// The origin rules. Deterministic: the same papers always give the same checks, papers and questions.
// Every check names its rule ('compliance.js#<code>') and the papers it looked at, so a person can see why.
//
// Sources, checked against the official texts:
// - EU: AWDC EU Import Guidelines, update 1 January 2026 (Due Diligence Statement on Diamond Origin for
//   natural polished 0.50 ct and up, KP certificates with mining countries for rough, Diamond Office
//   G7/GF declaration template for lab-grown).
// - US: CBP CSMS #61912001 (self-certification for non-industrial diamonds 0.50 ct and up, diamond
//   jewellery and unsorted diamonds; one per entry, company letterhead, PDF, DocCode CBP03).
import { getField, docLines, parseDate, formatDate, formatCarat, shortHash } from './fields.js';
import {
  normalizeCountry, countryName, isEU, splitCountries, checkReportNumber, labFromReportNumber, natureFromText, formFromText,
} from './formats.js';
import { classifyGoods, documentNature, perStoneCarat, atOrAboveHalf, PARCEL_DOC_TYPES } from './goods.js';
import { findRussia, describeHit, totalsProblems, partiesProblems, datesProblems, exportDate, docWord } from './consistency.js';
import { findStoneIssues, stoneLabel, shipmentDocuments } from '../records/stones.js';

export const RULES_VERSION = 'compliance.js 1.0';
export { classifyGoods };

export const RULE_SOURCES = {
  awdc: {
    title: 'AWDC EU Import Guidelines, update 1 January 2026',
    url: 'https://www.awdc.be/sites/default/files/2025-12/EU%20Import%20Guidelines%20-%20Update%201%20January%202026.pdf',
  },
  cbp: {
    title: 'CBP CSMS #61912001',
    url: 'https://content.govdelivery.com/accounts/USDHSCBP/bulletins/3b0b3c1',
  },
};

const REASONS = {
  eu_dds: 'EU import of natural polished diamonds of 0.50 ct and up needs a signed Due Diligence Statement on '
    + 'Diamond Origin from the importer, before or at import (AWDC EU Import Guidelines, update 1 January 2026). '
    + 'One statement may cover several parcels in a shipment. Keep it 5 years.',
  g7_rough: 'EU import of natural rough needs a KP certificate that lists the countries of mining, and the Diamond '
    + 'Office G7/GF declaration template (AWDC EU Import Guidelines, update 1 January 2026).',
  g7_synthetic: 'For lab-grown rough and polished, the Diamond Office G7/GF declaration template still applies '
    + '(AWDC EU Import Guidelines, update 1 January 2026).',
  us_cbp: 'US import of non-industrial diamonds of 0.50 ct and up, diamond jewellery or unsorted diamonds needs the '
    + 'importer\'s self-certification: one per entry, on company letterhead, as a PDF uploaded to ACE DIS with DocCode '
    + 'CBP03 (CBP CSMS #61912001).',
  export_pack: 'Every export gets an origin pack: stone list, evidence index and the originals in the order customs reads them.',
  import_pack: 'Every import gets an origin pack: stone list, evidence index and the originals in the order customs reads them.',
};

// The papers customs expects, by direction. Insurance is optional.
// label starts a sentence; word sits inside one.
const REQUIRED_DOCS = {
  export: [
    { types: ['commercial_invoice'], label: 'Commercial invoice', word: 'commercial invoice' },
    { types: ['packing_list'], label: 'Packing list', word: 'packing list' },
    { types: ['shipping_bill'], label: 'Shipping bill with Let Export Order', word: 'shipping bill with Let Export Order' },
    { types: ['air_waybill'], label: 'Air waybill', word: 'air waybill' },
  ],
  import: [
    { types: ['commercial_invoice', 'supplier_invoice'], label: 'Invoice', word: 'invoice' },
    { types: ['bill_of_entry'], label: 'Bill of entry', word: 'bill of entry' },
    { types: ['air_waybill'], label: 'Air waybill', word: 'air waybill' },
  ],
};

/**
 * Run every rule on one shipment.
 * documents: all documents of the workspace (the shipment's own are picked by shipment.documentIds; rough-side
 *   papers the stones point to are read too). stones: from matchStones. screenings: OFAC screen results for the
 *   shipment's parties ({ name, status, best, role? }); null means not screened yet. now: Date or ISO string.
 * @returns {{ checks: object[], required: object[], questions: object[], status: string, summary: {passed:number,total:number} }}
 */
export function evaluate({ shipment, documents = [], stones = [], house = null, screenings = null, now = new Date() }) {
  const docs = shipmentDocuments(shipment, documents);
  const ids = new Set(docs.map((doc) => doc.id));
  const docsById = new Map(documents.map((doc) => [doc.id, doc]));
  // Rough-side papers the stones point to (they may be filed under another shipment).
  const sourceIds = new Set(stones.flatMap((stone) => (stone.sources || []).map((s) => s.docId)));
  const related = [...docs, ...documents.filter((doc) => sourceIds.has(doc.id) && !ids.has(doc.id))];

  const ref = shipment.ref || 'this shipment';
  const goods = classifyGoods({ documents: docs.filter((doc) => PARCEL_DOC_TYPES.includes(doc.docType)), stones });
  // When the papers do not say, a person's answer on the shipment does ("Natural", "Polished").
  const answered = shipment.goods || {};
  if (goods.nature === 'unknown') goods.nature = natureFromText(answered.nature) || 'unknown';
  if (goods.form === 'unknown') goods.form = formFromText(answered.form) || 'unknown';
  const destination = normalizeCountry(shipment.destinationCountry);
  const direction = String(shipment.direction || 'unknown').toLowerCase();
  const regime = regimeOf(destination);
  const natural = goods.nature === 'natural' || goods.nature === 'mixed';
  const labGrown = goods.nature === 'lab-grown' || goods.nature === 'mixed';
  const stoneIssues = findStoneIssues({ stones, documents, shipment });

  const checks = [];
  const required = [];
  const questions = [];
  const check = (code, severity, title, detail, evidence = []) => checks.push({
    id: `chk_${shortHash(`${shipment.id}|${code}`)}`,
    shipmentId: shipment.id,
    code,
    severity,
    title,
    detail,
    evidence: dedupeEvidence(evidence),
    rule: `compliance.js#${code}`,
  });
  // key is a field key: the pipeline writes the answer into that field (of docId when given), so it is
  // only set when the answer is the field's value. check names the rule that asked.
  // dedupeKey says when two questions are the same one, so a question whose wording changes as papers arrive
  // ("... on the invoice" becomes "... on the packing list and the invoice") is not asked again.
  const ask = (code, kind, text, extra = {}) => questions.push({
    shipmentId: shipment.id,
    check: code,
    kind,
    text,
    key: extra.key || null,
    docId: extra.docId || null,
    options: extra.options || null,
    docType: extra.docType || null,
    dedupeKey: extra.dedupeKey || null,
    status: 'open',
  });
  const evidenceOf = (problem) => problem.docIds.filter(Boolean).map((docId) => ({ docId, key: problem.keys ? problem.keys[0] : undefined }));

  // ---- Where it goes and what it is ----

  if (destination) {
    const words = { EU: 'EU rules apply.', US: 'US rules apply.', UK: 'UK rules: no statement template yet, the pack carries the evidence.', OTHER: 'No EU or US origin statement is needed.' };
    check('destination_regime', 'pass', 'Destination', `${countryName(destination)}. ${words[regime]}`, fieldEvidence(docs, ['goods.destinationCountry', 'consignee.country', 'consignee.address']));
  } else {
    check('destination_regime', 'warn', 'Destination', 'No paper names the destination country.');
    ask('destination_regime', 'missing_field', `Where is ${ref} going? No paper names the destination country.`, { key: 'goods.destinationCountry' });
  }

  if (direction === 'export' || direction === 'import') {
    const detail = direction === 'export'
      ? `Export${shipment.originCountry ? ` from ${countryName(shipment.originCountry)}` : ''}.`
      : `Import${destination ? ` into ${countryName(destination)}` : ''}.`;
    check('direction', 'pass', 'Export or import', detail, fieldEvidence(docs, ['exporter.name', 'consignee.name']));
  } else {
    const houseName = (house && (house.name || (house.profile && house.profile.name))) || 'your house';
    check('direction', 'warn', 'Export or import', `The house name does not appear as exporter or consignee on ${ref}.`);
    ask('direction', 'confirm', `Is ${ref} an export or an import for ${houseName}?`, { key: 'shipment.direction', options: ['Export', 'Import'] });
  }

  const goodsWords = describeGoods(goods);
  if (goods.nature === 'unknown' || goods.form === 'unknown') {
    check('goods_class', 'warn', 'Goods', goodsWords, fieldEvidence(docs, ['goods.hsCode', 'goods.nature', 'goods.description']));
    if (goods.nature === 'unknown') ask('goods_class', 'missing_field', `Are the diamonds in ${ref} natural or lab-grown?`, { key: 'goods.nature', options: ['Natural', 'Lab-grown'] });
    if (goods.form === 'unknown') ask('goods_class', 'missing_field', `Are the diamonds in ${ref} rough, polished or set in jewellery?`, { key: 'goods.form', options: ['Rough', 'Polished', 'Jewellery'] });
  } else {
    check('goods_class', goods.nature === 'mixed' ? 'info' : 'pass', 'Goods', goodsWords, fieldEvidence(docs, ['goods.hsCode', 'goods.nature', 'goods.description']));
  }

  // Lots (several stones on one line) are judged by their average size.
  const lots = stones.some((stone) => stone.pieces > 1) ? ' Lots are counted by their average size.' : '';
  let sizeDetail = 'Stone sizes are not listed yet.';
  if (goods.sizesKnown && goods.stonesAtOrAboveHalf > 0) sizeDetail = `${goods.stonesAtOrAboveHalf} of ${goods.stoneCount} stones are 0.50 ct or more (largest ${formatCarat(goods.maxCarat)} ct).${lots}`;
  else if (goods.sizesKnown) sizeDetail = `No stone reaches 0.50 ct (largest ${formatCarat(goods.maxCarat)} ct).${lots}`;
  check('half_carat_stones', 'info', 'Stones of 0.50 ct and up', sizeDetail);
  const halfCaratOrUnknown = !goods.sizesKnown || goods.stonesAtOrAboveHalf > 0;

  // ---- What the destination requires ----

  required.push(direction === 'import'
    ? { kind: 'import_pack', reason: REASONS.import_pack, signer: 'importer', regime }
    : { kind: 'export_pack', reason: REASONS.export_pack, signer: 'exporter', regime });

  if (regime === 'EU') {
    const polished = ['polished', 'mixed', 'unknown'].includes(goods.form);
    const rough = goods.form === 'rough' || goods.form === 'mixed';
    if (natural && polished) {
      if (halfCaratOrUnknown) {
        required.push({ kind: 'eu_dds', reason: REASONS.eu_dds, signer: 'importer', regime });
        const safe = goods.sizesKnown ? '' : ' Stone sizes are not listed, so it is prepared to be safe.';
        check('eu_dds_required', 'info', 'EU Due Diligence Statement', `Required. The importer signs it.${safe}`);
      } else {
        check('eu_dds_required', 'info', 'EU Due Diligence Statement', 'Not required: no stone reaches 0.50 ct.');
      }
    }
    if (natural && rough) {
      const kp = kpOnFile(related, stones);
      required.push({ kind: 'g7_gf_declaration', reason: REASONS.g7_rough, signer: 'importer', regime });
      if (!kp.number) {
        check('eu_kp_rough', 'fail', 'KP certificate for EU rough', 'Rough into the EU needs a KP certificate. None is on file.');
        ask('eu_kp_rough', 'missing_document', `KP certificate for ${ref} is not on file. Upload it with the countries of mining listed.`);
      } else if (!kp.countries.length) {
        check('eu_kp_rough', 'fail', 'KP certificate for EU rough', `KP certificate ${kp.number} does not list the countries of mining.`, kp.evidence);
        ask('eu_kp_rough', 'missing_field', `KP certificate ${kp.number} does not list the countries of mining. Upload a copy that does.`, { key: 'kp.countriesOfMining', docId: kp.docId });
      } else {
        check('eu_kp_rough', 'pass', 'KP certificate for EU rough', `KP certificate ${kp.number} lists ${countryList(kp.countries)}.`, kp.evidence);
      }
    }
    if (labGrown) {
      required.push({ kind: 'g7_gf_declaration', reason: REASONS.g7_synthetic, signer: 'importer', regime });
      check('eu_synthetic_g7', 'info', 'Diamond Office G7/GF declaration', 'Required for lab-grown stones. The importer signs it.');
    }
  }

  if (regime === 'US') {
    const covered = (natural && !goods.industrial && halfCaratOrUnknown) || goods.form === 'jewelry' || goods.unsorted;
    if (covered) {
      required.push({ kind: 'us_cbp_certificate', reason: REASONS.us_cbp, signer: 'us_importer', regime });
      check('us_cbp_cert', 'info', 'US CBP self-certification', 'Required: one per entry, on letterhead, DocCode CBP03. The US importer uploads it.');
    } else {
      let why = 'no stone reaches 0.50 ct';
      if (goods.nature === 'lab-grown') why = 'the parcel is lab-grown';
      else if (goods.nature === 'unknown') why = 'the papers do not say the stones are natural';
      else if (goods.industrial) why = 'the diamonds are industrial';
      check('us_cbp_cert', 'info', 'US CBP self-certification', `Not required: ${why}.`);
    }
  }

  // ---- Origin ----

  const russia = findRussia(related, stones);
  if (russia.length) {
    const shown = russia.slice(0, 3).map((hit) => describeHit(hit, docsById)).join('; ');
    check('russia_anywhere', 'fail', 'Russia anywhere', `Russia appears in the papers: ${shown}.`, russia.map((hit) => ({ docId: hit.docId, key: hit.key })));
  } else {
    check('russia_anywhere', 'pass', 'Russia anywhere', 'No paper or stone points to Russia.');
  }

  // The KP certificate of the rough behind natural goods: a warning when missing, a failure for EU rough
  // (eu_kp_rough above asks the question, so none is asked twice).
  if (natural) {
    const euRough = regime === 'EU' && (goods.form === 'rough' || goods.form === 'mixed');
    const missingSeverity = euRough ? 'fail' : 'warn';
    const kp = kpOnFile(related, stones);
    if (kp.number) {
      check('kp_present', 'pass', 'KP certificate', `KP certificate ${kp.number} is linked to the rough.`, kp.evidence);
      if (kp.countries.length) check('kp_countries_listed', 'pass', 'Countries of mining', `Mined in ${countryList(kp.countries)}.`, kp.evidence);
      else check('kp_countries_listed', missingSeverity, 'Countries of mining', `KP certificate ${kp.number} does not list the countries of mining.`, kp.evidence);
    } else {
      check('kp_present', missingSeverity, 'KP certificate', euRough
        ? 'No KP certificate is on file for this rough.'
        : 'No KP certificate is linked to these stones. The statement is stronger with one.');
    }
  }

  // ---- Stones ----

  // Polished stones carry grading reports; rough and jewellery do not.
  const naturalStones = stones.filter((stone) => stone.growth !== 'lab-grown');
  if (natural && ['polished', 'mixed', 'unknown'].includes(goods.form)) {
    const big = naturalStones.filter((stone) => atOrAboveHalf(perStoneCarat(stone)));
    const missing = big.filter((stone) => !stone.reportNumber && !(stone.sources || []).some((s) => s.kind === 'lab_report'));
    if (!stones.length) {
      check('lab_reports_for_half_carat', 'info', 'Grading reports', 'No stone list yet.');
    } else if (missing.length) {
      check('lab_reports_for_half_carat', 'warn', 'Grading reports', `${missing.length} of ${big.length} stones of 0.50 ct or more have no grading report.`,
        missing.flatMap((stone) => (stone.sources || []).map((s) => ({ docId: s.docId }))));
      for (const stone of missing) {
        ask('lab_reports_for_half_carat', 'missing_document', `${stoneLabel(stone)} on ${ref} has no grading report. Upload it or add its report number.`, {
          docId: firstDoc(stone),
          dedupeKey: `lab_reports_for_half_carat|${formatCarat(perStoneCarat(stone))}|${stone.shape || ''}|${stone.color || ''}|${stone.clarity || ''}`,
        });
      }
    } else {
      check('lab_reports_for_half_carat', 'pass', 'Grading reports', big.length
        ? `Every natural stone of 0.50 ct or more has a grading report (${big.length}).`
        : 'No natural stone reaches 0.50 ct.');
    }
  }

  const numbered = stones.filter((stone) => stone.reportNumber);
  const badFormat = [];
  for (const stone of numbered) {
    const lab = stone.lab || labFromReportNumber(stone.reportNumber);
    const result = checkReportNumber(lab, stone.reportNumber);
    if (result.ok === false) badFormat.push({ stone, lab, hint: result.hint });
  }
  if (!numbered.length) {
    check('report_format', 'info', 'Report numbers', 'No report numbers listed.');
  } else if (badFormat.length) {
    check('report_format', 'warn', 'Report numbers', `${badFormat.length} report numbers do not match their lab's format.`, badFormat.map(({ stone }) => ({ docId: firstDoc(stone) })));
    for (const { stone, lab, hint } of badFormat) {
      ask('report_format', 'confirm', `Report number ${stone.reportNumber} on ${ref} does not look like a ${lab} number (${hint}). Check it.`, { docId: firstDoc(stone) });
    }
  } else {
    check('report_format', 'pass', 'Report numbers', `${numbered.length} report numbers match their lab's format.`);
  }

  problemCheck('duplicate_reports', 'Duplicate reports', stoneIssues.filter((i) => i.code === 'duplicate_report'),
    'No report number is listed twice.',
    (issue) => ({ kind: 'mismatch', text: `${issue.detail} Which is right?` }));

  problemCheck('stone_details', 'Stones agree across papers',
    stoneIssues.filter((i) => ['carat_mismatch', 'grade_mismatch', 'report_not_on_list'].includes(i.code)),
    'Weight and grades agree on the lab reports, packing list and invoice.',
    (issue) => (issue.code === 'report_not_on_list'
      ? { kind: 'confirm', text: `${issue.detail} Is it part of ${ref}?`, options: ['Yes', 'No'] }
      : { kind: 'mismatch', text: `${issue.detail} Which is right?` }));

  // ---- Papers agree with each other ----

  problemCheck('totals_consistency', 'Totals', totalsProblems(docs, ref),
    'Pieces, carats and value agree across the papers.',
    (problem) => ({ kind: 'mismatch', text: `${problem.text} Which is right?` }));

  problemCheck('parties_consistency', 'Exporter and consignee', partiesProblems(docs, ref),
    'Exporter and consignee names agree across the papers.',
    (problem) => ({ kind: 'confirm', text: `${problem.text} Same company?`, options: ['Same company', 'Different companies'] }));

  // Dates in order, and a rough parcel's KP certificate still valid when it leaves.
  const dateProblems = datesProblems(docs, ref);
  const expired = kpExpiry(docs, goods, now);
  if (!dateProblems.length && !expired) {
    check('dates_order', 'pass', 'Dates', 'Invoice, Let Export Order and air waybill dates are in order.');
  } else {
    const all = expired ? [expired, ...dateProblems] : dateProblems;
    check('dates_order', expired ? 'fail' : 'warn', 'Dates', all.map((p) => p.text).join(' '), all.flatMap(evidenceOf));
    if (expired) ask('dates_order', 'missing_document', `${expired.text} Upload a valid certificate.`, { docId: expired.docIds[0], docType: 'kp_certificate' });
    for (const problem of dateProblems) ask('dates_order', 'confirm', problem.text, { docId: problem.docIds[1] });
  }

  // Natural on one paper, lab-grown on another.
  const conflicts = stoneIssues.filter((i) => i.code === 'nature_conflict');
  const docConflict = documentNatureConflict(docs, stones);
  if (conflicts.length || docConflict) {
    const lines = [...conflicts.map((issue) => issue.detail), ...(docConflict ? [docConflict.text] : [])];
    const evidence = [...conflicts.flatMap((issue) => issue.docIds.map((docId) => ({ docId }))), ...(docConflict ? evidenceOf(docConflict) : [])];
    check('nature_consistency', 'fail', 'Natural or lab-grown', lines.join(' '), evidence);
    for (const text of lines) ask('nature_consistency', 'mismatch', `${text} Which is right?`);
  } else {
    check('nature_consistency', 'pass', 'Natural or lab-grown', 'Every paper agrees on natural or lab-grown.');
  }

  // ---- Papers on file ----

  // A paper the house marked as not needed (shipment.notNeeded, from an answer) counts as settled.
  const waived = new Set(shipment.notNeeded || []);
  const needed = REQUIRED_DOCS[direction === 'import' ? 'import' : 'export'];
  const notNeeded = needed.filter((item) => item.types.some((type) => waived.has(type)));
  const missing = needed.filter((item) => !notNeeded.includes(item) && !docs.some((doc) => item.types.includes(doc.docType)));
  const shippingBill = docs.find((doc) => doc.docType === 'shipping_bill');
  const noLeo = direction !== 'import' && shippingBill && !waived.has('shipping_bill') && !parseDate(getField(shippingBill, 'leo.date'));
  const waivedText = notNeeded.length ? ` Marked not needed by the house: ${notNeeded.map((item) => item.word).join(', ')}.` : '';
  if (missing.length || noLeo) {
    const names = missing.map((item) => item.word);
    const detail = [names.length ? `Not on file: ${names.join(', ')}.` : '', noLeo ? 'The shipping bill has no Let Export Order date.' : ''].filter(Boolean).join(' ') + waivedText;
    check('required_documents', 'warn', 'Papers on file', detail, docs.map((doc) => ({ docId: doc.id })));
    for (const item of missing) ask('required_documents', 'missing_document', missingText(item, ref, docs), { docType: item.types[0] });
    if (noLeo) {
      const number = getField(shippingBill, 'shippingBill.number') || getField(shippingBill, 'doc.number');
      const name = number ? `Shipping bill ${number}` : 'The shipping bill';
      ask('required_documents', 'missing_field', `${name} for ${ref} has no Let Export Order date. Upload the copy with the LEO.`, { key: 'leo.date', docId: shippingBill.id, docType: 'shipping_bill' });
    }
  } else {
    const insured = docs.some((doc) => doc.docType === 'insurance_certificate') ? ' Insurance certificate on file too.' : '';
    const onFile = needed.filter((item) => !notNeeded.includes(item)).map((item) => item.label);
    check('required_documents', 'pass', 'Papers on file', `${onFile.join(', ')} ${onFile.length === 1 ? 'is' : 'are'} on file.${insured}${waivedText}`, docs.map((doc) => ({ docId: doc.id })));
  }

  // ---- Sanctions ----

  sanctionsCheck();

  // ---- Result ----

  const status = checks.some((c) => c.severity === 'fail') ? 'held_for_review' : questions.length ? 'questions' : 'ready_to_sign';
  const passed = checks.filter((c) => c.severity === 'pass' || c.severity === 'info').length;
  return { checks, required: dedupeRequired(required), questions, status, summary: { passed, total: checks.length }, goods, regime };

  // ---------- helpers that need the shipment in scope ----------

  // A check that passes when there are no problems, else warns and asks one question per problem.
  // Problems are stone issues ({ detail, docIds }) or paper problems ({ text, docIds, keys }).
  function problemCheck(code, title, problems, okText, makeQuestion) {
    if (!problems.length) {
      check(code, 'pass', title, okText);
      return;
    }
    const words = (problem) => problem.text || problem.detail;
    check(code, 'warn', title, problems.map(words).join(' '), problems.flatMap(evidenceOf));
    for (const problem of problems) {
      const question = makeQuestion(problem);
      // A stone's problem is the same question while the same values disagree, whatever papers name them.
      const dedupeKey = problem.stoneId
        ? [code, problem.code, problem.ref, problem.field || '', (problem.values || []).join(',')].join('|')
        : null;
      // No field key here: "Which is right?" answers are not a value to write into a paper.
      ask(code, question.kind, question.text, { docId: problem.docIds[problem.docIds.length - 1], options: question.options, dedupeKey });
    }
  }

  // Screen results come from the Sanctions agent: 'clear', 'review', 'match', or 'not_screened'.
  function sanctionsCheck() {
    if (!Array.isArray(screenings) || !screenings.length) {
      check('sanctions', 'fail', 'OFAC SDN screen', 'The parties have not been screened against the OFAC SDN list yet.');
      return;
    }
    const matches = screenings.filter((s) => s.status === 'match');
    const reviews = screenings.filter((s) => s.status === 'review');
    const unscreened = screenings.filter((s) => !['clear', 'review', 'match'].includes(s.status));
    const screeningOff = Boolean(house && house.permissions && house.permissions.ofacScreen === false);
    const names = (list) => list.map((s) => s.name).join(', ');
    const parts = [];
    let severity = 'pass';

    if (matches.length) {
      severity = 'fail';
      parts.push(`On the OFAC SDN list: ${matches.map((s) => `${s.name}${s.best && s.best.sdnName ? ` (${s.best.sdnName})` : ''}`).join(', ')}.`);
    }
    if (reviews.length) {
      if (severity === 'pass') severity = 'warn';
      parts.push(`Possible matches to review: ${names(reviews)}.`);
      for (const s of reviews) {
        const like = s.best && s.best.sdnName ? ` looks like ${s.best.sdnName}` : ' is close to a listed name';
        ask('sanctions', 'confirm', `Possible OFAC SDN match: ${s.name}${like}. Confirm they are different before signing.`, { options: ['Different', 'Same'] });
      }
    }
    if (unscreened.length && screeningOff) {
      if (severity === 'pass') severity = 'info';
      parts.push('OFAC screening is off for this house.');
    } else if (unscreened.length) {
      severity = 'fail';
      parts.push(`Not screened yet: ${names(unscreened)}.`);
    }
    if (!parts.length) {
      const compared = screenings.reduce((sum, s) => sum + (s.compared || 0), 0);
      parts.push(`${screenings.length} parties clear on the OFAC SDN list${compared ? ` (${compared} similar names compared)` : ''}.`);
    }
    const evidence = [...matches, ...reviews].flatMap((s) => partyEvidence(docs, s.name));
    check('sanctions', severity, 'OFAC SDN screen', parts.join(' '), evidence);
  }
}

// ---------- small helpers ----------

/** 'EU', 'US', 'UK' or 'OTHER' for a destination country. */
export function regimeOf(country) {
  const code = normalizeCountry(country);
  if (!code) return 'OTHER';
  if (isEU(code)) return 'EU';
  if (code === 'US') return 'US';
  if (code === 'GB') return 'UK';
  return 'OTHER';
}

function describeGoods(goods) {
  const nature = { natural: 'Natural', 'lab-grown': 'Lab-grown', mixed: 'Natural and lab-grown', unknown: 'Unknown nature' }[goods.nature];
  const form = { rough: 'rough', polished: 'polished', jewelry: 'jewellery', mixed: 'rough and polished', unknown: 'form unknown' }[goods.form];
  const hs = goods.hsCodes.length ? ` (HS ${goods.hsCodes.join(', ')})` : '';
  const mixedNote = goods.nature === 'mixed' ? ' Each stone follows its own rule.' : '';
  return `${nature} ${goods.form === 'unknown' ? `diamonds, ${form}` : `${form} diamonds`}${hs}.${mixedNote}`;
}

function countryList(codes) {
  const names = codes.map(countryName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The KP certificate behind the stones: on file with the shipment, or reached through the stones' sources.
function kpOnFile(related, stones) {
  const kpDocs = related.filter((doc) => doc.docType === 'kp_certificate');
  const stoneKp = stones.map((stone) => stone.kp).find((kp) => kp && kp.certificateNumber);
  const doc = kpDocs[0] || null;
  const number = (doc && (getField(doc, 'kp.certificateNumber') || getField(doc, 'doc.number'))) || (stoneKp && stoneKp.certificateNumber) || null;
  const countries = [...new Set([
    ...kpDocs.flatMap((d) => splitCountries(getField(d, 'kp.countriesOfMining'))),
    ...stones.flatMap((stone) => (stone.kp && stone.kp.countries) || []),
  ])];
  return { number, countries, docId: doc ? doc.id : null, evidence: kpDocs.map((d) => ({ docId: d.id, key: 'kp.countriesOfMining' })) };
}

// A KP certificate travels with rough: it must still be valid on the day the parcel leaves.
function kpExpiry(docs, goods, now) {
  if (goods.form !== 'rough' && goods.form !== 'mixed') return null;
  const shippedOn = exportDate(docs) || parseDate(now) || new Date().toISOString().slice(0, 10);
  for (const doc of docs.filter((d) => d.docType === 'kp_certificate')) {
    const expiry = parseDate(getField(doc, 'kp.expiryDate'));
    if (expiry && expiry < shippedOn) {
      const number = getField(doc, 'kp.certificateNumber') || getField(doc, 'doc.number');
      const name = number ? `KP certificate ${number}` : 'The KP certificate';
      return { text: `${name} expired on ${formatDate(expiry)}, before the parcel left on ${formatDate(shippedOn)}.`, docIds: [doc.id], keys: ['kp.expiryDate'] };
    }
  }
  return null;
}

// Two shipment papers that disagree on natural or lab-grown, when the stones do not explain it.
function documentNatureConflict(docs, stones) {
  const stoneNatures = new Set(stones.map((stone) => stone.growth).filter(Boolean));
  if (stoneNatures.size > 1) return null; // a mixed parcel: papers may name both
  const claims = docs
    .filter((doc) => PARCEL_DOC_TYPES.includes(doc.docType) && doc.docType !== 'lab_report')
    .map((doc) => ({ doc, nature: documentNature(doc) }))
    .filter((claim) => claim.nature);
  const natural = claims.find((claim) => claim.nature === 'natural');
  const labGrown = claims.find((claim) => claim.nature === 'lab-grown');
  if (!natural || !labGrown) return null;
  return {
    text: `The ${docWord(natural.doc)} says natural but the ${docWord(labGrown.doc)} says lab-grown.`,
    docIds: [natural.doc.id, labGrown.doc.id],
    keys: ['goods.nature'],
  };
}

function missingText(item, ref, docs) {
  if (item.label === 'Packing list') {
    // The agents can draft a packing list from a chat, an email or the invoice lines.
    const from = docs.some((doc) => doc.docType === 'whatsapp_chat') ? 'the chat'
      : docs.some((doc) => doc.docType === 'email') ? 'the email'
        : docs.some((doc) => doc.docType === 'commercial_invoice' && docLines(doc).length) ? 'the invoice' : null;
    if (from) return `Packing list for ${ref} is not on file. Upload it or ask the agents to draft it from ${from}.`;
  }
  return `${item.label} for ${ref} is not on file. Upload it.`;
}

function fieldEvidence(docs, keys) {
  const evidence = [];
  for (const doc of docs) {
    for (const key of keys) if (getField(doc, key)) evidence.push({ docId: doc.id, key });
  }
  return evidence;
}

function partyEvidence(docs, name) {
  const evidence = [];
  for (const doc of docs) {
    for (const key of ['exporter.name', 'consignee.name', 'buyer.name', 'supplier.name']) {
      if (getField(doc, key) === name) evidence.push({ docId: doc.id, key });
    }
  }
  return evidence;
}

function firstDoc(stone) {
  const source = (stone.sources || [])[0];
  return source ? source.docId : null;
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((item) => {
    if (!item || !item.docId) return false;
    const key = `${item.docId}|${item.key || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => (item.key ? { docId: item.docId, key: item.key } : { docId: item.docId }));
}

function dedupeRequired(required) {
  const seen = new Set();
  return required.filter((item) => {
    if (seen.has(item.kind)) return false;
    seen.add(item.kind);
    return true;
  });
}
