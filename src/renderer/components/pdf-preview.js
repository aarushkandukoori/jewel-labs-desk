// PDF preview for papers: page thumbnails on the left, pages on the right, zoom in and out.
// Pages are drawn with pdf.js one after another, so a long pack shows its first pages quickly.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { openPdf, drawPage } from '../lib/pdf.js';
import { paperFile } from '../lib/files.js';
import { Icon } from './icons.js';
import { Skeleton } from './ui.js';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Finds the first page whose text matches (used to jump to the parcel sheets). */
async function findPage(doc, pattern) {
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
    if (pattern.test(text)) return n;
  }
  return 1;
}

export function PdfPreview({ paper, title, jumpTo, toolbar }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const pagesBox = useRef(null);
  const thumbs = useRef([]);
  const canvases = useRef([]);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setError(null);
    setCurrent(1);
    (async () => {
      try {
        const file = await paperFile(paper);
        const d = await openPdf(file.key, file.bytes);
        if (live) setDoc(d);
      } catch (e) {
        if (live) setError(e.message || 'The paper could not be opened.');
      }
    })();
    return () => { live = false; };
  }, [paper.id, paper.version, paper.status, paper.sha256]);

  // Draw every page at the current zoom, then the thumbnails.
  useEffect(() => {
    if (!doc) return undefined;
    let live = true;
    (async () => {
      const box = pagesBox.current;
      const fit = Math.min(820, Math.max(320, (box?.clientWidth || 820) - 48));
      for (let n = 1; n <= doc.numPages && live; n++) {
        const canvas = canvases.current[n - 1];
        if (canvas) {
          try {
            const size = await drawPage(doc, n, canvas, fit * zoom);
            canvas.style.width = `${Math.round(fit * zoom)}px`;
            canvas.style.height = `${Math.round((fit * zoom * size.height) / size.width)}px`;
          } catch {
            // a page that fails to draw stays blank; the rest still show
          }
        }
      }
      for (let n = 1; n <= doc.numPages && live; n++) {
        const t = thumbs.current[n - 1];
        if (t && !t.dataset.drawn) {
          await drawPage(doc, n, t, 86).catch(() => {});
          t.dataset.drawn = '1';
        }
      }
      if (live && jumpTo === 'handover') {
        const n = await findPage(doc, /shipment handover|neutral cover|parcel/i);
        scrollToPage(n);
      }
    })();
    return () => { live = false; };
  }, [doc, zoom]);

  function scrollToPage(n) {
    setCurrent(n);
    const el = pagesBox.current?.querySelector(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // Track which page is in view, to light up its thumbnail.
  function onScroll() {
    const box = pagesBox.current;
    if (!box) return;
    const mid = box.scrollTop + box.clientHeight * 0.35;
    let seen = 1;
    for (const el of box.querySelectorAll('[data-page]')) if (el.offsetTop <= mid) seen = Number(el.dataset.page);
    if (seen !== current) setCurrent(seen);
  }

  const step = (dir) => setZoom((z) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + dir))]);

  return html`<div class="preview">
    <div class="preview-bar">
      <span class="title" title=${title}>${title}</span>
      <span class="spacer"></span>
      ${doc ? html`<span class="muted small">${current} / ${doc.numPages}</span>` : null}
      <button class="btn btn-sm btn-icon" type="button" onClick=${() => step(-1)} disabled=${zoom === ZOOMS[0]} title="Zoom out" aria-label="Zoom out">${Icon.zoomOut()}</button>
      <span class="zoom">${Math.round(zoom * 100)}%</span>
      <button class="btn btn-sm btn-icon" type="button" onClick=${() => step(1)} disabled=${zoom === ZOOMS[ZOOMS.length - 1]} title="Zoom in" aria-label="Zoom in">${Icon.zoomIn()}</button>
      ${toolbar || null}
    </div>
    ${error ? html`<div class="empty"><div class="t">This paper could not be opened.</div>${error}</div>`
      : !doc ? html`<${Skeleton} block lines=${3} />`
      : html`<div class="preview-body" key=${`${paper.id}:${paper.version}:${paper.status}:${paper.sha256 || ''}`}>
          <div class="thumbs" aria-label="Pages">
            ${Array.from({ length: doc.numPages }, (_, i) => html`<button type="button" class=${`thumb${current === i + 1 ? ' active' : ''}`} key=${i}
              onClick=${() => scrollToPage(i + 1)} aria-label=${`Page ${i + 1}`}>
              <div class="img"><canvas ref=${(el) => { thumbs.current[i] = el; }}></canvas></div><span>${i + 1}</span>
            </button>`)}
          </div>
          <div class="pages" ref=${pagesBox} onScroll=${onScroll}>
            ${Array.from({ length: doc.numPages }, (_, i) => html`<div class="pdf-page" data-page=${i + 1} key=${i}>
              <canvas ref=${(el) => { canvases.current[i] = el; }} aria-label=${`Page ${i + 1}`} role="img"></canvas>
            </div>`)}
          </div>
        </div>`}
  </div>`;
}
