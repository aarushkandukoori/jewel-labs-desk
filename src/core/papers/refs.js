// Paper references: JL-EXP-1115-01 = Jewel Labs, export pack, 15 November, first of the day.
import { parseDate } from './format.js';

export const REF_PREFIX = {
  export_pack: 'EXP',
  import_pack: 'IMP',
  eu_dds: 'DDS',
  us_cbp_certificate: 'CBP',
  g7_gf_declaration: 'G7',
  packing_list_draft: 'PKL',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Next free ref for this kind on this day. existingRefs are refs already used (strings, or paper objects
 * with a .ref). The number after the date counts up from the highest one already taken that day.
 */
export function nextRef(kind, date = new Date(), existingRefs = []) {
  const prefix = REF_PREFIX[kind];
  if (!prefix) throw new Error(`Unknown paper kind: ${kind}`);
  const day = parseDate(date) || new Date();
  const stem = `JL-${prefix}-${pad2(day.getMonth() + 1)}${pad2(day.getDate())}-`;
  let highest = 0;
  for (const item of existingRefs || []) {
    const ref = typeof item === 'string' ? item : item?.ref;
    if (typeof ref !== 'string' || !ref.startsWith(stem)) continue;
    const number = parseInt(ref.slice(stem.length), 10);
    if (Number.isFinite(number) && number > highest) highest = number;
  }
  return stem + pad2(highest + 1);
}
