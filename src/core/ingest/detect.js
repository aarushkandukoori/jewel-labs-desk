// Works out what a file is. The first bytes ("magic bytes") are checked first because names lie:
// WhatsApp and phones often save files with odd or missing extensions. The extension is the fallback.
import { createHash } from 'node:crypto';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
  zip: 'application/zip',
  eml: 'message/rfc822',
  txt: 'text/plain', text: 'text/plain', log: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  xlsx: XLSX_MIME, xlsm: XLSX_MIME, xls: XLS_MIME, ods: ODS_MIME,
  docx: DOCX_MIME, doc: 'application/msword', msg: 'application/vnd.ms-outlook',
};

const SHEET_MIMES = [XLSX_MIME, XLS_MIME, ODS_MIME, 'text/csv'];
const TEXT_MIMES = ['application/json', 'application/xml'];

// HEIC photos (iPhone) and AVIF images are "ftyp" boxes; videos use the same box with other brands.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
const AVIF_BRANDS = ['avif', 'avis'];

/** sha256 of the bytes as lowercase hex (sync). */
export function sha256(bytes) {
  return createHash('sha256').update(toBytes(bytes)).digest('hex');
}

/** The MIME type of a file, from its magic bytes first and its name second (sync). */
export function detectMime(name, bytes) {
  const data = toBytes(bytes);
  const ext = extensionOf(name);
  const fromBytes = mimeFromMagic(data, ext);
  if (fromBytes) return fromBytes;
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  // No extension we know. Saved emails and plain text have no magic bytes, so look at the content.
  if (looksLikeEmail(data)) return 'message/rfc822';
  if (looksLikeText(data)) return 'text/plain';
  return 'application/octet-stream';
}

/** Maps a MIME type to the kind the pipeline works with. 'chat' is set later by the WhatsApp reader. */
export function kindForMime(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (SHEET_MIMES.includes(mime)) return 'sheet';
  if (mime === 'message/rfc822') return 'email';
  if (mime.startsWith('text/') || TEXT_MIMES.includes(mime)) return 'text';
  return 'other';
}

function mimeFromMagic(data, ext) {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp';
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (ascii(data, 0, 2) === 'BM' && data.length > 14 && littleEndian32(data, 2) === data.length) return 'image/bmp';
  if (ascii(data, 4, 8) === 'ftyp') {
    const brand = ascii(data, 8, 12);
    if (HEIC_BRANDS.includes(brand)) return 'image/heic';
    if (AVIF_BRANDS.includes(brand)) return 'image/avif';
    return 'video/mp4';
  }
  if (ascii(data, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(data, 0, 2) === 'PK' && [3, 5, 7].includes(data[2])) return zipFlavour(data, ext);
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return oleFlavour(ext);
  // Some PDF writers put a little junk before the header; PDF readers accept up to 1 KB of it.
  if (ext === 'pdf' && ascii(data, 0, 1024).includes('%PDF-')) return 'application/pdf';
  return null;
}

// Office files (xlsx, docx) are zips too. The extension tells them apart; without one, the zip's
// directory (stored at the end of the file) lists the parts, such as xl/workbook.xml.
function zipFlavour(data, ext) {
  if (ext === 'xlsx' || ext === 'xlsm') return XLSX_MIME;
  if (ext === 'ods') return ODS_MIME;
  if (ext === 'docx') return DOCX_MIME;
  if (ext === 'zip') return 'application/zip';
  const tail = ascii(data, Math.max(0, data.length - 65536), data.length);
  if (tail.includes('xl/workbook.xml')) return XLSX_MIME;
  if (tail.includes('word/document.xml')) return DOCX_MIME;
  return 'application/zip';
}

// Old Office files (xls, doc, Outlook msg) share one container format. Spreadsheets are the likely case.
function oleFlavour(ext) {
  if (ext === 'msg') return 'application/vnd.ms-outlook';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
  return XLS_MIME;
}

// A saved email starts with header lines such as "From: ..." and "Subject: ...".
function looksLikeEmail(data) {
  const head = ascii(data, 0, 4096);
  if (!/^[A-Za-z][A-Za-z0-9-]*:[ \t]/.test(head)) return false;
  const headers = head.match(/^(Received|From|To|Subject|Date|Message-ID|MIME-Version|Return-Path|Delivered-To):/gim) || [];
  return new Set(headers.map((h) => h.toLowerCase())).size >= 3;
}

// Text has no NUL bytes or other control characters (tabs and line breaks are fine).
function looksLikeText(data) {
  if (data.length === 0) return false;
  if (startsWith(data, [0xef, 0xbb, 0xbf]) || startsWith(data, [0xff, 0xfe]) || startsWith(data, [0xfe, 0xff])) return true;
  const end = Math.min(data.length, 4096);
  for (let i = 0; i < end; i++) {
    const b = data[i];
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return false;
  }
  return true;
}

/** Text from bytes: honours a BOM (UTF-8 or UTF-16), else UTF-8, else Windows-1252 for old exports. */
export function decodeText(bytes) {
  const data = toBytes(bytes);
  if (startsWith(data, [0xef, 0xbb, 0xbf])) return new TextDecoder('utf-8').decode(data.subarray(3));
  if (startsWith(data, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (startsWith(data, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(data.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Accepts Uint8Array, Buffer, ArrayBuffer, any typed array or a string; returns a plain Uint8Array. */
export function toBytes(data) {
  if (data instanceof Uint8Array) {
    // A Buffer is a Uint8Array too; hand out a plain view so every item looks the same.
    return data.constructor === Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(0);
}

/** "Invoice.PDF" -> "pdf"; "" when there is no extension. */
export function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function startsWith(data, magic) {
  if (data.length < magic.length) return false;
  return magic.every((byte, i) => data[i] === byte);
}

// Reads bytes [start, end) as Latin-1 characters: enough to compare against ASCII markers.
function ascii(data, start, end) {
  let out = '';
  for (let i = start; i < Math.min(end, data.length); i++) out += String.fromCharCode(data[i]);
  return out;
}

function littleEndian32(data, offset) {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}
