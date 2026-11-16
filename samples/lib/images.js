// Two SAMPLE papers must not arrive as clean PDFs, so the agents also exercise their vision and OCR path:
//   phonePhoto():  a JPEG of the printed emerald report, shot on a desk with a phone (tilted, in
//                  perspective, soft shadow, uneven light, a little blur and sensor noise)
//   scannedPdf():  the insurance certificate as a grey, slightly turned scan inside a PDF with no text layer
// Pages are drawn with pdf.js, the same renderer the app uses, and its built-in canvas. The photo look
// is plain pixel maths with seeded random numbers, so every run gives the same bytes.
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { seeded } from './kit.js';
import { FOOTER } from './facts.js';

const require = createRequire(import.meta.url);
const FONT_DIR = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

/** Draws page 1 of a PDF at `dpi`. Returns the canvas and the factory that makes more canvases. */
export async function renderFirstPage(pdfBytes, dpi) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes), standardFontDataUrl: FONT_DIR, verbosity: pdfjs.VerbosityLevel.ERRORS, isEvalSupported: false,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const factory = doc.canvasFactory;
    const { canvas, context } = factory.create(Math.round(viewport.width), Math.round(viewport.height));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    return { canvas, factory };
  } finally {
    await task.destroy();
  }
}

// ---------- phone photo ----------

const PHOTO_WIDTH = 1200;
const PHOTO_HEIGHT = 1600;
// Where the page's corners land in the photo: top-left, top-right, bottom-right, bottom-left.
// Turned about 2 degrees, and wider at the bottom because the phone was held closer there.
const PAGE_CORNERS = [[168, 112], [1062, 146], [1122, 1488], [96, 1452]];

/** A phone photo (JPEG bytes) of the printed first page of pdfBytes. */
export async function phonePhoto(pdfBytes, { seed = 5 } = {}) {
  const { canvas: page, factory } = await renderFirstPage(pdfBytes, 200);
  const { canvas, context } = factory.create(PHOTO_WIDTH, PHOTO_HEIGHT);
  const rand = seeded(seed);

  drawDesk(context, rand);
  // Soft shadow under the paper, a little down and to the right of it.
  context.save();
  context.filter = 'blur(18px)';
  context.fillStyle = 'rgba(0, 0, 0, 0.55)';
  polygon(context, PAGE_CORNERS.map(([x, y]) => [x + 14, y + 22]));
  context.fill();
  context.restore();

  warpPage(context, page, PAGE_CORNERS);

  // The shadow of the phone and hand across the lower right corner.
  context.save();
  context.filter = 'blur(60px)';
  context.fillStyle = 'rgba(20, 15, 10, 0.22)';
  context.beginPath();
  context.ellipse(1160, 1420, 420, 300, -0.5, 0, Math.PI * 2);
  context.fill();
  context.restore();

  // Camera softness, then sensor noise.
  const { canvas: soft, context: softContext } = factory.create(PHOTO_WIDTH, PHOTO_HEIGHT);
  softContext.filter = 'blur(0.45px)';
  softContext.drawImage(canvas, 0, 0);
  addNoise(softContext, PHOTO_WIDTH, PHOTO_HEIGHT, rand, 7);
  return new Uint8Array(soft.toBuffer('image/jpeg', 74));
}

// A warm wooden desk: a gradient and some darker grain lines.
function drawDesk(context, rand) {
  const gradient = context.createLinearGradient(0, 0, PHOTO_WIDTH, PHOTO_HEIGHT);
  gradient.addColorStop(0, '#8a6a4f');
  gradient.addColorStop(1, '#5e4532');
  context.fillStyle = gradient;
  context.fillRect(0, 0, PHOTO_WIDTH, PHOTO_HEIGHT);
  for (let i = 0; i < 90; i++) {
    const y = rand() * PHOTO_HEIGHT;
    context.strokeStyle = `rgba(40, 25, 15, ${0.05 + rand() * 0.12})`;
    context.lineWidth = 1 + rand() * 3;
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(PHOTO_WIDTH * 0.3, y + (rand() - 0.5) * 40, PHOTO_WIDTH * 0.7, y + (rand() - 0.5) * 40, PHOTO_WIDTH, y + (rand() - 0.5) * 30);
    context.stroke();
  }
}

function polygon(context, points) {
  context.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
  context.closePath();
}

/**
 * Paints the page into the four corners. For every photo pixel we ask "which page pixel lands here?"
 * (the inverse of the perspective), read that page pixel, tint it like paper under a lamp and mix it
 * over the desk. Edge pixels are mixed by how much of them the page covers, so the edge is smooth.
 */
function warpPage(context, page, corners) {
  const pageWidth = page.width;
  const pageHeight = page.height;
  const source = page.getContext('2d').getImageData(0, 0, pageWidth, pageHeight).data;
  const pageCorners = [[0, 0], [pageWidth, 0], [pageWidth, pageHeight], [0, pageHeight]];
  const toPage = perspective(corners, pageCorners);

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const left = Math.floor(Math.min(...xs));
  const top = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - left;
  const height = Math.ceil(Math.max(...ys)) - top;
  const image = context.getImageData(left, top, width, height);
  const out = image.data;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const u = left + col + 0.5;
      const v = top + row + 0.5;
      const [x, y] = toPage(u, v);
      // How much of this photo pixel the paper covers (0 outside, 1 well inside).
      const cover = Math.max(0, Math.min(1, x + 0.5, pageWidth - 0.5 - x, y + 0.5, pageHeight - 0.5 - y));
      if (cover <= 0) continue;
      const [r, g, b] = sample(source, pageWidth, pageHeight, x, y);
      // Paper is a little warm, and the lamp is brighter at the top left than at the bottom right.
      const light = 1.02 - 0.13 * (u / PHOTO_WIDTH) * 0.6 - 0.13 * (v / PHOTO_HEIGHT) * 0.4;
      const i = (row * width + col) * 4;
      out[i] = out[i] * (1 - cover) + Math.min(255, r * 0.985 * light) * cover;
      out[i + 1] = out[i + 1] * (1 - cover) + Math.min(255, g * 0.972 * light) * cover;
      out[i + 2] = out[i + 2] * (1 - cover) + Math.min(255, b * 0.94 * light) * cover;
    }
  }
  context.putImageData(image, left, top);
}

// Bilinear sampling: the colour between four neighbouring page pixels.
function sample(data, width, height, x, y) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const result = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = data[(y0 * width + x0) * 4 + c] * (1 - fx) + data[(y0 * width + x1) * 4 + c] * fx;
    const bottom = data[(y1 * width + x0) * 4 + c] * (1 - fx) + data[(y1 * width + x1) * 4 + c] * fx;
    result[c] = top * (1 - fy) + bottom * fy;
  }
  return result;
}

/**
 * The perspective that sends four points `from` onto four points `to`, as a function (x, y) -> [x, y].
 * It has 8 unknown numbers; each corner gives two equations, so we solve 8 equations (Gaussian elimination).
 */
export function perspective(from, to) {
  const rows = [];
  const rhs = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i];
    const [x, y] = to[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    rhs.push(y);
  }
  const h = solve(rows, rhs);
  return (u, v) => {
    const w = h[6] * u + h[7] * v + 1;
    return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
  };
}

function solve(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

// Grain: the same small random shift on the three colours of a pixel, plus a little colour noise.
function addNoise(context, width, height, rand, strength) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const grain = (rand() + rand() - 1) * strength;
    data[i] = clamp(data[i] + grain + (rand() - 0.5) * 3);
    data[i + 1] = clamp(data[i + 1] + grain + (rand() - 0.5) * 3);
    data[i + 2] = clamp(data[i + 2] + grain + (rand() - 0.5) * 3);
  }
  context.putImageData(image, 0, 0);
}

function clamp(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// ---------- scanned PDF ----------

/**
 * A scanned-looking copy of page 1 of pdfBytes: grey, a little turned, with scanner speckles, saved as
 * a JPEG inside a new PDF. The new PDF has no text at all, so it must be read with OCR or vision.
 */
export async function scannedPdf(pdfBytes, { seed = 11, title, date } = {}) {
  const { canvas: page, factory } = await renderFirstPage(pdfBytes, 150);
  const width = page.width;
  const height = page.height;
  const { canvas, context } = factory.create(width, height);
  const rand = seeded(seed);

  // The scanner lid is darker than the paper; the page went in turned by under a degree.
  context.fillStyle = '#b9b9b5';
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((0.8 * Math.PI) / 180);
  context.filter = 'blur(0.6px)';
  context.drawImage(page, -width / 2 + 7, -height / 2 + 5);
  context.restore();

  // Grey paper, slightly washed-out ink, and grain.
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = clamp(42 + (grey / 255) * (228 - 42) + (rand() + rand() - 1) * 9);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
  context.putImageData(image, 0, 0);

  // Dust on the glass, a faint streak from the scanner bar, and a shadow along the bound edge.
  context.fillStyle = 'rgba(30, 30, 30, 0.55)';
  for (let i = 0; i < 420; i++) {
    const size = rand() < 0.85 ? 1 : 2;
    context.fillRect(Math.floor(rand() * width), Math.floor(rand() * height), size, size);
  }
  context.fillStyle = 'rgba(0, 0, 0, 0.05)';
  context.fillRect(Math.floor(width * 0.63), 0, 2, height);
  const edge = context.createLinearGradient(0, 0, 46, 0);
  edge.addColorStop(0, 'rgba(0, 0, 0, 0.35)');
  edge.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = edge;
  context.fillRect(0, 0, 46, height);

  const jpeg = new Uint8Array(canvas.toBuffer('image/jpeg', 64));
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setSubject(FOOTER);
  pdf.setCreator('Sample Scanner (SAMPLE)');
  pdf.setProducer('pdf-lib');
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  const picture = await pdf.embedJpg(jpeg);
  const pdfPage = pdf.addPage([595.28, 841.89]);
  pdfPage.drawImage(picture, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return { pdf: await pdf.save(), jpeg };
}
