// Small helpers for reading values out of document records.
// Values arrive as printed on the paper ("2,49,503.13", "05/11/2026", "EXP/26-27/28"),
// so every module that compares papers goes through these first.
// No Node imports: this file also runs in the browser demo.

/** The first field with this key that has a value, or null. */
export function getFieldInfo(doc, key) {
  if (!doc || !Array.isArray(doc.fields)) return null;
  for (const field of doc.fields) {
    if (field && field.key === key && hasValue(field.value)) return field;
  }
  return null;
}

/** The value of a field as printed (trimmed), or null. */
export function getField(doc, key) {
  const field = getFieldInfo(doc, key);
  return field ? String(field.value).trim() : null;
}

/** Every value printed for this key (a shipping bill can list two invoice numbers). */
export function getFieldValues(doc, key) {
  if (!doc || !Array.isArray(doc.fields)) return [];
  const values = [];
  for (const field of doc.fields) {
    if (field && field.key === key && hasValue(field.value)) values.push(String(field.value).trim());
  }
  return values;
}

/** The first value found for the key, trying documents in the order given. */
export function firstField(docs, key) {
  for (const doc of docs) {
    const value = getField(doc, key);
    if (value) return { value, doc };
  }
  return null;
}

export function hasValue(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

/** Lines of a document, always an array. */
export function docLines(doc) {
  return doc && Array.isArray(doc.lines) ? doc.lines.filter(Boolean) : [];
}

// ---------- numbers ----------

/**
 * Parse a number as printed on trade papers.
 * Indian "2,49,503.13", US "249,503.13", European "249.503,13", "1 234,5",
 * "USD 38,640.00", "0.51 ct", "5953.210 cts" all work. Returns null when there is no number.
 */
export function parseNumber(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (!hasValue(input)) return null;
  const text = String(input).replace(/[  ]/g, ' ');

  // Thousands written with spaces, like "1 234 567,89".
  const spaced = text.match(/-?\d{1,3}(?: \d{3})+(?:[.,]\d+)?/);
  // A number may start with its decimal point (".50 ct" is half a carat), but not right after a word: in "No.123"
  // and "Ct.1.02" the dot ends a label.
  const token = spaced ? spaced[0].replace(/ /g, '') : (text.match(/-?(?:\d|(?<![\w.])\.\d)[\d.,'’]*/) || [null])[0];
  if (!token) return null;

  let clean = token.replace(/['’]/g, '').replace(/[.,]+$/, '');
  const negative = clean.startsWith('-');
  clean = clean.replace(/^-/, '');

  const commas = (clean.match(/,/g) || []).length;
  const dots = (clean.match(/\./g) || []).length;

  if (commas && dots) {
    // Whichever separator comes last is the decimal point.
    if (clean.lastIndexOf(',') > clean.lastIndexOf('.')) clean = clean.replace(/\./g, '').replace(',', '.');
    else clean = clean.replace(/,/g, '');
  } else if (commas > 1) {
    clean = clean.replace(/,/g, ''); // 2,49,503 or 1,234,567
  } else if (commas === 1) {
    const [whole, part] = clean.split(',');
    // "1,234" is a thousand; "0,51" and "12,5" use a decimal comma.
    if (part.length === 3 && whole !== '0' && whole !== '') clean = whole + part;
    else clean = whole + '.' + part;
  } else if (dots > 1) {
    clean = clean.replace(/\./g, ''); // 1.234.567 (European thousands)
  }
  // A single dot is always a decimal point: carats are printed as 1.012.

  const value = Number(clean);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** 0.7 -> '0.70', 1.012 -> '1.012': carats print with two decimals, or three when the paper has three. */
export function formatCarat(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '';
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? n.toFixed(2) : String(round(n, 3));
}

/** ('USD', 38640) -> 'USD 38,640.00'. */
export function formatMoney(currency, value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '';
  const amount = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${amount}` : amount;
}

/** Round to a number of decimals without floating point noise (0.1 + 0.2 -> 0.3). */
export function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// Checked in order: HK$ must be tested before the plain $ of USD.
const CURRENCY_WORDS = [
  ['HKD', /\bHKD\b|HK\$/],
  ['USD', /\bUSD\b|US\s?\$|\$/],
  ['EUR', /\bEUR\b|€|\bEURO/],
  ['INR', /\bINR\b|₹|\bRS\.?\s|\bRUPEES?\b/],
  ['AED', /\bAED\b|\bDIRHAMS?\b/],
  ['GBP', /\bGBP\b|£/],
  ['ILS', /\bILS\b|\bNIS\b|₪/],
  ['CHF', /\bCHF\b/],
  ['JPY', /\bJPY\b|¥/],
  ['THB', /\bTHB\b/],
];

/** A three-letter currency code found in the text, or null. */
export function parseCurrency(input) {
  if (!hasValue(input)) return null;
  const text = String(input).toUpperCase();
  if (/^[A-Z]{3}$/.test(text.trim())) return text.trim();
  for (const [code, pattern] of CURRENCY_WORDS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

// ---------- dates ----------

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Parse a printed date into 'YYYY-MM-DD'. Trade papers from India and Europe write the day first
 * (05/11/2026 is 5 November), so day-first is the default. When the first number is a month and the
 * second cannot be (11/25/2026), the US order is used. Returns null when no date is found.
 */
export function parseDate(input) {
  if (!hasValue(input)) return null;
  if (input instanceof Date) return calendarDay(input);
  const text = String(input).trim().toUpperCase();

  // 2026-11-05 or 2026-11-05T10:00:00Z
  let m = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (m) return makeDate(+m[1], +m[2], +m[3]);

  // 05 NOV 2026, 5-Nov-26, 05.NOV.2026
  m = text.match(/\b(\d{1,2})(?:ST|ND|RD|TH)?[\s\-/.,]*([A-Z]{3,9})[\s\-/.,']*(\d{2,4})\b/);
  if (m && monthNumber(m[2])) return makeDate(fullYear(+m[3]), monthNumber(m[2]), +m[1]);

  // NOV 5, 2026 or NOVEMBER 05 2026
  m = text.match(/\b([A-Z]{3,9})[\s.]+(\d{1,2})(?:ST|ND|RD|TH)?,?\s+(\d{4})\b/);
  if (m && monthNumber(m[1])) return makeDate(+m[3], monthNumber(m[1]), +m[2]);

  // 05/11/2026, 05-11-26, 05.11.2026
  m = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const year = fullYear(+m[3]);
    if (a > 12 || b <= 12) return makeDate(year, b, a); // day first (default)
    return makeDate(year, a, b); // 11/25/2026: month first
  }
  return null;
}

/**
 * The calendar day of a moment as 'YYYY-MM-DD': in a time zone ('Asia/Kolkata') when one is given, else on the
 * computer's own clock. Never the UTC day, which is a day off near midnight in India or New York.
 */
export function calendarDay(date, timeZone = null) {
  const moment = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(moment.getTime())) return null;
  if (timeZone) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(moment).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch {
      // An unknown zone name: use the computer's own day.
    }
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

function monthNumber(word) {
  return MONTHS[word] || MONTHS[word.slice(0, 3)] || null;
}

// Two-digit years 70 to 99 are 1970 to 1999, so an old date ("05/11/99") never reads as one far ahead (2099),
// which would make an expired certificate look valid.
function fullYear(year) {
  if (year < 70) return 2000 + year;
  if (year < 100) return 1900 + year;
  return year;
}

function makeDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null; // 31 Feb
  return date.toISOString().slice(0, 10);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-05' -> '05 Nov 2026' for sentences. */
export function formatDate(iso) {
  const date = parseDate(iso);
  if (!date) return iso ? String(iso) : '';
  const [y, mo, d] = date.split('-');
  return `${d} ${MONTH_NAMES[Number(mo) - 1]} ${y}`;
}

// ---------- references ----------

const PLACEHOLDERS = new Set(['NA', 'NIL', 'NONE', 'TBA', 'TBD', 'NOTAPPLICABLE', 'UNKNOWN', 'PENDING']);

/**
 * Normalize a reference so the same number matches however it is printed:
 * "EXP/26-27/28", "exp 26-27/28" and "EXP-26-27-28" all become "EXP262728".
 */
export function normalizeRef(input) {
  if (!hasValue(input)) return '';
  return String(input)
    .toUpperCase()
    .trim()
    .replace(/^(NO|NUMBER|#)\s*[.:#]?\s*(?=\d)/, '') // "No. 7955006" -> "7955006"
    .replace(/[^A-Z0-9]/g, '');
}

/** True when a normalized ref is specific enough to link papers (has a digit, not a placeholder). */
export function isUsefulRef(norm, minLength = 4) {
  if (!norm || norm.length < minLength) return false;
  if (PLACEHOLDERS.has(norm)) return false;
  if (!/\d/.test(norm)) return false;
  if (/^0+$/.test(norm)) return false;
  return true;
}

// ---------- company names ----------

// Legal suffixes and filler words that do not tell two companies apart.
const NAME_NOISE = new Set([
  'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'LLC', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY',
  'FZCO', 'FZE', 'FZC', 'DMCC', 'BVBA', 'BV', 'NV', 'SA', 'SRL', 'SPA', 'AG', 'GMBH', 'PLC', 'PTE', 'PTY', 'THE',
  'AND', 'MS', 'OF', 'SAMPLE',
]);

/** Upper case, punctuation removed, legal suffixes dropped: "M/s. Kestrel Gems Pvt. Ltd." -> "KESTREL GEMS". */
export function normalizeName(input) {
  if (!hasValue(input)) return '';
  const tokens = String(input)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  // Join runs of single letters, so "B.V." becomes "BV" and "M/s" becomes "MS".
  const words = [];
  let initials = '';
  for (const token of tokens) {
    if (token.length === 1 && /[A-Z]/.test(token)) {
      initials += token;
      continue;
    }
    if (initials) words.push(initials);
    initials = '';
    words.push(token);
  }
  if (initials) words.push(initials);
  return words.filter((word) => !NAME_NOISE.has(word)).join(' ');
}

/** 0..1 similarity between two company names (word overlap, letter pairs, or one name inside the other). */
export function nameSimilarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const wordsX = new Set(x.split(' '));
  const wordsY = new Set(y.split(' '));
  const shared = [...wordsX].filter((word) => wordsY.has(word)).length;
  const jaccard = shared / new Set([...wordsX, ...wordsY]).size;

  // "KESTREL GEMS" inside "KESTREL GEMS INTERNATIONAL": same house, longer name.
  const smaller = wordsX.size <= wordsY.size ? wordsX : wordsY;
  const contained = smaller.size >= 2 && shared === smaller.size ? 0.9 : 0;

  // Letter pairs catch small spelling slips ("DIAMONTAIRE" / "DIAMONTAIR").
  const dice = letterPairSimilarity(x.replace(/ /g, ''), y.replace(/ /g, ''));
  return Math.max(jaccard, contained, dice);
}

/** True when two printed names are very likely the same company. */
export function namesMatch(a, b, threshold = 0.8) {
  return nameSimilarity(a, b) >= threshold;
}

function letterPairSimilarity(x, y) {
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const pairs = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const pair = x.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const pair = y.slice(i, i + 2);
    const count = pairs.get(pair) || 0;
    if (count > 0) {
      shared++;
      pairs.set(pair, count - 1);
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

// ---------- ids ----------

/** Short stable hash (FNV-1a) so the same inputs always give the same record id. */
export function shortHash(text) {
  let hash = 0x811c9dc5;
  const input = String(text);
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A second pass with a different seed gives 16 hex characters, plenty for one workspace.
  let hash2 = 0x01000193;
  for (let i = input.length - 1; i >= 0; i--) {
    hash2 ^= input.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x811c9dc5) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + hash2.toString(16).padStart(8, '0');
}
