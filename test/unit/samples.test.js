// Tests for the SAMPLE shipment (samples/generate.js and samples/lib/*):
// the build is deterministic, every file in answers.json exists, the WhatsApp zip and the email hold
// what they should, the insurance certificate is an image-only scan, and every paper is marked SAMPLE.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { simpleParser } from 'mailparser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildSampleSet } from '../../samples/lib/build.js';
import { FOOTER, SHIPMENTS } from '../../samples/lib/facts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES = path.join(ROOT, 'samples');
const SHIPMENT_DIR = path.join(SAMPLES, 'sample-shipment');
const ZIP_PATH = 'whatsapp/WhatsApp Chat - Kavya Gems Export Desk.zip';
const EMAIL_PATH = 'email/PO LDB-7781 from Lumen Diamant.eml';
const INSURANCE_PATH = 'drop/Insurance certificate KG-26-27-041.pdf';
const FORBIDDEN = /\bYC\b|Y Combinator|\bBrad\b/;

const require = createRequire(import.meta.url);
const FONT_DIR = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = (files) => Object.fromEntries(files.map((file) => [file.path, sha(file.bytes)]));

/** Text of every page of a PDF, plus how many text items pdf.js found. */
async function pdfText(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: FONT_DIR, verbosity: 0, isEvalSupported: false });
  const doc = await task.promise;
  try {
    let text = '';
    let items = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      items += content.items.filter((item) => item.str && item.str.trim()).length;
      text += `${content.items.map((item) => item.str).join(' ')}\n`;
    }
    return { pages: doc.numPages, items, text };
  } finally {
    await task.destroy();
  }
}

async function readSample(relative) {
  return new Uint8Array(await fs.readFile(path.join(SHIPMENT_DIR, relative)));
}

/** Every PDF in the committed sample set, including those inside the zip and the email: [{ name, bytes }]. */
async function allPdfs() {
  const pdfs = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.pdf')) pdfs.push({ name: path.relative(SHIPMENT_DIR, full), bytes: new Uint8Array(await fs.readFile(full)) });
    }
  };
  await walk(SHIPMENT_DIR);
  const zip = await JSZip.loadAsync(await readSample(ZIP_PATH));
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.pdf'))) {
    pdfs.push({ name: `${ZIP_PATH}/${name}`, bytes: await zip.files[name].async('uint8array') });
  }
  const mail = await simpleParser(Buffer.from(await readSample(EMAIL_PATH)));
  for (const attachment of mail.attachments) pdfs.push({ name: `${EMAIL_PATH}/${attachment.filename}`, bytes: new Uint8Array(attachment.content) });
  return pdfs;
}

describe('sample build', () => {
  let first;
  let tempDir;

  before(async () => {
    first = await buildSampleSet();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-samples-'));
  });

  after(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('two builds give the same bytes for every file and the same answer key', async () => {
    const second = await buildSampleSet();
    assert.deepEqual(hashes(second.files), hashes(first.files));
    assert.equal(JSON.stringify(second.answers), JSON.stringify(first.answers));
  });

  test('generate.js --out writes exactly the files of the build, plus answers.json', async () => {
    const run = spawnSync(process.execPath, [path.join(SAMPLES, 'generate.js'), '--out', tempDir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    for (const file of first.files) {
      const written = await fs.readFile(path.join(tempDir, 'sample-shipment', file.path));
      assert.equal(sha(written), sha(file.bytes), file.path);
    }
    const answers = JSON.parse(await fs.readFile(path.join(tempDir, 'answers.json'), 'utf8'));
    assert.deepEqual(answers, JSON.parse(JSON.stringify(first.answers)));
  });

  test('files sit in the delivery folders the demo expects', () => {
    const paths = first.files.map((file) => file.path).sort();
    assert.ok(paths.includes(ZIP_PATH));
    assert.ok(paths.includes(EMAIL_PATH));
    assert.ok(paths.includes('later/Packing list KG-26-27-041.xlsx'));
    assert.deepEqual(paths.filter((p) => p.startsWith('drop/') && !p.includes('shipment-')).sort(), [
      'drop/AWB 99000012345.pdf', 'drop/Factory record lot R-0412.xlsx', INSURANCE_PATH, 'drop/Shipping bill 1234567.pdf',
    ]);
    assert.equal(paths.filter((p) => p.startsWith('drop/shipment-b/')).length, 5);
    assert.equal(paths.filter((p) => p.startsWith('drop/shipment-c/')).length, 4);
    assert.ok(!paths.some((p) => p.startsWith('drop/') && /packing/i.test(p)), 'the packing list only arrives later');
  });
});

describe('committed sample set', () => {
  let answers;

  before(async () => {
    answers = JSON.parse(await fs.readFile(path.join(SAMPLES, 'answers.json'), 'utf8'));
  });

  test('every file in answers.json exists, including files inside the zip and the email', async () => {
    const zip = await JSZip.loadAsync(await readSample(ZIP_PATH));
    const mail = await simpleParser(Buffer.from(await readSample(EMAIL_PATH)));
    assert.equal(answers.files.length, 25);
    for (const file of answers.files) {
      await fs.access(path.join(SHIPMENT_DIR, file.path));
      if (!file.inside) continue;
      if (file.path === ZIP_PATH) assert.ok(zip.files[file.inside], `${file.inside} is in the zip`);
      else if (file.path === EMAIL_PATH) assert.ok(mail.attachments.some((a) => a.filename === file.inside), `${file.inside} is attached`);
      else assert.fail(`${file.id} points inside ${file.path}`);
    }
  });

  test('the WhatsApp zip holds _chat.txt and every attachment the chat names, but no packing list', async () => {
    const zip = await JSZip.loadAsync(await readSample(ZIP_PATH));
    const names = Object.keys(zip.files);
    assert.ok(names.includes('_chat.txt'));
    const chat = await zip.files['_chat.txt'].async('string');
    const attached = [...chat.matchAll(/<attached: ([^>]+)>/g)].map((m) => m[1]);
    assert.deepEqual(attached.sort(), names.filter((n) => n !== '_chat.txt').sort());
    assert.deepEqual(attached.map((n) => n.replace(/^\d{8}-/, '')).sort(), [
      '7391020001.pdf', '7391020002.pdf', '7391020003.pdf', '7391020006.pdf', 'Invoice KG-26-27-041.pdf',
      'KP AE-SAMPLE-0001234.pdf', 'PHOTO-2026-11-10-11-52-18.jpg', 'Supplier invoice SRT-2026-0315.pdf',
    ]);
    assert.ok(!names.some((n) => /packing|\.xlsx$/i.test(n)));
    // iPhone format, day first, between Ravi and the desk, with the promise and the typed stone list.
    assert.match(chat, /^\[10\/11\/26, 9:58:12\u202fAM\] Kavya Gems Export Desk: \u200eMessages and calls are end-to-end encrypted/);
    assert.match(chat, /\] Ravi \(Kavya Gems\): packing list is coming tomorrow/);
    assert.match(chat, /Jewel Labs desk: \u200eVoice call, \u200eNo answer/);
    assert.match(chat, /\r\n2\) OV 0\.71 F VS1 7391020002\r\n/);
    assert.match(chat, /\[13\/11\/26, 9:06:20\u202fAM\] Jewel Labs desk:/);
    // The photo is a real JPEG.
    const photo = await zip.files[attached.find((n) => n.endsWith('.jpg'))].async('uint8array');
    assert.deepEqual([...photo.slice(0, 3)], [0xff, 0xd8, 0xff]);
  });

  test('the email is from the buyer, asks for the EU statement and carries PO LDB-7781 as a PDF', async () => {
    const mail = await simpleParser(Buffer.from(await readSample(EMAIL_PATH)));
    assert.equal(mail.from.value[0].address, 'buying@lumen-diamant.example.com');
    assert.equal(mail.subject, 'PO LDB-7781 from Lumen Diamant');
    assert.match(mail.text, /signed EU statement/);
    assert.match(mail.text, /KG\/26-27\/041/);
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].contentType, 'application/pdf');
    const po = await pdfText(mail.attachments[0].content);
    assert.match(po.text, /PURCHASE ORDER/);
    assert.match(po.text, /KG\/26-27\/041/);
    assert.match(po.text, /Due Diligence Statement on Diamond Origin/);
  });

  test('the insurance certificate is an image-only scan with no text layer', async () => {
    const bytes = await readSample(INSURANCE_PATH);
    const info = await pdfText(bytes);
    assert.equal(info.pages, 1);
    assert.equal(info.items, 0, 'no text at all, so OCR or vision must read it');
    const raw = Buffer.from(bytes).toString('latin1');
    assert.match(raw, /\/Subtype\s*\/Image/);
    assert.match(raw, /\/DCTDecode/);
  });

  test('every text PDF has one page, the SAMPLE footer and fictional names only', async () => {
    const pdfs = await allPdfs();
    assert.equal(pdfs.length, 20);
    const textPdfs = pdfs.filter((pdf) => pdf.name !== INSURANCE_PATH);
    for (const pdf of textPdfs) {
      const info = await pdfText(pdf.bytes);
      assert.equal(info.pages, 1, pdf.name);
      assert.ok(info.text.includes(FOOTER), `${pdf.name} has the footer`);
      assert.match(info.text, /\(SAMPLE\)/, `${pdf.name} names a SAMPLE company`);
      assert.doesNotMatch(info.text, FORBIDDEN, pdf.name);
      assert.doesNotMatch(info.text, /\u2014/, `${pdf.name} has no em dash`);
    }
  });

  test('the spreadsheets, chat and email are fictional too', async () => {
    const texts = [];
    for (const relative of ['later/Packing list KG-26-27-041.xlsx', 'drop/Factory record lot R-0412.xlsx']) {
      const book = XLSX.read(await readSample(relative), { type: 'array' });
      const sheet = book.Sheets[book.SheetNames[0]];
      const text = XLSX.utils.sheet_to_csv(sheet);
      assert.ok(text.includes(FOOTER), relative);
      texts.push(text);
    }
    const zip = await JSZip.loadAsync(await readSample(ZIP_PATH));
    texts.push(await zip.files['_chat.txt'].async('string'));
    texts.push(Buffer.from(await readSample(EMAIL_PATH)).toString('utf8'));
    texts.push(JSON.stringify(answers));
    for (const text of texts) {
      assert.doesNotMatch(text, FORBIDDEN);
      for (const email of text.match(/[\w.-]+@[\w.-]+\.[a-z]+/gi) || []) assert.match(email, /\.example\.com$/, email);
    }
  });

  test('the packing list copies 0.71 ct from the invoice, the factory record says 0.70 ct like the lab', async () => {
    const packing = XLSX.read(await readSample('later/Packing list KG-26-27-041.xlsx'), { type: 'array' });
    const packingRows = XLSX.utils.sheet_to_json(packing.Sheets[packing.SheetNames[0]], { header: 1, raw: false });
    assert.equal(packingRows.find((row) => row[7] === '7391020002')[3], '0.71');
    const factory = XLSX.read(await readSample('drop/Factory record lot R-0412.xlsx'), { type: 'array' });
    const factoryRows = XLSX.utils.sheet_to_json(factory.Sheets[factory.SheetNames[0]], { header: 1, raw: false });
    assert.equal(factoryRows.find((row) => row[1] === '7391020002')[3], '0.70');
    assert.ok(factoryRows.some((row) => row[1] === 'AE-SAMPLE-0001234'), 'the factory record names the KP certificate');
  });

  test('answers.json matches the facts the papers were drawn from', async () => {
    const A = answers.shipments.A;
    assert.equal(A.ref, 'KG/26-27/041');
    assert.equal(A.regime, 'EU');
    assert.deepEqual(A.required, ['export_pack', 'eu_dds']);
    assert.equal(A.stones.length, 6);
    const mismatch = A.expectedChecks.find((check) => check.issue === 'carat_mismatch');
    assert.equal(mismatch.reportNumber, '7391020002');
    assert.deepEqual(mismatch.values, { commercial_invoice: 0.71, packing_list: 0.71, lab_report: 0.7, factory_record: 0.7 });
    assert.equal(A.stones.find((s) => s.reportNumber === '7391020002').carat, 0.7);
    assert.equal(A.stones.find((s) => s.line === 4).reportNumber, null);
    assert.ok(A.expectedChecks.some((check) => check.code === 'required_documents' && check.missing.includes('packing_list')));
    assert.deepEqual(A.history.countriesOfMining, ['Botswana', 'Namibia']);
    assert.equal(A.totals.value, 37274.5);

    const B = answers.shipments.B;
    assert.equal(B.goods.nature, 'lab-grown');
    assert.ok(B.expectedChecks.some((check) => check.code === 'eu_dds_required' && check.expect === 'absent'));
    assert.deepEqual(B.lots.map((lot) => [lot.pieces, lot.carats]), [[120, 96.4], [80, 61.15]]);

    const C = answers.shipments.C;
    assert.equal(C.regime, 'US');
    assert.ok(C.required.includes('us_cbp_certificate'));
    assert.deepEqual(C.stones.map((s) => s.carat), [1.21, 0.8]);

    // Every report number is a 10-digit number starting 739, and every answer file names its doc type.
    for (const shipment of Object.values(answers.shipments)) {
      for (const stone of shipment.stones.filter((s) => s.reportNumber)) assert.match(stone.reportNumber, /^739\d{7}$/);
    }
    for (const file of answers.files) assert.ok(file.docType, file.id);
    assert.equal(answers.files.find((f) => f.id === 'A-insurance').textLayer, false);
    assert.equal(answers.files.find((f) => f.id === 'A-report-7391020005-photo').kind, 'image');
  });

  test('invoice totals add up from the stone lines', () => {
    for (const shipment of Object.values(SHIPMENTS)) {
      const file = answers.files.find((f) => f.id === `${shipment.id}-invoice`);
      const cents = file.lines.reduce((sum, line) => sum + Math.round(line.amount * 100), 0);
      assert.equal(String(cents / 100), file.fields['goods.totalValue'].value, shipment.id);
      for (const line of file.lines) assert.equal(Math.round(line.carat * line.rate * 100) / 100, line.amount);
    }
  });
});
