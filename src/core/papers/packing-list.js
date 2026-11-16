// Packing list drafted by the agents (from chat messages, emails and documents) for the house to check.
import { nextRef } from './refs.js';
import {
  COLOR, CONTENT_WIDTH, MARGIN, addPage, drawFooters, drawHeader, drawNotice, drawParagraph, drawRows,
  drawSignatureBlock, drawTable, drawText, ensureSpace, finishPaper, sectionLabel, startPaper, wrap,
} from './layout.js';
import {
  formatCarat, formatDateTime, formatDay, growthText, isBlank, isSampleData, partyLine, toNumber,
} from './format.js';
import { houseName } from './statements.js';

export const DRAFT_NOTICE = 'Drafted by Jewel Labs agents from the sources below. Check every line before use.';

/** Table of packing list lines with a total row. Also used for spreadsheet originals inside a pack. */
export function drawLinesTable(ctx, lines) {
  const columns = [
    { title: 'No.', width: 22, empty: '' },
    { title: 'Description', width: 94 },
    { title: 'Report no.', width: 74, mono: true },
    { title: 'Lab', width: 44 },
    { title: 'Shape', width: 46 },
    { title: 'Carat', width: 50, align: 'right' },
    { title: 'Colour', width: 44 },
    { title: 'Clarity', width: 44 },
    { title: 'Pcs', width: 25, align: 'right', empty: '' },
    { title: 'Growth', width: 44 },
  ];
  let pieces = 0;
  let carats = 0;
  const rows = (lines || []).map((line, i) => {
    const carat = toNumber(line.carat);
    const count = toNumber(line.pieces);
    if (carat !== null) carats += carat;
    pieces += count !== null ? count : 1;
    return {
      cells: [
        line.lineNo ?? i + 1, line.description, line.reportNumber, line.lab, line.shape,
        carat === null ? null : formatCarat(carat), line.color, line.clarity, count, isBlank(line.growth) ? null : growthText(line.growth),
      ],
    };
  });
  if (!rows.length) {
    drawParagraph(ctx, 'No lines yet.', { size: 8.5, color: COLOR.muted });
    return;
  }
  rows.push({ strong: true, empty: '', cells: ['', 'Total', '', '', '', formatCarat(carats), '', '', pieces, ''] });
  drawTable(ctx, { columns, rows });
}

function sourceKindText(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'chat' || k === 'whatsapp') return 'WhatsApp chat';
  if (k === 'email') return 'Email';
  if (k === 'document' || k === 'doc') return 'Document';
  return k ? k[0].toUpperCase() + k.slice(1) : 'Source';
}

/** Each source: who said it and when, then the exact words quoted. */
function drawSourceQuotes(ctx, sources) {
  const { fonts } = ctx;
  if (!sources?.length) {
    drawParagraph(ctx, 'No sources listed.', { size: 8.5, color: COLOR.muted });
    return;
  }
  for (const source of sources) {
    const when = source.at || source.chatAt;
    const head = [
      sourceKindText(source.kind),
      source.author,
      isBlank(when) ? null : formatDateTime(when),
      source.ref,
      source.fileName || source.title,
    ].filter((part) => !isBlank(part)).join(' · ');
    const headLines = wrap(head, fonts.medium, 7.8, CONTENT_WIDTH - 12);
    const quoteLines = isBlank(source.quote) ? [] : wrap(`“${String(source.quote).trim()}”`, fonts.regular, 8, CONTENT_WIDTH - 12);
    const height = 7 + headLines.length * 10.4 + quoteLines.length * 10.8 + 5;
    ensureSpace(ctx, height);
    const { page } = ctx;
    let y = ctx.y - 7 - 6.2;
    headLines.forEach((line) => { drawText(page, line, MARGIN.left + 6, y, { font: fonts.medium, size: 7.8 }); y -= 10.4; });
    quoteLines.forEach((line) => { drawText(page, line, MARGIN.left + 6, y, { font: fonts.regular, size: 8, color: COLOR.soft }); y -= 10.8; });
    ctx.y -= height;
    page.drawLine({ start: { x: MARGIN.left, y: ctx.y }, end: { x: MARGIN.left + CONTENT_WIDTH, y: ctx.y }, thickness: 0.5, color: COLOR.line });
  }
}

/**
 * Builds the agents' packing list draft.
 * sources: [{ kind: 'chat'|'email'|'document', ref?, quote, author?, at?, fileName? }].
 * Optional extras beyond the contract: ref, version, printedAt, status (default 'draft').
 */
export async function buildPackingListDraft({ shipment = {}, lines = [], sources = [], house = {}, ref, version = 1, printedAt = new Date(), status = 'draft' }) {
  const paperRef = ref || nextRef('packing_list_draft', printedAt, []);
  const ctx = await startPaper({ ref: paperRef, version, printedAt, sample: isSampleData({ house, shipment }) });
  addPage(ctx, 'Packing list');
  const exporter = shipment?.exporter?.name || 'Exporter not on file';
  const consignee = shipment?.consignee?.name || 'consignee not on file';
  drawHeader(ctx, {
    label: 'Packing list · drafted by agents',
    title: shipment?.invoiceNumber ? `Packing list for ${shipment.invoiceNumber}` : 'Packing list',
    subtitle: `${exporter} to ${consignee}`,
    status,
  });
  drawNotice(ctx, DRAFT_NOTICE);
  sectionLabel(ctx, 'Shipment');
  drawRows(ctx, [
    { label: 'Exporter', value: partyLine(shipment?.exporter) },
    { label: 'Consignee', value: partyLine(shipment?.consignee) },
    { label: 'Invoice', value: shipment?.invoiceNumber },
    { label: 'Invoice date', value: isBlank(shipment?.invoiceDate) ? null : formatDay(shipment.invoiceDate) },
    { label: 'House air waybill (HAWB)', value: shipment?.hawb },
    { label: 'Route', value: shipment?.route },
  ]);
  sectionLabel(ctx, 'Lines', { keepWith: 60 });
  drawLinesTable(ctx, lines);
  sectionLabel(ctx, 'Sources');
  drawSourceQuotes(ctx, sources);
  drawSignatureBlock(ctx, { heading: `Checked by ${houseName(house)}`, role: 'signer' });
  drawFooters(ctx);
  return finishPaper(ctx, { title: `${paperRef} Packing list (drafted by agents)`, subject: `Packing list draft for ${shipment?.ref || shipment?.invoiceNumber || 'a shipment'}` });
}
