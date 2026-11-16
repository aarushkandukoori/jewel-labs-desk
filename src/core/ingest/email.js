// Reads saved emails (.eml) with mailparser: who sent it, to whom, the subject, the body text and
// the attached files.
import { simpleParser } from 'mailparser';
import { toBytes } from './detect.js';
import { baseName } from './zip.js';

// Small pictures shown inside the email body are signature logos and icons, not papers.
// Screenshots pasted into an email are bigger than this, so they are kept.
const LOGO_MAX_BYTES = 20 * 1024;
const SIGNATURE_TYPES = ['application/pkcs7-signature', 'application/x-pkcs7-signature', 'application/pgp-signature'];

const EXTENSION_BY_TYPE = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/tiff': 'tif', 'message/rfc822': 'eml', 'application/zip': 'zip', 'text/plain': 'txt',
  'text/csv': 'csv', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * Parses an .eml file. Returns { email: { from, to, cc, subject, date, text }, fromAddress, attachments },
 * where attachments are [{ name, bytes, mime }] and date is ISO (UTC) or null.
 */
export async function readEmail(bytes) {
  const data = toBytes(bytes);
  const mail = await simpleParser(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    skipImageLinks: true,
    skipTextLinks: true,
    skipTextToHtml: true,
  });
  const email = {
    from: addressText(mail.from),
    to: addressText(mail.to),
    cc: addressText(mail.cc),
    subject: (mail.subject || '').trim(),
    date: mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : null,
    text: (mail.text || '').trim() || htmlToText(mail.html),
  };
  const attachments = (mail.attachments || []).filter(isPaper).map((attachment, index) => ({
    name: attachmentName(attachment, index),
    bytes: toBytes(attachment.content),
    mime: attachment.contentType || 'application/octet-stream',
  }));
  return { email, fromAddress: firstAddress(mail.from), attachments };
}

/** The email as plain text: header lines, a blank line, then the body. */
export function emailAsText(email) {
  const header = [`From: ${email.from}`, `To: ${email.to}`];
  if (email.cc) header.push(`Cc: ${email.cc}`);
  header.push(`Subject: ${email.subject}`, `Date: ${email.date || ''}`);
  return `${header.join('\n')}\n\n${email.text}`;
}

/**
 * A small HTML to text conversion: no scripts or styles, line breaks at block ends, common entities.
 * Every step runs in time proportional to the length of the HTML. Anyone can email the house, and the
 * plain regular expressions for these steps rescan the rest of the text from each "<style" with no end
 * tag, each "<" with no ">" and each space not followed by a line break: 200 KB of that took 20 seconds.
 */
export function htmlToText(html) {
  if (!html) return '';
  const marked = dropBlocks(String(html))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t');
  return stripTags(marked)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (whole, code) => (Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : ''))
    .replace(/&amp;/gi, '&') // last, so "&amp;lt;" stays "&lt;"
    .replace(/(?<![ \t])[ \t]+\n/g, '\n') // tried from the first space of a run only, so a long run is read once
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_START = /<(script|style|head)\b/gi;
const BLOCK_END = { script: /<\/script>/gi, style: /<\/style>/gi, head: /<\/head>/gi };

/**
 * Drops <script>, <style> and <head> blocks: the same as .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ').
 * Once a block has no end tag left, the same kind of block cannot end later either, so its end tag is
 * looked for once instead of once for every opening.
 */
function dropBlocks(html) {
  const unclosed = new Set();
  let out = '';
  let from = 0;
  BLOCK_START.lastIndex = 0;
  for (let start = BLOCK_START.exec(html); start; start = BLOCK_START.exec(html)) {
    const tag = start[1].toLowerCase();
    if (unclosed.has(tag)) continue;
    const end = BLOCK_END[tag];
    end.lastIndex = BLOCK_START.lastIndex;
    if (!end.exec(html)) {
      unclosed.add(tag);
      continue;
    }
    out += `${html.slice(from, start.index)} `;
    from = end.lastIndex;
    BLOCK_START.lastIndex = end.lastIndex;
  }
  return out + html.slice(from);
}

/** Removes tags: the same as .replace(/<[^>]*>/g, ''). After the last ">" no tag can end, so that tail stays as it is. */
function stripTags(text) {
  const end = text.lastIndexOf('>') + 1;
  return text.slice(0, end).replace(/<[^>]*>/g, '') + text.slice(end);
}

function isPaper(attachment) {
  const type = (attachment.contentType || '').toLowerCase();
  if (SIGNATURE_TYPES.includes(type)) return false;
  const shownInBody = attachment.related || attachment.contentDisposition === 'inline';
  const size = attachment.content ? attachment.content.length : 0;
  return !(type.startsWith('image/') && shownInBody && size < LOGO_MAX_BYTES);
}

function attachmentName(attachment, index) {
  const name = baseName(attachment.filename || '');
  if (name) return name;
  const type = (attachment.contentType || '').toLowerCase();
  if (type === 'message/rfc822') return `forwarded-email-${index + 1}.eml`;
  return `attachment-${index + 1}.${EXTENSION_BY_TYPE[type] || 'bin'}`;
}

// mailparser gives { text: '"Mehul" <mehul@x.example>', value: [{ name, address }] }, or a list of those.
function addressText(field) {
  if (!field) return '';
  const list = Array.isArray(field) ? field : [field];
  return list.map((entry) => entry.text || '').filter(Boolean).join(', ');
}

function firstAddress(field) {
  const first = Array.isArray(field) ? field[0] : field;
  return first?.value?.[0]?.address || '';
}
