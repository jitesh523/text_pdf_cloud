import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleUpload as sdkHandleUpload } from '@vercel/blob/client';
import { FILE_PREFIX, MAX_FILE_BYTES, makeFilePath, parseFilePath } from '../lib/file-paths.js';
import { createFilesHandler, createDownloadHandler, createUploadHandler, MAX_UPLOAD_REQUEST_BYTES } from '../lib/files-handler.js';

const SITE = 'https://textdesk-tan.vercel.app';
const ID = '620185a1-3af0-4b3c-981c-0e3b63e2a263';
const OTHER_ID = 'f6490fc0-a99e-4498-b25f-8c2c5aad25a0';
const PATH = makeFilePath('Report.pdf', ID);
const noLog = () => {};

function request(route, method = 'GET', body, headers = {}) {
  return new Request(`${SITE}/api/${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function uploadEvent({ name = 'Report.pdf', path = makeFilePath(name, ID), size = 10, type = 'application/pdf', multipart = false } = {}) {
  return { type: 'blob.generate-client-token', payload: { pathname: path, clientPayload: JSON.stringify({ name, size, type }), multipart } };
}

function mockUploader() {
  const calls = [];
  const handler = createUploadHandler({
    logError: noLog,
    now: () => 123456,
    async handleUpload(options) {
      calls.push(options);
      const { pathname, clientPayload, multipart } = options.body.payload;
      calls.at(-1).constraints = await options.onBeforeGenerateToken(pathname, clientPayload, multipart);
      return { type: options.body.type, clientToken: 'scoped-test-token' };
    },
  });
  return { handler, calls };
}

test('managed paths preserve arbitrary opaque, Unicode and long names without Node-only APIs', () => {
  const names = ['Report.pdf', '  notes and spaces  .txt', 'हिन्दी 🐈‍⬛ e\u0301.pdf', 'quote";100%+#&?.html', '\uFEFFdocument', '😀'.repeat(128)];
  for (const name of names) {
    const path = makeFilePath(name, ID);
    assert.ok(path.startsWith(FILE_PREFIX));
    assert.deepEqual(parseFilePath(path), { name, id: ID });
  }
  const random = makeFilePath('phone photo.heic');
  assert.equal(parseFilePath(random).name, 'phone photo.heic');
  assert.notEqual(random, makeFilePath('phone photo.heic'));
});

test('paths reject namespace escapes, malformed UUIDs, noncanonical encodings and invalid names', () => {
  for (const name of ['', 'a/b.txt', 'a\\b.txt', 'nul\0.txt', 'line\n.txt', 'c1\u0085.txt', '\ud800', 'x'.repeat(256), 'ह'.repeat(171)]) {
    assert.throws(() => makeFilePath(name, ID), TypeError);
  }
  for (const path of [
    null, 'textdesk/library-v1.json', PATH.replace('textdesk/files/', 'textdesk/files-other/'),
    `../${PATH}`, `${PATH}/extra`, `${PATH}=`, PATH.replace(ID, 'not-a-uuid'),
    PATH.replace(ID, ID.replace('-4b3c-', '-1b3c-')), `${FILE_PREFIX}${ID}/YQ_`,
    `${FILE_PREFIX}${ID}/Yg==`, `${FILE_PREFIX}${ID}/AA`, `${FILE_PREFIX}${ID}/_w`,
    `${FILE_PREFIX}${ID}/Li4vbm90ZXM`, `https://store.blob.vercel-storage.com/${PATH}`,
  ]) assert.equal(parseFilePath(path), null, String(path));
});

test('upload tokens allow fresh managed files up to 100 MiB without changing names or overwriting', async () => {
  const { handler, calls } = mockUploader();
  for (const event of [uploadEvent(), uploadEvent({ name: '手机 🧡.heic', size: MAX_FILE_BYTES, type: 'image/heic', multipart: true }), uploadEvent({ name: 'empty.bin', size: 0, type: '' })]) {
    const response = await handler(request('upload', 'POST', event, { Origin: SITE }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).clientToken, 'scoped-test-token');
    const options = calls.at(-1).constraints;
    assert.equal(options.maximumSizeInBytes, MAX_FILE_BYTES);
    assert.equal(options.addRandomSuffix, false);
    assert.equal(options.allowOverwrite, false);
    assert.equal(options.validUntil, 123456 + 60 * 60 * 1000);
    assert.equal('allowedContentTypes' in options, false);
    assert.deepEqual(JSON.parse(options.tokenPayload), { ...JSON.parse(event.payload.clientPayload), type: JSON.parse(event.payload.clientPayload).type || 'application/octet-stream' });
  }
});

test('upload validation rejects wrong paths, metadata, size and origins before issuing any token', async () => {
  const { handler, calls } = mockUploader();
  const invalid = [
    [uploadEvent({ path: 'textdesk/library-v1.json' }), 400],
    [uploadEvent({ path: `../${PATH}` }), 400],
    [uploadEvent({ path: makeFilePath('different.pdf', ID) }), 400],
    [uploadEvent({ size: MAX_FILE_BYTES + 1 }), 413],
    ...[-1, 0.5, null, '10'].map(size => [uploadEvent({ size }), 400]),
    [uploadEvent({ type: null }), 400], [uploadEvent({ type: 'text/html\r\nx: bad' }), 400],
    [uploadEvent({ multipart: 'yes' }), 400],
    [{ type: 'blob.generate-client-token', payload: { pathname: PATH, clientPayload: 'oops', multipart: false } }, 400],
    [{ type: 'unknown' }, 400], [null, 400],
  ];
  for (const [body, status] of invalid) assert.equal((await handler(request('upload', 'POST', body))).status, status);
  assert.equal((await handler(request('upload', 'POST', uploadEvent(), { Origin: 'https://another.example' }))).status, 403);
  assert.equal(calls.length, 0);
});

test('upload route enforces JSON and a 16 KiB streaming body limit', async () => {
  const { handler, calls } = mockUploader();
  assert.equal((await handler(request('upload'))).status, 405);
  assert.equal((await handler(request('upload', 'POST', uploadEvent(), { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await handler(request('upload', 'POST', uploadEvent(), { 'Content-Length': String(MAX_UPLOAD_REQUEST_BYTES + 1) }))).status, 413);
  assert.equal((await handler(request('upload', 'POST', { ...uploadEvent(), padding: 'x'.repeat(MAX_UPLOAD_REQUEST_BYTES) }))).status, 413);
  const malformed = new Request(`${SITE}/api/upload`, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
  assert.equal((await handler(malformed)).status, 400);
  const empty = new Request(`${SITE}/api/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal((await handler(empty)).status, 400);
  assert.equal(calls.length, 0);
});

test('real Blob SDK generates a pathname-scoped token and verifies callback signatures', async () => {
  const fakeToken = 'vercel_blob_rw_teststore_TEST_ONLY_NOT_A_CREDENTIAL';
  const handler = createUploadHandler({ handleUpload: options => sdkHandleUpload({ ...options, token: fakeToken }), logError: noLog });
  const response = await handler(request('upload', 'POST', uploadEvent()));
  assert.equal(response.status, 200);
  const { clientToken } = await response.json();
  const payload = JSON.parse(Buffer.from(Buffer.from(clientToken.split('_').slice(4).join('_'), 'base64').toString().split('.')[1], 'base64').toString());
  assert.equal(payload.pathname, PATH);
  assert.equal(payload.maximumSizeInBytes, MAX_FILE_BYTES);
  assert.equal(payload.allowOverwrite, false);
  assert.equal(payload.addRandomSuffix, false);
  assert.ok(payload.validUntil > Date.now() && payload.validUntil <= Date.now() + 60 * 60 * 1000);

  const callback = { type: 'blob.upload-completed', payload: { blob: { pathname: PATH }, tokenPayload: null } };
  assert.equal((await handler(request('upload', 'POST', callback))).status, 403);
  assert.equal((await handler(request('upload', 'POST', callback, { 'x-vercel-signature': '0'.repeat(64) }))).status, 403);
  const signature = createHmac('sha256', fakeToken).update(JSON.stringify(callback)).digest('hex');
  const accepted = await handler(request('upload', 'POST', callback, { 'x-vercel-signature': signature }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { type: 'blob.upload-completed', response: 'ok' });
});

test('upload storage errors and missing cloud confirmations never report success', async () => {
  for (const handleUpload of [async () => { throw new Error('storage credentials or contents'); }, async () => ({}), async () => ({ clientToken: '' })]) {
    const handler = createUploadHandler({ handleUpload, logError: noLog });
    const response = await handler(request('upload', 'POST', uploadEvent()));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /credentials or contents/);
  }
});

test('cloud list is public, confined to file prefix, sorted, safe and paginated', async () => {
  const calls = [];
  const unicodePath = makeFilePath('手機 🧡 photo.jpg', OTHER_ID);
  const handler = createFilesHandler({ logError: noLog, async list(options) {
    calls.push(options);
    return { blobs: [
      { pathname: PATH, size: 0, uploadedAt: new Date('2026-10-15T00:00:00Z') },
      { pathname: 'textdesk/library-v1.json', size: 100, uploadedAt: new Date() },
      { pathname: unicodePath, size: 1312, uploadedAt: new Date('2026-10-16T00:00:00Z'), downloadUrl: 'https://ignored-private-url' },
    ], hasMore: true, cursor: 'opaque+/cursor=' };
  } });
  const response = await handler(request('files?cursor=previous%2Bcursor%3D'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [{ prefix: FILE_PREFIX, limit: 1000, cursor: 'previous+cursor=' }]);
  assert.deepEqual(await response.json(), {
    files: [
      { pathname: unicodePath, name: '手機 🧡 photo.jpg', size: 1312, uploadedAt: '2026-10-16T00:00:00.000Z', downloadUrl: `/api/download?path=${encodeURIComponent(unicodePath)}` },
      { pathname: PATH, name: 'Report.pdf', size: 0, uploadedAt: '2026-10-15T00:00:00.000Z', downloadUrl: `/api/download?path=${encodeURIComponent(PATH)}` },
    ], hasMore: true, cursor: 'opaque+/cursor=', maxFileBytes: MAX_FILE_BYTES,
  });
});

test('empty lists succeed, malformed cursors fail and provider failures are explicit', async () => {
  let called = 0;
  const handler = createFilesHandler({ logError: noLog, async list() { called++; return { blobs: [], hasMore: false }; } });
  const response = await handler(request('files'));
  assert.deepEqual(await response.json(), { files: [], hasMore: false, cursor: null, maxFileBytes: MAX_FILE_BYTES });
  for (const cursor of ['', 'x'.repeat(4097), '\n']) assert.equal((await handler(request(`files?cursor=${encodeURIComponent(cursor)}`))).status, 400);
  assert.equal(called, 1);
  for (const list of [async () => { throw new Error('private detail'); }, async () => null, async () => ({ blobs: [], hasMore: true })]) {
    const unavailable = createFilesHandler({ list, logError: noLog });
    const result = await unavailable(request('files'));
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /private detail/);
  }
});

test('downloads preserve every binary byte and the original Unicode name as a safe attachment', async () => {
  const name = '手機 🧡 100% "quoted"; file.html';
  const path = makeFilePath(name, ID);
  const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);
  const calls = [];
  const handler = createDownloadHandler({ logError: noLog, async get(...args) {
    calls.push(args);
    return { statusCode: 200, stream: new Response(bytes).body, blob: { size: bytes.byteLength, contentType: 'text/html' } };
  } });
  const response = await handler(request(`download?path=${encodeURIComponent(path)}`));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [[path, { access: 'private', useCache: false }]]);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
  const disposition = response.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="[A-Za-z0-9 ._()-]+"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('empty files download and missing files or bad cloud responses never return fake file content', async () => {
  const empty = createDownloadHandler({ logError: noLog, async get() { return { statusCode: 200, stream: new Response(new Uint8Array()).body, blob: { size: 0 } }; } });
  const response = await empty(request(`download?path=${encodeURIComponent(PATH)}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '0');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  for (const [get, status] of [
    [async () => null, 404], [async () => ({ statusCode: 304, stream: null }), 503],
    [async () => ({ statusCode: 200, stream: null }), 503], [async () => { throw new Error('cloud down'); }, 503],
  ]) {
    const handler = createDownloadHandler({ get, logError: noLog });
    assert.equal((await handler(request(`download?path=${encodeURIComponent(PATH)}`))).status, status);
  }
});

test('downloads and deletes cannot access notes, URLs or files outside the managed namespace', async () => {
  const calls = [];
  const files = createFilesHandler({ logError: noLog, async del(...args) { calls.push(args); } });
  const download = createDownloadHandler({ logError: noLog, async get(...args) { calls.push(args); } });
  for (const path of ['textdesk/library-v1.json', 'other/file.txt', `../${PATH}`, `${PATH}/extra`, `https://example.com/${PATH}`, '']) {
    assert.equal((await files(request(`files?path=${encodeURIComponent(path)}`, 'DELETE'))).status, 400);
    assert.equal((await download(request(`download?path=${encodeURIComponent(path)}`))).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await files(request(`files?path=${encodeURIComponent(PATH)}`, 'DELETE', undefined, { Origin: 'https://another.example' }))).status, 403);
  assert.equal(calls.length, 0);
  const response = await files(request(`files?path=${encodeURIComponent(PATH)}`, 'DELETE', undefined, { Origin: SITE }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(calls, [[PATH]]);
});

test('delete failures remain errors, and route method restrictions are explicit', async () => {
  const files = createFilesHandler({ logError: noLog, async del() { throw new Error('delete failed'); } });
  const response = await files(request(`files?path=${encodeURIComponent(PATH)}`, 'DELETE'));
  assert.equal(response.status, 503);
  assert.equal((await files(request('files', 'POST'))).status, 405);
  const download = createDownloadHandler({ get() { throw new Error('should not call'); }, logError: noLog });
  assert.equal((await download(request('download', 'POST'))).status, 405);
});
