// Records agent: puts every read document under the right shipment, then traces every stone
// (lab report, invoice line, packing list line, KP rough source, export clearance, air waybill).
import { newId, reportKey, plural } from './context.js';
import { saveShipment } from './shipment-save.js';

const CLOSED = ['signed', 'sent'];

/** Groups all read documents into shipments and matches the stones. Returns the shipments after this pass. */
export async function runRecords(ctx) {
  const { store } = ctx;
  const records = await ctx.load('records');
  const house = await store.workspace();
  const readDocs = await store.list('documents', (d) => d.status === 'read');
  if (!readDocs.length) return [];
  const before = await store.list('shipments');

  const grouped = (await records.groupShipments({ documents: readDocs, shipments: before, house })) || {};
  const assignments = grouped.assignments || {};
  await assignDocuments(ctx, readDocs, assignments);

  const saved = [];
  for (const shipment of grouped.shipments || []) {
    saved.push(await mergeShipment(ctx, shipment, before, assignments));
  }
  await removeEmptyShipments(ctx, before, saved, assignments);

  // Rough-side papers (KP certificate, supplier invoice) may sit under another shipment, so stones are
  // matched against every read document of the house.
  const allRead = await store.list('documents', (d) => d.status === 'read');
  for (const shipment of saved) {
    if (!CLOSED.includes(shipment.status)) await matchShipmentStones(ctx, records, shipment, allRead);
  }
  return saved;
}

async function assignDocuments(ctx, readDocs, assignments) {
  for (const doc of readDocs) {
    const shipmentId = assignments[doc.id] ?? doc.shipmentId ?? null;
    if (shipmentId !== doc.shipmentId) await ctx.store.put('documents', { ...doc, shipmentId });
  }
}

/** Saves a grouped shipment on top of what we already knew, so statuses and answers are never lost. */
async function mergeShipment(ctx, grouped, before, assignments) {
  const old = before.find((s) => s.id === grouped.id) || null;
  const id = grouped.id || newId('shp');
  const assigned = Object.keys(assignments).filter((docId) => assignments[docId] === id);
  const shipment = await saveShipment(ctx, {
    ...old,
    ...grouped,
    id,
    documentIds: assigned.length ? assigned : grouped.documentIds || old?.documentIds || [],
    status: old?.status || grouped.status || 'collecting',
    required: old?.required || grouped.required || [],
    answers: old?.answers || {},
    notNeeded: old?.notNeeded || [],
    houseEdits: old?.houseEdits || 0,
    deskEdits: old?.deskEdits || 0,
  });

  const added = shipment.documentIds.filter((docId) => !(old?.documentIds || []).includes(docId));
  if (!old || added.length) {
    const name = shipment.ref ? `shipment ${shipment.ref}` : 'a new shipment';
    const detail = old
      ? `Matched ${plural(added.length, 'more paper')} to ${name}`
      : `Started ${name} with ${plural(shipment.documentIds.length, 'paper')}`;
    await ctx.log(ctx.agentActor('records'), 'matched', detail, { shipmentId: id });
    ctx.agentEvent('records', 'done', detail, { shipmentId: id });
  }
  return shipment;
}

/** A shipment the grouping merged into another one is left with no papers: remove it (never a signed one). */
async function removeEmptyShipments(ctx, before, saved, assignments) {
  const kept = new Set(saved.map((s) => s.id));
  const stillUsed = new Set(Object.values(assignments));
  for (const old of before) {
    if (kept.has(old.id) || stillUsed.has(old.id) || CLOSED.includes(old.status)) continue;
    const papers = await ctx.store.list('papers', (p) => p.shipmentId === old.id);
    if (!papers.length) await ctx.store.remove('shipments', old.id);
  }
}

async function matchShipmentStones(ctx, records, shipment, documents) {
  const { store } = ctx;
  const papers = await store.list('papers', (p) => p.shipmentId === shipment.id);
  const oldStones = await store.list('stones', (s) => s.shipmentId === shipment.id);
  const matched = (await records.matchStones({ shipment, documents })) || {};
  const stones = matched.stones || [];

  const keep = new Set();
  for (const stone of stones) {
    const old = oldStones.find((s) => sameStone(s, stone));
    const merged = {
      ...old,
      ...stone,
      id: old?.id || stone.id || newId('stn'),
      shipmentId: shipment.id,
      labCheck: stone.labCheck || old?.labCheck || null, // keep a lab check a person already did
    };
    merged.history = (await records.buildHistory({ stone: merged, shipment, documents, papers })) || [];
    await store.put('stones', merged);
    keep.add(merged.id);
  }
  for (const old of oldStones) if (!keep.has(old.id)) await store.remove('stones', old.id);

  const latest = (await store.get('shipments', shipment.id)) || shipment;
  await saveShipment(ctx, { ...latest, stoneCount: stones.length, matchIssues: matched.issues || [] });
  if (stones.length !== oldStones.length) {
    const detail = `Traced ${plural(stones.length, 'stone')} for ${shipment.ref || 'the shipment'}`;
    ctx.agentEvent('records', 'done', detail, { shipmentId: shipment.id });
  }
}

function sameStone(a, b) {
  if (a.reportNumber && b.reportNumber) return reportKey(a.reportNumber) === reportKey(b.reportNumber);
  return Boolean(a.ref && b.ref && a.ref === b.ref);
}
