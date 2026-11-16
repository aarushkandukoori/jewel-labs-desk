// Checks the PACKAGED app (macOS): mounts the .dmg read-only, starts the app inside it with a throwaway
// data folder, and lets the app check itself (src/main/e2e.js, JL_E2E_REPORT): start, load the sample,
// let the agents read it, OCR the phone photo with the unpacked tesseract worker, draw a PDF page.
//
//   npx electron-builder --mac --arm64 --publish never
//   node test/e2e/packaged.spec.mjs [path/to/Jewel-Labs-mac-arm64.dmg]
//
// The AI stays off here (a packaged app never reads a developer key), so the offline reader and OCR do
// the reading. Playwright is not used: it cannot attach to a packaged app, so the app is started directly.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TMP, sleep, tempDir } from './helpers.mjs';

const dmg = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'Jewel-Labs-mac-arm64.dmg'));
if (process.platform !== 'darwin') {
  console.log('This check runs on macOS only.');
  process.exit(0);
}
if (!fs.existsSync(dmg)) {
  console.error(`No disk image at ${dmg}. Build it first: npx electron-builder --mac --arm64 --publish never`);
  process.exit(1);
}

const mountPoint = tempDir('jl-dmg-');
const userData = tempDir('jl-packaged-');
const reportFile = path.join(TMP, 'packaged', 'report.json');
fs.rmSync(reportFile, { force: true });
let child = null;
let failed = false;

try {
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmg], { stdio: 'ignore' });
  const appDir = fs.readdirSync(mountPoint).find((name) => name.endsWith('.app'));
  if (!appDir) throw new Error('The disk image has no .app inside');
  const binary = path.join(mountPoint, appDir, 'Contents', 'MacOS', appDir.replace(/\.app$/, ''));
  const unpacked = path.join(mountPoint, appDir, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  const needed = ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data', 'bmp-js', 'is-url', 'regenerator-runtime', 'wasm-feature-detect', 'pdfjs-dist'];
  const missing = needed.filter((m) => !fs.existsSync(path.join(unpacked, m)));
  console.log(`${dmg}: ${(fs.statSync(dmg).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`unpacked modules: ${missing.length ? `MISSING ${missing.join(', ')}` : 'all present'}`);
  if (missing.length) failed = true;

  const lines = [];
  const started = Date.now();
  child = spawn(binary, [], {
    env: { ...process.env, OPENAI_API_KEY: '', JL_DEV_OPENAI_KEY_FILE: '', JL_E2E: '1', JL_E2E_QUIT: '1', JL_USER_DATA: userData, JL_E2E_REPORT: reportFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => lines.push(...String(c).split('\n').filter(Boolean)));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  // The app writes the report, then quits on its own.
  while (!fs.existsSync(reportFile) && Date.now() - started < 8 * 60 * 1000 && child.exitCode === null) await sleep(1000);
  const code = await Promise.race([exited, sleep(20000).then(() => 'still running')]);
  if (code === 'still running') {
    failed = true;
    console.log('FAIL  the packaged app did not quit by itself');
  } else {
    console.log(`ok    the packaged app quit by itself (exit code ${code}) after ${Math.round((Date.now() - started) / 1000)} s`);
  }
  if (!fs.existsSync(reportFile)) throw new Error(`No report. Last lines:\n${lines.slice(-20).join('\n')}`);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  for (const [name, s] of Object.entries(report.steps)) {
    const { ok, ms, error, ...detail } = s;
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${name} (${ms} ms)${error ? `: ${error}` : `: ${JSON.stringify(detail)}`}`);
  }
  if (!report.ok) failed = true;
  const ocr = report.steps.ocrPhoto || {};
  if (ocr.ok && !ocr.workerOutsideAsar) {
    failed = true;
    console.log('FAIL  the OCR worker ran from inside app.asar, not from app.asar.unpacked');
  }
  const errors = lines.filter((l) => /\[jewel-labs\] error|Uncaught|A JavaScript error occurred/.test(l));
  console.log(`main process: ${errors.length ? errors.join('\n') : 'no errors'}`);
  if (errors.length) failed = true;
} catch (error) {
  failed = true;
  console.log(`FAIL  ${error.message}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await sleep(500);
  try {
    execFileSync('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' });
  } catch {
    // already detached
  }
  fs.rmSync(userData, { recursive: true, force: true });
  try {
    fs.rmdirSync(mountPoint); // only when empty, that is, once the image is detached
  } catch {
    // still mounted: leave it
  }
}
console.log(failed ? '\nPACKAGED CHECK FAILED' : '\nPACKAGED CHECK PASSED');
process.exit(failed ? 1 : 0);
