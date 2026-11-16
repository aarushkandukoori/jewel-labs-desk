// A small CSV reader for the OFAC files (sdn.csv, alt.csv).
// Handles quoted fields ("CO., LTD."), doubled quotes inside quotes (""), CRLF line ends and the
// Ctrl-Z end-of-file byte (0x1A) that the Treasury files end with. We write our own instead of
// adding a dependency because the format is simple and the files never change shape.

const QUOTE = 34; // "
const COMMA = 44; // ,
const NEWLINE = 10; // \n
const RETURN = 13; // \r
const CTRL_Z = 26; // end-of-file marker in the OFAC files

/** Parse CSV text into an array of rows (each row an array of strings). Empty lines are skipped. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let start = 0; // start of the current run of plain characters (we copy runs, not single chars, for speed)

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inQuotes) {
      if (code !== QUOTE) continue;
      field += text.slice(start, i);
      if (text.charCodeAt(i + 1) === QUOTE) {
        field += '"'; // "" inside quotes is one quote
        i++;
        start = i + 1;
      } else {
        inQuotes = false;
        start = i + 1;
      }
      continue;
    }
    if (code === QUOTE) {
      field += text.slice(start, i);
      inQuotes = true;
      start = i + 1;
    } else if (code === COMMA) {
      row.push(field + text.slice(start, i));
      field = '';
      start = i + 1;
    } else if (code === NEWLINE) {
      row.push(field + text.slice(start, i));
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      start = i + 1;
    } else if (code === RETURN || code === CTRL_Z) {
      field += text.slice(start, i); // drop the character itself
      start = i + 1;
    }
  }
  const last = field + text.slice(start);
  if (row.length || last !== '') {
    row.push(last);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** OFAC writes "-0-" for an empty value. Returns the trimmed value, or '' for empty. */
export function cleanValue(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '-0-' ? '' : trimmed;
}
