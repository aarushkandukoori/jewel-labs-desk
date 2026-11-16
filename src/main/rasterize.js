// Renders one page of a PDF to a PNG, in a hidden window that runs the vendored pdf.js (rasterize.html).
// Scanned PDFs have no text layer: OCR needs a picture of each page, and the AI reads page pictures too.
//   rasterize(pdfBytes, pageNumber) -> Uint8Array (PNG, drawn at 2x)
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// pdf.js wants the folder of its image decoders as a URL ending in "/".
export function wasmUrlFor(dir) {
  return dir ? pathToFileURL(dir).href.replace(/\/?$/, '/') : null;
}

export function dataUrlToBytes(dataUrl) {
  const text = String(dataUrl || '');
  if (!text.startsWith('data:image/png;base64,')) throw new Error('The page could not be drawn.');
  const buf = Buffer.from(text.slice(text.indexOf(',') + 1), 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

export function createRasterizer({ BrowserWindow, htmlPath, wasmDir = null, scale = 2, idleMs = 60000 }) {
  const wasmUrl = wasmUrlFor(wasmDir);
  let windowPromise = null;
  let idleTimer = null;
  let busy = 0;

  function openWindow() {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    return win.loadFile(htmlPath).then(
      () => win,
      (error) => {
        win.destroy();
        throw error;
      },
    );
  }

  // One hidden window is shared by every call and reopened if it was closed.
  async function getWindow() {
    if (windowPromise) {
      const win = await windowPromise.catch(() => null);
      if (win && !win.isDestroyed()) return win;
    }
    windowPromise = openWindow();
    return windowPromise;
  }

  async function rasterize(pdfBytes, pageNumber = 1) {
    if (!(pdfBytes instanceof Uint8Array) || !pdfBytes.length) throw new Error('rasterize needs the bytes of a PDF.');
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('Page numbers start at 1.');
    busy += 1;
    clearTimeout(idleTimer);
    try {
      const win = await getWindow();
      const run = (code) => win.webContents.executeJavaScript(code);
      // The PDF is sent once (keyed by its hash); later pages of the same PDF reuse it.
      const key = crypto.createHash('sha256').update(pdfBytes).digest('hex');
      if (!(await run(`window.raster.has(${JSON.stringify(key)})`))) {
        const b64 = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength).toString('base64');
        await run(`window.raster.load(${JSON.stringify(key)}, ${JSON.stringify(b64)}, ${JSON.stringify(wasmUrl)})`);
      }
      return dataUrlToBytes(await run(`window.raster.render(${JSON.stringify(key)}, ${pageNumber}, ${scale})`));
    } finally {
      busy -= 1;
      if (busy === 0) {
        idleTimer = setTimeout(close, idleMs); // free the memory when no pages are needed for a while
        idleTimer.unref?.();
      }
    }
  }

  function close() {
    clearTimeout(idleTimer);
    const pending = windowPromise;
    windowPromise = null;
    pending?.then((win) => !win.isDestroyed() && win.destroy()).catch(() => {});
  }

  return { rasterize, close };
}
