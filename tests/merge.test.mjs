import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLibraries } from '../dist/merge.js';
import { createStore, makeNote } from '../dist/storage.js';

function note(id, content = id) {
  return { ...makeNote(), id, content };
}
function library(notes, activeId = notes[0]?.id, focusMode = false) {
  return { version: 1, notes, activeId, settings: { focusMode } };
}
function clone(value) { return structuredClone(value); }
function byId(state, id) { return state.notes.find(note => note.id === id); }
function assertValid(state) {
  const values = new Map();
  const store = createStore({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) });
  store.save(state);
  assert.deepEqual(store.load(), state);
}

test('independent edits and all new or unsaved notes survive without mutating inputs', () => {
  const base = library([note('a'), note('b')]);
  const local = clone(base);
  const remote = clone(base);
  local.notes[0].content = 'local edit';
  remote.notes[1].content = 'remote edit';
  local.notes.push(note('local new', 'unsaved text'));
  remote.notes.push(note('remote new'));
  const before = [clone(base), clone(local), clone(remote)];
  const { state, conflicted } = mergeLibraries(base, local, remote);
  assert.equal(conflicted, false);
  assert.equal(byId(state, 'a').content, 'local edit');
  assert.equal(byId(state, 'b').content, 'remote edit');
  assert.equal(byId(state, 'local new').content, 'unsaved text');
  assert.ok(byId(state, 'remote new'));
  assert.deepEqual([base, local, remote], before);
  assertValid(state);
});

test('a local deletion applies only when the remote text is unchanged', () => {
  const base = library([note('a'), note('b'), note('c')]);
  const local = library([clone(base.notes[2])]);
  const remote = clone(base);
  remote.notes[0].scrollTop = 120;
  remote.notes[1].title = 'Edited elsewhere';
  const { state, conflicted } = mergeLibraries(base, local, remote);
  assert.equal(byId(state, 'a'), undefined);
  assert.equal(byId(state, 'b').title, 'Edited elsewhere');
  assert.equal(state.activeId, 'c');
  assert.equal(conflicted, true);
  assertValid(state);
});

test('conflicting text retains the remote original and selects a fresh local copy', () => {
  const base = library([note('a')]);
  const local = clone(base);
  const remote = clone(base);
  local.notes[0].content = '  local\n\tहिन्दी 🐈\n';
  local.notes[0].cursorStart = 3;
  local.notes[0].cursorEnd = 5;
  remote.notes[0].content = 'remote';
  const { state, conflicted } = mergeLibraries(base, local, remote);
  assert.equal(conflicted, true);
  assert.equal(state.notes.length, 2);
  assert.equal(byId(state, 'a').content, 'remote');
  assert.notEqual(state.activeId, 'a');
  assert.deepEqual(byId(state, state.activeId), { ...local.notes[0], id: state.activeId });
  assertValid(state);
});

test('remote deletion keeps unsaved local edits under a fresh ID and deletes unchanged notes', () => {
  const base = library([note('edited'), note('unchanged'), note('survivor')], 'edited');
  const local = clone(base);
  local.notes[0].content = 'my unsaved text';
  const remote = library([clone(base.notes[2])]);
  const { state, conflicted } = mergeLibraries(base, local, remote);
  assert.equal(conflicted, true);
  assert.equal(state.notes.length, 2);
  assert.equal(byId(state, 'edited'), undefined);
  assert.equal(byId(state, 'unchanged'), undefined);
  assert.equal(byId(state, state.activeId).content, 'my unsaved text');
  assertValid(state);
});

test('local view changes survive only when the merged content is still the same', () => {
  const base = library([note('a', 'abcdef')]);
  const local = clone(base);
  const remote = clone(base);
  local.notes[0].cursorStart = 4;
  local.notes[0].cursorEnd = 6;
  local.notes[0].scrollTop = 88;
  remote.notes[0].title = 'Remote title';
  let result = mergeLibraries(base, local, remote);
  assert.equal(result.state.notes[0].title, 'Remote title');
  assert.equal(result.state.notes[0].cursorStart, 4);
  assert.equal(result.state.notes[0].scrollTop, 88);
  remote.notes[0].content = 'x';
  result = mergeLibraries(base, local, remote);
  assert.equal(result.state.notes[0].content, 'x');
  assert.equal(result.state.notes[0].cursorStart, 0);
  assertValid(result.state);
});

test('unchanged local views adopt remote cursor metadata and identical edits converge', () => {
  const base = library([note('a', 'abcdef')]);
  const local = clone(base);
  const remote = clone(base);
  local.notes[0].title = 'same title';
  remote.notes[0].title = 'same title';
  remote.notes[0].cursorStart = 3;
  remote.notes[0].cursorEnd = 3;
  const { state, conflicted } = mergeLibraries(base, local, remote);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].cursorStart, 3);
  assert.equal(conflicted, false);
});

test('local settings win only when changed; active selection falls back to remote', () => {
  const base = library([note('a'), note('b')]);
  const local = clone(base);
  const remote = library([clone(base.notes[1])], 'b', true);
  let result = mergeLibraries(base, local, remote);
  assert.equal(result.state.activeId, 'b');
  assert.equal(result.state.settings.focusMode, true);
  local.settings.focusMode = true;
  remote.settings.focusMode = false;
  result = mergeLibraries(base, local, remote);
  assert.equal(result.state.settings.focusMode, true);
  assertValid(result.state);
});

test('when both sides remove the remaining base notes, the result has one blank note', () => {
  const base = library([note('a'), note('b')]);
  const local = library([clone(base.notes[0])]);
  const remote = library([clone(base.notes[1])]);
  const { state } = mergeLibraries(base, local, remote);
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].content, '');
  assert.equal(state.notes[0].title, '');
  assertValid(state);
});

test('an unlikely new-note ID collision preserves both texts', () => {
  const base = library([note('a')]);
  const local = library([...clone(base.notes), note('new', 'local')], 'new');
  const remote = library([...clone(base.notes), note('new', 'remote')]);
  const { state, conflicted } = mergeLibraries(base, local, remote);
  assert.equal(state.notes.length, 3);
  assert.equal(byId(state, 'new').content, 'remote');
  assert.equal(byId(state, state.activeId).content, 'local');
  assert.equal(conflicted, true);
  assertValid(state);
});
