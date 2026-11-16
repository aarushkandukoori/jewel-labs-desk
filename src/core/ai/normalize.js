// Cleans what the model answers into the exact shapes the rest of the app expects, and checks it against the
// offline reader. The model is good at reading; code makes sure keys, dates, numbers and quotes are trustworthy.

import { FIELD_KEYS, DOC_TYPES, PAPER_KINDS } from '../types.js';
import { parseDate, parseNumber, toCaratString, toAmountString, squash, oneLine, plainCopy, containsLoose } from './text.js';
import { ROUTE_INTENTS } from './schemas.js';
import { findShipmentByRef } from './conversation.js';

const DATE_KEYS = new Set(FIELD_KEYS.filter((key) => /date$/i.test(key)));
const CARAT_KEYS = new Set(['lab.carat', 'goods.totalCarats', 'kp.carats']);
const MONEY_KEYS = new Set(['goods.totalValue', 'kp.value', 'insurance.insuredValue']);
// Numbers the offline reader finds reliably; used to fill a gap when the AI left one out.
const CROSS_CHECK_KEYS = ['invoice.number', 'shippingBill.number', 'leo.date', 'awb.hawb', 'awb.mawb',
  'kp.certificateNumber', 'lab.reportNumber', 'billOfEntry.number', 'goods.hsCode'];

function clamp(n, low, high, fallback) {
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
}

function textOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = oneLine(String(v));
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
  if (key === 'lab.reportNumber') value = value.replace(/\s/g, '').toUpperCase();
  if (key === 'goods.currency') value = currencyCode(value);
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
    reportNumber: textOrNull(line?.reportNumber)?.replace(/\s/g, '').toUpperCase() || null,
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
  return {
    docType: DOC_TYPES.includes(raw?.docType) ? raw.docType : docType,
    summary: plainCopy(oneLine(raw?.summary || '')),
    fields,
    lines,
    declarations,
  };
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
