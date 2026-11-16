// Tests for the rules: formats, field parsing, goods classification and the compliance checks.
// All companies, numbers and papers here are fictional SAMPLE data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumber, parseDate, parseCurrency, normalizeRef, isUsefulRef, namesMatch, getField, formatDate, formatCarat,
} from '../../src/core/rules/fields.js';
import {
  normalizeCountry, splitCountries, isEU, countryName, findRussiaWord, countryListHasRussia, hsInfo, formatHsCode,
  checkReportNumber, normalizeShape, normalizeColor, normalizeClarity, natureFromText, formFromText, isKpParticipant,
  normalizeLab,
} from '../../src/core/rules/formats.js';
import { RULES_VERSION, classifyGoods, evaluate, regimeOf } from '../../src/core/rules/compliance.js';
import { groupShipments } from '../../src/core/records/shipments.js';
import { matchStones } from '../../src/core/records/stones.js';

// ---------- fixture helpers ----------

let clock = 0;
function doc(id, docType, fields = {}, lines = [], extra = {}) {
  clock += 1;
  return {
    id,
    workspaceId: 'ws_sample',
    fileName: `${id}.pdf`,
    sha256: `sha-${id}`,
    docType,
    createdAt: `2026-11-10T11:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}Z`,
    fields: Object.entries(fields).map(([key, value]) => ({ key, value, quote: String(value), page: 1, confidence: 0.95 })),
    lines: lines.map((line, i) => ({
      lineNo: i + 1, description: null, reportNumber: null, lab: null, shape: null, carat: null, color: null,
      clarity: null, pieces: null, rate: null, amount: null, growth: null, quote: null, ...line,
    })),
    declarations: [],
    shipmentId: null,
    status: 'read',
    source: { kind: 'sample', receivedAt: '2026-11-10T11:00:00Z' },
    ...extra,
  };
}

const HOUSE = { id: 'ws_sample', name: 'Kestrel Gems (SAMPLE)', legalEntity: 'Kestrel Gems Pvt Ltd', country: 'IN' };
const EXPORTER = { 'exporter.name': 'Kestrel Gems Pvt Ltd', 'exporter.address': 'Plot 12, Sample Diamond Park, Surat 395004, India', 'exporter.country': 'India' };

function sum(lines, key) {
  return Math.round(lines.reduce((total, line) => total + (line[key] || 0), 0) * 1000) / 1000;
}

/**
 * One export parcel from Surat: invoice, packing list, shipping bill with LEO, air waybill, plus extras.
 * opts: { p (id prefix), invoiceNo, consignee, destination, hs, description, lines, extraDocs, invoiceExtra, skip: ['packing_list'] }
 */
function parcel(opts) {
  const { p, invoiceNo, consignee, destination, hs, description, lines } = opts;
  const party = { 'consignee.name': consignee.name, 'consignee.address': consignee.address, 'consignee.country': consignee.country };
  const pieces = lines.reduce((total, line) => total + (line.pieces || 1), 0);
  const totals = { 'goods.totalPieces': String(pieces), 'goods.totalCarats': String(sum(lines, 'carat')), 'goods.totalValue': String(sum(lines, 'amount')), 'goods.currency': 'USD' };
  const docs = [
    doc(`${p}-inv`, 'commercial_invoice', {
      'invoice.number': invoiceNo, 'invoice.date': '05/11/2026', ...EXPORTER, ...party, 'goods.description': description,
      'goods.hsCode': hs, 'goods.destinationCountry': destination, ...totals,
    }, lines, opts.invoiceExtra || {}),
    doc(`${p}-pl`, 'packing_list', { 'invoice.number': invoiceNo, 'doc.date': '05/11/2026', ...EXPORTER, ...party,
      'goods.totalPieces': totals['goods.totalPieces'], 'goods.totalCarats': totals['goods.totalCarats'] }, lines.map(({ amount, ...line }) => line)),
    doc(`${p}-sb`, 'shipping_bill', { 'shippingBill.number': `79${p.length}5${clock}`, 'leo.date': '07/11/2026', 'invoice.number': invoiceNo,
      'exporter.name': 'KESTREL GEMS PRIVATE LIMITED', 'consignee.name': consignee.name.toUpperCase(), 'goods.hsCode': hs,
      'goods.totalCarats': totals['goods.totalCarats'], 'goods.totalValue': totals['goods.totalValue'], 'goods.currency': 'USD',
      'awb.hawb': `SMP ${p}-${clock}` }),
    doc(`${p}-awb`, 'air_waybill', { 'awb.hawb': `SMP ${p}-${clock - 1}`, 'awb.date': '08/11/2026', 'invoice.number': invoiceNo,
      'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': consignee.name }),
    ...(opts.extraDocs || []),
  ];
  const skip = opts.skip || [];
  return docs.filter((d) => !skip.includes(d.docType));
}

const BELGIUM_BUYER = { name: 'Example Diamonds BV', address: 'Sample Straat 1, 2018 Antwerpen', country: 'Belgique' };
const NATURAL_LINES = [
  { reportNumber: '2141438171', lab: 'GIA', shape: 'RD', carat: 1.01, color: 'G', clarity: 'VS1', amount: 9800 },
  { reportNumber: '2141438172', lab: 'GIA', shape: 'OV', carat: 0.72, color: 'F', clarity: 'VS2', amount: 5200 },
  { reportNumber: null, lab: null, shape: 'RD', carat: 0.45, color: 'H', clarity: 'SI1', amount: 1100 },
  { reportNumber: '2141438174', lab: 'GIA', shape: 'PS', carat: 1.2, color: 'E', clarity: 'VVS2', amount: 12400 },
  { reportNumber: '612345675', lab: 'IGI', shape: 'CU', carat: 0.58, color: 'G', clarity: 'VS1', amount: 3300 },
  { reportNumber: '2141438176', lab: 'GIA', shape: 'RD', carat: 1.01, color: 'F', clarity: 'VS2', amount: 6840 },
];

function kpCertificate(id, number, countries, fields = {}, extra = {}) {
  return doc(id, 'kp_certificate', { 'kp.certificateNumber': number, 'kp.countriesOfMining': countries, 'kp.exportingCountry': 'U.A.E.', 'kp.importingCountry': 'India', ...fields }, [], extra);
}

function euNatural(extra = {}) {
  return parcel({
    p: 'eu', invoiceNo: 'KG/26-27/041', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910',
    description: 'Cut and polished natural diamonds', lines: NATURAL_LINES, invoiceExtra: { parentId: 'eu-mail' },
    extraDocs: [
      doc('eu-lr6', 'lab_report', { 'lab.name': 'GIA', 'lab.reportNumber': '2141438176', 'lab.carat': '1.04', 'lab.shape': 'Round Brilliant', 'lab.color': 'F', 'lab.clarity': 'VS2' }),
      // The KP certificate came by email with the invoice (attachments of one email travel together).
      doc('eu-mail', 'email', {}, [], { refs: ['KG/26-27/041'] }),
      kpCertificate('eu-kp', 'AE 0457123', 'Botswana, Namibia', {}, { parentId: 'eu-mail' }),
      doc('eu-ins', 'insurance_certificate', {
        'doc.number': 'SAMPLE-INS-0041', 'invoice.number': 'KG/26-27/041', 'goods.totalCarats': '4.97', 'goods.totalValue': '38640',
        'goods.description': 'Cover excludes transits to/from/via Ukraine, Russia and Belarus.',
      }),
      doc('eu-chat', 'whatsapp_chat', {}, [], { refs: ['KG/26-27/041'] }),
      ...(extra.extraDocs || []),
    ],
    skip: extra.skip,
  });
}

function clearScreens(names = ['Kestrel Gems Pvt Ltd', 'Example Diamonds BV']) {
  return names.map((name) => ({ name, status: 'clear', best: null, compared: 12 }));
}

// Group, match and evaluate, like the pipeline does.
function run(documents, { screenings = clearScreens(), now = '2026-11-15' } = {}) {
  const { shipments } = groupShipments({ documents, shipments: [], house: HOUSE });
  assert.equal(shipments.length, 1, `one shipment expected, got ${shipments.length}`);
  const shipment = shipments[0];
  const { stones } = matchStones({ shipment, documents });
  const result = evaluate({ shipment, documents, stones, house: HOUSE, screenings, now });
  const byCode = Object.fromEntries(result.checks.map((c) => [c.code, c]));
  return { shipment, stones, result, byCode };
}

// ---------- fields and formats ----------

test('numbers parse with Indian, US and European separators', () => {
  assert.equal(parseNumber('2,49,503.13'), 249503.13);
  assert.equal(parseNumber('249,503.13'), 249503.13);
  assert.equal(parseNumber('249.503,13'), 249503.13);
  assert.equal(parseNumber('1 234,56'), 1234.56);
  assert.equal(parseNumber('0,51'), 0.51);
  assert.equal(parseNumber('1,234'), 1234);
  assert.equal(parseNumber('1.012 ct'), 1.012);
  assert.equal(parseNumber('USD 38,640.00'), 38640);
  assert.equal(parseNumber('5953.210 cts'), 5953.21);
  assert.equal(parseNumber('6 PCS'), 6);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('N/A'), null);
  assert.equal(parseNumber(4.5), 4.5);
  assert.equal(parseCurrency('USD 38,640.00'), 'USD');
  assert.equal(parseCurrency('HK$ 1,000'), 'HKD');
  assert.equal(parseCurrency('€ 900'), 'EUR');
});

test('dates parse day first, with month names and ISO', () => {
  assert.equal(parseDate('05/11/2026'), '2026-11-05');
  assert.equal(parseDate('05-11-26'), '2026-11-05');
  assert.equal(parseDate('11/25/2026'), '2026-11-25', 'a month-first date that cannot be day-first');
  assert.equal(parseDate('23-Oct-2026'), '2026-10-23');
  assert.equal(parseDate('Nov 5, 2026'), '2026-11-05');
  assert.equal(parseDate('2026-11-05T10:00:00Z'), '2026-11-05');
  assert.equal(parseDate('EK500 on 23-Oct-2026 from Surat'), '2026-10-23');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('soon'), null);
  assert.equal(formatDate('2026-11-07'), '07 Nov 2026');
});

test('refs normalize across spaces, slashes and dashes', () => {
  assert.equal(normalizeRef('EXP/26-27/28'), 'EXP262728');
  assert.equal(normalizeRef(' exp 26-27/28 '), 'EXP262728');
  assert.equal(normalizeRef('No. 7955006'), '7955006');
  assert.equal(isUsefulRef(normalizeRef('N/A')), false);
  assert.equal(isUsefulRef(normalizeRef('ABCD')), false, 'a ref needs a digit');
  assert.equal(isUsefulRef('28'), false, 'too short');
});

test('company names match fuzzily', () => {
  assert.ok(namesMatch('Kestrel Gems Pvt Ltd', 'M/s. KESTREL GEMS PRIVATE LIMITED'));
  assert.ok(namesMatch('Example Diamonds BV', 'EXAMPLE DIAMONDS B.V.'));
  assert.ok(namesMatch('Kestrel Gems', 'Kestrel Gems International'));
  assert.ok(namesMatch('Diamontaire Exports', 'Diamontair Exports'), 'small spelling slip');
  assert.ok(!namesMatch('Kestrel Gems', 'Example Diamonds BV'));
  assert.equal(getField({ fields: [{ key: 'a', value: ' ' }, { key: 'a', value: ' x ' }] }, 'a'), 'x');
});

test('countries normalize from names, codes, local forms and hub cities', () => {
  const cases = {
    'U.A.E.': 'AE', UAE: 'AE', 'United Arab Emirates': 'AE', 'Hong Kong': 'HK', USA: 'US', 'U.S.A.': 'US',
    Belgique: 'BE', BEL: 'BE', 'Antwerpen, Belgium': 'BE', Antwerp: 'BE', Surat: 'IN', Mumbai: 'IN', Dubai: 'AE',
    'Ramat Gan': 'IL', 'Tel Aviv': 'IL', 'New York, NY 10036': 'US', 'Los Angeles': 'US', Gaborone: 'BW', Bangkok: 'TH',
    'Russian Federation': 'RU', RUS: 'RU', UK: 'GB', "Côte d'Ivoire": 'CI', 'Plot 12, Diamond Park, Surat 395004, India': 'IN',
  };
  for (const [input, code] of Object.entries(cases)) assert.equal(normalizeCountry(input), code, input);
  assert.equal(normalizeCountry('NA'), null, 'a bare NA means not applicable');
  assert.equal(normalizeCountry('Atlantis'), null);
  assert.deepEqual(splitCountries('Botswana, Namibia'), ['BW', 'NA']);
  assert.deepEqual(splitCountries('BW, NA, ZA'), ['BW', 'NA', 'ZA']);
  assert.deepEqual(splitCountries('Mixed: Botswana / Canada'), ['BW', 'CA']);
  assert.deepEqual(splitCountries('Congo, Democratic Republic of the'), ['CD']);
  assert.equal(countryName('BE'), 'Belgium');
  assert.ok(isEU('Belgium') && isEU('DE') && isEU('Antwerp'));
  assert.ok(!isEU('United Kingdom') && !isEU('Dubai') && !isEU('US'));
  assert.ok(isKpParticipant('India') && isKpParticipant('France') && !isKpParticipant('Atlantis'));
  assert.equal(regimeOf('Belgique'), 'EU');
  assert.equal(regimeOf('USA'), 'US');
  assert.equal(regimeOf('UK'), 'UK');
  assert.equal(regimeOf('Dubai'), 'OTHER');
});

test('Russia indicators are found, negated mentions are not', () => {
  assert.equal(findRussiaWord('Rough from ALROSA, Mirny'), 'ALROSA');
  assert.equal(findRussiaWord('Plot No. 5, Lenina Street, Sakha Republic'), 'SAKHA');
  assert.equal(findRussiaWord('Mined in Yakutia'), 'YAKUTIA');
  assert.equal(findRussiaWord('The diamonds herein are not of Russian origin.'), null);
  assert.equal(findRussiaWord('Non-Russian goods only'), null);
  assert.equal(findRussiaWord('Cover excludes transits to/from/via Ukraine, Russia and Belarus.'), 'RUSSIA', '"excludes" is not a negation word');
  assert.equal(findRussiaWord('excluding transits to/from/via/within Ukraine, Russia, Belarus'), null);
  assert.ok(countryListHasRussia('BW, RU'));
  assert.ok(countryListHasRussia('Botswana, Russian Federation'));
  assert.ok(countryListHasRussia('RUS'));
  assert.ok(!countryListHasRussia('Botswana, Namibia'));
});

test('HS codes say nature and form, including Indian 8-digit codes', () => {
  assert.equal(formatHsCode('71023910'), '7102.39');
  assert.equal(formatHsCode('7102.39.10'), '7102.39');
  assert.equal(formatHsCode('711319'), '7113');
  assert.deepEqual(pick(hsInfo('71023910')), { nature: 'natural', form: 'polished' });
  assert.deepEqual(pick(hsInfo('7102.31')), { nature: 'natural', form: 'rough' });
  assert.deepEqual(pick(hsInfo('71049120')), { nature: 'lab-grown', form: 'polished' });
  assert.deepEqual(pick(hsInfo('7104.21')), { nature: 'lab-grown', form: 'rough' });
  assert.equal(hsInfo('7102.10').unsorted, true);
  assert.equal(hsInfo('7102.21').industrial, true);
  assert.equal(hsInfo('7113.19').form, 'jewelry');
  assert.equal(hsInfo('7103.91'), null, 'rubies are not diamonds');
  function pick(info) {
    return { nature: info.nature, form: info.form };
  }
});

test('report numbers, grades and nature words', () => {
  assert.equal(checkReportNumber('GIA', '2141438171').ok, true);
  assert.equal(checkReportNumber('GIA', 'GIA # 2141 438 171').ok, true);
  assert.equal(checkReportNumber('GIA', '21414').ok, false);
  assert.equal(checkReportNumber('IGI', 'LG612345678').ok, true);
  assert.equal(checkReportNumber('IGI', 'LG12').ok, false);
  assert.equal(checkReportNumber(null, '123').ok, null, 'unknown lab: no format to check');
  assert.equal(normalizeLab('Gemological Institute of America'), 'GIA');
  assert.equal(normalizeLab('Northbridge Gem Laboratory (SAMPLE)'), 'Northbridge Gem Laboratory (SAMPLE)', 'other labs keep their name');
  assert.equal(checkReportNumber('Northbridge Gem Laboratory (SAMPLE)', '7391020001').ok, null);
  assert.equal(normalizeShape('Round Brilliant'), 'Round');
  assert.equal(normalizeShape('Cushion Modified Brilliant'), 'Cushion');
  assert.equal(normalizeShape('PS'), 'Pear');
  assert.equal(normalizeColor('g color'), 'G');
  assert.equal(normalizeColor('Fancy Yellow'), 'FANCY YELLOW');
  assert.equal(normalizeClarity('VS 1'), 'VS1');
  assert.equal(normalizeClarity('vvs-2'), 'VVS2');
  assert.equal(natureFromText('Lab grown diamonds (CVD)'), 'lab-grown');
  assert.equal(natureFromText('LGD polished'), 'lab-grown');
  assert.equal(natureFromText('Natural cut & polished diamonds'), 'natural');
  assert.equal(natureFromText('Determined by examination'), null);
  assert.equal(formFromText('Cut & polished diamonds'), 'polished');
  assert.equal(formFromText('Rough diamonds, unworked'), 'rough');
  assert.equal(formFromText('18K gold ring with diamonds'), 'jewelry');
});

test('classifyGoods weighs stones, then HS codes, then fields, then descriptions', () => {
  const invoice = doc('c-inv', 'commercial_invoice', { 'goods.hsCode': '71023910', 'goods.description': 'Polished diamonds' }, [
    { carat: 1.01, shape: 'RD' }, { carat: 0.3, shape: 'RD' },
  ]);
  const natural = classifyGoods({ documents: [invoice], stones: [] });
  assert.equal(natural.nature, 'natural');
  assert.equal(natural.form, 'polished');
  assert.deepEqual(natural.hsCodes, ['7102.39']);
  assert.equal(natural.maxCarat, 1.01);
  assert.equal(natural.stonesAtOrAboveHalf, 1);
  assert.equal(natural.stoneCount, 2);

  const mixed = classifyGoods({ documents: [invoice], stones: [{ growth: 'natural', carat: 1 }, { growth: 'lab-grown', carat: 2 }] });
  assert.equal(mixed.nature, 'mixed');

  const jewellery = classifyGoods({ documents: [doc('c-j', 'commercial_invoice', { 'goods.hsCode': '7113.19', 'goods.description': '18K gold ring set with natural diamonds' })] });
  assert.equal(jewellery.form, 'jewelry');
  assert.equal(jewellery.nature, 'natural');

  const unknown = classifyGoods({ documents: [doc('c-u', 'commercial_invoice', { 'goods.description': 'Goods as per list' })] });
  assert.equal(unknown.nature, 'unknown');
  assert.equal(unknown.form, 'unknown');
  assert.equal(unknown.sizesKnown, false);
});

// ---------- compliance scenarios ----------

test('natural polished India to Belgium: EU statement required, the carat mismatch is a question', () => {
  const { result, byCode, stones } = run(euNatural());
  assert.equal(RULES_VERSION, 'compliance.js 1.0');
  assert.equal(stones.length, 6);
  assert.equal(result.regime, 'EU');
  assert.deepEqual(result.required.map((r) => r.kind), ['export_pack', 'eu_dds']);
  const dds = result.required.find((r) => r.kind === 'eu_dds');
  assert.equal(dds.signer, 'importer');
  assert.equal(dds.regime, 'EU');
  assert.match(dds.reason, /AWDC EU Import Guidelines, update 1 January 2026/);
  assert.match(dds.reason, /several parcels/);
  assert.match(dds.reason, /5 years/);

  assert.equal(byCode.destination_regime.severity, 'pass');
  assert.equal(byCode.destination_regime.detail, 'Belgium. EU rules apply.');
  assert.equal(byCode.goods_class.detail, 'Natural polished diamonds (HS 7102.39).');
  assert.equal(byCode.half_carat_stones.detail, '5 of 6 stones are 0.50 ct or more (largest 1.20 ct).');
  assert.equal(byCode.eu_dds_required.severity, 'info');
  assert.equal(byCode.russia_anywhere.severity, 'pass', 'insurance exclusion wording is not a Russia hit');
  assert.equal(byCode.kp_present.severity, 'pass');
  assert.equal(byCode.kp_countries_listed.detail, 'Mined in Botswana and Namibia.');
  assert.equal(byCode.lab_reports_for_half_carat.severity, 'pass');
  assert.equal(byCode.report_format.severity, 'pass');
  assert.equal(byCode.duplicate_reports.severity, 'pass');
  assert.equal(byCode.stone_details.severity, 'warn');
  assert.equal(byCode.totals_consistency.severity, 'pass', byCode.totals_consistency.detail);
  assert.equal(byCode.parties_consistency.severity, 'pass', byCode.parties_consistency.detail);
  assert.equal(byCode.dates_order.severity, 'pass');
  assert.equal(byCode.nature_consistency.severity, 'pass');
  assert.equal(byCode.required_documents.severity, 'pass');
  assert.equal(byCode.sanctions.severity, 'pass');
  assert.ok(!byCode.us_cbp_cert && !byCode.eu_synthetic_g7 && !byCode.eu_kp_rough);

  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].kind, 'mismatch');
  assert.equal(result.questions[0].text, 'Report 2141438176 weighs 1.04 ct on the lab report but 1.01 ct on the packing list and the invoice. Which is right?');
  assert.equal(result.status, 'questions');
  assert.deepEqual(result.summary, { passed: result.checks.length - 1, total: result.checks.length });
  for (const check of result.checks) {
    assert.equal(check.rule, `compliance.js#${check.code}`);
    assert.ok(['pass', 'info', 'warn', 'fail'].includes(check.severity));
    assert.match(check.id, /^chk_/);
  }
  assert.ok(byCode.stone_details.evidence.some((e) => e.docId === 'eu-lr6'));
});

test('a missing packing list becomes a one-line question that offers the chat draft', () => {
  const { result, byCode } = run(euNatural({ skip: ['packing_list'] }));
  assert.equal(byCode.required_documents.severity, 'warn');
  const question = result.questions.find((q) => q.check === 'required_documents');
  assert.equal(question.text, 'Packing list for KG/26-27/041 is not on file. Upload it or ask the agents to draft it from the chat.');
  assert.equal(question.kind, 'missing_document');
  assert.equal(question.docType, 'packing_list');
  assert.equal(result.status, 'questions');
});

test('a shipping bill without its Let Export Order date is asked about', () => {
  const docs = euNatural().map((d) => (d.docType === 'shipping_bill' ? { ...d, fields: d.fields.filter((f) => f.key !== 'leo.date') } : d));
  const { result } = run(docs);
  const question = result.questions.find((q) => q.key === 'leo.date');
  assert.match(question.text, /^Shipping bill \d+ for KG\/26-27\/041 has no Let Export Order date\. Upload the copy with the LEO\.$/);
});

test('lab-grown India to UAE: no statement, ready to sign', () => {
  const lines = [
    { reportNumber: 'LG612345601', lab: 'IGI', shape: 'OV', carat: 1.5, color: 'E', clarity: 'VS1', growth: 'CVD', amount: 900 },
    { reportNumber: 'LG612345602', lab: 'IGI', shape: 'RD', carat: 2.01, color: 'F', clarity: 'VVS2', growth: 'CVD', amount: 1400 },
    { reportNumber: 'LG612345603', lab: 'IGI', shape: 'PS', carat: 0.9, color: 'G', clarity: 'VS2', growth: 'HPHT', amount: 500 },
  ];
  const docs = parcel({
    p: 'ae', invoiceNo: 'KG/26-27/052', consignee: { name: 'Sample Trading FZCO', address: 'Sample Tower, Dubai', country: 'U.A.E.' },
    destination: 'UAE', hs: '71049120', description: 'Lab grown polished diamonds (CVD)', lines,
  });
  const { result, byCode, stones, shipment } = run(docs, { screenings: clearScreens(['Kestrel Gems Pvt Ltd', 'Sample Trading FZCO']) });
  assert.equal(shipment.route, 'India to United Arab Emirates');
  assert.ok(stones.every((s) => s.growth === 'lab-grown'));
  assert.equal(result.regime, 'OTHER');
  assert.deepEqual(result.required.map((r) => r.kind), ['export_pack']);
  assert.equal(byCode.goods_class.detail, 'Lab-grown polished diamonds (HS 7104.91).');
  assert.ok(!byCode.kp_present, 'KP checks do not apply to lab-grown');
  assert.ok(!byCode.lab_reports_for_half_carat);
  assert.equal(byCode.report_format.severity, 'pass');
  assert.equal(byCode.destination_regime.detail, 'United Arab Emirates. No EU or US origin statement is needed.');
  assert.deepEqual(result.questions, []);
  assert.equal(result.status, 'ready_to_sign');
});

test('lab-grown into the EU needs the Diamond Office G7/GF declaration', () => {
  const lines = [{ reportNumber: 'LG612345611', lab: 'IGI', shape: 'RD', carat: 1.2, color: 'E', clarity: 'VS1', growth: 'CVD', amount: 700 }];
  const docs = parcel({ p: 'lg', invoiceNo: 'KG/26-27/053', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71049120', description: 'Lab grown polished diamonds', lines });
  const { result, byCode } = run(docs);
  assert.deepEqual(result.required.map((r) => r.kind), ['export_pack', 'g7_gf_declaration']);
  assert.match(result.required[1].reason, /G7\/GF declaration template still applies/);
  assert.equal(byCode.eu_synthetic_g7.severity, 'info');
  assert.ok(!byCode.eu_dds_required);
  assert.equal(result.status, 'ready_to_sign');
});

test('natural polished India to the US: CBP self-certification for the US importer', () => {
  const lines = [
    { reportNumber: '2141438181', lab: 'GIA', shape: 'RD', carat: 1.1, color: 'D', clarity: 'VS1', amount: 15000 },
    { reportNumber: '2141438182', lab: 'GIA', shape: 'RD', carat: 0.3, color: 'G', clarity: 'SI1', amount: 600 },
  ];
  const docs = parcel({
    p: 'us', invoiceNo: 'KG/26-27/060', consignee: { name: 'Example Jewelry Inc', address: '1 Sample Ave, New York, NY 10036', country: 'USA' },
    destination: 'United States', hs: '71023910', description: 'Natural polished diamonds', lines,
  });
  const { result, byCode } = run(docs, { screenings: clearScreens(['Kestrel Gems Pvt Ltd', 'Example Jewelry Inc']) });
  assert.equal(result.regime, 'US');
  assert.deepEqual(result.required.map((r) => r.kind), ['export_pack', 'us_cbp_certificate']);
  const cbp = result.required[1];
  assert.equal(cbp.signer, 'us_importer');
  assert.match(cbp.reason, /CBP03/);
  assert.match(cbp.reason, /CSMS #61912001/);
  assert.match(cbp.reason, /one per entry/);
  assert.match(cbp.reason, /letterhead/);
  assert.equal(byCode.us_cbp_cert.severity, 'info');
  assert.equal(byCode.kp_present.severity, 'warn', 'no KP linked: a warning, not a question');
  assert.ok(!byCode.eu_dds_required);
  assert.deepEqual(result.questions, []);
  assert.equal(result.status, 'ready_to_sign');
});

test('small natural stones to the US or the EU need no statement', () => {
  const lines = [{ reportNumber: null, shape: 'RD', carat: 0.3, color: 'G', clarity: 'SI1', amount: 400 }];
  const us = parcel({ p: 'su', invoiceNo: 'KG/26-27/061', consignee: { name: 'Example Jewelry Inc', address: 'Los Angeles', country: 'USA' }, destination: 'USA', hs: '71023910', description: 'Natural polished diamonds', lines });
  const eu = parcel({ p: 'se', invoiceNo: 'KG/26-27/062', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910', description: 'Natural polished diamonds', lines });
  const usRun = run(us, { screenings: clearScreens(['Kestrel Gems Pvt Ltd', 'Example Jewelry Inc']) });
  const euRun = run(eu);
  assert.deepEqual(usRun.result.required.map((r) => r.kind), ['export_pack']);
  assert.equal(usRun.byCode.us_cbp_cert.detail, 'Not required: no stone reaches 0.50 ct.');
  assert.deepEqual(euRun.result.required.map((r) => r.kind), ['export_pack']);
  assert.equal(euRun.byCode.eu_dds_required.detail, 'Not required: no stone reaches 0.50 ct.');
});

test('diamond jewellery to the US needs the CBP certificate whatever the stone size', () => {
  const docs = parcel({
    p: 'jw', invoiceNo: 'KG/26-27/063', consignee: { name: 'Example Jewelry Inc', address: 'New York', country: 'USA' }, destination: 'USA',
    hs: '71131910', description: '18K gold rings set with natural diamonds', lines: [{ description: 'Ring', carat: 0.2, amount: 800 }],
  });
  const { result } = run(docs, { screenings: clearScreens(['Kestrel Gems Pvt Ltd', 'Example Jewelry Inc']) });
  assert.ok(result.required.some((r) => r.kind === 'us_cbp_certificate'));
});

test('Russia anywhere holds the shipment for review', () => {
  const docs = euNatural().map((d) => (d.id === 'eu-kp'
    ? { ...d, fields: d.fields.map((f) => (f.key === 'kp.countriesOfMining' ? { ...f, value: 'Russian Federation, Botswana' } : f)) }
    : d));
  const { result, byCode } = run(docs);
  assert.equal(byCode.russia_anywhere.severity, 'fail');
  assert.match(byCode.russia_anywhere.detail, /Russian Federation, Botswana/);
  assert.ok(byCode.russia_anywhere.evidence.some((e) => e.docId === 'eu-kp' && e.key === 'kp.countriesOfMining'));
  assert.equal(result.status, 'held_for_review');
});

test('a supplier named after a Russian miner is caught, a "not of Russian origin" declaration is not', () => {
  const clean = euNatural({ extraDocs: [] }).map((d) => (d.docType === 'commercial_invoice'
    ? { ...d, declarations: ['We declare the diamonds are not of Russian origin.'], fields: [...d.fields, { key: 'declaration.text', value: 'Not of Russian origin', page: 1 }] }
    : d));
  assert.equal(run(clean).byCode.russia_anywhere.severity, 'pass');

  const dirty = euNatural().map((d) => (d.docType === 'commercial_invoice'
    ? { ...d, lines: d.lines.map((line, i) => (i === 0 ? { ...line, description: 'Polished from ALROSA rough' } : line)) }
    : d));
  const { byCode, result } = run(dirty);
  assert.equal(byCode.russia_anywhere.severity, 'fail');
  assert.match(byCode.russia_anywhere.detail, /line 1 of the invoice/);
  assert.equal(result.status, 'held_for_review');
});

test('EU rough needs a KP certificate with countries of mining, valid when the parcel leaves', () => {
  const lines = [{ description: 'Natural rough diamonds', carat: 152.4, pieces: 210, amount: 98000 }];
  const base = { p: 'rg', invoiceNo: 'KG/26-27/070', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023100', description: 'Natural rough diamonds, unworked', lines };

  const none = run(parcel(base));
  assert.equal(none.byCode.eu_kp_rough.severity, 'fail');
  assert.equal(none.byCode.kp_present.severity, 'fail', 'missing KP fails for EU rough');
  assert.equal(none.result.questions.filter((q) => q.check === 'eu_kp_rough').length, 1, 'asked once');
  assert.equal(none.result.status, 'held_for_review');
  assert.ok(none.result.questions.some((q) => q.text === 'KP certificate for KG/26-27/070 is not on file. Upload it with the countries of mining listed.'));
  assert.deepEqual(none.result.required.map((r) => r.kind), ['export_pack', 'g7_gf_declaration']);

  const noCountries = run(parcel({ ...base, extraDocs: [kpCertificate('rg-kp', 'IN 2026/0099', '', { 'invoice.number': 'KG/26-27/070' })] }));
  assert.equal(noCountries.byCode.eu_kp_rough.severity, 'fail');
  assert.match(noCountries.byCode.eu_kp_rough.detail, /does not list the countries of mining/);
  assert.equal(noCountries.byCode.kp_countries_listed.severity, 'fail');

  const good = run(parcel({ ...base, extraDocs: [kpCertificate('rg-kp2', 'IN 2026/0100', 'Botswana', { 'invoice.number': 'KG/26-27/070', 'kp.expiryDate': '30/12/2026' })] }));
  assert.equal(good.byCode.eu_kp_rough.severity, 'pass');
  assert.equal(good.byCode.dates_order.severity, 'pass');
  assert.equal(good.result.status, 'ready_to_sign');

  const expired = run(parcel({ ...base, extraDocs: [kpCertificate('rg-kp3', 'IN 2026/0101', 'Botswana', { 'invoice.number': 'KG/26-27/070', 'kp.expiryDate': '01/11/2026' })] }));
  assert.equal(expired.byCode.dates_order.severity, 'fail');
  assert.match(expired.byCode.dates_order.detail, /KP certificate IN 2026\/0101 expired on 01 Nov 2026, before the parcel left on 07 Nov 2026\./);
  assert.equal(expired.result.status, 'held_for_review');
});

test('sanctions: a match holds, a possible match asks, no screen holds', () => {
  const docs = euNatural();
  const match = run(docs, { screenings: [{ name: 'Example Diamonds BV', status: 'match', best: { sdnName: 'EXAMPLE LISTED ENTITY', score: 0.97 } }] });
  assert.equal(match.byCode.sanctions.severity, 'fail');
  assert.equal(match.result.status, 'held_for_review');

  const review = run(docs, { screenings: [...clearScreens(['Kestrel Gems Pvt Ltd']), { name: 'Example Diamonds BV', status: 'review', best: { sdnName: 'EXAMPLE DIAMOND LISTED', score: 0.86 } }] });
  assert.equal(review.byCode.sanctions.severity, 'warn');
  const question = review.result.questions.find((q) => q.check === 'sanctions');
  assert.equal(question.text, 'Possible OFAC SDN match: Example Diamonds BV looks like EXAMPLE DIAMOND LISTED. Confirm they are different before signing.');
  assert.deepEqual(question.options, ['Different', 'Same']);

  const unscreened = run(docs, { screenings: null });
  assert.equal(unscreened.byCode.sanctions.severity, 'fail');
  assert.equal(unscreened.result.status, 'held_for_review');
});

test('totals, party names and dates that disagree become questions', () => {
  const docs = euNatural().map((d) => {
    if (d.docType === 'shipping_bill') return { ...d, fields: d.fields.map((f) => (f.key === 'goods.totalCarats' ? { ...f, value: '5.07' } : f)) };
    if (d.docType === 'air_waybill') {
      return { ...d, fields: d.fields.map((f) => {
        if (f.key === 'consignee.name') return { ...f, value: 'Other Sample Trading NV' };
        if (f.key === 'awb.date') return { ...f, value: '04/11/2026' };
        return f;
      }) };
    }
    return d;
  });
  const { result, byCode } = run(docs);
  assert.equal(byCode.totals_consistency.severity, 'warn');
  assert.ok(result.questions.some((q) => q.text === 'Carats differ for KG/26-27/041: 4.97 ct on the invoice, 5.07 ct on the shipping bill. Which is right?'));
  assert.equal(byCode.parties_consistency.severity, 'warn');
  const party = result.questions.find((q) => q.check === 'parties_consistency');
  assert.equal(party.text, 'Consignee differs on KG/26-27/041: the invoice says Example Diamonds BV, the air waybill says Other Sample Trading NV. Same company?');
  assert.equal(byCode.dates_order.severity, 'warn');
  assert.ok(result.questions.some((q) => q.text === 'The air waybill for KG/26-27/041 is dated 04 Nov 2026, before the Let Export Order on 07 Nov 2026. Check the dates.'));
});

test('an invoice that says natural against a lab report that says CVD is held for review', () => {
  const docs = euNatural().map((d) => (d.id === 'eu-lr6'
    ? { ...d, fields: [...d.fields, { key: 'lab.growthMethod', value: 'CVD', page: 1 }] }
    : d));
  const { result, byCode } = run(docs);
  assert.equal(byCode.nature_consistency.severity, 'fail');
  assert.match(byCode.nature_consistency.detail, /Report 2141438176 is lab-grown \(CVD\) on the lab report but natural on the invoice\./);
  assert.equal(result.status, 'held_for_review');
});

test('a big natural stone without any report number asks for its grading report', () => {
  const lines = NATURAL_LINES.map((line, i) => (i === 1 ? { ...line, reportNumber: null, lab: null } : line));
  const docs = parcel({ p: 'mr', invoiceNo: 'KG/26-27/043', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910', description: 'Natural polished diamonds', lines });
  const { result, byCode } = run(docs);
  assert.equal(byCode.lab_reports_for_half_carat.severity, 'warn');
  const question = result.questions.find((q) => q.check === 'lab_reports_for_half_carat');
  assert.equal(question.text, 'Line 2 of the packing list (0.72 ct Oval) on KG/26-27/043 has no grading report. Upload it or add its report number.');
  assert.equal(result.status, 'questions');
});

test('unknown direction, destination and goods each get one question', () => {
  const docs = [doc('u-inv', 'commercial_invoice', { 'invoice.number': 'SAMPLE/26/001', 'exporter.name': 'Someone Else Ltd', 'goods.description': 'Goods as per list' })];
  const { shipments } = groupShipments({ documents: docs, shipments: [], house: HOUSE });
  const result = evaluate({ shipment: shipments[0], documents: docs, stones: [], house: HOUSE, screenings: clearScreens(['Someone Else Ltd']) });
  const texts = result.questions.map((q) => q.text);
  assert.ok(texts.includes('Where is SAMPLE/26/001 going? No paper names the destination country.'));
  assert.ok(texts.includes('Is SAMPLE/26/001 an export or an import for Kestrel Gems (SAMPLE)?'));
  assert.ok(texts.includes('Are the diamonds in SAMPLE/26/001 natural or lab-grown?'));
  assert.ok(texts.includes('Are the diamonds in SAMPLE/26/001 rough, polished or set in jewellery?'));
  assert.equal(result.status, 'questions');
});

test('evaluate is deterministic and every question is one line', () => {
  const docs = euNatural({ skip: ['air_waybill'] });
  const first = run(docs).result;
  const second = run(docs).result;
  assert.deepEqual(first, second);
  for (const question of first.questions) {
    assert.ok(!question.text.includes('\n'));
    assert.ok(!question.text.includes('\u2014'), 'no em dashes');
    assert.ok(question.text.length < 200, question.text);
    assert.equal(question.status, 'open');
  }
  for (const check of first.checks) assert.ok(!/\bfiled\b/i.test(check.detail), 'never say filed');
});

test('answers a person gave on the shipment are honoured on the next run', () => {
  const docs = [doc('a-inv', 'commercial_invoice', {
    'invoice.number': 'SAMPLE/26/002', 'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': 'Example Diamonds BV',
    'goods.description': 'Goods as per list',
  }, [{ reportNumber: '2141438191', lab: 'GIA', shape: 'RD', carat: 1.1, color: 'G', clarity: 'VS1' }])];
  const { shipments } = groupShipments({ documents: docs, shipments: [], house: HOUSE });
  // What the pipeline stores after the house answers: "Belgium", "Natural", "Export".
  const answered = { ...shipments[0], destinationCountry: 'Belgium', direction: 'Export', goods: { ...shipments[0].goods, nature: 'Natural' } };
  const { stones } = matchStones({ shipment: answered, documents: docs });
  const result = evaluate({ shipment: answered, documents: docs, stones, house: HOUSE, screenings: clearScreens() });
  const byCode = Object.fromEntries(result.checks.map((c) => [c.code, c]));
  assert.equal(result.regime, 'EU');
  assert.equal(byCode.direction.severity, 'pass');
  assert.equal(byCode.destination_regime.detail, 'Belgium. EU rules apply.');
  assert.equal(result.goods.nature, 'natural');
  assert.ok(result.required.some((r) => r.kind === 'eu_dds'));
  assert.ok(!result.questions.some((q) => q.check === 'direction' || q.check === 'destination_regime'));
});

test('questions about different stones stay distinct, and mismatch questions write nothing into papers', () => {
  const lines = NATURAL_LINES.map((line, i) => (i === 1 || i === 3 ? { ...line, reportNumber: null, lab: null } : line));
  const docs = parcel({ p: 'dq', invoiceNo: 'KG/26-27/044', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910', description: 'Natural polished diamonds', lines });
  const { result } = run(docs);
  const missing = result.questions.filter((q) => q.check === 'lab_reports_for_half_carat');
  assert.equal(missing.length, 2);
  assert.notEqual(missing[0].text, missing[1].text);
  for (const question of result.questions) {
    if (question.kind === 'mismatch' || question.check === 'parties_consistency') assert.equal(question.key, null);
    if (question.key) assert.match(question.key, /^(goods|leo|kp|shipment)\./, 'keys are field keys');
  }
});

test('parties not screened hold the shipment unless the house turned screening off', () => {
  const docs = euNatural();
  const notScreened = [{ name: 'Kestrel Gems Pvt Ltd', status: 'not_screened' }, { name: 'Example Diamonds BV', status: 'clear' }];
  const held = run(docs, { screenings: notScreened });
  assert.equal(held.byCode.sanctions.severity, 'fail');
  assert.equal(held.byCode.sanctions.detail, 'Not screened yet: Kestrel Gems Pvt Ltd.');

  const { shipments } = groupShipments({ documents: docs, shipments: [], house: HOUSE });
  const { stones } = matchStones({ shipment: shipments[0], documents: docs });
  const off = evaluate({ shipment: shipments[0], documents: docs, stones, house: { ...HOUSE, permissions: { ofacScreen: false } }, screenings: notScreened });
  const sanctions = off.checks.find((c) => c.code === 'sanctions');
  assert.equal(sanctions.severity, 'info');
  assert.equal(sanctions.detail, 'OFAC screening is off for this house.');
});

test('a paper the house marked as not needed is not asked for again', () => {
  const docs = euNatural({ skip: ['air_waybill'] });
  const asked = run(docs);
  assert.ok(asked.result.questions.some((q) => q.text === 'Air waybill for KG/26-27/041 is not on file. Upload it.'));

  const { shipments } = groupShipments({ documents: docs, shipments: [], house: HOUSE });
  const shipment = { ...shipments[0], notNeeded: ['air_waybill'] };
  const { stones } = matchStones({ shipment, documents: docs });
  const result = evaluate({ shipment, documents: docs, stones, house: HOUSE, screenings: clearScreens() });
  const papers = result.checks.find((c) => c.code === 'required_documents');
  assert.equal(papers.severity, 'pass');
  assert.match(papers.detail, /Marked not needed by the house: air waybill\./);
  assert.ok(!result.questions.some((q) => q.check === 'required_documents'));
});

test('carats print with two decimals in sentences', () => {
  assert.equal(formatCarat(0.7), '0.70');
  assert.equal(formatCarat(1.012), '1.012');
  assert.equal(formatCarat(152.4), '152.40');
  assert.equal(formatCarat(null), '');
});
