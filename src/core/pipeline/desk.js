// The Jewel Labs desk: packs held for review wait here. Approve makes a pack ready to sign; hold keeps it held.
// Both post a message to the house. Only a change to the content counts as a desk edit (approving alone is not).
import { PAPER_KIND_LABELS, FIELD_LABELS } from '../types.js';
import { personName } from './context.js';
import { applyAnswers } from './answers.js';

export function createDesk(ctx, { run, buildPapers }) {
  const { store } = ctx;

  async function queue() {
    const held = await store.list('papers', (p) => p.status === 'held_for_review');
    const items = [];
    for (const paper of held) {
      const shipment = await store.get('shipments', paper.shipmentId);
      const checks = await store.list('checks', (c) => c.shipmentId === paper.shipmentId && c.severity !== 'pass');
      const questions = await store.list('questions', (q) => q.shipmentId === paper.shipmentId && q.status === 'open');
      items.push({ paper, shipment, checks, questions });
    }
    return items.sort((a, b) => String(a.paper.builtAt || '').localeCompare(String(b.paper.builtAt || '')));
  }

  /** changes (optional): { fields: { 'goods.destinationCountry': 'BE' } } set by the desk before approving. */
  async function approve(paperId, message, by, changes) {
    let paper = await paperToReview(paperId);
    paper = (await applyDeskChanges(paper, changes, by)) || paper;
    const approved = { ...paper, status: 'ready_to_sign', deskNote: message || null, approvedBy: personName(by), approvedAt: ctx.nowIso() };
    await store.put('papers', approved);
    await markShipment(approved, by, 'ready_to_sign');

    const label = PAPER_KIND_LABELS[paper.kind] || 'Paper';
    const text = message || `${label} ${paper.ref} is approved and ready to sign.`;
    await postDeskMessage(approved, text, by);
    await ctx.usage('desk_approved', { paperId, shipmentId: paper.shipmentId, by: personName(by) }, by);
    await ctx.log(ctx.personActor(by), 'approved', `Approved ${label} ${paper.ref} v${approved.version}`, { shipmentId: paper.shipmentId, paperId });
    await ctx.notifyUser({ kind: 'pack_ready', shipmentId: paper.shipmentId, paperId, title: `Ready to sign: ${paper.ref}`, body: text });
    return approved;
  }

  async function hold(paperId, message, by, changes) {
    let paper = await paperToReview(paperId);
    paper = (await applyDeskChanges(paper, changes, by)) || paper;
    const label = PAPER_KIND_LABELS[paper.kind] || 'Paper';
    const text = message || `${label} ${paper.ref} is held for review. Jewel Labs will write with what to fix.`;
    const held = { ...paper, status: 'held_for_review', deskNote: text, heldBy: personName(by), heldAt: ctx.nowIso() };
    await store.put('papers', held);
    await markShipment(held, by, 'held_for_review');
    await postDeskMessage(held, text, by);
    await ctx.usage('desk_held', { paperId, shipmentId: paper.shipmentId, by: personName(by) }, by);
    await ctx.log(ctx.personActor(by), 'held', `Held ${label} ${paper.ref} v${held.version}: ${text}`, { shipmentId: paper.shipmentId, paperId });
    await ctx.notifyUser({ kind: 'desk_message', shipmentId: paper.shipmentId, paperId, title: `Message from Jewel Labs on ${paper.ref}`, body: text });
    return held;
  }

  async function paperToReview(paperId) {
    const paper = await store.get('papers', paperId);
    if (!paper) throw new Error('That paper is no longer there.');
    if (paper.status === 'signed' || paper.status === 'sent') throw new Error('This paper is already signed.');
    return paper;
  }

  /** A desk edit: new values go onto the shipment, the rules run again and the paper gets a new version. */
  async function applyDeskChanges(paper, changes, by) {
    const fields = changes?.fields || {};
    const shipment = await store.get('shipments', paper.shipmentId);
    if (!shipment) return null;
    const answers = { ...(shipment.answers || {}) };
    const changedKeys = Object.keys(fields).filter((key) => answers[key] !== fields[key]);
    if (!changedKeys.length) return null;
    for (const key of changedKeys) answers[key] = fields[key];
    await store.put('shipments', applyAnswers({ ...shipment, answers, deskEdits: (shipment.deskEdits || 0) + 1 }));

    const labels = changedKeys.map((key) => FIELD_LABELS[key] || key).join(', ');
    await ctx.usage('desk_edit', { paperId: paper.id, shipmentId: paper.shipmentId, fields: changedKeys, by: personName(by) }, by);
    await ctx.log(ctx.personActor(by), 'edited', `Changed ${labels} on ${paper.ref}`, { shipmentId: paper.shipmentId, paperId: paper.id });

    await run({ shipmentId: paper.shipmentId, reason: 'desk edit' });
    let latest = await store.get('papers', paper.id);
    if (!latest || latest.version === paper.version) {
      await buildPapers(paper.shipmentId, { kinds: [paper.kind], by }); // autopilot did not rebuild it: do it now
      latest = await store.get('papers', paper.id);
    }
    return latest;
  }

  /** The shipment follows its pack, and an approval is remembered so a later re-check keeps it. */
  async function markShipment(paper, by, status) {
    const shipment = await store.get('shipments', paper.shipmentId);
    if (!shipment || shipment.status === 'signed' || shipment.status === 'sent') return;
    const others = await store.list('papers', (p) => p.shipmentId === paper.shipmentId && p.id !== paper.id && p.status === 'held_for_review');
    if (status === 'ready_to_sign' && others.length) return; // another paper of this shipment still waits for the desk
    const next = { ...shipment, status };
    if (status === 'ready_to_sign') next.deskApproved = { basis: shipment.checkedBasis || null, by: personName(by), at: ctx.nowIso() };
    await store.put('shipments', next);
  }

  async function postDeskMessage(paper, text, by) {
    await ctx.postMessage({ from: ctx.personFrom(by, 'desk'), to: 'house', text, kind: 'desk', shipmentId: paper.shipmentId, paperId: paper.id });
  }

  return { queue, approve, hold };
}
