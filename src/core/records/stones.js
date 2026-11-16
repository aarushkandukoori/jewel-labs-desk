// Stone matching: one record per stone (or lot) in a shipment, tied to every paper that mentions it.
// Grading reports, packing list lines and invoice lines are joined on the report number; lines without
// a report number join on carat + shape + colour + clarity. The rough side (factory record, supplier
// invoice, KP certificate) is then attached so each stone carries its countries of mining.
import { getField, docLines, parseNumber, normalizeRef, round, shortHash, formatCarat } from '../rules/fields.js';
import {
  normalizeShape, normalizeColor, normalizeClarity, normalizeLab, natureFromText, growthMethodFromText,
  labFromReportNumber, cleanReportNumber, splitCountries,
} from '../rules/formats.js';
import { documentNature, perStoneCarat, atOrAboveHalf, lotSizeRange } from '../rules/goods.js';

// Lists are read in this order; the packing list is the stone-by-stone list customs reads.
const LIST_TYPES = ['packing_list', 'commercial_invoice', 'proforma_invoice'];
// When sources disagree, the stone keeps the value from the most trusted one.
const TRUST_ORDER = ['lab_report', 'packing_list', 'commercial_invoice', 'proforma_invoice', 'factory_record'];
const CARAT_TOLERANCE = 0.005;

const KIND_WORDS = {
  lab_report: 'the lab report',
  packing_list: 'the packing list',
  commercial_invoice: 'the invoice',
  proforma_invoice: 'the proforma invoice',
  factory_record: 'the factory record',
};

/**
 * Build the stones of one shipment.
 * Pass all documents of the workspace: the shipment's own papers are picked by shipment.documentIds,
 * and the rough-side papers (factory records, supplier invoices, KP certificates) are found by report
 * number and certificate number even when they were filed under another shipment.
 * @returns {{ stones: object[], issues: Array<{code:string, detail:string, ref:string, docIds:string[]}> }}
 */
export function matchStones({ shipment, documents = [] }) {
  const own = shipmentDocuments(shipment, documents);
  const drafts = [];

  // 1. Grading reports on file.
  for (const doc of own.filter((d) => d.docType === 'lab_report')) {
    addReading(drafts, readLabReport(doc));
  }

  // 2. Lines of the packing list and invoices.
  for (const type of LIST_TYPES) {
    for (const doc of own.filter((d) => d.docType === type)) {
      const docNature = documentNature(doc);
      docLines(doc).forEach((line, index) => addReading(drafts, readLine(doc, line, index, docNature)));
    }
  }

  // 3. The rough side: where each stone came from.
  for (const draft of drafts) attachRoughSide(draft, own, documents);

  const stones = drafts.map((draft, index) => finishStone(draft, index, shipment));
  return { stones, issues: findStoneIssues({ stones, documents, shipment }) };
}

/**
 * The shipment's own papers: listed in shipment.documentIds or filed under the shipment. A packing list the agents
 * drafted stops counting once the house's own packing list is on file (it stays on record, but the real one rules),
 * and a grading report the house said is not part of the shipment does not count at all.
 */
export function shipmentDocuments(shipment, documents) {
  const ids = new Set(shipment.documentIds || []);
  const own = documents.filter((doc) => ids.has(doc.id) || (doc.shipmentId && doc.shipmentId === shipment.id));
  return withoutReplacedDrafts(own).filter((doc) => !leftOutByHouse(doc, shipment));
}

/**
 * A grading report on file that no list mentions is asked about ("Is it part of ...?"). The answer is kept under
 * 'stone.<report>.onShipment': "No" leaves the report out of the stones, the statement and the pack.
 */
export function onShipmentAnswer(shipment, ref) {
  const said = shipmentAnswer(shipment, stoneAnswerKey(ref, 'onShipment'));
  return said === null ? null : said.replace(/[.!]+$/, '').trim().toLowerCase();
}

function leftOutByHouse(doc, shipment) {
  if (doc.docType !== 'lab_report' || !shipment?.answers) return false;
  const number = cleanReportNumber(getField(doc, 'lab.reportNumber') || getField(doc, 'doc.number'));
  return Boolean(number) && onShipmentAnswer(shipment, number) === 'no';
}

/** Leaves out packing list drafts made by the agents when a packing list from the house is among the papers. */
export function withoutReplacedDrafts(docs) {
  const realList = docs.some((doc) => doc.docType === 'packing_list' && !isAgentDraft(doc));
  return realList ? docs.filter((doc) => !isAgentDraft(doc)) : docs;
}

/** A packing list the agents drafted (from a chat, an email or the invoice lines). */
export function isAgentDraft(doc) {
  return Boolean(doc && doc.docType === 'packing_list' && doc.source && doc.source.kind === 'generated');
}

/**
 * An agents' draft no person has checked yet. It is only a draft: it does not count as the packing list on file and
 * does not go in the envelope. A person checks it by answering the rules' question, which sets doc.checkedBy.
 */
export function isUncheckedDraft(doc) {
  return isAgentDraft(doc) && !getField(doc, 'doc.checkedBy');
}

// ---------- readings: what one paper says about one stone ----------

function readLabReport(doc) {
  const reportNumber = getField(doc, 'lab.reportNumber') || getField(doc, 'doc.number');
  const methodText = getField(doc, 'lab.growthMethod');
  const growthMethod = growthMethodFromText(methodText);
  const growth = natureFromText(methodText) || (growthMethod ? 'lab-grown' : null)
    || natureFromText(getField(doc, 'goods.nature')) || (labFromReportNumber(reportNumber) ? 'lab-grown' : null)
    || natureFromText((doc.declarations || []).join(' '));
  return {
    docId: doc.id,
    kind: 'lab_report',
    lineNo: null,
    sha256: doc.sha256 || null,
    reportNumber,
    lab: normalizeLab(getField(doc, 'lab.name')) || labFromReportNumber(reportNumber),
    shape: normalizeShape(getField(doc, 'lab.shape')),
    carat: parseNumber(getField(doc, 'lab.carat')),
    color: normalizeColor(getField(doc, 'lab.color')),
    clarity: normalizeClarity(getField(doc, 'lab.clarity')),
    growth,
    growthMethod,
    pieces: 1,
    sizeRange: null,
    amount: null,
  };
}

function readLine(doc, line, index, docNature) {
  const reportNumber = line.reportNumber ? String(line.reportNumber).trim() : null;
  const growthMethod = growthMethodFromText(line.growth) || growthMethodFromText(line.description);
  const growth = natureFromText(line.growth) || natureFromText(line.description) || (growthMethod ? 'lab-grown' : null)
    || (labFromReportNumber(reportNumber) ? 'lab-grown' : null) || docNature || null;
  const pieces = parseNumber(line.pieces);
  return {
    docId: doc.id,
    kind: doc.docType,
    lineNo: line.lineNo ?? index + 1,
    reportNumber: reportNumber || null,
    lab: normalizeLab(line.lab) || labFromReportNumber(reportNumber),
    shape: normalizeShape(line.shape),
    carat: parseNumber(line.carat),
    color: normalizeColor(line.color),
    clarity: normalizeClarity(line.clarity),
    growth,
    growthMethod,
    pieces: pieces && pieces > 0 ? pieces : 1,
    // A lot's printed size range ("0.30-0.70 ct") says whether stones of 0.50 ct and up may be in it.
    sizeRange: pieces > 1 ? lotSizeRange(line.description) : null,
    amount: parseNumber(line.amount),
  };
}

// Put a reading on the stone it belongs to, or start a new stone.
function addReading(drafts, reading) {
  const key = reportKey(reading.reportNumber);
  if (key) {
    const found = drafts.find((draft) => draft.key === key);
    if (found) found.readings.push(reading);
    else drafts.push({ key, readings: [reading], kp: null });
    return;
  }
  // No report number: the same stone on another paper, matched on its grades and weight.
  const match = drafts.find((draft) => !draft.readings.some((r) => r.docId === reading.docId) && sameStone(draft, reading));
  if (match) match.readings.push(reading);
  else drafts.push({ key: `S:${reading.docId}:${reading.lineNo}`, readings: [reading], kp: null });
}

function reportKey(reportNumber) {
  const clean = cleanReportNumber(reportNumber);
  return clean.length >= 5 ? `R:${clean}` : null;
}

// Carat within 0.005 ct and no grade that disagrees.
function sameStone(draft, reading) {
  if (reading.carat === null) return false;
  return draft.readings.some((other) => {
    if (other.carat === null || Math.abs(other.carat - reading.carat) > CARAT_TOLERANCE + 1e-9) return false;
    if ((other.pieces || 1) !== (reading.pieces || 1)) return false;
    for (const field of ['shape', 'color', 'clarity']) {
      if (other[field] && reading[field] && other[field] !== reading[field]) return false;
    }
    return true;
  });
}

// ---------- the rough side ----------

function attachRoughSide(draft, own, all) {
  const key = draft.key.startsWith('R:') ? draft.key.slice(2) : null;

  // 1. Factory records that list this stone by report number. A factory record filed with the shipment
  //    that lists no report numbers at all (only rough lots) covers the whole parcel.
  const factories = [];
  for (const doc of all.filter((d) => d.docType === 'factory_record')) {
    const lines = docLines(doc);
    const index = key ? lines.findIndex((line) => cleanReportNumber(line.reportNumber) === key) : -1;
    if (index >= 0) {
      draft.readings.push(readLine(doc, lines[index], index, null));
      factories.push(doc);
    } else if (own.includes(doc) && !lines.some((line) => cleanReportNumber(line.reportNumber))) {
      draft.readings.push(emptyReading(doc));
      factories.push(doc);
    }
  }

  const isLabGrown = draft.readings.some((r) => r.growth === 'lab-grown') && !draft.readings.some((r) => r.growth === 'natural');
  if (isLabGrown) return; // the Kimberley Process covers natural rough only

  // 2. The supplier invoice of the rough: named by the factory record (invoice or KP number), else the one
  //    filed with the shipment.
  const factoryKp = factories.map((doc) => getField(doc, 'kp.certificateNumber')).filter(Boolean);
  let invoices = factories.flatMap((doc) => findByNumber(all, 'supplier_invoice', ['invoice.number', 'doc.number'], getField(doc, 'invoice.number')));
  invoices.push(...factoryKp.flatMap((number) => findByNumber(all, 'supplier_invoice', ['kp.certificateNumber'], number)));
  if (!invoices.length) invoices = own.filter((d) => d.docType === 'supplier_invoice');
  invoices = [...new Set(invoices)];

  // 3. The KP certificate: by the numbers the factory record and supplier invoice print, else the one filed
  //    with the shipment.
  const kpNumbers = [...factoryKp, ...invoices.map((doc) => getField(doc, 'kp.certificateNumber')).filter(Boolean)];
  let kpDocs = kpNumbers.flatMap((number) => findByNumber(all, 'kp_certificate', ['kp.certificateNumber', 'doc.number'], number));
  if (!kpDocs.length) kpDocs = own.filter((d) => d.docType === 'kp_certificate');
  kpDocs = [...new Set(kpDocs)];

  for (const doc of [...invoices, ...kpDocs]) draft.readings.push(emptyReading(doc));

  const certificateNumber = kpDocs.length
    ? getField(kpDocs[0], 'kp.certificateNumber') || getField(kpDocs[0], 'doc.number')
    : kpNumbers[0] || null;
  // Mining countries from the KP certificate; when it is not on file, as printed on the factory record or invoice.
  let countries = kpDocs.flatMap((doc) => splitCountries(getField(doc, 'kp.countriesOfMining')));
  if (!countries.length) {
    countries = [...factories, ...invoices].flatMap((doc) => splitCountries(getField(doc, 'kp.countriesOfMining')));
  }
  draft.kp = { certificateNumber, countries: [...new Set(countries)] };
}

function findByNumber(docs, docType, keys, number) {
  const wanted = normalizeRef(number);
  if (!wanted) return [];
  return docs.filter((doc) => doc.docType === docType && keys.some((key) => normalizeRef(getField(doc, key)) === wanted));
}

function emptyReading(doc) {
  return {
    docId: doc.id, kind: doc.docType, lineNo: null, reportNumber: null, lab: null, shape: null, carat: null,
    color: null, clarity: null, growth: null, growthMethod: null, pieces: null, sizeRange: null, amount: null,
  };
}

// ---------- the stone record ----------

function finishStone(draft, index, shipment) {
  const readings = [...draft.readings].sort((a, b) => trust(a.kind) - trust(b.kind));
  const pick = (field) => {
    const found = readings.find((r) => r[field] !== null && r[field] !== undefined);
    return found ? found[field] : null;
  };
  const reportNumber = pick('reportNumber');
  const firstLine = draft.readings.find((r) => r.lineNo !== null);
  const growth = pick('growth');
  const ref = reportNumber ? cleanReportNumber(reportNumber) : `${shipment.ref} line ${firstLine ? firstLine.lineNo : index + 1}`;
  // When the papers disagree, the value a person chose ("Which is right?") wins over the most trusted paper.
  const value = (field) => {
    const chosen = chosenValue(shipment, ref, field, draft.readings);
    return chosen !== undefined && chosen !== null ? chosen : pick(field);
  };
  return {
    id: `stn_${shortHash(`${shipment.id}|${draft.key}`)}`,
    workspaceId: shipment.workspaceId,
    shipmentId: shipment.id,
    ref,
    reportNumber: reportNumber ? cleanReportNumber(reportNumber) : null,
    lab: pick('lab'),
    shape: value('shape'),
    carat: value('carat'),
    color: value('color'),
    clarity: value('clarity'),
    growth: growth === 'lab-grown' || growth === 'natural' ? growth : null,
    growthMethod: pick('growthMethod'),
    pieces: pick('pieces') || 1,
    sizeRange: pick('sizeRange'),
    sources: draft.readings.map((r) => ({
      docId: r.docId, kind: r.kind, lineNo: r.lineNo, reportNumber: r.reportNumber, lab: r.lab, shape: r.shape,
      carat: r.carat, color: r.color, clarity: r.clarity, growth: r.growth, growthMethod: r.growthMethod,
      pieces: r.pieces, amount: r.amount, sha256: r.sha256 || null,
    })),
    kp: draft.kp || { certificateNumber: null, countries: [] },
  };
}

// ---------- a person's answer to "Which is right?" ----------

/** The answer key for one stone and field: 'stone.<ref>.carat'. Rules only: it is never written into a paper. */
export function stoneAnswerKey(ref, field) {
  return `stone.${ref}.${field}`;
}

/** A person's answer stored on the shipment, as text, or null when there is none. */
export function shipmentAnswer(shipment, key) {
  const answer = shipment && shipment.answers ? shipment.answers[key] : null;
  return answer === null || answer === undefined || String(answer).trim() === '' ? null : String(answer).trim();
}

const GRADE_READERS = { color: normalizeColor, clarity: normalizeClarity, shape: normalizeShape };

/**
 * The value a person chose for a stone's field. It must be one of the values the papers print ("0.70 ct", "G"):
 * undefined when nobody answered, null when the answer names none of them.
 */
function chosenValue(shipment, ref, field, sources) {
  const answer = shipmentAnswer(shipment, stoneAnswerKey(ref, field));
  if (answer === null) return undefined;
  const values = [...new Set(sources.map((s) => s[field]).filter((v) => v !== null && v !== undefined))];
  if (field === 'carat') {
    for (const number of (answer.match(/\d*[.,]\d+|\d+/g) || []).map(parseNumber)) {
      const found = values.find((v) => Math.abs(v - number) <= CARAT_TOLERANCE + 1e-9);
      if (found !== undefined) return found;
    }
    return null;
  }
  const said = GRADE_READERS[field](answer);
  return values.includes(said) ? said : null;
}

function trust(kind) {
  const at = TRUST_ORDER.indexOf(kind);
  return at === -1 ? TRUST_ORDER.length : at;
}

// ---------- issues ----------

/**
 * Problems with the stones, worked out from the stones' own sources so the rules can recompute them:
 * carat_mismatch, grade_mismatch, nature_conflict, duplicate_report, report_not_on_list, missing_lab_report.
 */
export function findStoneIssues({ stones = [], documents = [], shipment = {} }) {
  const issues = [];
  const own = shipmentDocuments(shipment, documents);
  const listsWithLines = own.filter((doc) => LIST_TYPES.includes(doc.docType) && docLines(doc).length > 0);
  // Rough and stones set in jewellery are not graded one by one.
  const graded = !['rough', 'jewelry'].includes(shipment.goods && shipment.goods.form);

  for (const stone of stones) {
    const sources = (stone.sources || []).filter((s) => TRUST_ORDER.includes(s.kind));
    const label = stoneLabel(stone);
    const add = (code, detail, docIds, extra = {}) => issues.push({
      code, detail, ref: stone.ref, label, stoneId: stone.id, docIds: [...new Set(docIds)], ...extra,
    });

    // Weight: any two papers more than 0.005 ct apart.
    const carat = (v) => `${formatCarat(v)} ct`;
    const weighed = sources.filter((s) => s.carat !== null && s.carat !== undefined);
    if (weighed.length > 1) {
      const carats = weighed.map((s) => s.carat);
      if (round(Math.max(...carats) - Math.min(...carats), 3) > CARAT_TOLERANCE) {
        const values = [...new Set(carats.map(formatCarat))].sort();
        const detail = `${label} weighs ${describe(weighed, 'carat', carat)}.`;
        add('carat_mismatch', detail, weighed.map((s) => s.docId), { field: 'carat', values, ...choice(shipment, stone, 'carat', weighed, label, carat) });
      }
    }

    // Grades: colour, clarity and shape must agree.
    for (const [field, word] of [['color', 'colour'], ['clarity', 'clarity'], ['shape', 'shape']]) {
      const graded = sources.filter((s) => s[field]);
      if (new Set(graded.map((s) => s[field])).size > 1) {
        const values = [...new Set(graded.map((s) => s[field]))].sort();
        const show = (v) => v;
        add('grade_mismatch', `${label} has ${word} ${describe(graded, field, show)}.`, graded.map((s) => s.docId), { field, values, ...choice(shipment, stone, field, graded, label, show) });
      }
    }

    // Natural on one paper, lab-grown on another.
    const natures = sources.filter((s) => s.growth === 'natural' || s.growth === 'lab-grown');
    if (new Set(natures.map((s) => s.growth)).size > 1) {
      const word = (s) => (s.growth === 'lab-grown' && s.growthMethod ? `lab-grown (${s.growthMethod})` : s.growth);
      const groups = natures.map((s) => `${word(s)} on ${KIND_WORDS[s.kind]}`);
      add('nature_conflict', `${label} is ${[...new Set(groups)].join(' but ')}.`, natures.map((s) => s.docId));
    }

    // The same report twice: two lines of one list, or two different report files.
    const byDoc = new Map();
    for (const source of sources.filter((s) => LIST_TYPES.includes(s.kind))) {
      byDoc.set(source.docId, [...(byDoc.get(source.docId) || []), source]);
    }
    for (const [docId, lines] of byDoc) {
      if (lines.length > 1 && stone.reportNumber) {
        const where = lines.map((s) => s.lineNo).join(' and ');
        add('duplicate_report', `Report ${stone.reportNumber} is listed twice on ${KIND_WORDS[lines[0].kind]} (lines ${where}).`, [docId]);
      }
    }
    const reportFiles = sources.filter((s) => s.kind === 'lab_report');
    const distinctFiles = new Set(reportFiles.map((s) => s.sha256 || s.docId));
    if (distinctFiles.size > 1) {
      add('duplicate_report', `Report ${stone.reportNumber} was uploaded as ${distinctFiles.size} different files.`, reportFiles.map((s) => s.docId));
    }

    // A grading report that no list mentions. "Yes, it is part of the shipment" settles it; "No" left the report
    // out already (shipmentDocuments); any other answer asks again.
    const onList = sources.some((s) => LIST_TYPES.includes(s.kind));
    if (reportFiles.length && !onList && listsWithLines.length) {
      const said = onShipmentAnswer(shipment, stone.ref);
      const extra = said === 'yes' ? { accepted: true } : said ? { unclear: shipmentAnswer(shipment, stoneAnswerKey(stone.ref, 'onShipment')) } : {};
      add('report_not_on_list', `Report ${stone.reportNumber} is on file but not on the packing list or invoice.`, reportFiles.map((s) => s.docId), extra);
    }

    // 0.50 ct and up needs a grading report: a report number on a list counts, because the lab's own
    // report check can confirm it.
    const size = perStoneCarat(stone);
    if (graded && atOrAboveHalf(size) && !stone.reportNumber && !reportFiles.length) {
      add('missing_lab_report', `${label} is ${formatCarat(size)} ct and has no grading report on file.`, sources.map((s) => s.docId), { carat: size });
    }
  }
  return issues;
}

/**
 * What a person's answer to "Which is right?" did to a stone that the papers disagree on:
 * {} (no answer yet), { unclear: answer } (the answer names none of the values), or { chosen, accepted, detail, offDocIds }
 * once a value was chosen: detail then names the papers that still print another value, and accepted is true when
 * a person agreed to ship with that difference ('stone.<ref>.<field>.accepted').
 */
function choice(shipment, stone, field, sources, label, show) {
  const chosen = chosenValue(shipment, stone.ref, field, sources);
  if (chosen === undefined) return {};
  if (chosen === null) return { unclear: shipmentAnswer(shipment, stoneAnswerKey(stone.ref, field)) };
  const off = sources.filter((s) => (field === 'carat' ? Math.abs(s.carat - chosen) > CARAT_TOLERANCE + 1e-9 : s[field] !== chosen));
  return {
    chosen,
    accepted: Boolean(shipmentAnswer(shipment, `${stoneAnswerKey(stone.ref, field)}.accepted`)),
    detail: `${label}: the house answered ${show(chosen)}, but ${say(off, field, show)}.`,
    offDocIds: [...new Set(off.map((s) => s.docId))],
    offText: say(off, field, show),
  };
}

/** "the lab report and the factory record say 0.70 ct" */
function say(sources, field, show) {
  const groups = new Map();
  for (const source of sources) {
    const words = groups.get(source[field]) || [];
    const word = KIND_WORDS[source.kind] || 'another paper';
    if (!words.includes(word)) words.push(word);
    groups.set(source[field], words);
  }
  return [...groups.entries()].map(([value, words]) => `${words.join(' and ')} ${words.length > 1 ? 'say' : 'says'} ${show(value)}`).join(', and ');
}

/** "Report 2141438176" or "Line 3 (0.45 ct Round)" for sentences. */
export function stoneLabel(stone) {
  if (stone.reportNumber) return `Report ${stone.reportNumber}`;
  const line = (stone.sources || []).find((s) => s.lineNo !== null && s.lineNo !== undefined);
  const parts = [stone.carat !== null ? `${formatCarat(stone.carat)} ct` : null, stone.shape].filter(Boolean).join(' ');
  const where = line ? `Line ${line.lineNo} of ${KIND_WORDS[line.kind] || 'the list'}` : 'A stone';
  return parts ? `${where} (${parts})` : where;
}

// "1.04 ct on the lab report but 1.01 ct on the packing list and the invoice"
function describe(sources, field, show) {
  const groups = new Map();
  for (const source of sources) {
    const value = source[field];
    const words = groups.get(value) || [];
    const word = KIND_WORDS[source.kind] || 'another paper';
    if (!words.includes(word)) words.push(word);
    groups.set(value, words);
  }
  return [...groups.entries()].map(([value, words]) => `${show(value)} on ${words.join(' and ')}`).join(' but ');
}
