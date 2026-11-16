// Small formatting helpers for the screens. Pure functions, so they are easy to test.
import { DOC_TYPE_LABELS, SHIPMENT_STATUS_LABELS, PAPER_STATUS_LABELS, SOURCE_LABELS, PAPER_KIND_LABELS } from './labels.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, '0');

/** "08:53" in local time. */
export function clock(value) {
  const d = toDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

/** "05 Nov 2026". */
export function day(value) {
  const d = toDate(value);
  return d ? `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '';
}

/** "05 Nov, 08:53". */
export function dayTime(value) {
  const d = toDate(value);
  return d ? `${pad(d.getDate())} ${MONTHS[d.getMonth()]}, ${clock(d)}` : '';
}

/** "just now", "4 min ago", "3 h ago", "2 days ago", or the date for anything older than a week. */
export function ago(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const seconds = Math.round((toDate(now).getTime() - d.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return day(d);
}

/** "1 document", "6 documents". */
export function plural(n, word, many = `${word}s`) {
  const count = Number(n) || 0;
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`;
}

export function number(value, digits = 0) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "1.04 ct". */
export function carat(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return '';
  return `${n.toFixed(2)} ct`;
}

/** "USD 249,503.13". */
export function money(value, currency) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return '';
  return `${currency || ''} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

export function percent(value, digits = 0) {
  const n = Number(value);
  if (value === null || value === undefined || Number.isNaN(n)) return '';
  return `${(n * 100).toFixed(digits)}%`;
}

/** Confidence 0..1 as "97%". */
export function confidence(value) {
  if (value === null || value === undefined || value === '') return '';
  return percent(Math.max(0, Math.min(1, Number(value))));
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function docTypeLabel(type) {
  return DOC_TYPE_LABELS[type] || (type ? String(type).replace(/_/g, ' ') : 'Document');
}

export function paperKindLabel(kind) {
  return PAPER_KIND_LABELS[kind] || (kind ? String(kind).replace(/_/g, ' ') : 'Paper');
}

export function sourceLabel(source) {
  const kind = typeof source === 'string' ? source : source?.kind;
  return SOURCE_LABELS[kind] || (kind ? String(kind) : 'Upload');
}

const ISO_COUNTRIES = {
  IN: 'India', BE: 'Belgium', AE: 'United Arab Emirates', US: 'United States', GB: 'United Kingdom', HK: 'Hong Kong',
  IL: 'Israel', CN: 'China', JP: 'Japan', CH: 'Switzerland', TH: 'Thailand', NL: 'Netherlands', DE: 'Germany',
  FR: 'France', IT: 'Italy', BW: 'Botswana', NA: 'Namibia', ZA: 'South Africa', CA: 'Canada', RU: 'Russia',
  AU: 'Australia', AO: 'Angola', CD: 'DR Congo', SL: 'Sierra Leone', LS: 'Lesotho', SG: 'Singapore', ES: 'Spain',
};

/** "BE" -> "Belgium"; names pass through. */
export function country(code) {
  if (!code) return '';
  const key = String(code).trim().toUpperCase();
  return ISO_COUNTRIES[key] || String(code);
}

/** "India to Belgium" from a shipment. */
export function route(shipment) {
  if (!shipment) return '';
  if (shipment.route && !/^[A-Z]{2}\s*-\s*[A-Z]{2}$/.test(shipment.route)) return shipment.route;
  const from = country(shipment.originCountry || shipment.exporter?.country);
  const to = country(shipment.destinationCountry || shipment.consignee?.country);
  if (from && to) return `${from} to ${to}`;
  return from || to || '';
}

// Status chips: the tone picks the colour (ok, warn, fail, info, muted).
const SHIPMENT_TONES = {
  collecting: 'muted', reading: 'info', questions: 'warn', held_for_review: 'warn', ready_to_sign: 'ok', signed: 'ok', sent: 'ok',
};
const PAPER_TONES = { draft: 'muted', held_for_review: 'warn', ready_to_sign: 'ok', signed: 'ok', sent: 'info' };
const SCREEN_TONES = { clear: 'ok', review: 'warn', match: 'fail' };
const SEVERITY_TONES = { pass: 'ok', info: 'info', warn: 'warn', fail: 'fail' };
const DOC_TONES = { new: 'muted', reading: 'info', read: 'ok', error: 'fail' };

export function shipmentStatus(status) {
  return { text: SHIPMENT_STATUS_LABELS[status] || status || 'New', tone: SHIPMENT_TONES[status] || 'muted' };
}

export function paperStatus(status) {
  return { text: PAPER_STATUS_LABELS[status] || status || 'Draft', tone: PAPER_TONES[status] || 'muted' };
}

export function screeningStatus(status) {
  const text = { clear: 'Clear', review: 'Review', match: 'Match' }[status] || (status ? String(status) : 'Not screened');
  return { text, tone: SCREEN_TONES[status] || 'muted' };
}

export function severityTone(severity) {
  return SEVERITY_TONES[severity] || 'muted';
}

export function docStatus(status) {
  const text = { new: 'Waiting', reading: 'Reading', read: 'Read', error: 'Could not read' }[status] || status || 'Waiting';
  return { text, tone: DOC_TONES[status] || 'muted' };
}

/** Lab check on a stone: "Matches GIA", "Differs", "Not checked". */
export function labCheckStatus(check) {
  const status = check?.status;
  if (status === 'match') return { text: 'Matches lab', tone: 'ok' };
  if (status === 'mismatch') return { text: 'Differs', tone: 'fail' };
  if (status === 'not_found') return { text: 'Not found', tone: 'warn' };
  if (status === 'open_in_browser') return { text: 'Opened', tone: 'info' };
  return { text: 'Not checked', tone: 'muted' };
}

/** "Lab-grown" / "Natural". */
export function growthLabel(growth) {
  if (!growth) return '';
  if (/lab/i.test(growth)) return 'Lab-grown';
  if (/natural/i.test(growth)) return 'Natural';
  return String(growth);
}

/** Strips anything but digits for wa.me links: "+91 97695 24840" -> "919769524840". */
export function phoneDigits(text) {
  return String(text || '').replace(/[^0-9]/g, '');
}

/** Masks an email for display: "ops@house.com" -> "o••@house.com". */
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return email || '';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(4, user.length - 1)))}@${domain}`;
}

