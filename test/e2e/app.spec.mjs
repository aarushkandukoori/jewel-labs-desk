// End-to-end smoke test: starts the real app with Playwright, checks the bridge, draws a PDF page in
// the hidden pdf.js window, saves a screenshot to test/.tmp/e2e-home.png, and checks the app quits.
//
//   node test/e2e/app.spec.mjs
//
// The app runs with JL_E2E=1 and a throwaway data folder (helpers.mjs launchApp), so real workspaces are
// never touched, and with no OpenAI key, so nothing is sent to the AI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TMP, waitFor, tempDir, launchApp, closeApp, errorLines } from './helpers.mjs';

const SCREENSHOT = path.join(TMP, 'e2e-home.png');
const require = createRequire(import.meta.url);

// A one-page SAMPLE PDF, made with pdf-lib.
async function makeSamplePdf() {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('SAMPLE commercial invoice', { x: 50, y: 780, size: 20, font });
  return doc.save();
}

const userData = tempDir('jewel-labs-e2e-');
const pageProblems = []; // console errors from the screens
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
let app = null;
let lines = [];

try {
  const launched = await launchApp({ userData, env: { JL_DEV_OPENAI_KEY_FILE: '' } });
  ({ app, lines } = launched);
  const { page } = launched;
  page.on('console', (msg) => {
    // The check below asks for file:///etc/hosts on purpose; Chromium logs the refusal.
    if (msg.type() === 'error' && !msg.text().includes('file:///etc/hosts')) pageProblems.push(msg.text());
  });
  page.on('pageerror', (error) => pageProblems.push(error.message));

  await check('the window opens and shows', async () => {
    await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible())), 20000, 'a visible window');
    return `${Date.now() - started} ms after launch`;
  });

  await check('the screens load from app://jewel-labs/, so no other file on the disk counts as the page', async () => {
    assert.match(page.url(), /^app:\/\/jewel-labs\/index\.html/);
    const outside = await page.evaluate(() => import('file:///etc/hosts').then(() => 'loaded', () => 'blocked'));
    assert.equal(outside, 'blocked');
    return page.url();
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
    fs.mkdirSync(TMP, { recursive: true });
    await page.screenshot({ path: SCREENSHOT });
    return path.relative(path.dirname(TMP), SCREENSHOT);
  });
} catch (error) {
  failed = true;
  results.push(`FAIL  ${error.message}`);
} finally {
  // Quitting must work: a quit that hangs leaves the app running with no window.
  const quit = await closeApp(app);
  if (quit) {
    results.push('ok    the app quits when asked');
  } else {
    failed = true;
    results.push('FAIL  the app quits when asked: still running 15 s later');
  }
  fs.rmSync(userData, { recursive: true, force: true });
}

// The main process must start cleanly: no errors from our code and no crashes.
const mainErrors = errorLines(lines);
if (mainErrors.length) failed = true;

console.log(results.join('\n'));
console.log(`\nmain process: ${mainErrors.length ? `${mainErrors.length} error line(s)` : 'no errors'}`);
for (const line of mainErrors) console.log(`  ${line}`);
console.log(`screens: ${pageProblems.length ? `${pageProblems.length} console error(s)` : 'no console errors'}`);
for (const line of pageProblems.slice(0, 20)) console.log(`  ${line}`);
console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
process.exit(failed ? 1 : 0);
