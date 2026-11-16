// Fetches the bytes of documents and papers through the bridge, once, and remembers them.
// A file comes back as { kind: 'pdf' | 'image' | 'other', name, mime, bytes, url? }.
import { jl } from '../api.js';

const cache = new Map(); // key -> Promise<file>

/** What kind of file this is, from its type, name or first bytes. */
export function fileKind({ mime, name, bytes }) {
  const head = bytes && bytes.length >= 4 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : '';
  if (head === '%PDF' || /pdf/i.test(mime || '') || /\.pdf$/i.test(name || '')) return 'pdf';
  if (/^image\//i.test(mime || '') || /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(name || '')) return 'image';
  return 'other';
}

function toBytes(value) {
  if (!value) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value.data && Array.isArray(value.data)) return new Uint8Array(value.data); // a Buffer sent as JSON
  return new Uint8Array(value);
}

async function load(key, fetcher) {
  const result = await fetcher();
  if (!result || result.error) throw new Error(result?.error || 'The file could not be opened.');
  const bytes = toBytes(result.bytes);
  const file = { key, name: result.name || 'file', mime: result.mime || '', bytes };
  file.kind = fileKind(file);
  if (file.kind === 'image') file.url = URL.createObjectURL(new Blob([bytes], { type: file.mime || 'image/png' }));
  return file;
}

function cached(key, fetcher) {
  if (!cache.has(key)) {
    const p = load(key, fetcher);
    cache.set(key, p);
    p.catch(() => cache.delete(key)); // try again next time
  }
  return cache.get(key);
}

/** A document's original file. */
export function docFile(docId) {
  return cached(`doc:${docId}`, () => jl.docs.file(docId));
}

/** A paper's PDF. The version and status are part of the key: signing makes a new file. */
export function paperFile(paper) {
  return cached(`paper:${paper.id}:${paper.version}:${paper.status}:${paper.sha256 || ''}`, () => jl.papers.file(paper.id));
}

/** Starts a browser download of bytes (used by the demo and as a fallback). */
export function downloadBytes(bytes, name, mime = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
