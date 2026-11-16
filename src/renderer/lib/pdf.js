// Draws PDF pages with the vendored pdf.js (vendor/pdfjs). pdf.js is large, so it loads the first
// time a PDF is shown. Open documents are cached by key so moving between pages is quick.

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
const KEEP_OPEN = 6;

let pdfjsPromise = null;
const docs = new Map(); // key -> Promise<PDFDocumentProxy>

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.mjs`;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** Opens a PDF from its bytes (cached under key). Returns the pdf.js document. */
export async function openPdf(key, bytes) {
  if (docs.has(key)) return docs.get(key);
  const loading = loadPdfjs().then((pdfjs) =>
    pdfjs.getDocument({
      data: bytes.slice(), // pdf.js takes ownership of the buffer; keep ours intact
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      isEvalSupported: false, // the page forbids eval
    }).promise,
  );
  docs.set(key, loading);
  loading.catch(() => docs.delete(key)); // a broken file is not kept
  while (docs.size > KEEP_OPEN) {
    const [oldKey, old] = docs.entries().next().value;
    docs.delete(oldKey);
    old.then((d) => d.loadingTask.destroy()).catch(() => {});
  }
  return loading;
}

/** Forgets a cached PDF (after a paper gets a new version). */
export function forgetPdf(key) {
  const old = docs.get(key);
  docs.delete(key);
  if (old) old.then((d) => d.loadingTask.destroy()).catch(() => {});
}

/**
 * Draws one page into a canvas, sized to cssWidth pixels wide (sharp on Retina screens).
 * Returns { width, height } of the page in PDF points, so callers know its shape.
 */
export async function drawPage(doc, pageNumber, canvas, cssWidth) {
  const page = await doc.getPage(Math.max(1, Math.min(pageNumber, doc.numPages)));
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const scale = (cssWidth / base.width) * ratio;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' });
  await task.promise;
  return { width: base.width, height: base.height };
}
