// Loads the other core modules only when a step first needs them.
// Why lazy: the app starts fast, and a module that is missing or broken only fails the step that uses it.
// Tests pass fakes in `overrides`, so they never touch the real modules.
import { fileURLToPath } from 'node:url';

// Where each module lives (paths are relative to this file). Records is split over several files,
// so every file that exists is loaded and their exports are merged.
const MODULE_FILES = {
  ingest: ['../ingest/index.js'],
  ocr: ['../ocr/index.js'],
  ai: ['../ai/index.js'],
  records: ['../records/index.js', '../records/locate.js', '../records/shipments.js', '../records/stones.js', '../records/history.js'],
  rules: ['../rules/compliance.js'],
  sanctions: ['../sanctions/index.js'],
  labs: ['../labs/index.js'],
  papers: ['../papers/index.js'],
  mail: ['../mail/index.js'],
  metrics: ['../metrics.js'],
};

/** Returns load(name) -> the module's exports. */
export function createModuleLoader(overrides = {}) {
  const cache = {};
  return function load(name) {
    if (overrides[name]) return Promise.resolve(overrides[name]);
    if (!cache[name]) {
      cache[name] = importModule(name).catch((err) => {
        delete cache[name]; // try again next time, for example after an update
        throw err;
      });
    }
    return cache[name];
  };
}

async function importModule(name) {
  const files = MODULE_FILES[name];
  if (!files) throw new Error(`Unknown module: ${name}`);
  const merged = {};
  let found = 0;
  for (const file of files) {
    const url = new URL(file, import.meta.url);
    try {
      Object.assign(merged, await import(url.href));
      found += 1;
    } catch (err) {
      if (!isMissingFile(err, url)) throw err; // a real bug inside the module: show it
    }
  }
  if (!found) throw new Error(`The ${name} module is not installed yet (${files[0]}).`);
  return merged;
}

function isMissingFile(err, url) {
  return err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(fileURLToPath(url));
}
