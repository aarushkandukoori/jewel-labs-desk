// Unpacks zip files with JSZip. Skips folders and the junk files Macs and Windows add to zips.
import JSZip from 'jszip';

// Limits so a broken or hostile zip cannot fill the memory of the app.
const MAX_FILES = 5000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

const JUNK_FILE_NAMES = ['thumbs.db', 'desktop.ini'];

/**
 * The bytes the zips of one incoming file may unpack to, all together: zips inside zips, inside emails or
 * inside WhatsApp exports share one budget, so packing zips inside each other does not multiply it.
 */
export function unpackBudget(limit = MAX_UNPACKED_BYTES) {
  return { limit, left: limit };
}

function tooBig(budget) {
  return new Error(`the zips in this file unpack to more than ${Math.round(budget.limit / (1024 * 1024))} MB`);
}

/**
 * Unpacks a zip into [{ path, bytes }] in the order the zip lists them. Throws if it cannot be read or if it
 * unpacks to more than budget.left bytes; budget.left goes down by what was unpacked.
 */
export async function unzip(bytes, budget = unpackBudget()) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !isJunkPath(entry.name));
  if (entries.length > MAX_FILES) throw new Error(`the zip holds more than ${MAX_FILES} files`);

  // The sizes the zip lists for its files are written by whoever made it, so they only stop an honest big zip
  // early. The real bytes are counted while each file is unpacked.
  const listedSize = entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0);
  if (listedSize > budget.left) throw tooBig(budget);

  const files = [];
  try {
    for (const entry of entries) {
      const path = cleanPath(entry.name);
      if (path) files.push({ path, bytes: await unpackEntry(entry, budget) });
    }
  } catch (err) {
    budget.left += files.reduce((sum, file) => sum + file.bytes.length, 0); // dropped along with this zip
    throw err;
  }
  return files;
}

// Unpacks one file chunk by chunk and stops as soon as the budget is used up. (JSZip's own entry.async()
// checks the real size only after the whole file is in memory, and 1 MB of zip can unpack to a gigabyte.)
function unpackEntry(entry, budget) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const stream = entry.internalStream('uint8array');
    const fail = (err) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      stream.pause();
      reject(err);
    };
    stream
      .on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > budget.left) fail(tooBig(budget));
        else chunks.push(chunk);
      })
      .on('error', fail)
      .on('end', () => {
        if (done) return;
        done = true;
        budget.left -= size;
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
        resolve(bytes);
      })
      .resume();
  });
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
