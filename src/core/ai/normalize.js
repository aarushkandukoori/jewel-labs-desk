// Cleans what the model answers into the exact shapes the rest of the app expects, and checks it against the
// offline reader. The model is good at reading; code makes sure keys, dates, numbers and quotes are trustworthy.

import { FIELD_KEYS, DOC_TYPES, PAPER_KINDS } from '../types.js';
import { parseDate, parseNumber, toCaratString, toAmountString, squash, oneLine, plainCopy, containsLoose, findCountry } from './text.js';
import { ROUTE_INTENTS } from './schemas.js';
import { findShipmentByRef } from './conversation.js';

const DATE_KEYS = new Set(FIELD_KEYS.filter((key) => /date$/i.test(key)));
const CARAT_KEYS = new Set(['lab.carat', 'goods.totalCarats', 'kp.carats']);
const MONEY_KEYS = new Set(['goods.totalValue', 'kp.value', 'insurance.insuredValue']);
// Numbers the offline reader finds reliably; used to fill a gap when the AI left one out.
const CROSS_CHECK_KEYS = ['invoice.number', 'shippingBill.number', 'leo.date', 'awb.hawb', 'awb.mawb',
  'kp.certificateNumber', 'lab.reportNumber', 'billOfEntry.number', 'goods.hsCode'];
// Printed keys the offline reader finds right after their own label. When the AI leaves one out of a real text layer,
// the labelled value fills the gap: the model now and then skips a key that is clearly printed.
const LABELED_FILL_KEYS = ['invoice.date', 'po.number', 'payment.terms', 'goods.incoterm', 'goods.totalValue', 'goods.portOfLoading',
  'goods.portOfDischarge', 'goods.grossWeight', 'goods.netWeight', 'awb.date', 'awb.flight', 'lab.inscription',
  'leo.number', 'exporter.taxId', 'insurance.policyNumber', 'kp.issueDate', 'kp.expiryDate'];
// Dates printed under their own label ("Invoice Date : 10/11/2026"). When the AI read a different date for one of
// these (a paper prints several dates), the date under the label wins.
const LABELED_DATE_KEYS = ['invoice.date', 'shippingBill.date', 'leo.date', 'awb.date', 'kp.issueDate', 'kp.expiryDate'];
const LABELED_CONFIDENCE = 0.6; // what the offline reader gives a value printed right after its label
// Company and person names. A value made of numbers (a PO or invoice number) is never a company.
const PARTY_NAME_KEYS = new Set(['exporter.name', 'consignee.name', 'buyer.name', 'supplier.name', 'carrier.name',
  'broker.name', 'insurer.name']);
// Each paper's own number and date have a general key (doc.number, doc.date) and a specific one. The model fills
// one or the other; the app reads both, so each fills the other when it is missing.
const OWN_KEYS = {
  commercial_invoice: ['invoice.number', 'invoice.date'],
  proforma_invoice: ['invoice.number', 'invoice.date'],
  supplier_invoice: ['invoice.number', 'invoice.date'],
  purchase_order: ['po.number', null],
  lab_report: ['lab.reportNumber', 'lab.reportDate'],
  kp_certificate: ['kp.certificateNumber', 'kp.issueDate'],
  shipping_bill: ['shippingBill.number', 'shippingBill.date'],
  bill_of_entry: ['billOfEntry.number', 'billOfEntry.date'],
  air_waybill: ['awb.hawb', 'awb.date'],
};

function clamp(n, low, high, fallback) {
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
}

function textOrNull(v) {
  if (v === null || v === undefined) return null;
  // Values use plain hyphens ("E-G", "BOM-DXB"): the app never shows an em dash.
  const s = oneLine(String(v)).replace(/[\u2010-\u2015\u2212]/g, '-');
  return s || null;
}

/** 'natural', 'lab-grown' or null. CVD, HPHT and "synthetic" all mean lab-grown. */
export function normalizeGrowth(value) {
  const s = String(value ?? '').toLowerCase();
  if (/lab|cvd|hpht|synthetic|lgd|grown/.test(s)) return 'lab-grown';
  if (/natural/.test(s)) return 'natural';
  return null;
}

export function normalizeForm(value) {
  const s = String(value ?? '').toLowerCase();
  if (/jewel/.test(s)) return 'jewelry';
  if (/rough/.test(s)) return 'rough';
  if (/polish|\bcut\b/.test(s)) return 'polished';
  return null;
}

const CURRENCY_SIGNS = { $: 'USD', US$: 'USD', '€': 'EUR', '₹': 'INR', RS: 'INR', 'RS.': 'INR', '£': 'GBP' };

function currencyCode(value) {
  const s = String(value).trim().toUpperCase();
  return CURRENCY_SIGNS[s] || (/^[A-Z]{3}$/.test(s) ? s : String(value).trim());
}

/** Clean one field from the model, or null when it carries nothing (no value, unknown key). */
export function normalizeField(field) {
  if (!field || !FIELD_KEYS.includes(field.key)) return null;
  const key = field.key;
  let value = textOrNull(field.value);
  if (!value) return null;
  let confidence = clamp(Number(field.confidence), 0, 1, 0.5);
  if (DATE_KEYS.has(key) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const iso = parseDate(value);
    if (iso) value = iso;
    else confidence = Math.min(confidence, 0.5); // not a date we can read: keep it, but a person should look
  }
  if (CARAT_KEYS.has(key)) value = toCaratString(value) ?? value;
  if (MONEY_KEYS.has(key)) value = toAmountString(value) ?? value;
  if (key === 'goods.nature') value = normalizeGrowth(value);
  if (key === 'goods.form') value = normalizeForm(value);
  if (key === 'goods.hsCode') value = value.replace(/\D/g, '') || null;
  if (key === 'lab.reportNumber') value = cleanReportNumber(value);
  if (key === 'goods.currency') value = currencyCode(value);
  if (key.endsWith('.taxId')) value = withoutLabel(value);
  if (key.endsWith('.address')) value = withoutContacts(value);
  if (key === 'awb.route') value = airportRoute(value);
  if (key === 'awb.flight') value = flightNumbers(value);
  if (PARTY_NAME_KEYS.has(key) && looksLikeReference(value)) return null;
  if (!value) return null;
  const page = Number.isInteger(field.page) && field.page >= 1 ? field.page : null;
  return { key, value, quote: textOrNull(field.quote), page, confidence };
}

/** Clean one stone or lot line. Missing values are null; numbers are numbers. */
export function normalizeLine(line, index = 0) {
  const num = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : parseNumber(v));
  const int = (v) => {
    const n = num(v);
    return n === null ? null : Math.round(n);
  };
  return {
    lineNo: int(line?.lineNo) ?? index + 1,
    description: textOrNull(line?.description),
    reportNumber: cleanReportNumber(line?.reportNumber),
    lab: textOrNull(line?.lab)?.toUpperCase() || null,
    shape: textOrNull(line?.shape),
    carat: num(line?.carat),
    color: textOrNull(line?.color)?.toUpperCase() || null,
    clarity: textOrNull(line?.clarity)?.toUpperCase().replace(/\s/g, '') || null,
    pieces: int(line?.pieces),
    rate: num(line?.rate),
    amount: num(line?.amount),
    growth: normalizeGrowth(line?.growth),
    quote: textOrNull(line?.quote),
  };
}

/** Clean a whole extraction: known keys only, no empty values, no duplicate key and value pairs. */
export function normalizeExtraction(raw, docType) {
  const fields = [];
  for (const f of raw?.fields || []) {
    const clean = normalizeField(f);
    if (clean && !fields.some((x) => x.key === clean.key && x.value === clean.value)) fields.push(clean);
  }
  const lines = (raw?.lines || [])
    .map((line, i) => normalizeLine(line, i))
    .filter((line) => line.reportNumber || line.carat !== null || line.description);
  const declarations = [...new Set((raw?.declarations || []).map((d) => oneLine(d)).filter(Boolean))];
  splitNamesFromAddresses(fields);
  fillOwnNumber(fields, docType);
  return {
    docType: DOC_TYPES.includes(raw?.docType) ? raw.docType : docType,
    summary: plainCopy(oneLine(raw?.summary || '')),
    fields,
    lines,
    declarations,
  };
}

/**
 * "7391020005", "GIA 2141 438 172" -> the number without spaces. "No report", "N/A" or "-" -> null:
 * a report number has at least 5 digits.
 */
export function cleanReportNumber(value) {
  const text = textOrNull(value);
  if (!text) return null;
  const compact = text.replace(/\s/g, '').toUpperCase();
  return (compact.match(/\d/g) || []).length >= 5 ? compact : null;
}

/** "IEC SAMPLE00012", "GSTIN: 24AAAAA0000A1Z5" -> the number without its label. */
function withoutLabel(value) {
  return value.replace(/^(?:IEC|GSTIN|GST|VAT|EORI|PAN|TIN|TRN|TAX\s*ID)(?:\s*(?:NO|NUMBER))?\s*[.:#]?\s+/i, '').trim();
}

/** An address ends before the phone and email printed under it. */
function withoutContacts(value) {
  return value.split(/[\s,;|]+(?:e-?mail|tel|phone|fax|mob(?:ile)?|website|web)\b\.?\s*[:.]?/i)[0].replace(/[\s,;|]+$/, '') || value;
}

// Words printed between airport codes ("BOM VIA DXB TO BRU") that are not airports.
const NOT_AIRPORTS = new Set(['VIA', 'AND', 'THE', 'FOR', 'TO', 'BY', 'EX', 'PER', 'AIR', 'NIL', 'USD']);

/** "MUMBAI (BOM) - DXB - JFK" -> "BOM-DXB-JFK": the airport codes in order, when at least two are printed. */
function airportRoute(value) {
  const codes = (value.match(/\b[A-Z]{3}\b/g) || []).filter((code) => !NOT_AIRPORTS.has(code));
  return codes.length >= 2 ? codes.join('-') : value;
}

/** "EK 501/13 NOV EK 183/13 NOV" -> "EK 501, EK 183": the flight numbers without their dates. */
function flightNumbers(value) {
  const flights = [...value.matchAll(/\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{1,4})[A-Z]?\b/g)].map((m) => `${m[1]} ${m[2]}`);
  return flights.length ? [...new Set(flights)].join(', ') : value;
}

/** "LDB-7781" or "PO 4471/26" is a reference, not a company: no letters-only word and mostly digits. */
export function looksLikeReference(value) {
  const text = String(value || '').trim();
  if (!/\d/.test(text)) return false;
  if (!/\s/.test(text)) return true;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  return digits >= letters;
}

/**
 * "Lumen Diamant BV (SAMPLE), Hoveniersstraat 99, 2018 Antwerpen, Belgium" read as a name: papers often print a
 * party and its address on one line. The name is the part before the first comma when the rest is an address (it
 * has a number or a country); the rest becomes the address if none was read.
 */
function splitNamesFromAddresses(fields) {
  for (const field of fields) {
    if (!PARTY_NAME_KEYS.has(field.key)) continue;
    const at = field.value.indexOf(', ');
    if (at < 3) continue;
    const rest = field.value.slice(at + 2);
    if (!/\d/.test(rest) && !findCountry(rest)) continue;
    const addressKey = field.key.replace(/\.name$/, '.address');
    field.value = field.value.slice(0, at).trim();
    if (!fields.some((f) => f.key === addressKey) && !field.key.startsWith('carrier') && !field.key.startsWith('broker')) {
      fields.push({ key: addressKey, value: rest.trim(), quote: rest.trim(), page: field.page, confidence: field.confidence });
    }
  }
}

/** Adds doc.number / doc.date from the paper's own number and date keys, and the other way round. */
export function fillOwnNumber(fields, docType) {
  const own = OWN_KEYS[docType];
  if (!own) return;
  const find = (key) => fields.find((f) => f.key === key);
  const copy = (from, key) => fields.push({ ...from, key });
  const [numberKey, dateKey] = own;
  const number = find(numberKey);
  const docNumber = find('doc.number');
  if (number && !docNumber) copy(number, 'doc.number');
  // On an air waybill a lone document number may be the master number: only a different number is the house one.
  if (!number && docNumber && !(numberKey === 'awb.hawb' && docNumber.value === find('awb.mawb')?.value)) {
    copy(docNumber, numberKey);
  }
  if (!dateKey) return;
  const date = find(dateKey);
  const docDate = find('doc.date');
  if (date && !docDate) copy(date, 'doc.date');
  if (!date && docDate) copy(docDate, dateKey);
}

/**
 * Check the AI's reading against the text layer and the offline reader. Changes `result` in place and
 * returns warnings for the record:
 *  1. a quote that is not in the text layer gets a lower confidence (it may be misread), when verifyQuotes is on;
 *  2. key numbers the offline reader found but the AI left out are added with low confidence;
 *  3. stone rows the AI missed (long lists can be cut off) are added from the text layer.
 * verifyQuotes should be on only for a real text layer, not OCR text (OCR makes its own mistakes).
 */
export function crossCheck(result, offline, { text = '', verifyQuotes = false } = {}) {
  const warnings = [];
  const haystack = squash(text);
  const reliable = verifyQuotes && haystack.length > 200;
  if (reliable) {
    for (const f of result.fields) {
      if (f.quote && !haystack.includes(squash(f.quote))) {
        f.confidence = Math.min(f.confidence, 0.6);
        warnings.push(`${f.key}: "${f.quote}" is not in the text layer.`);
      }
    }
  }
  for (const key of CROSS_CHECK_KEYS) {
    if (result.fields.some((f) => f.key === key)) continue;
    const found = offline?.fields?.find((f) => f.key === key);
    if (found) {
      result.fields.push({ ...found, confidence: Math.min(found.confidence, 0.45) });
      warnings.push(`${key} added from the offline reader: ${found.value}.`);
    }
  }
  if (reliable) {
    const labelled = (key) => offline?.fields?.find((f) => f.key === key && f.confidence >= LABELED_CONFIDENCE && f.value);
    for (const key of LABELED_FILL_KEYS) {
      const found = labelled(key);
      if (!found || result.fields.some((f) => f.key === key)) continue;
      result.fields.push({ ...found, confidence: 0.55 });
      warnings.push(`${key} read from its label on the paper: ${found.value}.`);
    }
    // A weight read without its unit ("0.850" under "Gross Wt (KGS)") takes the unit of the same number under its label.
    for (const key of ['goods.grossWeight', 'goods.netWeight']) {
      const found = labelled(key);
      const field = result.fields.find((f) => f.key === key);
      if (found && field && !/[a-z]/i.test(field.value) && /[a-z]/i.test(found.value) && parseFloat(field.value) === parseFloat(found.value)) {
        field.value = found.value;
      }
    }
    for (const key of LABELED_DATE_KEYS) {
      const found = labelled(key);
      const field = result.fields.find((f) => f.key === key);
      if (!found || !field || field.value === found.value) continue;
      warnings.push(`${key}: the AI read ${field.value}, the date under its label is ${found.value}.`);
      const fixed = { value: found.value, quote: found.quote, page: found.page ?? field.page, confidence: 0.7 };
      // doc.date may be a copy of the same misread date.
      for (const copy of result.fields.filter((f) => f.key === 'doc.date' && f.value === field.value && f.quote === field.quote)) Object.assign(copy, fixed);
      Object.assign(field, fixed);
    }
  }
  const offlineLines = offline?.lines || [];
  if (!result.lines.length && offlineLines.length) {
    result.lines = offlineLines.map((line) => ({ ...line }));
    warnings.push(`${offlineLines.length} line${offlineLines.length === 1 ? '' : 's'} read by the offline reader.`);
  } else if (reliable) {
    // Only full stone rows are added (report number, carat and a grade), so a stray number never becomes a stone.
    const known = new Set(result.lines.map((l) => squash(l.reportNumber)).filter(Boolean));
    const missed = offlineLines.filter((l) => l.reportNumber && l.carat !== null && (l.color || l.clarity)
      && !known.has(squash(l.reportNumber)));
    for (const line of missed) result.lines.push({ ...line, lineNo: result.lines.length + 1 });
    if (missed.length) warnings.push(`${missed.length} stone line${missed.length === 1 ? '' : 's'} found in the text but not read by the AI.`);
    for (const line of result.lines) {
      if (line.reportNumber && !haystack.includes(squash(line.reportNumber))) {
        warnings.push(`Report number ${line.reportNumber} is not in the text layer.`);
      }
    }
  }
  return warnings;
}

/** Clean a classification. When the model agrees with the keyword check, keep the higher confidence. */
export function normalizeClassification(raw, guess) {
  if (!raw || !DOC_TYPES.includes(raw.docType)) return guess;
  let confidence = clamp(Number(raw.confidence), 0, 1, 0.7);
  if (guess && guess.docType === raw.docType) confidence = Math.max(confidence, guess.confidence);
  return { docType: raw.docType, confidence: Math.round(confidence * 100) / 100, reason: oneLine(raw.reason || '') || 'Read by the AI' };
}

/**
 * Clean a route answer. The shipment ref must be one on file, or typed in the message; otherwise the offline
 * router's choice is used (it understands "latest"). Never trust a ref the model made up.
 */
export function normalizeRoute(raw, { text, shipments = [], fallback }) {
  const intent = ROUTE_INTENTS.includes(raw?.intent) ? raw.intent : 'other';
  const kinds = [...new Set((raw?.kinds || []).filter((k) => PAPER_KINDS.includes(k)))];
  const onFile = findShipmentByRef(raw?.shipmentRef, shipments);
  let shipmentRef = fallback?.shipmentRef ?? null;
  if (onFile) shipmentRef = onFile.ref;
  else if (raw?.shipmentRef && containsLoose(text, raw.shipmentRef)) shipmentRef = oneLine(raw.shipmentRef);
  const reply = plainCopy(oneLine(raw?.reply || '')).slice(0, 600) || fallback?.reply || '';
  return { intent, shipmentRef, kinds, reply };
}
