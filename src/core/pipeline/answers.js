// Answers to the Review agent's one-line questions. An answer can set a value on the shipment,
// fill a missing field on a document, or mark a paper as not needed. Then the shipment is checked again.
import { personName } from './context.js';

// Field key -> where that value lives on the shipment record.
const SHIPMENT_PATHS = {
  'exporter.name': ['exporter', 'name'], 'exporter.address': ['exporter', 'address'], 'exporter.country': ['exporter', 'country'],
  'consignee.name': ['consignee', 'name'], 'consignee.address': ['consignee', 'address'], 'consignee.country': ['consignee', 'country'],
  'buyer.name': ['buyer', 'name'], 'buyer.country': ['buyer', 'country'],
  'supplier.name': ['supplier', 'name'], 'supplier.country': ['supplier', 'country'],
  'goods.countryOfOrigin': ['originCountry'], 'goods.destinationCountry': ['destinationCountry'],
  'goods.nature': ['goods', 'nature'], 'goods.form': ['goods', 'form'], 'goods.description': ['goods', 'description'],
  'goods.totalPieces': ['totals', 'pieces'], 'goods.totalCarats': ['totals', 'carats'],
  'goods.totalValue': ['totals', 'value'], 'goods.currency': ['totals', 'currency'],
  'invoice.number': ['invoiceNumber'], 'invoice.date': ['invoiceDate'],
  'shippingBill.number': ['shippingBillNumber'], 'leo.date': ['leoDate'],
  'awb.hawb': ['hawb'], 'awb.mawb': ['mawb'], 'awb.flight': ['flight'], 'awb.route': ['route'],
};
const NUMBER_KEYS = new Set(['goods.totalPieces', 'goods.totalCarats', 'goods.totalValue']);
const NOT_NEEDED = /^(not needed|not required|no need|n\/?a|none needed|not applicable)\.?$/i;

/** Puts every answer the house gave back onto the shipment (answers beat what the papers say). */
export function applyAnswers(shipment) {
  for (const [key, value] of Object.entries(shipment.answers || {})) setShipmentValue(shipment, key, value);
  return shipment;
}

/** Sets one field key on the shipment. Unknown keys are kept only in shipment.answers. */
export function setShipmentValue(shipment, key, value) {
  const path = SHIPMENT_PATHS[key] || (String(key).startsWith('shipment.') ? key.slice('shipment.'.length).split('.') : null);
  if (!path) return false;
  let target = shipment;
  for (const part of path.slice(0, -1)) {
    target[part] = { ...(target[part] || {}) };
    target = target[part];
  }
  target[path[path.length - 1]] = NUMBER_KEYS.has(key) ? toNumber(value) : value;
  return true;
}

function toNumber(value) {
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The answer as text, from a plain string or { value } / { text }. */
export function answerText(answer) {
  if (answer && typeof answer === 'object') return answer.value ?? answer.text ?? null;
  return answer == null ? null : String(answer).trim();
}

function isNotNeeded(question, answer) {
  if (answer && typeof answer === 'object' && answer.notNeeded) return true;
  return question.kind === 'missing_document' && NOT_NEEDED.test(String(answerText(answer) || '').trim());
}

/** Stores the answer, applies it, counts a house edit and checks the shipment again. */
export async function answerQuestion(ctx, { run }, id, answer, by) {
  const { store } = ctx;
  const question = await store.get('questions', id);
  if (!question) throw new Error('That question is no longer there.');
  if (question.status !== 'open') throw new Error('That question is already closed.');
  const notNeeded = isNotNeeded(question, answer);
  const value = notNeeded ? null : answerText(answer);
  if (!notNeeded && (value == null || value === '')) throw new Error('Type an answer first.');

  const saved = {
    ...question, status: 'answered', answer: notNeeded ? 'Not needed' : value, notNeeded,
    answeredBy: personName(by), answeredAt: ctx.nowIso(),
  };
  await store.put('questions', saved);
  if (question.shipmentId) await applyToShipment(ctx, question, value, notNeeded);
  if (question.docId && question.key && !notNeeded) await applyToDocument(ctx, question, value, by);

  await ctx.usage('question_answered', { questionId: id, shipmentId: question.shipmentId || null, by: personName(by) }, by);
  await ctx.usage('house_edit', { questionId: id, shipmentId: question.shipmentId || null, by: personName(by) }, by);
  await ctx.log(ctx.personActor(by), 'answered', `${question.text} ${notNeeded ? 'Not needed.' : `Answer: ${value}`}`, { shipmentId: question.shipmentId });

  if (question.shipmentId) await run({ shipmentId: question.shipmentId, reason: 'question answered' });
  const shipment = question.shipmentId ? await store.get('shipments', question.shipmentId) : null;
  return { question: saved, shipment, status: shipment?.status || null };
}

/** Closes a question without an answer (the person says it does not apply). Not counted as an edit. */
export async function dismissQuestion(ctx, { run }, id, by) {
  const question = await ctx.store.get('questions', id);
  if (!question) throw new Error('That question is no longer there.');
  const saved = { ...question, status: 'dismissed', closedBy: personName(by), closedAt: ctx.nowIso() };
  await ctx.store.put('questions', saved);
  await ctx.log(ctx.personActor(by), 'dismissed', `Dismissed: ${question.text}`, { shipmentId: question.shipmentId });
  if (question.shipmentId) await run({ shipmentId: question.shipmentId, reason: 'question dismissed' });
  return saved;
}

async function applyToShipment(ctx, question, value, notNeeded) {
  const shipment = await ctx.store.get('shipments', question.shipmentId);
  if (!shipment) return;
  const next = {
    ...shipment,
    answers: { ...(shipment.answers || {}) },
    notNeeded: [...(shipment.notNeeded || [])],
    houseEdits: (shipment.houseEdits || 0) + 1,
  };
  if (notNeeded) {
    const kind = question.docType || question.key || question.code;
    if (kind && !next.notNeeded.includes(kind)) next.notNeeded.push(kind);
  } else {
    next.answers[question.key || question.id] = value; // a confirm question with no field keeps its answer by id
  }
  applyAnswers(next);
  await ctx.store.put('shipments', next);
}

async function applyToDocument(ctx, question, value, by) {
  const doc = await ctx.store.get('documents', question.docId);
  if (!doc) return;
  const old = (doc.fields || []).find((f) => f.key === question.key) || {};
  const field = { ...old, key: question.key, value, quote: old.quote ?? null, page: old.page ?? null, box: old.box ?? null, confidence: 1, agent: 'person', by: personName(by) };
  const fields = (doc.fields || []).filter((f) => f.key !== question.key).concat(field);
  await ctx.store.put('documents', { ...doc, fields, editedAt: ctx.nowIso() });
}
