// Tests for ingest: file type detection, zips, WhatsApp exports, emails, spreadsheets and PDF text.
// Every file is built here in memory; all names and numbers are fictional SAMPLE data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PDFDocument, PDFHexString, StandardFonts, degrees } from 'pdf-lib';
import { detectMime, ingestFile, kindForMime, parseChat, pdfInfo, sha256 } from '../../src/core/ingest/index.js';
import { htmlToText } from '../../src/core/ingest/email.js';
import { unpackBudget, unzip } from '../../src/core/ingest/zip.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const SOURCE = { kind: 'upload', receivedAt: '2026-11-15T10:00:00.000Z' };
const OCR_PNG = new URL('../fixtures/ingest/ocr-sample.png', import.meta.url);

function bytesOf(...parts) {
  const out = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

// A small PDF made with pdf-lib. Each text is drawn with Helvetica at (x, y) from the bottom left.
async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage(spec.size);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    for (const t of spec.texts || []) page.drawText(t.text, { x: t.x, y: t.y, size: t.size || 12, font });
    if (spec.png) {
      const image = await doc.embedPng(spec.png);
      page.drawImage(image, { x: 0, y: 0, width: spec.size[0], height: spec.size[1] });
    }
  }
  return { bytes: await doc.save(), font };
}

// The drawn width of a text: pdf-lib's widthOfTextAtSize applies kerning, but drawText does not,
// so add up the letters one by one.
function drawnWidth(font, text, size) {
  return [...text].reduce((sum, letter) => sum + font.widthOfTextAtSize(letter, size), 0);
}

async function makeZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array' });
}

function base64Lines(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n');
}

// --- detection ---------------------------------------------------------------------------------

test('sha256 gives the standard hex digest', () => {
  assert.equal(sha256(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.from('abc')), sha256(new TextEncoder().encode('abc')));
});

test('detectMime trusts magic bytes first, then the extension', async () => {
  const xlsxBytes = XLSX.write(sheetBook([['a']]), { type: 'array', bookType: 'xlsx' });
  const cases = [
    ['scan.bin', bytesOf('%PDF-1.7\n'), 'application/pdf'],
    ['invoice.pdf', bytesOf('junk before the header %PDF-1.4\n'), 'application/pdf'],
    ['photo', bytesOf(PNG_SIGNATURE), 'image/png'],
    ['report.pdf', bytesOf(PNG_SIGNATURE), 'image/png'],
    ['IMG-20261105-WA0003', FAKE_JPEG, 'image/jpeg'],
    ['anim', bytesOf('GIF89a'), 'image/gif'],
    ['pic', bytesOf('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
    ['IMG_0042.HEIC', bytesOf([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0]), 'image/heic'],
    ['clip.mov', bytesOf([0, 0, 0, 0x18], 'ftypqt  '), 'video/mp4'],
    ['scan.tif', bytesOf([0x49, 0x49, 0x2a, 0x00]), 'image/tiff'],
    ['bundle.zip', bytesOf('PK', [3, 4], 'rest'), 'application/zip'],
    ['book.xlsx', bytesOf('PK', [3, 4]), XLSX_MIME],
    ['no-extension', new Uint8Array(xlsxBytes), XLSX_MIME],
    ['old.xls', bytesOf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), XLS_MIME],
    ['mail.msg', bytesOf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/vnd.ms-outlook'],
    ['thread.eml', bytesOf('From: a@b.example\r\n'), 'message/rfc822'],
    ['saved', bytesOf('Received: x\r\nFrom: a@b.example\r\nTo: c@d.example\r\nSubject: hi\r\n\r\nbody'), 'message/rfc822'],
    ['notes.txt', bytesOf('hello'), 'text/plain'],
    ['readme', bytesOf('plain words\nand lines'), 'text/plain'],
    ['list.csv', bytesOf('a,b\n1,2'), 'text/csv'],
    ['data.json', bytesOf('{}'), 'application/json'],
    ['mystery', bytesOf([0, 1, 2, 3, 0]), 'application/octet-stream'],
    ['empty', new Uint8Array(0), 'application/octet-stream'],
  ];
  for (const [name, bytes, expected] of cases) assert.equal(detectMime(name, bytes), expected, name);
});

test('kindForMime maps MIME types to the kinds the agents use', () => {
  assert.equal(kindForMime('application/pdf'), 'pdf');
  assert.equal(kindForMime('image/heic'), 'image');
  assert.equal(kindForMime(XLSX_MIME), 'sheet');
  assert.equal(kindForMime('text/csv'), 'sheet');
  assert.equal(kindForMime('message/rfc822'), 'email');
  assert.equal(kindForMime('application/json'), 'text');
  assert.equal(kindForMime('application/zip'), 'other');
});

// --- single files --------------------------------------------------------------------------------

test('a plain file becomes one item with its hash and source', async () => {
  const { bytes } = await makePdf([{ size: [300, 300], texts: [{ text: 'SAMPLE', x: 20, y: 200 }] }]);
  const { items } = await ingestFile({ name: 'Invoice.pdf', bytes: Buffer.from(bytes), source: SOURCE });
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.name, 'Invoice.pdf');
  assert.equal(item.mime, 'application/pdf');
  assert.equal(item.kind, 'pdf');
  assert.equal(item.sha256, sha256(bytes));
  assert.deepEqual(item.source, SOURCE);
  assert.equal(item.parent, undefined);
  assert.equal(item.bytes.constructor, Uint8Array, 'bytes come back as a plain Uint8Array');
});

test('text files are decoded, including UTF-16 and HTML', async () => {
  const json = (await ingestFile({ name: 'refs.json', bytes: '{"ref":"EXP/26-27/28"}' })).items[0];
  assert.equal(json.kind, 'text');
  assert.equal(json.text, '{"ref":"EXP/26-27/28"}');
  assert.equal(json.source.kind, 'upload');
  assert.ok(json.source.receivedAt);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Carats 1.02 \u20b9 SAMPLE', 'utf16le')]);
  const note = (await ingestFile({ name: 'note.txt', bytes: utf16 })).items[0];
  assert.equal(note.text, 'Carats 1.02 \u20b9 SAMPLE');

  const html = '<html><head><style>p{}</style></head><body><p>Report 7000000001</p><p>Carat&nbsp;1.02 &amp; D</p></body></html>';
  const page = (await ingestFile({ name: 'report.html', bytes: html })).items[0];
  assert.equal(page.text, 'Report 7000000001\nCarat 1.02 & D');
});

test('unknown binary files are kept as kind other', async () => {
  const { items } = await ingestFile({ name: 'blob.dat', bytes: new Uint8Array([0, 159, 146, 150, 0]) });
  assert.equal(items[0].kind, 'other');
  assert.equal(items[0].mime, 'application/octet-stream');
});

// --- zips ----------------------------------------------------------------------------------------

test('zips expand with relative paths, one nested level, and no junk files', async () => {
  const deeper = await makeZip({ 'x.pdf': '%PDF-1.4 deep' });
  const inner = await makeZip({ 'awb.pdf': '%PDF-1.4 awb', 'deeper.zip': deeper });
  const outer = await makeZip({
    'docs/invoice.pdf': '%PDF-1.4 invoice',
    'docs/photo.jpg': FAKE_JPEG,
    'inner.zip': inner,
    '__MACOSX/docs/._invoice.pdf': 'junk',
    '.DS_Store': 'junk',
    'docs/.hidden.pdf': '%PDF-1.4 hidden',
    'docs/Thumbs.db': 'junk',
  });
  const { items } = await ingestFile({ name: 'EXP-28 papers.zip', bytes: outer, source: SOURCE });
  const names = items.map((item) => item.name);
  assert.deepEqual(names, ['docs/invoice.pdf', 'docs/photo.jpg', 'inner.zip/awb.pdf', 'inner.zip/deeper.zip']);
  assert.equal(items[0].parent, 'EXP-28 papers.zip');
  assert.equal(items[0].kind, 'pdf');
  assert.deepEqual(items[0].source, SOURCE);
  assert.equal(items[1].kind, 'image');
  assert.equal(items[2].parent, 'inner.zip');
  assert.equal(items[3].kind, 'other');
  assert.match(items[3].error, /not opened/);
});

test('a damaged zip becomes one item with an error, never a crash', async () => {
  const { items } = await ingestFile({ name: 'broken.zip', bytes: bytesOf('PK', [3, 4], 'this is not really a zip') });
  assert.equal(items.length, 1);
  assert.match(items[0].error, /Could not open this file/);
});

// Writes `size` as the unpacked size of every file, in the local headers and in the zip's directory.
function claimSize(zipBytes, size) {
  const bytes = new Uint8Array(zipBytes);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i + 30 <= bytes.length; i++) {
    const signature = view.getUint32(i, true);
    if (signature === 0x04034b50) view.setUint32(i + 22, size, true);
    if (signature === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return bytes;
}

test('a zip that lies about its size is stopped while unpacking, before the memory fills', async () => {
  const zip = new JSZip();
  zip.file('invoice.pdf', new Uint8Array(20 * 1024 * 1024)); // 20 MB of zeros packs into about 20 KB
  const bomb = claimSize(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), 10);
  assert.ok(bomb.length < 100 * 1024);

  const budget = unpackBudget(4 * 1024 * 1024);
  await assert.rejects(unzip(bomb, budget), /unpack to more than 4 MB/);
  assert.equal(budget.left, budget.limit, 'nothing is held from a refused zip');

  const { items } = await ingestFile({ name: 'papers.zip', bytes: bomb, maxUnpackedBytes: 4 * 1024 * 1024 });
  assert.equal(items.length, 1);
  assert.match(items[0].error, /Could not open this file: the zips in this file unpack to more than 4 MB/);
});

test('zips inside zips and emails share one unpacking budget', async () => {
  const part = async (n) => {
    const zip = new JSZip();
    zip.file(`part-${n}.pdf`, new Uint8Array(3 * 1024 * 1024)); // packs small, unpacks to 3 MB
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  };
  const outer = await makeZip({ 'part-1.zip': await part(1), 'part-2.zip': await part(2), 'part-3.zip': await part(3) });
  const limit = 8 * 1024 * 1024; // each part fits on its own, all three do not
  const { items } = await ingestFile({ name: 'papers.zip', bytes: outer, maxUnpackedBytes: limit });
  assert.deepEqual(items.map((item) => item.name), ['part-1.zip/part-1.pdf', 'part-2.zip/part-2.pdf', 'part-3.zip']);
  assert.equal(items[0].bytes.length, 3 * 1024 * 1024);
  assert.match(items[2].error, /unpack to more than 8 MB/);

  const zipped = Buffer.from(await part(1));
  const eml = [
    'From: mehul@sample-exports.example', 'To: docs@sample-house.example', 'Subject: SAMPLE parts', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"', '',
    '--B', 'Content-Type: text/plain', '', 'Two parts attached.',
    '--B', 'Content-Type: application/zip; name="a.zip"', 'Content-Disposition: attachment; filename="a.zip"',
    'Content-Transfer-Encoding: base64', '', base64Lines(zipped),
    '--B', 'Content-Type: application/zip; name="b.zip"', 'Content-Disposition: attachment; filename="b.zip"',
    'Content-Transfer-Encoding: base64', '', base64Lines(zipped),
    '--B--',
  ].join('\r\n');
  const fromEmail = (await ingestFile({ name: 'parts.eml', bytes: eml, maxUnpackedBytes: 5 * 1024 * 1024 })).items;
  assert.deepEqual(fromEmail.map((item) => [item.name, Boolean(item.error)]), [
    ['parts.eml', false], ['a.zip/part-1.pdf', false], ['b.zip', true],
  ]);
});

// --- WhatsApp ------------------------------------------------------------------------------------

const LRM = '\u200e';
const NNBSP = '\u202f';
const IPHONE_CHAT = [
  `[5/11/26, 11:20:01${NNBSP}PM] SAMPLE Export Desk: ${LRM}Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
  `${LRM}[5/11/26, 11:21:00${NNBSP}PM] ${LRM}Mehul SAMPLE created group \u201cSAMPLE Export Desk\u201d`,
  `[5/11/26, 11:25:43${NNBSP}PM] Mehul SAMPLE: Sending papers for EXP/26-27/28`,
  'Invoice and packing list below',
  `${LRM}[5/11/26, 11:26:02${NNBSP}PM] Mehul SAMPLE: ${LRM}INVOICE.pdf \u2022 ${LRM}2 pages ${LRM}<attached: 00000030-INVOICE.pdf>`,
  `${LRM}[5/11/26, 11:27:10${NNBSP}PM] \u202a+91 00000 00001\u202c: ${LRM}<attached: 00000031-PHOTO-2026-11-05-23-27-10.jpg>`,
  `${LRM}[5/11/26, 11:28:00${NNBSP}PM] Anika SAMPLE: ${LRM}image omitted`,
  `[5/11/26, 11:29:00${NNBSP}PM] Anika SAMPLE: Got it, thanks ${LRM}<This message was edited>`,
].join('\n');

test('an iPhone WhatsApp export becomes a chat plus attachments that know who sent them', async () => {
  const { bytes: invoice } = await makePdf([{ size: [300, 300], texts: [{ text: 'SAMPLE invoice', x: 20, y: 200 }] }]);
  const zip = await makeZip({
    '_chat.txt': IPHONE_CHAT,
    '00000031-PHOTO-2026-11-05-23-27-10.jpg': FAKE_JPEG,
    '00000030-INVOICE.pdf': invoice,
    '__MACOSX/._chat.txt': 'junk',
  });
  const { items } = await ingestFile({ name: 'WhatsApp Chat - SAMPLE Export Desk.zip', bytes: zip, source: SOURCE });
  assert.deepEqual(items.map((item) => item.name), ['_chat.txt', '00000030-INVOICE.pdf', '00000031-PHOTO-2026-11-05-23-27-10.jpg']);

  const [chatItem, pdfItem, photoItem] = items;
  assert.equal(chatItem.kind, 'chat');
  assert.equal(chatItem.parent, 'WhatsApp Chat - SAMPLE Export Desk.zip');
  assert.equal(chatItem.source.kind, 'whatsapp');
  assert.equal(chatItem.chat.title, 'SAMPLE Export Desk');
  assert.equal(chatItem.chat.dateOrder, 'DMY', 'the photo name says 2026-11-05, so 5/11/26 is day first');

  const messages = chatItem.chat.messages;
  assert.equal(messages.length, 5, 'the encryption notice and the group note are dropped');
  assert.deepEqual(messages[0], {
    at: '2026-11-05T23:25:43',
    atRaw: '5/11/26, 11:25:43 PM',
    author: 'Mehul SAMPLE',
    text: 'Sending papers for EXP/26-27/28\nInvoice and packing list below',
    attachment: null,
  });
  assert.equal(messages[1].attachment, '00000030-INVOICE.pdf');
  assert.equal(messages[1].text, 'INVOICE.pdf \u2022 2 pages');
  assert.equal(messages[2].author, '+91 00000 00001');
  assert.equal(messages[2].text, '');
  assert.equal(messages[3].text, 'image omitted');
  assert.equal(messages[3].attachment, null);
  assert.equal(messages[4].text, 'Got it, thanks');

  assert.equal(pdfItem.kind, 'pdf');
  assert.deepEqual(pdfItem.source, {
    ...SOURCE, kind: 'whatsapp', ref: 'SAMPLE Export Desk', chatAuthor: 'Mehul SAMPLE', chatAt: '2026-11-05T23:26:02',
  });
  assert.equal(photoItem.kind, 'image');
  assert.equal(photoItem.source.chatAuthor, '+91 00000 00001');
  assert.equal(photoItem.source.chatAt, '2026-11-05T23:27:10');
});

test('an Android WhatsApp export is read too, with system lines and media notes', async () => {
  const chat = [
    '05/11/2026, 23:20 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.',
    '05/11/2026, 23:21 - Mehul SAMPLE created group "SAMPLE Diamonds"',
    '05/11/2026, 23:22 - Mehul SAMPLE changed the group description: Papers for EXP/26-27/28',
    '05/11/2026, 23:25 - Mehul SAMPLE: IMG-20261105-WA0003.jpg (file attached)',
    'Packing list for EXP/26-27/28',
    '05/11/2026, 23:27 - Mehul SAMPLE: INVOICE EXP-28.pdf (file attached)',
    '05/11/2026, 23:28 - Anika SAMPLE: <Media omitted>',
    '13/11/2026, 09:05 - Anika SAMPLE: Received, will check',
    '',
  ].join('\r\n');
  const zip = await makeZip({
    'WhatsApp Chat with SAMPLE Diamonds.txt': chat,
    'IMG-20261105-WA0003.jpg': FAKE_JPEG,
    'INVOICE EXP-28.pdf': '%PDF-1.4 sample',
    'IMG-20261105-WA0009.jpg': FAKE_JPEG, // in the zip but not mentioned in the chat
  });
  const { items } = await ingestFile({ name: 'WhatsApp Chat with SAMPLE Diamonds.zip', bytes: zip, source: SOURCE });
  assert.deepEqual(items.map((item) => item.name), [
    'WhatsApp Chat with SAMPLE Diamonds.txt', 'IMG-20261105-WA0003.jpg', 'INVOICE EXP-28.pdf', 'IMG-20261105-WA0009.jpg',
  ]);
  const { chat: parsed } = items[0];
  assert.equal(parsed.title, 'SAMPLE Diamonds');
  assert.equal(parsed.dateOrder, 'DMY');
  assert.deepEqual(parsed.messages.map((m) => [m.at, m.author, m.text, m.attachment]), [
    ['2026-11-05T23:25:00', 'Mehul SAMPLE', 'Packing list for EXP/26-27/28', 'IMG-20261105-WA0003.jpg'],
    ['2026-11-05T23:27:00', 'Mehul SAMPLE', '', 'INVOICE EXP-28.pdf'],
    ['2026-11-05T23:28:00', 'Anika SAMPLE', '<Media omitted>', null],
    ['2026-11-13T09:05:00', 'Anika SAMPLE', 'Received, will check', null],
  ]);
  assert.equal(items[1].source.chatAuthor, 'Mehul SAMPLE');
  assert.equal(items[1].source.chatAt, '2026-11-05T23:25:00');
  assert.equal(items[3].source.kind, 'whatsapp');
  assert.equal(items[3].source.chatAuthor, undefined, 'a file no message mentions has no sender');
});

test('a re-zipped WhatsApp folder keeps its title and links its attachments', async () => {
  const zip = await makeZip({
    'WhatsApp Chat - SAMPLE Export Desk/_chat.txt': IPHONE_CHAT,
    'WhatsApp Chat - SAMPLE Export Desk/00000030-INVOICE.pdf': '%PDF-1.4 sample',
  });
  const { items } = await ingestFile({ name: 'Archive.zip', bytes: zip });
  assert.equal(items[0].chat.title, 'SAMPLE Export Desk');
  assert.equal(items[1].name, 'WhatsApp Chat - SAMPLE Export Desk/00000030-INVOICE.pdf');
  assert.equal(items[1].source.chatAuthor, 'Mehul SAMPLE');
});

test('a WhatsApp .txt on its own (exported without media) is still a chat', async () => {
  const text = [
    `11/5/26, 11:25${NNBSP}PM - Mehul SAMPLE: IMG-20261105-WA0003.jpg (file attached)`,
    `11/5/26, 11:26${NNBSP}PM - Mehul SAMPLE: Invoice to follow`,
    'second line',
  ].join('\n');
  const { items } = await ingestFile({ name: 'WhatsApp Chat with Mehul SAMPLE.txt', bytes: text });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'chat');
  assert.equal(items[0].source.kind, 'whatsapp');
  assert.equal(items[0].chat.title, 'Mehul SAMPLE');
  // 11/5 fits both orders; the attachment name holds 2026-11-05, so this phone writes month first.
  assert.equal(items[0].chat.dateOrder, 'MDY');
  assert.equal(items[0].chat.messages[0].at, '2026-11-05T23:25:00');
  assert.equal(items[0].chat.messages[1].text, 'Invoice to follow\nsecond line');

  const renamed = await ingestFile({ name: 'export.txt', bytes: '5/11/26, 23:25 - A: one\n5/11/26, 23:26 - B: two' });
  assert.equal(renamed.items[0].kind, 'chat', 'found by its content when the name says nothing');
});

test('parseChat reads both date orders and keeps the raw date', () => {
  const dayFirst = parseChat('[13/11/2026, 09:05:00] Anika: hi');
  assert.equal(dayFirst.messages[0].at, '2026-11-13T09:05:00');
  assert.equal(dayFirst.messages[0].atRaw, '13/11/2026, 09:05:00');
  const monthFirst = parseChat('11/13/26, 9:05 AM - Anika: hi');
  assert.equal(monthFirst.dateOrder, 'MDY');
  assert.equal(monthFirst.messages[0].at, '2026-11-13T09:05:00');
  const unclear = parseChat('5/6/26, 12:30 AM - Anika: hi');
  assert.equal(unclear.dateOrder, 'DMY', 'day first when nothing else tells');
  assert.equal(unclear.messages[0].at, '2026-06-05T00:30:00');
  const yearFirst = parseChat('2026-11-05, 23:25 - Anika: hi');
  assert.equal(yearFirst.messages[0].at, '2026-11-05T23:25:00');
  assert.deepEqual(parseChat('not a chat').messages, []);
});

// --- email ---------------------------------------------------------------------------------------

test('an .eml becomes an email item plus its attachments, without signature logos', async () => {
  const { bytes: invoice } = await makePdf([{ size: [300, 300], texts: [{ text: 'SAMPLE invoice', x: 20, y: 200 }] }]);
  const logo = bytesOf(PNG_SIGNATURE, new Array(200).fill(7));
  const forwarded = [
    'From: "Anika SAMPLE" <anika@sample-diamonds.example>',
    'To: mehul@sample-exports.example',
    'Subject: KP note',
    'Date: Wed, 04 Nov 2026 10:00:00 +0100',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="FWD"',
    '',
    '--FWD',
    'Content-Type: text/plain',
    '',
    'KP certificate to follow.',
    '--FWD',
    'Content-Type: text/csv; name="kp.csv"',
    'Content-Disposition: attachment; filename="kp.csv"',
    '',
    'KP,Country',
    'SAMPLE-KP-0001,BW',
    '--FWD--',
  ].join('\r\n');
  const eml = [
    'From: "Mehul SAMPLE" <mehul@sample-exports.example>',
    'To: docs@sample-house.example, "Desk SAMPLE" <desk@sample-house.example>',
    'Cc: broker@sample-broker.example',
    'Subject: EXP/26-27/28 papers',
    'Date: Thu, 05 Nov 2026 23:25:43 +0530',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIXED"',
    '',
    '--MIXED',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello, the invoice for EXP/26-27/28 is attached.',
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello, the invoice for <b>EXP/26-27/28</b> is attached.</p><img src="cid:logo1">',
    '--ALT--',
    '--REL',
    'Content-Type: image/png; name="image001.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo1>',
    'Content-Disposition: inline; filename="image001.png"',
    '',
    base64Lines(logo),
    '--REL--',
    '--MIXED',
    'Content-Type: application/pdf; name="INVOICE EXP-28.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="INVOICE EXP-28.pdf"',
    '',
    base64Lines(invoice),
    '--MIXED',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment',
    '',
    forwarded,
    '--MIXED--',
    '',
  ].join('\r\n');

  const { items } = await ingestFile({ name: 'EXP-28 papers.eml', bytes: eml, source: SOURCE });
  assert.deepEqual(items.map((item) => item.name), [
    'EXP-28 papers.eml', 'INVOICE EXP-28.pdf', 'forwarded-email-2.eml', 'forwarded-email-2.eml/kp.csv',
  ]);
  const [mail, pdf, inner, csv] = items;
  assert.equal(mail.kind, 'email');
  assert.deepEqual(mail.email, {
    from: '"Mehul SAMPLE" <mehul@sample-exports.example>',
    to: 'docs@sample-house.example, "Desk SAMPLE" <desk@sample-house.example>',
    cc: 'broker@sample-broker.example',
    subject: 'EXP/26-27/28 papers',
    date: '2026-11-05T17:55:43.000Z',
    text: 'Hello, the invoice for EXP/26-27/28 is attached.',
  });
  assert.match(mail.text, /^From: "Mehul SAMPLE"[\s\S]*Subject: EXP\/26-27\/28 papers[\s\S]*\n\nHello/);

  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.parent, 'EXP-28 papers.eml');
  assert.equal(pdf.sha256, sha256(invoice));
  assert.deepEqual(pdf.source, { ...SOURCE, kind: 'email', from: 'mehul@sample-exports.example', ref: 'EXP/26-27/28 papers' });

  assert.equal(inner.kind, 'email');
  assert.equal(inner.email.subject, 'KP note');
  assert.equal(csv.kind, 'sheet');
  assert.equal(csv.parent, 'forwarded-email-2.eml');
  assert.deepEqual(csv.sheet.sheets[0].rows, [['KP', 'Country'], ['SAMPLE-KP-0001', 'BW']]);
  assert.equal(csv.source.from, 'anika@sample-diamonds.example');
});

test('the HTML to text conversion takes time in step with the length, even for hostile HTML', () => {
  // Each of these took seconds (200 KB) to minutes (1 MB) with plain regular expressions.
  const size = 1024 * 1024;
  for (const [what, html] of [
    ['a <style> with no end', '<style'.repeat(size / 6)],
    ['a < with no >', '<'.repeat(size)],
    ['spaces with no line break', `${' '.repeat(size)}x`],
    ['all three', '<style<script<head <a '.repeat(size / 22)],
  ]) {
    const started = performance.now();
    htmlToText(html);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${what}: ${Math.round(ms)} ms`);
  }
  // The same text as the plain regular expressions give for ordinary HTML.
  const html = '<html><head><title>x</title><style>p { color: red }</style></head><body><script>run()</script>'
    + '<p>Invoice  <b>EXP/26-27/28</b>&nbsp;&amp; KP</p>  \n<table><tr><td>1.02</td><td>G</td></tr></table><br/>a &lt; b'
    + '<style>unclosed and kept';
  assert.equal(htmlToText(html), 'Invoice  EXP/26-27/28 & KP\n\n1.02\tG\n\na < bunclosed and kept');
});

test('an email with only an HTML body still gets plain text', async () => {
  const eml = [
    'From: desk@sample-house.example',
    'To: mehul@sample-exports.example',
    'Subject: Missing KP',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div>Please send the <b>KP certificate</b>.</div><div>Thanks &amp; regards</div>',
  ].join('\r\n');
  const { items } = await ingestFile({ name: 'missing-kp.eml', bytes: eml });
  assert.equal(items.length, 1);
  assert.equal(items[0].email.text, 'Please send the KP certificate.\nThanks & regards');
  assert.equal(items[0].email.date, null);
});

// --- spreadsheets ---------------------------------------------------------------------------------

function sheetBook(rows, name = 'Packing list') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return book;
}

test('an xlsx becomes rows of text plus a tab separated dump', async () => {
  const book = sheetBook([
    ['Sr', 'Lab', 'Report', 'Carat', 'Amount USD'],
    [1, 'GIA', '7000000001', 1.02, 12345],
    [],
    [2, 'IGI', '7000000002', 0.71, 4100.5, ''],
  ]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Total', 1.73]]), 'Totals');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const { items } = await ingestFile({ name: 'packing-list.xlsx', bytes });
  const [item] = items;
  assert.equal(item.kind, 'sheet');
  assert.equal(item.mime, XLSX_MIME);
  assert.deepEqual(item.sheet.sheets[0], {
    name: 'Packing list',
    rows: [['Sr', 'Lab', 'Report', 'Carat', 'Amount USD'], ['1', 'GIA', '7000000001', '1.02', '12345'], ['2', 'IGI', '7000000002', '0.71', '4100.5']],
  });
  assert.equal(item.sheet.sheets[1].name, 'Totals');
  assert.equal(item.text, item.sheet.text);
  assert.ok(item.sheet.text.startsWith('Sheet: Packing list\nSr\tLab\tReport\tCarat\tAmount USD\n1\tGIA\t7000000001'));
  assert.ok(item.sheet.text.includes('\n\nSheet: Totals\nTotal\t1.73'));
});

test('an old .xls and a .csv are read, and a csv keeps cells exactly as written', async () => {
  const xls = XLSX.write(sheetBook([['Report', 'Carat'], ['7000000001', 1.02]]), { type: 'buffer', bookType: 'biff8' });
  const fromXls = (await ingestFile({ name: 'old.xls', bytes: xls })).items[0];
  assert.equal(fromXls.mime, XLS_MIME);
  assert.deepEqual(fromXls.sheet.sheets[0].rows, [['Report', 'Carat'], ['7000000001', '1.02']]);

  const csv = 'Report,Carat,Date\n7000000001,"1,02",05/11/2026\n';
  const fromCsv = (await ingestFile({ name: 'stones.csv', bytes: csv })).items[0];
  assert.equal(fromCsv.kind, 'sheet');
  assert.deepEqual(fromCsv.sheet.sheets[0].rows[1], ['7000000001', '1,02', '05/11/2026']);
});

// An xlsx whose first sheet's XML is changed by edit(xml): a forged <dimension>, or cells placed far apart.
async function forgedXlsx(edit, sheets = 1) {
  const book = XLSX.utils.book_new();
  for (let i = 1; i <= sheets; i++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Report', 'Carat'], ['7000000001', '0.71']]), `S${i}`);
  const zip = await JSZip.loadAsync(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
  for (let i = 1; i <= sheets; i++) {
    const name = `xl/worksheets/sheet${i}.xml`;
    zip.file(name, edit(await zip.file(name).async('string')));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function timedSheet(name, bytes) {
  const started = performance.now();
  const [item] = (await ingestFile({ name, bytes })).items;
  return { item, ms: performance.now() - started };
}

test('a sheet that claims a huge size is read only where its cells are', async () => {
  // Any sender can write the size tag. Reading the box it claims took about 5 seconds per thousand rows, so the
  // A1:XFD1048576 of a real attack froze the whole app for hours. Now only the cells in the file count. (2,000
  // rows here, so a regression fails this test in half a minute instead of hanging it.)
  const forged = await forgedXlsx((xml) => xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD2000"/>'), 3);
  const { item, ms } = await timedSheet('forged.xlsx', forged);
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
  assert.equal(item.error, undefined);
  assert.deepEqual(item.sheet.sheets.map((sheet) => sheet.rows), Array(3).fill([['Report', 'Carat'], ['7000000001', '0.71']]));

  // Real cells far apart: a cell in the last column (XFD) and one 1,000 rows down. Only the first 200 columns are read.
  const far = await forgedXlsx((xml) => xml
    .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1000"/>')
    .replace('</sheetData>', '<row r="1000"><c r="XFD1000" t="inlineStr"><is><t>far</t></is></c></row></sheetData>'));
  const wide = await timedSheet('far.xlsx', far);
  assert.ok(wide.ms < 2000, `${Math.round(wide.ms)} ms`);
  assert.deepEqual(wide.item.sheet.sheets[0].rows, [['Report', 'Carat'], ['7000000001', '0.71']]);

  // A csv with one line of 16,384 cells and many empty lines: also only 200 columns.
  const csv = `${Array.from({ length: 16384 }, (_, i) => `c${i}`).join(',')}${'\n'.repeat(1500)}last`;
  const fromCsv = await timedSheet('wide.csv', csv);
  assert.ok(fromCsv.ms < 2000, `${Math.round(fromCsv.ms)} ms`);
  assert.equal(fromCsv.item.sheet.sheets[0].rows[0].length, 200);
  assert.deepEqual(fromCsv.item.sheet.sheets[0].rows[1], ['last']);
});

test('one file looks at no more than a million cells, however many sheets it has', async () => {
  // Every sheet holds a cell at A1 and one at GR5000: 200 columns by 5,000 rows, the most one sheet may read.
  const bytes = await forgedXlsx((xml) => xml
    .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:GR5000"/>')
    .replace('</sheetData>', '<row r="5000"><c r="GR5000" t="inlineStr"><is><t>end</t></is></c></row></sheetData>'), 4);
  const { item, ms } = await timedSheet('many.xlsx', bytes);
  assert.ok(ms < 5000, `${Math.round(ms)} ms`);
  assert.deepEqual(item.sheet.sheets.map((sheet) => sheet.rows.length), [3, 0, 0, 0]);
});

test('a very long sheet dump is cut at about 40,000 characters', async () => {
  const rows = [['Sr', 'Report', 'Notes']];
  for (let i = 1; i <= 3000; i++) rows.push([i, `GIA ${7000000000 + i}`, 'SAMPLE stone with a fairly long note']);
  const bytes = XLSX.write(sheetBook(rows), { type: 'buffer', bookType: 'xlsx' });
  const [item] = (await ingestFile({ name: 'big.xlsx', bytes })).items;
  assert.equal(item.sheet.sheets[0].rows.length, 3001);
  assert.ok(item.sheet.text.length < 40200, `length ${item.sheet.text.length}`);
  assert.match(item.sheet.text, /The rest is not shown/);
});

// --- PDF text layer ---------------------------------------------------------------------------------

test('pdfInfo reads every word with a box in reading order', async () => {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const valueX = 50 + drawnWidth(font, 'Consignee: ', 12); // one space after the label
  const { bytes: pdf } = await makePdf([
    {
      size: [600, 800],
      texts: [
        // The value is drawn before its label on purpose: the text must still read left to right.
        { text: 'SAMPLE Diamonds BVBA', x: valueX, y: 600 },
        { text: 'Invoice No: EXP/26-27/28', x: 50, y: 700 },
        { text: 'Consignee:', x: 50, y: 600 },
        { text: 'Antwerp', x: 450, y: 600 },
        { text: 'Total carats 1,02 and pieces 2 for this SAMPLE parcel', x: 50, y: 500, size: 10 },
      ],
    },
    { size: [400, 400], texts: [{ text: 'Second page', x: 20, y: 360, size: 20 }] },
  ]);

  const before = pdf.length;
  const info = await pdfInfo(pdf);
  assert.equal(pdf.length, before, 'the caller keeps its bytes');
  assert.equal(info.error, undefined);
  assert.equal(info.pages, 2);
  assert.deepEqual(info.pageSizes, [{ w: 600, h: 800 }, { w: 400, h: 400 }]);
  assert.deepEqual(info.pageTexts[0].split('\n'), [
    'Invoice No: EXP/26-27/28',
    'Consignee: SAMPLE Diamonds BVBA\tAntwerp',
    'Total carats 1,02 and pieces 2 for this SAMPLE parcel',
  ]);
  assert.equal(info.pageTexts[1], 'Second page');
  assert.equal(info.text, `${info.pageTexts[0]}\n\n${info.pageTexts[1]}`);
  assert.deepEqual(info.pageHasText, [true, false]);
  assert.equal(info.hasTextLayer, true);

  // Word boxes: x from the Helvetica widths, y around the baseline (700 pt from the bottom = 0.125 from the top).
  const word = info.words.find((w) => w.text === 'EXP/26-27/28');
  assert.equal(word.page, 1);
  assert.ok(Math.abs(word.x0 - (50 + drawnWidth(font, 'Invoice No: ', 12)) / 600) < 0.001, `x0 ${word.x0}`);
  assert.ok(Math.abs(word.x1 - (50 + drawnWidth(font, 'Invoice No: EXP/26-27/28', 12)) / 600) < 0.001, `x1 ${word.x1}`);
  assert.ok(word.y0 < 0.125 && word.y1 > 0.125, `y ${word.y0} ${word.y1}`);
  assert.ok(Math.abs(word.y1 - word.y0 - 12 / 800) < 0.004, 'box height is about the font size');

  const carats = info.words.find((w) => w.text === '1,02');
  assert.ok(Math.abs(carats.x0 - (50 + drawnWidth(font, 'Total carats ', 10)) / 600) < 0.001, `x0 ${carats.x0}`);
  assert.ok(Math.abs(carats.x1 - (50 + drawnWidth(font, 'Total carats 1,02', 10)) / 600) < 0.001, `x1 ${carats.x1}`);
  const second = info.words.find((w) => w.text === 'Second');
  assert.equal(second.page, 2);
  assert.ok(Math.abs(second.x0 - 20 / 400) < 0.002);

  // Reading order: page 1 words top to bottom, then page 2.
  assert.deepEqual(info.words.slice(0, 4).map((w) => w.text), ['Invoice', 'No:', 'EXP/26-27/28', 'Consignee:']);
  for (const w of info.words) {
    for (const v of [w.x0, w.y0, w.x1, w.y1]) assert.ok(v >= 0 && v <= 1);
    assert.ok(w.x1 > w.x0 && w.y1 > w.y0);
  }
});

test('pdfInfo handles rotated pages', async () => {
  const { bytes, font } = await makePdf([{ size: [600, 800], rotate: 90, texts: [{ text: 'Rotated SAMPLE page', x: 50, y: 700 }] }]);
  const info = await pdfInfo(bytes);
  assert.deepEqual(info.pageSizes, [{ w: 800, h: 600 }]);
  const word = info.words.find((w) => w.text === 'Rotated');
  // Turned a quarter: the text now runs down the page near x = 700 / 800.
  assert.ok(word.x0 < 0.875 && word.x1 > 0.875, `x ${word.x0} ${word.x1}`);
  assert.ok(Math.abs(word.y0 - 50 / 600) < 0.002, `y0 ${word.y0}`);
  assert.ok(Math.abs(word.y1 - (50 + drawnWidth(font, 'Rotated', 12)) / 600) < 0.001, `y1 ${word.y1}`);
});

test('a scanned PDF (only a picture) has no text layer', async () => {
  const { bytes } = await makePdf([{ size: [500, 210], png: fs.readFileSync(OCR_PNG) }]);
  const info = await pdfInfo(bytes);
  assert.equal(info.pages, 1);
  assert.equal(info.hasTextLayer, false);
  assert.deepEqual(info.pageHasText, [false]);
  assert.deepEqual(info.words, []);
  assert.equal(info.text, '');
});

test('broken and locked PDFs give pages 0 and an error, never a throw', async () => {
  for (const bad of [bytesOf('%PDF-1.4\nnothing else'), new Uint8Array([1, 2, 3]), new Uint8Array(0)]) {
    const info = await pdfInfo(bad);
    assert.equal(info.pages, 0);
    assert.equal(typeof info.error, 'string');
    assert.deepEqual(info.words, []);
  }

  // A PDF that asks for a password: the security dictionary does not accept an empty one.
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const security = doc.context.obj({
    Filter: 'Standard', V: 1, R: 2, P: -44, O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('11'.repeat(32)),
  });
  doc.context.trailerInfo.Encrypt = doc.context.register(security);
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of('ab'.repeat(16)), PDFHexString.of('ab'.repeat(16))]);
  const locked = await pdfInfo(await doc.save({ useObjectStreams: false }));
  assert.equal(locked.pages, 0);
  assert.equal(locked.error, 'This PDF is locked with a password.');
});
