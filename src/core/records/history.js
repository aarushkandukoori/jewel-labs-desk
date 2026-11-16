// A stone's history: every step from the mine to the signed statement, each tied to the paper that proves it.
// Steps follow the stage order below. Within a stage, dated steps come first (oldest first) and steps
// whose date is unknown keep at = null and come after them.
import { getField, parseDate, parseNumber, parseCurrency, formatDate, formatCarat, formatMoney } from '../rules/fields.js';
import { countryName, normalizeCountry } from '../rules/formats.js';
import { PAPER_KIND_LABELS } from '../types.js';
import { shipmentDocuments } from './stones.js';

export const HISTORY_STAGES = [
  'mined', 'grown', 'rough_purchased', 'cut_and_polished', 'graded', 'invoiced', 'packed',
  'cleared_for_export', 'cleared_for_import', 'flown', 'statement_drafted', 'statement_signed', 'statement_sent',
];

/**
 * Build the timeline for one stone.
 * documents: every document of the workspace (or at least the shipment's and the stone's sources).
 * papers: the generated papers (packs and statements); only this shipment's are used.
 * @returns {Array<{at:string|null, kind:string, title:string, detail:string, docId:string|null, field:string|null}>}
 */
export function buildHistory({ stone, shipment, documents = [], papers = [] }) {
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const sources = (stone.sources || []).filter((source) => byId.has(source.docId));
  const sourcesOf = (kind) => sources.filter((source) => source.kind === kind);
  const shipmentDocs = shipmentDocuments(shipment, documents);
  const events = [];
  const add = (kind, at, title, detail, docId = null, field = null) => events.push({ at: at || null, kind, title, detail, docId, field });

  // Mine or lab.
  if (stone.growth === 'lab-grown') {
    const report = sourcesOf('lab_report')[0];
    const method = stone.growthMethod ? `${stone.growthMethod} growth` : 'Lab-grown';
    add('grown', null, 'Grown in a lab', `${method}${report ? `, per ${stone.lab || 'the lab'} report ${stone.reportNumber}` : ''}.`,
      report ? report.docId : null, 'lab.growthMethod');
  } else {
    const kpSource = sourcesOf('kp_certificate')[0];
    const kp = stone.kp || { certificateNumber: null, countries: [] };
    const countries = joinWords((kp.countries || []).map(countryName));
    let detail = 'Countries of mining are not on file yet.';
    if (countries && kp.certificateNumber) detail = `Countries of mining: ${countries}, per KP certificate ${kp.certificateNumber}.`;
    else if (countries) detail = `Countries of mining: ${countries}.`;
    else if (kp.certificateNumber) detail = `KP certificate ${kp.certificateNumber} is known, but its countries of mining are not on file.`;
    add('mined', null, 'Mined', detail, kpSource ? kpSource.docId : null, 'kp.countriesOfMining');
  }

  // Rough bought from the supplier.
  for (const source of sourcesOf('supplier_invoice')) {
    const doc = byId.get(source.docId);
    const supplier = getField(doc, 'supplier.name') || getField(doc, 'exporter.name') || 'the supplier';
    const printedCountry = getField(doc, 'supplier.country');
    const country = printedCountry ? countryName(normalizeCountry(printedCountry)) || printedCountry : null;
    const number = getField(doc, 'invoice.number') || getField(doc, 'doc.number');
    const carats = parseNumber(getField(doc, 'goods.totalCarats'));
    const detail = `Rough bought from ${supplier}${country ? `, ${country},` : ''}${number ? ` on invoice ${number}` : ''}`
      + `${carats !== null ? `, ${formatCarat(carats)} ct in the lot` : ''}.`;
    add('rough_purchased', dateOf(doc, ['invoice.date', 'doc.date']), 'Rough purchased', detail, doc.id, 'invoice.date');
  }

  // Cut and polished at the factory.
  for (const source of sourcesOf('factory_record')) {
    const doc = byId.get(source.docId);
    const lot = getField(doc, 'doc.number');
    const where = getField(doc, 'exporter.name') || getField(doc, 'supplier.name');
    const detail = `Cut and polished${lot ? ` from rough lot ${lot}` : ''}${where ? ` at ${where}` : ''}`
      + `${source.lineNo ? ` (line ${source.lineNo} of the factory record)` : ''}.`;
    add('cut_and_polished', dateOf(doc, ['doc.date']), 'Cut and polished', detail, doc.id, 'doc.date');
  }

  // Graded by the lab.
  const reports = sourcesOf('lab_report');
  for (const source of reports) {
    const doc = byId.get(source.docId);
    const grades = [source.carat !== null ? `${formatCarat(source.carat)} ct` : null, source.shape, source.color, source.clarity].filter(Boolean);
    const detail = `${source.lab || 'Lab'} report ${source.reportNumber || stone.reportNumber}${grades.length ? `: ${grades.join(', ')}` : ''}.`;
    add('graded', dateOf(doc, ['lab.reportDate', 'doc.date']), 'Graded', detail, doc.id, 'lab.reportDate');
  }
  if (!reports.length && stone.reportNumber) {
    const list = sources.find((source) => source.reportNumber);
    add('graded', null, 'Graded', `${stone.lab || 'Lab'} report ${stone.reportNumber} is listed on ${listWord(list)}. The report itself is not on file.`,
      list ? list.docId : null, null);
  }

  // Sold and packed.
  for (const source of [...sourcesOf('commercial_invoice'), ...sourcesOf('proforma_invoice')]) {
    const doc = byId.get(source.docId);
    const number = getField(doc, 'invoice.number') || getField(doc, 'doc.number');
    const buyer = getField(doc, 'consignee.name') || getField(doc, 'buyer.name');
    const currency = parseCurrency(getField(doc, 'goods.currency')) || parseCurrency(getField(doc, 'goods.totalValue'));
    const amount = source.amount !== null && source.amount !== undefined ? `, ${formatMoney(currency, source.amount)}` : '';
    const detail = `Line ${source.lineNo} of ${source.kind === 'proforma_invoice' ? 'proforma ' : ''}invoice ${number || shipment.ref}`
      + `${buyer ? ` to ${buyer}` : ''}${amount}.`;
    add('invoiced', dateOf(doc, ['invoice.date', 'doc.date']), 'Invoiced', detail, doc.id, 'invoice.date');
  }
  for (const source of sourcesOf('packing_list')) {
    const doc = byId.get(source.docId);
    add('packed', dateOf(doc, ['doc.date', 'invoice.date']), 'Packed', `Line ${source.lineNo} of the packing list for ${shipment.ref}.`, doc.id, 'doc.date');
  }

  // Customs and transport papers cover every stone in the parcel.
  for (const doc of shipmentDocs.filter((d) => d.docType === 'shipping_bill')) {
    const number = getField(doc, 'shippingBill.number') || getField(doc, 'doc.number');
    const leo = parseDate(getField(doc, 'leo.date'));
    const detail = `Shipping bill ${number || ''}${leo ? `, Let Export Order ${formatDate(leo)}` : ', no Let Export Order yet'}.`.replace(/ ,/, ',');
    add('cleared_for_export', leo || dateOf(doc, ['shippingBill.date', 'doc.date']), 'Cleared for export', detail, doc.id, leo ? 'leo.date' : 'shippingBill.date');
  }
  for (const doc of shipmentDocs.filter((d) => d.docType === 'bill_of_entry')) {
    const number = getField(doc, 'billOfEntry.number') || getField(doc, 'doc.number');
    add('cleared_for_import', dateOf(doc, ['billOfEntry.date', 'doc.date']), 'Cleared for import',
      `Bill of entry ${number || 'on file'}.`, doc.id, 'billOfEntry.date');
  }
  for (const doc of shipmentDocs.filter((d) => d.docType === 'air_waybill')) {
    const parts = [
      getField(doc, 'awb.hawb') ? `HAWB ${getField(doc, 'awb.hawb')}` : null,
      getField(doc, 'awb.mawb') ? `MAWB ${getField(doc, 'awb.mawb')}` : null,
      getField(doc, 'awb.flight') ? `flight ${getField(doc, 'awb.flight')}` : null,
      getField(doc, 'awb.route'),
    ].filter(Boolean);
    add('flown', dateOf(doc, ['awb.date', 'doc.date']), 'Flown', `Air waybill${parts.length ? ` ${parts.join(', ')}` : ''}.`, doc.id, 'awb.date');
  }

  // The statement and pack: drafted, signed, sent.
  for (const paper of papers.filter((p) => p.shipmentId === shipment.id && p.kind !== 'packing_list_draft')) {
    const label = (PAPER_KIND_LABELS[paper.kind] || 'Paper').replace(' (draft)', '');
    add('statement_drafted', paper.createdAt, `${label} drafted`, `${paper.ref}, version ${paper.version || 1}.`);
    if (paper.signedAt || paper.status === 'signed' || paper.status === 'sent') {
      add('statement_signed', paper.signedAt, `${label} signed`, `${paper.ref}${paper.signedBy ? ` signed by ${paper.signedBy}` : ' signed'}.`);
    }
    if (paper.sentAt || paper.status === 'sent') {
      add('statement_sent', paper.sentAt, `${label} sent`, `${paper.ref}${paper.sentTo ? ` sent to ${paper.sentTo}` : ' sent'}.`);
    }
  }

  return sortEvents(events);
}

/** Stage order first; inside a stage, known dates oldest first, unknown dates last. */
export function sortEvents(events) {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const stage = HISTORY_STAGES.indexOf(a.event.kind) - HISTORY_STAGES.indexOf(b.event.kind);
      if (stage !== 0) return stage;
      if (a.event.at && b.event.at && a.event.at !== b.event.at) return a.event.at < b.event.at ? -1 : 1;
      if (a.event.at && !b.event.at) return -1;
      if (!a.event.at && b.event.at) return 1;
      return a.index - b.index;
    })
    .map((item) => item.event);
}

function dateOf(doc, keys) {
  for (const key of keys) {
    const date = parseDate(getField(doc, key));
    if (date) return date;
  }
  return null;
}

function listWord(source) {
  if (!source) return 'a list';
  if (source.kind === 'packing_list') return 'the packing list';
  if (source.kind === 'factory_record') return 'the factory record';
  return 'the invoice';
}

function joinWords(words) {
  const list = words.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
