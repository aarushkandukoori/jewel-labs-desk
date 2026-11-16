// Turns raw record values into the words printed on the papers: dates, carats, countries, document titles.
import { DOC_TYPE_LABELS, EU_MEMBER_STATES } from '../types.js';

export const NOT_ON_FILE = 'Not on file';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Countries seen most in the diamond trade, plus every EU state. Anything else prints as given.
const COUNTRY_NAMES = {
  ...EU_MEMBER_STATES,
  AE: 'United Arab Emirates', AO: 'Angola', AU: 'Australia', BW: 'Botswana', CA: 'Canada', CD: 'DR Congo',
  CH: 'Switzerland', CN: 'China', GB: 'United Kingdom', HK: 'Hong Kong', IL: 'Israel', IN: 'India',
  JP: 'Japan', LS: 'Lesotho', NA: 'Namibia', RU: 'Russian Federation', SG: 'Singapore', SL: 'Sierra Leone',
  TH: 'Thailand', TZ: 'Tanzania', US: 'United States', ZA: 'South Africa', ZW: 'Zimbabwe',
};

export function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The value as text, or "Not on file" when it is missing. */
export function show(value) {
  return isBlank(value) ? NOT_ON_FILE : String(value).trim();
}

/** First value that is not blank, or null. */
export function firstOf(...values) {
  for (const value of values) if (!isBlank(value)) return value;
  return null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Reads a Date, a timestamp, "2026-11-15" or a full ISO time. Returns null for anything else, because dates
 * copied from papers ("22-10-2026", "Oct 22, 2026") are printed exactly as the document had them.
 */
export function parseDate(value) {
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value === 'number') return new Date(value);
  const text = String(value ?? '').trim();
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  // A plain day is a calendar day, not midnight UTC, so it never slips to the day before.
  if (dayOnly) return new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]));
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    return isNaN(date) ? null : date;
  }
  return null;
}

/** "15 Nov 2026" (local calendar day). Unknown formats print as given. */
export function formatDay(value) {
  const date = parseDate(value);
  if (!date) return show(value);
  return `${pad2(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "15 Nov 2026, 09:42" (local time). */
export function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return show(value);
  return `${formatDay(date)}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "15/11/2026", the format the Diamond Office template asks for. */
export function formatSlashDate(value) {
  const date = parseDate(value);
  if (!date) return show(value);
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** "PRINTED 15 NOV 2026" for the top right of every paper. */
export function printedLabel(value) {
  return `Printed ${formatDay(value || new Date())}`.toUpperCase();
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = parseFloat(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** "1.02" for a carat weight, or "Not on file". */
export function formatCarat(value) {
  const n = toNumber(value);
  return n === null ? NOT_ON_FILE : n.toFixed(2);
}

/** "12 stones, 9.84 ct" */
export function stonesText(count, carats) {
  const word = count === 1 ? 'stone' : 'stones';
  return `${count} ${word}, ${(Math.round(carats * 100) / 100).toFixed(2)} ct`;
}

/** "BE" -> "Belgium". Names pass through unchanged. */
export function countryName(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  return COUNTRY_NAMES[text.toUpperCase()] || text;
}

export function isBelgium(value) {
  const name = countryName(value);
  return name === 'Belgium';
}

export function isEuCountry(value) {
  const name = countryName(value);
  return Object.values(EU_MEMBER_STATES).includes(name);
}

/** One line for a party: "Name, address, country". */
export function partyLine(party) {
  if (!party || isBlank(party.name)) return NOT_ON_FILE;
  const parts = [party.name, party.address, countryName(party.country)].filter((part) => !isBlank(part));
  return parts.join(', ');
}

/** The value a reading agent found for a field key on one document, or null. */
export function fieldOf(doc, key) {
  const found = (doc?.fields || []).find((field) => field.key === key && !isBlank(field.value));
  return found ? String(found.value).trim() : null;
}

/** First value for a field key across documents, preferring the given document types in order. */
export function findField(documents, key, preferTypes = []) {
  const docs = documents || [];
  for (const type of preferTypes) {
    for (const doc of docs) if (doc.docType === type && fieldOf(doc, key)) return fieldOf(doc, key);
  }
  for (const doc of docs) if (fieldOf(doc, key)) return fieldOf(doc, key);
  return null;
}

/** A short, human title for a document: "Commercial invoice INV/26-27/041". */
export function docTitle(doc) {
  const type = doc?.docType || 'other';
  const label = DOC_TYPE_LABELS[type] || DOC_TYPE_LABELS.other;
  const f = (key) => fieldOf(doc, key);
  const join = (...parts) => parts.filter((part) => !isBlank(part)).join(' ');
  switch (type) {
    case 'commercial_invoice':
    case 'proforma_invoice':
    case 'supplier_invoice':
      return join(label, f('invoice.number') || f('doc.number'));
    case 'shipping_bill': {
      const base = join(label, f('shippingBill.number') || f('doc.number'));
      return f('leo.date') || f('leo.number') ? `${base} with Let Export Order` : base;
    }
    case 'bill_of_entry':
      return join(label, f('billOfEntry.number') || f('doc.number'));
    case 'air_waybill': {
      const parts = [];
      if (f('awb.hawb')) parts.push(`HAWB ${f('awb.hawb')}`);
      if (f('awb.mawb')) parts.push(`MAWB ${f('awb.mawb')}`);
      return parts.length ? `${label}, ${parts.join(', ')}` : label;
    }
    case 'insurance_certificate':
      return join(label, f('insurance.policyNumber') || f('doc.number'));
    case 'lab_report':
      return join(label, f('lab.name'), f('lab.reportNumber') || f('doc.number'));
    case 'kp_certificate':
      return join(label, f('kp.certificateNumber') || f('doc.number'));
    case 'supplier_declaration':
      return join(label, f('supplier.name'));
    case 'whatsapp_chat':
      return doc.source?.ref ? `${label}, ${doc.source.ref}` : label;
    case 'email':
      return doc.source?.from ? `${label} from ${doc.source.from}` : label;
    default:
      return join(label, f('doc.number'));
  }
}

/** Where a document came from and when it arrived: { how: 'Email from a@b.com', when: '14 Nov 2026, 09:42' }. */
export function sourceText(source) {
  const s = source || {};
  let how;
  switch (s.kind) {
    case 'email':
      how = s.from ? `Email from ${s.from}` : 'Email';
      break;
    case 'forward':
      how = s.from ? `Forwarded by ${s.from}` : 'Forwarded email';
      break;
    case 'whatsapp':
      how = ['WhatsApp chat', s.ref, s.chatAuthor ? `sent by ${s.chatAuthor}` : null].filter(Boolean).join(', ');
      break;
    case 'folder':
      how = 'Watched folder';
      break;
    case 'generated':
      how = 'Drafted by Jewel Labs agents';
      break;
    case 'sample':
      how = 'SAMPLE data';
      break;
    case 'upload':
      how = 'Upload';
      break;
    default:
      how = s.kind ? String(s.kind) : NOT_ON_FILE;
  }
  const when = s.chatAt || s.receivedAt;
  return { how, when: isBlank(when) ? NOT_ON_FILE : formatDateTime(when) };
}

/** Carat weight of a stone as a number, or null. */
export function caratOf(stone) {
  return toNumber(stone?.carat);
}

/** True when the stone record says lab-grown (CVD, HPHT, synthetic). Unknown growth counts as natural. */
export function isLabGrown(stone) {
  return /lab|cvd|hpht|synthetic|grown/i.test(String(stone?.growth || ''));
}

/** "CVD" stays "CVD", "natural" becomes "Natural". */
export function growthText(value) {
  if (isBlank(value)) return NOT_ON_FILE;
  const text = String(value).trim();
  return text === text.toLowerCase() ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Counts for the statements: all stones, and stones of 0.50 ct and up ("in scope"). */
export function stoneFacts(stones, { naturalOnly = false } = {}) {
  const list = (stones || []).filter((stone) => !naturalOnly || !isLabGrown(stone));
  let carats = 0;
  let inScopeCount = 0;
  let inScopeCarats = 0;
  let unknownCarat = 0;
  for (const stone of list) {
    const carat = caratOf(stone);
    if (carat === null) {
      unknownCarat += 1;
      continue;
    }
    carats += carat;
    if (carat >= 0.5) {
      inScopeCount += 1;
      inScopeCarats += carat;
    }
  }
  return { count: list.length, carats, inScopeCount, inScopeCarats, unknownCarat };
}

/** Countries of mining from the stones' KP data and any KP certificate on file, as country names. */
export function miningCountries(stones, documents) {
  const names = [];
  const add = (value) => {
    const name = countryName(value);
    if (name && !names.includes(name)) names.push(name);
  };
  for (const stone of stones || []) for (const country of stone?.kp?.countries || []) add(country);
  for (const doc of documents || []) {
    if (doc.docType !== 'kp_certificate') continue;
    const listed = fieldOf(doc, 'kp.countriesOfMining');
    if (listed) listed.split(/,|;|\/|\band\b/i).map((part) => part.trim()).filter(Boolean).forEach(add);
  }
  return names;
}

/** True when the papers are built from the SAMPLE shipment, so every page says so. */
export function isSampleData({ house, shipment, documents } = {}) {
  if (house?.sample || shipment?.sample) return true;
  return (documents || []).some((doc) => doc?.source?.kind === 'sample');
}
