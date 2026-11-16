// Reads spreadsheets (xlsx, xls, ods, csv) with SheetJS: every sheet as rows of text, plus one
// readable dump (tab between cells) for the reading agent.
import * as XLSX from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import { decodeText, toBytes } from './detect.js';

// Old .xls files store text in Windows code pages; SheetJS needs the tables to decode them.
XLSX.set_cptable(codepages);

const MAX_ROWS_PER_SHEET = 5000;
const MAX_COLUMNS = 200; // packing lists use a dozen or two
const MAX_CELLS = 1_000_000; // cells looked at in one file, all its sheets together
const MAX_TEXT_CHARS = 40000;

/** Returns { sheets: [{ name, rows: string[][] }], text }. Throws if the file is not a spreadsheet. */
export function readSheet(bytes, mime) {
  // dense: false keeps one key per cell, which usedEnd() below relies on.
  const workbook =
    mime === 'text/csv'
      ? // raw: keep cells such as "05/11/2026" and "1,02" exactly as written, no guessing at dates.
        XLSX.read(decodeText(bytes), { type: 'string', raw: true, dense: false })
      : XLSX.read(toBytes(bytes), { type: 'array', dense: false });
  let cellsLeft = MAX_CELLS;
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = rangeToRead(sheet, cellsLeft);
    if (!range) return { name, rows: [] };
    cellsLeft -= (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    return { name, rows: sheetRows(sheet, range) };
  });
  return { sheets, text: sheetsToText(sheets) };
}

// sheet_to_json visits every cell of the box it is given, and the file itself says how big the sheet is (its
// dimension tag, which anyone can write as A1:XFD1048576, or two cells far apart). Walking such a box would
// stop the app for hours. So the box is cut to where cells really are, then to MAX_ROWS_PER_SHEET rows,
// MAX_COLUMNS columns and the cells this file has left. It keeps its top-left corner, so rows come out the same.
function rangeToRead(sheet, cellsLeft) {
  if (!sheet?.['!ref']) return null;
  const used = usedEnd(sheet);
  if (!used) return null;
  const { s, e } = XLSX.utils.decode_range(sheet['!ref']);
  const width = Math.min(Math.min(e.c, used.c) - s.c + 1, MAX_COLUMNS);
  if (width < 1) return null;
  const height = Math.min(Math.min(e.r, used.r) - s.r + 1, MAX_ROWS_PER_SHEET, Math.floor(cellsLeft / width));
  if (height < 1) return null;
  return { s, e: { r: s.r + height - 1, c: s.c + width - 1 } };
}

// The last row and the last column that hold a cell. Only the cells in the file are visited, never the box.
function usedEnd(sheet) {
  let r = -1;
  let c = -1;
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue; // '!ref', '!merges' and other sheet settings
    const cell = XLSX.utils.decode_cell(address);
    if (cell.r > r) r = cell.r;
    if (cell.c > c) c = cell.c;
  }
  return r < 0 ? null : { r, c };
}

// Cells as they look in Excel (formatted text), blank rows dropped, empty cells at the row end trimmed.
function sheetRows(sheet, range) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false, range });
  return rows.map(trimRow).filter((row) => row.length);
}

function trimRow(row) {
  const cells = row.map((cell) => String(cell ?? '').trim());
  while (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function sheetsToText(sheets) {
  const text = sheets
    .map((sheet) => `Sheet: ${sheet.name}\n${sheet.rows.map((row) => row.join('\t')).join('\n')}`)
    .join('\n\n');
  if (text.length <= MAX_TEXT_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_TEXT_CHARS);
  return `${text.slice(0, cut > 0 ? cut : MAX_TEXT_CHARS)}\n[The rest is not shown: the sheet is longer than 40,000 characters.]`;
}
