// "Tell the agents": the house types a request, the model picks what it means (ai.route), and one handler does it.
// The reply lists the steps that really ran, like "Matching your documents" and "Building the export paper".
import { PAPER_KIND_LABELS, SHIPMENT_STATUS_LABELS, DOC_TYPE_LABELS } from '../types.js';
import { byNewest, plural } from './context.js';
import { defaultKinds, nextVersion, savePaper } from './paperwork.js';
import { safeFileName } from './files.js';

const CLOSED = ['signed', 'sent'];
const BUILD_STEPS = {
  export_pack: 'Building the export paper',
  import_pack: 'Building the import paper',
  eu_dds: 'Writing the EU statement',
  us_cbp_certificate: 'Writing the US self-certification',
  g7_gf_declaration: 'Writing the G7 note',
};

/** deps: { run, buildPapers, addGeneratedDocument } -> { reply, actions, steps, intent, shipmentId } */
export async function ask(ctx, deps, text, { shipmentId = null, by } = {}) {
  const request = String(text || '').trim();
  if (!request) throw new Error('Type a request for the agents.');
  const { store } = ctx;
  await ctx.postMessage({ from: ctx.personFrom(by), to: 'agents', text: request, kind: 'ask', shipmentId });
  await ctx.log(ctx.personActor(by), 'asked', `Asked the agents: ${request}`, { shipmentId });

  const steps = ['Sending your request'];
  const shipments = await store.list('shipments');
  const documents = await store.list('documents', (d) => d.status === 'read');
  const openQuestions = await store.list('questions', (q) => q.status === 'open');
  const ai = await ctx.getAI();
  const route = (await ai.route(request, {
    shipments: shipments.map((s) => brief(s, documents)),
    openQuestions: openQuestions.map((q) => ({ id: q.id, shipmentId: q.shipmentId, text: q.text })),
  })) || {};
  const shipment = pickShipment(route.intent, { request, route, shipments, shipmentId, documents });
  const handler = HANDLERS[route.intent] || replyOnly;

  let out;
  try {
    out = await handler(ctx, deps, { route, shipment, steps, by });
  } catch (err) {
    steps.push('Stopped with an error');
    out = { reply: `The agents could not finish this: ${err.message}`, actions: [] };
  }
  const answer = { reply: out.reply, actions: out.actions || [], steps, intent: route.intent || 'other', shipmentId: shipment?.id || shipmentId || null };
  await ctx.postMessage({
    from: ctx.agentsFrom(), to: 'house', text: answer.reply, kind: 'reply',
    steps, actions: answer.actions, intent: answer.intent, shipmentId: answer.shipmentId,
  });
  return answer;
}

const HANDLERS = {
  prepare_papers: preparePapers,
  whats_missing: whatsMissing,
  build_packing_list: buildPackingList,
  status: statusReply,
  explain: replyOnly,
  other: replyOnly,
};

/** By id, then by a ref the person typed (ref, invoice, shipping bill or AWB number), else the latest open one. */
export function findShipment(shipments, ref, shipmentId) {
  if (shipmentId) {
    const byId = shipments.find((s) => s.id === shipmentId);
    if (byId) return byId;
  }
  if (ref) {
    const key = refKey(ref);
    const numbers = (s) => [s.ref, s.invoiceNumber, s.shippingBillNumber, s.hawb, s.mawb].filter(Boolean).map(refKey);
    return shipments.find((s) => numbers(s).includes(key))
      || (key.length >= 4 ? shipments.find((s) => numbers(s).some((n) => n.includes(key))) : null)
      || null; // a ref that matches nothing should not quietly pick another shipment
  }
  const open = shipments.filter((s) => !CLOSED.includes(s.status));
  return [...(open.length ? open : shipments)].sort(byNewest)[0] || null;
}

function refKey(value) {
  return String(value).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

const ABOUT_EVERY_SHIPMENT = ['whats_missing', 'status'];
const SAYS_LATEST = /\b(?:latest|last|newest|recent|current)\b/i;

/**
 * Which shipment a request is about:
 * 1. the shipment open on screen (shipmentId), or one whose number is typed in the message;
 * 2. one the model recognised from other words ("the Antwerp parcel"), when the message names its buyer or city;
 * 3. no shipment for "What is still missing?" or a status question: they are about every open shipment;
 * 4. for a packing list drafted from the chat, the shipment whose stones were typed in the chat;
 * 5. otherwise the latest open shipment: the one whose papers arrived last.
 * A number typed in the message that matches nothing gives null, so the reply can say so.
 */
export function pickShipment(intent, { request, route = {}, shipments = [], shipmentId = null, documents = [] }) {
  const byId = shipmentId ? shipments.find((s) => s.id === shipmentId) : null;
  if (byId) return byId;
  const typed = typedShipment(request, shipments);
  if (typed) return typed;
  const saysLatest = SAYS_LATEST.test(request);
  const byModel = route.shipmentRef ? findShipment(shipments, route.shipmentRef) : null;
  if (byModel && !saysLatest && describes(request, byModel)) return byModel;
  if (route.shipmentRef && !byModel && refKey(request).includes(refKey(route.shipmentRef))) return null; // typed, not on file
  if (ABOUT_EVERY_SHIPMENT.includes(intent) && !saysLatest) return null;
  if (intent === 'build_packing_list') return packingListShipment(shipments, documents) || latestOpen(shipments, documents);
  return latestOpen(shipments, documents);
}

/** A shipment whose ref, invoice, shipping bill or air waybill number is typed in the message. */
function typedShipment(request, shipments) {
  const typedText = refKey(request);
  const numbers = (s) => [s.ref, s.invoiceNumber, s.shippingBillNumber, s.hawb, s.mawb].filter(Boolean).map(refKey).filter((n) => n.length >= 5);
  return shipments.find((s) => numbers(s).some((n) => typedText.includes(n))) || null;
}

// Words that say nothing about which shipment is meant.
const PLAIN_WORDS = new Set(['sample', 'gems', 'diamond', 'diamonds', 'trading', 'jewels', 'fine', 'crystals', 'limited',
  'private', 'company', 'street', 'tower', 'suite', 'unit', 'plot', 'zone', 'free', 'avenue', 'road']);

/** Does the message name something of this shipment: its buyer, consignee, city or destination country? */
function describes(request, shipment) {
  const words = (text) => String(text || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !PLAIN_WORDS.has(w));
  const asked = words(request);
  const known = words([shipment.consignee?.name, shipment.consignee?.address, shipment.buyer?.name, shipment.consignee?.country,
    shipment.destinationCountry && shipment.destinationCountry.length > 3 ? shipment.destinationCountry : null].join(' '));
  return asked.some((a) => known.some((k) => a === k || (Math.min(a.length, k.length) >= 5 && (a.startsWith(k) || k.startsWith(a)))));
}

/** When the papers of each open shipment last arrived (or when it was started). */
function lastPaperAt(shipment, documents) {
  const times = documents.filter((d) => d.shipmentId === shipment.id).map((d) => String(d.createdAt || ''));
  return times.sort().pop() || String(shipment.createdAt || '');
}

/** The open shipment whose papers arrived last (falls back to any shipment when all are signed or sent). */
export function latestOpen(shipments, documents = []) {
  const open = shipments.filter((s) => !CLOSED.includes(s.status));
  const list = open.length ? open : shipments;
  return [...list].sort((a, b) => lastPaperAt(b, documents).localeCompare(lastPaperAt(a, documents)))[0] || null;
}

/** The shipment whose stones were typed in a chat or email, preferring one with no packing list on file yet. */
function packingListShipment(shipments, documents) {
  const open = shipments.filter((s) => !CLOSED.includes(s.status));
  const found = [];
  for (const doc of documents.filter((d) => d.docType === 'whatsapp_chat' || d.docType === 'email')) {
    for (const group of doc.insights?.packing || []) {
      if (!group.lines?.length) continue;
      const shipment = (group.ref && findShipment(open, group.ref)) || open.find((s) => s.id === doc.shipmentId) || null;
      if (shipment && !found.includes(shipment)) found.push(shipment);
    }
  }
  const hasList = (s) => documents.some((d) => d.shipmentId === s.id && d.docType === 'packing_list' && d.source?.kind !== 'generated');
  return found.find((s) => !hasList(s)) || found[0] || null;
}

function brief(s, documents = []) {
  return {
    id: s.id, ref: s.ref, status: s.status, invoiceNumber: s.invoiceNumber || null, shippingBillNumber: s.shippingBillNumber || null,
    hawb: s.hawb || null, destinationCountry: s.destinationCountry || null, consignee: s.consignee?.name || null,
    // "latest" means the shipment whose papers arrived last, not the record a run touched last.
    updatedAt: lastPaperAt(s, documents) || s.updatedAt || null,
  };
}

function noShipment(route) {
  return route.shipmentRef
    ? `No shipment matches ${route.shipmentRef}. Check the number, or add its papers first.`
    : 'There is no shipment yet. Add its papers and the agents will start.';
}

async function preparePapers(ctx, deps, { route, shipment, steps, by }) {
  if (!shipment) return { reply: noShipment(route), actions: [] };
  const name = shipment.ref || 'Your shipment';
  if (CLOSED.includes(shipment.status)) return { reply: `${name} is already ${shipment.status}. You can open it under Papers.`, actions: [] };
  const kinds = (route.kinds || []).filter((k) => BUILD_STEPS[k]);
  const before = new Set((await ctx.store.list('papers', (p) => p.shipmentId === shipment.id)).map((p) => `${p.id}:${p.version}`));

  steps.push('Matching your documents');
  await deps.run({ shipmentId: shipment.id, reason: 'asked by the house' });
  steps.push('Sanctions check', 'Checking the documents');
  const fresh = await ctx.store.get('shipments', shipment.id);
  if (!['ready_to_sign', 'held_for_review'].includes(fresh.status)) {
    const open = await ctx.store.list('questions', (q) => q.shipmentId === fresh.id && q.status === 'open');
    if (open.length) {
      return {
        reply: `${name} has ${plural(open.length, 'open question')} first: ${open.map((q) => q.text).join(' ')}`,
        actions: open.map((q) => ({ kind: 'question', questionId: q.id, text: q.text })),
      };
    }
    return { reply: `${name} is still collecting papers. Add the rest and the agents will finish it.`, actions: [] };
  }

  const wanted = kinds.length ? kinds : defaultKinds(fresh);
  // Papers the autopilot already built for exactly these documents are reused, not built twice.
  let papers = await currentPapers(ctx, fresh, wanted);
  if (papers && papers.every((p) => before.has(`${p.id}:${p.version}`))) {
    steps.push('The papers were already up to date');
  } else {
    steps.push(...wanted.map((k) => BUILD_STEPS[k]));
    if (!papers) papers = (await deps.buildPapers(fresh.id, { kinds: wanted, by })).papers;
  }
  const held = papers.some((p) => p.status === 'held_for_review');
  const list = papers.map((p) => `${PAPER_KIND_LABELS[p.kind]} ${p.ref} v${p.version}`).join(', ');
  return {
    reply: held ? `${list}: held for review. Jewel Labs checks it before you sign.` : `${list}: ready to sign.`,
    actions: papers.map((p) => ({ kind: 'paper', paperId: p.id, ref: p.ref, status: p.status })),
  };
}

/** The latest paper of each kind, if every one was built from the shipment as it is now. */
async function currentPapers(ctx, shipment, kinds) {
  const papers = await ctx.store.list('papers', (p) => p.shipmentId === shipment.id);
  const picked = kinds.map((kind) => papers.filter((p) => p.kind === kind).sort((a, b) => b.version - a.version)[0]);
  if (picked.some((p) => !p || !p.basis || p.basis !== shipment.checkedBasis)) return null;
  return picked;
}

async function whatsMissing(ctx, deps, { route, shipment, steps }) {
  steps.push('Checking the documents');
  const shipments = shipment ? [shipment] : await ctx.store.list('shipments', (s) => !CLOSED.includes(s.status));
  if (!shipments.length) return { reply: noShipment(route), actions: [] };
  const parts = [];
  const actions = [];
  for (const s of shipments) {
    const open = await ctx.store.list('questions', (q) => q.shipmentId === s.id && q.status === 'open');
    const name = s.ref || 'Shipment';
    if (!open.length) {
      parts.push(`${name}: nothing is missing. ${SHIPMENT_STATUS_LABELS[s.status] || s.status}.`);
      continue;
    }
    const papers = open.filter((q) => q.kind === 'missing_document');
    const others = open.filter((q) => q.kind !== 'missing_document');
    const bits = [];
    if (papers.length) bits.push(`${plural(papers.length, 'paper')} missing: ${papers.map(missingName).join(', ')}.`);
    if (others.length) bits.push(`${plural(others.length, 'question')} open: ${others.map((q) => q.text).join(' ')}`);
    parts.push(`${name}: ${bits.join(' ')}`);
    actions.push(...open.map((q) => ({ kind: 'question', questionId: q.id, text: q.text })));
  }
  return { reply: parts.join('\n'), actions };
}

function missingName(question) {
  return DOC_TYPE_LABELS[question.docType || question.key] || question.text;
}

async function buildPackingList(ctx, deps, { route, shipment, steps, by }) {
  if (!shipment) return { reply: noShipment(route), actions: [] };
  const { store } = ctx;
  const name = shipment.ref || 'the shipment';
  steps.push('Reading the chat and emails');
  const docs = await store.list('documents', (d) => d.status === 'read');
  const own = docs.filter((d) => d.shipmentId === shipment.id);
  const linked = (d) => d.shipmentId === shipment.id || mentions(d, shipment);
  // Stone lists typed in the chat come first: they are the stones. The other chat lines are context only.
  const chats = docs.filter((d) => d.kind === 'chat' && linked(d));
  const chatLines = [
    ...chats.flatMap((d) => (d.insights?.packing || []).map((p) => ({ text: `Packing notes for ${p.ref || name}`, ref: p.ref || null, lines: p.lines || [], docId: d.id }))),
    ...chats.flatMap((d) => (d.insights?.relevant || []).map((line) => ({ ...line, docId: d.id }))),
  ];
  const emails = docs.filter((d) => d.kind === 'email' && linked(d)).map((d) => ({ docId: d.id, ...(d.content?.email || {}), relevant: d.insights?.relevant || [] }));
  const documents = own.filter((d) => d.kind !== 'chat' && d.kind !== 'email')
    .map((d) => ({ id: d.id, fileName: d.fileName, docType: d.docType, fields: d.fields, lines: d.lines }));
  if (!chatLines.length && !emails.length && !documents.some((d) => d.lines?.length)) {
    return { reply: `There are no chat lines or emails about ${name} to draft a packing list from. Add the WhatsApp export or the email first.`, actions: [] };
  }

  steps.push('Drafting the packing list');
  const ai = await ctx.getAI();
  const draft = (await ai.draftPackingList({ shipment, chatLines, emails, documents })) || {};
  const lines = draft.lines || [];
  if (!lines.length) return { reply: `The chat and emails do not list the stones for ${name} yet, so there is nothing to draft.`, actions: [] };
  const papersModule = await ctx.load('papers');
  const house = await store.workspace();
  const pdf = await papersModule.buildPackingListDraft({ shipment, lines, sources: draft.sources || [], house });

  const doc = await deps.addGeneratedDocument({
    name: `Packing list draft ${safeFileName(shipment.ref || 'shipment')}.pdf`,
    bytes: pdf.bytes, shipment, docType: 'packing_list', lines, fields: refFields(shipment),
    summary: draft.notes || `Drafted by the agents from ${plural(chatLines.length, 'chat line')} and ${plural(emails.length, 'email')}`,
    sources: draft.sources || [],
  });
  const { previous, ref, version } = await nextVersion(ctx, papersModule, shipment, 'packing_list_draft');
  const paper = await savePaper(ctx, {
    previous, kind: 'packing_list_draft', shipment, ref, version, status: 'draft',
    output: { bytes: pdf.bytes, sha256: pdf.sha256, pages: 1, contents: [{ title: 'Packing list (drafted by agents)', docId: doc.id }] },
    basis: null, actor: by ? ctx.personActor(by) : ctx.agentActor('paperwork'),
  });

  steps.push('Matching your documents', 'Checking the documents');
  await deps.run({ shipmentId: shipment.id, reason: 'packing list drafted' });
  return {
    reply: `Drafted a packing list for ${name} with ${plural(lines.length, 'line')}. Check it against the parcel before you sign.`,
    actions: [{ kind: 'document', docId: doc.id }, { kind: 'paper', paperId: paper.id, ref: paper.ref, status: paper.status }],
  };
}

/** Does a chat or email talk about this shipment (by any of its numbers)? */
function mentions(doc, shipment) {
  const numbers = [shipment.ref, shipment.invoiceNumber, shipment.shippingBillNumber, shipment.hawb].filter(Boolean).map(refKey);
  const refs = (doc.refs || []).map(refKey);
  return refs.some((r) => numbers.includes(r));
}

/** The shipment's numbers as fields, so Records files the draft under the same shipment. */
function refFields(shipment) {
  const pairs = [
    ['invoice.number', shipment.invoiceNumber], ['shippingBill.number', shipment.shippingBillNumber], ['awb.hawb', shipment.hawb],
    ['exporter.name', shipment.exporter?.name], ['consignee.name', shipment.consignee?.name],
  ];
  return pairs.filter(([, value]) => value).map(([key, value]) => ({ key, value, quote: null, page: null, box: null, confidence: 1, agent: 'paperwork' }));
}

async function statusReply(ctx, deps, { route, shipment }) {
  if (!shipment) {
    const open = await ctx.store.list('shipments', (s) => !CLOSED.includes(s.status));
    if (!open.length) return { reply: noShipment(route), actions: [] };
    return { reply: open.map((s) => `${s.ref || 'Shipment'}: ${SHIPMENT_STATUS_LABELS[s.status] || s.status}.`).join('\n'), actions: [] };
  }
  const open = await ctx.store.list('questions', (q) => q.shipmentId === shipment.id && q.status === 'open');
  const parts = [`${shipment.ref || 'The shipment'}: ${SHIPMENT_STATUS_LABELS[shipment.status] || shipment.status}.`];
  if (shipment.summary?.total) parts.push(`${shipment.summary.passed} of ${shipment.summary.total} checks consistent.`);
  if (open.length) parts.push(`${plural(open.length, 'question')} open.`);
  return { reply: parts.join(' '), actions: [] };
}

async function replyOnly(ctx, deps, { route }) {
  return {
    reply: route.reply || 'I can prepare the papers for a shipment, tell you what is still missing, or draft a packing list from the chat.',
    actions: [],
  };
}
