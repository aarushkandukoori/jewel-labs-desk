// The fictional SAMPLE papers of the demo, drawn as real PDFs (with demo/mini-pdf.js) so the agents-
// reading view shows true pages. Each layout records where every field's value was printed, so the
// highlight boxes sit exactly on the text. Every company, person and number here is made up.
import { makePdf, pageBuilder, textWidth } from './mini-pdf.js';

const GREY = [0.42, 0.45, 0.5];
const LIGHT = [0.94, 0.95, 0.96];

/** The strip across the top of every sample page. */
function sampleBanner(p) {
  p.rect(0, 0, p.width, 18, { fill: [0.97, 0.93, 0.8] });
  p.text(36, 12.5, 'SAMPLE DOCUMENT  -  fictional company and numbers  -  made for the Jewel Labs demo', { size: 7, color: [0.45, 0.35, 0.1] });
}

function hr(p, y, x1 = 36, x2 = p.width - 36, width = 0.6) {
  p.line(x1, y, x2, y, { width, color: [0.55, 0.57, 0.6] });
}

function money(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A table with hairlines. cols: [{ title, x, w, align }]. rows: arrays of cell text. Returns the y under it. */
function table(p, y, cols, rows, { size = 8, rowH = 17, onCell } = {}) {
  const left = cols[0].x - 4;
  const right = cols[cols.length - 1].x + cols[cols.length - 1].w + 4;
  p.rect(left, y, right - left, rowH, { fill: LIGHT });
  for (const c of cols) p.text(c.align === 'right' ? c.x + c.w - textWidth(c.title, 'B', size - 0.5) : c.x, y + 11.5, c.title, { size: size - 0.5, font: 'B', color: [0.25, 0.27, 0.3] });
  let rowY = y + rowH;
  rows.forEach((row, r) => {
    row.forEach((cell, i) => {
      const c = cols[i];
      const text = String(cell ?? '');
      const x = c.align === 'right' ? c.x + c.w - textWidth(text, 'R', size) : c.x;
      if (onCell && onCell(r, i, x, rowY + 11.5, text, size)) return;
      p.text(x, rowY + 11.5, text, { size });
    });
    rowY += rowH;
    p.line(left, rowY, right, rowY, { width: 0.35, color: [0.75, 0.77, 0.8] });
  });
  p.rect(left, y, right - left, rowY - y, { stroke: [0.55, 0.57, 0.6], width: 0.6 });
  return rowY;
}

function finish(p, title, lines = []) {
  return { bytes: makePdf([{ ops: p.ops }], { title }), fields: p.fields, lines, pages: 1, mime: 'application/pdf' };
}

// ---------------------------------------------------------------------------------------------

/** A commercial invoice. s: the shipment data (see sample.js). */
export function invoicePdf(s) {
  const p = pageBuilder();
  sampleBanner(p);
  p.value('exporter.name', 36, 52, s.exporter.name, { size: 13, font: 'B' });
  p.value('exporter.address', 36, 67, s.exporter.address, { size: 8 });
  p.text(36, 79, `${s.exporter.city}, ${s.exporter.countryName}   -   ${s.exporter.taxId}`, { size: 8, color: GREY });
  p.text(398, 52, 'COMMERCIAL INVOICE', { size: 13, font: 'B' });
  p.labelled('invoice.number', 398, 70, 'Invoice No.', s.invoiceNumber, { size: 9, labelWidth: 62, font: 'B' });
  p.labelled('invoice.date', 398, 83, 'Date', s.invoiceDate, { size: 9, labelWidth: 62 });
  hr(p, 94);

  p.text(36, 110, 'CONSIGNEE', { size: 7, font: 'B', color: GREY });
  p.value('consignee.name', 36, 123, s.consignee.name, { size: 9.5, font: 'B' });
  p.value('consignee.address', 36, 135, s.consignee.address, { size: 8 });
  p.value('consignee.country', 36, 146, s.consignee.countryName, { size: 8 });
  p.text(318, 110, 'SHIPMENT', { size: 7, font: 'B', color: GREY });
  p.labelled('goods.destinationCountry', 318, 123, 'Final destination', s.consignee.countryName, { size: 8.5, labelWidth: 92 });
  p.labelled('goods.countryOfOrigin', 318, 135, 'Country of origin', s.originText, { size: 8.5, labelWidth: 92 });
  p.labelled('payment.terms', 318, 147, 'Terms', s.terms, { size: 8.5, labelWidth: 92 });
  p.labelled('goods.hsCode', 318, 159, 'HS code', s.hsCode, { size: 8.5, labelWidth: 92 });
  hr(p, 170);

  p.labelled('goods.description', 36, 186, 'Description of goods', s.description, { size: 8.5, labelWidth: 104 });
  p.labelled('goods.nature', 36, 198, 'Natural or lab-grown', s.natureText, { size: 8.5, labelWidth: 104 });

  const cols = [
    { title: 'Sr', x: 40, w: 14 }, { title: 'Shape', x: 60, w: 44 }, { title: 'Report No.', x: 108, w: 70 }, { title: 'Lab', x: 182, w: 26 },
    { title: 'Carat', x: 214, w: 36, align: 'right' }, { title: 'Colour', x: 262, w: 34 }, { title: 'Clarity', x: 302, w: 36 },
    { title: 'Rate US$/ct', x: 350, w: 64, align: 'right' }, { title: 'Amount US$', x: 430, w: 120, align: 'right' },
  ];
  const lines = [];
  const rows = s.stones.map((st, i) => {
    lines.push({ lineNo: i + 1, description: `${st.shape} polished diamond`, reportNumber: st.report || null, lab: st.report ? st.lab : null, shape: st.shape, carat: st.carat, color: st.color, clarity: st.clarity, pieces: 1, rate: st.rate, amount: Math.round(st.carat * st.rate * 100) / 100, growth: s.nature, quote: null });
    return [i + 1, st.shape, st.report || '-', st.report ? st.lab : '-', st.carat.toFixed(2), st.color, st.clarity, money(st.rate), money(st.carat * st.rate)];
  });
  let y = table(p, 212, cols, rows);
  y += 16;
  p.text(300, y, 'Total pieces', { size: 8.5, color: GREY });
  p.value('goods.totalPieces', 380, y, String(s.stones.length), { size: 9, font: 'B' });
  p.text(300, y + 13, 'Total carats', { size: 8.5, color: GREY });
  p.value('goods.totalCarats', 380, y + 13, s.totalCarats.toFixed(2), { size: 9, font: 'B' });
  p.text(300, y + 26, 'Invoice value', { size: 8.5, color: GREY });
  p.value('goods.currency', 380, y + 26, 'USD', { size: 9, font: 'B' });
  p.value('goods.totalValue', 404, y + 26, money(s.totalValue), { size: 9, font: 'B' });
  y += 52;
  hr(p, y);
  p.text(36, y + 16, 'DECLARATION', { size: 7, font: 'B', color: GREY });
  const decl = 'The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict, in compliance with United Nations resolutions. The seller guarantees that these diamonds are conflict free (System of Warranties).';
  const words = decl.split(' ');
  let line = '';
  let ly = y + 29;
  const firstLine = ly;
  for (const w of words) {
    if (textWidth(`${line} ${w}`, 'R', 8) > 520) { p.text(36, ly, line.trim(), { size: 8 }); ly += 11; line = ''; }
    line += ` ${w}`;
  }
  p.text(36, ly, line.trim(), { size: 8 });
  p.fields.push({ key: 'declaration.text', value: decl, quote: decl.slice(0, 60), page: 1, confidence: 0.95, box: [32 / p.width, (firstLine - 9) / p.height, 560 / p.width, (ly + 3) / p.height].map((n) => Math.round(n * 10000) / 10000) });
  p.text(390, ly + 46, `For ${s.exporter.shortName}`, { size: 8.5 });
  p.line(390, ly + 78, 556, ly + 78, { width: 0.5 });
  p.text(390, ly + 89, 'Authorised signatory', { size: 7.5, color: GREY });
  return finish(p, `Invoice ${s.invoiceNumber}`, lines);
}

/** A packing list for the same parcel. */
export function packingListPdf(s) {
  const p = pageBuilder();
  sampleBanner(p);
  p.value('exporter.name', 36, 52, s.exporter.name, { size: 13, font: 'B' });
  p.text(36, 66, `${s.exporter.address}, ${s.exporter.city}`, { size: 8, color: GREY });
  p.text(430, 52, 'PACKING LIST', { size: 13, font: 'B' });
  p.labelled('doc.number', 400, 70, 'List No.', s.packingNumber, { size: 9, labelWidth: 56 });
  p.labelled('invoice.number', 400, 83, 'Invoice', s.invoiceNumber, { size: 9, labelWidth: 56, font: 'B' });
  p.labelled('doc.date', 400, 96, 'Date', s.invoiceDate, { size: 9, labelWidth: 56 });
  hr(p, 106);
  p.labelled('consignee.name', 36, 122, 'Consignee', s.consignee.name, { size: 9, labelWidth: 64, font: 'B' });
  p.text(100, 134, `${s.consignee.address}, ${s.consignee.countryName}`, { size: 8, color: GREY });
  p.labelled('goods.grossWeight', 36, 152, 'Gross weight', s.grossWeight, { size: 8.5, labelWidth: 64 });
  p.labelled('goods.netWeight', 220, 152, 'Net weight', s.netWeight, { size: 8.5, labelWidth: 58 });
  p.text(390, 152, 'Packages: 1 sealed parcel', { size: 8.5 });

  const cols = [
    { title: 'Packet', x: 40, w: 44 }, { title: 'Report No.', x: 92, w: 72 }, { title: 'Lab', x: 170, w: 26 }, { title: 'Shape', x: 204, w: 44 },
    { title: 'Carat', x: 254, w: 40, align: 'right' }, { title: 'Colour', x: 308, w: 36 }, { title: 'Clarity', x: 350, w: 40 }, { title: 'Measurements (mm)', x: 400, w: 150 },
  ];
  const lines = [];
  const rows = s.stones.map((st, i) => {
    const ct = st.listCarat ?? st.carat;
    lines.push({ lineNo: i + 1, description: `Packet P${String(i + 1).padStart(2, '0')}`, reportNumber: st.report || null, lab: st.report ? st.lab : null, shape: st.shape, carat: ct, color: st.color, clarity: st.clarity, pieces: 1, rate: null, amount: null, growth: s.nature, quote: null });
    return [`P${String(i + 1).padStart(2, '0')}`, st.report || '-', st.report ? st.lab : '-', st.shape, ct.toFixed(2), st.color, st.clarity, st.mm || ''];
  });
  let y = table(p, 166, cols, rows, {
    onCell: (r, c, x, cy, text, size) => {
      if (c === 4 && r === s.mismatchIndex) { p.value('lab.carat', x, cy, text, { size, confidence: 0.94 }); return true; }
      return false;
    },
  });
  y += 18;
  p.text(254, y, 'Total', { size: 8.5, color: GREY });
  p.value('goods.totalPieces', 300, y, `${s.stones.length} pcs`, { size: 9, font: 'B' });
  p.value('goods.totalCarats', 360, y, `${s.stones.reduce((n, st) => n + (st.listCarat ?? st.carat), 0).toFixed(2)} ct`, { size: 9, font: 'B' });
  p.text(36, y + 40, 'Packed and sealed in the presence of the exporter. Seal No. NS-SEAL-0441 (sample).', { size: 8, color: GREY });
  return finish(p, `Packing list ${s.packingNumber}`, lines);
}

/** An export declaration with its Let Export Order (a generic sample form, not any customs authority's). */
export function shippingBillPdf(s) {
  const p = pageBuilder();
  sampleBanner(p);
  p.text(36, 50, 'SHIPPING BILL FOR EXPORT', { size: 14, font: 'B' });
  p.text(36, 63, 'Export declaration with Let Export Order  -  exporter copy  -  SAMPLE form', { size: 8, color: GREY });
  p.labelled('shippingBill.number', 36, 90, 'SB No.', s.sbNumber, { size: 10, labelWidth: 48, font: 'B' });
  p.labelled('shippingBill.date', 196, 90, 'SB date', s.sbDate, { size: 10, labelWidth: 46 });
  p.labelled('leo.date', 380, 90, 'LEO date', s.leoDate, { size: 10, labelWidth: 52, font: 'B' });
  p.text(36, 104, 'Let Export Order granted. Goods examined and sealed. Port of loading below.', { size: 8, color: GREY });
  hr(p, 114);
  p.text(36, 130, 'EXPORTER', { size: 7, font: 'B', color: GREY });
  p.value('exporter.name', 36, 143, s.exporter.name, { size: 9, font: 'B' });
  p.text(36, 155, `${s.exporter.address}, ${s.exporter.city}`, { size: 8 });
  p.text(36, 166, s.exporter.taxId, { size: 8, color: GREY });
  p.text(318, 130, 'CONSIGNEE', { size: 7, font: 'B', color: GREY });
  p.value('consignee.name', 318, 143, s.consignee.name, { size: 9, font: 'B' });
  p.text(318, 155, s.consignee.address, { size: 8 });
  p.text(318, 166, s.consignee.countryName, { size: 8 });
  hr(p, 178);
  const rowsY = 196;
  const kv = [
    ['goods.portOfLoading', 'Port of loading', s.portOfLoading],
    ['goods.portOfDischarge', 'Port of discharge', s.portOfDischarge],
    ['goods.destinationCountry', 'Country of destination', s.consignee.countryName],
    ['invoice.number', 'Invoice No.', s.invoiceNumber],
    ['goods.hsCode', 'Tariff item (HS)', s.hsCodeLong],
    ['goods.totalCarats', 'Quantity (carats)', s.totalCarats.toFixed(2)],
    ['goods.totalValue', 'FOB value (USD)', money(s.totalValue)],
    ['goods.grossWeight', 'Gross weight', s.grossWeight],
  ];
  kv.forEach(([key, label, value], i) => {
    const y = rowsY + i * 16;
    p.labelled(key, 36, y, label, value, { size: 9, labelWidth: 130, font: key === 'invoice.number' ? 'B' : 'R' });
    p.line(36, y + 5, 360, y + 5, { width: 0.3, color: [0.82, 0.83, 0.86] });
  });
  p.rect(390, 190, 166, 118, { stroke: [0.3, 0.3, 0.3] });
  p.text(400, 206, 'LET EXPORT ORDER', { size: 8, font: 'B' });
  p.text(400, 222, 'The goods may be exported.', { size: 8 });
  p.text(400, 240, `Date: ${s.leoDate}`, { size: 8 });
  p.text(400, 256, 'Officer: SAMPLE-0000', { size: 8, color: GREY });
  p.text(400, 296, '(stamp, sample)', { size: 7, color: GREY });
  hr(p, 340);
  p.text(36, 356, 'Nature of goods: polished natural diamonds, loose, set in a single sealed parcel. Not opened for examination.', { size: 8 });
  return finish(p, `Shipping bill ${s.sbNumber}`);
}

/** An air waybill from a fictional carrier. */
export function airWaybillPdf(s) {
  const p = pageBuilder();
  sampleBanner(p);
  p.value('carrier.name', 36, 50, s.carrier, { size: 13, font: 'B' });
  p.text(36, 63, 'Air waybill  -  not negotiable  -  SAMPLE', { size: 8, color: GREY });
  p.labelled('awb.mawb', 360, 50, 'MAWB', s.mawb, { size: 11, labelWidth: 44, font: 'B' });
  p.labelled('awb.hawb', 360, 66, 'HAWB', s.hawb, { size: 9.5, labelWidth: 44 });
  hr(p, 78);
  p.rect(36, 88, 254, 74, { stroke: [0.4, 0.4, 0.4] });
  p.text(44, 100, "SHIPPER'S NAME AND ADDRESS", { size: 6.5, font: 'B', color: GREY });
  p.value('exporter.name', 44, 114, s.exporter.name, { size: 9, font: 'B' });
  p.text(44, 126, s.exporter.address, { size: 7.5 });
  p.text(44, 137, `${s.exporter.city}, ${s.exporter.countryName}`, { size: 7.5 });
  p.rect(302, 88, 254, 74, { stroke: [0.4, 0.4, 0.4] });
  p.text(310, 100, "CONSIGNEE'S NAME AND ADDRESS", { size: 6.5, font: 'B', color: GREY });
  p.value('consignee.name', 310, 114, s.consignee.name, { size: 9, font: 'B' });
  p.text(310, 126, s.consignee.address, { size: 7.5 });
  p.text(310, 137, s.consignee.countryName, { size: 7.5 });
  p.labelled('awb.route', 36, 184, 'Routing', s.route, { size: 9, labelWidth: 70 });
  p.labelled('awb.flight', 36, 200, 'Flight / date', s.flight, { size: 9, labelWidth: 70, font: 'B' });
  p.labelled('awb.date', 300, 200, 'Executed on', s.awbDate, { size: 9, labelWidth: 66 });
  const cols = [{ title: 'Pieces', x: 40, w: 40 }, { title: 'Gross weight', x: 90, w: 70 }, { title: 'Nature and quantity of goods', x: 170, w: 250 }, { title: 'Declared value', x: 440, w: 110, align: 'right' }];
  let y = table(p, 216, cols, [['1', '', 'Valuable cargo: polished diamonds, 1 sealed parcel', `USD ${money(s.totalValue)}`]], {
    onCell: (r, c, x, cy, text, size) => {
      if (c === 1) { p.value('goods.grossWeight', x, cy, s.grossWeight, { size }); return true; }
      return false;
    },
  });
  p.text(36, y + 22, 'Handling: valuable cargo. Escort from airport to the consignee by the carrier’s secure service.', { size: 8, color: GREY });
  p.text(36, y + 60, 'Signature of issuing carrier or its agent: Northline Air Cargo (sample)', { size: 8 });
  return finish(p, `Air waybill ${s.mawb}`);
}

/** The rough supplier's invoice, with the KP certificate and countries of mining. */
export function roughInvoicePdf(r) {
  const p = pageBuilder();
  sampleBanner(p);
  p.value('supplier.name', 36, 52, r.supplier.name, { size: 13, font: 'B' });
  p.text(36, 66, `${r.supplier.address}`, { size: 8, color: GREY });
  p.value('supplier.country', 36, 77, r.supplier.countryName, { size: 8 });
  p.text(400, 52, 'TAX INVOICE', { size: 13, font: 'B' });
  p.labelled('invoice.number', 400, 70, 'Invoice No.', r.invoiceNumber, { size: 9, labelWidth: 62, font: 'B' });
  p.labelled('invoice.date', 400, 83, 'Date', r.date, { size: 9, labelWidth: 62 });
  hr(p, 94);
  p.text(36, 110, 'BILL TO', { size: 7, font: 'B', color: GREY });
  p.value('buyer.name', 36, 123, r.buyer.name, { size: 9.5, font: 'B' });
  p.text(36, 135, `${r.buyer.address}, ${r.buyer.city}, ${r.buyer.countryName}`, { size: 8 });
  const cols = [{ title: 'Lot', x: 40, w: 50 }, { title: 'Description', x: 96, w: 220 }, { title: 'Carats', x: 330, w: 60, align: 'right' }, { title: 'US$/ct', x: 400, w: 60, align: 'right' }, { title: 'Amount US$', x: 470, w: 80, align: 'right' }];
  const y = table(p, 150, cols, [[r.lot, 'Rough diamonds, natural, unworked (HS 7102.31)', '', money(r.rate), money(r.value)]], {
    onCell: (row, c, x, cy, text, size) => {
      if (c === 2) { p.value('kp.carats', 330 + 60 - textWidth(r.carats.toFixed(2), 'R', size), cy, r.carats.toFixed(2), { size }); return true; }
      if (c === 1) { p.value('goods.description', x, cy, text, { size }); return true; }
      return false;
    },
  });
  p.labelled('goods.nature', 36, y + 20, 'Goods', 'Natural', { size: 9, labelWidth: 130 });
  p.labelled('kp.value', 300, y + 20, 'Value', `USD ${money(r.value)}`, { size: 9, labelWidth: 50 });
  p.rect(36, y + 36, 520, 78, { fill: [0.97, 0.98, 0.99], stroke: [0.6, 0.62, 0.66] });
  p.text(46, y + 52, 'KIMBERLEY PROCESS', { size: 7, font: 'B', color: GREY });
  p.labelled('kp.certificateNumber', 46, y + 68, 'KP certificate', r.kp, { size: 9.5, labelWidth: 110, font: 'B' });
  p.labelled('kp.countriesOfMining', 46, y + 84, 'Countries of mining', r.mining, { size: 9.5, labelWidth: 110, font: 'B' });
  p.labelled('kp.exportingCountry', 46, y + 100, 'Exported from', r.supplier.countryName, { size: 9, labelWidth: 110 });
  p.text(36, y + 136, 'The rough diamonds in this invoice were imported under the KP certificate above and are conflict free (System of Warranties).', { size: 8 });
  return finish(p, `Rough invoice ${r.invoiceNumber}`);
}

/**
 * The factory register for one rough lot, as a phone photo (drawn on a canvas, browser only).
 * Returns { bytes (PNG), mime, fields, lines }. Field boxes are in the photo's coordinates.
 */
export async function factoryPhoto(f) {
  const W = 1000;
  const H = 1250;
  const canvas = makeCanvas(W, H);
  const g = canvas ? canvas.getContext('2d') : null; // no canvas (Node tests): boxes are estimated, no picture
  if (g) {
    // A desk under warm light, and the paper with a soft shadow.
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#5b4a3a');
    bg.addColorStop(1, '#3a2f26');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
  }
  const paper = { x: 70, y: 60, w: 860, h: 1130 };
  if (g) {
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = 40;
    g.shadowOffsetY = 18;
    g.fillStyle = '#f4f1ea';
    g.fillRect(paper.x, paper.y, paper.w, paper.h);
    g.restore();
    // Faint ruled lines like a register book, and the red margin.
    g.strokeStyle = 'rgba(80, 110, 160, 0.18)';
    g.lineWidth = 1.2;
    for (let y = paper.y + 120; y < paper.y + paper.h - 30; y += 44) { g.beginPath(); g.moveTo(paper.x + 30, y); g.lineTo(paper.x + paper.w - 30, y); g.stroke(); }
    g.strokeStyle = 'rgba(190, 70, 70, 0.3)';
    g.beginPath(); g.moveTo(paper.x + 120, paper.y + 20); g.lineTo(paper.x + 120, paper.y + paper.h - 20); g.stroke();
    g.fillStyle = 'rgba(200,150,40,0.9)';
    g.font = '600 15px Arial, sans-serif';
    g.fillText('SAMPLE  -  fictional factory register for the Jewel Labs demo', paper.x + 30, paper.y + 34);
  }

  const fields = [];
  const ink = '#1d2a44';
  function write(text, x, y, { size = 26, bold = false, color = ink, key, value, confidence = 0.9 } = {}) {
    let w = String(text).length * size * 0.5;
    if (g) {
      g.font = `${bold ? '600 ' : ''}${size}px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive`;
      g.fillStyle = color;
      g.fillText(text, x, y);
      w = g.measureText(text).width;
    }
    if (key) {
      fields.push({ key, value: String(value ?? text), quote: String(text), page: 1, confidence, box: [(x - 5) / W, (y - size * 0.92) / H, (x + w + 5) / W, (y + size * 0.32) / H].map((n) => Math.round(n * 10000) / 10000) });
    }
  }
  write('Factory register - assortment', paper.x + 150, paper.y + 92, { size: 32, bold: true });
  write(f.house, paper.x + 150, paper.y + 150, { size: 24, key: 'exporter.name', value: f.houseName });
  write('Rough lot', paper.x + 150, paper.y + 196, { size: 24 });
  write(f.lot, paper.x + 300, paper.y + 196, { size: 26, bold: true, key: 'doc.number' });
  write('Date', paper.x + 520, paper.y + 196, { size: 24 });
  write(f.date, paper.x + 600, paper.y + 196, { size: 24, key: 'doc.date' });
  write('Rough wt', paper.x + 150, paper.y + 240, { size: 24 });
  write(`${f.roughCarats.toFixed(2)} ct`, paper.x + 300, paper.y + 240, { size: 24, key: 'goods.totalCarats', value: f.roughCarats.toFixed(2) });
  write('Report', paper.x + 150, paper.y + 306, { size: 22, color: '#555' });
  write('Shape', paper.x + 420, paper.y + 306, { size: 22, color: '#555' });
  write('Polished wt', paper.x + 590, paper.y + 306, { size: 22, color: '#555' });
  const lines = [];
  f.stones.forEach((st, i) => {
    const y = paper.y + 350 + i * 44;
    write(String(i + 1), paper.x + 60, y, { size: 22, color: '#666' });
    write(st.report || '(no report)', paper.x + 150, y, { size: 24 });
    write(st.shape, paper.x + 420, y, { size: 24 });
    const ct = (st.factoryCarat ?? st.carat).toFixed(2);
    if (i === f.mismatchIndex) write(ct, paper.x + 590, y, { size: 24, key: 'lab.carat', value: ct, confidence: 0.68 });
    else write(ct, paper.x + 590, y, { size: 24 });
    lines.push({ lineNo: i + 1, description: `Polished from lot ${f.lot}`, reportNumber: st.report || null, lab: st.report ? st.lab : null, shape: st.shape, carat: Number(ct), color: null, clarity: null, pieces: 1, rate: null, amount: null, growth: 'natural', quote: null });
  });
  const totalY = paper.y + 350 + f.stones.length * 44 + 30;
  write(`Total polished ${f.stones.reduce((n, st) => n + (st.factoryCarat ?? st.carat), 0).toFixed(2)} ct from ${f.roughCarats.toFixed(2)} ct rough`, paper.x + 150, totalY, { size: 24 });
  write('Checked - M. Desai (sample)', paper.x + 520, totalY + 90, { size: 24, color: '#2d3d6b' });

  if (!g) return { bytes: new Uint8Array(), mime: 'image/jpeg', fields, lines, pages: 1 };
  // A little lens vignette, like a phone camera.
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.8);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 }) : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', fields, lines, pages: 1 };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return null;
}

