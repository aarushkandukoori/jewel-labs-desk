// The bridge to the app. In Electron, preload.cjs puts window.jl on the page. On the website (and in
// tests) there is no window.jl, so the in-browser demo API stands in with the same methods.
export const jl = window.jl ?? (await import('./demo/mock-api.js')).createMockApi();
export const isDemo = !window.jl;

let onError = (message) => console.warn(message);

/** app.js sets this so failed calls show a toast. */
export function setErrorHandler(fn) {
  onError = fn;
}

/**
 * Runs a bridge call. Every call may come back as { error }: then the toast shows it and this
 * returns null, so screens can write `const x = await call(jl.shipments.list())` and check for null.
 */
export async function call(promise, { quiet = false } = {}) {
  let result;
  try {
    result = await promise;
  } catch (e) {
    result = { error: e?.message || String(e) };
  }
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.error === 'string') {
    if (!quiet) onError(result.error, result);
    return null;
  }
  return result;
}
