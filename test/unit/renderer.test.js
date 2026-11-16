// Tests for the screens' pure parts (src/renderer/lib), the browser demo (src/renderer/demo) and the
// page contract (index.html). They run in plain Node, offline, in a few seconds:
//   node --test test/unit/renderer.test.js
// With JL_UI_SHOTS=1 it also serves src/renderer and screenshots the main screens with Playwright into
// test/.tmp/ui-*.png (slow, opt-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as types from '../../src/core/types.js';
import { TEMPLATES } from '../../src/core/papers/templates.js';
import * as labels from '../../src/renderer/lib/labels.js';
import { parseHash, href, shellFor } from '../../src/renderer/lib/router.js';
import { reducer, initialState, stillNeeded, agentStripCounts, busyAgents, upsert } from '../../src/renderer/lib/store.js';
import * as fmt from '../../src/renderer/lib/format.js';
import { searchAll, squash } from '../../src/renderer/lib/search.js';
import { displayAgent, cursorPoint, parkPoint, layoutChips, labelKeyFields, boxesOf, latestReadDocument, activityChip, pace, readLine, actorAgentId } from '../../src/renderer/lib/reading.js';
import { makePdf, pageBuilder, textWidth } from '../../src/renderer/demo/mini-pdf.js';
import { makeQr } from '../../src/renderer/demo/qr.js';
import { EU_DDS_PARAGRAPHS, US_CBP_DIAMONDS } from '../../src/renderer/demo/sample-papers.js';
import { buildScriptedRun, A } from '../../src/renderer/demo/sample.js';
import { createMockApi } from '../../src/renderer/demo/mock-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, ms = 5000, what = 'a condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---------- the copies of shared labels stay the same as src/core ----------

test('label maps match src/core/types.js', () => {
  assert.deepEqual(labels.DOC_TYPE_LABELS, types.DOC_TYPE_LABELS);
  assert.deepEqual(labels.FIELD_LABELS, types.FIELD_LABELS);
  assert.deepEqual(labels.SHIPMENT_STATUS_LABELS, types.SHIPMENT_STATUS_LABELS);
  assert.deepEqual(labels.PAPER_KIND_LABELS, types.PAPER_KIND_LABELS);
  assert.deepEqual(labels.AGENTS, types.AGENTS);
});

test('the demo statements use the official wording from src/core/papers/templates.js', () => {
  assert.deepEqual(EU_DDS_PARAGRAPHS, TEMPLATES.eu_dds.paragraphs);
  assert.equal(US_CBP_DIAMONDS, TEMPLATES.us_cbp_certificate.diamonds);
});

// ---------- router ----------

test('parseHash reads routes, ids and queries', () => {
  assert.deepEqual(parseHash('#/shipments/abc?doc=d1&field=invoice.number'), { name: 'shipments', id: 'abc', sub: null, query: { doc: 'd1', field: 'invoice.number' }, known: true });
  assert.equal(parseHash('').name, 'home');
  assert.equal(parseHash('#/nonsense').name, 'home');
  assert.equal(parseHash('#/nonsense').known, false);
  const desk = parseHash('#/desk/shipments/shp-a?tab=checks');
  assert.equal(desk.name, 'desk');
  assert.equal(desk.id, 'shipments');
  assert.equal(desk.sub, 'shp-a');
  assert.equal(desk.query.tab, 'checks');
  assert.equal(shellFor(desk), 'desk');
  assert.equal(shellFor(parseHash('#/welcome')), 'welcome');
  assert.equal(shellFor(parseHash('#/papers')), 'house');
});

test('href builds hashes that parse back, with encoding', () => {
  const h = href('stones', 'NS/26 27', { q: 'a b', empty: '' });
  assert.equal(h, '#/stones/NS%2F26%2027?q=a%20b');
  const r = parseHash(h);
  assert.equal(r.id, 'NS/26 27');
  assert.equal(r.query.q, 'a b');
});

// ---------- store ----------

test('the reducer loads, upserts and removes records', () => {
  let s = initialState();
  s = reducer(s, { type: 'set-collection', collection: 'shipments', rows: [{ id: 'a', ref: 'A' }] });
  assert.equal(s.loaded.shipments, true);
  s = reducer(s, { type: 'upsert', collection: 'shipments', value: { id: 'b', ref: 'B' } });
  s = reducer(s, { type: 'upsert', collection: 'shipments', value: { id: 'a', status: 'signed' } });
  assert.deepEqual(s.data.shipments.map((x) => x.id), ['b', 'a']);
  assert.equal(s.data.shipments[1].ref, 'A'); // merged, not replaced
  assert.equal(s.data.shipments[1].status, 'signed');
  s = reducer(s, { type: 'remove', collection: 'shipments', id: 'b' });
  assert.deepEqual(s.data.shipments.map((x) => x.id), ['a']);
  assert.equal(reducer(s, { type: 'upsert', collection: 'nope', value: { id: 'x' } }), s);
  assert.equal(upsert([], { noId: true }).length, 0);
});

test('agent events mark agents busy until done, and toasts show once', () => {
  let s = initialState();
  const at = new Date().toISOString();
  s = reducer(s, { type: 'agent', event: { agent: 'intake', action: 'field', message: 'x', at } });
  s = reducer(s, { type: 'agent', event: { agent: 'records', action: 'done', message: 'y', at } });
  assert.ok(busyAgents(s).intake);
  assert.equal(busyAgents(s).records, undefined);
  assert.equal(s.agentEvents[0].agent, 'records');
  assert.equal(s.agentEvents[0].seq, 2);
  assert.deepEqual(busyAgents(s, Date.now() + 60000), {}); // gone quiet: stops pulsing
  s = reducer(s, { type: 'toast', toast: { title: 'Saved', text: 'ok' } });
  s = reducer(s, { type: 'toast', toast: { title: 'Saved', text: 'ok' } });
  assert.equal(s.toasts.length, 1);
  s = reducer(s, { type: 'dismiss-toast', id: s.toasts[0].id });
  assert.equal(s.toasts.length, 0);
});

test('stillNeeded and agentStripCounts summarise the house home', () => {
  let s = initialState();
  s = reducer(s, { type: 'set-collection', collection: 'shipments', rows: [{ id: 's1', ref: 'S1', status: 'collecting' }, { id: 's2', ref: 'S2', status: 'sent' }] });
  s = reducer(s, { type: 'set-collection', collection: 'questions', rows: [
    { id: 'q1', shipmentId: 's1', kind: 'missing_document', status: 'open', text: 'Packing list' },
    { id: 'q2', shipmentId: 's2', kind: 'missing_document', status: 'open', text: 'Ignored: sent' },
    { id: 'q3', shipmentId: 's1', kind: 'mismatch', status: 'open', text: 'Which carat?' },
  ] });
  s = reducer(s, { type: 'set-collection', collection: 'documents', rows: [{ id: 'd1', status: 'read', shipmentId: 's1' }, { id: 'd2', status: 'reading', fileName: 'b.pdf', shipmentId: null }] });
  const needs = stillNeeded(s);
  assert.equal(needs.length, 1);
  assert.equal(needs[0].missing[0].id, 'q1');
  const c = agentStripCounts(s);
  assert.deepEqual({ total: c.total, read: c.read, filed: c.filed, unfiled: c.unfiled, missing: c.missing }, { total: 2, read: 1, filed: 1, unfiled: 1, missing: 2 });
  assert.equal(c.reading.fileName, 'b.pdf');
});

// ---------- formatting ----------

test('format helpers write short plain text', () => {
  assert.equal(fmt.plural(1, 'document'), '1 document');
  assert.equal(fmt.plural(1200, 'document'), '1,200 documents');
  assert.equal(fmt.carat(0.7), '0.70 ct');
  assert.equal(fmt.money(32917, 'USD'), 'USD 32,917.00');
  assert.equal(fmt.route({ originCountry: 'IN', destinationCountry: 'BE' }), 'India to Belgium');
  assert.equal(fmt.shipmentStatus('ready_to_sign').text, 'Ready to sign');
  assert.equal(fmt.shipmentStatus('ready_to_sign').tone, 'ok');
  assert.equal(fmt.paperStatus('held_for_review').tone, 'warn');
  assert.equal(fmt.ago(new Date(Date.now() - 5 * 60000)), '5 min ago');
  assert.equal(fmt.phoneDigits('+91 98250 12345'), '919825012345');
  assert.equal(fmt.growthLabel('lab-grown'), 'Lab-grown');
  assert.equal(fmt.labCheckStatus({ status: 'mismatch' }).tone, 'fail');
  assert.match(fmt.maskEmail('ops@house.com'), /^o•+@house\.com$/);
  // No status text says the paper was "filed" by Jewel Labs.
  for (const s of ['draft', 'held_for_review', 'ready_to_sign', 'signed', 'sent']) assert.doesNotMatch(fmt.paperStatus(s).text, /filed/i);
});

// ---------- search (Cmd/Ctrl+K) ----------

test('search finds shipments, stones and report numbers', () => {
  const data = {
    shipments: [{ id: 's1', ref: 'KG/26-27/041', consignee: { name: 'Rhine Facet' } }],
    stones: [{ id: 'st1', reportNumber: '2211458734', lab: 'GIA', carat: 0.71 }],
    papers: [{ id: 'p1', ref: 'JL-EXP-1115-01', kind: 'export_pack', version: 1 }],
    documents: [{ id: 'd1', fileName: 'Invoice KG.pdf', docType: 'commercial_invoice', fields: [] }],
  };
  assert.equal(squash('kg/26-27 041'), 'KG2627041');
  const g = searchAll(data, 'kg 26 27 041');
  assert.equal(g[0].group, 'Shipments');
  assert.equal(g[0].items[0].id, 's1');
  assert.equal(searchAll(data, '2211458734')[0].items[0].kind, 'stone');
  const unknown = searchAll(data, '7712345678');
  assert.equal(unknown.at(-1).group, 'Stone history');
  assert.deepEqual(searchAll(data, '   '), []);
  assert.equal(searchAll(data, 'jl-exp-1115')[0].items[0].kind, 'paper');
});

// ---------- the agents-reading view ----------

test('each field goes to the agent that checks it', () => {
  assert.equal(displayAgent('consignee.name'), 'sanctions');
  assert.equal(displayAgent('invoice.number'), 'records');
  assert.equal(displayAgent('kp.countriesOfMining'), 'origin');
  assert.equal(displayAgent('goods.totalCarats'), 'intake');
  assert.equal(displayAgent('goods.totalCarats', 'intake', 0.6), 'review'); // unsure readings go to Review
  assert.equal(displayAgent('x', 'paperwork'), 'intake'); // no cursor for paperwork: Intake shows it
  const p = cursorPoint([0.1, 0.2, 0.3, 0.3]);
  assert.ok(p.x > 10 && p.x < 30 && p.y > 20 && p.y < 30);
  assert.ok(parkPoint('intake').y > parkPoint('origin').y);
  assert.ok(pace(40) < pace(0));
  assert.equal(readLine('intake', 'Invoice number', 'KG/26-27/041'), 'Intake agent read Invoice number: KG/26-27/041');
  assert.equal(actorAgentId({ type: 'agent', name: 'Sanctions' }), 'sanctions');
  assert.equal(actorAgentId({ type: 'person', name: 'Asha' }), null);
});

test('label chips stay on the page and never cover each other', () => {
  const boxes = [];
  for (let i = 0; i < 12; i++) boxes.push({ id: `b${i}`, key: `k${i}`, label: `Field number ${i}: value ${i}`, box: [0.1 + (i % 2) * 0.4, 0.1 + Math.floor(i / 2) * 0.03, 0.3 + (i % 2) * 0.4, 0.12 + Math.floor(i / 2) * 0.03] });
  const laid = layoutChips(boxes, { max: 6 });
  const withChip = laid.filter((b) => b.chip);
  assert.ok(withChip.length > 0 && withChip.length <= 6);
  assert.ok(laid.slice(0, 6).every((b) => b.chip === false)); // older boxes keep just their outline
  const still = labelKeyFields([{ id: 'a', key: 'goods.description', label: 'Goods: x', box: [0.1, 0.1, 0.2, 0.12] }, { id: 'b', key: 'invoice.number', label: 'Invoice number: 1', box: [0.1, 0.5, 0.2, 0.52] }]);
  assert.equal(still.find((b) => b.key === 'invoice.number').chip, 'right');
  assert.equal(still.find((b) => b.key === 'goods.description').chip, false);
});

test('boxesOf and latestReadDocument pick what the still view shows', () => {
  const doc = { id: 'd', status: 'read', readAt: '2026-11-15T10:00:00Z', fields: [
    { key: 'invoice.number', value: 'X1', page: 1, box: [0.1, 0.1, 0.2, 0.12] },
    { key: 'doc.date', value: '', page: 1, box: [0.1, 0.2, 0.2, 0.22] },
    { key: 'goods.totalCarats', value: '4.85', page: 2, box: [0.1, 0.3, 0.2, 0.32] },
  ] };
  assert.deepEqual(boxesOf(doc, 1).map((b) => b.key), ['invoice.number']);
  assert.equal(boxesOf(doc, 2)[0].label, 'Carats: 4.85');
  const older = { ...doc, id: 'old', readAt: '2026-11-01T00:00:00Z' };
  const chat = { ...doc, id: 'chat', kind: 'chat', readAt: '2026-11-16T00:00:00Z' };
  assert.equal(latestReadDocument([older, doc, chat]).id, 'd');
  assert.equal(activityChip('read').text, 'Read');
  assert.equal(activityChip('missing').tone, 'warn');
  assert.equal(activityChip('lab check').text, 'Lab');
});

// ---------- the demo's PDF writer and QR codes ----------

test('mini-pdf writes a PDF that pdf.js reads, with field boxes on the printed text', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const p = pageBuilder();
  p.text(40, 60, 'COMMERCIAL INVOICE (SAMPLE)', { size: 16, font: 'B' });
  p.value('invoice.number', 300, 100, 'NS/26-27/041', { size: 10 });
  p.line(40, 120, 555, 120);
  const bytes = makePdf([{ ops: p.ops }, { ops: [{ t: 'text', x: 50, y: 50, text: 'Page two (\\ and parens)', size: 9 }] }], { title: 'Test' });
  const doc = await pdfjs.getDocument({ data: bytes, standardFontDataUrl: path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep, verbosity: 0 }).promise;
  assert.equal(doc.numPages, 2);
  const items = (await (await doc.getPage(1)).getTextContent()).items.filter((i) => i.str);
  const value = items.find((i) => i.str === 'NS/26-27/041');
  assert.ok(value, 'the value is in the text layer');
  const [x0, y0, x1] = p.fields[0].box;
  assert.ok(Math.abs(value.transform[4] - x0 * 595.28 - 2) < 0.5, 'the box starts where the text starts');
  assert.ok(Math.abs(value.width - textWidth('NS/26-27/041', 'R', 10)) < 0.5, 'our text width matches pdf.js');
  assert.ok(x1 > x0 && y0 > 0 && y0 < 0.13);
  const page2 = (await (await doc.getPage(2)).getTextContent()).items.map((i) => i.str).join('');
  assert.equal(page2, 'Page two (\\ and parens)');
  await doc.loadingTask.destroy();
});

test('qr.js matches the qrcode package module for module', () => {
  const QRCode = require('qrcode');
  for (const text of ['https://wa.me/919825012345', 'hi', 'x'.repeat(90)]) {
    for (const mask of [0, 3, 6]) {
      const mine = makeQr(text, { mask });
      const ref = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M', maskPattern: mask, version: mine.version });
      assert.equal(mine.size, ref.modules.size);
      for (let y = 0; y < mine.size; y++) for (let x = 0; x < mine.size; x++) assert.equal(mine.modules[y][x], Boolean(ref.modules.get(y, x)), `${text.length} chars, mask ${mask}, module ${x},${y}`);
    }
  }
  assert.throws(() => makeQr('x'.repeat(400)), /too long/);
});

// ---------- the browser demo API ----------

test('the scripted run has the documented shape and only fictional SAMPLE parties', async () => {
  const run = await buildScriptedRun(Date.parse('2026-11-15T10:00:00Z'));
  assert.equal(run.meta.format, 1);
  assert.equal(run.meta.recorded, false);
  assert.ok(run.steps.length > 100);
  assert.ok(run.steps.every((s) => typeof s.t === 'number' && ['put', 'remove', 'event'].includes(s.kind) && s.name && s.payload));
  assert.ok(run.steps.every((s, i) => i === 0 || s.t >= run.steps[i - 1].t), 'steps are in time order');
  const fields = run.steps.filter((s) => s.kind === 'event' && s.name === 'agent' && s.payload.action === 'field');
  assert.ok(fields.length > 40);
  assert.ok(fields.every((s) => s.payload.box.every((n) => n >= 0 && n <= 1) && s.payload.box[2] > s.payload.box[0] && s.payload.box[3] > s.payload.box[1]));
  const parties = run.steps.filter((s) => s.kind === 'put' && s.name === 'parties').map((s) => s.payload.name);
  assert.ok(parties.length && parties.every((n) => /\(SAMPLE\)/.test(n)));
  const text = JSON.stringify(run.steps);
  assert.doesNotMatch(text, /\bfiled by Jewel Labs\b/i);
  assert.ok(run.files['doc-a-inv'].bytes.length > 1000);
});

test('the demo API plays the run, answers, builds, signs and keeps the desktop rules', async () => {
  const run = await buildScriptedRun(Date.now());
  const jl = createMockApi({ run, fetchRun: false, speed: 1000 });
  await jl.ready();
  const changes = [];
  jl.on('change', (c) => changes.push(c));

  // The end state of the run: four shipments, one open question on NS/26-27/041.
  const shipments = await jl.shipments.list();
  assert.equal(shipments.length, 4);
  const questions = await jl.questions.list({ status: 'open' });
  const q = questions.find((x) => x.shipmentId === A.id);
  assert.ok(q && q.options.length === 2);
  assert.equal((await jl.shipments.get(A.id)).status, 'questions');

  // A file comes back as bytes (a real PDF).
  const file = await jl.docs.file('doc-a-inv');
  assert.equal(String.fromCharCode(...file.bytes.slice(0, 4)), '%PDF');

  // Answering builds the EU statement and the export pack, ready to sign.
  await jl.questions.answer(q.id, q.options[0]);
  await until(async () => (await jl.papers.list({ shipmentId: A.id })).length === 2, 5000, 'the papers');
  const papers = await jl.papers.list({ shipmentId: A.id });
  assert.deepEqual(papers.map((p) => p.kind).sort(), ['eu_dds', 'export_pack']);
  assert.ok(papers.every((p) => p.status === 'ready_to_sign' && /^[0-9a-f]{64}$/.test(p.sha256)));
  assert.ok(changes.some((c) => c.collection === 'papers' && c.op === 'put'));

  // Signing needs a name, locks the paper with a new hash, and sending says the demo cannot email.
  const pack = papers.find((p) => p.kind === 'export_pack');
  assert.match((await jl.papers.sign(pack.id, { name: '' })).error, /name/);
  const signed = await jl.papers.sign(pack.id, { name: 'Asha Mehta', title: 'Director' });
  assert.equal(signed.status, 'signed');
  assert.notEqual(signed.sha256, pack.sha256);
  assert.match((await jl.papers.sign(pack.id, { name: 'Again' })).error, /already signed/);
  const sent = await jl.papers.send(pack.id, { to: 'broker@example.com' });
  assert.equal(sent.code, 'no_mailbox');
  const pdf = await jl.papers.file(pack.id);
  assert.equal(String.fromCharCode(...pdf.bytes.slice(0, 4)), '%PDF');

  // The desk approves the held Hong Kong pack.
  const queue = await jl.desk.queue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].checks[0].severity, 'warn');
  const approved = await jl.desk.approve(queue[0].paper.id, 'Same company. Approved.');
  assert.equal(approved.status, 'ready_to_sign');
  assert.equal((await jl.desk.queue()).length, 0);

  // A stone's history runs from the mine to the flight, each step tied to its paper.
  const history = await jl.stones.history('2211 4587 34');
  assert.equal(history.stone.reportNumber, '2211458734');
  const kinds = history.events.map((e) => e.kind);
  for (const k of ['mined', 'rough_purchased', 'cut_and_polished', 'graded', 'invoiced', 'packed', 'cleared_for_export', 'flown', 'statement_drafted']) assert.ok(kinds.includes(k), k);
  assert.ok(history.events.find((e) => e.kind === 'mined').docId);
  assert.equal((await jl.stones.history('0000000000')).stone, null);

  // The demo never takes a key, a mailbox password or an account.
  assert.match((await jl.settings.set({ openaiKey: ['sk', 'test', 'abc123'].join('-') })).error, /never takes an API key/);
  assert.match((await jl.mail.connect({ email: 'a@b.c', appPassword: 'x' })).error, /desktop app/);
  assert.match((await jl.auth.signIn({ email: 'a@b.c', password: 'x' })).error, /desktop app/);

  // Screening: sample parties are clear; any other name is sent to review, never passed blindly.
  assert.equal((await jl.sanctions.screen('Rhine Facet BV (SAMPLE)')).status, 'clear');
  assert.equal((await jl.sanctions.screen('Some Real Company Ltd')).status, 'review');

  const metrics = await jl.metrics.get();
  assert.equal(metrics.houses.length, 2);
  assert.ok(metrics.houses[0].packsSigned >= 3);
  assert.equal(typeof (await jl.app.info()).version, 'string');
  assert.equal((await jl.app.info()).ai.mode, 'demo');
});

test('the demo replays the run live from the start', async () => {
  const run = await buildScriptedRun(Date.now());
  const jl = createMockApi({ run, fetchRun: false, speed: 400, autoStart: false });
  await jl.ready();
  assert.equal((await jl.shipments.list()).length, 0);
  const agentEvents = [];
  jl.on('agent', (e) => agentEvents.push(e));
  await jl.demo.load();
  await until(async () => (await jl.questions.list({ status: 'open', shipmentId: A.id })).length === 1, 5000, 'the run to reach its question');
  assert.ok(agentEvents.some((e) => e.action === 'field' && e.docId === 'doc-a-inv'));
  assert.ok(agentEvents.some((e) => e.agent === 'sanctions'));
  assert.equal((await jl.demo.status()).recorded, false);
  const added = await jl.docs.add([{ name: 'notes.txt', bytes: new TextEncoder().encode('hello') }]);
  assert.equal(added.documentIds.length, 1);
  await until(async () => (await jl.docs.get(added.documentIds[0])).status === 'read', 3000, 'the demo reader');
});

// ---------- the page contract ----------

test('index.html has the strict CSP and no inline scripts or styles', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  assert.match(html, /content="default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'self' blob:; font-src 'self'; connect-src 'self' data: blob:"/);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.doesNotMatch(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''), /<script/);
  assert.doesNotMatch(html, /style="/);
  assert.doesNotMatch(html, /<style/);
  for (const sheet of ['tokens', 'app', 'motion']) assert.ok(fs.existsSync(path.join(RENDERER, 'styles', `${sheet}.css`)));
});

test('the screens never use style="..." strings, <style> tags, or words the brand avoids', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'vendor' || name === 'fonts') continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|html|css|md|json)$/.test(name)) files.push(p);
    }
  };
  walk(RENDERER);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.js')) {
      assert.doesNotMatch(text, /\sstyle="/, `${f} sets style with a string`);
      assert.doesNotMatch(text, /<style[\s>]/, `${f} has a style tag`);
      assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]{8,}/, `${f} has something that looks like a key`);
    }
    assert.doesNotMatch(text, /\bY Combinator\b|\bYC\b|\bBrad\b/, `${f} names something it must not`);
    assert.doesNotMatch(text, /—/, `${f} has an em dash`);
  }
});

// ---------- optional: screenshots of the main screens (JL_UI_SHOTS=1) ----------

function serve(root) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => (err ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(buf)));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function chromiumPath() {
  if (process.env.JL_CHROMIUM) return process.env.JL_CHROMIUM;
  const cache = path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    const exe = path.join(cache, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

test('screenshots of the main screens (JL_UI_SHOTS=1)', { skip: process.env.JL_UI_SHOTS !== '1', timeout: 240000 }, async () => {
  const { chromium } = await import('playwright');
  const server = await serve(RENDERER);
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const out = path.join(ROOT, 'test', '.tmp');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    const shot = (name) => page.screenshot({ path: path.join(out, `ui-${name}.png`) });
    await page.goto(`${base}#/welcome`);
    await page.waitForTimeout(1200);
    await shot('welcome');
    await page.getByRole('button', { name: /Try the sample shipment/ }).click();
    await page.waitForTimeout(14000);
    await page.evaluate(() => { const r = document.querySelector('.reader'); document.querySelector('.page').scrollTop = r.offsetTop - 150; });
    await page.waitForTimeout(600);
    await shot('home');
    for (const [name, hash, wait] of [['shipment', '#/shipments/shp-b?doc=doc-b-inv&field=invoice.number', 2500], ['stones', '#/stones/614208835', 1800], ['papers', '#/papers/pap-b-exp', 3000], ['desk', '#/desk', 2000], ['metrics', '#/desk/metrics', 1500]]) {
      await page.goto(base + hash);
      await page.waitForTimeout(wait);
      await shot(name);
    }
    await page.goto(`${base}#/desk`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByPlaceholder('+91 98250 00000').fill('+91 98250 12345');
    await page.waitForTimeout(800);
    await shot('onboard');
  } finally {
    await browser.close();
    server.close();
  }
  assert.deepEqual(problems, []);
});
