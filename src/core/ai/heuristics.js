// Offline reader: pulls fields, stone lines and declarations out of plain text with regular expressions.
// Used when the AI is off (no key and no sign-in) and as a cross-check on the AI's answer.
// Cautious on purpose: every field it returns has confidence 0.6 or less, so people check what matters.
// Output has the same shape as AI.extract: { docType, summary, fields, lines, declarations }.

import { DOC_TYPE_LABELS } from '../types.js';
import {
  DATE_PATTERN, parseDate, findDates, parseNumber, toCaratString, toAmountString, findCountry, squash, oneLine,
} from './text.js';
import { linesFromText, linesFromSheet } from './stone-lines.js';
import { familyOf } from './classify.js';

export { parseStoneLine, linesFromText, linesFromSheet, growthFrom } from './stone-lines.js';

const LABELED = 0.6; // value printed right after its label
const NEARBY = 0.5; // value read from the lines under a label (addresses, countries)
const LOOSE = 0.45; // value recognised by its shape only

// Between a label and its value: a closing bracket, dot leaders ("Carat Weight ....... 1.02"), spaces,
// one of : - = and at most one line break.
// Between a label and its value: a colon, dots or a dash. OCR often reads the colon as "+", ";" or "©".
const SEP = '[)\\]]?[ \\t]*(?:[.…]{2,}[ \\t]*)?[:\\-–=+;©]?[ \\t]*\\.?[ \\t]*(?:\\r?\\n[ \\t]*)?';
const REF = '([A-Z0-9][A-Z0-9/\\-.]*\\d[A-Z0-9/\\-]*)'; // a reference with at least one digit
const DATE = `(${DATE_PATTERN})`;
const NUMBER = '((?:\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.\\d+)?)';
const MONEY = `(?:USD|US\\$|EUR|INR|AED|HKD|GBP|\\$|€|₹)?\\s*${NUMBER}`;
const LINE = '([^\\n]+)';
const hasDigit = (v) => /\d/.test(v);
const startsUpper = (v) => /^[A-Z0-9]/.test(v.trim()) && v.trim().length <= 90;

/**
 * Find "Label : value" anywhere in the text. The label must be whole words.
 * Returns { value, match } for the first value that passes accept(), or null.
 */
function findLabeled(text, label, value, accept = () => true) {
  const re = new RegExp(`(?<![A-Za-z])(?:${label})(?![A-Za-z])${SEP}${value}`, 'gi');
  for (const m of text.matchAll(re)) {
    if (m[1] && accept(m[1])) return { value: m[1].trim(), match: m[0] };
  }
  return null;
}

// A word that belongs to a label, like "Total", "Pkgs.", "No.of", or a small joining word.
function isLabelWord(word) {
  return /^[A-Z][a-z]/.test(word) || /^(?:of|and|&|no\.?|to|for|the|in)$/i.test(word);
}

/**
 * Tidy a value read to the end of its line. Two-column papers print the next label on the same line:
 * "SAMPLE DIAMOND BOURSE, K Total Pkgs. : 1" -> "SAMPLE DIAMOND BOURSE, K". Wide gaps also end the value.
 */
export function cleanValue(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).split(/\s{3,}|\t/)[0].trim();
  const colon = s.search(/\s?:/);
  if (colon > 0) {
    const words = s.slice(0, colon).trim().split(/\s+/);
    let cut = words.length;
    while (cut > 0 && words.length - cut < 3 && isLabelWord(words[cut - 1])) cut -= 1;
    if (cut > 0 && cut < words.length) s = words.slice(0, cut).join(' ');
  }
  s = s.replace(/^[\s:.\-–]+|[\s,;:\-–/]+$/g, '').replace(/\s+/g, ' ');
  s = s.replace(/(\))\s+[^\s\w(]?\w?$/, '$1'); // OCR specks after a closing bracket: "Ltd (SAMPLE) 5"
  return s || null;
}

function countryValue(raw) {
  const cleaned = cleanValue(raw);
  if (!cleaned) return null;
  return findCountry(cleaned) || (cleaned.length <= 40 ? cleaned : null);
}

// "Gross Wt(KGS) :5.150" -> "5.15 kg". The unit comes from the printed label; kilograms when none is printed.
function weightValue(raw, printed) {
  const n = parseNumber(raw);
  if (n === null) return null;
  const unit = /(?<![A-Za-z])(?:g|grams?|gms?)(?![A-Za-z])/i.test(printed) && !/kg/i.test(printed) ? 'g' : 'kg';
  return `${n} ${unit}`;
}

const CURRENCIES = { 'US$': 'USD', $: 'USD', '€': 'EUR', '₹': 'INR', '£': 'GBP' };
const CURRENCY_RE = /\b(USD|EUR|INR|AED|HKD|GBP|CHF|JPY|CNY|ILS|THB|SGD)\b|US\$|€|₹|£/;

function currencyIn(text) {
  const m = String(text || '').match(CURRENCY_RE);
  if (!m) return null;
  return { value: m[1] || CURRENCIES[m[0]] || m[0], quote: m[0] };
}

// Simple "Label : value" fields. [key, label, value pattern, how to normalize, families it applies to]
const SIMPLE_FIELDS = [
  // A factory record's own number is its rough lot and its own date the record date (it also prints the
  // supplier invoice and KP numbers and dates, which must not be taken for its own).
  ['doc.number', '(?:rough\\s+)?lot\\s*(?:no\\b\\.?|number|#)', REF, oneLine, ['factory']],
  ['doc.date', '(?:record|production|assortment|manufactur(?:ing|e)|polishing)\\s+date', DATE, parseDate, ['factory']],
  ['doc.date', '(?:date\\s+of\\s+issue|issue\\s+date)', DATE, parseDate, ['insurance']],
  ['invoice.number', '(?:commercial\\s+|export\\s+|tax\\s+|proforma\\s+)?inv(?:oice)?\\.?\\s*(?:no\\b\\.?|number|num|#)', REF, oneLine],
  ['invoice.date', 'inv(?:oice)?\\.?\\s*(?:date|dt)\\b\\.?', DATE, parseDate],
  ['po.number', '(?:p\\.?\\s?o\\.?|purchase\\s+order)\\s*(?:no\\b\\.?|number|#)', REF, oneLine],
  ['payment.terms', '(?:payment\\s+terms?|terms\\s+of\\s+payment|nature\\s+of\\s+payment)', LINE, cleanValue],
  ['shippingBill.number', '(?:s\\.?\\s?b\\.?|s\\s?/\\s?b|shipping\\s+bill)\\s*(?:no\\b\\.?|number)', '(\\d{5,8})', oneLine],
  ['shippingBill.date', '(?:s\\.?\\s?b\\.?|shipping\\s+bill)\\s*(?:no\\b\\.?|number)', `\\d{5,8}\\s*(?:/|dt\\.?|dated)\\s*(${DATE_PATTERN})`, parseDate],
  ['shippingBill.date', '(?:s\\.?\\s?b\\.?|shipping\\s+bill)\\s*date', DATE, parseDate],
  ['leo.date', '(?:LEO|let\\s+export\\s+order)\\s*(?:date|dt)\\b\\.?', DATE, parseDate],
  ['leo.number', 'LEO\\s*(?:no\\b\\.?|number)', '([A-Z0-9][A-Z0-9/\\-]*)', oneLine],
  ['billOfEntry.number', '(?:b\\.?\\s?e\\.?|bill\\s+of\\s+entry)\\s*(?:no\\b\\.?|number)', '(\\d{5,8})', oneLine],
  ['billOfEntry.date', '(?:b\\.?\\s?e\\.?|bill\\s+of\\s+entry)\\s*date', DATE, parseDate],
  // "MAWB / HAWB No. : 176-12345678 / 99000012345": both numbers under one label.
  ['awb.mawb', 'm\\.?a\\.?w\\.?b\\.?\\s*/\\s*h\\.?a\\.?w\\.?b\\.?\\s*(?:no\\b\\.?|number|#)?', '(\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4})',
    (v) => { const d = v.replace(/\D/g, ''); return `${d.slice(0, 3)}-${d.slice(3)}`; }],
  ['awb.hawb', 'm\\.?a\\.?w\\.?b\\.?\\s*/\\s*h\\.?a\\.?w\\.?b\\.?\\s*(?:no\\b\\.?|number|#)?',
    '(?:\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4})\\s*/\\s*([A-Z0-9]{5,20})', (v) => v.toUpperCase()],
  ['awb.mawb', '(?:m\\.?a\\.?w\\.?b\\.?|master\\s+air\\s*way\\s*bill)(?:\\s*/\\s*mbl)?\\s*(?:no\\b\\.?|number|#)?',
    '(\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4})', (v) => { const d = v.replace(/\D/g, ''); return `${d.slice(0, 3)}-${d.slice(3)}`; }],
  ['awb.mawb', '(?:awb|air\\s*way\\s*bill)\\s*(?:no\\b\\.?|number|#)', '(\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4})',
    (v) => { const d = v.replace(/\D/g, ''); return `${d.slice(0, 3)}-${d.slice(3)}`; }],
  ['awb.hawb', '(?:h\\.?a\\.?w\\.?b\\.?|house\\s+air\\s*way\\s*bill)(?:\\s*/\\s*hbl)?\\s*(?:no\\b\\.?|number|#)?',
    '([A-Z]{0,4}[\\s-]?\\d[A-Z0-9]{2,19}(?:\\s?/\\s?[A-Z0-9]{3,20})?)', (v) => v.replace(/\s*\/\s*/g, '/').toUpperCase()],
  ['awb.flight', '(?:flight|flt)\\.?\\s*(?:no\\b\\.?|number)?(?:\\s*(?:and|&|/)\\s*date)?', '([A-Z0-9]{2}\\s?\\d{2,4}[A-Z]?)',
    (v) => v.replace(/\s/g, '').toUpperCase()],
  ['awb.date', '(?:executed\\s+on|flight\\s+date|awb\\s+date|date\\s+of\\s+issue)', DATE, parseDate, ['air_waybill']],
  ['awb.route', '(?:route|routing)', LINE, cleanValue, ['air_waybill', 'insurance']],
  ['kp.certificateNumber', '(?:KP|kimberley\\s+process)\\s*(?:certificate|cert\\b\\.?)?\\s*(?:no\\b\\.?|number|#)?',
    '([A-Z]{2}[\\s-]?[A-Z0-9][A-Z0-9/\\-]{3,20})', oneLine],
  ['kp.certificateNumber', '(?:certificate|cert\\b\\.?)\\s*(?:no\\b\\.?|number|#)', '([A-Z]{2}[\\s-]?[A-Z0-9][A-Z0-9/\\-]{3,20})',
    oneLine, ['kp']],
  ['kp.countriesOfMining', 'countr(?:y|ies)\\s+of\\s+mining', LINE, cleanValue],
  ['kp.countriesOfMining', 'countr(?:y|ies)\\s+of\\s+(?:origin|provenance)', LINE, cleanValue, ['kp']],
  ['kp.exportingCountry', '(?:exporting\\s+country|country\\s+of\\s+export(?:ation)?)', LINE, countryValue, ['kp']],
  ['kp.importingCountry', '(?:importing\\s+country|country\\s+of\\s+(?:import(?:ation)?|destination))', LINE, countryValue, ['kp']],
  ['kp.issueDate', '(?:date\\s+of\\s+issue|issue\\s+date|issued\\s+on|date\\s+issued)', DATE, parseDate, ['kp']],
  ['kp.expiryDate', '(?:date\\s+of\\s+expiry|expiry\\s+date|expiration\\s+date|valid\\s+until|expires?(?:\\s+on)?)', DATE, parseDate, ['kp']],
  ['kp.carats', '(?:carat\\s+weight|total\\s+carats?|carats?)', NUMBER, toCaratString, ['kp']],
  ['kp.value', '(?:value(?:\\s+in)?(?:\\s*\\(?\\s*(?:USD|US\\$)\\s*\\)?)?)', MONEY, toAmountString, ['kp']],
  ['exporter.taxId', '(?:IEC(?:\\s*(?:no|code))?|import\\s*[-/]?\\s*export\\s+code|GSTIN|GST\\s*(?:no|id|number)|tax\\s*id|VAT\\s*(?:no|number)|EORI(?:\\s*no)?|BIN\\s*no)\\.?',
    '([A-Z0-9]{8,20})', (v) => v.toUpperCase()],
  ['carrier.name', '(?:issuing\\s+carrier(?:\'s)?\\s+name(?:\\s+and\\s+city)?|carrier|airline|courier)', LINE, cleanValue],
  ['broker.name', '(?:CHA|customs\\s+(?:house\\s+)?(?:agent|broker)|clearing\\s+agent)', LINE,
    (v) => cleanValue(String(v).replace(/^[A-Z0-9]{10,}\s+/, ''))],
  ['insurer.name', '(?:insurer|underwriters?|insurance\\s+company)', LINE, cleanValue],
  ['insurance.policyNumber', 'policy\\s*(?:no\\b\\.?|number|#)', '([A-Z0-9][A-Z0-9/\\-]{4,40})', oneLine, ['insurance']],
  ['insurance.insuredValue', '(?:insured\\s+value|sum\\s+insured|valued(?:\\s+at)?|insured\\s+amount|amount\\s+insured)', MONEY,
    toAmountString, ['insurance']],
  ['goods.totalPieces', '(?:total\\s*(?:no\\.?\\s*of\\s*)?(?:pcs|pieces|stones|diamonds)|no\\.?\\s*of\\s*(?:pcs|pieces|stones))',
    '(\\d[\\d,]*)(?![.\\d])', (v) => String(parseNumber(v))],
  ['goods.totalCarats', '(?:total\\s*(?:carats?|cts?|carat\\s+weight|weight\\s*\\(?\\s*cts?\\s*\\)?)|carats?\\s+total)', NUMBER, toCaratString],
  ['goods.totalValue', '(?:(?:grand\\s+)?total\\s*(?:invoice\\s+)?(?:value|amount)|invoice\\s+value|inv\\.?\\s*val(?:ue)?|total\\s+(?:fob|cif|cfr)(?:\\s+value)?|(?:fob|cif)\\s+value)(?:\\s*\\(?\\s*(?:in\\s+)?(?:USD|US\\$|EUR|INR|AED|HKD)\\s*\\)?)?',
    MONEY, toAmountString],
  ['goods.countryOfOrigin', 'country\\s+of\\s+origin(?:\\s+of\\s+goods)?', LINE, countryValue,
    ['invoice', 'packing_list', 'customs', 'air_waybill', 'insurance', 'declaration', 'factory', 'other']],
  ['goods.destinationCountry', '(?:country\\s+of\\s+(?:final\\s+)?dest(?:ination)?\\.?|final\\s+destination|destination\\s+country)', LINE, countryValue],
  ['goods.portOfLoading', '(?:port\\s+of\\s+loading|airport\\s+of\\s+departure)', LINE, cleanValue],
  ['goods.portOfDischarge', '(?:port\\s+of\\s+discharge|airport\\s+of\\s+destination)', LINE, cleanValue],
  ['goods.grossWeight', 'gross\\s*w(?:eigh)?t\\.?(?:\\s*\\(?\\s*(?:kgs?|grams?|gms?)\\s*\\)?)?', NUMBER, weightValue],
  ['goods.netWeight', 'net\\s*w(?:eigh)?t\\.?(?:\\s*\\(?\\s*(?:kgs?|grams?|gms?)\\s*\\)?)?', NUMBER, weightValue],
  ['goods.description', '(?:description\\s+of\\s+goods|goods\\s+description|insured\\s+interest|nature\\s+of\\s+goods)', LINE, cleanValue],
  // Grading report fields
  ['lab.reportNumber', '(?:(?:GIA|IGI|HRD)\\s+)?(?:report|certificate|cert\\b\\.?|dossier)\\s*(?:no\\b\\.?|number|#)',
    '(LG\\s?\\d{6,12}|[A-Z]{0,3}\\d{6,12})', (v) => v.replace(/\s/g, '').toUpperCase(), ['lab_report']],
  ['lab.reportDate', '(?:report\\s+date|date\\s+of\\s+(?:report|issue|examination)|date)', DATE, parseDate, ['lab_report']],
  ['lab.shape', '(?:shape\\s*(?:and|&)\\s*cutting\\s+style|shape\\s*/\\s*cut|shape)', '([A-Za-z][A-Za-z \\-]{2,40})', cleanValue, ['lab_report']],
  ['lab.carat', '(?:carat\\s+weight|weight|carat)', '(\\d{1,3}\\.\\d{1,3})', toCaratString, ['lab_report']],
  ['lab.color', '(?:colou?r\\s+grade|colou?r)', '([D-Z](?:\\s*[-–/]\\s*[D-Z])?(?![A-Za-z])|fancy[^\\n]{0,40})',
    (v) => (/^fancy/i.test(v) ? cleanValue(v) : v.replace(/\s/g, '').toUpperCase()), ['lab_report']],
  ['lab.clarity', '(?:clarity\\s+grade|clarity)', '(FL|IF|VVS\\s?[12]|VS\\s?[12]|SI\\s?[123]|I\\s?[123])(?![A-Za-z0-9])',
    (v) => v.replace(/\s/g, '').toUpperCase(), ['lab_report']],
  ['lab.cut', '(?:cut\\s+grade|cut)', '(excellent|very\\s+good|good|fair|poor|ideal|EX|VG|GD|ID)(?![A-Za-z])', oneLine, ['lab_report']],
  ['lab.polish', 'polish', '(excellent|very\\s+good|good|fair|poor|EX|VG|GD)(?![A-Za-z])', oneLine, ['lab_report']],
  ['lab.symmetry', 'symmetry', '(excellent|very\\s+good|good|fair|poor|EX|VG|GD)(?![A-Za-z])', oneLine, ['lab_report']],
  ['lab.fluorescence', 'fluorescence',
    '(very\\s+strong(?:\\s+blue)?|strong(?:\\s+blue)?|medium(?:\\s+blue)?|faint|none|negligible|nil|NON|FNT|MED|STG|VST)(?![A-Za-z])',
    oneLine, ['lab_report']],
  ['lab.measurements', 'measurements?', '(\\d+\\.\\d+\\s*[-–x×]\\s*\\d+\\.\\d+\\s*[x×]\\s*\\d+\\.\\d+(?:\\s*mm)?)', oneLine, ['lab_report']],
  ['lab.inscription', '(?:laser\\s+)?inscriptions?(?:\\(s\\))?', LINE, cleanValue, ['lab_report']],
  ['doc.number', '(?:document|doc|ref(?:erence)?|serial|packing\\s+list|certificate)\\.?\\s*(?:no\\b\\.?|number|#)?', REF, oneLine],
];

// Values whose text must contain a digit to count (so a word is never taken for a number),
// and names that must look like names ("underwriters to give the confirmation" is not an insurer).
const NEEDS_DIGIT = new Set([
  'invoice.number', 'po.number', 'kp.certificateNumber', 'exporter.taxId', 'insurance.policyNumber', 'doc.number',
  'lab.reportNumber', 'awb.hawb', 'awb.flight', 'leo.number',
]);
const NEEDS_NAME = new Set(['insurer.name', 'carrier.name', 'broker.name']);
// The paper's own number and date, by family (a shipping bill also prints the invoice number).
const MAIN_NUMBER = {
  factory: [],
  customs: ['shippingBill.number', 'billOfEntry.number', 'invoice.number'],
  air_waybill: ['awb.hawb', 'awb.mawb'],
  kp: ['kp.certificateNumber'],
  lab_report: ['lab.reportNumber'],
  insurance: ['insurance.policyNumber'],
  other: ['invoice.number', 'shippingBill.number', 'billOfEntry.number', 'awb.hawb', 'awb.mawb', 'kp.certificateNumber',
    'lab.reportNumber', 'insurance.policyNumber', 'po.number'],
};
const MAIN_DATE = {
  factory: [],
  customs: ['shippingBill.date', 'billOfEntry.date', 'leo.date', 'invoice.date'],
  air_waybill: ['awb.date'],
  kp: ['kp.issueDate'],
  lab_report: ['lab.reportDate'],
  other: ['invoice.date', 'shippingBill.date', 'billOfEntry.date', 'kp.issueDate', 'lab.reportDate', 'awb.date', 'leo.date'],
};
const mainKeys = (table, family) => table[family] || table.other;

// ---------------------------------------------------------------- parties

const PARTY_LABELS = [
  ['exporter', /^(?:\d+[.)]\s*)?(?:manufacturers?\s*(?:&|and)\s*exporters?|exporter|shipper|consignor|seller)(?:'?s)?(?:\s+details|\s+name(?:\s+(?:and|&)\s+address)?)?(?![A-Za-z])/i],
  ['consignee', /^(?:\d+[.)]\s*)?(?:consignee|ship\s+to|deliver(?:ed)?\s+to)(?:'?s)?(?:\s+details|\s+name(?:\s+(?:and|&)\s+address)?)?(?![A-Za-z])/i],
  ['buyer', /^(?:\d+[.)]\s*)?(?:buyer|sold\s+to|bill\s+to|importer|purchaser)(?:'?s)?(?:\s*\(if\s+other\s+than\s+consignee\))?(?:\s+details|\s+name(?:\s+(?:and|&)\s+address)?)?(?![A-Za-z])/i],
  ['supplier', /^(?:\d+[.)]\s*)?(?:supplier|vendor)(?:'?s)?(?:\s+details|\s+name(?:\s+(?:and|&)\s+address)?)?(?![A-Za-z])/i],
];
// "Exporter's Ref", "Shipper's Account Number": a label that is not a party.
const NOT_A_PARTY = /^\s*[:\-]?\s*(?:ref|reference|code|no\b|number|iec|gst|pan|account|a\/c|bank|tax|vat|eori|signature|stamp|seal)/i;
// Lines in a party block that are IDs or contact details, not the name or address.
const ID_LINE = /^(?:[\W\d]*|[A-Z0-9]{8,}\W*(?:\(\s*\))?\W*|(?:IEC|GSTIN|GST|PAN|BIN|TEL|PHONE|FAX|E-?MAIL|MOB(?:ILE)?|CONTACT|BRANCH|VAT|EORI|CODE|A\/C|ACCOUNT)\b.*)$/i;
// Lines that start another part of the paper, so the address has ended.
const NEXT_SECTION = /^(?:port|invoice|inv\b|date|country\s+of\s+dest|total|gross|net|marks|nature|terms|payment|description|notify|pre-carriage|vessel|flight|awb|hawb|mawb|sb\s+no|leo|bank|swift|policy|reference)\b/i;

const isPartyLabel = (s) => PARTY_LABELS.some(([, re]) => re.test(s));

// Table columns are split by tabs (the ingest text layer) or by wide gaps (OCR and pasted text).
const cellsOf = (line) => String(line || '').split(/\t+|\s{3,}/).map((c) => c.trim()).filter(Boolean);

/** Name, address and country from the label's own text (inline) and the cells under it, one per line. */
function readParty(inline, cells) {
  const block = [];
  if (inline && /[A-Za-z]{2}/.test(inline) && !isPartyLabel(inline)) block.push(inline);
  for (const cell of cells) {
    if (!cell) {
      if (block.length) break;
      continue;
    }
    if (isPartyLabel(cell) || NEXT_SECTION.test(cell)) break;
    // A table row or another "Label: value" line means the address is over.
    if (/\|.*\|/.test(cell) || (block.length && /^[^:]{1,40}:/.test(cell))) break;
    block.push(cell);
    if (block.length >= 5) break;
  }
  const useful = block.map(cleanValue).filter((line) => line && !ID_LINE.test(line));
  if (!useful.length) return null;
  let [name, ...address] = useful;
  // Name and address on one line: "ABC GEMS LLP, 12 Diamond Market, Mumbai" or "ABC GEMS LLP, Surat, India".
  const comma = name.indexOf(',');
  if (!address.length && comma > 0) {
    const rest = name.slice(comma + 1).trim();
    if (/\d/.test(rest) || findCountry(rest)) {
      address = [rest];
      name = name.slice(0, comma).trim();
    }
  }
  address = address.slice(0, 3);
  return { name, address: address.length ? address.join(', ') : null, addressQuote: address[0] || null,
    country: address.length ? findCountry(address.join(' ')) : null };
}

/**
 * Exporter, consignee, buyer and supplier blocks: { exporter: { name, address, country }, ... }.
 * A label can sit in the left or the right column ("EXPORTER DETAILS <gap> CONSIGNEE"). A left label reads
 * the first cell of the lines under it; a right label reads the last cell of lines that have two or more.
 */
export function findParties(text) {
  const lines = String(text || '').split(/\r?\n/);
  const found = {};
  lines.forEach((line, i) => {
    const cells = cellsOf(line);
    cells.forEach((cell, k) => {
      const label = PARTY_LABELS.find(([party, re]) => !found[party] && re.test(cell));
      if (!label) return;
      const [party, re] = label;
      const rest = cell.slice(cell.match(re)[0].length).replace(/^\s*\([^)]*\)/, ''); // drop "(Name & Address)"
      // A party label stands alone or is followed by a colon. "EXPORTER COPY" or "Exporter declares..." is not one.
      if (NOT_A_PARTY.test(rest) || (rest.trim() && !/^\s*[:\-–]/.test(rest))) return;
      const right = k > 0;
      const column = lines.slice(i + 1, i + 9).map((next) => {
        const c = cellsOf(next);
        if (!right) return c[0] || '';
        return c.length >= 2 ? c[c.length - 1] : '';
      });
      // "Exporter:<tab>ABC GEMS LLP": the name can be the next cell on the label's own line.
      const nextCell = cells[k + 1];
      const sameLine = nextCell && !isPartyLabel(nextCell) && !NEXT_SECTION.test(nextCell) && !/^[^:]{1,40}:/.test(nextCell)
        ? nextCell : null;
      const inline = cleanValue(rest.replace(/^\s*[:\-–]\s*/, '')) || sameLine;
      const info = readParty(inline, column);
      if (info) found[party] = info;
    });
  });
  return found;
}

// ---------------------------------------------------------------- goods

/** HS code: a labelled one first, otherwise a diamond chapter code printed with a dot or as 8 digits. */
function findHsCode(text) {
  const labeled = findLabeled(text, '(?:ITC[\\s-]*)?(?:HS|HSN|H\\.S\\.|RITC)\\s*(?:code|no\\b\\.?|classification)?|tariff\\s*(?:code|item|heading)?',
    '(\\d{4}[\\s.]?\\d{2}(?:[\\s.]?\\d{2})?)');
  if (labeled) return { value: labeled.value.replace(/\D/g, ''), quote: labeled.value, confidence: LABELED };
  const loose = String(text).match(/(?<![\d.])(71(?:02|04|13)(?:\.\d{2}(?:\.?\d{2})?|\d{4}))(?![\d])/);
  if (loose) return { value: loose[1].replace(/\D/g, ''), quote: loose[1], confidence: LOOSE };
  return null;
}

/** Natural or lab-grown, only with evidence. Contradicting evidence gives null so a person decides. */
function findNature(text, hs) {
  const labWords = String(text).match(/\b(CVD|HPHT|lab[\s-]?grown|laboratory[\s-]grown|LGD)\b/i);
  const naturalWords = String(text).match(/\bnatural\s+(?:polished\s+|cut\s+(?:&|and)\s+polished\s+|rough\s+)?diamonds?\b/i);
  const hsSays = hs?.value.startsWith('7104') ? 'lab-grown' : hs?.value.startsWith('7102') ? 'natural' : null;
  const wordsSay = labWords && !naturalWords ? 'lab-grown' : naturalWords && !labWords ? 'natural' : null;
  if (hsSays && wordsSay && hsSays !== wordsSay) return null;
  if (wordsSay) return { value: wordsSay, quote: (labWords || naturalWords)[0] };
  if (hsSays) return { value: hsSays, quote: hs.quote };
  return null;
}

function findForm(text, hs) {
  const code = hs?.value || '';
  if (/^7113/.test(code)) return { value: 'jewelry', quote: hs.quote };
  if (/^(?:710210|710221|710231|710421)/.test(code)) return { value: 'rough', quote: hs.quote };
  if (/^(?:710239|710491)/.test(code)) return { value: 'polished', quote: hs.quote };
  const polished = String(text).match(/cut\s*(?:&|and)\s*polished|\bpolished\b/i);
  const rough = String(text).match(/\brough\b/i);
  const jewelry = String(text).match(/\b(?:studded|gold|silver|platinum|diamond)\s+jewel(?:le)?ry\b(?!\s+services)/i);
  if (jewelry) return { value: 'jewelry', quote: jewelry[0] };
  if (polished && !rough) return { value: 'polished', quote: polished[0] };
  if (rough && !polished) return { value: 'rough', quote: rough[0] };
  return null;
}

/**
 * "TOTAL 12 15.230 45,678.90": pieces, carats and value from a totals row.
 * A word just before a number ("CARATS 3.74", "PCS 3", "USD 1,250.00") says what it is; otherwise
 * the order and decimals do: whole number = pieces, last number with 2 decimals = value, other decimal = carats.
 */
function findTotalsRow(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = oneLine(raw);
    if (!/^\W*(?:grand\s+)?total\b/i.test(line) || /pkgs?|packages|duty|tax|weight|\bwt\b/i.test(line)) continue;
    const nums = [...line.matchAll(/(?<![\w.,])(\d[\d,]*(?:\.\d+)?)(?![\w]|[.,]\d)/g)].map((m) => {
      const before = line.slice(Math.max(0, m.index - 14), m.index);
      let kind = null;
      if (/carats?|cts?\b|crt/i.test(before)) kind = 'carats';
      else if (/pcs|pieces|stones|qty/i.test(before)) kind = 'pieces';
      else if (/amount|value|usd|us\$|\$|eur|inr|€|₹/i.test(before)) kind = 'value';
      return { raw: m[1], value: parseNumber(m[1]), decimals: m[1].includes('.') ? m[1].split('.')[1].length : 0, kind };
    });
    if (!nums.length) continue;
    const free = nums.filter((n) => !n.kind);
    const looksLikeMoney = (n) => n.decimals === 2 && (free.length > 1 || n.raw.includes(',') || CURRENCY_RE.test(line));
    const money = nums.find((n) => n.kind === 'value') || [...free].reverse().find(looksLikeMoney);
    const pieces = nums.find((n) => n.kind === 'pieces') || (free.length > 1 ? free.find((n) => n.decimals === 0 && !n.raw.includes(',')) : null);
    const carats = nums.find((n) => n.kind === 'carats') || free.find((n) => n.decimals > 0 && n !== money);
    return { pieces: pieces || null, carats: carats || null, value: money || null };
  }
  return null;
}

function findLabName(text) {
  const checks = [
    ['GIA', /gemological\s+institute\s+of\s+america|\bGIA\b/i],
    ['IGI', /international\s+gemological\s+institute|\bIGI\b/i],
    ['HRD', /\bHRD\b(?:\s+antwerp)?/i],
    ['GCAL', /\bGCAL\b/i],
    ['GSI', /gemological\s+science\s+international|\bGSI\b/i],
  ];
  for (const [value, re] of checks) {
    const m = String(text).match(re);
    if (m) return { value, quote: m[0] };
  }
  // Any other lab prints its name near the top: "Northbridge Gem Laboratory (SAMPLE)", "... Gemological Laboratory".
  const lab = /([A-Z][A-Za-z&.'-]*(?:[ \t]+[A-Z][A-Za-z&.'-]*){0,4}[ \t]+(?:Gem(?:ological)?[ \t]+)?(?:Laboratory|Laboratories|Lab)\b(?:[ \t]*\(SAMPLE\))?)/i;
  const other = String(text).split(/\r?\n/).slice(0, 8).map((line) => line.match(lab)).find(Boolean);
  if (other) {
    const name = other[1].trim();
    // Printed in capitals on the report: shown in title case so it reads like a name.
    const shown = name === name.toUpperCase() ? name.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\(Sample\)/, '(SAMPLE)') : name;
    return { value: shown, quote: name };
  }
  return null;
}

// ---------------------------------------------------------------- declarations

const DECLARATION_TOPIC = /conflict[\s-]?free|legitimate\s+sources|russia|kimberley|herein\s+invoiced|system\s+of\s+warrant|not\s+been\s+(?:mined|produced)|origin/i;
const DECLARATION_VERB = /hereby|declare|guarantee|certif(?:y|ies)|confirm|warrant|have\s+been\s+purchased|not\s+(?:been|of)\b/i;

/** Declaration sentences (System of Warranties, "not of Russian origin"...), copied as printed. */
export function findDeclarations(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+(?=[A-Z"“])/);
  const out = [];
  for (const raw of sentences) {
    // A sentence can start right after a table row or a "Label: value" line; drop those lines first.
    const lines = raw.split(/\r?\n/);
    while (lines.length > 1 && (!/[a-z]{3,}\s+[a-z]{3,}/.test(lines[0]) || /^[^:]{1,40}:\s*\S/.test(lines[0]))) lines.shift();
    const sentence = oneLine(lines.join(' '));
    if (sentence.length < 40 || sentence.length > 700) continue;
    if (DECLARATION_TOPIC.test(sentence) && DECLARATION_VERB.test(sentence) && !out.includes(sentence)) out.push(sentence);
  }
  return out.slice(0, 10);
}

// ---------------------------------------------------------------- the reader

const FAMILIES_WITH_LINES = ['invoice', 'packing_list', 'customs', 'factory', 'other'];

/**
 * Read a document's text without AI.
 * text: the text layer or OCR text (pages may be split with \f); pageTexts: optional text per page;
 * sheet: optional spreadsheet ({ sheets: [{ name, rows }] }) for exact table columns.
 */
export function readDocument({ text = '', pageTexts = null, docType = 'other', sheet = null } = {}) {
  const pages = Array.isArray(pageTexts) && pageTexts.length ? pageTexts.map((p) => String(p || '')) : String(text || '').split('\f');
  const full = pages.join('\n');
  // Spreadsheet text from ingest ("Sheet: name" then tab-separated rows) still has its columns: rebuild the rows.
  if (!sheet && /^Sheet: /m.test(full)) sheet = sheetFromText(full);
  const family = familyOf(docType);
  const fields = [];
  const has = (key) => fields.some((f) => f.key === key);
  const add = (key, value, quote, confidence) => {
    if (value === null || value === undefined || value === '' || has(key)) return;
    fields.push({ key, value: String(value), quote: quote ? oneLine(quote) : null, page: null, confidence });
  };

  for (const [key, label, value, normalize, families] of SIMPLE_FIELDS) {
    if (has(key) || (families && !families.includes(family))) continue;
    const accept = NEEDS_DIGIT.has(key) ? hasDigit : NEEDS_NAME.has(key) ? startsUpper : undefined;
    const found = findLabeled(full, label, value, accept);
    if (!found) continue;
    // Values read to the end of the line are tidied; short values are quoted exactly as printed.
    const normalized = normalize(found.value, found.match);
    let quote = found.value;
    if (value === LINE) quote = normalized && squash(found.value).includes(squash(normalized)) ? normalized : cleanValue(found.value);
    add(key, normalized, quote, LABELED);
  }

  const parties = findParties(full);
  for (const [party, info] of Object.entries(parties)) {
    // On a supplier's invoice the seller is the supplier; on a KP certificate the importer is the consignee.
    let target = party;
    if (docType === 'supplier_invoice' && party === 'exporter') target = 'supplier';
    if (family === 'kp' && party === 'buyer' && !parties.consignee) target = 'consignee';
    add(`${target}.name`, info.name, info.name, LABELED);
    add(`${target}.address`, info.address, info.addressQuote, NEARBY);
    add(`${target}.country`, info.country, info.country, NEARBY);
  }

  const hs = findHsCode(full);
  if (hs) add('goods.hsCode', hs.value, hs.quote, hs.confidence);
  const nature = findNature(full, hs);
  if (nature) add('goods.nature', nature.value, nature.quote, NEARBY);
  const form = findForm(full, hs);
  if (form) add('goods.form', form.value, form.quote, NEARBY);

  const totals = findTotalsRow(full);
  if (totals?.pieces) add('goods.totalPieces', String(totals.pieces.value), totals.pieces.raw, LOOSE);
  if (totals?.carats) add('goods.totalCarats', toCaratString(totals.carats.value), totals.carats.raw, LOOSE);
  if (totals?.value) add('goods.totalValue', toAmountString(totals.value.value), totals.value.raw, LOOSE);
  const totalField = fields.find((f) => f.key === 'goods.totalValue');
  const around = totalField?.quote ? full.slice(Math.max(0, full.indexOf(totalField.quote) - 40), full.indexOf(totalField.quote) + 60) : '';
  const currency = currencyIn(around) || currencyIn(full);
  if (currency) add('goods.currency', currency.value, currency.quote, around && currencyIn(around) ? LABELED : LOOSE);

  const incoterm = findLabeled(full, '(?:incoterms?(?:\\s*2020)?|terms\\s+of\\s+delivery|delivery\\s+terms|price\\s+terms)',
    '(?:[^\\n]*?)\\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\\b');
  if (incoterm) add('goods.incoterm', incoterm.value.toUpperCase(), incoterm.value, LABELED);

  if (!has('goods.description')) {
    const m = full.match(/[^\n]{0,60}\b(?:cut\s*(?:&|and)\s*polished|polished|rough|lab[\s-]*grown|natural)\b[^\n]{0,40}\bdiamonds?\b[^\n]{0,30}/i);
    // Drop a code printed in front, as in "ITC(HS) 71023910 CUT AND POLISHED NATURAL DIAMONDS".
    const description = m ? cleanValue(m[0].replace(/^.*?\b\d{4}[.\d]*\s+(?=[A-Za-z])/, '')) : null;
    if (description) add('goods.description', description, description, LOOSE);
  }
  if (family === 'lab_report') {
    const lab = findLabName(full);
    if (lab) add('lab.name', lab.value, lab.quote, LABELED);
    const report = full.match(/(?<![\w.])(LG\d{9}|\d{10}|\d{9})(?![\w.])/);
    if (report) add('lab.reportNumber', report[1].toUpperCase(), report[1], LOOSE);
    // OCR can cut the last digits off the labelled number; the full number is usually printed again
    // (inscription, QR link), so a longer number that starts with it wins.
    const labelled = fields.find((f) => f.key === 'lab.reportNumber');
    const longer = labelled && [...full.matchAll(/(?<!\d)\d{9,12}(?!\d)/g)].map((m) => m[0])
      .find((n) => n.length > labelled.value.length && n.startsWith(labelled.value));
    if (longer) labelled.value = longer;
    const method = full.match(/\b(CVD|HPHT)\b/);
    if (method) add('lab.growthMethod', method[1], method[0], LABELED);
    const firstDate = findDates(full)[0]; // reports print their date near the top without a label
    if (firstDate) add('lab.reportDate', firstDate.value, firstDate.quote, LOOSE);
  }
  if (family === 'kp') add('goods.form', 'rough', null, LOOSE);
  if ((family === 'invoice' || family === 'packing_list') && !has('invoice.number')) {
    // "Invoice No. & Date" with the number printed under it: take the first invoice-style reference.
    const ref = full.match(/\b(?:[A-Z]{1,6}\/\d{2,4}(?:-\d{2,4})?\/\d{1,6}|INV[-/]?\d[\w/-]*)\b/);
    if (ref) add('invoice.number', ref[0], ref[0], LOOSE);
  }

  // doc.number and doc.date default to the paper's main number and date.
  for (const key of mainKeys(MAIN_NUMBER, family)) {
    const f = fields.find((x) => x.key === key);
    if (f) {
      add('doc.number', f.value, f.quote, f.confidence);
      break;
    }
  }
  for (const key of mainKeys(MAIN_DATE, family)) {
    const f = fields.find((x) => x.key === key);
    if (f) {
      add('doc.date', f.value, f.quote, f.confidence);
      break;
    }
  }
  const labeledDate = findLabeled(full, 'dated?', DATE, (v) => Boolean(parseDate(v)));
  if (labeledDate) add('doc.date', parseDate(labeledDate.value), labeledDate.value, LABELED);
  const firstDate = findDates(full)[0];
  if (firstDate) add('doc.date', firstDate.value, firstDate.quote, LOOSE);

  const declarations = findDeclarations(full);
  if (declarations.length) add('declaration.text', declarations[0], declarations[0], LABELED);

  // Which page each quote is on.
  const squashed = pages.map(squash);
  for (const f of fields) f.page = pageOf(f.quote, squashed);

  let lines = sheet ? linesFromSheet(sheet) : [];
  if (!lines.length && family === 'lab_report') lines = labReportLine(fields);
  else if (!lines.length && FAMILIES_WITH_LINES.includes(family)) lines = linesFromText(full);

  return { docType, summary: summarize(docType, fields, lines), fields, lines, declarations, readBy: 'offline' };
}

/** Rows back from spreadsheet text: "Sheet: name" starts a sheet, cells are separated by tabs. */
export function sheetFromText(text) {
  const sheets = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const head = line.match(/^Sheet: (.*)$/);
    if (head || !current) {
      current = { name: head ? head[1].trim() : 'Sheet1', rows: [] };
      sheets.push(current);
      if (head) continue;
    }
    current.rows.push(line.split('\t'));
  }
  return { sheets };
}

function pageOf(quote, squashedPages) {
  if (squashedPages.length <= 1) return 1;
  if (!quote) return null;
  const needle = squash(quote);
  const index = squashedPages.findIndex((page) => page.includes(needle));
  return index === -1 ? null : index + 1;
}

/** A grading report is one stone: build its line from the report fields. */
function labReportLine(fields) {
  const get = (key) => fields.find((f) => f.key === key)?.value ?? null;
  const reportNumber = get('lab.reportNumber');
  if (!reportNumber && !get('lab.carat')) return [];
  const growth = (get('lab.growthMethod') || /^LG/.test(reportNumber || '')) ? 'lab-grown' : get('goods.nature');
  return [{
    lineNo: 1,
    description: get('goods.description'),
    reportNumber,
    lab: get('lab.name') || (/^LG/.test(reportNumber || '') ? 'IGI' : null),
    shape: get('lab.shape'),
    carat: parseNumber(get('lab.carat')),
    color: get('lab.color'),
    clarity: get('lab.clarity'),
    pieces: 1,
    rate: null,
    amount: null,
    growth: growth === 'natural' || growth === 'lab-grown' ? growth : null,
    quote: fields.find((f) => f.key === 'lab.reportNumber')?.quote || null,
  }];
}

/** One plain sentence: what the paper is, its number and date, who to whom, lines and total. */
export function summarize(docType, fields, lines) {
  const get = (key) => fields.find((f) => f.key === key)?.value || null;
  let s = DOC_TYPE_LABELS[docType] || 'Document';
  const number = get('doc.number') || MAIN_NUMBER.other.map(get).find(Boolean);
  if (number) s += ` ${number}`;
  const date = get('doc.date');
  if (date) s += ` dated ${date}`;
  const from = get('exporter.name') || get('supplier.name');
  const to = get('consignee.name') || get('buyer.name');
  if (from && to) s += `, ${from} to ${to}`;
  else if (from) s += `, from ${from}`;
  else if (to) s += `, to ${to}`;
  if (lines.length) s += `, ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  const total = get('goods.totalValue');
  if (total) s += `, total ${get('goods.currency') ? `${get('goods.currency')} ` : ''}${total}`;
  return `${s}.`;
}
