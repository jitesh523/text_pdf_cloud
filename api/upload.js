import { handleUpload } from '@vercel/blob/client';
import { createUploadHandler } from '../lib/files-handler.js';

const upload = createUploadHandler({ handleUpload });

export async function POST(request) {
  return upload(request);
}
