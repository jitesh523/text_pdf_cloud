import { makeNote } from './storage.js';

const sameText = (a, b) => a.title === b.title && a.content === b.content;
const sameView = (a, b) => a.cursorStart === b.cursorStart
  && a.cursorEnd === b.cursorEnd && a.scrollTop === b.scrollTop;

// Merge against the last successfully saved library, never against an unsaved
// snapshot. Conflicting text survives as two notes instead of being overwritten.
export function mergeLibraries(base, local, remote) {
  const baseNotes = new Map(base.notes.map(note => [note.id, note]));
  const localNotes = new Map(local.notes.map(note => [note.id, note]));
  const remoteNotes = new Map(remote.notes.map(note => [note.id, note]));
  const merged = new Map(remote.notes.map(note => [note.id, { ...note }]));
  const ids = new Set([...baseNotes.keys(), ...localNotes.keys(), ...remoteNotes.keys()]);
  const localIds = new Map();
  let conflicted = false;

  const retainLocalCopy = (note) => {
    let id;
    do { id = makeNote().id; } while (ids.has(id));
    ids.add(id);
    merged.set(id, { ...note, id });
    localIds.set(note.id, id);
    conflicted = true;
  };

  for (const original of base.notes) {
    const here = localNotes.get(original.id);
    const there = remoteNotes.get(original.id);
    if (!here) {
      if (there && sameText(there, original)) merged.delete(original.id);
      else if (there) conflicted = true;
      continue;
    }
    if (!there) {
      if (!sameText(here, original)) retainLocalCopy(here);
      continue;
    }
    const localChanged = !sameText(here, original);
    const remoteChanged = !sameText(there, original);
    if (localChanged && remoteChanged && !sameText(here, there)) {
      retainLocalCopy(here);
    } else if (localChanged && !remoteChanged) {
      merged.set(here.id, { ...here });
    } else if (!sameView(here, original) && here.content === there.content) {
      merged.set(there.id, {
        ...there,
        cursorStart: here.cursorStart,
        cursorEnd: here.cursorEnd,
        scrollTop: here.scrollTop,
      });
    }
  }

  for (const here of local.notes) {
    if (baseNotes.has(here.id)) continue;
    const there = remoteNotes.get(here.id);
    if (!there) merged.set(here.id, { ...here });
    else if (!sameText(here, there)) retainLocalCopy(here);
    else merged.set(here.id, { ...there, cursorStart: here.cursorStart,
      cursorEnd: here.cursorEnd, scrollTop: here.scrollTop });
  }

  let notes = [...merged.values()];
  if (!notes.length) notes = [makeNote()];
  const selected = localIds.get(local.activeId) ?? local.activeId;
  const activeId = notes.some(note => note.id === selected) ? selected
    : notes.some(note => note.id === remote.activeId) ? remote.activeId : notes[0].id;
  const settings = local.settings.focusMode !== base.settings.focusMode
    ? { ...local.settings } : { ...remote.settings };
  return { state: { version: 1, notes, activeId, settings }, conflicted };
}
