// Tests for the rules: formats, field parsing, goods classification and the compliance checks.
// All companies, numbers and papers here are fictional SAMPLE data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumber, parseDate, parseCurrency, normalizeRef, isUsefulRef, namesMatch, getField, formatDate, formatCarat, calendarDay,
} from '../../src/core/rules/fields.js';
import {
  normalizeCountry, splitCountries, isEU, countryName, findRussiaWord, countryListHasRussia, hsInfo, formatHsCode,
  checkReportNumber, normalizeShape, normalizeColor, normalizeClarity, natureFromText, formFromText, isKpParticipant,
  normalizeLab, growthMethodFromText, timeZoneOf, splitCountryList,
} from '../../src/core/rules/formats.js';
import {
  RULES_VERSION, classifyGoods, evaluate, regimeOf, ruleContext, kpCertificate as kpSection, sanctionsKey,
} from '../../src/core/rules/compliance.js';
import { cleanReportNumber } from '../../src/core/rules/formats.js';
import { lotSizeRange, reachesHalf } from '../../src/core/rules/goods.js';
import { placeHasRussia, partiesProblems } from '../../src/core/rules/consistency.js';
import { FIELD_KEYS, FIELD_LABELS } from '../../src/core/types.js';
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

// Group, match and evaluate, like the pipeline does. patch: what a person's answers put on the shipment.
function run(documents, { screenings = clearScreens(), now = '2026-11-15', patch = {}, house = HOUSE } = {}) {
  const { shipments } = groupShipments({ documents, shipments: [], house: HOUSE });
  assert.equal(shipments.length, 1, `one shipment expected, got ${shipments.length}`);
  const shipment = { ...shipments[0], ...patch };
  const { stones } = matchStones({ shipment, documents });
  const result = evaluate({ shipment, documents, stones, house, screenings, now });
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
  assert.equal(RULES_VERSION, 'compliance.js 1.1');
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

test('sanctions: a match holds, a possible match asks and holds until a person says "Different", no screen holds', () => {
  const docs = euNatural();
  const match = run(docs, { screenings: [{ name: 'Example Diamonds BV', status: 'match', best: { sdnName: 'EXAMPLE LISTED ENTITY', score: 0.97 } }] });
  assert.equal(match.byCode.sanctions.severity, 'fail');
  assert.equal(match.result.status, 'held_for_review');

  const screenings = [...clearScreens(['Kestrel Gems Pvt Ltd']), { name: 'Example Diamonds BV', status: 'review', best: { sdnName: 'EXAMPLE DIAMOND LISTED', uid: 99001, score: 0.86 } }];
  const review = run(docs, { screenings });
  assert.equal(review.byCode.sanctions.severity, 'fail', 'an open possible match holds the shipment');
  assert.equal(review.result.status, 'held_for_review');
  const question = review.result.questions.find((q) => q.check === 'sanctions');
  assert.equal(question.text, 'Possible OFAC SDN match: Example Diamonds BV looks like EXAMPLE DIAMOND LISTED. Confirm they are different before signing.');
  assert.deepEqual(question.options, ['Different', 'Same']);
  assert.equal(question.key, 'sanctions.example-diamonds-bv.99001', 'the answer is kept per party and listed entry');

  // "Same": the house confirms the party is the listed one. That is a match.
  const same = run(docs, { screenings, patch: { answers: { [question.key]: 'Same' } } });
  assert.equal(same.byCode.sanctions.severity, 'fail');
  assert.match(same.byCode.sanctions.detail, /On the OFAC SDN list: Example Diamonds BV \(EXAMPLE DIAMOND LISTED\)\. The house confirmed Example Diamonds BV is the listed name\./);
  assert.ok(!same.result.questions.some((q) => q.check === 'sanctions'));
  assert.equal(same.result.status, 'held_for_review');

  // Any other answer settles nothing: the question stays and the shipment stays held.
  const unsure = run(docs, { screenings, patch: { answers: { [question.key]: 'Not sure' } } });
  assert.equal(unsure.byCode.sanctions.severity, 'fail');

  // "Different" clears it, and says so.
  const different = run(docs, { screenings, patch: { answers: { [question.key]: 'Different' } } });
  assert.equal(different.byCode.sanctions.severity, 'pass');
  assert.match(different.byCode.sanctions.detail, /Checked by the house, not the listed name: Example Diamonds BV \(not EXAMPLE DIAMOND LISTED\)\./);
  assert.ok(!different.result.questions.some((q) => q.check === 'sanctions'));

  // A "Different" for one listed entry never clears a hit on another one.
  const other = run(docs, { screenings: [screenings[0], { ...screenings[1], best: { sdnName: 'ANOTHER LISTED NAME', uid: 99002, score: 0.88 } }], patch: { answers: { [question.key]: 'Different' } } });
  assert.equal(other.byCode.sanctions.severity, 'fail');

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
  assert.equal(sanctions.severity, 'warn', 'screening off shows under "To check", never as screened');
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

// ---------- fixes: what the rules now catch ----------

const US_BUYER = { name: 'Example Jewelry Inc', address: '1 Sample Ave, New York, NY 10036', country: 'USA' };
const UAE_BUYER = { name: 'Sample Trading FZCO', address: 'Sample Tower, Dubai', country: 'U.A.E.' };
const usScreens = () => clearScreens(['Kestrel Gems Pvt Ltd', 'Example Jewelry Inc']);
const uaeScreens = () => clearScreens(['Kestrel Gems Pvt Ltd', 'Sample Trading FZCO']);
const ROUGH_LINES = [{ description: 'Natural rough diamonds', carat: 152.4, pieces: 210, amount: 98000 }];

test('the insurance certificate names the insured, so it is never compared as the consignee', () => {
  assert.ok(FIELD_KEYS.includes('insured.name') && FIELD_LABELS['insured.name'] === 'Insured');
  assert.ok(FIELD_KEYS.includes('goods.packages') && FIELD_LABELS['goods.packages'] === 'Packages');
  // The reader took the insured (the exporter) for the consignee.
  const insurance = doc('k1-ins', 'insurance_certificate', { 'doc.number': 'SAMPLE-INS-77', 'invoice.number': 'KG/26-27/041', 'consignee.name': 'Kestrel Gems Pvt Ltd', 'exporter.name': 'Kestrel Gems Pvt Ltd' });
  const { byCode, result } = run(euNatural({ extraDocs: [insurance] }));
  assert.equal(byCode.parties_consistency.severity, 'pass', byCode.parties_consistency.detail);
  assert.ok(!result.questions.some((q) => q.check === 'parties_consistency'));
  // The exporter on the insurance is still compared.
  const wrongExporter = { ...insurance, fields: insurance.fields.map((f) => (f.key === 'exporter.name' ? { ...f, value: 'Other Sample Exports Ltd' } : f)) };
  assert.ok(partiesProblems([doc('k1-inv', 'commercial_invoice', { 'exporter.name': 'Kestrel Gems Pvt Ltd' }), wrongExporter], 'X').some((p) => /^Exporter differs/.test(p.text)));
});

test('Russia: "non-industrial ... Russian" is a hit, so is a route or port through Russia; "non-Russian" is not', () => {
  assert.equal(findRussiaWord('Non-industrial cut and polished diamonds of Russian origin'), 'RUSSIAN');
  assert.equal(findRussiaWord('Natural polished diamonds, non certified, mined in Yakutia'), 'YAKUTIA');
  assert.equal(findRussiaWord('Polished diamonds (non-industrial) from ALROSA rough'), 'ALROSA');
  assert.equal(findRussiaWord('Non-Russian goods only'), null);
  assert.equal(findRussiaWord('Non Russian Federation origin'), null);
  assert.ok(placeHasRussia('BOM - SVO - BRU'));
  assert.ok(placeHasRussia('Moscow (SVO)'));
  assert.ok(placeHasRussia('Mumbai via Moscow to Antwerp'));
  assert.ok(!placeHasRussia('BOM-DXB-BRU'));
  assert.ok(!placeHasRussia('Mumbai Air Cargo'));

  const viaMoscow = parcel({
    p: 'rv', invoiceNo: 'KG/26-27/300', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910',
    description: 'Natural polished diamonds', lines: NATURAL_LINES.slice(0, 2),
  }).map((d) => (d.docType === 'air_waybill' ? { ...d, fields: [...d.fields, { key: 'awb.route', value: 'BOM - SVO - BRU', page: 1 }] } : d));
  const { byCode, result } = run(viaMoscow);
  assert.equal(byCode.russia_anywhere.severity, 'fail');
  assert.match(byCode.russia_anywhere.detail, /"BOM - SVO - BRU" on the air waybill \(route\)/);
  assert.equal(result.status, 'held_for_review');
});

test('nature words: "not lab-grown", "non-synthetic" and HPHT-treated natural stones are natural', () => {
  const cases = [
    ['Natural polished diamond, not lab-grown', 'natural'], ['Natural diamonds (non-synthetic)', 'natural'],
    ['Natural diamonds, no CVD/HPHT', 'natural'], ['not man-made', 'natural'], ['Non-LGD', 'natural'],
    ['HPHT treated natural diamond', 'natural'], ['Natural diamond, HPHT processed', 'natural'],
    ['CVD, HPHT treated', 'lab-grown'], ['Laboratory-grown diamond, not natural', 'lab-grown'], ['HPHT', 'lab-grown'],
    ['Lab grown diamonds (CVD)', 'lab-grown'], ['Determined by examination', null],
  ];
  for (const [text, nature] of cases) assert.equal(natureFromText(text), nature, text);
  // Twice in a row: no regex state carries over between calls.
  assert.equal(natureFromText('not lab-grown'), 'natural');
  assert.equal(natureFromText('not lab-grown'), 'natural');
  assert.equal(growthMethodFromText('no CVD/HPHT'), null);
  assert.equal(growthMethodFromText('HPHT treated'), null);
  assert.equal(growthMethodFromText('CVD as grown'), 'CVD');

  const line = [{ description: 'Natural polished diamond, not lab-grown', carat: 1.5, shape: 'RD', color: 'G', clarity: 'VS1', reportNumber: '2141438201', lab: 'GIA', amount: 9000 }];
  const us = run(parcel({ p: 'nl', invoiceNo: 'KG/26-27/301', consignee: US_BUYER, destination: 'USA', hs: '71023910', description: 'Natural polished diamonds', lines: line }), { screenings: usScreens() });
  assert.equal(us.stones[0].growth, 'natural');
  assert.ok(us.result.required.some((r) => r.kind === 'us_cbp_certificate'));
  const eu = run(parcel({ p: 'nb', invoiceNo: 'KG/26-27/302', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910', description: 'Natural polished diamonds', lines: line }));
  assert.ok(eu.result.required.some((r) => r.kind === 'eu_dds'));
  assert.ok(!eu.result.required.some((r) => r.kind === 'g7_gf_declaration'));
});

test('a paper whose own HS code says natural while every stone reads lab-grown is held for review', () => {
  const lines = [{ reportNumber: 'LG612345688', lab: 'IGI', shape: 'RD', carat: 1.2, color: 'E', clarity: 'VS1', growth: 'CVD', amount: 900 }];
  const { byCode, result } = run(parcel({ p: 'hs', invoiceNo: 'KG/26-27/303', consignee: UAE_BUYER, destination: 'UAE', hs: '71023910', description: 'Polished diamonds', lines }), { screenings: uaeScreens() });
  assert.equal(byCode.nature_consistency.severity, 'fail');
  assert.match(byCode.nature_consistency.detail, /says natural \(HS 71023910\) but the stones read lab-grown/);
  assert.ok(result.questions.some((q) => q.check === 'nature_consistency'));
});

test('jewellery with loose natural polished stones: the EU statement and both CBP sentences still apply', () => {
  const lines = [
    { description: '18K gold ring with natural diamonds', carat: 0.4, amount: 1200 },
    { reportNumber: '2141438177', lab: 'GIA', shape: 'RD', carat: 1.2, color: 'G', clarity: 'VS1', amount: 9000 },
  ];
  const looseInvoice = (p) => doc(`${p}-inv2`, 'commercial_invoice', { 'invoice.number': 'KG/26-27/304', 'goods.hsCode': '71023910' });
  const eu = run(parcel({ p: 'jl', invoiceNo: 'KG/26-27/304', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71131910', description: 'Jewellery and loose diamonds', lines, extraDocs: [looseInvoice('jl')] }));
  assert.equal(eu.result.goods.form, 'jewelry');
  assert.deepEqual(eu.result.goods.loose, ['polished']);
  assert.match(eu.byCode.goods_class.detail, /^Natural jewellery and loose polished diamonds/);
  assert.ok(eu.result.required.some((r) => r.kind === 'eu_dds'));

  const pure = classifyGoods({ documents: [doc('pj', 'commercial_invoice', { 'goods.hsCode': '71131910' })] });
  assert.deepEqual(pure.loose, [], 'jewellery alone has no loose stones');
  const heading = classifyGoods({ documents: [doc('ph', 'commercial_invoice', { 'goods.hsCode': '71131910' }), doc('ph2', 'commercial_invoice', { 'goods.hsCode': '7102' })] });
  assert.deepEqual(heading.loose, ['unknown'], 'a bare 7102 heading next to jewellery is loose stones of unknown form');
});

test('natural rough without a KP certificate is held wherever it goes, with one question', () => {
  for (const [p, consignee, destination, screenings] of [['ka', UAE_BUYER, 'UAE', uaeScreens()], ['ku', US_BUYER, 'USA', usScreens()]]) {
    const { byCode, result } = run(parcel({ p, invoiceNo: `KG/26-27/31${p.length}${p}`, consignee, destination, hs: '71023100', description: 'Natural rough diamonds', lines: ROUGH_LINES }), { screenings });
    assert.equal(byCode.kp_present.severity, 'fail', destination);
    assert.match(byCode.kp_present.detail, /Rough crosses a border only with one/);
    const asked = result.questions.filter((q) => q.check === 'kp_present');
    assert.equal(asked.length, 1, destination);
    assert.equal(asked[0].docType, 'kp_certificate');
    assert.equal(result.status, 'held_for_review');
  }
  // Its own KP certificate without mining countries is only a warning outside the EU (only the EU needs them).
  const kp = kpCertificate('ka-kp', 'IN 2026/0300', '', { 'invoice.number': 'KG/26-27/320' });
  const listed = run(parcel({ p: 'kc', invoiceNo: 'KG/26-27/320', consignee: UAE_BUYER, destination: 'UAE', hs: '71023100', description: 'Natural rough diamonds', lines: ROUGH_LINES, extraDocs: [kp] }), { screenings: uaeScreens() });
  assert.equal(listed.byCode.kp_present.severity, 'pass');
  assert.equal(listed.byCode.kp_countries_listed.severity, 'warn');
});

test('EU rough counts only its own KP certificate, never one a supplier invoice names', () => {
  // The rough purchase invoice prints an old KP number and Botswana; no KP certificate is filed with the parcel.
  const supplier = doc('rs-sup', 'supplier_invoice', { 'invoice.number': 'SUP-77', 'kp.certificateNumber': 'AE-OLD-0001', 'kp.countriesOfMining': 'Botswana' }, [], { parentId: 'rs-mail' });
  const docs = parcel({ p: 'rs', invoiceNo: 'KG/26-27/321', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023100', description: 'Natural rough diamonds', lines: ROUGH_LINES, invoiceExtra: { parentId: 'rs-mail' }, extraDocs: [doc('rs-mail', 'email', {}, []), supplier] });
  const { byCode, result } = run(docs);
  assert.equal(byCode.eu_kp_rough.severity, 'fail');
  assert.match(byCode.eu_kp_rough.detail, /None is on file/);
  assert.ok(result.questions.some((q) => q.check === 'eu_kp_rough'));

  // Its own KP certificate lists no countries; a supplier invoice that does cannot stand in for it.
  const own = kpCertificate('rs-kp', 'IN 2026/0099', '', { 'invoice.number': 'KG/26-27/321' });
  const second = run([...docs, own]);
  assert.equal(second.byCode.eu_kp_rough.severity, 'fail');
  assert.match(second.byCode.eu_kp_rough.detail, /does not list the countries of mining/);
});

test('a rough import KP certificate must be valid on the bill of entry date', () => {
  const docs = [
    doc('ri-inv', 'commercial_invoice', { 'invoice.number': 'SUP-2026-0921', 'invoice.date': '20/09/2026', 'exporter.name': 'Sample Rough DMCC', 'consignee.name': 'Kestrel Gems Pvt Ltd', 'goods.hsCode': '71023100', 'goods.destinationCountry': 'India' }, ROUGH_LINES),
    doc('ri-awb', 'air_waybill', { 'awb.hawb': 'SMP 5500001', 'awb.date': '30/09/2026', 'invoice.number': 'SUP-2026-0921' }),
    doc('ri-boe', 'bill_of_entry', { 'billOfEntry.number': '4410099', 'billOfEntry.date': '14/11/2026', 'awb.hawb': 'SMP 5500001' }),
    kpCertificate('ri-kp', 'AE 2026/5500', 'Botswana', { 'invoice.number': 'SUP-2026-0921', 'kp.expiryDate': '01/10/2026' }),
  ];
  const { shipment, byCode } = run(docs, { screenings: clearScreens(['Sample Rough DMCC', 'Kestrel Gems Pvt Ltd']) });
  assert.equal(shipment.direction, 'import');
  assert.equal(byCode.dates_order.severity, 'fail');
  assert.match(byCode.dates_order.detail, /expired on 01 Oct 2026, before the parcel was declared for import on 14 Nov 2026\./);
});

test('the KP expiry day is the house\'s own calendar day, not the UTC day', () => {
  assert.equal(timeZoneOf('India'), 'Asia/Kolkata');
  assert.equal(timeZoneOf('Atlantis'), null);
  assert.equal(calendarDay(new Date('2026-11-15T20:00:00Z'), 'Asia/Kolkata'), '2026-11-16');
  assert.equal(calendarDay(new Date('2026-11-16T03:00:00Z'), 'America/New_York'), '2026-11-15');
  assert.equal(calendarDay(new Date('2026-11-16T03:00:00Z'), 'Not/AZone'), calendarDay(new Date('2026-11-16T03:00:00Z')));
  // No date on the papers: 20:00 UTC on 15 Nov is already 16 Nov in Surat, so a KP that ended on the 15th has expired.
  const docs = [
    doc('rx-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/322', 'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': 'Sample Trading FZCO', 'goods.hsCode': '71023100', 'goods.destinationCountry': 'UAE' }, ROUGH_LINES),
    kpCertificate('rx-kp', 'IN 2026/0322', 'Botswana', { 'invoice.number': 'KG/26-27/322', 'kp.expiryDate': '15/11/2026' }),
  ];
  const late = run(docs, { screenings: uaeScreens(), now: new Date('2026-11-15T20:00:00Z') });
  assert.equal(late.byCode.dates_order.severity, 'fail');
  const early = run(docs, { screenings: uaeScreens(), now: new Date('2026-11-15T10:00:00Z') });
  assert.equal(early.byCode.dates_order.severity, 'pass');
});

test('a lot is judged per stone: an average under 0.50 ct does not rule out bigger stones', () => {
  assert.deepEqual(lotSizeRange('Natural polished diamonds, sizes 0.30-0.70 ct'), { min: 0.3, max: 0.7 });
  assert.deepEqual(lotSizeRange('up to 0.29 ct'), { min: null, max: 0.29 });
  assert.equal(lotSizeRange('Melee, +11-14 sieve').melee, true);
  assert.equal(lotSizeRange('+11-14 sieve'), null, 'sieve sizes are not carats');
  assert.equal(reachesHalf({ carat: 4.6, pieces: 10, description: 'sizes 0.30-0.70 ct' }), 'maybe');
  assert.equal(reachesHalf({ carat: 2.5, pieces: 10, description: 'sizes 0.20-0.30 ct' }), 'no');
  assert.equal(reachesHalf({ carat: 2.5, pieces: 10, description: 'Lot' }), 'maybe');
  assert.equal(reachesHalf({ carat: 7.5, pieces: 10 }), 'yes');
  assert.equal(reachesHalf({ carat: null }), null);

  const lot = (description) => parcel({ p: `lo${description.length}`, invoiceNo: `KG/26-27/33${description.length}`, consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910', description: 'Natural polished diamonds', lines: [{ description, carat: 4.6, pieces: 10, amount: 4500 }] });
  const wide = run(lot('Natural polished diamonds, sizes 0.30-0.70 ct'));
  assert.ok(wide.result.required.some((r) => r.kind === 'eu_dds'));
  assert.match(wide.byCode.eu_dds_required.detail, /Lots give only an average size, so it is prepared to be safe\./);
  assert.match(wide.byCode.half_carat_stones.detail, /^No stone is known to reach 0\.50 ct\. 10 stones in lots may reach 0\.50 ct/);
  const small = run(lot('Natural polished diamonds, sizes 0.40-0.49 ct'));
  assert.ok(!small.result.required.some((r) => r.kind === 'eu_dds'));
  assert.equal(small.byCode.half_carat_stones.detail, 'No stone reaches 0.50 ct (largest 0.49 ct).');
  const melee = run(lot('Melee'));
  assert.ok(!melee.result.required.some((r) => r.kind === 'eu_dds'), 'melee is small stones by name');
});

test('the 0.50 ct threshold of the EU statement and the CBP certificate counts natural stones only', () => {
  const lines = [
    { reportNumber: null, shape: 'RD', carat: 0.3, color: 'G', clarity: 'SI1', amount: 300, growth: 'natural' },
    { reportNumber: 'LG612345699', lab: 'IGI', shape: 'RD', carat: 1.2, color: 'E', clarity: 'VS1', amount: 900, growth: 'CVD' },
  ];
  const eu = run(parcel({ p: 'mn', invoiceNo: 'KG/26-27/340', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71023910', description: 'Polished diamonds', lines }));
  assert.equal(eu.result.goods.nature, 'mixed');
  assert.ok(!eu.result.required.some((r) => r.kind === 'eu_dds'));
  assert.equal(eu.byCode.eu_dds_required.detail, 'Not required: no natural stone reaches 0.50 ct.');
  assert.ok(eu.result.required.some((r) => r.kind === 'g7_gf_declaration'), 'the lab-grown stone still needs the G7/GF template');
  const us = run(parcel({ p: 'mu', invoiceNo: 'KG/26-27/341', consignee: US_BUYER, destination: 'USA', hs: '71023910', description: 'Polished diamonds', lines }), { screenings: usScreens() });
  assert.ok(!us.result.required.some((r) => r.kind === 'us_cbp_certificate'));
  assert.equal(us.byCode.us_cbp_cert.detail, 'Not required: no natural stone reaches 0.50 ct.');
});

test('unknown nature: the statements are prepared to be safe until a person says natural or lab-grown', () => {
  const lines = [{ reportNumber: '2141438190', lab: 'GIA', shape: 'RD', carat: 1.1, color: 'G', clarity: 'VS1', amount: 9000 }];
  const us = run(parcel({ p: 'uu', invoiceNo: 'KG/26-27/342', consignee: US_BUYER, destination: 'USA', hs: '', description: 'Polished diamonds', lines }), { screenings: usScreens() });
  assert.equal(us.result.goods.nature, 'unknown');
  assert.ok(us.result.required.some((r) => r.kind === 'us_cbp_certificate'));
  assert.match(us.byCode.us_cbp_cert.detail, /The papers do not say yet whether the stones are natural, so it is prepared to be safe\./);
  const eu = run(parcel({ p: 'ue', invoiceNo: 'KG/26-27/343', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '', description: 'Polished diamonds', lines }));
  assert.ok(eu.result.required.some((r) => r.kind === 'eu_dds'));
  assert.ok(eu.result.questions.some((q) => q.key === 'goods.nature'), 'and the nature is still asked');
});

test('industrial diamonds are outside Article 3p: no EU statement and no grading reports', () => {
  const { byCode, result } = run(parcel({ p: 'in', invoiceNo: 'KG/26-27/344', consignee: BELGIUM_BUYER, destination: 'Belgium', hs: '71022900', description: 'Industrial diamonds, worked', lines: [{ description: 'Industrial lot', carat: 50, pieces: 100, amount: 900 }] }));
  assert.ok(!result.required.some((r) => r.kind === 'eu_dds'));
  assert.equal(byCode.eu_dds_required.detail, 'Not required: industrial diamonds are outside Article 3p.');
  assert.ok(!byCode.lab_reports_for_half_carat);
});

test('natural rough into any EU member state goes to the Diamond Office in Antwerp', () => {
  const germany = { name: 'Beispiel Diamanten GmbH', address: 'Beispielstrasse 1, Idar-Oberstein', country: 'Germany' };
  const kp = kpCertificate('de-kp', 'IN 2026/0200', 'Botswana', { 'invoice.number': 'KG/26-27/345' });
  const { byCode } = run(parcel({ p: 'de', invoiceNo: 'KG/26-27/345', consignee: germany, destination: 'Germany', hs: '71023100', description: 'Natural rough diamonds', lines: ROUGH_LINES, extraDocs: [kp] }), { screenings: clearScreens(['Kestrel Gems Pvt Ltd', 'Beispiel Diamanten GmbH']) });
  assert.equal(byCode.eu_rough_diamond_office.severity, 'info');
  assert.match(byCode.eu_rough_diamond_office.detail, /Diamond Office in Antwerp \(FPS Economy, Hoveniersstraat 22\)/);
});

test('an EU import statement needs the house\'s EORI number: asked once, then taken from the answer', () => {
  const docs = [
    doc('im-inv', 'commercial_invoice', { 'invoice.number': 'EXD-2026-400', 'invoice.date': '10/11/2026', 'exporter.name': 'Example Exports Pvt Ltd', 'exporter.country': 'India', 'consignee.name': 'Kestrel Gems Pvt Ltd', 'consignee.country': 'Belgium', 'goods.hsCode': '71023910', 'goods.destinationCountry': 'Belgium' }, NATURAL_LINES.slice(0, 2)),
    doc('im-boe', 'bill_of_entry', { 'billOfEntry.number': '4410400', 'invoice.number': 'EXD-2026-400' }),
    doc('im-awb', 'air_waybill', { 'awb.hawb': 'SMP 6600001', 'invoice.number': 'EXD-2026-400' }),
  ];
  const screens = clearScreens(['Example Exports Pvt Ltd', 'Kestrel Gems Pvt Ltd']);
  const asked = run(docs, { screenings: screens });
  assert.equal(asked.shipment.direction, 'import');
  assert.equal(asked.byCode.importer_eori.severity, 'warn');
  const question = asked.result.questions.find((q) => q.check === 'importer_eori');
  assert.equal(question.text, 'What is the house\'s EORI number? It goes on the EU statement.');
  assert.equal(question.key, 'house.eori');
  const answered = run(docs, { screenings: screens, patch: { answers: { 'house.eori': 'be 0123.456.789' } } });
  assert.equal(answered.byCode.importer_eori.severity, 'pass');
  assert.equal(answered.byCode.importer_eori.detail, 'EORI number BE0123456789 goes on the EU statement.');
  // "Not needed" is no EORI number: it is never printed as one, and the question is asked again.
  const notOne = run(docs, { screenings: screens, patch: { answers: { 'house.eori': 'not needed' } } });
  assert.equal(notOne.byCode.importer_eori.severity, 'warn');
  const again = notOne.result.questions.find((q) => q.check === 'importer_eori');
  assert.match(again.text, /^"not needed" does not look like an EORI number/);
  assert.notEqual(again.dedupeKey, question.dedupeKey);
  const inProfile = run(docs, { screenings: screens, house: { ...HOUSE, letterhead: { eori: 'BE0999999999' } } });
  assert.equal(inProfile.byCode.importer_eori.detail, 'EORI number BE0999999999 goes on the EU statement.');
});

test('a packing list the agents drafted counts only once a person checked it', () => {
  const draft = doc('dr-pl', 'packing_list', { 'invoice.number': 'KG/26-27/041' }, NATURAL_LINES.map(({ amount, ...line }) => line),
    { source: { kind: 'generated', receivedAt: '2026-11-11T10:00:00Z' } });
  const unchecked = run([...euNatural({ skip: ['packing_list'] }), draft]);
  assert.equal(unchecked.byCode.required_documents.severity, 'warn');
  assert.match(unchecked.byCode.required_documents.detail, /Not on file: packing list\. The packing list on file is the agents' draft: a person checks it before it counts\./);
  const question = unchecked.result.questions.find((q) => q.check === 'required_documents');
  assert.equal(question.text, 'The agents drafted the packing list for KG/26-27/041. Check every line against the parcel. Is it right?');
  assert.equal(question.key, 'doc.checkedBy');
  assert.equal(question.docId, 'dr-pl');
  assert.deepEqual(question.options, ['Yes, use it as our packing list']);
  assert.equal(question.dedupeKey, 'packing_list_draft|sha-dr-pl');

  // The answer is written onto the draft (doc.checkedBy), with who gave it.
  const checked = { ...draft, fields: [...draft.fields, { key: 'doc.checkedBy', value: 'Yes, use it as our packing list', by: 'Asha Clerk', page: null }] };
  const ok = run([...euNatural({ skip: ['packing_list'] }), checked]);
  assert.equal(ok.byCode.required_documents.severity, 'pass');
  assert.match(ok.byCode.required_documents.detail, /The packing list is the agents' draft, checked by Asha Clerk\./);
});

test('"Which is right?" about a stone: the chosen value counts, and papers that still disagree wait for a person', () => {
  const docs = euNatural();
  const first = run(docs);
  const question = first.result.questions.find((q) => q.check === 'stone_details');
  assert.equal(question.key, 'stone.2141438176.carat');
  assert.deepEqual(question.options, ['1.01 ct', '1.04 ct']);
  assert.equal(first.stones.find((s) => s.reportNumber === '2141438176').carat, 1.04, 'the lab report until a person chooses');

  // The house says the invoice is right: the stone weighs 1.01 ct, and the lab report still disagrees.
  const chosen = run(docs, { patch: { answers: { [question.key]: '1.01 ct - the invoice is right' } } });
  assert.equal(chosen.stones.find((s) => s.reportNumber === '2141438176').carat, 1.01);
  assert.equal(chosen.byCode.stone_details.severity, 'warn');
  assert.equal(chosen.byCode.stone_details.detail, 'Report 2141438176: the house answered 1.01 ct, but the lab report says 1.04 ct.');
  const accept = chosen.result.questions.find((q) => q.check === 'stone_details');
  assert.equal(accept.text, 'The lab report says 1.04 ct for report 2141438176, not 1.01 ct. Upload corrected copies, or ship with this difference.');
  assert.equal(accept.key, 'stone.2141438176.carat.accepted');
  assert.deepEqual(accept.options, ['Ship with this difference']);
  assert.equal(accept.docId, 'eu-lr6');
  assert.equal(chosen.result.status, 'questions');

  // Accepted: noted as accepted, nothing left to ask, ready to sign.
  const accepted = run(docs, { patch: { answers: { [question.key]: '1.01 ct', [accept.key]: 'Ship with this difference' } } });
  assert.equal(accepted.byCode.stone_details.severity, 'info');
  assert.equal(accepted.byCode.stone_details.accepted, true);
  assert.match(accepted.byCode.stone_details.detail, /^Accepted by the house: Report 2141438176: the house answered 1\.01 ct/);
  assert.equal(accepted.result.status, 'ready_to_sign');

  // An answer that names neither value is asked again, with the values to pick from.
  const unclear = run(docs, { patch: { answers: { [question.key]: 'the lab report is wrong' } } });
  const again = unclear.result.questions.find((q) => q.check === 'stone_details');
  assert.match(again.text, /^The answer "the lab report is wrong" names none of these values\./);
  assert.deepEqual(again.options, ['1.01 ct', '1.04 ct']);
  assert.notEqual(again.dedupeKey, question.dedupeKey);
});

test('each rule section can be run on its own', () => {
  const docs = parcel({ p: 'sx', invoiceNo: 'KG/26-27/350', consignee: UAE_BUYER, destination: 'UAE', hs: '71023100', description: 'Natural rough diamonds', lines: ROUGH_LINES });
  const { shipments } = groupShipments({ documents: docs, shipments: [], house: HOUSE });
  const { stones } = matchStones({ shipment: shipments[0], documents: docs });
  const ctx = ruleContext({ shipment: shipments[0], documents: docs, stones, house: HOUSE, screenings: null, now: '2026-11-15' });
  kpSection(ctx);
  assert.deepEqual(ctx.checks.map((c) => `${c.code}:${c.severity}`), ['kp_present:fail']);
  assert.equal(ctx.questions.length, 1);
  assert.equal(sanctionsKey({ name: 'Example Diamonds B.V.', best: { sdnName: 'EXAMPLE LISTED' } }), 'sanctions.example-diamonds-b-v.example-listed');
  assert.deepEqual(splitCountryList('Botswana, Sierra Leon').map((p) => p.code), ['BW', null], 'an unknown name stays, as printed');
});

test('one report number cleaner and one set of grade readers for the papers and the lab check', () => {
  assert.equal(cleanReportNumber('GIA2141438172'), '2141438172');
  assert.equal(cleanReportNumber('GIA # 2141 438 171'), '2141438171');
  assert.equal(cleanReportNumber('IGI LG-612345678'), 'LG612345678');
  assert.equal(cleanReportNumber(null), '');
  assert.equal(normalizeColor('w - x'), 'W-X', 'a spaced range stays a range');
  assert.equal(normalizeColor('E (Rare White+)'), 'E');
  assert.equal(normalizeColor('H colour grade'), 'H');
  assert.equal(normalizeColor('E-G'), 'E-G');
  assert.equal(normalizeClarity('VS1 (very slightly included)'), 'VS1');
  assert.equal(normalizeClarity('Loupe clean'), 'IF');
  assert.equal(normalizeClarity('Internally flawless'), 'IF');
  assert.equal(normalizeClarity('PK2'), 'I2');
  assert.equal(normalizeClarity('VS1-VS2'), 'VS1-VS2');
});

test('natural or lab-grown: denials, treatments, and a text naming both is for a person to decide', () => {
  assert.equal(natureFromText('Natural and lab-grown diamonds'), null);
  assert.equal(natureFromText('Natural diamonds (not lab-grown)'), 'natural');
  assert.equal(natureFromText('HPHT treated natural diamond'), 'natural');
  assert.equal(natureFromText('No CVD/HPHT'), 'natural');
  assert.equal(natureFromText('Lab-grown diamond, not natural'), 'lab-grown');
  assert.equal(natureFromText('Laboratory-grown diamond (CVD)'), 'lab-grown');
});

test('leading decimal points and two-digit years', () => {
  assert.equal(parseNumber('.50 ct'), 0.5);
  assert.equal(parseNumber('(.75)'), 0.75);
  assert.equal(parseNumber('No.123'), 123, 'a dot right after a word ends the label');
  assert.equal(parseNumber('Ct.1.02'), 1.02);
  assert.equal(parseDate('05/11/99'), '1999-11-05', 'an old date never reads as one far ahead');
  assert.equal(parseDate('05/11/85'), '1985-11-05');
  assert.equal(parseDate('05-11-26'), '2026-11-05');
});

test('the OFAC result names the date of the list it was screened against', () => {
  const { byCode } = run(euNatural(), { screenings: clearScreens().map((s) => ({ ...s, listDate: '2026-11-02' })) });
  assert.match(byCode.sanctions.detail, /^2 parties clear on the OFAC SDN list of 02 Nov 2026 \(24 similar names compared\)\.$/);
});

test('a grading report no list names is asked about once, under a key the stones read', () => {
  const shipment = { id: 'shp_v', ref: 'KG/26-27/097', workspaceId: 'ws_sample', direction: 'export', destinationCountry: 'BE', documentIds: ['v-pl', 'v-lr1', 'v-lr9'] };
  const documents = [
    doc('v-pl', 'packing_list', { 'goods.description': 'Cut and polished natural diamonds' }, [
      { reportNumber: '2141430001', lab: 'GIA', shape: 'RD', carat: 0.9, color: 'G', clarity: 'VS1' },
    ]),
    doc('v-lr1', 'lab_report', { 'lab.name': 'GIA', 'lab.reportNumber': '2141430001', 'lab.carat': '0.90', 'lab.shape': 'Round', 'lab.color': 'G', 'lab.clarity': 'VS1' }),
    doc('v-lr9', 'lab_report', { 'lab.name': 'GIA', 'lab.reportNumber': '2141430009', 'lab.carat': '1.50', 'lab.shape': 'Round', 'lab.color': 'D', 'lab.clarity': 'IF' }),
  ];
  const ask = (answers) => {
    const answered = { ...shipment, answers };
    const { stones } = matchStones({ shipment: answered, documents });
    const result = evaluate({ shipment: answered, documents, stones, house: HOUSE, screenings: clearScreens(), now: '2026-11-15' });
    return { result, question: result.questions.find((q) => q.check === 'stone_details' && /2141430009/.test(q.text)) };
  };
  const first = ask({});
  assert.equal(first.question.key, 'stone.2141430009.onShipment');
  assert.deepEqual(first.question.options, ['Yes', 'No']);
  assert.equal(ask({ 'stone.2141430009.onShipment': 'No' }).question, undefined, '"No" leaves the report out');
  const yes = ask({ 'stone.2141430009.onShipment': 'Yes' });
  assert.equal(yes.question, undefined, '"Yes" settles it');
  assert.equal(yes.result.checks.find((c) => c.code === 'stone_details').severity, 'info');
  const again = ask({ 'stone.2141430009.onShipment': 'maybe' });
  assert.match(again.question.text, /^The answer "maybe" is neither Yes nor No\./);
  assert.ok(again.question.dedupeKey.endsWith('|again|maybe'), 'a new question, so the first answer does not hold the shipment');
});

test('papers the offline reader read because the AI failed are confirmed by a person', () => {
  const docs = euNatural();
  const invoice = docs.find((d) => d.docType === 'commercial_invoice');
  invoice.needsAiRead = true;
  invoice.warnings = ['Read offline: the model timed out'];
  const { result, byCode } = run(docs);
  assert.equal(byCode.read_offline.severity, 'warn');
  assert.match(byCode.read_offline.detail, /^1 paper was read by the offline reader because a call to the AI failed: eu-inv\.pdf\. It is read again when the AI is back\.$/);
  const question = result.questions.find((q) => q.check === 'read_offline');
  assert.equal(question.kind, 'confirm');
  assert.deepEqual(question.options, ['Use the values as read']);
  assert.equal(question.dedupeKey, 'read_offline|eu-inv');
  assert.equal(result.status, 'questions');
  assert.match(question.text, /Check the values against the paper, or wait until the agents read it again\.$/);
  delete invoice.needsAiRead; // a failure the AI cannot get past: it is not read again
  const final = run(docs);
  assert.match(final.byCode.read_offline.detail, /eu-inv\.pdf\. Check the values against the paper\.$/);
  assert.match(final.result.questions.find((q) => q.check === 'read_offline').text, /Check the values against the paper\.$/);
  invoice.warnings = [];
  assert.equal(run(docs).byCode.read_offline, undefined, 'read by the AI: nothing to confirm');
});
