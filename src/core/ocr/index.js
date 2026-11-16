// OCR for photos and scans: tesseract.js with the English model that ships with the app.
// Nothing is downloaded: the model is read from node_modules/@tesseract.js-data/eng on this computer.
// One worker is started on first use and reused for the next images; terminateOcr() stops it. Its memory
// (WebAssembly) grows to fit the biggest page it has read and is never given back, and the app runs all
// day in the tray, so the worker is also stopped after a minute without work and replaced after 50 images.
//
// Word boxes are [x0, y0, x1, y1] from 0 to 1 with the origin at the top left of the image.
// Scanned PDF pages are turned into images by the Electron side first, then read here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectMime, toBytes } from '../ingest/detect.js';

const require = createRequire(import.meta.url);
const { createWorker, OEM } = require('tesseract.js'); // tesseract.js is a CommonJS package

const MODEL = '4.0.0_best_int'; // the "best int" English model: accurate and small (3 MB)
const START_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 180_000;
const READABLE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];
const DEFAULT_LIMITS = { idleMs: 60_000, imagesPerWorker: 50 };
// Packages the OCR worker thread loads by itself (it runs tesseract.js/src/worker-script/node/index.js).
const WORKER_PACKAGES = ['bmp-js', 'is-url', 'regenerator-runtime/runtime', 'wasm-feature-detect', 'tesseract.js-core/package.json'];

let workerPromise = null; // the shared worker, started on first use
let queue = Promise.resolve(); // images are read one at a time
let waiting = 0; // images asked for and not read yet
let imagesRead = 0; // by the current worker
let idleTimer = null;
let limits = DEFAULT_LIMITS;

/** For tests: a shorter idle time or fewer images per worker. No argument puts the defaults back. */
export function setOcrLimits(next = {}) {
  limits = { ...DEFAULT_LIMITS, ...next };
}

/** Whether a worker is running, and how many images it has read. */
export function ocrStatus() {
  return { running: Boolean(workerPromise), imagesRead };
}

/** The folder holding eng.traineddata.gz. */
export function modelDir() {
  const packageDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  return outsideAsar(path.join(packageDir, MODEL));
}

/** tesseract.js options: the local model (gzipped) and a cache in the temp folder, so no network is used. */
export function ocrOptions() {
  return {
    langPath: modelDir(),
    gzip: true,
    cachePath: path.join(os.tmpdir(), 'jewel-labs-ocr', MODEL),
    workerPath: workerScript(),
    // Errors reach us through the rejected promise. Without a handler tesseract.js also throws them
    // inside its message listener, which would crash the app.
    errorHandler: () => {},
  };
}

/**
 * Reads the words on a PNG or JPEG (WEBP and BMP work too).
 * Returns { text, words: [{ text, page, x0, y0, x1, y1, conf }], width, height }; conf is 0 to 1.
 * Never throws: on failure the result is empty and carries an `error` message.
 * page: the page number to put on the words (for a rendered PDF page); 1 by default.
 */
export function ocrImage(bytes, options = {}) {
  const page = options?.page ?? 1;
  waiting += 1;
  clearTimeout(idleTimer);
  const job = queue.then(() => readImage(toBytes(bytes), page)).finally(() => {
    waiting -= 1;
    if (waiting === 0) stopWhenIdle();
  });
  queue = job.catch(() => {});
  return job;
}

/** Stops the OCR worker (when the app quits, or when it is idle). The next ocrImage call starts a new one. */
export async function terminateOcr() {
  clearTimeout(idleTimer);
  const current = workerPromise;
  workerPromise = null;
  imagesRead = 0;
  if (!current) return;
  try {
    const worker = await current;
    await worker.terminate();
  } catch {
    // It never started, so there is nothing to stop.
  }
}

async function readImage(data, page) {
  if (!READABLE_TYPES.includes(detectMime('', data))) {
    return emptyResult('OCR reads PNG, JPEG, WEBP and BMP images only.');
  }
  try {
    const worker = await getWorker();
    const result = await withTimeout(
      worker.recognize(data, {}, { text: true, tsv: true }),
      READ_TIMEOUT_MS,
      'it took longer than 3 minutes',
    );
    imagesRead += 1;
    if (imagesRead >= limits.imagesPerWorker) await terminateOcr(); // a fresh worker starts small again
    return readTsv(result.data.tsv, result.data.text, page);
  } catch (err) {
    await terminateOcr(); // a stuck or broken worker is replaced on the next call
    return emptyResult(`OCR failed: ${err?.message || err}`);
  }
}

// After the last image, wait a while; if nothing new came, stop the worker. It goes through the queue, so it
// never stops a worker in the middle of a read.
function stopWhenIdle() {
  clearTimeout(idleTimer);
  if (!workerPromise) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    queue = queue.then(() => (waiting === 0 ? terminateOcr() : undefined));
  }, limits.idleMs);
  idleTimer.unref?.(); // a waiting timer alone should not keep the app running
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = startWorker().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function startWorker() {
  const options = ocrOptions();
  const modelFile = path.join(options.langPath, 'eng.traineddata.gz');
  if (!fs.existsSync(modelFile)) throw new Error(`the English OCR model is missing (${modelFile})`);
  try {
    fs.mkdirSync(options.cachePath, { recursive: true });
  } catch {
    // No cache folder only means the model is unpacked again on the next start.
  }

  const starting = createWorker('eng', OEM.LSTM_ONLY, options);
  try {
    return await withTimeout(starting, START_TIMEOUT_MS, 'the OCR engine did not start');
  } catch (err) {
    starting.then((worker) => worker.terminate(), () => {}); // if it starts late, stop it
    // A damaged cached copy of the model is the usual cause; the next start reads the bundled one.
    fs.rmSync(path.join(options.cachePath, 'eng.traineddata'), { force: true });
    throw err;
  }
}

// Tesseract's TSV has one row per page, block, paragraph, line and word. Columns: level, page_num,
// block_num, par_num, line_num, word_num, left, top, width, height, conf, text. The level 1 row is the
// whole image (so it gives the image size); level 5 rows are words.
function readTsv(tsv, text, page) {
  const rows = String(tsv || '').split('\n').map((line) => line.split('\t'));
  const imageRow = rows.find((row) => row[0] === '1');
  const width = imageRow ? Number(imageRow[8]) : 0;
  const height = imageRow ? Number(imageRow[9]) : 0;
  const words = [];
  for (const row of rows) {
    const wordText = plainDashes((row[11] || '').trim());
    const conf = Number(row[10]);
    if (row[0] !== '5' || !wordText || conf < 0 || !width || !height) continue;
    const [left, top, boxWidth, boxHeight] = row.slice(6, 10).map(Number);
    words.push({
      text: wordText,
      page,
      x0: round(left / width, 4),
      y0: round(top / height, 4),
      x1: round((left + boxWidth) / width, 4),
      y1: round((top + boxHeight) / height, 4),
      conf: round(conf / 100, 2),
    });
  }
  return { text: plainDashes(String(text || '').trim()), words, width, height };
}

// OCR reads rules, borders and smudges as long dashes. Papers print plain hyphens in numbers and ranges, and the
// app never shows an em dash, so any dash OCR returns becomes a hyphen.
function plainDashes(text) {
  return text.replace(/[\u2010-\u2015\u2212]/g, '-');
}

function emptyResult(error) {
  return { text: '', words: [], width: 0, height: 0, error };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.(); // a waiting timer alone should not keep the app running
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The script the OCR worker thread runs. In the packaged app it is taken from app.asar.unpacked, but
// only when every package it loads sits there too; a worker that cannot load them would crash the app.
function workerScript() {
  const packed = require.resolve('tesseract.js/src/worker-script/node/index.js');
  const unpacked = outsideAsar(packed);
  if (unpacked === packed) return packed;
  const requireNextToIt = createRequire(unpacked);
  const loadable = (name) => {
    try {
      requireNextToIt.resolve(name);
      return true;
    } catch {
      return false;
    }
  };
  return WORKER_PACKAGES.every(loadable) ? unpacked : packed;
}

// In the packaged app node_modules sit inside app.asar. When the build unpacks the OCR files
// (asarUnpack), the worker thread must use the unpacked copies, which plain file reads can open.
export function outsideAsar(filePath) {
  const unpacked = filePath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return unpacked !== filePath && fs.existsSync(unpacked) ? unpacked : filePath;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
