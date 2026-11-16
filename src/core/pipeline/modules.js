// Loads the other core modules only when a step first needs them, so the app starts fast.
// Tests pass fakes in `overrides`, so they never touch the real modules.

// Where each module lives (paths are relative to this file).
const MODULE_FILES = {
  ingest: '../ingest/index.js',
  ocr: '../ocr/index.js',
  ai: '../ai/index.js',
  records: '../records/index.js',
  rules: '../rules/compliance.js',
  sanctions: '../sanctions/index.js',
  labs: '../labs/index.js',
  papers: '../papers/index.js',
  mail: '../mail/index.js',
  metrics: '../metrics.js',
};

/** Returns load(name) -> the module's exports. A module that fails to load fails the step with its own error. */
export function createModuleLoader(overrides = {}) {
  const cache = {};
  return function load(name) {
    if (overrides[name]) return Promise.resolve(overrides[name]);
    if (!MODULE_FILES[name]) return Promise.reject(new Error(`Unknown module: ${name}`));
    if (!cache[name]) {
      cache[name] = import(new URL(MODULE_FILES[name], import.meta.url).href).catch((err) => {
        delete cache[name]; // try again next time, for example after an update
        throw err;
      });
    }
    return cache[name];
  };
}
