// Renders one page of a PDF to a PNG, in a hidden window that runs the vendored pdf.js (rasterize.html, served
// at app://pages/rasterize.html, see window.js). Scanned PDFs have no text layer: OCR needs a picture of each page,
// and the AI reads page pictures too.
//   rasterize(pdfBytes, pageNumber) -> Uint8Array (PNG, drawn at 2x)
import crypto from 'node:crypto';

export function dataUrlToBytes(dataUrl) {
  const text = String(dataUrl || '');
  if (!text.startsWith('data:image/png;base64,')) throw new Error('The page could not be drawn.');
  const buf = Buffer.from(text.slice(text.indexOf(',') + 1), 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** The hidden page answers { error } instead of throwing (see rasterize-page.mjs): turn it back into an Error. */
export function unwrap(result) {
  if (result && typeof result === 'object' && typeof result.error === 'string') throw new Error(result.error);
  return result;
}

// pageUrl: the hidden page's address. wasmUrl: where pdf.js finds its image decoders (a URL ending in "/"), or null.
// timeoutMs: how long one call may take before the window counts as stuck and is replaced.
export function createRasterizer({ BrowserWindow, pageUrl, wasmUrl = null, scale = 2, idleMs = 60000, timeoutMs = 60000 }) {
  let current = null; // { promise of the window, waiting: Set of the calls' reject functions, gone(reason) }
  let idleTimer = null;
  let busy = 0;

  function openWindow() {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const entry = { waiting: new Set(), promise: null };
    // A crashed or hung page fails the calls waiting on it, and the next call gets a fresh window. Without this,
    // every later page would queue behind the stuck one.
    entry.gone = (reason) => {
      if (current === entry) current = null;
      const error = new Error(reason);
      for (const reject of entry.waiting) reject(error);
      entry.waiting.clear();
      if (!win.isDestroyed()) win.destroy();
    };
    win.webContents.on?.('render-process-gone', (_event, details) => entry.gone(`The page drawer stopped (${details?.reason || 'it crashed'}).`));
    win.on?.('unresponsive', () => entry.gone('The page drawer stopped responding.'));
    entry.promise = win.loadURL(pageUrl).then(
      () => win,
      (error) => {
        if (current === entry) current = null;
        if (!win.isDestroyed()) win.destroy();
        throw error;
      },
    );
    return entry;
  }

  // One hidden window is shared by every call and reopened if it was closed.
  async function getWindow() {
    if (current) {
      const entry = current;
      const win = await entry.promise.catch(() => null);
      if (win && !win.isDestroyed()) return { win, entry };
    }
    current = openWindow();
    const entry = current;
    return { win: await entry.promise, entry };
  }

  /** Runs one step in the window. It fails when the window crashes or hangs, or after timeoutMs. */
  function inWindow(entry, win, code) {
    return new Promise((resolve, reject) => {
      entry.waiting.add(reject);
      const timer = setTimeout(() => entry.gone('Drawing the page took too long.'), timeoutMs);
      timer.unref?.();
      win.webContents.executeJavaScript(code).then(resolve, reject).finally(() => {
        clearTimeout(timer);
        entry.waiting.delete(reject);
      });
    });
  }

  async function rasterize(pdfBytes, pageNumber = 1) {
    if (!(pdfBytes instanceof Uint8Array) || !pdfBytes.length) throw new Error('rasterize needs the bytes of a PDF.');
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('Page numbers start at 1.');
    busy += 1;
    clearTimeout(idleTimer);
    try {
      const { win, entry } = await getWindow();
      const run = async (code) => unwrap(await inWindow(entry, win, code));
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
    const entry = current;
    current = null;
    entry?.promise.then((win) => !win.isDestroyed() && win.destroy()).catch(() => {});
  }

  return { rasterize, close };
}
