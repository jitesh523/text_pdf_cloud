const STORAGE_KEY = 'textdesk.notes.v1';

export class StorageError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code;
  }
}

export function makeNote() {
  const now = Date.now();
  const id = globalThis.crypto?.randomUUID?.()
    ?? `note-${now.toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    title: '',
    content: '',
    createdAt: now,
    updatedAt: now,
    cursorStart: 0,
    cursorEnd: 0,
    scrollTop: 0,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateState(state) {
  const fail = () => {
    throw new StorageError('Saved notes have an invalid format. Your stored data has not been changed.', 'corrupt');
  };
  if (!isObject(state) || state.version !== 1 || !Array.isArray(state.notes)
    || state.notes.length === 0 || typeof state.activeId !== 'string'
    || !isObject(state.settings) || typeof state.settings.focusMode !== 'boolean') {
    fail();
  }

  const ids = new Set();
  for (const note of state.notes) {
    if (!isObject(note) || typeof note.id !== 'string' || note.id.length === 0
      || ids.has(note.id) || typeof note.title !== 'string' || typeof note.content !== 'string'
      || !Number.isFinite(note.createdAt) || note.createdAt < 0 || note.createdAt > 8640000000000000
      || !Number.isFinite(note.updatedAt) || note.updatedAt < 0 || note.updatedAt > 8640000000000000
      || !Number.isInteger(note.cursorStart) || note.cursorStart < 0
      || !Number.isInteger(note.cursorEnd) || note.cursorEnd < note.cursorStart
      || note.cursorEnd > note.content.length
      || !Number.isFinite(note.scrollTop) || note.scrollTop < 0) {
      fail();
    }
    ids.add(note.id);
  }
  if (!ids.has(state.activeId)) fail();
  return state;
}

function storageFailure(error) {
  const quota = error?.name === 'QuotaExceededError'
    || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22 || error?.code === 1014;
  return new StorageError(
    quota
      ? 'Browser storage is full. Export your notes to keep a copy.'
      : 'Browser storage is unavailable. Export your notes to keep a copy.',
    quota ? 'quota' : 'unavailable',
    error,
  );
}

export function createStore(storage) {
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch (error) {
      throw storageFailure(error);
    }
  }
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new StorageError('Browser storage is unavailable. Export your notes to keep a copy.', 'unavailable');
  }

  // A failed load locks this store against writes so a later autosave cannot
  // replace data that was unreadable or corrupt. Create a fresh store only
  // after the user has deliberately resolved that failure.
  let loadError = null;

  function load() {
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (error) {
      loadError = storageFailure(error);
      throw loadError;
    }

    if (raw === null) {
      loadError = null;
      const note = makeNote();
      return { version: 1, activeId: note.id, notes: [note], settings: { focusMode: false } };
    }

    try {
      const state = validateState(JSON.parse(raw));
      loadError = null;
      return state;
    } catch (error) {
      loadError = error instanceof StorageError ? error
        : new StorageError('Saved notes could not be read. Your stored data has not been changed.', 'corrupt', error);
      throw loadError;
    }
  }

  function save(state) {
    if (loadError) {
      throw new StorageError('Saving is paused because saved notes could not be read. Your stored data has not been changed.', loadError.code, loadError);
    }
    // Check before every write: corruption introduced in another tab must not
    // be replaced by an autosave from a previously valid session.
    load();
    validateState(state);
    let serialized;
    try {
      serialized = JSON.stringify(state);
    } catch (error) {
      throw new StorageError('These notes could not be saved in the expected format.', 'corrupt', error);
    }
    try {
      storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw storageFailure(error);
    }
  }

  return { load, save };
}
