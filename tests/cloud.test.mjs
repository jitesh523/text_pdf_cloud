import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createCloudSync } from '../dist/cloud.js';
import { makeNote } from '../dist/storage.js';

const clone = value => structuredClone(value);
const note = (id, content = '', title = '') => ({ ...makeNote(), id, content, title });
const library = notes => ({ version: 1, notes, activeId: notes[0].id, settings: { focusMode: false } });
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
function memoryStorage(cache) {
  const data = new Map(cache ? [['textdesk.cloud.v1', JSON.stringify(cache)]] : []);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function server(initial = null) {
  let state = clone(initial);
  let revision = initial ? 1 : 0;
  const calls = [];
  let intercept;
  return {
    calls,
    get state() { return clone(state); },
    get etag() { return revision ? `v${revision}` : null; },
    setState(next) { state = clone(next); revision += 1; },
    intercept(fn) { intercept = fn; },
    async fetch(url, options) {
      calls.push({ url, options });
      const override = await intercept?.(url, options);
      if (override) return override;
      const payload = { state, etag: revision ? `v${revision}` : null };
      if (options.method === 'GET') return response(200, payload);
      const submitted = JSON.parse(options.body);
      if (submitted.etag !== payload.etag) return response(409, payload);
      state = clone(submitted.state);
      revision += 1;
      return response(200, { state, etag: `v${revision}` });
    },
  };
}
function client(initial, api, storage = memoryStorage()) {
  let state = clone(initial);
  const statuses = [];
  const sync = createCloudSync({ getState: () => state, applyState: next => { state = next; },
    onStatus: status => statuses.push(status), fetchFn: api.fetch.bind(api), storage });
  return { sync, statuses, storage, get state() { return state; },
    edit(id, content) {
      const current = state.notes.find(note => note.id === id);
      current.content = content;
      current.cursorStart = current.cursorEnd = 0;
      sync.changed();
    } };
}
const writes = api => api.calls.filter(call => call.options.method === 'PUT');
const latest = user => user.statuses.at(-1);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('first cloud save migrates exact existing local text, then saves changes automatically', async t => {
  const exact = '  first\r\n\tहिन्दी 🐈‍⬛ e\u0301\n\nlast  \n';
  const api = server();
  const user = client(library([note('local', exact, ' Exact title  ')]), api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  assert.equal(api.calls[0].options.method, 'GET');
  assert.equal(api.state.notes[0].content, exact);
  assert.equal(api.state.notes[0].title, ' Exact title  ');
  assert.equal(latest(user).phase, 'saved');
  assert.equal(JSON.parse(user.storage.getItem('textdesk.cloud.v1')).etag, api.etag);
  user.edit('local', exact + 'new text');
  assert.equal(latest(user).phase, 'saving');
  await user.sync.flush();
  assert.equal(api.state.notes[0].content, exact + 'new text');
  assert.equal(latest(user).phase, 'saved');
  assert.equal(writes(api)[0].options.keepalive, true);
});

test('a fresh device opens cloud notes without uploading its blank placeholder', async t => {
  const remote = library([note('cloud', 'cloud text')]);
  const api = server(remote);
  const user = client(library([note('placeholder')]), api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  assert.deepEqual(user.state, remote);
  assert.equal(writes(api).length, 0);
  assert.equal(latest(user).phase, 'saved');
});

test('pre-cloud drafts and whitespace notes migrate alongside an existing public library', async t => {
  const api = server(library([note('remote', 'from another device')]));
  const user = client(library([note('placeholder'), note('draft', 'my draft'), note('spaces', ' \n\t')]), api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  assert.deepEqual(new Set(api.state.notes.map(note => note.id)), new Set(['remote', 'draft', 'spaces']));
  assert.equal(api.state.notes.find(note => note.id === 'spaces').content, ' \n\t');
});

test('cached metadata with a missing local library cannot delete the entire cloud library', async t => {
  const remote = library([note('a', 'keep this cloud text'), note('b', 'keep this too')]);
  const api = server(remote);
  const user = client(library([note('new local placeholder')]), api,
    memoryStorage({ version: 1, state: remote, etag: api.etag }));
  t.after(() => user.sync.stop());
  await user.sync.start();
  assert.deepEqual(user.state, remote);
  assert.deepEqual(api.state, remote);
  assert.equal(writes(api).length, 0);
});

test('a reload verifies remote first and preserves conflicting unsaved local text', async t => {
  const base = library([note('shared', 'original')]);
  const api = server(base);
  const local = clone(base);
  local.notes[0].content = 'unsaved local draft';
  api.setState(library([note('shared', 'edited elsewhere')]));
  const user = client(local, api, memoryStorage({ version: 1, state: base, etag: 'v1' }));
  t.after(() => user.sync.stop());
  await user.sync.start();
  assert.equal(api.calls[0].options.method, 'GET');
  assert.deepEqual(new Set(api.state.notes.map(note => note.content)),
    new Set(['unsaved local draft', 'edited elsewhere']));
  assert.notEqual(user.state.activeId, 'shared');
  assert.match(latest(user).message, /conflicting edits/);
});

test('edits made while an earlier PUT is pending survive and only one request runs at once', async t => {
  const api = server(library([note('a', 'original')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  const gate = deferred();
  const arrived = deferred();
  let active = 0;
  let maxActive = 0;
  let first = true;
  api.intercept(async (_url, options) => {
    active += 1;
    maxActive = Math.max(active, maxActive);
    if (options.method === 'PUT' && first) {
      first = false;
      arrived.resolve();
      await gate.promise;
    }
    active -= 1;
  });
  user.edit('a', 'first edit');
  const saving = user.sync.flush();
  await arrived.promise;
  user.edit('a', 'first edit and later typing');
  assert.equal(latest(user).phase, 'saving');
  gate.resolve();
  await saving;
  assert.equal(maxActive, 1);
  assert.equal(user.state.notes[0].content, 'first edit and later typing');
  assert.equal(api.state.notes[0].content, 'first edit and later typing');
  assert.equal(writes(api).length, 2);
  assert.equal(latest(user).phase, 'saved');
});

test('409 merges the verified baseline with both concurrent edits and retries using the latest etag', async t => {
  const base = library([note('a', 'original'), note('b', 'second')]);
  const api = server(base);
  const user = client(base, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  user.edit('a', 'local change');
  const remote = clone(base);
  remote.notes[1].content = 'remote change';
  api.setState(remote);
  await user.sync.flush();
  assert.equal(writes(api).length, 2);
  assert.equal(JSON.parse(writes(api)[1].options.body).etag, 'v2');
  assert.deepEqual(api.state.notes.map(note => note.content), ['local change', 'remote change']);
  assert.equal(latest(user).phase, 'saved');
});

test('focus refresh merges remote changes without replacing drafts', async t => {
  const base = library([note('a', 'original'), note('b', 'second')]);
  const api = server(base);
  const user = client(base, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  user.edit('a', 'draft still here');
  const remote = clone(base);
  remote.notes[1].content = 'updated on other device';
  api.setState(remote);
  await user.sync.refresh();
  assert.deepEqual(api.state.notes.map(note => note.content), ['draft still here', 'updated on other device']);
  assert.equal(latest(user).phase, 'saved');
});

test('cursor, scrolling, focus mode and active selection do not cause cloud writes', async t => {
  const api = server(library([note('a', 'abcdef'), note('b', 'second')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  user.state.notes[0].cursorStart = user.state.notes[0].cursorEnd = 4;
  user.state.notes[0].scrollTop = 90;
  user.state.settings.focusMode = true;
  user.state.activeId = 'b';
  user.sync.changed();
  await user.sync.flush();
  assert.equal(writes(api).length, 0);
  assert.equal(latest(user).phase, 'saved');
});

test('network failures retain drafts and an explicit flush retries without claiming success early', async t => {
  const api = server(library([note('a', 'original')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  api.intercept(() => { throw new TypeError('Failed to fetch'); });
  user.edit('a', 'kept offline');
  await user.sync.flush();
  assert.equal(latest(user).phase, 'offline');
  assert.equal(user.state.notes[0].content, 'kept offline');
  assert.equal(api.state.notes[0].content, 'original');
  api.intercept(null);
  await user.sync.flush();
  assert.equal(api.state.notes[0].content, 'kept offline');
  assert.equal(latest(user).phase, 'saved');
});

test('unavailable device storage still permits verified cloud saves', async t => {
  const api = server();
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const user = client(library([note('a', 'save in cloud')]), api, storage);
  t.after(() => user.sync.stop());
  await user.sync.start();
  assert.equal(api.state.notes[0].content, 'save in cloud');
  assert.equal(latest(user).phase, 'saved');
});

test('permanent HTTP errors retain text and larger saves disable keepalive', async t => {
  const api = server(library([note('a', 'original')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  api.intercept((_url, options) => options.method === 'PUT' ? response(413, { error: 'Too large' }) : null);
  user.edit('a', 'ह'.repeat(25000));
  await user.sync.flush();
  assert.equal(latest(user).phase, 'error');
  assert.equal(user.state.notes[0].content.length, 25000);
  assert.equal(writes(api)[0].options.keepalive, false);
  assert.equal(api.state.notes[0].content, 'original');
});

test('stop aborts requests and prevents later success callbacks', async () => {
  const gate = deferred();
  const api = server(library([note('a', 'original')]));
  let signal;
  api.intercept((_url, options) => { signal = options.signal; return gate.promise; });
  const user = client(api.state, api);
  const starting = user.sync.start();
  user.sync.stop();
  assert.equal(signal.aborted, true);
  gate.resolve();
  await starting;
  assert.equal(user.statuses.some(status => status.phase === 'saved'), false);
});

test('typing is debounced for 800ms and continuous input saves within 2500ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = server(library([note('a', 'original')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  user.edit('a', 'first');
  t.mock.timers.tick(799);
  await nextTurn();
  assert.equal(writes(api).length, 0);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(api.state.notes[0].content, 'first');
  user.edit('a', 'continuous 1');
  for (let i = 2; i <= 5; i += 1) {
    t.mock.timers.tick(600);
    user.edit('a', `continuous ${i}`);
  }
  await nextTurn();
  assert.equal(writes(api).length, 1);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(api.state.notes[0].content, 'continuous 5');
  assert.equal(writes(api).length, 2);
});

test('transient failures retry automatically with exponential delay capped at 15 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = server(library([note('a', 'original')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  let failing = true;
  api.intercept((_url, options) => failing && options.method === 'PUT'
    ? response(503, { error: 'Temporarily unavailable' }) : null);
  user.edit('a', 'retry this exact text');
  await user.sync.flush();
  assert.equal(writes(api).length, 1);
  for (const delay of [1000, 2000, 4000, 8000, 15000]) {
    const before = writes(api).length;
    t.mock.timers.tick(delay - 1);
    await nextTurn();
    assert.equal(writes(api).length, before);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(writes(api).length, before + 1);
    assert.equal(latest(user).phase, 'error');
  }
  failing = false;
  t.mock.timers.tick(14999);
  await nextTurn();
  assert.equal(api.state.notes[0].content, 'original');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(api.state.notes[0].content, 'retry this exact text');
  assert.equal(latest(user).phase, 'saved');
});

test('429 respects Retry-After and permanent errors wait for a new explicit attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = server(library([note('a', 'original')]));
  const user = client(api.state, api);
  t.after(() => user.sync.stop());
  await user.sync.start();
  let code = 429;
  api.intercept((_url, options) => options.method === 'PUT'
    ? response(code, { error: 'Unavailable' }, { 'Retry-After': '20' }) : null);
  user.edit('a', 'draft');
  await user.sync.flush();
  t.mock.timers.tick(19999);
  await nextTurn();
  assert.equal(writes(api).length, 1);
  code = 400;
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(writes(api).length, 2);
  t.mock.timers.tick(60000);
  await nextTurn();
  assert.equal(writes(api).length, 2);
  assert.equal(user.state.notes[0].content, 'draft');
  assert.equal(latest(user).phase, 'error');
});
