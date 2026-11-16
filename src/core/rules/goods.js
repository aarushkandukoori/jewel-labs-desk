// What is in the parcel: natural or lab-grown, rough, polished or jewellery, and how big the stones are.
// compliance.js re-exports classifyGoods (that is the public contract); records uses it while grouping.
import { getField, getFieldValues, docLines, parseNumber, round } from './fields.js';
import { formatHsCode, hsInfo, natureFromText, formFromText, normalizeShape } from './formats.js';

export const HALF_CARAT = 0.5;

// The parcel's own papers. Rough-side papers (supplier invoice, KP certificate, factory record) describe the
// rough a stone was cut from, so they are left out when deciding what the parcel is.
export const PARCEL_DOC_TYPES = [
  'commercial_invoice', 'proforma_invoice', 'packing_list', 'shipping_bill', 'bill_of_entry', 'air_waybill',
  'insurance_certificate', 'customs_declaration', 'purchase_order', 'lab_report',
];

// Shapes only exist once a stone is cut, so a known shape is evidence of polished goods.
const POLISHED_SHAPES = ['Round', 'Oval', 'Pear', 'Princess', 'Cushion', 'Emerald', 'Marquise', 'Heart', 'Radiant',
  'Asscher', 'Baguette'];

/** Carat of one stone: a lot line of 3 pieces and 2.10 ct counts as 0.70 ct a stone. */
export function perStoneCarat(stone) {
  if (!stone || stone.carat === null || stone.carat === undefined) return null;
  const pieces = stone.pieces && stone.pieces > 1 ? stone.pieces : 1;
  return round(stone.carat / pieces, 3);
}

/** True for 0.50 ct and up (the EU and US thresholds). */
export function atOrAboveHalf(carat) {
  return carat !== null && carat !== undefined && carat >= HALF_CARAT - 1e-9;
}

/** 'natural' | 'lab-grown' | null for one document, from its nature field, HS code or description. */
export function documentNature(doc) {
  const fromField = natureFromText(getField(doc, 'goods.nature'));
  if (fromField) return fromField;
  for (const code of getFieldValues(doc, 'goods.hsCode')) {
    const info = hsInfo(code);
    if (info && info.nature !== 'unknown') return info.nature;
  }
  return natureFromText(getField(doc, 'goods.description'));
}

/**
 * Classify the goods from the papers and the matched stones.
 * Evidence is weighed in a fixed order and the first kind of evidence that says anything decides:
 * nature: stones (lab reports and lines), HS codes, "natural / lab-grown" fields, descriptions;
 * form: HS codes, "rough / polished" fields, stone shapes, descriptions.
 * When the deciding evidence points both ways the answer is 'mixed'.
 */
export function classifyGoods({ documents = [], stones = [] } = {}) {
  const hsCodes = unique(documents.flatMap((doc) => getFieldValues(doc, 'goods.hsCode')).map(formatHsCode).filter(Boolean));
  const hs = hsCodes.map(hsInfo).filter(Boolean);

  const nature = decide([
    stones.map((stone) => stone.growth),
    hs.map((info) => info.nature),
    documents.map((doc) => natureFromText(getField(doc, 'goods.nature'))),
    documents.flatMap((doc) => [getField(doc, 'goods.description'), ...docLines(doc).map((l) => l.description)]).map(natureFromText),
  ], ['natural', 'lab-grown']);

  const form = decideForm([
    hs.map((info) => info.form),
    documents.map((doc) => formFromText(getField(doc, 'goods.form'))),
    stones.map((stone) => (POLISHED_SHAPES.includes(normalizeShape(stone.shape)) || hasLabReport(stone) ? 'polished' : null)),
    documents.map((doc) => formFromText(getField(doc, 'goods.description'))),
  ]);

  const sizes = stoneSizes(stones, documents);
  const maxCarat = sizes.length ? round(Math.max(...sizes.map((s) => s.carat)), 3) : null;
  const stonesAtOrAboveHalf = sizes.filter((s) => atOrAboveHalf(s.carat)).reduce((sum, s) => sum + s.pieces, 0);

  return {
    nature,
    form,
    hsCodes,
    maxCarat,
    stonesAtOrAboveHalf,
    sizesKnown: sizes.length > 0,
    stoneCount: sizes.reduce((sum, s) => sum + s.pieces, 0),
    industrial: hs.length > 0 && hs.every((info) => info.industrial),
    unsorted: hs.some((info) => info.unsorted),
  };
}

// The first list with any answer decides. Both answers in that list means 'mixed'.
function decide(levels, answers) {
  for (const level of levels) {
    const found = unique(level.filter((value) => answers.includes(value)));
    if (found.length === 1) return found[0];
    if (found.length > 1) return 'mixed';
  }
  return 'unknown';
}

function decideForm(levels) {
  for (const level of levels) {
    const found = unique(level.filter((value) => ['rough', 'polished', 'jewelry'].includes(value)));
    if (found.includes('jewelry')) return 'jewelry'; // loose stones inside jewellery still ship as jewellery
    if (found.length === 1) return found[0];
    if (found.length > 1) return 'mixed';
  }
  return 'unknown';
}

function hasLabReport(stone) {
  return Array.isArray(stone.sources) && stone.sources.some((source) => source.kind === 'lab_report');
}

// Per-stone sizes from matched stones, or from list lines when no stones were matched yet.
function stoneSizes(stones, documents) {
  const fromStones = stones
    .map((stone) => ({ carat: perStoneCarat(stone), pieces: stone.pieces && stone.pieces > 1 ? stone.pieces : 1 }))
    .filter((size) => size.carat !== null);
  if (fromStones.length) return fromStones;

  const list = documents.find((doc) => doc.docType === 'packing_list' && docLines(doc).length)
    || documents.find((doc) => doc.docType === 'commercial_invoice' && docLines(doc).length);
  if (!list) return [];
  return docLines(list)
    .map((line) => {
      const pieces = parseNumber(line.pieces) || 1;
      const carat = parseNumber(line.carat);
      return { carat: carat === null ? null : round(carat / pieces, 3), pieces };
    })
    .filter((size) => size.carat !== null);
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}
