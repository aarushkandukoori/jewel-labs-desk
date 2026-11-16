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
  const { opened, open, unsettled } = await syncQuestions(ctx, shipment, result.questions || []);
  const deskReview = ctx.houseSetting(house, 'deskReview') === true;
  const status = decideStatus(result, checks, open, shipment, { unsettled, deskReview });

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
  await report(ctx, updated, checks, opened, unsettled);
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

/**
 * Opens the questions the rules ask, keeps the ones still open, and closes open ones that no longer apply.
 * Returns { opened, open, unsettled }: unsettled are questions a person closed that the rules still ask, because
 * the answer did not settle them (see isLeftOpen).
 */
async function syncQuestions(ctx, shipment, drafts) {
  const { store } = ctx;
  const existing = await store.list('questions', (q) => q.shipmentId === shipment.id);
  const wanted = drafts.filter((d) => d && d.text && !isWaived(shipment, d));
  const wantedKeys = new Set(wanted.map(questionKey));
  const opened = [];
  const unsettled = [];

  for (const draft of wanted) {
    const key = questionKey(draft);
    const same = existing.find((q) => questionKey(q) === key);
    // Closed earlier by the Review agent and needed again: open it again instead of asking a new one.
    if (same && same.status === 'dismissed' && same.closedBy === REVIEW_AGENT) {
      const reopened = { ...same, ...draft, id: same.id, status: 'open', closedBy: null, closedAt: null, closedReason: null };
      if (await putIfUnchanged(ctx, same, reopened)) opened.push(reopened);
      continue;
    }
    // Still open: keep it, in the newest wording (more papers can name the same problem). A question asked before
    // the rules gave it a key or options gets them too, so its answer is stored where the rules read it.
    if (same && same.status === 'open') {
      const next = { ...same, text: draft.text, docId: draft.docId ?? same.docId, options: draft.options ?? same.options, key: draft.key ?? same.key };
      if (['text', 'docId', 'key'].some((field) => next[field] !== same[field]) || JSON.stringify(next.options) !== JSON.stringify(same.options)) {
        await putIfUnchanged(ctx, same, next);
      }
      continue;
    }
    if (same) { // answered or dismissed by a person: never ask twice
      if (isLeftOpen(same)) unsettled.push(same);
      continue;
    }
    const question = { ...draft, id: newId('qst'), shipmentId: shipment.id, status: 'open', askedAt: ctx.nowIso(), askedBy: REVIEW_AGENT };
    await store.put('questions', question);
    opened.push(question);
  }

  for (const q of existing) {
    if (q.status !== 'open' || wantedKeys.has(questionKey(q))) continue;
    await putIfUnchanged(ctx, q, { ...q, status: 'dismissed', closedBy: REVIEW_AGENT, closedReason: 'No longer needed', closedAt: ctx.nowIso() });
  }
  const open = await store.list('questions', (q) => q.shipmentId === shipment.id && q.status === 'open');
  return { opened, open, unsettled };
}

/**
 * The Review agent's change to a question is saved only if nobody changed the question since this check read it.
 * A person who answers while the check runs keeps the answer: it is never put back to open or dismissed.
 */
async function putIfUnchanged(ctx, before, next) {
  const latest = await ctx.store.get('questions', before.id);
  if (!latest || latest.status !== before.status) return false;
  await ctx.store.put('questions', next);
  return true;
}

/**
 * A question the rules still ask after a person closed it. When it has a key, the rules read the answer from that
 * key, so asking again means the answer did not settle it ("not sure" to "natural or lab-grown?", or dismissed).
 * A possible OFAC SDN match is cleared only by the answer "Different": "Same", any other answer or a dismissal
 * leaves it open. Either way the pack is held for a person at Jewel Labs.
 */
function isLeftOpen(question) {
  if (question.check === 'sanctions') return String(question.answer || '').trim().toLowerCase() !== 'different';
  return Boolean(question.key);
}

/** The failed checks as "code: detail" lines. A desk approval covers exactly these. */
export function failedChecks(checks) {
  return checks.filter((c) => c.severity === 'fail').map((c) => `${c.code}: ${c.detail || c.title || ''}`).sort();
}

/**
 * True when the desk approved the shipment as it is now: the same papers and answers, and the same failed checks.
 * A check that fails anew (a party newly on the OFAC SDN list, say) holds the pack for the desk again.
 */
export function deskApproves(shipment, checks) {
  const approval = shipment?.deskApproved;
  if (!approval || approval.basis !== shipment.checkedBasis) return false;
  return JSON.stringify(approval.failing || []) === JSON.stringify(failedChecks(checks));
}

/**
 * The shipment status after the rules. Open questions come first. A failed check, a possible OFAC SDN match nobody
 * cleared, or a house that has the desk review every pack, holds it for a person at Jewel Labs; what the desk
 * approved stays approved while nothing changed.
 * options: { unsettled: questions left open by a person (see syncQuestions), deskReview: the house setting }.
 */
export function decideStatus(result, checks, openQuestions, shipment = {}, { unsettled = [], deskReview = false } = {}) {
  if (openQuestions.length) return 'questions';
  if (!result.status && !checks.length) return 'collecting'; // the rules found nothing to check yet
  const failed = checks.some((c) => c.severity === 'fail') || result.status === 'held_for_review' || unsettled.length > 0;
  if (failed || deskReview) return deskApproves(shipment, checks) ? 'ready_to_sign' : 'held_for_review';
  if (!result.status || result.status === 'questions') return 'ready_to_sign'; // every question is answered or not needed
  return result.status;
}

async function report(ctx, shipment, checks, opened, unsettled = []) {
  const name = shipment.ref || 'the shipment';
  for (const check of checks.filter((c) => c.severity === 'warn' || c.severity === 'fail')) {
    ctx.agentEvent('origin', 'check', `${check.title}${check.detail ? `: ${check.detail}` : ''}`, { shipmentId: shipment.id });
  }
  for (const q of unsettled) {
    ctx.agentEvent('review', 'check', `Not cleared: ${q.text} The pack waits for a person at Jewel Labs.`, { shipmentId: shipment.id });
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
