// Small file helpers for the watched folder and the sample shipment.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_DEPTH = 5;
const MAX_FILES = 2000;
// Hidden files, Office lock files and half-finished downloads are never papers.
const SKIP_NAME = /^(\.|~\$|__MACOSX$|Thumbs\.db$|desktop\.ini$)|\.(tmp|part|crdownload|download|partial)$/i;

/** Every file under `dir` as { full, rel, size, mtimeMs }, sorted by path. Folders are walked a few levels deep. */
export async function listFiles(dir) {
  const out = [];
  await walk(dir, '', 0, out);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function walk(root, relDir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
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
      await walk(root, rel, depth + 1, out);
    } else if (entry.isFile() && out.length < MAX_FILES) {
      const stat = await fs.stat(full);
      out.push({ full, rel, size: stat.size, mtimeMs: stat.mtimeMs });
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
