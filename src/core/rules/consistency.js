// Cross-paper checks used by compliance.js: Russia anywhere, totals, party names and dates.
// Each function returns plain "problems": { text, docIds, keys } so compliance.js can turn them into
// checks and one-line questions.
import {
  getField, getFieldValues, docLines, parseNumber, parseDate, parseCurrency, formatDate, formatCarat, formatMoney, round,
  namesMatch,
} from './fields.js';
import { airportCountry, countryListHasRussia, findRussiaWord } from './formats.js';
import { DOC_TYPE_LABELS, FIELD_LABELS } from '../types.js';

// How each paper is named inside a sentence.
const DOC_WORDS = {
  commercial_invoice: 'invoice', proforma_invoice: 'proforma invoice', packing_list: 'packing list',
  lab_report: 'grading report', kp_certificate: 'KP certificate', supplier_invoice: 'supplier invoice',
  shipping_bill: 'shipping bill', bill_of_entry: 'bill of entry', air_waybill: 'air waybill',
  insurance_certificate: 'insurance certificate', factory_record: 'factory record', whatsapp_chat: 'WhatsApp chat',
};

export function docWord(doc) {
  if (!doc) return 'paper';
  return DOC_WORDS[doc.docType] || (DOC_TYPE_LABELS[doc.docType] || 'paper').toLowerCase();
}

// ---------- Russia anywhere ----------

const COUNTRY_KEYS = ['kp.countriesOfMining', 'goods.countryOfOrigin', 'kp.exportingCountry', 'exporter.country',
  'consignee.country', 'buyer.country', 'supplier.country'];
const TEXT_KEYS = ['exporter.name', 'exporter.address', 'consignee.name', 'consignee.address', 'buyer.name', 'buyer.address',
  'supplier.name', 'supplier.address', 'goods.description'];
// Where the parcel was loaded, unloaded and flown through: goods that left or transited Russia are banned too
// (EC FAQ on diamonds, Question 2).
const PLACE_KEYS = ['goods.portOfLoading', 'goods.portOfDischarge', 'awb.route'];

/** True when a port or a route ("BOM - SVO - BRU", "Moscow (SVO)", "Mumbai via Moscow") passes through Russia. */
export function placeHasRussia(value) {
  const text = String(value || '').toUpperCase();
  if (text.split(/[^A-Z]+/).some((code) => airportCountry(code) === 'RU')) return true;
  return text.split(/-|>|\bVIA\b|\bTO\b/).some((part) => countryListHasRussia(part));
}

/**
 * Every place a paper or a stone points to Russia: [{ docId, key, value }].
 * Declarations are not read ("not of Russian origin" is the declaration itself), and insurance wording
 * is not read either, because policies list the territories they exclude.
 */
export function findRussia(docs, stones = []) {
  const hits = [];
  for (const doc of docs) {
    for (const key of COUNTRY_KEYS) {
      for (const value of getFieldValues(doc, key)) if (countryListHasRussia(value)) hits.push({ docId: doc.id, key, value });
    }
    if (doc.docType === 'insurance_certificate') continue;
    for (const key of TEXT_KEYS) {
      for (const value of getFieldValues(doc, key)) if (findRussiaWord(value)) hits.push({ docId: doc.id, key, value });
    }
    for (const key of PLACE_KEYS) {
      for (const value of getFieldValues(doc, key)) if (placeHasRussia(value)) hits.push({ docId: doc.id, key, value });
    }
    for (const line of docLines(doc)) {
      if (findRussiaWord(line.description)) hits.push({ docId: doc.id, key: 'line', value: line.description, lineNo: line.lineNo });
    }
  }
  for (const stone of stones) {
    if (!((stone.kp && stone.kp.countries) || []).includes('RU')) continue;
    const kpSource = (stone.sources || []).find((s) => s.kind === 'kp_certificate');
    const already = hits.some((hit) => kpSource && hit.docId === kpSource.docId);
    if (!already) hits.push({ docId: kpSource ? kpSource.docId : null, key: 'kp.countriesOfMining', value: 'Russia' });
  }
  return hits;
}

export function describeHit(hit, docsById) {
  const doc = docsById.get(hit.docId);
  const where = hit.key === 'line' ? `line ${hit.lineNo} of the ${docWord(doc)}` : `the ${docWord(doc)} (${(FIELD_LABELS[hit.key] || hit.key).toLowerCase()})`;
  return `"${hit.value}" on ${where}`;
}

// ---------- totals ----------

const CARAT_TOLERANCE = 0.01;
const VALUE_TOLERANCE = 0.005; // 0.5 %

function printedTotals(doc) {
  const value = parseNumber(getField(doc, 'goods.totalValue'));
  const insured = parseNumber(getField(doc, 'insurance.insuredValue'));
  return {
    pieces: parseNumber(getField(doc, 'goods.totalPieces')),
    carats: parseNumber(getField(doc, 'goods.totalCarats')),
    value: value !== null ? value : insured,
    insuredOnly: value === null && insured !== null,
    currency: parseCurrency(getField(doc, 'goods.currency')) || parseCurrency(getField(doc, 'goods.totalValue')),
  };
}

function lineSums(doc) {
  const lines = docLines(doc);
  if (!lines.length) return null;
  const amounts = lines.map((line) => parseNumber(line.amount)).filter((n) => n !== null);
  return {
    pieces: lines.reduce((sum, line) => sum + (parseNumber(line.pieces) || 1), 0),
    carats: round(lines.reduce((sum, line) => sum + (parseNumber(line.carat) || 0), 0), 3),
    value: amounts.length ? round(amounts.reduce((sum, n) => sum + n, 0), 2) : null,
  };
}

function valueDiffers(a, b) {
  if (a === null || b === null) return false;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && Math.abs(a - b) / base > VALUE_TOLERANCE;
}

/**
 * Lines against printed totals on each list, then the invoice against the packing list, shipping bill
 * and insurance: pieces equal, carats within 0.01 ct, value within 0.5 %.
 */
export function totalsProblems(docs, ref) {
  const problems = [];
  const lists = docs.filter((doc) => ['commercial_invoice', 'packing_list'].includes(doc.docType));

  for (const doc of lists) {
    const sums = lineSums(doc);
    const totals = printedTotals(doc);
    if (!sums) continue;
    const word = docWord(doc);
    if (totals.carats !== null && Math.abs(sums.carats - totals.carats) > CARAT_TOLERANCE + 1e-9) {
      problems.push({ text: `The ${word} lines for ${ref} add up to ${formatCarat(sums.carats)} ct but its total says ${formatCarat(totals.carats)} ct.`, docIds: [doc.id], keys: ['goods.totalCarats'] });
    }
    if (totals.pieces !== null && sums.pieces !== totals.pieces) {
      problems.push({ text: `The ${word} for ${ref} lists ${sums.pieces} stones but its total says ${totals.pieces}.`, docIds: [doc.id], keys: ['goods.totalPieces'] });
    }
    if (totals.value !== null && valueDiffers(sums.value, totals.value)) {
      problems.push({ text: `The ${word} lines for ${ref} add up to ${formatMoney(totals.currency, sums.value)} but its total says ${formatMoney(totals.currency, totals.value)}.`, docIds: [doc.id], keys: ['goods.totalValue'] });
    }
  }

  // Cross-paper: everything is compared with the invoice (or the packing list when there is no invoice).
  const reference = lists.find((doc) => doc.docType === 'commercial_invoice') || lists[0];
  if (!reference) return problems;
  const refTotals = withLineFallback(reference);
  const others = docs.filter((doc) => doc !== reference
    && ['commercial_invoice', 'packing_list', 'shipping_bill', 'insurance_certificate'].includes(doc.docType));

  for (const doc of others) {
    const totals = withLineFallback(doc);
    const a = `on the ${docWord(reference)}`;
    const b = `on the ${docWord(doc)}`;
    // Pieces only between the lists: shipping bills and insurance count packets, not stones.
    if (doc.docType === 'packing_list' || doc.docType === 'commercial_invoice') {
      if (refTotals.pieces !== null && totals.pieces !== null && refTotals.pieces !== totals.pieces) {
        problems.push({ text: `Stone count differs for ${ref}: ${refTotals.pieces} ${a}, ${totals.pieces} ${b}.`, docIds: [reference.id, doc.id], keys: ['goods.totalPieces'] });
      }
    }
    if (refTotals.carats !== null && totals.carats !== null && Math.abs(refTotals.carats - totals.carats) > CARAT_TOLERANCE + 1e-9) {
      problems.push({ text: `Carats differ for ${ref}: ${formatCarat(refTotals.carats)} ct ${a}, ${formatCarat(totals.carats)} ct ${b}.`, docIds: [reference.id, doc.id], keys: ['goods.totalCarats'] });
    }
    const sameCurrency = !refTotals.currency || !totals.currency || refTotals.currency === totals.currency;
    if (sameCurrency && refTotals.value !== null && totals.value !== null) {
      // Insured value may be higher than the invoice (cover plus a margin), never lower.
      const low = totals.insuredOnly ? totals.value < refTotals.value * (1 - VALUE_TOLERANCE) : valueDiffers(refTotals.value, totals.value);
      if (low) {
        problems.push({ text: `Value differs for ${ref}: ${formatMoney(refTotals.currency, refTotals.value)} ${a}, ${formatMoney(totals.currency || refTotals.currency, totals.value)} ${b}.`, docIds: [reference.id, doc.id], keys: ['goods.totalValue'] });
      }
    }
  }
  return problems;
}

function withLineFallback(doc) {
  const totals = printedTotals(doc);
  const sums = lineSums(doc);
  if (!sums) return totals;
  return {
    ...totals,
    pieces: totals.pieces !== null ? totals.pieces : sums.pieces,
    carats: totals.carats !== null ? totals.carats : sums.carats,
    value: totals.value !== null ? totals.value : sums.value,
  };
}

// ---------- party names ----------

const PARTY_DOC_TYPES = ['commercial_invoice', 'packing_list', 'shipping_bill', 'air_waybill', 'insurance_certificate'];
// An insurance certificate names the insured (often the exporter), not the consignee, so consignee names are
// compared only on the papers that name who receives the parcel.
const CONSIGNEE_DOC_TYPES = ['commercial_invoice', 'packing_list', 'shipping_bill', 'air_waybill'];

/**
 * Exporter names on the invoice, packing list, shipping bill, air waybill and insurance, and consignee names on all
 * of them but the insurance, should be the same company.
 */
export function partiesProblems(docs, ref) {
  const problems = [];
  const papers = docs.filter((doc) => PARTY_DOC_TYPES.includes(doc.docType))
    .sort((a, b) => PARTY_DOC_TYPES.indexOf(a.docType) - PARTY_DOC_TYPES.indexOf(b.docType));
  for (const [role, word] of [['exporter', 'Exporter'], ['consignee', 'Consignee']]) {
    const named = papers.filter((doc) => getField(doc, `${role}.name`) && (role !== 'consignee' || CONSIGNEE_DOC_TYPES.includes(doc.docType)));
    if (named.length < 2) continue;
    const reference = named[0];
    const name = getField(reference, `${role}.name`);
    for (const doc of named.slice(1)) {
      const other = getField(doc, `${role}.name`);
      if (namesMatch(name, other)) continue;
      problems.push({
        text: `${word} differs on ${ref}: the ${docWord(reference)} says ${name}, the ${docWord(doc)} says ${other}.`,
        docIds: [reference.id, doc.id],
        keys: [`${role}.name`],
      });
    }
  }
  return problems;
}

// ---------- dates ----------

function dateOf(docs, type, keys) {
  for (const doc of docs.filter((d) => d.docType === type)) {
    for (const key of keys) {
      const date = parseDate(getField(doc, key));
      if (date) return { date, doc, key };
    }
  }
  return null;
}

/** Invoice on or before the Let Export Order, LEO on or before the air waybill. */
export function datesProblems(docs, ref) {
  const problems = [];
  const invoice = dateOf(docs, 'commercial_invoice', ['invoice.date', 'doc.date']);
  const leo = dateOf(docs, 'shipping_bill', ['leo.date']);
  const awb = dateOf(docs, 'air_waybill', ['awb.date', 'doc.date']);
  const add = (text, a, b) => problems.push({ text, docIds: [a.doc.id, b.doc.id], keys: [a.key, b.key] });

  if (invoice && leo && leo.date < invoice.date) {
    add(`The Let Export Order for ${ref} (${formatDate(leo.date)}) is dated before the invoice (${formatDate(invoice.date)}). Check the dates.`, invoice, leo);
  }
  if (leo && awb && awb.date < leo.date) {
    add(`The air waybill for ${ref} is dated ${formatDate(awb.date)}, before the Let Export Order on ${formatDate(leo.date)}. Check the dates.`, leo, awb);
  }
  if (!leo && invoice && awb && awb.date < invoice.date) {
    add(`The air waybill for ${ref} is dated ${formatDate(awb.date)}, before the invoice on ${formatDate(invoice.date)}. Check the dates.`, invoice, awb);
  }
  return problems;
}

/** The date the parcel left: Let Export Order, else air waybill, else invoice. */
export function exportDate(docs) {
  const found = dateOf(docs, 'shipping_bill', ['leo.date']) || dateOf(docs, 'air_waybill', ['awb.date', 'doc.date'])
    || dateOf(docs, 'commercial_invoice', ['invoice.date', 'doc.date']);
  return found ? found.date : null;
}
