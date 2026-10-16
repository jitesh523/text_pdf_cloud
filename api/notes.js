import { get, put } from '@vercel/blob';
import { createNotesHandler } from '../lib/notes-handler.js';

const handleNotes = createNotesHandler({ get, put });

export async function GET(request) {
  return handleNotes(request);
}

export async function PUT(request) {
  return handleNotes(request);
}
