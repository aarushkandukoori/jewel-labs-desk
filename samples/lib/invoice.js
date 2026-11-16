// The house's commercial invoices (shipments A, B and C) and the buyer's purchase order for A.
// Layout follows the usual Indian export invoice: exporter and consignee on the left, "Label : value"
// references on the right, then the stone table, totals, declarations and the signed stamp.
import {
  newPdf, addPage, paperDate, write, paragraph, rect, line, svg, table, roundStamp, sign, markPage, rgb,
  MARGIN, A4, INK, GREY, RULE,
} from './kit.js';
import { HOUSE, LAB, SHIPMENTS, lineAmount, totals, dmy, money, carats } from './facts.js';

const NAVY = rgb(0.09, 0.17, 0.36);

// The WDC System of Warranties wording every natural-diamond invoice carries.
export const SOW_TEXT = 'The diamonds herein invoiced have been purchased from legitimate sources not involved in funding '
  + 'conflict, in compliance with United Nations Security Council Resolutions and corresponding national laws. The seller '
  + 'hereby guarantees that these diamonds are conflict free and confirms adherence to the WDC SoW Guidelines.';
export const RUSSIA_TEXT = 'We hereby declare that the diamonds herein invoiced have not been mined, processed or produced '
  + 'in the Russian Federation and are not of Russian origin.';
export const US_TEXT = 'We hereby declare that the diamonds herein invoiced were not mined, extracted, produced or '
  + 'manufactured wholly or in part in the Russian Federation, notwithstanding whether such diamonds have been '
  + 'substantially transformed into other products outside of the Russian Federation.';
export const LAB_GROWN_TEXT = 'We hereby declare that the goods herein invoiced are laboratory-grown diamonds produced by '
  + 'CVD and are not natural diamonds. Laboratory-grown diamonds are not covered by the Kimberley Process.';
export const TRUE_TEXT = 'We declare that this invoice shows the actual price of the goods described and that all '
  + 'particulars are true and correct.';

/** The declarations printed on one shipment's invoice, in order. */
export function invoiceDeclarations(shipment) {
  if (shipment.nature === 'lab-grown') return [LAB_GROWN_TEXT, TRUE_TEXT];
  if (shipment.regime === 'US') return [SOW_TEXT, US_TEXT, TRUE_TEXT];
  return [SOW_TEXT, RUSSIA_TEXT, TRUE_TEXT];
}

/** Kavya Gems letterhead: a small cut-diamond mark, the name and the contact line. */
export function houseLetterhead(page, fonts, y = 40) {
  const mark = 'M0 7 L7 0 L25 0 L32 7 L16 30 Z M0 7 H32 M7 0 L11 7 L16 0 L21 7 L25 0 M11 7 L16 30 M21 7 L16 30';
  svg(page, mark, MARGIN, y, { stroke: NAVY, lineWidth: 1.1 });
  write(page, HOUSE.name.toUpperCase(), MARGIN + 44, y + 15, { font: fonts.serifBold, size: 18, color: NAVY });
  write(page, 'Manufacturers and exporters of natural and laboratory-grown diamonds', MARGIN + 44, y + 26,
    { font: fonts.serifItalic, size: 8.5, color: GREY });
  write(page, HOUSE.address, MARGIN + 44, y + 37, { font: fonts.serif, size: 8.5 });
  write(page, `Tel ${HOUSE.phone}   |   ${HOUSE.email}   |   IEC ${HOUSE.iec}`, MARGIN + 44, y + 48, { font: fonts.serif, size: 8.5 });
  line(page, MARGIN, y + 56, A4.width - MARGIN, y + 56, { color: NAVY, width: 1.4 });
  line(page, MARGIN, y + 58.5, A4.width - MARGIN, y + 58.5, { color: NAVY, width: 0.4 });
}

/** Amount in words, the way bank papers want it: "US Dollars Thirty-Seven Thousand ... and Cents Fifty Only". */
export function amountInWords(value) {
  const dollars = Math.floor(value);
  const cents = Math.round((value - dollars) * 100);
  const words = `US Dollars ${numberWords(dollars)}`;
  return cents ? `${words} and Cents ${numberWords(cents)} Only` : `${words} Only`;
}

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function numberWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 1000000) return `${numberWords(Math.floor(n / 1000))} Thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return `${numberWords(Math.floor(n / 1000000))} Million${n % 1000000 ? ` ${numberWords(n % 1000000)}` : ''}`;
}

/** "Label : value" lines, label in regular type and value in bold, one under the other. */
function pairs(page, fonts, x, y, items, { labelWidth = 104, size = 8, lineHeight = 11.6 } = {}) {
  items.forEach(([label, value], i) => {
    const baseline = y + i * lineHeight;
    write(page, label, x, baseline, { font: fonts.sans, size });
    write(page, `: ${value}`, x + labelWidth, baseline, { font: fonts.sansBold, size });
  });
}

/** One commercial invoice as PDF bytes. id: 'A', 'B' or 'C'. */
export async function buildInvoice(id) {
  const s = SHIPMENTS[id];
  const sum = totals(s);
  const { pdf, fonts } = await newPdf({
    title: `Commercial invoice ${s.invoice} (SAMPLE)`, author: HOUSE.name, date: paperDate(s.invoiceDate, '16:40:00'),
  });
  const page = addPage(pdf);
  houseLetterhead(page, fonts);

  write(page, 'COMMERCIAL INVOICE', 0, 122, { font: fonts.serifBold, size: 13, align: 'center', width: A4.width });
  write(page, 'Original for buyer', A4.width - MARGIN - 80, 122, { font: fonts.sansItalic, size: 7, color: GREY, align: 'right', width: 80 });

  // Parties on the left, references on the right, in two bordered boxes.
  const top = 132;
  const half = (A4.width - MARGIN * 2) / 2;
  const gridHeight = 158;
  rect(page, MARGIN, top, half, gridHeight, { stroke: RULE, lineWidth: 0.6 });
  rect(page, MARGIN + half, top, half, gridHeight, { stroke: RULE, lineWidth: 0.6 });
  // Left and right lines share baselines, so a line of text reads "left value <tab> right value".
  const lh = 11.6;
  const y0 = top + 13;
  const left = MARGIN + 6;
  line(page, MARGIN, y0 + 5 * lh + 4.5, MARGIN + half, y0 + 5 * lh + 4.5, { width: 0.5 });
  write(page, 'Exporter', left, y0, { font: fonts.sansBold, size: 7.5, color: GREY });
  [HOUSE.name, ...HOUSE.lines, `IEC ${HOUSE.iec}`, `Tel ${HOUSE.phone}`].forEach((text, i) => {
    write(page, text, left, y0 + (i + 1) * lh, { font: i === 0 ? fonts.sansBold : fonts.sans, size: 8.5 });
  });
  const buyer = s.buyer;
  const buyerLines = [buyer.name, ...buyer.lines, buyer.eori ? `EORI ${buyer.eori}` : `Email ${buyer.email}`, `Tel ${buyer.phone}`];
  write(page, 'Consignee', left, y0 + 6 * lh, { font: fonts.sansBold, size: 7.5, color: GREY });
  buyerLines.forEach((text, i) => {
    write(page, text, left, y0 + (i + 7) * lh, { font: i === 0 ? fonts.sansBold : fonts.sans, size: 8.5 });
  });

  const legs = s.awb.legs.map((leg) => leg.flight).join(' / ');
  const refs = [
    ['Invoice No.', s.invoice],
    ['Invoice Date', dmy(s.invoiceDate)],
    ...(s.po ? [["Buyer's PO No.", s.po.number], ['PO Date', dmy(s.po.date)]] : []),
    ['Country of Origin of Goods', 'India'],
    ['Country of Final Destination', s.destination],
    ['Pre-carriage by', 'Road, Surat to Mumbai'],
    ['Flight No.', legs],
    ['Port of Loading', s.portOfLoading],
    ['Port of Discharge', s.portOfDischarge],
    ['Final Destination', s.finalDestination],
    ['Terms of Delivery', `${s.incoterm} ${s.incotermPlace} (Incoterms 2020)`],
    ['Payment Terms', s.payment],
  ];
  pairs(page, fonts, MARGIN + half + 6, y0, refs, { labelWidth: 112, size: 8, lineHeight: lh });

  // The goods.
  let y = top + gridHeight + 16;
  write(page, `Description of goods : ${s.goods}`, MARGIN, y, { font: fonts.sansBold, size: 8.5 });
  write(page, `ITC HS Code : ${s.hsCode}`, A4.width - MARGIN - 150, y, { font: fonts.sansBold, size: 8.5, align: 'right', width: 150 });
  y += 8;
  const columns = [
    { title: 'Sr.', width: 22, align: 'center' },
    { title: 'Description', width: 120 },
    { title: 'Shape', width: 66 },
    { title: 'Pcs', width: 26, align: 'right' },
    { title: 'Carat', width: 38, align: 'right' },
    { title: 'Colour', width: 38, align: 'center' },
    { title: 'Clarity', width: 40, align: 'center' },
    { title: 'Report No.', width: 58, align: 'center' },
    { title: 'Rate\nUS$/ct', width: 54, align: 'right' },
    { title: 'Amount\nUS$', width: 61.28, align: 'right' },
  ];
  const rows = s.stones.map((stone) => [
    String(stone.line),
    stone.description || (s.nature === 'natural' ? 'Natural polished diamond' : 'Lab-grown polished diamond'),
    stone.shape,
    String(stone.pieces || 1),
    carats(stone.carat),
    stone.color,
    stone.clarity,
    stone.report || '-',
    money(stone.rate),
    money(lineAmount(stone)),
  ]);
  rows.push(['', 'Total', '', String(sum.pieces), carats(sum.carats), '', '', '', '', money(sum.value)]);
  y = table(page, { x: MARGIN, y, columns, rows, font: fonts.sans, bold: fonts.sansBold, size: 7.6, rowHeight: 15,
    headerHeight: 20, boldRows: [rows.length - 1] });

  y += 13;
  write(page, `Total invoice value : USD ${money(sum.value)} (${s.incoterm} ${s.incotermPlace})`, MARGIN, y, { font: fonts.sansBold, size: 8.5 });
  write(page, `Lab : ${LAB.short} = ${LAB.name}`, A4.width - MARGIN - 230, y, { font: fonts.sans, size: 7.5, color: GREY, align: 'right', width: 230 });
  y += 12;
  y = paragraph(page, `Amount in words : ${amountInWords(sum.value)}`, MARGIN, y, { font: fonts.sans, size: 8, width: A4.width - MARGIN * 2 });
  y += 2;
  write(page, `Packages : 1 sealed parcel   |   Net weight : ${carats(sum.carats)} ct   |   Gross weight : ${s.awb.grossKg.toFixed(2)} kg`,
    MARGIN, y, { font: fonts.sans, size: 8 });

  // Declarations, numbered, in a box.
  y += 12;
  const declarations = invoiceDeclarations(s);
  const boxTop = y;
  y += 12;
  write(page, 'Declarations', MARGIN + 6, y, { font: fonts.sansBold, size: 7.5, color: GREY });
  y += 11;
  declarations.forEach((text, i) => {
    write(page, `${i + 1}.`, MARGIN + 6, y, { font: fonts.serif, size: 8.5 });
    y = paragraph(page, text, MARGIN + 18, y, { font: fonts.serif, size: 8.5, width: A4.width - MARGIN * 2 - 26, lineHeight: 10.4 }) + 3;
  });
  rect(page, MARGIN, boxTop, A4.width - MARGIN * 2, y - boxTop + 2, { stroke: RULE, lineWidth: 0.5 });

  // Bank box on the left, signature with the house stamp on the right.
  y += 18;
  const bankTop = y - 9;
  rect(page, MARGIN, bankTop, 250, 66, { stroke: RULE, lineWidth: 0.5 });
  write(page, 'Bank details', MARGIN + 6, bankTop + 12, { font: fonts.sansBold, size: 7.5, color: GREY });
  ['Sample Merchant Bank (SAMPLE), Ring Road branch, Surat', 'Account details are shared on request.',
    `Marks and numbers : ${s.fileRef.replace(/-/g, '/')} / 1 of 1`].forEach((text, i) => {
    write(page, text, MARGIN + 6, bankTop + 26 + i * 12, { font: fonts.sans, size: 8 });
  });
  const signX = A4.width - MARGIN - 175;
  write(page, `For ${HOUSE.name}`, signX, y, { font: fonts.sansBold, size: 8.5 });
  roundStamp(page, { cx: signX + 34, cy: y + 36, r: 29, top: 'KAVYA GEMS LLP', bottom: 'SURAT * INDIA', middle: ['SAMPLE'], rotate: -14 });
  sign(page, signX + 66, y + 40, { seed: 4101 + id.charCodeAt(0), width: 90, height: 16 });
  write(page, 'Authorised signatory', signX + 70, y + 76, { font: fonts.sans, size: 8 });
  write(page, 'E. & O.E.   Subject to Surat jurisdiction.', MARGIN, y + 76, { font: fonts.sans, size: 7, color: GREY });
  markPage(page, fonts);
  return pdf.save();
}

/** Lumen Diamant's purchase order LDB-7781, attached to their email. */
export async function buildPurchaseOrder() {
  const s = SHIPMENTS.A;
  const buyer = s.buyer;
  const { pdf, fonts } = await newPdf({
    title: `Purchase order ${s.po.number} (SAMPLE)`, author: buyer.name, date: paperDate(s.po.date, '10:05:00', '+01:00'),
  });
  const page = addPage(pdf);
  const teal = rgb(0.05, 0.36, 0.42);

  // Letterhead: a lens mark and the buyer's name, contacts on the right.
  svg(page, 'M0 14 A14 14 0 1 0 28 14 A14 14 0 1 0 0 14 Z M7 14 A7 7 0 1 0 21 14 A7 7 0 1 0 7 14 Z', MARGIN, 40, { stroke: teal, lineWidth: 1.6 });
  write(page, buyer.name, MARGIN + 38, 52, { font: fonts.sansBold, size: 15, color: teal });
  write(page, 'Polished diamonds  |  Antwerp', MARGIN + 38, 64, { font: fonts.sans, size: 8, color: GREY });
  [buyer.address, `${buyer.phone}  |  ${buyer.email}`, `EORI ${buyer.eori}`].forEach((text, i) => {
    write(page, text, A4.width - MARGIN - 260, 44 + i * 10, { font: fonts.sans, size: 7.5, align: 'right', width: 260 });
  });
  line(page, MARGIN, 80, A4.width - MARGIN, 80, { color: teal, width: 1 });
  write(page, 'PURCHASE ORDER', MARGIN, 108, { font: fonts.sansBold, size: 16, color: INK });

  // Supplier on the left, order details on the right.
  write(page, 'Supplier', MARGIN, 132, { font: fonts.sansBold, size: 7.5, color: GREY });
  [HOUSE.name, ...HOUSE.lines, `IEC ${HOUSE.iec}`].forEach((text, i) => {
    write(page, text, MARGIN, 143 + i * 11, { font: i === 0 ? fonts.sansBold : fonts.sans, size: 8.5 });
  });
  // Same baselines as the order details on the right.
  write(page, 'Deliver to', MARGIN, 187, { font: fonts.sansBold, size: 7.5, color: GREY });
  [buyer.name, ...buyer.lines].forEach((text, i) => {
    write(page, text, MARGIN, 198 + i * 11, { font: i === 0 ? fonts.sansBold : fonts.sans, size: 8.5 });
  });
  pairs(page, fonts, 320, 143, [
    ['PO number', s.po.number],
    ['PO date', dmy(s.po.date)],
    ['Your offer', s.invoice],
    ['Incoterm', `${s.incoterm} ${s.incotermPlace}`],
    ['Payment', s.payment],
    ['Ship by', dmy(s.awb.date)],
  ], { labelWidth: 62, size: 8, lineHeight: 11 });

  let y = 250;
  write(page, `Please supply the following ${s.goods.toLowerCase()}:`, MARGIN, y, { font: fonts.sans, size: 8.5 });
  y += 8;
  const columns = [
    { title: '#', width: 22, align: 'center' },
    { title: 'Report No.', width: 70, align: 'center' },
    { title: 'Lab', width: 36, align: 'center' },
    { title: 'Shape', width: 90 },
    { title: 'Carat', width: 46, align: 'right' },
    { title: 'Colour', width: 44, align: 'center' },
    { title: 'Clarity', width: 46, align: 'center' },
    { title: 'Price US$/ct', width: 78, align: 'right' },
    { title: 'Amount US$', width: 91.28, align: 'right' },
  ];
  const sum = totals(s);
  const rows = s.stones.map((stone) => [
    String(stone.line), stone.report || 'No report', stone.report ? LAB.short : '-', stone.shape, carats(stone.carat),
    stone.color, stone.clarity, money(stone.rate), money(lineAmount(stone)),
  ]);
  rows.push(['', '', '', 'Total', carats(sum.carats), '', '', '', money(sum.value)]);
  y = table(page, { x: MARGIN, y, columns, rows, font: fonts.sans, bold: fonts.sansBold, size: 8, rowHeight: 16,
    headerHeight: 18, headerFill: rgb(0.9, 0.95, 0.95), boldRows: [rows.length - 1] });

  y += 22;
  write(page, 'Documents required with the parcel', MARGIN, y, { font: fonts.sansBold, size: 9 });
  const documents = [
    'Commercial invoice and packing list, stone by stone, with report numbers.',
    'Grading reports for every stone of 0.50 ct and up.',
    'Signed EU Due Diligence Statement on Diamond Origin, with the countries of mining of every stone.',
    'KP certificate details of the rough the stones were cut from.',
    'Air waybill and insurance certificate.',
  ];
  documents.forEach((text, i) => {
    y += 13;
    write(page, `${i + 1}.  ${text}`, MARGIN + 6, y, { font: fonts.sans, size: 8.5 });
  });
  y += 22;
  y = paragraph(page, 'Since 1 January 2026 our broker cannot release natural polished diamonds of 0.50 ct and up in the EU '
    + 'without the signed statement. Please send it with the parcel.', MARGIN, y, { font: fonts.sans, size: 8.5, width: A4.width - MARGIN * 2 });

  y += 34;
  write(page, `For ${buyer.name}`, MARGIN, y, { font: fonts.sansBold, size: 8.5 });
  sign(page, MARGIN + 8, y + 30, { seed: 7781, width: 80, height: 15 });
  write(page, 'Buying desk', MARGIN, y + 48, { font: fonts.sans, size: 8 });
  markPage(page, fonts);
  return pdf.save();
}
