// Tests for ocr/index.js: tesseract.js with the bundled English model, run on small SAMPLE images
// made by test/fixtures/ingest/make-ocr-sample.py (the JSON beside them says where each word was drawn).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { modelDir, ocrImage, ocrOptions, outsideAsar, terminateOcr } from '../../src/core/ocr/index.js';
import { locate } from '../../src/core/records/locate.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/ingest/', import.meta.url));
const PNG = fs.readFileSync(path.join(FIXTURES, 'ocr-sample.png'));
const JPEG = fs.readFileSync(path.join(FIXTURES, 'ocr-sample.jpg'));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ocr-sample.json'), 'utf8'));
const BOX_TOLERANCE = 0.012; // about a dozen pixels on this 1000 px wide image

after(() => terminateOcr());

function closeBox(word, box) {
  return [word.x0, word.y0, word.x1, word.y1].every((value, i) => Math.abs(value - box[i]) <= BOX_TOLERANCE);
}

test('the model is a local file, not a download', () => {
  const options = ocrOptions();
  assert.equal(options.langPath, modelDir());
  assert.ok(path.isAbsolute(options.langPath));
  assert.ok(fs.existsSync(path.join(options.langPath, 'eng.traineddata.gz')));
  assert.equal(options.gzip, true);
  assert.ok(options.cachePath.startsWith(os.tmpdir()));
});

test('in a packaged app the unpacked copy of a file is used when it exists', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-asar-'));
  try {
    fs.mkdirSync(path.join(app, 'app.asar.unpacked', 'model'), { recursive: true });
    const packed = path.join(app, 'app.asar', 'model');
    assert.equal(outsideAsar(packed), path.join(app, 'app.asar.unpacked', 'model'));
    assert.equal(outsideAsar(path.join(app, 'app.asar', 'missing')), path.join(app, 'app.asar', 'missing'));
    assert.equal(outsideAsar('/plain/folder/model'), '/plain/folder/model');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('reads the words of a PNG with sane boxes', async () => {
  const result = await ocrImage(PNG);
  assert.equal(result.error, undefined);
  assert.equal(result.width, EXPECTED.width);
  assert.equal(result.height, EXPECTED.height);
  assert.match(result.text, /SAMPLE COMMERCIAL INVOICE/);
  assert.match(result.text, /Invoice No: EXP\/26-27\/28/);

  let found = 0;
  for (const expected of EXPECTED.words) {
    const word = result.words.find((w) => w.text === expected.text && closeBox(w, expected.box));
    if (word) found++;
  }
  assert.ok(found >= EXPECTED.words.length - 1, `found ${found} of ${EXPECTED.words.length} words in place`);

  for (const word of result.words) {
    assert.equal(word.page, 1);
    assert.ok(word.x0 >= 0 && word.x1 <= 1 && word.y0 >= 0 && word.y1 <= 1);
    assert.ok(word.x1 > word.x0 && word.y1 > word.y0);
    assert.ok(word.conf >= 0 && word.conf <= 1);
  }
});

test('reads a JPEG, and the words work with locate', async () => {
  const result = await ocrImage(JPEG, { page: 3 });
  assert.equal(result.error, undefined);
  assert.ok(result.words.every((w) => w.page === 3));
  const found = locate(result.words, 'Invoice No: EXP/26-27/28', { page: 3 });
  assert.equal(found.page, 3);
  const start = EXPECTED.words.find((w) => w.text === 'Invoice').box;
  const end = EXPECTED.words.find((w) => w.text === 'EXP/26-27/28').box;
  assert.ok(Math.abs(found.box[0] - start[0]) <= BOX_TOLERANCE && Math.abs(found.box[2] - end[2]) <= BOX_TOLERANCE);
  assert.ok(locate(result.words, '1,02'), 'the carat weight is found even with a decimal comma');
});

test('unreadable input gives an empty result with an error, never a throw', async () => {
  for (const bad of [new Uint8Array(0), new Uint8Array([1, 2, 3]), Buffer.from('GIF89a......')]) {
    const result = await ocrImage(bad);
    assert.deepEqual(result.words, []);
    assert.equal(result.text, '');
    assert.match(result.error, /PNG, JPEG/);
  }
  // A PNG header with nothing behind it: tesseract fails, the worker is replaced, the next image works.
  const broken = await ocrImage(PNG.subarray(0, 40));
  assert.deepEqual(broken.words, []);
  assert.equal(typeof broken.error, 'string');
  const again = await ocrImage(PNG);
  assert.ok(again.words.length >= 10);
});

test('terminateOcr stops the worker and the next call starts a new one', async () => {
  await terminateOcr();
  await terminateOcr(); // stopping twice is fine
  const result = await ocrImage(PNG);
  assert.ok(result.words.length >= 10);
});

// Node's permission model can forbid all network access (--permission without --allow-net). OCR run
// that way still works, which shows it never downloads anything.
const canBlockNetwork = process.allowedNodeEnvironmentFlags.has('--allow-net');
test('OCR works with network access switched off', { skip: !canBlockNetwork && 'this Node cannot block the network' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-ocr-offline-'));
  const script = `
    import fs from 'node:fs';
    import { ocrImage, terminateOcr } from ${JSON.stringify(new URL('../../src/core/ocr/index.js', import.meta.url).href)};
    let blocked = false;
    try { await fetch('https://example.com'); } catch (err) { blocked = (err.code || err.cause?.code) === 'ERR_ACCESS_DENIED'; }
    const result = await ocrImage(fs.readFileSync(${JSON.stringify(path.join(FIXTURES, 'ocr-sample.png'))}));
    await terminateOcr();
    console.log(JSON.stringify({ blocked, words: result.words.length, error: result.error || null }));
  `;
  const args = ['--permission', '--allow-worker', '--allow-fs-read=*', `--allow-fs-write=${tmp}`, '--input-type=module', '-e', script];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
      timeout: 60_000,
    });
    const result = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(result.blocked, true, 'the child process really had no network');
    assert.equal(result.error, null);
    assert.ok(result.words >= 10, `read ${result.words} words`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
