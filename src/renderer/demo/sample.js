// The fictional SAMPLE world of the demo and the built-in scripted run over it.
// One house (Nilgiri Star Diamonds, SAMPLE) with four shipments:
//   A  NS/26-27/041  Surat to Antwerp, natural: the live run. The agents read its 7 papers while you watch,
//                    trace the 6 stones, screen the parties, run the rules and ask one question.
//   B  NS/26-27/038  Surat to New York: signed and sent last week (the US self-certification).
//   C  NS/26-27/044  Surat to Dubai, lab-grown: still collecting papers (two missing).
//   D  NS/26-27/043  Surat to Hong Kong: its pack is held for the Jewel Labs desk to review.
// Every company, person and number is made up. The run has the same shape as a recorded one
// (see demo/README.md), so demo/mock-api.js plays both the same way.
import { invoicePdf, packingListPdf, shippingBillPdf, airWaybillPdf, roughInvoicePdf, factoryPhoto } from './sample-docs.js';

export const HOUSE = {
  id: 'ws-sample', kind: 'local', sample: true, name: 'Nilgiri Star Diamonds', legalName: 'Nilgiri Star Diamonds Pvt. Ltd. (SAMPLE)',
  address: 'Unit 7, Diamond Trade Centre, Varachha Road', city: 'Surat', country: 'IN', taxId: 'IEC 0000000000 (sample)',
  letterhead: 'Natural polished diamonds, Surat (SAMPLE)', brokerEmail: 'docs@broker.example.com', autopilot: true, role: 'exporter',
};
export const LOCAL = { id: 'ws-local', kind: 'local', sample: false, name: 'Local workspace', autopilot: true };

const EXPORTER = { name: 'Nilgiri Star Diamonds Pvt. Ltd. (SAMPLE)', shortName: 'Nilgiri Star Diamonds', address: 'Unit 7, Diamond Trade Centre, Varachha Road', city: 'Surat', country: 'IN', countryName: 'India', taxId: 'IEC 0000000000 (sample)' };
const RHINE = { name: 'Rhine Facet BV (SAMPLE)', address: 'Diamond quarter, 2018 Antwerp', country: 'BE', countryName: 'Belgium', eori: 'BE0000000000 (sample)' };
const HUDSON = { name: 'Hudson Row Jewels LLC (SAMPLE)', address: 'West 47th Street, New York, NY 10036', country: 'US', countryName: 'United States' };
const GULF = { name: 'Gulf Lumen Trading FZE (SAMPLE)', address: 'Free Zone, Dubai', country: 'AE', countryName: 'United Arab Emirates' };
const KOWLOON = { name: 'Kowloon Lantern Gems Ltd (SAMPLE)', address: 'Tsim Sha Tsui, Kowloon', country: 'HK', countryName: 'Hong Kong' };
const KAROO = { name: 'Karoo Rough Trading DMCC (SAMPLE)', address: 'Dubai, United Arab Emirates', country: 'AE', countryName: 'United Arab Emirates' };
const CARRIER = 'Northline Air Cargo (SAMPLE)';

const natural = (report, shape, carat, color, clarity, rate, mm, extra = {}) => ({ report, lab: 'GIA', shape, carat, color, clarity, rate, mm, ...extra });

export const A = {
  id: 'shp-a', ref: 'NS/26-27/041', invoiceNumber: 'NS/26-27/041', invoiceDate: '03 Nov 2026', packingNumber: 'PL/26-27/041',
  exporter: EXPORTER, consignee: RHINE, carrier: CARRIER, nature: 'natural', natureText: 'Natural', originText: 'Botswana, Namibia (mixed)',
  terms: 'CIF Antwerp, 60 days', hsCode: '7102.39', hsCodeLong: '71023910', description: 'Cut and polished natural diamonds, loose',
  stones: [
    natural('2211458730', 'Round', 1.02, 'F', 'VS1', 9800, '6.43 x 6.47 x 3.98'),
    natural('2211458731', 'Round', 0.91, 'G', 'VS2', 6900, '6.19 x 6.22 x 3.84'),
    natural('2211458732', 'Oval', 1.21, 'E', 'SI1', 8200, '8.21 x 5.94 x 3.70'),
    natural('2211458734', 'Round', 0.71, 'H', 'VS1', 4600, '5.70 x 5.73 x 3.52', { factoryCarat: 0.7 }),
    natural('2211458735', 'Pear', 0.62, 'G', 'VVS2', 4100, '7.40 x 4.71 x 2.88'),
    natural(null, 'Round', 0.38, 'H', 'SI1', 2400, '4.62 x 4.65 x 2.86'),
  ],
  mismatchIndex: 3, totalCarats: 4.85, totalValue: 32917,
  sbNumber: '4417203', sbDate: '04 Nov 2026', leoDate: '04 Nov 2026', portOfLoading: 'Surat (SUR6, sample)', portOfDischarge: 'Brussels',
  mawb: '176-55501234', hawb: 'NLX61238874', flight: 'NL 104 / 05 Nov 2026', awbDate: '05 Nov 2026', route: 'Surat - Mumbai - Brussels',
  grossWeight: '0.850 kg', netWeight: '0.001 kg', kp: 'AE-SAMPLE-0042117', mining: ['BW', 'NA'],
};
const ROUGH = { invoiceNumber: 'KRT-2209', date: '12 Aug 2026', lot: 'R-118', carats: 9.8, rate: 1500, value: 14700, kp: A.kp, mining: 'Botswana, Namibia', supplier: KAROO, buyer: EXPORTER };
const FACTORY = { house: 'Nilgiri Star - factory, Surat', houseName: EXPORTER.name, lot: 'R-118', date: '02 Oct 2026', roughCarats: 9.8, stones: A.stones, mismatchIndex: 3 };

export const B = {
  ...A, id: 'shp-b', ref: 'NS/26-27/038', invoiceNumber: 'NS/26-27/038', invoiceDate: '27 Oct 2026', packingNumber: 'PL/26-27/038',
  consignee: HUDSON, terms: 'CIF New York, 30 days', originText: 'Canada, Botswana (mixed)',
  stones: [
    { report: '614208835', lab: 'IGI', shape: 'Round', carat: 1.51, color: 'G', clarity: 'VS2', rate: 11200, mm: '7.36 x 7.40 x 4.55' },
    { report: '614208836', lab: 'IGI', shape: 'Cushion', carat: 0.8, color: 'F', clarity: 'VVS2', rate: 7400, mm: '5.62 x 5.48 x 3.71' },
    { report: '614208837', lab: 'IGI', shape: 'Round', carat: 0.55, color: 'H', clarity: 'SI1', rate: 3900, mm: '5.25 x 5.28 x 3.24' },
  ],
  mismatchIndex: -1, totalCarats: 2.86, totalValue: 24977, sbNumber: '4402918', sbDate: '28 Oct 2026', leoDate: '28 Oct 2026', portOfDischarge: 'New York (JFK)',
  mawb: '176-55500977', hawb: 'NLX61230411', flight: 'NL 220 / 29 Oct 2026', awbDate: '29 Oct 2026', route: 'Surat - Mumbai - New York JFK',
  grossWeight: '0.620 kg', kp: 'AE-SAMPLE-0039954', mining: ['CA', 'BW'],
};
export const C = {
  ...A, id: 'shp-c', ref: 'NS/26-27/044', invoiceNumber: 'NS/26-27/044', invoiceDate: '12 Nov 2026', consignee: GULF, nature: 'lab-grown',
  natureText: 'Lab-grown (CVD)', originText: 'India (grown)', terms: 'CIF Dubai, 30 days', hsCode: '7104.91', description: 'Cut and polished lab-grown diamonds, loose',
  stones: [
    { report: 'LG622189401', lab: 'IGI', shape: 'Emerald', carat: 2.03, color: 'E', clarity: 'VS1', rate: 420, mm: '' },
    { report: 'LG622189402', lab: 'IGI', shape: 'Round', carat: 1.5, color: 'F', clarity: 'VVS2', rate: 380, mm: '' },
    { report: 'LG622189403', lab: 'IGI', shape: 'Oval', carat: 1.71, color: 'D', clarity: 'VS2', rate: 400, mm: '' },
    { report: 'LG622189404', lab: 'IGI', shape: 'Round', carat: 1.01, color: 'G', clarity: 'VS1', rate: 300, mm: '' },
  ],
  mismatchIndex: -1, totalCarats: 6.25, totalValue: 2409.6, kp: null, mining: [],
};
export const D = {
  ...A, id: 'shp-d', ref: 'NS/26-27/043', invoiceNumber: 'NS/26-27/043', invoiceDate: '10 Nov 2026', consignee: KOWLOON, terms: 'CIF Hong Kong, 45 days',
  originText: 'Botswana', stones: [
    { report: '2211459120', lab: 'GIA', shape: 'Round', carat: 0.9, color: 'G', clarity: 'VS1', rate: 6400, mm: '' },
    { report: '2211459121', lab: 'GIA', shape: 'Princess', carat: 0.74, color: 'F', clarity: 'VS2', rate: 4800, mm: '' },
  ],
  mismatchIndex: -1, totalCarats: 1.64, totalValue: 9312, mawb: '176-55501102', hawb: 'NLX61236650', flight: 'NL 330 / 12 Nov 2026', awbDate: '12 Nov 2026',
  route: 'Surat - Mumbai - Hong Kong', sbNumber: '4413360', sbDate: '11 Nov 2026', leoDate: '11 Nov 2026', portOfDischarge: 'Hong Kong', kp: 'AE-SAMPLE-0040510', mining: ['BW'],
};

const DOC_TITLES = {
  commercial_invoice: (s) => `Export invoice ${s.invoiceNumber}`, packing_list: (s) => `Packing list ${s.packingNumber}`,
  shipping_bill: (s) => `Shipping bill ${s.sbNumber} with Let Export Order`, air_waybill: (s) => `Air waybill: MAWB ${s.mawb}, HAWB ${s.hawb}`,
  supplier_invoice: () => `Rough invoice ${ROUGH.invoiceNumber} with KP certificate ${ROUGH.kp}`, factory_record: () => `Factory register, rough lot ${ROUGH.lot}`,
};

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const iso = (base, minutesAgo) => new Date(base - minutesAgo * 60000).toISOString();

/**
 * Makes every sample file and its record. Returns { files: { id: { name, mime, bytes } }, docs: { id: record } }.
 * base: the time the run starts (ms). The live shipment's papers arrive "now"; the others earlier.
 */
async function makeDocuments(base) {
  const files = {};
  const docs = {};
  async function add(id, { shipment, docType, name, made, source, minutesAgo, summary, confidence = 0.97, kind = 'pdf' }) {
    const sha = made.bytes.length ? await sha256Hex(made.bytes) : '';
    files[id] = { name, mime: made.mime, bytes: made.bytes };
    docs[id] = {
      id, workspaceId: HOUSE.id, fileName: name, mime: made.mime, kind, size: made.bytes.length, sha256: sha, fileKey: `docs/${id}/${name}`,
      source, pages: made.pages || 1, hasTextLayer: kind === 'pdf', docType, classifyConfidence: confidence, summary,
      fields: made.fields.map((f) => ({ ...f, agent: 'intake' })), lines: made.lines || [], declarations: [], shipmentId: shipment?.id || null,
      status: 'read', readBy: 'gpt-5.4-mini', readAt: iso(base, minutesAgo - 1), ocrUsed: kind === 'image', title: DOC_TITLES[docType]?.(shipment || A) || name,
      createdAt: iso(base, minutesAgo), updatedAt: iso(base, minutesAgo - 1),
    };
  }
  const chatSource = (at) => ({ kind: 'whatsapp', receivedAt: at, chatAuthor: 'Kiran (Nilgiri Star)' });
  const now = new Date(base).toISOString();
  // A: the live shipment (arrives in the run).
  await add('doc-a-inv', { shipment: A, docType: 'commercial_invoice', name: 'Invoice NS-26-27-041.pdf', made: invoicePdf(A), source: chatSource(now), minutesAgo: 0, summary: 'Export invoice for 6 natural polished diamonds to Rhine Facet BV, Antwerp.' });
  await add('doc-a-pl', { shipment: A, docType: 'packing_list', name: 'Packing list NS-26-27-041.pdf', made: packingListPdf(A), source: chatSource(now), minutesAgo: 0, summary: 'Six packets, one per stone, with report numbers and measurements.' });
  await add('doc-a-sb', { shipment: A, docType: 'shipping_bill', name: 'Shipping bill 4417203.pdf', made: shippingBillPdf(A), source: chatSource(now), minutesAgo: 0, summary: 'Export declaration with the Let Export Order of 04 Nov 2026.', confidence: 0.95 });
  await add('doc-a-awb', { shipment: A, docType: 'air_waybill', name: 'AWB 176-55501234.pdf', made: airWaybillPdf(A), source: chatSource(now), minutesAgo: 0, summary: 'Air waybill, Surat to Brussels via Mumbai, one valuable parcel.' });
  await add('doc-a-rough', { shipment: A, docType: 'supplier_invoice', name: 'Rough invoice KRT-2209.pdf', made: roughInvoicePdf(ROUGH), source: chatSource(now), minutesAgo: 0, summary: 'Rough lot R-118 bought from Karoo Rough Trading, with KP certificate and countries of mining.', confidence: 0.93 });
  await add('doc-a-factory', { shipment: A, docType: 'factory_record', name: 'Factory record R-118.jpg', made: await factoryPhoto(FACTORY), source: chatSource(now), minutesAgo: 0, summary: 'Phone photo of the factory register: rough lot R-118 cut into the 6 stones.', confidence: 0.88, kind: 'image' });
  // B: sent last week.
  const mail = (min) => ({ kind: 'email', receivedAt: iso(base, min), from: 'accounts@nilgiri-star.example.com' });
  await add('doc-b-inv', { shipment: B, docType: 'commercial_invoice', name: 'Invoice NS-26-27-038.pdf', made: invoicePdf(B), source: mail(26000), minutesAgo: 26000, summary: 'Export invoice for 3 natural diamonds to Hudson Row Jewels, New York.' });
  await add('doc-b-pl', { shipment: B, docType: 'packing_list', name: 'Packing list NS-26-27-038.pdf', made: packingListPdf(B), source: mail(26000), minutesAgo: 25999, summary: 'Three packets.' });
  await add('doc-b-sb', { shipment: B, docType: 'shipping_bill', name: 'Shipping bill 4402918.pdf', made: shippingBillPdf(B), source: mail(25000), minutesAgo: 25000, summary: 'Export declaration with the Let Export Order of 28 Oct 2026.' });
  await add('doc-b-awb', { shipment: B, docType: 'air_waybill', name: 'AWB 176-55500977.pdf', made: airWaybillPdf(B), source: mail(24000), minutesAgo: 24000, summary: 'Air waybill, Surat to New York.' });
  // C: collecting (lab-grown, Dubai).
  await add('doc-c-inv', { shipment: C, docType: 'commercial_invoice', name: 'Invoice NS-26-27-044.pdf', made: invoicePdf(C), source: { kind: 'upload', receivedAt: iso(base, 3000) }, minutesAgo: 3000, summary: 'Export invoice for 4 lab-grown diamonds to Gulf Lumen Trading, Dubai.' });
  // D: held for review (Hong Kong).
  const dAwb = airWaybillPdf({ ...D, consignee: { ...KOWLOON, name: 'Kowloon Lantern Gems Limited (SAMPLE)' } });
  await add('doc-d-inv', { shipment: D, docType: 'commercial_invoice', name: 'Invoice NS-26-27-043.pdf', made: invoicePdf(D), source: { kind: 'folder', receivedAt: iso(base, 5200) }, minutesAgo: 5200, summary: 'Export invoice for 2 natural diamonds to Kowloon Lantern Gems, Hong Kong.' });
  await add('doc-d-sb', { shipment: D, docType: 'shipping_bill', name: 'Shipping bill 4413360.pdf', made: shippingBillPdf(D), source: { kind: 'folder', receivedAt: iso(base, 5100) }, minutesAgo: 5100, summary: 'Export declaration with the Let Export Order of 11 Nov 2026.' });
  await add('doc-d-awb', { shipment: D, docType: 'air_waybill', name: 'AWB 176-55501102.pdf', made: dAwb, source: { kind: 'folder', receivedAt: iso(base, 5000) }, minutesAgo: 5000, summary: 'Air waybill, Surat to Hong Kong.' });
  return { files, docs };
}

function chatDocument(base) {
  const at = (day, time) => `2026-11-${day}T${time}:00`;
  const lotte = 'Lotte (Rhine Facet)';
  const kiran = 'Kiran (Nilgiri Star)';
  const messages = [
    { at: at('03', '10:14'), author: lotte, text: 'Morning! Can you send the papers for the six stones? Our broker needs them before the parcel lands.' },
    { at: at('03', '10:20'), author: kiran, text: 'Yes, sending the invoice and packing list now.' },
    { at: at('03', '10:21'), author: kiran, text: '', attachment: 'Invoice NS-26-27-041.pdf' },
    { at: at('03', '10:21'), author: kiran, text: '', attachment: 'Packing list NS-26-27-041.pdf' },
    { at: at('04', '18:02'), author: kiran, text: 'Shipping bill came through with the LEO.' },
    { at: at('04', '18:02'), author: kiran, text: '', attachment: 'Shipping bill 4417203.pdf' },
    { at: at('05', '09:40'), author: kiran, text: '', attachment: 'AWB 176-55501234.pdf' },
    { at: at('05', '09:41'), author: lotte, text: 'Great. We need the EU due diligence statement with it, since it is for Antwerp.' },
    { at: at('05', '09:43'), author: kiran, text: 'Our rough invoice and the factory photo are here too.' },
    { at: at('05', '09:43'), author: kiran, text: '', attachment: 'Rough invoice KRT-2209.pdf' },
    { at: at('05', '09:44'), author: kiran, text: '', attachment: 'Factory record R-118.jpg' },
  ];
  const text = messages.map((m) => `[${m.at}] ${m.author}: ${m.attachment ? `<attached: ${m.attachment}>` : m.text}`).join('\n');
  const bytes = new TextEncoder().encode(text);
  const now = new Date(base).toISOString();
  return {
    file: { name: '_chat.txt', mime: 'text/plain', bytes },
    doc: {
      id: 'doc-a-chat', workspaceId: HOUSE.id, fileName: 'WhatsApp Chat - Rhine Facet.zip', mime: 'application/zip', kind: 'chat', size: bytes.length, sha256: '',
      source: { kind: 'whatsapp', receivedAt: now }, pages: 0, hasTextLayer: false, docType: 'whatsapp_chat', classifyConfidence: 1,
      summary: '11 messages, 6 files, 1 request: the EU due diligence statement.', fields: [], lines: [], declarations: [], shipmentId: A.id, status: 'read',
      readBy: 'gpt-5.4-mini', readAt: now, content: { chat: { title: 'Rhine Facet', messages } },
      insights: { relevant: [{ text: messages[7].text, author: lotte, why: 'Asks for the EU statement' }] }, createdAt: now, updatedAt: now,
    },
  };
}

// ---------- records: shipments, stones, checks, questions, papers, parties ----------

function shipmentRecord(s, { status, base, minutesAgo, documentIds, summary, required }) {
  return {
    id: s.id, workspaceId: HOUSE.id, ref: s.ref, direction: 'export',
    exporter: { name: s.exporter.name, address: s.exporter.address, country: 'IN' }, consignee: { name: s.consignee.name, address: s.consignee.address, country: s.consignee.country },
    originCountry: 'IN', destinationCountry: s.consignee.country, route: null,
    invoiceNumber: s.invoiceNumber, invoiceDate: s.invoiceDate, shippingBillNumber: s.id === 'shp-c' ? null : s.sbNumber, leoDate: s.id === 'shp-c' ? null : s.leoDate,
    hawb: s.id === 'shp-c' ? null : s.hawb, mawb: s.id === 'shp-c' ? null : s.mawb, flight: s.id === 'shp-c' ? null : s.flight,
    goods: { nature: s.nature, form: 'polished', hsCodes: [s.hsCode], description: s.description },
    totals: { pieces: s.stones.length, carats: s.totalCarats, value: s.totalValue, currency: 'USD' },
    documentIds, status, required: required || [], summary: summary || null,
    createdAt: iso(base, minutesAgo), updatedAt: iso(base, Math.max(0, minutesAgo - 30)),
  };
}

function stoneRecords(s, docIds, base, minutesAgo) {
  return s.stones.map((st, i) => ({
    id: `stone-${s.id}-${i + 1}`, workspaceId: HOUSE.id, shipmentId: s.id, ref: `${s.ref} #${i + 1}`, reportNumber: st.report, lab: st.report ? st.lab : null,
    shape: st.shape, carat: st.carat, color: st.color, clarity: st.clarity, growth: s.nature,
    sources: docIds.map((docId) => ({ docId, kind: docId.includes('-inv') ? 'commercial_invoice' : docId.includes('-pl') ? 'packing_list' : docId.includes('factory') ? 'factory_record' : docId.includes('rough') ? 'supplier_invoice' : 'other', lineNo: i + 1 })),
    kp: s.kp ? { certificateNumber: s.kp, countries: s.mining } : null,
    labCheck: { status: 'not_checked' }, createdAt: iso(base, minutesAgo), updatedAt: iso(base, minutesAgo),
  }));
}

const check = (shipmentId, n, severity, title, detail, evidence = []) => ({ id: `chk-${shipmentId}-${n}`, workspaceId: HOUSE.id, shipmentId, code: `R${n}`, severity, title, detail, evidence, rule: `compliance.js R${n}` });

export function checksForA({ answered = false } = {}) {
  const s = A.id;
  return [
    check(s, 1, 'pass', 'Invoice and packing list agree', '6 stones, 4.85 ct on both.', [{ docId: 'doc-a-inv', key: 'goods.totalCarats' }, { docId: 'doc-a-pl', key: 'goods.totalCarats' }]),
    check(s, 2, 'pass', 'Value agrees with the shipping bill', 'USD 32,917.00 on the invoice and the shipping bill.', [{ docId: 'doc-a-inv', key: 'goods.totalValue' }, { docId: 'doc-a-sb', key: 'goods.totalValue' }]),
    check(s, 3, 'pass', 'Every stone of 0.50 ct and up has a grading report', '5 stones, GIA report numbers in the right format.', [{ docId: 'doc-a-pl' }]),
    check(s, 4, 'info', 'One stone is under 0.50 ct', 'The 0.38 ct stone needs no report and is outside the EU threshold.', [{ docId: 'doc-a-inv' }]),
    check(s, 5, 'pass', 'Natural diamonds: countries of mining on file', 'Botswana and Namibia, from KP certificate AE-SAMPLE-0042117.', [{ docId: 'doc-a-rough', key: 'kp.countriesOfMining' }]),
    check(s, 6, 'pass', 'No Russian origin anywhere in the chain', 'Mine, rough supplier, factory and route checked.', [{ docId: 'doc-a-rough', key: 'kp.countriesOfMining' }]),
    check(s, 7, 'pass', 'Rough traced to the polished stones', 'Factory register links rough lot R-118 (9.80 ct) to the 6 stones.', [{ docId: 'doc-a-factory', key: 'doc.number' }, { docId: 'doc-a-rough', key: 'kp.carats' }]),
    check(s, 8, 'pass', 'Let Export Order before the flight', 'LEO 04 Nov 2026, flight 05 Nov 2026.', [{ docId: 'doc-a-sb', key: 'leo.date' }, { docId: 'doc-a-awb', key: 'awb.flight' }]),
    check(s, 9, 'pass', 'Air waybill matches the parcel', 'Same consignee and gross weight (0.850 kg) as the shipping bill.', [{ docId: 'doc-a-awb', key: 'consignee.name' }, { docId: 'doc-a-sb', key: 'goods.grossWeight' }]),
    check(s, 10, 'pass', 'HS code fits the goods', '7102.39: worked natural diamonds, not mounted or set.', [{ docId: 'doc-a-inv', key: 'goods.hsCode' }]),
    check(s, 11, 'pass', 'Parties screened against the OFAC SDN list', 'No match for the exporter, consignee, rough supplier or carrier.', []),
    check(s, 12, 'pass', 'EU destination: a Due Diligence Statement is needed', 'Natural polished diamonds of 0.50 ct and up entering Belgium.', [{ docId: 'doc-a-inv', key: 'goods.destinationCountry' }]),
    check(s, 13, 'pass', 'Supplier warranty on file', 'System of Warranties declaration on the invoice and the rough invoice.', [{ docId: 'doc-a-inv', key: 'declaration.text' }]),
    answered
      ? check(s, 14, 'pass', 'Stone 4 carat confirmed', 'GIA 2211458734 is 0.71 ct, as on the invoice and the packing list. Confirmed by the house.', [{ docId: 'doc-a-pl', key: 'lab.carat' }, { docId: 'doc-a-factory', key: 'lab.carat' }])
      : check(s, 14, 'warn', 'Stone 4: the carat differs between papers', 'Packing list 0.71 ct, factory register 0.70 ct for GIA 2211458734.', [{ docId: 'doc-a-pl', key: 'lab.carat' }, { docId: 'doc-a-factory', key: 'lab.carat' }]),
  ];
}

export const QUESTION_A = {
  id: 'q-a-carat', workspaceId: HOUSE.id, shipmentId: A.id, kind: 'mismatch', key: 'lab.carat', docId: 'doc-a-factory',
  text: 'Stone 4 (GIA 2211458734): the packing list says 0.71 ct, the factory register 0.70 ct. Which is right?',
  options: ['0.71 ct, as invoiced', '0.70 ct, as in the factory register'], status: 'open',
};

const party = (id, name, country, roles, compared, base) => ({
  id, workspaceId: HOUSE.id, name, country, roles,
  screening: { status: 'clear', compared, best: null, listDate: '2026-11-15', screenedAt: new Date(base).toISOString() }, createdAt: new Date(base).toISOString(),
});

/** The shape a recorded run uses: { meta, workspace, files, steps, final }. Files here are in memory. */
export async function buildScriptedRun(base = Date.now()) {
  const { files, docs } = await makeDocuments(base);
  const chat = chatDocument(base);
  files['doc-a-chat'] = chat.file;
  const steps = [];
  let t = 0;
  const put = (name, payload, at = t) => steps.push({ t: at, kind: 'put', name, payload });
  const event = (name, payload, at = t) => steps.push({ t: at, kind: 'event', name, payload });
  let act = 0;
  const activity = (actor, action, detail, extra = {}, at = t) => {
    const entry = { id: `act-${String(++act).padStart(4, '0')}`, workspaceId: HOUSE.id, at: extra.when || new Date(base + at).toISOString(), actor, action, detail, shipmentId: extra.shipmentId ?? null, docId: extra.docId ?? null, paperId: extra.paperId ?? null };
    put('activity', entry, at);
    event('activity', entry, at);
  };
  const agent = (name) => ({ type: 'agent', name });
  const agentEvent = (agentId, action, message, extra = {}) => event('agent', { agent: agentId, action, message, ...extra });

  // ---- t = 0: what the house already had (B sent, C collecting, D held) ----
  const past = (min) => ({ when: iso(base, min) });
  for (const id of ['doc-b-inv', 'doc-b-pl', 'doc-b-sb', 'doc-b-awb', 'doc-c-inv', 'doc-d-inv', 'doc-d-sb', 'doc-d-awb']) put('documents', docs[id]);
  put('shipments', shipmentRecord(B, { status: 'sent', base, minutesAgo: 26000, documentIds: ['doc-b-inv', 'doc-b-pl', 'doc-b-sb', 'doc-b-awb'], summary: { passed: 12, total: 12 },
    required: [{ kind: 'us_cbp_certificate', reason: 'Natural diamonds of 0.5 ct and up entering the United States', signer: 'exporter', regime: 'US' }] }));
  put('shipments', shipmentRecord(C, { status: 'collecting', base, minutesAgo: 3000, documentIds: ['doc-c-inv'], summary: { passed: 3, total: 5 } }));
  put('shipments', shipmentRecord(D, { status: 'held_for_review', base, minutesAgo: 5200, documentIds: ['doc-d-inv', 'doc-d-sb', 'doc-d-awb'], summary: { passed: 10, total: 11 } }));
  for (const st of stoneRecords(B, ['doc-b-inv', 'doc-b-pl'], base, 25990)) put('stones', { ...st, labCheck: { status: 'match', checkedAt: iso(base, 25000) } });
  for (const st of stoneRecords(C, ['doc-c-inv'], base, 2990)) put('stones', st);
  for (const st of stoneRecords(D, ['doc-d-inv'], base, 5190)) put('stones', st);
  put('questions', { id: 'q-c-pl', workspaceId: HOUSE.id, shipmentId: C.id, kind: 'missing_document', docType: 'packing_list', text: 'Packing list for NS/26-27/044', status: 'open' });
  put('questions', { id: 'q-c-awb', workspaceId: HOUSE.id, shipmentId: C.id, kind: 'missing_document', docType: 'air_waybill', text: 'Air waybill for NS/26-27/044', status: 'open' });
  put('checks', check(D.id, 1, 'pass', 'Invoice and shipping bill agree', '2 stones, 1.64 ct, USD 9,312.00.', [{ docId: 'doc-d-inv', key: 'goods.totalValue' }]));
  put('checks', check(D.id, 2, 'warn', 'Consignee name differs on the air waybill', '"Kowloon Lantern Gems Ltd" on the invoice, "Kowloon Lantern Gems Limited" on the air waybill. Likely the same company.', [{ docId: 'doc-d-inv', key: 'consignee.name' }, { docId: 'doc-d-awb', key: 'consignee.name' }]));
  const paperB = { id: 'pap-b-exp', workspaceId: HOUSE.id, shipmentId: B.id, kind: 'export_pack', ref: 'JL-EXP-1029-01', version: 1, status: 'sent', fileKey: 'papers/pap-b-exp/JL-EXP-1029-01-v1.pdf', sha256: '', pages: 4, contents: [], signedBy: 'A. Mehta (sample)', signerTitle: 'Director', signedAt: iso(base, 23900), sentTo: 'docs@broker.example.com', sentAt: iso(base, 23880), deskEdits: 0, houseEdits: 0, builtAt: iso(base, 23950), createdAt: iso(base, 23950), updatedAt: iso(base, 23880) };
  const paperBcbp = { ...paperB, id: 'pap-b-cbp', kind: 'us_cbp_certificate', ref: 'JL-CBP-1029-01', pages: 1, fileKey: 'papers/pap-b-cbp/JL-CBP-1029-01-v1.pdf' };
  const paperD = { id: 'pap-d-exp', workspaceId: HOUSE.id, shipmentId: D.id, kind: 'export_pack', ref: 'JL-EXP-1113-01', version: 1, status: 'held_for_review', fileKey: 'papers/pap-d-exp/JL-EXP-1113-01-v1.pdf', sha256: '', pages: 4, contents: [], deskEdits: 0, houseEdits: 0, builtAt: iso(base, 3200), createdAt: iso(base, 3200), updatedAt: iso(base, 3200) };
  put('papers', paperB);
  put('papers', paperBcbp);
  put('papers', paperD);
  put('messages', { id: 'msg-d-1', workspaceId: HOUSE.id, at: iso(base, 3260), from: 'house', author: 'Kiran (sample)', text: 'Prepare the papers for my parcel NS/26-27/043', shipmentId: D.id });
  put('messages', { id: 'msg-d-2', workspaceId: HOUSE.id, at: iso(base, 3200), from: 'agents', text: 'Export pack JL-EXP-1113-01 v1: held for review. Jewel Labs checks it before you sign.', steps: ['Sending your request', 'Matching your documents', 'Sanctions check', 'Checking the documents', 'Building the export paper'], actions: [{ kind: 'paper', paperId: 'pap-d-exp', ref: 'JL-EXP-1113-01', status: 'held_for_review' }], shipmentId: D.id });
  put('messages', { id: 'msg-b-1', workspaceId: HOUSE.id, at: iso(base, 23870), from: 'desk', author: 'Jewel Labs desk', text: 'JL-EXP-1029-01 and the US self-certification are signed and went to your broker. Nothing else needed.', shipmentId: B.id });
  activity(agent('Paperwork'), 'built', 'Built the export pack JL-EXP-1029-01 v1 and the US CBP self-certification', { shipmentId: B.id, ...past(23950) });
  activity({ type: 'person', name: 'A. Mehta (sample)' }, 'signed', 'Signed Export pack JL-EXP-1029-01 v1', { shipmentId: B.id, ...past(23900) });
  activity({ type: 'person', name: 'A. Mehta (sample)' }, 'sent', 'Sent JL-EXP-1029-01 to docs@broker.example.com from the house mailbox', { shipmentId: B.id, ...past(23880) });
  activity(agent('Review'), 'missing', 'NS/26-27/044 still needs: Packing list, Air waybill', { shipmentId: C.id, ...past(2990) });
  activity(agent('Origin'), 'held', 'NS/26-27/043: 10 of 11 checks consistent. Consignee name differs on the air waybill; held for the desk.', { shipmentId: D.id, ...past(3210) });
  activity(agent('Paperwork'), 'built', 'Built Export pack JL-EXP-1113-01 v1 (held for review)', { shipmentId: D.id, ...past(3200) });

  // ---- the live run: a WhatsApp export arrives with the papers for NS/26-27/041 ----
  t = 900;
  agentEvent('retrieval', 'read', 'Opened WhatsApp Chat - Rhine Facet.zip: 6 documents inside, 1 WhatsApp chat');
  activity(agent('Retrieval'), 'received', 'WhatsApp Chat - Rhine Facet.zip from WhatsApp: 6 documents inside, 1 chat');
  t = 1500;
  const order = ['doc-a-inv', 'doc-a-pl', 'doc-a-sb', 'doc-a-awb', 'doc-a-rough', 'doc-a-factory'];
  for (const id of order) put('documents', { ...docs[id], status: 'new', fields: [], lines: [], shipmentId: null, readAt: null, summary: null });
  put('documents', { ...chat.doc, status: 'reading' });
  agentEvent('intake', 'start', 'Reading the WhatsApp chat', { docId: 'doc-a-chat' });
  t = 2600;
  put('documents', chat.doc);
  agentEvent('intake', 'read', 'WhatsApp Chat - Rhine Facet.zip: 11 messages, 6 files, 1 request', { docId: 'doc-a-chat' });
  activity(agent('Intake'), 'whatsapp', 'Read the WhatsApp chat: 11 messages, 6 files, 1 request (the EU due diligence statement)', { docId: 'doc-a-chat' });
  put('messages', { id: 'msg-a-req', workspaceId: HOUSE.id, at: new Date(base + t).toISOString(), from: 'house', kind: 'request', channel: 'WhatsApp chat', docId: 'doc-a-chat', author: 'Lotte (Rhine Facet)', text: 'We need the EU due diligence statement with it, since it is for Antwerp.', ref: null, status: 'open' });
  t = 3600;

  let shipmentCreated = false;
  const fieldGap = 650;
  for (const id of order) {
    const d = docs[id];
    put('documents', { ...d, status: 'reading', fields: [], lines: [], shipmentId: shipmentCreated ? A.id : null, readAt: null });
    agentEvent('intake', 'start', `Reading ${d.fileName}`, { docId: id });
    t += 700;
    agentEvent('intake', 'read', `${d.fileName}: ${d.title}`, { docId: id });
    t += 500;
    for (const f of d.fields) {
      const label = FIELD_LABEL_FOR[f.key] || f.key;
      agentEvent('intake', 'field', `${label}: ${f.value}`, { docId: id, page: f.page, key: f.key, label, value: f.key === 'declaration.text' ? 'System of Warranties' : f.value, box: f.box });
      t += fieldGap;
    }
    put('documents', { ...d, shipmentId: A.id, readAt: new Date(base + t).toISOString(), updatedAt: new Date(base + t).toISOString() });
    activity(agent('Intake'), 'read', `${d.fileName}: ${LABEL_FOR_TYPE[d.docType]}, ${d.fields.length} fields read${d.ocrUsed ? ' with OCR' : ''}`, { docId: id, shipmentId: A.id });
    if (!shipmentCreated) {
      shipmentCreated = true;
      put('shipments', shipmentRecord(A, { status: 'reading', base: base + t, minutesAgo: 0, documentIds: [id, 'doc-a-chat'] }));
    }
    agentEvent('records', 'done', `Filed ${d.fileName} under NS/26-27/041`, { shipmentId: A.id });
    activity(agent('Records'), 'filed', `${d.fileName} filed under NS/26-27/041`, { docId: id, shipmentId: A.id });
    t += 900;
  }

  // Records traces the stones; Sanctions screens the parties; Origin runs the rules; Review asks.
  const stonesA = stoneRecords(A, ['doc-a-inv', 'doc-a-pl', 'doc-a-factory', 'doc-a-rough'], base + t, 0);
  for (const st of stonesA) put('stones', st);
  agentEvent('records', 'done', 'Traced 6 stones: rough lot R-118 (KP AE-SAMPLE-0042117) to the factory register, the invoice and the packing list', { shipmentId: A.id });
  activity(agent('Records'), 'traced', 'Traced 6 stones from rough lot R-118 through the factory register to the invoice, packing list, shipping bill and air waybill', { shipmentId: A.id });
  put('shipments', { ...shipmentRecord(A, { status: 'reading', base: base + t, minutesAgo: 0, documentIds: [...order, 'doc-a-chat'] }) });
  t += 1400;
  const parties = [
    party('pty-1', EXPORTER.name, 'IN', ['Exporter'], 41, base + t), party('pty-2', RHINE.name, 'BE', ['Consignee'], 38, base + t),
    party('pty-3', KAROO.name, 'AE', ['Rough supplier'], 44, base + t), party('pty-4', CARRIER, 'IN', ['Carrier'], 29, base + t),
  ];
  for (const p of parties) {
    agentEvent('sanctions', 'screen', `${p.name}: no match on the OFAC SDN list (${p.screening.compared} similar names compared)`, { shipmentId: A.id });
    put('parties', p);
    t += 1100;
  }
  activity(agent('Sanctions'), 'screened', 'Screened 4 parties against the OFAC SDN list (19,565 entries, 15 Nov 2026): no match', { shipmentId: A.id });
  const checks = checksForA();
  for (const c of checks) {
    put('checks', c);
    if (c.severity !== 'pass') agentEvent('origin', 'check', `${c.title}: ${c.detail}`, { shipmentId: A.id });
    t += 160;
  }
  agentEvent('origin', 'done', '13 of 14 checks consistent. One carat differs between two papers.', { shipmentId: A.id });
  activity(agent('Origin'), 'checked', 'NS/26-27/041: 13 of 14 checks consistent. Stone 4 carat differs between the packing list and the factory register.', { shipmentId: A.id });
  t += 900;
  put('questions', { ...QUESTION_A, createdAt: new Date(base + t).toISOString() });
  agentEvent('review', 'question', QUESTION_A.text, { shipmentId: A.id });
  put('shipments', { ...shipmentRecord(A, { status: 'questions', base: base + t, minutesAgo: 0, documentIds: [...order, 'doc-a-chat'], summary: { passed: 13, total: 14 },
    required: [{ kind: 'eu_dds', reason: 'Natural polished diamonds of 0.50 ct and up entering the EU', signer: 'importer', regime: 'EU' }, { kind: 'export_pack', reason: 'The papers for customs and the carrier', signer: 'exporter', regime: 'IN' }] }) });
  activity(agent('Review'), 'question', `Asked the house: ${QUESTION_A.text}`, { shipmentId: A.id });
  event('notify', { title: 'One question on NS/26-27/041', body: 'Answer it on Home and the agents build the papers.', kind: 'question', shipmentId: A.id });
  agentEvent('review', 'done', 'Waiting for one answer from the house', { shipmentId: A.id });

  return {
    meta: { format: 1, title: 'Scripted run on the SAMPLE shipment NS/26-27/041', recorded: false, createdAt: new Date(base).toISOString(), durationMs: t },
    workspace: HOUSE,
    files, // id -> { name, mime, bytes } (a recorded run has id -> URL instead)
    steps,
    final: null, // the player works it out by applying every step
  };
}

const FIELD_LABEL_FOR = {
  'doc.number': 'Document number', 'doc.date': 'Date', 'exporter.name': 'Exporter', 'exporter.address': 'Exporter address',
  'consignee.name': 'Consignee', 'consignee.address': 'Consignee address', 'consignee.country': 'Consignee country', 'buyer.name': 'Buyer',
  'supplier.name': 'Supplier', 'supplier.country': 'Supplier country', 'carrier.name': 'Carrier', 'invoice.number': 'Invoice number',
  'invoice.date': 'Invoice date', 'payment.terms': 'Payment terms', 'shippingBill.number': 'Shipping bill number', 'shippingBill.date': 'Shipping bill date',
  'leo.date': 'Let Export Order', 'awb.hawb': 'House air waybill', 'awb.mawb': 'Master air waybill', 'awb.flight': 'Flight', 'awb.date': 'Air waybill date',
  'awb.route': 'Route', 'kp.certificateNumber': 'KP certificate', 'kp.exportingCountry': 'KP exporting country', 'kp.countriesOfMining': 'Countries of mining',
  'kp.carats': 'KP carats', 'kp.value': 'KP value', 'goods.description': 'Goods', 'goods.nature': 'Natural or lab-grown', 'goods.hsCode': 'HS code',
  'goods.totalPieces': 'Pieces', 'goods.totalCarats': 'Carats', 'goods.totalValue': 'Value', 'goods.currency': 'Currency', 'goods.countryOfOrigin': 'Country of origin',
  'goods.destinationCountry': 'Destination', 'goods.portOfLoading': 'Port of loading', 'goods.portOfDischarge': 'Port of discharge',
  'goods.grossWeight': 'Gross weight', 'goods.netWeight': 'Net weight', 'lab.carat': 'Carat', 'declaration.text': 'Declaration',
};
const LABEL_FOR_TYPE = {
  commercial_invoice: 'Commercial invoice', packing_list: 'Packing list', shipping_bill: 'Shipping bill', air_waybill: 'Air waybill',
  supplier_invoice: 'Supplier invoice', factory_record: 'Factory record',
};

/** The stone history the desktop app would build for a sample stone (records/history.js stages). */
export function sampleHistory(stone, { documents, papers }) {
  const events = [];
  const add = (kind, at, title, detail, docId, field) => events.push({ at, kind, title, detail, docId: docId || null, field: field || null });
  const has = (id) => documents.some((d) => d.id === id && d.status === 'read');
  const sid = stone.shipmentId;
  const ship = { 'shp-a': A, 'shp-b': B, 'shp-c': C, 'shp-d': D }[sid] || A;
  const idx = Number(String(stone.id).split('-').pop()) - 1;
  const raw = ship.stones[idx] || {};
  const dateOf = (text) => (text ? new Date(`${text} 12:00 UTC`).toISOString() : null);
  if (stone.growth === 'lab-grown') add('grown', null, 'Grown in a lab', `CVD growth, per ${stone.lab} report ${stone.reportNumber}.`, `doc-${sid.slice(4)}-inv`, 'goods.nature');
  else if (stone.kp) add('mined', null, 'Mined', `Countries of mining: ${stone.kp.countries.map((c) => ({ BW: 'Botswana', NA: 'Namibia', CA: 'Canada' }[c] || c)).join(' and ')}, per KP certificate ${stone.kp.certificateNumber}.`, sid === 'shp-a' && has('doc-a-rough') ? 'doc-a-rough' : null, 'kp.countriesOfMining');
  if (sid === 'shp-a' && has('doc-a-rough')) add('rough_purchased', dateOf(ROUGH.date), 'Rough purchased', `Rough bought from ${KAROO.name} (Dubai) on invoice ${ROUGH.invoiceNumber}, ${ROUGH.carats.toFixed(2)} ct in lot ${ROUGH.lot}.`, 'doc-a-rough', 'invoice.date');
  if (sid === 'shp-a' && has('doc-a-factory')) add('cut_and_polished', dateOf(FACTORY.date), 'Cut and polished', `Cut and polished from rough lot ${FACTORY.lot} at the house factory in Surat (line ${idx + 1} of the factory register).`, 'doc-a-factory', 'doc.date');
  if (stone.reportNumber) add('graded', null, 'Graded', `${stone.lab} report ${stone.reportNumber}: ${stone.carat.toFixed(2)} ct, ${stone.shape}, ${stone.color}, ${stone.clarity}. The report is listed on the invoice and packing list.`, `doc-${sid.slice(4)}-inv`, null);
  if (has(`doc-${sid.slice(4)}-inv`)) add('invoiced', dateOf(ship.invoiceDate), 'Invoiced', `Line ${idx + 1} of invoice ${ship.invoiceNumber} to ${ship.consignee.name}${raw.rate ? `, USD ${(raw.carat * raw.rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}.`, `doc-${sid.slice(4)}-inv`, 'invoice.number');
  if (has(`doc-${sid.slice(4)}-pl`)) add('packed', dateOf(ship.invoiceDate), 'Packed', `Packet P${String(idx + 1).padStart(2, '0')} of packing list ${ship.packingNumber}, sealed in one parcel.`, `doc-${sid.slice(4)}-pl`, 'doc.number');
  if (has(`doc-${sid.slice(4)}-sb`)) add('cleared_for_export', dateOf(ship.leoDate), 'Cleared for export', `Shipping bill ${ship.sbNumber}, Let Export Order ${ship.leoDate}.`, `doc-${sid.slice(4)}-sb`, 'leo.date');
  if (has(`doc-${sid.slice(4)}-awb`)) add('flown', dateOf(ship.awbDate), 'Flown', `${ship.flight.split(' / ')[0]}, ${ship.route}. MAWB ${ship.mawb}, HAWB ${ship.hawb}.`, `doc-${sid.slice(4)}-awb`, 'awb.flight');
  for (const p of papers.filter((x) => x.shipmentId === sid && x.kind !== 'export_pack')) {
    add('statement_drafted', p.builtAt || p.createdAt, 'Statement drafted', `${p.kind === 'eu_dds' ? 'EU Due Diligence Statement' : 'US CBP self-certification'} ${p.ref} v${p.version}.`, null, null);
    if (p.signedAt) add('statement_signed', p.signedAt, 'Statement signed', `Signed by ${p.signedBy}${p.signerTitle ? `, ${p.signerTitle}` : ''}. Locked with its SHA-256 fingerprint.`, null, null);
    if (p.sentAt) add('statement_sent', p.sentAt, 'Statement sent', `Sent to ${p.sentTo} from the house mailbox.`, null, null);
  }
  return events;
}
