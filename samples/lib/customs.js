// Export clearance and transport papers: the shipping bill (a fixed-width customs printout from a
// made-up customs station) and the house air waybill from a made-up valuables carrier.
import {
  newPdf, addPage, paperDate, write, rect, line, roundStamp, boxStamp, sign, markPage, rgb,
  A4, MARGIN, INK, GREY, RULE,
} from './kit.js';
import { HOUSE, LOGISTICS, CUSTOMS, BROKER, SHIPMENTS, totals, dmy, shortDate, money, carats } from './facts.js';

// ---------- shipping bill ----------

const MONO_SIZE = 8;
const COL = MONO_SIZE * 0.6; // Courier letters are 0.6 em wide
const ROW = 11;

/** One shipping bill (A or B) as PDF bytes. */
export async function buildShippingBill(id) {
  const s = SHIPMENTS[id];
  const sb = s.shippingBill;
  const sum = totals(s);
  const { pdf, fonts } = await newPdf({
    title: `Shipping bill ${sb.number} (SAMPLE)`, author: CUSTOMS.name, date: paperDate(sb.date, '18:05:00'),
  });
  const page = addPage(pdf);
  // Text at a column and row, like a printout: col counts letters from the left margin.
  const at = (col, row, text, bold = false) => write(page, text, MARGIN + col * COL, 50 + row * ROW,
    { font: bold ? fonts.monoBold : fonts.mono, size: MONO_SIZE });
  const pair = (col, row, label, value) => at(col, row, `${label.padEnd(15)}: ${value}`);
  const rule = (row) => line(page, MARGIN, 50 + row * ROW - 7, A4.width - MARGIN, 50 + row * ROW - 7, { width: 0.5, color: RULE });
  const centre = (row, text, bold = false) => write(page, text, 0, 50 + row * ROW, {
    font: bold ? fonts.monoBold : fonts.mono, size: bold ? 10 : MONO_SIZE, align: 'center', width: A4.width,
  });

  const goods = s.nature === 'lab-grown' ? 'LAB-GROWN (CVD) CUT AND POLISHED DIAMONDS' : 'CUT AND POLISHED NATURAL DIAMONDS, GRADED';
  const graded = s.stones.filter((stone) => stone.report).length;

  centre(0, 'SHIPPING BILL FOR EXPORT OF DUTY FREE GOODS', true);
  centre(1, '(SAMPLE PRINTOUT FOR THE JEWEL LABS DEMO)');
  centre(2, `${CUSTOMS.name.toUpperCase()}, ${CUSTOMS.city.toUpperCase()}   PORT CODE : ${CUSTOMS.portCode}`);
  rule(4);
  pair(0, 4, 'SB No.', sb.number);
  pair(56, 4, 'SB Date', dmy(sb.date));
  pair(0, 5, 'IEC No.', HOUSE.iec);
  pair(56, 5, 'Mode', 'AIR');
  pair(0, 6, 'Exporter', HOUSE.name.toUpperCase());
  at(17, 7, HOUSE.address.toUpperCase());
  pair(0, 8, 'Consignee', s.buyer.name.toUpperCase());
  at(17, 9, s.buyer.address.toUpperCase());
  pair(0, 10, 'CHA', BROKER.name.toUpperCase());
  pair(0, 11, 'CHA Licence', BROKER.licence);
  rule(13);
  pair(0, 13, 'Port of Loading', s.portOfLoading.toUpperCase());
  pair(56, 13, 'Country of Final Dest.', s.destination.toUpperCase());
  pair(0, 14, 'Port of Discharge', s.portOfDischarge.toUpperCase());
  pair(56, 14, 'Nature of Contract', s.incoterm);
  pair(0, 15, 'Invoice No.', s.invoice);
  pair(56, 15, 'Invoice Date', dmy(s.invoiceDate));
  pair(0, 16, 'Invoice Value', `USD ${money(sum.value)}`);
  pair(56, 16, 'Exchange Rate', '1 USD = 88.40 INR');
  pair(0, 17, 'Total Pcs', String(sum.pieces));
  pair(56, 17, 'Total Carats', carats(sum.carats));
  pair(0, 18, 'Gross Wt (KGS)', s.awb.grossKg.toFixed(3));
  pair(56, 18, 'Packages', '1 SEALED PARCEL');
  pair(0, 19, 'MAWB No.', s.awb.mawb);
  pair(56, 19, 'HAWB No.', s.awb.hawb);
  rule(21);
  at(0, 21, 'ITEM DETAILS', true);
  // Fixed columns: Sr 4, RITC 10, Description 45, Qty 8, gap 3, Unit 6, Value 12.
  const itemRow = (sr, ritc, text, qty, unit, val) => `${sr.padEnd(4)}${ritc.padEnd(10)}${text.padEnd(45)}${qty.padStart(8)}   ${unit.padEnd(6)}${val.padStart(12)}`;
  at(0, 22, itemRow('Sr', 'RITC', 'Description', 'Qty', 'Unit', 'Value (USD)'));
  line(page, MARGIN, 50 + 22 * ROW + 3, A4.width - MARGIN, 50 + 22 * ROW + 3, { width: 0.3, color: GREY });
  at(0, 23, itemRow('1', s.hsCode, goods, carats(sum.carats), 'CTS', money(sum.value)));
  at(14, 24, `${sum.pieces} PCS, NGL REPORTS ${graded} NOS`);
  rule(26);
  pair(0, 26, 'Scheme Code', '99 (NO EXPORT INCENTIVE CLAIMED)');
  pair(0, 27, 'Exam Mark', '100% EXAMINED, GOODS FOUND AS DECLARED, SEALED (SEAL SMP-55120)');
  rule(29);
  at(0, 29, 'LET EXPORT ORDER', true);
  pair(0, 30, 'LEO No.', sb.leoNumber);
  pair(56, 30, 'LEO Date', dmy(sb.leoDate));
  pair(0, 31, 'Appraiser', 'SAMPLE OFFICER 07');
  pair(0, 32, 'Supdt.', 'SAMPLE OFFICER 12');

  boxStamp(page, { x: 400, y: 50 + 31 * ROW, lines: ['LET EXPORT ORDER', shortDate(sb.leoDate), 'SAMPLE CUSTOMS'], size: 9, rotate: -5 });
  sign(page, 300, 50 + 34.5 * ROW, { seed: Number(sb.number), width: 80, height: 15, color: rgb(0.15, 0.15, 0.2) });
  at(0, 38, 'Declaration by the exporter: the particulars given above are true and correct.');
  sign(page, MARGIN + 4, 50 + 40.6 * ROW, { seed: Number(sb.number) + 1, width: 70, height: 14 });
  at(0, 42, `For ${HOUSE.name.toUpperCase()}`);
  rule(45);
  at(0, 45, `Printed from the sample customs system on ${dmy(sb.date)} 18:05. This is not a real customs document.`);
  markPage(page, fonts);
  return pdf.save();
}

// ---------- house air waybill ----------

const LABEL_SIZE = 5.8;
const VALUE_SIZE = 8.5;

/** One house air waybill (A, B or C) as PDF bytes. */
export async function buildAirWaybill(id) {
  const s = SHIPMENTS[id];
  const awb = s.awb;
  const sum = totals(s);
  const { pdf, fonts } = await newPdf({
    title: `House air waybill ${awb.hawb} (SAMPLE)`, author: LOGISTICS.name, date: paperDate(awb.date, '07:30:00'),
  });
  const page = addPage(pdf);
  const label = (text, x, y) => write(page, text, x, y, { font: fonts.sans, size: LABEL_SIZE, color: GREY });
  const value = (text, x, y, size = VALUE_SIZE) => write(page, text, x, y, { font: fonts.monoBold, size });
  const box = (x, y, w, h) => rect(page, x, y, w, h, { stroke: RULE, lineWidth: 0.6 });
  const W = A4.width - MARGIN * 2;
  const half = W / 2;
  const L = MARGIN;
  const R = MARGIN + half;

  value(`MAWB No. ${awb.mawb}`, L, 52, 11);
  value(`HAWB No. ${awb.hawb}`, R + 70, 52, 11);

  // Shipper and consignee on the left; the issuer's block on the right.
  let y = 62;
  box(L, y, half, 74);
  label("Shipper's Name and Address", L + 4, y + 8);
  [HOUSE.name.toUpperCase(), ...HOUSE.lines.map((t) => t.toUpperCase()), `IEC ${HOUSE.iec}`].forEach((text, i) => value(text, L + 4, y + 22 + i * 11, 8));
  // The right-hand lines sit on the same baselines as the shipper and consignee lines on the left,
  // so each printed line reads "left text <gap> right text". Nothing shares a line with the two labels.
  box(R, y, half, 148);
  label('Not negotiable', R + 6, y + 4);
  write(page, 'HOUSE AIR WAYBILL', R + 6, y + 22, { font: fonts.sansBold, size: 13 });
  label('Issued by', R + 6, y + 33);
  write(page, LOGISTICS.name, R + 6, y + 44, { font: fonts.sansBold, size: 9 });
  write(page, LOGISTICS.address, R + 6, y + 55, { font: fonts.sans, size: 7.5 });
  write(page, `IATA agent code ${LOGISTICS.iata}`, R + 6, y + 66, { font: fonts.sans, size: 7.5 });
  label('Copies 1, 2 and 3 of this air waybill are originals and have the same validity.', R + 6, y + 78);
  label('Goods are accepted for carriage in apparent good order and condition, subject to the conditions', R + 6, y + 96);
  label('of contract printed on the original. Valuable cargo: carried under the carrier\'s strong-room rules.', R + 6, y + 107);
  write(page, 'AWB Date', R + 6, y + 129, { font: fonts.sans, size: LABEL_SIZE, color: GREY });
  value(dmy(awb.date), R + 42, y + 129);

  y += 74;
  box(L, y, half, 74);
  label("Consignee's Name and Address", L + 4, y + 8);
  [s.buyer.name.toUpperCase(), ...s.buyer.lines.map((t) => t.toUpperCase()), `TEL ${s.buyer.phone}`].forEach((text, i) => value(text, L + 4, y + 22 + i * 11, 8));

  y += 74;
  box(L, y, half, 30);
  label("Issuing Carrier's Agent, Name and City", L + 4, y + 8);
  value(`${LOGISTICS.name.toUpperCase()}, ${LOGISTICS.city.toUpperCase()}`, L + 4, y + 22, 7.5);
  box(R, y, half, 30);
  label('Accounting Information', R + 4, y + 8);
  value('FREIGHT PREPAID', R + 4, y + 18, 7);
  value(`CHA: ${BROKER.name.toUpperCase()}`, R + 4, y + 26, 6.5);

  // One line per cell: small label, then the typed value on the same line.
  y += 30;
  const inline = (x, w, y0, h, text, val, size = VALUE_SIZE) => {
    box(x, y0, w, h);
    label(text, x + 4, y0 + h / 2 + 3);
    value(val, x + 9 + fonts.sans.widthOfTextAtSize(text, LABEL_SIZE), y0 + h / 2 + 3, size);
  };
  const legs = awb.legs;
  inline(L, half, y, 24, 'Airport of Departure', `${s.portOfLoading.toUpperCase()}`);
  inline(R, half, y, 24, 'Routing :', awb.route.split('-').join(' - '));
  y += 24;
  // To / By pairs for each leg, then currency and the value declared for customs.
  const widths = [55, 60, 55, 60, 63, W - 293];
  const starts = widths.map((w, i) => L + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const second = legs[1];
  inline(starts[0], widths[0], y, 24, 'To', legs[0].to);
  inline(starts[1], widths[1], y, 24, 'By', legs[0].flight.split(' ')[0]);
  inline(starts[2], widths[2], y, 24, 'To', second ? second.to : '-');
  inline(starts[3], widths[3], y, 24, 'By', second ? second.flight.split(' ')[0] : '-');
  inline(starts[4], widths[4], y, 24, 'Currency', 'USD');
  inline(starts[5], widths[5], y, 24, 'Declared Value for Carriage: NVD.  For Customs:', `USD ${money(sum.value)}`, 8);
  y += 24;
  inline(L, half * 0.7, y, 24, 'Airport of Destination', s.portOfDischarge.toUpperCase());
  const flights = legs.map((leg) => `${leg.flight}/${shortDate(awb.date).slice(0, 6)}`).join('  ');
  inline(L + half * 0.7, half * 0.9, y, 24, 'Flight/Date', flights, 8);
  inline(L + half * 1.6, half * 0.4, y, 24, 'Insurance', 'AS PER POLICY', 6.5);
  y += 24;
  box(L, y, W, 34);
  label('Handling Information', L + 4, y + 8);
  const sb = s.shippingBill;
  value(`VALUABLE CARGO. KEEP IN STRONG ROOM. ${sb ? `SB NO. ${sb.number} DT ${dmy(sb.date)}. ` : ''}INV NO. ${s.invoice}`, L + 4, y + 22, 7.5);

  // Pieces, weights and the goods.
  y += 34;
  const columns = [
    ['No. of', 'Pieces', 34], ['Gross', 'Weight', 40], ['kg', 'lb', 20], ['Rate', 'Class', 30], ['Chargeable', 'Weight', 46],
    ['Rate /', 'Charge', 50], ['Total', '', 50], ['Nature and Quantity of Goods', '(incl. Dimensions or Volume)', W - 270],
  ];
  const tableH = 150;
  let x = L;
  const goodsLines = [
    'VALUABLE CARGO',
    s.nature === 'lab-grown' ? 'LAB-GROWN (CVD) CUT AND POLISHED DIAMONDS' : 'NATURAL CUT AND POLISHED DIAMONDS',
    `${sum.pieces} PCS, ${carats(sum.carats)} CTS, HS ${s.hsCode}`,
    `GROSS WEIGHT ${awb.grossKg.toFixed(2)} KG`,
    `DIMS ${awb.dims.toUpperCase().replace(/ X /g, ' X ')} X 1`,
    `INV NO. ${s.invoice}`,
    `INV. VALUE : USD ${money(sum.value)} ${s.incoterm}`,
  ];
  const cells = ['1', awb.grossKg.toFixed(2), 'K', 'Q', awb.chargeableKg.toFixed(1), 'AS AGREED', 'AS AGREED'];
  columns.forEach(([top, bottom, w], i) => {
    box(x, y, w, tableH);
    label(top, x + 3, y + 8);
    if (bottom) label(bottom, x + 3, y + 15);
    line(page, x, y + 20, x + w, y + 20, { width: 0.4 });
    if (i < cells.length) value(cells[i], x + 3, y + 34, cells[i].length > 5 ? 6.5 : VALUE_SIZE);
    else goodsLines.forEach((text, j) => value(text, x + 4, y + 34 + j * 12, 7.5));
    x += w;
  });

  // Charges, certification and signatures.
  y += tableH;
  box(L, y, half, 90);
  label('Prepaid', L + 4, y + 9);
  [['Weight Charge', 'AS AGREED'], ['Valuation Charge', 'AS AGREED'], ['Total Other Charges', 'NIL'], ['Total Prepaid', 'AS AGREED']]
    .forEach(([name, val], i) => {
      label(name, L + 4, y + 24 + i * 18);
      value(val, L + 110, y + 24 + i * 18, 8);
    });
  box(R, y, half, 90);
  label('Shipper certifies that the particulars on the face hereof are correct and that this consignment', R + 4, y + 9);
  label('holds no dangerous goods.', R + 4, y + 16);
  sign(page, R + 30, y + 52, { seed: Number(awb.hawb.slice(-5)), width: 80, height: 15 });
  line(page, R + 10, y + 70, R + half - 10, y + 70, { width: 0.4 });
  label('Signature of Shipper or his Agent', R + 10, y + 79);

  y += 90;
  box(L, y, W, 74);
  write(page, 'Executed on', L + 4, y + 18, { font: fonts.sans, size: 7, color: GREY });
  value(`${dmy(awb.date)} at ${LOGISTICS.city.toUpperCase()}`, L + 50, y + 18);
  roundStamp(page, { cx: L + half + 60, cy: y + 38, r: 28, top: 'SAMPLE SECURE LOGISTICS', bottom: 'MUMBAI * SAMPLE', middle: ['VALUABLES'],
    color: rgb(0.1, 0.3, 0.55), rotate: -8 });
  sign(page, L + half + 110, y + 44, { seed: Number(awb.hawb.slice(-4)) + 7, width: 90, height: 16 });
  line(page, L + half, y + 60, L + W - 10, y + 60, { width: 0.4 });
  label('Signature of Issuing Carrier or its Agent', L + half, y + 69);
  write(page, `M# ${awb.mawb}    H# ${awb.hawb}`, L + 4, y + 62, { font: fonts.mono, size: 8, color: INK });
  markPage(page, fonts);
  return pdf.save();
}
