import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotesHandler, NOTES_PATH, MAX_NOTES_BYTES } from '../lib/notes-handler.js';
import { makeNote } from '../dist/storage.js';

const SITE = 'https://textdesk-tan.vercel.app';

function stateWith(content = '') {
  const note = { ...makeNote(), title: '  Exact title  ', content, cursorStart: content.length, cursorEnd: content.length, scrollTop: 42.5 };
  return { version: 1, activeId: note.id, notes: [note], settings: { focusMode: true } };
}

function mockBlob(initial = null) {
  let version = initial === null ? 0 : 1;
  let stored = initial === null ? null : { state: structuredClone(initial), etag: '"v1"' };
  const calls = { get: [], put: [], errors: [] };
  const mock = {
    calls,
    beforePut: null,
    readError: null,
    writeError: null,
    overwrite(state) {
      version++;
      stored = { state: structuredClone(state), etag: `"v${version}"` };
      return stored;
    },
    snapshot() { return structuredClone(stored); },
    async get(pathname, options) {
      calls.get.push({ pathname, options });
      assert.equal(pathname, NOTES_PATH);
      assert.deepEqual(options, { access: 'private', useCache: false });
      if (mock.readError) throw mock.readError;
      if (stored === null) return null;
      return {
        statusCode: 200,
        stream: new Response(JSON.stringify(stored.state)).body,
        blob: { etag: stored.etag },
      };
    },
    async put(pathname, body, options) {
      calls.put.push({ pathname, body, options });
      assert.equal(pathname, NOTES_PATH);
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      assert.equal(options.contentType, 'application/json');
      if (mock.beforePut) await mock.beforePut();
      if (mock.writeError) throw mock.writeError;
      if ((stored && !options.allowOverwrite) || (options.ifMatch && options.ifMatch !== stored?.etag)) {
        throw Object.assign(new Error('conditional write failed'), { name: 'BlobPreconditionFailedError' });
      }
      return { etag: mock.overwrite(JSON.parse(body)).etag };
    },
  };
  mock.handler = createNotesHandler({ get: mock.get, put: mock.put, logError: error => calls.errors.push(error.name) });
  return mock;
}

function request(method = 'GET', data, headers = {}) {
  return new Request(`${SITE}/api/notes`, {
    method,
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

test('GET on an empty cloud library returns null without creating sample data', async () => {
  const cloud = mockBlob();
  const response = await cloud.handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { state: null, etag: null });
  assert.equal(cloud.calls.put.length, 0);
});

test('initial save and cloud reload preserve exact text, Unicode, whitespace and cursor position', async () => {
  const cloud = mockBlob();
  const state = stateWith('  first line\r\n\tहिन्दी 🐈‍⬛ e\u0301\n\nlast line  \n');
  const save = await cloud.handler(request('PUT', { state, etag: null }, { Origin: SITE }));
  assert.equal(save.status, 200);
  assert.equal(save.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await save.json(), { state, etag: '"v1"' });
  assert.equal(cloud.calls.put[0].options.allowOverwrite, false);
  assert.equal('ifMatch' in cloud.calls.put[0].options, false);

  const reload = await cloud.handler(request());
  assert.equal(reload.headers.get('etag'), '"v1"');
  assert.deepEqual(await reload.json(), { state, etag: '"v1"' });
});

test('GET can return a bodyless 304 only for the current cloud ETag', async () => {
  const cloud = mockBlob(stateWith('saved'));
  const unchanged = await cloud.handler(request('GET', undefined, { 'If-None-Match': '"v1"' }));
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('cache-control'), 'no-store');
  assert.equal(unchanged.headers.get('etag'), '"v1"');
  assert.equal(await unchanged.text(), '');
  const changed = await cloud.handler(request('GET', undefined, { 'If-None-Match': '"older"' }));
  assert.equal(changed.status, 200);
});

test('a correct ETag updates the cloud with an atomic conditional write', async () => {
  const cloud = mockBlob(stateWith('old'));
  const state = stateWith('replacement\n\t  ');
  const response = await cloud.handler(request('PUT', { state, etag: '"v1"' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state, etag: '"v2"' });
  assert.equal(cloud.calls.put[0].options.allowOverwrite, true);
  assert.equal(cloud.calls.put[0].options.ifMatch, '"v1"');
  assert.deepEqual(cloud.snapshot().state, state);
});

test('stale or missing ETags return current data and never overwrite the cloud', async () => {
  const state = stateWith('current saved text');
  const cloud = mockBlob(state);
  for (const etag of ['"old"', null, undefined]) {
    const response = await cloud.handler(request('PUT', { state: stateWith('stale edit'), etag }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { state, etag: '"v1"' });
  }
  assert.equal(cloud.calls.put.length, 0);
  assert.deepEqual(cloud.snapshot().state, state);
});

test('concurrent initial saves return the winner without overwriting it', async () => {
  const cloud = mockBlob();
  const winner = stateWith('another browser saved first');
  cloud.beforePut = () => cloud.overwrite(winner);
  const response = await cloud.handler(request('PUT', { state: stateWith('second browser'), etag: null }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { state: winner, etag: '"v1"' });
  assert.deepEqual(cloud.snapshot().state, winner);
});

test('a write racing after the initial read returns 409 and preserves the latest cloud edit', async () => {
  const cloud = mockBlob(stateWith('base'));
  const winner = stateWith('edit from another device');
  cloud.beforePut = () => cloud.overwrite(winner);
  const response = await cloud.handler(request('PUT', { state: stateWith('my edit'), etag: '"v1"' }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { state: winner, etag: '"v2"' });
  assert.deepEqual(cloud.snapshot().state, winner);
});

test('invalid states and malformed requests are rejected before cloud access', async () => {
  const cloud = mockBlob();
  const invalid = [
    { state: null },
    { state: { ...stateWith('hello'), notes: [] } },
    { state: { ...stateWith('hello'), activeId: 'missing' } },
    { state: { ...stateWith('hello'), settings: { focusMode: 'true' } } },
    { state: { ...stateWith('hello'), notes: [{ ...makeNote(), content: 'x', cursorEnd: 2 }] } },
    { state: stateWith('hello'), etag: 1 },
    { state: stateWith('hello'), etag: '' },
    ['invalid'],
  ];
  for (const data of invalid) {
    const response = await cloud.handler(request('PUT', data));
    assert.equal(response.status, 400);
  }
  const broken = new Request(`${SITE}/api/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal((await cloud.handler(broken)).status, 400);
  assert.equal(cloud.calls.get.length, 0);
  assert.equal(cloud.calls.put.length, 0);
});

test('the limit uses UTF-8 bytes and libraries cannot exceed 300 notes', async () => {
  const cloud = mockBlob();
  const tooLarge = stateWith('ह'.repeat(Math.ceil(MAX_NOTES_BYTES / 3)));
  assert.equal((await cloud.handler(request('PUT', { state: tooLarge }))).status, 413);
  const tooMany = stateWith('one');
  while (tooMany.notes.length < 301) tooMany.notes.push(makeNote());
  assert.equal((await cloud.handler(request('PUT', { state: tooMany }))).status, 413);
  assert.equal(cloud.calls.get.length, 0);
  assert.equal(cloud.calls.put.length, 0);
});

test('public reads need no sign-in and write origins must match the site', async () => {
  const cloud = mockBlob();
  assert.equal((await cloud.handler(request())).status, 200);
  const blocked = await cloud.handler(request('PUT', { state: stateWith('text') }, { Origin: 'https://another-site.example' }));
  assert.equal(blocked.status, 403);
  assert.equal(cloud.calls.put.length, 0);
  const allowed = await cloud.handler(request('PUT', { state: stateWith('text') }, { Origin: SITE }));
  assert.equal(allowed.status, 200);
});

test('only GET and PUT are accepted and writes require JSON', async () => {
  const cloud = mockBlob();
  const response = await cloud.handler(request('DELETE'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, PUT');
  const wrongType = request('PUT', { state: stateWith('text') }, { 'Content-Type': 'text/plain' });
  assert.equal((await cloud.handler(wrongType)).status, 415);
  assert.equal(cloud.calls.get.length, 0);
});

test('read and write failures return 503 instead of falsely confirming a save', async () => {
  const cloud = mockBlob();
  cloud.readError = Object.assign(new Error('sensitive upstream detail'), { name: 'BlobServiceNotAvailable' });
  for (const req of [request(), request('PUT', { state: stateWith('text') })]) {
    const response = await cloud.handler(req);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.text()).includes('sensitive'), false);
  }
  cloud.readError = null;
  cloud.writeError = new Error('sensitive upstream detail');
  const save = await cloud.handler(request('PUT', { state: stateWith('not yet saved') }));
  assert.equal(save.status, 503);
  assert.equal(cloud.snapshot(), null);
  assert.equal((await save.text()).includes('sensitive'), false);
  assert.deepEqual(cloud.calls.errors, ['BlobServiceNotAvailable', 'BlobServiceNotAvailable', 'Error']);
});

test('a corrupt cloud document cannot be overwritten by a browser autosave', async () => {
  const cloud = mockBlob({ version: 1, notes: [] });
  const response = await cloud.handler(request('PUT', { state: stateWith('replacement'), etag: '"v1"' }));
  assert.equal(response.status, 503);
  assert.equal(cloud.calls.put.length, 0);
  assert.deepEqual(cloud.snapshot().state, { version: 1, notes: [] });
});

for (const method of ['GET', 'PUT']) {
  test(`${method} stops oversized stored cloud reads before buffering the entire document`, async () => {
    const chunkSize = 64 * 1024;
    let pulls = 0;
    let cancelled = false;
    let writes = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls <= 32) controller.enqueue(new Uint8Array(chunkSize));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const handler = createNotesHandler({
      get: async () => ({ statusCode: 200, stream, blob: { etag: '"v1"' } }),
      put: async () => { writes++; return { etag: '"v2"' }; },
      logError() {},
    });

    const response = await handler(method === 'GET'
      ? request() : request('PUT', { state: stateWith('replacement'), etag: '"v1"' }));

    assert.equal(response.status, 503);
    assert.equal(cancelled, true);
    assert.equal(pulls, MAX_NOTES_BYTES / chunkSize + 1);
    assert.equal(stream.locked, false);
    assert.equal(writes, 0);
  });
}

test('stored cloud reads accept the exact byte limit and preserve Unicode split across chunks', async () => {
  const state = stateWith('ह');
  const encoder = new TextEncoder();
  const padding = MAX_NOTES_BYTES - encoder.encode(JSON.stringify(state)).byteLength;
  state.notes[0].content += 'x'.repeat(padding);
  const bytes = encoder.encode(JSON.stringify(state));
  assert.equal(bytes.byteLength, MAX_NOTES_BYTES);
  const split = bytes.indexOf(0xe0) + 1;
  assert.ok(split > 0);
  const chunks = [bytes.slice(0, split), bytes.slice(split, split + 1), bytes.slice(split + 1)];
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const handler = createNotesHandler({
    get: async () => ({ statusCode: 200, stream, blob: { etag: '"v1"' } }),
    put: async () => { throw new Error('unexpected write'); },
    logError() {},
  });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state, etag: '"v1"' });
  assert.equal(stream.locked, false);
});
