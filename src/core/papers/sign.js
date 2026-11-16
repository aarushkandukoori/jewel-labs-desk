// Signing a paper: write the signer into the house's signature boxes and stamp SIGNED over each status chip.
// The box and chip positions were saved in the PDF's Keywords when the paper was built (see layout.js).
import { PDFDocument } from 'pdf-lib';
import {
  COLOR, CONTENT_WIDTH, MARGIN, PAGE, RIGHT_EDGE,
  drawCaps, drawChipOn, drawText, embedFonts, fitLine, readLayout, sha256Hex, writeLayout,
} from './layout.js';
import { formatDateTime, formatSlashDate, parseIsoDay } from './format.js';

async function embedSignature(doc, dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUrl).trim());
  if (!match) throw new Error('The signature must be a PNG or JPEG image.');
  const bytes = new Uint8Array(Buffer.from(match[2], 'base64')); // own copy, see toBytes in originals.js
  return match[1].toLowerCase() === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

/** Writes text just above a field's line, shortened if the line is too short for it. */
function writeOnLine(page, fonts, field, text, size = 9.5) {
  if (!field || !text) return;
  drawText(page, fitLine(text, fonts.medium, size, field.w - 2), field.x + 1, field.y + 3.5, { font: fonts.medium, size });
}

function writeSigner(page, fonts, block, signer) {
  writeOnLine(page, fonts, block.name, signer.name);
  writeOnLine(page, fonts, block.title, signer.title);
  writeOnLine(page, fonts, block.date, signer.when);
  // A statement's own "Date of declaration" line: the day it is signed, in the template's format.
  writeOnLine(page, fonts, block.day, signer.day, 8.5);
  if (!block.sig) return;
  if (signer.image) {
    // Fit the drawn signature right of the small "Signature" label, keeping its shape.
    const box = { x: block.sig.x + 42, y: block.sig.y + 1.5, w: Math.min(150, block.sig.w - 46), h: block.sig.h + 6 };
    const scale = Math.min(box.w / signer.image.width, box.h / signer.image.height);
    page.drawImage(signer.image, { x: box.x, y: box.y, width: signer.image.width * scale, height: signer.image.height * scale });
  } else {
    writeOnLine(page, fonts, block.sig, signer.name, 11);
  }
}

/** Covers the old chip with white and draws a black SIGNED chip in the same place. */
function restamp(page, fonts, chip) {
  page.drawRectangle({ x: chip.x - 1.5, y: chip.y - 1.5, width: chip.w + 3, height: chip.h + 3, color: COLOR.white });
  const anchor = chip.align === 'right' ? chip.ax : chip.x;
  drawChipOn(page, fonts, 'Signed', anchor, chip.y, { align: chip.align, filled: true });
}

/** For a PDF made elsewhere (no saved layout): add a last page that records who signed and when. */
function addSignaturePage(doc, fonts, signer) {
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const top = PAGE.height - MARGIN.top;
  drawCaps(page, fonts, 'Signature', MARGIN.left, top - 6);
  drawChipOn(page, fonts, 'Signed', RIGHT_EDGE, top - 9.5, { align: 'right', filled: true });
  drawText(page, 'Signed', MARGIN.left, top - 30, { font: fonts.semibold, size: 16 });
  page.drawLine({ start: { x: MARGIN.left, y: top - 44 }, end: { x: RIGHT_EDGE, y: top - 44 }, thickness: 0.8, color: COLOR.rule });
  const fields = [['Name', signer.name], ['Title', signer.title || ''], ['Date', signer.when]];
  fields.forEach(([label, value], i) => {
    const y = top - 70 - i * 26;
    drawText(page, label, MARGIN.left + 6, y, { font: fonts.medium, size: 8.5 });
    drawText(page, fitLine(value, fonts.regular, 9, CONTENT_WIDTH - 170), MARGIN.left + 165, y, { font: fonts.regular, size: 9 });
    page.drawLine({ start: { x: MARGIN.left, y: y - 9 }, end: { x: RIGHT_EDGE, y: y - 9 }, thickness: 0.5, color: COLOR.line });
  });
  if (signer.image) {
    const scale = Math.min(200 / signer.image.width, 60 / signer.image.height);
    page.drawImage(signer.image, { x: MARGIN.left + 165, y: top - 70 - 3 * 26 - 60, width: signer.image.width * scale, height: signer.image.height * scale });
  }
}

/**
 * Signs a paper. Returns { bytes, sha256 }; the hash changes because the file changes.
 * Only boxes saved with role 'signer' are filled. Boxes for the importer, the carrier or the consignee stay
 * blank for them to sign by hand. A paper can be signed once; changes need a new version.
 */
export async function signPdf(bytes, { name, title = '', signedAt = new Date(), signatureDataUrl } = {}) {
  if (!bytes || !bytes.length) throw new Error('There is no PDF to sign.');
  if (!name || !String(name).trim()) throw new Error('The signer needs a name.');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const layout = readLayout(doc);
  if (layout?.signed) throw new Error('This paper is already signed. Build a new version to change it.');

  const fonts = await embedFonts(doc);
  const at = parseIsoDay(signedAt) || new Date();
  const signer = {
    name: String(name).trim(),
    title: String(title || '').trim(),
    when: formatDateTime(at),
    day: formatSlashDate(at),
    image: await embedSignature(doc, signatureDataUrl),
  };
  const pages = doc.getPages();
  let written = 0;
  for (const block of layout?.blocks || []) {
    if (block.role !== 'signer' || !pages[block.p]) continue;
    writeSigner(pages[block.p], fonts, block, signer);
    if (block.sig || block.name) written += 1; // a date line alone is not a place for the signature
  }
  for (const chip of layout?.chips || []) {
    if (pages[chip.p]) restamp(pages[chip.p], fonts, chip);
  }
  if (!written) addSignaturePage(doc, fonts, signer);

  writeLayout(doc, { ...(layout || { v: 1, chips: [], blocks: [] }), signed: { name: signer.name, title: signer.title, at: at.toISOString() } });
  doc.setModificationDate(at);
  const out = await doc.save();
  return { bytes: out, sha256: sha256Hex(out) };
}
