import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, makeNote, StorageError } from '../dist/storage.js';

const KEY = 'textdesk.notes.v1';

function memoryStorage(initial = null) {
  const items = new Map(initial === null ? [] : [[KEY, initial]]);
  return {
    getItem(key) { return items.get(key) ?? null; },
    setItem(key, value) { items.set(key, String(value)); },
  };
}

function stateWith(content) {
  const note = { ...makeNote(), title: '  Exact title  ', content, cursorStart: content.length, cursorEnd: content.length, scrollTop: 42.5 };
  return { version: 1, activeId: note.id, notes: [note], settings: { focusMode: true } };
}

test('a new store supplies one genuinely blank note without writing sample data', () => {
  const storage = memoryStorage();
  const state = createStore(storage).load();
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].title, '');
  assert.equal(state.notes[0].content, '');
  assert.equal(state.activeId, state.notes[0].id);
  assert.equal(storage.getItem(KEY), null);
});

test('save and reload preserve exact text, whitespace, Unicode and editor position', () => {
  const storage = memoryStorage();
  const state = stateWith('  first line\r\n\tहिन्दी 🐈‍⬛ e\u0301\n\nlast line  \n');
  const second = { ...makeNote(), content: '\n\t  ' };
  state.notes.push(second);
  createStore(storage).save(state);
  assert.deepEqual(createStore(storage).load(), state);
});

test('malformed JSON and invalid saved structures cannot be overwritten by autosave', () => {
  const invalid = [
    '{broken json',
    JSON.stringify({ version: 1, notes: [] }),
    JSON.stringify({ ...stateWith('abc'), activeId: 'missing' }),
    JSON.stringify({ ...stateWith('abc'), settings: { focusMode: 'yes' } }),
    JSON.stringify({ ...stateWith('abc'), notes: [{ ...makeNote(), content: 'a', cursorEnd: 9 }] }),
    JSON.stringify({ ...stateWith('abc'), notes: [{ ...makeNote(), content: 12 }] }),
  ];
  for (const raw of invalid) {
    const storage = memoryStorage(raw);
    const store = createStore(storage);
    assert.throws(() => store.load(), error => error instanceof StorageError && error.code === 'corrupt');
    assert.throws(() => store.save(stateWith('replacement')), error => error.code === 'corrupt');
    assert.equal(storage.getItem(KEY), raw);
    assert.throws(() => createStore(storage).save(stateWith('replacement')), error => error.code === 'corrupt');
    assert.equal(storage.getItem(KEY), raw);
  }
});

test('quota errors are distinguished from unavailable browser storage', () => {
  for (const name of ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']) {
    const storage = { getItem() { return null; }, setItem() { throw Object.assign(new Error('full'), { name }); } };
    assert.throws(() => createStore(storage).save(stateWith('text')), error => error instanceof StorageError && error.code === 'quota');
  }
  const inaccessible = { getItem() { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); }, setItem() {} };
  assert.throws(() => createStore(inaccessible).load(), error => error.code === 'unavailable');
  const deniedWrite = { getItem() { return null; }, setItem() { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); } };
  assert.throws(() => createStore(deniedWrite).save(stateWith('text')), error => error.code === 'unavailable');
  assert.throws(() => createStore(null), error => error.code === 'unavailable');
});

test('corruption introduced after an initial load is preserved before every save', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.load();
  storage.setItem(KEY, '{corruption from another tab');
  assert.throws(() => store.save(stateWith('local edit')), error => error.code === 'corrupt');
  assert.equal(storage.getItem(KEY), '{corruption from another tab');
});
