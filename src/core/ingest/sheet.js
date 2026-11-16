// Reads spreadsheets (xlsx, xls, ods, csv) with SheetJS: every sheet as rows of text, plus one
// readable dump (tab between cells) for the reading agent.
import * as XLSX from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import { decodeText, toBytes } from './detect.js';

// Old .xls files store text in Windows code pages; SheetJS needs the tables to decode them.
XLSX.set_cptable(codepages);

const MAX_ROWS_PER_SHEET = 5000;
const MAX_TEXT_CHARS = 40000;

/** Returns { sheets: [{ name, rows: string[][] }], text }. Throws if the file is not a spreadsheet. */
export function readSheet(bytes, mime) {
  const workbook =
    mime === 'text/csv'
      ? // raw: keep cells such as "05/11/2026" and "1,02" exactly as written, no guessing at dates.
        XLSX.read(decodeText(bytes), { type: 'string', raw: true })
      : XLSX.read(toBytes(bytes), { type: 'array' });
  const sheets = workbook.SheetNames.map((name) => ({ name, rows: sheetRows(workbook.Sheets[name]) }));
  return { sheets, text: sheetsToText(sheets) };
}

// Cells as they look in Excel (formatted text), blank rows dropped, empty cells at the row end trimmed.
function sheetRows(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  return rows
    .map(trimRow)
    .filter((row) => row.length)
    .slice(0, MAX_ROWS_PER_SHEET);
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
