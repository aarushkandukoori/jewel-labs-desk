// The WhatsApp export "WhatsApp Chat - Kavya Gems Export Desk.zip": an iPhone-format _chat.txt between
// Ravi at the house and the Jewel Labs desk (10 to 13 Nov 2026), plus the files Ravi sent in the chat.
// The packing list is NOT in the zip: Ravi types the stone list into the chat instead.
//
// iPhone exports look like this (dates day first on an Indian phone, a thin space before AM/PM, and
// invisible left-to-right marks in front of WhatsApp's own notes and attachments):
//   [10/11/26, 11:41:15 AM] Ravi (Kavya Gems): Invoice KG-26-27-041.pdf • 1 page <attached: 00000008-Invoice KG-26-27-041.pdf>
import JSZip from 'jszip';

export const CHAT_TITLE = 'Kavya Gems Export Desk';
export const ZIP_NAME = `WhatsApp Chat - ${CHAT_TITLE}.zip`;
export const RAVI = 'Ravi (Kavya Gems)';
export const DESK = 'Jewel Labs desk';

const LRM = '\u200e'; // left-to-right mark
const THIN = '\u202f'; // narrow no-break space, used before AM/PM
const BULLET = '\u2022';

// Every message in order. `file` names a paper the caller supplies (see buildChatZip); `system` marks
// WhatsApp's own notes; `relevant` marks what a reading agent should pick out. Times are local Surat time.
export const MESSAGES = [
  { at: '2026-11-10 09:58:12', from: CHAT_TITLE, system: true, text: 'Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.' },
  { at: '2026-11-10 09:58:12', from: CHAT_TITLE, system: true, text: `${RAVI} created this group` },
  { at: '2026-11-10 09:58:13', from: CHAT_TITLE, system: true, text: `${RAVI} added ${DESK}` },
  { at: '2026-11-10 10:02:41', from: RAVI, text: 'Good morning sir' },
  { at: '2026-11-10 10:03:05', from: DESK, text: 'Good morning Ravi. Please send the papers for the Antwerp parcel when ready.' },
  { at: '2026-11-10 10:15:22', from: RAVI, text: 'ok ji' },
  { at: '2026-11-10 11:41:09', from: RAVI, text: 'Invoice KG/26-27/041 for Lumen Diamant Antwerp. 6 stones', relevant: true },
  { at: '2026-11-10 11:41:15', from: RAVI, file: 'invoice' },
  { at: '2026-11-10 11:44:50', from: RAVI, text: 'Lab reports' },
  { at: '2026-11-10 11:44:58', from: RAVI, file: 'report-7391020001' },
  { at: '2026-11-10 11:44:58', from: RAVI, file: 'report-7391020002' },
  { at: '2026-11-10 11:44:59', from: RAVI, file: 'report-7391020003' },
  { at: '2026-11-10 11:45:00', from: RAVI, file: 'report-7391020006' },
  { at: '2026-11-10 11:47:31', from: RAVI, text: 'Emerald one report is in the office safe. Sending photo', relevant: true },
  { at: '2026-11-10 11:52:18', from: RAVI, file: 'photo-7391020005' },
  { at: '2026-11-10 11:53:02', from: DESK, text: 'Got it. Is the 0.45 round without a report?' },
  { at: '2026-11-10 11:55:40', from: RAVI, text: 'Yes sir, below half carat, no report', relevant: true },
  { at: '2026-11-10 12:20:11', from: RAVI, text: 'KP of the rough and Dubai supplier bill', relevant: true },
  { at: '2026-11-10 12:20:19', from: RAVI, file: 'kp' },
  { at: '2026-11-10 12:20:19', from: RAVI, file: 'supplier-invoice' },
  { at: '2026-11-10 12:22:47', from: DESK, text: 'Thanks. Packing list also please' },
  { at: '2026-11-10 12:31:05', from: RAVI, text: 'packing list is coming tomorrow', relevant: true },
  { at: '2026-11-10 16:05:33', from: DESK, call: true, text: 'Voice call, No answer' },
  { at: '2026-11-11 10:12:44', from: RAVI, text: 'Sorry sir was in the bourse \u{1F64F}' },
  { at: '2026-11-11 10:13:10', from: RAVI, text: 'Accountant is on leave, packing list sheet not ready. Typing the stones here', relevant: true },
  {
    at: '2026-11-11 10:16:52',
    from: RAVI,
    text: [
      'KG/26-27/041 stones',
      '1) RD 1.02 D VVS1 7391020001',
      '2) OV 0.71 F VS1 7391020002',
      '3) PR 0.52 G VS2 7391020003',
      '4) RD 0.45 E SI1 no report',
      '5) EM 1.50 H VVS2 7391020005',
      '6) CU 0.90 E VS1 7391020006',
      'total 6 pcs 5.10 cts',
    ].join('\n'),
    stoneList: true,
    relevant: true,
  },
  { at: '2026-11-11 10:17:30', from: DESK, text: 'Thank you. The agents will draft the packing list from this. Send the sheet when it is ready.' },
  { at: '2026-11-11 10:18:02', from: RAVI, text: 'ok ji' },
  { at: '2026-11-12 18:42:19', from: RAVI, text: 'Shipping bill 1234567 done, LEO today. AWB tomorrow', relevant: true },
  { at: '2026-11-13 09:05:51', from: RAVI, text: 'Parcel left on EK 501 this morning', relevant: true },
  { at: '2026-11-13 09:06:20', from: DESK, text: '\u{1F44D}' },
];

/** "2026-11-10 16:05:33" -> "10/11/26, 4:05:33 PM" (with the thin space before PM). */
export function stamp(at) {
  const [date, time] = at.split(' ');
  const [year, month, day] = date.split('-');
  const [hour, minute, second] = time.split(':').map(Number);
  const half = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${Number(day)}/${Number(month)}/${year.slice(2)}, ${hour12}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${THIN}${half}`;
}

/** The attachment's name inside the export: an 8-digit counter, then the original name. */
export function attachmentName(index, file) {
  return `${String(index + 1).padStart(8, '0')}-${file.name}`;
}

/**
 * Builds the export. files maps each `file` key in MESSAGES to { name, bytes, pages }.
 * Photos are named the iPhone way: 00000015-PHOTO-2026-11-10-11-52-18.jpg.
 * Returns { zip: Uint8Array, chatText, attachments: [{ key, name, at }] }.
 */
export async function buildChatZip(files) {
  const lines = [];
  const attachments = [];
  MESSAGES.forEach((message, index) => {
    const head = `[${stamp(message.at)}] ${message.from}: `;
    if (message.file) {
      const file = files[message.file];
      if (!file) throw new Error(`No file for chat attachment "${message.file}"`);
      const name = attachmentName(index, file);
      attachments.push({ key: message.file, name, at: message.at, bytes: file.bytes });
      // Documents carry "name • N pages" before the marker; photos carry only the marker.
      const caption = file.pages ? `${LRM}${file.name} ${BULLET} ${LRM}${file.pages} page${file.pages === 1 ? '' : 's'} ` : '';
      lines.push(`${LRM}${head}${caption}${LRM}<attached: ${name}>`);
    } else if (message.system || message.call) {
      const text = message.call ? message.text.replace(', ', `, ${LRM}`) : message.text;
      lines.push(`${message.call ? LRM : ''}${head}${LRM}${text}`);
    } else {
      lines.push(`${head}${message.text.replace(/\n/g, '\r\n')}`);
    }
  });
  const chatText = `${lines.join('\r\n')}\r\n`;

  const zip = new JSZip();
  // Fixed file times (the time of the export, then each message's time) keep the zip the same every run.
  zip.file('_chat.txt', chatText, { date: localDate('2026-11-13 09:10:00') });
  for (const attachment of attachments) {
    zip.file(attachment.name, attachment.bytes, { date: localDate(attachment.at) });
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { zip: bytes, chatText, attachments: attachments.map(({ key, name, at }) => ({ key, name, at })) };
}

// Zip files keep the phone's local clock time with no zone. JSZip writes a Date's UTC fields, so the
// local Surat time is passed as if it were UTC.
function localDate(at) {
  return new Date(`${at.replace(' ', 'T')}Z`);
}

/** The stone lines Ravi typed into the chat, for the answer key. */
export function typedStoneLines() {
  const message = MESSAGES.find((m) => m.stoneList);
  return message.text.split('\n').filter((line) => /^\d\)/.test(line));
}
