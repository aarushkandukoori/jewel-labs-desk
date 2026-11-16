// One page of a document: a PDF page drawn with pdf.js, or a photo. Field boxes sit on top in
// page coordinates (0..1 from the top-left), so "every field links to its spot on the page".
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { docFile } from '../lib/files.js';
import { openPdf, drawPage } from '../lib/pdf.js';

/** A box's position as CSS percentages. box = [x0, y0, x1, y1]. */
export function boxStyle(box, color) {
  const [x0, y0, x1, y1] = box.map((n) => Math.max(0, Math.min(1, Number(n) || 0)));
  return {
    left: `${(x0 * 100).toFixed(3)}%`,
    top: `${(y0 * 100).toFixed(3)}%`,
    width: `${(Math.max(0.004, x1 - x0) * 100).toFixed(3)}%`,
    height: `${(Math.max(0.006, y1 - y0) * 100).toFixed(3)}%`,
    '--c': color || '#7dd3fc',
  };
}

/** The class for where a box's chip sits (see layoutChips in lib/reading.js). */
export function chipClass(b) {
  if (!b.label || b.chip === false) return 'no-chip';
  if (!b.chip || b.chip === 'right') return '';
  return `chip-${b.chip}`;
}

export function isValidBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every((n) => Number.isFinite(Number(n))) && Number(box[2]) > Number(box[0]) && Number(box[3]) > Number(box[1]);
}

/**
 * props: docId, page (1-based), boxes [{ id, box, color, label, shown, pulse, dim }], onBox(box), onPages(n),
 * maxWidth (px to draw at), children (extra overlay content such as agent cursors).
 */
export function PageView({ docId, page = 1, boxes = [], onBox, onPages, children, fallback }) {
  const sheet = useRef(null);
  const canvas = useRef(null);
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [drawn, setDrawn] = useState(false);
  const [width, setWidth] = useState(0);

  // Load the file when the document changes.
  useEffect(() => {
    let live = true;
    setFile(null);
    setError(null);
    setDrawn(false);
    if (!docId) return undefined;
    docFile(docId).then(
      (f) => live && setFile(f),
      (e) => live && setError(e.message),
    );
    return () => { live = false; };
  }, [docId]);

  // Watch the sheet's width so the page is drawn sharp at its real size.
  useEffect(() => {
    const el = sheet.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth);
      setWidth((old) => (Math.abs(old - w) > 24 ? w : old));
    });
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, [file?.kind]);

  // Draw the PDF page whenever the file, page or width changes.
  useEffect(() => {
    let live = true;
    if (!file || file.kind !== 'pdf' || !canvas.current || !width) return undefined;
    (async () => {
      try {
        const doc = await openPdf(file.key, file.bytes);
        if (!live) return;
        onPages?.(doc.numPages);
        await drawPage(doc, page, canvas.current, width);
        if (live) setDrawn(true);
      } catch (e) {
        if (live) setError(e.message || 'The page could not be drawn.');
      }
    })();
    return () => { live = false; };
  }, [file, page, width]);

  if (!docId) return null;
  if (error) return html`<div class="reader-empty"><div class="t">This page could not be shown.</div><div>${error}</div></div>`;
  if (file && file.kind === 'other') return fallback || html`<div class="reader-empty"><div class="t">${file.name}</div><div>This file has no page to show. Its contents were read as text.</div></div>`;

  return html`<div class="page-view">
    <div class=${`page-sheet${drawn ? '' : ' pending'}`} ref=${sheet}>
      ${file?.kind === 'image'
        ? html`<img src=${file.url} alt=${file.name} onLoad=${() => setDrawn(true)} />`
        : html`<canvas ref=${canvas} aria-label=${file ? `Page ${page} of ${file.name}` : 'Page'} role="img"></canvas>`}
      ${!drawn ? html`<div class="loading">Opening the page…</div>` : null}
      <div class="page-overlay">
        ${drawn ? boxes.filter((b) => isValidBox(b.box)).map((b) => html`<div key=${b.id}
          class=${`fbox${b.shown === false ? ' hidden' : ''}${b.pulse ? ' pulse' : ''}${b.dim ? ' dim' : ''}${onBox ? ' clickable' : ''} ${chipClass(b)}`}
          style=${boxStyle(b.box, b.color)} data-key=${b.key || undefined}
          title=${b.label || undefined}
          onClick=${onBox ? () => onBox(b) : undefined}>
          ${b.label && b.chip !== false ? html`<span class="fchip">${b.label}</span>` : null}
        </div>`) : null}
        ${drawn ? children : null}
      </div>
    </div>
  </div>`;
}
