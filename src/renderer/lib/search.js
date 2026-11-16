// Command search (Cmd/Ctrl+K): finds shipments, stones, report numbers, papers and documents in the
// data already on screen. Pure function, so it is tested in test/unit/renderer.test.js.
import { docTypeLabel, paperKindLabel, carat, route } from './format.js';

/** Upper-case letters and digits only, so "kg/26-27 041" finds "KG/26-27/041". */
export function squash(text) {
  return String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function score(haystacks, query) {
  const q = squash(query);
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  let best = 0;
  for (const h of haystacks.filter(Boolean)) {
    const s = squash(h);
    if (q && s === q) best = Math.max(best, 100);
    else if (q && s.startsWith(q)) best = Math.max(best, 80);
    else if (q.length >= 2 && s.includes(q)) best = Math.max(best, 60);
    else if (words.length && words.every((w) => String(h).toLowerCase().includes(w))) best = Math.max(best, 40);
  }
  return best;
}

/**
 * data: { shipments, stones, papers, documents }. Returns groups of results, best first:
 * [{ group, items: [{ kind, id, title, ref, meta }] }].
 */
export function searchAll(data, query, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const groups = [];

  const ranked = (rows, fields, make) => rows
    .map((r) => ({ r, s: score(fields(r), q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => make(x.r));

  const shipments = ranked(data.shipments || [], (s) => [s.ref, s.invoiceNumber, s.shippingBillNumber, s.hawb, s.mawb, s.consignee?.name, s.exporter?.name],
    (s) => ({ kind: 'shipment', id: s.id, ref: s.ref || 'Shipment', title: [s.consignee?.name, route(s)].filter(Boolean).join(' · '), meta: s.status }));
  if (shipments.length) groups.push({ group: 'Shipments', items: shipments });

  const stones = ranked(data.stones || [], (s) => [s.reportNumber, s.ref],
    (s) => ({ kind: 'stone', id: s.reportNumber || s.id, ref: s.reportNumber || s.ref, title: [s.lab, carat(s.carat), s.color, s.clarity].filter(Boolean).join(' '), meta: 'Stone history' }));
  if (stones.length) groups.push({ group: 'Stones', items: stones });

  const papers = ranked(data.papers || [], (p) => [p.ref, paperKindLabel(p.kind)],
    (p) => ({ kind: 'paper', id: p.id, ref: `${p.ref} v${p.version || 1}`, title: paperKindLabel(p.kind), meta: p.status }));
  if (papers.length) groups.push({ group: 'Papers', items: papers });

  const docs = ranked(data.documents || [], (d) => [d.fileName, docTypeLabel(d.docType), ...(d.fields || []).map((f) => f.value)],
    (d) => ({ kind: 'document', id: d.id, ref: d.fileName, title: docTypeLabel(d.docType), meta: d.shipmentId ? 'Filed' : 'Not filed yet', shipmentId: d.shipmentId }));
  if (docs.length) groups.push({ group: 'Documents', items: docs });

  // Something that looks like a report number we do not have: offer to look it up in stone history.
  if (/^[A-Z]{0,4}\s?\d{6,12}$/i.test(q) && !stones.some((s) => squash(s.ref) === squash(q))) {
    groups.push({ group: 'Stone history', items: [{ kind: 'stone', id: q.replace(/\s/g, ''), ref: q, title: 'Look up this report number', meta: '' }] });
  }
  return groups;
}
