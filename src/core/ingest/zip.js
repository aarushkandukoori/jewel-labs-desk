// Unpacks zip files with JSZip. Skips folders and the junk files Macs and Windows add to zips.
import JSZip from 'jszip';

// Limits so a broken or hostile zip cannot fill the memory of the app.
const MAX_FILES = 5000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

const JUNK_FILE_NAMES = ['thumbs.db', 'desktop.ini'];

/** Unpacks a zip into [{ path, bytes }] in the order the zip lists them. Throws if it cannot be read. */
export async function unzip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !isJunkPath(entry.name));
  if (entries.length > MAX_FILES) throw new Error(`the zip holds more than ${MAX_FILES} files`);

  // JSZip knows each file's unpacked size before unpacking it (from the zip's own directory).
  const unpackedSize = entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0);
  if (unpackedSize > MAX_UNPACKED_BYTES) throw new Error('the zip unpacks to more than 512 MB');

  const files = [];
  for (const entry of entries) {
    const path = cleanPath(entry.name);
    if (path) files.push({ path, bytes: await entry.async('uint8array') });
  }
  return files;
}

/** True for paths inside __MACOSX, dotfiles such as .DS_Store, and Windows thumbnail files. */
export function isJunkPath(path) {
  const parts = cleanPath(path).split('/');
  const last = parts[parts.length - 1].toLowerCase();
  return parts.some((part) => part === '__MACOSX' || part.startsWith('.')) || JUNK_FILE_NAMES.includes(last);
}

/** Forward slashes, no leading slash, no "." or ".." parts (a zip must not point outside itself). */
export function cleanPath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

/** "docs/Invoice 28.pdf" -> "Invoice 28.pdf". */
export function baseName(path) {
  const parts = cleanPath(path).split('/');
  return parts[parts.length - 1];
}
