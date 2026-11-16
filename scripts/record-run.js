#!/usr/bin/env node
// Records a real run of the agents on the SAMPLE shipment for the website demo, then checks the replay.
//
//   node scripts/record-run.js            AI in direct mode (key in ~/.config/jewel-labs/openai_key), pace 0
//   node scripts/record-run.js --cache    reuses saved AI answers for requests that did not change (test/.tmp/ai-cache)
//   node scripts/record-run.js --verify   only replays the saved recording in Chromium and takes screenshots
//
// The run: the SAMPLE papers arrive the way the house sends them (loadSample: the WhatsApp export, the buyer's email,
// the dropped files), the agents read, file, trace, screen and check them, the house asks "What is still missing?",
// the late packing list arrives, the house answers the weight question (0.70 ct, as on the lab report; the invoice
// says 0.71 ct), accepts shipping with that difference (the invoice and the packing list still print 0.71 ct), and the
// agents build the papers. Every store change and live event is recorded with its time. Long waits are cut short so the
// replay lasts about 75 seconds, each paper's fields show one by one about 150 ms apart, top to bottom, and the papers
// come in the order they arrived. The result goes to src/renderer/demo/sample-run.json in the format of
// src/renderer/demo/README.md, with the files it points to in src/renderer/demo/files/.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHarness, loadAnswers, withTimeout, EVAL_PERSON } from './eval.js';
import { signPdf } from '../src/core/papers/index.js';
import { COLLECTIONS } from '../src/core/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const DEMO = path.join(RENDERER, 'demo');
const FILES = path.join(DEMO, 'files');
const RUN_FILE = path.join(DEMO, 'sample-run.json');
const SHOTS = path.join(ROOT, 'test', '.tmp');
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// How the replay is timed (milliseconds).
const TIMING = {
  field: 150, // one field after another
  fieldsPerPaper: 12, // fields shown live per paper; the still view shows them all once it is read
  paperStart: 350, // the next paper comes up
  reading: 550, // the paper is being read before its first field shows
  received: 120, // a paper arrives (the list fills quickly)
  agentNote: 260, // a line from another agent (filed, screened, checked, asked, built)
  activity: 40,
  store: 12, // a record saved
  pause: 1600, // between the parts of the run (first pass, the question, the late packing list...)
  maxGap: 300, // no other wait is longer than this
};
const SIGNER = { name: 'Demo signature (SAMPLE)', title: 'Partner' }; // pre-signed copies for visitors who sign

// ---------------------------------------------------------------- recording

async function record({ cache }) {
  const answers = await loadAnswers();
  const h = await createHarness({ mode: 'direct', cache, answers, pace: 0, parallel: 1 });
  const steps = [];
  const now = () => Date.now();
  const add = (kind, name, payload) => steps.push({ at: now(), kind, name, payload: structuredClone(payload) });
  const mark = (name) => steps.push({ at: now(), kind: 'mark', name });
  h.services.events.on('change', (c) => {
    if (!COLLECTIONS.includes(c.collection)) return;
    if (c.op === 'remove') add('remove', c.collection, { id: c.id });
    else add('put', c.collection, c.value);
  });
  for (const name of ['agent', 'activity', 'notify']) h.services.events.on(name, (payload) => add('event', name, payload));
  const idle = (what) => withTimeout(h.services.idle(), IDLE_TIMEOUT_MS, what);
  const startedAt = new Date().toISOString();
  const errors = [];
  h.services.events.on('agent', (e) => { if (e.action === 'error') errors.push(`${e.agent}: ${e.message}`); });

  try {
    // 1. The papers the house sends: the WhatsApp export, the buyer's email, the dropped files.
    const loaded = await h.services.loadSample();
    await idle('The first pass');
    mark('first pass');
    // 2. The house asks what is missing.
    await h.services.ask('What is still missing?', { by: EVAL_PERSON });
    await idle('The question');
    mark('asked');
    // 3. The late packing list arrives.
    await h.services.loadSample({ later: true });
    await idle('The late packing list');
    mark('later');
    // 4. The house answers the weight question, then accepts shipping with the difference the papers still print;
    // the agents build the papers.
    const shipments = await h.store.list('shipments');
    const a = shipments.find((s) => s.ref === answers.shipments.A.ref);
    const question = (await h.store.list('questions', (q) => q.shipmentId === a?.id && q.status === 'open' && q.kind === 'mismatch'))[0];
    if (!question) throw new Error('The weight question on shipment A was not asked: nothing to answer.');
    await h.services.answerQuestion(question.id, '0.70 ct', EVAL_PERSON);
    await idle('The answer');
    const accept = (await h.store.list('questions', (q) => q.shipmentId === a.id && q.status === 'open' && q.key === 'stone.7391020002.carat.accepted'))[0];
    if (!accept) throw new Error('The agents did not ask to accept the weight the invoice still prints.');
    await h.services.answerQuestion(accept.id, 'Ship with this difference', EVAL_PERSON);
    await idle('Accepting the difference');
    mark('answered');
    await h.services.ask('Prepare the papers for my latest shipment', { by: EVAL_PERSON });
    await idle('Preparing the papers');

    const final = {};
    for (const name of COLLECTIONS) final[name] = await h.store.list(name);
    const workspace = await h.store.workspace();
    const files = await exportFiles(h.store, final, steps);
    return { steps, final, workspace, files, loaded, startedAt, usage: h.ai.usage(), calls: h.meter.calls, errors };
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------- files

const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'text/plain': '.txt', 'message/rfc822': '.eml' };

function extOf(doc) {
  const fromName = path.extname(doc.fileName || '').toLowerCase();
  return fromName && fromName.length <= 5 ? fromName : EXT[doc.mime] || '.bin';
}

/** Copies the originals and every paper version the recording shows into demo/files/. Returns the files map. */
async function exportFiles(store, final, steps) {
  await fs.rm(FILES, { recursive: true, force: true });
  await fs.mkdir(FILES, { recursive: true });
  const map = {};
  const write = async (name, bytes) => {
    await fs.writeFile(path.join(FILES, name), bytes);
    return `files/${name}`;
  };
  for (const doc of final.documents) {
    if (!doc.fileKey) continue;
    const bytes = await store.getFile(doc.fileKey).catch(() => null);
    if (bytes) map[doc.id] = await write(`${doc.id}${extOf(doc)}`, bytes);
  }
  // Every (paper, version, status) the replay passes through, then a signed copy of each paper ready to sign.
  const seen = new Map();
  for (const step of steps) {
    if (step.kind !== 'put' || step.name !== 'papers') continue;
    const p = step.payload;
    seen.set(`${p.id}:${p.version}:${p.status}`, p);
  }
  for (const p of final.papers) seen.set(`${p.id}:${p.version}:${p.status}`, p);
  const written = new Map(); // fileKey -> url
  for (const [key, paper] of seen) {
    const fileKey = paper.status === 'signed' || paper.status === 'sent' ? paper.fileKey : paper.unsignedFileKey || paper.fileKey;
    if (!written.has(fileKey)) {
      const bytes = await store.getFile(fileKey).catch(() => null);
      if (!bytes) continue;
      written.set(fileKey, await write(`${paper.ref}-v${paper.version}${paper.status === 'signed' ? '-signed' : ''}.pdf`, bytes));
    }
    map[key] = written.get(fileKey);
  }
  for (const paper of final.papers.filter((p) => p.status === 'ready_to_sign')) {
    const bytes = await store.getFile(paper.fileKey);
    const signed = await signPdf(bytes, { ...SIGNER, signedAt: new Date().toISOString() });
    map[`${paper.id}:${paper.version}:signed`] = await write(`${paper.ref}-v${paper.version}-signed.pdf`, signed.bytes);
  }
  return map;
}

// ---------------------------------------------------------------- the replay timeline

const PRIORITY = ['doc.number', 'invoice.number', 'lab.reportNumber', 'kp.certificateNumber', 'shippingBill.number', 'awb.hawb',
  'awb.mawb', 'exporter.name', 'consignee.name', 'supplier.name', 'lab.carat', 'lab.color', 'lab.clarity', 'lab.shape',
  'kp.countriesOfMining', 'leo.date', 'goods.totalCarats', 'goods.totalValue', 'goods.hsCode', 'goods.nature',
  'goods.destinationCountry', 'insurance.insuredValue', 'invoice.date', 'awb.flight', 'awb.route'];

const isField = (s) => s.kind === 'event' && s.name === 'agent' && s.payload?.agent === 'intake' && s.payload.action === 'field';
const isRead = (s) => s.kind === 'event' && s.name === 'agent' && s.payload?.agent === 'intake' && s.payload.action === 'read';
const isStart = (s) => s.kind === 'event' && s.name === 'agent' && s.payload?.agent === 'intake' && s.payload.action === 'start';

/**
 * Puts each paper's live fields right after the paper was read (the live view plays them on their own queue, so in
 * the raw recording they can come after the next paper started), keeps those with a spot on the page, at most
 * TIMING.fieldsPerPaper, in page order (top to bottom), and drops the rest (the stored paper still has them all).
 */
export function orderSteps(raw) {
  const readPutAt = new Map(); // docId -> index of the put that saved it as read
  raw.forEach((s, i) => {
    if (s.kind === 'put' && s.name === 'documents' && s.payload?.status === 'read' && !readPutAt.has(s.payload.id)) readPutAt.set(s.payload.id, i);
  });
  const fieldsOf = new Map();
  for (const s of raw.filter(isField)) fieldsOf.set(s.payload.docId, [...(fieldsOf.get(s.payload.docId) || []), s]);
  const keep = new Set();
  for (const list of fieldsOf.values()) {
    const placed = list.filter((s) => Array.isArray(s.payload.box));
    const rank = (s) => {
      const at = PRIORITY.indexOf(s.payload.key);
      return at === -1 ? PRIORITY.length : at;
    };
    const chosen = [...placed].sort((a, b) => rank(a) - rank(b)).slice(0, TIMING.fieldsPerPaper);
    chosen.sort((a, b) => (a.payload.page || 1) - (b.payload.page || 1) || a.payload.box[1] - b.payload.box[1] || a.payload.box[0] - b.payload.box[0]);
    chosen.forEach((s, i) => { s.order = i; keep.add(s); });
  }
  // Positions are counted in the raw list, so a step's anchor and its index use the same numbers.
  const anchored = raw
    .map((s, index) => {
      const docId = s.payload?.docId;
      const anchor = (isField(s) || isRead(s)) && readPutAt.has(docId) ? readPutAt.get(docId) + 0.5 : index;
      return { s, anchor, index, sub: isField(s) ? 1 + s.order : 0 };
    })
    .filter(({ s }) => !isField(s) || keep.has(s));
  anchored.sort((x, y) => x.anchor - y.anchor || x.sub - y.sub || x.index - y.index);
  return anchored.map((x) => x.s);
}

/** Times every step for the replay: { t, kind, name, payload }, t in milliseconds from the start. */
export function retime(ordered) {
  const out = [];
  let t = 0;
  let last = ordered[0]?.at || 0;
  for (const step of ordered) {
    const gap = Math.max(0, (step.at || last) - last);
    last = Math.max(last, step.at || last);
    if (step.kind === 'mark') {
      t += TIMING.pause;
      continue;
    }
    if (isField(step)) t += TIMING.field;
    else if (isStart(step)) t += TIMING.paperStart;
    else if (isRead(step)) t += TIMING.reading;
    else if (step.kind === 'event' && step.name === 'agent' && step.payload?.agent === 'retrieval') t += TIMING.received;
    else if (step.kind === 'event' && step.name === 'agent') t += TIMING.agentNote;
    else if (step.kind === 'event') t += TIMING.activity;
    else t += Math.min(gap, TIMING.store);
    out.push({ t: Math.round(t), kind: step.kind, name: step.name, payload: step.payload });
  }
  return out;
}

// Long texts the screens do not need: the raw text layer or OCR text (the screens and search use the fields) and
// long email bodies.
function slim(step) {
  if (step.kind !== 'put' || step.name !== 'documents') return step;
  const doc = { ...step.payload };
  delete doc.text;
  if (doc.content?.email?.text) doc.content = { ...doc.content, email: { ...doc.content.email, text: String(doc.content.email.text).slice(0, 2000) } };
  return { ...step, payload: doc };
}

// ---------------------------------------------------------------- checking the replay in a browser

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.txt': 'text/plain', '.eml': 'message/rfc822', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function serve(dir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.join(dir, decodeURIComponent(url.pathname));
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function chromiumPath() {
  if (process.env.JL_CHROMIUM) return process.env.JL_CHROMIUM;
  const cache = path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright');
  const dirs = (await fs.readdir(cache).catch(() => [])).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse();
  for (const dir of dirs) {
    const exe = path.join(cache, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (await fs.stat(exe).then(() => true, () => false)) return exe;
  }
  return undefined;
}

/** Plays sample-run.json in Chromium at 1440x900 with no window.jl, and saves screenshots at a few moments. */
async function verify(run) {
  const { chromium } = await import('playwright');
  const server = await serve(RENDERER);
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({ executablePath: await chromiumPath() });
  const result = { shots: [], consoleErrors: [], failedRequests: [], banner: null };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
    page.on('requestfailed', (r) => result.failedRequests.push(r.url()));
    page.on('response', (r) => { if (r.status() >= 400) result.failedRequests.push(`${r.status()} ${r.url()}`); });
    await page.goto(`${base}?autoplay=1#/home`);
    const shoot = async (name, waitMs) => {
      if (waitMs) await page.waitForTimeout(waitMs);
      const file = path.join(SHOTS, `replay-${name}.png`);
      await page.screenshot({ path: file });
      result.shots.push(file);
    };
    // The page being read sits below the fold on Home: bring it into view.
    const toReader = () => page.evaluate(() => {
      const label = [...document.querySelectorAll('span, div, h2, h3')].find((el) => /^agents reading$/i.test((el.textContent || '').trim()));
      if (label) label.scrollIntoView({ block: 'start' });
      return Boolean(label);
    });
    const opened = Date.now();
    await page.waitForTimeout(2500);
    result.banner = await page.evaluate(() => document.body.innerText.split('\n').find((line) => /Demo:/.test(line)) || null);
    // Moments of the replay, in milliseconds after the page opened.
    const end = Math.max(...run.steps.map((s) => s.t));
    const moments = [['01-start', 3500], ['02-reading', 15000], ['03-reading-more', 30000], ['04-checks', end * 0.6],
      ['05-late-list', end * 0.83], ['06-end', end + 5000]];
    for (const [name, at] of moments) {
      await page.waitForTimeout(Math.max(0, Math.round(at - (Date.now() - opened))));
      result[`reader-${name}`] = await toReader();
      await shoot(name);
    }
    // Home at the end, top to bottom (the page scrolls inside its own container).
    for (let part = 0; part < 4; part += 1) {
      await page.evaluate((y) => {
        const scroller = [...document.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 40
          && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) || document.scrollingElement;
        scroller.scrollTo(0, y);
      }, part * 820);
      await shoot(`10-home-${part + 1}`, 400);
    }
    await page.goto(`${base}#/papers`);
    await shoot('07-papers', 3500);
    await page.goto(`${base}#/stones/7391020001`);
    await shoot('08-stone-history', 3500);
    await page.goto(`${base}#/shipments`);
    await shoot('09-shipments', 3000);
    await page.goto(`${base}#/desk`);
    await shoot('11-desk', 3500);
  } finally {
    await browser.close();
    server.close();
  }
  return result;
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) {
    const run = JSON.parse(await fs.readFile(RUN_FILE, 'utf8'));
    console.log(JSON.stringify(await verify(run), null, 2));
    return;
  }
  const started = Date.now();
  const recorded = await record({ cache: args.includes('--cache') });
  const steps = retime(orderSteps(recorded.steps)).map(slim);
  const durationMs = Math.max(...steps.map((s) => s.t));
  const ws = recorded.workspace;
  const run = {
    meta: {
      format: 1, recorded: true, title: 'Recorded run on the SAMPLE shipments KG/26-27/041, 042 and 043',
      createdAt: recorded.startedAt, durationMs,
      note: 'A real run of the desktop agents (gpt-5.4-mini) on fictional SAMPLE papers. Waits are shortened; up to '
        + `${TIMING.fieldsPerPaper} fields per paper play live, the rest show once the paper is read.`,
    },
    workspace: {
      id: 'ws-sample', name: ws.legalEntity || ws.name, legalEntity: ws.legalEntity || null, city: ws.city || null, country: ws.country || null,
      role: ws.role || 'exporter', sample: true, letterhead: ws.letterhead || null,
    },
    files: recorded.files,
    steps,
  };
  await fs.writeFile(RUN_FILE, `${JSON.stringify(run)}\n`);
  const size = (await fs.stat(RUN_FILE)).size;
  const fileSizes = await Promise.all((await fs.readdir(FILES)).map(async (f) => (await fs.stat(path.join(FILES, f))).size));
  const hash = createHash('sha256').update(await fs.readFile(RUN_FILE)).digest('hex').slice(0, 12);
  console.log(`Recorded ${recorded.steps.length} steps (${steps.length} in the replay, ${Math.round(durationMs / 1000)} s) in ${Math.round((Date.now() - started) / 1000)} s.`);
  console.log(`sample-run.json ${Math.round(size / 1024)} KB (sha256 ${hash}), ${fileSizes.length} files ${Math.round(fileSizes.reduce((a, b) => a + b, 0) / 1024)} KB.`);
  console.log(`AI: ${recorded.usage.calls} calls, ${recorded.usage.inputTokens} input and ${recorded.usage.outputTokens} output tokens.${recorded.errors.length ? ` Agent errors: ${recorded.errors.join(' | ')}` : ''}`);
  const check = await verify(run);
  console.log(JSON.stringify(check, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (err) => {
    console.error(`Recording failed: ${err.stack || err.message}`);
    process.exit(1);
  });
}
