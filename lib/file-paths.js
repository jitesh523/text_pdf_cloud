// This module is shared with the browser. Original names are encoded in the
// pathname, so listing the cloud never depends on a second metadata database.
export const FILE_PREFIX = 'textdesk/files/';
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function encodeName(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nameBytes(name) {
  if (typeof name !== 'string' || name.length === 0 || [...name].length > 255
    || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(name)) {
    throw new TypeError('Use a file name of 1–255 characters without slashes or control characters.');
  }
  const bytes = encoder.encode(name);
  // TextEncoder replaces lone surrogates; refuse those instead of changing a name.
  if (bytes.byteLength > 512 || decoder.decode(bytes) !== name) {
    throw new TypeError('The file name must contain valid Unicode and fit within 512 UTF-8 bytes.');
  }
  return bytes;
}

export function makeFilePath(name, id = globalThis.crypto.randomUUID()) {
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new TypeError('Use a valid file ID.');
  return `${FILE_PREFIX}${id}/${encodeName(nameBytes(name))}`;
}

export function parseFilePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(FILE_PREFIX) || pathname.length > 800) return null;
  const parts = pathname.slice(FILE_PREFIX.length).split('/');
  if (parts.length !== 2 || !uuidPattern.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const binary = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const name = decoder.decode(bytes);
    if (encodeName(nameBytes(name)) !== parts[1]) return null;
    return { name, id: parts[0] };
  } catch {
    return null;
  }
}
