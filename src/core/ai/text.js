// Small text helpers for the AI layer: dates, numbers, countries and loose string matching.
// Everything here is sync and pure, so the offline reader and the tests can use it directly.

import { parseDate, parseNumber } from '../rules/fields.js';

// Dates and numbers are read the same way everywhere in the app: by rules/fields.js.
export { parseDate, parseNumber };

/** Regex source for every date format parseDate understands. Wrap it in a group when you use it. */
export const DATE_PATTERN = [
  '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}', // 2026-10-22
  '\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}', // 22/10/2026, 22-10-26, 22.10.2026
  '\\d{1,2}(?:st|nd|rd|th)?[\\s\\-/.]*[A-Za-z]{3,9}\\.?[\\s\\-/.,]*\\d{2,4}', // 22 Oct 2026, 22-OCT-26
  '[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}', // October 22, 2026
].map((p) => `(?:${p})`).join('|');

/** Every real date in the text, in order: [{ value: '2026-10-22', quote: '22/10/2026', index }]. */
export function findDates(text) {
  const re = new RegExp(`(?<![\\w.])(${DATE_PATTERN})(?!\\w)`, 'g');
  const found = [];
  for (const m of String(text || '').matchAll(re)) {
    const value = parseDate(m[1]);
    if (value) found.push({ value, quote: m[1].trim(), index: m.index });
  }
  return found;
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
