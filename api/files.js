import { list, del } from '@vercel/blob';
import { createFilesHandler } from '../lib/files-handler.js';

const files = createFilesHandler({ list, del });

export async function GET(request) {
  return files(request);
}

export async function DELETE(request) {
  return files(request);
}
