import test from 'node:test';
import assert from 'node:assert/strict';
import { mountFileBridge, formatFileSize } from '../src/files.js';
import { MAX_FILE_BYTES } from '../lib/file-paths.js';

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.events = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = '';
    this.classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => this.classes.add(value)),
      remove: (...values) => values.forEach(value => this.classes.delete(value)),
      contains: value => this.classes.has(value),
      toggle: (value, force) => {
        const enabled = force ?? !this.classes.has(value);
        if (enabled) this.classes.add(value); else this.classes.delete(value);
        return enabled;
      },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.append(...node.children);
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) {
    const handlers = this.events.get(name) || new Set();
    handlers.add(handler);
    this.events.set(name, handlers);
  }
  removeEventListener(name, handler) { this.events.get(name)?.delete(handler); }
  emit(name, data = {}) {
    const event = { preventDefault() { this.defaultPrevented = true; }, ...data };
    for (const handler of this.events.get(name) || []) handler(event);
    return event;
  }
  click() { this.emit('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const IDS = ['file-panel', 'notes-panel', 'show-files', 'show-notes', 'file-list', 'files-empty',
  'files-status', 'file-count', 'refresh-files', 'file-input', 'choose-files', 'file-dropzone',
  'upload-queue', 'load-more-files', 'delete-file-dialog', 'delete-file-name',
  'cancel-file-delete', 'confirm-file-delete', 'file-delete-error', 'library-toggle'];

function setup({ fetchFn = async () => json({ files: [], hasMore: false, cursor: null }), uploadFn, hash = '' } = {}) {
  const nodes = new Map(IDS.map(id => [id, new FakeNode()]));
  const document = new FakeNode('document');
  document.body = new FakeNode('body');
  document.visibilityState = 'visible';
  document.getElementById = id => nodes.get(id);
  document.createElement = tag => new FakeNode(tag);
  document.createDocumentFragment = () => new FakeNode('#fragment');
  const window = new FakeNode('window');
  window.location = new URL(`https://textdesk-tan.vercel.app/${hash}`);
  window.history = { state: null, replaceState(state, title, url) { window.location = new URL(url); } };
  window.setInterval = callback => { window.poll = callback; return 7; };
  window.clearInterval = value => { window.cleared = value; };
  const bridge = mountFileBridge({ document, window, fetchFn, uploadFn });
  return { bridge, document, window, nodes, node: id => nodes.get(id) };
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function file(name = 'photo.jpg', size = 24, type = 'image/jpeg') { return { name, size, type }; }
function record(name = 'photo.jpg', id = 'example') {
  const pathname = `files/${id}/${encodeURIComponent(name)}`;
  return { pathname, name, size: 24, uploadedAt: '2026-10-16T10:00:00.000Z', downloadUrl: `/api/download?path=${encodeURIComponent(pathname)}` };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const queueRow = (ui, index = 0) => ui.node('upload-queue').children[index];
const queueActions = row => row.children[0].children[1].children;

test('human file sizes use the upload limit consistently', () => {
  assert.equal(formatFileSize(0), '0 bytes');
  assert.equal(formatFileSize(1), '1 byte');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(MAX_FILE_BYTES), '100 MB');
});

test('files navigation preserves notes and refreshes from the cloud on return and focus', async () => {
  let calls = 0;
  const ui = setup({ fetchFn: async () => { calls++; return json({ files: [], hasMore: false }); } });
  ui.document.body.classList.add('library-open');
  ui.node('show-files').click();
  await settle();
  assert.equal(calls, 1);
  assert.equal(ui.node('notes-panel').hidden, true);
  assert.equal(ui.node('file-panel').hidden, false);
  assert.equal(ui.document.body.classList.contains('library-open'), false);
  assert.equal(ui.node('show-files').getAttribute('aria-current'), 'page');
  assert.equal(ui.window.location.hash, '#files');
  assert.equal(ui.node('library-toggle').getAttribute('aria-expanded'), 'false');
  ui.window.emit('focus');
  await settle();
  assert.equal(calls, 2);
  ui.node('show-notes').click();
  ui.window.poll();
  await settle();
  assert.equal(calls, 2);
  assert.equal(ui.node('notes-panel').hidden, false);
  assert.equal(ui.window.location.hash, '');
  ui.bridge.stop();
  assert.equal(ui.window.cleared, 7);
  ui.window.emit('focus');
  assert.equal(calls, 2);
});

test('multiple files upload in sequence, progress is truthful, and only confirmed results save', async () => {
  const first = deferred();
  const received = [];
  const ui = setup({ uploadFn: (pathname, selected, options) => {
    received.push({ pathname, selected, options });
    if (received.length === 1) return first.promise;
    return Promise.resolve({ pathname });
  } });
  const finished = ui.bridge.uploadFiles([file('one.txt'), file('two.zip', 6 * 1024 * 1024, '')]);
  assert.equal(received.length, 1);
  assert.equal(queueRow(ui).dataset.state, 'uploading');
  assert.equal(queueRow(ui, 1).dataset.state, 'queued');
  received[0].options.onUploadProgress({ percentage: 100 });
  assert.match(queueRow(ui).textContent, /99%/);
  assert.doesNotMatch(queueRow(ui).textContent, /Saved to cloud/);
  first.resolve({ pathname: received[0].pathname });
  const tasks = await finished;
  assert.equal(received.length, 2);
  assert.deepEqual(tasks.map(task => task.state), ['saved', 'saved']);
  assert.equal(received[0].options.access, 'private');
  assert.equal(received[0].options.handleUploadUrl, '/api/upload');
  assert.equal(received[0].options.multipart, false);
  assert.equal(received[1].options.multipart, true);
  assert.deepEqual(JSON.parse(received[1].options.clientPayload), { name: 'two.zip', size: 6 * 1024 * 1024, type: '' });
  assert.equal('addRandomSuffix' in received[0].options, false);
  assert.equal('token' in received[0].options, false);
  assert.match(queueRow(ui).textContent, /Saved to cloud/);
  assert.equal(ui.node('file-list').children.length, 2);
  ui.bridge.stop();
});

test('invalid files are rejected before obtaining upload tokens and do not block valid files', async () => {
  const received = [];
  const ui = setup({ uploadFn: async (pathname, selected) => { received.push(selected); return { pathname }; } });
  const tasks = await ui.bridge.uploadFiles([file('too-large.bin', MAX_FILE_BYTES + 1), file('bad/name.txt'), file('good.txt')]);
  assert.deepEqual(tasks.map(task => task.state), ['error', 'error', 'saved']);
  assert.equal(received.length, 1);
  assert.match(queueRow(ui).textContent, /100 MB/);
  assert.equal(queueActions(queueRow(ui))[0].hidden, true);
  ui.bridge.stop();
});

test('failed uploads retain a retry and never claim cloud success until retry completes', async () => {
  let calls = 0;
  const paths = [];
  const ui = setup({ uploadFn: async pathname => {
    calls++;
    paths.push(pathname);
    if (calls === 1) throw new TypeError('Failed to fetch');
    return { pathname };
  } });
  const [task] = await ui.bridge.uploadFiles([file()]);
  assert.equal(task.state, 'error');
  assert.equal(ui.node('file-list').children.length, 0);
  assert.match(queueRow(ui).textContent, /Check your internet/);
  assert.doesNotMatch(queueRow(ui).textContent, /Saved to cloud/);
  queueActions(queueRow(ui))[0].click();
  await settle();
  assert.equal(calls, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.equal(task.state, 'saved');
  assert.equal(task.file, null);
  assert.match(queueRow(ui).textContent, /Saved to cloud/);
  ui.bridge.stop();
});

test('a direct files link opens and refreshes the cloud file panel', async () => {
  let calls = 0;
  const ui = setup({ hash: '#files', fetchFn: async () => { calls++; return json({ files: [], hasMore: false }); } });
  await settle();
  assert.equal(calls, 1);
  assert.equal(ui.node('file-panel').hidden, false);
  assert.equal(ui.node('notes-panel').hidden, true);
  ui.bridge.stop();
});

test('cancel aborts a running upload and the next file still uploads', async () => {
  const received = [];
  const ui = setup({ uploadFn: (pathname, selected, options) => {
    received.push({ selected, options });
    if (received.length > 1) return Promise.resolve({ pathname });
    return new Promise((resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  } });
  const finished = ui.bridge.uploadFiles([file('cancel-me.jpg'), file('keep-me.jpg')]);
  queueActions(queueRow(ui))[1].click();
  const tasks = await finished;
  assert.equal(received[0].options.abortSignal.aborted, true);
  assert.deepEqual(tasks.map(task => task.state), ['cancelled', 'saved']);
  assert.equal(ui.node('file-list').children.length, 1);
  ui.bridge.stop();
});

test('an older in-flight list cannot erase an upload and a listing failure preserves its saved state', async () => {
  const listing = deferred();
  const ui = setup({ fetchFn: () => listing.promise, uploadFn: async pathname => ({ pathname }) });
  const refreshing = ui.bridge.refresh();
  await ui.bridge.uploadFiles([file('from-phone.pdf')]);
  assert.equal(ui.node('file-list').children.length, 1);
  listing.resolve(json({ files: [], hasMore: false }));
  await refreshing;
  assert.equal(ui.node('file-list').children.length, 1);
  assert.match(queueRow(ui).textContent, /Saved to cloud/);
  ui.bridge.stop();
  const failed = setup({ fetchFn: async () => { throw new TypeError('Failed to fetch'); }, uploadFn: async pathname => ({ pathname }) });
  await failed.bridge.uploadFiles([file('already-saved.txt')]);
  await settle();
  assert.match(queueRow(failed).textContent, /Saved to cloud/);
  assert.equal(failed.node('file-list').children.length, 1);
  failed.bridge.stop();
});

test('file names render as text and links only use the same-origin download endpoint', async () => {
  const name = '<img src=x onerror=alert(1)>.txt';
  const good = record(name);
  const evil = { ...record('evil.html', 'evil'), downloadUrl: 'https://evil.example/steal' };
  const wrongPath = { ...record('wrong.txt', 'wrong'), downloadUrl: '/api/download?path=another-path' };
  const ui = setup({ fetchFn: async () => json({ files: [good, evil, wrongPath], hasMore: false }) });
  await ui.bridge.refresh();
  const row = ui.node('file-list').children[0];
  assert.equal(ui.node('file-list').children.length, 1);
  assert.equal(row.children[1].children[0].textContent, name);
  assert.equal(row.children[2].children[0].href, good.downloadUrl);
  assert.equal(row.children[2].children[0].download, name);
  ui.bridge.stop();
});

test('pagination merges existing entries without duplicate paths', async () => {
  const one = record('first.txt', 'one');
  const two = record('second.txt', 'two');
  const urls = [];
  const ui = setup({ fetchFn: async url => {
    urls.push(url);
    return json(urls.length === 1 ? { files: [one], cursor: 'next+/=', hasMore: true } : { files: [one, two], cursor: null, hasMore: false });
  } });
  await ui.bridge.refresh();
  assert.equal(ui.node('load-more-files').hidden, false);
  assert.equal(ui.node('file-count').textContent, '1+');
  await ui.bridge.refresh({ append: true });
  assert.equal(urls[1], '/api/files?cursor=next%2B%2F%3D');
  assert.equal(ui.node('file-list').children.length, 2);
  assert.equal(ui.node('load-more-files').hidden, true);
  ui.bridge.stop();
});

test('deletion waits for confirmation and keeps the file after a failed delete', async () => {
  const stored = record('keep until confirmed.txt');
  const methods = [];
  let fail = true;
  const ui = setup({ fetchFn: async (url, options = {}) => {
    methods.push(options.method || 'GET');
    if (options.method === 'DELETE') return fail ? json({ error: 'Delete unavailable. Try again.' }, 503) : json({ deleted: true });
    return json({ files: [stored], hasMore: false });
  } });
  await ui.bridge.refresh();
  ui.node('file-list').children[0].children[2].children[1].click();
  assert.deepEqual(methods, ['GET']);
  assert.equal(ui.node('delete-file-dialog').open, true);
  assert.equal(ui.node('delete-file-name').textContent, stored.name);
  ui.node('confirm-file-delete').click();
  await settle();
  assert.equal(ui.node('file-list').children.length, 1);
  assert.equal(ui.node('delete-file-dialog').open, true);
  assert.equal(ui.node('file-delete-error').hidden, false);
  assert.equal(ui.node('confirm-file-delete').disabled, false);
  fail = false;
  ui.node('confirm-file-delete').click();
  await settle();
  assert.equal(ui.node('file-list').children.length, 0);
  assert.equal(ui.node('delete-file-dialog').open, false);
  ui.bridge.stop();
});

test('picker resets so the same file can be selected again, and uploads stop cleanly', async () => {
  let called = 0;
  const ui = setup({ uploadFn: async pathname => { called++; return { pathname }; } });
  ui.node('file-input').files = [file('twice.txt')];
  ui.node('file-input').value = '/fake/path';
  ui.node('file-input').emit('change');
  await settle();
  assert.equal(ui.node('file-input').value, '');
  ui.node('file-input').emit('change');
  await settle();
  assert.equal(called, 2);
  ui.bridge.stop();
  await ui.bridge.uploadFiles([file('after-stop.txt')]);
  assert.equal(called, 2);
});
