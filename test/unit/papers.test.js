// Tests for the papers module. Every company, number and person here is fictional and marked SAMPLE.
// Run: node --test test/unit/papers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPack, buildStatement, buildPackingListDraft, signPdf, nextRef, TEMPLATES } from '../../src/core/papers/index.js';
import { jpegOrientation, sniffType } from '../../src/core/papers/originals.js';
import { customsOrder } from '../../src/core/papers/pack.js';
import { cbpSentences } from '../../src/core/papers/statements.js';
import { miningCountries, stoneFacts } from '../../src/core/papers/format.js';
import { classifyGoods } from '../../src/core/rules/compliance.js';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'papers');
const PRINTED = new Date(2026, 10, 15, 10, 30); // 15 Nov 2026, local time
const CBP_DIAMONDS = 'I certify that the non-industrial diamonds in this shipment were not mined, extracted, produced, or manufactured wholly or in part in the Russian Federation, notwithstanding whether such diamonds have been substantially transformed into other products outside of the Russian Federation.';
const CBP_JEWELRY = 'I certify that the diamond jewelry and unsorted diamonds in this shipment are not of Russian Federation origin and were not exported from the Russian Federation.';

// ---------- fixture files ----------

/** A small PNG (a grey "page" with text-like bars), built by hand so the test needs no image library. */
function makePng(width = 300, height = 420) {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // PNG filter type "none"
    const bar = y > 40 && y % 18 < 5 && y < height - 40;
    for (let x = 0; x < width; x++) {
      const ink = (y < 28 && x > 20 && x < 160) || (bar && x > 24 && x < width - 24 - (y % 7) * 12);
      const v = ink ? 70 : 244;
      raw.set([v, v, ink ? 80 : 238], y * rowBytes + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 64x48 JPEG stored sideways with EXIF orientation 6 (a phone photo held upright).
const SIDEWAYS_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDia9a8D/8AIpWP/bT/ANGNXkteteB/+RSsf+2n/oxqTAux6xbSadLfBJfKjbaQQN2ePf3qSTU4I/se5JP9Mx5eAOM468+4rAtf+RSvP+uw/mlWLv8A5l//AIB/7JQBtR30Umoy2IV/NjXcSQNuOP8AGoI9YtpNOlvgkvlRttIIG7PHv71Vtf8Akbbz/riP5JWda/8AIpXn/XYfzSgDfk1OCP7HuST/AEzHl4A4zjrz7inx30Umoy2IV/NjXcSQNuOP8axbv/mX/wDgH/slWbX/AJG28/64j+SUAeRV614H/wCRSsf+2n/oxq8lr1rwP/yKVj/20/8ARjUMCja/8ilef9dh/NKsXf8AzL//AAD/ANkqva/8ilef9dh/NKsXf/Mv/wDAP/ZKALNr/wAjbef9cR/JKzrX/kUrz/rsP5pWja/8jbef9cR/JKzrX/kUrz/rsP5pQBYu/wDmX/8AgH/slWbX/kbbz/riP5JVa7/5l/8A4B/7JVm1/wCRtvP+uI/klAHkVeteB/8AkUrH/tp/6MavJa9a8D/8ilY/9tP/AEY1DAo2v/IpXn/XYfzSrF3/AMy//wAA/wDZK049Hto9OlsQ8vlSNuJJG7PHt7VJJpkEn2Pc8n+h48vBHOMdePYUAUbX/kbbz/riP5JWda/8ilef9dh/NK6KOxij1GW+DP5si7SCRtxx/hUEej20enS2IeXypG3Ekjdnj29qAMy7/wCZf/4B/wCyVZtf+RtvP+uI/klXpNMgk+x7nk/0PHl4I5xjrx7Cnx2MUeoy3wZ/NkXaQSNuOP8ACgD/2Q==', 'base64');

async function makePdf(title, pageCount, size = [595.28, 841.89]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pageCount; n++) {
    const page = doc.addPage(size);
    page.drawText(`${title}, page ${n} of ${pageCount}`, { x: 56, y: size[1] - 80, size: 14, font });
    page.drawText('SAMPLE document for tests. Fictional data.', { x: 56, y: size[1] - 104, size: 10, font });
  }
  return doc.save();
}

// ---------- fixture records ----------

const field = (key, value) => ({ key, value, quote: value, page: 1, confidence: 0.95 });

function exportHouse() {
  return {
    id: 'ws-sample', name: 'Sample Gems (SAMPLE)', legalEntity: 'Sample Gems Exports Pvt Ltd (SAMPLE)',
    address: 'Unit 4, Sample Diamond Bourse, Surat 395000', city: 'Surat', country: 'IN', sample: true,
  };
}

function makeStones(count, shipmentId = 'sh-exp') {
  const shapes = ['Round', 'Oval', 'Pear', 'Cushion', 'Emerald'];
  const colors = ['D', 'E', 'F', 'G', 'H'];
  const clarities = ['VVS1', 'VS1', 'VS2', 'SI1', 'IF'];
  return Array.from({ length: count }, (_, i) => ({
    id: `st-${i + 1}`, workspaceId: 'ws-sample', shipmentId, ref: `stone-${i + 1}`,
    reportNumber: `SMP${String(9100000 + i)}`, lab: i % 3 === 0 ? 'IGI' : 'GIA',
    shape: shapes[i % 5], carat: i === 5 ? null : Number((0.32 + (i % 9) * 0.17).toFixed(2)),
    color: colors[i % 5], clarity: clarities[i % 5], growth: 'natural',
    sources: [{ docId: 'doc-inv', kind: 'commercial_invoice', lineNo: i + 1 }, { docId: 'doc-pkl', kind: 'packing_list', lineNo: i + 1 }],
    kp: { certificateNumber: 'KP-SAMPLE-0001', countries: i % 2 ? ['BW'] : ['CA'] },
  }));
}

async function exportFixture() {
  const files = {
    'docs/doc-inv/invoice-041.pdf': await makePdf('SAMPLE commercial invoice SGE/26-27/041', 2),
    'docs/doc-pkl/packing-list-photo.png': makePng(),
    'docs/doc-sb/shipping-bill.pdf': await makePdf('SAMPLE shipping bill 7000001', 1, [612, 792]),
    'docs/doc-lab1/lab-report.jpg': SIDEWAYS_JPEG,
  };
  const received = '2026-11-14T09:42:00.000Z';
  const documents = [
    // Deliberately out of customs order, so the test proves the pack sorts them.
    { id: 'doc-sb', fileName: 'shipping-bill.pdf', mime: 'application/pdf', fileKey: 'docs/doc-sb/shipping-bill.pdf', sha256: 'a1'.repeat(32), docType: 'shipping_bill', source: { kind: 'email', from: 'broker@sample-broker.example', receivedAt: received }, fields: [field('shippingBill.number', '7000001'), field('leo.date', '2026-11-12')], lines: [] },
    { id: 'doc-chat', fileName: 'WhatsApp Chat - Sample Office.zip', mime: 'application/zip', fileKey: 'docs/doc-chat/chat.zip', sha256: 'b2'.repeat(32), docType: 'whatsapp_chat', source: { kind: 'whatsapp', ref: 'Sample Office', chatAuthor: 'Sample Clerk', chatAt: '2026-11-13T15:05:00.000Z', receivedAt: received }, fields: [], lines: [] },
    { id: 'doc-awb', fileName: 'hawb.pdf', mime: 'application/pdf', fileKey: 'docs/doc-awb/hawb.pdf', sha256: 'c3'.repeat(32), docType: 'air_waybill', source: { kind: 'upload', receivedAt: received }, fields: [field('awb.hawb', '999-00000001'), field('awb.mawb', '176-00000002'), field('carrier.name', 'Sample Secure Logistics (SAMPLE)')], lines: [] },
    { id: 'doc-inv', fileName: 'invoice-041.pdf', mime: 'application/pdf', fileKey: 'docs/doc-inv/invoice-041.pdf', sha256: 'd4'.repeat(32), docType: 'commercial_invoice', source: { kind: 'email', from: 'accounts@sample-gems.example', receivedAt: received }, fields: [field('invoice.number', 'SGE/26-27/041'), field('invoice.date', '2026-11-10')], lines: [] },
    { id: 'doc-lab1', fileName: 'lab-report.jpg', mime: 'image/jpeg', fileKey: 'docs/doc-lab1/lab-report.jpg', sha256: 'e5'.repeat(32), docType: 'lab_report', source: { kind: 'whatsapp', ref: 'Sample Office', chatAuthor: 'Sample Clerk', receivedAt: received }, fields: [field('lab.name', 'GIA'), field('lab.reportNumber', 'SMP9100001')], lines: [] },
    { id: 'doc-pkl', fileName: 'packing-list-photo.png', mime: 'image/png', fileKey: 'docs/doc-pkl/packing-list-photo.png', sha256: 'f6'.repeat(32), docType: 'packing_list', source: { kind: 'folder', receivedAt: received }, fields: [field('doc.number', 'PL-041')], lines: [] },
    { id: 'doc-kp', fileName: 'kp.pdf', mime: 'application/pdf', fileKey: 'docs/doc-kp/kp.pdf', sha256: '07'.repeat(32), docType: 'kp_certificate', source: { kind: 'upload', receivedAt: received }, fields: [field('kp.certificateNumber', 'KP-SAMPLE-0001'), field('kp.countriesOfMining', 'Botswana, Canada')], lines: [] },
  ];
  const shipment = {
    id: 'sh-exp', workspaceId: 'ws-sample', ref: 'SAMPLE-EXP-041', direction: 'export',
    exporter: { name: 'Sample Gems Exports Pvt Ltd (SAMPLE)', address: 'Unit 4, Sample Diamond Bourse, Surat 395000', country: 'IN' },
    consignee: { name: 'Example Diamonds BV (SAMPLE)', address: '1 Example Street, 2018 Antwerp', country: 'BE', eori: 'BE0000000000' },
    originCountry: 'IN', destinationCountry: 'BE', route: 'BOM to BRU',
    invoiceNumber: 'SGE/26-27/041', invoiceDate: '2026-11-10', shippingBillNumber: '7000001', leoDate: '2026-11-12',
    hawb: '999-00000001', mawb: '176-00000002', flight: 'XS 101', packages: 1, grossWeight: '0.45 kg',
    goods: { nature: 'natural', form: 'polished', hsCodes: ['71023910'] },
    totals: { pieces: 40, carats: null, value: null, currency: 'USD' },
    documentIds: documents.map((d) => d.id), status: 'ready_to_sign', summary: { passed: 19, total: 20 },
    required: [], sample: true,
  };
  const checks = [
    ...Array.from({ length: 19 }, (_, i) => ({ id: `ck-${i}`, shipmentId: 'sh-exp', code: `rule_${i}`, severity: 'pass', title: `Check ${i + 1} passed`, detail: '', evidence: [], rule: 'sample' })),
    { id: 'ck-warn', shipmentId: 'sh-exp', code: 'weights', severity: 'warn', title: 'Packing list weight differs from the invoice by 0.02 ct', detail: 'Invoice total 31.10 ct, packing list total 31.12 ct. Ask the clerk which is right.', evidence: [], rule: 'sample' },
  ];
  const required = [{ kind: 'eu_dds', reason: 'Natural polished stones of 0.50 ct and up going to Belgium.', signer: 'importer', regime: 'EU' }];
  const getFile = (key) => files[key] || null;
  return { kind: 'export_pack', shipment, documents, stones: makeStones(40), checks, required, house: exportHouse(), getFile, ref: 'JL-EXP-1115-01', version: 1, status: 'ready_to_sign', printedAt: PRINTED, rulesVersion: 'compliance.js 2026.11-sample' };
}

function importFixture(files) {
  const house = { id: 'ws-be', name: 'Example Diamonds (SAMPLE)', legalEntity: 'Example Diamonds BV (SAMPLE)', address: '1 Example Street, 2018 Antwerp', country: 'BE', eori: 'BE0000000000', vat: 'BE0000000000', sample: true };
  const documents = [
    { id: 'i-pkl', fileName: 'packing.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileKey: 'k/pkl', sha256: '11'.repeat(32), docType: 'packing_list', source: { kind: 'email', from: 'office@sample-gems.example', receivedAt: '2026-11-14T08:00:00Z' }, fields: [], lines: [
      { lineNo: 1, description: 'Natural polished diamond', reportNumber: 'SMP9100000', lab: 'GIA', shape: 'Round', carat: 1.01, color: 'E', clarity: 'VS1', pieces: 1, rate: null, amount: null, growth: 'natural', quote: null },
      { lineNo: 2, description: 'Natural polished diamond', reportNumber: 'SMP9100001', lab: 'GIA', shape: 'Oval', carat: 0.72, color: 'F', clarity: 'VS2', pieces: 1, rate: null, amount: null, growth: 'natural', quote: null },
    ] },
    { id: 'i-awb', fileName: 'awb.pdf', mime: 'application/pdf', fileKey: 'k/awb', sha256: '22'.repeat(32), docType: 'air_waybill', source: { kind: 'upload', receivedAt: '2026-11-14T08:00:00Z' }, fields: [field('awb.hawb', '999-00000009')], lines: [] },
    { id: 'i-boe', fileName: 'boe.pdf', mime: 'application/pdf', fileKey: 'k/boe', sha256: '33'.repeat(32), docType: 'bill_of_entry', source: { kind: 'upload', receivedAt: '2026-11-14T08:00:00Z' }, fields: [field('billOfEntry.number', 'BE-SAMPLE-77')], lines: [] },
    { id: 'i-inv', fileName: 'inv.pdf', mime: 'application/pdf', fileKey: 'k/inv', sha256: '44'.repeat(32), docType: 'commercial_invoice', source: { kind: 'upload', receivedAt: '2026-11-14T08:00:00Z' }, fields: [field('invoice.number', 'SGE/26-27/052')], lines: [] },
    { id: 'i-ins', fileName: 'insurance.heic', mime: 'image/heic', fileKey: 'k/ins', sha256: '55'.repeat(32), docType: 'insurance_certificate', source: { kind: 'upload', receivedAt: '2026-11-14T08:00:00Z' }, fields: [], lines: [] },
  ];
  const shipment = {
    id: 'sh-imp', ref: 'SAMPLE-IMP-052', direction: 'import',
    exporter: { name: 'Sample Gems Exports Pvt Ltd (SAMPLE)', country: 'IN' },
    consignee: { name: 'Example Diamonds BV (SAMPLE)', address: '1 Example Street, 2018 Antwerp', country: 'BE' },
    originCountry: 'IN', destinationCountry: 'BE', invoiceNumber: 'SGE/26-27/052', invoiceDate: '2026-11-11', hawb: '999-00000009',
    goods: { nature: 'natural', form: 'polished', hsCodes: ['71023910'] }, totals: {}, documentIds: [], status: 'held_for_review', required: [],
  };
  return {
    kind: 'import_pack', shipment, documents, stones: makeStones(2, 'sh-imp'), checks: [], house,
    required: [{ kind: 'eu_dds', reason: 'Natural polished stones of 0.50 ct and up entering Belgium.', signer: 'house', regime: 'EU' }],
    getFile: (key) => files[key] || null, ref: 'JL-IMP-1115-01', version: 2, status: 'held_for_review', printedAt: PRINTED,
  };
}

// ---------- helpers ----------

/** Text of every page, read back with pdf.js (the same library the app uses to read PDFs). */
async function readPdf(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const { width } = page.getViewport({ scale: 1 });
    pages.push({ text: content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' '), items: content.items, width });
  }
  const numPages = pdf.numPages;
  await task.destroy();
  return { numPages, pages, text: pages.map((p) => p.text).join(' ') };
}

const generatedPages = (read) => read.pages.filter((p) => p.text.includes('Prepared by Jewel Labs agents'));

function assertNoOverflow(read) {
  for (const page of generatedPages(read)) {
    for (const item of page.items) {
      if (!item.str.trim()) continue;
      const x = item.transform[4];
      assert.ok(x >= 53, `text starts left of the margin: "${item.str}" at ${x}`);
      assert.ok(x + item.width <= page.width - 53, `text runs past the right margin: "${item.str}" ends at ${x + item.width}`);
    }
  }
}

function save(name, bytes) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), bytes);
}

// ---------- tests ----------

test('nextRef counts up per kind and day', () => {
  const day = new Date(2026, 10, 15);
  assert.equal(nextRef('export_pack', day, []), 'JL-EXP-1115-01');
  assert.equal(nextRef('export_pack', day, ['JL-EXP-1115-01', 'JL-EXP-1115-03', 'JL-EXP-1114-07', 'JL-IMP-1115-09']), 'JL-EXP-1115-04');
  assert.equal(nextRef('import_pack', day, [{ ref: 'JL-IMP-1115-09' }]), 'JL-IMP-1115-10');
  assert.equal(nextRef('eu_dds', '2026-01-02', []), 'JL-DDS-0102-01');
  assert.equal(nextRef('us_cbp_certificate', day), 'JL-CBP-1115-01');
  assert.equal(nextRef('g7_gf_declaration', day), 'JL-G7-1115-01');
  assert.equal(nextRef('packing_list_draft', day), 'JL-PKL-1115-01');
  assert.throws(() => nextRef('invoice', day), /Unknown paper kind/);
});

test('templates keep the official wording and cite real sources', () => {
  assert.equal(TEMPLATES.us_cbp_certificate.diamonds, CBP_DIAMONDS);
  assert.equal(TEMPLATES.us_cbp_certificate.jewelry, CBP_JEWELRY);
  assert.equal(TEMPLATES.us_cbp_certificate.ace.docCode, 'CBP03');
  assert.equal(TEMPLATES.eu_dds.paragraphs.length, 3);
  assert.match(TEMPLATES.eu_dds.paragraphs[0], /^I, the undersigned, hereby declare/);
  for (const source of Object.values(TEMPLATES.sources)) assert.match(source.url, /^https:\/\//);
});

test('customs order: export and import', () => {
  const docs = ['air_waybill', 'lab_report', 'packing_list', 'whatsapp_chat', 'commercial_invoice', 'bill_of_entry', 'shipping_bill', 'kp_certificate']
    .map((docType, i) => ({ id: String(i), docType, fields: [] }));
  assert.deepEqual(customsOrder(docs, 'export').map((d) => d.docType), ['commercial_invoice', 'packing_list', 'shipping_bill', 'air_waybill', 'lab_report', 'kp_certificate']);
  assert.deepEqual(customsOrder(docs, 'import').map((d) => d.docType), ['commercial_invoice', 'bill_of_entry', 'air_waybill', 'packing_list', 'lab_report', 'kp_certificate']);
});

test('photo helpers: file type and EXIF orientation', () => {
  assert.equal(sniffType(makePng(4, 4)), 'png');
  assert.equal(sniffType(SIDEWAYS_JPEG), 'jpeg');
  assert.equal(sniffType(Buffer.from('%PDF-1.7\n')), 'pdf');
  assert.equal(sniffType(Buffer.from('hello world')), 'other');
  assert.equal(jpegOrientation(SIDEWAYS_JPEG), 6);
  assert.equal(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
  assert.equal(jpegOrientation(makePng(4, 4)), 1);
});

test('export pack: cover, envelope, statement, stone list, evidence, sources, originals in order', async () => {
  const input = await exportFixture();
  const pack = await buildPack(input);
  save('export-pack.pdf', pack.bytes);
  const read = await readPdf(pack.bytes);
  assert.equal(read.numPages, pack.pages);
  assert.match(pack.sha256, /^[0-9a-f]{64}$/);

  // Originals: 2-page invoice PDF, PNG packing list, 1-page shipping bill, air waybill with no file, JPEG report, KP with no file.
  const docs = pack.contents.filter((c) => c.docId);
  assert.deepEqual(docs.map((c) => c.docId), ['doc-inv', 'doc-pkl', 'doc-sb', 'doc-awb', 'doc-lab1', 'doc-kp']);
  assert.deepEqual(docs.map((c) => c.attached), [true, true, true, false, true, false]);
  const invoice = docs[0];
  assert.equal(docs[1].page, invoice.page + 2, 'the invoice PDF keeps both of its pages');
  assert.equal(pack.pages, docs[4].page, 'the photo of the grading report is the last page');
  assert.ok(read.pages[invoice.page - 1].text.includes('SAMPLE commercial invoice SGE/26-27/041, page 1 of 2'));
  assert.ok(read.pages[invoice.page].text.includes('page 2 of 2'));

  const page1 = read.pages[0].text;
  assert.ok(page1.includes('Shipment handover'));
  assert.ok(page1.includes('OUTSIDE COVER · HANDOVER RECORD'));
  assert.ok(page1.includes('JL-EXP-1115-01'));
  assert.ok(page1.includes('PRINTED 15 NOV 2026'));
  assert.ok(page1.includes('Neutral cover for the outside of the parcel: no contents or values. The papers go in the document envelope (next page).'));
  for (const box of ['SHIPPER', 'CARRIER', 'CONSIGNEE', 'Date and time', 'Number of pieces (packages)', 'Seal numbers', '0.45 kg', 'XS 101, BOM to BRU']) {
    assert.ok(page1.includes(box), `page 1 has ${box}`);
  }
  assert.ok(!/\$|USD|31\.\d\d ct/.test(page1), 'the outside cover shows no contents or values');

  const page2 = read.pages[1].text;
  assert.ok(page2.includes('INSIDE THE DOCUMENT ENVELOPE'));
  assert.ok(page2.includes('PAPERS IN THIS ENVELOPE, IN THE ORDER CUSTOMS READS THEM'));
  assert.ok(page2.includes('READY TO SIGN'));
  assert.ok(page2.includes('Consistent 19 of 20 checks'));
  assert.ok(page2.includes('Packing list weight differs from the invoice by 0.02 ct'));
  assert.ok(page2.includes(`Pages ${invoice.page} to ${invoice.page + 1}`));
  assert.ok(read.text.includes('Not on file Nothing required is missing.'));
  assert.ok(read.text.includes('hawb.pdf · No file on record'));
  assert.ok(read.text.includes(`Pages ${pack.pages}`), 'the checks list the total page count');

  // The EU statement is a draft for the importer, on the importer's letterhead, with the official wording.
  assert.ok(read.text.includes('Prepared by Sample Gems Exports Pvt Ltd (SAMPLE) for signature by the importer.'));
  assert.ok(read.text.includes('DRAFT FOR THE IMPORTER'));
  for (const paragraph of TEMPLATES.eu_dds.paragraphs) assert.ok(read.text.includes(paragraph), 'EU paragraph verbatim');
  assert.ok(read.text.includes('Antwerp Diamond Office (FPS Economy)'));
  assert.ok(read.text.includes('Botswana') && read.text.includes('Canada'));
  assert.ok(!read.text.includes(CBP_DIAMONDS), 'no US certificate in an EU-bound pack');

  // Stone list spans two pages, evidence index has fingerprints and sources, sources page has the URLs.
  assert.ok(read.text.includes('STONE LIST · CONTINUED'));
  assert.ok(read.text.includes('SMP9100039'));
  assert.ok(read.text.includes('d4d4d4d4d4d4d4d4'));
  assert.ok(read.text.includes('Email from accounts@sample-gems.example'));
  assert.ok(read.text.includes('WhatsApp chat, Sample Office, sent by Sample Clerk'));
  assert.ok(read.text.includes('Kept on record'));
  assert.ok(read.text.includes('finance.ec.europa.eu/system/files/2023-12/faqs-sanctions-russia-diamonds_en.pdf'));
  assert.ok(read.text.includes('compliance.js 2026.11-sample'));
  assert.ok(read.text.includes('SAMPLE · FICTIONAL DATA'));

  // Footer on every generated page, with the right count.
  const footers = generatedPages(read);
  assert.ok(footers.length >= 8);
  assert.ok(read.pages[0].text.includes(`Prepared by Jewel Labs agents · JL-EXP-1115-01 v1 · page 1 of ${pack.pages}`));
  assert.ok(read.pages[pack.pages - 1].text.includes(`page ${pack.pages} of ${pack.pages}`), 'the photo page has a footer too');
  assert.ok(!read.pages[invoice.page - 1].text.includes('Prepared by Jewel Labs agents'), 'original PDF pages stay unchanged');

  assert.ok(!/\bfiled\b/i.test(read.text));
  assertNoOverflow(read);

  // Same input, same bytes: the fingerprint only changes when the paper changes.
  const again = await buildPack(await exportFixture());
  assert.equal(again.sha256, pack.sha256);
});

test('import pack: house letterhead, import order, spreadsheet lines shown as a table', async () => {
  const files = { 'k/awb': await makePdf('SAMPLE air waybill', 1), 'k/boe': await makePdf('SAMPLE bill of entry', 1), 'k/inv': await makePdf('SAMPLE invoice', 1), 'k/pkl': Buffer.from('PK\u0003\u0004 not really a spreadsheet'), 'k/ins': Buffer.from('not a picture pdf-lib can read') };
  const pack = await buildPack(importFixture(files));
  save('import-pack.pdf', pack.bytes);
  const read = await readPdf(pack.bytes);
  const docs = pack.contents.filter((c) => c.docId);
  assert.deepEqual(docs.map((c) => c.docId), ['i-inv', 'i-boe', 'i-awb', 'i-pkl', 'i-ins']);
  assert.deepEqual(docs.map((c) => c.attached), [true, true, true, true, false]);
  assert.ok(read.text.includes('This HEIC file cannot go in a PDF. It is kept on record.'));
  assert.ok(read.text.includes('Bill of entry BE-SAMPLE-77'));
  assert.ok(read.text.includes('JL-IMP-1115-01 v2'));
  assert.ok(read.text.includes('HELD FOR REVIEW'));
  assert.ok(read.text.includes('ORIGINAL DOCUMENT · SPREADSHEET'));
  assert.ok(read.text.includes('SMP9100001'));
  assert.ok(read.text.includes('To be signed by Example Diamonds BV (SAMPLE).'), 'nothing is signed until a person signs the pack');
  assert.ok(!read.text.includes('for signature by the importer'), 'the house is the importer and signs itself');
  assert.ok(read.text.includes('The importer and its customs broker lodge the declaration'));
  assert.ok(!/\bfiled\b/i.test(read.text));
  assertNoOverflow(read);
});

test('EU statement on its own: official wording, facts, draft for the importer', async () => {
  const input = await exportFixture();
  const paper = await buildStatement({ kind: 'eu_dds', shipment: input.shipment, stones: input.stones, house: input.house, status: 'ready_to_sign', documents: input.documents, ref: 'JL-DDS-1115-01', printedAt: PRINTED });
  save('eu-dds.pdf', paper.bytes);
  const read = await readPdf(paper.bytes);
  assert.equal(read.numPages, 1, 'the statement fits on one page like the official template');
  for (const paragraph of TEMPLATES.eu_dds.paragraphs) assert.ok(read.text.includes(paragraph));
  for (const label of ['Importing company name', 'EORI number BE0000000000', 'VAT number', 'HAWB number 999-00000001', 'Shipment reference / Invoice number SAMPLE-EXP-041 / SGE/26-27/041']) {
    assert.ok(read.text.includes(label), `statement has ${label}`);
  }
  // The date of declaration is the importer's to write: never the invoice date, never a date before it is signed.
  assert.ok(read.text.includes('Date of declaration Customs office'), 'the date of declaration is a blank line');
  assert.ok(!read.text.includes('10/11/2026'), 'no back-dating to the invoice date');
  assert.ok(!read.text.includes('VAT number Not on file'), 'a missing VAT number is a line to write on');
  // 40 stones, one has no carat. Only stones of 0.50 ct and up count, and the one with no carat is called out.
  assert.ok(/Natural stones of 0\.50 ct and up \d+ stones, \d+\.\d\d ct\. 1 more with no carat on file/.test(read.text));
  assert.ok(read.text.includes('(Company stamp if applicable)'));
  assert.ok(read.text.includes('Prepared by Jewel Labs agents · JL-DDS-1115-01 v1 · page 1 of 1'));
  assert.ok(!/\bfiled\b/i.test(read.text));
  assertNoOverflow(read);
});

test('US certificate: exact CBP sentence, lodging facts, jewelry wording', async () => {
  const input = await exportFixture();
  const shipment = { ...input.shipment, destinationCountry: 'US', consignee: { name: 'Example Jewelers LLC (SAMPLE)', address: '1 Example Avenue, New York, NY', country: 'US' } };
  const paper = await buildStatement({ kind: 'us_cbp_certificate', shipment, stones: input.stones, house: input.house, status: 'ready_to_sign', ref: 'JL-CBP-1115-01', printedAt: PRINTED });
  save('us-cbp.pdf', paper.bytes);
  const read = await readPdf(paper.bytes);
  assert.ok(read.text.includes(CBP_DIAMONDS), 'CBP sentence verbatim');
  assert.ok(!read.text.includes(CBP_JEWELRY));
  assert.ok(read.text.includes('DocCode CBP03'));
  assert.ok(read.text.includes('One certificate per entry'));
  assert.ok(read.text.includes('Prepared by Sample Gems Exports Pvt Ltd (SAMPLE) for signature by the importer.'));
  assert.ok(!/\bfiled\b/i.test(read.text));
  assertNoOverflow(read);

  const jewelry = await buildStatement({ kind: 'us_cbp_certificate', shipment: { ...shipment, goods: { nature: 'natural', form: 'jewelry', hsCodes: ['711319'] } }, stones: [], house: input.house, printedAt: PRINTED });
  const jewelryText = (await readPdf(jewelry.bytes)).text;
  assert.ok(jewelryText.includes(CBP_JEWELRY));
  assert.ok(!jewelryText.includes(CBP_DIAMONDS));
  assert.ok(jewelryText.includes('JL-CBP-1115-01'), 'a ref is made when none is given');
});

test('G7 / GF note for lab-grown goods', async () => {
  const input = await exportFixture();
  const stones = input.stones.slice(0, 6).map((s) => ({ ...s, growth: 'CVD', lab: 'IGI' }));
  const shipment = { ...input.shipment, goods: { nature: 'lab-grown', form: 'polished', hsCodes: ['71049100'] } };
  const paper = await buildStatement({ kind: 'g7_gf_declaration', shipment, stones, house: input.house, ref: 'JL-G7-1115-01', printedAt: PRINTED });
  save('g7-note.pdf', paper.bytes);
  const read = await readPdf(paper.bytes);
  assert.equal(read.numPages, 1);
  assert.ok(read.text.includes('Diamond Office G7/GF declaration template'));
  assert.ok(read.text.includes('Growth method CVD'));
  assert.ok(read.text.includes('71049100'));
  assert.ok(read.text.includes('Antwerp Diamond Office (FPS Economy)'));
  assert.ok(!/\bfiled\b/i.test(read.text));
  assertNoOverflow(read);
});

test('packing list draft lists its sources and warns to check every line', async () => {
  const input = await exportFixture();
  const lines = input.stones.slice(0, 8).map((s, i) => ({ lineNo: i + 1, description: 'Natural polished diamond', reportNumber: s.reportNumber, lab: s.lab, shape: s.shape, carat: s.carat, color: s.color, clarity: s.clarity, pieces: 1, rate: null, amount: null, growth: 'natural', quote: null }));
  const sources = [
    { kind: 'chat', author: 'Sample Clerk', at: '2026-11-13T15:05:00.000Z', quote: 'Parcel 041: 8 stones, GIA reports attached, all natural.', ref: 'Sample Office' },
    { kind: 'document', fileName: 'invoice-041.pdf', quote: 'Total 8 pcs' },
  ];
  const paper = await buildPackingListDraft({ shipment: input.shipment, lines, sources, house: input.house, ref: 'JL-PKL-1115-01', printedAt: PRINTED });
  save('packing-list-draft.pdf', paper.bytes);
  const read = await readPdf(paper.bytes);
  assert.ok(read.text.includes('Drafted by Jewel Labs agents from the sources below. Check every line before use.'));
  assert.ok(read.text.includes('WhatsApp chat · Sample Clerk'));
  assert.ok(read.text.includes('“Parcel 041: 8 stones, GIA reports attached, all natural.”'));
  assert.ok(read.text.includes('invoice-041.pdf'));
  assert.ok(read.text.includes('Total'));
  assert.ok(read.text.includes('DRAFT'));
  assert.ok(!/\bfiled\b/i.test(read.text));
  assertNoOverflow(read);
});

test('signPdf writes the signer, stamps SIGNED, changes the hash and refuses a second signature', async () => {
  const input = await exportFixture();
  const pack = await buildPack(input);
  const signature = `data:image/png;base64,${makePng(120, 40).toString('base64')}`;
  const signed = await signPdf(pack.bytes, { name: 'Sample Signer', title: 'Export manager', signedAt: new Date(2026, 10, 15, 14, 5), signatureDataUrl: signature });
  save('export-pack-signed.pdf', signed.bytes);
  assert.notEqual(signed.sha256, pack.sha256);
  const read = await readPdf(signed.bytes);
  assert.equal(read.numPages, pack.pages, 'signing adds no pages to our own papers');
  const signOff = read.pages.find((p) => p.text.includes('SIGNED FOR SAMPLE GEMS EXPORTS PVT LTD (SAMPLE)'));
  assert.ok(signOff.text.includes('Sample Signer'));
  assert.ok(signOff.text.includes('Export manager'));
  assert.ok(signOff.text.includes('15 Nov 2026, 14:05'));
  assert.ok(read.pages[1].text.includes('SIGNED'), 'the status chip on the envelope page now says SIGNED');
  assert.ok(!read.pages[0].text.includes('Sample Signer'), 'the handover boxes stay blank for pen at handover');
  await assert.rejects(() => signPdf(signed.bytes, { name: 'Someone Else' }), /already signed/);

  // The importer's box on the export statement stays blank: only the house's "prepared and checked" strip is filled.
  const statementPage = read.pages.find((p) => p.text.includes('Due Diligence Statement of Diamond Origin') && p.text.includes('PREPARED AND CHECKED BY'));
  assert.ok(statementPage.text.includes('Sample Signer'));
  assert.equal(statementPage.text.split('Sample Signer').length - 1, 1, 'the name is written once, in the house strip');

  // A PDF made elsewhere gets a signature page at the end.
  const foreign = await makePdf('SAMPLE outside PDF', 1);
  const foreignSigned = await signPdf(foreign, { name: 'Sample Signer', title: 'Director' });
  const foreignRead = await readPdf(foreignSigned.bytes);
  assert.equal(foreignRead.numPages, 2);
  assert.ok(foreignRead.pages[1].text.includes('Sample Signer'));
  await assert.rejects(() => signPdf(pack.bytes, { name: '' }), /needs a name/);
});

test('many grading reports share one row in the envelope list', async () => {
  const input = await exportFixture();
  const reportPdf = await makePdf('SAMPLE grading report', 1);
  const files = {};
  const reports = Array.from({ length: 12 }, (_, i) => {
    const key = `docs/lab-${i}/report.pdf`;
    if (i < 10) files[key] = reportPdf; // the last two have no file yet
    return {
      id: `lab-${i}`, fileName: `report-${i}.pdf`, mime: 'application/pdf', fileKey: key, sha256: String(i).padStart(64, '0'),
      docType: 'lab_report', source: { kind: 'upload', receivedAt: '2026-11-14T09:42:00.000Z' },
      fields: [field('lab.name', i % 3 === 0 ? 'IGI' : 'GIA'), field('lab.reportNumber', `SMP${9100100 + (11 - i)}`)], lines: [],
    };
  });
  input.documents = [...input.documents.filter((d) => d.docType !== 'lab_report'), ...reports];
  const baseGetFile = input.getFile;
  input.getFile = async (key) => files[key] || baseGetFile(key); // async getFile works too
  const pack = await buildPack(input);
  const read = await readPdf(pack.bytes);
  assert.ok(read.pages[1].text.includes('Grading reports, 12 (GIA 8, IGI 4)'));
  assert.ok(read.pages[1].text.includes('2 not attached, see the evidence index'));
  const labs = pack.contents.filter((c) => c.docId?.startsWith('lab-'));
  assert.equal(labs.length, 12);
  // Sorted by report number: lab-11 has the lowest number.
  assert.equal(labs[0].docId, 'lab-11');
  assert.equal(labs.filter((c) => c.attached).length, 10);
  assert.equal(read.numPages, pack.pages);
  assertNoOverflow(read);
});

test('an empty shipment still builds a clean pack', async () => {
  const pack = await buildPack({ kind: 'export_pack', shipment: {}, documents: [], stones: [], checks: [], required: [], house: {}, getFile: () => null, printedAt: PRINTED });
  const read = await readPdf(pack.bytes);
  assert.equal(read.numPages, pack.pages);
  assert.ok(read.text.includes('JL-EXP-1115-01'), 'a ref is made from the printed date');
  assert.ok(read.text.includes('AIR WAYBILL NOT ON FILE'));
  assert.ok(read.text.includes('No papers on file yet.'));
  assert.ok(read.text.includes('No stones on file yet'));
  assert.ok(read.text.includes('Commercial invoice, Packing list, Shipping bill, Air waybill'));
  // No paper names the destination, so nobody can say yet which origin statement the importer needs.
  assert.ok(read.text.includes('Not decided yet: no paper names the destination.'));
  assert.ok(!read.text.includes('None needed for this shipment.'));
  assert.ok(read.text.includes('DRAFT'));
  assert.ok(!/\bfiled\b/i.test(read.text));
  const toDubai = await readPdf((await buildPack({ kind: 'export_pack', shipment: { destinationCountry: 'AE' }, documents: [], stones: [], checks: [], required: [], house: {}, getFile: () => null, printedAt: PRINTED })).bytes);
  assert.ok(toDubai.text.includes('None needed for this shipment.'), 'a known destination that needs no statement');
  await assert.rejects(() => buildPack({ kind: 'eu_dds' }), /Unknown pack kind/);
  await assert.rejects(() => buildStatement({ kind: 'export_pack' }), /Unknown statement kind/);
});

test('long and odd values wrap instead of overflowing', async () => {
  const input = await exportFixture();
  const longName = 'Example Diamonds International Trading and Manufacturing Company Limited Liability Partnership (SAMPLE) '.repeat(2);
  input.shipment.consignee = { name: longName, address: `${'Very long street name '.repeat(8)}, Antwerp`, country: 'BE' };
  input.shipment.invoiceNumber = 'SGE/26-27/041/AN-EXTREMELY-LONG-INVOICE-REFERENCE-WITHOUT-SPACES-1234567890';
  input.documents[0].fileName = `${'scan_of_shipping_bill_'.repeat(6)}.pdf`;
  input.checks.push({ id: 'x', shipmentId: 'sh-exp', code: 'emoji', severity: 'fail', title: 'Name has odd characters ✓ ગુજરાતી 💎', detail: 'x'.repeat(300), evidence: [], rule: 'sample' });
  const pack = await buildPack(input);
  save('export-pack-long-values.pdf', pack.bytes);
  const read = await readPdf(pack.bytes);
  assert.equal(read.numPages, pack.pages);
  assertNoOverflow(read);
  assert.ok(read.text.includes('Name has odd characters ?'), 'characters the font lacks become "?"');
});

test('writes sample papers for a visual check (test/.tmp/papers)', async () => {
  // The other tests saved the PDFs. Turn the first pages of the export pack into PNGs when pdftoppm exists.
  const probe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  if (probe.error) return; // pdftoppm not installed: nothing to render
  const pdfPath = path.join(OUT_DIR, 'export-pack.pdf');
  if (!fs.existsSync(pdfPath)) return;
  const result = spawnSync('pdftoppm', ['-r', '80', '-png', '-f', '1', '-l', '2', pdfPath, path.join(OUT_DIR, 'export-pack')]);
  assert.equal(result.status, 0);
  assert.ok(fs.readdirSync(OUT_DIR).some((name) => /^export-pack-0?1\.png$/.test(name)));
});

// ---------- fixes ----------

/** The text items on one page that sit on the same line as the label (same baseline, within 2 points). */
function onSameLine(page, label) {
  const at = page.items.find((item) => item.str === label);
  if (!at) return [];
  return page.items.filter((item) => item !== at && item.str.trim() && Math.abs(item.transform[5] - at.transform[5]) < 2).map((item) => item.str);
}

test('an import EU statement the house signs carries the signing day as its date of declaration', async () => {
  const fixture = importFixture({});
  const paper = await buildStatement({ kind: 'eu_dds', shipment: fixture.shipment, stones: fixture.stones, house: fixture.house, status: 'ready_to_sign', ref: 'JL-DDS-1116-01', printedAt: new Date(2026, 10, 16, 9, 0) });
  const before = await readPdf(paper.bytes);
  assert.deepEqual(onSameLine(before.pages[0], 'Date of declaration'), [], 'blank until it is signed');
  const signed = await signPdf(paper.bytes, { name: 'Asha Clerk', title: 'Partner', signedAt: new Date(2026, 10, 18, 14, 5) });
  const read = await readPdf(signed.bytes);
  assert.deepEqual(onSameLine(read.pages[0], 'Date of declaration'), ['18/11/2026']);
  assert.ok(read.text.includes('18 Nov 2026, 14:05'), 'the signature box has the same day');
  assert.ok(!read.text.includes('11/11/2026'), 'never the invoice date');

  // On an export draft the importer signs by hand: the house's sign-off leaves the importer's date blank.
  const exportStatement = await buildStatement({ kind: 'eu_dds', shipment: (await exportFixture()).shipment, stones: [], house: exportHouse(), status: 'ready_to_sign', printedAt: PRINTED });
  const exportSigned = await readPdf((await signPdf(exportStatement.bytes, { name: 'Asha Clerk', signedAt: new Date(2026, 10, 18, 14, 5) })).bytes);
  assert.deepEqual(onSameLine(exportSigned.pages[0], 'Date of declaration'), []);
});

test('lot lines count each stone: a 119-piece lot is 119 stones, and its average decides its scope', async () => {
  const lots = [
    { id: 'l1', reportNumber: null, carat: 5.0, pieces: 50, growth: 'natural', sizeRange: { min: null, max: null, melee: true } },
    { id: 'l2', reportNumber: null, carat: 94.88, pieces: 119, growth: 'natural' },
    { id: 'l3', reportNumber: '2141438199', lab: 'GIA', carat: 1.02, pieces: 1, growth: 'natural' },
  ];
  const goods = classifyGoods({ stones: lots });
  assert.equal(goods.stoneCount, 170);
  assert.equal(goods.stonesAtOrAboveHalf, 120);
  const facts = stoneFacts(lots);
  assert.equal(facts.count, 170);
  assert.equal(facts.inScopeCount, 120);

  const input = await exportFixture();
  const dds = await readPdf((await buildStatement({ kind: 'eu_dds', shipment: input.shipment, stones: lots, house: input.house, documents: input.documents, printedAt: PRINTED })).bytes);
  assert.ok(dds.text.includes('Natural stones of 0.50 ct and up 120 stones, 95.90 ct'), dds.text);
  const us = { ...input.shipment, destinationCountry: 'US' };
  const cbp = await readPdf((await buildStatement({ kind: 'us_cbp_certificate', shipment: us, stones: lots, house: input.house, printedAt: PRINTED })).bytes);
  assert.ok(cbp.text.includes('Stones 170 stones, 100.90 ct'));
  assert.ok(cbp.text.includes('Stones of 0.50 ct and up 120 stones, 95.90 ct'));

  // A lot whose average is under 0.50 ct, with no size range, may hold bigger stones: the paper says so.
  const unsized = lots.map((stone) => (stone.id === 'l1' ? { ...stone, sizeRange: null } : stone));
  const maybe = await readPdf((await buildStatement({ kind: 'eu_dds', shipment: input.shipment, stones: unsized, house: input.house, printedAt: PRINTED })).bytes);
  assert.ok(maybe.text.includes('120 stones, 95.90 ct. 50 more in lots that may reach 0.50 ct'));
  // No stone sizes at all: the row says so instead of claiming none are in scope.
  const none = await readPdf((await buildStatement({ kind: 'eu_dds', shipment: input.shipment, stones: [], house: input.house, printedAt: PRINTED })).bytes);
  assert.ok(none.text.includes('Natural stones of 0.50 ct and up Not on file'));
});

test('countries of mining print once each, by name, from the stones and the KP certificate', () => {
  const kp = { docType: 'kp_certificate', fields: [field('kp.countriesOfMining', 'Guinea, Ghana, Sierra Leone')] };
  assert.deepEqual(miningCountries([{ kp: { countries: ['GN', 'GH', 'SL'] } }], [kp]), ['Guinea', 'Ghana', 'Sierra Leone']);
  assert.deepEqual(miningCountries([{ kp: { countries: ['BW', 'NA'] } }], []), ['Botswana', 'Namibia']);
  const odd = { docType: 'kp_certificate', fields: [field('kp.countriesOfMining', 'Congo, Democratic Republic of the')] };
  assert.deepEqual(miningCountries([], [odd]), ['Democratic Republic of the Congo']);
  const typo = { docType: 'kp_certificate', fields: [field('kp.countriesOfMining', 'Botswana, Sierra Leon')] };
  assert.deepEqual(miningCountries([], [typo]), ['Botswana', 'Sierra Leon'], 'a name we do not know is kept as printed');
});

test('CBP sentences: loose stones, jewellery, both, and never jewellery the shipment does not have', () => {
  const t = TEMPLATES.us_cbp_certificate;
  assert.deepEqual(cbpSentences({ goods: { form: 'polished', hsCodes: ['71023910'] } }), [t.diamonds]);
  assert.deepEqual(cbpSentences({ goods: { form: 'jewelry', hsCodes: ['71131910'], loose: [] } }), [t.jewelry]);
  assert.deepEqual(cbpSentences({ goods: { form: 'jewelry', hsCodes: ['71131910', '71023910'], loose: ['polished'] } }), [t.diamonds, t.jewelry]);
  assert.deepEqual(cbpSentences({ goods: { form: 'mixed', hsCodes: ['71023100', '71023910'] } }), [t.diamonds], 'rough and polished are loose diamonds');
  assert.deepEqual(cbpSentences({ goods: { form: 'rough', hsCodes: ['71021000'] } }), [t.diamonds, t.jewelry], 'unsorted diamonds');
});

test('G7 / GF note for natural rough: Diamond Office verification, KP certificate and countries of mining', async () => {
  const input = await exportFixture();
  const shipment = { ...input.shipment, destinationCountry: 'DE', consignee: { name: 'Beispiel Diamanten GmbH (SAMPLE)', address: 'Beispielstrasse 1, Idar-Oberstein', country: 'DE' }, goods: { nature: 'natural', form: 'rough', hsCodes: ['71023100'] } };
  const stones = [{ id: 'r1', reportNumber: null, carat: 152.4, pieces: 210, growth: 'natural', kp: { certificateNumber: 'KP-SAMPLE-0001', countries: ['BW'] } }];
  const paper = await buildStatement({ kind: 'g7_gf_declaration', shipment, stones, house: input.house, documents: input.documents, printedAt: PRINTED });
  save('g7-note-rough.pdf', paper.bytes);
  const read = await readPdf(paper.bytes);
  assert.equal(read.numPages, 1);
  assert.ok(read.text.includes('EU · NATURAL ROUGH DIAMONDS'));
  assert.ok(read.text.includes('Diamond Office in Antwerp (FPS Economy, Hoveniersstraat 22, 2018 Antwerpen)'));
  assert.ok(read.text.includes('KP certificate KP-SAMPLE-0001'));
  assert.ok(read.text.includes('Countries of mining (KP) Botswana, Canada'));
  assert.ok(read.text.includes('Verified at Diamond Office, Antwerp'), 'a rough parcel for Germany is verified in Antwerp');
  assert.ok(!read.text.includes('Lab-grown goods use the Diamond Office'), 'not the lab-grown note');
  assert.ok(!read.text.includes('do not show lab-grown'));
  assert.ok(read.text.includes('1 March 2024 (1.0 ct and up)'), 'grandfathering follows EC FAQ Question 17');
  assertNoOverflow(read);

  const labGrown = await readPdf((await buildStatement({ kind: 'g7_gf_declaration', shipment: { ...input.shipment, goods: { nature: 'lab-grown', form: 'polished', hsCodes: ['71049100'] } }, stones: [], house: input.house, documents: [{ docType: 'commercial_invoice', fields: [field('goods.countryOfOrigin', 'India')] }], printedAt: PRINTED })).bytes);
  assert.ok(labGrown.text.includes('Country of manufacture India'));
});

test('one EU statement for several invoices names every invoice and the number of parcels', async () => {
  const input = await exportFixture();
  const second = { id: 'doc-inv2', docType: 'commercial_invoice', fileName: 'invoice-042.pdf', fields: [field('invoice.number', 'SGE/26-27/042')], lines: [] };
  const read = await readPdf((await buildStatement({ kind: 'eu_dds', shipment: input.shipment, stones: input.stones, house: input.house, documents: [...input.documents, second], printedAt: PRINTED })).bytes);
  assert.ok(read.text.includes('SAMPLE-EXP-041 / SGE/26-27/041, SGE/26-27/042 (2 parcels)'));
  assert.equal(read.numPages, 1);
});

test('the pack never reads as screened when OFAC screening was off, and states each regime\'s threshold', async () => {
  const input = await exportFixture();
  const off = await readPdf((await buildPack({ ...input, house: { ...input.house, permissions: { ofacScreen: false } } })).bytes);
  assert.ok(off.text.includes('OFAC screening was off for this house: the parties were not screened against this list.'));
  assert.ok(!off.text.includes('Every party in the shipment is screened against this list.'));
  assert.ok(off.text.includes('EU: diamonds of 0.50 ct and up a stone, natural and lab-grown.'));
  assert.ok(!off.text.includes('US: non-industrial diamonds'), 'an EU pack states the EU threshold');
  const us = await readPdf((await buildPack({ ...input, required: [{ kind: 'us_cbp_certificate', reason: 'US import.', signer: 'us_importer', regime: 'US' }] })).bytes);
  assert.ok(us.text.includes('US: non-industrial diamonds of 0.50 ct and up; diamond jewellery and unsorted diamonds at any weight.'));
  assert.ok(us.text.includes('Every party in the shipment is screened against this list.'));
});

test('original PDFs go into the pack unchanged on the page, but with nothing that can run or open', async () => {
  const input = await exportFixture();
  const src = await PDFDocument.create();
  const page = src.addPage([595.28, 841.89]);
  page.drawText('SAMPLE supplier invoice with scripts', { x: 56, y: 760, size: 14, font: await src.embedFont(StandardFonts.Helvetica) });
  const c = src.context;
  const js = c.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("SAMPLE")') });
  page.node.set(PDFName.of('AA'), c.obj({ O: js }));
  const link = c.register(c.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], A: c.obj({ S: 'Launch', F: PDFString.of('sample.exe') }) }));
  const attachment = c.register(c.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [10, 40, 30, 60], FS: c.obj({ Type: 'Filespec', F: PDFString.of('sample.exe') }) }));
  page.node.set(PDFName.of('Annots'), c.obj([link, attachment]));
  const files = { 'docs/doc-inv/invoice-041.pdf': await src.save() };
  const pack = await buildPack({ ...input, getFile: (key) => files[key] || input.getFile(key) });
  const invoicePage = pack.contents.find((item) => item.docId === 'doc-inv').page;
  const out = await PDFDocument.load(pack.bytes);
  const copied = out.getPages()[invoicePage - 1];
  assert.equal(copied.node.get(PDFName.of('AA')), undefined, 'no page actions');
  const annots = copied.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const kinds = [];
  for (let i = 0; i < annots.size(); i++) {
    const annot = out.context.lookup(annots.get(i), PDFDict);
    kinds.push(annot.get(PDFName.of('Subtype')).decodeText());
    assert.equal(annot.get(PDFName.of('A')), undefined, 'no annotation actions');
  }
  assert.deepEqual(kinds, ['Link'], 'the file attachment is left out');
  assert.ok((await readPdf(pack.bytes)).pages[invoicePage - 1].text.includes('SAMPLE supplier invoice with scripts'), 'what is printed stays');
});

test('the agents\' packing list draft stays out of the envelope until a person checked it', async () => {
  const input = await exportFixture();
  const lines = input.stones.slice(0, 3).map((s, i) => ({ lineNo: i + 1, description: 'Natural polished diamond', reportNumber: s.reportNumber, lab: s.lab, shape: s.shape, carat: s.carat, color: s.color, clarity: s.clarity, pieces: 1, rate: null, amount: null, growth: 'natural', quote: null }));
  const draft = { id: 'doc-draft', fileName: 'Packing list draft SAMPLE-EXP-041.pdf', mime: 'application/pdf', fileKey: 'docs/doc-draft/draft.pdf', sha256: '99'.repeat(32), docType: 'packing_list', source: { kind: 'generated', receivedAt: '2026-11-14T10:00:00.000Z' }, fields: [field('invoice.number', 'SGE/26-27/041')], lines };
  const documents = [...input.documents.filter((d) => d.id !== 'doc-pkl'), draft];
  const files = { 'docs/doc-draft/draft.pdf': await makePdf('SAMPLE DRAFT packing list. Check every line before use.', 1) };
  const getFile = (key) => files[key] || input.getFile(key);

  const unchecked = await buildPack({ ...input, documents, getFile });
  assert.ok(!unchecked.contents.some((item) => item.docId === 'doc-draft'), 'not in the envelope');
  const read = await readPdf(unchecked.bytes);
  assert.ok(read.text.includes('Not on file Packing list'));
  assert.ok(read.text.includes('Kept on record'));

  const checkedDraft = { ...draft, fields: [...draft.fields, { key: 'doc.checkedBy', value: 'Yes, use it as our packing list', by: 'Asha Clerk', page: null }] };
  const checked = await buildPack({ ...input, documents: [...input.documents.filter((d) => d.id !== 'doc-pkl'), checkedDraft], getFile });
  const item = checked.contents.find((c) => c.docId === 'doc-draft');
  assert.ok(item && item.attached, 'in the envelope once checked');
  const checkedRead = await readPdf(checked.bytes);
  assert.ok(checkedRead.pages[item.page - 1].text.includes('checked line by line by Asha Clerk at the house'));
  assert.ok(!checkedRead.text.includes('Check every line before use'), 'the DRAFT copy is not the one in the envelope');
  assert.ok(checkedRead.text.includes('Not on file Nothing required is missing.'));
  assertNoOverflow(checkedRead);
});

test('labs print by a short name with a key, so a long lab name never breaks mid-word', async () => {
  const input = await exportFixture();
  const stones = input.stones.slice(0, 5).map((s) => ({ ...s, lab: 'Northbridge Gem Laboratory (SAMPLE)' }));
  const read = await readPdf((await buildPack({ ...input, stones })).bytes);
  const stoneList = read.pages.find((p) => p.text.includes('Stones in this shipment'));
  assert.ok(stoneList.text.includes(' NGL '));
  assert.ok(stoneList.text.includes('Labs: NGL is Northbridge Gem Laboratory (SAMPLE).'));
  assert.ok(!/Northbrid(?!ge)/.test(stoneList.text), 'no word cut in two');
  const lines = stones.map((s, i) => ({ lineNo: i + 1, description: 'Natural polished diamond', reportNumber: s.reportNumber, lab: s.lab, shape: s.shape, carat: s.carat, color: s.color, clarity: s.clarity, pieces: 1, growth: 'natural' }));
  const draft = await readPdf((await buildPackingListDraft({ shipment: input.shipment, lines, sources: [], house: input.house, printedAt: PRINTED })).bytes);
  assert.ok(draft.text.includes('Labs: NGL is Northbridge Gem Laboratory (SAMPLE).'));
  assertNoOverflow(read);
});

test('a difference a person accepted prints as accepted; the cover takes the package count from the air waybill', async () => {
  const input = await exportFixture();
  input.checks.push({ id: 'ck-acc', shipmentId: 'sh-exp', code: 'stone_details', severity: 'info', accepted: true, title: 'Stones agree across papers', detail: 'Accepted by the house: Report SMP9100001: the house answered 0.49 ct, but the lab report says 0.50 ct.', evidence: [], rule: 'compliance.js#stone_details' });
  delete input.shipment.packages;
  input.documents = input.documents.map((d) => (d.id === 'doc-awb' ? { ...d, fields: [...d.fields, field('goods.packages', '2')] } : d));
  const read = await readPdf((await buildPack(input)).bytes);
  assert.ok(read.pages[1].text.includes('Accepted Stones agree across papers'));
  assert.ok(read.pages[0].text.includes('Number of pieces (packages) 2'));
});
