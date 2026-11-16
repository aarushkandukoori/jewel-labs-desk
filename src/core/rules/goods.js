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

/**
 * A lot's size range as printed in its description: "sizes 0.30-0.70 ct" -> { min: 0.3, max: 0.7 },
 * "up to 0.29 ct" -> { min: null, max: 0.29 }, "melee" -> { min: null, max: null, melee: true } (the trade's word
 * for small stones, well under 0.50 ct). Null when the description gives no size (sieve sizes such as "+11-14"
 * are not carats and are left alone).
 */
export function lotSizeRange(text) {
  const upper = String(text || '').toUpperCase();
  if (/\bMELEE\b/.test(upper)) return { min: null, max: null, melee: true };
  const range = upper.match(/(\d*\.\d+|\d+)\s*(?:CTS?|CARATS?)?\s*(?:-|–|TO)\s*(\d*\.\d+|\d+)\s*(CTS?\b|CARATS?\b)?/);
  if (range && (range[3] || (range[1].includes('.') && range[2].includes('.')))) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (a <= b) return { min: a, max: b };
  }
  const upTo = upper.match(/\b(?:UP\s+TO|BELOW|UNDER|LESS\s+THAN|MAX(?:IMUM)?\.?)\s*(\d*\.\d+)\s*(?:CTS?|CARATS?)?/);
  if (upTo) return { min: null, max: Number(upTo[1]) };
  return null;
}

/**
 * Does a stone or a lot reach 0.50 ct? Each stone counts on its own (EC FAQ on diamonds, Questions 2 and 15;
 * CBP CSMS #61912001), so a lot's average is not enough to rule a lot out:
 * 'yes' a stone of 0.50 ct or more, or a lot whose average is (one of its stones is at least the average);
 * 'no' a smaller stone, or a lot whose printed size range stays under 0.50 ct;
 * 'maybe' a lot whose average is under 0.50 ct but whose papers give no range that rules out bigger stones;
 * null when the carat is not on file.
 */
export function reachesHalf(stone) {
  const average = perStoneCarat(stone);
  if (average === null) return null;
  if (atOrAboveHalf(average)) return 'yes';
  if (!(stone.pieces > 1)) return 'no';
  const range = stone.sizeRange || lotSizeRange(stone.description);
  if (range && range.melee) return 'no';
  return range && range.max !== null && !atOrAboveHalf(range.max) ? 'no' : 'maybe';
}

/** 'natural' | 'lab-grown' | null for one document, from its nature field, HS code or description. */
export function documentNature(doc) {
  return declaredNature(doc) || natureFromText(getField(doc, 'goods.description'));
}

/** 'natural' | 'lab-grown' | null from what a paper declares outright: its nature field or its HS code. */
export function declaredNature(doc) {
  const fromField = natureFromText(getField(doc, 'goods.nature'));
  if (fromField) return fromField;
  for (const code of getFieldValues(doc, 'goods.hsCode')) {
    const info = hsInfo(code);
    if (info && info.nature !== 'unknown') return info.nature;
  }
  return null;
}

/**
 * Classify the goods from the papers and the matched stones.
 * Evidence is weighed in a fixed order and the first kind of evidence that says anything decides:
 * nature: stones (lab reports and lines), HS codes, "natural / lab-grown" fields, descriptions;
 * form: HS codes, "rough / polished" fields, stone shapes, descriptions.
 * When the deciding evidence points both ways the answer is 'mixed'. Jewellery wins the form, and loose rough or
 * polished named next to it (HS 7102.39 beside 7113) are kept in `loose`: they need their own statements.
 * Sizes: `naturalSizes` counts the stones that are not lab-grown (the EU statement and the US certificate cover
 * natural diamonds only); the plain fields count every stone.
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

  const { form, loose } = decideForm([
    hs.map((info) => info.form),
    documents.map((doc) => formFromText(getField(doc, 'goods.form'))),
    stones.map((stone) => (POLISHED_SHAPES.includes(normalizeShape(stone.shape)) || hasLabReport(stone) ? 'polished' : null)),
    documents.map((doc) => formFromText(getField(doc, 'goods.description'))),
  ]);

  const sizes = stoneSizes(stones, documents);
  const all = sizeFacts(sizes);

  return {
    nature,
    form,
    loose,
    hsCodes,
    maxCarat: all.maxCarat,
    stonesAtOrAboveHalf: all.atOrAboveHalf,
    sizesKnown: all.sizesKnown,
    stoneCount: all.count,
    lotsMayReachHalf: all.maybe,
    sizeUnknown: all.unknown,
    naturalSizes: sizeFacts(sizes.filter((size) => size.natural)),
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

// Like decide, but jewellery wins: loose stones inside jewellery still ship as jewellery. Loose rough or polished
// at the deciding level (or a bare 7102/7104 heading, form unknown) are returned in `loose`.
function decideForm(levels) {
  for (const level of levels) {
    const found = unique(level.filter((value) => ['rough', 'polished', 'jewelry'].includes(value)));
    if (found.includes('jewelry')) {
      const loose = found.filter((value) => value !== 'jewelry');
      if (level.includes('unknown')) loose.push('unknown');
      return { form: 'jewelry', loose };
    }
    if (found.length === 1) return { form: found[0], loose: [] };
    if (found.length > 1) return { form: 'mixed', loose: [] };
  }
  return { form: 'unknown', loose: [] };
}

function hasLabReport(stone) {
  return Array.isArray(stone.sources) && stone.sources.some((source) => source.kind === 'lab_report');
}

// One entry per stone or lot: { carat (per stone), pieces, reach, natural, top (largest stone, when known) }.
// From the matched stones, or from list lines when no stone was matched yet.
function stoneSizes(stones, documents) {
  const entry = (stone, natural) => {
    const pieces = stone.pieces && stone.pieces > 1 ? stone.pieces : 1;
    const carat = perStoneCarat({ carat: stone.carat, pieces });
    const reach = reachesHalf({ ...stone, pieces });
    const range = pieces > 1 ? stone.sizeRange || lotSizeRange(stone.description) : null;
    return { carat, pieces, reach, natural, top: pieces > 1 && range && range.max !== null ? range.max : carat };
  };
  if (stones.length) return stones.map((stone) => entry(stone, stone.growth !== 'lab-grown'));

  const list = documents.find((doc) => doc.docType === 'packing_list' && docLines(doc).length)
    || documents.find((doc) => doc.docType === 'commercial_invoice' && docLines(doc).length);
  if (!list) return [];
  return docLines(list).map((line) => {
    const growth = natureFromText(line.growth) || natureFromText(line.description);
    return entry({ carat: parseNumber(line.carat), pieces: parseNumber(line.pieces), description: line.description }, growth !== 'lab-grown');
  });
}

/**
 * Counts for the 0.50 ct threshold: count (stones), atOrAboveHalf, maybe (stones in lots that may reach it),
 * unknown (stones with no carat), sizesKnown (some size is on file) and maxCarat (the largest stone of known size,
 * or the largest lot average).
 */
function sizeFacts(sizes) {
  const facts = { count: 0, atOrAboveHalf: 0, maybe: 0, unknown: 0, sizesKnown: false, maxCarat: null };
  const tops = [];
  for (const size of sizes) {
    facts.count += size.pieces;
    if (size.reach === null) {
      facts.unknown += size.pieces;
      continue;
    }
    facts.sizesKnown = true;
    if (size.reach === 'yes') facts.atOrAboveHalf += size.pieces;
    if (size.reach === 'maybe') facts.maybe += size.pieces;
    tops.push(size.top);
  }
  if (tops.length) facts.maxCarat = round(Math.max(...tops), 3);
  return facts;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}
