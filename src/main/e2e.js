// Test hooks for the end-to-end tests. main.js only uses this file when JL_E2E=1, so a normal start
// (and every copy a house installs) never loads it.
//
//   JL_E2E_SAVE_DIR=<folder>     the Save dialog answers on its own with <folder>/<suggested name>
//   JL_E2E_OPEN_FILES=<a>:<b>    the Open dialog answers on its own with these files (path.delimiter)
//   JL_E2E_REPORT=<file>         after start-up: load the sample, let the agents finish, run OCR on the
//                                phone photo and draw a PDF page, then write what happened to <file> as JSON
//   JL_E2E_QUIT=1                quit once the report is written
import fs from 'node:fs';
import path from 'node:path';

// Dialogs that never wait for a person. Anything not set up answers "canceled", like a person closing it.
export function createTestDialogs(dialog, env = process.env) {
  const lastOptions = (args) => args[args.length - 1] || {};
  return {
    ...dialog,
    showMessageBox: (...args) => dialog.showMessageBox(...args),
    showErrorBox: (...args) => dialog.showErrorBox(...args),
    async showOpenDialog(...args) {
      const files = String(env.JL_E2E_OPEN_FILES || '').split(path.delimiter).filter(Boolean);
      return files.length ? { canceled: false, filePaths: files } : { canceled: true, filePaths: [] };
    },
    async showSaveDialog(...args) {
      const dir = env.JL_E2E_SAVE_DIR;
      if (!dir) return { canceled: true };
      const suggested = path.basename(lastOptions(args).defaultPath || 'paper.pdf');
      return { canceled: false, filePath: path.join(dir, suggested) };
    },
  };
}

function withTimeout(promise, ms, what) {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Loads the sample, waits for the agents, and checks OCR and page drawing in this copy of the app.
// Every step records its own result, so one failure does not hide the others.
export async function runSelfCheck({ state, core, rasterize, appInfo, file, log = console }) {
  const report = { startedAt: new Date().toISOString(), steps: {}, ok: false };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      report.steps[name] = { ok: true, ...((await fn()) || {}), ms: Date.now() - t0 };
    } catch (error) {
      report.steps[name] = { ok: false, error: error?.message || String(error), ms: Date.now() - t0 };
    }
    return report.steps[name].ok;
  };

  await step('start', async () => {
    await withTimeout(state.ready(), 60000, 'Opening the workspace');
    const info = { ...appInfo(), ...state.info() };
    return { version: info.version, isDev: info.isDev, mode: info.mode, ai: info.ai, startError: info.startError };
  });

  await step('loadSample', async () => {
    const result = await withTimeout(state.loadSample(), 60000, 'Loading the sample');
    return { files: result?.files ?? null, documents: result?.documentIds?.length ?? null };
  });

  await step('agentsFinish', async () => {
    const { services } = await state.ready();
    if (typeof services.idle === 'function') await withTimeout(services.idle(), 300000, 'The agents');
    const docs = await state.list('documents');
    const shipments = await state.list('shipments');
    return {
      documents: docs.length,
      read: docs.filter((d) => d.status === 'read').length,
      errors: docs.filter((d) => d.status === 'error').map((d) => `${d.fileName}: ${d.error || 'error'}`),
      shipments: shipments.map((s) => `${s.ref} ${s.status}`),
    };
  });

  await step('ocrPhoto', async () => {
    const docs = await state.list('documents');
    const photo = docs.find((d) => /^image\/(jpeg|png)$/.test(d.mime || ''));
    if (!photo) throw new Error('The sample has no photo');
    const bytes = await state.documentFile(photo.id).then((f) => f.bytes);
    const result = await withTimeout(core.ocr.ocrImage(bytes), 180000, 'OCR');
    if (result.error) throw new Error(`OCR failed: ${result.error}`);
    const options = core.ocr.ocrOptions ? core.ocr.ocrOptions() : {};
    const text = String(result.text || '');
    return {
      file: photo.fileName,
      words: result.words?.length || 0,
      characters: text.length,
      foundReportNumber: /7391020005/.test(text.replace(/\s+/g, '')),
      workerPath: options.workerPath || null,
      workerOutsideAsar: Boolean(options.workerPath && !/app\.asar[\\/]/.test(options.workerPath)),
      photoDocument: { status: photo.status, readBy: photo.readBy || null, fields: photo.fields?.length || 0 },
    };
  });

  await step('rasterize', async () => {
    const docs = await state.list('documents');
    const pdf = docs.find((d) => d.mime === 'application/pdf');
    if (!pdf) throw new Error('The sample has no PDF');
    const bytes = await state.documentFile(pdf.id).then((f) => f.bytes);
    const png = await withTimeout(rasterize(bytes, 1), 60000, 'Drawing the page');
    const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    if (!isPng) throw new Error('The page did not come back as a PNG');
    return { file: pdf.fileName, pngBytes: png.length };
  });

  report.ok = Object.values(report.steps).every((s) => s.ok);
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log.info(`Self-check ${report.ok ? 'passed' : 'failed'}; report written`);
  return report;
}
