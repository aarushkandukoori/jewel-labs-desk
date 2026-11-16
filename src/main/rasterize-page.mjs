// Draws PDF pages with the vendored pdf.js. This runs inside the hidden window (rasterize.html) that
// rasterize.js and print.js open; they call window.raster with executeJavaScript.
import * as pdfjs from '../renderer/vendor/pdfjs/pdf.mjs';

const VENDOR = new URL('../renderer/vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.mjs`;

const MAX_SIDE = 4096; // pixels: huge pages are drawn smaller so they fit in memory
const KEEP_OPEN = 3; // PDFs kept open, so the next page of the same PDF is quick
const docs = new Map(); // key -> promise of a pdf.js document

function fromBase64(b64) {
  const text = atob(b64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function openPdf(b64, wasmUrl) {
  return pdfjs.getDocument({
    data: fromBase64(b64),
    cMapUrl: `${VENDOR}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${VENDOR}standard_fonts/`,
    wasmUrl: wasmUrl || undefined, // image decoders for scanned PDFs (JPEG 2000, JBIG2)
    isEvalSupported: false, // our page forbids eval
  }).promise;
}

async function drawPage(doc, pageNumber, scale) {
  if (pageNumber > doc.numPages) throw new Error(`The PDF has ${doc.numPages} pages, not ${pageNumber}.`);
  const page = await doc.getPage(pageNumber);
  const size = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(scale, MAX_SIDE / Math.max(size.width, size.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
  page.cleanup();
  return canvas;
}

function toPng(canvas) {
  const url = canvas.toDataURL('image/png');
  canvas.width = 0; // free the pixels now rather than at the next garbage collection
  canvas.height = 0;
  return url;
}

window.raster = {
  has(key) {
    return docs.has(key);
  },

  async load(key, b64, wasmUrl) {
    if (!docs.has(key)) {
      const loading = openPdf(b64, wasmUrl);
      loading.catch(() => docs.delete(key)); // a broken PDF is not kept
      docs.set(key, loading);
    }
    while (docs.size > KEEP_OPEN) {
      const [oldKey, oldDoc] = docs.entries().next().value;
      docs.delete(oldKey);
      oldDoc.then((d) => d.destroy()).catch(() => {});
    }
    return (await docs.get(key)).numPages;
  },

  // One page as a PNG data URL.
  async render(key, pageNumber, scale) {
    if (!docs.has(key)) throw new Error('The PDF is not loaded.');
    const doc = await docs.get(key);
    return toPng(await drawPage(doc, pageNumber, scale));
  },

  // For printing: every page as a picture on its own sheet, sized like the PDF's first page.
  async showAll(b64, wasmUrl, title) {
    const doc = await openPdf(b64, wasmUrl);
    document.title = title || 'Jewel Labs';
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const style = document.createElement('style');
    style.textContent = `@page { size: ${first.width}pt ${first.height}pt; margin: 0; }`;
    document.head.append(style);
    for (let n = 1; n <= doc.numPages; n++) {
      const img = new Image();
      img.className = 'page';
      img.src = toPng(await drawPage(doc, n, 2));
      await img.decode();
      document.body.append(img);
    }
    const pages = doc.numPages;
    await doc.destroy();
    return pages;
  },
};
