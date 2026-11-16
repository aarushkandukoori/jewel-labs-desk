// Origin agent runs the compliance rules; the Review agent turns anything uncertain into one-line questions.
// Checks are replaced on every run. Questions are never asked twice, and open ones that no longer apply are closed.
import { SHIPMENT_STATUS_LABELS } from '../types.js';
import { newId, normalizeName, plural } from './context.js';
import { saveShipment } from './shipment-save.js';

const REVIEW_AGENT = 'Review agent';

/** Runs the rules for one shipment. Returns { shipment, checks, opened, open }. */
export async function checkShipment(ctx, shipment, screenings = []) {
  const { store } = ctx;
  const rules = await ctx.load('rules');
  const house = await store.workspace();
  const documents = await store.list('documents', (d) => d.shipmentId === shipment.id && d.status === 'read');
  const stones = await store.list('stones', (s) => s.shipmentId === shipment.id);

  const result = (await rules.evaluate({ shipment, documents, stones, house, screenings, now: ctx.now() })) || {};
  const checks = await replaceChecks(ctx, shipment, result.checks || []);
  const { opened, open } = await syncQuestions(ctx, shipment, result.questions || []);
  const status = decideStatus(result, checks, open, shipment);

  const updated = await saveShipment(ctx, {
    ...shipment,
    status,
    required: result.required || [],
    summary: result.summary || { passed: checks.filter((c) => c.severity === 'pass').length, total: checks.length },
    goods: result.goods ? { ...shipment.goods, ...result.goods } : shipment.goods, // the rules also count the stones
    regime: result.regime ?? shipment.regime ?? null,
    checkedAt: ctx.nowIso(),
    rulesVersion: rules.RULES_VERSION || null,
  });
  await report(ctx, updated, checks, opened);
  return { shipment: updated, checks, opened, open };
}

async function replaceChecks(ctx, shipment, drafts) {
  const { store } = ctx;
  for (const old of await store.list('checks', (c) => c.shipmentId === shipment.id)) await store.remove('checks', old.id);
  const saved = [];
  for (const draft of drafts) {
    const check = { ...draft, id: draft.id || newId('chk'), shipmentId: shipment.id, evidence: draft.evidence || [], checkedAt: ctx.nowIso() };
    await store.put('checks', check);
    saved.push(check);
  }
  return saved;
}

/**
 * When are two questions the same? The rules give each one a dedupeKey. Without it: same kind, same field
 * (or paper type, or rule code) and same document. The wording decides only when there is no key at all.
 */
export function questionKey(q) {
  if (q.dedupeKey) return q.dedupeKey;
  const key = q.key || q.docType || q.code || '';
  return [q.kind || '', key, q.docId || '', key ? '' : normalizeName(q.text)].join('|');
}

/** A missing paper the house said is not needed is not asked about again. */
function isWaived(shipment, draft) {
  if (draft.kind !== 'missing_document') return false;
  const kind = draft.docType || draft.key || draft.code;
  return Boolean(kind && (shipment.notNeeded || []).includes(kind));
}

async function syncQuestions(ctx, shipment, drafts) {
  const { store } = ctx;
  const existing = await store.list('questions', (q) => q.shipmentId === shipment.id);
  const wanted = drafts.filter((d) => d && d.text && !isWaived(shipment, d));
  const wantedKeys = new Set(wanted.map(questionKey));
  const opened = [];

  for (const draft of wanted) {
    const key = questionKey(draft);
    const same = existing.find((q) => questionKey(q) === key);
    // Closed earlier by the Review agent and needed again: open it again instead of asking a new one.
    if (same && same.status === 'dismissed' && same.closedBy === REVIEW_AGENT) {
      const reopened = { ...same, ...draft, id: same.id, status: 'open', closedBy: null, closedAt: null, closedReason: null };
      await store.put('questions', reopened);
      opened.push(reopened);
      continue;
    }
    // Still open: keep it, in the newest wording (more papers can name the same problem).
    if (same && same.status === 'open') {
      if (same.text !== draft.text || same.docId !== (draft.docId ?? same.docId)) {
        await store.put('questions', { ...same, text: draft.text, docId: draft.docId ?? same.docId, options: draft.options ?? same.options });
      }
      continue;
    }
    if (same) continue; // answered or dismissed by a person: never ask twice
    const question = { ...draft, id: newId('qst'), shipmentId: shipment.id, status: 'open', askedAt: ctx.nowIso(), askedBy: REVIEW_AGENT };
    await store.put('questions', question);
    opened.push(question);
  }

  for (const q of existing) {
    if (q.status !== 'open' || wantedKeys.has(questionKey(q))) continue;
    await store.put('questions', { ...q, status: 'dismissed', closedBy: REVIEW_AGENT, closedReason: 'No longer needed', closedAt: ctx.nowIso() });
  }
  const open = await store.list('questions', (q) => q.shipmentId === shipment.id && q.status === 'open');
  return { opened, open };
}

/**
 * The shipment status after the rules. Open questions come first; a failed check holds the pack for a
 * person; a pack the desk already approved stays approved while its papers have not changed.
 */
export function decideStatus(result, checks, openQuestions, shipment = {}) {
  if (openQuestions.length) return 'questions';
  const failed = checks.some((c) => c.severity === 'fail') || result.status === 'held_for_review';
  if (failed) {
    const approved = shipment.deskApproved && shipment.deskApproved.basis === shipment.checkedBasis;
    return approved ? 'ready_to_sign' : 'held_for_review';
  }
  if (!result.status && !checks.length) return 'collecting'; // the rules found nothing to check yet
  if (!result.status || result.status === 'questions') return 'ready_to_sign'; // every question is answered or not needed
  return result.status;
}

async function report(ctx, shipment, checks, opened) {
  const name = shipment.ref || 'the shipment';
  for (const check of checks.filter((c) => c.severity === 'warn' || c.severity === 'fail')) {
    ctx.agentEvent('origin', 'check', `${check.title}${check.detail ? `: ${check.detail}` : ''}`, { shipmentId: shipment.id });
  }
  // The same count the papers print ("Consistent 17 of 18 checks"): passes and notes, out of every check.
  const passed = shipment.summary?.total === checks.length
    ? shipment.summary.passed
    : checks.filter((c) => c.severity === 'pass' || c.severity === 'info').length;
  const summary = `Checked ${name}: ${passed} of ${checks.length} checks consistent. ${SHIPMENT_STATUS_LABELS[shipment.status] || shipment.status}.`;
  ctx.agentEvent('origin', 'done', summary, { shipmentId: shipment.id });
  await ctx.log(ctx.agentActor('origin'), 'checked', summary, { shipmentId: shipment.id });

  for (const q of opened) {
    ctx.agentEvent('review', 'question', q.text, { shipmentId: shipment.id });
    await ctx.usage('question_asked', { questionId: q.id, shipmentId: shipment.id, kind: q.kind });
  }
  if (opened.length) {
    await ctx.log(ctx.agentActor('review'), 'asked', `${plural(opened.length, 'question')} on ${name}: ${opened.map((q) => q.text).join(' ')}`, { shipmentId: shipment.id });
    await ctx.notifyUser({
      kind: 'questions', shipmentId: shipment.id,
      title: `${plural(opened.length, 'question')} on ${name}`,
      body: opened.map((q) => q.text).join(' '),
    });
  }
}
