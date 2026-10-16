import { upload } from '@vercel/blob/client';
import { makeFilePath, MAX_FILE_BYTES } from '../lib/file-paths.js';

const TERMINAL_STATES = new Set(['saved', 'error', 'cancelled']);

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function friendlyError(error, fallback) {
  if (error?.name === 'AbortError') return 'Upload cancelled. You can try again.';
  if (error?.name === 'TypeError' || /network|fetch|offline/i.test(error?.message || '')) {
    return 'Could not connect. Check your internet connection and try again.';
  }
  return error?.userMessage || fallback;
}

async function readResponse(response, fallback) {
  let data;
  try { data = await response.json(); } catch { /* A failed proxy may return HTML. */ }
  if (!response.ok) {
    const error = new Error(fallback);
    // Only show messages from our JSON endpoints, never a raw upstream response.
    if (typeof data?.error === 'string') error.userMessage = data.error;
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error(fallback);
  return data;
}

export function mountFileBridge({
  document = globalThis.document,
  fetchFn = globalThis.fetch,
  uploadFn = upload,
  window = globalThis.window,
} = {}) {
  const byId = id => document?.getElementById(id);
  const panel = byId('file-panel');
  if (!panel) return { refresh: async () => {}, uploadFiles: async () => [], stop() {} };
  const ui = {
    panel, notes: byId('notes-panel'), filesNav: byId('show-files'), notesNav: byId('show-notes'),
    list: byId('file-list'), empty: byId('files-empty'), status: byId('files-status'),
    count: byId('file-count'), refresh: byId('refresh-files'), input: byId('file-input'),
    choose: byId('choose-files'), dropzone: byId('file-dropzone'), queue: byId('upload-queue'),
    more: byId('load-more-files'), dialog: byId('delete-file-dialog'),
    deleteName: byId('delete-file-name'), deleteCancel: byId('cancel-file-delete'),
    deleteConfirm: byId('confirm-file-delete'), deleteError: byId('file-delete-error'),
  };
  const listeners = [];
  const tasks = [];
  const confirmedUploads = new Map();
  let files = new Map();
  let cursor = null;
  let hasMore = false;
  let stopped = false;
  let filesView = false;
  let listFlight = null;
  let worker = null;
  let deleteTarget = null;
  let deleting = false;
  let refreshController = null;
  let dragDepth = 0;
  let taskId = 0;
  const deletedPaths = new Set();
  const origin = window?.location?.origin || 'https://textdesk.invalid';

  function listen(element, event, callback, options) {
    if (!element?.addEventListener) return;
    element.addEventListener(event, callback, options);
    listeners.push(() => element.removeEventListener(event, callback, options));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function status(message, state = 'ready') {
    if (stopped || !ui.status) return;
    ui.status.textContent = message;
    ui.status.dataset.state = state;
  }

  function normalizeFile(file) {
    if (!file || typeof file.pathname !== 'string' || typeof file.name !== 'string' ||
        !Number.isFinite(file.size) || file.size < 0 || typeof file.downloadUrl !== 'string') return null;
    try {
      const url = new URL(file.downloadUrl, origin);
      if (url.origin !== origin || url.pathname !== '/api/download' || url.searchParams.get('path') !== file.pathname) return null;
      return { ...file, downloadUrl: `${url.pathname}${url.search}`, uploadedAt: file.uploadedAt || '' };
    } catch { return null; }
  }

  function fileTime(file) {
    const time = Date.parse(file.uploadedAt);
    return Number.isNaN(time) ? 0 : time;
  }

  function renderFiles() {
    if (stopped) return;
    const fragment = document.createDocumentFragment();
    for (const file of [...files.values()].sort((a, b) => fileTime(b) - fileTime(a) || a.name.localeCompare(b.name))) {
      const row = element('li', 'file-card');
      row.dataset.path = file.pathname;
      const extension = file.name.includes('.') ? file.name.split('.').pop().slice(0, 5).toUpperCase() : 'FILE';
      const icon = element('span', 'file-icon', extension || 'FILE');
      icon.setAttribute('aria-hidden', 'true');
      const info = element('div', 'file-info');
      const name = element('span', 'file-name', file.name);
      const metadata = [formatFileSize(file.size)];
      if (fileTime(file)) metadata.push(new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(new Date(file.uploadedAt)));
      info.append(name, element('span', 'file-meta', metadata.join(' · ')));
      const actions = element('div', 'file-actions');
      const download = element('a', 'file-download tool-button', 'Download');
      download.href = file.downloadUrl;
      download.download = file.name;
      download.setAttribute('aria-label', `Download ${file.name}`);
      const remove = element('button', 'file-delete icon-button', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete ${file.name} from cloud`);
      remove.addEventListener('click', () => requestDelete(file));
      actions.append(download, remove);
      row.append(icon, info, actions);
      fragment.append(row);
    }
    ui.list?.replaceChildren(fragment);
    if (ui.empty) ui.empty.hidden = files.size > 0;
    if (ui.count) {
      ui.count.textContent = `${files.size}${hasMore ? '+' : ''}`;
      ui.count.setAttribute('aria-label', `${files.size}${hasMore ? ' or more' : ''} cloud files`);
    }
    if (ui.more) { ui.more.hidden = !hasMore; ui.more.disabled = Boolean(listFlight); }
  }

  async function refresh({ append = false, silent = false } = {}) {
    if (stopped) return;
    if (listFlight) return listFlight;
    if (append && !hasMore) return;
    refreshController = new AbortController();
    const controller = refreshController;
    if (!silent) status(append ? 'Loading more files…' : 'Checking cloud files…', 'loading');
    if (ui.refresh) ui.refresh.disabled = true;
    if (ui.more) ui.more.disabled = true;
    const requestedCursor = append ? cursor : null;
    listFlight = (async () => {
      // Also handle injected transports that throw before returning a promise.
      await Promise.resolve();
      try {
        const url = requestedCursor ? `/api/files?cursor=${encodeURIComponent(requestedCursor)}` : '/api/files';
        const response = await fetchFn(url, { cache: 'no-store', signal: controller.signal });
        const data = await readResponse(response, 'Could not load the cloud files. Try Refresh.');
        if (!Array.isArray(data.files)) throw new Error('Invalid file list');
        if (stopped) return;
        const next = append ? new Map(files) : new Map();
        for (const item of data.files) {
          const file = normalizeFile(item);
          if (!file || deletedPaths.has(file.pathname)) continue;
          next.set(file.pathname, file);
          confirmedUploads.delete(file.pathname);
        }
        // An older list request must never remove a just-completed upload.
        for (const [path, file] of confirmedUploads) if (!deletedPaths.has(path)) next.set(path, file);
        files = next;
        cursor = typeof data.cursor === 'string' ? data.cursor : null;
        hasMore = Boolean(data.hasMore && cursor);
        renderFiles();
        if (!silent) status(files.size ? 'Files are saved in the cloud. Open this link on your other device.' : 'Ready for your first file.', 'ready');
        return true;
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          status(friendlyError(error, 'Could not load the cloud files. Try Refresh.'), 'error');
        }
        return false;
      } finally {
        listFlight = null;
        if (!stopped) {
          if (ui.refresh) ui.refresh.disabled = false;
          if (ui.more) ui.more.disabled = false;
        }
      }
    })();
    return listFlight;
  }

  function setView(showFiles, { updateHash = true } = {}) {
    if (stopped) return;
    filesView = showFiles;
    document.body.classList.toggle('files-view', showFiles);
    document.body.classList.remove('library-open');
    byId('library-toggle')?.setAttribute('aria-expanded', 'false');
    if (ui.notes) ui.notes.hidden = showFiles;
    ui.panel.hidden = !showFiles;
    for (const [node, active] of [[ui.filesNav, showFiles], [ui.notesNav, !showFiles]]) {
      node?.setAttribute('aria-pressed', String(active));
      node?.setAttribute('aria-current', active ? 'page' : 'false');
    }
    if (updateHash && window?.history?.replaceState) {
      const url = new URL(window.location.href);
      if (showFiles) url.hash = 'files';
      else if (url.hash === '#files') url.hash = '';
      window.history.replaceState(window.history.state, '', url);
    }
    if (showFiles) void refresh();
  }

  function ensureTaskRow(task) {
    if (task.row) return;
    const row = element('li', 'upload-item');
    const heading = element('div', 'upload-item-heading');
    const name = element('span', 'upload-name', task.name);
    const actions = element('div', 'upload-actions');
    const cancel = element('button', 'upload-cancel tool-button', 'Cancel');
    cancel.type = 'button';
    cancel.setAttribute('aria-label', `Cancel upload of ${task.name}`);
    cancel.addEventListener('click', () => {
      if (task.state === 'queued') {
        task.state = 'cancelled';
        task.message = 'Upload cancelled. Nothing was saved.';
        task.complete(task);
      } else if (task.state === 'uploading') {
        task.state = 'cancelling';
        task.message = 'Cancelling upload…';
        task.controller?.abort();
      }
      updateTask(task);
    });
    const retry = element('button', 'upload-retry tool-button', 'Try again');
    retry.type = 'button';
    retry.setAttribute('aria-label', `Retry upload of ${task.name}`);
    retry.addEventListener('click', () => {
      if (!task.file || !['error', 'cancelled'].includes(task.state)) return;
      // The earlier request may have reached storage before its response was lost.
      // A fresh ID lets this attempt succeed without overwriting any cloud file.
      task.pathname = makeFilePath(task.name);
      task.state = 'queued';
      task.percent = 0;
      task.message = 'Waiting to upload…';
      updateTask(task);
      void pump();
    });
    actions.append(retry, cancel);
    heading.append(name, actions);
    const progress = element('progress', 'upload-progress');
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute('aria-label', `Uploading ${task.name}`);
    const message = element('span', 'upload-message');
    row.append(heading, progress, message);
    task.row = row;
    task.elements = { progress, message, cancel, retry };
    ui.queue?.append(row);
    if (ui.queue) ui.queue.hidden = false;
  }

  function updateTask(task) {
    if (stopped) return;
    ensureTaskRow(task);
    task.row.dataset.state = task.state;
    const { progress, message, cancel, retry } = task.elements;
    progress.value = task.percent;
    progress.hidden = !['uploading', 'cancelling'].includes(task.state);
    message.textContent = task.message;
    cancel.hidden = !['queued', 'uploading', 'cancelling'].includes(task.state);
    cancel.disabled = task.state === 'cancelling';
    retry.hidden = !['error', 'cancelled'].includes(task.state) || !task.file || task.invalid;
  }

  async function runTask(task) {
    task.state = 'uploading';
    task.controller = new AbortController();
    task.message = 'Uploading… 0%';
    updateTask(task);
    status(`Uploading ${task.name}… Keep this page open.`, 'loading');
    try {
      const file = task.file;
      const result = await uploadFn(task.pathname, file, {
        access: 'private',
        handleUploadUrl: '/api/upload',
        multipart: file.size > 4 * 1024 * 1024,
        clientPayload: JSON.stringify({ name: file.name, size: file.size, type: file.type || '' }),
        abortSignal: task.controller.signal,
        onUploadProgress(event) {
          if (stopped || task.state !== 'uploading') return;
          task.percent = Math.min(99, Math.max(0, Math.floor(event.percentage || 0)));
          task.message = `Uploading… ${task.percent}%`;
          updateTask(task);
        },
      });
      if (!result || result.pathname !== task.pathname) throw new Error('Upload response did not confirm the file');
      if (stopped) return;
      const storedFile = {
        pathname: task.pathname, name: task.name, size: file.size,
        uploadedAt: new Date().toISOString(), downloadUrl: `/api/download?path=${encodeURIComponent(task.pathname)}`,
      };
      confirmedUploads.set(task.pathname, storedFile);
      files.set(task.pathname, storedFile);
      task.state = 'saved';
      task.percent = 100;
      task.message = 'Saved to cloud';
      task.file = null;
      updateTask(task);
      renderFiles();
      status(`${task.name} saved to cloud. Ready to download on your other device.`, 'saved');
      // The queue keeps its confirmed success even if listing is temporarily unavailable.
      void refresh({ silent: true });
    } catch (error) {
      if (stopped) return;
      if (task.controller.signal.aborted || error?.name === 'AbortError') {
        task.state = 'cancelled';
        task.message = 'Upload cancelled. You can try again.';
      } else {
        task.state = 'error';
        task.message = friendlyError(error, 'Upload did not complete. Try again.');
      }
      updateTask(task);
      status(task.state === 'cancelled' ? `Upload of ${task.name} cancelled.` : `${task.name}: ${task.message}`, task.state === 'cancelled' ? 'ready' : 'error');
    } finally {
      task.controller = null;
      task.complete(task);
    }
  }

  function pump() {
    if (worker || stopped) return worker;
    worker = (async () => {
      let next;
      while (!stopped && (next = tasks.find(task => task.state === 'queued'))) await runTask(next);
    })().finally(() => {
      worker = null;
      // A retry or a second selection can arrive as the previous worker settles.
      if (!stopped && tasks.some(task => task.state === 'queued')) void pump();
    });
    return worker;
  }

  function uploadFiles(fileList) {
    if (stopped) return Promise.resolve([]);
    const added = [];
    for (const file of Array.from(fileList || [])) {
      const task = { id: ++taskId, file, name: file?.name || 'Untitled file', percent: 0, state: 'queued', message: 'Waiting to upload…' };
      task.done = new Promise(resolve => { task.complete = resolve; });
      try {
        if (!file || typeof file.name !== 'string' || !Number.isFinite(file.size) || file.size < 0) {
          throw new Error('This file could not be read. Choose the file again.');
        }
        if (file.size > MAX_FILE_BYTES) throw new Error(`Choose a file of ${formatFileSize(MAX_FILE_BYTES)} or less.`);
        task.pathname = makeFilePath(file.name);
      } catch (error) {
        task.state = 'error';
        task.invalid = true;
        task.message = error.message || 'This filename is not supported. Rename the file and try again.';
        task.file = null;
        task.complete(task);
      }
      tasks.push(task);
      added.push(task);
      updateTask(task);
    }
    void pump();
    return Promise.all(added.map(task => task.done));
  }

  function closeDelete() {
    if (deleting) return;
    deleteTarget = null;
    if (typeof ui.dialog?.close === 'function') ui.dialog.close();
    else if (ui.dialog) ui.dialog.hidden = true;
  }

  function requestDelete(file) {
    if (deleting || stopped) return;
    deleteTarget = file;
    if (ui.deleteName) ui.deleteName.textContent = file.name;
    if (ui.deleteError) { ui.deleteError.hidden = true; ui.deleteError.textContent = ''; }
    if (typeof ui.dialog?.showModal === 'function') ui.dialog.showModal();
    else if (ui.dialog) ui.dialog.hidden = false;
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting || stopped) return;
    const file = deleteTarget;
    deleting = true;
    if (ui.deleteConfirm) { ui.deleteConfirm.disabled = true; ui.deleteConfirm.textContent = 'Deleting…'; }
    if (ui.deleteCancel) ui.deleteCancel.disabled = true;
    if (ui.deleteError) ui.deleteError.hidden = true;
    try {
      const response = await fetchFn(`/api/files?path=${encodeURIComponent(file.pathname)}`, { method: 'DELETE' });
      const result = await readResponse(response, 'Could not delete this file. Try again.');
      if (result.deleted !== true) throw new Error('Deletion was not confirmed');
      if (stopped) return;
      deletedPaths.add(file.pathname);
      confirmedUploads.delete(file.pathname);
      files.delete(file.pathname);
      renderFiles();
      status(`${file.name} deleted from cloud.`, 'ready');
      deleting = false;
      closeDelete();
      void refresh({ silent: true });
    } catch (error) {
      const message = friendlyError(error, 'Could not delete this file. Try again.');
      status(message, 'error');
      if (ui.deleteError && !stopped) { ui.deleteError.textContent = message; ui.deleteError.hidden = false; }
    } finally {
      deleting = false;
      if (!stopped) {
        if (ui.deleteConfirm) { ui.deleteConfirm.disabled = false; ui.deleteConfirm.textContent = 'Delete file'; }
        if (ui.deleteCancel) ui.deleteCancel.disabled = false;
      }
    }
  }

  listen(ui.filesNav, 'click', () => setView(true));
  listen(ui.notesNav, 'click', () => setView(false));
  listen(ui.choose, 'click', () => ui.input?.click());
  listen(ui.input, 'change', () => {
    const selected = Array.from(ui.input.files || []);
    ui.input.value = '';
    void uploadFiles(selected);
  });
  listen(ui.refresh, 'click', () => void refresh());
  listen(ui.more, 'click', () => void refresh({ append: true }));
  listen(ui.deleteCancel, 'click', closeDelete);
  listen(ui.deleteConfirm, 'click', () => void confirmDelete());
  listen(ui.dialog, 'cancel', event => { if (deleting) event.preventDefault(); else deleteTarget = null; });
  const isFilesDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  listen(ui.dropzone, 'dragenter', event => {
    if (!isFilesDrag(event)) return;
    event.preventDefault(); dragDepth++;
    ui.dropzone.classList.add('is-dragging');
  });
  listen(ui.dropzone, 'dragover', event => {
    if (!isFilesDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  listen(ui.dropzone, 'dragleave', event => {
    if (!isFilesDrag(event)) return;
    event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropzone.classList.remove('is-dragging');
  });
  listen(ui.dropzone, 'drop', event => {
    if (!isFilesDrag(event)) return;
    event.preventDefault(); dragDepth = 0;
    ui.dropzone.classList.remove('is-dragging');
    void uploadFiles(event.dataTransfer.files);
  });
  const refreshWhenVisible = () => {
    if (filesView && document.visibilityState !== 'hidden') void refresh({ silent: true });
  };
  listen(window, 'focus', refreshWhenVisible);
  listen(window, 'online', refreshWhenVisible);
  listen(window, 'hashchange', () => setView(window.location.hash === '#files', { updateHash: false }));
  listen(document, 'visibilitychange', refreshWhenVisible);
  const interval = window?.setInterval?.(refreshWhenVisible, 15_000);
  renderFiles();
  setView(window?.location?.hash === '#files', { updateHash: false });

  return {
    refresh,
    uploadFiles,
    stop() {
      stopped = true;
      listeners.forEach(remove => remove());
      if (interval !== undefined) window?.clearInterval?.(interval);
      refreshController?.abort();
      for (const task of tasks) {
        task.controller?.abort();
        if (!TERMINAL_STATES.has(task.state)) {
          task.state = 'cancelled';
          task.complete(task);
        }
        task.file = null;
      }
    },
  };
}

if (globalThis.document?.getElementById('file-panel')) mountFileBridge();
