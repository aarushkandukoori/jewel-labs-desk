// A tiny PDF writer for the browser demo: text in the standard PDF fonts (Helvetica, Helvetica-Bold,
// Courier), lines and boxes. No library needed, and it runs in Node too (for the tests).
// Coordinates are in PDF points from the top-left of the page (y is the text baseline).

export const A4 = { width: 595.28, height: 841.89 };

// Glyph widths (per 1000 units of font size) for characters 32..126, from the Adobe font metrics.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const FONTS = { R: 'Helvetica', B: 'Helvetica-Bold', M: 'Courier' };

/** Keeps text to plain ASCII, which the standard fonts can always draw. */
export function plain(text) {
  return String(text ?? '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-')
    .replace(/·/g, '-').replace(/•/g, '*').replace(/→/g, '->').replace(/[^\x20-\x7e]/g, '?');
}

/** Width of a string in points. font: 'R' | 'B' | 'M'. */
export function textWidth(text, font = 'R', size = 10) {
  const s = plain(text);
  if (font === 'M') return s.length * 600 * size / 1000;
  const table = font === 'B' ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (let i = 0; i < s.length; i++) units += table[s.charCodeAt(i) - 32] ?? 556;
  return units * size / 1000;
}

function escapeText(text) {
  return plain(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => (c || [0, 0, 0]).map((v) => num(v)).join(' ');

/** The drawing commands for one page. */
function pageStream(page) {
  const h = page.height || A4.height;
  const out = [];
  for (const op of page.ops) {
    if (op.t === 'text') {
      const font = { R: 'F1', B: 'F2', M: 'F3' }[op.font || 'R'];
      out.push(`BT ${rgb(op.color)} rg /${font} ${num(op.size || 10)} Tf 1 0 0 1 ${num(op.x)} ${num(h - op.y)} Tm (${escapeText(op.text)}) Tj ET`);
    } else if (op.t === 'line') {
      out.push(`${rgb(op.color)} RG ${num(op.width || 0.6)} w ${num(op.x1)} ${num(h - op.y1)} m ${num(op.x2)} ${num(h - op.y2)} l S`);
    } else if (op.t === 'rect') {
      const y = h - op.y - op.h;
      if (op.fill) out.push(`${rgb(op.fill)} rg ${num(op.x)} ${num(y)} ${num(op.w)} ${num(op.h)} re f`);
      if (op.stroke) out.push(`${rgb(op.stroke)} RG ${num(op.width || 0.6)} w ${num(op.x)} ${num(y)} ${num(op.w)} ${num(op.h)} re S`);
    }
  }
  return out.join('\n');
}

/**
 * Builds a PDF. pages: [{ width?, height?, ops: [{ t: 'text', x, y, text, size, font, color } |
 * { t: 'line', x1, y1, x2, y2, width, color } | { t: 'rect', x, y, w, h, fill, stroke, width }] }].
 * Returns the file as a Uint8Array.
 */
export function makePdf(pages, { title = 'Document', author = 'Jewel Labs demo' } = {}) {
  const objects = []; // index + 1 = object number
  const add = (body) => { objects.push(body); return objects.length; };

  const catalog = add(null); // filled in below, once the pages object exists
  const pagesObj = add(null);
  const fonts = Object.values(FONTS).map((name) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
  const info = add(`<< /Title (${escapeText(title)}) /Author (${escapeText(author)}) /Producer (Jewel Labs demo) >>`);
  const kids = [];
  for (const page of pages) {
    const w = page.width || A4.width;
    const h = page.height || A4.height;
    const stream = pageStream(page);
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  // Everything is ASCII, so string length equals byte length and the offsets are exact.
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}

/** A small helper for laying out a page: draws text and remembers where each field's value went. */
export function pageBuilder({ width = A4.width, height = A4.height, page = 1 } = {}) {
  const ops = [];
  const fields = [];
  const grey = [0.42, 0.45, 0.5];

  const api = {
    ops,
    fields,
    width,
    height,
    text(x, y, text, { size = 9, font = 'R', color } = {}) {
      ops.push({ t: 'text', x, y, text: plain(text), size, font, color });
      return textWidth(text, font, size);
    },
    line(x1, y1, x2, y2, opts = {}) {
      ops.push({ t: 'line', x1, y1, x2, y2, width: opts.width || 0.6, color: opts.color || [0.15, 0.15, 0.15] });
    },
    rect(x, y, w, h, opts = {}) {
      ops.push({ t: 'rect', x, y, w, h, fill: opts.fill || null, stroke: opts.stroke || null, width: opts.width });
    },
    /** Prints a value and records its box as a field the agents read. */
    value(key, x, y, value, { size = 9, font = 'R', confidence = 0.97, show = value } = {}) {
      const w = api.text(x, y, show, { size, font });
      fields.push({
        key, value: String(value), quote: String(show), page, confidence,
        box: [(x - 2) / width, (y - size * 0.86 - 2) / height, (x + w + 2) / width, (y + size * 0.24 + 2) / height].map((n) => Math.round(n * 10000) / 10000),
      });
      return w;
    },
    /** "Label:" in grey, then the value as a field. */
    labelled(key, x, y, label, value, { size = 9, gap = 6, labelWidth, font = 'R', confidence } = {}) {
      const lw = api.text(x, y, label, { size, color: grey });
      return api.value(key, x + (labelWidth ?? lw + gap), y, value, { size, font, confidence });
    },
  };
  return api;
}
