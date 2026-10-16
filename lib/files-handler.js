import { FILE_PREFIX, MAX_FILE_BYTES, parseFilePath } from './file-paths.js';

export const MAX_UPLOAD_REQUEST_BYTES = 16 * 1024;

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function methodNotAllowed(methods) {
  return json({ error: 'Method not allowed.' }, 405, { Allow: methods });
}

function validateOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new RequestError('Upload and delete requests must come from this site.', 403);
  }
}

function pathFromRequest(request) {
  const pathname = new URL(request.url).searchParams.get('path');
  if (!parseFilePath(pathname)) throw new RequestError('Choose a valid uploaded file.');
  return pathname;
}

function defaultLog(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)
    ? error.name : 'Error';
  console.error('Textdesk file storage failed:', name);
}

function failure(error, logError) {
  if (error instanceof RequestError) return json({ error: error.message }, error.status);
  logError(error);
  return json({ error: 'Cloud file storage is temporarily unavailable. Please try again.' }, 503);
}

async function readUploadBody(request) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError('Send upload details as JSON.', 415);
  if (Number(request.headers.get('content-length')) > MAX_UPLOAD_REQUEST_BYTES) {
    throw new RequestError('Upload details are too large.', 413);
  }
  if (!request.body) throw new RequestError('Upload details are missing.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestError('Upload details are too large.', 413);
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError('Upload details have an invalid format.');
  }
}

function validateUpload(pathname, clientPayload) {
  const file = parseFilePath(pathname);
  if (!file) throw new RequestError('Choose a valid file name and upload path.');
  let metadata;
  try {
    metadata = JSON.parse(clientPayload);
  } catch {
    throw new RequestError('File details have an invalid format.');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || metadata.name !== file.name || !Number.isSafeInteger(metadata.size) || metadata.size < 0
    || typeof metadata.type !== 'string' || metadata.type.length > 255
    || /[\u0000-\u001f\u007f-\u009f]/u.test(metadata.type)) {
    throw new RequestError('File details have an invalid format.');
  }
  if (metadata.size > MAX_FILE_BYTES) throw new RequestError('Each file must be 100 MB or smaller.', 413);
  return { name: file.name, size: metadata.size, type: metadata.type.trim() || 'application/octet-stream' };
}

// The desk is intentionally public, matching the shared notes. The issued
// client token can create one fresh managed pathname, never overwrite notes.
export function createUploadHandler({ handleUpload, logError = defaultLog, now = () => Date.now() }) {
  return async function upload(request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    try {
      validateOrigin(request);
      const body = await readUploadBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !['blob.generate-client-token', 'blob.upload-completed'].includes(body.type)) {
        throw new RequestError('Upload details have an invalid format.');
      }
      if (body.type === 'blob.generate-client-token') {
        if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)
          || typeof body.payload.clientPayload !== 'string' || typeof body.payload.multipart !== 'boolean') {
          throw new RequestError('File details have an invalid format.');
        }
        validateUpload(body.payload.pathname, body.payload.clientPayload);
      }
      const result = await handleUpload({
        request,
        body,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          const metadata = validateUpload(pathname, clientPayload);
          return {
            maximumSizeInBytes: MAX_FILE_BYTES,
            addRandomSuffix: false,
            allowOverwrite: false,
            validUntil: now() + 60 * 60 * 1000,
            tokenPayload: JSON.stringify(metadata),
          };
        },
      });
      if (body.type === 'blob.generate-client-token'
        && (typeof result?.clientToken !== 'string' || !result.clientToken)) throw new Error('Missing upload token');
      if (body.type === 'blob.upload-completed' && result?.response !== 'ok') throw new Error('Invalid upload callback response');
      return json(result);
    } catch (error) {
      // Let the Blob SDK verify callback signatures; do not accept an unsigned
      // completion event or expose credentials and low-level storage errors.
      if (/callback signature/i.test(error?.message ?? '')) return json({ error: 'Invalid upload confirmation.' }, 403);
      return failure(error, logError);
    }
  };
}

export function createFilesHandler({ list, del, logError = defaultLog }) {
  return async function files(request) {
    if (request.method !== 'GET' && request.method !== 'DELETE') return methodNotAllowed('GET, DELETE');
    try {
      if (request.method === 'DELETE') {
        validateOrigin(request);
        const pathname = pathFromRequest(request);
        await del(pathname);
        return json({ deleted: true });
      }
      const cursor = new URL(request.url).searchParams.get('cursor');
      if (cursor !== null && (cursor.length === 0 || cursor.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(cursor))) {
        throw new RequestError('The file list cursor is invalid.');
      }
      const page = await list({ prefix: FILE_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.blobs) || typeof page.hasMore !== 'boolean'
        || (page.hasMore && (typeof page.cursor !== 'string' || !page.cursor))) throw new Error('Invalid cloud file list');
      const entries = [];
      for (const blob of page.blobs) {
        const file = parseFilePath(blob?.pathname);
        if (!file) continue;
        const uploadedAt = new Date(blob.uploadedAt);
        if (!Number.isSafeInteger(blob.size) || blob.size < 0 || !Number.isFinite(uploadedAt.getTime())) {
          throw new Error('Invalid cloud file details');
        }
        entries.push({
          pathname: blob.pathname,
          name: file.name,
          size: blob.size,
          uploadedAt: uploadedAt.toISOString(),
          downloadUrl: `/api/download?path=${encodeURIComponent(blob.pathname)}`,
        });
      }
      entries.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      return json({ files: entries, hasMore: page.hasMore, cursor: page.hasMore ? page.cursor : null, maxFileBytes: MAX_FILE_BYTES });
    } catch (error) {
      return failure(error, logError);
    }
  };
}

function contentDisposition(name) {
  const fallback = [...name].map(character => /^[A-Za-z0-9 ._()-]$/.test(character) ? character : '_').join('');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback || 'download'}"; filename*=UTF-8''${encoded}`;
}

export function createDownloadHandler({ get, logError = defaultLog }) {
  return async function download(request) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    try {
      const pathname = pathFromRequest(request);
      const { name } = parseFilePath(pathname);
      const result = await get(pathname, { access: 'private', useCache: false });
      if (result === null) return json({ error: 'This file could not be found. It may have been deleted.' }, 404);
      if (result?.statusCode !== 200 || !result.stream) throw new Error('Invalid cloud download response');
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(name),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      // Blob SDK reports size 0 when its upstream response omits Content-Length
      // (including chunked responses). That does not mean an empty file. Let the
      // runtime frame the stream so a guessed length never truncates a download.
      return new Response(result.stream, { headers });
    } catch (error) {
      return failure(error, logError);
    }
  };
}
