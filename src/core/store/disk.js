// Disk helpers for the stores: atomic writes, safe reads, and a folder of JSON files that saves itself
// in the background a moment after something changes.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isCollectionName } from './shared.js';

// On Windows a virus scanner or the search indexer can hold a file for a moment; these errors are worth a retry.
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes a file so a crash or power cut never leaves half a file behind: write a temporary file next to it,
 * make sure the bytes are on the disk (sync), then rename it over the old one in one step.
 */
export async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (!BUSY_CODES.has(err.code) || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
    }
  }
}

/** The file's bytes, or null when it does not exist. */
export async function readFileOrNull(file) {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Deletes leftover *.tmp files from a write that was cut off (only directly inside dir). */
export async function removeTempFiles(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const leftovers = names.filter((name) => name.endsWith('.tmp'));
  await Promise.all(leftovers.map((name) => fs.rm(path.join(dir, name), { force: true })));
}

/** Names of the collections saved in dir (every <name>.json that is a valid collection name). */
export async function savedCollectionNames(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isCollectionName);
}

/** The error getFile throws for a missing file. It has code ENOENT like Node's own errors. */
export function fileNotFound(key, message = `File not found: ${key}`) {
  return Object.assign(new Error(message), { code: 'ENOENT', key });
}

/**
 * A folder of named JSON files (<name>.json) kept in memory by the caller and saved here in the background.
 * - markDirty(name): this file changed; save it soon. Saves wait `delayMs` after the last change, but never
 *   more than `maxDelayMs` after the first one, so a steady stream of changes still reaches the disk.
 * - snapshot(name): given by the caller, returns the text to write for that name at save time.
 * - flush(): save everything that changed, now. Saves never overlap.
 */
export function createJsonFolder(dir, { snapshot, delayMs = 250, maxDelayMs = 2000 } = {}) {
  const dirty = new Set();
  const problems = []; // files that could not be read and were set aside
  let timer = null;
  let firstChangeAt = 0;
  let writing = null;
  let closed = false;
  let lastError = null;

  const fileFor = (name) => path.join(dir, `${name}.json`);

  async function read(name) {
    const bytes = await readFileOrNull(fileFor(name));
    if (bytes === null) return null;
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      // Keep the broken file for recovery, and carry on as if it were empty.
      const movedTo = path.join(dir, `${name}.corrupt-${Date.now()}.json.bak`);
      await fs.rename(fileFor(name), movedTo).catch(() => {});
      problems.push({ name, movedTo });
      console.error(`[store] ${fileFor(name)} could not be read. It was moved to ${movedTo}.`);
      return null;
    }
  }

  function markDirty(name) {
    if (closed) return;
    dirty.add(name);
    if (!firstChangeAt) firstChangeAt = Date.now();
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(delayMs, firstChangeAt + maxDelayMs - Date.now()));
    timer = setTimeout(saveInBackground, wait);
  }

  function saveInBackground() {
    timer = null;
    flush().catch((err) => {
      lastError = err;
      console.error(`[store] saving to ${dir} failed, trying again in 2 s:`, err.message);
      if (!timer && !closed) timer = setTimeout(saveInBackground, 2000);
    });
  }

  async function flush() {
    while (writing) await writing.catch(() => {});
    if (dirty.size === 0) return;
    clearTimeout(timer);
    timer = null;
    firstChangeAt = 0;
    const names = [...dirty];
    dirty.clear();
    writing = (async () => {
      // Different files can be written side by side. Wait for all of them before the next save starts.
      const results = await Promise.allSettled(names.map((name) => writeFileAtomic(fileFor(name), snapshot(name))));
      const failed = results.findIndex((result) => result.status === 'rejected');
      results.forEach((result, i) => {
        if (result.status === 'rejected') dirty.add(names[i]); // keep it for the next try
      });
      if (failed !== -1) throw results[failed].reason;
    })();
    try {
      await writing;
      lastError = null;
    } finally {
      writing = null;
    }
  }

  async function close() {
    closed = true; // ignore changes from now on, then save what is waiting
    clearTimeout(timer);
    timer = null;
    await flush();
  }

  return {
    dir,
    problems,
    read,
    markDirty,
    flush,
    close,
    get lastError() {
      return lastError;
    },
  };
}
