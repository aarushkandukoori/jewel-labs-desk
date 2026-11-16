// Small text helpers for the AI layer: dates, numbers, countries and loose string matching.
// Everything here is sync and pure, so the offline reader and the tests can use it directly.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/** Regex source for every date format parseDate understands. Wrap it in a group when you use it. */
export const DATE_PATTERN = [
  '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}', // 2026-10-22
  '\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}', // 22/10/2026, 22-10-26, 22.10.2026
  '\\d{1,2}(?:st|nd|rd|th)?[\\s\\-/.]*[A-Za-z]{3,9}\\.?[\\s\\-/.,]*\\d{2,4}', // 22 Oct 2026, 22-OCT-26
  '[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}', // October 22, 2026
].map((p) => `(?:${p})`).join('|');

/**
 * Turn a printed date into yyyy-mm-dd, or null.
 * Numeric dates are read day first (India, EU) unless usStyle is true. 22/10/2026 is always 22 October.
 */
export function parseDate(raw, { usStyle = false } = {}) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const year = fullYear(m[3]);
    if (a > 12) return isoDate(year, b, a); // only a day can be above 12
    if (b > 12) return isoDate(year, a, b); // month/day order
    return usStyle ? isoDate(year, a, b) : isoDate(year, b, a);
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([A-Za-z]{3,9})\.?[\s\-/.,]*(\d{2,4})(?!\d)/);
  if (m && monthNumber(m[2])) return isoDate(fullYear(m[3]), monthNumber(m[2]), +m[1]);
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/);
  if (m && monthNumber(m[1])) return isoDate(+m[3], monthNumber(m[1]), +m[2]);
  return null;
}

function monthNumber(word) {
  return MONTHS[String(word).toLowerCase()] || null;
}

// Two-digit years are this century: 26 means 2026.
function fullYear(text) {
  const n = Number(text);
  if (text.length === 4) return n;
  if (text.length === 2) return n < 70 ? 2000 + n : 1900 + n;
  return NaN;
}

/** Build yyyy-mm-dd, or null when the date does not exist (31 Feb). */
export function isoDate(year, month, day) {
  if (!(year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Every real date in the text, in order: [{ value: '2026-10-22', quote: '22/10/2026', index }]. */
export function findDates(text, options) {
  const re = new RegExp(`(?<![\\w.])(${DATE_PATTERN})(?!\\w)`, 'g');
  const found = [];
  for (const m of String(text || '').matchAll(re)) {
    const value = parseDate(m[1], options);
    if (value) found.push({ value, quote: m[1].trim(), index: m.index });
  }
  return found;
}

/**
 * Read a printed number: "2,49,503.13" (Indian grouping), "249,503.13", "1.234,56", "1,02", "US$ 1,250.00".
 * Returns a number or null.
 */
export function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const negative = /^-/.test(s);
  s = s.replace(/-/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) {
    const decimals = s.length - lastComma - 1;
    if (lastDot !== -1 || decimals <= 2) {
      // "1.234,56" or "1,02": the last comma is the decimal mark
      s = s.slice(0, lastComma).replace(/[.,]/g, '') + '.' + s.slice(lastComma + 1);
    } else {
      s = s.replace(/,/g, ''); // "2,49,503" or "1,234": commas only group digits
    }
  } else {
    s = s.replace(/,/g, '');
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, ''); // "1.234.567"
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Carats as a plain decimal string: "1.020" -> "1.02", "5,953.210" -> "5953.21". */
export function toCaratString(raw) {
  const n = parseNumber(raw);
  if (n === null) return null;
  return String(Number(n.toFixed(3)));
}

/** Money as a plain decimal string without separators: "2,49,503.13" -> "249503.13". */
export function toAmountString(raw) {
  const n = parseNumber(raw);
  if (n === null) return null;
  return String(Number(n.toFixed(2)));
}

// Countries that show up on diamond papers (mining, trading and EU). Longer names first so they win.
const COUNTRY_NAMES = [
  'Democratic Republic of the Congo', 'United States of America', 'Central African Republic', 'United Arab Emirates',
  'Russian Federation', 'United Kingdom', 'United States', 'South Africa', 'Sierra Leone', 'Saudi Arabia',
  'Czech Republic', "Côte d'Ivoire", "Cote d'Ivoire", 'Ivory Coast', 'New Zealand', 'South Korea', 'Hong Kong',
  'Sri Lanka', 'DR Congo', 'Netherlands', 'Switzerland', 'Luxembourg', 'Bangladesh', 'Kazakhstan', 'Mozambique',
  'Zimbabwe', 'Botswana', 'Tanzania', 'Cameroon', 'Thailand', 'Singapore', 'Malaysia', 'Indonesia', 'Mauritius',
  'Lithuania', 'Australia', 'Venezuela', 'Lesotho', 'Namibia', 'Liberia', 'Belgium', 'Germany', 'Armenia',
  'Belarus', 'Bulgaria', 'Croatia', 'Denmark', 'Estonia', 'Finland', 'Hungary', 'Ireland', 'Lebanon', 'Romania',
  'Slovakia', 'Slovenia', 'Czechia', 'Portugal', 'Türkiye', 'Turkey', 'Vietnam', 'Ukraine', 'Austria', 'Bahrain',
  'Kuwait', 'Mexico', 'Panama', 'Canada', 'Brazil', 'Guyana', 'Guinea', 'Angola', 'Russia', 'Israel', 'Cyprus',
  'Greece', 'France', 'Sweden', 'Poland', 'Norway', 'Taiwan', 'Latvia', 'Ghana', 'Congo', 'India', 'China',
  'Japan', 'Italy', 'Spain', 'Malta', 'Qatar', 'Oman', 'Togo', 'Korea', 'U.A.E.', 'U.A.E', 'U.S.A.', 'U.S.A',
  'UAE', 'USA', 'UK',
];
const COUNTRY_RE = new RegExp(
  `(?<![A-Za-z])(${COUNTRY_NAMES.map(escapeRegex).join('|')})(?![A-Za-z])`,
  'gi',
);

/** The first country named in the text, as printed, or null. */
export function findCountry(text) {
  const found = findCountries(text);
  return found.length ? found[0] : null;
}

/** Every country named in the text, as printed, without repeats. */
export function findCountries(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(COUNTRY_RE)) {
    const key = m[1].toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m[1]);
    }
  }
  return out;
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lower case, no whitespace, plain dashes and quotes. Used to check that a quote really is in a text. */
export function squash(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, '');
}

/** True when needle appears in haystack, ignoring case and spacing. */
export function containsLoose(haystack, needle) {
  const n = squash(needle);
  return n.length > 0 && squash(haystack).includes(n);
}

/** Collapse runs of spaces and trim. */
export function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Copy for people: no em dashes, and never says a paper was "filed" (the house or its broker lodges papers). */
export function plainCopy(text) {
  return String(text ?? '')
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2')
    .replace(/\s+[\u2013\u2014]\s+/g, ', ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\bfiled\b/gi, 'prepared')
    .trim();
}

/** Cut a long text to max characters, at a line break when one is close. */
export function capText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max);
  return s.slice(0, cut > max * 0.8 ? cut : max) + '\n[... text cut for length ...]';
}
