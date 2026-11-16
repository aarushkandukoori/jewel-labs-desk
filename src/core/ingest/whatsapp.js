// Reads WhatsApp "Export chat" files into messages. An iPhone exports a zip holding _chat.txt; Android
// exports "WhatsApp Chat with <name>.txt", zipped together with the media when "Include media" is on.
//
//   iPhone:  [5/11/26, 11:25:43 PM] Mehul: Invoice for EXP/28
//            [5/11/26, 11:26:02 PM] Mehul: <attached: 00000030-INVOICE.pdf>
//   Android: 5/11/26, 23:25 - Mehul: Invoice for EXP/28
//            5/11/26, 23:26 - Mehul: IMG-20261105-WA0003.jpg (file attached)
import { baseName } from './zip.js';

// Invisible direction marks WhatsApp writes around names, system notes and attachments.
const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const STARTS_WITH_MARK = /^[\u200e\u200f]/;

const IPHONE_LINE = /^\[([^\]]+)\]\s?(.*)$/;
const ANDROID_LINE =
  /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[ap]\.?\s?m\.?)?)\s+[-\u2013]\s(.*)$/i;
// The date and time of a line: three numbers in the phone's date order, then the time (12 or 24 hour).
const STAMP = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s*([ap])\.?\s?m\.?)?$/i;

const ATTACHED_IPHONE = /<attached:\s*([^>]+?)\s*>/i;
const ATTACHED_ANDROID = /^(.+?\.[A-Za-z0-9]{1,6})\s+\(file attached\)\s*/i;
const EDITED_NOTE = /\s*<This message was edited>\s*$/i;

// Notes WhatsApp writes itself. iPhone also marks them with an invisible character, checked separately.
const SYSTEM_NOTES = [
  /end-to-end encrypted/i,
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^missed (voice|video) call/i,
  /security code (with .+ )?changed/i,
];
// Group notes that contain a colon, so they could pass for "Name: text" ("Mehul changed the subject: ...").
const GROUP_NOTES = /^[^:]+ changed (the subject|the group description|this group's)/i;

/** True for "_chat.txt" (iPhone) and "WhatsApp Chat with Mehul.txt" (Android). */
export function isChatFileName(path) {
  const base = baseName(path);
  return base === '_chat.txt' || /^WhatsApp Chat.*\.txt$/i.test(base);
}

/** "WhatsApp Chat - SAMPLE Export Desk.zip" or "WhatsApp Chat with SAMPLE Export Desk.txt" -> "SAMPLE Export Desk". */
export function chatTitleFromName(name) {
  const base = baseName(name).replace(/\.(zip|txt)$/i, '');
  const match = /^WhatsApp Chat(?:\s+with\s+|\s*-\s*|\s+)(.+)$/i.exec(base);
  return match ? match[1].trim() : null;
}

/** True when a text file reads like a WhatsApp export, whatever it is called. */
export function looksLikeChat(text) {
  const lines = splitLines(String(text)).filter((line) => line.trim()).slice(0, 30);
  if (!lines.length || !readLineStart(lines[0])) return false;
  return lines.filter((line) => readLineStart(line)).length >= 2;
}

/**
 * Parses an exported chat. fileNames are the files that came with it, used to link attachments.
 * Returns { title, dateOrder: 'DMY'|'MDY'|'YMD', messages: [{ at, atRaw, author, text, attachment }] }.
 * `at` is local time as ISO without a zone ("2026-11-05T23:25:43"): the export does not say which zone.
 */
export function parseChat(text, { title = 'WhatsApp chat', fileNames = [] } = {}) {
  const drafts = readDrafts(String(text), fileNames);
  const dateOrder = guessDateOrder(drafts);
  const messages = drafts
    .filter((draft) => !draft.system)
    .map((draft) => ({
      at: toIso(draft.stamp, dateOrder),
      atRaw: draft.stampText,
      author: draft.author,
      text: draft.text,
      attachment: draft.attachment,
    }));
  return { title, dateOrder, messages };
}

// One draft per message. Lines that do not start with a date belong to the message above.
function readDrafts(text, fileNames) {
  const drafts = [];
  for (const line of splitLines(text)) {
    const start = readLineStart(line);
    if (start) drafts.push(start);
    else if (drafts.length) drafts[drafts.length - 1].lines.push(line);
  }
  return drafts.map((draft) => finishDraft(draft, fileNames));
}

// Reads the date, time and the rest of a line that starts a message, or returns null.
function readLineStart(line) {
  const plain = line.replace(/^[\u200e\u200f\ufeff]+/, '');
  let stampText = null;
  let rest = null;
  const iphone = IPHONE_LINE.exec(plain);
  if (iphone && STAMP.test(tidySpaces(iphone[1]))) {
    stampText = tidySpaces(iphone[1]);
    rest = iphone[2];
  } else {
    const android = ANDROID_LINE.exec(plain);
    if (!android) return null;
    stampText = tidySpaces(android[1]);
    rest = android[2];
  }
  return { stampText, stamp: readStamp(stampText), rest, lines: [] };
}

function finishDraft(draft, fileNames) {
  // "Name: text". Lines with no name are notes from WhatsApp itself ("Mehul added Anika").
  const colon = findAuthorColon(draft.rest);
  const author = colon < 0 ? null : tidyAuthor(draft.rest.slice(0, colon));
  const firstLine = colon < 0 ? draft.rest : draft.rest.slice(colon + 1).replace(/^\s/, '');
  const rawBody = [firstLine, ...draft.lines].join('\n');
  const body = rawBody.replace(DIRECTION_MARKS, '').replace(EDITED_NOTE, '').trim();
  const { attachment, text } = splitAttachment(body, fileNames);

  // iPhone starts its own notes with an invisible mark; attachments and "image omitted" also start
  // with one, so those stay.
  const markedNote = (STARTS_WITH_MARK.test(draft.rest) || STARTS_WITH_MARK.test(firstLine)) && !attachment && !/omitted/i.test(body);
  const system =
    !author || markedNote || GROUP_NOTES.test(draft.rest) || SYSTEM_NOTES.some((note) => note.test(body));
  return { stampText: draft.stampText, stamp: draft.stamp, author, text, attachment, system };
}

// The colon after the sender's name. Names are short and never hold ": ".
function findAuthorColon(rest) {
  const match = /^([^:]{1,80}?):(\s|$)/.exec(rest);
  return match ? match[1].length : -1;
}

function tidyAuthor(name) {
  return name.replace(DIRECTION_MARKS, '').replace(/^~\s*/, '').trim() || null;
}

function splitAttachment(body, fileNames) {
  const iphone = ATTACHED_IPHONE.exec(body);
  if (iphone) return { attachment: iphone[1], text: body.replace(iphone[0], '').trim() };
  const android = ATTACHED_ANDROID.exec(body);
  if (android) return { attachment: android[1].trim(), text: body.slice(android[0].length).trim() };
  // Phones set to other languages word the markers differently; a file name from the export is enough.
  const named = fileNames.find((name) => name && body.includes(name));
  return { attachment: named || null, text: body };
}

function readStamp(stampText) {
  const m = STAMP.exec(stampText);
  if (!m) return null;
  return {
    a: Number(m[1]), b: Number(m[2]), c: Number(m[3]), yearFirst: m[1].length === 4,
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] || 0), half: (m[7] || '').toLowerCase(),
  };
}

// The phone writes dates in its own order. Use any number above 12 to tell day from month; if all
// dates fit both ways, attachment names such as IMG-20261105-WA0003.jpg hold the real date.
function guessDateOrder(drafts) {
  const stamps = drafts.map((draft) => draft.stamp).filter(Boolean);
  if (stamps.some((stamp) => stamp.yearFirst)) return 'YMD';
  if (stamps.some((stamp) => stamp.a > 12)) return 'DMY';
  if (stamps.some((stamp) => stamp.b > 12)) return 'MDY';
  let dayFirst = 0;
  let monthFirst = 0;
  for (const draft of drafts) {
    const named = dateInFileName(draft.attachment);
    if (!named || !draft.stamp) continue;
    if (draft.stamp.a === named.day && draft.stamp.b === named.month) dayFirst++;
    if (draft.stamp.a === named.month && draft.stamp.b === named.day) monthFirst++;
  }
  // Day first is the usual order in India, Europe, the Gulf and Hong Kong.
  return monthFirst > dayFirst ? 'MDY' : 'DMY';
}

// IMG-20261105-WA0003.jpg (Android) or 00000012-PHOTO-2026-11-05-23-25-43.jpg (iPhone).
function dateInFileName(name) {
  const m = /(20\d{2})-?(\d{2})-?(\d{2})/.exec(name || '');
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { year: Number(m[1]), month, day } : null;
}

function toIso(stamp, dateOrder) {
  if (!stamp) return null;
  let [year, month, day] = [stamp.c, stamp.b, stamp.a];
  if (dateOrder === 'MDY') [year, month, day] = [stamp.c, stamp.a, stamp.b];
  if (dateOrder === 'YMD') [year, month, day] = [stamp.a, stamp.b, stamp.c];
  if (year < 100) year += 2000;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || check.getUTCDate() !== day) return null;

  let hour = stamp.hour;
  if (stamp.half === 'p') hour = (hour % 12) + 12;
  if (stamp.half === 'a') hour = hour % 12;
  if (hour > 23 || stamp.minute > 59 || stamp.second > 59) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(stamp.minute)}:${pad(stamp.second)}`;
}

// Newer exports put a narrow no-break space before AM/PM; plain spaces are easier to read and match.
function tidySpaces(text) {
  return text.replace(DIRECTION_MARKS, '').replace(/[\u00a0\u202f\u2009]/g, ' ').trim();
}

// Windows, Mac and Unix line breaks, plus the Unicode line separators some phones use inside messages.
function splitLines(text) {
  return text.split(/\r\n|[\r\n\u2028\u2029]/);
}

function pad(number) {
  return String(number).padStart(2, '0');
}
