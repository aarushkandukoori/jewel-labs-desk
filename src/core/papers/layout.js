// Drawing kit shared by every paper: A4 pages, Geist fonts, text that wraps instead of overflowing,
// headers, tables, status chips, signature boxes and the footer. Plain pdf-lib calls, nothing clever.
import { PDFDocument, rgb, setCharacterSpacing } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { printedLabel } from './format.js';

export const PAGE = { width: 595.28, height: 841.89 }; // A4 in points (1 pt = 1/72 inch)
export const MARGIN = { left: 54, right: 54, top: 50, bottom: 60 };
export const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
export const RIGHT_EDGE = PAGE.width - MARGIN.right;

export const COLOR = {
  ink: rgb(0.067, 0.07, 0.078), // body text, almost black
  soft: rgb(0.29, 0.31, 0.34), // secondary text
  muted: rgb(0.45, 0.47, 0.51), // small labels and "Not on file"
  line: rgb(0.84, 0.85, 0.87), // hairlines between table rows
  rule: rgb(0.07, 0.07, 0.08), // header rules and box borders
  wash: rgb(0.96, 0.962, 0.967), // light fill behind notes
  white: rgb(1, 1, 1),
};

export const STATUS_LABELS = {
  draft: 'Draft',
  held_for_review: 'Held for review',
  ready_to_sign: 'Ready to sign',
  signed: 'Signed',
  sent: 'Sent',
};

// Labels use wide letter spacing. pdf.js treats a gap above 0.102 x font size as a space when it reads the
// text back, so 0.09 x size keeps "PRINTED" readable as one word for search and copy.
const TRACKING = 0.09;

// The positions of status chips and signature fields are saved in the PDF Keywords under this prefix,
// so signPdf can write the signer into the right spots later without rebuilding the paper.
export const LAYOUT_PREFIX = 'jl-layout:';

const FONT_FILES = {
  regular: 'Geist-Regular.ttf',
  medium: 'Geist-Medium.ttf',
  semibold: 'Geist-SemiBold.ttf',
  mono: 'GeistMono-Regular.ttf',
  monoMedium: 'GeistMono-Medium.ttf',
};
const fontCache = {}; // file name -> { bytes, kit }, read from disk once per process
const kitOfFont = new WeakMap(); // pdf-lib font -> fontkit font, used to check which characters exist

function loadFont(file) {
  if (!fontCache[file]) {
    const bytes = fs.readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)));
    fontCache[file] = { bytes, kit: fontkit.create(bytes) };
  }
  return fontCache[file];
}

/** Embeds the Geist fonts into a document (only the characters used end up in the file). */
export async function embedFonts(doc) {
  doc.registerFontkit(fontkit);
  const fonts = {};
  for (const [name, file] of Object.entries(FONT_FILES)) {
    const { bytes, kit } = loadFont(file);
    fonts[name] = await doc.embedFont(bytes, { subset: true });
    kitOfFont.set(fonts[name], kit);
  }
  return fonts;
}

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Makes text safe to draw: tabs and line breaks become spaces, control characters go, and any character
 * the font has no shape for (Gujarati, emoji...) becomes "?" instead of an empty box.
 */
export function clean(text, font) {
  const kit = kitOfFont.get(font);
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (ch === '\t' || ch === '\n' || ch === '\r' || code === 0xa0) out += ' ';
    else if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    else if (kit && !kit.hasGlyphForCodePoint(code)) out += '?';
    else out += ch;
  }
  return out;
}

export function textWidth(text, font, size, spacing = 0) {
  const safe = clean(text, font);
  return font.widthOfTextAtSize(safe, size) + spacing * Math.max(0, [...safe].length - 1);
}

/** Draws one line of text. align 'right' means x is the right edge. Returns the width drawn. */
export function drawText(page, text, x, y, { font, size, color = COLOR.ink, spacing = 0, align = 'left' }) {
  const safe = clean(text, font);
  if (!safe) return 0;
  const width = font.widthOfTextAtSize(safe, size) + spacing * Math.max(0, [...safe].length - 1);
  const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
  if (spacing) page.pushOperators(setCharacterSpacing(spacing));
  page.drawText(safe, { x: left, y, size, font, color });
  if (spacing) page.pushOperators(setCharacterSpacing(0)); // reset, or every later text would be spaced out
  return width;
}

/** Small uppercase label with wide letter spacing, like "INSIDE THE DOCUMENT ENVELOPE". */
export function drawCaps(page, fonts, text, x, y, { size = 6.8, color = COLOR.muted, align = 'left', font } = {}) {
  return drawText(page, String(text ?? '').toUpperCase(), x, y, {
    font: font || fonts.medium, size, color, spacing: size * TRACKING, align,
  });
}

export function capsWidth(fonts, text, size = 6.8) {
  return textWidth(String(text ?? '').toUpperCase(), fonts.medium, size, size * TRACKING);
}

/** Splits text into lines that fit maxWidth. Long words (file names, URLs) are cut so nothing overflows. */
export function wrap(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const ch of word) {
        if (line && textWidth(line + ch, font, size) > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Keeps at most `max` lines; the last one kept ends in "..." so a runaway value can never outgrow a page. */
export function capLines(lines, max, font, size, maxWidth) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = fitLine(`${kept[max - 1]} ${lines[max]}`, font, size, maxWidth);
  return kept;
}

/** Shortens one line with "..." so it fits maxWidth. */
export function fitLine(text, font, size, maxWidth) {
  let safe = clean(text, font);
  if (textWidth(safe, font, size) <= maxWidth) return safe;
  while (safe.length > 1 && textWidth(`${safe}...`, font, size) > maxWidth) safe = safe.slice(0, -1);
  return `${safe.trimEnd()}...`;
}

/**
 * Starts a paper. ctx carries the document, the current page and the cursor y (top of the free space).
 * marks collects chip and signature positions; generated lists the pages we drew (they get the footer).
 */
export async function startPaper({ ref, version = 1, printedAt = new Date(), sample = false }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedFonts(doc);
  return {
    doc, fonts, ref, version, printedAt, sample,
    page: null, pageIndex: -1, y: 0, section: '',
    generated: [],
    marks: { chips: [], blocks: [] },
  };
}

/** Adds a blank A4 page and moves the cursor to its top. */
export function addPage(ctx, section) {
  ctx.page = ctx.doc.addPage([PAGE.width, PAGE.height]);
  ctx.pageIndex = ctx.doc.getPageCount() - 1;
  ctx.generated.push(ctx.pageIndex);
  ctx.y = PAGE.height - MARGIN.top;
  if (section) ctx.section = section;
  return ctx.page;
}

/** Makes sure `height` points fit above the footer; if not, continues on a new page. Returns true on a new page. */
export function ensureSpace(ctx, height) {
  if (ctx.page && ctx.y - height >= MARGIN.bottom) return false;
  addPage(ctx);
  drawContinuedHeader(ctx);
  return true;
}

function drawRefBlock(ctx, rightY) {
  const { page, fonts } = ctx;
  drawText(page, ctx.ref, RIGHT_EDGE, rightY, { font: fonts.monoMedium, size: 11, align: 'right' });
  drawCaps(page, fonts, printedLabel(ctx.printedAt), RIGHT_EDGE, rightY - 12.5, { size: 6.3, align: 'right' });
}

/**
 * Page header: small label, big title, subtitle on the left; status chip, ref and printed date on the right;
 * a black rule underneath. status null means no chip. registerChip false (or a fixed chipText) makes a chip that
 * signPdf leaves alone; a registered chip turns into SIGNED when the paper is signed.
 */
export function drawHeader(ctx, { label, title, subtitle, subtitleCaps = false, status = null, registerChip = true, chipText }) {
  const { page, fonts } = ctx;
  const top = ctx.y;
  const left = MARGIN.left;
  drawCaps(page, fonts, label, left, top - 6);
  if (status || chipText) drawChip(ctx, status, RIGHT_EDGE, top - 9.5, { align: 'right', register: registerChip, text: chipText });

  // Left: title (up to 2 lines) and subtitle (up to 2 lines). Right: ref and printed date, aligned to the
  // last line on the left. Long values are wrapped, and shortened with "..." only past two lines.
  const titleWidth = CONTENT_WIDTH - 175;
  const titleLines = wrap(title, fonts.semibold, 16, titleWidth);
  let y = top - 28;
  titleLines.slice(0, 2).forEach((line, i) => {
    const text = i === 1 && titleLines.length > 2 ? fitLine(`${line} ${titleLines.slice(2).join(' ')}`, fonts.semibold, 16, titleWidth) : line;
    drawText(page, text, left, y - i * 19, { font: fonts.semibold, size: 16 });
  });
  y -= (Math.min(titleLines.length, 2) - 1) * 19;
  const subFont = subtitleCaps ? fonts.medium : fonts.regular;
  const subSize = subtitleCaps ? 6.6 : 8.6;
  const subText = subtitle ? (subtitleCaps ? String(subtitle).toUpperCase() : String(subtitle)) : '';
  const subLines = subtitle ? wrap(subText, subFont, subSize, titleWidth) : [];
  y -= 15;
  subLines.slice(0, 2).forEach((line, i) => {
    const text = i === 1 && subLines.length > 2 ? fitLine(`${line} ${subLines.slice(2).join(' ')}`, subFont, subSize, titleWidth) : line;
    if (subtitleCaps) drawCaps(page, fonts, text, left, y - i * 11, { size: subSize });
    else drawText(page, text, left, y - i * 11, { font: subFont, size: subSize, color: COLOR.soft });
  });
  y -= Math.max(0, Math.min(subLines.length, 2) - 1) * 11;
  drawRefBlock(ctx, y + 12.5);
  page.drawLine({ start: { x: left, y: y - 9 }, end: { x: RIGHT_EDGE, y: y - 9 }, thickness: 0.8, color: COLOR.rule });
  ctx.y = y - 9 - 14;
}

/** A slim header for pages that continue a section: "STONE LIST · CONTINUED" and the ref. */
export function drawContinuedHeader(ctx) {
  const { page, fonts } = ctx;
  const top = ctx.y;
  drawCaps(page, fonts, ctx.section ? `${ctx.section} · continued` : 'Continued', MARGIN.left, top - 6);
  drawText(page, ctx.ref, RIGHT_EDGE, top - 6, { font: fonts.monoMedium, size: 8.5, align: 'right' });
  page.drawLine({ start: { x: MARGIN.left, y: top - 13 }, end: { x: RIGHT_EDGE, y: top - 13 }, thickness: 0.5, color: COLOR.line });
  ctx.y = top - 27;
}

/** Small uppercase section label. Keeps at least `keepWith` points of what follows on the same page. */
export function sectionLabel(ctx, text, { keepWith = 40 } = {}) {
  const atTop = ctx.y >= PAGE.height - MARGIN.top - 30;
  const gap = atTop ? 0 : 10;
  ensureSpace(ctx, gap + 12 + keepWith);
  const freshTop = ctx.y >= PAGE.height - MARGIN.top - 30;
  ctx.y -= freshTop ? 0 : gap;
  drawCaps(ctx.page, ctx.fonts, text, MARGIN.left, ctx.y - 6);
  ctx.y -= 12;
}

/** Status chip: "READY TO SIGN" in a thin black box. SIGNED is a filled black chip. y is the chip's bottom. */
export function drawChip(ctx, status, x, y, { align = 'left', register = true, page = ctx.page, pageIndex = ctx.pageIndex, text } = {}) {
  const width = drawChipOn(page, ctx.fonts, text || STATUS_LABELS[status] || String(status || ''), x, y, { align, filled: status === 'signed' && !text });
  if (register) {
    const left = align === 'right' ? x - width : x;
    ctx.marks.chips.push({ p: pageIndex, x: round(left), y: round(y), w: round(width), h: CHIP_HEIGHT, ax: round(x), align });
  }
  return width;
}

const CHIP_HEIGHT = 12.5;

/** Draws a chip on any page (also used by signPdf on a page it loaded). Returns its width. */
export function drawChipOn(page, fonts, text, x, y, { align = 'left', filled = false } = {}) {
  const size = 6.6;
  const label = String(text).toUpperCase();
  const width = capsWidth(fonts, label, size) + 10;
  const left = align === 'right' ? x - width : x;
  page.drawRectangle({
    x: left, y, width, height: CHIP_HEIGHT,
    borderColor: COLOR.rule, borderWidth: 0.75, color: filled ? COLOR.rule : undefined,
  });
  drawCaps(page, fonts, label, left + 5, y + 4, { size, color: filled ? COLOR.white : COLOR.ink });
  return width;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Two-column rows (label | value) with hairlines, like the reference papers.
 * row: { label, value, note?, mono?, chip?, muted?, writeIn? }. A missing value prints "Not on file" in grey.
 * writeIn: a missing value is a field to fill in by hand, so a line to write on is drawn instead. With
 * writeIn: { role }, signPdf writes the signing day (15/11/2026) on that line when it signs for that role.
 */
export function drawRows(ctx, rows, { labelWidth = 165, size = 8.5, pad = 5 } = {}) {
  const { fonts } = ctx;
  const lead = size * 1.36;
  const valueX = MARGIN.left + labelWidth;
  const valueWidth = RIGHT_EDGE - valueX - 4;
  let first = true;
  for (const row of rows) {
    const blank = row.value === null || row.value === undefined || String(row.value).trim() === '';
    const writeIn = Boolean(row.writeIn) && blank && !row.chip;
    const missing = blank && !writeIn;
    const valueFont = row.mono ? fonts.mono : fonts.regular;
    const valueSize = row.mono ? size - 0.5 : size;
    const valueLines = row.chip || writeIn ? [''] : capLines(wrap(missing ? 'Not on file' : row.value, valueFont, valueSize, valueWidth), 24, valueFont, valueSize, valueWidth);
    const noteLines = row.note ? capLines(wrap(row.note, fonts.regular, size - 1, valueWidth), 8, fonts.regular, size - 1, valueWidth) : [];
    const labelLines = wrap(row.label, fonts.medium, size, labelWidth - 14);
    const height = pad * 2 + Math.max(labelLines.length * lead, valueLines.length * lead + noteLines.length * (lead - 1.5));
    const newPage = ensureSpace(ctx, height);
    const { page } = ctx;
    const top = ctx.y;
    if (first || newPage) page.drawLine({ start: { x: MARGIN.left, y: top }, end: { x: RIGHT_EDGE, y: top }, thickness: 0.5, color: COLOR.line });
    first = false;
    const baseline = top - pad - (lead - size) / 2 - size * 0.78;
    labelLines.forEach((line, i) => drawText(page, line, MARGIN.left + 6, baseline - i * lead, { font: fonts.medium, size }));
    if (row.chip) {
      drawChip(ctx, row.chip, valueX, baseline - 3.5, { register: row.registerChip !== false });
    } else if (writeIn) {
      const line = { x: round(valueX), y: round(baseline - 2.5), w: round(Math.min(160, valueWidth)), h: round(size) };
      page.drawLine({ start: { x: line.x, y: line.y }, end: { x: line.x + line.w, y: line.y }, thickness: 0.5, color: COLOR.soft });
      if (row.writeIn.role) ctx.marks.blocks.push({ p: ctx.pageIndex, role: row.writeIn.role, name: null, title: null, sig: null, date: null, day: line });
    } else {
      const color = missing || row.muted ? COLOR.muted : COLOR.ink;
      valueLines.forEach((line, i) => drawText(page, line, valueX, baseline - i * lead, { font: valueFont, size: valueSize, color }));
    }
    const noteTop = baseline - valueLines.length * lead;
    noteLines.forEach((line, i) => drawText(page, line, valueX, noteTop - i * (lead - 1.5), { font: fonts.regular, size: size - 1, color: COLOR.muted }));
    ctx.y = top - height;
    page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: RIGHT_EDGE, y: ctx.y }, thickness: 0.5, color: COLOR.line });
  }
}

/**
 * A table with column headings that repeat on every page.
 * columns: [{ title, width, align?, mono?, empty? }] (widths in points; empty = text for a missing value,
 * "Not on file" unless set). rows: [{ cells: [..], muted?, strong?, empty? }] (row empty overrides the column's).
 */
export function drawTable(ctx, { columns, rows, size = 7.6 }) {
  const { fonts } = ctx;
  const lead = size * 1.32;
  const pad = 4;
  const xs = [];
  let x = MARGIN.left;
  for (const col of columns) {
    xs.push(x);
    x += col.width;
  }

  const drawHeadings = () => {
    const { page } = ctx;
    const top = ctx.y;
    const headLines = columns.map((col) => wrap(col.title.toUpperCase(), fonts.medium, 5.9, col.width - (col.align === 'right' ? 13 : 6)));
    const height = 6 + Math.max(...headLines.map((lines) => lines.length)) * 7.6;
    headLines.forEach((lines, i) => {
      lines.forEach((line, j) => {
        const col = columns[i];
        const textX = col.align === 'right' ? xs[i] + col.width - 10 : xs[i] + 3;
        drawCaps(page, fonts, line, textX, top - 7 - j * 7.6, { size: 5.9, align: col.align === 'right' ? 'right' : 'left' });
      });
    });
    ctx.y = top - height;
    page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: RIGHT_EDGE, y: ctx.y }, thickness: 0.75, color: COLOR.rule });
  };

  ensureSpace(ctx, 40);
  drawHeadings();
  for (const row of rows) {
    const font = row.strong ? fonts.medium : fonts.regular;
    const cellLines = columns.map((col, i) => {
      const value = row.cells[i];
      const blank = value === null || value === undefined || String(value).trim() === '';
      const text = blank ? (row.empty ?? col.empty ?? 'Not on file') : String(value);
      const cellFont = col.mono && !blank ? fonts.mono : font;
      const cellSize = col.mono ? size - 0.4 : size;
      const width = col.width - (col.align === 'right' ? 13 : 7);
      return capLines(wrap(text, cellFont, cellSize, width), 12, cellFont, cellSize, width);
    });
    const height = pad * 2 + Math.max(...cellLines.map((lines) => lines.length)) * lead;
    if (ensureSpace(ctx, height)) drawHeadings();
    const { page } = ctx;
    const top = ctx.y;
    const baseline = top - pad - (lead - size) / 2 - size * 0.78;
    columns.forEach((col, i) => {
      const value = row.cells[i];
      const blank = value === null || value === undefined || String(value).trim() === '';
      const cellFont = col.mono && !blank ? fonts.mono : font;
      const cellSize = col.mono ? size - 0.4 : size;
      const color = blank || row.muted || col.muted ? COLOR.muted : COLOR.ink;
      cellLines[i].forEach((line, j) => {
        const textX = col.align === 'right' ? xs[i] + col.width - 10 : xs[i] + 3;
        drawText(page, line, textX, baseline - j * lead, { font: cellFont, size: cellSize, color, align: col.align === 'right' ? 'right' : 'left' });
      });
    });
    ctx.y = top - height;
    page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: RIGHT_EDGE, y: ctx.y }, thickness: 0.5, color: COLOR.line });
  }
}

/** A label row with an empty line to write on by hand (seal numbers on the handover cover). */
export function drawWriteInRow(ctx, label, { labelWidth = 165 } = {}) {
  ensureSpace(ctx, 26);
  const { page } = ctx;
  drawText(page, label, MARGIN.left + 6, ctx.y - 14, { font: ctx.fonts.medium, size: 8.5 });
  page.drawLine({ start: { x: MARGIN.left + labelWidth, y: ctx.y - 20 }, end: { x: RIGHT_EDGE, y: ctx.y - 20 }, thickness: 0.6, color: COLOR.soft });
  ctx.y -= 26;
}

/** A paragraph of running text that flows onto the next page if needed. */
export function drawParagraph(ctx, text, { size = 9, font, color = COLOR.ink, indent = 0, gapAfter = 7, lead } = {}) {
  const useFont = font || ctx.fonts.regular;
  const lineHeight = lead || size * 1.42;
  for (const line of wrap(text, useFont, size, CONTENT_WIDTH - indent)) {
    ensureSpace(ctx, lineHeight);
    drawText(ctx.page, line, MARGIN.left + indent, ctx.y - size * 0.95, { font: useFont, size, color });
    ctx.y -= lineHeight;
  }
  ctx.y -= gapAfter;
}

/** A light grey box with a short note in it, e.g. "Drafted by Jewel Labs agents ... Check every line." */
export function drawNotice(ctx, text, { size = 8.4, font } = {}) {
  const useFont = font || ctx.fonts.medium;
  const lines = wrap(text, useFont, size, CONTENT_WIDTH - 20);
  const lead = size * 1.4;
  const height = lines.length * lead + 10;
  ensureSpace(ctx, height + 6);
  const { page } = ctx;
  page.drawRectangle({ x: MARGIN.left, y: ctx.y - height, width: CONTENT_WIDTH, height, color: COLOR.wash, borderColor: COLOR.line, borderWidth: 0.5 });
  lines.forEach((line, i) => drawText(page, line, MARGIN.left + 10, ctx.y - 5 - size * 0.95 - i * lead, { font: useFont, size }));
  ctx.y -= height + 7;
}

/**
 * A write-in field: small label on top, a line to write on. Returns where the writing goes:
 * x, y (the line), w (its length) and h (the room above the line, below the label).
 */
function drawWriteIn(page, fonts, label, x, top, width, height = 24) {
  drawText(page, label, x, top - 7.5, { font: fonts.regular, size: 6.8, color: COLOR.muted });
  const lineY = top - height;
  page.drawLine({ start: { x, y: lineY }, end: { x: x + width, y: lineY }, thickness: 0.5, color: COLOR.soft });
  return { x: round(x), y: round(lineY), w: round(width), h: round(height - 10) };
}

/**
 * Signature block: a bordered box with Name, Title/Position, Signature and Date, and an optional stamp area.
 * role 'signer' is filled by signPdf (the house person who signs in the app); other roles stay blank for pen.
 */
export function drawSignatureBlock(ctx, { heading, role = 'signer', labels = {}, stamp = null, note = null }) {
  const { fonts } = ctx;
  const names = { name: 'Name', title: 'Title', signature: 'Signature', date: 'Date', ...labels };
  const noteLines = note ? wrap(note, fonts.regular, 7.4, CONTENT_WIDTH - 20) : [];
  const boxHeight = 70 + noteLines.length * 10;
  sectionLabel(ctx, heading, { keepWith: boxHeight + 4 });
  const { page } = ctx;
  const top = ctx.y;
  page.drawRectangle({ x: MARGIN.left, y: top - boxHeight, width: CONTENT_WIDTH, height: boxHeight, borderColor: COLOR.rule, borderWidth: 0.75 });
  const stampWidth = stamp ? 112 : 0;
  const inner = CONTENT_WIDTH - 20 - (stamp ? stampWidth + 14 : 0);
  const colWidth = (inner - 16) / 2;
  const x1 = MARGIN.left + 10;
  const x2 = x1 + colWidth + 16;
  const row1 = top - 7;
  const row2 = row1 - 31;
  const block = {
    p: ctx.pageIndex,
    role,
    name: drawWriteIn(page, fonts, names.name, x1, row1, colWidth),
    title: drawWriteIn(page, fonts, names.title, x2, row1, colWidth),
    sig: drawWriteIn(page, fonts, names.signature, x1, row2, colWidth),
    date: drawWriteIn(page, fonts, names.date, x2, row2, colWidth),
  };
  if (stamp) {
    const sx = RIGHT_EDGE - 10 - stampWidth;
    page.drawRectangle({ x: sx, y: row2 - 24, width: stampWidth, height: row1 - row2 + 24, borderColor: COLOR.line, borderWidth: 0.75 });
    drawText(page, stamp, sx + stampWidth / 2, row2 - 24 + 6, { font: fonts.regular, size: 6.6, color: COLOR.muted, align: 'center' });
  }
  noteLines.forEach((line, i) => drawText(page, line, x1, row2 - 24 - 10 - i * 10, { font: fonts.regular, size: 7.4, color: COLOR.muted }));
  ctx.marks.blocks.push(block);
  ctx.y = top - boxHeight - 6;
  return block;
}

/**
 * One-row strip "Checked by <house>": Name, Title, Date. Used on drafts another party signs, so the house's own
 * sign-off has a place that signPdf can fill without touching the other party's signature box.
 */
export function drawCheckedBy(ctx, { heading, role = 'signer' }) {
  const { fonts } = ctx;
  const height = 36;
  sectionLabel(ctx, heading, { keepWith: height + 4 });
  const { page } = ctx;
  const top = ctx.y;
  page.drawRectangle({ x: MARGIN.left, y: top - height, width: CONTENT_WIDTH, height, borderColor: COLOR.line, borderWidth: 0.75 });
  const gap = 14;
  const width = (CONTENT_WIDTH - 20 - gap * 2) / 3;
  const x = (i) => MARGIN.left + 10 + i * (width + gap);
  const block = {
    p: ctx.pageIndex,
    role,
    name: drawWriteIn(page, fonts, 'Name', x(0), top - 5, width, 23),
    title: drawWriteIn(page, fonts, 'Title', x(1), top - 5, width, 23),
    date: drawWriteIn(page, fonts, 'Date', x(2), top - 5, width, 23),
    sig: null,
  };
  ctx.marks.blocks.push(block);
  ctx.y = top - height - 6;
  return block;
}

/** Three handover boxes side by side: SHIPPER / CARRIER / CONSIGNEE, each with Name, Signature, Date and time. */
export function drawHandoverBoxes(ctx, titles) {
  const { fonts } = ctx;
  const gap = 10;
  const width = (CONTENT_WIDTH - gap * (titles.length - 1)) / titles.length;
  const height = 106;
  ensureSpace(ctx, height + 8);
  const { page } = ctx;
  const top = ctx.y;
  titles.forEach((title, i) => {
    const x = MARGIN.left + i * (width + gap);
    page.drawRectangle({ x, y: top - height, width, height, borderColor: COLOR.rule, borderWidth: 0.9 });
    drawCaps(page, fonts, title, x + 8, top - 13);
    ['Name', 'Signature', 'Date and time'].forEach((label, j) => {
      drawWriteIn(page, fonts, label, x + 8, top - 20 - j * 28, width - 16, 25);
    });
  });
  ctx.y = top - height - 10;
}

/** Writes "Prepared by Jewel Labs agents · REF vN · page n of N" on every page we generated. */
export function drawFooters(ctx) {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  for (const index of ctx.generated) {
    const page = pages[index];
    page.drawLine({ start: { x: MARGIN.left, y: 48 }, end: { x: RIGHT_EDGE, y: 48 }, thickness: 0.5, color: COLOR.line });
    const text = `Prepared by Jewel Labs agents · ${ctx.ref} v${ctx.version} · page ${index + 1} of ${total}`;
    drawText(page, text, MARGIN.left, 36, { font: ctx.fonts.regular, size: 7, color: COLOR.muted });
    if (ctx.sample) drawCaps(page, ctx.fonts, 'Sample · fictional data', RIGHT_EDGE, 36, { size: 6.4, color: COLOR.soft, align: 'right' });
  }
}

/** Reads the saved chip and signature positions back out of a PDF made here. Null for other PDFs. */
export function readLayout(doc) {
  const keywords = doc.getKeywords() || '';
  const at = keywords.indexOf(LAYOUT_PREFIX);
  if (at === -1) return null;
  try {
    return JSON.parse(keywords.slice(at + LAYOUT_PREFIX.length));
  } catch {
    return null;
  }
}

export function writeLayout(doc, layout) {
  doc.setKeywords([`${LAYOUT_PREFIX}${JSON.stringify(layout)}`]);
}

/** Sets the metadata, saves, and returns { bytes, sha256, pages }. Same input gives the same bytes. */
export async function finishPaper(ctx, { title, subject }) {
  const { doc } = ctx;
  doc.setTitle(title);
  doc.setSubject(subject || title);
  doc.setAuthor('Jewel Labs agents');
  doc.setCreator('Jewel Labs Desk');
  doc.setProducer('Jewel Labs Desk (pdf-lib)');
  doc.setCreationDate(new Date(ctx.printedAt));
  doc.setModificationDate(new Date(ctx.printedAt));
  writeLayout(doc, { v: 1, ref: ctx.ref, version: ctx.version, chips: ctx.marks.chips, blocks: ctx.marks.blocks, signed: null });
  const bytes = await doc.save();
  return { bytes, sha256: sha256Hex(bytes), pages: doc.getPageCount() };
}
