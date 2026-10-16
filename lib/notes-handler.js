import { validateState } from '../dist/storage.js';

export const NOTES_PATH = 'textdesk/library-v1.json';
export const MAX_NOTES_BYTES = 1024 * 1024;
export const MAX_NOTES_COUNT = 300;

class PayloadTooLargeError extends Error {}

function json(data, status = 200, etag = null, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(etag ? { ETag: etag } : {}),
      ...extraHeaders,
    },
  });
}

function checkState(state) {
  validateState(state);
  if (state.notes.length > MAX_NOTES_COUNT) throw new PayloadTooLargeError();
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_NOTES_BYTES) {
    throw new PayloadTooLargeError();
  }
  return state;
}

async function readBody(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_NOTES_BYTES) throw new PayloadTooLargeError();
  if (!request.body) throw new SyntaxError();

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_NOTES_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function matchesETag(header, etag) {
  if (!header || !etag) return false;
  return header.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
}

// The library is deliberately public: anyone using the site can read and edit it.
// Blob credentials stay in the server function; no token is sent to the browser.
export function createNotesHandler({ get, put, logError = error => {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)
    ? error.name : 'Error';
  console.error('Textdesk cloud storage failed:', name);
} }) {
  async function readLibrary() {
    const result = await get(NOTES_PATH, { access: 'private', useCache: false });
    if (result === null) return { state: null, etag: null };
    if (result?.statusCode !== 200 || !result.stream || typeof result.blob?.etag !== 'string'
      || !result.blob.etag) throw new Error('Invalid cloud response');
    const text = await new Response(result.stream).text();
    if (new TextEncoder().encode(text).byteLength > MAX_NOTES_BYTES) throw new PayloadTooLargeError();
    return { state: checkState(JSON.parse(text)), etag: result.blob.etag };
  }

  function unavailable(error) {
    logError(error);
    return json({ error: 'Cloud saving is temporarily unavailable. Your text has not been confirmed saved.' }, 503);
  }

  return async function handleNotes(request) {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return json({ error: 'Method not allowed.' }, 405, null, { Allow: 'GET, PUT' });
    }

    if (request.method === 'GET') {
      try {
        const library = await readLibrary();
        if (matchesETag(request.headers.get('if-none-match'), library.etag)) {
          return new Response(null, { status: 304, headers: { 'Cache-Control': 'no-store', ETag: library.etag } });
        }
        return json(library, 200, library.etag);
      } catch (error) {
        return unavailable(error);
      }
    }

    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: 'Write requests must come from this site.' }, 403);
    }
    const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return json({ error: 'Send notes as JSON.' }, 415);

    let state;
    let etag;
    try {
      const body = await readBody(request);
      if (body === null || typeof body !== 'object' || Array.isArray(body)
        || (body.etag !== undefined && body.etag !== null
          && (typeof body.etag !== 'string' || body.etag.length === 0 || body.etag.length > 512))) {
        throw new SyntaxError();
      }
      state = checkState(body.state);
      etag = body.etag ?? null;
    } catch (error) {
      return error instanceof PayloadTooLargeError
        ? json({ error: 'Keep the library below 1 MB and 300 notes.' }, 413)
        : json({ error: 'The notes have an invalid format.' }, 400);
    }

    let current;
    try {
      current = await readLibrary();
    } catch (error) {
      return unavailable(error);
    }
    if (current.etag !== etag) return json(current, 409, current.etag);

    try {
      const blob = await put(NOTES_PATH, JSON.stringify(state), {
        access: 'private',
        addRandomSuffix: false,
        contentType: 'application/json',
        allowOverwrite: etag !== null,
        ...(etag !== null ? { ifMatch: etag } : {}),
      });
      if (typeof blob?.etag !== 'string' || !blob.etag) throw new Error('Missing cloud confirmation');
      return json({ state, etag: blob.etag }, 200, blob.etag);
    } catch (error) {
      // Another browser can write after our read. Conditional writes prevent
      // overwriting it; return its latest version so the browser can merge.
      try {
        const latest = await readLibrary();
        if (latest.etag !== current.etag) return json(latest, 409, latest.etag);
      } catch {
        // Keep the original error generic and do not expose note contents.
      }
      return unavailable(error);
    }
  };
}
