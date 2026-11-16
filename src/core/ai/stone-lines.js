// Reads stone and lot rows out of text and spreadsheets: report number, carat, colour, clarity, shape, price.
// Used by the offline reader, for chat messages that list stones, and to cross-check what the AI read.
// Every row it returns has the Line shape from types.js (missing values are null).

import { parseNumber, oneLine } from './text.js';

const REPORT_RE = /(?<![\w.,])(LG\s?\d{8,10}|\d{9,10})(?![\w]|[.,]\d)/i;
const LAB_RE = /\b(GIA|IGI|HRD|GCAL|GSI|AGS|EGL|IIDGR|SGL)\b/;
const CLARITY_RE = /\b(VVS[12]|VS[12]|SI[123]|I[123])\b/i;
const CLARITY_TOP_RE = /\b(FL|IF)\b/; // upper case only: "if" is also an English word
const COLOR_RE = /^(?:[D-Z](?:[-/][D-Z])?|FANCY|FCY)$/;
const SHAPE_WORDS_RE = new RegExp(
  '\\b(round\\s+brilliant|cushion\\s+modified|cushion\\s+brilliant|square\\s+emerald|long\\s+radiant|round|oval|pear|' +
    'princess|emerald|cushion|marquise|heart|asscher|radiant|baguette|trillion|briolette)\\b',
  'i',
);
const SHAPE_CODES_RE = /\b(RBC|RND|RD|BR|OV|OVL|PS|PR|PRN|EM|EMD|CU|CUS|CMB|MQ|MAR|HT|HRT|AS|ASH|RAD|RA|BAG|BG|TRI|SQ|SEM)\b/;
const LAB_GROWN_RE = /\b(CVD|HPHT|LGD|lab[\s-]?grown|laboratory[\s-]grown|man[\s-]?made|synthetic)\b/i;
const NATURAL_RE = /\bnatural\b/i;
const UNIT_CARAT_RE = /(?<![\w.,])(\d{1,5}(?:,\d{3})*\.\d{1,3})\s*(?:cts?|carats?|crts?)\b/i;
const PIECES_RE = /(?<![\w.,])(\d{1,6})\s*(?:pcs|pc|pieces|nos)\b/i;
const TOTAL_ROW_RE = /^\W*(?:sub[\s-]*)?total\b|\bgrand\s+total\b/i;
const HS_RE = /(?<![\d.])(71(?:02|04|13)(?:\.\d{2}(?:\.?\d{2})?|\d{4}))(?!\d)/;
const DESCRIPTION_RE = /((?:[A-Za-z&]+[\s,]+){0,5}diamonds?\b(?:[\s,]+[A-Za-z&]+){0,3})/i;

/** 'natural', 'lab-grown' or null, from words like CVD, HPHT, "lab grown", "natural", or an LG report number. */
export function growthFrom(text, reportNumber = null) {
  if (LAB_GROWN_RE.test(String(text || '')) || /^LG/i.test(reportNumber || '')) return 'lab-grown';
  if (NATURAL_RE.test(String(text || ''))) return 'natural';
  return null;
}

/** Clean one token: drop brackets and trailing punctuation. */
function cleanToken(token) {
  return token.replace(/^[(\[]+/, '').replace(/[.,:;)\]]+$/, '');
}

/** Numbers printed in the row, with where they sit: [{ index, value, decimals }]. */
function numbersIn(tokens) {
  const out = [];
  tokens.forEach((token, index) => {
    const m = cleanToken(token).match(/^(?:US\$|\$|€|₹|Rs\.?|USD)?(\d[\d,]*(?:\.\d+)?)(?:\/-)?$/i);
    if (!m) return;
    const decimals = m[1].includes('.') ? m[1].split('.')[1].length : 0;
    out.push({ index, value: parseNumber(m[1]), decimals });
  });
  return out.filter((n) => n.value !== null);
}

// rate x carat = amount, within half a percent (or 60 cents), so we know which number is which.
function fits(carat, rate, amount) {
  if (!(rate > 0 && amount > 0)) return false;
  return Math.abs(carat * rate - amount) <= Math.max(0.6, amount * 0.005);
}

function findColor(tokens, caratIndex) {
  // Colour usually comes right after the carat weight; there lower case is fine ("1.02 g vs1" in a chat).
  if (caratIndex >= 0) {
    for (let i = caratIndex + 1; i < Math.min(tokens.length, caratIndex + 4); i += 1) {
      const t = cleanToken(tokens[i]).toUpperCase();
      if (COLOR_RE.test(t)) return t;
    }
  }
  for (const token of tokens) {
    const t = cleanToken(token);
    if (COLOR_RE.test(t)) return t;
  }
  return null;
}

/**
 * Read one printed row (a table row, an OCR line or a chat line) as a stone or lot.
 * Returns a Line, or null when the row is not a stone (headers, totals, addresses...).
 */
export function parseStoneLine(raw) {
  const quote = oneLine(raw);
  if (quote.length < 6 || quote.length > 400 || TOTAL_ROW_RE.test(quote)) return null;

  // Join split clarity grades ("VS 1") and drop measurements and percentages, which look like carats.
  let row = quote.replace(/[|\t]/g, ' ').replace(/\b(VVS|VS|SI|I)\s?-?\s?([123])\b/gi, '$1$2');
  row = row.replace(/\d+(?:\.\d+)?\s*[-x×*]\s*\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*mm)?/gi, ' ');
  row = row.replace(/\d+(?:\.\d+)?\s*%/g, ' ');

  const report = row.match(REPORT_RE);
  const reportNumber = report ? report[1].replace(/\s/g, '').toUpperCase() : null;
  if (report) row = row.replace(report[0], ' ');
  const hs = row.match(HS_RE); // HS codes (7102.39) look like carats, so take them out first
  if (hs) row = row.replace(hs[0], ' ');

  const tokens = row.split(/\s+/).filter(Boolean);
  const numbers = numbersIn(tokens);
  const clarity = ((row.match(CLARITY_RE) || row.match(CLARITY_TOP_RE)) || [])[1]?.toUpperCase() || null;

  // Carat, rate and amount: a printed unit wins; otherwise three numbers where carat x rate = amount.
  let carat = null;
  let caratIndex = -1;
  let rate = null;
  let amount = null;
  const unit = row.match(UNIT_CARAT_RE);
  if (unit) {
    carat = parseNumber(unit[1]);
    caratIndex = numbers.find((n) => n.value === carat)?.index ?? -1;
  }
  if (carat === null) {
    // Numbers are in printed order, so carat comes before rate, and rate before amount.
    outer: for (const c of numbers.filter((n) => n.decimals > 0 && n.value > 0 && n.value <= 100000)) {
      for (let j = 0; j < numbers.length; j += 1) {
        if (numbers[j].index <= c.index) continue;
        for (let k = j + 1; k < numbers.length; k += 1) {
          if (fits(c.value, numbers[j].value, numbers[k].value)) {
            [carat, caratIndex, rate, amount] = [c.value, c.index, numbers[j].value, numbers[k].value];
            break outer;
          }
        }
      }
    }
  }
  // No price columns: a report number or grade on the row means the first small decimal is the carat weight.
  if (carat === null && (reportNumber || clarity || findColor(tokens, -1))) {
    const guess = numbers.find((n) => n.decimals >= 1 && n.decimals <= 3 && n.value > 0 && n.value < 30);
    if (guess) [carat, caratIndex] = [guess.value, guess.index];
  }
  const color = findColor(tokens, caratIndex);
  if (carat !== null && rate === null) {
    const rest = numbers.filter((n) => n.index > caratIndex);
    for (let j = 0; j < rest.length && rate === null; j += 1) {
      for (let k = j + 1; k < rest.length; k += 1) {
        if (fits(carat, rest[j].value, rest[k].value)) {
          [rate, amount] = [rest[j].value, rest[k].value];
          break;
        }
      }
    }
    // Only an amount column: one money-looking number (2 decimals) after the carat weight.
    const money = rest.filter((n) => n.decimals === 2 && n.value >= 1);
    if (rate === null && money.length === 1) amount = money[0].value;
  }

  // A leading whole number is the row's serial number.
  const first = numbers[0];
  const lineNo = first && first.index === 0 && first.decimals === 0 && first.value <= 9999 && first.index !== caratIndex
    ? first.value : null;
  const piecesMatch = row.match(PIECES_RE);
  let pieces = piecesMatch ? Number(piecesMatch[1]) : null;
  const description = (quote.match(DESCRIPTION_RE) || [])[1]?.trim().replace(/[\s,]+$/, '') || null;

  const isStone = Boolean(reportNumber && (carat !== null || color || clarity)) || Boolean(carat !== null && color && clarity);
  const isLot = !isStone && carat !== null && (pieces !== null || description || hs) && (amount !== null || unit);
  if (!isStone && !isLot) return null;
  if (isLot && pieces === null) {
    // On a lot row the only other whole number is usually the piece count.
    const whole = numbers.filter((n) => n.decimals === 0 && n.index !== 0 && n.value > 0 && n.value < 100000);
    if (whole.length === 1) pieces = whole[0].value;
  }

  const shape = (quote.match(SHAPE_WORDS_RE) || quote.match(SHAPE_CODES_RE) || [])[1] || null;
  const lab = (quote.match(LAB_RE) || [])[1] || (/^LG\d/.test(reportNumber || '') ? 'IGI' : null);
  return {
    lineNo,
    description,
    reportNumber,
    lab,
    shape,
    carat,
    color,
    clarity,
    pieces,
    rate,
    amount,
    growth: growthFrom(quote, reportNumber),
    quote: quote.slice(0, 160),
  };
}

/** Every stone or lot row in a text, numbered in order when the paper prints no serial numbers. */
export function linesFromText(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = parseStoneLine(raw);
    if (!line || seen.has(line.quote)) continue;
    seen.add(line.quote);
    out.push(line);
  }
  out.forEach((line, i) => {
    if (line.lineNo === null) line.lineNo = i + 1;
  });
  return out;
}

// Spreadsheet column headers we understand. Order matters: "Report No" must be a report column, not a serial.
const COLUMNS = [
  ['reportNumber', /report|cert(?:ificate)?\b|certi|\b(?:gia|igi)\s*no/i],
  ['lineNo', /^(?:sr|s|sl)?\.?\s*(?:no|nos|#)\.?$|^serial|^sr\.?$|^#$/i],
  ['lab', /^lab(?:oratory)?(?:\s*name)?$/i],
  ['shape', /shape/i],
  ['carat', /carat|\bcts?\b|weight|\bwt\b|crt/i],
  ['color', /colou?r|^col$/i],
  ['clarity', /clarity|purity|^cla$/i],
  ['pieces', /pcs|pieces|qty|quantity|^nos$/i],
  ['rate', /rate|price|per\s*c(?:ara)?t|\/\s*ct/i],
  ['amount', /amount|value|total|^amt/i],
  ['description', /description|particulars|^item|goods/i],
  ['growth', /growth|^type$|nature/i],
];

/** Map header cells to columns: { carat: 3, color: 4, ... }, or null when the row is not a header. */
function headerColumns(row) {
  const columns = {};
  (row || []).forEach((cell, index) => {
    const label = oneLine(cell);
    if (!label || label.length > 40 || /^\d/.test(label)) return;
    const match = COLUMNS.find(([key, re]) => columns[key] === undefined && re.test(label));
    if (match) columns[match[0]] = index;
  });
  const keys = Object.keys(columns);
  const useful = columns.carat !== undefined || columns.reportNumber !== undefined;
  return keys.length >= 3 && useful ? columns : null;
}

function textCell(value) {
  const s = oneLine(value);
  return s ? s : null;
}

/** Stone lines from a spreadsheet ({ sheets: [{ name, rows }] }), using the header row to find each column. */
export function linesFromSheet(sheet) {
  const lines = [];
  for (const table of sheet?.sheets || []) {
    const rows = table.rows || [];
    const headerIndex = rows.slice(0, 30).findIndex((row) => headerColumns(row));
    if (headerIndex === -1) continue;
    const columns = headerColumns(rows[headerIndex]);
    const cell = (row, key) => (columns[key] === undefined ? null : row[columns[key]]);
    for (const row of rows.slice(headerIndex + 1)) {
      if (!row || !row.some((c) => oneLine(c))) continue;
      if (row.some((c) => /^\s*(?:sub\s*)?total\b/i.test(String(c ?? '')))) break;
      const reportRaw = oneLine(cell(row, 'reportNumber')).replace(/\s/g, '').toUpperCase();
      const reportNumber = /\d{5,}/.test(reportRaw) ? reportRaw : null;
      const carat = parseNumber(cell(row, 'carat'));
      if (carat === null && !reportNumber) continue;
      const description = textCell(cell(row, 'description'));
      const pieces = parseNumber(cell(row, 'pieces'));
      const lineNo = parseNumber(cell(row, 'lineNo'));
      lines.push({
        lineNo: Number.isInteger(lineNo) ? lineNo : lines.length + 1,
        description,
        reportNumber,
        lab: textCell(cell(row, 'lab'))?.toUpperCase() || (/^LG\d/.test(reportNumber || '') ? 'IGI' : null),
        shape: textCell(cell(row, 'shape')),
        carat,
        color: textCell(cell(row, 'color'))?.toUpperCase() || null,
        clarity: textCell(cell(row, 'clarity'))?.toUpperCase().replace(/\s/g, '') || null,
        pieces: Number.isInteger(pieces) ? pieces : null,
        rate: parseNumber(cell(row, 'rate')),
        amount: parseNumber(cell(row, 'amount')),
        growth: growthFrom(`${oneLine(cell(row, 'growth'))} ${description || ''}`, reportNumber),
        quote: row.map((c) => oneLine(c)).filter(Boolean).join(' ').slice(0, 160),
      });
    }
  }
  return lines;
}
