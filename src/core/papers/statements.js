// Origin statements: the EU Due Diligence Statement, the US CBP self-certification and the G7/GF note.
// Each one is drawn by a function that takes a paper context, so the export or import pack can draw the
// same pages inside itself, and buildStatement can draw them as a paper of their own.
import { DOC_TYPE_LABELS } from '../types.js';
import { TEMPLATES } from './templates.js';
import { nextRef } from './refs.js';
import {
  COLOR, CONTENT_WIDTH, MARGIN, RIGHT_EDGE,
  addPage, drawCaps, drawCheckedBy, drawChip, drawFooters, drawNotice, drawParagraph, drawRows,
  drawSignatureBlock, drawText, ensureSpace, finishPaper, fitLine, sectionLabel, startPaper, wrap,
} from './layout.js';
import {
  NOT_ON_FILE, countryName, docTitle, findField, firstOf, formatDay, formatSlashDate, growthText, isBelgium,
  isBlank, isEuCountry, isLabGrown, isSampleData, miningCountries, printedLabel, stoneFacts, stonesText,
} from './format.js';

export const STATEMENT_KINDS = ['eu_dds', 'us_cbp_certificate', 'g7_gf_declaration'];

const EVIDENCE_ORDER = [
  'commercial_invoice', 'proforma_invoice', 'packing_list', 'shipping_bill', 'bill_of_entry', 'customs_declaration',
  'air_waybill', 'insurance_certificate', 'lab_report', 'kp_certificate', 'supplier_declaration', 'g7_gf_declaration',
  'supplier_invoice',
];

// Compact rows so a statement fits on one A4 page, like the official one-page template.
const ROWS = { labelWidth: 178, size: 8.2, pad: 3 };

export function houseName(house) {
  return firstOf(house?.legalEntity, house?.name) || 'the house';
}

/**
 * Whose letterhead the statement goes on. The importer signs these statements. On an import the house is
 * the importer, so it is the house letterhead. On an export the house prepares a draft for the consignee.
 */
export function letterheadFor(shipment, house) {
  const forImporter = shipment?.direction !== 'import';
  if (forImporter) {
    const consignee = shipment?.consignee || {};
    return {
      forImporter,
      name: firstOf(consignee.name),
      address: firstOf(consignee.address),
      country: countryName(consignee.country),
      eori: firstOf(consignee.eori),
      vat: firstOf(consignee.vat, consignee.vatNumber),
    };
  }
  return {
    forImporter,
    name: houseName(house),
    address: firstOf(house?.address, house?.city),
    country: countryName(house?.country),
    eori: firstOf(house?.eori),
    vat: firstOf(house?.vat, house?.vatNumber),
  };
}

/** The customs office the goods are declared at, when the destination tells us. */
export function customsOffice(shipment) {
  if (!isBlank(shipment?.customsOffice)) return shipment.customsOffice;
  const destination = firstOf(shipment?.destinationCountry, shipment?.consignee?.country);
  if (isBelgium(destination)) return 'Antwerp Diamond Office (FPS Economy)';
  if (isEuCountry(destination)) return `Customs office of entry, ${countryName(destination)}`;
  return null;
}

function plural(type) {
  if (type === 'bill_of_entry') return 'Bills of entry';
  return `${DOC_TYPE_LABELS[type] || DOC_TYPE_LABELS.other}s`;
}

/** Evidence on file, grouped so 40 grading reports become one line ("Grading reports, 40 on file"). */
export function evidenceSummary(shipment, documents) {
  const docs = documents || [];
  if (!docs.length) {
    // Without the document list, name the papers the shipment record points to.
    const items = [];
    if (shipment?.invoiceNumber) items.push(`Commercial invoice ${shipment.invoiceNumber}`);
    if (shipment?.shippingBillNumber) items.push(`Shipping bill ${shipment.shippingBillNumber}`);
    if (shipment?.hawb) items.push(`Air waybill, HAWB ${shipment.hawb}`);
    return items;
  }
  // Customs papers first, in the order customs reads them, then chats, emails and the rest.
  const rank = (type) => (EVIDENCE_ORDER.includes(type) ? EVIDENCE_ORDER.indexOf(type) : EVIDENCE_ORDER.length);
  const byType = new Map();
  for (const doc of [...docs].sort((a, b) => rank(a.docType) - rank(b.docType))) {
    const type = doc.docType || 'other';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(doc);
  }
  const items = [];
  for (const [type, group] of byType) {
    if (group.length <= 2) group.forEach((doc) => items.push(docTitle(doc)));
    else items.push(`${plural(type)}, ${group.length} on file`);
  }
  return items;
}

function shipmentFacts(shipment, documents) {
  const docs = documents || [];
  return {
    invoiceNumber: firstOf(shipment?.invoiceNumber, findField(docs, 'invoice.number', ['commercial_invoice'])),
    invoiceDate: firstOf(shipment?.invoiceDate, findField(docs, 'invoice.date', ['commercial_invoice'])),
    hawb: firstOf(shipment?.hawb, findField(docs, 'awb.hawb', ['air_waybill'])),
    mawb: firstOf(shipment?.mawb, findField(docs, 'awb.mawb', ['air_waybill'])),
    exporter: shipment?.exporter?.name
      ? [shipment.exporter.name, countryName(shipment.exporter.country)].filter(Boolean).join(', ')
      : null,
  };
}

function addressWithCountry(head) {
  const parts = [head.address];
  if (head.country && !String(head.address || '').toLowerCase().includes(head.country.toLowerCase())) parts.push(head.country);
  const text = parts.filter((part) => !isBlank(part)).join(', ');
  return text || null;
}

/** The top of a statement: the importer's (or the house's) name and address, ref and status on the right. */
function drawLetterhead(ctx, head, { status, house }) {
  const { fonts } = ctx;
  const { page } = ctx;
  const top = ctx.y;
  const width = CONTENT_WIDTH - 180;
  if (head.forImporter) drawChip(ctx, null, RIGHT_EDGE, top - 9.5, { align: 'right', register: false, text: 'Draft for the importer' });
  else drawChip(ctx, status || 'draft', RIGHT_EDGE, top - 9.5, { align: 'right' });

  drawCaps(page, fonts, 'Importer', MARGIN.left, top - 6);
  const name = head.name ? fitLine(head.name, fonts.semibold, 15, width) : 'Importer not on file';
  drawText(page, name, MARGIN.left, top - 26, { font: fonts.semibold, size: 15, color: head.name ? COLOR.ink : COLOR.muted });
  const address = addressWithCountry(head);
  const lines = address ? wrap(address, fonts.regular, 8.4, width).slice(0, 3) : [];
  lines.forEach((line, i) => drawText(page, line, MARGIN.left, top - 40 - i * 11, { font: fonts.regular, size: 8.4, color: COLOR.soft }));

  drawText(page, ctx.ref, RIGHT_EDGE, top - 26, { font: fonts.monoMedium, size: 11, align: 'right' });
  drawCaps(page, fonts, printedLabel(ctx.printedAt), RIGHT_EDGE, top - 38.5, { size: 6.3, align: 'right' });

  const ruleY = Math.min(top - 46, top - 40 - (lines.length - 1) * 11 - 9);
  page.drawLine({ start: { x: MARGIN.left, y: ruleY }, end: { x: RIGHT_EDGE, y: ruleY }, thickness: 0.8, color: COLOR.rule });
  ctx.y = ruleY - 10;
  if (head.forImporter) {
    drawNotice(ctx, `Prepared by ${houseName(house)} for signature by the importer.`);
  }
}

function drawTitleBlock(ctx, { label, title, subtitle }) {
  const { fonts } = ctx;
  ensureSpace(ctx, 60);
  const { page } = ctx;
  drawCaps(page, fonts, label, MARGIN.left, ctx.y - 6);
  let y = ctx.y - 24;
  for (const line of wrap(title, fonts.semibold, 14, CONTENT_WIDTH)) {
    drawText(page, line, MARGIN.left, y, { font: fonts.semibold, size: 14 });
    y -= 17;
  }
  for (const line of subtitle ? wrap(subtitle, fonts.regular, 8.4, CONTENT_WIDTH) : []) {
    drawText(page, line, MARGIN.left, y + 3, { font: fonts.regular, size: 8.4, color: COLOR.soft });
    y -= 11;
  }
  ctx.y = y - 2;
}

/** Bulleted list in two columns, read down the left column first. Used for the evidence on file. */
function drawTwoColumnList(ctx, items, { size = 7.8, max = 12, moreText } = {}) {
  const { fonts } = ctx;
  const shown = items.slice(0, max);
  if (items.length > max) shown.push(moreText ? moreText(items.length - max) : `and ${items.length - max} more`);
  const gap = 18;
  const colWidth = (CONTENT_WIDTH - gap) / 2;
  const lead = size * 1.36;
  const half = Math.ceil(shown.length / 2);
  for (let i = 0; i < half; i++) {
    const pair = [shown[i], shown[half + i]].filter((text) => text !== undefined).map((text) => wrap(text, fonts.regular, size, colWidth - 10));
    const height = Math.max(...pair.map((lines) => lines.length)) * lead + 1.5;
    ensureSpace(ctx, height);
    pair.forEach((lines, col) => {
      const x = MARGIN.left + col * (colWidth + gap);
      drawText(ctx.page, '•', x + 1, ctx.y - size, { font: fonts.regular, size, color: COLOR.muted });
      lines.forEach((line, j) => drawText(ctx.page, line, x + 10, ctx.y - size - j * lead, { font: fonts.regular, size }));
    });
    ctx.y -= height;
  }
  ctx.y -= 2;
}

function drawWordingNote(ctx, text) {
  ctx.y -= 4;
  drawParagraph(ctx, text, { size: 7, color: COLOR.muted, gapAfter: 0 });
}

function drawEuDds(ctx, { shipment, stones, house, status, documents, evidenceNote }) {
  const t = TEMPLATES.eu_dds;
  const head = letterheadFor(shipment, house);
  const facts = shipmentFacts(shipment, documents);
  const natural = stoneFacts(stones, { naturalOnly: true });
  const countries = miningCountries(stones, documents);
  addPage(ctx, 'EU statement');
  drawLetterhead(ctx, head, { status, house });
  drawTitleBlock(ctx, { label: 'EU · Article 3p of Council Regulation (EU) No 833/2014', title: t.title, subtitle: t.scope });

  let scopeText = stonesText(natural.inScopeCount, natural.inScopeCarats);
  if (natural.unknownCarat) scopeText += `. ${natural.unknownCarat} more with no carat on file`;
  drawRows(ctx, [
    { label: t.fields.company, value: head.name },
    { label: t.fields.address, value: addressWithCountry(head) },
    { label: t.fields.eori, value: head.eori },
    { label: t.fields.vat, value: head.vat },
    { label: t.fields.hawb, value: facts.hawb },
    { label: t.fields.shipmentRef, value: [shipment?.ref, facts.invoiceNumber].filter((v) => !isBlank(v)).join(' / ') },
    { label: t.fields.date, value: isBlank(facts.invoiceDate) ? null : formatSlashDate(facts.invoiceDate) },
    { label: 'Customs office', value: customsOffice(shipment) },
    { label: 'Exporter', value: facts.exporter },
    { label: 'Natural stones of 0.50 ct and up', value: scopeText },
    { label: 'Countries of mining (KP)', value: countries.join(', ') },
  ], ROWS);

  if (shipment?.goods?.nature === 'lab-grown') {
    ctx.y -= 8;
    drawNotice(ctx, 'These goods are lab-grown. Lab-grown goods use the Diamond Office G7/GF declaration, not this statement.');
  }
  sectionLabel(ctx, 'Statement', { keepWith: 60 });
  t.paragraphs.forEach((text) => drawParagraph(ctx, text, { size: 8.6, gapAfter: 4 }));

  sectionLabel(ctx, 'Evidence retained', { keepWith: 24 });
  drawTwoColumnList(ctx, evidenceSummary(shipment, documents), { max: 8, moreText: evidenceNote });
  drawParagraph(ctx, t.retention, { size: 7.4, color: COLOR.muted, gapAfter: 0 });

  drawSignatureBlock(ctx, {
    heading: t.signature.heading,
    role: head.forImporter ? 'importer' : 'signer',
    labels: { name: t.signature.name, title: t.signature.position, date: t.signature.date, signature: t.signature.signature },
    stamp: t.signature.stamp,
  });
  if (head.forImporter) drawCheckedBy(ctx, { heading: `Prepared and checked by ${houseName(house)}` });
  drawWordingNote(ctx, t.wordingNote);
}

/** Which CBP sentences apply: loose diamonds, jewelry or unsorted diamonds (HS 7102.10), or both. */
export function cbpSentences(shipment) {
  const t = TEMPLATES.us_cbp_certificate;
  const form = shipment?.goods?.form;
  const hsCodes = (shipment?.goods?.hsCodes || []).map((code) => String(code).replace(/\D/g, ''));
  const unsorted = hsCodes.some((code) => code.startsWith('710210'));
  if (form === 'jewelry') return [t.jewelry];
  if (form === 'mixed' || unsorted) return [t.diamonds, t.jewelry];
  return [t.diamonds];
}

function goodsText(shipment) {
  const goods = shipment?.goods || {};
  if (!isBlank(goods.description)) return goods.description;
  const words = [goods.form, goods.nature].filter((w) => w && w !== 'unknown' && w !== 'mixed');
  return words.length ? `${words.join(' ')} diamonds`.replace(/^./, (c) => c.toUpperCase()) : null;
}

function drawCbp(ctx, { shipment, stones, house, status, documents }) {
  const t = TEMPLATES.us_cbp_certificate;
  const head = letterheadFor(shipment, house);
  const facts = shipmentFacts(shipment, documents);
  const all = stoneFacts(stones);
  const hsCodes = (shipment?.goods?.hsCodes || []).join(', ');
  addPage(ctx, 'US certificate');
  drawLetterhead(ctx, head, { status, house });
  drawTitleBlock(ctx, { label: 'United States · Executive Order 14068 · CBP CSMS # 61912001', title: t.title, subtitle: t.scope });
  drawRows(ctx, [
    { label: 'Importer', value: head.name },
    { label: 'Address', value: addressWithCountry(head) },
    { label: 'Entry number', value: firstOf(shipment?.entryNumber) || 'Added by the importer or its customs broker', muted: isBlank(shipment?.entryNumber) },
    { label: 'Invoice', value: [facts.invoiceNumber, isBlank(facts.invoiceDate) ? null : formatDay(facts.invoiceDate)].filter((v) => !isBlank(v)).join(', ') },
    { label: 'Air waybill', value: [facts.hawb && `HAWB ${facts.hawb}`, facts.mawb && `MAWB ${facts.mawb}`].filter(Boolean).join(', ') },
    { label: 'Goods', value: [goodsText(shipment), hsCodes && `HS ${hsCodes}`].filter(Boolean).join(', ') },
    { label: 'Stones', value: all.count ? stonesText(all.count, all.carats) : null },
    { label: 'Stones of 0.50 ct and up', value: all.count ? stonesText(all.inScopeCount, all.inScopeCarats) : null },
    { label: 'Countries of mining (KP)', value: miningCountries(stones, documents).join(', ') },
    { label: 'Exporter', value: facts.exporter },
  ], ROWS);

  sectionLabel(ctx, 'Certification', { keepWith: 50 });
  cbpSentences(shipment).forEach((sentence) => drawParagraph(ctx, sentence, { size: 9.6, font: ctx.fonts.medium, gapAfter: 6 }));

  drawSignatureBlock(ctx, {
    heading: 'Signed by',
    role: head.forImporter ? 'importer' : 'signer',
    labels: { name: t.signature.name, title: t.signature.title, date: t.signature.date, signature: t.signature.signature },
  });
  if (head.forImporter) drawCheckedBy(ctx, { heading: `Prepared and checked by ${houseName(house)}` });

  sectionLabel(ctx, 'How it is lodged', { keepWith: 40 });
  t.howItIsLodged.forEach((line) => drawParagraph(ctx, `•  ${line}`, { size: 7.8, color: COLOR.soft, gapAfter: 1 }));
  drawWordingNote(ctx, t.wordingNote);
}

function drawG7Note(ctx, { shipment, stones, house, documents }) {
  const t = TEMPLATES.g7_gf_declaration;
  const facts = shipmentFacts(shipment, documents);
  const all = stoneFacts(stones);
  const growth = [...new Set((stones || []).map((s) => s.growth).filter((g) => !isBlank(g)).map(growthText))];
  const labs = [...new Set((stones || []).map((s) => s.lab).filter((l) => !isBlank(l)))];
  const reports = (stones || []).filter((s) => !isBlank(s.reportNumber)).length;
  const importer = letterheadFor(shipment, house);
  addPage(ctx, 'G7 / GF note');
  drawHeaderForNote(ctx, house);
  drawTitleBlock(ctx, { label: 'EU · Lab-grown diamonds', title: t.title, subtitle: t.scope });
  t.paragraphs.forEach((text) => drawParagraph(ctx, text, { size: 8.8, gapAfter: 4 }));
  if (shipment?.goods?.nature && !['lab-grown', 'mixed'].includes(shipment.goods.nature) && !(stones || []).some(isLabGrown)) {
    drawNotice(ctx, 'The records do not show lab-grown goods in this shipment. Check the goods before using this note.');
  }
  sectionLabel(ctx, 'Facts for the template');
  drawRows(ctx, [
    { label: 'Importer', value: importer.name },
    { label: 'Exporter', value: facts.exporter },
    { label: 'Invoice', value: [facts.invoiceNumber, isBlank(facts.invoiceDate) ? null : formatDay(facts.invoiceDate)].filter((v) => !isBlank(v)).join(', ') },
    { label: 'House air waybill (HAWB)', value: facts.hawb },
    { label: 'Master air waybill (MAWB)', value: facts.mawb },
    { label: 'Goods', value: goodsText(shipment) },
    { label: 'Growth method', value: growth.join(', ') },
    { label: 'Stones', value: all.count ? stonesText(all.count, all.carats) : null },
    { label: 'Stones of 0.50 ct and up', value: all.count ? stonesText(all.inScopeCount, all.inScopeCarats) : null },
    { label: 'HS codes', value: (shipment?.goods?.hsCodes || []).join(', ') },
    { label: 'Grading reports', value: reports ? `${reports} on file${labs.length ? `, ${labs.join(', ')}` : ''}` : null },
    { label: 'Customs office', value: customsOffice(shipment) },
  ], ROWS);
  drawCheckedBy(ctx, { heading: `Checked by ${houseName(house)}` });
  drawWordingNote(ctx, t.wordingNote);
}

/** The G7/GF note is the house's own working note, so it carries the house name, not a letterhead. */
function drawHeaderForNote(ctx, house) {
  const { page, fonts } = ctx;
  const top = ctx.y;
  drawChip(ctx, null, RIGHT_EDGE, top - 9.5, { align: 'right', register: false, text: 'Note' });
  drawCaps(page, fonts, 'Prepared for', MARGIN.left, top - 6);
  drawText(page, fitLine(houseName(house), fonts.semibold, 15, CONTENT_WIDTH - 180), MARGIN.left, top - 26, { font: fonts.semibold, size: 15 });
  drawText(page, ctx.ref, RIGHT_EDGE, top - 26, { font: fonts.monoMedium, size: 11, align: 'right' });
  drawCaps(page, fonts, printedLabel(ctx.printedAt), RIGHT_EDGE, top - 38.5, { size: 6.3, align: 'right' });
  page.drawLine({ start: { x: MARGIN.left, y: top - 46 }, end: { x: RIGHT_EDGE, y: top - 46 }, thickness: 0.8, color: COLOR.rule });
  ctx.y = top - 58;
}

/** Draws one statement into an open paper (used by buildStatement and by the packs). */
export function drawStatement(ctx, { kind, ...rest }) {
  if (kind === 'eu_dds') return drawEuDds(ctx, rest);
  if (kind === 'us_cbp_certificate') return drawCbp(ctx, rest);
  if (kind === 'g7_gf_declaration') return drawG7Note(ctx, rest);
  throw new Error(`Unknown statement kind: ${kind}`);
}

/**
 * Builds one statement as its own PDF.
 * Optional extras beyond the contract: documents (for the evidence list), ref, version, printedAt.
 */
export async function buildStatement({ kind, shipment = {}, stones = [], house = {}, status = 'draft', documents = [], ref, version = 1, printedAt = new Date() }) {
  if (!STATEMENT_KINDS.includes(kind)) throw new Error(`Unknown statement kind: ${kind}`);
  const paperRef = ref || nextRef(kind, printedAt, []);
  const ctx = await startPaper({ ref: paperRef, version, printedAt, sample: isSampleData({ house, shipment, documents }) });
  drawStatement(ctx, { kind, shipment, stones, house, status, documents });
  drawFooters(ctx);
  const title = `${paperRef} ${TEMPLATES[kind].title}`;
  return finishPaper(ctx, { title, subject: `${TEMPLATES[kind].title} for ${shipment?.ref || shipment?.invoiceNumber || NOT_ON_FILE}` });
}
