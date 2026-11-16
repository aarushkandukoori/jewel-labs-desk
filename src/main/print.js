// Prints a paper. Every page is drawn as a picture in a hidden window (rasterize.html), then the
// system print dialog opens. Electron cannot print its built-in PDF viewer from code, so we print
// pictures of the pages instead. If printing fails, ipc.js opens the PDF in the PDF app instead.
// pageUrl and wasmUrl as in rasterize.js.
export function createPrinter({ BrowserWindow, pageUrl, wasmUrl = null }) {
  async function print(pdfBytes, { title = 'Jewel Labs' } = {}) {
    const win = new BrowserWindow({
      show: false,
      title,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    try {
      await win.loadURL(pageUrl);
      const b64 = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength).toString('base64');
      const pages = await win.webContents.executeJavaScript(
        `window.raster.showAll(${JSON.stringify(b64)}, ${JSON.stringify(wasmUrl)}, ${JSON.stringify(title)})`,
      );
      const result = await new Promise((resolve) => {
        win.webContents.print({ printBackground: true, margins: { marginType: 'none' } }, (ok, reason) => resolve({ ok, reason }));
      });
      if (result.ok) return { printed: true, pages };
      if (result.reason === 'cancelled') return { printed: false, cancelled: true, pages };
      throw new Error(`Printing did not work (${result.reason || 'no reason given'}).`);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  return { print };
}
