// Grading lab helpers: which lab issued a report, where to check it, and how to read the lab's answer.
//   detectLab(reportNumber, labHint) -> 'GIA' | 'IGI' | 'HRD' | 'GCAL' | null
//   reportCheckUrl(lab, reportNumber) -> the lab's own report-check page for that number
//   parseLabPage(lab, pageText)       -> the result fields read from the page text (parse.js)
//   compareLab(stone, parsed)         -> does the lab's record agree with our stone? (compare.js)
// The lookup itself runs in Electron (src/main/labs-window.js): a visible window opens the lab's page,
// the person solves any challenge the site shows, and the page text comes back here.
export { parseLabPage } from './parse.js';
export { compareLab, normalizeColor, normalizeClarity, shapeKey, normalizeGrowth } from './compare.js';

/**
 * The four labs we know. Checked on 2026-11-15:
 * - GIA: link format published on gia.edu/developer ("report-check?reportno={report number}").
 * - HRD: my.hrdantwerp.com reads record_number from the address (its page script lists it), and its
 *   "Find Diamond" box takes 10 to 13 letters or digits. Its reports carry 12-digit numbers.
 * - IGI and GCAL: both sites block automated checks, so we could not open them. The formats below are the
 *   ones their own result pages use in search engine listings (igi.org/Verify-Your-Report/?r=<number> and
 *   gcalusa.com/certificate-search.html?certificate_id=<number>). urlConfirmed is false for these two;
 *   if a link stops working, landingUrl is the lab's own report-check page.
 */
export const LABS = {
  GIA: {
    name: 'GIA',
    fullName: 'Gemological Institute of America',
    checkUrl: 'https://www.gia.edu/report-check?reportno=',
    landingUrl: 'https://www.gia.edu/report-check-landing',
    urlConfirmed: true,
  },
  IGI: {
    name: 'IGI',
    fullName: 'International Gemological Institute',
    checkUrl: 'https://www.igi.org/Verify-Your-Report/?r=',
    landingUrl: 'https://www.igi.org/Verify-Your-Report/',
    urlConfirmed: false,
  },
  HRD: {
    name: 'HRD',
    fullName: 'HRD Antwerp',
    checkUrl: 'https://my.hrdantwerp.com/?record_number=',
    landingUrl: 'https://my.hrdantwerp.com/',
    urlConfirmed: true,
  },
  GCAL: {
    name: 'GCAL',
    fullName: 'Gem Certification & Assurance Lab',
    checkUrl: 'https://www.gcalusa.com/certificate-search.html?certificate_id=',
    landingUrl: 'https://www.gcalusa.com/certificate-search.html',
    urlConfirmed: false,
  },
};

// Lab names as they appear on invoices and packing lists. Full names first: "International Gemological
// Institute" contains "Gemological Institute", which is also part of GIA's full name.
const LAB_NAME_PATTERNS = [
  ['IGI', /\bINTERNATIONAL\s+GEMOLOGICAL\s+INSTITUTE\b|\bIGI\b/],
  ['GIA', /\bGEMOLOGICAL\s+INSTITUTE\s+OF\s+AMERICA\b|\bGIA\b/],
  ['HRD', /\bHRD\b|\bHOGE\s+RAAD\s+VOOR\s+DIAMANT\b/],
  ['GCAL', /\bGCAL\b|\bGEM\s+CERTIFICATION\s*(?:&|AND)\s*ASSURANCE\b/],
];

/**
 * Which lab issued a report. The hint (a lab name from the papers) wins; then a lab name written in front
 * of the number ("GIA 2141438171"); then the number's shape:
 *   10 digits -> GIA, 12 digits -> HRD, 9 digits or "LG" + 8 to 10 digits -> IGI.
 * GCAL also uses 9 digits and "LG" numbers, so a GCAL report needs the hint. Other shapes -> null.
 */
export function detectLab(reportNumber, labHint) {
  const fromHint = labFromText(labHint);
  if (fromHint) return fromHint;
  const fromPrefix = labFromText(String(reportNumber ?? '').replace(/[\d\s.#:/-]+$/, ''));
  if (fromPrefix) return fromPrefix;

  const number = cleanReportNumber(reportNumber);
  if (/^\d{10}$/.test(number)) return 'GIA';
  if (/^\d{12}$/.test(number)) return 'HRD';
  if (/^\d{9}$/.test(number) || /^LG\d{8,10}$/.test(number)) return 'IGI';
  return null;
}

function labFromText(text) {
  const upper = String(text ?? '').toUpperCase();
  if (!upper.trim()) return null;
  for (const [lab, pattern] of LAB_NAME_PATTERNS) if (pattern.test(upper)) return lab;
  return null;
}

/**
 * "GIA No. 2141 438 171" -> "2141438171", "IGI LG-612345678" -> "LG612345678".
 * Keeps letters and digits, drops a lab name and "No." written in front.
 */
export function cleanReportNumber(reportNumber) {
  let text = String(reportNumber ?? '').toUpperCase();
  text = text.replace(/^\s*(?:GIA|IGI|HRD(?:\s+ANTWERP)?|GCAL)(?![A-Z])/, '');
  text = text.replace(/^\s*(?:REPORT|CERTIFICATE|CERT)?\s*(?:NO|NUMBER|NR|N°|#)?\.?\s*:?/, '');
  return text.replace(/[^A-Z0-9]/g, '');
}

/** The lab's own page for one report, or the lab's report-check page when there is no number. */
export function reportCheckUrl(lab, reportNumber) {
  const info = LABS[String(lab ?? '').toUpperCase()];
  if (!info) return null;
  const number = cleanReportNumber(reportNumber);
  if (!number) return info.landingUrl;
  return info.checkUrl + encodeURIComponent(number);
}
