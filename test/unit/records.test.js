// Tests for records: shipment grouping, stone matching and stone history.
// All companies, numbers and papers here are fictional SAMPLE data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupShipments, documentRefs } from '../../src/core/records/shipments.js';
import { matchStones, findStoneIssues } from '../../src/core/records/stones.js';
import { buildHistory, sortEvents } from '../../src/core/records/history.js';

// ---------- fixture helpers ----------

let clock = 0;
function doc(id, docType, fields = {}, lines = [], extra = {}) {
  clock += 1;
  return {
    id,
    workspaceId: 'ws_sample',
    fileName: `${id}.pdf`,
    mime: 'application/pdf',
    sha256: `sha-${id}`,
    docType,
    createdAt: `2026-11-10T10:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}Z`,
    fields: Object.entries(fields).map(([key, value]) => ({ key, value, quote: String(value), page: 1, confidence: 0.95 })),
    lines: lines.map((line, i) => ({
      lineNo: i + 1, description: null, reportNumber: null, lab: null, shape: null, carat: null, color: null,
      clarity: null, pieces: null, rate: null, amount: null, growth: null, quote: null, ...line,
    })),
    declarations: [],
    shipmentId: null,
    status: 'read',
    source: { kind: 'sample', receivedAt: '2026-11-10T10:00:00Z' },
    ...extra,
  };
}

const HOUSE = { id: 'ws_sample', name: 'Kestrel Gems (SAMPLE)', legalEntity: 'Kestrel Gems Pvt Ltd', country: 'IN' };

// Six stones on the India -> Belgium export. Line 3 is 0.45 ct with no report.
// Line 6 says 1.01 ct, its GIA report says 1.04 ct (a planted carat mismatch).
const EU_LINES = [
  { reportNumber: '2141438171', lab: 'GIA', shape: 'RD', carat: 1.01, color: 'G', clarity: 'VS1', amount: 9800 },
  { reportNumber: '2141438172', lab: 'GIA', shape: 'OV', carat: 0.72, color: 'F', clarity: 'VS2', amount: 5200 },
  { reportNumber: null, lab: null, shape: 'RD', carat: 0.45, color: 'H', clarity: 'SI1', amount: 1100 },
  { reportNumber: '2141438174', lab: 'GIA', shape: 'PS', carat: 1.2, color: 'E', clarity: 'VVS2', amount: 12400 },
  { reportNumber: '612345675', lab: 'IGI', shape: 'CU', carat: 0.58, color: 'G', clarity: 'VS1', amount: 3300 },
  { reportNumber: '2141438176', lab: 'GIA', shape: 'RD', carat: 1.01, color: 'F', clarity: 'VS2', amount: 6840 },
];

function labReport(id, lab, number, shape, carat, color, clarity) {
  return doc(id, 'lab_report', {
    'lab.name': lab, 'lab.reportNumber': number, 'lab.reportDate': '12 Sep 2026', 'lab.shape': shape,
    'lab.carat': String(carat), 'lab.color': color, 'lab.clarity': clarity,
  });
}

function euExport() {
  const exporter = { 'exporter.name': 'Kestrel Gems Pvt Ltd', 'exporter.address': 'Plot 12, Sample Diamond Park, Surat 395004, India', 'exporter.country': 'India' };
  const consignee = { 'consignee.name': 'Example Diamonds BV', 'consignee.address': 'Sample Straat 1, 2018 Antwerpen', 'consignee.country': 'Belgique' };
  return [
    doc('inv1', 'commercial_invoice', {
      'invoice.number': 'KG/26-27/041', 'invoice.date': '05/11/2026', ...exporter, ...consignee,
      'goods.description': 'Cut and polished natural diamonds', 'goods.hsCode': '71023910', 'goods.totalPieces': '6',
      'goods.totalCarats': '4.97', 'goods.totalValue': '38,640.00', 'goods.currency': 'USD', 'goods.destinationCountry': 'Belgium',
    }, EU_LINES),
    doc('pl1', 'packing_list', {
      'doc.number': 'KG/26-27/041', 'invoice.number': 'KG/26-27/041', 'doc.date': '05/11/2026', ...exporter, ...consignee,
      'goods.totalPieces': '6 PCS', 'goods.totalCarats': '4.97 CTS',
    }, EU_LINES.map(({ amount, ...line }) => line)),
    doc('sb1', 'shipping_bill', {
      'shippingBill.number': '7955006', 'shippingBill.date': '06/11/2026', 'leo.date': '07/11/2026', 'invoice.number': 'KG/26-27/041',
      'exporter.name': 'KESTREL GEMS PRIVATE LIMITED', 'consignee.name': 'EXAMPLE DIAMONDS B.V.', 'goods.hsCode': '71023910',
      'goods.totalCarats': '4.97', 'goods.totalValue': '38640', 'goods.currency': 'USD', 'goods.portOfLoading': 'Mumbai Air Cargo',
      'awb.hawb': 'SMP 4784325',
    }),
    doc('awb1', 'air_waybill', {
      'awb.hawb': 'SMP-4784325', 'awb.mawb': '176-1234 5675', 'awb.flight': 'EK 500', 'awb.date': '08/11/2026', 'awb.route': 'BOM-DXB-BRU',
      'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': 'Example Diamonds BV',
    }),
    doc('ins1', 'insurance_certificate', {
      'doc.number': 'SAMPLE-INS-0041', 'awb.hawb': 'SMP 4784325', 'goods.totalCarats': '4.97', 'goods.totalValue': 'USD 38,640.00',
      'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': 'Example Diamonds BV',
      'goods.description': 'Natural cut and polished diamonds. Cover excludes transits to/from/via Ukraine, Russia and Belarus.',
    }),
    labReport('lr1', 'GIA', '2141438171', 'Round Brilliant', 1.01, 'G', 'VS1'),
    labReport('lr2', 'GIA', '2141438172', 'Oval Brilliant', 0.72, 'F', 'VS2'),
    labReport('lr4', 'GIA', '2141438174', 'Pear Brilliant', 1.2, 'E', 'VVS2'),
    labReport('lr5', 'IGI', '612345675', 'Cushion Modified Brilliant', 0.58, 'G', 'VS1'),
    labReport('lr6', 'GIA', '2141438176', 'Round Brilliant', 1.04, 'F', 'VS2'),
    // The rough side: factory record (rough lot -> polished stones), supplier invoice, KP certificate.
    doc('fr1', 'factory_record', {
      'doc.number': 'LOT R-118', 'kp.certificateNumber': 'AE 0457123', 'invoice.number': 'SUP-26-0012',
      'exporter.name': 'Kestrel Gems Pvt Ltd', 'doc.date': '02/08/2026',
    }, [
      { reportNumber: '2141438171', shape: 'Round', carat: 1.01, color: 'G', clarity: 'VS1' },
      { reportNumber: '2141438172', shape: 'Oval', carat: 0.72, color: 'F', clarity: 'VS2' },
    ]),
    doc('si1', 'supplier_invoice', {
      'invoice.number': 'SUP-26-0012', 'invoice.date': '15/06/2026', 'supplier.name': 'Sample Rough DMCC', 'supplier.country': 'U.A.E.',
      'consignee.name': 'Kestrel Gems Pvt Ltd', 'kp.certificateNumber': 'AE 0457123', 'goods.description': 'Rough diamonds, unworked',
      'goods.totalCarats': '152.40', 'goods.hsCode': '71023100',
    }),
    doc('kp1', 'kp_certificate', {
      'kp.certificateNumber': 'AE 0457123', 'kp.exportingCountry': 'U.A.E.', 'kp.importingCountry': 'India',
      'kp.countriesOfMining': 'Botswana, Namibia', 'kp.issueDate': '14/06/2026', 'kp.expiryDate': '13/08/2026', 'invoice.number': 'SUP-26-0012',
    }),
    doc('chat1', 'whatsapp_chat', {}, [], { refs: ['KG / 26-27 / 041'] }),
  ];
}

function groupedEu() {
  const documents = euExport();
  const { shipments, assignments } = groupShipments({ documents, shipments: [], house: HOUSE });
  return { documents, shipments, assignments, shipment: shipments[0] };
}

// ---------- grouping ----------

test('refs are read from fields, document numbers, list lines and chat mentions', () => {
  const [invoice] = euExport();
  const refs = documentRefs(invoice);
  const invoiceRef = refs.find((r) => r.kind === 'invoice');
  assert.equal(invoiceRef.norm, 'KG2627041');
  assert.equal(invoiceRef.own, true);
  assert.equal(invoiceRef.strong, true);
  const reports = refs.filter((r) => r.kind === 'report');
  assert.equal(reports.length, 5, 'five lines carry report numbers');
  assert.ok(reports.every((r) => !r.strong), 'report numbers are weak links');
});

test('an India to Belgium export groups into one shipment with the rough side attached', () => {
  const { documents, shipments, assignments, shipment } = groupedEu();
  assert.equal(shipments.length, 1);
  for (const d of documents) assert.equal(assignments[d.id], shipment.id, `${d.id} is filed with the shipment`);
  assert.equal(shipment.ref, 'KG/26-27/041');
  assert.equal(shipment.direction, 'export');
  assert.equal(shipment.originCountry, 'IN');
  assert.equal(shipment.destinationCountry, 'BE');
  assert.equal(shipment.route, 'India to Belgium');
  assert.equal(shipment.exporter.name, 'Kestrel Gems Pvt Ltd');
  assert.equal(shipment.consignee.country, 'Belgium');
  assert.equal(shipment.shippingBillNumber, '7955006');
  assert.equal(shipment.leoDate, '2026-11-07');
  assert.equal(shipment.invoiceDate, '2026-11-05');
  assert.equal(shipment.hawb, 'SMP-4784325');
  assert.equal(shipment.flight, 'EK 500');
  assert.deepEqual(shipment.goods.hsCodes, ['7102.39']);
  assert.equal(shipment.goods.nature, 'natural');
  assert.equal(shipment.goods.form, 'polished');
  assert.deepEqual(shipment.totals, { pieces: 6, carats: 4.97, value: 38640, currency: 'USD' });
  assert.equal(shipment.status, 'collecting');
  assert.ok(shipment.refs.includes('KG/26-27/041'));
  assert.ok(shipment.refs.includes('AE 0457123'), 'KP certificate number is listed');
  assert.equal(shipment.documentIds[0], 'inv1', 'the invoice is the best paper');
  assert.match(shipment.id, /^shp_[0-9a-f]{16}$/);
});

test('grouping is deterministic and reuses the existing shipment on the next run', () => {
  const first = groupedEu();
  const again = groupShipments({ documents: euExport(), shipments: [], house: HOUSE });
  assert.equal(again.shipments[0].id, first.shipment.id, 'same papers, same id');

  // A late paper (a second insurance page with the HAWB) joins the shipment that already exists.
  const existing = [{ ...first.shipment, status: 'questions', createdAt: '2026-11-10T11:00:00Z' }];
  const documents = [...first.documents.map((d) => ({ ...d, shipmentId: first.shipment.id })),
    doc('ins2', 'insurance_certificate', { 'awb.hawb': 'SMP4784325', 'goods.totalCarats': '4.97' })];
  const next = groupShipments({ documents, shipments: existing, house: HOUSE });
  assert.equal(next.shipments.length, 1);
  assert.equal(next.assignments.ins2, first.shipment.id);
  assert.equal(next.shipments[0].status, 'questions', 'status is kept on reuse');
  assert.equal(next.shipments[0].createdAt, '2026-11-10T11:00:00Z');
});

test('two parcels on one master air waybill stay two shipments', () => {
  const a = [
    doc('a-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/080', 'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': 'Example Diamonds BV' }),
    doc('a-awb', 'air_waybill', { 'awb.hawb': 'SMP 1000001', 'awb.mawb': '176-5555 0001', 'invoice.number': 'KG/26-27/080' }),
  ];
  const b = [
    doc('b-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/081', 'exporter.name': 'Kestrel Gems Pvt Ltd', 'consignee.name': 'Example Trading NV' }),
    doc('b-awb', 'air_waybill', { 'awb.hawb': 'SMP 1000002', 'awb.mawb': '176-5555 0001', 'invoice.number': 'KG/26-27/081' }),
  ];
  // A chat that mentions both parcels is filed with one of them but never joins them.
  const chat = doc('chat2', 'whatsapp_chat', {}, [], { refs: ['KG/26-27/080', 'KG/26-27/081', '176-5555 0001'] });
  const { shipments, assignments } = groupShipments({ documents: [...a, ...b, chat], shipments: [], house: HOUSE });
  assert.equal(shipments.length, 2);
  assert.notEqual(assignments['a-inv'], assignments['b-inv']);
  assert.equal(assignments['a-awb'], assignments['a-inv']);
  assert.equal(assignments['b-awb'], assignments['b-inv']);
  assert.ok([assignments['a-inv'], assignments['b-inv']].includes(assignments.chat2));
});

test('attachments of one email travel together even without a shared reference', () => {
  const email = doc('mail1', 'email', {}, [], { refs: [] });
  const invoice = doc('m-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/090', 'exporter.name': 'Kestrel Gems Pvt Ltd' }, [], { parentId: 'mail1' });
  const list = doc('m-pl', 'packing_list', {}, [{ carat: 0.8, shape: 'RD' }], { parentId: 'mail1' });
  const { shipments, assignments } = groupShipments({ documents: [email, invoice, list], shipments: [], house: HOUSE });
  assert.equal(shipments.length, 1);
  assert.equal(assignments['m-pl'], assignments['m-inv']);
  assert.equal(assignments.mail1, assignments['m-inv'], 'the email is filed with its attachments');
  assert.equal(shipments[0].ref, 'KG/26-27/090');
});

test('a grading report on its own does not make a shipment', () => {
  const lone = labReport('lr-alone', 'GIA', '2141439999', 'Round', 0.9, 'G', 'VS2');
  const { shipments, assignments } = groupShipments({ documents: [lone], shipments: [], house: HOUSE });
  assert.equal(shipments.length, 0);
  assert.equal(assignments['lr-alone'], undefined);
});

test('the house as consignee makes an import; a bridging paper merges two existing shipments', () => {
  const inv = doc('i-inv', 'commercial_invoice', {
    'invoice.number': 'EXD-2026-311', 'exporter.name': 'Example Diamonds BV', 'exporter.country': 'Belgium',
    'consignee.name': 'Kestrel Gems Pvt. Ltd.', 'consignee.country': 'India',
  });
  const boe = doc('i-boe', 'bill_of_entry', { 'billOfEntry.number': '4410023', 'awb.hawb': 'SMP 7000001' });
  const first = groupShipments({ documents: [inv, boe], shipments: [], house: HOUSE });
  assert.equal(first.shipments.length, 2, 'no shared reference yet');
  const invShipment = first.shipments.find((s) => s.documentIds.includes('i-inv'));
  assert.equal(invShipment.direction, 'import');
  assert.equal(invShipment.route, 'Belgium to India');

  // The air waybill names both the invoice and the HAWB on the bill of entry.
  const awb = doc('i-awb', 'air_waybill', { 'awb.hawb': 'SMP 7000001', 'invoice.number': 'EXD-2026-311' });
  const existing = first.shipments.map((s) => ({ ...s }));
  const second = groupShipments({ documents: [inv, boe, awb], shipments: existing, house: HOUSE });
  assert.equal(second.shipments.length, 1);
  assert.equal(second.merged.length, 1);
  const survivor = second.shipments[0];
  assert.equal(second.merged[0].into, survivor.id);
  assert.deepEqual([...survivor.documentIds].sort(), ['i-awb', 'i-boe', 'i-inv']);
  assert.equal(survivor.direction, 'import');
});

test('rough import papers do not pull a polished export into the same shipment', () => {
  const docs = euExport();
  // The rough came in on its own bill of entry, which names the same KP certificate.
  const roughBoe = doc('boe-rough', 'bill_of_entry', { 'billOfEntry.number': '3300456', 'kp.certificateNumber': 'AE 0457123', 'consignee.name': 'Kestrel Gems Pvt Ltd' });
  const { shipments, assignments } = groupShipments({ documents: [roughBoe, ...docs], shipments: [], house: HOUSE });
  assert.equal(shipments.length, 2);
  assert.notEqual(assignments['boe-rough'], assignments.inv1);
  assert.equal(assignments.fr1, assignments.inv1, 'the factory record stays with the polished stones');
});

// ---------- stones ----------

test('stones match on report number and on grades, and the 0.45 ct stone is not flagged', () => {
  const { documents, shipment } = groupedEu();
  const { stones, issues } = matchStones({ shipment, documents });
  assert.equal(stones.length, 6);

  const first = stones.find((s) => s.reportNumber === '2141438171');
  assert.equal(first.lab, 'GIA');
  assert.equal(first.shape, 'Round');
  assert.equal(first.carat, 1.01);
  assert.equal(first.growth, 'natural');
  assert.deepEqual(first.kp, { certificateNumber: 'AE 0457123', countries: ['BW', 'NA'] });
  const kinds = first.sources.map((s) => s.kind);
  for (const kind of ['lab_report', 'packing_list', 'commercial_invoice', 'factory_record', 'supplier_invoice', 'kp_certificate']) {
    assert.ok(kinds.includes(kind), `stone 1 has a ${kind} source`);
  }
  assert.equal(first.sources.find((s) => s.kind === 'packing_list').lineNo, 1);

  const small = stones.find((s) => s.carat === 0.45);
  assert.equal(small.reportNumber, null);
  assert.equal(small.ref, 'KG/26-27/041 line 3');
  assert.deepEqual(small.sources.filter((s) => s.lineNo).map((s) => s.kind).sort(), ['commercial_invoice', 'packing_list']);

  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0].code, 'carat_mismatch');
  assert.equal(issues[0].ref, '2141438176');
  assert.match(issues[0].detail, /1\.04 ct on the lab report but 1\.01 ct on the packing list and the invoice/);
  assert.ok(issues[0].docIds.includes('lr6'));
  assert.ok(!issues.some((i) => i.code === 'missing_lab_report'));
});

test('stone issues: missing report, duplicate, report not on list, grade and nature conflicts', () => {
  const shipment = { id: 'shp_test', ref: 'KG/26-27/099', workspaceId: 'ws_sample', documentIds: ['t-pl', 't-inv', 't-lr1', 't-lr9', 't-lr3'] };
  const documents = [
    doc('t-pl', 'packing_list', { 'goods.description': 'Natural polished diamonds' }, [
      { reportNumber: '2141430001', shape: 'RD', carat: 0.9, color: 'G', clarity: 'VS1' },
      { reportNumber: null, shape: 'OV', carat: 0.62, color: 'H', clarity: 'SI1' },
      { reportNumber: '2141430001', shape: 'RD', carat: 0.9, color: 'G', clarity: 'VS1' },
      { reportNumber: '2141430003', shape: 'PS', carat: 0.7, color: 'E', clarity: 'VS2' },
    ]),
    doc('t-inv', 'commercial_invoice', { 'goods.description': 'Natural polished diamonds', 'goods.hsCode': '7102.39' }, [
      { reportNumber: '2141430001', shape: 'RD', carat: 0.9, color: 'H', clarity: 'VS1' },
    ]),
    labReport('t-lr1', 'GIA', '2141430001', 'Round Brilliant', 0.9, 'G', 'VS1'),
    labReport('t-lr9', 'GIA', '2141430009', 'Round Brilliant', 1.5, 'D', 'IF'),
    doc('t-lr3', 'lab_report', { 'lab.name': 'IGI', 'lab.reportNumber': '2141430003', 'lab.carat': '0.70', 'lab.growthMethod': 'CVD', 'lab.shape': 'Pear' }),
  ];
  const { stones, issues } = matchStones({ shipment, documents });
  const codes = issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['duplicate_report', 'grade_mismatch', 'missing_lab_report', 'nature_conflict', 'report_not_on_list']);
  assert.match(issues.find((i) => i.code === 'duplicate_report').detail, /listed twice on the packing list \(lines 1 and 3\)/);
  assert.match(issues.find((i) => i.code === 'grade_mismatch').detail, /colour G on the lab report and the packing list but H on the invoice/);
  assert.match(issues.find((i) => i.code === 'missing_lab_report').detail, /Line 2 of the packing list \(0\.62 ct Oval\) is 0\.62 ct/);
  assert.equal(issues.find((i) => i.code === 'report_not_on_list').ref, '2141430009');
  assert.match(issues.find((i) => i.code === 'nature_conflict').detail, /lab-grown \(CVD\) on the lab report but natural on the packing list/);
  const cvd = stones.find((s) => s.reportNumber === '2141430003');
  assert.equal(cvd.growth, 'lab-grown', 'the lab report decides');
  assert.equal(cvd.growthMethod, 'CVD');
  assert.deepEqual(cvd.kp, { certificateNumber: null, countries: [] }, 'no KP for a lab-grown stone');

  // Issues can be worked out again from the stored stones alone.
  assert.deepEqual(findStoneIssues({ stones, documents, shipment }), issues);
});

test('a lot line is judged per stone', () => {
  const shipment = { id: 'shp_lot', ref: 'KG/26-27/100', documentIds: ['lot-pl'] };
  const documents = [doc('lot-pl', 'packing_list', {}, [
    { description: 'Melee lot', carat: 12.5, pieces: 250 },
    { description: 'Lot of 3', carat: 2.1, pieces: 3, shape: 'RD' },
  ])];
  const { stones, issues } = matchStones({ shipment, documents });
  assert.equal(stones.length, 2);
  assert.equal(stones[0].pieces, 250);
  assert.deepEqual(issues.map((i) => i.code), ['missing_lab_report'], 'only the 0.70 ct average lot needs reports');
  assert.equal(issues[0].carat, 0.7);
});

// ---------- history ----------

test('history runs from the mine to the signed statement in stage order', () => {
  const { documents, shipment } = groupedEu();
  const { stones } = matchStones({ shipment, documents });
  const stone = stones.find((s) => s.reportNumber === '2141438171');
  const papers = [
    { id: 'pap1', shipmentId: shipment.id, kind: 'eu_dds', ref: 'JL-EXP-1115-01', version: 1, status: 'sent',
      createdAt: '2026-11-09T09:00:00Z', signedAt: '2026-11-09T10:00:00Z', signedBy: 'Sample Signer', sentAt: '2026-11-09T11:00:00Z', sentTo: 'buyer@example.com' },
    { id: 'pap2', shipmentId: 'shp_other', kind: 'eu_dds', ref: 'JL-EXP-1115-02', version: 1, status: 'draft', createdAt: '2026-11-09T09:00:00Z' },
  ];
  const events = buildHistory({ stone, shipment, documents, papers });
  assert.deepEqual(events.map((e) => e.kind), [
    'mined', 'rough_purchased', 'cut_and_polished', 'graded', 'invoiced', 'packed', 'cleared_for_export', 'flown',
    'statement_drafted', 'statement_signed', 'statement_sent',
  ]);
  const byKind = Object.fromEntries(events.map((e) => [e.kind, e]));
  assert.equal(byKind.mined.at, null);
  assert.equal(byKind.mined.detail, 'Countries of mining: Botswana and Namibia, per KP certificate AE 0457123.');
  assert.equal(byKind.mined.docId, 'kp1');
  assert.equal(byKind.rough_purchased.at, '2026-06-15');
  assert.match(byKind.rough_purchased.detail, /Rough bought from Sample Rough DMCC, United Arab Emirates, on invoice SUP-26-0012, 152\.40 ct in the lot\./);
  assert.equal(byKind.cut_and_polished.at, '2026-08-02');
  assert.equal(byKind.graded.at, '2026-09-12');
  assert.equal(byKind.graded.detail, 'GIA report 2141438171: 1.01 ct, Round, G, VS1.');
  assert.equal(byKind.invoiced.detail, 'Line 1 of invoice KG/26-27/041 to Example Diamonds BV, USD 9,800.00.');
  assert.equal(byKind.cleared_for_export.at, '2026-11-07');
  assert.equal(byKind.cleared_for_export.detail, 'Shipping bill 7955006, Let Export Order 07 Nov 2026.');
  assert.equal(byKind.flown.detail, 'Air waybill HAWB SMP-4784325, MAWB 176-1234 5675, flight EK 500, BOM-DXB-BRU.');
  assert.equal(byKind.statement_signed.title, 'EU Due Diligence Statement signed');
  assert.equal(byKind.statement_sent.detail, 'JL-EXP-1115-01 sent to buyer@example.com.');
  assert.equal(events.filter((e) => e.kind === 'statement_drafted').length, 1, "another shipment's paper is left out");
});

test('a stone without a report on file still shows where its report number came from', () => {
  const { documents, shipment } = groupedEu();
  const withoutReport = documents.filter((d) => d.id !== 'lr4');
  const trimmed = { ...shipment, documentIds: shipment.documentIds.filter((id) => id !== 'lr4') };
  const { stones } = matchStones({ shipment: trimmed, documents: withoutReport });
  const pear = stones.find((s) => s.reportNumber === '2141438174');
  const events = buildHistory({ stone: pear, shipment: trimmed, documents: withoutReport, papers: [] });
  const graded = events.find((e) => e.kind === 'graded');
  assert.equal(graded.at, null);
  assert.equal(graded.detail, 'GIA report 2141438174 is listed on the packing list. The report itself is not on file.');
});

test('unknown dates stay null and sort after known dates within their stage', () => {
  const events = sortEvents([
    { at: null, kind: 'graded', title: 'B', detail: '' },
    { at: '2026-11-08', kind: 'flown', title: 'F', detail: '' },
    { at: '2026-09-01', kind: 'graded', title: 'A', detail: '' },
    { at: '2026-01-01', kind: 'statement_sent', title: 'S', detail: '' },
    { at: null, kind: 'mined', title: 'M', detail: '' },
  ]);
  assert.deepEqual(events.map((e) => e.title), ['M', 'A', 'B', 'F', 'S']);
});

test('stones find their KP certificate through the factory record even when it is filed with another shipment', () => {
  const docs = euExport();
  const roughBoe = doc('boe-first', 'bill_of_entry', { 'billOfEntry.number': '3300457', 'kp.certificateNumber': 'AE 0457123', 'invoice.number': 'SUP-26-0012' });
  roughBoe.createdAt = '2026-01-01T00:00:00Z'; // the rough import was filed long before
  const documents = [roughBoe, ...docs];
  const { shipments, assignments } = groupShipments({ documents, shipments: [], house: HOUSE });
  assert.equal(shipments.length, 2);
  assert.equal(assignments.kp1, assignments['boe-first'], 'the KP certificate went with the rough import');
  const polished = shipments.find((s) => s.documentIds.includes('inv1'));
  const { stones } = matchStones({ shipment: polished, documents });
  const first = stones.find((s) => s.reportNumber === '2141438171');
  assert.deepEqual(first.kp, { certificateNumber: 'AE 0457123', countries: ['BW', 'NA'] });
});

test('a store workspace works as the house, and a shipment left with no papers is not returned', () => {
  const workspace = { id: 'ws_sample', name: 'Kestrel (SAMPLE)', legalEntity: '', letterhead: { companyName: 'Kestrel Gems Pvt Ltd' } };
  const invoice = doc('w-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/120', 'exporter.name': 'KESTREL GEMS PVT. LTD.' });
  const stale = { id: 'shp_stale', ref: 'OLD-1', documentIds: ['w-inv'], status: 'collecting' };
  const other = { id: 'shp_waiting', ref: 'OLD-2', documentIds: ['still-reading'], status: 'collecting' };
  const { shipments, assignments } = groupShipments({ documents: [invoice], shipments: [stale, other], house: workspace });
  assert.equal(assignments['w-inv'], 'shp_stale', 'the shipment that owned the paper is reused');
  assert.equal(shipments.find((s) => s.id === 'shp_stale').direction, 'export');
  assert.equal(shipments.find((s) => s.id === 'shp_stale').ref, 'KG/26-27/120');
  assert.ok(shipments.some((s) => s.id === 'shp_waiting'), 'papers not passed in (still being read) keep their shipment');
});

test('papers that only share dates, totals or a master air waybill stay in separate shipments', () => {
  const documents = [];
  for (let i = 0; i < 3; i++) {
    const invoiceNo = `KG/26-27/2${i}0`;
    const same = { 'invoice.date': '05/11/2026', 'goods.totalCarats': '4.97', 'goods.totalValue': '38,640.00', 'exporter.address': 'Plot 12, Surat 395004' };
    documents.push(doc(`p${i}-inv`, 'commercial_invoice', { 'invoice.number': invoiceNo, ...same }));
    documents.push(doc(`p${i}-sb`, 'shipping_bill', { 'shippingBill.number': `795${i}006`, 'invoice.number': invoiceNo, 'leo.date': '07/11/2026', ...same }));
    documents.push(doc(`p${i}-awb`, 'air_waybill', { 'awb.hawb': `SMP 90${i}001`, 'awb.mawb': '176-0000 0001', 'invoice.number': invoiceNo, 'awb.date': '08/11/2026' }));
  }
  const { shipments, assignments } = groupShipments({ documents, shipments: [], house: HOUSE });
  assert.equal(shipments.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(assignments[`p${i}-sb`], assignments[`p${i}-inv`]);
    assert.equal(assignments[`p${i}-awb`], assignments[`p${i}-inv`]);
  }
});

test('two parcels insured under one annual policy are not joined by it', () => {
  const policy = { 'doc.number': 'POLICY 4001/3733/01', 'insurance.policyNumber': '4001/3733/01' };
  const documents = [
    doc('x-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/301' }),
    doc('x-ins', 'insurance_certificate', { ...policy, 'invoice.number': 'KG/26-27/301' }),
    doc('y-inv', 'commercial_invoice', { 'invoice.number': 'KG/26-27/302' }),
    doc('y-ins', 'insurance_certificate', { ...policy, 'invoice.number': 'KG/26-27/302' }),
  ];
  const { shipments, assignments } = groupShipments({ documents, shipments: [], house: HOUSE });
  assert.equal(shipments.length, 2);
  assert.equal(assignments['x-ins'], assignments['x-inv']);
  assert.equal(assignments['y-ins'], assignments['y-inv']);
});

test('a factory record that lists only rough lots still ties the stones to their KP certificate', () => {
  const docs = euExport().map((d) => {
    if (d.id === 'fr1') {
      // Rough lot rows only, no report numbers; the KP number and mining countries are printed on it.
      return doc('fr1', 'factory_record', { 'doc.number': 'R-0412', 'kp.certificateNumber': 'AE 0457123', 'kp.countriesOfMining': 'Botswana' },
        [{ description: 'Rough lot R-0412 issued', pieces: 14, carat: 12.8 }]);
    }
    if (d.id === 'kp1') return null; // the KP certificate itself is not on file
    return d;
  }).filter(Boolean);
  const { shipments } = groupShipments({ documents: docs, shipments: [], house: HOUSE });
  const shipment = shipments.find((s) => s.documentIds.includes('inv1'));
  // Put the factory record with the shipment, as a person would by answering a question.
  const filed = { ...shipment, documentIds: [...new Set([...shipment.documentIds, 'fr1', 'si1'])] };
  const { stones } = matchStones({ shipment: filed, documents: docs });
  const first = stones.find((s) => s.reportNumber === '2141438171');
  assert.deepEqual(first.kp, { certificateNumber: 'AE 0457123', countries: ['BW'] });
  const kinds = first.sources.map((s) => s.kind);
  assert.ok(kinds.includes('factory_record') && kinds.includes('supplier_invoice'));
});
