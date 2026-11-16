// Chats, emails and "Tell the agents", without AI.
// Used when the AI is off, as the fallback when an AI call fails, and before the AI reads a chat:
// greetings, calls and system lines are dropped first ("clear the fluff"), so the AI only sees what matters.

import { SHIPMENT_STATUS_LABELS } from '../types.js';
import { parseStoneLine } from './stone-lines.js';
import { squash, oneLine } from './text.js';

// ---------------------------------------------------------------- fluff

const SYSTEM_RE = new RegExp([
  'messages and calls are end-to-end encrypted',
  '<media omitted>',
  '\\b(?:image|video|audio|sticker|gif|document|contact card) omitted\\b',
  '^missed (?:voice|video|group) call',
  '^(?:voice|video) call\\b',
  '^call (?:ended|started)',
  'this message was deleted',
  'you deleted this message',
  '^null$',
  "joined using this group's invite link",
  'security code (?:with .* )?changed',
  '^waiting for this message',
].join('|'), 'i');

const GREETING_RE = new RegExp(
  '^(?:(?:hi+|hello|hey|good\\s+(?:morning|afternoon|evening|night)|gm|gn|ok(?:ay)?|k+|thanks?(?:\\s+you)?|thank\\s+u|' +
    'thx|ty|noted|sure|yes|yeah|yep|yup|no|nope|done|great|fine|cool|welcome|bye|ji|haan|ha|acha|accha|theek\\s+hai|' +
    'sir|bhai|dear|👍|🙏|👌|✅|😊|🙂)[\\s!.,?🙏👍👌😊🙂✅]*)+$',
  'iu',
);

/** Message text without WhatsApp's "<This message was edited>" tag. */
function cleanText(text) {
  return oneLine(String(text ?? '').replace(/<this message was edited>/gi, ''));
}

/** True for greetings, calls, deleted messages and group system lines. A message with a file is never fluff. */
export function isFluff(message) {
  if (message?.attachment) return false;
  const text = cleanText(message?.text);
  if (!text) return true;
  if (SYSTEM_RE.test(text)) return true;
  // System lines ("Ravi added Priya") have no author in an export.
  if (!message?.author && /\b(?:added|removed|left|joined|changed|created)\b/i.test(text)) return true;
  if (GREETING_RE.test(text)) return true;
  return !/[A-Za-z0-9]/.test(text); // only emoji or punctuation
}

// ---------------------------------------------------------------- references

const REF_PATTERNS = [
  /\b[A-Z]{1,6}\/\d{2,4}(?:-\d{2,4})?\/\d{1,6}\b/g, // EXP/26-27/031, NS/2026/118
  /\bJL-(?:EXP|IMP)-\d{4}-\d{2}\b/g, // JL-EXP-1115-01
  /\b(?:INV|EXP|IMP|PO|PI|PL|SO|DO|ORD)[-/]?\d{2,}(?:[-/]\d+)*\b/gi, // INV-2026-0042, PO-7781
  /(?<![\d-])\d{3}-\d{4}\s?\d{4}(?!\d)/g, // air waybill 176-1234 5678
];
const LABELED_REF = /\b(?:invoice|inv|awb|hawb|mawb|sb|shipping\s+bill|kp|parcel|order|po|ref)\.?\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]*\d[A-Z0-9/-]*)/gi;

/**
 * Shipment-level references in a text, as printed: invoice numbers, parcel refs, air waybills, shipping bills,
 * KP certificates. Grading report numbers are not refs (they belong to stone lines).
 */
export function findRefs(text) {
  const s = String(text || '');
  const found = [];
  for (const re of REF_PATTERNS) {
    for (const m of s.matchAll(re)) found.push({ index: m.index, ref: m[0] });
  }
  for (const m of s.matchAll(LABELED_REF)) {
    if (m[1].length >= 3 && !/^\d{9,10}$/.test(m[1])) found.push({ index: m.index + m[0].indexOf(m[1]), ref: m[1] });
  }
  found.sort((a, b) => a.index - b.index || b.ref.length - a.ref.length); // longest first at the same spot
  const out = [];
  for (const { ref } of found) {
    const clean = ref.replace(/[.,;:/-]+$/, '');
    if (!out.some((r) => squash(r) === squash(clean) || squash(r).includes(squash(clean)))) out.push(clean);
  }
  return out;
}

// ---------------------------------------------------------------- reading chats and emails

const REQUEST_RE = /\b(?:please|pls|plz|kindly|need|needed|require[sd]?|prepare|send|share|make|create|build|draft|can\s+you|could\s+you|urgent|asap|by\s+(?:today|tomorrow|tonight|eod|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const SHIPMENT_WORDS_RE = /\b(?:invoice|inv|packing|awb|hawb|mawb|courier|parcel|shipment|consignment|dispatch|export|import|customs|kp|kimberley|certificates?|cert|reports?|gia|igi|hrd|lab|carats?|cts?|stones?|diamonds?|polished|rough|lot|shipping\s+bill|leo|bill\s+of\s+entry|insurance|flight|dds|statement|cbp|g7|origin|russia|antwerp|dubai|hong\s+kong|new\s+york|papers?|docs?|documents?)\b/i;
const CONTEXT_MESSAGES = 10; // a ref stays "current" for this many messages

/** Stone lines typed in a message, one per line of text. */
export function stoneLinesIn(text) {
  return String(text || '')
    .split(/\r?\n|;/)
    .map((piece) => parseStoneLine(piece))
    .filter(Boolean);
}

function whyRelevant({ attachment, lines, isRequest, refs, text }) {
  if (attachment) return 'Attached file';
  if (lines.length) return 'Stone details';
  if (isRequest) return 'Request';
  if (refs.length) return 'Reference number';
  if (SHIPMENT_WORDS_RE.test(text)) return 'Shipment detail';
  return null;
}

/** Read a WhatsApp chat without AI: { relevant, requests, packing, refs }. */
export function readChatOffline(chat) {
  const relevant = [];
  const requests = [];
  const packing = [];
  const refs = [];
  let current = { ref: null, index: -Infinity };
  (chat?.messages || []).forEach((message, index) => {
    if (isFluff(message)) return;
    const text = cleanText(message.text);
    const found = findRefs(text);
    for (const r of found) if (!refs.some((x) => squash(x) === squash(r))) refs.push(r);
    if (found.length) current = { ref: found[0], index };
    const contextRef = found[0] || (index - current.index <= CONTEXT_MESSAGES ? current.ref : null);
    const lines = stoneLinesIn(message.text);
    const isRequest = REQUEST_RE.test(text) && (SHIPMENT_WORDS_RE.test(text) || found.length > 0);
    const why = whyRelevant({ attachment: message.attachment, lines, isRequest, refs: found, text });
    if (!why) return;
    const at = message.at ?? null;
    const author = message.author ?? null;
    relevant.push({ index, at, author, text: text || String(message.attachment), why });
    if (isRequest) requests.push({ index, text, ref: contextRef, at, author });
    if (lines.length) {
      let group = packing.find((p) => p.ref === contextRef);
      if (!group) {
        group = { ref: contextRef, lines: [] };
        packing.push(group);
      }
      group.lines.push(...lines);
    }
  });
  for (const group of packing) group.lines.forEach((line, i) => { line.lineNo = i + 1; });
  return { relevant, requests, packing, refs };
}

const SIGN_OFF_RE = /^(?:dear|hi|hello|regards|best(?:\s+regards)?|kind\s+regards|warm\s+regards|thanks(?:\s+(?:and|&)\s+regards)?|thank\s+you|sincerely|cheers|sent\s+from\s+my)\b.{0,30}$/i;

/** The new part of an email: drops quoted replies ("> ...", "On ... wrote:"). Forwarded content is kept. */
export function newPartOfEmail(text) {
  const s = String(text || '');
  const cut = s.search(/^\s*On .{5,200} wrote:\s*$/m);
  const body = cut > 0 ? s.slice(0, cut) : s;
  return body.split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join('\n');
}

/** Read an email without AI: { relevant, requests, refs, packing }. */
export function readEmailOffline(email) {
  const body = newPartOfEmail(email?.text);
  const refs = findRefs(`${email?.subject || ''}\n${body}`);
  const relevant = [];
  const requests = [];
  const packingLines = [];
  for (const line of body.split(/\r?\n+/).map(oneLine).filter(Boolean)) {
    if (SIGN_OFF_RE.test(line) || isFluff({ text: line, author: email?.from || 'sender' })) continue;
    const lineRefs = findRefs(line);
    const lines = stoneLinesIn(line);
    const isRequest = REQUEST_RE.test(line) && (SHIPMENT_WORDS_RE.test(line) || lineRefs.length > 0);
    const why = whyRelevant({ lines, isRequest, refs: lineRefs, text: line });
    if (!why) continue;
    relevant.push({ at: email?.date ?? null, author: email?.from ?? null, text: line, why });
    if (isRequest) requests.push({ text: line, ref: lineRefs[0] || refs[0] || null });
    packingLines.push(...lines);
  }
  packingLines.forEach((line, i) => { line.lineNo = i + 1; });
  const packing = packingLines.length ? [{ ref: refs[0] || null, lines: packingLines }] : [];
  return { relevant, requests, refs, packing };
}

// ---------------------------------------------------------------- "Tell the agents"

// [intent, ...patterns that must all match]. Checked in this order.
const INTENT_RULES = [
  ['build_packing_list', /packing\s*list/i, /\b(?:build|make|draft|create|prepare|generate|from\s+(?:the\s+)?(?:chat|whatsapp|email|mail))\b/i],
  ['whats_missing', /\b(?:missing|still\s+need(?:ed|s)?|outstanding|pending|what(?:'s|\s+is)\s+left|what\s+else)\b/i],
  ['prepare_papers', /\b(?:prepare|make|build|generate|create|draft|send|do|need)\b/i,
    /\b(?:papers?|pack|statement|certificate|certification|dds|cbp|declaration|export|import|docs|documents|paperwork)\b/i],
  ['status', /\b(?:status|where|progress|update|ready|done|signed|sent|how\s+far)\b/i],
  ['explain', /\b(?:why|explain|what\s+(?:is|does|are)|how\s+(?:does|do)|meaning|mean)\b/i],
];

const KIND_RULES = [
  ['export_pack', /\bexport\s+(?:paper|papers|pack|docs?|documents?|paperwork)\b/i],
  ['import_pack', /\bimport\s+(?:paper|papers|pack|docs?|documents?|paperwork)\b/i],
  ['eu_dds', /\bEU\b|due\s+diligence|\bDDS\b|diamond\s+office/i],
  ['us_cbp_certificate', /\bCBP\b|\bUS\s+(?:customs|certificate|certification|statement)\b|self[\s-]?certification/i],
  ['g7_gf_declaration', /\bG7\b|\bGF\b|grandfather/i],
  ['packing_list_draft', /packing\s*list/i],
];

const KIND_WORDS = {
  export_pack: 'the export pack',
  import_pack: 'the import pack',
  eu_dds: 'the EU statement',
  us_cbp_certificate: 'the US CBP certificate',
  g7_gf_declaration: 'the G7 declaration note',
  packing_list_draft: 'a packing list',
};

export function kindsIn(text) {
  return KIND_RULES.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}

function shipmentKeys(s) {
  return [s.ref, s.invoiceNumber, s.hawb, s.mawb, s.shippingBillNumber].filter(Boolean);
}

/** The shipment a message means: a ref typed in it, "latest", or the only one. */
export function matchShipment(text, shipments = []) {
  const hay = squash(text);
  for (const s of shipments) {
    if (shipmentKeys(s).some((key) => squash(key).length >= 3 && hay.includes(squash(key)))) return s;
  }
  if (shipments.length === 1) return shipments[0];
  if (/\b(?:latest|last|newest|recent|current)\b/i.test(text) && shipments.length) return latestShipment(shipments);
  return null;
}

function latestShipment(shipments) {
  const time = (s) => String(s.updatedAt || s.createdAt || '');
  return [...shipments].sort((a, b) => time(b).localeCompare(time(a)))[0];
}

/** Find a shipment by the ref the AI (or a person) gave. */
export function findShipmentByRef(ref, shipments = []) {
  if (!ref) return null;
  const key = squash(ref);
  return shipments.find((s) => shipmentKeys(s).some((k) => squash(k) === key)) || null;
}

function listKinds(kinds) {
  const words = kinds.map((k) => KIND_WORDS[k]).filter(Boolean);
  if (words.length <= 1) return words[0] || 'the papers';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Route a "Tell the agents" message without AI: { intent, shipmentRef, kinds, reply }. */
export function routeOffline(text, { shipments = [], openQuestions = [] } = {}) {
  const message = String(text || '');
  const intent = INTENT_RULES.find(([, ...patterns]) => patterns.every((re) => re.test(message)))?.[0] || 'other';
  const kinds = intent === 'prepare_papers' ? kindsIn(message).filter((k) => k !== 'packing_list_draft') : [];
  const shipment = matchShipment(message, shipments);
  const typedRef = findRefs(message)[0] || null;
  const ref = shipment?.ref || typedRef || null;
  const openFor = (s) => openQuestions.filter((q) => q.shipmentId === s.id && (q.status || 'open') === 'open').length;

  let reply;
  if (intent === 'prepare_papers') {
    reply = shipment
      ? `Preparing ${listKinds(kinds)} for ${shipment.ref}. They will show under Papers when they are ready to sign.`
      : typedRef
        ? `No shipment ${typedRef} on file yet. Add its invoice and packing list, and the agents will start.`
        : 'No shipment on file yet. Add the invoice and packing list, and the agents will start.';
  } else if (intent === 'whats_missing') {
    reply = shipment ? `Checking what ${shipment.ref} still needs.` : 'Checking what each open shipment still needs.';
    const open = shipment ? openFor(shipment) : openQuestions.filter((q) => (q.status || 'open') === 'open').length;
    if (open) reply += ` ${open} question${open === 1 ? ' is' : 's are'} open.`;
  } else if (intent === 'build_packing_list') {
    reply = `Drafting a packing list${shipment ? ` for ${shipment.ref}` : ''} from the chat lines and papers on file.`;
  } else if (intent === 'status') {
    const list = shipment ? [shipment] : shipments.slice(0, 3);
    reply = list.length
      ? list.map((s) => `${s.ref}: ${SHIPMENT_STATUS_LABELS[s.status] || s.status || 'on file'}.`).join(' ')
      : 'No shipments on file yet.';
  } else if (intent === 'explain') {
    reply = 'The agents explain checks when the AI is on. Offline they can prepare papers, list what is missing, draft a packing list and give a status.';
  } else {
    reply = 'The agents can prepare papers, list what is missing, draft a packing list or give a status. Try one of those.';
  }
  return { intent, shipmentRef: ref, kinds, reply };
}

// ---------------------------------------------------------------- packing list draft

const DOC_ORDER = ['packing_list', 'commercial_invoice', 'proforma_invoice', 'lab_report'];

/**
 * Draft a packing list without AI. Stones typed in the chat or emails come first; when there are none,
 * the lines of the papers on file are used. Grading reports fill in missing grades for the same report number.
 * Every line has a source at the same position: sources[i] says where lines[i] came from. No stone is invented.
 */
export function draftPackingListOffline({ shipment = null, chatLines = [], emails = [], documents = [] } = {}) {
  const lines = [];
  const sources = [];
  const sameStone = (a, b) => a.reportNumber && b.reportNumber && squash(a.reportNumber) === squash(b.reportNumber);
  const add = (line, source) => {
    if (lines.some((l) => sameStone(l, line))) return;
    lines.push({ ...line, lineNo: lines.length + 1 });
    sources.push(source);
  };

  for (const message of chatLines) {
    const ref = [message.author, message.at].filter(Boolean).join(', ') || message.ref || 'chat';
    // Packing notes from readChat come with their stone lines already read; otherwise read the message text.
    if (Array.isArray(message.lines) && message.lines.length) {
      for (const line of message.lines) add(line, { kind: 'chat', ref, quote: line.quote || '' });
      continue;
    }
    for (const piece of String(message.text || '').split(/\r?\n|;/)) {
      const line = parseStoneLine(piece);
      if (line) add(line, { kind: 'chat', ref, quote: oneLine(piece) });
    }
  }
  for (const email of emails) {
    for (const piece of newPartOfEmail(email.text).split(/\r?\n|;/)) {
      const line = parseStoneLine(piece);
      if (line) add(line, { kind: 'email', ref: email.subject || email.from || 'email', quote: oneLine(piece) });
    }
  }
  const typed = lines.length;

  const docs = [...documents]
    .filter((d) => DOC_ORDER.includes(d.docType))
    .sort((a, b) => DOC_ORDER.indexOf(a.docType) - DOC_ORDER.indexOf(b.docType));
  if (!typed) {
    for (const doc of docs) {
      for (const line of doc.lines || []) {
        add(line, {
          kind: 'document',
          ref: `${doc.fileName || doc.id}${line.lineNo ? ` line ${line.lineNo}` : ''}`,
          quote: line.quote || '',
          docId: doc.id || null,
        });
      }
    }
  }

  // Fill gaps (shape, colour, clarity, lab) from any paper that has the same report number.
  let filled = 0;
  for (const line of lines) {
    for (const doc of docs) {
      const match = (doc.lines || []).find((l) => sameStone(l, line));
      if (!match) continue;
      for (const key of ['lab', 'shape', 'carat', 'color', 'clarity', 'growth']) {
        if (line[key] === null || line[key] === undefined) {
          if (match[key] !== null && match[key] !== undefined) {
            line[key] = match[key];
            filled += 1;
          }
        }
      }
    }
  }

  const noReport = lines.filter((l) => !l.reportNumber).length;
  let notes = lines.length
    ? `Drafted ${lines.length} line${lines.length === 1 ? '' : 's'} from ${typed ? 'the chat and emails' : 'the papers on file'}${shipment?.ref ? ` for ${shipment.ref}` : ''}.`
    : 'No stones found in the chat, emails or papers on file.';
  if (filled) notes += ` Filled ${filled} detail${filled === 1 ? '' : 's'} from papers with the same report number.`;
  if (noReport) notes += ` ${noReport} line${noReport === 1 ? ' has' : 's have'} no report number.`;
  return { lines, sources, notes };
}
