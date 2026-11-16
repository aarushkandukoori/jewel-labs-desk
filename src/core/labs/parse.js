// Reads a grading lab's report-check page (its visible text) into plain fields.
// Labs lay the result out in a few ways, and we accept all of them:
//   "Carat Weight: 1.01 carat"           label and value on one line
//   "CARAT WEIGHT ........ 1.01 CARATS"   dot leaders, any case
//   "Carat Weight" / "Weight given in carats" / "1.01 carat"   value a few lines below, after a definition
// Values are only accepted when the whole line (or the rest of the label's line) looks like that kind of
// value, so a definition such as "a grade on the D-to-Z scale" is never read as colour "D".

const LOOK_AHEAD_LINES = 3;

const FIELDS = {
  reportNumber: {
    labels: [/^(?:(?:GIA|IGI|HRD|GCAL)\s+)?(?:report|certificate|cert\.?|record)\s*(?:number|no\b\.?|n[°º]\.?|#|id\b)/i,
      /^n[°º]/i],
    read: readReportNumber,
  },
  reportDate: { labels: [/^(?:date\s+of\s+issue|report\s+date|issue\s+date|date\s+issued|date)\b/i], read: readDate },
  shape: {
    labels: [/^shape\s*(?:and|&)\s*cutting\s*style\b/i, /^shape\s*(?:and|&)\s*cut\b/i, /^cutting\s*style\b/i,
      /^shape\b/i],
    read: readShape,
  },
  carat: { labels: [/^carat\s*weight\b/i, /^(?:carat|weight)\b/i], read: readCarat },
  color: { labels: [/^colou?r\s*grade\b/i, /^colou?r\b/i], read: readColor },
  clarity: { labels: [/^clarity\s*grade\b/i, /^clarity\b/i], read: readClarity },
};
const ALL_LABELS = Object.values(FIELDS).flatMap((field) => field.labels);

const LAB_GROWN = /\b(?:laboratory|lab)[\s-]*(?:grown|created)\b|\bLGD\b|\bman[\s-]?made\b|\bsynthetic\s+diamond\b|\bCVD\b|\bchemical\s+vapou?r\s+deposition\b|\bHPHT[\s-]+(?:grown|growth)\b/i;
const CVD = /\bCVD\b|\bchemical\s+vapou?r\s+deposition\b/i;
const HPHT = /\bHPHT\b|\bhigh[\s-]+pressure[\s,]+high[\s-]+temperature\b/i;
const NATURAL = /\bnatural\b/i;

const NOT_FOUND = new RegExp([
  String.raw`no\s+(?:results?|records?|reports?|certificates?|data|match(?:es)?)\s+(?:were\s+|was\s+)?found`,
  String.raw`\bnot\s+found\b`,
  String.raw`could\s*n[o']?t\s+(?:be\s+)?(?:find|found|locate)`,
  String.raw`can\s*n[o']?t\s+(?:be\s+)?(?:find|found|locate)`,
  String.raw`unable\s+to\s+(?:find|locate)`,
  String.raw`does\s*(?:n[o']?t|\s+not)\s+exist`,
  String.raw`invalid\s+(?:report|certificate|record)`,
  String.raw`no\s+(?:matching|such)\s+(?:report|record|certificate)`,
  String.raw`(?:report|certificate)\s+(?:number\s+)?(?:is\s+)?not\s+(?:valid|recogni[sz]ed)`,
  String.raw`please\s+(?:check|verify)\s+the\s+(?:report|certificate)\s+number`,
].join('|'), 'i');

// Bot checks some lab sites show before the result: the person has to solve them in the window.
const CHALLENGE = /verify\s+you\s+are\s+(?:a\s+)?human|just\s+a\s+moment|enable\s+javascript\s+and\s+cookies|i['’]?m\s+not\s+a\s+robot|\bcaptcha\b|checking\s+your\s+browser/i;

/**
 * @param {string} lab 'GIA' | 'IGI' | 'HRD' | 'GCAL' (kept on the result)
 * @param {string} pageText the page's visible text (innerText)
 * @returns {{ found:boolean, lab, reason?:'not_found'|'challenge'|'no_result', reportNumber?, reportDate?, carat?,
 *   color?, clarity?, shape?, growth?:'lab-grown'|'natural'|null, growthMethod?:'CVD'|'HPHT'|null }}
 */
export function parseLabPage(lab, pageText) {
  const text = String(pageText ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);

  const fields = {};
  for (const [key, field] of Object.entries(FIELDS)) fields[key] = findField(lines, field);

  const gradeCount = [fields.color, fields.clarity, fields.shape].filter(Boolean).length;
  const found = fields.carat !== null || gradeCount >= 2;
  if (!found) {
    const reason = NOT_FOUND.test(text) ? 'not_found' : CHALLENGE.test(text) ? 'challenge' : 'no_result';
    return { found: false, lab: lab || null, reason };
  }

  const labGrown = LAB_GROWN.test(text);
  return {
    found: true,
    lab: lab || null,
    reportNumber: fields.reportNumber,
    reportDate: fields.reportDate,
    carat: fields.carat,
    color: fields.color,
    clarity: fields.clarity,
    shape: fields.shape,
    growth: labGrown ? 'lab-grown' : NATURAL.test(text) ? 'natural' : null,
    // CVD first: CVD stones are often HPHT treated after growth, and the report then names both.
    growthMethod: !labGrown ? null : CVD.test(text) ? 'CVD' : HPHT.test(text) ? 'HPHT' : null,
  };
}

// ---------- finding a labelled value ----------

function findField(lines, field) {
  for (let i = 0; i < lines.length; i++) {
    const rest = textAfterLabel(lines[i], field.labels);
    if (rest === null) continue;
    if (rest) {
      const value = field.read(rest);
      if (value !== null) return value;
    }
    // The value may sit a few lines below, after a short definition. Stop at the next label.
    for (let k = 1; k <= LOOK_AHEAD_LINES && i + k < lines.length; k++) {
      const value = field.read(lines[i + k]);
      if (value !== null) return value;
      if (textAfterLabel(lines[i + k], ALL_LABELS) !== null) break;
    }
  }
  return null;
}

/** The text after a label at the start of the line (without ":", dots or dashes), or null when no label. */
function textAfterLabel(line, labels) {
  for (const label of labels) {
    const match = line.match(label);
    // Separators: colon, dot leaders, dashes (also the long \u2013 and \u2014), ellipsis, middle dot, bar.
    if (match) return line.slice(match[0].length).replace(/^[\s:.\-\u2013\u2014\u2026\u00b7|=]+/, '');
  }
  return null;
}

// ---------- reading one kind of value ----------

function readReportNumber(text) {
  const withoutLab = text.replace(/^(?:GIA|IGI|HRD(?:\s+Antwerp)?|GCAL)\s+/i, ''); // "GCAL LG342830016"
  const match = withoutLab.match(/^(?:N[°º]|No\.?)?\s*([A-Z]{0,4}[\s-]?\d{6,13})$/i);
  return match ? match[1].replace(/[\s-]/g, '').toUpperCase() : null;
}

function readDate(text) {
  const monthName = /^(?:[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,8}\.?,?\s+\d{4})$/;
  const numeric = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/;
  return monthName.test(text) || numeric.test(text) ? text : null;
}

function readCarat(text) {
  const match = text.match(/^(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:carats?|cts?\.?|ct\.?)?$/i);
  if (!match) return null;
  const carat = Number(match[1].replace(',', '.'));
  return carat > 0 && carat < 1000 ? carat : null;
}

function readColor(text) {
  // D to Z, or a range like "W-X", optionally with a description: "F (colourless)".
  const letter = text.match(/^([D-Z](?:\s*-\s*[D-Z])?)(?:\s*\(.*\)|\s+colou?r(?:less)?)?$/i);
  if (letter) return letter[1].replace(/\s+/g, '').toUpperCase();
  // Fancy colours: "Fancy Intense Yellow", "Faint Pink", "Very Light Blue".
  const fancy = text.match(/^((?:fancy|faint|very\s+light|light)\b[A-Za-z\s-]{2,40})$/i);
  return fancy ? fancy[1].replace(/\s+/g, ' ').trim() : null;
}

function readClarity(text) {
  const match = text.match(/^(FL|IF|VVS\s*-?\s*[12]|VS\s*-?\s*[12]|SI\s*-?\s*[123]|I\s*-?\s*[123]|P\s*-?\s*[123]|LC|FLAWLESS|INTERNALLY\s+FLAWLESS|LOUPE[\s-]*CLEAN)(?:\s*\(.*\))?$/i);
  return match ? match[1].replace(/[\s-]+/g, '').toUpperCase() : null;
}

const SHAPE_WORDS = /\b(?:round|princess|cushion|oval|emerald|pear|marquise|heart|radiant|asscher|baguette|trilliant|triangular|triangle|square|rectangular|octagonal|step|brilliant|briolette|rose\s+cut|old\s+(?:mine|european))\b/i;

function readShape(text) {
  if (text.length > 60 || /\d/.test(text) || !SHAPE_WORDS.test(text)) return null;
  return text.replace(/\s+/g, ' ').trim();
}
