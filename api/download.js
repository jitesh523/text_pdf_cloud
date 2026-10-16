import { get } from '@vercel/blob';
import { createDownloadHandler } from '../lib/files-handler.js';

const download = createDownloadHandler({ get });

export async function GET(request) {
  return download(request);
}
