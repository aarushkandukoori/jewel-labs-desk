// The rough side of shipment A: the KP certificate that brought the rough into India and the
// Dubai supplier's invoice for rough lot R-0412. These are what tie a polished stone to its mines.
import {
  newPdf, addPage, paperDate, write, paragraph, rect, line, svg, table, roundStamp, sign, guilloche, markPage, rgb,
  A4, MARGIN, INK, GREY,
} from './kit.js';
import { HOUSE, ROUGH_SUPPLIER, KP, KP_OFFICE, SUPPLIER_INVOICE, dmy, money, carats } from './facts.js';
import { SOW_TEXT, RUSSIA_TEXT } from './invoice.js';

const SLATE = rgb(0.18, 0.3, 0.27);
const MAROON = rgb(0.45, 0.1, 0.16);

export const KP_STATEMENT = 'The rough diamonds in this shipment have been handled in accordance with the provisions of '
  + 'the Kimberley Process Certification Scheme for rough diamonds.';

/** A plain, made-up KP certificate. It does not copy any participant's real certificate design. */
export async function buildKpCertificate() {
  const { pdf, fonts } = await newPdf({
    title: `KP certificate ${KP.number} (SAMPLE)`, author: KP_OFFICE.name, date: paperDate(KP.issued, '12:00:00', '+04:00'),
  });
  const page = addPage(pdf);
  rect(page, 26, 26, A4.width - 52, 784, { stroke: SLATE, lineWidth: 1.6 });
  rect(page, 31, 31, A4.width - 62, 774, { stroke: SLATE, lineWidth: 0.4 });
  guilloche(page, { x: 32, y: 32, w: A4.width - 64, h: 772, color: rgb(0.9, 0.93, 0.91), waves: 70, seed: 1234 });

  write(page, 'KIMBERLEY PROCESS CERTIFICATE', 0, 74, { font: fonts.serifBold, size: 20, color: SLATE, align: 'center', width: A4.width });
  write(page, 'Certificate for the export of rough diamonds', 0, 92, { font: fonts.serifItalic, size: 10, align: 'center', width: A4.width });
  write(page, 'SAMPLE CERTIFICATE FOR THE JEWEL LABS DEMO. NOT VALID FOR ANY SHIPMENT.', 0, 108,
    { font: fonts.sansBold, size: 7.5, color: rgb(0.6, 0.12, 0.12), align: 'center', width: A4.width });
  write(page, `Issued by ${KP_OFFICE.name}, ${KP_OFFICE.city}`, 0, 122, { font: fonts.sans, size: 8, color: GREY, align: 'center', width: A4.width });

  // Numbered fields: number, label, value. Party rows start their value on the line under the label.
  const x = 52;
  const valueX = x + 190;
  let y = 150;
  const row = (no, label, value, { bold = false } = {}) => {
    write(page, `${no}. ${label}`, x, y, { font: fonts.sans, size: 9 });
    write(page, value, valueX, y, { font: bold ? fonts.monoBold : fonts.serifBold, size: bold ? 11 : 10.5 });
    line(page, x, y + 7, A4.width - x, y + 7, { width: 0.3, color: GREY });
    y += 24;
  };
  const partyRow = (no, label, lines) => {
    write(page, `${no}. ${label}`, x, y, { font: fonts.sans, size: 9 });
    lines.forEach((text, i) => write(page, text, valueX, y + 13 + i * 12.5, { font: i === 0 ? fonts.serifBold : fonts.serif, size: 10 }));
    y += 13 + lines.length * 12.5;
    line(page, x, y - 5, A4.width - x, y - 5, { width: 0.3, color: GREY });
    y += 14;
  };
  row(1, 'KP certificate number', KP.number, { bold: true });
  row(2, 'Exporting country', KP.exportingCountry);
  row(3, 'Importing country', KP.importingCountry);
  partyRow(4, 'Exporter', [ROUGH_SUPPLIER.name, ...ROUGH_SUPPLIER.lines]);
  partyRow(5, 'Importer', [HOUSE.name, ...HOUSE.lines, `IEC ${HOUSE.iec}`]);
  row(6, 'Countries of mining', KP.countriesOfMining.join(', '));
  row(7, 'Country of origin', 'Mixed origin');
  row(8, 'HS classification', `${KP.hsCode} (rough, unworked)`);
  row(9, 'Number of parcels', String(KP.parcels));
  row(10, 'Carat weight', carats(KP.carats));
  row(11, 'Value (USD)', money(KP.value));
  row(12, 'Date of issue', dmy(KP.issued));
  row(13, 'Date of expiry', dmy(KP.expires));
  row(14, 'Seal number', 'SEAL-SAMPLE-5531');

  y += 4;
  rect(page, x, y, A4.width - x * 2, 44, { fill: rgb(1, 1, 1), opacity: 0.9, stroke: SLATE, lineWidth: 0.6 });
  paragraph(page, KP_STATEMENT, x + 10, y + 17, { font: fonts.serifItalic, size: 9.5, width: A4.width - x * 2 - 20 });

  y += 74;
  write(page, 'Authorised officer', A4.width - 220, y, { font: fonts.sans, size: 8.5, color: GREY });
  roundStamp(page, { cx: A4.width - 210, cy: y + 44, r: 32, top: 'SAMPLE KP OFFICE', bottom: 'DUBAI * U.A.E.', middle: ['SAMPLE'],
    color: rgb(0.12, 0.38, 0.28), rotate: 10 });
  sign(page, A4.width - 175, y + 50, { seed: 1234, width: 95, height: 17 });
  line(page, A4.width - 220, y + 82, A4.width - 60, y + 82, { width: 0.5, color: GREY });
  write(page, `${KP_OFFICE.name}`, A4.width - 220, y + 94, { font: fonts.sans, size: 8 });
  write(page, `Issued in Dubai on ${dmy(KP.issued)}`, x, y + 94, { font: fonts.sans, size: 8 });
  markPage(page, fonts);
  return pdf.save();
}

/** The Dubai supplier's invoice for rough lot R-0412, sent on memo with the KP certificate. */
export async function buildSupplierInvoice() {
  const inv = SUPPLIER_INVOICE;
  const { pdf, fonts } = await newPdf({
    title: `Tax invoice ${inv.number} (SAMPLE)`, author: ROUGH_SUPPLIER.name, date: paperDate(inv.date, '14:10:00', '+04:00'),
  });
  const page = addPage(pdf);

  // Letterhead band.
  rect(page, 0, 0, A4.width, 86, { fill: MAROON });
  svg(page, 'M0 0 H30 V30 H0 Z M0 30 L30 0 M8 0 V8 H0', MARGIN, 26, { stroke: rgb(1, 1, 1), lineWidth: 1.4 });
  write(page, ROUGH_SUPPLIER.name.toUpperCase(), MARGIN + 44, 42, { font: fonts.sansBold, size: 15, color: rgb(1, 1, 1) });
  write(page, `Rough diamond trading   |   ${ROUGH_SUPPLIER.address}`, MARGIN + 44, 56, { font: fonts.sans, size: 8, color: rgb(1, 0.9, 0.9) });
  write(page, `Tel ${ROUGH_SUPPLIER.phone}   |   ${ROUGH_SUPPLIER.email}   |   Licence ${ROUGH_SUPPLIER.licence}`, MARGIN + 44, 68,
    { font: fonts.sans, size: 8, color: rgb(1, 0.9, 0.9) });
  write(page, 'TAX INVOICE', MARGIN, 118, { font: fonts.sansBold, size: 16, color: MAROON });
  write(page, 'Export of rough diamonds, zero-rated', MARGIN, 132, { font: fonts.sans, size: 8, color: GREY });

  // Exporter and consignee on the left, references on the right (same baselines).
  const lh = 12;
  const top = 160;
  const left = [
    ['Exporter', true], [ROUGH_SUPPLIER.name, 'bold'], ...ROUGH_SUPPLIER.lines.map((t) => [t]), [`Licence ${ROUGH_SUPPLIER.licence}`],
    ['Consignee', true], [HOUSE.name, 'bold'], ...HOUSE.lines.map((t) => [t]), [`IEC ${HOUSE.iec}`],
  ];
  left.forEach(([text, style], i) => {
    const font = style === true ? fonts.sansBold : style === 'bold' ? fonts.sansBold : fonts.sans;
    write(page, text, MARGIN, top + i * lh, { font, size: style === true ? 7.5 : 8.5, color: style === true ? GREY : INK });
  });
  const refs = [
    ['Invoice No.', inv.number],
    ['Invoice Date', dmy(inv.date)],
    ['Payment Terms', '60 days from invoice date'],
    ['KP Certificate No.', KP.number],
    ['KP Date', dmy(KP.issued)],
    ['Terms of Delivery', 'CIF Mumbai'],
    ['Countries of Mining', KP.countriesOfMining.join(', ')],
    ['Country of Origin', 'Mixed origin'],
    ['Country of Destination', 'India'],
    ['Sent on Memo', dmy(inv.memoDate)],
  ];
  refs.forEach(([label, value], i) => {
    write(page, label, 300, top + i * lh, { font: fonts.sans, size: 8 });
    write(page, `: ${value}`, 400, top + i * lh, { font: fonts.sansBold, size: 8 });
  });

  let y = top + left.length * lh + 14;
  write(page, `Description of goods : Natural rough diamonds   |   HS Code : ${inv.hsCode}`, MARGIN, y, { font: fonts.sansBold, size: 8.5 });
  y += 8;
  const columns = [
    { title: 'Lot', width: 50, align: 'center' },
    { title: 'Description', width: 200 },
    { title: 'Pcs', width: 40, align: 'right' },
    { title: 'Carats', width: 60, align: 'right' },
    { title: 'Price US$/ct', width: 80, align: 'right' },
    { title: 'Amount US$', width: 93.28, align: 'right' },
  ];
  const rows = [
    [inv.lot, 'Natural rough diamonds, gem quality, sawable', String(inv.pieces), carats(inv.carats), money(inv.rate), money(inv.value)],
    ['', 'VAT 0% (zero-rated export)', '', '', '', '0.00'],
    ['', 'Total', String(inv.pieces), carats(inv.carats), '', money(inv.value)],
  ];
  y = table(page, { x: MARGIN, y, columns, rows, font: fonts.sans, bold: fonts.sansBold, size: 8, rowHeight: 17,
    headerFill: rgb(0.96, 0.92, 0.92), boldRows: [2] });
  y += 14;
  write(page, `Total invoice value : USD ${money(inv.value)} (CIF Mumbai)`, MARGIN, y, { font: fonts.sansBold, size: 9 });
  y += 13;
  write(page, 'Amount in words : US Dollars Twenty-Two Thousand Four Hundred Only', MARGIN, y, { font: fonts.sans, size: 8.5 });
  y += 13;
  write(page, `Goods sent on memo on ${dmy(inv.memoDate)} with the KP certificate, invoiced on approval.`, MARGIN, y, { font: fonts.sans, size: 8.5 });

  y += 22;
  write(page, 'Declarations', MARGIN, y, { font: fonts.sansBold, size: 8.5, color: MAROON });
  y += 13;
  for (const text of [SOW_TEXT, RUSSIA_TEXT, KP_STATEMENT]) {
    y = paragraph(page, text, MARGIN, y, { font: fonts.serif, size: 9, width: A4.width - MARGIN * 2, lineHeight: 11 }) + 5;
  }

  y += 20;
  write(page, `For ${ROUGH_SUPPLIER.name}`, A4.width - MARGIN - 200, y, { font: fonts.sansBold, size: 8.5 });
  roundStamp(page, { cx: A4.width - MARGIN - 160, cy: y + 42, r: 30, top: 'SAMPLE ROUGH TRADING', bottom: 'DUBAI * U.A.E.',
    middle: ['DMCC'], color: rgb(0.5, 0.12, 0.2), rotate: 16 });
  sign(page, A4.width - MARGIN - 120, y + 46, { seed: 315, width: 88, height: 16 });
  write(page, 'Authorised signatory', A4.width - MARGIN - 110, y + 80, { font: fonts.sans, size: 8 });
  write(page, 'Bank: Sample Gulf Bank (SAMPLE), Dubai. Account details on request.', MARGIN, y + 80, { font: fonts.sans, size: 7.5, color: GREY });
  markPage(page, fonts);
  return pdf.save();
}
