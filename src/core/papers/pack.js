// The export or import pack: handover cover, what is inside the envelope, origin statements, stone list,
// evidence index, sources, then every original document in the order customs reads them.
import { PAPER_KIND_LABELS } from '../types.js';
import { normalizeLab } from '../rules/formats.js';
import { SOURCES, WORDING_VERSION } from './templates.js';
import { nextRef } from './refs.js';
import {
  COLOR, CONTENT_WIDTH, MARGIN, RIGHT_EDGE,
  addPage, drawFooters, drawHandoverBoxes, drawHeader, drawParagraph, drawRows, drawSignatureBlock, drawTable,
  drawText, drawWriteInRow, ensureSpace, finishPaper, fitLine, sectionLabel, startPaper, wrap,
} from './layout.js';
import {
  NOT_ON_FILE, countryName, docTitle, fieldOf, findField, firstOf, formatCarat, formatDay, growthText, isBlank,
  isSampleData, partyLine, sourceText, stoneFacts, stonesText,
} from './format.js';
import { STATEMENT_KINDS, drawStatement, houseName } from './statements.js';
import { appendOriginal, loadOriginal } from './originals.js';

// The order customs reads the papers in. Types not listed (chats, emails, KYC) stay in the evidence index only.
export const CUSTOMS_ORDER = {
  export: [
    'commercial_invoice', 'proforma_invoice', 'packing_list', 'shipping_bill', 'customs_declaration', 'air_waybill',
    'insurance_certificate', 'lab_report', 'kp_certificate', 'supplier_declaration', 'g7_gf_declaration', 'supplier_invoice',
  ],
  import: [
    'commercial_invoice', 'proforma_invoice', 'bill_of_entry', 'customs_declaration', 'air_waybill', 'packing_list',
    'insurance_certificate', 'lab_report', 'kp_certificate', 'supplier_declaration', 'g7_gf_declaration', 'supplier_invoice',
  ],
};

// The papers every shipment should have. Missing ones are listed under "Not on file".
const CORE_PAPERS = {
  export: [['commercial_invoice', 'Commercial invoice'], ['packing_list', 'Packing list'], ['shipping_bill', 'Shipping bill'], ['air_waybill', 'Air waybill']],
  import: [['commercial_invoice', 'Commercial invoice'], ['bill_of_entry', 'Bill of entry'], ['air_waybill', 'Air waybill'], ['packing_list', 'Packing list']],
};

/** Documents that go in the envelope, sorted the way customs reads them (grading reports by number). */
export function customsOrder(documents, direction) {
  const order = CUSTOMS_ORDER[direction] || CUSTOMS_ORDER.export;
  const sortKey = (doc) => (doc.docType === 'lab_report' ? fieldOf(doc, 'lab.reportNumber') || '' : '');
  return (documents || [])
    .map((doc, index) => ({ doc, index }))
    .filter(({ doc }) => order.includes(doc.docType))
    .sort((a, b) => order.indexOf(a.doc.docType) - order.indexOf(b.doc.docType)
      || sortKey(a.doc).localeCompare(sortKey(b.doc), 'en', { numeric: true })
      || a.index - b.index)
    .map(({ doc }) => doc);
}

/** The pack needs RULES_VERSION from the rules module. Loaded lazily so papers still work without it. */
async function loadRulesVersion() {
  try {
    const rules = await import('../rules/compliance.js');
    return rules.RULES_VERSION || null;
  } catch {
    return null;
  }
}

function pageText(range) {
  if (!range) return 'Not attached';
  return range.first === range.last ? `Page ${range.first}` : `Pages ${range.first} to ${range.last}`;
}

/** Facts read once and shared by every page of the pack. */
function shipmentFacts(shipment, documents, direction) {
  const docs = documents || [];
  return {
    invoice: firstOf(shipment.invoiceNumber, findField(docs, 'invoice.number', ['commercial_invoice'])),
    invoiceDate: firstOf(shipment.invoiceDate, findField(docs, 'invoice.date', ['commercial_invoice'])),
    shippingBill: firstOf(shipment.shippingBillNumber, findField(docs, 'shippingBill.number', ['shipping_bill'])),
    leoDate: firstOf(shipment.leoDate, findField(docs, 'leo.date', ['shipping_bill'])),
    billOfEntry: firstOf(shipment.billOfEntryNumber, findField(docs, 'billOfEntry.number', ['bill_of_entry'])),
    hawb: firstOf(shipment.hawb, findField(docs, 'awb.hawb', ['air_waybill'])),
    mawb: firstOf(shipment.mawb, findField(docs, 'awb.mawb', ['air_waybill'])),
    carrier: firstOf(shipment.carrier, findField(docs, 'carrier.name', ['air_waybill', 'shipping_bill'])),
    flight: firstOf(shipment.flight, findField(docs, 'awb.flight', ['air_waybill'])),
    awbRoute: firstOf(findField(docs, 'awb.route', ['air_waybill']), shipment.route),
    grossWeight: firstOf(shipment.grossWeight, findField(docs, 'goods.grossWeight', ['air_waybill', 'shipping_bill', 'commercial_invoice'])),
    packages: firstOf(shipment.packages),
    booking: firstOf(shipment.bookingRef, shipment.bookingReference),
    direction,
  };
}

function routeText(shipment) {
  const from = countryName(shipment.originCountry);
  const to = countryName(shipment.destinationCountry);
  if (from && to) return shipment.route && !shipment.route.includes(' to ') ? `${from} to ${to} (${shipment.route})` : `${from} to ${to}`;
  return firstOf(shipment.route);
}

function goodsText(shipment, stones) {
  const goods = shipment.goods || {};
  const words = [goods.form, goods.nature].filter((w) => w && w !== 'unknown');
  const kind = !isBlank(goods.description) ? goods.description : words.length ? `${words.join(' ')} diamonds` : null;
  const facts = stoneFacts(stones);
  const parts = [kind ? kind[0].toUpperCase() + kind.slice(1) : null];
  if (facts.count) parts.push(stonesText(facts.count, facts.carats));
  return parts.filter(Boolean).join(', ') || null;
}

// ---------- page 1: the outside cover ----------

function drawHandover(ctx, job) {
  const { shipment, facts } = job;
  addPage(ctx, 'Shipment handover');
  drawHeader(ctx, {
    label: 'Outside cover · Handover record',
    title: 'Shipment handover',
    subtitle: facts.hawb ? `Air waybill ${facts.hawb}` : 'Air waybill not on file',
    subtitleCaps: true,
  });
  const rows = [
    { label: 'Shipper', value: partyLine(shipment.exporter) },
    { label: 'Consignee', value: partyLine(shipment.consignee) },
    { label: 'House air waybill (HAWB)', value: facts.hawb },
    { label: 'Master air waybill (MAWB)', value: facts.mawb },
    { label: 'Carrier', value: facts.carrier },
    { label: 'Flight and route', value: [facts.flight, facts.awbRoute].filter((v) => !isBlank(v)).join(', ') },
  ];
  if (facts.booking) rows.push({ label: 'Booking or confirmation reference', value: facts.booking });
  rows.push({ label: 'Number of pieces (packages)', value: facts.packages === null ? null : String(facts.packages) });
  rows.push({ label: 'Gross weight', value: facts.grossWeight });
  drawRows(ctx, rows);
  drawWriteInRow(ctx, 'Seal numbers');
  ctx.y -= 12;
  drawHandoverBoxes(ctx, ['Shipper', 'Carrier', 'Consignee']);
  ctx.page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: RIGHT_EDGE, y: ctx.y }, thickness: 0.8, color: COLOR.rule });
  ctx.y -= 8;
  drawParagraph(ctx, 'Neutral cover for the outside of the parcel: no contents or values. The papers go in the document envelope (next page).', { size: 7.8, color: COLOR.soft });
}

// ---------- page 2: inside the document envelope ----------

/**
 * Rows for the envelope list. One grading report per stone can mean 40 reports, so when there are more than
 * three they share one row ("Grading reports, 40") with the pages they span. The evidence index lists each one.
 */
function envelopeRows(job, places) {
  const labCount = job.originals.filter((original) => original.doc.docType === 'lab_report').length;
  const rows = [];
  job.originals.forEach((original, i) => {
    const item = { original, range: places ? places.originals[i] : { first: 88, last: 88 } };
    const grouped = original.doc.docType === 'lab_report' && labCount > 3;
    const last = rows[rows.length - 1];
    if (grouped && last?.group) last.items.push(item);
    else rows.push({ group: grouped, items: [item] });
  });
  return rows.map((row) => {
    if (!row.group) {
      const { original, range } = row.items[0];
      const missing = original.type === 'none';
      return {
        title: original.title,
        sub: [original.doc.fileName, missing ? original.note : null].filter(Boolean).join(' \u00b7 '),
        pages: missing ? 'Not attached' : pageText(range),
        missing,
      };
    }
    const attached = row.items.filter((item) => item.original.type !== 'none');
    const labs = {};
    row.items.forEach((item) => {
      const lab = normalizeLab(fieldOf(item.original.doc, 'lab.name')) || 'lab not read';
      labs[lab] = (labs[lab] || 0) + 1;
    });
    const missingCount = row.items.length - attached.length;
    const count = row.items.length;
    const title = Object.keys(labs).length === 1
      ? `Grading reports, ${count}, all from ${Object.keys(labs)[0]}`
      : `Grading reports, ${count} (${Object.entries(labs).map(([lab, n]) => `${lab} ${n}`).join(', ')})`;
    return {
      title,
      sub: missingCount ? `In report number order. ${missingCount} not attached, see the evidence index.` : 'In report number order, one per stone.',
      pages: attached.length
        ? pageText({ first: attached[0].range.first, last: attached[attached.length - 1].range.last })
        : 'Not attached',
      missing: !attached.length,
    };
  });
}

/** Numbered list of the originals with the pages they sit on in this pack. */
function drawPapersList(ctx, job, places) {
  const { fonts } = ctx;
  if (!job.originals.length) {
    drawParagraph(ctx, 'No papers on file yet.', { size: 8.5, color: COLOR.muted });
    return;
  }
  const titleWidth = CONTENT_WIDTH - 24 - 92;
  envelopeRows(job, places).forEach((row, i) => {
    const titleLines = wrap(row.title, fonts.regular, 8.5, titleWidth);
    const subLines = row.sub ? wrap(row.sub, fonts.regular, 7.3, titleWidth) : [];
    const height = 7 + titleLines.length * 11.2 + subLines.length * 9.4 + 2.5;
    ensureSpace(ctx, height);
    const { page } = ctx;
    let y = ctx.y - 7 - 6.6;
    drawText(page, String(i + 1), MARGIN.left + 6, y, { font: fonts.regular, size: 8.5, color: COLOR.soft });
    drawText(page, fitLine(row.pages, fonts.regular, 7.6, 88), RIGHT_EDGE - 4, y, { font: fonts.regular, size: 7.6, color: row.missing ? COLOR.ink : COLOR.muted, align: 'right' });
    titleLines.forEach((line) => { drawText(page, line, MARGIN.left + 24, y, { font: fonts.regular, size: 8.5 }); y -= 11.2; });
    subLines.forEach((line) => { drawText(page, line, MARGIN.left + 24, y + 1, { font: fonts.regular, size: 7.3, color: COLOR.muted }); y -= 9.4; });
    ctx.y -= height;
    page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: RIGHT_EDGE, y: ctx.y }, thickness: 0.5, color: COLOR.line });
  });
}

function missingCorePapers(job) {
  const have = new Set(job.documents.map((doc) => doc.docType));
  return CORE_PAPERS[job.direction].filter(([type]) => !have.has(type)).map(([, label]) => label);
}

function drawChecks(ctx, job, places) {
  const checks = job.checks;
  const summary = job.shipment.summary;
  const total = summary?.total ?? checks.length;
  const passed = summary?.passed ?? checks.filter((c) => c.severity === 'pass' || c.severity === 'info').length;
  const problems = checks.filter((c) => c.severity === 'fail' || c.severity === 'warn')
    .sort((a, b) => (a.severity === 'fail' ? 0 : 1) - (b.severity === 'fail' ? 0 : 1));
  const missing = missingCorePapers(job);
  drawRows(ctx, [
    { label: 'Status', chip: job.status },
    { label: 'Consistent', value: total ? `${passed} of ${total} checks` : 'No checks run yet' },
    ...problems.map((check) => ({ label: check.severity === 'fail' ? 'Failed' : 'To check', value: check.title, note: check.detail })),
    { label: 'Not on file', value: missing.length ? missing.join(', ') : 'Nothing required is missing.' },
    { label: 'Pages', value: String(places ? places.total : 888) },
  ], { pad: 4 });
}

function drawStatementsList(ctx, job, places) {
  const wanted = job.required.filter((item) => item && !['export_pack', 'import_pack'].includes(item.kind));
  if (!wanted.length) {
    drawRows(ctx, [{ label: 'Origin statements', value: 'None needed for this shipment.' }], { pad: 4 });
    return;
  }
  drawRows(ctx, wanted.map((item) => {
    const inPack = STATEMENT_KINDS.includes(item.kind);
    const page = places?.sections[item.kind];
    const who = item.kind === 'g7_gf_declaration'
      ? 'Note for the importer.'
      : job.direction === 'export' ? 'Draft for the importer to sign.' : `Signed by ${houseName(job.house)}.`;
    return {
      label: PAPER_KIND_LABELS[item.kind] || item.kind,
      value: firstOf(item.reason) || 'Required for this shipment.',
      note: inPack ? `${who} Page ${page ?? 88} of this pack.` : 'Not in this pack.',
    };
  }), { pad: 4 });
}

function drawEnvelope(ctx, job, places) {
  const { shipment, facts, house } = job;
  addPage(ctx, 'Inside the document envelope');
  const exporter = shipment.exporter?.name || 'Exporter not on file';
  const consignee = shipment.consignee?.name || 'consignee not on file';
  drawHeader(ctx, {
    label: 'Inside the document envelope',
    title: firstOf(facts.invoice, shipment.ref) || 'Shipment',
    subtitle: `${exporter} to ${consignee}`,
    status: job.status,
  });
  sectionLabel(ctx, 'Shipment');
  const customsRow = job.direction === 'export'
    ? { label: 'Shipping bill', value: facts.shippingBill ? [facts.shippingBill, facts.leoDate ? `Let Export Order ${formatDay(facts.leoDate)}` : null].filter(Boolean).join(', ') : null }
    : { label: 'Bill of entry', value: facts.billOfEntry };
  drawRows(ctx, [
    { label: 'Company', value: houseName(house) },
    { label: 'Invoice', value: facts.invoice },
    { label: 'Route', value: routeText(shipment) },
    { label: 'Invoice date', value: facts.invoiceDate ? formatDay(facts.invoiceDate) : null },
    customsRow,
    { label: 'House air waybill (HAWB)', value: facts.hawb },
    { label: 'Goods', value: goodsText(shipment, job.stones) },
  ], { pad: 4 });
  sectionLabel(ctx, 'Papers in this envelope, in the order customs reads them');
  drawPapersList(ctx, job, places);
  sectionLabel(ctx, 'Checks');
  drawChecks(ctx, job, places);
  sectionLabel(ctx, 'Origin statements');
  drawStatementsList(ctx, job, places);
  drawSignatureBlock(ctx, { heading: `Signed for ${houseName(house)}`, role: 'signer' });
  const lodger = job.direction === 'export' ? 'The exporter' : 'The importer';
  ctx.y -= 2;
  drawParagraph(ctx, `Prepared supporting papers only. This is not a customs declaration, a shipping label or a certificate. ${lodger} and its customs broker lodge the declaration, and the carrier issues the air waybill.`, { size: 7.4, color: COLOR.muted });
}

// ---------- stone list, evidence index, sources ----------

function lineNumberFor(stone, documents, types) {
  for (const source of stone.sources || []) {
    const doc = documents.find((d) => d.id === source.docId);
    if (types.includes(source.kind) || (doc && types.includes(doc.docType))) {
      if (source.lineNo !== null && source.lineNo !== undefined) return String(source.lineNo);
    }
  }
  return null;
}

function drawStoneList(ctx, job) {
  const { stones, documents } = job;
  const facts = stoneFacts(stones);
  addPage(ctx, 'Stone list');
  drawHeader(ctx, {
    label: 'Stone list',
    title: 'Stones in this shipment',
    subtitle: stones.length ? `${stonesText(facts.count, facts.carats)}. ${facts.inScopeCount} of 0.50 ct and up.` : 'No stones on file yet',
  });
  if (!stones.length) {
    drawParagraph(ctx, 'The list fills in as the agents read the invoice, the packing list and the grading reports.', { size: 8.5, color: COLOR.muted });
    return;
  }
  const columns = [
    { title: 'Report number', width: 92, mono: true },
    { title: 'Lab', width: 44 },
    { title: 'Shape', width: 48 },
    { title: 'Carat', width: 50, align: 'right' },
    { title: 'Colour', width: 44 },
    { title: 'Clarity', width: 44 },
    { title: 'Growth', width: 55 },
    { title: 'Invoice line', width: 55, align: 'right' },
    { title: 'Packing line', width: 55, align: 'right' },
  ];
  const rows = stones.map((stone) => ({
    cells: [
      stone.reportNumber, stone.lab, stone.shape, isBlank(stone.carat) ? null : formatCarat(stone.carat),
      stone.color, stone.clarity, isBlank(stone.growth) ? null : growthText(stone.growth),
      lineNumberFor(stone, documents, ['commercial_invoice', 'proforma_invoice', 'invoice']),
      lineNumberFor(stone, documents, ['packing_list']),
    ],
  }));
  rows.push({ strong: true, empty: '', cells: [`${facts.count} stones`, '', '', formatCarat(facts.carats), '', '', '', '', ''] });
  drawTable(ctx, { columns, rows });
}

function drawEvidenceIndex(ctx, job, places) {
  addPage(ctx, 'Evidence index');
  drawHeader(ctx, {
    label: 'Evidence index',
    title: 'Evidence index',
    subtitle: 'Every document the agents read for this shipment, where it came from and its fingerprint.',
  });
  if (!job.documents.length) {
    drawParagraph(ctx, 'No documents on file yet.', { size: 8.5, color: COLOR.muted });
    return;
  }
  const columns = [
    { title: '#', width: 18, empty: '' },
    { title: 'Document', width: 160 },
    { title: 'Source and received', width: 140 },
    { title: 'In this pack', width: 75 },
    { title: 'SHA-256 (first 16)', width: 94, mono: true },
  ];
  // Same order as the envelope list, then the evidence that stays on record (chats, emails, KYC).
  const inEnvelope = job.originals.map((original) => original.doc);
  const ordered = [...inEnvelope, ...job.documents.filter((doc) => !inEnvelope.includes(doc))];
  const rows = ordered.map((doc, i) => {
    const at = job.originals.findIndex((original) => original.doc === doc);
    let inPack = 'Kept on record';
    if (at !== -1) {
      const original = job.originals[at];
      inPack = original.type === 'none' ? 'Not attached' : places ? pageText(places.originals[at]) : 'Pages 88 to 88';
    }
    const source = sourceText(doc.source);
    return {
      cells: [
        i + 1,
        [docTitle(doc), doc.fileName].filter(Boolean).join('\n'),
        `${source.how}\n${source.when}`,
        inPack,
        doc.sha256 ? String(doc.sha256).slice(0, 16) : null,
      ],
    };
  });
  drawTable(ctx, { columns, rows });
}

function sourceKeysFor(job) {
  const kinds = job.required.map((item) => item?.kind);
  const keys = [];
  const eu = kinds.includes('eu_dds') || kinds.includes('g7_gf_declaration');
  const us = kinds.includes('us_cbp_certificate');
  if (eu || !us) keys.push('eu_regulation', 'eu_faq', 'dds_template', 'awdc_guidelines', 'awdc_update');
  if (us || !eu) keys.push('cbp_csms', 'ofac_determinations', 'ace_dis');
  keys.push('ofac_sdn');
  return keys;
}

function drawSources(ctx, job) {
  const { fonts } = ctx;
  addPage(ctx, 'Sources');
  drawHeader(ctx, { label: 'Sources', title: 'Sources and rules', subtitle: 'The official texts and rules these papers follow.' });
  sectionLabel(ctx, 'Legal sources');
  for (const key of sourceKeysFor(job)) {
    const source = SOURCES[key];
    const titleLines = wrap(source.title, fonts.medium, 8.3, CONTENT_WIDTH - 12);
    const metaLines = wrap(`${source.publisher}. ${source.usedFor}`, fonts.regular, 7.5, CONTENT_WIDTH - 12);
    const urlLines = wrap(source.url, fonts.mono, 6.9, CONTENT_WIDTH - 12);
    const height = 7 + titleLines.length * 11 + metaLines.length * 10 + urlLines.length * 9.4 + 5;
    ensureSpace(ctx, height);
    const { page } = ctx;
    let y = ctx.y - 7 - 6.5;
    titleLines.forEach((line) => { drawText(page, line, MARGIN.left + 6, y, { font: fonts.medium, size: 8.3 }); y -= 11; });
    metaLines.forEach((line) => { drawText(page, line, MARGIN.left + 6, y, { font: fonts.regular, size: 7.5, color: COLOR.soft }); y -= 10; });
    urlLines.forEach((line) => { drawText(page, line, MARGIN.left + 6, y, { font: fonts.mono, size: 6.9, color: COLOR.muted }); y -= 9.4; });
    ctx.y -= height;
    page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: RIGHT_EDGE, y: ctx.y }, thickness: 0.5, color: COLOR.line });
  }
  sectionLabel(ctx, 'Rules');
  drawRows(ctx, [
    { label: 'Rules version', value: job.rulesVersion, mono: Boolean(job.rulesVersion) },
    { label: 'Statement wording checked', value: formatDay(WORDING_VERSION) },
    { label: 'Threshold', value: 'Stones of 0.50 ct and up are in scope for the EU and US rules.' },
  ]);
  sectionLabel(ctx, 'How this pack was made');
  drawParagraph(ctx, `Jewel Labs agents read every document in the evidence index and took each value from the page it is printed on. The original documents follow, in the order customs reads them, reproduced unchanged. A person at ${houseName(job.house)} checks and signs the pack.`, { size: 8.4, color: COLOR.soft });
}

// ---------- putting it together ----------

const SECTION_TITLES = {
  eu_dds: 'EU Due Diligence Statement',
  us_cbp_certificate: 'US CBP self-certification',
  g7_gf_declaration: 'G7 / GF declaration note',
};

/** Draws the whole pack once. places = where things landed in the previous pass (null on the first pass). */
async function renderPack(job, places) {
  const ctx = await startPaper({ ref: job.ref, version: job.version, printedAt: job.printedAt, sample: job.sample });
  const found = { sections: {}, originals: [], total: 0 };
  const contents = [];
  const here = () => ctx.doc.getPageCount() + 1;

  drawHandover(ctx, job);
  contents.push({ title: 'Shipment handover', page: 1 });
  found.sections.envelope = here();
  drawEnvelope(ctx, job, places);
  contents.push({ title: 'Inside the document envelope', page: found.sections.envelope });

  for (const kind of job.statementKinds) {
    found.sections[kind] = here();
    drawStatement(ctx, {
      kind, shipment: job.shipment, stones: job.stones, house: job.house, status: job.status, documents: job.documents,
      evidenceNote: (n) => `and ${n} more in the evidence index`,
    });
    const forImporter = job.direction === 'export' && kind !== 'g7_gf_declaration';
    contents.push({ title: forImporter ? `${SECTION_TITLES[kind]} (draft for the importer)` : SECTION_TITLES[kind], page: found.sections[kind] });
  }

  found.sections.stones = here();
  drawStoneList(ctx, job);
  contents.push({ title: 'Stone list', page: found.sections.stones });
  found.sections.evidence = here();
  drawEvidenceIndex(ctx, job, places);
  contents.push({ title: 'Evidence index', page: found.sections.evidence });
  found.sections.sources = here();
  drawSources(ctx, job);
  contents.push({ title: 'Sources', page: found.sections.sources });

  for (const original of job.originals) {
    const range = await appendOriginal(ctx, original);
    found.originals.push(range);
    contents.push({ title: original.title, docId: original.doc.id ?? null, page: range ? range.first : null, attached: Boolean(range) });
  }
  found.total = ctx.doc.getPageCount();
  drawFooters(ctx);
  return { ctx, places: found, contents };
}

/**
 * Builds an export or import pack. Returns { bytes, sha256, pages, contents: [{ title, docId?, page, attached? }] }.
 * getFile(fileKey, doc) returns a document's bytes. Optional extras: printedAt, rulesVersion.
 */
export async function buildPack(input) {
  const { kind } = input || {};
  if (kind !== 'export_pack' && kind !== 'import_pack') throw new Error(`Unknown pack kind: ${kind}`);
  const direction = kind === 'export_pack' ? 'export' : 'import';
  const printedAt = input.printedAt || new Date();
  const documents = input.documents || [];
  // The pack kind decides whose letterhead the statements use, even if the shipment says "unknown".
  const shipment = { ...(input.shipment || {}), direction };
  const required = (input.required || []).filter(Boolean);
  const envelope = customsOrder(documents, direction);
  const originals = [];
  for (const doc of envelope) originals.push(await loadOriginal(doc, input.getFile));

  const job = {
    kind, direction, shipment, documents, originals, required, printedAt,
    stones: input.stones || [],
    checks: input.checks || [],
    house: input.house || {},
    status: input.status || 'draft',
    version: input.version || 1,
    ref: input.ref || nextRef(kind, printedAt, []),
    rulesVersion: input.rulesVersion || (await loadRulesVersion()),
    statementKinds: [...new Set(required.map((item) => item.kind).filter((k) => STATEMENT_KINDS.includes(k)))],
    sample: isSampleData({ house: input.house, shipment: input.shipment, documents }),
  };
  job.facts = shipmentFacts(shipment, documents, direction);

  // Pass 1 finds where every section and original lands; pass 2 prints those page numbers. If a page count
  // still moved (it should not, the page-number column has a fixed width), one more pass settles it.
  let places = null;
  let run = null;
  for (let pass = 0; pass < 3; pass++) {
    run = await renderPack(job, places);
    if (places && JSON.stringify(places) === JSON.stringify(run.places)) break;
    places = run.places;
  }
  const label = kind === 'export_pack' ? 'Export pack' : 'Import pack';
  const saved = await finishPaper(run.ctx, {
    title: `${job.ref} ${label}`,
    subject: `${label} for ${shipment.ref || job.facts.invoice || NOT_ON_FILE}`,
  });
  return { bytes: saved.bytes, sha256: saved.sha256, pages: saved.pages, contents: run.contents };
}
