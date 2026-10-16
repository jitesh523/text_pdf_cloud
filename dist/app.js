import { createStore, makeNote } from './storage.js';
import { mergeLibraries } from './merge.js';
import { createCloudSync } from './cloud.js';

const $ = (id) => document.getElementById(id);
const ui = {
  title: $('note-title'), editor: $('editor'), list: $('note-list'), search: $('search'),
  status: $('save-status'), stats: $('stats'), edited: $('last-edited'),
  warning: $('storage-warning'), warningText: $('storage-warning-text'),
  sidebar: $('sidebar'), focus: $('focus-toggle'), dialog: $('delete-dialog'),
};
let store;
let state;
let savingBlocked = false;
let lastSaved = '';
let viewTimer;
let toastTimer;
let cloud;
let localWarning = '';
let cloudWarning = '';
const STORAGE_KEY = 'textdesk.notes.v1';

function updateWarning() {
  ui.warningText.textContent = [cloudWarning, localWarning].filter(Boolean).join(' ');
  ui.warning.hidden = !ui.warningText.textContent;
}

function warn(message) {
  localWarning = message;
  updateWarning();
}

function storageFailure(error) {
  if (error.code === 'corrupt') {
    savingBlocked = true;
    warn('The saved device backup could not be read and was left untouched. Check the cloud status above before closing.');
  } else if (error.code === 'quota') {
    warn('Device storage is full, so an offline backup is unavailable. Check the cloud status above before closing.');
  } else {
    warn('An offline backup is unavailable in this browser. Check the cloud status above before closing.');
  }
}

function activeNote() { return state.notes.find((note) => note.id === state.activeId); }
function label(note) { return note.title.trim() || 'Untitled note'; }

try {
  store = createStore();
  state = store.load();
  lastSaved = JSON.stringify(state);
} catch (error) {
  const note = makeNote();
  state = { version: 1, activeId: note.id, notes: [note], settings: { focusMode: false } };
  storageFailure(error);
}

function save() {
  if (savingBlocked || !store) return false;
  try {
    if (globalThis.localStorage.getItem(STORAGE_KEY) !== null && lastSaved) {
      const latest = store.load();
      if (JSON.stringify(latest) !== lastSaved) {
        const merged = mergeLibraries(JSON.parse(lastSaved), state, latest);
        state = merged.state;
        if (merged.conflicted) announce('Changes from another tab were preserved in your library.');
      }
    }
    store.save(state);
    lastSaved = JSON.stringify(state);
    localWarning = '';
    updateWarning();
    const note = activeNote();
    if (ui.editor.value !== note.content || ui.title.value !== note.title) renderEditor();
    return true;
  } catch (error) {
    storageFailure(error);
    return false;
  }
}

function rememberView() {
  const note = activeNote();
  note.cursorStart = ui.editor.selectionStart;
  note.cursorEnd = ui.editor.selectionEnd;
  note.scrollTop = Math.max(0, ui.editor.scrollTop);
}

function updateStats() {
  const note = activeNote();
  const wordCount = note.content.trim() ? note.content.trim().split(/\s+/u).length : 0;
  const charCount = [...note.content].length;
  ui.stats.textContent = `${wordCount.toLocaleString()} ${wordCount === 1 ? 'word' : 'words'} · ${charCount.toLocaleString()} ${charCount === 1 ? 'character' : 'characters'}`;
  ui.edited.textContent = note.content || note.title
    ? `Edited ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(note.updatedAt)}`
    : 'Ready when you are';
  document.title = `${label(note)} — Textdesk`;
}

function renderList() {
  const query = ui.search.value.toLocaleLowerCase();
  const notes = state.notes.filter((note) => `${note.title}\n${note.content}`.toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const note of notes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `note-card${note.id === state.activeId ? ' active' : ''}`;
    button.dataset.noteId = note.id;
    button.setAttribute('aria-current', note.id === state.activeId ? 'true' : 'false');
    const top = document.createElement('span');
    top.className = 'note-card-top';
    const title = document.createElement('span');
    title.className = 'note-card-title';
    title.textContent = label(note);
    const dot = document.createElement('span');
    dot.className = 'note-card-dot';
    dot.setAttribute('aria-hidden', 'true');
    top.append(title, dot);
    const preview = document.createElement('span');
    preview.className = 'note-card-preview';
    preview.textContent = note.content.replace(/\s+/gu, ' ').trim().slice(0, 90) || 'A fresh page for your thoughts';
    const meta = document.createElement('span');
    meta.className = 'note-card-meta';
    const words = note.content.trim() ? note.content.trim().split(/\s+/u).length : 0;
    meta.textContent = `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(note.updatedAt)} · ${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    button.append(top, preview, meta);
    button.addEventListener('click', () => selectNote(note.id));
    fragment.append(button);
  }
  if (!notes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-search';
    empty.textContent = 'No notes found. Try another word.';
    fragment.append(empty);
  }
  ui.list.replaceChildren(fragment);
  const count = $('note-count');
  if (count) count.textContent = `${state.notes.length} ${state.notes.length === 1 ? 'note' : 'notes'}`;
}

function renderEditor() {
  const note = activeNote();
  ui.title.value = note.title;
  ui.editor.value = note.content;
  ui.editor.setSelectionRange(note.cursorStart, note.cursorEnd);
  requestAnimationFrame(() => { ui.editor.scrollTop = note.scrollTop; });
  document.body.classList.toggle('focus-mode', state.settings.focusMode);
  ui.focus.setAttribute('aria-pressed', String(state.settings.focusMode));
  ui.focus.title = state.settings.focusMode ? 'Leave focus mode' : 'Focus mode';
  updateStats();
}

function closeLibrary() {
  document.body.classList.remove('library-open');
  $('library-toggle').setAttribute('aria-expanded', 'false');
}

function selectNote(id) {
  $('show-notes')?.click();
  rememberView();
  state.activeId = id;
  save();
  renderEditor();
  renderList();
  closeLibrary();
  ui.editor.focus({ preventScroll: true });
}

function edit(field, value) {
  const note = activeNote();
  note[field] = value;
  note.updatedAt = Date.now();
  rememberView();
  save();
  cloud?.changed();
  updateStats();
  renderList();
}

ui.editor.addEventListener('input', () => edit('content', ui.editor.value));
ui.title.addEventListener('input', () => edit('title', ui.title.value));
ui.search.addEventListener('input', renderList);

function persistView() {
  clearTimeout(viewTimer);
  rememberView();
  // Caret and scrolling do not change the text's edited time.
  save();
}

for (const event of ['select', 'keyup', 'pointerup', 'scroll']) {
  ui.editor.addEventListener(event, () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(persistView, 200);
  });
}

$('new-note').addEventListener('click', () => {
  $('show-notes')?.click();
  rememberView();
  const note = makeNote();
  state.notes.unshift(note);
  state.activeId = note.id;
  ui.search.value = '';
  save();
  renderEditor();
  renderList();
  closeLibrary();
  ui.title.focus();
  cloud?.changed();
});

function announce(message) {
  let toast = $('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    document.body.append(toast);
  }
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

$('copy-note').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ui.editor.value);
    announce('Text copied');
  } catch {
    ui.editor.focus();
    ui.editor.select();
    announce('Select text and press Ctrl+C or ⌘C to copy.');
  }
});

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('download-note').addEventListener('click', () => {
  const name = label(activeNote()).replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '-').slice(0, 100);
  download(ui.editor.value, `${name}.txt`, 'text/plain;charset=utf-8');
  announce('Note downloaded');
});

$('export-backup')?.addEventListener('click', () => {
  rememberView();
  download(JSON.stringify(state, null, 2), `textdesk-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  announce('Library backup downloaded');
});

$('delete-note').addEventListener('click', () => ui.dialog.showModal());
$('cancel-delete').addEventListener('click', () => ui.dialog.close());
$('confirm-delete').addEventListener('click', () => {
  const deletingId = state.activeId;
  state.notes = state.notes.filter((note) => note.id !== deletingId);
  if (!state.notes.length) state.notes.push(makeNote());
  state.activeId = state.notes[0].id;
  save();
  renderEditor();
  renderList();
  ui.dialog.close();
  announce('Note deleted');
  cloud?.changed();
});

function toggleFocus() {
  state.settings.focusMode = !state.settings.focusMode;
  document.body.classList.toggle('focus-mode', state.settings.focusMode);
  ui.focus.setAttribute('aria-pressed', String(state.settings.focusMode));
  ui.focus.title = state.settings.focusMode ? 'Leave focus mode' : 'Focus mode';
  save();
  closeLibrary();
}

ui.focus.addEventListener('click', toggleFocus);
$('library-toggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('library-open');
  $('library-toggle').setAttribute('aria-expanded', String(open));
});
$('close-library')?.addEventListener('click', closeLibrary);
$('library-backdrop')?.addEventListener('click', closeLibrary);

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    $('new-note').click();
  }
  if (event.key === 'Escape') {
    closeLibrary();
    if (state.settings.focusMode) toggleFocus();
  }
});

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY || !store || savingBlocked) return;
  // Unsaved changes stay in memory until the user downloads or storage recovers.
  if (localWarning) return;
  try {
    const latest = store.load();
    const merged = mergeLibraries(JSON.parse(lastSaved), state, latest);
    state = merged.state;
    lastSaved = JSON.stringify(latest);
    renderEditor();
    renderList();
    announce('Library updated from another tab');
    cloud?.changed();
  } catch (error) { storageFailure(error); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistView();
    cloud?.flush();
  } else cloud?.refresh();
});
window.addEventListener('pagehide', () => { persistView(); cloud?.flush(); });
window.addEventListener('online', () => cloud?.refresh());
window.addEventListener('focus', () => cloud?.refresh());

renderEditor();
renderList();
if (!savingBlocked && store) save();

cloud = createCloudSync({
  getState: () => state,
  applyState: (nextState) => {
    const previousActiveId = state.activeId;
    state = nextState;
    if (store && !savingBlocked) {
      try {
        store.save(state);
        lastSaved = JSON.stringify(state);
        localWarning = '';
        updateWarning();
      } catch (error) { storageFailure(error); }
    }
    if (previousActiveId !== state.activeId || ui.editor.value !== activeNote().content || ui.title.value !== activeNote().title) renderEditor();
    else updateStats();
    renderList();
  },
  onStatus: ({ phase, message }) => {
    ui.status.textContent = message;
    ui.status.dataset.state = phase === 'saved' ? 'saved' : ['offline', 'error'].includes(phase) ? 'error' : 'saving';
    cloudWarning = ['offline', 'error'].includes(phase)
      ? 'Your latest text has not reached the cloud. Keep this page open while it retries, or download a copy.' : '';
    updateWarning();
  },
});
cloud.start();
setInterval(() => {
  if (document.visibilityState === 'visible') cloud.refresh();
}, 15000);
