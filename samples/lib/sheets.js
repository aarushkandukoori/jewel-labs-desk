// The two spreadsheets of shipment A: the packing list (arrives late in the demo) and the factory
// record that ties rough lot R-0412 to each polished stone and its grading report.
import * as XLSX from 'xlsx';
import { FOOTER, HOUSE, LAB, ROUGH_SUPPLIER, KP, SUPPLIER_INVOICE, FACTORY, SHIPMENTS, lineAmount, totals, factoryTotal, dmy } from './facts.js';

const CARAT = '0.00';
const MONEY = '#,##0.00';

/** A number cell with an Excel number format, so it shows "1.50", not "1.5". */
function num(value, format) {
  return { t: 'n', v: value, z: format };
}

/** A total cell: a SUM formula plus its value, the way a clerk's sheet has it. */
function sum(column, firstRow, lastRow, value, format) {
  return { t: 'n', f: `SUM(${column}${firstRow}:${column}${lastRow})`, v: value, z: format };
}

/** Builds the xlsx bytes for one sheet. rows are arrays of plain values or cell objects. */
function workbook(sheetName, rows, { widths, title, author, date, merges = [] }) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  sheet['!merges'] = merges;
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  // Fixed properties keep the file the same on every run.
  book.Props = { Title: title, Author: author, Company: HOUSE.name, CreatedDate: date, ModifiedDate: date };
  return new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

/** Packing list KG/26-27/041, stone by stone with report numbers (copied from the invoice: 0.71 ct on line 2). */
export function buildPackingList() {
  const s = SHIPMENTS.A;
  const total = totals(s);
  const header = ['Sr. No.', 'Description', 'Shape', 'Carat', 'Colour', 'Clarity', 'Lab', 'Report No.', 'Pcs', 'Rate (US$/ct)', 'Amount (US$)'];
  const firstStoneRow = 11; // Excel row numbers start at 1; the stone rows start under the header in row 10
  const stoneRows = s.stones.map((stone) => [
    stone.line, 'Natural polished diamond', stone.shape, num(stone.carat, CARAT), stone.color, stone.clarity,
    stone.report ? LAB.short : '-', stone.report || 'No report', 1, num(stone.rate, MONEY), num(lineAmount(stone), MONEY),
  ]);
  const lastStoneRow = firstStoneRow + stoneRows.length - 1;
  const rows = [
    [HOUSE.name.toUpperCase()],
    [`${HOUSE.address}  |  IEC ${HOUSE.iec}  |  ${HOUSE.email}`],
    ['PACKING LIST'],
    [],
    ['Invoice No.', s.invoice, '', '', 'Date', dmy(s.packingListDate)],
    ['Consignee', `${s.buyer.name}, ${s.buyer.address}`],
    ["Buyer's PO No.", `${s.po.number} dated ${dmy(s.po.date)}`],
    ['Description of goods', `${s.goods}, ITC HS ${s.hsCode}`],
    [],
    header,
    ...stoneRows,
    ['Total', '', '', sum('D', firstStoneRow, lastStoneRow, total.carats, CARAT), '', '', '', '',
      sum('I', firstStoneRow, lastStoneRow, total.pieces, '0'), '', sum('K', firstStoneRow, lastStoneRow, total.value, MONEY)],
    [],
    ['Packages', '1 sealed parcel, box 1 of 1'],
    ['Net weight (grams)', num(Math.round(total.carats * 0.2 * 1000) / 1000, '0.00')],
    ['Gross weight (kg)', num(s.awb.grossKg, '0.00')],
    ['Lab', `${LAB.short} = ${LAB.name}`],
    [],
    [FOOTER],
  ];
  return workbook('Packing list', rows, {
    widths: [12, 24, 16, 8, 8, 8, 6, 13, 6, 13, 14],
    title: `Packing list ${s.invoice} (SAMPLE)`,
    author: HOUSE.name,
    date: new Date('2026-11-11T09:30:00Z'),
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 10 } }, { s: { r: 2, c: 0 }, e: { r: 2, c: 10 } }],
  });
}

/**
 * Factory record for rough lot R-0412: which polished stones came out of it, planned against actual weight.
 * The factory weighed stone 2 at 0.70 ct, like the lab, while the invoice says 0.71 ct.
 */
export function buildFactoryRecord() {
  const stones = SHIPMENTS.A.stones;
  const polished = factoryTotal();
  const planned = stones.reduce((total, stone) => total + Math.round(stone.planned * 100), 0) / 100;
  const firstStoneRow = 15;
  const stoneRows = stones.map((stone) => [
    stone.line, stone.report || '', stone.shapeKey, num(stone.actual, CARAT), num(stone.planned, CARAT), stone.color, stone.clarity,
    stone.report ? LAB.short : '-', stone.roughPiece, dmy(stone.polishedOn),
    stone.report ? 'Graded' : 'Not graded (below 0.50 ct)',
  ]);
  const lastStoneRow = firstStoneRow + stoneRows.length - 1;
  const loss = Math.round((FACTORY.roughCarats - polished) * 100) / 100;
  const rows = [
    [HOUSE.name.toUpperCase()],
    ['FACTORY RECORD: ROUGH TO POLISHED'],
    [],
    ['Rough lot No.', FACTORY.lot],
    ['Supplier', ROUGH_SUPPLIER.name],
    ['Supplier invoice No.', SUPPLIER_INVOICE.number, '', 'Invoice date', dmy(SUPPLIER_INVOICE.date)],
    ['KP certificate No.', KP.number, '', 'KP date', dmy(KP.issued)],
    ['Countries of mining', KP.countriesOfMining.join(', ')],
    ['Rough received', `${FACTORY.roughPieces} pcs, ${FACTORY.roughCarats.toFixed(2)} ct`],
    ['Polish months', FACTORY.polishMonths],
    ['Factory', FACTORY.unit],
    ['Record date', dmy(FACTORY.recordDate)],
    [],
    ['Sr. No.', 'Report No.', 'Shape', 'Polished ct', 'Planned ct', 'Colour', 'Clarity', 'Lab', 'Rough piece', 'Polished on', 'Status'],
    ...stoneRows,
    ['Total', '', '', sum('D', firstStoneRow, lastStoneRow, polished, CARAT), sum('E', firstStoneRow, lastStoneRow, planned, CARAT)],
    [],
    ['Rough weight (ct)', num(FACTORY.roughCarats, CARAT)],
    ['Polished output (ct)', num(polished, CARAT)],
    ['Yield', `${((polished / FACTORY.roughCarats) * 100).toFixed(1)}%`],
    ['Dust and loss (ct)', num(loss, CARAT)],
    [],
    [FOOTER],
  ];
  return workbook(`Lot ${FACTORY.lot}`, rows, {
    widths: [20, 13, 10, 11, 11, 8, 8, 6, 12, 12, 26],
    title: `Factory record lot ${FACTORY.lot} (SAMPLE)`,
    author: HOUSE.name,
    date: new Date('2026-07-08T12:00:00Z'),
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 10 } }],
  });
}
