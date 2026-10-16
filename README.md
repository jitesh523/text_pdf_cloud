# Textdesk

A shared cloud notebook and file bridge. Type or paste text, or upload files from your phone and download them on your laptop. Open the same URL on either device. No sign-in is required; anyone with the link can access the shared notes and files.

Live app: [Textdesk](https://textdesk-tan.vercel.app) · [Files](https://textdesk-tan.vercel.app/#files)

## Run

Run `npm ci` and `npm run build` to bundle the browser file uploader. `npm run dev` serves the interface at http://127.0.0.1:5173. Use `vercel dev` with the linked project for working cloud APIs, or use the production URL.

`npm test` runs device persistence, merging, cloud autosave, file upload queues, and API checks. `dist/` contains the interface; `src/files.js` bundles to `dist/files.js` using esbuild. `api/` provides the Vercel Functions, and `vercel.json` configures the deployment.

## Data

The shared library lives in the private `textdesk-cloud` Vercel Blob store. The public `/api/notes` endpoint intentionally lets visitors read and edit it. Blob credentials stay on the server. Updates use ETags and conditional writes so concurrent browsers preserve conflicting text instead of silently overwriting it. The endpoint validates the library and caps it at 1 MB / 300 notes.

The browser retains a draft backup under `textdesk.notes.v1` and the last verified cloud version under `textdesk.cloud.v1`. Existing local-only notes migrate when the upgraded page opens. The interface says `Saved to cloud` only after server confirmation; failed requests keep the draft and retry. Download a note as `.txt` or export the library as JSON for an extra backup.

Uploaded files use a separate `textdesk/files/` namespace. The browser uploads directly to Blob with a scoped, short-lived upload token, so files larger than a Function request limit work. Downloads stream through `/api/download` with the original filename. The limit is 100 MiB per file; multiple files upload in sequence with progress, retry, and cancellation. Files remain in the cloud until removed. No file metadata is added to the notes document.

To deploy elsewhere, connect a private Vercel Blob store to the project. Vercel injects `BLOB_READ_WRITE_TOKEN` on the server; this is required for issuing scoped upload tokens. Keep it in Vercel environment variables or a gitignored local `.env.local`. Never place it in browser code.

## Features

- Multiple notes, titles, and full-text search
- Cloud autosave, automatic retry, and restored last-opened note
- Public access across devices without sign-in
- Phone-to-laptop file uploads and downloads at `/#files`
- Multiple uploads, drag and drop, progress, retry, and cancellation
- Original filenames and file bytes preserved; confirmed removal of cloud files
- Text spacing and line breaks preserved
- Copy, download, library backup, and confirmed deletion
- Focus mode and responsive mobile library
- Cmd/Ctrl+Shift+N creates a note; Escape closes overlays/focus mode
