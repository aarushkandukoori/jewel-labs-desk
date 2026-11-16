// Pipeline + services tests. Everything runs offline: the store is the real local store in a temp folder
// (or a tiny in-memory copy of its interface), and ai, ocr, ingest, records, rules, sanctions, papers,
// mail and metrics are small fakes passed in through createServices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { createServices } from '../../src/core/services.js';
import { mergeOptions } from '../../src/core/pipeline/runner.js';
import { questionKey, decideStatus } from '../../src/core/pipeline/origin-stage.js';
import { applyAnswers } from '../../src/core/pipeline/answers.js';
import { findShipment } from '../../src/core/pipeline/ask.js';
import { saveShipment } from '../../src/core/pipeline/shipment-save.js';
import { listFiles } from '../../src/core/pipeline/files.js';
import { STUCK_EMAIL, STUCK_FILE } from '../../src/core/pipeline/worker.js';
import { collectParties } from '../../src/core/pipeline/sanctions-stage.js';

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PASS = ['test', 'app', 'pw'].join('-'); // built at runtime: nothing in the repo looks like a password
const WRONG_PASS = ['wrong', 'pw'].join('-');
const CLERK = { id: 'user-1', name: 'Asha (SAMPLE clerk)', email: 'clerk@house.example' };
const DESK = { id: 'desk-1', name: 'Desk reviewer', email: 'desk@jewellabs.example' };

// ---------- store: the real local store if it is there, else an in-memory one ----------

async function makeStore(profile) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-pipeline-'));
  const remove = () => fs.rm(dir, { recursive: true, force: true });
  try {
    const { createLocalWorkspace, openLocalStore } = await import('../../src/core/store/index.js');
    const workspace = await createLocalWorkspace({ dir, profile });
    const store = await openLocalStore({ dir, workspaceId: workspace.id });
    return { store, dir, cleanup: async () => { await store.close(); await remove(); } };
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return { store: memoryStore(profile), dir, cleanup: remove };
  }
}

function memoryStore(profile) {
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const tables = new Map();
  const files = new Map();
  const listeners = [];
  let workspace = { id: 'ws-test', autopilot: true, deskReview: false, environment: 'sandbox', emailDomains: [], permissions: {}, ...profile };
  const table = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  return {
    async workspace() { return copy(workspace); },
    async updateWorkspace(patch) { workspace = { ...workspace, ...copy(patch) }; return copy(workspace); },
    async list(name, filter) { return [...table(name).values()].map(copy).filter((r) => !filter || filter(r)); },
    async get(name, id) { return copy(table(name).get(id)) || null; },
    async put(name, obj) {
      const now = new Date().toISOString();
      const old = table(name).get(obj.id);
      const record = { ...copy(obj), workspaceId: workspace.id, createdAt: old?.createdAt || now, updatedAt: now };
      table(name).set(record.id, record);
      listeners.forEach((fn) => fn({ collection: name, id: record.id, op: 'put', value: record }));
      return copy(record);
    },
    async remove(name, id) { table(name).delete(id); },
    async putFile(key, bytes) { files.set(key, new Uint8Array(bytes)); return key; },
    async getFile(key) { if (!files.has(key)) throw new Error(`No file ${key}`); return files.get(key); },
    async removeFile(key) { files.delete(key); },
    on(event, fn) { if (event === 'change') listeners.push(fn); },
    async close() {},
  };
}

// ---------- fake modules ----------

/** Words with boxes for every token of the text, one line per row. scale 1 = 0..1 coordinates, else pixels. */
function wordsOf(text, page, scale = 1) {
  const words = [];
  text.split('\n').forEach((line, row) => {
    let x = 0.05;
    for (const token of line.split(/\s+/).filter(Boolean)) {
      const width = 0.012 * token.length;
      words.push({ text: token, page, x0: x * scale, y0: (0.05 + row * 0.04) * scale, x1: (x + width) * scale, y1: (0.08 + row * 0.04) * scale });
      x += width + 0.01;
    }
  });
  return words;
}

const fakeIngest = {
  sha256: (bytes) => sha(bytes),
  detectMime: (name) => (name.endsWith('.eml') ? 'message/rfc822' : name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
  kindForMime: (mime) => (mime === 'message/rfc822' ? 'email' : mime === 'application/pdf' ? 'pdf' : 'other'),
  async pdfInfo(bytes) {
    const text = dec(bytes);
    if (text.startsWith('LOCKED')) return { pages: 0, hasTextLayer: false, text: '', pageTexts: [], words: [], pageSizes: [], error: 'This PDF is locked with a password.' };
    if (text.startsWith('SCANNED')) return { pages: 2, hasTextLayer: false, text: '', pageTexts: [], words: [], pageSizes: [] };
    return { pages: 1, hasTextLayer: true, text, pageTexts: [text], words: wordsOf(text, 1), pageSizes: [{ w: 595, h: 842 }] };
  },
  async ingestFile({ name, bytes, source }) {
    const item = (itemName, data, extra = {}) => ({
      name: itemName, bytes: data, sha256: sha(data), source, mime: 'application/pdf', kind: 'pdf', ...extra,
    });
    if (name.endsWith('.zip')) return { items: await unzipChat(name, bytes, source) };
    if (name.endsWith('.eml')) {
      const text = dec(bytes);
      const email = { from: (text.match(/^From: (.*)$/m) || [])[1], subject: (text.match(/^Subject: (.*)$/m) || [])[1], text, to: [], cc: [], date: null };
      return { items: [item(name, bytes, { mime: 'message/rfc822', kind: 'email', email, text })] };
    }
    if (name.endsWith('.png')) return { items: [item(name, bytes, { mime: 'image/png', kind: 'image' })] };
    if (name.endsWith('.heic')) return { items: [item(name, bytes, { mime: 'image/heic', kind: 'image' })] };
    if (name.endsWith('.msg')) return { items: [item(name, bytes, { mime: 'application/vnd.ms-outlook', kind: 'other' })] };
    if (name.endsWith('.broken')) return { items: [item(name, bytes, { mime: 'application/zip', kind: 'other', error: 'Could not open this file: bad zip' })] };
    return { items: [item(name, bytes)] };
  },
};

// Like the real ingest: the chat item first, then each attachment, whose parent is the zip.
async function unzipChat(zipName, bytes, source) {
  const zip = await JSZip.loadAsync(bytes);
  const chatText = await zip.file('_chat.txt').async('string');
  const messages = chatText.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^\[(.+?)\] (.+?): (.*)$/);
    return { at: m[1], author: m[2], text: m[3] };
  });
  const chatSource = { ...source, kind: 'whatsapp', ref: 'SAMPLE chat' };
  const chatBytes = enc(chatText);
  const items = [{ name: '_chat.txt', mime: 'text/plain', kind: 'chat', bytes: chatBytes, sha256: sha(chatBytes), source: chatSource, parent: zipName, chat: { title: 'SAMPLE chat', messages }, text: chatText }];
  for (const entry of Object.values(zip.files)) {
    if (entry.name === '_chat.txt' || entry.dir) continue;
    const data = await entry.async('uint8array');
    items.push({ name: entry.name, mime: 'application/pdf', kind: 'pdf', bytes: data, sha256: sha(data), source: { ...chatSource, chatAuthor: messages[0].author }, parent: zipName });
  }
  return items;
}

function fakeOcr() {
  const pages = {
    'PAGE-1': 'SAMPLE SHIPPING BILL\nInvoice No: INV-100\nShipping Bill No: 7955006',
    'PAGE-2': 'Page two of the scan',
    PHOTO: 'SAMPLE PACKING LIST\nInvoice No: INV-100\nPieces: 1',
  };
  const calls = [];
  return {
    calls,
    async ocrImage(bytes) {
      const key = dec(bytes);
      calls.push(key);
      const text = pages[key] || '';
      return { text, words: wordsOf(text, 1, 1000), width: 1000, height: 1000 }; // pixels, like tesseract
    },
    async terminateOcr() {},
  };
}

const FIELD_PATTERNS = [
  [/^Invoice No: (.+)$/m, 'invoice.number'], [/^Exporter: (.+)$/m, 'exporter.name'], [/^Consignee: (.+)$/m, 'consignee.name'],
  [/^Destination: (.+)$/m, 'goods.destinationCountry'], [/^Report No: (.+)$/m, 'lab.reportNumber'], [/^Carat: (.+)$/m, 'lab.carat'],
  [/^Shipping Bill No: (.+)$/m, 'shippingBill.number'], [/^HAWB: (.+)$/m, 'awb.hawb'],
];

function typeFromText(text) {
  if (/COMMERCIAL INVOICE/.test(text)) return 'commercial_invoice';
  if (/GRADING REPORT/.test(text)) return 'lab_report';
  if (/PACKING LIST/.test(text)) return 'packing_list';
  if (/SHIPPING BILL/.test(text)) return 'shipping_bill';
  if (/AIR WAYBILL/.test(text)) return 'air_waybill';
  return 'other';
}

function fakeAI() {
  const calls = { classify: 0, extract: 0, readChat: 0, readEmail: 0, route: 0, draftPackingList: 0, extractTexts: [] };
  return {
    available: true, mode: 'mock', model: 'fake-model', calls,
    async classify(item, { textHint }) { calls.classify += 1; return { docType: typeFromText(textHint), confidence: 0.9, reason: 'test' }; },
    async extract(item, docType, { textHint, pageImages }) {
      calls.extract += 1;
      calls.extractTexts.push({ name: item.name, pageImages: pageImages ? pageImages.length : 0, firstImage: pageImages?.[0] || null });
      if (/FAIL/.test(textHint)) throw new Error('The model could not read this page');
      const fields = FIELD_PATTERNS.map(([re, key]) => {
        const m = textHint.match(re);
        return m ? { key, value: m[1].trim(), quote: m[1].trim(), page: 1, confidence: 0.9 } : null;
      }).filter(Boolean);
      return { docType, summary: `SAMPLE ${docType}`, fields, lines: [], declarations: [] };
    },
    async readChat(chat) {
      calls.readChat += 1;
      return {
        relevant: chat.messages.map((m) => ({ at: m.at, author: m.author, text: m.text, why: 'mentions the parcel' })),
        requests: [{ text: 'Please send the packing list for INV-100', ref: 'INV-100' }],
        packing: [], refs: ['INV-100'],
      };
    },
    async readEmail() { calls.readEmail += 1; return { relevant: [], requests: [], refs: ['INV-100'] }; },
    async route(text) {
      calls.route += 1;
      const t = text.toLowerCase();
      const ref = (text.match(/INV-\d+/) || [])[0] || null;
      if (t.includes('missing')) return { intent: 'whats_missing', shipmentRef: ref, kinds: [], reply: '' };
      if (t.includes('packing')) return { intent: 'build_packing_list', shipmentRef: ref, kinds: [], reply: '' };
      if (t.includes('prepare')) return { intent: 'prepare_papers', shipmentRef: ref, kinds: [], reply: '' };
      if (t.includes('status')) return { intent: 'status', shipmentRef: ref, kinds: [], reply: '' };
      return { intent: 'other', shipmentRef: null, kinds: [], reply: 'Hello from the agents.' };
    },
    async draftPackingList({ shipment, chatLines }) {
      calls.draftPackingList += 1;
      return {
        lines: [{ lineNo: 1, description: 'Round brilliant', reportNumber: '2141438172', lab: 'GIA', carat: 1.01, pieces: 1, quote: chatLines[0]?.text || null }],
        sources: [{ kind: 'chat', ref: shipment.ref, quote: chatLines[0]?.text || '' }], notes: 'SAMPLE draft',
      };
    },
    usage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }),
  };
}

const field = (doc, key) => (doc.fields || []).find((f) => f.key === key)?.value || null;

const fakeRecords = {
  locate(words, quote) {
    const first = String(quote).split(/\s+/)[0].toLowerCase();
    const hit = words.find((w) => w.text.toLowerCase() === first);
    return hit ? { page: hit.page, box: [hit.x0, hit.y0, hit.x1, hit.y1] } : null;
  },
  groupShipments({ documents, shipments }) {
    const byRef = new Map();
    const assignments = {};
    for (const doc of documents) {
      const owner = shipments.find((s) => s.id === doc.shipmentId);
      const ref = field(doc, 'invoice.number') || (doc.refs || [])[0] || owner?.ref;
      if (!ref) continue;
      if (!byRef.has(ref)) {
        const old = shipments.find((s) => s.ref === ref);
        byRef.set(ref, { ...(old || {}), id: old?.id || `shp_${ref.replace(/\W/g, '')}`, ref, invoiceNumber: ref, direction: 'export', exporter: { name: null }, consignee: { name: null }, destinationCountry: null, documentIds: [], status: old?.status || 'collecting' });
      }
      const shipment = byRef.get(ref);
      shipment.documentIds.push(doc.id);
      assignments[doc.id] = shipment.id;
      for (const role of ['exporter', 'consignee']) if (field(doc, `${role}.name`)) shipment[role] = { name: field(doc, `${role}.name`), country: null };
      if (field(doc, 'goods.destinationCountry')) shipment.destinationCountry = field(doc, 'goods.destinationCountry');
    }
    return { shipments: [...byRef.values()], assignments, merged: [] };
  },
  matchStones({ shipment, documents }) {
    const own = documents.filter((d) => (shipment.documentIds || []).includes(d.id));
    const stones = own.filter((d) => d.docType === 'lab_report').map((d) => ({
      ref: field(d, 'lab.reportNumber'), reportNumber: field(d, 'lab.reportNumber'), lab: 'GIA', carat: Number(field(d, 'lab.carat')),
      growth: 'natural', sources: [{ docId: d.id, kind: 'lab_report' }],
    }));
    return { stones, issues: [] };
  },
  withoutReplacedDrafts(docs) {
    const hasOwn = docs.some((d) => d.docType === 'packing_list' && d.source?.kind !== 'generated');
    return docs.filter((d) => !(hasOwn && d.docType === 'packing_list' && d.source?.kind === 'generated'));
  },
  shipmentDocuments(shipment, docs) {
    return this.withoutReplacedDrafts(docs.filter((d) => (shipment.documentIds || []).includes(d.id) || d.shipmentId === shipment.id));
  },
  buildHistory({ stone, shipment }) {
    return [
      { at: null, kind: 'graded', title: `Graded by ${stone.lab}`, detail: stone.reportNumber, docId: stone.sources[0].docId, field: 'lab.reportNumber' },
      { at: null, kind: 'invoiced', title: 'Invoiced', detail: shipment.ref, docId: null, field: null },
    ];
  },
};

const fakeRules = {
  RULES_VERSION: 'test-rules-1',
  evaluate({ shipment, documents, stones, screenings }) {
    const checks = [{ code: 'stones', severity: stones.length ? 'pass' : 'warn', title: 'Stones traced', detail: `${stones.length} stones`, evidence: [], rule: 'test' }];
    if (screenings.some((s) => s.status === 'match')) checks.push({ code: 'sanctions', severity: 'fail', title: 'A party is on the OFAC SDN list', detail: '', evidence: [], rule: 'test' });
    const questions = [];
    if (documents.some((d) => /ODD/.test(d.text || ''))) questions.push({ kind: 'confirm', check: 'report_format', text: 'Report number ODD-1 does not look like a GIA number. Check it.' });
    for (const s of screenings.filter((x) => x.status === 'review')) {
      checks.push({ code: 'sanctions', severity: 'warn', title: 'Possible OFAC SDN match', detail: s.name, evidence: [], rule: 'test' });
      questions.push({ kind: 'confirm', check: 'sanctions', text: `Possible OFAC SDN match: ${s.name} looks like ${s.best.sdnName}. Confirm they are different before signing.`, options: ['Different', 'Same'] });
    }
    if (!shipment.destinationCountry) questions.push({ kind: 'missing_field', key: 'goods.destinationCountry', text: 'Which country is the parcel going to?' });
    if (!documents.some((d) => d.docType === 'kp_certificate')) {
      questions.push({ kind: 'missing_document', key: 'kp_certificate', docType: 'kp_certificate', text: 'The KP certificate is not on file. Add it, or say it is not needed.' });
    }
    return {
      checks, questions, status: questions.length ? 'questions' : 'ready_to_sign',
      required: [{ kind: 'eu_dds', reason: 'Polished natural diamonds to the EU', signer: 'importer', regime: 'EU' }],
      summary: { passed: checks.filter((c) => c.severity === 'pass').length, total: checks.length },
    };
  },
};

function fakeSanctions() {
  const calls = [];
  return {
    calls,
    screen(name) {
      calls.push(name);
      const hit = /BLOCKED/i.test(name);
      if (/CLOSE/.test(name)) return { name, status: 'review', best: { sdnName: 'CLOSE TRADING', uid: '2', programs: ['SDGT'], score: 0.9 }, compared: 41 };
      return { name, status: hit ? 'match' : 'clear', best: hit ? { sdnName: 'BLOCKED TRADING', uid: '1', programs: ['SDGT'], score: 0.99 } : null, compared: 41 };
    },
  };
}

const ABBR = { export_pack: 'EXP', import_pack: 'IMP', eu_dds: 'DDS', us_cbp_certificate: 'CBP', g7_gf_declaration: 'G7', packing_list_draft: 'PKL' };
const fakePapers = {
  nextRef(kind, date, refs) {
    let n = 1;
    while (refs.includes(`JL-${ABBR[kind]}-1115-0${n}`)) n += 1;
    return `JL-${ABBR[kind]}-1115-0${n}`;
  },
  async buildPack({ ref, version, status, documents, getFile }) {
    await getFile(documents[0].fileKey); // the pack reads the originals
    return { bytes: enc(`PACK ${ref} v${version} ${status}`), pages: 3, contents: documents.map((d) => ({ title: d.fileName, docId: d.id })) };
  },
  async buildStatement({ kind, ref, version, status, documents }) { return { bytes: enc(`STATEMENT ${kind} ${ref} v${version} ${status} docs=${documents.length}`) }; },
  async buildPackingListDraft({ shipment, lines }) { const bytes = enc(`PACKING LIST DRAFT ${shipment.ref} ${lines.length}`); return { bytes, sha256: sha(bytes) }; },
  async signPdf(bytes, { name }) { const out = enc(`${dec(bytes)} SIGNED BY ${name}`); return { bytes: out, sha256: sha(out) }; },
};

function fakeMail(messages = []) {
  const sent = [];
  const connects = [];
  const fetches = [];
  return {
    sent, connects, fetches,
    connectMailbox(config) {
      connects.push(config);
      return {
        async test() { if (config.appPassword === WRONG_PASS) throw new Error('The mailbox did not accept this email and app password.'); return { ok: true }; },
        async fetchSince(date, options) { fetches.push({ date, options }); return messages; },
        async close() {},
      };
    },
    async sendMail(options) { sent.push(options); return { messageId: `<sent-${sent.length}@house.example>` }; },
  };
}

const fakeMetrics = { lastInput: null, computeMetrics(input) { fakeMetrics.lastInput = input; return { houses: [], totals: { events: input.workspaces[0].events.length } }; } };

// ---------- harness ----------

async function makeHarness({ profile = {}, lease, mailMessages = [], samplesDir, cacheDir, store: givenStore, parallel, rasterize, pageDrawTimeoutMs } = {}) {
  const { store, cleanup } = givenStore ? { store: givenStore, cleanup: async () => {} } : await makeStore({ name: 'SAMPLE Gems Exports', environment: 'sandbox', ...profile });
  const clock = { now: Date.UTC(2026, 10, 15, 9, 0, 0) };
  const h = {
    store, clock, ai: fakeAI(), ocr: fakeOcr(), sanctions: fakeSanctions(), mail: fakeMail(mailMessages),
    notes: [], agent: [], activity: [], rasterized: [], listDate: '2026-11-02',
  };
  h.services = createServices({
    store, ai: h.ai, ocr: h.ocr,
    rasterize: rasterize || (async (bytes, page) => { h.rasterized.push(page); return enc(`PAGE-${page}`); }),
    sanctionsLoader: async () => ({ count: 17589, date: h.listDate, source: 'test', entries: [] }),
    notify: async (note) => { h.notes.push(note); },
    paths: { samplesDir, cacheDir }, deviceId: 'test-device', clock: () => clock.now, lease, pace: 0, parallel, pageDrawTimeoutMs,
    modules: { ingest: fakeIngest, records: fakeRecords, rules: fakeRules, sanctions: h.sanctions, papers: fakePapers, mail: h.mail, metrics: fakeMetrics },
  });
  h.services.events.on('agent', (e) => h.agent.push(e));
  h.services.events.on('activity', (e) => h.activity.push(e));
  h.cleanup = async () => { h.services.worker.stop(); await h.services.idle(); await cleanup(); };
  return h;
}

const INVOICE = 'SAMPLE COMMERCIAL INVOICE\nInvoice No: INV-100\nExporter: SAMPLE Gems Exports\nConsignee: SAMPLE Diamant BV';
const REPORT = 'SAMPLE GRADING REPORT\nInvoice No: INV-100\nReport No: 2141438172\nCarat: 1.01';

async function chatZip() {
  const zip = new JSZip();
  zip.file('_chat.txt', '[11/12/26, 10:00:00 AM] Ravi: Parcel INV-100 leaves Friday, one stone 1.01 ct\n[11/12/26, 10:01:00 AM] Ravi: AWB attached\n');
  zip.file('awb.pdf', 'SAMPLE AIR WAYBILL\nInvoice No: INV-100\nHAWB: 176-12345675');
  return zip.generateAsync({ type: 'uint8array' });
}

async function baseFiles() {
  return [
    { name: 'invoice.pdf', bytes: enc(INVOICE), by: CLERK },
    { name: 'report.pdf', bytes: enc(REPORT) },
    { name: 'scan.pdf', bytes: enc('SCANNED') },
    { name: 'photo.png', bytes: enc('PHOTO') },
    { name: 'WhatsApp Chat - SAMPLE.zip', bytes: await chatZip(), source: { kind: 'whatsapp' } },
  ];
}

/** Drops the base papers and waits until the agents are done. Returns the one shipment. */
async function withShipment(h) {
  await h.services.addFiles(await baseFiles());
  await h.services.idle();
  const [shipment] = await h.store.list('shipments');
  return shipment;
}

async function openQuestions(h) {
  return h.store.list('questions', (q) => q.status === 'open');
}

/** Answers both base questions: the KP certificate is not needed, the parcel goes to Belgium. */
async function answerAll(h, by = CLERK) {
  for (const q of await openQuestions(h)) {
    await h.services.answerQuestion(q.id, q.kind === 'missing_document' ? 'not needed' : 'BE', by);
  }
  await h.services.idle();
}

// ---------- tests ----------

test('files in: every paper is read, grouped, screened, checked, and questions are asked', async () => {
  const h = await makeHarness();
  try {
    const result = await h.services.addFiles(await baseFiles());
    assert.equal(result.documentIds.length, 6); // 4 files + chat + its attachment
    assert.deepEqual(result.duplicates, []);
    await h.services.idle();

    const docs = await h.store.list('documents');
    assert.ok(docs.every((d) => d.status === 'read'), 'every document is read');
    const byName = Object.fromEntries(docs.map((d) => [d.fileName, d]));
    assert.equal(byName['invoice.pdf'].docType, 'commercial_invoice');
    assert.equal(byName['invoice.pdf'].readBy, 'fake-model');
    assert.match(byName['invoice.pdf'].fileKey, /^docs\/doc_[0-9a-z]+\/invoice\.pdf$/);
    const invoiceNo = byName['invoice.pdf'].fields.find((f) => f.key === 'invoice.number');
    assert.equal(invoiceNo.value, 'INV-100');
    assert.equal(invoiceNo.page, 1);
    assert.equal(invoiceNo.box.length, 4, 'the field has its spot on the page');

    // A scan is drawn page by page, read with OCR, and the page images go to the vision model.
    assert.deepEqual(h.rasterized, [1, 2]);
    assert.equal(byName['scan.pdf'].docType, 'shipping_bill');
    assert.equal(byName['scan.pdf'].ocrUsed, true);
    const scanCall = h.ai.calls.extractTexts.find((c) => c.name === 'scan.pdf');
    assert.equal(scanCall.pageImages, 2);
    assert.equal(scanCall.firstImage, `data:image/png;base64,${Buffer.from('PAGE-1').toString('base64')}`, 'pages go to the model as data URLs');
    const sb = byName['scan.pdf'].fields.find((f) => f.key === 'shippingBill.number');
    assert.ok(sb.box.every((n) => n >= 0 && n <= 1), 'OCR pixels are turned into 0..1 boxes');
    assert.equal(byName['photo.png'].docType, 'packing_list');
    assert.equal(byName['photo.png'].ocrUsed, true);

    // The chat is read by readChat; its attachment points at the chat and keeps who sent it.
    const chat = byName['_chat.txt'];
    assert.equal(chat.docType, 'whatsapp_chat');
    assert.equal(chat.insights.relevant.length, 2);
    assert.deepEqual(chat.refs, ['INV-100']);
    assert.equal(byName['awb.pdf'].parentId, chat.id);
    assert.equal(byName['awb.pdf'].source.kind, 'whatsapp');
    assert.equal(byName['awb.pdf'].source.chatAuthor, 'Ravi');
    const requests = await h.store.list('messages', (m) => m.kind === 'request');
    assert.equal(requests[0].text, 'Please send the packing list for INV-100');
    assert.deepEqual(requests[0].from, { type: 'person', name: 'House', role: 'house' });
    assert.equal(requests[0].to, 'desk');

    // Live events: a field event per value, with its box and label.
    const fieldEvents = h.agent.filter((e) => e.action === 'field' && e.docId === byName['invoice.pdf'].id);
    assert.ok(fieldEvents.some((e) => e.key === 'invoice.number' && e.label === 'Invoice number' && e.value === 'INV-100' && e.box));
    const readIndex = h.agent.findIndex((e) => e.action === 'read' && e.agent === 'intake' && e.docId === byName['invoice.pdf'].id);
    assert.ok(readIndex >= 0 && readIndex < h.agent.indexOf(fieldEvents[0]), 'the page shows before its fields');

    // Records: one shipment with every paper, the stone traced with its history.
    const shipments = await h.store.list('shipments');
    assert.equal(shipments.length, 1);
    const shipment = shipments[0];
    assert.equal(shipment.ref, 'INV-100');
    assert.equal(shipment.documentIds.length, 6);
    assert.ok(docs.every((d) => d.shipmentId === shipment.id), 'every paper is under the shipment');
    const stones = await h.store.list('stones');
    assert.equal(stones.length, 1);
    assert.equal(stones[0].reportNumber, '2141438172');
    assert.equal(stones[0].history.length, 2);

    // Sanctions: both parties screened and stored with the list date and the compared count.
    const parties = await h.store.list('parties');
    assert.deepEqual(parties.map((p) => p.name).sort(), ['SAMPLE Diamant BV', 'SAMPLE Gems Exports']);
    assert.ok(parties.every((p) => p.status === 'clear' && p.compared === 41 && p.listDate === '2026-11-02'));
    assert.ok(h.agent.some((e) => e.agent === 'sanctions' && /no match on the OFAC SDN list \(41 similar names compared\)/.test(e.message)));

    // Origin + Review: checks stored, two questions asked once, the house notified.
    const checks = await h.store.list('checks');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].shipmentId, shipment.id);
    const questions = await openQuestions(h);
    assert.equal(questions.length, 2);
    assert.equal(shipment.status, 'questions');
    assert.equal(shipment.rulesVersion, 'test-rules-1');
    assert.ok(h.notes.some((n) => n.kind === 'questions' && n.shipmentId === shipment.id));
    assert.equal(await h.store.list('papers').then((p) => p.length), 0, 'no papers while questions are open');

    // Audit trail and usage.
    const actions = new Set(h.activity.map((a) => a.action));
    for (const action of ['received', 'read', 'matched', 'screened', 'checked', 'asked']) assert.ok(actions.has(action), `activity has ${action}`);
    assert.ok(h.activity.every((a) => a.actor && a.actor.type && a.actor.name && a.at));
    const uploads = (await h.store.list('events')).filter((e) => e.type === 'upload');
    assert.equal(uploads.length, 6);
    assert.equal(uploads.find((e) => e.docId === byName['invoice.pdf'].id).userId, 'user-1');
    assert.equal((await h.store.list('events')).filter((e) => e.type === 'question_asked').length, 2);

    // A second run with nothing new asks nothing twice.
    await h.services.run({ shipmentId: shipment.id, reason: 'again' });
    assert.equal((await h.store.list('questions')).length, 2);
  } finally {
    await h.cleanup();
  }
});

test('a file already on file is skipped and logged', async () => {
  const h = await makeHarness();
  try {
    await withShipment(h);
    const extractsBefore = h.ai.calls.extract;
    const again = await h.services.addFiles([{ name: 'invoice copy.pdf', bytes: enc(INVOICE) }]);
    await h.services.idle();
    assert.deepEqual(again.documentIds, []);
    assert.equal(again.duplicates.length, 1);
    assert.equal(again.duplicates[0].name, 'invoice copy.pdf');
    assert.ok(h.activity.some((a) => a.action === 'skipped' && a.detail === 'invoice copy.pdf is already on file'));
    assert.equal(h.ai.calls.extract, extractsBefore, 'nothing is read twice');
    assert.equal((await h.store.list('documents')).length, 6);
  } finally {
    await h.cleanup();
  }
});

test('a file ingest could not open becomes a failed document that is not retried', async () => {
  const h = await makeHarness();
  try {
    const result = await h.services.addFiles([{ name: 'parcel.broken', bytes: enc('nope') }]);
    await h.services.idle();
    const doc = await h.store.get('documents', result.documentIds[0]);
    assert.equal(doc.status, 'error');
    assert.match(doc.error, /bad zip/);
    await h.services.worker.tick();
    assert.equal((await h.store.get('documents', doc.id)).status, 'error');
  } finally {
    await h.cleanup();
  }
});

test('answering the questions re-runs the checks and autopilot builds the papers', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    const questions = await openQuestions(h);
    const kpQuestion = questions.find((q) => q.kind === 'missing_document');
    const destQuestion = questions.find((q) => q.kind === 'missing_field');

    const first = await h.services.answerQuestion(kpQuestion.id, 'Not needed', CLERK);
    assert.equal(first.question.status, 'answered');
    assert.equal(first.question.answer, 'Not needed');
    assert.equal(first.status, 'questions', 'the destination is still open');
    assert.deepEqual((await h.store.get('shipments', shipment.id)).notNeeded, ['kp_certificate']);
    await assert.rejects(h.services.answerQuestion(kpQuestion.id, 'again', CLERK), /already closed/);

    const second = await h.services.answerQuestion(destQuestion.id, 'BE', CLERK);
    assert.equal(second.question.status, 'answered', 'saved at once; the check runs in the background');
    await h.services.idle();
    const after = await h.store.get('shipments', shipment.id);
    assert.equal(after.status, 'ready_to_sign');
    assert.equal(after.destinationCountry, 'BE', 'the answer is set on the shipment');
    assert.equal(after.answers['goods.destinationCountry'], 'BE');
    assert.equal(after.houseEdits, 2);
    assert.equal((await openQuestions(h)).length, 0, 'the KP question is not asked again');

    const papers = await h.store.list('papers');
    assert.deepEqual(papers.map((p) => p.kind).sort(), ['eu_dds', 'export_pack']);
    const pack = papers.find((p) => p.kind === 'export_pack');
    assert.equal(pack.ref, 'JL-EXP-1115-01');
    assert.equal(pack.version, 1);
    assert.equal(pack.status, 'ready_to_sign');
    assert.equal(pack.fileKey, `papers/${pack.id}/JL-EXP-1115-01-v1.pdf`);
    assert.equal(dec(await h.store.getFile(pack.fileKey)), 'PACK JL-EXP-1115-01 v1 ready_to_sign');
    assert.equal(pack.sha256, sha(enc('PACK JL-EXP-1115-01 v1 ready_to_sign')));
    const dds = papers.find((p) => p.kind === 'eu_dds');
    assert.equal(dec(await h.store.getFile(dds.fileKey)), `STATEMENT eu_dds ${dds.ref} v1 ready_to_sign docs=${pack.contents.length}`,
      'the statement on its own prints its own ref and lists the same papers as the pack');
    assert.equal(pack.houseEdits, 2);
    assert.equal(pack.builtBy, 'Paperwork');
    assert.ok(h.notes.some((n) => n.kind === 'pack_ready' && n.shipmentId === shipment.id));
    const events = await h.store.list('events');
    assert.equal(events.filter((e) => e.type === 'question_answered').length, 2);
    assert.equal(events.filter((e) => e.type === 'house_edit' && e.userId === 'user-1').length, 2);

    // Nothing changed: another run does not build a second version.
    await h.services.run({});
    await h.services.idle();
    assert.equal((await h.store.get('papers', pack.id)).version, 1);
  } finally {
    await h.cleanup();
  }
});

test('a rebuild adds a version; then sign, send without a mailbox, and send from the mailbox', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    await answerAll(h);
    const v2 = await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK });
    assert.equal(v2.papers.length, 1);
    const pack = v2.papers[0];
    assert.equal(pack.version, 2);
    assert.equal(pack.fileKey, `papers/${pack.id}/JL-EXP-1115-01-v2.pdf`);
    assert.equal(pack.versions.length, 2);
    assert.equal(dec(await h.store.getFile(pack.versions[0].fileKey)), 'PACK JL-EXP-1115-01 v1 ready_to_sign', 'the old version is kept');
    assert.equal(pack.builtBy, CLERK.name);

    const signed = await h.services.signPaper(pack.id, { name: 'Asha Mehta', title: 'Director' }, CLERK);
    assert.equal(signed.status, 'signed');
    assert.equal(signed.signedBy, 'Asha Mehta');
    assert.equal(signed.fileKey, `papers/${pack.id}/JL-EXP-1115-01-v2-signed.pdf`);
    assert.equal(signed.sha256, sha(await h.store.getFile(signed.fileKey)));
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'signed');
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /already signed/);

    const unsent = await h.services.sendPaper(pack.id, { to: 'broker@broker.example' }, CLERK);
    assert.equal(unsent.download, true);
    assert.match(unsent.error, /No mailbox is connected/);

    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: `${PASS} x`, domains: 'broker.example', pollNow: false, by: CLERK });
    assert.equal(h.mail.connects[0].appPassword, `${PASS}x`, 'spaces are taken out of the app password');
    const sent = await h.services.sendPaper(pack.id, { to: 'broker@broker.example, desk@broker.example', subject: 'Pack', body: 'Signed pack attached.' }, CLERK);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.sentTo, 'broker@broker.example, desk@broker.example');
    assert.equal(h.mail.sent[0].email, 'clerk@house.example');
    assert.deepEqual(h.mail.sent[0].to, ['broker@broker.example', 'desk@broker.example']);
    assert.equal(h.mail.sent[0].attachments[0].filename, 'JL-EXP-1115-01-v2.pdf');
    assert.match(dec(h.mail.sent[0].attachments[0].content), /SIGNED BY Asha Mehta/);
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'sent');

    const types = (await h.store.list('events')).map((e) => e.type);
    assert.ok(types.includes('pack_signed') && types.includes('pack_sent'));
    assert.ok(h.activity.some((a) => a.action === 'sent' && a.actor.type === 'person' && /from clerk@house\.example/.test(a.detail)));
    // A signed shipment is left alone by later runs, and the agents never write over a sent paper.
    await h.services.run({});
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'sent');
    const byAgent = await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: { type: 'agent', name: 'Paperwork' } });
    assert.deepEqual(byAgent.papers, []);
    assert.equal((await h.store.get('papers', pack.id)).status, 'sent');

    // A person may rebuild it on purpose: v3 needs signing again, and v2 keeps its signature in the history.
    const v3 = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers[0];
    assert.equal(v3.version, 3);
    assert.equal(v3.status, 'ready_to_sign');
    const v2entry = v3.versions.find((v) => v.version === 2);
    assert.equal(v2entry.status, 'sent');
    assert.equal(v2entry.signedBy, 'Asha Mehta');
    assert.equal(v2entry.fileKey, signed.fileKey);
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'ready_to_sign');
  } finally {
    await h.cleanup();
  }
});

test('desk review: packs are held; hold and approve post messages; only content changes are desk edits', async () => {
  const h = await makeHarness({ profile: { deskReview: true } });
  try {
    const shipment = await withShipment(h);
    await answerAll(h);
    const pack = (await h.store.list('papers')).find((p) => p.kind === 'export_pack');
    assert.equal(pack.status, 'held_for_review');
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'held_for_review');
    assert.ok(h.notes.some((n) => n.kind === 'pack_held'));

    const queue = await h.services.desk.queue();
    assert.deepEqual(queue.map((item) => item.paper.kind).sort(), ['eu_dds', 'export_pack']);
    assert.equal(queue[0].shipment.id, shipment.id);
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /held for review/);

    const held = await h.services.desk.hold(pack.id, 'Please add the KP certificate number.', DESK);
    assert.equal(held.status, 'held_for_review');
    assert.equal(held.deskNote, 'Please add the KP certificate number.');
    assert.ok(h.notes.some((n) => n.kind === 'desk_message' && n.body === 'Please add the KP certificate number.'));

    const approved = await h.services.desk.approve(pack.id, 'Checked. Ready for your signature.', DESK);
    assert.equal(approved.status, 'ready_to_sign');
    assert.equal(approved.approvedBy, DESK.name);
    const deskMessages = await h.store.list('messages', (m) => m.kind === 'desk');
    assert.deepEqual(deskMessages.map((m) => m.text), ['Please add the KP certificate number.', 'Checked. Ready for your signature.']);
    assert.deepEqual(deskMessages[0].from, { type: 'person', name: DESK.name, role: 'desk' });
    assert.equal(deskMessages[0].to, 'house');
    assert.equal((await h.store.list('events')).filter((e) => e.type === 'desk_edit').length, 0, 'approve and hold alone are not edits');
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'held_for_review', 'the EU statement still waits for the desk');

    const dds = queue.find((item) => item.paper.kind === 'eu_dds').paper;
    await h.services.desk.approve(dds.id, '', DESK);
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'ready_to_sign');

    // A desk change to the content is an edit and makes a new version.
    const edited = await h.services.desk.approve(pack.id, 'Fixed the destination.', DESK, { fields: { 'goods.destinationCountry': 'DE' } });
    assert.equal(edited.version, 2);
    assert.equal(edited.status, 'ready_to_sign');
    const after = await h.store.get('shipments', shipment.id);
    assert.equal(after.destinationCountry, 'DE');
    assert.equal(after.deskEdits, 1);
    const deskEdits = (await h.store.list('events')).filter((e) => e.type === 'desk_edit');
    assert.equal(deskEdits.length, 1);
    assert.equal(deskEdits[0].userId, 'desk-1');
    const signed = await h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK);
    assert.equal(signed.status, 'signed');
  } finally {
    await h.cleanup();
  }
});

test('a sanctions match holds the pack for a person', async () => {
  const h = await makeHarness();
  try {
    await h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(INVOICE.replace('SAMPLE Diamant BV', 'BLOCKED Trading LLC')) }, { name: 'report.pdf', bytes: enc(REPORT) }]);
    await h.services.idle();
    await answerAll(h);
    const party = (await h.store.list('parties')).find((p) => p.name === 'BLOCKED Trading LLC');
    assert.equal(party.status, 'match');
    assert.ok(h.agent.some((e) => e.agent === 'sanctions' && /matches BLOCKED TRADING/.test(e.message)));
    const [shipment] = await h.store.list('shipments');
    assert.equal(shipment.status, 'held_for_review');
    assert.ok((await h.store.list('papers')).every((p) => p.status === 'held_for_review'));
  } finally {
    await h.cleanup();
  }
});

test('autopilot off: files wait, a manual run reads them, and papers wait for a person', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    assert.equal(await h.services.autopilot.get(), false);
    await h.services.addFiles(await baseFiles());
    await h.services.idle();
    assert.ok((await h.store.list('documents')).every((d) => d.status === 'new'), 'nothing runs on its own');

    // Three runs asked at once become one pass plus one merged follow-up: nothing is read twice.
    await Promise.all([h.services.run({ reason: 'a' }), h.services.run({ reason: 'b' }), h.services.run({ reason: 'c' })]);
    assert.equal(h.ai.calls.extract, 5);
    await answerAll(h);
    const [shipment] = await h.store.list('shipments');
    assert.equal(shipment.status, 'ready_to_sign');
    assert.equal((await h.store.list('papers')).length, 0);
    assert.ok(h.agent.some((e) => e.agent === 'review' && /Autopilot is off/.test(e.message)));

    const answer = await h.services.ask('Prepare the papers for INV-100', { by: CLERK });
    assert.deepEqual(answer.steps, ['Sending your request', 'Matching your documents', 'Sanctions check', 'Checking the documents', 'Writing the EU statement', 'Building the export paper']);
    assert.match(answer.reply, /JL-EXP-1115-01 v1: ready to sign\.$/);
    assert.equal(answer.actions.length, 2);
    assert.equal((await h.store.list('papers')).length, 2);

    // Asking again reuses the papers instead of building a second version.
    const again = await h.services.ask('Prepare the papers for INV-100', { by: CLERK });
    assert.ok(again.steps.includes('The papers were already up to date'));
    assert.ok((await h.store.list('papers')).every((p) => p.version === 1));

    await h.services.autopilot.set(true, CLERK);
    assert.equal(await h.services.autopilot.get(), true);
    assert.ok(h.activity.some((a) => a.action === 'autopilot' && a.actor.name === CLERK.name));
  } finally {
    await h.cleanup();
  }
});

test('lease: while another computer holds it nothing is read; then this one takes over and releases it', async () => {
  const lease = {
    allow: false, acquired: [], released: [],
    async acquire(workspaceId, holder, ttl) { this.acquired.push({ workspaceId, holder, ttl }); return this.allow; },
    async release(workspaceId, holder) { this.released.push({ workspaceId, holder }); },
  };
  const h = await makeHarness({ lease });
  try {
    await h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(INVOICE) }]);
    await h.services.idle();
    const blocked = await h.services.run({ reason: 'try again' });
    assert.deepEqual(blocked, { skipped: 'lease', reason: 'held' });
    assert.ok((await h.store.list('documents')).every((d) => d.status === 'new'));
    assert.equal(h.activity.filter((a) => a.action === 'waiting').length, 1, 'logged once, not on every try');
    assert.equal(lease.acquired[0].holder, 'test-device');
    assert.equal(lease.acquired[0].ttl, 180);

    lease.allow = true;
    const done = await h.services.run({ reason: 'lease free' });
    assert.equal(done.read, 1);
    assert.equal((await h.store.list('documents'))[0].status, 'read');
    const workspace = await h.store.workspace();
    assert.deepEqual(lease.released.at(-1), { workspaceId: workspace.id, holder: 'test-device' });
  } finally {
    await h.cleanup();
  }
});

test('ask: what is missing, status, a packing list from the chat, and anything else', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    const missing = await h.services.ask('What is still missing?', { by: CLERK });
    assert.equal(missing.intent, 'whats_missing');
    assert.deepEqual(missing.steps, ['Sending your request', 'Checking the documents']);
    assert.match(missing.reply, /^INV-100: 1 paper missing: Kimberley Process certificate\. 1 question open: Which country is the parcel going to\?$/);
    assert.equal(missing.actions.length, 2);

    const prepare = await h.services.ask('Prepare the papers for my latest shipment', { by: CLERK });
    assert.match(prepare.reply, /has 2 open questions first/);

    const status = await h.services.ask('What is the status of INV-100?', { by: CLERK });
    assert.equal(status.reply, 'INV-100: Questions open. 1 of 1 checks consistent. 2 questions open.');

    const unknown = await h.services.ask('Prepare the papers for INV-999', { by: CLERK });
    assert.match(unknown.reply, /No shipment matches INV-999/);

    const packing = await h.services.ask('Make the packing list from the chat', { shipmentId: shipment.id, by: CLERK });
    assert.equal(packing.intent, 'build_packing_list');
    assert.deepEqual(packing.steps, ['Sending your request', 'Reading the chat and emails', 'Drafting the packing list', 'Matching your documents', 'Checking the documents']);
    const drafted = (await h.store.list('documents')).find((d) => d.source.kind === 'generated');
    assert.equal(drafted.docType, 'packing_list');
    assert.equal(drafted.status, 'read');
    assert.equal(drafted.shipmentId, shipment.id);
    assert.equal(drafted.lines.length, 1);
    const draftPaper = (await h.store.list('papers')).find((p) => p.kind === 'packing_list_draft');
    assert.equal(draftPaper.status, 'draft');
    assert.equal(draftPaper.fileKey, `papers/${draftPaper.id}/JL-PKL-1115-01-v1.pdf`);
    assert.ok((await h.store.get('shipments', shipment.id)).documentIds.includes(drafted.id), 'Records sees the draft');

    const other = await h.services.ask('Hello there');
    assert.equal(other.reply, 'Hello from the agents.');
    await assert.rejects(h.services.ask('   '), /Type a request/);

    const asked = await h.store.list('messages', (m) => m.kind === 'ask');
    const replies = await h.store.list('messages', (m) => m.kind === 'reply');
    assert.equal(asked.length, 6);
    assert.equal(replies.length, 6);
    assert.deepEqual(asked[0].from, { type: 'person', name: CLERK.name, role: 'house' });
    assert.equal(asked[0].to, 'agents');
    assert.deepEqual(replies[0].from, { type: 'agent', name: 'Agents', role: 'agents' });
    assert.equal(replies.find((m) => m.intent === 'build_packing_list').steps.length, 5);
  } finally {
    await h.cleanup();
  }
});

test('sanctions: a name screened in the last 24 hours is not screened again', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    assert.equal(h.sanctions.calls.length, 2);
    await h.services.run({ shipmentId: shipment.id, reason: 'check again' });
    assert.equal(h.sanctions.calls.length, 2, 'same names within 24 hours: no new screen');
    h.clock.now += 25 * 3600 * 1000;
    await h.services.run({ shipmentId: shipment.id, reason: 'a day later' });
    assert.equal(h.sanctions.calls.length, 4);
    const party = (await h.store.list('parties')).find((p) => p.name === 'SAMPLE Gems Exports');
    assert.deepEqual(party.roles, ['exporter']);
    assert.deepEqual(party.shipmentIds, [shipment.id]);
  } finally {
    await h.cleanup();
  }
});

test('the house can turn off OFAC screening and chat reading', async () => {
  const h = await makeHarness({ profile: { permissions: { ofacScreen: false, readWhatsApp: false } } });
  try {
    await withShipment(h);
    assert.equal(h.sanctions.calls.length, 0);
    assert.equal(h.ai.calls.readChat, 0);
    const chat = (await h.store.list('documents')).find((d) => d.kind === 'chat');
    assert.match(chat.summary, /reading chats is off/);
    assert.ok(h.agent.some((e) => e.agent === 'sanctions' && /screening is off/.test(e.message)));
  } finally {
    await h.cleanup();
  }
});

test('worker: mailbox poll, watched folder, retries, start and stop', async () => {
  const eml = enc('From: ops@broker.example\nSubject: INV-100 papers\n\nPlease find the SAMPLE invoice.');
  const messages = [{ uid: 7, messageId: '<m7@broker.example>', from: 'ops@broker.example', subject: 'INV-100 papers', date: '2026-11-15T08:00:00.000Z', eml }];
  const h = await makeHarness({ mailMessages: messages });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-folder-'));
  try {
    await assert.rejects(h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS }), /email domains of your brokers/);
    await assert.rejects(h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'house.example' }), /email domains/, 'the house itself is not a partner');
    await assert.rejects(h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: WRONG_PASS, domains: 'broker.example' }), /did not accept/);
    assert.equal((await h.services.mail.status()).connected, false);

    const status = await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', by: CLERK });
    assert.equal(status.connected, true);
    await h.services.idle(); // the first poll runs right after connecting
    const email = (await h.store.list('documents')).find((d) => d.kind === 'email');
    assert.equal(email.fileName, 'INV-100 papers.eml');
    assert.equal(email.source.kind, 'email');
    assert.equal(email.source.from, 'ops@broker.example');
    assert.equal(email.source.ref, 'INV-100 papers');
    assert.equal(email.status, 'read');
    assert.deepEqual(h.mail.fetches[0].options.domains, ['broker.example']);
    assert.ok(h.mail.fetches[0].date.getTime() < Date.now(), 'a new mailbox looks back a few days');

    await h.services.mail.pollNow(); // the same mail again: skipped quietly by its message id
    assert.equal((await h.store.list('documents', (d) => d.kind === 'email')).length, 1);
    assert.equal(h.activity.filter((a) => a.action === 'skipped').length, 0);
    assert.equal((await h.store.workspace()).mailbox, undefined, 'nothing about the mailbox goes into the shared workspace');
    const mailStatus = await h.services.mail.status();
    assert.equal(mailStatus.email, 'clerk@house.example');
    assert.deepEqual(mailStatus.domains, ['broker.example']);
    assert.equal(mailStatus.lastSeenAt, '2026-11-15T08:00:00.000Z');
    assert.ok(mailStatus.lastPollAt);

    // Watched folder: new files by path, time and size; hidden files and files still copying are skipped.
    const old = new Date(Date.now() - 60 * 1000);
    await fs.writeFile(path.join(folder, 'invoice-200.pdf'), 'SAMPLE COMMERCIAL INVOICE\nInvoice No: INV-200\nExporter: SAMPLE Gems Exports');
    await fs.utimes(path.join(folder, 'invoice-200.pdf'), old, old);
    await fs.writeFile(path.join(folder, '.DS_Store'), 'x');
    await fs.writeFile(path.join(folder, 'still-copying.pdf'), 'SAMPLE');
    await h.services.folder.set(folder, CLERK);
    await h.services.idle();
    let fromFolder = await h.store.list('documents', (d) => d.source.kind === 'folder');
    assert.deepEqual(fromFolder.map((d) => d.source.ref), ['invoice-200.pdf']);
    await h.services.worker.tick();
    assert.equal((await h.store.list('documents', (d) => d.source.kind === 'folder')).length, 1, 'an unchanged file is not taken twice');
    await fs.writeFile(path.join(folder, 'invoice-200.pdf'), 'SAMPLE COMMERCIAL INVOICE\nInvoice No: INV-200\nExporter: SAMPLE Gems Exports Pvt Ltd');
    await fs.utimes(path.join(folder, 'invoice-200.pdf'), new Date(old.getTime() + 1000), new Date(old.getTime() + 1000));
    await h.services.worker.tick();
    await h.services.idle();
    fromFolder = await h.store.list('documents', (d) => d.source.kind === 'folder');
    assert.equal(fromFolder.length, 2, 'a changed file is read again');
    const folderStatus = await h.services.folder.status();
    assert.equal(folderStatus.path, folder);
    assert.equal(folderStatus.watching, true);

    // Retries: a failed document is read again on the next rounds, at most 3 times.
    const bad = await h.services.addFiles([{ name: 'bad.pdf', bytes: enc('SAMPLE COMMERCIAL INVOICE\nFAIL\nInvoice No: INV-300') }]);
    await h.services.idle();
    const badId = bad.documentIds[0];
    assert.equal((await h.store.get('documents', badId)).status, 'error');
    for (let round = 0; round < 4; round += 1) {
      await h.services.worker.tick();
      await h.services.idle();
    }
    const failed = await h.store.get('documents', badId);
    assert.equal(failed.status, 'error');
    assert.equal(failed.retries, 3);
    assert.equal(h.ai.calls.extractTexts.filter((c) => c.name === 'bad.pdf').length, 4, 'first try plus 3 retries');
    assert.match(failed.error, /could not read this page/);

    const workerStatus = await h.services.worker.status();
    assert.ok(workerStatus.lastPollAt);
    assert.equal(workerStatus.counts.error, 1);
    assert.equal(workerStatus.counts.pulledFromMail, 1);
    assert.equal(workerStatus.counts.retried, 3);

    const started = await h.services.worker.start();
    assert.equal(started.running, true);
    assert.ok(started.nextPollAt);
    await h.services.idle();
    h.services.worker.stop();
    assert.equal((await h.services.worker.status()).running, false);

    const off = await h.services.mail.disconnect(CLERK);
    assert.equal(off.connected, false);
    await assert.rejects(h.services.mail.pollNow(), /Connect a mailbox first/);
  } finally {
    await h.cleanup();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('the mailbox is not searched when the house turned that off', async () => {
  const eml = enc('From: ops@broker.example\nSubject: INV-100 papers\n\nSAMPLE');
  const h = await makeHarness({ profile: { permissions: { searchMailbox: false } }, mailMessages: [{ uid: 1, messageId: '<x@y>', from: 'ops@broker.example', subject: 'INV-100 papers', date: '2026-11-15T08:00:00.000Z', eml }] });
  try {
    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.mail.pollNow();
    assert.equal(h.mail.fetches.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('loadSample adds the sample folder as it is; resetSample empties the sandbox', async () => {
  const samples = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-samples-'));
  await fs.writeFile(path.join(samples, 'invoice.pdf'), INVOICE);
  await fs.mkdir(path.join(samples, 'WhatsApp Chat - SAMPLE'));
  await fs.writeFile(path.join(samples, 'WhatsApp Chat - SAMPLE', '_chat.txt'), '[11/12/26, 10:00:00 AM] Ravi: Parcel INV-100 leaves Friday\n');
  await fs.writeFile(path.join(samples, 'WhatsApp Chat - SAMPLE', 'awb.pdf'), 'SAMPLE AIR WAYBILL\nInvoice No: INV-100\nHAWB: 176-12345675');
  const h = await makeHarness({ samplesDir: samples });
  try {
    const loaded = await h.services.loadSample();
    assert.equal(loaded.files, 2, 'the chat folder goes in as one export');
    await h.services.idle();
    const docs = await h.store.list('documents');
    assert.deepEqual(docs.map((d) => d.fileName).sort(), ['_chat.txt', 'awb.pdf', 'invoice.pdf']);
    assert.ok(docs.every((d) => d.source.kind === 'sample' || d.source.sample === true));
    const chat = docs.find((d) => d.kind === 'chat');
    assert.equal(docs.find((d) => d.fileName === 'awb.pdf').parentId, chat.id);
    const fileKey = docs[0].fileKey;

    const reset = await h.services.resetSample();
    assert.ok(reset.removed > 0);
    for (const name of ['documents', 'shipments', 'stones', 'checks', 'questions', 'parties', 'events', 'messages']) {
      assert.equal((await h.store.list(name)).length, 0, `${name} is empty`);
    }
    assert.deepEqual((await h.store.list('activity')).map((a) => a.detail), ['Cleared the sandbox']);
    await assert.rejects(h.store.getFile(fileKey));

    await h.store.updateWorkspace({ environment: 'live' });
    await assert.rejects(h.services.loadSample(), /live workspace/);
    await assert.rejects(h.services.resetSample(), /live workspace/);
  } finally {
    await h.cleanup();
    await fs.rm(samples, { recursive: true, force: true });
  }
});

test('history finds a stone by its report number written any way', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    const found = await h.services.history('GIA 2141-438-172');
    assert.equal(found.stone.reportNumber, '2141438172');
    assert.equal(found.shipment.id, shipment.id);
    assert.deepEqual(found.events.map((e) => e.kind), ['graded', 'invoiced']);
    assert.deepEqual(await h.services.history('nope'), { stone: null, shipment: null, events: [] });
  } finally {
    await h.cleanup();
  }
});

test('metrics hands this house to computeMetrics', async () => {
  const h = await makeHarness();
  try {
    await withShipment(h);
    const result = await h.services.metrics();
    assert.ok(result.totals.events > 0);
    const [house] = fakeMetrics.lastInput.workspaces;
    assert.equal(house.workspace.name, 'SAMPLE Gems Exports');
    assert.ok(house.events.some((e) => e.type === 'upload' && 'userId' in e));
    assert.ok(Array.isArray(house.papers) && Array.isArray(house.shipments) && Array.isArray(house.members));
    assert.ok(fakeMetrics.lastInput.now instanceof Date);
  } finally {
    await h.cleanup();
  }
});

test('helpers: merging queued runs, question identity, status, answers, finding a shipment', () => {
  assert.deepEqual(mergeOptions({ shipmentId: 'a', reason: 'x' }, { shipmentId: 'b', reason: 'y' }), { shipmentIds: ['a', 'b'], forceIds: ['a', 'b'], force: false, reason: 'x, y' });
  assert.deepEqual(mergeOptions({}, { shipmentId: 'b' }).shipmentIds, null, 'a full run covers every shipment');
  assert.deepEqual(mergeOptions({}, { shipmentId: 'b' }).forceIds, ['b'], 'b is still checked');

  assert.equal(questionKey({ kind: 'missing_field', key: 'goods.destinationCountry', text: 'A?' }), questionKey({ kind: 'missing_field', key: 'goods.destinationCountry', text: 'Different words?' }));
  // The real rules give every missing paper the same code, so the dedupeKey (or the paper type) tells them apart.
  const kp = { kind: 'missing_document', code: 'required_documents', docType: 'kp_certificate', text: 'KP?' };
  const awb = { kind: 'missing_document', code: 'required_documents', docType: 'air_waybill', text: 'AWB?' };
  assert.notEqual(questionKey(kp), questionKey(awb));
  assert.equal(questionKey({ ...kp, dedupeKey: 's1|required_documents|ab12' }), 's1|required_documents|ab12');
  assert.notEqual(questionKey({ kind: 'confirm', text: 'Is it A?' }), questionKey({ kind: 'confirm', text: 'Is it B?' }));

  const pass = [{ severity: 'pass' }];
  assert.equal(decideStatus({ status: 'questions' }, pass, [{ id: 'q' }]), 'questions');
  assert.equal(decideStatus({ status: 'questions' }, pass, []), 'ready_to_sign');
  assert.equal(decideStatus({ status: 'ready_to_sign' }, [{ severity: 'fail' }], []), 'held_for_review');
  const failedCheck = { code: 'sanctions', severity: 'fail', detail: 'On the OFAC SDN list: X (X).' };
  const approvedThis = { checkedBasis: 'b1', deskApproved: { basis: 'b1', failing: ['sanctions: On the OFAC SDN list: X (X).'] } };
  assert.equal(decideStatus({ status: 'ready_to_sign' }, [failedCheck], [], approvedThis), 'ready_to_sign');
  const newFailure = { code: 'sanctions', severity: 'fail', detail: 'On the OFAC SDN list: X (X), Y (Y).' };
  assert.equal(decideStatus({ status: 'ready_to_sign' }, [newFailure], [], approvedThis), 'held_for_review', 'a new failure holds it again');
  assert.equal(decideStatus({ status: 'ready_to_sign' }, [failedCheck], [], { checkedBasis: 'b1', deskApproved: { basis: 'b1' } }), 'held_for_review', 'an approval that names no checks covers none');
  assert.equal(decideStatus({ status: 'questions' }, pass, [], {}, { unsettled: [{ id: 'q', check: 'sanctions', answer: 'Same' }] }), 'held_for_review');
  assert.equal(decideStatus({ status: 'ready_to_sign' }, pass, [], {}, { deskReview: true }), 'held_for_review', 'the desk reviews every pack');
  assert.equal(decideStatus({ status: 'ready_to_sign' }, pass, [], { checkedBasis: 'b1', deskApproved: { basis: 'b1', failing: [] } }, { deskReview: true }), 'ready_to_sign');
  assert.equal(decideStatus({}, [], []), 'collecting');

  const shipment = applyAnswers({ answers: { 'goods.totalCarats': '1.01 ct', 'consignee.country': 'Belgium', 'goods.destinationCountry': 'BE' }, consignee: { name: 'X' } });
  assert.equal(shipment.totals.carats, 1.01);
  assert.deepEqual(shipment.consignee, { name: 'X', country: 'Belgium' });
  assert.equal(shipment.destinationCountry, 'BE');

  const list = [
    { id: 's1', ref: 'EXP/26-27/28', status: 'sent', updatedAt: '2026-11-14' },
    { id: 's2', ref: 'EXP/26-27/29', hawb: '176-12345675', status: 'questions', updatedAt: '2026-11-13' },
  ];
  assert.equal(findShipment(list, 'exp 26-27/28').id, 's1');
  assert.equal(findShipment(list, '17612345675').id, 's2');
  assert.equal(findShipment(list, null).id, 's2', 'the latest open one');
  assert.equal(findShipment(list, 'EXP/99'), null);
});

test('verifyStone stores the lab check and lets the rules see it', async () => {
  const seen = [];
  const h = await makeHarness();
  try {
    await withShipment(h);
    const [stone] = await h.store.list('stones');
    await assert.rejects(h.services.verifyStone(stone.id, CLERK), /not available/);

    const labsVerify = async (s) => { seen.push(s.reportNumber); return { status: 'mismatch', diffs: [{ field: 'carat', ours: 1.01, lab: 1.02 }], lab: 'GIA', url: 'https://www.gia.edu/report-check' }; };
    const withLabs = createServices({ store: h.store, ai: h.ai, labsVerify, pace: 0, modules: { ingest: fakeIngest, records: fakeRecords, rules: fakeRules, sanctions: h.sanctions, papers: fakePapers, mail: h.mail } });
    const check = await withLabs.verifyStone(stone.id, CLERK);
    await withLabs.idle();
    assert.deepEqual(seen, ['2141438172']);
    assert.equal(check.status, 'mismatch');
    assert.equal((await h.store.get('stones', stone.id)).labCheck.status, 'mismatch', 'kept after Records runs again');
    const logged = (await h.store.list('activity')).find((a) => a.action === 'lab check');
    assert.equal(logged.detail, 'GIA report 2141438172 differs from our record: carat');
  } finally {
    await h.cleanup();
  }
});

test('settings main re-applies on every open are not logged again', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-folder-'));
  const h = await makeHarness();
  try {
    await h.services.autopilot.set(true); // already on
    await h.services.folder.set(folder, CLERK);
    await h.services.folder.set(folder, CLERK);
    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.idle();
    const actions = (await h.store.list('activity')).map((a) => a.action);
    assert.equal(actions.filter((a) => a === 'autopilot').length, 0);
    assert.equal(actions.filter((a) => a === 'folder').length, 1);
    assert.equal(actions.filter((a) => a === 'connected').length, 1);
    await h.services.autopilot.set(false, CLERK);
    assert.equal((await h.store.list('activity')).filter((a) => a.action === 'autopilot').length, 1);
  } finally {
    await h.cleanup();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('the watched folder is remembered on this computer, not in the shared workspace', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-folder-'));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-cache-'));
  const old = new Date(Date.now() - 60 * 1000);
  for (const name of ['a.pdf', 'b.pdf']) {
    await fs.writeFile(path.join(folder, name), `SAMPLE COMMERCIAL INVOICE\nInvoice No: INV-${name === 'a.pdf' ? 400 : 401}`);
    await fs.utimes(path.join(folder, name), old, old);
  }
  const first = await makeHarness({ cacheDir });
  let second = null;
  try {
    await first.services.folder.set(folder, CLERK);
    await first.services.idle();
    assert.equal((await first.store.list('documents')).length, 2);
    assert.equal((await first.store.workspace()).folder, undefined, 'nothing about the folder in the shared workspace');
    const saved = JSON.parse(await fs.readFile(path.join(cacheDir, `watched-folder-${(await first.store.workspace()).id}.json`), 'utf8'));
    assert.equal(saved.path, folder);
    assert.deepEqual(Object.keys(saved.seen).sort(), ['a.pdf', 'b.pdf']);

    // The app restarts: main sets the same folder again. Nothing is logged twice or read twice.
    first.services.worker.stop();
    second = await makeHarness({ cacheDir, store: first.store });
    await second.services.folder.set(folder, CLERK);
    await second.services.worker.tick();
    await second.services.idle();
    const activity = await first.store.list('activity');
    assert.equal(activity.filter((a) => a.action === 'folder').length, 1);
    assert.equal(activity.filter((a) => a.action === 'skipped').length, 0);
    assert.equal((await second.services.folder.status()).files, 2);

    // A folder seen for the first time on a new computer: files already on file are summed up in one line.
    await fs.rm(path.join(cacheDir, `watched-folder-${(await first.store.workspace()).id}.json`));
    const third = await makeHarness({ cacheDir, store: first.store });
    await third.services.folder.set(folder, CLERK);
    await third.services.idle();
    const skipped = (await first.store.list('activity')).filter((a) => a.action === 'skipped');
    assert.deepEqual(skipped.map((a) => a.detail), [`2 files in ${folder} already on file`]);
    third.services.worker.stop();
  } finally {
    if (second) second.services.worker.stop();
    await first.cleanup();
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('an agent save never drops an answer or reopens a signed shipment', async () => {
  const { store, cleanup } = await makeStore({ name: 'SAMPLE House' });
  try {
    await store.put('shipments', { id: 'shp_1', ref: 'INV-1', status: 'signed', answers: { 'goods.destinationCountry': 'BE' }, houseEdits: 1 });
    const stale = { id: 'shp_1', ref: 'INV-1', status: 'ready_to_sign', answers: {}, houseEdits: 0, destinationCountry: null };
    const saved = await saveShipment({ store }, stale);
    assert.equal(saved.status, 'signed');
    assert.deepEqual(saved.answers, { 'goods.destinationCountry': 'BE' });
    assert.equal(saved.destinationCountry, 'BE');
    assert.equal((await store.get('shipments', 'shp_1')).houseEdits, 1);
  } finally {
    await cleanup();
  }
});

test('the worker re-checks a shipment that changed while this computer was waiting', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    assert.equal(shipment.status, 'questions');
    // As if both answers were given on another computer whose run had to wait for the lease.
    await h.store.put('shipments', { ...shipment, answers: { 'goods.destinationCountry': 'BE' }, notNeeded: ['kp_certificate'] });
    for (const q of await openQuestions(h)) await h.store.put('questions', { ...q, status: 'answered', answer: 'x' });
    await h.services.worker.tick();
    await h.services.idle();
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'ready_to_sign');
    assert.equal((await h.store.list('papers')).length, 2, 'autopilot built the papers');
    const runsBefore = h.ai.calls.extract;
    await h.services.worker.tick(); // nothing changed now: no run
    assert.equal(h.ai.calls.extract, runsBefore);
  } finally {
    await h.cleanup();
  }
});

// ---------- fixes: nothing uncertain reaches a pack ----------

/** A promise the test opens when it wants: lets a slow step be caught in the middle. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test('papers built while a question is open are a draft: the shipment keeps its questions and nothing is signed', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    assert.equal(shipment.status, 'questions');
    const built = await h.services.buildPapers(shipment.id, { by: CLERK });
    assert.equal(built.status, 'draft');
    assert.deepEqual(built.papers.map((p) => [p.kind, p.status]), [['eu_dds', 'draft'], ['export_pack', 'draft']]);
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'questions', 'the shipment keeps its open questions');
    assert.ok(h.notes.some((n) => n.kind === 'questions' && n.title === 'Draft only: INV-100'));
    assert.ok(!h.notes.some((n) => n.kind === 'pack_ready'));
    const pack = built.papers.find((p) => p.kind === 'export_pack');
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /draft/);
    await assert.rejects(h.services.desk.approve(pack.id, 'Looks fine.', DESK), /still open/);
  } finally {
    await h.cleanup();
  }
});

test('a paper is signed only as it was built from the shipment as it is now', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    await h.services.addFiles(await baseFiles());
    await h.services.run({ reason: 'test' });
    await answerAll(h);
    const [shipment] = await h.store.list('shipments');
    assert.equal(shipment.status, 'ready_to_sign');
    const pack = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers[0];
    assert.equal(pack.status, 'ready_to_sign');
    // A new paper arrives after the pack was built: the pack does not have it.
    await h.services.addFiles([{ name: 'awb-2.pdf', bytes: enc('SAMPLE AIR WAYBILL\nInvoice No: INV-100\nHAWB: 176-99999999') }]);
    await h.services.run({ reason: 'new paper' });
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /New papers or answers came in/);
    await h.services.idle();
    const again = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers[0];
    assert.equal(again.version, 2);
    assert.equal((await h.services.signPaper(again.id, { name: 'Asha Mehta' }, CLERK)).status, 'signed');
  } finally {
    await h.cleanup();
  }
});

test('a possible OFAC SDN match is cleared only by "Different": "Same" holds the pack, and it cannot be dismissed', async () => {
  for (const [reply, expected] of [['Same', 'held_for_review'], ['Different', 'ready_to_sign'], [null, 'questions']]) {
    const h = await makeHarness();
    try {
      await h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(INVOICE.replace('SAMPLE Diamant BV', 'CLOSE Trading LLC')) }, { name: 'report.pdf', bytes: enc(REPORT) }]);
      await h.services.idle();
      const open = await openQuestions(h);
      const match = open.find((q) => q.check === 'sanctions');
      assert.ok(match, 'the clerk is asked to confirm');
      for (const q of open.filter((x) => x !== match)) await h.services.answerQuestion(q.id, q.kind === 'missing_document' ? 'not needed' : 'BE', CLERK);
      if (reply) await h.services.answerQuestion(match.id, reply, CLERK);
      else await assert.rejects(h.services.dismissQuestion(match.id, CLERK), /Answer this question; the agents need to know which is right\./);
      await h.services.idle();
      const [shipment] = await h.store.list('shipments');
      assert.equal(shipment.status, expected, reply || 'a dismissal');
      if (!reply) {
        // Refused: the question stays open, the shipment waits for the answer and no pack is ready to sign.
        assert.equal((await h.store.get('questions', match.id)).status, 'open');
        assert.ok((await h.store.list('papers')).every((p) => p.status !== 'ready_to_sign'));
        continue;
      }
      const pack = (await h.store.list('papers')).find((p) => p.kind === 'export_pack');
      assert.equal(pack.status, expected, `the pack after ${reply || 'a dismissal'}`);
      if (expected === 'held_for_review') {
        await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /held for review/);
        // The papers are built again by hand: still held, never ready to sign.
        assert.equal((await h.services.buildPapers(shipment.id, { by: CLERK })).status, 'held_for_review');
      }
    } finally {
      await h.cleanup();
    }
  }
});

test('a newer OFAC SDN list: the shipment is screened again before anyone signs', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    await h.services.addFiles(await baseFiles());
    await h.services.run({ reason: 'test' });
    await answerAll(h);
    const [shipment] = await h.store.list('shipments');
    assert.equal(shipment.sdnListDate, '2026-11-02');
    const pack = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers[0];
    const screened = h.sanctions.calls.length;
    h.listDate = '2026-11-15'; // the daily refresh brought a newer list
    h.clock.now += 2 * 3600 * 1000;
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /OFAC SDN list was updated \(2026-11-15\)/);
    await h.services.idle(); // the agents screen it again on their own
    assert.ok(h.sanctions.calls.length > screened, 'the parties were screened again');
    assert.equal((await h.store.get('shipments', shipment.id)).sdnListDate, '2026-11-15');
    assert.equal((await h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK)).status, 'signed');

    // With autopilot on, the 5-minute loop screens open shipments again when the list changes.
    await h.store.updateWorkspace({ autopilot: true });
    await h.services.addFiles([{ name: 'invoice-2.pdf', bytes: enc(INVOICE.replace('INV-100', 'INV-300')) }]);
    await h.services.idle();
    const second = (await h.store.list('shipments')).find((s) => s.ref === 'INV-300');
    h.listDate = '2026-11-16';
    h.clock.now += 2 * 3600 * 1000;
    await h.services.worker.tick();
    await h.services.idle();
    assert.equal((await h.store.get('shipments', second.id)).sdnListDate, '2026-11-16');
  } finally {
    await h.cleanup();
  }
});

test('on an export, signing the EU statement is the house checking the draft the importer signs', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    await answerAll(h);
    const dds = (await h.store.list('papers')).find((p) => p.kind === 'eu_dds');
    await h.services.signPaper(dds.id, { name: 'Asha Mehta' }, CLERK);
    assert.ok(h.activity.some((a) => a.action === 'signed' && a.detail === `Checked EU Due Diligence Statement (draft) ${dds.ref} v1. The importer signs it.`));
    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.sendPaper(dds.id, { to: 'importer@buyer.example' }, CLERK);
    assert.match(h.mail.sent[0].text, /checked by Asha Mehta, for the importer to sign\.$/);
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'ready_to_sign', 'the statement alone does not sign the shipment');
  } finally {
    await h.cleanup();
  }
});

// ---------- fixes: papers, numbers and signatures under load ----------

test('two builds at the same moment never take the same paper number', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    await h.services.addFiles([
      { name: 'invoice-a.pdf', bytes: enc(INVOICE.replace('INV-100', 'INV-501')) },
      { name: 'invoice-b.pdf', bytes: enc(INVOICE.replace('INV-100', 'INV-502')) },
    ]);
    await h.services.run({ reason: 'test' });
    await answerAll(h);
    const [a, b] = await h.store.list('shipments');
    const [one, two] = await Promise.all([h.services.buildPapers(a.id, { by: CLERK }), h.services.buildPapers(b.id, { by: CLERK })]);
    const refs = [...one.papers, ...two.papers].map((p) => p.ref);
    assert.equal(refs.length, 4);
    assert.equal(new Set(refs).size, 4, `every paper has its own number: ${refs.join(', ')}`);
  } finally {
    await h.cleanup();
  }
});

test('a person who signs while the agents rebuild the pack keeps the signature', async () => {
  const h = await makeHarness();
  const original = fakePapers.buildPack;
  try {
    const shipment = await withShipment(h);
    await answerAll(h);
    const pack = (await h.store.list('papers')).find((p) => p.kind === 'export_pack');
    const release = gate();
    const started = gate();
    fakePapers.buildPack = async (input) => { started.open(); await release.promise; return original.call(fakePapers, input); };
    const rebuild = h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: { type: 'agent', name: 'Paperwork' } });
    await started.promise;
    const signed = await h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK);
    release.open();
    assert.deepEqual((await rebuild).papers, [], 'the agents leave the signed paper alone');
    const after = await h.store.get('papers', pack.id);
    assert.deepEqual([after.status, after.version, after.signedBy, after.fileKey], ['signed', 1, 'Asha Mehta', signed.fileKey]);
  } finally {
    fakePapers.buildPack = original;
    await h.cleanup();
  }
});

test('a paper removed while the agents read it stays removed', async () => {
  const h = await makeHarness();
  const original = h.ai.extract;
  try {
    const release = gate();
    const reading = gate();
    h.ai.extract = async (...args) => { reading.open(); await release.promise; return original.apply(h.ai, args); };
    const { documentIds: [id] } = await h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(INVOICE) }]);
    await reading.promise;
    await h.store.remove('documents', id); // what jl.docs.remove does
    release.open();
    await h.services.idle();
    assert.equal(await h.store.get('documents', id), null);
    assert.equal((await h.store.list('shipments')).length, 0, 'no shipment was started from it');
  } finally {
    h.ai.extract = original;
    await h.cleanup();
  }
});

// ---------- fixes: reading files ----------

test('locked PDFs, iPhone photos and Outlook files fail with a plain reason and are not sent to the model', async () => {
  const h = await makeHarness();
  try {
    const classified = h.ai.calls.classify;
    const added = await h.services.addFiles([
      { name: 'KP certificate.pdf', bytes: enc('LOCKED') },
      { name: 'IMG_4512.heic', bytes: enc('HEIC PHOTO') },
      { name: 'RE Invoice.msg', bytes: enc('OUTLOOK MSG') },
    ]);
    await h.services.idle();
    const docs = await Promise.all(added.documentIds.map((id) => h.store.get('documents', id)));
    assert.deepEqual(docs.map((d) => d.status), ['error', 'error', 'error']);
    assert.equal(docs[0].error, 'This PDF is locked with a password. Remove the password and add it again.');
    assert.match(docs[1].error, /^Pictures saved as HEIC cannot be read yet/);
    assert.match(docs[2].error, /^Outlook \.msg files cannot be read yet/);
    assert.ok(docs.every((d) => d.retries === 3), 'reading again would not help');
    assert.equal(h.ai.calls.classify, classified, 'nothing went to the model');
    assert.deepEqual(h.rasterized, [], 'no pages drawn for a PDF that does not open');
    await h.services.worker.tick();
    await h.services.idle();
    assert.ok((await h.store.list('documents')).every((d) => d.status === 'error'), 'and they are not tried again');
  } finally {
    await h.cleanup();
  }
});

test('a chat the model could not read says the offline reader read it', async () => {
  const h = await makeHarness();
  const original = h.ai.readChat;
  try {
    // What the AI module answers when the model fails: the offline reading, said so, with the error's code.
    h.ai.readChat = async (chat) => ({ ...(await original.call(h.ai, chat)), readBy: 'offline', warnings: ['Read offline: the model timed out'], aiError: 'timeout' });
    await h.services.addFiles([{ name: 'WhatsApp Chat - SAMPLE.zip', bytes: await chatZip(), source: { kind: 'whatsapp' } }]);
    await h.services.idle();
    const docs = await h.store.list('documents');
    const chat = docs.find((d) => d.kind === 'chat');
    assert.equal(chat.readBy, 'Offline reader');
    assert.deepEqual(chat.warnings, ['Read offline: the model timed out']);
    assert.equal(chat.aiError, 'timeout');
    assert.equal(chat.needsAiRead, true, 'read again once the AI is back');
    assert.ok(chat.content.chat.messages.length > 0 && chat.content.chat.messageCount === undefined, 'the whole chat is kept for that read');
    assert.equal(docs.find((d) => d.fileName === 'awb.pdf').readBy, 'fake-model');
    assert.equal(docs.find((d) => d.fileName === 'awb.pdf').needsAiRead, false);
  } finally {
    h.ai.readChat = original;
    await h.cleanup();
  }
});

test('a file the store refuses (too big for a shared house) is reported, and the rest of the drop goes on', async () => {
  const { store, cleanup } = await makeStore({ name: 'SAMPLE Gems Exports', environment: 'sandbox' });
  const putFile = store.putFile;
  const refusal = 'huge.pdf is 63 MB, and a house shared online keeps files of up to 50 MB.';
  store.putFile = async (key, bytes, mime) => { if (key.endsWith('/huge.pdf')) throw new Error(refusal); return putFile(key, bytes, mime); };
  const h = await makeHarness({ store });
  try {
    const result = await h.services.addFiles([{ name: 'huge.pdf', bytes: enc('HUGE') }, { name: 'invoice.pdf', bytes: enc(INVOICE) }]);
    assert.deepEqual(result.failed, [{ name: 'huge.pdf', error: refusal }]);
    assert.equal(result.documentIds.length, 1);
    await h.services.idle();
    assert.deepEqual((await h.store.list('documents')).map((d) => d.fileName), ['invoice.pdf']);
    assert.ok(h.activity.some((a) => a.action === 'error' && a.detail === `Could not add huge.pdf: ${refusal}`));
  } finally {
    await h.cleanup();
    await cleanup();
  }
});

// ---------- fixes: the watched folder and the mailbox ----------

test('a file the watched folder cannot read does not stop the others, and is tried again', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-folder-'));
  const locked = path.join(folder, 'doc-12.pdf');
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    const old = new Date(Date.now() - 60 * 1000);
    for (let i = 1; i <= 13; i += 1) {
      const file = path.join(folder, `doc-${String(i).padStart(2, '0')}.pdf`);
      await fs.writeFile(file, `SAMPLE COMMERCIAL INVOICE\nInvoice No: INV-6${String(i).padStart(2, '0')}`);
      await fs.utimes(file, old, old);
    }
    await fs.chmod(locked, 0o000); // in the second batch of ten
    await h.services.folder.set(folder, CLERK);
    await h.services.idle();
    const picked = () => h.store.list('documents', (d) => d.source.kind === 'folder');
    assert.equal((await picked()).length, 12, 'the other files came in');
    const status = await h.services.folder.status();
    assert.deepEqual(status.problems, [{ file: 'doc-12.pdf', reason: 'no permission to read it' }]);
    assert.equal(status.files, 12, 'only files the agents have are marked as seen');
    const logged = () => h.activity.filter((a) => a.action === 'error' && /could not be read/.test(a.detail)).length;
    assert.equal(logged(), 1);
    await h.services.worker.tick();
    assert.equal(logged(), 1, 'logged once, not every round');
    await fs.chmod(locked, 0o644);
    await h.services.worker.tick();
    assert.equal((await picked()).length, 13, 'picked up once it can be read');
    assert.deepEqual((await h.services.folder.status()).problems, []);
  } finally {
    await fs.chmod(locked, 0o644).catch(() => {});
    await h.cleanup();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('the watched folder sees every file however many there are; a whole drive is refused out loud', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-folder-'));
  try {
    for (let m = 1; m <= 21; m += 1) {
      const month = path.join(folder, `2025-${String(m).padStart(2, '0')}`);
      await fs.mkdir(month);
      await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(month, `paper-${i}.pdf`), 'x')));
    }
    await fs.writeFile(path.join(folder, '2025-21', 'Invoice KG-26-27-090.pdf'), 'new');
    const files = await listFiles(folder);
    assert.equal(files.length, 2101);
    assert.ok(files.some((f) => f.rel === '2025-21/Invoice KG-26-27-090.pdf'), 'the newest paper, in the last folder, is seen');
    await assert.rejects(listFiles(folder, { maxFiles: 500 }), /This folder holds more than 500 files\. Choose the folder where new papers land\./);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('the same file added twice at the same moment is stored once, and mail polls never run two at once', async () => {
  const eml = enc('From: ops@broker.example\nSubject: INV-100 papers\n\nSAMPLE');
  const h = await makeHarness({ profile: { autopilot: false }, mailMessages: [{ uid: 1, messageId: '<a@b>', from: 'ops@broker.example', subject: 'INV-100 papers', date: '2026-11-15T08:00:00.000Z', eml }] });
  try {
    const [a, b] = await Promise.all([
      h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(INVOICE) }]),
      h.services.addFiles([{ name: 'invoice copy.pdf', bytes: enc(INVOICE) }]),
    ]);
    assert.equal(a.documentIds.length + b.documentIds.length, 1);
    assert.equal(a.duplicates.length + b.duplicates.length, 1);
    assert.equal((await h.store.list('documents')).length, 1);

    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await Promise.all([h.services.mail.pollNow(), h.services.worker.tick(), h.services.mail.pollNow()]);
    assert.equal(h.mail.fetches.length, 1, 'one poll, shared by the loop and both buttons');
    assert.equal((await h.store.list('documents', (d) => d.kind === 'email')).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('the mailbox and how far the agents got in it stay on this computer; another mailbox starts afresh', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-cache-'));
  const eml = enc('From: ops@broker.example\nSubject: INV-100 papers\n\nSAMPLE');
  const messages = Object.assign(
    [{ uid: 7, messageId: '<m7@broker.example>', from: 'ops@broker.example', subject: 'INV-100 papers', date: '2026-11-15T08:00:00.000Z', eml }],
    { lastUid: 7, uidValidity: '42', more: false },
  );
  const h = await makeHarness({ cacheDir, mailMessages: messages, profile: { autopilot: false } });
  try {
    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.mail.pollNow();
    await h.services.mail.pollNow();
    assert.deepEqual(h.mail.fetches[0].options, { domains: ['broker.example'], afterUid: 0, uidValidity: null });
    assert.deepEqual(h.mail.fetches[1].options, { domains: ['broker.example'], afterUid: 7, uidValidity: '42' }, 'the next poll goes on after the last message');
    const file = path.join(cacheDir, `mailbox-${(await h.store.workspace()).id}.json`);
    const text = await fs.readFile(file, 'utf8');
    assert.equal(JSON.parse(text).lastUid, 7);
    assert.ok(!text.includes(PASS), 'the app password is never saved here');
    assert.equal((await h.store.workspace()).mailbox, undefined, 'nor anything in the shared workspace');

    await h.services.mail.connect({ provider: 'gmail', email: 'other@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.mail.pollNow();
    assert.equal(h.mail.fetches[2].options.afterUid, 0, 'another mailbox does not use the first one\'s progress');
    assert.ok(Date.now() - h.mail.fetches[2].date.getTime() > 13 * 24 * 3600 * 1000, 'it looks back a few days the first time');
    assert.equal((await h.services.mail.status()).email, 'other@house.example');
  } finally {
    await h.cleanup();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('the 5-minute checks do not wait for the agents to finish a big batch', async () => {
  const h = await makeHarness();
  const original = h.ai.extract;
  const release = gate();
  try {
    h.ai.extract = async (...args) => { await release.promise; return original.apply(h.ai, args); };
    await h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(INVOICE) }]); // the agents start reading it
    await h.services.addFiles([{ name: 'report.pdf', bytes: enc(REPORT) }]); // a second paper waits for the next run
    let late;
    const tooLong = new Promise((resolve, reject) => { late = setTimeout(() => reject(new Error('the round waited for the run')), 3000); });
    await Promise.race([h.services.worker.tick(), tooLong]);
    clearTimeout(late);
    assert.ok((await h.services.worker.status()).lastPollAt, 'the round finished while the agents were still reading');
  } finally {
    release.open();
    h.ai.extract = original;
    await h.cleanup();
  }
});

test('a run stops when its lease ran out, and being offline is not blamed on another computer', async () => {
  let offline = false;
  const lease = { async acquire() { if (offline) throw new Error('fetch failed'); return true; }, async release() {} };
  const h = await makeHarness({ lease, parallel: 1, profile: { autopilot: false } });
  const original = h.ai.extract;
  try {
    await h.services.addFiles([
      { name: 'a.pdf', bytes: enc(INVOICE) }, { name: 'b.pdf', bytes: enc(REPORT) },
      { name: 'c.pdf', bytes: enc('SAMPLE AIR WAYBILL\nInvoice No: INV-100') },
    ]);
    // The laptop sleeps for 200 seconds while the first paper is read: longer than the 180-second lease.
    h.ai.extract = async (...args) => { h.clock.now += 200 * 1000; return original.apply(h.ai, args); };
    const stopped = await h.services.run({ reason: 'test' });
    assert.equal(stopped.stopped, 'lease');
    assert.equal((await h.store.list('documents', (d) => d.status === 'read')).length, 1, 'no more papers once the lease ran out');
    assert.ok(h.activity.some((a) => a.action === 'stopped'));
    h.ai.extract = original;

    offline = true;
    assert.deepEqual(await h.services.run({ reason: 'again' }), { skipped: 'lease', reason: 'offline' });
    assert.match(h.activity.find((a) => a.action === 'waiting').detail, /^The cloud cannot be reached/);
    offline = false;
    await h.services.run({ reason: 'back online' });
    assert.ok((await h.store.list('documents')).every((d) => d.status === 'read'));
  } finally {
    h.ai.extract = original;
    await h.cleanup();
  }
});

test('a page of a scan that never finishes drawing fails that paper, and the agents go on', async () => {
  const h = await makeHarness({ rasterize: () => new Promise(() => {}), pageDrawTimeoutMs: 50 });
  try {
    await h.services.addFiles([{ name: 'scan.pdf', bytes: enc('SCANNED') }, { name: 'invoice.pdf', bytes: enc(INVOICE) }]);
    await h.services.idle();
    const docs = await h.store.list('documents');
    const scan = docs.find((d) => d.fileName === 'scan.pdf');
    assert.equal(scan.status, 'error');
    assert.equal(scan.error, 'Drawing page 1 of this scan took too long.');
    assert.equal(scan.retries, 0, 'tried again on a later round');
    assert.equal(docs.find((d) => d.fileName === 'invoice.pdf').status, 'read');
  } finally {
    await h.cleanup();
  }
});

test('a draft is never taken for the finished pack once nothing is open', async () => {
  const h = await makeHarness();
  try {
    await h.services.addFiles([{ name: 'invoice.pdf', bytes: enc(`${INVOICE}\nDestination: BE\nODD`) }, { name: 'report.pdf', bytes: enc(REPORT) }]);
    await h.services.idle();
    const kp = (await openQuestions(h)).find((q) => q.kind === 'missing_document');
    await h.services.answerQuestion(kp.id, 'not needed', CLERK);
    await h.services.idle();
    const [note] = await openQuestions(h);
    assert.match(note.text, /Check it\.$/);
    const [shipment] = await h.store.list('shipments');
    const draft = (await h.services.buildPapers(shipment.id, { by: CLERK })).papers.find((p) => p.kind === 'export_pack');
    assert.equal(draft.status, 'draft');
    await assert.rejects(h.services.dismissQuestion(note.id, CLERK), /Answer this question/); // a question to confirm is answered
    await h.services.answerQuestion(note.id, 'Checked, it is right', CLERK);
    await h.services.idle();
    const pack = await h.store.get('papers', draft.id);
    assert.deepEqual([pack.status, pack.version], ['ready_to_sign', 2], 'autopilot built the pack to sign');
  } finally {
    await h.cleanup();
  }
});

test('an answer the rules cannot use, or a dismissal, of a question they still ask holds the pack', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    const questions = await openQuestions(h);
    await h.services.answerQuestion(questions.find((q) => q.kind === 'missing_document').id, 'not needed', CLERK);
    await h.services.dismissQuestion(questions.find((q) => q.key === 'goods.destinationCountry').id, CLERK);
    await h.services.idle();
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'held_for_review', 'the destination is still unknown');
    assert.ok((await h.store.list('papers')).every((p) => p.status === 'held_for_review'));
  } finally {
    await h.cleanup();
  }
});

// ---------- answers the rules read, the rules' own version, and inputs that stopped the app ----------

/** With autopilot off the agents wait for a person: drop the base papers and run them by hand. */
async function withShipmentByHand(h) {
  await h.services.addFiles(await baseFiles());
  await h.services.run({ reason: 'test' });
  await h.services.idle();
  const [shipment] = await h.store.list('shipments');
  return shipment;
}

test('a rules-only answer stays on the shipment; doc.checkedBy goes on the draft; a valid EORI goes into the house profile', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    const shipment = await withShipmentByHand(h);
    const invoice = (await h.store.list('documents')).find((d) => d.fileName === 'invoice.pdf');
    const ask = async (extra) => {
      const q = { id: `qst_${extra.key.replace(/\W/g, '')}`, shipmentId: shipment.id, kind: 'confirm', text: `Question about ${extra.key}?`, status: 'open', ...extra };
      await h.store.put('questions', q);
      return q;
    };
    const carat = await ask({ key: 'stone.2141438172.carat', docId: invoice.id, kind: 'mismatch' });
    await h.services.answerQuestion(carat.id, '1.01 ct', CLERK);
    const eori = await ask({ key: 'house.eori', kind: 'missing_field' });
    await h.services.answerQuestion(eori.id, 'be 0123.456.789', CLERK);
    const draft = await ask({ key: 'doc.checkedBy', docId: invoice.id });
    await h.services.answerQuestion(draft.id, 'Yes, use it as our packing list', CLERK);
    await h.services.idle();

    const after = await h.store.get('documents', invoice.id);
    assert.ok(!after.fields.some((f) => f.key.startsWith('stone.')), 'a stone answer is never written into a paper');
    assert.equal(after.fields.find((f) => f.key === 'doc.checkedBy').value, 'Yes, use it as our packing list');
    assert.equal(after.fields.find((f) => f.key === 'doc.checkedBy').by, CLERK.name);
    const answers = (await h.store.get('shipments', shipment.id)).answers;
    assert.equal(answers['stone.2141438172.carat'], '1.01 ct');
    const house = await h.store.workspace();
    assert.equal(house.eori, 'BE0123456789');
    assert.equal(house.letterhead.eori, 'BE0123456789');

    const bad = await ask({ key: 'house.eori', kind: 'missing_field', id: 'qst_eori2' });
    await h.store.updateWorkspace({ eori: '', letterhead: { eori: '' } });
    await h.services.answerQuestion(bad.id, 'not an eori', CLERK);
    assert.equal((await h.store.workspace()).eori, '', 'only a valid EORI goes into the profile');
  } finally {
    await h.cleanup();
  }
});

test('a question asked before the rules gave it a key gets the key, so its answer lands where the rules read it', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  const evaluate = fakeRules.evaluate;
  try {
    const shipment = await withShipmentByHand(h);
    fakeRules.evaluate = (input) => {
      const result = evaluate(input);
      return { ...result, questions: [...result.questions, { kind: 'mismatch', check: 'stone_details', key: 'stone.2141438172.carat', options: ['1.01 ct', '1.02 ct'], text: 'Report 2141438172 weighs 1.01 ct on the lab report but 1.02 ct on the invoice. Which is right?', dedupeKey: 'stone_details|carat_mismatch|2141438172' }] };
    };
    // The same question, saved by an older copy of the app: no key, no options.
    await h.store.put('questions', { id: 'qst_old', shipmentId: shipment.id, kind: 'mismatch', check: 'stone_details', text: 'Report 2141438172 weighs 1.01 ct on the lab report but 1.02 ct on the invoice. Which is right?', dedupeKey: 'stone_details|carat_mismatch|2141438172', status: 'open' });
    await h.services.run({ shipmentId: shipment.id, force: true, reason: 'test' });
    const updated = await h.store.get('questions', 'qst_old');
    assert.equal(updated.status, 'open');
    assert.equal(updated.key, 'stone.2141438172.carat');
    assert.deepEqual(updated.options, ['1.01 ct', '1.02 ct']);
    assert.equal((await openQuestions(h)).filter((q) => q.dedupeKey === 'stone_details|carat_mismatch|2141438172').length, 1, 'not asked twice');
  } finally {
    fakeRules.evaluate = evaluate;
    await h.cleanup();
  }
});

test('new rules in a new version of the app: shipments are checked again, and old papers are built again before signing', async () => {
  const h = await makeHarness({ profile: { autopilot: false } });
  try {
    const shipment = await withShipmentByHand(h);
    await answerAll(h);
    await h.services.run({ shipmentId: shipment.id, reason: 'test' });
    await h.services.idle();
    const pack = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers[0];
    assert.equal(pack.status, 'ready_to_sign');
    assert.equal(pack.rulesVersion, 'test-rules-1');
    fakeRules.RULES_VERSION = 'test-rules-2';
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /compliance rules were updated/);
    await h.services.idle(); // the agents check it again on their own
    assert.equal((await h.store.get('shipments', shipment.id)).rulesVersion, 'test-rules-2');
    await assert.rejects(h.services.signPaper(pack.id, { name: 'Asha Mehta' }, CLERK), /compliance rules were updated/, 'the old version stays unsigned');
    const rebuilt = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers[0];
    assert.deepEqual([rebuilt.version, rebuilt.rulesVersion, rebuilt.status], [2, 'test-rules-2', 'ready_to_sign']);
    assert.equal((await h.services.signPaper(rebuilt.id, { name: 'Asha Mehta' }, CLERK)).status, 'signed');
  } finally {
    fakeRules.RULES_VERSION = 'test-rules-1';
    await h.cleanup();
  }
});

test('with autopilot on, new rules check every open shipment again and rebuild its pack', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    await answerAll(h);
    const before = (await h.store.list('papers')).find((p) => p.kind === 'export_pack');
    assert.equal(before.rulesVersion, 'test-rules-1');
    fakeRules.RULES_VERSION = 'test-rules-2';
    await h.services.worker.tick();
    await h.services.idle();
    const after = await h.store.get('papers', before.id);
    assert.equal((await h.store.get('shipments', shipment.id)).rulesVersion, 'test-rules-2');
    assert.deepEqual([after.version, after.rulesVersion], [before.version + 1, 'test-rules-2']);
  } finally {
    fakeRules.RULES_VERSION = 'test-rules-1';
    await h.cleanup();
  }
});

test('papers that disagree cannot be dismissed: the question stays open and the shipment waits', async () => {
  const h = await makeHarness();
  const evaluate = fakeRules.evaluate;
  try {
    fakeRules.evaluate = (input) => {
      const result = evaluate(input);
      return { ...result, questions: [...result.questions, { kind: 'mismatch', check: 'stone_details', key: 'stone.2141438172.carat', text: 'Report 2141438172 weighs 1.01 ct on the lab report but 1.02 ct on the invoice. Which is right?', dedupeKey: 'mm|2141438172' }] };
    };
    const shipment = await withShipment(h);
    for (const q of (await openQuestions(h)).filter((x) => x.kind !== 'mismatch')) {
      await h.services.answerQuestion(q.id, q.kind === 'missing_document' ? 'not needed' : 'BE', CLERK);
    }
    await h.services.idle();
    const mismatch = (await openQuestions(h)).find((q) => q.kind === 'mismatch');
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'questions');
    await assert.rejects(h.services.dismissQuestion(mismatch.id, CLERK), /^Error: Answer this question; the agents need to know which is right\.$/);
    await h.services.idle();
    assert.equal((await h.store.get('questions', mismatch.id)).status, 'open');
    assert.equal((await h.store.get('shipments', shipment.id)).status, 'questions');
  } finally {
    fakeRules.evaluate = evaluate;
    await h.cleanup();
  }
});

test('an email or a folder file that stopped the app is not added again: it becomes a paper that could not be read', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-stuck-'));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-stuck-folder-'));
  const eml = enc('From: ops@broker.example\nSubject: INV-100 papers\n\nThe SAMPLE invoice.');
  const messages = [
    { uid: 8, messageId: '<m8@broker.example>', from: 'ops@broker.example', subject: 'INV-100 papers', date: '2026-11-15T08:00:00.000Z', eml },
    { uid: 9, messageId: '<m9@broker.example>', from: 'ops@broker.example', subject: 'Huge zip', date: '2026-11-15T08:05:00.000Z', eml: enc('From: ops@broker.example\nSubject: Huge zip\n\nzip bomb') },
  ];
  const h = await makeHarness({ mailMessages: messages, cacheDir });
  try {
    const { id } = await h.store.workspace();
    // The last start stopped while the second email and one folder file were being added.
    await fs.writeFile(path.join(cacheDir, `mailbox-${id}.json`), JSON.stringify({ email: 'clerk@house.example', connected: true, seen: [], inFlight: ['<m9@broker.example>'] }));
    const old = new Date(Date.now() - 60 * 1000);
    await fs.writeFile(path.join(folder, 'bad.pdf'), 'SAMPLE BROKEN');
    await fs.writeFile(path.join(folder, 'good.pdf'), INVOICE);
    for (const name of ['bad.pdf', 'good.pdf']) await fs.utimes(path.join(folder, name), old, old);
    const stat = await fs.stat(path.join(folder, 'bad.pdf'));
    await fs.writeFile(path.join(cacheDir, `watched-folder-${id}.json`), JSON.stringify({ path: folder, seen: {}, inFlight: { 'bad.pdf': `${Math.round(stat.mtimeMs)}:${stat.size}` } }));

    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.mail.pollNow();
    await h.services.folder.set(folder, CLERK);
    await h.services.idle();

    const docs = await h.store.list('documents');
    const byName = Object.fromEntries(docs.map((d) => [d.fileName, d]));
    assert.equal(byName['INV-100 papers.eml'].status, 'read', 'the other email is brought in as usual');
    assert.equal(byName['Huge zip.eml'].status, 'error');
    assert.equal(byName['Huge zip.eml'].error, STUCK_EMAIL);
    assert.equal(byName['good.pdf'].status, 'read');
    assert.equal(byName['bad.pdf'].status, 'error');
    assert.equal(byName['bad.pdf'].error, STUCK_FILE);
    const mailState = JSON.parse(await fs.readFile(path.join(cacheDir, `mailbox-${id}.json`), 'utf8'));
    assert.deepEqual(mailState.inFlight, []);
    assert.ok(mailState.seen.includes('<m9@broker.example>'));
    const folderState = JSON.parse(await fs.readFile(path.join(cacheDir, `watched-folder-${id}.json`), 'utf8'));
    assert.deepEqual(folderState.inFlight, {});
    await h.services.worker.tick();
    assert.equal((await h.store.list('documents')).length, docs.length, 'and none of them is pulled in again');
  } finally {
    await h.cleanup();
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('papers read offline are read again with the AI once it answers, at most three times', async () => {
  const h = await makeHarness();
  try {
    const shipment = await withShipment(h);
    const invoice = (await h.store.list('documents')).find((d) => d.fileName === 'invoice.pdf');
    await h.store.put('documents', { ...invoice, needsAiRead: true, warnings: ['Read offline: the model timed out'] });
    h.ai.check = async () => ({ ok: false, message: 'still down' });
    await h.services.worker.tick();
    await h.services.idle();
    assert.equal((await h.store.get('documents', invoice.id)).needsAiRead, true, 'the AI is still down: nothing is read again');
    h.ai.check = async () => ({ ok: true });
    const extracts = h.ai.calls.extract;
    await h.services.worker.tick();
    await h.services.idle();
    const reread = await h.store.get('documents', invoice.id);
    assert.equal(h.ai.calls.extract, extracts + 1);
    assert.deepEqual([reread.status, reread.needsAiRead, reread.aiRereads], ['read', false, 1]);
    await h.store.put('documents', { ...reread, needsAiRead: true, aiRereads: 3 });
    await h.services.worker.tick();
    await h.services.idle();
    assert.equal(h.ai.calls.extract, extracts + 1, 'three tries are enough');
    assert.ok(shipment);
  } finally {
    await h.cleanup();
  }
});

test('an email too big to download is named once, for the house to add its papers by hand', async () => {
  const messages = Object.assign([], { tooBig: [{ uid: 5, from: 'ops@broker.example', subject: 'All scans', size: 80 * 1024 * 1024 }] });
  const h = await makeHarness({ mailMessages: messages });
  try {
    await h.services.mail.connect({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, domains: 'broker.example', pollNow: false });
    await h.services.mail.pollNow();
    assert.ok(h.activity.some((a) => a.action === 'error' && /ops@broker\.example \("All scans"\) is 80 MB, too big to bring in/.test(a.detail)));
  } finally {
    await h.cleanup();
  }
});

test('a lab check that could not run, or did not finish, never reads as "not found"', async () => {
  const h = await makeHarness();
  try {
    await withShipment(h);
    const [stone] = await h.store.list('stones');
    for (const [result, line] of [
      [{ status: 'unavailable', reason: 'NGL has no online report check' }, /could not be checked: NGL has no online report check$/],
      [{ status: 'incomplete' }, /was not checked: the check did not finish$/],
    ]) {
      const withLabs = createServices({ store: h.store, ai: h.ai, labsVerify: async () => ({ diffs: [], ...result }), pace: 0, modules: { ingest: fakeIngest, records: fakeRecords, rules: fakeRules, sanctions: h.sanctions, papers: fakePapers, mail: h.mail } });
      const seen = [];
      withLabs.events.on('activity', (a) => seen.push(a));
      await withLabs.verifyStone(stone.id, CLERK);
      await withLabs.idle();
      const detail = seen.find((a) => a.action === 'lab check').detail;
      assert.match(detail, line);
      assert.doesNotMatch(detail, /not found/);
    }
  } finally {
    await h.cleanup();
  }
});

test('the insured on an insurance certificate is screened like the other parties', () => {
  const parties = collectParties({ exporter: { name: 'SAMPLE Gems Exports' } }, [
    { fields: [{ key: 'insured.name', value: 'SAMPLE Diamant BV' }, { key: 'insurer.name', value: 'SAMPLE Cargo Insurance Ltd' }] },
  ]);
  assert.deepEqual(parties.map((p) => [p.name, p.roles]), [
    ['SAMPLE Gems Exports', ['exporter']], ['SAMPLE Diamant BV', ['insured']], ['SAMPLE Cargo Insurance Ltd', ['insurer']],
  ]);
});

test('a shared house takes a first paper\'s number from the server, and a first build waits while it is offline', async () => {
  const { store, cleanup } = await makeStore({ name: 'SAMPLE Gems Exports', environment: 'sandbox', autopilot: false });
  const handedOut = new Map();
  let online = true;
  store.reserveRef = async (stem, floor) => {
    if (!online) throw new Error('Could not get a paper number from Jewel Labs.');
    const next = Math.max(handedOut.get(stem) || 0, floor) + 4; // another computer took a few numbers meanwhile
    handedOut.set(stem, next);
    return next;
  };
  const h = await makeHarness({ store });
  try {
    const shipment = await withShipmentByHand(h);
    await answerAll(h);
    await h.services.run({ shipmentId: shipment.id, reason: 'test' });
    await h.services.idle();
    online = false;
    await assert.rejects(h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK }), /cannot be reached now/);
    assert.equal((await h.store.list('papers')).length, 0, 'no paper with a number another computer may take');
    online = true;
    const [pack] = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers;
    assert.equal(pack.ref, 'JL-EXP-1115-04');
    online = false; // a new version keeps its ref: no number is needed
    const [again] = (await h.services.buildPapers(shipment.id, { kinds: ['export_pack'], by: CLERK })).papers;
    assert.deepEqual([again.ref, again.version], ['JL-EXP-1115-04', 2]);
  } finally {
    await h.cleanup();
    await cleanup();
  }
});
