// Ingest: turns one incoming file into the items the agents read.
// - Zips are unpacked (a zip inside the zip too), skipping __MACOSX and dotfiles.
// - A WhatsApp export becomes one chat item plus one item per attachment, each tagged with who sent it.
// - An .eml becomes one email item plus one item per attachment.
// - Spreadsheets become rows of text; text files become text.
// A bad file never throws: its item carries an `error` message instead, so autopilot keeps going.
import { decodeText, detectMime, kindForMime, sha256, toBytes } from './detect.js';
import { baseName, cleanPath, unzip } from './zip.js';
import { chatTitleFromName, isChatFileName, looksLikeChat, parseChat } from './whatsapp.js';
import { emailAsText, htmlToText, readEmail } from './email.js';
import { readSheet } from './sheet.js';

export { decodeText, detectMime, kindForMime, sha256 } from './detect.js';
export { pdfInfo } from './pdf.js';
export { parseChat } from './whatsapp.js';

const MAX_ZIPS_DEEP = 2; // a zip, and one zip inside it
const MAX_CONTAINERS_DEEP = 4; // zips and emails inside each other, in any mix

/**
 * ingestFile({ name, bytes, source }) -> { items }
 * name: the file name (a relative path is kept). source: where it came from, e.g. { kind: 'upload' }.
 * Each item: { name, mime, kind, bytes, sha256, source, parent?, chat?, email?, sheet?, text?, error? }.
 */
export async function ingestFile({ name, bytes, source } = {}) {
  const items = [];
  const file = {
    name: cleanPath(name) || 'file',
    bytes: toBytes(bytes),
    source: { kind: 'upload', ...source, receivedAt: source?.receivedAt || new Date().toISOString() },
    parent: null,
    depth: 0, // how many zips or emails this file sits inside
    zips: 0, // how many of those are zips
  };
  await addFile(items, file);
  return { items };
}

async function addFile(items, file) {
  const mime = detectMime(file.name, file.bytes);
  const kind = kindForMime(mime);
  try {
    if (mime === 'application/zip') return await addZip(items, file);
    if (mime === 'message/rfc822') return await addEmail(items, file);
    if (kind === 'sheet') return addSheet(items, file, mime);
    if (kind === 'text') return addText(items, file, mime);
    items.push(makeItem(file, mime));
  } catch (err) {
    items.push(makeItem(file, mime, { error: `Could not open this file: ${err?.message || err}` }));
  }
}

async function addZip(items, file) {
  if (file.zips >= MAX_ZIPS_DEEP || file.depth >= MAX_CONTAINERS_DEEP) {
    const error = 'This zip is packed inside other zips too deeply, so it was not opened. Unzip it and add the files.';
    items.push(makeItem(file, 'application/zip', { error }));
    return;
  }
  const files = await unzip(file.bytes);
  const zip = { ...file, zips: file.zips + 1 };
  const chatFile = files.find((entry) => isChatFileName(entry.path));
  if (chatFile) {
    await addWhatsAppExport(items, zip, chatFile, files.filter((entry) => entry !== chatFile));
    return;
  }
  for (const entry of files) await addFile(items, inside(zip, entry.path, entry.bytes, file.source));
}

// A WhatsApp export: the chat first, then the attachments in the order they were sent. Each attachment
// remembers who sent it and when, so the agents can tie "invoice for EXP/28" to the right PDF.
async function addWhatsAppExport(items, zip, chatFile, attachments) {
  const text = decodeText(chatFile.bytes);
  const title = chatTitle(zip.name, chatFile.path);
  const chat = parseChat(text, { title, fileNames: attachments.map((entry) => baseName(entry.path)) });
  const chatSource = { ...zip.source, kind: 'whatsapp', ref: title };
  items.push(makeItem(inside(zip, chatFile.path, chatFile.bytes, chatSource), 'text/plain', { kind: 'chat', chat, text }));

  const messageIndex = new Map();
  for (const entry of attachments) {
    const index = chat.messages.findIndex((message) => sameFileName(message.attachment, entry.path));
    messageIndex.set(entry, index < 0 ? chat.messages.length : index); // files no message mentions go last
  }
  const ordered = [...attachments].sort((p, q) => messageIndex.get(p) - messageIndex.get(q));
  for (const entry of ordered) {
    const message = chat.messages[messageIndex.get(entry)];
    const source = message ? { ...chatSource, chatAuthor: message.author, chatAt: message.at } : chatSource;
    await addFile(items, inside(zip, entry.path, entry.bytes, source));
  }
}

// The chat's name, from "WhatsApp Chat - X.zip", from the chat file, or from the folder holding it
// (people often unzip an export and zip the folder again).
function chatTitle(zipName, chatPath) {
  const folder = chatPath.split('/').slice(0, -1).pop() || '';
  return (
    chatTitleFromName(zipName) ||
    chatTitleFromName(chatPath) ||
    chatTitleFromName(folder) ||
    baseName(zipName).replace(/\.[^.]+$/, '')
  );
}

async function addEmail(items, file) {
  const { email, fromAddress, attachments } = await readEmail(file.bytes);
  const tooDeep = file.depth >= MAX_CONTAINERS_DEEP && attachments.length > 0;
  const extra = tooDeep ? { error: 'The attachments were not opened: this email is packed inside too many files.' } : {};
  items.push(makeItem(file, 'message/rfc822', { email, text: emailAsText(email), ...extra }));
  if (tooDeep) return;
  const source = { ...file.source, kind: 'email', from: fromAddress || email.from, ref: email.subject };
  for (const attachment of attachments) {
    await addFile(items, inside(file, attachment.name, attachment.bytes, source));
  }
}

function addSheet(items, file, mime) {
  const sheet = readSheet(file.bytes, mime);
  items.push(makeItem(file, mime, { sheet, text: sheet.text }));
}

function addText(items, file, mime) {
  const text = decodeText(file.bytes);
  // A WhatsApp chat exported without media is a lone .txt file.
  if (mime === 'text/plain' && (isChatFileName(file.name) || looksLikeChat(text))) {
    const title = chatTitleFromName(file.name) || 'WhatsApp chat';
    const chat = parseChat(text, { title });
    const source = { ...file.source, kind: 'whatsapp', ref: title };
    items.push(makeItem({ ...file, source }, mime, { kind: 'chat', chat, text }));
    return;
  }
  items.push(makeItem(file, mime, { text: mime === 'text/html' ? htmlToText(text) : text }));
}

// A file found inside a zip or an email. Inside a nested zip or email the container's name is kept in
// front ("docs/inner.zip/invoice.pdf") so it stays clear where the file came from.
function inside(container, name, bytes, source) {
  const path = cleanPath(name) || 'file';
  return {
    name: container.depth === 0 ? path : `${container.name}/${path}`,
    bytes,
    source,
    parent: container.name,
    depth: container.depth + 1,
    zips: container.zips,
  };
}

function makeItem(file, mime, extra = {}) {
  const item = {
    name: file.name,
    mime,
    kind: kindForMime(mime),
    bytes: file.bytes,
    sha256: sha256(file.bytes),
    source: file.source,
  };
  if (file.parent) item.parent = file.parent;
  return { ...item, ...extra };
}

function sameFileName(a, b) {
  return Boolean(a) && baseName(a).toLowerCase() === baseName(b).toLowerCase();
}
