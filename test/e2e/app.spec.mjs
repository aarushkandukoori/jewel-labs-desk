// End-to-end smoke test: starts the real app with Playwright, checks the bridge, draws a PDF page in
// the hidden pdf.js window, saves a screenshot to test/.tmp/e2e-home.png, and checks the app quits.
//
//   node test/e2e/app.spec.mjs
//
// The app runs with JL_E2E=1 and a throwaway data folder, so real workspaces are never touched.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'test', '.tmp');
const SCREENSHOT = path.join(OUT_DIR, 'e2e-home.png');
const require = createRequire(import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, what) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// A one-page SAMPLE PDF, made with pdf-lib.
async function makeSamplePdf() {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('SAMPLE commercial invoice', { x: 50, y: 780, size: 20, font });
  return doc.save();
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jewel-labs-e2e-'));
const mainLines = []; // everything the main process printed
const pageProblems = []; // console errors from the screens (another module; reported, not failed on)
const results = [];
let failed = false;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      (detail) => results.push(`ok    ${name}${detail ? `: ${detail}` : ''}`),
      (error) => {
        failed = true;
        results.push(`FAIL  ${name}: ${error.message}`);
      },
    );
}

const started = Date.now();
const app = await electron.launch({
  args: [ROOT],
  cwd: ROOT,
  env: { ...process.env, JL_E2E: '1', JL_USER_DATA: userData },
  timeout: 60000,
});
for (const stream of [app.process().stdout, app.process().stderr]) {
  stream.on('data', (chunk) => mainLines.push(...String(chunk).split('\n').filter(Boolean)));
}

try {
  const page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageProblems.push(msg.text());
  });
  page.on('pageerror', (error) => pageProblems.push(error.message));

  await check('the window opens and shows', async () => {
    await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible())), 20000, 'a visible window');
    // The page may still be moving to its final screen; wait until it has settled with the bridge.
    const settled = async () => {
      try {
        return await page.evaluate(() => document.readyState === 'complete' && typeof window.jl === 'object');
      } catch {
        return false; // the page navigated while we asked
      }
    };
    await waitFor(settled, 20000, 'the first screen');
    return `${Date.now() - started} ms after launch, ${page.url().split('/').slice(-2).join('/')}`;
  });

  await check('window.jl exists', async () => {
    const shape = await page.evaluate(() => (window.jl ? Object.keys(window.jl).sort().join(' ') : null));
    assert.ok(shape, 'window.jl is missing');
    return shape;
  });

  let info = null;
  await check('jl.app.info() returns a version', async () => {
    info = await page.evaluate(() => window.jl.app.info());
    assert.ok(info && typeof info.version === 'string' && info.version.length > 0, `got ${JSON.stringify(info)}`);
    return `version ${info.version}, ${info.platform} ${info.arch}, ${info.isDev ? 'dev' : 'packaged'}, mode ${info.mode}`;
  });

  await check('bad calls come back as { error }', async () => {
    const result = await page.evaluate(() => window.jl.app.openExternal('file:///etc/passwd'));
    assert.ok(result && typeof result.error === 'string', `got ${JSON.stringify(result)}`);
    return result.error;
  });

  await check('jl.app.qr makes a QR code', async () => {
    const qr = await page.evaluate(() => window.jl.app.qr('https://wa.me/910000000000'));
    assert.match(String(qr), /^data:image\/png;base64,/);
  });

  await check('the agents started', async () => {
    await waitFor(async () => {
      const now = await page.evaluate(() => window.jl.app.info());
      return now.ready || now.startError;
    }, 20000, 'the agents');
    info = await page.evaluate(() => window.jl.app.info());
    assert.equal(info.startError, null, info.startError);
    return `workspace ${info.workspaceId}, AI ${info.ai.mode}, autopilot ${info.autopilot ? 'on' : 'off'}`;
  });

  await check('the hidden pdf.js window draws a PDF page', async () => {
    const pdf = Buffer.from(await makeSamplePdf()).toString('base64');
    const png = await app.evaluate(async (_electron, b64) => {
      const bytes = await globalThis.__jlTest.rasterize(new Uint8Array(Buffer.from(b64, 'base64')), 1);
      return { length: bytes.length, head: Array.from(bytes.slice(0, 4)) };
    }, pdf);
    assert.deepEqual(png.head, [0x89, 0x50, 0x4e, 0x47], 'not a PNG');
    return `${png.length} bytes`;
  });

  await check('screenshot', async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: SCREENSHOT });
    return path.relative(ROOT, SCREENSHOT);
  });
} catch (error) {
  failed = true;
  results.push(`FAIL  ${error.message}`);
} finally {
  // Quitting must work: a quit that hangs leaves the app running with no window.
  const quit = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
  if (quit) {
    results.push('ok    the app quits when asked');
  } else {
    failed = true;
    results.push('FAIL  the app quits when asked: still running 15 s later');
    app.process().kill('SIGKILL');
  }
  fs.rmSync(userData, { recursive: true, force: true });
}

// The main process must start cleanly: no errors from our code and no crashes.
const mainErrors = mainLines.filter((line) => /\[jewel-labs\] error|Uncaught|UnhandledPromiseRejection|A JavaScript error occurred/.test(line));
if (mainErrors.length) failed = true;

console.log(results.join('\n'));
console.log(`\nmain process: ${mainErrors.length ? `${mainErrors.length} error line(s)` : 'no errors'}`);
for (const line of mainErrors) console.log(`  ${line}`);
console.log(`screens: ${pageProblems.length ? `${pageProblems.length} console error(s)` : 'no console errors'}`);
for (const line of pageProblems.slice(0, 20)) console.log(`  ${line}`);
console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
process.exit(failed ? 1 : 0);
