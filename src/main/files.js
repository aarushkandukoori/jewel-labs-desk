// Files on disk: reading what the person dropped or picked, and writing temporary copies of papers.
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_FILES = 500;
export const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB in one go

// The main process only reads paths the person chose: files dropped on the window (the preload
// reports them) or picked in a file dialog. A page that asks for any other path is refused.
export function createPathGrants() {
  const granted = new Set();
  return {
    allow(p) {
      if (typeof p === 'string' && p) granted.add(path.resolve(p));
    },
    isAllowed(p) {
      if (typeof p !== 'string' || !p) return false;
      const full = path.resolve(p);
      for (const g of granted) {
        if (full === g || full.startsWith(g + path.sep)) return true;
      }
      return false;
    },
  };
}

// Reads dropped or picked paths into { name, bytes }. A folder is read file by file (hidden files and
// macOS "__MACOSX" folders are skipped), so dropping a whole shipment folder works.
// Symbolic links are never followed: a link inside an unpacked zip (../../.ssh/id_rsa) would otherwise
// read a file from outside the folder the person chose and send it to the house and the AI.
export async function readDroppedPaths(paths, { maxFiles = MAX_FILES, maxBytes = MAX_TOTAL_BYTES } = {}) {
  const files = [];
  let total = 0;
  let links = 0;

  async function visit(p, depth) {
    const info = await fs.lstat(p);
    if (info.isSymbolicLink()) {
      links += 1;
      return;
    }
    if (info.isDirectory()) {
      if (depth > 5) return; // folders nested this deep are not shipment folders
      const names = (await fs.readdir(p)).sort();
      for (const name of names) {
        if (name.startsWith('.') || name === '__MACOSX') continue;
        await visit(path.join(p, name), depth + 1);
      }
      return;
    }
    if (!info.isFile()) return;
    if (files.length >= maxFiles) throw new Error(`That is more than ${maxFiles} files. Add them in smaller batches.`);
    total += info.size;
    if (total > maxBytes) throw new Error('Those files are too large to add at once. Add them in smaller batches.');
    files.push({ name: path.basename(p), bytes: new Uint8Array(await fs.readFile(p)) });
  }

  for (const p of paths) await visit(p, 0);
  if (!files.length && links) throw new Error('Links to other places on this computer are not read. Add the files themselves.');
  return files;
}

// A file name that is safe to write anywhere: no folders, no characters Windows refuses.
export function safeFileName(name, fallback = 'file') {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (clean || fallback).slice(-180);
}

const TEMP_KEEP_MS = 24 * 3600 * 1000;

// Writes bytes to a new folder of its own inside the app's temp folder (used to open or print a paper in
// another app). Every open gets its own copy: a PDF app may still hold the last one open (Acrobat on Windows
// locks it, and on a Mac the viewer would show the other paper under the same name). Copies older than a day
// are removed.
export async function writeTempFile(dir, name, bytes, { now = Date.now() } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await removeOldTempFolders(dir, now);
  const folder = await fs.mkdtemp(path.join(dir, 'open-'));
  const file = path.join(folder, safeFileName(name));
  await fs.writeFile(file, bytes);
  return file;
}

async function removeOldTempFolders(dir, now) {
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.startsWith('open-')) continue;
    const folder = path.join(dir, name);
    const info = await fs.stat(folder).catch(() => null);
    if (info && now - info.mtimeMs > TEMP_KEEP_MS) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}
