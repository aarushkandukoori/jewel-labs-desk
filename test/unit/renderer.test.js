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
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as types from '../../src/core/types.js';
import { HISTORY_STAGES } from '../../src/core/records/history.js';
import { LABS } from '../../src/core/labs/index.js';
import * as labels from '../../src/renderer/lib/labels.js';
import { parseHash, href, shellFor } from '../../src/renderer/lib/router.js';
import { reducer, initialState, stillNeeded, agentStripCounts, busyAgents, upsert, COLLECTIONS, piecesOf, sortStones, isLot } from '../../src/renderer/lib/store.js';
import * as fmt from '../../src/renderer/lib/format.js';
import { paperNote, sendBody, isImporterDraft } from '../../src/renderer/lib/papers.js';
import { modelText, aiUnreachable } from '../../src/renderer/components/status-bar.js';
import { questionLabel } from '../../src/renderer/components/questions.js';
import { searchAll, squash } from '../../src/renderer/lib/search.js';
import { displayAgent, cursorPoint, parkPoint, layoutChips, labelKeyFields, boxesOf, latestReadDocument, activityChip, pace, readLine, actorAgentId } from '../../src/renderer/lib/reading.js';
import { makeQr } from '../../src/renderer/demo/qr.js';
import { createMockApi, shiftTimes } from '../../src/renderer/demo/mock-api.js';

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

test('every other copy of a src/core list in the screens stays the same as its original', () => {
  // Each history stage has exactly one step on the stone timeline.
  for (const kind of HISTORY_STAGES) assert.equal(labels.HISTORY_STEPS.filter((s) => s.kinds.includes(kind)).length, 1, kind);
  assert.deepEqual(labels.HISTORY_STEPS.flatMap((s) => s.kinds).sort(), [...HISTORY_STAGES].sort());
  assert.deepEqual(Object.keys(labels.SOURCE_LABELS).sort(), [...types.SOURCE_KINDS].sort());
  assert.deepEqual(Object.keys(labels.ROLE_LABELS).sort(), [...types.ROLES].sort());
  // The screens keep every collection but the usage log.
  assert.deepEqual(COLLECTIONS, types.COLLECTIONS.filter((c) => c !== 'events'));
  // The labs the app can check online.
  assert.deepEqual([...fmt.LABS_WITH_ONLINE_CHECK].sort(), Object.keys(LABS).sort());
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

test('a paper date shows the same day west of UTC', () => {
  const was = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.equal(fmt.day('2026-11-12'), '12 Nov 2026');
    assert.equal(fmt.day('2026-03-15'), '15 Mar 2026');
    assert.equal(fmt.day('2026-11-12T03:00:00.000Z'), '11 Nov 2026'); // a timestamp still shows in local time
    assert.equal(fmt.day(''), '');
    assert.equal(fmt.day('garbage'), '');
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test('a lab check that could not run reads "Could not check", and Verify is offered only where a lab check exists', () => {
  assert.deepEqual(fmt.labCheckStatus({ status: 'unavailable' }), { text: 'Could not check', tone: 'muted' });
  assert.deepEqual(fmt.labCheckStatus({ status: 'incomplete' }), { text: 'Could not check', tone: 'muted' });
  assert.equal(fmt.labCheckStatus({ status: 'not_found' }).tone, 'warn');
  assert.deepEqual(fmt.labCheckToast({ status: 'unavailable', reason: 'NGL has no online report check.' }), { text: 'Could not check: NGL has no online report check.', tone: 'info' });
  assert.deepEqual(fmt.labCheckToast({ status: 'not_found' }), { text: 'Not found', tone: 'warn' });
  assert.deepEqual(fmt.labCheckToast({ status: 'mismatch', reason: 'x' }).tone, 'error');
  assert.deepEqual(fmt.labCheckToast({ status: 'match' }), { text: 'Matches lab', tone: 'ok' });
  assert.equal(fmt.canCheckOnline({ reportNumber: '2141438171', lab: 'GIA' }), true);
  assert.equal(fmt.canCheckOnline({ reportNumber: '2141438171', lab: null }), true); // the app tells the lab from the number
  assert.equal(fmt.canCheckOnline({ reportNumber: '7391020001', lab: 'Northbridge Gem Laboratory (SAMPLE)' }), false);
  assert.equal(fmt.canCheckOnline({ reportNumber: null, lab: 'GIA' }), false);
});

test('the closest SDN name shows only for a name worth a look', () => {
  const best = { sdnName: 'JOINT STOCK COMPANY SALEK', score: 0.43 };
  assert.equal(fmt.closestSdnName({ status: 'clear', best }), null);
  assert.equal(fmt.closestSdnName({ status: 'review', best }), 'JOINT STOCK COMPANY SALEK (43%)');
  assert.equal(fmt.closestSdnName({ status: 'match', best: { sdnName: 'X', score: 0.97 } }), 'X (97%)');
  assert.equal(fmt.closestSdnName(null), null);
});

test('an importer statement on an export is checked by the house and sent to the importer, never to the broker "to lodge"', () => {
  const exportShipment = { id: 's1', ref: 'KG/26-27/041', direction: 'export', consignee: { name: 'Lumen Diamant BV (SAMPLE)' } };
  const dds = { kind: 'eu_dds', ref: 'JL-DDS-1116-01', version: 1, shipmentId: 's1' };
  assert.equal(isImporterDraft(dds, exportShipment), true);
  assert.equal(isImporterDraft(dds, { ...exportShipment, direction: 'import' }), false);
  assert.equal(isImporterDraft({ ...dds, kind: 'export_pack' }, exportShipment), false);
  assert.match(paperNote({ ...dds, status: 'ready_to_sign' }, { shipment: exportShipment }), /Draft for Lumen Diamant BV \(SAMPLE\)\. .*the importer signs the statement/);
  assert.match(paperNote({ ...dds, status: 'signed', signedBy: 'Asha Mehta (SAMPLE)' }, { shipment: exportShipment }), /^Checked by Asha Mehta \(SAMPLE\)\. Send it to the importer to sign\.$/);
  assert.match(paperNote({ ...dds, status: 'sent', sentTo: 'buying@lumen.example.com' }, { shipment: exportShipment }), /for the importer to sign/);
  const body = sendBody({ ...dds, status: 'signed' }, { shipment: exportShipment, house: 'Kavya Gems LLP (SAMPLE)', signer: 'Asha' });
  assert.match(body, /Attached is the EU Due Diligence Statement \(draft\) JL-DDS-1116-01 for shipment KG\/26-27\/041, prepared and checked by Kavya Gems LLP \(SAMPLE\)\. Please sign it as the importer\./);
  assert.doesNotMatch(body, /lodge|originals/i);
  assert.doesNotMatch(body, /\beu due/); // the label keeps its capitals
  // The house's own pack still goes to its broker, with the originals.
  const pack = sendBody({ kind: 'export_pack', ref: 'JL-EXP-1116-01', status: 'signed' }, { shipment: exportShipment, house: 'Kavya Gems LLP (SAMPLE)' });
  assert.match(pack, /Attached is the signed Export pack JL-EXP-1116-01 .*The originals follow in the order customs reads them\.\n\nPlease lodge it with the declaration\./);
  // On an import the house is the importer: its signed statement goes to its broker, without "(draft)" or originals.
  const imported = sendBody({ ...dds, status: 'signed' }, { shipment: { ...exportShipment, direction: 'import' }, house: 'H' });
  assert.match(imported, /Attached is the signed EU Due Diligence Statement JL-DDS-1116-01/);
  assert.doesNotMatch(imported, /originals|\(draft\)/);
});

test('a held pack in a local workspace says what failed instead of promising a review', () => {
  const held = { kind: 'export_pack', status: 'held_for_review' };
  const checks = [{ severity: 'fail', title: 'Russian origin on the KP certificate' }, { severity: 'pass', title: 'Totals agree' }];
  assert.match(paperNote(held, { checks, signedIn: true }), /Jewel Labs checks it before you sign/);
  const local = paperNote(held, { checks, signedIn: false });
  assert.match(local, /^A check failed: Russian origin on the KP certificate\. Fix it and run the agents again, or sign in/);
  assert.doesNotMatch(local, /You get a message/);
  assert.match(paperNote(held, { checks: [], signedIn: false }), /Sign in so Jewel Labs can review it/);
});

test('the status bar names the offline reader while the AI is unreachable', () => {
  const now = Date.parse('2026-11-16T10:00:00Z');
  const ai = { mode: 'direct', model: 'gpt-5.4-mini', lastError: null };
  assert.equal(modelText({ ai }, now), 'gpt-5.4-mini · your OpenAI key');
  const failing = { ...ai, lastError: { message: 'fetch failed', at: '2026-11-16T09:58:00Z' } };
  assert.equal(aiUnreachable(failing, now), true);
  assert.equal(modelText({ ai: failing }, now), 'Offline reader (AI unreachable)');
  assert.equal(modelText({ ai: failing }, now + 60 * 60000), 'gpt-5.4-mini · your OpenAI key'); // an old problem
  assert.equal(modelText({ ai: { ...ai, lastError: { message: 'No key', at: null } } }, now), 'gpt-5.4-mini · your OpenAI key');
  assert.equal(modelText({ ai: { mode: 'off' } }, now), 'Offline reader');
  assert.equal(modelText({}, now), 'Offline reader');
});

test('a parcel counts every stone in its lots, and single stones come before lots', () => {
  const stones = [
    { id: 'a', shipmentId: 's', carat: 0.9, pieces: 1 }, { id: 'b', shipmentId: 's', carat: 94.88, pieces: 119 },
    { id: 'c', shipmentId: 's', carat: 1.52 }, { id: 'd', shipmentId: 's', carat: 59.97, pieces: 79 },
  ];
  assert.equal(piecesOf({ id: 's', totals: { pieces: 200 } }, stones), 200);
  assert.equal(piecesOf({ id: 's', totals: {} }, stones), 200);
  assert.equal(piecesOf({ id: 'other', totals: {} }, stones), '');
  assert.deepEqual(sortStones(stones).map((s) => s.id), ['c', 'a', 'b', 'd']);
  assert.equal(isLot(stones[1]), true);
  assert.equal(isLot(stones[2]), false);
});

// ---------- search (Cmd/Ctrl+K) ----------

test('search finds shipments, stones and report numbers', () => {
  const data = {
    shipments: [{ id: 's1', ref: 'KG/26-27/041', consignee: { name: 'Rhine Facet' } }],
    stones: [{ id: 'st1', reportNumber: '7391020002', lab: 'Northbridge Gem Laboratory (SAMPLE)', carat: 0.7 }],
    papers: [{ id: 'p1', ref: 'JL-EXP-1115-01', kind: 'export_pack', version: 1 }],
    documents: [{ id: 'd1', fileName: 'Invoice KG.pdf', docType: 'commercial_invoice', fields: [] }],
  };
  assert.equal(squash('kg/26-27 041'), 'KG2627041');
  const g = searchAll(data, 'kg 26 27 041');
  assert.equal(g[0].group, 'Shipments');
  assert.equal(g[0].items[0].id, 's1');
  assert.equal(searchAll(data, '7391020002')[0].items[0].kind, 'stone');
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

// ---------- the QR codes ----------

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

// ---------- the browser demo API (replays the recorded run in demo/sample-run.json) ----------

const DEMO_DIR = path.join(RENDERER, 'demo');

function recordedRun() {
  const file = path.join(DEMO_DIR, 'sample-run.json');
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')), baseUrl: pathToFileURL(file).href };
}

/** The end state of a recorded run, worked out from its steps: { collection: [records] }. */
function endState(run) {
  const out = {};
  for (const step of run.steps) {
    const table = (out[step.name] ||= new Map());
    if (step.kind === 'put') table.set(step.payload.id, { ...(table.get(step.payload.id) || {}), ...step.payload });
    else if (step.kind === 'remove') table.delete(step.payload.id);
  }
  return Object.fromEntries(Object.entries(out).map(([name, table]) => [name, [...table.values()]]));
}

// The demo fetches the recording's files next to sample-run.json; Node's fetch cannot read file:// addresses.
async function withFileFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return real(url, init);
    const file = fileURLToPath(u);
    if (!fs.existsSync(file)) return new Response('', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('shiftTimes moves the recording\'s own times only', () => {
  const start = Date.parse('2026-11-16T05:26:32.918Z');
  const value = {
    at: '2026-11-16T05:28:13.789Z', history: [{ at: '2026-03-15' }, { at: '2026-11-16T05:28:18.842Z' }],
    chat: { at: '2026-11-10T11:52:18' }, email: '2026-11-09T08:00:00.000Z', n: 3,
  };
  const moved = shiftTimes(value, 60000, start - 600000, start + 3600000);
  assert.equal(moved.at, '2026-11-16T05:29:13.789Z');
  assert.deepEqual(moved.history, [{ at: '2026-03-15' }, { at: '2026-11-16T05:29:18.842Z' }]);
  assert.equal(moved.chat.at, '2026-11-10T11:52:18'); // a chat time from the papers
  assert.equal(moved.email, '2026-11-09T08:00:00.000Z'); // before the recording
  assert.equal(moved.n, 3);
});

test('the demo shows the recorded house, its people, papers and files, as if the run just happened', () => withFileFetch(async () => {
  const run = recordedRun();
  const recorded = endState(run);
  const jl = createMockApi({ run, fetchRun: false, speed: 1000 });
  await jl.ready();
  assert.equal((await jl.demo.status()).recorded, true);

  // The recorded house and nothing else: no field of a made-up house is mixed in.
  const house = await jl.workspaces.current();
  assert.equal(house.name, run.workspace.name);
  assert.deepEqual(house.letterhead, run.workspace.letterhead);
  assert.deepEqual(Object.keys(house).sort(), [...new Set([...Object.keys(run.workspace), 'id', 'kind', 'sample', 'autopilot', 'createdAt', 'role'])].sort());
  // Its customer logins are the people of the recording (and the visitor).
  const people = [...new Set(recorded.activity.filter((a) => a.actor?.type === 'person').map((a) => a.actor.name))];
  assert.ok(people.length > 0);
  assert.deepEqual((await jl.workspaces.members()).filter((m) => !m.you).map((m) => m.name).sort(), people.sort());
  const everything = JSON.stringify([await jl.workspaces.list(), await jl.shipments.list(), await jl.stones.list(), await jl.parties.list()]);
  assert.doesNotMatch(everything, /Nilgiri|nilgiri-star|NS\/26-27|2211458/);

  // The recorded times end now; the papers' own dates (a plain day) stay as the papers say.
  const [latest] = await jl.activity.list({ limit: 1 });
  assert.ok(Math.abs(Date.now() - Date.parse(latest.at)) < 2 * 60000, `latest activity at ${latest.at}`);
  const stone = recorded.stones.find((x) => x.reportNumber && (x.history || []).some((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.at || '')));
  const history = await jl.stones.history(stone.reportNumber);
  assert.deepEqual(history.events.map((e) => e.kind), stone.history.map((e) => e.kind));
  const paperDay = stone.history.find((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.at || ''));
  assert.equal(history.events.find((e) => e.kind === paperDay.kind).at, paperDay.at);

  // A document opens under its own name; a paper opens as its recorded PDF.
  const doc = recorded.documents.find((d) => run.files[d.id] && /\.(xlsx|pdf)$/.test(d.fileName));
  const file = await jl.docs.file(doc.id);
  assert.equal(file.name, doc.fileName);
  assert.equal(file.bytes.length, fs.statSync(path.join(DEMO_DIR, run.files[doc.id])).size);
  const paper = recorded.papers[0];
  const pdf = await jl.papers.file(paper.id);
  assert.equal(pdf.name, path.basename(run.files[`${paper.id}:${paper.version}:${paper.status}`]));
  assert.equal(String.fromCharCode(...pdf.bytes.slice(0, 4)), '%PDF');

  // The OFAC list and screenings are the recorded ones; a name the recording never screened is never "clear".
  const party = recorded.parties.find((x) => x.listCount);
  assert.equal((await jl.sanctions.status()).count, party.listCount);
  const screened = await jl.sanctions.screen(party.name);
  assert.equal(screened.status, party.status);
  assert.equal(screened.compared, party.compared);
  for (const name of ['Some Real Company Ltd', 'Meridian Stones (SAMPLE)']) assert.equal((await jl.sanctions.screen(name)).status, 'review', name);

  const metrics = await jl.metrics.get();
  assert.equal(metrics.houses.find((h) => h.id === house.id).inTotals, false, 'a sandbox house stays out of the totals');
  assert.equal(metrics.totals.autonomyRate, null);
  assert.equal((await jl.app.info()).ai.mode, 'demo');
}));

test('the demo answers, signs and sends in memory, and never claims what it did not do', () => withFileFetch(async () => {
  const run = recordedRun();
  const jl = createMockApi({ run, fetchRun: false, speed: 1000 });
  await jl.ready();
  const notices = [];
  jl.on('notify', (n) => notices.push(n));

  // "Not needed" closes a recorded missing paper; the shipment keeps its recorded status.
  const missing = (await jl.questions.list({ status: 'open' })).find((q) => q.kind === 'missing_document');
  const before = await jl.shipments.get(missing.shipmentId);
  const answered = await jl.questions.answer(missing.id, 'Not needed');
  assert.equal(answered.question.status, 'answered');
  assert.equal(answered.question.answer, 'Not needed');
  assert.ok((await jl.shipments.get(missing.shipmentId)).notNeeded.includes(missing.docType));
  await sleep(20);
  assert.equal((await jl.shipments.get(missing.shipmentId)).status, before.status);
  assert.match((await jl.questions.answer(missing.id, 'again')).error, /already closed/);

  // Signing needs a name; the paper then opens as the copy signed while recording, and a notice says so.
  const papers = await jl.papers.list();
  const pack = papers.find((x) => x.kind === 'export_pack');
  const statement = papers.find((x) => x.kind === 'eu_dds' || x.kind === 'us_cbp_certificate');
  const shipment = await jl.shipments.get(pack.shipmentId);
  assert.match((await jl.papers.send(pack.id, { to: 'broker@example.com' })).error, /Sign the paper first/);
  assert.match((await jl.papers.sign(pack.id, { name: '' })).error, /name/);
  const signed = await jl.papers.sign(pack.id, { name: 'Visitor (SAMPLE)', title: 'Director' });
  assert.equal(signed.status, 'signed');
  assert.equal(signed.signedBy, 'Visitor (SAMPLE)');
  assert.notEqual(signed.sha256, pack.sha256);
  assert.equal((await jl.papers.file(pack.id)).name, path.basename(run.files[`${pack.id}:${pack.version}:signed`]));
  assert.ok(notices.some((n) => /recorded signature/.test(n.title)));
  assert.match((await jl.papers.sign(pack.id, { name: 'Again' })).error, /already signed/);

  // On an export the statement is the importer's: the history says the house checked it and sent it to the importer.
  assert.equal(shipment.direction, 'export');
  await jl.papers.sign(statement.id, { name: 'Visitor (SAMPLE)', title: 'Director' });
  assert.match((await jl.papers.send(statement.id, { to: 'not an email' })).error, /email addresses/);
  const sent = await jl.papers.send(statement.id, { to: 'importer@example.com' });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentTo, 'importer@example.com');
  const stone = (await jl.stones.list()).find((x) => x.shipmentId === pack.shipmentId && x.reportNumber);
  const events = (await jl.stones.history(stone.reportNumber)).events;
  assert.ok(events.some((e) => / checked by the house$/.test(e.title) && /Visitor \(SAMPLE\)/.test(e.detail)));
  assert.ok(events.some((e) => / sent to the importer$/.test(e.title)));
  assert.ok(events.some((e) => e.title === 'Export pack signed'));
  const audit = (await jl.activity.list()).map((a) => a.detail).join('\n');
  assert.match(audit, /as sent to importer@example\.com \(demo: no email left this tab\)/);

  // Lab checks, agent runs and builds say what the desktop app does; nothing is made up.
  const check = await jl.stones.verify(stone.id);
  assert.equal(check.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(check), /match/);
  assert.deepEqual(await jl.agents.run({}), { ran: false, demo: true });
  const without = (await jl.shipments.list()).find((x) => !papers.some((p) => p.shipmentId === x.id));
  assert.match((await jl.papers.build(without.id)).error, new RegExp(`This recording has papers for ${shipment.ref.replace(/\//g, '\\/')} only`));
  assert.equal((await jl.papers.build(pack.shipmentId)).length, papers.filter((p) => p.shipmentId === pack.shipmentId).length);

  // A visitor is not the Jewel Labs desk, and onboarding opens the new house.
  assert.match((await jl.desk.approve(pack.id, 'ok')).error, /signed-in Jewel Labs desk account/);
  assert.equal((await jl.auth.status()).canApprove, false);
  const onboarded = await jl.desk.onboard({ name: 'Meridian Stones (SAMPLE)' });
  assert.equal((await jl.workspaces.current()).id, onboarded.workspace.id);
  assert.equal(onboarded.screening.status, 'review');

  // The demo never takes a key, a mailbox password or an account.
  assert.match((await jl.settings.set({ openaiKey: ['sk', 'test', 'abc123'].join('-') })).error, /never takes an API key/);
  assert.match((await jl.mail.connect({ email: 'a@b.c', appPassword: 'x' })).error, /desktop app/);
  assert.match((await jl.auth.signIn({ email: 'a@b.c', password: 'x' })).error, /desktop app/);
}));

test('the demo will not close a question about papers that disagree', () => withFileFetch(async () => {
  const run = recordedRun();
  // The recording up to the moment the carat question was still open.
  const asked = run.steps.find((x) => x.name === 'questions' && x.payload.kind === 'mismatch').t;
  const jl = createMockApi({ run: { ...run, steps: run.steps.filter((x) => x.t <= asked) }, fetchRun: false, speed: 1000 });
  await jl.ready();
  const mismatch = (await jl.questions.list({ status: 'open' })).find((q) => q.kind === 'mismatch');
  assert.match((await jl.questions.dismiss(mismatch.id)).error, /Answer this question/);
  assert.equal((await jl.questions.list({ status: 'open' })).some((q) => q.id === mismatch.id), true);
  const missing = (await jl.questions.list({ status: 'open' })).find((q) => q.kind === 'missing_document');
  assert.equal((await jl.questions.dismiss(missing.id)).status, 'dismissed');
}));

test('the demo replays the run live from now', () => withFileFetch(async () => {
  const run = recordedRun();
  const jl = createMockApi({ run, fetchRun: false, speed: 400, autoStart: false });
  await jl.ready();
  assert.equal((await jl.shipments.list()).length, 0);
  const agentEvents = [];
  jl.on('agent', (e) => agentEvents.push(e));
  await jl.demo.load();
  const built = endState(run).papers.length;
  await until(async () => (await jl.papers.list()).length === built, 5000, 'the run to build its papers');
  assert.ok(agentEvents.some((e) => e.action === 'field' && e.box));
  assert.ok(agentEvents.some((e) => e.agent === 'sanctions'));
  const [first] = await jl.activity.list({ limit: 1 });
  assert.ok(Math.abs(Date.now() - Date.parse(first.at)) < 5 * 60000, first.at);
  const added = await jl.docs.add([{ name: 'notes.txt', bytes: new TextEncoder().encode('hello') }]);
  assert.equal(added.documentIds.length, 1);
  await until(async () => (await jl.docs.get(added.documentIds[0])).status === 'read', 3000, 'the demo reader');
}));

test('without a recording the demo is empty and says so', async () => {
  const jl = createMockApi({ fetchRun: false });
  await jl.ready();
  assert.equal((await jl.demo.status()).recorded, false);
  assert.match((await jl.demo.load()).error, /could not be loaded/);
  assert.equal((await jl.workspaces.current()).name, 'Sample workspace');
  assert.deepEqual(await jl.shipments.list(), []);
});

// ---------- the vendored libraries ----------

test('the vendored libraries are unchanged copies of the installed packages (vendor/README.md)', () => {
  const same = (from, to) => assert.ok(fs.readFileSync(path.join(ROOT, from)).equals(fs.readFileSync(path.join(ROOT, to))), `${to} is not a copy of ${from}`);
  same('node_modules/htm/preact/standalone.mjs', 'src/renderer/vendor/preact-htm.mjs');
  same('node_modules/pdfjs-dist/build/pdf.mjs', 'src/renderer/vendor/pdfjs/pdf.mjs');
  same('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'src/renderer/vendor/pdfjs/pdf.worker.mjs');
  for (const dir of ['cmaps', 'standard_fonts']) {
    for (const name of fs.readdirSync(path.join(ROOT, 'node_modules', 'pdfjs-dist', dir))) same(`node_modules/pdfjs-dist/${dir}/${name}`, `src/renderer/vendor/pdfjs/${dir}/${name}`);
  }
  const readme = fs.readFileSync(path.join(RENDERER, 'vendor', 'README.md'), 'utf8');
  for (const pkg of ['htm', 'pdfjs-dist']) {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8'));
    assert.ok(readme.includes(`${pkg} ${version}`), `vendor/README.md names ${pkg} ${version}`);
  }
});

// ---------- the page contract ----------

test('a question is labelled by its field, or by what kind it is: keys only the rules read never show as they are', () => {
  assert.equal(questionLabel({ key: 'goods.destinationCountry', kind: 'missing_field' }), 'Destination');
  assert.equal(questionLabel({ key: 'stone.7391020002.carat', kind: 'mismatch' }), 'Papers disagree');
  assert.equal(questionLabel({ key: 'stone.7391020002.carat.accepted', kind: 'confirm' }), 'Please confirm');
  assert.equal(questionLabel({ key: 'sanctions.example-diamonds-bv.99001', check: 'sanctions', kind: 'confirm' }), 'OFAC SDN screen');
  assert.equal(questionLabel({ key: 'house.eori', kind: 'missing_field' }), 'EORI number');
  assert.equal(questionLabel({ key: 'doc.checkedBy', kind: 'confirm' }), 'Packing list draft');
  assert.equal(questionLabel({ key: null, kind: 'missing_document' }), 'Missing paper');
});

test('the watched folder says which files it could not read; the mail form reads the domains typed in', () => {
  const problems = [{ file: 'AWB 1.pdf', reason: 'in use by another program' }, { file: 'b.pdf', reason: 'no permission to read it' }];
  assert.equal(fmt.folderProblem({ watching: true, problems }), '2 files could not be read: AWB 1.pdf (in use by another program), b.pdf (no permission to read it). The agents try again every 5 minutes.');
  const many = Array.from({ length: 5 }, (_, i) => ({ file: `f${i}.pdf`, reason: 'in use by another program' }));
  assert.match(fmt.folderProblem({ watching: true, problems: many }), /f2\.pdf \(in use by another program\) and 2 more\./);
  assert.equal(fmt.folderProblem({ watching: true, problems: [], lastError: 'That folder could not be opened.' }), 'That folder could not be opened.');
  assert.equal(fmt.folderProblem({ watching: false, problems }), null);
  assert.deepEqual(fmt.domainList('Broker.example, @lab.example;  courier.example broker.example'), ['broker.example', 'lab.example', 'courier.example']);
  assert.deepEqual(fmt.domainList(''), []);
  assert.equal(fmt.offlineNote(1), '1 paper was read by the offline reader; it is read again when the AI is back.');
  assert.equal(fmt.offlineNote(3), '3 papers were read by the offline reader; they are read again when the AI is back.');
});

test('index.html has the strict CSP and no inline scripts or styles', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  assert.match(html, /content="default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'self' blob:; font-src 'self'; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'"/);
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
    // Ids from the recorded run (demo/sample-run.json): shipment KG/26-27/041, its invoice, a stone and its export pack.
    for (const [name, hash, wait] of [['shipment', '#/shipments/shp_3d40e04e61446f04?doc=doc_0mwitmgts0004bd0809&field=invoice.number', 2500], ['stones', '#/stones/7391020001', 1800], ['papers', '#/papers/pap_0mwitoqud004g0c3262', 3000], ['desk', '#/desk', 2000], ['metrics', '#/desk/metrics', 1500]]) {
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
