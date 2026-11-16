// Builds every SAMPLE file in memory: the papers, the photo and the scan, the WhatsApp zip, the email
// and the spreadsheets, then the answer key. generate.js writes the result to disk; the tests call
// buildSampleSet() directly to check that two runs give the same bytes.
import { buildInvoice, buildPurchaseOrder } from './invoice.js';
import { buildLabReport } from './lab.js';
import { buildKpCertificate, buildSupplierInvoice } from './rough.js';
import { buildShippingBill, buildAirWaybill } from './customs.js';
import { buildInsuranceCertificate } from './insurance.js';
import { buildPackingList, buildFactoryRecord } from './sheets.js';
import { buildChatZip, ZIP_NAME } from './chat.js';
import { buildEmail, EMAIL_FILE, PO_FILE } from './email.js';
import { phonePhoto, scannedPdf } from './images.js';
import { buildAnswers } from './answers.js';
import { SHIPMENTS, KP, SUPPLIER_INVOICE, FACTORY } from './facts.js';
import { paperDate } from './kit.js';

const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Returns { files, answers }.
 * files: [{ path, bytes }] with paths relative to samples/sample-shipment.
 * answers: the answer key object written to samples/answers.json.
 */
export async function buildSampleSet() {
  const A = SHIPMENTS.A;
  const B = SHIPMENTS.B;
  const C = SHIPMENTS.C;
  const report = (shipment, number, options) => buildLabReport(shipment.stones.find((s) => s.report === number), options);

  // 1. The papers as clean PDFs.
  const reportA = {};
  for (const stone of A.stones.filter((s) => s.report)) reportA[stone.report] = await buildLabReport(stone);
  const papers = {
    invoiceA: await buildInvoice('A'),
    invoiceB: await buildInvoice('B'),
    invoiceC: await buildInvoice('C'),
    purchaseOrder: await buildPurchaseOrder(),
    kp: await buildKpCertificate(),
    supplierInvoice: await buildSupplierInvoice(),
    shippingBillA: await buildShippingBill('A'),
    shippingBillB: await buildShippingBill('B'),
    airWaybillA: await buildAirWaybill('A'),
    airWaybillB: await buildAirWaybill('B'),
    airWaybillC: await buildAirWaybill('C'),
    insurance: await buildInsuranceCertificate(),
    reportB1: await report(B, '7392040011', { labGrown: true }),
    reportB2: await report(B, '7392040012', { labGrown: true }),
    reportC1: await report(C, '7391030001'),
    reportC2: await report(C, '7391030002'),
  };

  // 2. Papers that arrive as pictures: the emerald report as a phone photo, the insurance as a scan.
  const photo = await phonePhoto(reportA['7391020005'], { seed: 5 });
  const scan = await scannedPdf(papers.insurance, {
    seed: 11, title: `Scan of insurance certificate ${A.insurance.certificate}`, date: paperDate(A.insurance.date, '17:40:00'),
  });

  // 3. The WhatsApp export (everything Ravi sent; no packing list) and the buyer's email.
  const chat = await buildChatZip({
    invoice: { name: `Invoice ${A.fileRef}.pdf`, bytes: papers.invoiceA, pages: 1 },
    'report-7391020001': { name: '7391020001.pdf', bytes: reportA['7391020001'], pages: 1 },
    'report-7391020002': { name: '7391020002.pdf', bytes: reportA['7391020002'], pages: 1 },
    'report-7391020003': { name: '7391020003.pdf', bytes: reportA['7391020003'], pages: 1 },
    'report-7391020006': { name: '7391020006.pdf', bytes: reportA['7391020006'], pages: 1 },
    'photo-7391020005': { name: 'PHOTO-2026-11-10-11-52-18.jpg', bytes: photo },
    kp: { name: `KP ${KP.number}.pdf`, bytes: papers.kp, pages: 1 },
    'supplier-invoice': { name: `Supplier invoice ${SUPPLIER_INVOICE.number}.pdf`, bytes: papers.supplierInvoice, pages: 1 },
  });
  const email = buildEmail(papers.purchaseOrder);
  const inChat = (key) => chat.attachments.find((a) => a.key === key).name;

  // 4. Every document with its id in the answer key. `disk` is what gets written at `path`; papers
  //    inside the zip or the email have no `disk` of their own.
  const zipPath = `whatsapp/${ZIP_NAME}`;
  const emailPath = `email/${EMAIL_FILE}`;
  const layout = [
    { id: 'A-chat', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: '_chat.txt', kind: 'chat', mime: 'text/plain' },
    { id: 'A-invoice', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('invoice') },
    { id: 'A-report-7391020001', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('report-7391020001') },
    { id: 'A-report-7391020002', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('report-7391020002') },
    { id: 'A-report-7391020003', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('report-7391020003') },
    { id: 'A-report-7391020006', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('report-7391020006') },
    { id: 'A-report-7391020005-photo', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('photo-7391020005'), kind: 'image', mime: 'image/jpeg', textLayer: false },
    { id: 'A-kp', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('kp') },
    { id: 'A-supplier-invoice', shipment: 'A', channel: 'whatsapp', path: zipPath, inside: inChat('supplier-invoice') },
    { id: 'A-email', shipment: 'A', channel: 'email', path: emailPath, kind: 'email', mime: 'message/rfc822', disk: email },
    { id: 'A-purchase-order', shipment: 'A', channel: 'email', path: emailPath, inside: PO_FILE },
    { id: 'A-shipping-bill', shipment: 'A', channel: 'drop', path: `drop/Shipping bill ${A.shippingBill.number}.pdf`, disk: papers.shippingBillA },
    { id: 'A-air-waybill', shipment: 'A', channel: 'drop', path: `drop/AWB ${A.awb.hawb}.pdf`, disk: papers.airWaybillA },
    { id: 'A-insurance', shipment: 'A', channel: 'drop', path: `drop/Insurance certificate ${A.fileRef}.pdf`, kind: 'pdf', mime: PDF, textLayer: false, disk: scan.pdf },
    { id: 'A-factory-record', shipment: 'A', channel: 'drop', path: `drop/Factory record lot ${FACTORY.lot}.xlsx`, kind: 'sheet', mime: XLSX, disk: buildFactoryRecord() },
    { id: 'A-packing-list', shipment: 'A', channel: 'later', path: `later/Packing list ${A.fileRef}.xlsx`, kind: 'sheet', mime: XLSX, disk: buildPackingList() },
    { id: 'B-invoice', shipment: 'B', channel: 'drop', path: `drop/shipment-b/Invoice ${B.fileRef}.pdf`, disk: papers.invoiceB },
    { id: 'B-report-7392040011', shipment: 'B', channel: 'drop', path: 'drop/shipment-b/7392040011.pdf', disk: papers.reportB1 },
    { id: 'B-report-7392040012', shipment: 'B', channel: 'drop', path: 'drop/shipment-b/7392040012.pdf', disk: papers.reportB2 },
    { id: 'B-shipping-bill', shipment: 'B', channel: 'drop', path: `drop/shipment-b/Shipping bill ${B.shippingBill.number}.pdf`, disk: papers.shippingBillB },
    { id: 'B-air-waybill', shipment: 'B', channel: 'drop', path: `drop/shipment-b/AWB ${B.awb.hawb}.pdf`, disk: papers.airWaybillB },
    { id: 'C-invoice', shipment: 'C', channel: 'drop', path: `drop/shipment-c/Invoice ${C.fileRef}.pdf`, disk: papers.invoiceC },
    { id: 'C-report-7391030001', shipment: 'C', channel: 'drop', path: 'drop/shipment-c/7391030001.pdf', disk: papers.reportC1 },
    { id: 'C-report-7391030002', shipment: 'C', channel: 'drop', path: 'drop/shipment-c/7391030002.pdf', disk: papers.reportC2 },
    { id: 'C-air-waybill', shipment: 'C', channel: 'drop', path: `drop/shipment-c/AWB ${C.awb.hawb}.pdf`, disk: papers.airWaybillC },
  ];

  // Files on disk: the zip once, then the email and every dropped file.
  const files = [{ path: zipPath, bytes: chat.zip }];
  for (const entry of layout) {
    if (entry.disk) files.push({ path: entry.path, bytes: entry.disk });
  }

  const answers = buildAnswers({ layout: { files: layout.map(describe) }, chat });
  return { files, answers, chat };
}

/**
 * How the answer key describes one entry (without its bytes). Entries that say nothing else are
 * pdf-lib PDFs: one page with a text layer. Pages only apply to PDFs and pictures.
 */
function describe(entry) {
  const kind = entry.kind || 'pdf';
  const described = {
    id: entry.id,
    shipment: entry.shipment,
    channel: entry.channel,
    path: entry.path,
    inside: entry.inside,
    kind,
    mime: entry.mime || PDF,
    textLayer: kind === 'pdf' || kind === 'image' ? entry.textLayer ?? true : undefined,
    pages: kind === 'pdf' || kind === 'image' ? 1 : undefined,
  };
  return Object.fromEntries(Object.entries(described).filter(([, value]) => value !== undefined));
}
