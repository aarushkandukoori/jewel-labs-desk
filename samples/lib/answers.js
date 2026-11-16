// answers.json: the answer key for every SAMPLE file, used to measure how well the agents read papers.
// For each file: the doc type, the key fields with their expected values, the stone lines, and the
// declarations. For each shipment: the stones (report number, carat, colour, clarity, shape), the
// stone history, the papers it needs, and the checks a correct run should produce.
//
// Values are normalized the way the reading agent returns them (see src/core/ai/schemas.js):
// dates yyyy-mm-dd, numbers as plain decimals (5.1, 37274.5), weights "0.85 kg". `printed` shows a
// value exactly as it appears on the page when that differs.
import {
  HOUSE, BUYER_EU, BUYER_UAE, BUYER_US, ROUGH_SUPPLIER, LAB, LOGISTICS, INSURER, BROKER, KP, SUPPLIER_INVOICE, FACTORY,
  SHIPMENTS, lineAmount, totals, factoryTotal, dmy, longDate, money, carats,
} from './facts.js';
import { invoiceDeclarations, SOW_TEXT, RUSSIA_TEXT } from './invoice.js';
import { KP_STATEMENT } from './rough.js';
import { insuredValue } from './insurance.js';
import { MESSAGES, RAVI, DESK, CHAT_TITLE, typedStoneLines } from './chat.js';
import { emailFacts } from './email.js';

// Plain decimals, the way toCaratString / toAmountString in src/core/ai/text.js write them.
const dec = (n) => String(Number(n.toFixed(3)));
const cash = (n) => String(Number(n.toFixed(2)));

/** One field: value plus, when it differs, the text as printed. */
function field(value, printed) {
  return printed !== undefined && printed !== value ? { value, printed } : { value };
}

function invoiceLine(stone, nature) {
  return {
    lineNo: stone.line,
    reportNumber: stone.report || null,
    shape: stone.shape,
    shapeKey: stone.shapeKey,
    carat: stone.carat,
    color: stone.color,
    clarity: stone.clarity,
    pieces: stone.pieces || 1,
    rate: stone.rate,
    amount: lineAmount(stone),
    growth: nature,
  };
}

// ---------- per-file answers ----------

function commercialInvoice(id) {
  const s = SHIPMENTS[id];
  const sum = totals(s);
  const fields = {
    'doc.number': field(s.invoice),
    'invoice.number': field(s.invoice),
    'invoice.date': field(s.invoiceDate, dmy(s.invoiceDate)),
    'exporter.name': field(HOUSE.name),
    'exporter.country': field(HOUSE.country),
    'exporter.taxId': field(HOUSE.iec),
    'consignee.name': field(s.buyer.name),
    'consignee.address': field(s.buyer.address),
    'consignee.country': field(s.buyer.country),
    'goods.description': field(s.goods),
    'goods.nature': field(s.nature),
    'goods.form': field('polished'),
    'goods.hsCode': field(s.hsCode),
    'goods.totalPieces': field(String(sum.pieces)),
    'goods.totalCarats': field(dec(sum.carats), carats(sum.carats)),
    'goods.totalValue': field(cash(sum.value), money(sum.value)),
    'goods.currency': field('USD'),
    'goods.incoterm': field(s.incoterm, `${s.incoterm} ${s.incotermPlace}`),
    'goods.countryOfOrigin': field('India'),
    'goods.destinationCountry': field(s.destination),
    'goods.portOfLoading': field(s.portOfLoading),
    'goods.portOfDischarge': field(s.portOfDischarge),
    'payment.terms': field(s.payment),
  };
  if (s.po) fields['po.number'] = field(s.po.number);
  return {
    docType: 'commercial_invoice',
    fields,
    lines: s.stones.map((stone) => invoiceLine(stone, s.nature)),
    declarations: invoiceDeclarations(s),
  };
}

function labReport(stone, { labGrown = false } = {}) {
  const carat = stone.labCarat ?? stone.carat;
  const fields = {
    'doc.number': field(stone.report),
    'doc.date': field(stone.reportDate, longDate(stone.reportDate)),
    'lab.name': field(LAB.name),
    'lab.reportNumber': field(stone.report),
    'lab.reportDate': field(stone.reportDate, longDate(stone.reportDate)),
    'lab.shape': field(stone.labShape),
    'lab.carat': field(dec(carat), `${carats(carat)} carat`),
    'lab.color': field(stone.color),
    'lab.clarity': field(stone.clarity),
    'lab.polish': field(stone.polish),
    'lab.symmetry': field(stone.symmetry),
    'lab.fluorescence': field(stone.fluorescence),
    'lab.measurements': field(stone.measurements),
    'lab.inscription': field(`${labGrown ? 'LAB-GROWN ' : ''}${LAB.short} ${stone.report}`),
    'goods.nature': field(labGrown ? 'lab-grown' : 'natural'),
  };
  if (stone.cut) fields['lab.cut'] = field(stone.cut);
  if (labGrown) fields['lab.growthMethod'] = field('CVD');
  return {
    docType: 'lab_report',
    fields,
    lines: [{
      lineNo: 1, reportNumber: stone.report, lab: LAB.name, shape: stone.labShape, shapeKey: stone.shapeKey, carat,
      color: stone.color, clarity: stone.clarity, pieces: 1, rate: null, amount: null, growth: labGrown ? 'lab-grown' : 'natural',
    }],
    declarations: [],
  };
}

function kpCertificate() {
  return {
    docType: 'kp_certificate',
    fields: {
      'doc.number': field(KP.number),
      'doc.date': field(KP.issued, dmy(KP.issued)),
      'kp.certificateNumber': field(KP.number),
      'kp.exportingCountry': field(KP.exportingCountry),
      'kp.importingCountry': field(KP.importingCountry),
      'kp.countriesOfMining': field(KP.countriesOfMining.join(', ')),
      'kp.issueDate': field(KP.issued, dmy(KP.issued)),
      'kp.expiryDate': field(KP.expires, dmy(KP.expires)),
      'kp.carats': field(dec(KP.carats), carats(KP.carats)),
      'kp.value': field(cash(KP.value), money(KP.value)),
      'exporter.name': field(ROUGH_SUPPLIER.name),
      'consignee.name': field(HOUSE.name),
      'goods.hsCode': field('710231', KP.hsCode),
      'goods.nature': field('natural'),
      'goods.form': field('rough'),
    },
    alternatives: { 'consignee.name': ['buyer.name'], 'exporter.name': ['supplier.name'] },
    lines: [],
    declarations: [KP_STATEMENT],
  };
}

function supplierInvoice() {
  const inv = SUPPLIER_INVOICE;
  return {
    docType: 'supplier_invoice',
    fields: {
      'doc.number': field(inv.number),
      'invoice.number': field(inv.number),
      'invoice.date': field(inv.date, dmy(inv.date)),
      'supplier.name': field(ROUGH_SUPPLIER.name),
      'supplier.country': field(ROUGH_SUPPLIER.country),
      'consignee.name': field(HOUSE.name),
      'kp.certificateNumber': field(KP.number),
      'kp.countriesOfMining': field(KP.countriesOfMining.join(', ')),
      'goods.hsCode': field(inv.hsCode),
      'goods.nature': field('natural'),
      'goods.form': field('rough'),
      'goods.totalPieces': field(String(inv.pieces)),
      'goods.totalCarats': field(dec(inv.carats), carats(inv.carats)),
      'goods.totalValue': field(cash(inv.value), money(inv.value)),
      'goods.currency': field('USD'),
      'goods.incoterm': field('CIF', 'CIF Mumbai'),
    },
    alternatives: { 'supplier.name': ['exporter.name'], 'consignee.name': ['buyer.name'] },
    lines: [{
      lineNo: 1, reportNumber: null, description: 'Natural rough diamonds, gem quality, sawable', lot: inv.lot,
      carat: inv.carats, pieces: inv.pieces, rate: inv.rate, amount: inv.value, growth: 'natural',
    }],
    declarations: [SOW_TEXT, RUSSIA_TEXT, KP_STATEMENT],
  };
}

function factoryRecord() {
  return {
    docType: 'factory_record',
    fields: {
      'doc.number': field(FACTORY.lot),
      'doc.date': field(FACTORY.recordDate, dmy(FACTORY.recordDate)),
      'exporter.name': field(HOUSE.name),
      'supplier.name': field(ROUGH_SUPPLIER.name),
      'invoice.number': field(SUPPLIER_INVOICE.number),
      'kp.certificateNumber': field(KP.number),
      'kp.countriesOfMining': field(KP.countriesOfMining.join(', ')),
    },
    note: 'invoice.number here is the rough supplier invoice. Line carats are the factory\'s polished weights.',
    lines: SHIPMENTS.A.stones.map((stone) => ({
      lineNo: stone.line, reportNumber: stone.report || null, shapeKey: stone.shapeKey, shape: stone.shapeKey,
      carat: stone.actual, plannedCarat: stone.planned, color: stone.color, clarity: stone.clarity, pieces: 1,
      roughPiece: stone.roughPiece, polishedOn: stone.polishedOn, growth: null,
    })),
    totals: { roughCarats: FACTORY.roughCarats, polishedCarats: factoryTotal() },
    declarations: [],
  };
}

function packingList() {
  const s = SHIPMENTS.A;
  const sum = totals(s);
  return {
    docType: 'packing_list',
    fields: {
      'invoice.number': field(s.invoice),
      'doc.date': field(s.packingListDate, dmy(s.packingListDate)),
      'po.number': field(s.po.number),
      'consignee.name': field(s.buyer.name),
      'goods.hsCode': field(s.hsCode),
      'goods.totalPieces': field(String(sum.pieces)),
      'goods.totalCarats': field(dec(sum.carats), carats(sum.carats)),
      'goods.totalValue': field(cash(sum.value), money(sum.value)),
      'goods.netWeight': field('1.02 g', '1.02'),
      'goods.grossWeight': field('0.85 kg', '0.85'),
    },
    lines: s.stones.map((stone) => invoiceLine(stone, 'natural')),
    declarations: [],
  };
}

function shippingBill(id) {
  const s = SHIPMENTS[id];
  const sb = s.shippingBill;
  const sum = totals(s);
  return {
    docType: 'shipping_bill',
    fields: {
      'doc.number': field(sb.number),
      'shippingBill.number': field(sb.number),
      'shippingBill.date': field(sb.date, dmy(sb.date)),
      'leo.date': field(sb.leoDate, dmy(sb.leoDate)),
      'leo.number': field(sb.leoNumber),
      'exporter.name': field(HOUSE.name, HOUSE.name.toUpperCase()),
      'exporter.taxId': field(HOUSE.iec),
      'consignee.name': field(s.buyer.name, s.buyer.name.toUpperCase()),
      'broker.name': field(BROKER.name, BROKER.name.toUpperCase()),
      'invoice.number': field(s.invoice),
      'invoice.date': field(s.invoiceDate, dmy(s.invoiceDate)),
      'goods.hsCode': field(s.hsCode),
      'goods.nature': field(s.nature),
      'goods.form': field('polished'),
      'goods.totalPieces': field(String(sum.pieces)),
      'goods.totalCarats': field(dec(sum.carats), carats(sum.carats)),
      'goods.totalValue': field(cash(sum.value), money(sum.value)),
      'goods.currency': field('USD'),
      'goods.destinationCountry': field(s.destination, s.destination.toUpperCase()),
      'goods.portOfLoading': field(s.portOfLoading, s.portOfLoading.toUpperCase()),
      'goods.portOfDischarge': field(s.portOfDischarge, s.portOfDischarge.toUpperCase()),
      'goods.grossWeight': field(`${s.awb.grossKg} kg`, s.awb.grossKg.toFixed(3)),
      'awb.mawb': field(s.awb.mawb),
      'awb.hawb': field(s.awb.hawb),
    },
    lines: [],
    declarations: ['Declaration by the exporter: the particulars given above are true and correct.'],
  };
}

function airWaybill(id) {
  const s = SHIPMENTS[id];
  const awb = s.awb;
  const sum = totals(s);
  const fields = {
    'doc.number': field(awb.hawb),
    'awb.hawb': field(awb.hawb),
    'awb.mawb': field(awb.mawb),
    'awb.flight': field(awb.legs[0].flight.replace(' ', ''), awb.legs[0].flight),
    'awb.date': field(awb.date, dmy(awb.date)),
    'awb.route': field(awb.route, awb.route.split('-').join(' - ')),
    'exporter.name': field(HOUSE.name, HOUSE.name.toUpperCase()),
    'consignee.name': field(s.buyer.name, s.buyer.name.toUpperCase()),
    'invoice.number': field(s.invoice),
    'goods.grossWeight': field(`${awb.grossKg} kg`, `${awb.grossKg.toFixed(2)} KG`),
    'goods.totalValue': field(cash(sum.value), money(sum.value)),
    'goods.currency': field('USD'),
    'goods.portOfLoading': field(s.portOfLoading, s.portOfLoading.toUpperCase()),
    'goods.portOfDischarge': field(s.portOfDischarge, s.portOfDischarge.toUpperCase()),
  };
  if (s.shippingBill) fields['shippingBill.number'] = field(s.shippingBill.number);
  return {
    docType: 'air_waybill',
    fields,
    flights: awb.legs.map((leg) => `${leg.flight} ${leg.from}-${leg.to}`),
    note: `Issued by ${LOGISTICS.name} as agent of the carrier.`,
    lines: [],
    declarations: [],
  };
}

function insuranceCertificate() {
  const s = SHIPMENTS.A;
  const ins = s.insurance;
  return {
    docType: 'insurance_certificate',
    fields: {
      'doc.number': field(ins.certificate),
      'doc.date': field(ins.date, dmy(ins.date)),
      'insurance.policyNumber': field(ins.policy),
      'insurance.insuredValue': field(cash(insuredValue()), money(insuredValue())),
      'insurer.name': field(INSURER.name),
      'invoice.number': field(s.invoice),
      'awb.hawb': field(s.awb.hawb),
      'awb.mawb': field(s.awb.mawb),
      'goods.currency': field('USD'),
    },
    note: 'Image-only scan: no text layer, so it is read with the vision model or OCR.',
    lines: [],
    declarations: [],
  };
}

function purchaseOrder() {
  const s = SHIPMENTS.A;
  const sum = totals(s);
  return {
    docType: 'purchase_order',
    fields: {
      'doc.number': field(s.po.number),
      'po.number': field(s.po.number),
      'doc.date': field(s.po.date, dmy(s.po.date)),
      'buyer.name': field(s.buyer.name),
      'supplier.name': field(HOUSE.name),
      'goods.totalCarats': field(dec(sum.carats), carats(sum.carats)),
      'goods.totalValue': field(cash(sum.value), money(sum.value)),
      'goods.currency': field('USD'),
      'goods.incoterm': field('CIF', 'CIF Antwerp'),
    },
    alternatives: { 'buyer.name': ['consignee.name'] },
    refs: [s.invoice],
    lines: s.stones.map((stone) => invoiceLine(stone, 'natural')),
    declarations: [],
  };
}

function emailAnswer() {
  const facts = emailFacts();
  return {
    docType: 'email',
    email: facts,
    expectedReading: {
      refs: facts.refs,
      requests: [facts.request],
    },
    lines: [],
    declarations: [],
  };
}

function chatAnswer(chat) {
  const people = MESSAGES.filter((m) => !m.system && !m.call);
  return {
    docType: 'whatsapp_chat',
    chat: {
      title: CHAT_TITLE,
      format: 'iPhone export, dates day first (10/11/26), 12-hour times',
      authors: [RAVI, DESK],
      from: '2026-11-10',
      to: '2026-11-13',
      messages: people.length,
      systemNotes: MESSAGES.length - people.length,
      attachments: chat.attachments.map((a) => ({ name: a.name, sentBy: RAVI, at: a.at.replace(' ', 'T') })),
    },
    expectedReading: {
      refs: [SHIPMENTS.A.invoice, KP.number, SUPPLIER_INVOICE.number, SHIPMENTS.A.shippingBill.number],
      relevant: MESSAGES.filter((m) => m.relevant).map((m) => ({ at: m.at.replace(' ', 'T'), author: m.from, text: m.text })),
      deskAsked: MESSAGES.filter((m) => m.from === DESK && /please/i.test(m.text)).map((m) => m.text),
      promised: [{ paper: 'packing_list', text: 'packing list is coming tomorrow', arrives: 'later/Packing list KG-26-27-041.xlsx' }],
      typedStoneList: {
        ref: SHIPMENTS.A.invoice,
        printed: typedStoneLines(),
        lines: SHIPMENTS.A.stones.map((stone) => ({
          lineNo: stone.line, reportNumber: stone.report || null, shapeKey: stone.shapeKey, carat: stone.carat,
          color: stone.color, clarity: stone.clarity, pieces: 1,
        })),
      },
    },
    lines: [],
    declarations: [],
  };
}

// ---------- shipments ----------

function stoneTruth(stone, { growth }) {
  return {
    line: stone.line,
    reportNumber: stone.report || null,
    lab: stone.report ? LAB.name : null,
    shape: stone.shapeKey,
    carat: stone.labCarat ?? stone.carat,
    ...(stone.labCarat !== undefined ? { caratOnInvoice: stone.carat } : {}),
    color: stone.color,
    clarity: stone.clarity,
    pieces: stone.pieces || 1,
    growth,
    amount: lineAmount(stone),
  };
}

function shipmentA(fileIds) {
  const s = SHIPMENTS.A;
  const sum = totals(s);
  return {
    ref: s.invoice,
    direction: 'export',
    exporter: HOUSE.name,
    consignee: BUYER_EU.name,
    destination: s.destination,
    destinationCode: s.destinationCode,
    regime: 'EU',
    goods: { nature: 'natural', form: 'polished', hsCodes: [s.hsCode] },
    totals: { pieces: sum.pieces, carats: sum.carats, value: sum.value, currency: 'USD' },
    refs: {
      invoiceNumber: s.invoice, invoiceDate: s.invoiceDate, poNumber: s.po.number, shippingBillNumber: s.shippingBill.number,
      leoDate: s.shippingBill.leoDate, hawb: s.awb.hawb, mawb: s.awb.mawb, flights: s.awb.legs.map((l) => l.flight), route: s.awb.route,
    },
    required: ['export_pack', 'eu_dds'],
    notRequired: ['us_cbp_certificate', 'g7_gf_declaration'],
    stones: s.stones.map((stone) => stoneTruth(stone, { growth: 'natural' })),
    history: {
      countriesOfMining: KP.countriesOfMining,
      kpCertificate: KP.number,
      kpExportingCountry: KP.exportingCountry,
      roughSupplier: ROUGH_SUPPLIER.name,
      supplierInvoice: SUPPLIER_INVOICE.number,
      roughLot: FACTORY.lot,
      chain: [
        { step: 'mined', detail: `Botswana and Namibia, per KP certificate ${KP.number}`, file: 'A-kp' },
        { step: 'rough_purchased', at: SUPPLIER_INVOICE.date, detail: `Lot ${FACTORY.lot} from ${ROUGH_SUPPLIER.name} on invoice ${SUPPLIER_INVOICE.number}`, file: 'A-supplier-invoice' },
        { step: 'cut_and_polished', at: FACTORY.recordDate, detail: `From rough lot ${FACTORY.lot}`, file: 'A-factory-record' },
        { step: 'graded', detail: `${LAB.name} reports, July 2026`, file: 'A-report-*' },
        { step: 'invoiced', at: s.invoiceDate, detail: `Invoice ${s.invoice} to ${BUYER_EU.name}`, file: 'A-invoice' },
        { step: 'packed', at: s.packingListDate, detail: 'Packing list (arrives late)', file: 'A-packing-list' },
        { step: 'cleared_for_export', at: s.shippingBill.leoDate, detail: `Shipping bill ${s.shippingBill.number}, Let Export Order ${dmy(s.shippingBill.leoDate)}`, file: 'A-shipping-bill' },
        { step: 'flown', at: s.awb.date, detail: `HAWB ${s.awb.hawb}, MAWB ${s.awb.mawb}, EK 501 BOM-DXB then EK 183 DXB-BRU`, file: 'A-air-waybill' },
        { step: 'statement_drafted', detail: 'EU Due Diligence Statement on Diamond Origin, ready to sign by the importer' },
      ],
      stoneWithoutReport: { line: 4, carat: 0.45, why: 'below 0.50 ct, so no grading report and no EU statement line requirement' },
    },
    expectedChecks: [
      {
        code: 'stone_details', severity: 'warn', issue: 'carat_mismatch', reportNumber: '7391020002',
        values: { commercial_invoice: 0.71, packing_list: 0.71, lab_report: 0.7, factory_record: 0.7 },
        note: 'Deliberate: the invoice (and the packing list copied from it) say 0.71 ct, the lab report and the factory record say 0.70 ct. Expect a one-line question.',
      },
      { code: 'eu_dds_required', severity: 'info', expect: 'required', paper: 'eu_dds', note: 'Natural polished stones of 0.50 ct and up going to Belgium. The importer signs it.' },
      {
        code: 'required_documents', severity: 'warn', missing: ['packing_list'], until: 'later/Packing list KG-26-27-041.xlsx',
        note: 'Until the late packing list is added the agents should ask for it (Ravi said it is coming) or draft one from the stone list typed in the chat. Once it is added this check passes.',
      },
      { code: 'kp_present', severity: 'pass', kpCertificate: KP.number },
      { code: 'kp_countries_listed', severity: 'pass', countries: ['BW', 'NA'] },
      { code: 'russia_anywhere', severity: 'pass' },
      { code: 'lab_reports_for_half_carat', severity: 'pass', note: 'All five stones of 0.50 ct and up have reports; the 0.45 ct stone needs none.' },
      { code: 'nature_consistency', severity: 'pass' },
      { code: 'dates_order', severity: 'pass', note: 'Invoice 10 Nov, LEO 12 Nov, flight 13 Nov.' },
    ],
    files: fileIds,
  };
}

function shipmentB(fileIds) {
  const s = SHIPMENTS.B;
  const sum = totals(s);
  return {
    ref: s.invoice,
    direction: 'export',
    exporter: HOUSE.name,
    consignee: BUYER_UAE.name,
    destination: s.destination,
    destinationCode: s.destinationCode,
    regime: 'OTHER',
    goods: { nature: 'lab-grown', form: 'polished', hsCodes: [s.hsCode], growthMethod: 'CVD' },
    totals: { pieces: sum.pieces, carats: sum.carats, value: sum.value, currency: 'USD' },
    lots: [
      { lot: 1, pieces: 120, carats: 96.4, lines: [1, 2] },
      { lot: 2, pieces: 80, carats: 61.15, lines: [3, 4] },
    ],
    refs: {
      invoiceNumber: s.invoice, invoiceDate: s.invoiceDate, shippingBillNumber: s.shippingBill.number,
      leoDate: s.shippingBill.leoDate, hawb: s.awb.hawb, mawb: s.awb.mawb, flights: s.awb.legs.map((l) => l.flight), route: s.awb.route,
    },
    required: ['export_pack'],
    notRequired: ['eu_dds', 'us_cbp_certificate', 'g7_gf_declaration'],
    stones: s.stones.map((stone) => stoneTruth(stone, { growth: 'lab-grown' })),
    expectedChecks: [
      { code: 'eu_dds_required', expect: 'absent', note: 'Not going to the EU, and lab-grown: no EU Due Diligence Statement.' },
      { code: 'us_cbp_cert', expect: 'absent' },
      { code: 'goods_class', severity: 'pass', nature: 'lab-grown', form: 'polished' },
      { code: 'nature_consistency', severity: 'pass' },
      { code: 'required_documents', severity: 'warn', missing: ['packing_list'], note: 'The samples hold no packing list for shipment B.' },
    ],
    files: fileIds,
  };
}

function shipmentC(fileIds) {
  const s = SHIPMENTS.C;
  const sum = totals(s);
  return {
    ref: s.invoice,
    direction: 'export',
    exporter: HOUSE.name,
    consignee: BUYER_US.name,
    destination: s.destination,
    destinationCode: s.destinationCode,
    regime: 'US',
    goods: { nature: 'natural', form: 'polished', hsCodes: [s.hsCode] },
    totals: { pieces: sum.pieces, carats: sum.carats, value: sum.value, currency: 'USD' },
    refs: { invoiceNumber: s.invoice, invoiceDate: s.invoiceDate, hawb: s.awb.hawb, mawb: s.awb.mawb, flights: s.awb.legs.map((l) => l.flight), route: s.awb.route },
    required: ['export_pack', 'us_cbp_certificate'],
    notRequired: ['eu_dds', 'g7_gf_declaration'],
    stones: s.stones.map((stone) => stoneTruth(stone, { growth: 'natural' })),
    expectedChecks: [
      { code: 'us_cbp_cert', severity: 'info', expect: 'required', paper: 'us_cbp_certificate', note: 'Natural stones of 0.50 ct and up into the US. The US importer gives it to its customs broker with the entry.' },
      { code: 'eu_dds_required', expect: 'absent' },
      { code: 'required_documents', severity: 'warn', missing: ['packing_list', 'shipping_bill'], note: 'The samples hold only the invoice, two reports and the air waybill for shipment C.' },
      { code: 'kp_present', severity: 'warn', note: 'No KP certificate or rough papers are linked to shipment C.' },
      { code: 'lab_reports_for_half_carat', severity: 'pass' },
    ],
    files: fileIds,
  };
}

/**
 * The whole answer key. layout: { files: [{ id, shipment, path, inside?, channel, kind, mime, textLayer, pages }] }
 * from build.js; chat: the result of buildChatZip.
 */
export function buildAnswers({ layout, chat }) {
  const byId = {
    'A-invoice': commercialInvoice('A'),
    'A-report-7391020001': labReport(SHIPMENTS.A.stones[0]),
    'A-report-7391020002': labReport(SHIPMENTS.A.stones[1]),
    'A-report-7391020003': labReport(SHIPMENTS.A.stones[2]),
    'A-report-7391020005-photo': labReport(SHIPMENTS.A.stones[4]),
    'A-report-7391020006': labReport(SHIPMENTS.A.stones[5]),
    'A-kp': kpCertificate(),
    'A-supplier-invoice': supplierInvoice(),
    'A-chat': chatAnswer(chat),
    'A-email': emailAnswer(),
    'A-purchase-order': purchaseOrder(),
    'A-shipping-bill': shippingBill('A'),
    'A-air-waybill': airWaybill('A'),
    'A-insurance': insuranceCertificate(),
    'A-factory-record': factoryRecord(),
    'A-packing-list': packingList(),
    'B-invoice': commercialInvoice('B'),
    'B-report-7392040011': labReport(SHIPMENTS.B.stones[1], { labGrown: true }),
    'B-report-7392040012': labReport(SHIPMENTS.B.stones[3], { labGrown: true }),
    'B-shipping-bill': shippingBill('B'),
    'B-air-waybill': airWaybill('B'),
    'C-invoice': commercialInvoice('C'),
    'C-report-7391030001': labReport(SHIPMENTS.C.stones[0]),
    'C-report-7391030002': labReport(SHIPMENTS.C.stones[1]),
    'C-air-waybill': airWaybill('C'),
  };
  const files = layout.files.map((file) => {
    const answer = byId[file.id];
    if (!answer) throw new Error(`No answer for ${file.id}`);
    return { ...file, ...answer };
  });
  const idsOf = (shipment) => files.filter((f) => f.shipment === shipment).map((f) => f.id);
  return {
    about: 'Answer key for the SAMPLE shipment in samples/sample-shipment. Every company, person, lab and number is fictional (Jewel Labs demo).',
    generatedBy: 'node samples/generate.js',
    version: 1,
    howToCompare: {
      paths: '"path" is relative to samples/sample-shipment. "inside" names a file inside that zip or email, as ingest names it.',
      fields: 'Values are normalized like the reading agent output: dates yyyy-mm-dd, carats and money as plain decimals without separators (5.1, 37274.5), weights "<number> <unit>", HS codes as digits. Compare case-insensitively and ignore spaces and punctuation. "printed" is the same value as printed on the page.',
      alternatives: 'Where two field keys fit (the importer on a KP certificate can be consignee.name or buyer.name), "alternatives" lists keys that also count.',
      lines: 'One entry per printed row, in order. Match on reportNumber when there is one, else on lineNo. Compare carat as a number within 0.005, colour and clarity case-insensitively, shape by shapeKey (Round, Oval, Princess, Emerald, Cushion, Pear).',
      checks: 'expectedChecks use the codes in src/core/rules/compliance.js. expect "absent" means no such requirement should be raised.',
    },
    house: {
      name: HOUSE.name, address: HOUSE.address, country: HOUSE.country, iec: HOUSE.iec, email: HOUSE.email, phone: HOUSE.phone,
    },
    deliveryOrder: [
      { channel: 'email', path: 'email', note: 'The buyer\'s purchase order arrives first (9 Nov) and asks for the EU statement.' },
      { channel: 'whatsapp', path: 'whatsapp', note: 'Ravi sends the invoice, reports (one as a phone photo), the KP certificate and the supplier invoice (10 to 13 Nov). He promises the packing list and types the stone list instead.' },
      { channel: 'drop', path: 'drop', note: 'The house drops the shipping bill, air waybill, the scanned insurance certificate and the factory record, plus the papers of shipments B and C.' },
      { channel: 'later', path: 'later', note: 'The packing list arrives last and closes the open question for shipment A. Add it after the first run.' },
    ],
    shipments: { A: shipmentA(idsOf('A')), B: shipmentB(idsOf('B')), C: shipmentC(idsOf('C')) },
    files,
  };
}
