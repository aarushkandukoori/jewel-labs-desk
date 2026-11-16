// The papers the demo's Paperwork agent builds: the export pack (handover sheets, the envelope
// summary, the stone list, the evidence index) and the origin statements. Light pages with hairline
// tables, like the real packs. The statement sentences are the official wording the desktop app uses
// (src/core/papers/templates.js); test/unit/renderer.test.js checks they match.
import { makePdf, pageBuilder, textWidth } from './mini-pdf.js';

export const EU_DDS_PARAGRAPHS = [
  'I, the undersigned, hereby declare that the non-industrial, natural polished diamonds in this shipment were not mined, extracted, produced, or manufactured wholly or in part in the Russian Federation, notwithstanding whether such diamonds have been substantially transformed into other products outside of the Russian Federation.',
  'I confirm that reasonable steps have been taken to verify the declared origin and to avoid aggregation of diamonds of unknown origin with traceable goods.',
  'I further confirm that these efforts and internal controls conform to the requirements and principles of the Due Diligence on Diamond Origin (as referred to in Questions 24 and 25 of the FAQ “Restrictions on diamonds”).',
];
export const US_CBP_DIAMONDS = 'I certify that the non-industrial diamonds in this shipment were not mined, extracted, produced, or manufactured wholly or in part in the Russian Federation, notwithstanding whether such diamonds have been substantially transformed into other products outside of the Russian Federation.';

const GREY = [0.42, 0.45, 0.5];
const MID = [0.6, 0.62, 0.66];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function printed(date) {
  const d = new Date(date);
  return `PRINTED ${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Wraps text to a width; returns the y under the last line. */
function para(p, x, y, text, { size = 9, width = 520, lead = 13, color, font = 'R' } = {}) {
  let line = '';
  for (const w of String(text).split(' ')) {
    if (line && textWidth(`${line} ${w}`, font, size) > width) {
      p.text(x, y, line, { size, color, font });
      y += lead;
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) p.text(x, y, line, { size, color, font });
  return y + lead;
}

function section(p, y, title) {
  p.text(48, y, title.toUpperCase(), { size: 7, font: 'B', color: GREY });
  return y + 8;
}

/** Key/value rows with hairlines, like the walkthrough's shipment table. */
function kvRows(p, y, rows) {
  for (const [k, v] of rows) {
    p.line(48, y, 547, y, { width: 0.35, color: [0.8, 0.81, 0.84] });
    p.text(54, y + 15, k, { size: 9.5 });
    p.text(260, y + 15, String(v ?? '-'), { size: 9.5 });
    y += 22;
  }
  p.line(48, y, 547, y, { width: 0.35, color: [0.8, 0.81, 0.84] });
  return y + 14;
}

function header(p, { ref, date, kicker, title, sub, version }) {
  p.text(48, 46, kicker.toUpperCase(), { size: 7, font: 'B', color: GREY });
  p.text(48, 70, title, { size: 17, font: 'B' });
  if (sub) p.text(48, 86, sub, { size: 9.5 });
  const refText = version > 1 ? `${ref} v${version}` : ref;
  p.text(547 - textWidth(refText, 'M', 12) - 2, 72, refText, { size: 12, font: 'M' });
  const pr = printed(date);
  p.text(547 - textWidth(pr, 'R', 7), 86, pr, { size: 7, color: GREY });
  p.line(48, 96, 547, 96, { width: 1, color: [0.1, 0.1, 0.1] });
}

function footer(p, text, pageNo, pages) {
  p.text(48, 812, `${text}  |  Page ${pageNo} of ${pages}`, { size: 7, color: GREY });
}

function signatureBlock(p, y, signer) {
  if (!signer) {
    p.rect(48, y, 499, 74, { stroke: MID });
    p.text(58, y + 16, 'SIGNED BY', { size: 7, font: 'B', color: GREY });
    p.text(58, y + 36, 'Name ______________________   Position ______________________', { size: 9 });
    p.text(58, y + 56, 'Date ______________________   Signature ______________________', { size: 9 });
    return y + 90;
  }
  p.rect(48, y, 499, 74, { stroke: [0.1, 0.45, 0.25], width: 1 });
  p.text(58, y + 16, 'SIGNED', { size: 7, font: 'B', color: [0.1, 0.45, 0.25] });
  p.text(58, y + 36, `${signer.name}${signer.title ? `, ${signer.title}` : ''}`, { size: 11, font: 'B' });
  p.text(58, y + 54, `Signed in the Jewel Labs app on ${new Date(signer.at).toUTCString().replace(' GMT', ' UTC')}`, { size: 8.5 });
  p.text(58, y + 66, 'The unsigned version is kept; this version is locked by its SHA-256 fingerprint.', { size: 7.5, color: GREY });
  return y + 90;
}

/**
 * The export pack for a shipment. w: { house, shipment, docs, stones, checks, ref, version, status, date, signer, originalsHash }.
 * Returns { bytes, pages, contents }.
 */
export function exportPackPdf(w) {
  const { shipment: s, house } = w;
  const order = ['commercial_invoice', 'packing_list', 'shipping_bill', 'air_waybill', 'supplier_invoice', 'factory_record', 'kp_certificate', 'lab_report'];
  const docs = w.docs.filter((d) => d.kind !== 'chat').slice().sort((a, b) => order.indexOf(a.docType) - order.indexOf(b.docType));
  const pages = [];
  const total = 4;
  const statusText = { ready_to_sign: 'READY TO SIGN', signed: 'SIGNED', sent: 'SIGNED AND SENT', held_for_review: 'HELD FOR REVIEW' }[w.status] || 'DRAFT';

  // 1. Shipment handover: the neutral parcel cover and the three signatures.
  let p = pageBuilder();
  header(p, { ref: w.ref, date: w.date, kicker: 'Shipment handover', title: 'Shipment handover', sub: `${s.ref}  -  one sealed parcel`, version: w.version });
  let y = section(p, 124, 'Parcel');
  y = kvRows(p, y, [['From', `${house.legalName}, ${house.city}`], ['To', `${s.consignee.name}, ${s.consignee.countryName}`], ['Carrier', s.carrier], ['Air waybill', `MAWB ${s.mawb}  /  HAWB ${s.hawb}`], ['Pieces', '1 sealed parcel']]);
  y += 6;
  ['Shipper', 'Carrier', 'Consignee'].forEach((who, i) => {
    const x = 48 + i * 170;
    p.rect(x, y, 159, 112, { stroke: [0.15, 0.15, 0.15], width: 0.9 });
    p.text(x + 9, y + 16, who.toUpperCase(), { size: 7, font: 'B', color: GREY });
    ['Name', 'Signature', 'Date and time'].forEach((label, j) => {
      p.text(x + 9, y + 34 + j * 28, label, { size: 7.5, color: GREY });
      p.line(x + 9, y + 48 + j * 28, x + 150, y + 48 + j * 28, { width: 0.4, color: MID });
    });
  });
  y += 132;
  p.line(48, y, 547, y, { width: 1, color: [0.1, 0.1, 0.1] });
  p.text(48, y + 16, 'Neutral cover for the outside of the parcel: no contents or values. The papers go in the document envelope (next page).', { size: 8.5 });
  p.rect(48, y + 34, 499, 150, { stroke: MID });
  p.text(64, y + 62, 'TO', { size: 7, font: 'B', color: GREY });
  p.text(64, y + 82, s.consignee.name, { size: 14, font: 'B' });
  p.text(64, y + 98, s.consignee.address, { size: 10 });
  p.text(64, y + 112, s.consignee.countryName, { size: 10 });
  p.text(64, y + 146, `Air waybill ${s.mawb}`, { size: 10, font: 'M' });
  footer(p, `${w.ref}  |  ${s.ref}  |  Shipment handover`, 1, total);
  pages.push(p);

  // 2. Inside the document envelope: the shipment, the papers in the order customs reads them, the checks.
  p = pageBuilder();
  header(p, { ref: w.ref, date: w.date, kicker: 'Inside the document envelope', title: s.ref, sub: `${s.exporter.shortName} to ${s.consignee.name}`, version: w.version });
  y = section(p, 118, 'Shipment');
  y = kvRows(p, y, [['Company', house.legalName], ['Invoice', s.invoiceNumber], ['Route', `${s.exporter.countryName} to ${s.consignee.countryName}`], ['Invoice date', s.invoiceDate], ['Shipping bill', `${s.sbNumber}, Let Export Order ${s.leoDate}`], ['House air waybill (HAWB)', s.hawb]]);
  y = section(p, y + 6, 'Papers in this envelope, in the order customs reads them');
  docs.forEach((d, i) => {
    p.text(54, y + 14, String(i + 1), { size: 9.5 });
    p.text(80, y + 14, d.title, { size: 9.5 });
    p.text(80, y + 26, d.fileName, { size: 7.5, color: GREY });
    y += 32;
    p.line(48, y, 547, y, { width: 0.35, color: [0.8, 0.81, 0.84] });
  });
  y = section(p, y + 18, 'Checks');
  const passed = w.checks.filter((c) => c.severity === 'pass').length;
  p.line(48, y, 547, y, { width: 0.35, color: [0.8, 0.81, 0.84] });
  p.text(54, y + 15, 'Status', { size: 9.5 });
  p.rect(258, y + 4, textWidth(statusText, 'B', 8.5) + 14, 15, { stroke: [0.1, 0.1, 0.1], width: 0.8 });
  p.text(265, y + 15, statusText, { size: 8.5, font: 'B' });
  y = kvRows(p, y + 22, [['Consistent', `${passed} of ${w.checks.length} checks`], ['Not on file', 'Nothing required is missing.'], ['Statement', w.statementRef ? `${w.statementLabel} ${w.statementRef}` : 'Not needed for this route']]);
  y = section(p, y + 4, 'Paper fingerprint');
  p.text(54, y + 15, 'SHA-256 of the originals', { size: 9 });
  p.text(260, y + 15, w.originalsHash.slice(0, 40), { size: 8, font: 'M' });
  p.text(260, y + 26, w.originalsHash.slice(40), { size: 8, font: 'M' });
  p.line(48, y + 40, 547, y + 40, { width: 1, color: [0.1, 0.1, 0.1] });
  para(p, 48, y + 56, 'Prepared supporting papers only. Not a customs declaration, shipping label or certificate: the exporter and its broker lodge the declaration, and the carrier issues the air waybill.', { size: 8, width: 499, lead: 11 });
  footer(p, `${w.ref}  |  ${s.ref}  |  Envelope`, 2, total);
  pages.push(p);

  // 3. The stones, each with the papers that name it.
  p = pageBuilder();
  header(p, { ref: w.ref, date: w.date, kicker: 'Stone list', title: 'Every stone in the parcel', sub: `${w.stones.length} stones, ${w.stones.reduce((n, st) => n + st.carat, 0).toFixed(2)} ct, natural`, version: w.version });
  y = 118;
  const cols = [['Report', 54], ['Lab', 140], ['Shape', 174], ['Carat', 222], ['Col.', 262], ['Cla.', 292], ['Mined in', 330], ['Papers', 470]];
  p.rect(48, y, 499, 18, { fill: [0.94, 0.95, 0.96] });
  cols.forEach(([t, x]) => p.text(x, y + 12, t, { size: 7.5, font: 'B' }));
  y += 18;
  for (const st of w.stones) {
    const row = [st.reportNumber || '-', st.lab || '-', st.shape, st.carat.toFixed(2), st.color, st.clarity, (st.kp?.countries || []).join(', ') || '-', String((st.sources || []).length)];
    row.forEach((v, i) => p.text(cols[i][1], y + 13, v, { size: 8.5, font: i === 0 ? 'M' : 'R' }));
    y += 19;
    p.line(48, y, 547, y, { width: 0.35, color: [0.8, 0.81, 0.84] });
  }
  para(p, 48, y + 24, 'Stones of 0.50 ct and up carry their grading report number. The countries of mining come from the rough supplier’s Kimberley Process certificate, traced through the factory register.', { size: 8.5, width: 499, lead: 12 });
  footer(p, `${w.ref}  |  ${s.ref}  |  Stone list`, 3, total);
  pages.push(p);

  // 4. Evidence index: where each value on these papers was read.
  p = pageBuilder();
  header(p, { ref: w.ref, date: w.date, kicker: 'Evidence index', title: 'Where every value came from', sub: 'Each reference above was read from the page cited here.', version: w.version });
  y = 118;
  const keys = ['invoice.number', 'invoice.date', 'consignee.name', 'goods.totalCarats', 'goods.totalValue', 'shippingBill.number', 'leo.date', 'awb.mawb', 'awb.hawb', 'kp.certificateNumber', 'kp.countriesOfMining'];
  const labels = { 'invoice.number': 'Invoice number', 'invoice.date': 'Invoice date', 'consignee.name': 'Consignee', 'goods.totalCarats': 'Carats', 'goods.totalValue': 'Value', 'shippingBill.number': 'Shipping bill', 'leo.date': 'Let Export Order', 'awb.mawb': 'Master air waybill', 'awb.hawb': 'House air waybill', 'kp.certificateNumber': 'KP certificate', 'kp.countriesOfMining': 'Countries of mining' };
  for (const key of keys) {
    const doc = docs.find((d) => (d.fields || []).some((f) => f.key === key));
    const field = doc?.fields.find((f) => f.key === key);
    if (!field) continue;
    p.text(54, y + 13, labels[key], { size: 9 });
    p.text(200, y + 13, String(field.value).slice(0, 38), { size: 9 });
    p.text(400, y + 13, `${doc.fileName.slice(0, 26)}, p${field.page || 1}`, { size: 8, color: GREY });
    y += 20;
    p.line(48, y, 547, y, { width: 0.35, color: [0.8, 0.81, 0.84] });
  }
  y = section(p, y + 22, 'Signature');
  signatureBlock(p, y + 4, w.signer);
  para(p, 48, 770, `Compiled by Jewel Labs on ${new Date(w.date).toDateString()} from the originals on file for ${house.name}. The documents are reproduced unchanged; every reference above was read from the page cited.`, { size: 7.5, width: 499, lead: 10, color: GREY });
  footer(p, `${w.ref}  |  ${s.ref}  |  Evidence index`, 4, total);
  pages.push(p);

  const bytes = makePdf(pages.map((pg) => ({ ops: pg.ops })), { title: `${w.ref} export pack` });
  return {
    bytes,
    pages: pages.length,
    contents: [{ title: 'Shipment handover' }, { title: 'Inside the document envelope' }, ...docs.map((d) => ({ title: d.title, docId: d.id })), { title: 'Stone list' }, { title: 'Evidence index' }],
  };
}

/** The EU Due Diligence Statement (draft for signature), or the US CBP self-certification. */
export function statementPdf(w) {
  const { shipment: s, house } = w;
  const p = pageBuilder();
  const eu = w.kind === 'eu_dds';
  header(p, { ref: w.ref, date: w.date, kicker: eu ? 'EU import  -  draft for signature' : 'US import  -  for the importer or its broker', title: eu ? 'Due Diligence Statement of Diamond Origin' : 'US CBP self-certification', sub: `${s.ref}  -  ${s.exporter.shortName} to ${s.consignee.name}`, version: w.version });
  let y = section(p, 120, eu ? 'Importer' : 'Shipment');
  y = kvRows(p, y, eu
    ? [['Importing company name', s.consignee.name], ['Address', `${s.consignee.address}, ${s.consignee.countryName}`], ['EORI number', s.consignee.eori || 'To be added by the importer'], ['HAWB number', s.hawb], ['Shipment reference / Invoice number', s.invoiceNumber], ['Date of declaration', w.signer ? new Date(w.signer.at).toDateString() : 'On signature']]
    : [['Exporter', s.exporter.name], ['Importer', s.consignee.name], ['Invoice', s.invoiceNumber], ['Air waybill', `${s.mawb} / ${s.hawb}`]]);
  y = section(p, y + 4, eu ? 'Declaration' : 'Certification');
  for (const text of eu ? EU_DDS_PARAGRAPHS : [US_CBP_DIAMONDS]) y = para(p, 48, y + 14, text, { size: 9.5, width: 499, lead: 14 }) - 2;
  y = section(p, y + 14, 'Diamonds of 0.50 ct and up in this shipment');
  for (const st of w.stones.filter((x) => x.carat >= 0.5)) {
    p.text(54, y + 13, `${st.lab} ${st.reportNumber}`, { size: 8.5, font: 'M' });
    p.text(200, y + 13, `${st.shape} ${st.carat.toFixed(2)} ct ${st.color} ${st.clarity}`, { size: 8.5 });
    p.text(380, y + 13, `Mined in ${(st.kp?.countries || []).join(', ')}`, { size: 8.5, color: GREY });
    y += 17;
  }
  y = signatureBlock(p, y + 16, w.signer);
  para(p, 48, y + 6, eu ? 'Official wording: European Commission FAQ on restrictions on diamonds (17 Dec 2025), Question 23, and the Diamond Office template (Feb 2026). The importer keeps this statement for 5 years.'
    : 'Certification sentence copied from CBP CSMS # 61912001 (23 August 2024). The importer or its broker uploads it to ACE DIS, DocCode CBP03.', { size: 7.5, width: 499, lead: 10, color: GREY });
  footer(p, `${w.ref}  |  ${s.ref}  |  ${eu ? 'EU statement' : 'US certificate'}`, 1, 1);
  return { bytes: makePdf([{ ops: p.ops }], { title: `${w.ref} ${eu ? 'EU DDS' : 'US CBP'}` }), pages: 1, contents: [{ title: eu ? 'Due Diligence Statement of Diamond Origin' : 'US CBP self-certification' }] };
}
