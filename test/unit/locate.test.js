// Tests for records/locate.js: finding a quoted value among page words and returning its box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalNumber, locate, locateFields, tokenize } from '../../src/core/records/locate.js';

// Lays out lines of text on a simple grid: every character is 0.01 wide, lines are 0.05 apart.
// That makes the expected boxes easy to work out by hand.
function page(pageNo, lines) {
  const words = [];
  lines.forEach((line, row) => {
    let x = 0.05;
    for (const text of line.split(' ').filter(Boolean)) {
      const width = text.length * 0.01;
      words.push({ text, page: pageNo, x0: round(x), y0: round(0.1 + row * 0.05), x1: round(x + width), y1: round(0.13 + row * 0.05) });
      x += width + 0.01;
    }
  });
  return words;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function boxOf(words, text) {
  const word = words.find((w) => w.text === text);
  return [word.x0, word.y0, word.x1, word.y1];
}

const INVOICE = page(1, [
  'SAMPLE COMMERCIAL INVOICE',
  'Invoice No: EXP/26-27/28 Date: 05/11/2026',
  'Shipping Bill No: 7955006',
  'Exporter: SAMPLE Exports Pvt Ltd',
  'Plot 12, Diamond Park',
  'Surat 395007 India',
  '1 GIA 7000000001 Round 1,02 D VVS1 USD 12,345.00',
  '2 GIA 7000000002 Round 0.71 E VS1 USD 4,100.50',
  'Total carats (ct) 1.73',
]);

test('tokenize lowercases, drops punctuation and accents, keeps numbers whole', () => {
  assert.deepEqual(tokenize('Invoice No: EXP/26-27/28'), ['invoice', 'no', 'exp', '26', '27', '28']);
  assert.deepEqual(tokenize('Société Générale'), ['societe', 'generale']);
  assert.deepEqual(tokenize('Carat 1,02 ct'), ['carat', '1.02', 'ct']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('canonicalNumber writes every number one way', () => {
  const cases = {
    '1,02': '1.02', '1.02': '1.02', '1.020': '1.02', '1,020': '1020', '12,345.00': '12345', '12.345,00': '12345',
    '1,23,456.00': '123456', "1'234.50": '1234.5', '0.50': '0.5', '05': '5', '0': '0', '1.000.000': '1000000',
    '10.2': '10.2',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(canonicalNumber(input), expected, input);
});

test('finds a single value and returns its own box', () => {
  const found = locate(INVOICE, '7955006');
  assert.equal(found.page, 1);
  assert.deepEqual(found.box, boxOf(INVOICE, '7955006'));
  assert.equal(found.score, 1);
});

test('ignores case, punctuation, odd spaces and unicode dashes', () => {
  const found = locate(INVOICE, 'INVOICE NO.\u00a0exp/26\u201327/28');
  const start = boxOf(INVOICE, 'Invoice');
  const end = boxOf(INVOICE, 'EXP/26-27/28');
  assert.deepEqual(found.box, [start[0], start[1], end[2], end[3]]);
});

test('a decimal comma matches a decimal point and thousands separators are ignored', () => {
  assert.deepEqual(locate(INVOICE, '1.02').box, boxOf(INVOICE, '1,02'));
  assert.deepEqual(locate(INVOICE, 'USD 12345').box[2], boxOf(INVOICE, '12,345.00')[2]);
  assert.deepEqual(locate(INVOICE, '4100.50').box, boxOf(INVOICE, '4,100.50'));
  const european = page(1, ['Montant 12.345,00 EUR']);
  assert.deepEqual(locate(european, '12,345.00').box, boxOf(european, '12.345,00'));
});

test('numbers never match a different number', () => {
  const words = page(1, ['Amount 1,020.50 and weight 10.2 ct']);
  assert.equal(locate(words, '1.02'), null);
  assert.equal(locate(INVOICE, '7000000003'), null);
  assert.deepEqual(locate(INVOICE, '7000000002').box, boxOf(INVOICE, '7000000002'));
});

test('a quote spread over several lines gets one box around all of it', () => {
  const found = locate(INVOICE, 'SAMPLE Exports Pvt Ltd, Plot 12, Diamond Park, Surat 395007');
  assert.equal(found.score, 1);
  const first = boxOf(INVOICE, 'Exports');
  const last = boxOf(INVOICE, '395007');
  assert.equal(found.box[1], first[1]);
  assert.equal(found.box[3], last[3]);
  assert.ok(found.box[0] <= boxOf(INVOICE, 'Plot')[0]);
});

test('a long quote may be found in part (at least 60% of its words)', () => {
  const found = locate(INVOICE, 'SAMPLE Exports Private Limited, Plot 12, Diamond Park, Surat');
  assert.ok(found, 'expected a partial match');
  assert.ok(found.score >= 0.6 && found.score < 1, `score ${found.score}`);
  assert.equal(found.page, 1);
});

test('a long quote below 60% is not found', () => {
  assert.equal(locate(INVOICE, 'Cut and polished natural diamonds of one half carat and above'), null);
});

test('a long quote with a wrong number is not found, even when most words match', () => {
  assert.equal(locate(INVOICE, 'Invoice No: EXP/26-27/29 Date: 05/11/2026'), null);
});

test('a short quote may skip one extra word on the page', () => {
  const found = locate(INVOICE, 'Total carats 1.73');
  assert.ok(found);
  assert.equal(found.box[0], boxOf(INVOICE, 'Total')[0]);
  assert.equal(found.box[2], boxOf(INVOICE, '1.73')[2]);
});

test('prefers the page the reader named, but not over a much better match elsewhere', () => {
  const words = [...page(1, ['Port of loading Surat']), ...page(2, ['Consignee in Antwerp, from Surat', 'Exporter SAMPLE Exports Pvt Ltd Surat'])];
  assert.equal(locate(words, 'Surat').page, 1);
  assert.equal(locate(words, 'Surat', { page: 2 }).page, 2);
  assert.equal(locate(words, 'Surat', { page: '2' }).page, 2, 'a page number sent as text works too');
  // Whole on page 2, only a part on page 1: page 2 wins although page 1 was named.
  const both = [...page(1, ['SAMPLE Exports Pvt']), ...page(2, ['SAMPLE Exports Pvt Ltd Surat'])];
  assert.equal(locate(both, 'SAMPLE Exports Pvt Ltd Surat', { page: 1 }).page, 2);
});

test('a value split over two words, or glued to its label, is still found', () => {
  const split = page(1, ['Invoice EXP/26-27/ 28']);
  const found = locate(split, 'EXP/26-27/28');
  assert.deepEqual(found.box, [boxOf(split, 'EXP/26-27/')[0], boxOf(split, 'EXP/26-27/')[1], boxOf(split, '28')[2], boxOf(split, '28')[3]]);
  const glued = page(1, ['Shipping Bill No:7955006']);
  assert.deepEqual(locate(glued, '7955006').box, boxOf(glued, 'No:7955006'));
});

test('tolerates OCR look-alikes in numbers and one wrong letter in long words', () => {
  const ocr = page(1, ['lnvoice 7955O06 Consignce']);
  assert.deepEqual(locate(ocr, '7955006').box, boxOf(ocr, '7955O06'));
  assert.deepEqual(locate(ocr, 'Invoice').box, boxOf(ocr, 'lnvoice'));
  assert.deepEqual(locate(ocr, 'Consignee').box, boxOf(ocr, 'Consignce'));
  assert.equal(locate(ocr, 'Invoices sent'), null);
});

test('empty input gives null', () => {
  assert.equal(locate(INVOICE, ''), null);
  assert.equal(locate(INVOICE, null), null);
  assert.equal(locate([], 'Surat'), null);
  assert.equal(locate(null, 'Surat'), null);
  assert.equal(locate(INVOICE, '  ...  '), null);
});

test('words without a page count as page 1', () => {
  const words = page(1, ['Flight EK 507']).map(({ page: _page, ...rest }) => rest);
  assert.equal(locate(words, 'EK 507').page, 1);
});

test('locateFields fills page and box from the quote, else from the value', () => {
  const fields = [
    { key: 'shippingBill.number', value: '7955006', quote: 'Shipping Bill No: 7955006', page: null, confidence: 0.9 },
    { key: 'goods.totalCarats', value: '1.73', quote: null, page: 1, confidence: 0.8 },
    { key: 'awb.hawb', value: 'HAWB 123', quote: 'HAWB 123', page: 1, confidence: 0.5 },
    { key: 'kp.certificateNumber', value: 'IN0012345', quote: 'KP IN0012345', page: 2, confidence: 0.5, box: [0.1, 0.1, 0.2, 0.2] },
  ];
  const out = locateFields(INVOICE, fields);
  assert.equal(out, fields);
  assert.equal(fields[0].page, 1);
  assert.equal(fields[0].box[2], boxOf(INVOICE, '7955006')[2]);
  assert.deepEqual(fields[1].box, boxOf(INVOICE, '1.73'));
  assert.equal(fields[2].box, null);
  assert.deepEqual(fields[3].box, [0.1, 0.1, 0.2, 0.2], 'a box from elsewhere is kept when nothing is found');
  assert.equal(fields[3].page, 2);
});

test('runs quickly on a dense page', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`${i + 1} GIA ${7000000000 + i} Round ${(0.5 + i / 100).toFixed(2)} D VVS1 USD ${1000 + i}.00`);
  const words = page(1, lines);
  const started = Date.now();
  for (let i = 0; i < 20; i++) locate(words, 'SAMPLE Exports Pvt Ltd Plot 12 Diamond Park Surat Gujarat India');
  assert.ok(locate(words, `GIA ${7000000000 + 250}`));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
