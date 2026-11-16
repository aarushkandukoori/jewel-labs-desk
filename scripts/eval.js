#!/usr/bin/env node
// Runs the real agents on the SAMPLE shipments and compares what they found with samples/answers.json.
//
//   node scripts/eval.js              AI in direct mode, with the key in ~/.config/jewel-labs/openai_key
//   node scripts/eval.js --offline    no AI: the offline reader (regular expressions + OCR)
//   node scripts/eval.js --proxy      signs in a jl-test account and uses the Jewel Labs AI proxy (Edge Function 'ai')
//   node scripts/eval.js --only A     feeds only one shipment's papers (A, B or C)
//   node scripts/eval.js --cache      reuses saved AI answers for requests that did not change (test/.tmp/ai-cache)
//   node scripts/eval.js --model gpt-5-mini
//   node scripts/eval.js --dump       also writes the final records to test/.tmp/eval-snapshot.json (for debugging)
//   node scripts/eval.js --rewrite    renders test/.tmp/eval-report.md again from its JSON (no new run)
//
// The papers go in the way a house sends them: the WhatsApp export, then the email, then the dropped files
// (shipments A, B and C), then, after the first pass, the late packing list. Results go to
// test/.tmp/eval-report.json and test/.tmp/eval-report.md. The OpenAI key is read at run time and never printed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createServices } from '../src/core/services.js';
import { createLocalWorkspace, openLocalStore, createCloud } from '../src/core/store/index.js';
import { createAI } from '../src/core/ai/index.js';
import * as ocr from '../src/core/ocr/index.js';
import { loadSdn } from '../src/core/sanctions/index.js';
import { normalizeRef, parseNumber, parseDate } from '../src/core/rules/fields.js';
import { normalizeCountry, splitCountries, normalizeShape } from '../src/core/rules/formats.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, AI_MODELS } from '../src/core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = path.join(ROOT, 'samples', 'sample-shipment');
const ANSWERS_FILE = path.join(ROOT, 'samples', 'answers.json');
const OUT_DIR = path.join(ROOT, 'test', '.tmp');
const KEY_FILE = path.join(os.homedir(), '.config', 'jewel-labs', 'openai_key');
const PROXY_ACCOUNT_FILE = path.join(OUT_DIR, 'proxy-account.json'); // gitignored; holds the test password
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const CHANNELS = ['whatsapp', 'email', 'drop'];

// USD per 1M tokens, standard tier, from https://developers.openai.com/api/docs/pricing (15 Nov 2026).
// (https://openai.com/api/pricing answered 403 to the fetch tool; the developer docs page is the same table.)
export const PRICES = {
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
};

/** The fictional SAMPLE house, from the answer key. */
export function sampleHouseProfile(answers) {
  const house = answers.house;
  return {
    name: house.name,
    legalEntity: house.name,
    country: house.country,
    city: 'Surat',
    role: 'exporter',
    sample: true,
    environment: 'sandbox',
    contactEmails: [house.email],
    letterhead: { companyName: house.name, address: house.address, iec: house.iec, email: house.email, phone: house.phone },
  };
}

export const EVAL_PERSON = { id: 'eval-person', name: 'Asha Mehta (SAMPLE)', email: 'asha@kavya-gems.example.com' };

// ---------------------------------------------------------------- samples

export async function loadAnswers() {
  return JSON.parse(await fs.readFile(ANSWERS_FILE, 'utf8'));
}

/** Every sample file under one folder, as { name, rel, bytes }. */
async function filesUnder(rel) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(path.join(SAMPLES, dir), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else out.push({ name: entry.name, rel: child, bytes: new Uint8Array(await fs.readFile(path.join(SAMPLES, child))) });
    }
  }
  await walk(rel);
  // Files at the top of a folder first, then sub-folders (drop/ before drop/shipment-b/).
  return out.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
}

/** Which shipment a sample file belongs to (A, B or C), from the answer key. */
export function shipmentOfPath(answers, rel) {
  const entry = answers.files.find((f) => f.path === rel);
  return entry ? entry.shipment : null;
}

/** The sample files by channel. only: 'A', 'B' or 'C' keeps that shipment's files. */
export async function sampleFiles(answers, { only = null } = {}) {
  const channels = {};
  for (const channel of [...CHANNELS, 'later']) {
    const files = await filesUnder(channel);
    channels[channel] = files
      .filter((f) => !only || shipmentOfPath(answers, f.rel) === only)
      .map((f) => ({ name: f.name, rel: f.rel, bytes: f.bytes, source: { kind: 'upload' } }));
  }
  return channels;
}

// ---------------------------------------------------------------- PDF pages in Node (the app draws them in Electron)

const require = createRequire(import.meta.url);
const STANDARD_FONTS = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

/** Draws one PDF page as a PNG with pdf.js, at 2x like src/main/rasterize.js (at most 4096 px). Pages start at 1. */
export async function nodeRasterize(pdfBytes, pageNumber = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes), standardFontDataUrl: STANDARD_FONTS, isEvalSupported: false, verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 4096 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const { canvas, context } = doc.canvasFactory.create(Math.round(viewport.width), Math.round(viewport.height));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    return new Uint8Array(canvas.toBuffer('image/png'));
  } finally {
    await task.destroy();
  }
}

// ---------------------------------------------------------------- AI calls: counted, timed, optionally cached

/**
 * A fetch for the AI client that counts every call (model, tokens, time) and says what it was for, from the
 * prompt: "Paper: <file>" (extract), "File name: <file>" (classify), "Chat:", an email, a route or a packing list.
 * cacheDir: answers are saved by a hash of the request, so an unchanged request is not paid for twice.
 */
export function createMeter({ cacheDir = null } = {}) {
  const calls = [];
  let current = null; // a label for calls made outside document reading (an ask, say)

  async function meteredFetch(url, init = {}) {
    const body = typeof init.body === 'string' ? init.body : '';
    const request = safeJson(body) || {};
    const call = { ...describeRequest(request), during: current, model: request.model || null, at: Date.now(), cached: false };
    const key = cacheDir ? createHash('sha256').update(`${request.model}|${body}`).digest('hex') : null;
    if (key) {
      const saved = await fs.readFile(path.join(cacheDir, `${key}.json`), 'utf8').catch(() => null);
      if (saved) {
        calls.push({ ...call, ms: 0, status: 200, usage: safeJson(saved)?.usage || {}, cached: true });
        return new Response(saved, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    const started = Date.now();
    const res = await fetch(url, init);
    const text = await res.text();
    const data = safeJson(text);
    calls.push({ ...call, ms: Date.now() - started, status: res.status, usage: data?.usage || {}, error: res.ok ? null : data?.error?.code || data?.error?.type || String(res.status) });
    if (key && res.ok) {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, `${key}.json`), text);
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  return {
    fetch: meteredFetch,
    calls,
    during(label) { current = label; },
  };
}

function describeRequest(request) {
  const task = request?.response_format?.json_schema?.name || (request?.response_format ? 'json' : 'text');
  const user = (request.messages || []).filter((m) => m.role === 'user').pop();
  const text = typeof user?.content === 'string' ? user.content : (user?.content || []).find((p) => p.type === 'text')?.text || '';
  const file = text.match(/^Paper: (.+)$/m)?.[1] || text.match(/^File name: (.+)$/m)?.[1] || null;
  let subject = file;
  if (!subject && /^Chat: /m.test(text)) subject = 'chat';
  if (!subject && /^Subject: /m.test(text)) subject = 'email';
  if (!subject && /^Message: "/.test(text)) subject = 'ask';
  if (!subject && /\nMaterial:\n/.test(text)) subject = 'packing list draft';
  const parts = (user?.content && Array.isArray(user.content)) ? user.content.map((p) => p.type) : [];
  return { task, subject: subject || 'other', sentFile: parts.includes('file'), sentImages: parts.filter((t) => t === 'image_url').length };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Cost of one call in USD (cached prompt tokens are cheaper). */
export function callCost(call) {
  const price = PRICES[call.model];
  if (!price || call.cached) return 0;
  const prompt = call.usage?.prompt_tokens || 0;
  const cachedTokens = call.usage?.prompt_tokens_details?.cached_tokens || 0;
  const output = call.usage?.completion_tokens || 0;
  return ((prompt - cachedTokens) * price.input + cachedTokens * price.cached + output * price.output) / 1e6;
}

// ---------------------------------------------------------------- the harness

async function readKey() {
  const key = (await fs.readFile(KEY_FILE, 'utf8').catch(() => '')).trim();
  if (!key) throw new Error(`No OpenAI key in ${KEY_FILE}. Use --offline to run without the AI.`);
  return key;
}

/** Signs in the jl-test account saved in test/.tmp, or creates one through the signup function. */
async function proxyLogin() {
  const cloud = createCloud({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  const saved = safeJson(await fs.readFile(PROXY_ACCOUNT_FILE, 'utf8').catch(() => '')) || null;
  if (saved?.email && saved?.password && saved?.workspaceId) {
    try {
      const session = await cloud.auth.signIn({ email: saved.email, password: saved.password });
      return { cloud, session, email: saved.email, workspaceId: saved.workspaceId, created: false };
    } catch {
      // the saved account is gone: make a new one
    }
  }
  const email = `jl-test-eval-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const session = await cloud.auth.signUp({ email, password, name: 'JL test (eval)', houseName: 'Kavya Gems eval (SAMPLE)' });
  if (!session.workspaceId) throw new Error('The signup function did not return a house id.');
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(PROXY_ACCOUNT_FILE, JSON.stringify({ email, password, workspaceId: session.workspaceId }), { mode: 0o600 });
  return { cloud, session, email, workspaceId: session.workspaceId, created: true };
}

/**
 * The real services on a temp local store. mode: 'direct' | 'off' | 'proxy'.
 * Returns { dir, store, services, ai, meter, workspace, login, close() }.
 */
export async function createHarness({ mode = 'direct', model, pace = 0, cache = false, answers, clock, parallel } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-eval-'));
  const workspace = await createLocalWorkspace({ dir, profile: sampleHouseProfile(answers || (await loadAnswers())) });
  const store = await openLocalStore({ dir, workspaceId: workspace.id });
  const meter = createMeter({ cacheDir: cache ? path.join(OUT_DIR, 'ai-cache') : null });

  let ai;
  let login = null;
  if (mode === 'off') {
    ai = createAI({ mode: 'off' });
  } else if (mode === 'proxy') {
    login = await proxyLogin();
    ai = createAI({
      mode: 'proxy', proxyUrl: login.cloud.aiProxyUrl, getAccessToken: () => login.cloud.accessToken(),
      workspaceId: login.workspaceId, model, fetch: meter.fetch,
    });
  } else {
    ai = createAI({ mode: 'direct', apiKey: await readKey(), model, fetch: meter.fetch });
  }

  const sdn = await loadSdn({ cacheDir: path.join(dir, 'ofac'), fetch: null }); // the bundled OFAC snapshot
  const services = createServices({
    store, ai, ocr, rasterize: nodeRasterize, sanctionsLoader: async () => sdn,
    paths: { userData: dir, cacheDir: path.join(dir, 'cache') }, deviceId: 'eval', pace, clock, parallel,
  });

  /** Stops the agents, signs out of Jewel Labs (proxy mode) and removes the temp store. */
  async function close() {
    await services.shutdown().catch(() => {});
    await store.close().catch(() => {});
    let signedOut = null;
    if (login) {
      signedOut = await login.cloud.auth.signOut().then(() => true, () => false);
      if (signedOut) signedOut = !(await login.cloud.auth.session().catch(() => null));
      login.cloud.close?.();
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { signedOut };
  }
  return { dir, store, services, ai, meter, workspace, login, sdn, close };
}

export function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function snapshot(store) {
  const out = {};
  for (const name of ['documents', 'shipments', 'stones', 'checks', 'questions', 'papers', 'parties', 'activity', 'messages']) {
    out[name] = await store.list(name);
  }
  return out;
}

// ---------------------------------------------------------------- comparing with the answer key

const squash = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const NUMBER_KEYS = new Set(['goods.totalPieces', 'goods.totalCarats', 'goods.totalValue', 'goods.grossWeight', 'goods.netWeight',
  'kp.carats', 'kp.value', 'lab.carat', 'insurance.insuredValue']);

function unitOf(value) {
  const m = String(value ?? '').toLowerCase().match(/\b(kg|kgs|g|gm|gms|grams?|ct|cts|carats?)\b/);
  if (!m) return null;
  return m[1].startsWith('k') ? 'kg' : m[1].startsWith('g') ? 'g' : 'ct';
}

/** Does the value the agents read count as the answer key's value? Lenient on case, spacing and number format only. */
export function sameValue(key, expected, actual) {
  if (actual === null || actual === undefined || actual === '') return false;
  const a = squash(expected);
  const b = squash(actual);
  if (a === b) return true;
  if (NUMBER_KEYS.has(key)) {
    const x = parseNumber(expected);
    const y = parseNumber(actual);
    const units = [unitOf(expected), unitOf(actual)];
    return x !== null && y !== null && Math.abs(x - y) < 0.006 && (!units[0] || !units[1] || units[0] === units[1]);
  }
  if (/date$/i.test(key)) return Boolean(parseDate(expected)) && parseDate(expected) === parseDate(actual);
  if (key === 'kp.countriesOfMining') {
    const x = splitCountries(expected).sort().join(',');
    return Boolean(x) && x === splitCountries(actual).sort().join(',');
  }
  if (/country$/i.test(key) || key === 'kp.exportingCountry' || key === 'kp.importingCountry') {
    return Boolean(normalizeCountry(expected)) && normalizeCountry(expected) === normalizeCountry(actual);
  }
  if (key === 'lab.shape') return Boolean(normalizeShape(expected)) && normalizeShape(expected) === normalizeShape(actual);
  if (key.startsWith('goods.portOf')) {
    const code = String(expected).match(/\(([A-Z]{3})\)/)?.[1];
    return Boolean(code) && (String(actual).toUpperCase().includes(code) || b === squash(String(expected).replace(/\s*\(.*\)/, '')));
  }
  if (key === 'awb.flight' || key === 'goods.incoterm' || key === 'declaration.text') return b.startsWith(a) || (a.length > 30 && b.includes(a));
  return false;
}

function findDoc(documents, file) {
  const name = file.inside || path.posix.basename(file.path);
  return documents.find((d) => d.fileName === name) || null;
}

function sameShapeKey(expected, actual) {
  return Boolean(expected) && normalizeShape(expected) === normalizeShape(actual);
}

function lineMatches(expected, line) {
  const misses = [];
  if (expected.reportNumber && squash(line.reportNumber) !== squash(expected.reportNumber)) misses.push('reportNumber');
  if (expected.carat !== null && expected.carat !== undefined && !(typeof line.carat === 'number' && Math.abs(line.carat - expected.carat) <= 0.005)) misses.push('carat');
  if (expected.color && squash(line.color) !== squash(expected.color)) misses.push('color');
  if (expected.clarity && squash(line.clarity) !== squash(expected.clarity)) misses.push('clarity');
  if (expected.shapeKey && !sameShapeKey(expected.shapeKey, line.shape)) misses.push('shape');
  if (expected.pieces && expected.pieces > 1 && Number(line.pieces) !== expected.pieces) misses.push('pieces');
  return misses;
}

/** Document types, fields and lines, per file of the answer key. */
export function scoreDocuments(answers, documents, { files }) {
  const rows = [];
  for (const file of answers.files.filter((f) => files.has(f.id))) {
    const doc = findDoc(documents, file);
    const row = { id: file.id, shipment: file.shipment, file: file.inside || path.posix.basename(file.path), expectedType: file.docType };
    if (!doc) {
      rows.push({ ...row, found: false, typeRight: false, fields: { right: 0, total: Object.keys(file.fields || {}).length, misses: [] }, lines: { right: 0, total: (file.lines || []).length } });
      continue;
    }
    row.found = true;
    row.docType = doc.docType;
    row.typeRight = doc.docType === file.docType;
    row.status = doc.status;
    row.readBy = doc.readBy;
    row.ocrUsed = Boolean(doc.ocrUsed);
    const misses = [];
    let right = 0;
    for (const [key, info] of Object.entries(file.fields || {})) {
      const keys = [key, ...((file.alternatives || {})[key] || [])];
      const values = (doc.fields || []).filter((f) => keys.includes(f.key)).map((f) => f.value);
      if (values.some((v) => sameValue(key, info.value, v))) right += 1;
      else misses.push({ key, want: info.value, got: values.length ? values.join(' | ') : null });
    }
    row.fields = { right, total: Object.keys(file.fields || {}).length, misses };
    const lineMisses = [];
    let linesRight = 0;
    for (const expected of file.lines || []) {
      const lines = doc.lines || [];
      const line = expected.reportNumber
        ? lines.find((l) => squash(l.reportNumber) === squash(expected.reportNumber))
        : lines.find((l) => !l.reportNumber && typeof l.carat === 'number' && Math.abs(l.carat - expected.carat) <= 0.005)
          || lines.find((l) => l.lineNo === expected.lineNo && !l.reportNumber);
      const problems = line ? lineMatches(expected, line) : ['missing'];
      if (!problems.length) linesRight += 1;
      else lineMisses.push({ line: expected.lineNo, reportNumber: expected.reportNumber, problems, got: line ? { reportNumber: line.reportNumber, carat: line.carat, color: line.color, clarity: line.clarity, shape: line.shape, pieces: line.pieces } : null });
    }
    row.lines = { right: linesRight, total: (file.lines || []).length, extra: Math.max(0, (doc.lines || []).length - (file.lines || []).length), misses: lineMisses };
    // Field boxes: how many read fields got a spot on the page (sheets have no pages).
    const withValue = (doc.fields || []).filter((f) => f.value !== null && f.value !== '');
    row.boxes = doc.kind === 'sheet' || doc.kind === 'chat' || doc.kind === 'email'
      ? null
      : { withBox: withValue.filter((f) => Array.isArray(f.box) && f.box.length === 4).length, total: withValue.length, ocr: Boolean(doc.ocrUsed) };
    rows.push(row);
  }
  return rows;
}

/** Totals per document type. */
export function byDocType(rows) {
  const out = {};
  for (const row of rows) {
    const t = (out[row.expectedType] ||= { docs: 0, typeRight: 0, fieldsRight: 0, fields: 0, linesRight: 0, lines: 0 });
    t.docs += 1;
    t.typeRight += row.typeRight ? 1 : 0;
    t.fieldsRight += row.fields.right;
    t.fields += row.fields.total;
    t.linesRight += row.lines.right;
    t.lines += row.lines.total;
  }
  return out;
}

export function findShipment(shipments, expected) {
  const want = normalizeRef(expected.ref);
  return shipments.find((s) => normalizeRef(s.ref) === want || normalizeRef(s.invoiceNumber) === want) || null;
}

/** Are A, B and C separate shipments holding the right papers? */
export function scoreGrouping(answers, snap, { shipmentsWanted, files }) {
  const out = { shipments: snap.shipments.length, expectedShipments: shipmentsWanted.length, per: {} };
  for (const letter of shipmentsWanted) {
    const expected = answers.shipments[letter];
    const shipment = findShipment(snap.shipments, expected);
    const wrong = [];
    let right = 0;
    const ids = expected.files.filter((id) => files.has(id));
    for (const id of ids) {
      const doc = findDoc(snap.documents, answers.files.find((f) => f.id === id));
      if (doc && shipment && doc.shipmentId === shipment.id) right += 1;
      else wrong.push({ file: id, filedUnder: doc ? (snap.shipments.find((s) => s.id === doc.shipmentId)?.ref || doc.shipmentId) : 'not found' });
    }
    const extra = shipment
      ? snap.documents.filter((d) => d.shipmentId === shipment.id && !ids.some((id) => findDoc([d], answers.files.find((f) => f.id === id))))
        .filter((d) => d.source?.kind !== 'generated').map((d) => d.fileName)
      : [];
    out.per[letter] = { ref: shipment?.ref || null, found: Boolean(shipment), right, total: ids.length, wrong, extra };
  }
  out.allRight = out.shipments === out.expectedShipments && Object.values(out.per).every((p) => p.found && p.right === p.total && !p.extra.length);
  return out;
}

/** Each stone: report number, carat, colour, clarity and shape. */
export function scoreStones(answers, snap, { shipmentsWanted }) {
  const out = {};
  for (const letter of shipmentsWanted) {
    const expected = answers.shipments[letter];
    const shipment = findShipment(snap.shipments, expected);
    const stones = shipment ? snap.stones.filter((s) => s.shipmentId === shipment.id) : [];
    const rows = [];
    for (const want of expected.stones) {
      const stone = want.reportNumber
        ? stones.find((s) => squash(s.reportNumber) === squash(want.reportNumber))
        : stones.find((s) => !s.reportNumber && typeof s.carat === 'number' && Math.abs(s.carat - want.carat) <= 0.005);
      const problems = [];
      if (!stone) problems.push('missing');
      else {
        if (!(typeof stone.carat === 'number' && Math.abs(stone.carat - want.carat) <= 0.005)) problems.push(`carat ${stone.carat}`);
        if (squash(stone.color) !== squash(want.color)) problems.push(`colour ${stone.color}`);
        if (squash(stone.clarity) !== squash(want.clarity)) problems.push(`clarity ${stone.clarity}`);
        if (!sameShapeKey(want.shape, stone.shape)) problems.push(`shape ${stone.shape}`);
      }
      rows.push({ reportNumber: want.reportNumber, carat: want.carat, right: !problems.length, reportAndCaratRight: Boolean(stone) && !problems.some((p) => /^(missing|carat)/.test(p)), problems });
    }
    out[letter] = {
      right: rows.filter((r) => r.right).length, total: rows.length,
      reportAndCaratRight: rows.filter((r) => r.reportAndCaratRight).length,
      extra: stones.length - rows.filter((r) => !r.problems.includes('missing')).length,
      rows,
    };
  }
  return out;
}

/** What the rules decided per shipment: checks, open questions, required papers, sanctions. */
export function scoreRules(answers, snap, { shipmentsWanted, phase }) {
  const out = {};
  for (const letter of shipmentsWanted) {
    const expected = answers.shipments[letter];
    const shipment = findShipment(snap.shipments, expected);
    if (!shipment) {
      out[letter] = { found: false };
      continue;
    }
    const checks = snap.checks.filter((c) => c.shipmentId === shipment.id);
    const open = snap.questions.filter((q) => q.shipmentId === shipment.id && q.status === 'open');
    const results = [];
    for (const want of expected.expectedChecks) {
      const got = checks.filter((c) => c.code === want.code);
      let wantSeverity = want.severity || null;
      // The packing list for A arrives later: after that its check passes.
      if (want.until && phase === 'after-later') wantSeverity = 'pass';
      let ok;
      if (want.expect === 'absent') ok = !got.length;
      else if (want.code === 'stone_details') ok = got.some((c) => c.severity === wantSeverity && c.detail.includes(want.reportNumber));
      else if (want.code === 'required_documents' && wantSeverity === 'warn') ok = got.some((c) => c.severity === 'warn' && want.missing.every((m) => c.detail.toLowerCase().includes(m.replace('_', ' '))));
      else ok = got.some((c) => c.severity === wantSeverity);
      results.push({ code: want.code, want: want.expect === 'absent' ? 'absent' : wantSeverity, got: got.map((c) => `${c.severity}: ${c.detail}`), ok });
    }
    // The questions a person must see (one line each).
    const wantQuestions = expectedQuestions(letter, expected, phase);
    const questionResults = wantQuestions.map((w) => ({ ...w, ok: open.some((q) => w.test(q)) })).map(({ test, ...rest }) => rest);
    const required = (shipment.required || []).map((r) => r.kind);
    const parties = snap.parties.filter((p) => (p.shipmentIds || []).includes(shipment.id));
    out[letter] = {
      found: true, ref: shipment.ref, status: shipment.status, direction: shipment.direction, destination: shipment.destinationCountry,
      goods: shipment.goods, regime: shipment.regime,
      checks: results, checksRight: results.filter((r) => r.ok).length, checksTotal: results.length,
      questions: questionResults, openQuestions: open.map((q) => q.text),
      required, requiredRight: expected.required.every((k) => required.includes(k)) && !expected.notRequired.some((k) => required.includes(k)),
      parties: parties.map((p) => ({ name: p.name, status: p.status })),
      sanctionsMatch: parties.filter((p) => p.status === 'match').map((p) => p.name),
      allChecks: checks.map((c) => `${c.severity} ${c.code}: ${c.detail}`),
    };
  }
  return out;
}

function expectedQuestions(letter, expected, phase) {
  const missing = (docType, word) => ({ want: `${word} missing`, test: (q) => q.kind === 'missing_document' && q.docType === docType });
  const list = [];
  if (letter === 'A') {
    list.push({ want: 'carat mismatch on 7391020002', test: (q) => q.kind === 'mismatch' && q.text.includes('7391020002') && /0\.71/.test(q.text) && /0\.70/.test(q.text) });
    if (phase === 'before-later') list.push(missing('packing_list', 'packing list'));
  }
  if (letter === 'B') list.push(missing('packing_list', 'packing list'));
  if (letter === 'C') list.push(missing('packing_list', 'packing list'), missing('shipping_bill', 'shipping bill'));
  return list;
}

/** Did the packing-list question for A close (after the draft or the late packing list)? */
function packingQuestionClosed(snap, shipment) {
  const questions = snap.questions.filter((q) => q.shipmentId === shipment?.id && q.kind === 'missing_document' && q.docType === 'packing_list');
  return { asked: questions.length > 0, open: questions.filter((q) => q.status === 'open').length, closed: questions.filter((q) => q.status !== 'open').map((q) => `${q.status}${q.closedReason ? ` (${q.closedReason})` : ''}`) };
}

// ---------------------------------------------------------------- papers, signing, history

async function pdfCheck(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const out = { bytes: bytes.length, pdfjsPages: null, pdfinfoPages: null, ok: false, error: null };
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS, isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    out.pdfjsPages = doc.numPages;
    await task.destroy();
  } catch (err) {
    out.error = `pdf.js: ${err.message}`;
  }
  const file = path.join(os.tmpdir(), `jl-eval-${randomBytes(4).toString('hex')}.pdf`);
  try {
    await fs.writeFile(file, bytes);
    const info = await new Promise((resolve) => execFile('pdfinfo', [file], (err, stdout) => resolve(err ? null : stdout)));
    if (info) out.pdfinfoPages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]) || null;
  } finally {
    await fs.rm(file, { force: true });
  }
  out.ok = Boolean(out.pdfjsPages) && (out.pdfinfoPages === null || out.pdfinfoPages === out.pdfjsPages);
  return out;
}

const HISTORY_CHAIN = [
  { stage: 'mined', want: 'Botswana and Namibia from the KP', test: (e) => /Botswana/.test(e.detail) && /Namibia/.test(e.detail) && /AE-SAMPLE-0001234/.test(e.detail) },
  { stage: 'rough_purchased', want: 'SRT-2026-0315, lot R-0412', test: (e) => /SRT-2026-0315/.test(e.detail) && /R-0412/.test(e.detail) },
  { stage: 'cut_and_polished', want: 'factory record lot R-0412', test: (e) => /R-0412/.test(e.detail) },
  { stage: 'graded', want: 'lab report 7391020001', test: (e) => /7391020001/.test(e.detail) },
  { stage: 'invoiced', want: 'invoice KG/26-27/041', test: (e) => /KG\/26-27\/041/.test(e.detail) },
  { stage: 'packed', want: 'packing list', test: () => true },
  { stage: 'cleared_for_export', want: 'shipping bill 1234567 + LEO', test: (e) => /1234567/.test(e.detail) && /Let Export Order/.test(e.detail) },
  { stage: 'flown', want: 'AWB 99000012345', test: (e) => /99000012345/.test(e.detail) },
  { stage: 'statement_drafted', want: 'EU statement drafted', test: (e) => /Due Diligence|statement/i.test(e.title) },
];

export function scoreHistory(events) {
  const kinds = events.map((e) => e.kind);
  const rows = HISTORY_CHAIN.map((step) => {
    const found = events.filter((e) => e.kind === step.stage);
    return { stage: step.stage, want: step.want, ok: found.some(step.test), got: found.map((e) => `${e.at ? `${e.at.slice(0, 10)} ` : ''}${e.title}: ${e.detail}`) };
  });
  const order = HISTORY_CHAIN.map((s) => kinds.indexOf(s.stage)).filter((i) => i >= 0);
  return { rows, inOrder: order.every((v, i) => i === 0 || v > order[i - 1]), ok: rows.every((r) => r.ok) };
}

// ---------------------------------------------------------------- the run

function parseArgs(argv) {
  const args = { mode: 'direct', only: null, cache: false, model: undefined, quiet: false, dump: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') args.mode = 'off';
    else if (a === '--proxy') args.mode = 'proxy';
    else if (a === '--cache') args.cache = true;
    else if (a === '--only') args.only = String(argv[++i] || '').toUpperCase();
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--dump') args.dump = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (args.only && !['A', 'B', 'C'].includes(args.only)) throw new Error('--only takes A, B or C');
  if (args.mode === 'proxy') args.cache = false; // the point is to go through the Edge Function every time
  return args;
}

function usageSummary(calls, filter = () => true) {
  const picked = calls.filter(filter);
  const sum = (pick) => picked.reduce((n, c) => n + (pick(c) || 0), 0);
  return {
    calls: picked.length,
    cachedCalls: picked.filter((c) => c.cached).length,
    failedCalls: picked.filter((c) => c.status && c.status !== 200).length,
    inputTokens: sum((c) => c.usage?.prompt_tokens),
    cachedInputTokens: sum((c) => c.usage?.prompt_tokens_details?.cached_tokens),
    outputTokens: sum((c) => c.usage?.completion_tokens),
    reasoningTokens: sum((c) => c.usage?.completion_tokens_details?.reasoning_tokens),
    aiSeconds: Math.round(sum((c) => c.ms) / 100) / 10,
    costUsd: Math.round(sum(callCost) * 10000) / 10000,
    models: [...new Set(picked.map((c) => c.model).filter(Boolean))],
  };
}

export async function runEval(args) {
  const answers = await loadAnswers();
  const shipmentsWanted = args.only ? [args.only] : ['A', 'B', 'C'];
  const fileIds = new Set(answers.files.filter((f) => shipmentsWanted.includes(f.shipment)).map((f) => f.id));
  const beforeLater = new Set([...fileIds].filter((id) => answers.files.find((f) => f.id === id).channel !== 'later'));
  const log = (...parts) => { if (!args.quiet) console.log(...parts); };
  const started = Date.now();
  const h = await createHarness({ mode: args.mode, model: args.model, cache: args.cache, answers });
  const report = {
    startedAt: new Date(started).toISOString(), mode: args.mode, only: args.only, cache: args.cache,
    model: args.mode === 'off' ? 'offline' : h.ai.model, ofac: { entries: h.sdn.count, date: h.sdn.date, source: h.sdn.sourceKind },
  };
  if (h.login) report.proxy = { email: h.login.email, workspaceId: h.login.workspaceId, accountCreated: h.login.created, proxyUrl: h.login.cloud.aiProxyUrl };
  const docTimes = {}; // docId -> { start, read }
  h.services.events.on('agent', (e) => {
    if (e.agent !== 'intake' || !e.docId) return;
    const t = (docTimes[e.docId] ||= {});
    if (e.action === 'start') t.start = Date.now();
    if (e.action === 'read' || e.action === 'error') t.read = Date.now();
  });
  const errors = [];
  h.services.events.on('agent', (e) => { if (e.action === 'error') errors.push(`${e.agent}: ${e.message}`); });

  try {
    const channels = await sampleFiles(answers, { only: args.only });
    // 1. WhatsApp export, the email, the dropped files.
    log(`Mode ${args.mode}${args.only ? `, shipment ${args.only} only` : ''}. Feeding ${CHANNELS.map((c) => `${channels[c].length} ${c}`).join(', ')} file(s).`);
    h.meter.during('reading');
    const t1 = Date.now();
    for (const channel of CHANNELS) {
      if (channels[channel].length) await h.services.addFiles(channels[channel]);
    }
    await withTimeout(h.services.idle(), IDLE_TIMEOUT_MS, 'The first pass');
    report.firstPassSeconds = Math.round((Date.now() - t1) / 100) / 10;
    const snap1 = await snapshot(h.store);
    log(`First pass done in ${report.firstPassSeconds} s: ${snap1.documents.length} documents, ${snap1.shipments.length} shipments, ${snap1.stones.length} stones.`);
    report.phase1 = {
      documents: scoreDocuments(answers, snap1.documents, { files: beforeLater }),
      grouping: scoreGrouping(answers, snap1, { shipmentsWanted, files: beforeLater }),
      stones: scoreStones(answers, snap1, { shipmentsWanted }),
      rules: scoreRules(answers, snap1, { shipmentsWanted, phase: 'before-later' }),
    };

    // 2. "Tell the agents", before the late packing list.
    report.asks = [];
    const ask = async (text) => {
      h.meter.during(`ask: ${text}`);
      const t = Date.now();
      const answer = await h.services.ask(text, { by: EVAL_PERSON });
      await withTimeout(h.services.idle(), IDLE_TIMEOUT_MS, `"${text}"`);
      report.asks.push({ text, seconds: Math.round((Date.now() - t) / 100) / 10, intent: answer.intent, reply: answer.reply, steps: answer.steps, actions: answer.actions });
      log(`Asked "${text}": [${answer.intent}] ${answer.reply}`);
      return answer;
    };
    if (shipmentsWanted.includes('A')) {
      await ask('What is still missing?');
      await ask('Build the packing list from the chat');
      const snapDraft = await snapshot(h.store);
      const a = findShipment(snapDraft.shipments, answers.shipments.A);
      const draft = snapDraft.documents.find((d) => d.source?.kind === 'generated' && d.shipmentId === a?.id && d.docType === 'packing_list');
      report.packingDraft = {
        drafted: Boolean(draft), lines: draft ? draft.lines.length : 0,
        stones: draft ? draft.lines.map((l) => `${l.reportNumber || 'no report'} ${l.carat} ${l.shape || ''} ${l.color || ''} ${l.clarity || ''}`.trim()) : [],
        question: packingQuestionClosed(snapDraft, a),
      };
    }

    // 3. The late packing list.
    if (channels.later.length) {
      h.meter.during('reading');
      const t2 = Date.now();
      await h.services.addFiles(channels.later);
      await withTimeout(h.services.idle(), IDLE_TIMEOUT_MS, 'The late packing list');
      report.laterSeconds = Math.round((Date.now() - t2) / 100) / 10;
    }
    const snap2 = await snapshot(h.store);
    report.phase2 = {
      documents: scoreDocuments(answers, snap2.documents, { files: fileIds }),
      grouping: scoreGrouping(answers, snap2, { shipmentsWanted, files: fileIds }),
      stones: scoreStones(answers, snap2, { shipmentsWanted }),
      rules: scoreRules(answers, snap2, { shipmentsWanted, phase: 'after-later' }),
    };
    if (shipmentsWanted.includes('A')) report.packingQuestionAfterLater = packingQuestionClosed(snap2, findShipment(snap2.shipments, answers.shipments.A));

    // 4. Prepare the papers: the agents stop at open questions; a person answers the carat one.
    await ask('Prepare the papers for my latest shipment');
    if (shipmentsWanted.includes('A')) {
      const a = findShipment((await snapshot(h.store)).shipments, answers.shipments.A);
      const question = (await h.store.list('questions', (q) => q.shipmentId === a?.id && q.status === 'open' && q.kind === 'mismatch' && q.text.includes('7391020002')))[0];
      if (question) {
        h.meter.during('answer');
        await h.services.answerQuestion(question.id, '0.70 ct, as on the lab report', EVAL_PERSON);
        await withTimeout(h.services.idle(), IDLE_TIMEOUT_MS, 'The answer');
        const after = await h.store.get('shipments', a.id);
        report.answered = { question: question.text, statusAfter: after.status, papersBuiltByAgents: (await h.store.list('papers', (p) => p.shipmentId === a.id)).map((p) => `${p.kind} ${p.ref} v${p.version} ${p.status}`) };
      }
    }

    // 5. Papers for every shipment, then one is signed.
    h.meter.during('papers');
    report.papers = {};
    const shipmentsNow = await h.store.list('shipments');
    for (const letter of shipmentsWanted) {
      const shipment = findShipment(shipmentsNow, answers.shipments[letter]);
      if (!shipment) continue;
      let papers = (await h.store.list('papers', (p) => p.shipmentId === shipment.id && p.kind !== 'packing_list_draft'));
      if (!papers.length) papers = (await h.services.buildPapers(shipment.id, { by: EVAL_PERSON })).papers;
      const rows = [];
      for (const paper of papers) {
        const bytes = await h.store.getFile(paper.fileKey);
        rows.push({ kind: paper.kind, ref: paper.ref, version: paper.version, status: paper.status, pages: paper.pages, sha256: paper.sha256, pdf: await pdfCheck(bytes) });
      }
      report.papers[letter] = rows;
    }
    const target = shipmentsWanted[0];
    const targetShipment = findShipment(await h.store.list('shipments'), answers.shipments[target]);
    const pack = targetShipment && (await h.store.list('papers', (p) => p.shipmentId === targetShipment.id && p.kind === 'export_pack'))[0];
    if (pack) {
      const before = { status: pack.status, sha256: pack.sha256, shipmentStatus: targetShipment.status };
      let signed = null;
      let error = null;
      try {
        signed = await h.services.signPaper(pack.id, { name: EVAL_PERSON.name, title: 'Partner' }, EVAL_PERSON);
      } catch (err) {
        error = err.message;
      }
      const bytes = signed ? await h.store.getFile(signed.fileKey) : null;
      const fileHash = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
      const shipmentAfter = await h.store.get('shipments', targetShipment.id);
      report.signing = {
        paper: `${pack.ref} v${pack.version}`, before, error,
        after: signed ? { status: signed.status, sha256: signed.sha256, signedBy: signed.signedBy, shipmentStatus: shipmentAfter.status } : null,
        shaChanged: Boolean(signed && signed.sha256 !== before.sha256), fileMatchesSha: Boolean(signed && fileHash === signed.sha256),
        flowOk: before.status === 'ready_to_sign' && signed?.status === 'signed' && shipmentAfter.status === 'signed',
        signedPdf: bytes ? await pdfCheck(bytes) : null,
      };
    }

    // 6. The stone's history.
    if (shipmentsWanted.includes('A')) {
      const history = await h.services.history('7391020001');
      report.history = { stone: history.stone ? `${history.stone.reportNumber} ${history.stone.carat} ct` : null, events: history.events.length, ...scoreHistory(history.events) };
    }

    // 7. Usage and time.
    const subjectShipment = (call) => {
      if (call.during && call.during !== 'reading') return 'asks and papers';
      const entry = answers.files.find((f) => (f.inside || path.posix.basename(f.path)) === call.subject);
      if (entry) return entry.shipment;
      if (call.subject === 'chat' || call.subject === 'email') return 'A';
      return 'other';
    };
    report.usage = { total: usageSummary(h.meter.calls), perShipment: {} };
    for (const key of [...shipmentsWanted, 'asks and papers', 'other']) {
      const summary = usageSummary(h.meter.calls, (c) => subjectShipment(c) === key);
      if (summary.calls) report.usage.perShipment[key] = summary;
    }
    report.usage.perTask = {};
    for (const task of [...new Set(h.meter.calls.map((c) => c.task))]) report.usage.perTask[task] = usageSummary(h.meter.calls, (c) => c.task === task);
    report.readingSeconds = {};
    const docsNow = await h.store.list('documents');
    for (const letter of shipmentsWanted) {
      const docs = docsNow.filter((d) => answers.files.some((f) => f.shipment === letter && (f.inside || path.posix.basename(f.path)) === d.fileName));
      const spans = docs.map((d) => docTimes[d.id]).filter((t) => t?.start && t?.read);
      report.readingSeconds[letter] = spans.length
        ? { documents: spans.length, sumSeconds: Math.round(spans.reduce((n, t) => n + (t.read - t.start), 0) / 100) / 10, slowestSeconds: Math.round(Math.max(...spans.map((t) => t.read - t.start)) / 100) / 10 }
        : null;
    }
    report.aiLastError = h.ai.lastError ? { code: h.ai.lastError.code, message: h.ai.lastError.message } : null;
    report.agentErrors = errors;
    report.warnings = docsNow.filter((d) => d.warnings?.length).map((d) => ({ file: d.fileName, warnings: d.warnings }));
    report.totalSeconds = Math.round((Date.now() - started) / 100) / 10;
    report.summary = summarize(report, shipmentsWanted);
    if (args.dump) {
      const records = await snapshot(h.store);
      for (const doc of records.documents) delete doc.text; // the text layer is long and not needed here
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'eval-snapshot.json'), JSON.stringify({ ...records, calls: h.meter.calls }, null, 1));
    }
    return report;
  } finally {
    const closed = await h.close();
    if (report.proxy) report.proxy.signedOut = closed.signedOut;
  }
}

// ---------------------------------------------------------------- the summary table

function summarize(report, shipmentsWanted) {
  const docs = report.phase2.documents;
  const fieldsRight = docs.reduce((n, d) => n + d.fields.right, 0);
  const fieldsTotal = docs.reduce((n, d) => n + d.fields.total, 0);
  const boxes = docs.filter((d) => d.boxes && d.boxes.total);
  return {
    docTypes: `${docs.filter((d) => d.typeRight).length}/${docs.length}`,
    fields: `${fieldsRight}/${fieldsTotal}`,
    stones: Object.fromEntries(shipmentsWanted.map((l) => [l, `${report.phase2.stones[l].right}/${report.phase2.stones[l].total} full, ${report.phase2.stones[l].reportAndCaratRight}/${report.phase2.stones[l].total} report+carat`])),
    grouping: report.phase2.grouping.allRight ? 'right' : 'wrong',
    checks: Object.fromEntries(shipmentsWanted.map((l) => [l, `${report.phase2.rules[l].checksRight}/${report.phase2.rules[l].checksTotal}`])),
    questions: Object.fromEntries(shipmentsWanted.map((l) => [l, `${report.phase1.rules[l].questions?.filter((q) => q.ok).length}/${report.phase1.rules[l].questions?.length} before later, ${report.phase2.rules[l].questions?.filter((q) => q.ok).length}/${report.phase2.rules[l].questions?.length} after`])),
    required: Object.fromEntries(shipmentsWanted.map((l) => [l, report.phase2.rules[l].requiredRight ? 'right' : `wrong (${report.phase2.rules[l].required?.join(', ')})`])),
    sanctionsMatches: shipmentsWanted.flatMap((l) => report.phase2.rules[l].sanctionsMatch || []),
    papersValid: Object.values(report.papers || {}).flat().every((p) => p.pdf.ok),
    signing: report.signing ? (report.signing.flowOk && report.signing.shaChanged && report.signing.fileMatchesSha ? 'ok' : 'wrong') : 'not run',
    history: report.history ? (report.history.ok && report.history.inOrder ? 'full chain' : 'incomplete') : 'not run',
    boxes: `${boxes.reduce((n, d) => n + d.boxes.withBox, 0)}/${boxes.reduce((n, d) => n + d.boxes.total, 0)}`,
    costUsd: report.usage.total.costUsd,
    calls: report.usage.total.calls,
  };
}

function pad(s, n) {
  const text = String(s ?? '');
  return text.length >= n ? text : text + ' '.repeat(n - text.length);
}

export function reportText(report) {
  const lines = [];
  const add = (s = '') => lines.push(s);
  const s = report.summary;
  add(`# Jewel Labs eval: ${report.mode === 'off' ? 'offline reader' : `${report.model} (${report.mode})`}${report.only ? `, shipment ${report.only}` : ''}`);
  add('');
  add(`Run ${report.startedAt}, ${report.totalSeconds} s in all (first pass ${report.firstPassSeconds} s). AI answers ${report.cache ? 'could come from the cache' : 'all fresh (no cache)'}.`);
  if (report.proxy) add(`Cloud path: test account ${report.proxy.email} (${report.proxy.accountCreated ? 'created by the signup function' : 'signed in again'}), house ${report.proxy.workspaceId}, AI through ${report.proxy.proxyUrl}. Signed out at the end: ${report.proxy.signedOut === null || report.proxy.signedOut === undefined ? 'see the JSON' : report.proxy.signedOut ? 'yes' : 'NO'}.`);
  add('');
  add('| measure | result |');
  add('|---|---|');
  add(`| document types | ${s.docTypes} |`);
  add(`| fields | ${s.fields} |`);
  for (const [l, v] of Object.entries(s.stones)) add(`| stones ${l} | ${v} |`);
  add(`| shipments grouped | ${s.grouping} |`);
  for (const [l, v] of Object.entries(s.checks)) add(`| expected checks ${l} | ${v} |`);
  for (const [l, v] of Object.entries(s.questions)) add(`| expected questions ${l} | ${v} |`);
  for (const [l, v] of Object.entries(s.required)) add(`| required papers ${l} | ${v} |`);
  add(`| sanctions matches | ${s.sanctionsMatches.length ? s.sanctionsMatches.join(', ') : 'none'} |`);
  add(`| papers open as valid PDFs | ${s.papersValid ? 'yes' : 'NO'} |`);
  add(`| signing (ready_to_sign to signed, SHA-256 changed) | ${s.signing} |`);
  add(`| stone history 7391020001 | ${s.history} |`);
  add(`| field boxes (PDFs and images) | ${s.boxes} |`);
  add(`| AI calls | ${s.calls} (${report.usage.total.cachedCalls} from cache) |`);
  add(`| AI cost | $${s.costUsd.toFixed(4)} |`);
  add('');
  add('## Per document type (after the late packing list)');
  add('');
  add('| doc type | docs | type right | fields right | lines right |');
  add('|---|---|---|---|---|');
  for (const [type, t] of Object.entries(byDocType(report.phase2.documents))) add(`| ${type} | ${t.docs} | ${t.typeRight}/${t.docs} | ${t.fieldsRight}/${t.fields} | ${t.linesRight}/${t.lines} |`);
  add('');
  add('## Per document');
  add('');
  add('| file | ship | type | fields | lines | boxes | read by |');
  add('|---|---|---|---|---|---|---|');
  for (const d of report.phase2.documents) {
    add(`| ${d.file} | ${d.shipment} | ${d.typeRight ? 'ok' : `${d.docType || 'missing'} (want ${d.expectedType})`} | ${d.fields.right}/${d.fields.total} | ${d.lines.right}/${d.lines.total} | ${d.boxes ? `${d.boxes.withBox}/${d.boxes.total}${d.boxes.ocr ? ' OCR' : ''}` : 'n/a'} | ${d.readBy || ''} |`);
  }
  const misses = report.phase2.documents.flatMap((d) => d.fields.misses.map((m) => `- ${d.file}: ${m.key} want "${m.want}", got ${m.got === null ? 'nothing' : `"${m.got}"`}`));
  const lineMisses = report.phase2.documents.flatMap((d) => (d.lines.misses || []).map((m) => `- ${d.file}: line ${m.line} (${m.reportNumber || 'no report'}): ${m.problems.join(', ')}${m.got ? ` got ${JSON.stringify(m.got)}` : ''}`));
  if (misses.length || lineMisses.length) {
    add('');
    add('### Misses');
    add('');
    lines.push(...misses, ...lineMisses);
  }
  add('');
  add('## Shipments');
  for (const [letter, g] of Object.entries(report.phase2.grouping.per)) {
    const r = report.phase2.rules[letter];
    add('');
    add(`### ${letter}: ${g.ref || 'NOT FOUND'} (${r.status || ''}, ${r.direction || ''}, to ${r.destination || '?'}, ${r.regime || ''})`);
    add('');
    add(`- papers: ${g.right}/${g.total} filed here${g.wrong.length ? `; wrong: ${g.wrong.map((w) => `${w.file} under ${w.filedUnder}`).join(', ')}` : ''}${g.extra.length ? `; extra: ${g.extra.join(', ')}` : ''}`);
    const st = report.phase2.stones[letter];
    add(`- stones: ${st.right}/${st.total}${st.extra ? `, ${st.extra} extra` : ''}${st.rows.filter((x) => !x.right).map((x) => `; ${x.reportNumber || `${x.carat} ct lot`}: ${x.problems.join(', ')}`).join('')}`);
    add(`- required: ${r.required.join(', ')} (${r.requiredRight ? 'right' : 'WRONG'})`);
    add(`- expected checks: ${r.checks.map((c) => `${c.code} ${c.want} ${c.ok ? 'ok' : `NO (got ${c.got.join(' / ') || 'none'})`}`).join('; ')}`);
    add(`- questions before the late packing list: ${report.phase1.rules[letter].questions.map((q) => `${q.want} ${q.ok ? 'ok' : 'NO'}`).join('; ') || 'none expected'}`);
    add(`- open questions now: ${r.openQuestions.join(' | ') || 'none'}`);
    add(`- parties: ${r.parties.map((p) => `${p.name} ${p.status}`).join(', ')}`);
    for (const p of report.papers?.[letter] || []) add(`- paper ${p.kind} ${p.ref} v${p.version} ${p.status}: ${p.pdf.pdfjsPages} pages (pdfinfo ${p.pdf.pdfinfoPages ?? 'n/a'}) ${p.pdf.ok ? 'valid' : `INVALID ${p.pdf.error || ''}`}`);
  }
  add('');
  add('## Tell the agents');
  add('');
  for (const a of report.asks || []) add(`- "${a.text}" -> ${a.intent} (${a.seconds} s): ${a.reply.replace(/\n/g, ' / ')} [steps: ${a.steps.join(', ')}]`);
  if (report.packingDraft) add(`- packing list draft: ${report.packingDraft.drafted ? `${report.packingDraft.lines} lines (${report.packingDraft.stones.join('; ')})` : 'not drafted'}; packing list question ${report.packingDraft.question.open ? 'still open' : `closed: ${report.packingDraft.question.closed.join(', ')}`}`);
  if (report.packingQuestionAfterLater) add(`- after the late packing list: packing list question ${report.packingQuestionAfterLater.open ? 'OPEN' : 'closed'}`);
  if (report.answered) add(`- answered "${report.answered.question}": shipment now ${report.answered.statusAfter}; agents built ${report.answered.papersBuiltByAgents.join(', ') || 'nothing'}`);
  if (report.signing) {
    add('');
    add('## Signing');
    add('');
    add(`- ${report.signing.paper}: ${report.signing.before.status} -> ${report.signing.after?.status || report.signing.error}; shipment ${report.signing.before.shipmentStatus} -> ${report.signing.after?.shipmentStatus}; SHA-256 ${report.signing.shaChanged ? 'changed' : 'NOT changed'} (${report.signing.before.sha256?.slice(0, 12)} -> ${report.signing.after?.sha256?.slice(0, 12)}), stored file matches: ${report.signing.fileMatchesSha}`);
  }
  if (report.history) {
    add('');
    add(`## Stone history ${report.history.stone} (${report.history.events} events, ${report.history.inOrder ? 'in order' : 'OUT OF ORDER'})`);
    add('');
    for (const r of report.history.rows) add(`- ${r.ok ? 'ok' : 'NO'} ${r.stage} (${r.want}): ${r.got.join(' | ') || 'missing'}`);
  }
  add('');
  add('## AI usage');
  add('');
  add('| part | calls | input tokens (cached) | output tokens | AI seconds | cost USD |');
  add('|---|---|---|---|---|---|');
  const usageRow = (name, u) => add(`| ${name} | ${u.calls}${u.cachedCalls ? ` (${u.cachedCalls} cached)` : ''} | ${u.inputTokens} (${u.cachedInputTokens}) | ${u.outputTokens} | ${u.aiSeconds} | ${u.costUsd.toFixed(4)} |`);
  for (const [name, u] of Object.entries(report.usage.perShipment)) usageRow(`shipment ${name}`, u);
  for (const [name, u] of Object.entries(report.usage.perTask)) usageRow(`task ${name}`, u);
  usageRow('total', report.usage.total);
  add('');
  add(`Prices: ${Object.entries(PRICES).map(([m, p]) => `${m} $${p.input} in / $${p.cached} cached / $${p.output} out per 1M tokens`).join('; ')} (developers.openai.com/api/docs/pricing).`);
  add('');
  add(`Reading time per shipment (sum of per-document read times; documents are read 3 at a time): ${Object.entries(report.readingSeconds).map(([l, r]) => `${l} ${r ? `${r.sumSeconds} s over ${r.documents} docs, slowest ${r.slowestSeconds} s` : 'n/a'}`).join('; ')}.`);
  if (report.aiLastError) add(`Last AI problem: ${report.aiLastError.code}: ${report.aiLastError.message}`);
  if (report.agentErrors.length) {
    add('');
    add('## Agent errors');
    add('');
    for (const e of report.agentErrors) add(`- ${e}`);
  }
  return lines.join('\n');
}

/** The latest offline and cloud-path runs, summed up under the main report. */
async function otherRuns() {
  const lines = ['', '## Other runs', ''];
  const runs = [
    ['eval-report-off.json', 'Offline reader (node scripts/eval.js --offline)'],
    ['eval-report-proxy-A.json', 'Cloud path, shipment A (node scripts/eval.js --proxy --only A)'],
  ];
  for (const [file, what] of runs) {
    const other = safeJson(await fs.readFile(path.join(OUT_DIR, file), 'utf8').catch(() => ''));
    if (!other?.summary) continue;
    const s = other.summary;
    const parts = [
      `types ${s.docTypes}`, `fields ${s.fields}`,
      `stones ${Object.entries(s.stones).map(([l, v]) => `${l} ${v}`).join('; ')}`, `grouping ${s.grouping}`,
      `checks ${Object.entries(s.checks).map(([l, v]) => `${l} ${v}`).join(' ')}`,
      `required ${Object.values(s.required).every((v) => v === 'right') ? 'right' : 'wrong'}`,
      `papers valid ${s.papersValid ? 'yes' : 'no'}`, `signing ${s.signing}`, `history ${s.history}`, `boxes ${s.boxes}`,
      `AI calls ${s.calls}`, `cost $${s.costUsd.toFixed(4)}`,
    ];
    if (other.proxy) parts.push(`account ${other.proxy.email}`, `signed out ${other.proxy.signedOut === true ? 'yes' : String(other.proxy.signedOut)}`);
    lines.push(`- ${what}, run ${other.startedAt}: ${parts.join(', ')}.`);
  }
  return lines.length > 3 ? lines.join('\n') : '';
}

async function main() {
  // --rewrite: render test/.tmp/eval-report.md again from its JSON (to pick up newer offline and proxy runs).
  if (process.argv.includes('--rewrite')) {
    const saved = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'eval-report.json'), 'utf8'));
    await fs.writeFile(path.join(OUT_DIR, 'eval-report.md'), `${reportText(saved)}${await otherRuns()}\n`);
    console.log('Rewrote test/.tmp/eval-report.md');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const report = await runEval(args);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const base = args.only || args.mode !== 'direct' ? `eval-report${args.mode !== 'direct' ? `-${args.mode}` : ''}${args.only ? `-${args.only}` : ''}` : 'eval-report';
  await fs.writeFile(path.join(OUT_DIR, `${base}.json`), JSON.stringify(report, null, 2));
  let text = reportText(report);
  if (base === 'eval-report') text += await otherRuns();
  await fs.writeFile(path.join(OUT_DIR, `${base}.md`), `${text}\n`);
  console.log(`\n${text}\n\nWrote test/.tmp/${base}.json and test/.tmp/${base}.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (err) => {
    console.error(`Eval failed: ${err.stack || err.message}`);
    process.exit(1);
  });
}

export { AI_MODELS };
