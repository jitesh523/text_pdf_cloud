import { mergeLibraries } from './merge.js';
import { createStore } from './storage.js';

const CACHE_KEY = 'textdesk.cloud.v1';
const clone = value => JSON.parse(JSON.stringify(value));
const signature = state => state === null ? null : JSON.stringify(
  state.notes.map(({ id, title, content }) => [id, title, content])
    .sort((a, b) => a[0].localeCompare(b[0])),
);
const empty = state => ({ version: 1, notes: [], activeId: '', settings: { ...state.settings } });

function validState(state) {
  // Reuse the local library's strict validator without touching browser storage.
  createStore({ getItem: () => null, setItem() {} }).save(state);
  return state;
}

export function createCloudSync({ getState, applyState, onStatus, fetchFn = globalThis.fetch, storage }) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  let base = null;
  let etag = null;
  let initialized = false;
  let started = false;
  let stopped = false;
  let wantsRead = false;
  let wantsWrite = false;
  let running = null;
  let debounceTimer;
  let maximumTimer;
  let retryTimer;
  let retryCount = 0;
  let controller;
  let conflictPreserved = false;

  try {
    const cached = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    if (cached?.version === 1 && typeof cached.etag === 'string' && cached.state) {
      base = clone(validState(cached.state));
      etag = cached.etag;
    }
  } catch { /* Cached metadata is optional; a fresh GET remains mandatory. */ }

  const status = (phase, message) => { if (!stopped) onStatus({ phase, message }); };
  const dirty = () => signature(getState()) !== signature(base);
  const clearSaveTimers = () => {
    clearTimeout(debounceTimer);
    clearTimeout(maximumTimer);
    debounceTimer = maximumTimer = undefined;
  };
  const clearRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const remember = (state, tag) => {
    base = state === null ? null : clone(state);
    etag = tag;
    try { storage?.setItem(CACHE_KEY, JSON.stringify({ version: 1, state: base, etag })); }
    catch { /* A cloud save must still work when local storage is unavailable. */ }
  };
  const apply = state => {
    if (JSON.stringify(state) !== JSON.stringify(getState())) applyState(state);
  };
  const saved = () => {
    clearSaveTimers();
    status('saved', conflictPreserved
      ? 'Saved to cloud · conflicting edits kept as separate notes'
      : 'Saved to cloud');
    conflictPreserved = false;
  };

  async function request(method, submitted) {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 10000);
    timeout.unref?.();
    try {
      const body = method === 'PUT' ? JSON.stringify({ state: submitted, etag }) : undefined;
      const response = await fetchFn('/api/notes', {
        method, cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' }, body,
          keepalive: new TextEncoder().encode(body).byteLength <= 60000,
        }),
      });
      if (!response.ok && response.status !== 409) {
        const retryAfter = response.headers?.get?.('retry-after');
        let delay;
        if (retryAfter) {
          const seconds = Number(retryAfter);
          delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        }
        throw Object.assign(new Error(`Cloud request failed (${response.status}).`), {
          retryable: response.status === 429 || response.status >= 500,
          retryAfter: delay,
          phase: 'error',
        });
      }
      const payload = await response.json();
      if (!payload || !('state' in payload) || !('etag' in payload)
        || (payload.state === null ? payload.etag !== null : typeof payload.etag !== 'string')) {
        throw Object.assign(new Error('Invalid cloud response.'), { retryable: false, phase: 'error' });
      }
      if (payload.state !== null) validState(payload.state);
      if (method === 'PUT' && payload.state === null && response.status !== 409) {
        throw Object.assign(new Error('Cloud did not confirm the save.'), { retryable: false, phase: 'error' });
      }
      return { ...payload, conflict: response.status === 409 };
    } catch (error) {
      if (error.retryable === undefined) {
        error.retryable = !(error.code === 'corrupt' || error instanceof SyntaxError);
        error.phase = error.retryable ? 'offline' : 'error';
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      controller = undefined;
    }
  }

  function reconcile(remote, mergeBase = base, firstRead = false) {
    let local = clone(getState());
    if (firstRead && remote !== null) {
      const previousIds = new Set(mergeBase?.notes.map(note => note.id) ?? []);
      if (local.notes.length && local.notes.every(note => !previousIds.has(note.id)
        && note.title === '' && note.content === '')) {
        // Notes and sync metadata can be cleared independently. A newly
        // generated blank library is not evidence that cloud notes were deleted.
        mergeBase = empty(local);
      }
      // A fresh browser supplies an empty placeholder. It should open the
      // cloud library rather than add a blank note on every new device.
      local.notes = local.notes.filter(note => previousIds.has(note.id)
        || note.title !== '' || note.content !== '');
    }
    if (remote === null) return local;
    const result = mergeLibraries(mergeBase ?? empty(local), local, remote);
    conflictPreserved ||= result.conflicted;
    return result.state;
  }

  function scheduleRetry(error, action) {
    if (!error.retryable || stopped) return;
    const exponential = Math.min(15000, 1000 * (2 ** Math.min(retryCount++, 4)));
    const delay = Number.isFinite(error.retryAfter)
      ? Math.max(exponential, Math.max(0, error.retryAfter)) : exponential;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (action === 'GET') wantsRead = true;
      else wantsWrite = true;
      void run();
    }, delay);
    retryTimer.unref?.();
  }

  function run() {
    if (stopped) return Promise.resolve();
    if (running) return running;
    clearRetry();
    running = (async () => {
      let conflicts = 0;
      while (!stopped && (wantsRead || wantsWrite)) {
        const action = wantsRead || !initialized ? 'GET' : 'PUT';
        try {
          if (action === 'GET') {
            wantsRead = false;
            status(initialized && dirty() ? 'saving' : 'loading', initialized
              ? 'Checking cloud notes…' : 'Loading cloud notes…');
            const remote = await request('GET');
            if (stopped) return;
            const merged = reconcile(remote.state, base, !initialized);
            remember(remote.state, remote.etag);
            initialized = true;
            retryCount = 0;
            apply(merged);
            if (dirty()) wantsWrite = true;
            else saved();
          } else {
            wantsWrite = false;
            clearSaveTimers();
            if (!dirty()) { saved(); continue; }
            status('saving', 'Saving to cloud…');
            const submitted = clone(getState());
            const remote = await request('PUT', submitted);
            if (stopped) return;
            const merged = reconcile(remote.state, remote.conflict ? base : submitted);
            remember(remote.state, remote.etag);
            apply(merged);
            retryCount = 0;
            if (dirty()) {
              wantsWrite = true;
              if (remote.conflict && ++conflicts >= 5) {
                wantsWrite = false;
                throw Object.assign(new Error('Cloud is busy with other edits.'), {
                  retryable: true, phase: 'error',
                });
              }
            } else saved();
          }
        } catch (error) {
          if (stopped) return;
          // Retain every local draft and the last verified cloud baseline.
          wantsRead = wantsWrite = false;
          status(error.phase ?? 'error', error.retryable
            ? 'Not saved to cloud · retrying'
            : 'Cloud save failed · download a copy');
          scheduleRetry(error, action);
          return;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function changed() {
    if (stopped || (initialized && !dirty())) return;
    status('saving', 'Saving to cloud…');
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { wantsWrite = true; void run(); }, 800);
    debounceTimer.unref?.();
    if (!maximumTimer) {
      maximumTimer = setTimeout(() => { wantsWrite = true; void run(); }, 2500);
      maximumTimer.unref?.();
    }
  }

  return {
    start() {
      if (started) return running ?? Promise.resolve();
      started = true;
      wantsRead = true;
      return run();
    },
    changed,
    refresh() { wantsRead = true; return run(); },
    flush() {
      clearSaveTimers();
      wantsWrite = true;
      return run();
    },
    stop() {
      stopped = true;
      clearSaveTimers();
      clearRetry();
      controller?.abort();
    },
  };
}
