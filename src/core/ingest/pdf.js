// Reads a PDF's text layer with pdf.js: the text of each page and every word with its box on the page.
// Scanned PDFs have little or no text layer; the app then renders those pages and runs OCR on them.
//
// Boxes are [x0, y0, x1, y1] from 0 to 1 with the origin at the top left of the page as it is shown
// (rotation and crop applied), so the same box works for any zoom level in the app.
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { toBytes } from './detect.js';

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
// pdf.js wants folder paths that end in a slash. CMaps decode some Asian fonts; the standard fonts
// stand in for the 14 basic PDF fonts when a file does not embed them.
const CMAP_DIR = `${path.join(PDFJS_DIR, 'cmaps')}/`;
const FONT_DIR = `${path.join(PDFJS_DIR, 'standard_fonts')}/`;

// A page counts as having a text layer when it holds at least this many letters or digits.
// A scan that only carries a stamp such as "Scanned with CamScanner" stays below it.
const MIN_REAL_CHARS = 40;

// Helvetica letter widths for the characters space (32) to tilde (126), in thousandths of the font
// size. pdf.js gives the width of a whole run of text; these split it fairly between the words.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z { | } ~
];

/**
 * Returns { pages, hasTextLayer, text, pageTexts, words, pageSizes, pageHasText } and never throws:
 * a broken or password-locked PDF gives pages 0 and an `error` message.
 * words: [{ text, page, x0, y0, x1, y1 }] in reading order; pages start at 1; pageSizes are in points.
 */
export async function pdfInfo(bytes) {
  // pdf.js takes over the buffer it is given (it ends up empty), so it gets a copy.
  const data = new Uint8Array(toBytes(bytes));
  let task = null;
  try {
    task = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      cMapUrl: CMAP_DIR,
      cMapPacked: true,
      standardFontDataUrl: FONT_DIR,
    });
    const doc = await task.promise;
    const result = emptyInfo();
    result.pages = doc.numPages;
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await readPage(doc, pageNo);
      result.pageSizes.push(page.size);
      result.pageTexts.push(page.text);
      result.pageHasText.push(countRealChars(page.text) >= MIN_REAL_CHARS);
      for (const word of page.words) result.words.push(word);
    }
    result.text = result.pageTexts.join('\n\n');
    // Most pages need real text; otherwise the PDF is treated as a scan and goes to OCR.
    result.hasTextLayer = result.pages > 0 && result.pageHasText.filter(Boolean).length >= result.pages / 2;
    return result;
  } catch (err) {
    return { ...emptyInfo(), error: pdfError(err) };
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
}

function emptyInfo() {
  return { pages: 0, hasTextLayer: false, text: '', pageTexts: [], words: [], pageSizes: [], pageHasText: [] };
}

// One page: its size in points, its words in reading order and its text. A damaged page stays empty.
async function readPage(doc, pageNo) {
  try {
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = [];
    for (const item of content.items) {
      for (const word of itemWords(item, content.styles[item.fontName], viewport, pageNo)) words.push(word);
    }
    page.cleanup();
    const lines = groupLines(words);
    return {
      size: { w: round(viewport.width, 2), h: round(viewport.height, 2) },
      words: lines.flat(),
      text: linesToText(lines, viewport),
    };
  } catch {
    return { size: { w: 0, h: 0 }, words: [], text: '' };
  }
}

// pdf.js gives text in runs: a start point, the text's direction and size (in `transform`), and the
// run's total width. Each word gets its share of that width; the height comes from the font.
function itemWords(item, style, viewport, pageNo) {
  const text = item.str || '';
  if (!text.trim()) return [];
  const [a, b, c, d, e, f] = item.transform;
  const size = Math.hypot(c, d) || item.height || 1;
  const along = unit(a, b); // the way the text runs (left to right for normal text)
  const up = unit(c, d); // "up" for the letters
  const ascent = style?.ascent > 0 ? style.ascent : 0.8;
  const descent = style?.descent < 0 ? style.descent : -0.2;
  const width = item.width > 0 ? item.width : size * 0.5 * text.length;
  const offsets = widthOffsets(text); // offsets[i] = share of the run before character i
  const total = offsets[text.length] || 1;

  const words = [];
  for (const match of text.matchAll(/\S+/g)) {
    const start = (offsets[match.index] / total) * width;
    const end = (offsets[match.index + match[0].length] / total) * width;
    // The word's four corners on the page, turned into screen coordinates (y grows downwards).
    const corners = [
      [start, descent], [end, descent], [start, ascent], [end, ascent],
    ].map(([distance, height]) =>
      viewport.convertToViewportPoint(
        e + along.x * distance + up.x * height * size,
        f + along.y * distance + up.y * height * size,
      ),
    );
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    const word = cleanWord(match[0]);
    if (!word) continue;
    words.push({
      text: word,
      page: pageNo,
      x0: clamp01(Math.min(...xs) / viewport.width),
      y0: clamp01(Math.min(...ys) / viewport.height),
      x1: clamp01(Math.max(...xs) / viewport.width),
      y1: clamp01(Math.max(...ys) / viewport.height),
    });
  }
  return words;
}

// Running total of letter widths: offsets[i] is the width of text.slice(0, i).
function widthOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let w = 556; // an average letter
    if (code >= 32 && code <= 126) w = HELVETICA_WIDTHS[code - 32];
    else if (code >= 0x2e80) w = 1000; // Chinese, Japanese and Korean characters are square
    offsets.push(offsets[i] + w);
  }
  return offsets;
}

// Groups words into lines (their middles sit at about the same height), top to bottom, then sorts
// each line left to right. That is the order a person reads, whatever order the PDF stored them in.
function groupLines(words) {
  const sorted = [...words].sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
  const lines = [];
  let current = null;
  for (const word of sorted) {
    const middle = (word.y0 + word.y1) / 2;
    const height = word.y1 - word.y0;
    if (current && Math.abs(middle - current.middle) <= Math.min(current.height, height) * 0.5) {
      current.words.push(word);
    } else {
      current = { middle, height, words: [word] };
      lines.push(current);
    }
  }
  return lines.map((line) => line.words.sort((p, q) => p.x0 - q.x0));
}

// Words joined by spaces. A gap wider than the letters are tall becomes a tab, as between table columns.
function linesToText(lines, viewport) {
  return lines
    .map((words) =>
      words
        .map((word, i) => {
          if (i === 0) return word.text;
          const before = words[i - 1];
          const gap = (word.x0 - before.x1) * viewport.width;
          const height = (before.y1 - before.y0) * viewport.height;
          return (gap > height ? '\t' : ' ') + word.text;
        })
        .join(''),
    )
    .join('\n');
}

function pdfError(err) {
  if (err?.name === 'PasswordException') return 'This PDF is locked with a password.';
  if (err?.name === 'InvalidPDFException') return 'This file is not a readable PDF (it may be damaged).';
  return `Could not read this PDF: ${err?.message || err}`;
}

function countRealChars(text) {
  return (text.match(/[\p{L}\p{N}]/gu) || []).length;
}

// Control characters sometimes come out of fonts without a proper character map.
function cleanWord(word) {
  return word.replace(/[\u0000-\u001f\u007f]/g, '');
}

function unit(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function clamp01(value) {
  return round(Math.min(1, Math.max(0, value)), 4);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
