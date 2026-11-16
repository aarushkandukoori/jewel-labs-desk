// The origin rules. Deterministic: the same papers always give the same checks, papers and questions.
// Every check names its rule ('compliance.js#<code>') and the papers it looked at, so a person can see why.
//
// Sources, checked against the official texts:
// - EU: AWDC EU Import Guidelines, update 1 January 2026 (Due Diligence Statement on Diamond Origin for
//   natural polished 0.50 ct and up, KP certificates with mining countries for rough, Diamond Office
//   G7/GF declaration template for lab-grown), and the European Commission FAQ on diamonds (17 Dec 2025).
// - US: CBP CSMS #61912001 (self-certification for non-industrial diamonds 0.50 ct and up, diamond
//   jewellery and unsorted diamonds; one per entry, company letterhead, PDF, DocCode CBP03).
// - Kimberley Process: every international shipment of rough travels with a validated KP certificate
//   (KPCS Section III; US Clean Diamond Trade Act, 19 U.S.C. 3903).
//
// When in doubt the rules hold the shipment for a person or prepare a statement to be safe: they never call a
// shipment ready to sign on a guess.
//
// evaluate() is a short driver: it builds one context and runs the rule sections in order. Each section
// is a plain function below, so it can be read (and tested) on its own.
import { getField, getFieldInfo, docLines, parseDate, formatDate, formatCarat, shortHash, calendarDay } from './fields.js';
import {
  normalizeCountry, countryName, isEU, splitCountries, checkReportNumber, labFromReportNumber, natureFromText, formFromText,
  timeZoneOf, normalizeEori,
} from './formats.js';
import { classifyGoods, documentNature, declaredNature, perStoneCarat, atOrAboveHalf, PARCEL_DOC_TYPES } from './goods.js';
import { findRussia, describeHit, totalsProblems, partiesProblems, datesProblems, exportDate, docWord } from './consistency.js';
import {
  findStoneIssues, stoneLabel, shipmentDocuments, stoneAnswerKey, shipmentAnswer, isAgentDraft, isUncheckedDraft,
} from '../records/stones.js';

export const RULES_VERSION = 'compliance.js 1.1';
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

// The one answer that clears a possible OFAC SDN match, and the one that accepts papers that still disagree.
const DIFFERENT = 'Different';
const SHIP_WITH_DIFFERENCE = 'Ship with this difference';
const USE_DRAFT = 'Yes, use it as our packing list';
const USE_OFFLINE_READING = 'Use the values as read';

// Each rule section is exported too, so a test can run one on its own: ruleContext(input), then the section.

/**
 * Run every rule on one shipment.
 * documents: all documents of the workspace (the shipment's own are picked by shipment.documentIds; rough-side
 *   papers the stones point to are read too). stones: from matchStones. screenings: OFAC screen results for the
 *   shipment's parties ({ name, status, best, role? }); null means not screened yet. now: Date or ISO string.
 * @returns {{ checks: object[], required: object[], questions: object[], status: string, summary: {passed:number,total:number} }}
 */
export function evaluate({ shipment, documents = [], stones = [], house = null, screenings = null, now = new Date() }) {
  const ctx = ruleContext({ shipment, documents, stones, house, screenings, now });
  whereAndWhat(ctx);
  halfCaratStones(ctx);
  packRequired(ctx);
  euRequirements(ctx);
  usRequirement(ctx);
  russiaAnywhere(ctx);
  kpCertificate(ctx);
  stoneChecks(ctx);
  papersAgree(ctx);
  papersOnFile(ctx);
  readWithoutAi(ctx);
  sanctionsCheck(ctx);

  const { checks, questions, goods, regime } = ctx;
  const status = checks.some((c) => c.severity === 'fail') ? 'held_for_review' : questions.length ? 'questions' : 'ready_to_sign';
  const passed = checks.filter((c) => c.severity === 'pass' || c.severity === 'info').length;
  return { checks, required: dedupeRequired(ctx.required), questions, status, summary: { passed, total: checks.length }, goods, regime };
}

/** Everything the rule sections share: the papers, what the goods are, and check() / ask() to record results. */
export function ruleContext({ shipment, documents, stones, house, screenings, now }) {
  const docs = shipmentDocuments(shipment, documents);
  const ids = new Set(docs.map((doc) => doc.id));
  // Rough-side papers the stones point to (they may be filed under another shipment).
  const sourceIds = new Set(stones.flatMap((stone) => (stone.sources || []).map((s) => s.docId)));
  const related = [...docs, ...documents.filter((doc) => sourceIds.has(doc.id) && !ids.has(doc.id))];

  const goods = classifyGoods({ documents: docs.filter((doc) => PARCEL_DOC_TYPES.includes(doc.docType)), stones });
  // When the papers do not say, a person's answer on the shipment does ("Natural", "Polished").
  const answered = shipment.goods || {};
  if (goods.nature === 'unknown') goods.nature = natureFromText(answered.nature) || 'unknown';
  if (goods.form === 'unknown') goods.form = formFromText(answered.form) || 'unknown';
  const destination = normalizeCountry(shipment.destinationCountry);
  const regime = regimeOf(destination);
  const natural = goods.nature === 'natural' || goods.nature === 'mixed';
  // A rough parcel, or jewellery that ships with loose rough.
  const rough = goods.form === 'rough' || goods.form === 'mixed' || (goods.loose || []).includes('rough');

  const ctx = {
    shipment, documents, stones, house, screenings, docs, related,
    docsById: new Map(documents.map((doc) => [doc.id, doc])),
    ref: shipment.ref || 'this shipment',
    goods,
    destination,
    direction: String(shipment.direction || 'unknown').toLowerCase(),
    regime,
    natural,
    labGrown: goods.nature === 'lab-grown' || goods.nature === 'mixed',
    // Until a paper or a person says natural or lab-grown, the natural rules apply, to be safe.
    maybeNatural: goods.nature !== 'lab-grown',
    rough,
    // Natural rough into the EU: KP certificate with the mining countries and Diamond Office verification.
    // Industrial diamonds are outside Article 3p, so for them only the Kimberley Process applies.
    euRough: regime === 'EU' && natural && rough && !goods.industrial,
    // The house's own calendar day: a KP certificate that expired yesterday in Surat has expired, whatever UTC says.
    today: now instanceof Date ? calendarDay(now, timeZoneOf(house && house.country)) : parseDate(now),
    stoneIssues: findStoneIssues({ stones, documents, shipment }),
    checks: [],
    required: [],
    questions: [],
  };
  ctx.check = (code, severity, title, detail, evidence = [], extra = {}) => ctx.checks.push({
    id: `chk_${shortHash(`${shipment.id}|${code}`)}`,
    shipmentId: shipment.id,
    code,
    severity,
    title,
    detail,
    evidence: dedupeEvidence(evidence),
    rule: `compliance.js#${code}`,
    ...extra,
  });
  // key is where the pipeline keeps the answer: a field key (written into that field, of docId when given), or a
  // rules-only key the rules read back from shipment.answers ('stone.<ref>.carat', 'sanctions.<name>.<listed>',
  // 'house.eori'). check names the rule that asked.
  // dedupeKey says when two questions are the same one, so a question whose wording changes as papers arrive
  // ("... on the invoice" becomes "... on the packing list and the invoice") is not asked again.
  ctx.ask = (code, kind, text, extra = {}) => ctx.questions.push({
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
  ctx.evidenceOf = (problem) => problem.docIds.filter(Boolean).map((docId) => ({ docId, key: problem.keys ? problem.keys[0] : undefined }));
  return ctx;
}

// ---------- where it goes and what it is ----------

/** Destination, export or import, natural or lab-grown and rough, polished or jewellery. */
export function whereAndWhat(ctx) {
  const { check, ask, docs, ref, goods, destination, direction, regime, house } = ctx;
  if (destination) {
    const words = { EU: 'EU rules apply.', US: 'US rules apply.', UK: 'UK rules: no statement template yet, the pack carries the evidence.', OTHER: 'No EU or US origin statement is needed.' };
    check('destination_regime', 'pass', 'Destination', `${countryName(destination)}. ${words[regime]}`, fieldEvidence(docs, ['goods.destinationCountry', 'consignee.country', 'consignee.address']));
  } else {
    check('destination_regime', 'warn', 'Destination', 'No paper names the destination country.');
    ask('destination_regime', 'missing_field', `Where is ${ref} going? No paper names the destination country.`, { key: 'goods.destinationCountry' });
  }

  if (direction === 'export' || direction === 'import') {
    const detail = direction === 'export'
      ? `Export${ctx.shipment.originCountry ? ` from ${countryName(ctx.shipment.originCountry)}` : ''}.`
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
}

/**
 * The 0.50 ct threshold of the EU and US rules. It applies to each stone (EC FAQ Questions 2 and 15), so a lot whose
 * average is under 0.50 ct may still hold bigger stones, and a stone with no carat may be one.
 */
export function halfCaratStones(ctx) {
  const { goods, stones } = ctx;
  let detail = 'Stone sizes are not listed yet.';
  if (goods.sizesKnown) {
    const largest = `largest ${formatCarat(goods.maxCarat)} ct`;
    if (goods.stonesAtOrAboveHalf > 0) detail = `${goods.stonesAtOrAboveHalf} of ${goods.stoneCount} stones are 0.50 ct or more (${largest}).`;
    else if (goods.lotsMayReachHalf > 0) detail = 'No stone is known to reach 0.50 ct.';
    else if (goods.sizeUnknown > 0) detail = `No stone of known size reaches 0.50 ct (${largest}).`;
    else detail = `No stone reaches 0.50 ct (${largest}).`;
    if (stones.some((stone) => stone.pieces > 1 && atOrAboveHalf(perStoneCarat(stone)))) detail += ' Lots whose average is 0.50 ct or more count in full.';
    if (goods.lotsMayReachHalf > 0) detail += ` ${goods.lotsMayReachHalf} stones in lots may reach 0.50 ct: an average size does not rule out bigger stones.`;
    if (goods.sizeUnknown > 0) detail += ` ${goods.sizeUnknown} ${goods.sizeUnknown === 1 ? 'stone has' : 'stones have'} no carat on file.`;
  }
  ctx.check('half_carat_stones', 'info', 'Stones of 0.50 ct and up', detail);

  // The EU statement and the US certificate cover natural diamonds only, so the threshold is tested on them.
  const natural = goods.naturalSizes;
  ctx.naturalInScope = !natural.sizesKnown || natural.atOrAboveHalf > 0 || natural.maybe > 0 || natural.unknown > 0;
  ctx.safeNote = safeNote(goods);
}

/** Why a statement is prepared to be safe, or '' when the papers show it is needed. */
function safeNote(goods) {
  const natural = goods.naturalSizes;
  if (goods.nature === 'unknown') return ' The papers do not say yet whether the stones are natural, so it is prepared to be safe.';
  if (!natural.sizesKnown) return ' Stone sizes are not listed, so it is prepared to be safe.';
  if (natural.atOrAboveHalf > 0) return '';
  if (natural.maybe > 0) return ' Lots give only an average size, so it is prepared to be safe.';
  if (natural.unknown > 0) return ' Some stones have no carat on file, so it is prepared to be safe.';
  return '';
}

// ---------- what the destination requires ----------

/** Every shipment gets its export or import pack. */
export function packRequired(ctx) {
  const { direction, regime } = ctx;
  ctx.required.push(direction === 'import'
    ? { kind: 'import_pack', reason: REASONS.import_pack, signer: 'importer', regime }
    : { kind: 'export_pack', reason: REASONS.export_pack, signer: 'exporter', regime });
}

/**
 * EU: Due Diligence Statement, KP certificate for rough, G7/GF template (AWDC EU Import Guidelines, 1 Jan 2026;
 * EC FAQ Questions 11 to 15). Industrial diamonds are outside Article 3p (EC FAQ Question 12).
 */
export function euRequirements(ctx) {
  const { check, ask, goods, regime, maybeNatural, labGrown, docs, ref } = ctx;
  if (regime !== 'EU') return;
  const loose = goods.loose || [];
  const polished = ['polished', 'mixed', 'unknown'].includes(goods.form) || loose.includes('polished') || loose.includes('unknown');
  if (goods.industrial) {
    if (maybeNatural) check('eu_dds_required', 'info', 'EU Due Diligence Statement', 'Not required: industrial diamonds are outside Article 3p.');
  } else if (maybeNatural && polished) {
    if (ctx.naturalInScope) {
      ctx.required.push({ kind: 'eu_dds', reason: REASONS.eu_dds, signer: 'importer', regime });
      check('eu_dds_required', 'info', 'EU Due Diligence Statement', `Required. The importer signs it.${ctx.safeNote}`);
      importerEori(ctx);
    } else {
      const which = goods.nature === 'mixed' ? 'no natural stone' : 'no stone';
      check('eu_dds_required', 'info', 'EU Due Diligence Statement', `Not required: ${which} reaches 0.50 ct.`);
    }
  }
  if (ctx.euRough) {
    // The rough's own KP certificate, filed with this shipment: one from an earlier leg does not cover this parcel.
    const kp = kpOnFile(docs, []);
    ctx.required.push({ kind: 'g7_gf_declaration', reason: REASONS.g7_rough, signer: 'importer', regime });
    if (!kp.number) {
      check('eu_kp_rough', 'fail', 'KP certificate for EU rough', 'Rough into the EU needs a KP certificate. None is on file.');
      ask('eu_kp_rough', 'missing_document', `KP certificate for ${ref} is not on file. Upload it with the countries of mining listed.`, { docType: 'kp_certificate' });
    } else if (!kp.countries.length) {
      check('eu_kp_rough', 'fail', 'KP certificate for EU rough', `KP certificate ${kp.number} does not list the countries of mining.`, kp.evidence);
      ask('eu_kp_rough', 'missing_field', `KP certificate ${kp.number} does not list the countries of mining. Upload a copy that does.`, { key: 'kp.countriesOfMining', docId: kp.docId });
    } else {
      check('eu_kp_rough', 'pass', 'KP certificate for EU rough', `KP certificate ${kp.number} lists ${countryList(kp.countries)}.`, kp.evidence);
    }
    check('eu_rough_diamond_office', 'info', 'Diamond Office verification', 'Natural rough of 0.50 ct and up entering the EU, in any member state, '
      + 'is presented to the Diamond Office in Antwerp (FPS Economy, Hoveniersstraat 22) for verification and a G7 certificate (EC FAQ Question 11).');
  }
  if (labGrown) {
    ctx.required.push({ kind: 'g7_gf_declaration', reason: REASONS.g7_synthetic, signer: 'importer', regime });
    check('eu_synthetic_g7', 'info', 'Diamond Office G7/GF declaration', 'Required for lab-grown stones. The importer signs it.');
  }
}

/** On an import the house is the importer: its EORI number goes on the EU statement (EC FAQ Question 23). */
export function importerEori(ctx) {
  const { check, ask, direction, house, shipment } = ctx;
  if (direction !== 'import') return; // on an export the consignee writes in its own EORI number
  const eori = houseEori(house, shipment);
  const answer = shipmentAnswer(shipment, 'house.eori');
  if (eori) {
    check('importer_eori', 'pass', 'EORI number', `EORI number ${eori} goes on the EU statement.`);
  } else if (answer) {
    check('importer_eori', 'warn', 'EORI number', `"${answer}" is not an EORI number, so the EU statement has none yet.`);
    ask('importer_eori', 'missing_field', `"${answer}" does not look like an EORI number (two letters, then up to 15 letters or digits). What is the house's EORI number?`, {
      key: 'house.eori', dedupeKey: `importer_eori|again|${answer}`,
    });
  } else {
    check('importer_eori', 'warn', 'EORI number', 'The EU statement needs the house\'s EORI number. It is not in the house profile.');
    ask('importer_eori', 'missing_field', 'What is the house\'s EORI number? It goes on the EU statement.', { key: 'house.eori' });
  }
}

/**
 * The house's EORI number: from the house profile, or a person's answer on this shipment when it looks like one
 * (two letters for the country, then up to 15 letters or digits: "BE0123456789").
 */
export function houseEori(house, shipment) {
  const fromProfile = [house && house.eori, house && house.letterhead && house.letterhead.eori]
    .find((value) => value && String(value).trim());
  return fromProfile ? String(fromProfile).trim() : normalizeEori(shipmentAnswer(shipment, 'house.eori'));
}

/** US: the importer's self-certification (CBP CSMS #61912001). */
export function usRequirement(ctx) {
  const { check, goods, regime, maybeNatural } = ctx;
  if (regime !== 'US') return;
  const covered = (maybeNatural && !goods.industrial && ctx.naturalInScope) || goods.form === 'jewelry' || goods.unsorted;
  if (covered) {
    ctx.required.push({ kind: 'us_cbp_certificate', reason: REASONS.us_cbp, signer: 'us_importer', regime });
    // Jewellery and unsorted diamonds are covered at any weight; loose stones by the 0.50 ct threshold.
    const safe = goods.form === 'jewelry' || goods.unsorted ? '' : ctx.safeNote;
    check('us_cbp_cert', 'info', 'US CBP self-certification', `Required: one per entry, on letterhead, DocCode CBP03. The US importer uploads it.${safe}`);
  } else {
    let why = goods.nature === 'mixed' ? 'no natural stone reaches 0.50 ct' : 'no stone reaches 0.50 ct';
    if (goods.nature === 'lab-grown') why = 'the parcel is lab-grown';
    else if (goods.industrial) why = 'the diamonds are industrial';
    check('us_cbp_cert', 'info', 'US CBP self-certification', `Not required: ${why}.`);
  }
}

// ---------- origin ----------

/**
 * No paper or stone may point to Russia, and the goods may not have been exported from or transited through it
 * (Article 3p of Council Regulation (EU) No 833/2014, EC FAQ Question 2; E.O. 14068).
 */
export function russiaAnywhere(ctx) {
  const { check, related, stones, docsById } = ctx;
  const russia = findRussia(related, stones);
  if (russia.length) {
    const shown = russia.slice(0, 3).map((hit) => describeHit(hit, docsById)).join('; ');
    check('russia_anywhere', 'fail', 'Russia anywhere', `Russia appears in the papers: ${shown}.`, russia.map((hit) => ({ docId: hit.docId, key: hit.key })));
  } else {
    check('russia_anywhere', 'pass', 'Russia anywhere', 'No paper or stone points to Russia.');
  }
}

/**
 * The KP certificate. Rough crosses a border only with its own validated KP certificate (KPCS Section III; US Clean
 * Diamond Trade Act), so a rough parcel without one on file fails, wherever it goes. Polished stones trace back to
 * the KP certificate of their rough: there a missing one is a warning. Only the EU needs the mining countries listed.
 * (eu_kp_rough above asks the EU question, so none is asked twice.)
 */
export function kpCertificate(ctx) {
  const { check, ask, natural, rough, euRough, docs, related, stones, ref } = ctx;
  if (!natural) return;
  const kp = rough ? kpOnFile(docs, []) : kpOnFile(related, stones);
  if (kp.number) {
    check('kp_present', 'pass', 'KP certificate', `KP certificate ${kp.number} is linked to the rough.`, kp.evidence);
    if (kp.countries.length) check('kp_countries_listed', 'pass', 'Countries of mining', `Mined in ${countryList(kp.countries)}.`, kp.evidence);
    else check('kp_countries_listed', euRough ? 'fail' : 'warn', 'Countries of mining', `KP certificate ${kp.number} does not list the countries of mining.`, kp.evidence);
  } else if (rough) {
    check('kp_present', 'fail', 'KP certificate', 'No KP certificate is on file for this rough. Rough crosses a border only with one.');
    if (!euRough) ask('kp_present', 'missing_document', `KP certificate for ${ref} is not on file. Rough crosses a border only with one. Upload it.`, { docType: 'kp_certificate' });
  } else {
    check('kp_present', 'warn', 'KP certificate', 'No KP certificate is linked to these stones. The statement is stronger with one.');
  }
}

// ---------- stones ----------

/** Grading reports, report number formats, duplicate reports and stones that disagree across papers. */
export function stoneChecks(ctx) {
  const { check, ask, goods, natural, stones, ref, stoneIssues } = ctx;
  // Polished stones carry grading reports; rough, jewellery and industrial diamonds do not.
  const naturalStones = stones.filter((stone) => stone.growth !== 'lab-grown');
  if (natural && !goods.industrial && ['polished', 'mixed', 'unknown'].includes(goods.form)) {
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

  problemCheck(ctx, 'duplicate_reports', 'Duplicate reports', stoneIssues.filter((i) => i.code === 'duplicate_report'),
    'No report number is listed twice.',
    (issue) => ({ kind: 'mismatch', text: `${issue.detail} Which is right?` }));

  stoneDetails(ctx);
}

/**
 * Weight and grades that differ between the lab report, the packing list and the invoice. A person picks the
 * right value; the stone then carries it (records/stones.js). While papers in the envelope still print another
 * value, the shipment waits until corrected copies arrive or a person accepts shipping with the difference.
 */
export function stoneDetails(ctx) {
  const { check, ask, ref, stoneIssues, evidenceOf } = ctx;
  const problems = stoneIssues.filter((i) => ['carat_mismatch', 'grade_mismatch', 'report_not_on_list'].includes(i.code));
  const title = 'Stones agree across papers';
  if (!problems.length) {
    check('stone_details', 'pass', title, 'Weight and grades agree on the lab reports, packing list and invoice.');
    return;
  }
  const open = problems.filter((issue) => !issue.accepted);
  if (!open.length) {
    check('stone_details', 'info', title, `Accepted by the house: ${problems.map((issue) => issue.detail).join(' ')}`, problems.flatMap(evidenceOf), { accepted: true });
    return;
  }
  check('stone_details', 'warn', title, problems.map((issue) => issue.detail).join(' '), problems.flatMap(evidenceOf));
  for (const issue of open) {
    // A stone's problem is the same question while the same values disagree, whatever papers name them.
    const dedupeKey = ['stone_details', issue.code, issue.ref, issue.field || '', (issue.values || []).join(',')].join('|');
    const docId = issue.docIds[issue.docIds.length - 1];
    if (issue.code === 'report_not_on_list') {
      // The answer goes to 'stone.<report>.onShipment' (records/stones.js reads it): "No" leaves the report out.
      const key = stoneAnswerKey(issue.ref, 'onShipment');
      if (issue.unclear) {
        ask('stone_details', 'confirm', `The answer "${issue.unclear}" is neither Yes nor No. ${issue.detail} Is it part of ${ref}?`, {
          key, docId, options: ['Yes', 'No'], dedupeKey: `${dedupeKey}|again|${issue.unclear}`,
        });
      } else {
        ask('stone_details', 'confirm', `${issue.detail} Is it part of ${ref}?`, { key, docId, options: ['Yes', 'No'], dedupeKey });
      }
      continue;
    }
    const key = stoneAnswerKey(issue.ref, issue.field);
    const show = (value) => (issue.field === 'carat' ? `${value} ct` : value);
    const options = (issue.values || []).map(show);
    if (issue.chosen !== undefined) {
      // A value was chosen, but some papers in the envelope still print another one.
      const chosen = issue.field === 'carat' ? `${formatCarat(issue.chosen)} ct` : issue.chosen;
      ask('stone_details', 'confirm', `${capitalize(issue.offText)} for ${lowerFirst(issue.label)}, not ${chosen}. Upload corrected copies, or ship with this difference.`, {
        key: `${key}.accepted`, docId: issue.offDocIds[0] || docId, options: [SHIP_WITH_DIFFERENCE], dedupeKey: `${dedupeKey}|chosen|${chosen}`,
      });
    } else if (issue.unclear) {
      ask('stone_details', 'mismatch', `The answer "${issue.unclear}" names none of these values. ${issue.detail} Which is right?`, {
        key, docId, options, dedupeKey: `${dedupeKey}|again|${issue.unclear}`,
      });
    } else {
      ask('stone_details', 'mismatch', `${issue.detail} Which is right?`, { key, docId, options, dedupeKey });
    }
  }
}

// ---------- papers agree with each other ----------

/** Totals, party names, dates in order (and a rough parcel's KP still valid), natural or lab-grown. */
export function papersAgree(ctx) {
  const { check, ask, docs, ref, stones, stoneIssues, evidenceOf } = ctx;
  problemCheck(ctx, 'totals_consistency', 'Totals', totalsProblems(docs, ref),
    'Pieces, carats and value agree across the papers.',
    (problem) => ({ kind: 'mismatch', text: `${problem.text} Which is right?` }));

  problemCheck(ctx, 'parties_consistency', 'Exporter and consignee', partiesProblems(docs, ref),
    'Exporter and consignee names agree across the papers.',
    (problem) => ({ kind: 'confirm', text: `${problem.text} Same company?`, options: ['Same company', 'Different companies'] }));

  // Dates in order, and a rough parcel's KP certificate still valid when it leaves (or, on an import, arrives).
  const dateProblems = datesProblems(docs, ref);
  const expired = kpExpiry(ctx);
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
}

// ---------- papers on file ----------

/**
 * The papers customs reads for this direction, and the Let Export Order on the shipping bill. A packing list the
 * agents drafted counts only once a person checked it against the parcel: until then it is only a draft.
 */
export function papersOnFile(ctx) {
  const { check, ask, shipment, docs, ref, direction } = ctx;
  // A paper the house marked as not needed (shipment.notNeeded, from an answer) counts as settled.
  const waived = new Set(shipment.notNeeded || []);
  const needed = REQUIRED_DOCS[direction === 'import' ? 'import' : 'export'];
  const notNeeded = needed.filter((item) => item.types.some((type) => waived.has(type)));
  const counts = (doc) => !isUncheckedDraft(doc);
  const missing = needed.filter((item) => !notNeeded.includes(item) && !docs.some((doc) => counts(doc) && item.types.includes(doc.docType)));
  const drafts = docs.filter(isUncheckedDraft);
  const draft = drafts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  const shippingBill = docs.find((doc) => doc.docType === 'shipping_bill');
  const noLeo = direction !== 'import' && shippingBill && !waived.has('shipping_bill') && !parseDate(getField(shippingBill, 'leo.date'));
  const waivedText = notNeeded.length ? ` Marked not needed by the house: ${notNeeded.map((item) => item.word).join(', ')}.` : '';
  if (missing.length || noLeo) {
    const names = missing.map((item) => item.word);
    const draftText = draft && missing.some((item) => item.types.includes('packing_list'))
      ? ' The packing list on file is the agents\' draft: a person checks it before it counts.' : '';
    const detail = [names.length ? `Not on file: ${names.join(', ')}.${draftText}` : '', noLeo ? 'The shipping bill has no Let Export Order date.' : ''].filter(Boolean).join(' ') + waivedText;
    check('required_documents', 'warn', 'Papers on file', detail, docs.map((doc) => ({ docId: doc.id })));
    for (const item of missing) {
      if (draft && item.types.includes('packing_list')) {
        ask('required_documents', 'confirm', `The agents drafted the packing list for ${ref}. Check every line against the parcel. Is it right?`, {
          key: 'doc.checkedBy', docId: draft.id, options: [USE_DRAFT], dedupeKey: `packing_list_draft|${draft.sha256 || draft.id}`,
        });
      } else {
        ask('required_documents', 'missing_document', missingText(item, ref, docs), { docType: item.types[0] });
      }
    }
    if (noLeo) {
      const number = getField(shippingBill, 'shippingBill.number') || getField(shippingBill, 'doc.number');
      const name = number ? `Shipping bill ${number}` : 'The shipping bill';
      ask('required_documents', 'missing_field', `${name} for ${ref} has no Let Export Order date. Upload the copy with the LEO.`, { key: 'leo.date', docId: shippingBill.id, docType: 'shipping_bill' });
    }
  } else {
    const insured = docs.some((doc) => doc.docType === 'insurance_certificate') ? ' Insurance certificate on file too.' : '';
    const checked = docs.find((doc) => isAgentDraft(doc) && !isUncheckedDraft(doc));
    const checkedText = checked ? ` The packing list is the agents' draft, checked by ${checkedByName(checked)}.` : '';
    const onFile = needed.filter((item) => !notNeeded.includes(item)).map((item) => item.label);
    check('required_documents', 'pass', 'Papers on file', `${onFile.join(', ')} ${onFile.length === 1 ? 'is' : 'are'} on file.${insured}${checkedText}${waivedText}`, docs.map((doc) => ({ docId: doc.id })));
  }
}

/**
 * Papers the offline reader read because an AI call failed (intake marks them needsAiRead when the AI may read them
 * later, and the reader leaves a "Read offline: ..." warning). The worker reads those again once the AI is back.
 * Until then their values are less sure, so a person confirms them first; the question goes away by itself when the
 * AI reads them again.
 */
export function readWithoutAi(ctx) {
  const { check, ask, docs, ref } = ctx;
  const offline = docs.filter((doc) => doc.kind !== 'chat' && doc.kind !== 'email'
    && (doc.needsAiRead || (doc.warnings || []).some((warning) => /^Read offline:/.test(String(warning)))));
  if (!offline.length) return;
  const names = offline.map((doc) => doc.fileName || docWord(doc)).join(', ');
  const ids = offline.map((doc) => doc.id).sort();
  const one = offline.length === 1;
  const later = offline.every((doc) => doc.needsAiRead); // the AI reads them again once it answers
  const next = later ? `${one ? 'It is' : 'They are'} read again when the AI is back.` : 'Check the values against the paper.';
  check('read_offline', 'warn', 'Read without the AI', `${one ? '1 paper was' : `${offline.length} papers were`} read by the offline reader `
    + `because a call to the AI failed: ${names}. ${next}`, offline.map((doc) => ({ docId: doc.id })));
  ask('read_offline', 'confirm', `${names} on ${ref} ${one ? 'was' : 'were'} read by the offline reader because a call to the AI failed. `
    + `Check the values against the paper${later ? ', or wait until the agents read it again' : ''}.`, {
    docId: ids[0], options: [USE_OFFLINE_READING], dedupeKey: `read_offline|${ids.join(',')}`,
  });
}

function checkedByName(doc) {
  const field = getFieldInfo(doc, 'doc.checkedBy');
  return (field && field.by) || 'the house';
}

// ---------- sanctions ----------

/**
 * OFAC SDN screen of every party. Results come from the Sanctions agent: 'clear', 'review', 'match' or
 * 'not_screened'. A possible match is settled only when a person answers its question: "Same" makes it a match,
 * "Different" clears it. Until then it holds the shipment for a person.
 */
export function sanctionsCheck(ctx) {
  const { check, ask, docs, house, screenings, shipment } = ctx;
  if (!Array.isArray(screenings) || !screenings.length) {
    check('sanctions', 'fail', 'OFAC SDN screen', 'The parties have not been screened against the OFAC SDN list yet.');
    return;
  }
  const said = (s) => String(shipmentAnswer(shipment, sanctionsKey(s)) || '').replace(/[.!]+$/, '').trim().toLowerCase();
  const reviewed = screenings.filter((s) => s.status === 'review');
  const confirmed = reviewed.filter((s) => said(s) === 'same');
  const cleared = reviewed.filter((s) => said(s) === DIFFERENT.toLowerCase());
  const matches = [...screenings.filter((s) => s.status === 'match'), ...confirmed];
  const reviews = reviewed.filter((s) => !confirmed.includes(s) && !cleared.includes(s));
  const unscreened = screenings.filter((s) => !['clear', 'review', 'match'].includes(s.status));
  const screeningOff = Boolean(house && house.permissions && house.permissions.ofacScreen === false);
  const names = (list) => list.map((s) => s.name).join(', ');
  const listed = (s) => (s.best && s.best.sdnName ? ` (${s.best.sdnName})` : '');
  const parts = [];
  let severity = 'pass';

  if (matches.length) {
    severity = 'fail';
    parts.push(`On the OFAC SDN list: ${matches.map((s) => `${s.name}${listed(s)}`).join(', ')}.`);
    if (confirmed.length) parts.push(`The house confirmed ${names(confirmed)} ${confirmed.length === 1 ? 'is' : 'are'} the listed name.`);
  }
  if (reviews.length) {
    severity = 'fail';
    parts.push(`Possible matches to review: ${names(reviews)}.`);
    for (const s of reviews) {
      const like = s.best && s.best.sdnName ? ` looks like ${s.best.sdnName}` : ' is close to a listed name';
      ask('sanctions', 'confirm', `Possible OFAC SDN match: ${s.name}${like}. Confirm they are different before signing.`, { key: sanctionsKey(s), options: [DIFFERENT, 'Same'] });
    }
  }
  if (cleared.length) parts.push(`Checked by the house, not the listed name: ${cleared.map((s) => `${s.name}${s.best && s.best.sdnName ? ` (not ${s.best.sdnName})` : ''}`).join(', ')}.`);
  if (unscreened.length && screeningOff) {
    // Screening off is the house's choice, but the pack must not read as screened: it shows under "To check".
    if (severity === 'pass') severity = 'warn';
    parts.push('OFAC screening is off for this house.');
  } else if (unscreened.length) {
    severity = 'fail';
    parts.push(`Not screened yet: ${names(unscreened)}.`);
  }
  if (severity === 'pass') {
    const compared = screenings.reduce((sum, s) => sum + (s.compared || 0), 0);
    const clear = screenings.length - cleared.length;
    // A clear result holds only for the list of that date, so the date is part of the result.
    const listDate = screenings.map((s) => s.listDate).find(Boolean);
    const list = `the OFAC SDN list${listDate ? ` of ${formatDate(listDate)}` : ''}`;
    parts.unshift(`${clear} ${clear === 1 ? 'party' : 'parties'} clear on ${list}${compared ? ` (${compared} similar names compared)` : ''}.`);
  }
  const evidence = [...matches, ...reviews].flatMap((s) => partyEvidence(docs, s.name));
  check('sanctions', severity, 'OFAC SDN screen', parts.join(' '), evidence);
}

/**
 * The answer key for one possible match: the party and the listed entry, so "Different" for one listed name never
 * clears a later hit on another.
 */
export function sanctionsKey(screening) {
  const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const listed = screening.best && (screening.best.uid ?? screening.best.sdnName);
  return `sanctions.${slug(screening.name)}.${slug(listed || 'listed')}`;
}

/**
 * A check that passes when there are no problems, else warns and asks one question per problem.
 * Problems are stone issues ({ detail, docIds }) or paper problems ({ text, docIds, keys }).
 */
function problemCheck(ctx, code, title, problems, okText, makeQuestion) {
  const { check, ask, evidenceOf } = ctx;
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
  const looseWords = { rough: 'loose rough', polished: 'loose polished', unknown: 'loose' };
  const jewellery = goods.form === 'jewelry' && (goods.loose || []).length
    ? `jewellery and ${[...new Set(goods.loose.map((form) => looseWords[form]))].join(' and ')}` : 'jewellery';
  const form = { rough: 'rough', polished: 'polished', jewelry: jewellery, mixed: 'rough and polished', unknown: 'form unknown' }[goods.form];
  const hs = goods.hsCodes.length ? ` (HS ${goods.hsCodes.join(', ')})` : '';
  const mixedNote = goods.nature === 'mixed' ? ' Each stone follows its own rule.' : '';
  return `${nature} ${goods.form === 'unknown' ? `diamonds, ${form}` : `${form} diamonds`}${hs}.${mixedNote}`;
}

function countryList(codes) {
  const names = codes.map(countryName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/**
 * The KP certificate behind the stones: on file with the shipment, or reached through the stones' sources.
 * For a rough parcel pass only its own papers and no stones: the number and countries then come from its own
 * KP certificate, never from a supplier invoice or an earlier leg.
 */
function kpOnFile(papers, stones) {
  const kpDocs = papers.filter((doc) => doc.docType === 'kp_certificate');
  const stoneKp = stones.map((stone) => stone.kp).find((kp) => kp && kp.certificateNumber);
  const doc = kpDocs[0] || null;
  const number = (doc && (getField(doc, 'kp.certificateNumber') || getField(doc, 'doc.number'))) || (stoneKp && stoneKp.certificateNumber) || null;
  const countries = [...new Set([
    ...kpDocs.flatMap((d) => splitCountries(getField(d, 'kp.countriesOfMining'))),
    ...stones.flatMap((stone) => (stone.kp && stone.kp.countries) || []),
  ])];
  return { number, countries, docId: doc ? doc.id : null, evidence: kpDocs.map((d) => ({ docId: d.id, key: 'kp.countriesOfMining' })) };
}

/**
 * A KP certificate travels with rough: it must still be valid on the day the parcel leaves, or on an import the day
 * it was declared (the bill of entry). With no date on the papers, the house's own today counts.
 */
function kpExpiry(ctx) {
  const { docs, direction, rough, today } = ctx;
  if (!rough) return null;
  const entered = direction === 'import'
    ? docs.filter((d) => d.docType === 'bill_of_entry').map((d) => parseDate(getField(d, 'billOfEntry.date')) || parseDate(getField(d, 'doc.date'))).find(Boolean)
    : null;
  const day = entered || exportDate(docs) || today || calendarDay(new Date());
  const when = entered ? 'was declared for import' : 'left';
  for (const doc of docs.filter((d) => d.docType === 'kp_certificate')) {
    const expiry = parseDate(getField(doc, 'kp.expiryDate'));
    if (expiry && expiry < day) {
      const number = getField(doc, 'kp.certificateNumber') || getField(doc, 'doc.number');
      const name = number ? `KP certificate ${number}` : 'The KP certificate';
      return { text: `${name} expired on ${formatDate(expiry)}, before the parcel ${when} on ${formatDate(day)}.`, docIds: [doc.id], keys: ['kp.expiryDate'] };
    }
  }
  return null;
}

/**
 * Natural on one paper and lab-grown on another, when the stones do not explain it: two shipment papers that
 * disagree, or a paper whose own HS code or nature field says the opposite of every stone (HS 7102.39 on an
 * invoice whose stones all read lab-grown).
 */
function documentNatureConflict(docs, stones) {
  const stoneNatures = new Set(stones.map((stone) => stone.growth).filter(Boolean));
  if (stoneNatures.size > 1) return null; // a mixed parcel: papers may name both
  const papers = docs.filter((doc) => PARCEL_DOC_TYPES.includes(doc.docType) && doc.docType !== 'lab_report');
  const claims = papers.map((doc) => ({ doc, nature: documentNature(doc) })).filter((claim) => claim.nature);
  const natural = claims.find((claim) => claim.nature === 'natural');
  const labGrown = claims.find((claim) => claim.nature === 'lab-grown');
  if (natural && labGrown) {
    return {
      text: `The ${docWord(natural.doc)} says natural but the ${docWord(labGrown.doc)} says lab-grown.`,
      docIds: [natural.doc.id, labGrown.doc.id],
      keys: ['goods.nature'],
    };
  }
  const [stoneNature] = [...stoneNatures];
  if (!stoneNature) return null;
  const against = papers.find((doc) => {
    const declared = declaredNature(doc);
    return declared && declared !== stoneNature;
  });
  if (!against) return null;
  const hs = getField(against, 'goods.hsCode');
  return {
    text: `The ${docWord(against)} says ${declaredNature(against)}${hs ? ` (HS ${hs})` : ''} but the stones read ${stoneNature}.`,
    docIds: [against.id],
    keys: [hs ? 'goods.hsCode' : 'goods.nature'],
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
    for (const key of ['exporter.name', 'consignee.name', 'buyer.name', 'supplier.name', 'insured.name']) {
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
