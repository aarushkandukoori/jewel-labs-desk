// The original documents at the back of a pack. PDF pages are copied unchanged, photos are placed on an A4
// page, and spreadsheet lines are shown as a table. Anything we cannot attach is listed as "not attached".
import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib';
import {
  COLOR, CONTENT_WIDTH, MARGIN, addPage, drawCaps, drawHeader, drawNotice, drawText, fitLine,
} from './layout.js';
import { docTitle, sourceText } from './format.js';
import { drawLinesTable } from './packing-list.js';
import { isAgentDraft, isUncheckedDraft } from '../records/stones.js';

/**
 * A fresh copy of the bytes. Small Node Buffers share one big memory pool, and pdf-lib's JPEG reader looks
 * at the whole pool instead of our slice ("SOI not found"), so every file gets its own copy first.
 */
export function toBytes(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return null;
}

/** What the bytes really are, by their first bytes (the stored mime type can be wrong). */
export function sniffType(bytes) {
  if (!bytes || bytes.length < 4) return 'other';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  // A PDF header can sit a little after the start of the file.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  return 'other';
}

/**
 * Phone photos often store "which way is up" in an EXIF tag (0x0112) instead of turning the pixels.
 * PDF viewers ignore that tag, so we read it and turn the photo ourselves. Returns 1 (as stored) to 8.
 */
export function jpegOrientation(bytes) {
  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1;
    const marker = bytes[at + 1];
    const size = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker === 0xda) return 1; // image data starts: no more headers
    const isExif = marker === 0xe1 && Buffer.from(bytes.subarray(at + 4, at + 10)).toString('latin1') === 'Exif\0\0';
    if (isExif) return readTiffOrientation(bytes, at + 10, at + 2 + size);
    at += 2 + size;
  }
  return 1;
}

function readTiffOrientation(bytes, start, end) {
  const little = bytes[start] === 0x49; // "II" = little-endian, "MM" = big-endian
  const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
  const u32 = (o) => (little
    ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
    : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
  if (start + 8 > end) return 1;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** "This XLSX file cannot go in a PDF..." for files that are neither PDF, JPEG nor PNG. */
function cannotAttachNote(doc) {
  const match = /\.([a-z0-9]{1,6})$/i.exec(doc?.fileName || '');
  const kind = match ? `This ${match[1].toUpperCase()} file` : 'This file';
  return `${kind} cannot go in a PDF. It is kept on record.`;
}

/**
 * Fetches a document's file and decides how it goes into the pack.
 * getFile is called as getFile(doc.fileKey, doc) and may return bytes, null, or a promise of either.
 */
export async function loadOriginal(doc, getFile) {
  const base = { doc, title: docTitle(doc) };
  let bytes = null;
  try {
    bytes = toBytes(await getFile?.(doc.fileKey, doc));
  } catch {
    bytes = null;
  }
  // The agents' own packing list, once a person checked it, goes in as a clean table of its lines: the stored PDF
  // is the draft, stamped DRAFT and "check every line before use".
  if (isAgentDraft(doc) && !isUncheckedDraft(doc) && Array.isArray(doc.lines) && doc.lines.length) return { ...base, type: 'checked_draft' };
  if (!bytes || !bytes.length) return { ...base, type: 'none', note: 'No file on record' };
  const type = sniffType(bytes);
  if (type === 'pdf') {
    try {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      if (pdf.isEncrypted) return { ...base, type: 'none', note: 'The PDF is password protected' };
      return { ...base, type: 'pdf', pdf, pageCount: pdf.getPageCount() };
    } catch {
      return { ...base, type: 'none', note: 'The PDF could not be read' };
    }
  }
  if (type === 'png' || type === 'jpeg') {
    return { ...base, type, bytes, orientation: type === 'jpeg' ? jpegOrientation(bytes) : 1 };
  }
  // A spreadsheet (say a packing list .xlsx) cannot be placed in a PDF, but the lines the agents read can.
  if (Array.isArray(doc.lines) && doc.lines.length > 0) return { ...base, type: 'lines' };
  return { ...base, type: 'none', note: cannotAttachNote(doc) };
}

/** A photo or scan placed on its own A4 page, scaled to fit and turned the right way up. */
async function drawPhotoPage(ctx, original) {
  let image;
  try {
    image = original.type === 'png' ? await ctx.doc.embedPng(original.bytes) : await ctx.doc.embedJpg(original.bytes);
  } catch {
    original.type = 'none';
    original.note = 'The image could not be read';
    return false;
  }
  const page = addPage(ctx, 'Original');
  const { fonts } = ctx;
  const top = ctx.y;
  const source = sourceText(original.doc.source);
  drawCaps(page, fonts, 'Original document · photo or scan', MARGIN.left, top - 6);
  drawText(page, fitLine(original.title, fonts.semibold, 11, CONTENT_WIDTH), MARGIN.left, top - 22, { font: fonts.semibold, size: 11 });
  const caption = [original.doc.fileName, source.how, source.when].filter(Boolean).join(' · ');
  drawText(page, fitLine(caption, fonts.regular, 7.6, CONTENT_WIDTH), MARGIN.left, top - 34, { font: fonts.regular, size: 7.6, color: COLOR.muted });

  const boxTop = top - 46;
  const boxWidth = CONTENT_WIDTH;
  const boxHeight = boxTop - MARGIN.bottom;
  const turned = original.orientation === 6 || original.orientation === 8; // a quarter turn swaps width and height
  const shownW = turned ? image.height : image.width;
  const shownH = turned ? image.width : image.height;
  const scale = Math.min(boxWidth / shownW, boxHeight / shownH);
  const w = shownW * scale;
  const h = shownH * scale;
  const x = MARGIN.left + (boxWidth - w) / 2;
  const y = boxTop - h;
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  // pdf-lib turns an image around its bottom-left corner, so each turn starts from a different corner.
  if (original.orientation === 6) page.drawImage(image, { x, y: y + h, width: drawW, height: drawH, rotate: degrees(-90) });
  else if (original.orientation === 8) page.drawImage(image, { x: x + w, y, width: drawW, height: drawH, rotate: degrees(90) });
  else if (original.orientation === 3) page.drawImage(image, { x: x + w, y: y + h, width: drawW, height: drawH, rotate: degrees(180) });
  else page.drawImage(image, { x, y, width: drawW, height: drawH });
  page.drawRectangle({ x, y, width: w, height: h, borderColor: COLOR.line, borderWidth: 0.5 });
  ctx.y = MARGIN.bottom;
  return true;
}

/** A spreadsheet (packing list .xlsx) cannot be placed in a PDF, so its lines are shown as a table. */
function drawLinesPages(ctx, original) {
  addPage(ctx, 'Original');
  drawHeader(ctx, {
    label: 'Original document · spreadsheet',
    title: original.title,
    subtitle: original.doc.fileName || null,
  });
  drawNotice(ctx, 'The spreadsheet itself is kept on record. These are its lines as the agents read them.');
  drawLinesTable(ctx, original.doc.lines);
}

/** The agents' packing list a person checked: its lines as a table, with who checked it. */
function drawCheckedDraftPages(ctx, original) {
  addPage(ctx, 'Original');
  drawHeader(ctx, {
    label: 'Packing list · drafted by agents, checked by the house',
    title: original.title,
    subtitle: original.doc.fileName || null,
  });
  const checked = (original.doc.fields || []).find((field) => field.key === 'doc.checkedBy' && field.value);
  const by = checked?.by ? `${checked.by} at the house` : 'a person at the house';
  drawNotice(ctx, `Drafted by Jewel Labs agents from the chat and emails, then checked line by line by ${by}. These are its lines.`);
  drawLinesTable(ctx, original.doc.lines);
}

// Annotations that carry files, media or 3D content: left out of the copy. Their look on the page is not content.
const DROPPED_ANNOTATIONS = new Set(['FileAttachment', 'RichMedia', 'Screen', 'Movie', 'Sound', '3D']);

/**
 * Makes a copied page inert: what is printed stays exactly as it was, but nothing on it can run or open anything in
 * the house's own pack. Page actions go, annotations lose their actions (JavaScript, Launch, SubmitForm, links), and
 * attachment and media annotations are dropped. Form fields keep their printed values.
 */
export function makeInert(doc, page) {
  const { context } = doc;
  page.node.delete(PDFName.of('AA'));
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const annot = context.lookupMaybe(annots.get(i), PDFDict);
    if (!annot) continue;
    const subtype = annot.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (subtype && DROPPED_ANNOTATIONS.has(subtype.decodeText())) {
      annots.remove(i);
      continue;
    }
    // A form field's actions can sit on the widget or on the field above it.
    for (let node = annot, depth = 0; node && depth < 8; node = node.lookupMaybe(PDFName.of('Parent'), PDFDict), depth++) {
      node.delete(PDFName.of('A'));
      node.delete(PDFName.of('AA'));
    }
  }
}

/**
 * Appends one original to the pack. Returns { first, last } (page numbers, from 1) or null when it is
 * not attached. A failure here marks the original "not attached" so the next pass lists it that way.
 */
export async function appendOriginal(ctx, original) {
  const first = ctx.doc.getPageCount() + 1;
  if (original.type === 'pdf') {
    try {
      const pages = await ctx.doc.copyPages(original.pdf, original.pdf.getPageIndices());
      pages.forEach((page) => {
        makeInert(ctx.doc, page);
        ctx.doc.addPage(page);
      });
    } catch {
      original.type = 'none';
      original.note = 'The PDF pages could not be copied';
      return null;
    }
  } else if (original.type === 'png' || original.type === 'jpeg') {
    if (!(await drawPhotoPage(ctx, original))) return null;
  } else if (original.type === 'lines') {
    drawLinesPages(ctx, original);
  } else if (original.type === 'checked_draft') {
    drawCheckedDraftPages(ctx, original);
  } else {
    return null;
  }
  return { first, last: ctx.doc.getPageCount() };
}
