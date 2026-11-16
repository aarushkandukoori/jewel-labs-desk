// Drawing helpers for the SAMPLE papers, on top of pdf-lib.
//
// Layout uses points from the TOP-LEFT of the page (y grows downwards), the way you read a paper.
// pdf-lib itself measures from the bottom-left, so every helper flips y once, here.
//
// Two marks go on every page so nobody mistakes a sample for a real paper: a light diagonal SAMPLE
// watermark and the footer line. The watermark and the stamps are drawn as shapes (letter outlines),
// not as text, so they never end up in the text the agents read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
import { FOOTER } from './facts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The letter outlines for watermarks and stamps come from the app's own vendored font.
const OUTLINE_FONT = fontkit.create(fs.readFileSync(path.join(ROOT, 'src/core/papers/fonts/Geist-Bold.ttf')));

export const A4 = { width: 595.28, height: 841.89 };
export const MARGIN = 36;

export const INK = rgb(0.08, 0.08, 0.1);
export const GREY = rgb(0.42, 0.43, 0.46);
export const LIGHT = rgb(0.93, 0.93, 0.94);
export const RULE = rgb(0.2, 0.2, 0.22);
export const BLUE_INK = rgb(0.1, 0.16, 0.48); // pen ink for signatures
export { rgb, degrees };

/** A new PDF with fixed metadata, so the same facts always give the same bytes. */
export async function newPdf({ title, author, date }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setSubject(FOOTER);
  pdf.setKeywords(['SAMPLE', 'fictional', 'Jewel Labs demo']);
  pdf.setCreator('Jewel Labs sample generator (samples/generate.js)');
  pdf.setProducer('pdf-lib');
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  const fonts = {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    sansItalic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    serifBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    serifItalic: await pdf.embedFont(StandardFonts.TimesRomanItalic),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };
  return { pdf, fonts };
}

/** A local time on the paper's own day, as a Date for the PDF metadata. */
export function paperDate(iso, time = '11:00:00', zone = '+05:30') {
  return new Date(`${iso}T${time}${zone}`);
}

export function addPage(pdf, size = A4) {
  return pdf.addPage([size.width, size.height]);
}

// ---------- text ----------

/**
 * One line of text. (x, y) is the left end of the baseline, y from the top.
 * align 'center' or 'right' uses `width` as the box the text sits in.
 */
export function write(page, text, x, y, { font, size = 9, color = INK, align = 'left', width = 0, opacity } = {}) {
  const value = String(text ?? '');
  if (!value) return;
  let left = x;
  if (align !== 'left') {
    const textWidth = font.widthOfTextAtSize(value, size);
    left = align === 'center' ? x + (width - textWidth) / 2 : x + width - textWidth;
  }
  page.drawText(value, { x: left, y: page.getHeight() - y, size, font, color, opacity });
}

/** Splits text into lines that fit maxWidth, breaking between words. */
export function wrap(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A wrapped paragraph. Returns the y below it. */
export function paragraph(page, text, x, y, { font, size = 9, width, lineHeight = size * 1.3, color = INK, align = 'left' }) {
  const lines = wrap(text, font, size, width);
  lines.forEach((line, i) => write(page, line, x, y + i * lineHeight, { font, size, color, align, width }));
  return y + lines.length * lineHeight;
}

// ---------- lines and boxes ----------

export function rect(page, x, y, w, h, { fill, stroke, lineWidth = 0.6, opacity, strokeOpacity, dash } = {}) {
  page.drawRectangle({
    x, y: page.getHeight() - y - h, width: w, height: h,
    color: fill, opacity, borderColor: stroke, borderWidth: stroke ? lineWidth : 0, borderOpacity: strokeOpacity,
    borderDashArray: dash,
  });
}

export function line(page, x1, y1, x2, y2, { color = RULE, width = 0.6, dash, opacity } = {}) {
  const h = page.getHeight();
  page.drawLine({ start: { x: x1, y: h - y1 }, end: { x: x2, y: h - y2 }, thickness: width, color, dashArray: dash, opacity });
}

/** An SVG path drawn with its origin at (x, y) from the top-left. SVG paths already point y down. */
export function svg(page, d, x, y, { fill, stroke, lineWidth = 1, opacity, strokeOpacity, rotate = 0, scale = 1 } = {}) {
  page.drawSvgPath(d, {
    x, y: page.getHeight() - y, scale, rotate: degrees(rotate),
    color: fill, opacity, borderColor: stroke, borderWidth: stroke ? lineWidth : 0, borderOpacity: strokeOpacity,
    borderLineCap: 1,
  });
}

/**
 * A table with a header row. columns: [{ title, width, align }]. rows: arrays of cell strings.
 * Returns the y below the table.
 */
export function table(page, { x, y, columns, rows, font, bold, size = 7.5, rowHeight = 15, headerHeight = 18,
  headerFill = LIGHT, stroke = RULE, lineWidth = 0.5, boldRows = [] }) {
  const width = columns.reduce((sum, column) => sum + column.width, 0);
  const height = headerHeight + rows.length * rowHeight;
  rect(page, x, y, width, headerHeight, { fill: headerFill });
  // Header titles may hold two lines ("Rate\nUS$/ct").
  let left = x;
  for (const column of columns) {
    const parts = column.title.split('\n');
    parts.forEach((part, i) => {
      const baseline = y + headerHeight / 2 + size * 0.35 + (i - (parts.length - 1) / 2) * (size + 1);
      write(page, part, left + 3, baseline, { font: bold, size: size - 0.5, align: column.align || 'left', width: column.width - 6 });
    });
    left += column.width;
  }
  rows.forEach((row, r) => {
    const top = y + headerHeight + r * rowHeight;
    let cellLeft = x;
    row.forEach((cell, c) => {
      const column = columns[c];
      write(page, cell, cellLeft + 3, top + rowHeight / 2 + size * 0.35, {
        font: boldRows.includes(r) ? bold : font, size, align: column.align || 'left', width: column.width - 6,
      });
      cellLeft += column.width;
    });
  });
  // Grid: outer box, header rule, row rules and column rules.
  rect(page, x, y, width, height, { stroke, lineWidth });
  line(page, x, y + headerHeight, x + width, y + headerHeight, { width: lineWidth, color: stroke });
  for (let r = 1; r < rows.length; r++) {
    const ry = y + headerHeight + r * rowHeight;
    line(page, x, ry, x + width, ry, { width: lineWidth * 0.6, color: stroke });
  }
  let colX = x;
  for (const column of columns.slice(0, -1)) {
    colX += column.width;
    line(page, colX, y, colX, y + height, { width: lineWidth * 0.6, color: stroke });
  }
  return y + height;
}

// ---------- letter outlines (no text layer) ----------

/** Outline of a word in Geist Bold as an SVG path. Origin: left end of the baseline. */
export function outline(text, size, { spacing = 0 } = {}) {
  const run = OUTLINE_FONT.layout(text);
  const scale = size / OUTLINE_FONT.unitsPerEm;
  let cursor = 0;
  const parts = [];
  run.glyphs.forEach((glyph, i) => {
    const left = cursor;
    // Font outlines point y up; SVG points y down, hence -y.
    parts.push(glyphSvg(glyph, (x, y) => [left + x * scale, -y * scale]));
    cursor += run.positions[i].xAdvance * scale + spacing;
  });
  return { d: parts.join(' '), width: Math.max(0, cursor - spacing), capHeight: OUTLINE_FONT.capHeight * scale };
}

const SVG_COMMANDS = { moveTo: 'M', lineTo: 'L', quadraticCurveTo: 'Q', bezierCurveTo: 'C', closePath: 'Z' };

/**
 * One glyph as SVG path data, with every point passed through map(x, y) -> [x, y].
 * (fontkit has its own Path.transform, but it reuses the new x when it computes y, which breaks rotation.)
 */
function glyphSvg(glyph, map) {
  return glyph.path.commands
    .map(({ command, args }) => {
      const out = [];
      for (let i = 0; i < args.length; i += 2) {
        const [x, y] = map(args[i], args[i + 1]);
        out.push(round(x), round(y));
      }
      return SVG_COMMANDS[command] + out.join(' ');
    })
    .join('');
}

/** Outline text centred on (cx, y). Used for stamp lines. */
function centredOutline(text, size, cx, y, spacing = 0) {
  const shape = outline(text, size, { spacing });
  return shape.d ? shapeAt(shape.d, cx - shape.width / 2, y) : '';
}

// Move every point of an outline path by (dx, dy). Outline paths only hold M, L, Q, C and Z, whose
// numbers always come in x y pairs.
function shapeAt(d, dx, dy) {
  return d.replace(/(-?\d*\.?\d+)\s*,?\s*(-?\d*\.?\d+)/g, (whole, a, b) => `${round(Number(a) + dx)} ${round(Number(b) + dy)}`);
}

// Two decimals are plenty for print, and keep numbers like 1.2e-16 out of the path data.
function round(n) {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r; // no "-0"
}

/**
 * Text around a circle, as one SVG path centred on (0, 0). Top text reads clockwise with letters
 * pointing out; bottom text reads left to right with letters pointing in (like a rubber stamp).
 */
export function ringText(text, size, radius, { bottom = false, spacing = 0.6 } = {}) {
  const run = OUTLINE_FONT.layout(text);
  // Long names get smaller letters, so the text never covers more than 150 degrees of the ring.
  const natural = run.positions.reduce((sum, p) => sum + p.xAdvance, 0) * (size / OUTLINE_FONT.unitsPerEm);
  const room = (150 / 180) * Math.PI * radius;
  const scale = (natural > room ? size * (room / natural) : size) / OUTLINE_FONT.unitsPerEm;
  const advances = run.positions.map((p) => p.xAdvance * scale + spacing);
  const total = advances.reduce((a, b) => a + b, 0) - spacing;
  const capHeight = OUTLINE_FONT.capHeight * scale;
  // Bottom text sits on a larger circle so both rings fill the same band.
  const r = bottom ? radius + capHeight : radius;
  let along = -total / 2;
  const parts = [];
  run.glyphs.forEach((glyph, i) => {
    const width = advances[i] - spacing;
    const centre = along + width / 2;
    // Angle clockwise from the top. Top text runs clockwise; bottom text runs the other way.
    const angle = bottom ? Math.PI - centre / r : centre / r;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = r * sin;
    const py = -r * cos;
    parts.push(glyphSvg(glyph, (x, y) => {
      // The glyph in its own box: centred on its middle, y pointing down.
      const gx = x * scale - width / 2;
      const gy = -y * scale;
      // Top: x along the circle, "up" pointing out. Bottom: turned half a circle, "up" pointing in.
      return bottom
        ? [px - cos * gx + sin * gy, py - sin * gx - cos * gy]
        : [px + cos * gx - sin * gy, py + sin * gx + cos * gy];
    }));
    along += advances[i];
  });
  return parts.join(' ');
}

// ---------- page marks ----------

/** The light diagonal SAMPLE watermark and the footer line. Call once per page, after drawing it. */
export function markPage(page, fonts, { pageNo = 1, pages = 1, watermark = true } = {}) {
  const w = page.getWidth();
  const h = page.getHeight();
  if (watermark) {
    const shape = outline('SAMPLE', 132, { spacing: 10 });
    const angle = 32;
    const rad = (angle * Math.PI) / 180;
    // Put the middle of the word on the middle of the page, then turn it.
    const midX = shape.width / 2;
    const midY = shape.capHeight / 2;
    const x = w / 2 - (midX * Math.cos(rad) - midY * Math.sin(rad));
    const y = h / 2 - (midX * Math.sin(rad) + midY * Math.cos(rad));
    page.drawSvgPath(shape.d, { x, y, rotate: degrees(angle), color: rgb(0.55, 0.57, 0.62), opacity: 0.09 });
  }
  const footer = `${FOOTER}${pages > 1 ? `   |   Page ${pageNo} of ${pages}` : ''}`;
  line(page, MARGIN, h - 30, w - MARGIN, h - 30, { color: rgb(0.75, 0.75, 0.78), width: 0.4 });
  write(page, footer, 0, h - 19, { font: fonts.sans, size: 7, color: GREY, align: 'center', width: w });
}

// ---------- stamps ----------

/**
 * A round rubber stamp: ring text on top and bottom, short lines in the middle.
 * (cx, cy) is the centre from the top-left. Drawn slightly turned and see-through, like real ink.
 */
export function roundStamp(page, { cx, cy, r = 34, top, bottom, middle = [], color = rgb(0.2, 0.25, 0.62), rotate = -12, opacity = 0.78 }) {
  const ring = [
    circlePath(r), circlePath(r - 2.2), circlePath(r * 0.62),
    top ? ringText(top, r * 0.2, r * 0.7) : '',
    bottom ? ringText(bottom, r * 0.2, r * 0.7, { bottom: true }) : '',
  ];
  const strokes = ring.slice(0, 3).join(' ');
  const letters = ring.slice(3).join(' ');
  const middleSize = r * 0.19;
  const middleLetters = middle
    .map((text, i) => centredOutline(text, middleSize, 0, (i - (middle.length - 1) / 2) * (middleSize * 1.25) + middleSize * 0.36))
    .join(' ');
  svg(page, strokes, cx, cy, { stroke: color, lineWidth: 1.1, strokeOpacity: opacity, rotate });
  svg(page, `${letters} ${middleLetters}`, cx, cy, { fill: color, opacity, rotate });
}

/** A rectangular stamp with lines of capitals, e.g. LET EXPORT ORDER. (x, y) is the top-left corner. */
export function boxStamp(page, { x, y, lines, size = 9, color = rgb(0.45, 0.2, 0.55), rotate = 4, opacity = 0.8, padding = 6 }) {
  const shapes = lines.map((text) => outline(text, size));
  const width = Math.max(...shapes.map((s) => s.width)) + padding * 2;
  const lineHeight = size * 1.35;
  const height = lines.length * lineHeight + padding * 1.4;
  const frame = `M0 0 H${width} V${height} H0 Z M2 2 H${width - 2} V${height - 2} H2 Z`;
  const letters = shapes
    .map((shape, i) => shapeAt(shape.d, (width - shape.width) / 2, padding + size * 0.8 + i * lineHeight))
    .join(' ');
  svg(page, frame, x, y, { stroke: color, lineWidth: 1, strokeOpacity: opacity, rotate });
  svg(page, letters, x, y, { fill: color, opacity, rotate });
}

function circlePath(r) {
  // Two arcs make a full circle in SVG.
  return `M ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0`;
}

// ---------- signatures ----------

/** Small seeded random numbers, so the same seed always draws the same scribble. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A handwritten-looking signature: a tall first loop, a run of smaller loops, and a long flourish.
 * Returns an SVG path (origin at the left end of the line it sits on).
 */
export function scribble(seed, width = 90, height = 20) {
  const rand = seeded(seed);
  const points = [[0, -height * 0.1], [width * 0.05, -height * 0.95], [width * 0.1, height * 0.35], [width * 0.02, height * 0.05]];
  let x = width * 0.1;
  const steps = 7 + Math.floor(rand() * 4);
  for (let i = 0; i < steps; i++) {
    x += (width * 0.62) / steps;
    const tall = rand() < 0.25 ? 1.6 : 1;
    points.push([x, -height * (0.25 + rand() * 0.25) * tall]);
    points.push([x + width * 0.02, height * (0.05 + rand() * 0.2)]);
    if (rand() < 0.35) points.push([x - width * 0.03, -height * 0.05]);
  }
  points.push([width * 0.8, height * 0.15], [width * 0.95, -height * 0.2], [width * 0.55, height * 0.45], [width * 0.15, height * 0.4]);
  return smoothPath(points);
}

// Catmull-Rom spline through the points, written as cubic Bezier curves.
function smoothPath(points) {
  let d = `M${round(points[0][0])} ${round(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

/** Draws a signature scribble with its baseline at (x, y). */
export function sign(page, x, y, { seed, width = 90, height = 18, color = BLUE_INK, rotate = 3 }) {
  svg(page, scribble(seed, width, height), x, y, { stroke: color, lineWidth: 0.9, rotate });
}

// ---------- QR code ----------

/** A QR code for `text`, drawn as squares (top-left corner at x, y). */
export function qr(page, text, x, y, size) {
  const code = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const count = code.modules.size;
  const unit = size / count;
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.modules.data[row * count + col]) d += `M${round(col * unit)} ${round(row * unit)} h${round(unit)} v${round(unit)} h${round(-unit)} Z `;
    }
  }
  svg(page, d, x, y, { fill: INK });
}

// ---------- background patterns ----------

/** Fine wavy security lines, like the background of a certificate. Kept very light. */
export function guilloche(page, { x, y, w, h, color = rgb(0.86, 0.9, 0.92), waves = 28, seed = 7 }) {
  const rand = seeded(seed);
  let d = '';
  for (let i = 0; i < waves; i++) {
    const base = (h / waves) * (i + 0.5);
    const amp = 4 + rand() * 6;
    const length = 30 + rand() * 30;
    const phase = rand() * Math.PI * 2;
    d += `M0 ${round(base + amp * Math.sin(phase))}`;
    for (let px = 6; px <= w; px += 6) d += ` L${px} ${round(base + amp * Math.sin(phase + (px / length) * Math.PI))}`;
    d += ' ';
  }
  svg(page, d, x, y, { stroke: color, lineWidth: 0.35 });
}
