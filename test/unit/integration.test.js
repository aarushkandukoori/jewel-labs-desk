// Fixes found by running the whole pipeline on the SAMPLE shipments (scripts/eval.js). Each test pins one real
// failure the separate module tests did not catch. Everything runs offline with the real core modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeExtraction, normalizeField, normalizeLine, crossCheck, looksLikeReference } from '../../src/core/ai/normalize.js';
import { readDocument } from '../../src/core/ai/heuristics.js';
import { parseStoneLine } from '../../src/core/ai/stone-lines.js';
import { draftPackingListOffline } from '../../src/core/ai/conversation.js';
import { extractPrompt } from '../../src/core/ai/prompts.js';
import { invoiceTypeForHouse, splitJointNames } from '../../src/core/pipeline/intake.js';
import { pickShipment, latestOpen } from '../../src/core/pipeline/ask.js';
import { sameRecord } from '../../src/core/pipeline/context.js';
import * as records from '../../src/core/records/index.js';
import { locate } from '../../src/core/records/locate.js';
import { evaluate } from '../../src/core/rules/compliance.js';
import { normalizeClarity, normalizeLab } from '../../src/core/rules/formats.js';
import { createServices } from '../../src/core/services.js';
import { createLocalWorkspace, openLocalStore } from '../../src/core/store/index.js';

// ---------------------------------------------------------------- reading

test('a row that prints "No report" has no report number, so it never becomes a stone called NOREPORT', () => {
  const line = normalizeLine({ lineNo: 4, reportNumber: 'No report', carat: '0.45', color: 'E', clarity: 'SI1' });
  assert.equal(line.reportNumber, null);
  assert.equal(normalizeLine({ reportNumber: 'GIA 2141 438 172' }).reportNumber, '2141438172', 'without the lab name');
  assert.equal(normalizeField({ key: 'lab.reportNumber', value: 'N/A', confidence: 0.9 }), null);
});

test('reference numbers are never read as company names; tax ids lose their label; addresses lose phone and email', () => {
  assert.equal(normalizeField({ key: 'buyer.name', value: 'LDB-7781', confidence: 0.9 }), null);
  assert.equal(looksLikeReference('PO 4471 / 2026'), true);
  assert.equal(looksLikeReference('Lumen Diamant BV (SAMPLE)'), false);
  assert.equal(normalizeField({ key: 'exporter.taxId', value: 'IEC SAMPLE00012', confidence: 0.9 }).value, 'SAMPLE00012');
  const address = normalizeField({ key: 'consignee.address', value: '120 Sample Avenue, New York, NY 10036, United States Email a@example.com Tel +1 212 555 0143', confidence: 0.9 });
  assert.equal(address.value, '120 Sample Avenue, New York, NY 10036, United States');
  assert.equal(normalizeField({ key: 'awb.route', value: 'MUMBAI (BOM) - DXB - JFK', confidence: 0.9 }).value, 'BOM-DXB-JFK');
});

test('a party printed with its address on one line is screened by its name only', () => {
  const read = normalizeExtraction({ fields: [
    { key: 'consignee.name', value: 'Lumen Diamant BV (SAMPLE), Hoveniersstraat 99, 2018 Antwerpen, Belgium', quote: 'x', confidence: 0.9 },
    { key: 'exporter.name', value: 'Smith, Jones & Co', quote: 'y', confidence: 0.9 },
  ] }, 'packing_list');
  const value = (key) => read.fields.find((f) => f.key === key)?.value;
  assert.equal(value('consignee.name'), 'Lumen Diamant BV (SAMPLE)');
  assert.equal(value('consignee.address'), 'Hoveniersstraat 99, 2018 Antwerpen, Belgium');
  assert.equal(value('exporter.name'), 'Smith, Jones & Co', 'a comma inside a name stays');
});

test("a paper's own number and date fill doc.number and doc.date, and the other way round", () => {
  const report = normalizeExtraction({ fields: [
    { key: 'lab.reportNumber', value: '7391020001', quote: '7391020001', page: 1, confidence: 0.99 },
    { key: 'lab.reportDate', value: '14 July 2026', quote: '14 July 2026', page: 1, confidence: 0.99 },
  ] }, 'lab_report');
  const value = (fields, key) => fields.find((f) => f.key === key)?.value;
  assert.equal(value(report.fields, 'doc.number'), '7391020001');
  assert.equal(value(report.fields, 'doc.date'), '2026-07-14');
  const awb = normalizeExtraction({ fields: [
    { key: 'doc.number', value: '99000012345', quote: '99000012345', confidence: 0.9 },
    { key: 'doc.date', value: '13/11/2026', quote: '13/11/2026', confidence: 0.9 },
  ] }, 'air_waybill');
  assert.equal(value(awb.fields, 'awb.hawb'), '99000012345');
  assert.equal(value(awb.fields, 'awb.date'), '2026-11-13');
});

test('a key the AI skipped is read from its label, and a date read from the wrong label is put right', () => {
  const text = [
    'SHIPPING BILL FOR EXPORT', 'SB No.\t: 1234567\tSB Date\t: 12/11/2026', 'Invoice No.\t: KG/26-27/041\tInvoice Date\t: 10/11/2026',
    'Payment Terms : Advance payment by T/T', 'Port of Loading: MUMBAI (BOM)', 'Exporter : KAVYA GEMS LLP (SAMPLE)',
    'This text layer is long enough to count as a real one. '.repeat(4),
  ].join('\n');
  const offline = readDocument({ text, docType: 'shipping_bill' });
  const result = normalizeExtraction({ fields: [
    { key: 'shippingBill.number', value: '1234567', quote: '1234567', confidence: 0.99 },
    { key: 'invoice.date', value: '2026-11-12', quote: '12/11/2026', confidence: 0.99 }, // the SB date, not the invoice date
  ] }, 'shipping_bill');
  const warnings = crossCheck(result, offline, { text, verifyQuotes: true });
  const value = (key) => result.fields.find((f) => f.key === key)?.value;
  assert.equal(value('invoice.date'), '2026-11-10');
  assert.equal(value('payment.terms'), 'Advance payment by T/T');
  assert.ok(warnings.some((w) => /invoice\.date: the AI read 2026-11-12/.test(w)));
  // Not on OCR text: OCR makes its own mistakes, so nothing is filled from it.
  const ocr = normalizeExtraction({ fields: [] }, 'shipping_bill');
  crossCheck(ocr, offline, { text, verifyQuotes: false });
  assert.equal(ocr.fields.some((f) => f.key === 'payment.terms'), false);
});

test('the reader is told which house received the paper', () => {
  const prompt = extractPrompt({ fileName: 'x.pdf', docType: 'commercial_invoice', family: 'invoice', house: { name: 'Kavya Gems LLP (SAMPLE)', role: 'exporter', country: 'India' } });
  assert.match(prompt, /received this paper: Kavya Gems LLP \(SAMPLE\), a diamond exporter in India/);
  assert.match(prompt, /doc\.number, doc\.date/);
});

test('offline reader: lot rows keep their clarity range and piece count; a sentence about 0.50 ct is not a lot', () => {
  const lot = parseStoneLine('1\tLab-grown CVD polished, lot 1\tRound brilliant\t119\t94.88\tE-G\tVS1-VS2\t-\t85.00\t8,064.80');
  assert.equal(lot.clarity, 'VS1-VS2');
  assert.equal(lot.pieces, 119);
  assert.equal(lot.carat, 94.88);
  assert.equal(parseStoneLine('Please send the signed statement for the stones of 0.50 ct and above.'), null);
  assert.equal(normalizeClarity('VS1-VS2'), 'VS1-VS2');
  assert.equal(normalizeClarity('vs 1'), 'VS1');
});

test('offline reader: OCR text with "+" for ":", both air waybill numbers under one label, a cut report number', () => {
  const insurance = readDocument({ docType: 'insurance_certificate', text: [
    'CERTIFICATE OF INSURANCE', 'Date of Issue + 12/11/2026', 'MAWB / HAWB No. + 176-12345678 / 99000012345',
    'Invoice No. + KG/26-27/041 dated 10/11/2026',
  ].join('\n') });
  const value = (doc, key) => doc.fields.find((f) => f.key === key)?.value;
  assert.equal(value(insurance, 'invoice.number'), 'KG/26-27/041');
  assert.equal(value(insurance, 'awb.mawb'), '176-12345678');
  assert.equal(value(insurance, 'awb.hawb'), '99000012345');
  assert.equal(value(insurance, 'doc.date'), '2026-11-12');
  const photo = readDocument({ docType: 'lab_report', text: 'NORTHBRIDGE GEM LABORATORY (SAMPLE)\nReport Number 739102000\nInscription(s) NGL 7391020005' });
  assert.equal(value(photo, 'lab.reportNumber'), '7391020005');
  assert.equal(value(photo, 'lab.name'), 'Northbridge Gem Laboratory (SAMPLE)');
  const factory = readDocument({ docType: 'factory_record', text: 'FACTORY RECORD\nRough lot No.\tR-0412\nKP certificate No.\tAE-SAMPLE-0001234\nSupplier invoice No.\tSRT-2026-0315\t\tInvoice date\t15/03/2026\nRecord date\t08/07/2026' });
  assert.equal(value(factory, 'doc.number'), 'R-0412');
  assert.equal(value(factory, 'doc.date'), '2026-07-08');
});

test('offline packing list draft: the stones typed in the chat, never a sentence of another message', () => {
  const draft = draftPackingListOffline({
    chatLines: [
      { text: 'Packing notes', lines: [{ lineNo: 1, reportNumber: '7391020001', carat: 1.02, color: 'D', clarity: 'VVS1', quote: '1) RD 1.02 D VVS1 7391020001' }] },
      { text: 'KG/26-27/041 stones 1) RD 1.02 D VVS1 7391020001 total 6 pcs 5.10 cts' }, // the same message, flattened
    ],
    emails: [{ text: 'Please send the signed EU statement for the stones of 0.50 ct and above.' }],
  });
  assert.deepEqual(draft.lines.map((l) => [l.reportNumber, l.carat]), [['7391020001', 1.02]]);
});

test('lab names: an all-caps name reads as a name; a lab without an online check is never taken for GIA', async () => {
  assert.equal(normalizeLab('NORTHBRIDGE GEM LABORATORY (SAMPLE)'), 'Northbridge Gem Laboratory (SAMPLE)');
  assert.equal(normalizeLab('Gemological Institute of America'), 'GIA');
  const { detectLab } = await import('../../src/core/labs/index.js');
  assert.equal(detectLab('7391020001', 'Northbridge Gem Laboratory (SAMPLE)'), null);
});

// ---------------------------------------------------------------- the house's own invoice or its supplier's

const HOUSE = { name: 'Kavya Gems LLP (SAMPLE)', legalEntity: 'Kavya Gems LLP (SAMPLE)', role: 'exporter' };
const field = (key, value) => ({ key, value, quote: value, page: 1, confidence: 0.99 });

test('an invoice where another company sells to the house is a supplier invoice; its seller becomes the supplier', () => {
  const fields = [field('exporter.name', 'Sample Rough Trading DMCC (SAMPLE)'), field('exporter.country', 'United Arab Emirates'), field('consignee.name', 'KAVYA GEMS LLP (SAMPLE)')];
  const settled = invoiceTypeForHouse('commercial_invoice', fields, HOUSE, records);
  assert.equal(settled.docType, 'supplier_invoice');
  assert.equal(settled.fields.find((f) => f.key === 'supplier.name').value, 'Sample Rough Trading DMCC (SAMPLE)');
  assert.equal(settled.fields.find((f) => f.key === 'supplier.country').value, 'United Arab Emirates');
  // The house's own sale stays a commercial invoice, and an importer's purchase is the invoice of its import.
  const sale = [field('exporter.name', 'Kavya Gems LLP (SAMPLE)'), field('consignee.name', 'Lumen Diamant BV (SAMPLE)')];
  assert.equal(invoiceTypeForHouse('commercial_invoice', sale, HOUSE, records).docType, 'commercial_invoice');
  assert.equal(invoiceTypeForHouse('commercial_invoice', fields, { ...HOUSE, role: 'importer' }, records).docType, 'commercial_invoice');
  assert.equal(invoiceTypeForHouse('supplier_invoice', sale, HOUSE, records).docType, 'commercial_invoice');
});

test('"A and/or B" on an insurance certificate: the house keeps its role, the buyer is the consignee', () => {
  const joint = 'Kavya Gems LLP (SAMPLE) and/or Lumen Diamant BV (SAMPLE)';
  const fields = splitJointNames([field('consignee.name', joint), field('exporter.name', joint)], HOUSE, records);
  assert.equal(fields[0].value, 'Lumen Diamant BV (SAMPLE)');
  assert.equal(fields[1].value, 'Kavya Gems LLP (SAMPLE)');
  assert.equal(splitJointNames([field('consignee.name', joint)], null, records)[0].value, 'Lumen Diamant BV (SAMPLE)');
});

// ---------------------------------------------------------------- "Tell the agents"

const at = (minutes) => new Date(Date.UTC(2026, 10, 15, 9, minutes)).toISOString();
const shipments = [
  { id: 'a', ref: 'KG/26-27/041', status: 'questions', consignee: { name: 'Lumen Diamant BV', address: 'Hoveniersstraat 99, 2018 Antwerpen, Belgium' }, createdAt: at(0), updatedAt: at(50) },
  { id: 'c', ref: 'KG/26-27/043', status: 'questions', consignee: { name: 'Hudson Fine Jewels', address: 'New York' }, createdAt: at(10), updatedAt: at(55) },
];
const documents = [
  { id: 'd1', shipmentId: 'a', createdAt: at(1), docType: 'commercial_invoice' },
  { id: 'd2', shipmentId: 'c', createdAt: at(12), docType: 'commercial_invoice' },
  { id: 'chat', shipmentId: 'a', createdAt: at(0), docType: 'whatsapp_chat', insights: { packing: [{ ref: 'KG/26-27/041', lines: [{ reportNumber: '7391020001' }] }] } },
];

test('"What is still missing?" is about every open shipment; a typed number or a buyer named picks one', () => {
  assert.equal(pickShipment('whats_missing', { request: 'What is still missing?', route: { shipmentRef: 'KG/26-27/043' }, shipments, documents }), null);
  assert.equal(pickShipment('whats_missing', { request: 'What is missing on KG/26-27/041?', route: {}, shipments, documents }).id, 'a');
  assert.equal(pickShipment('prepare_papers', { request: 'Prepare the papers for the Antwerp parcel', route: { shipmentRef: 'KG/26-27/041' }, shipments, documents }).id, 'a');
  assert.equal(pickShipment('prepare_papers', { request: 'Prepare KG/26-27/099', route: { shipmentRef: 'KG/26-27/099' }, shipments, documents }), null, 'a number that matches nothing');
});

test('"from the chat" is the shipment whose stones were typed in the chat; "latest" is where papers arrived last', () => {
  assert.equal(pickShipment('build_packing_list', { request: 'Build the packing list from the chat', route: { shipmentRef: 'KG/26-27/043' }, shipments, documents }).id, 'a');
  // A run touching every record must not change which shipment is the latest: the papers' arrival decides.
  assert.equal(latestOpen(shipments, documents).id, 'c');
  const later = [...documents, { id: 'd3', shipmentId: 'a', createdAt: at(30), docType: 'packing_list' }];
  assert.equal(pickShipment('prepare_papers', { request: 'Prepare the papers for my latest shipment', route: {}, shipments, documents: later }).id, 'a');
});

test('sameRecord ignores times, so unchanged records are not saved again', () => {
  assert.equal(sameRecord({ id: 'x', b: [1, { c: 2 }], updatedAt: 'then' }, { b: [1, { c: 2 }], id: 'x', updatedAt: 'now' }), true);
  assert.equal(sameRecord({ id: 'x', status: 'questions' }, { id: 'x', status: 'ready_to_sign' }), false);
});

// ---------------------------------------------------------------- records and rules

test('a packing list the agents drafted stops counting once the house sends its own', () => {
  const draft = { id: 'pl1', docType: 'packing_list', source: { kind: 'generated' } };
  const real = { id: 'pl2', docType: 'packing_list', source: { kind: 'upload' } };
  const invoice = { id: 'inv', docType: 'commercial_invoice', source: { kind: 'upload' } };
  assert.deepEqual(records.withoutReplacedDrafts([invoice, draft]).map((d) => d.id), ['inv', 'pl1']);
  assert.deepEqual(records.withoutReplacedDrafts([invoice, draft, real]).map((d) => d.id), ['inv', 'pl2']);
});

test('the carat question keeps one identity while more papers name the same two weights', () => {
  const doc = (id, docType, carat, extra = {}) => ({
    id, docType, status: 'read', shipmentId: 's1', fields: [field('invoice.number', 'KG/26-27/041')],
    lines: [{ lineNo: 1, reportNumber: '7391020002', carat, color: 'F', clarity: 'VS1', shape: 'Oval' }], ...extra,
  });
  const report = { id: 'lab', docType: 'lab_report', status: 'read', shipmentId: 's1', fields: [field('lab.reportNumber', '7391020002'), field('lab.carat', '0.70'), field('lab.color', 'F'), field('lab.clarity', 'VS1')], lines: [] };
  const shipment = { id: 's1', ref: 'KG/26-27/041', destinationCountry: 'BE', direction: 'export', documentIds: [] };
  const ask = (docs) => {
    const { stones } = records.matchStones({ shipment, documents: docs });
    return evaluate({ shipment, documents: docs, stones, screenings: [{ name: 'x', status: 'clear' }] }).questions.find((q) => q.check === 'stone_details');
  };
  const first = ask([doc('inv', 'commercial_invoice', 0.71), report]);
  const second = ask([doc('inv', 'commercial_invoice', 0.71), report, doc('pl', 'packing_list', 0.71)]);
  assert.notEqual(first.text, second.text, 'the wording names the new paper');
  assert.equal(first.dedupeKey, second.dedupeKey);
});

test('history: the rough lot comes from the factory record, the factory is never the rough supplier, packed once', () => {
  const docs = [
    { id: 'sup', docType: 'supplier_invoice', status: 'read', fields: [field('supplier.name', 'Sample Rough Trading DMCC (SAMPLE)'), field('invoice.number', 'SRT-2026-0315'), field('invoice.date', '2026-03-15')], lines: [] },
    { id: 'fac', docType: 'factory_record', status: 'read', fields: [field('doc.number', 'R-0412'), field('supplier.name', 'Sample Rough Trading DMCC (SAMPLE)'), field('invoice.number', 'SRT-2026-0315'), field('doc.date', '2026-07-08')], lines: [] },
    { id: 'draft', docType: 'packing_list', status: 'read', source: { kind: 'generated' }, shipmentId: 's1', fields: [], lines: [] },
    { id: 'pl', docType: 'packing_list', status: 'read', source: { kind: 'upload' }, shipmentId: 's1', fields: [field('doc.date', '2026-11-11')], lines: [] },
  ];
  const stone = {
    id: 'st', growth: 'natural', reportNumber: '7391020001', kp: { certificateNumber: null, countries: [] },
    sources: [{ docId: 'sup', kind: 'supplier_invoice' }, { docId: 'fac', kind: 'factory_record', lineNo: 1 }, { docId: 'draft', kind: 'packing_list', lineNo: 1 }, { docId: 'pl', kind: 'packing_list', lineNo: 1 }],
  };
  const events = records.buildHistory({ stone, shipment: { id: 's1', ref: 'KG/26-27/041' }, documents: docs, papers: [] });
  const find = (kind) => events.filter((e) => e.kind === kind);
  assert.match(find('rough_purchased')[0].detail, /^Rough lot R-0412 bought from Sample Rough Trading DMCC \(SAMPLE\) on invoice SRT-2026-0315/);
  assert.doesNotMatch(find('cut_and_polished')[0].detail, /Rough Trading/);
  assert.equal(find('packed').length, 1);
  assert.equal(find('packed')[0].docId, 'pl');
});

test('locate finds an address printed over two lines next to another column', () => {
  const word = (text, x0, y0) => ({ text, page: 1, x0, y0, x1: x0 + 0.05, y1: y0 + 0.012 });
  const words = [
    word('Hoveniersstraat', 0.07, 0.275), word('99', 0.13, 0.275), word('Goods', 0.5, 0.275), word('are', 0.56, 0.275), word('accepted', 0.6, 0.275),
    word('for', 0.66, 0.275), word('carriage', 0.7, 0.275), word('in', 0.76, 0.275), word('order', 0.8, 0.275),
    word('2018', 0.07, 0.288), word('Antwerpen,', 0.11, 0.288), word('Belgium', 0.18, 0.288), word('Valuable', 0.5, 0.288), word('cargo', 0.58, 0.288),
  ];
  const found = locate(words, 'Hoveniersstraat 99 2018 Antwerpen, Belgium');
  assert.ok(found, 'found');
  assert.deepEqual(found.box, [0.07, 0.275, 0.23, 0.3]);
});

// ---------------------------------------------------------------- the SAMPLE shipment in the app

test('loadSample gives a sample workspace the SAMPLE house and holds the late packing list back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-integration-'));
  const samples = path.join(dir, 'samples');
  try {
    for (const [rel, text] of [['whatsapp/chat.txt', 'x'], ['email/po.txt', 'y'], ['drop/sb.txt', 'z'], ['later/packing.txt', 'w']]) {
      await fs.mkdir(path.dirname(path.join(samples, rel)), { recursive: true });
      await fs.writeFile(path.join(samples, rel), text);
    }
    const workspace = await createLocalWorkspace({ dir, profile: { name: 'Sample workspace', sample: true } });
    const store = await openLocalStore({ dir, workspaceId: workspace.id });
    const services = createServices({ store, ai: null, paths: { samplesDir: samples, cacheDir: path.join(dir, 'cache') }, pace: 0, sanctionsLoader: async () => null });
    await store.updateWorkspace({ autopilot: false });
    const first = await services.loadSample();
    assert.equal(first.files, 3);
    const names = (await store.list('documents')).map((d) => d.fileName);
    assert.deepEqual(names, ['chat.txt', 'po.txt', 'sb.txt'], 'the chat, then the email, then the dropped files; later/ waits');
    const house = await store.workspace();
    assert.equal(house.legalEntity, 'Kavya Gems LLP (SAMPLE)');
    assert.equal(house.name, 'Kavya Gems LLP (SAMPLE)', 'the default sandbox name becomes the house name');
    assert.equal(house.taxId, 'SAMPLE00012');
    assert.equal(house.environment, 'sandbox');
    assert.equal(house.letterhead.iec, 'SAMPLE00012');
    const late = await services.loadSample({ later: true });
    assert.equal(late.files, 1);
    assert.ok((await store.list('documents')).some((d) => d.fileName === 'packing.txt'));
    await services.shutdown();
    await store.close();

    // A name the person chose for the sandbox is kept.
    const named = await createLocalWorkspace({ dir, profile: { name: 'Training house', sample: true } });
    const namedStore = await openLocalStore({ dir, workspaceId: named.id });
    const namedServices = createServices({ store: namedStore, ai: null, paths: { samplesDir: samples, cacheDir: path.join(dir, 'cache2') }, pace: 0, sanctionsLoader: async () => null });
    await namedStore.updateWorkspace({ autopilot: false });
    await namedServices.loadSample();
    assert.equal((await namedStore.workspace()).name, 'Training house');
    assert.equal((await namedStore.workspace()).legalEntity, 'Kavya Gems LLP (SAMPLE)');
    await namedServices.shutdown();
    await namedStore.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
