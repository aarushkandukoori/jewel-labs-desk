// Compares our stone record (from the papers) with what the lab's own site says about the report.
// Rules from the brief: carat within 0.005 ct, colour and clarity equal after normalization, shape a loose
// match, and natural vs lab-grown must agree. Only fields known on both sides are compared; the result
// lists which ones were, so "match" never hides that nothing could be checked.

const CARAT_TOLERANCE = 0.005;

/**
 * @param {{ reportNumber?, carat?, color?, clarity?, shape?, growth? }} stone
 * @param {object} parsed result of parseLabPage
 * @returns {{ status:'match'|'mismatch'|'not_found', diffs:Array<{field, ours, lab}>, compared:string[] }}
 */
export function compareLab(stone, parsed) {
  if (!parsed || !parsed.found) return { status: 'not_found', diffs: [], compared: [] };
  const ours = stone || {};
  const diffs = [];
  const compared = [];

  function check(field, oursValue, labValue, same) {
    if (isBlank(oursValue) || isBlank(labValue)) return;
    compared.push(field);
    if (!same(oursValue, labValue)) diffs.push({ field, ours: oursValue, lab: labValue });
  }

  check('reportNumber', ours.reportNumber, parsed.reportNumber, (a, b) => digitsOf(a) === digitsOf(b));
  check('carat', ours.carat, parsed.carat,
    (a, b) => Math.abs(Number(a) - Number(b)) <= CARAT_TOLERANCE + 1e-9); // 1e-9: floating point slack
  check('color', ours.color, parsed.color, (a, b) => normalizeColor(a) === normalizeColor(b));
  check('clarity', ours.clarity, parsed.clarity, (a, b) => normalizeClarity(a) === normalizeClarity(b));
  check('shape', ours.shape, parsed.shape, sameShape);
  check('growth', normalizeGrowth(ours.growth), parsed.growth, (a, b) => a === normalizeGrowth(b));

  return { status: diffs.length ? 'mismatch' : 'match', diffs, compared };
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

// "LG612345678" and "612345678" are the same report; so are "2141 438 171" and "2141438171".
function digitsOf(value) {
  return String(value).replace(/\D/g, '');
}

/** "f", "F colour", "F (colourless)" -> "F"; "Fancy  intense yellow" -> "FANCY INTENSE YELLOW". */
export function normalizeColor(value) {
  const text = String(value ?? '').toUpperCase().replace(/\(.*\)/g, ' ').replace(/\bCOLOU?R(LESS)?\b|\bGRADE\b/g, ' ')
    .replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
  const letter = text.match(/^[D-Z](?:-[D-Z])?$/);
  return letter ? letter[0] : text;
}

const CLARITY_SYNONYMS = {
  F: 'FL', FLAWLESS: 'FL', INTERNALLYFLAWLESS: 'IF', LC: 'IF', LOUPECLEAN: 'IF',
  P1: 'I1', PK1: 'I1', P2: 'I2', PK2: 'I2', P3: 'I3', PK3: 'I3',
};

/** "vs 1", "VS-1", "VS1 (very slightly included)" -> "VS1"; HRD's "LC" (loupe clean) -> "IF". */
export function normalizeClarity(value) {
  const text = String(value ?? '').toUpperCase().replace(/\(.*\)/g, '').replace(/[\s-]+/g, '');
  return CLARITY_SYNONYMS[text] || text;
}

// Order matters: the longer descriptions labs print come before the plain shape words they contain.
const SHAPE_RULES = [
  ['ASSCHER', /ASSCHER|SQUARE\s+EMERALD|CUT[\s-]*CORNERED\s+SQUARE\s+STEP/],
  ['RADIANT', /RADIANT|CUT[\s-]*CORNERED\s+(?:RECTANGULAR|SQUARE)\s+MODIFIED\s+BRILLIANT/],
  ['PRINCESS', /PRINCESS|SQUARE\s+MODIFIED\s+BRILLIANT/],
  ['CUSHION', /CUSHION/],
  ['EMERALD', /EMERALD|RECTANGULAR\s+STEP|\bSTEP\s+CUT\b/],
  ['OVAL', /OVAL/],
  ['PEAR', /PEAR/],
  ['MARQUISE', /MARQUISE/],
  ['HEART', /HEART/],
  ['TRIANGLE', /TRIANGULAR|TRIANGLE|TRILLIANT|TRILLION/],
  ['BAGUETTE', /BAGUETTE/],
  ['ROUND', /ROUND/],
];

// Short codes used on packing lists.
const SHAPE_CODES = {
  RBC: 'ROUND', RD: 'ROUND', BR: 'ROUND', PR: 'PRINCESS', CU: 'CUSHION', CMB: 'CUSHION', EM: 'EMERALD',
  OV: 'OVAL', PS: 'PEAR', MQ: 'MARQUISE', HS: 'HEART', HT: 'HEART', RAD: 'RADIANT',
};

/** "Round Brilliant", "RBC", "round" -> "ROUND"; "Square Modified Brilliant" -> "PRINCESS". */
export function shapeKey(value) {
  const text = String(value ?? '').toUpperCase().replace(/[^A-Z\s-]/g, ' ');
  for (const [key, pattern] of SHAPE_RULES) if (pattern.test(text)) return key;
  for (const word of text.split(/[\s-]+/)) if (SHAPE_CODES[word]) return SHAPE_CODES[word];
  return null;
}

// Loose: the same shape family, or, for shapes we do not know, the same first word.
function sameShape(a, b) {
  const keyA = shapeKey(a);
  const keyB = shapeKey(b);
  if (keyA && keyB) return keyA === keyB;
  const firstWord = (value) => String(value).trim().split(/\s+/)[0].toUpperCase();
  return firstWord(a) === firstWord(b);
}

/** 'natural' | 'lab-grown' | null from any wording ("LGD", "CVD", "Laboratory-Grown", "Natural"). */
export function normalizeGrowth(value) {
  const text = String(value ?? '').toUpperCase();
  const saysLabGrown = /\bLAB\b|LABORATORY|LABGROWN|\bLGD\b|\bCVD\b|SYNTHETIC|MAN[\s-]?MADE|\bCREATED\b|CULTURED|\bGROWN\b/
    .test(text);
  const saysNatural = /\bNATURAL\b|\bMINED\b/.test(text);
  // "HPHT treated natural" is a natural stone; "HPHT" on its own is a growth method.
  if (saysNatural && !saysLabGrown) return 'natural';
  if (saysLabGrown || /\bHPHT\b/.test(text)) return 'lab-grown';
  return null;
}
