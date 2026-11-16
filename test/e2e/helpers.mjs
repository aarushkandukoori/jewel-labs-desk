// Small helpers shared by the end-to-end scripts (flow.spec.mjs, scripts/record-demo.js).
// They start the real app with Playwright, each run in its own throwaway data folder.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TMP = path.join(ROOT, 'test', '.tmp');
export const DEFAULT_KEY_FILE = path.join(os.homedir(), '.config', 'jewel-labs', 'openai_key');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls check() until it returns something truthy, and returns that. */
export async function waitFor(check, timeoutMs, what, everyMs = 250) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error; // the page may be between screens; try again
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${lastError ? ` (${lastError.message})` : ''}`);
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Starts the dev app. env is added to the test environment (JL_E2E=1 and JL_USER_DATA are always set).
 * Returns { app, page, lines } where lines collects everything the main process printed.
 */
export async function launchApp({ userData, env = {}, viewport } = {}) {
  const lines = [];
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, OPENAI_API_KEY: '', JL_E2E: '1', JL_USER_DATA: userData, ...env },
    timeout: 60000,
  });
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean)));
  }
  const page = await app.firstWindow();
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && typeof window.jl === 'object'), 30000, 'the first screen');
  // Keep drawing and timing at full speed even when another window covers this one.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.setBackgroundThrottling(false)));
  if (viewport) await setWindowSize(app, page, viewport);
  return { app, page, lines };
}

/**
 * Makes the screens exactly width x height. The window itself is resized when the screen is big enough;
 * on a smaller screen (macOS keeps windows inside the screen) the page is drawn at that size instead.
 */
export async function setWindowSize(app, page, { width, height }) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible()) || BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(800, 600);
    win.setContentSize(size.width, size.height);
  }, { width, height });
  const fits = ({ width: w, height: h }) => window.innerWidth === w && window.innerHeight === h;
  const native = await waitFor(() => page.evaluate(fits, { width, height }), 2000, 'the window size').catch(() => false);
  if (!native) {
    await page.setViewportSize({ width, height });
    await waitFor(() => page.evaluate(fits, { width, height }), 5000, `a ${width}x${height} page`);
  }
  return native ? 'window' : 'emulated';
}

/** Closes the app; kills it if it does not quit within 15 s. Returns true when it quit by itself. */
export async function closeApp(app) {
  if (!app) return true;
  const quit = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
  if (!quit) {
    try {
      app.process().kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  return quit;
}

/** Calls the bridge from the page: bridge(page, 'shipments.list') -> the result. */
export function bridge(page, method, ...args) {
  return page.evaluate(([m, a]) => {
    const [area, name] = m.split('.');
    return window.jl[area][name](...a);
  }, [method, args]);
}

/** Main-process lines that mean something went wrong (never the key: the app never prints it). */
export function errorLines(lines) {
  return lines.filter((line) => /\[jewel-labs\] error|Uncaught|UnhandledPromiseRejection|A JavaScript error occurred/.test(line));
}
