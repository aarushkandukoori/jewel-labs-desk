// Small formatting helpers for the screens. Pure functions, so they are easy to test.
import { DOC_TYPE_LABELS, SHIPMENT_STATUS_LABELS, PAPER_STATUS_LABELS, SOURCE_LABELS, PAPER_KIND_LABELS } from './labels.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value) {
  if (!value) return null;
  // A plain day ("2026-11-12", a paper's date) is a calendar day, not midnight UTC, so it never shows as the
  // day before west of UTC. Full timestamps show in local time.
  const dayOnly = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const d = value instanceof Date ? value : dayOnly ? new Date(+dayOnly[1], dayOnly[2] - 1, +dayOnly[3]) : new Date(value);
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
  // Words that start with a letter, so "Ravi Mehta (SAMPLE)" gives RM.
  const words = String(name || '').trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  if (!words.length) return '?';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
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

/**
 * The closest SDN name, only when the screening found one worth a look (review or match). For a clear party it
 * is null: its nearest name is noise, and next to a buyer it reads like an accusation.
 */
export function closestSdnName(screening) {
  const best = screening?.best;
  if (!best || !['review', 'match'].includes(screening.status)) return null;
  return `${best.sdnName} (${Math.round((best.score || 0) * 100)}%)`;
}

export function severityTone(severity) {
  return SEVERITY_TONES[severity] || 'muted';
}

export function docStatus(status) {
  const text = { new: 'Waiting', reading: 'Reading', read: 'Read', error: 'Could not read' }[status] || status || 'Waiting';
  return { text, tone: DOC_TONES[status] || 'muted' };
}

/**
 * Lab check on a stone: "Matches lab", "Differs", "Not found" (the lab says there is no such report),
 * "Could not check" (no online check, the window was closed, a timeout), "Not checked".
 */
export function labCheckStatus(check) {
  const status = check?.status;
  if (status === 'match') return { text: 'Matches lab', tone: 'ok' };
  if (status === 'mismatch') return { text: 'Differs', tone: 'fail' };
  if (status === 'not_found') return { text: 'Not found', tone: 'warn' };
  if (status === 'unavailable' || status === 'incomplete') return { text: 'Could not check', tone: 'muted' };
  if (status === 'open_in_browser') return { text: 'Opened', tone: 'info' };
  return { text: 'Not checked', tone: 'muted' };
}

/** The notice after a lab check: what came back, why it could not run, in the matching tone. */
export function labCheckToast(result) {
  const s = labCheckStatus(result);
  const tone = { ok: 'ok', fail: 'error', warn: 'warn' }[s.tone] || 'info';
  return { text: result?.reason && s.tone !== 'ok' ? `${s.text}: ${result.reason}` : s.text, tone };
}

// The labs with an online report check (LABS in src/core/labs/index.js; test/unit/renderer.test.js keeps the two
// the same). A stone with no lab on its papers is checked by its number's shape, so it may have one too.
export const LABS_WITH_ONLINE_CHECK = ['GIA', 'IGI', 'HRD', 'GCAL'];

/** True when the app can open the lab's own report check for this stone. */
export function canCheckOnline(stone) {
  if (!stone?.reportNumber) return false;
  const lab = String(stone.lab || '').trim().toUpperCase();
  return !lab || LABS_WITH_ONLINE_CHECK.includes(lab);
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

/** A lab's short name for tight places: GIA stays GIA; "Northbridge Gem Laboratory (SAMPLE)" becomes NGL. */
export function shortLab(lab) {
  const name = String(lab || '').replace(/\(.*?\)/g, '').trim();
  if (!name) return '';
  if (name.length <= 6) return name;
  const words = name.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w));
  return words.length >= 2 ? words.map((w) => w[0]).join('').toUpperCase() : name;
}

/**
 * What went wrong with the watched folder, in one line: files that could not be read in the last look
 * ("2 files could not be read: AWB 1.pdf (in use by another program)."), or the last error. null when all is well.
 */
export function folderProblem(folder) {
  if (!folder?.watching) return null;
  const problems = folder.problems || [];
  if (problems.length) {
    const list = problems.slice(0, 3).map((p) => `${p.file} (${p.reason})`).join(', ');
    const more = problems.length > 3 ? ` and ${problems.length - 3} more` : '';
    return `${plural(problems.length, 'file')} could not be read: ${list}${more}. The agents try again every 5 minutes.`;
  }
  return folder.lastError || null;
}

/** "broker.example, @lab.example" -> ['broker.example', 'lab.example'], as typed (main checks them). */
export function domainList(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
}

/** "2 papers were read by the offline reader; they are read again when the AI is back." */
export function offlineNote(count) {
  return count === 1
    ? '1 paper was read by the offline reader; it is read again when the AI is back.'
    : `${count} papers were read by the offline reader; they are read again when the AI is back.`;
}
