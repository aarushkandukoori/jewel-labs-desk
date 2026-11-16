// Small file helpers for the watched folder and the sample shipment.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_DEPTH = 5;
// Not a working limit: the seen list stops old files from being read again. This only stops someone from
// watching a whole drive by mistake, and says so instead of quietly leaving files out.
export const MAX_FILES = 50000;
// Hidden files, Office lock files and half-finished downloads are never papers.
const SKIP_NAME = /^(\.|~\$|__MACOSX$|Thumbs\.db$|desktop\.ini$)|\.(tmp|part|crdownload|download|partial)$/i;

/** Every file under `dir` as { full, rel, size, mtimeMs }, sorted by path. Folders are walked a few levels deep. */
export async function listFiles(dir, { maxFiles = MAX_FILES } = {}) {
  const out = [];
  await walk(dir, '', 0, out, maxFiles);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function walk(root, relDir, depth, out, maxFiles) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
  } catch (err) {
    if (depth === 0) throw err; // the folder itself is gone: tell the caller
    return;
  }
  for (const entry of entries) {
    if (SKIP_NAME.test(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const full = path.join(root, rel);
    if (entry.isDirectory()) {
      await walk(root, rel, depth + 1, out, maxFiles);
    } else if (entry.isFile()) {
      if (out.length >= maxFiles) {
        throw new Error(`This folder holds more than ${maxFiles.toLocaleString('en-US')} files. Choose the folder where new papers land.`);
      }
      const stat = await fs.stat(full).catch(() => null); // gone or locked since it was listed: next round
      if (stat) out.push({ full, rel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
}

export async function readBytes(fullPath) {
  return new Uint8Array(await fs.readFile(fullPath));
}

/** A name that is safe as a storage key on Mac and Windows: no slashes, no odd characters, not too long. */
export function safeFileName(name) {
  const cleaned = String(name || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 120) return cleaned || 'file';
  const ext = path.extname(cleaned).slice(0, 10);
  return cleaned.slice(0, 120 - ext.length) + ext;
}
