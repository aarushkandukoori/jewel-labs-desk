// Paperwork agent: builds the statements the rules ask for plus the export or import pack.
// Each paper keeps one record per shipment and kind; a rebuild adds a new version file next to the old ones.
import { PAPER_KIND_LABELS, SHIPMENT_STATUS_LABELS } from '../types.js';
import { newId, plural, sha256Hex } from './context.js';
import { deskApproves } from './origin-stage.js';
import { saveShipment } from './shipment-save.js';

export const STATEMENT_KINDS = ['eu_dds', 'us_cbp_certificate', 'g7_gf_declaration'];
export const PACK_KINDS = ['export_pack', 'import_pack'];
const BUILD_READY = ['ready_to_sign', 'held_for_review'];
const CLOSED = ['signed', 'sent'];

/** A short fingerprint of what the papers are built from. Same fingerprint = nothing to rebuild. */
export function shipmentBasis(shipment, documents) {
  const docs = documents
    .map((d) => [d.id, d.sha256, d.docType, (d.fields || []).map((f) => `${f.key}=${f.value}`).join(';')])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const input = JSON.stringify({ docs, answers: shipment.answers || {}, notNeeded: shipment.notNeeded || [] });
  return sha256Hex(input).slice(0, 16);
}

/**
 * True when the shipment changed (new papers, new answers) since the agents last checked it, or the rules changed
 * since (a new version of the app), so its checks and questions are out of date. A signed or sent shipment is never
 * checked again, so it is not counted as changed.
 */
export async function changedSinceCheck(ctx, shipment) {
  if (CLOSED.includes(shipment.status)) return false;
  if ((shipment.rulesVersion || null) !== (await currentRulesVersion(ctx))) return true;
  const documents = await ctx.store.list('documents', (d) => d.shipmentId === shipment.id && d.status === 'read');
  return shipment.checkedBasis !== shipmentBasis(shipment, documents);
}

/** The version of the rules this copy of the app runs ('compliance.js 1.1'), or null. */
export async function currentRulesVersion(ctx) {
  return (await ctx.load('rules'))?.RULES_VERSION || null;
}

/** True when a paper was built from the shipment as the rules last checked it, under the same rules. */
export function builtFromCheck(paper, shipment) {
  return Boolean(paper && paper.basis && paper.basis === shipment.checkedBasis
    && (paper.rulesVersion || null) === (shipment.rulesVersion || null));
}

/** The statements the rules require, plus the pack for the direction of the parcel. */
export function defaultKinds(shipment) {
  const fromRules = (shipment.required || []).map((r) => r.kind).filter(isBuildable);
  const pack = shipment.direction === 'import' ? 'import_pack' : 'export_pack';
  return orderKinds([...fromRules, pack]);
}

function isBuildable(kind) {
  return STATEMENT_KINDS.includes(kind) || PACK_KINDS.includes(kind);
}

/** Statements first, then the pack, with no repeats. */
function orderKinds(kinds) {
  const unique = [...new Set(kinds)];
  return [...unique.filter((k) => STATEMENT_KINDS.includes(k)), ...unique.filter((k) => PACK_KINDS.includes(k))];
}

/**
 * Nothing uncertain reaches a pack: with a question open, or with papers or answers the agents have not checked
 * yet, the papers are only a draft. Otherwise they are held for a person when the house asked the desk to review
 * every pack, when the last check held the shipment, or when a check failed that the desk has not approved.
 */
function paperStatus(ctx, house, checks, shipment, { open, changed }) {
  if (open.length || changed) return 'draft';
  if (ctx.houseSetting(house, 'deskReview') === true) return 'held_for_review';
  if (shipment.status === 'held_for_review') return 'held_for_review';
  const failed = checks.some((c) => c.severity === 'fail');
  return failed && !deskApproves(shipment, checks) ? 'held_for_review' : 'ready_to_sign';
}

// Builds run one at a time for each house on this computer, so two builds never take the same paper number.
const paperLocks = new WeakMap();

/** Runs task after every other paper build of this house on this computer has finished. */
export function withPaperLock(ctx, task) {
  const run = (paperLocks.get(ctx.store) || Promise.resolve()).then(task);
  paperLocks.set(ctx.store, run.catch(() => {}));
  return run;
}

/** buildPapers(shipmentId, { kinds, by }) -> { papers, status } */
export function buildPapers(ctx, shipmentId, options = {}) {
  return withPaperLock(ctx, () => buildPapersNow(ctx, shipmentId, options));
}

async function buildPapersNow(ctx, shipmentId, { kinds, by } = {}) {
  const { store } = ctx;
  const shipment = await store.get('shipments', shipmentId);
  if (!shipment) throw new Error('That shipment is no longer there.');
  const actor = by && by.type === 'agent' ? by : ctx.personActor(by);
  const changed = await changedSinceCheck(ctx, shipment);
  // Something came in while the agents were checking: the run after this one checks it again and builds then.
  if (changed && actor.type === 'agent') return { papers: [], status: shipment.status };
  const papersModule = await ctx.load('papers');
  const records = await ctx.load('records');
  const house = await store.workspace();
  const onFile = await store.list('documents', (d) => d.shipmentId === shipmentId && d.status === 'read');
  // A packing list the agents drafted is left out of the pack once the house's own packing list arrived, and so is
  // a grading report the house said is not part of the shipment.
  const documents = records.shipmentDocuments(shipment, onFile);
  const stones = await store.list('stones', (s) => s.shipmentId === shipmentId);
  const checks = await store.list('checks', (c) => c.shipmentId === shipmentId);
  const open = await store.list('questions', (q) => q.shipmentId === shipmentId && q.status === 'open');
  const status = paperStatus(ctx, house, checks, shipment, { open, changed });
  const wanted = orderKinds((kinds && kinds.length ? kinds : defaultKinds(shipment)).filter(isBuildable));
  if (!wanted.length) throw new Error('Nothing to build: pick a statement or a pack.');
  const job = {
    shipment, documents, stones, checks, house, status, actor,
    basis: shipment.checkedBasis || shipmentBasis(shipment, onFile),
  };

  const built = [];
  for (const kind of wanted) {
    const paper = await buildOne(ctx, papersModule, { ...job, kind });
    if (paper) built.push(paper);
  }
  if (!built.length) return { papers: [], status: shipment.status }; // signed while the agents were working: nothing replaced

  // A draft leaves the shipment as the last check left it. Otherwise the shipment follows its papers.
  if (status !== 'draft') {
    const latest = (await store.get('shipments', shipmentId)) || shipment;
    const next = { ...latest, status, papersBuiltAt: ctx.nowIso() };
    // A person rebuilding a signed pack wants it signed again; the agents never reopen a signed shipment.
    if (actor.type === 'agent') await saveShipment(ctx, next);
    else await store.put('shipments', next);
  }
  await announce(ctx, shipment, built, status, actor, { open, changed });
  return { papers: built, status };
}

async function buildOne(ctx, papersModule, { kind, shipment, documents, stones, checks, house, status, basis, actor }) {
  const { previous, ref, version } = await nextVersion(ctx, papersModule, shipment, kind);
  // The agents never write over a paper a person has signed or sent.
  if (actor.type === 'agent' && previous && CLOSED.includes(previous.status)) return null;
  // A statement on its own lists the same evidence as its copy in the pack, under its own ref and version.
  const output = STATEMENT_KINDS.includes(kind)
    ? await papersModule.buildStatement({ kind, shipment, documents, stones, house, status, ref, version })
    : await papersModule.buildPack({
      kind, shipment, documents, stones, checks, required: shipment.required || [], house,
      getFile: (key) => ctx.store.getFile(key), ref, version, status,
      rulesVersion: shipment.rulesVersion || undefined, // the rules that checked this shipment
    });
  return savePaper(ctx, { previous, kind, shipment, ref, version, status, output, basis, actor });
}

/** The ref stays the same across versions; a new kind gets the next free ref. */
export async function nextVersion(ctx, papersModule, shipment, kind) {
  const all = await ctx.store.list('papers');
  const previous = all.filter((p) => p.shipmentId === shipment.id && p.kind === kind).sort((a, b) => b.version - a.version)[0] || null;
  const version = previous ? previous.version + 1 : 1;
  const ref = previous?.ref || (await firstRef(ctx, papersModule, kind, all));
  return { previous, ref, version };
}

/**
 * The ref of a paper built for the first time. A shared house takes the number from the server (store.reserveRef),
 * so another computer of the house building a paper the same day never takes the same one; offline, a first build
 * waits. A house on this computer only counts the papers it has.
 */
async function firstRef(ctx, papersModule, kind, all) {
  const local = await papersModule.nextRef(kind, ctx.now(), all.map((p) => p.ref)); // 'JL-EXP-1116-03'
  if (typeof ctx.store.reserveRef !== 'function') return local;
  const stem = local.slice(0, local.lastIndexOf('-') + 1);
  const highestSeen = Number(local.slice(stem.length)) - 1;
  let number;
  try {
    number = await ctx.store.reserveRef(stem, highestSeen);
  } catch {
    throw new Error('A new paper takes its number from Jewel Labs, so two computers never give two papers the same one, and the cloud cannot be reached now. Build it again once you are online.');
  }
  return number ? `${stem}${String(number).padStart(2, '0')}` : local;
}

/** Stores the PDF at papers/<paperId>/<ref>-v<version>.pdf and the paper record (one record per shipment and kind). */
export async function savePaper(ctx, { previous: before, kind, shipment, ref, version, status, output, basis, actor }) {
  const id = before?.id || newId('pap');
  const fileKey = `papers/${id}/${ref}-v${version}.pdf`;
  await ctx.store.putFile(fileKey, output.bytes, 'application/pdf');
  // Building takes a while: a person may have signed or sent the paper meanwhile. The agents never write over
  // that; a person rebuilding on purpose keeps that signature in the version history.
  // (The PDF just written then stays unused: files under papers/ are write-once on a shared house.)
  const previous = before ? (await ctx.store.get('papers', before.id)) || before : null;
  if (actor.type === 'agent' && previous && CLOSED.includes(previous.status)) return null;
  const sha256 = output.sha256 || sha256Hex(output.bytes);
  const builtAt = ctx.nowIso();
  // The history keeps each version as it ended: a signed or sent version keeps its signature and its file.
  const versions = (previous?.versions || []).map((v) => (v.version === previous.version ? {
    ...v, status: previous.status, fileKey: previous.fileKey, sha256: previous.sha256,
    signedBy: previous.signedBy || null, signedAt: previous.signedAt || null, sentTo: previous.sentTo || null, sentAt: previous.sentAt || null,
  } : v));
  const paper = {
    ...previous,
    id, shipmentId: shipment.id, kind, ref, version, status, fileKey, sha256,
    pages: output.pages || 1,
    contents: output.contents || [],
    builtAt, builtBy: actor.name, basis: basis || null,
    rulesVersion: shipment.rulesVersion || null, // the rules that checked the shipment this version was built from
    deskEdits: shipment.deskEdits || 0,
    houseEdits: shipment.houseEdits || 0,
    signedBy: null, signerTitle: null, signedAt: null, unsignedFileKey: null,
    sentTo: null, sentCc: null, sentAt: null, deskNote: null, approvedBy: null, approvedAt: null,
    versions: [...versions, { version, fileKey, sha256, builtAt, status }],
  };
  await ctx.store.put('papers', paper);
  return paper;
}

async function announce(ctx, shipment, built, status, actor, { open, changed }) {
  const name = shipment.ref || 'the shipment';
  const statusText = status === 'draft'
    ? (open.length ? 'draft, questions still open' : 'draft, changed since the last check')
    : SHIPMENT_STATUS_LABELS[status].toLowerCase();
  for (const paper of built) {
    const label = PAPER_KIND_LABELS[paper.kind] || paper.kind;
    const detail = `${label} ${paper.ref} v${paper.version} for ${name}: ${statusText}`;
    ctx.agentEvent('paperwork', 'paper', detail, { shipmentId: shipment.id, paperId: paper.id });
    await ctx.log(actor.type === 'agent' ? actor : ctx.agentActor('paperwork'), 'built', detail, { shipmentId: shipment.id, paperId: paper.id });
    await ctx.usage('pack_built', { paperId: paper.id, shipmentId: shipment.id, kind: paper.kind, version: paper.version, status });
  }
  const refs = built.map((p) => p.ref).join(', ');
  if (status === 'draft') {
    const why = open.length
      ? `Answer the ${plural(open.length, 'open question')} on ${name}, then build the papers again to sign them.`
      : `${name} changed since the agents last checked it. Build the papers again once they have checked it, then sign.`;
    await ctx.notifyUser({ kind: 'questions', shipmentId: shipment.id, title: `Draft only: ${name}`, body: `${refs} is a draft. ${why}` });
    return;
  }
  await ctx.notifyUser(status === 'held_for_review'
    ? { kind: 'pack_held', shipmentId: shipment.id, title: `Pack held for review: ${name}`, body: `${refs} waits for a person at Jewel Labs to check it.` }
    : { kind: 'pack_ready', shipmentId: shipment.id, title: `Ready to sign: ${name}`, body: `${refs} is ready to sign.` });
}

/**
 * After the Review agent's questions: with autopilot on, the Paperwork agent builds the papers once the shipment
 * is ready (no question open, every check passed or held for a person). With autopilot off, they wait for a person.
 */
export async function buildIfReady(ctx, shipment, { autopilot, fresh }) {
  if (!BUILD_READY.includes(shipment.status)) return null;
  const name = shipment.ref || 'the shipment';
  if (!autopilot) {
    if (fresh) ctx.agentEvent('review', 'done', `${name} is ready to build. Autopilot is off, so the papers wait for you.`, { shipmentId: shipment.id });
    return null;
  }
  const packs = await ctx.store.list('papers', (p) => p.shipmentId === shipment.id && PACK_KINDS.includes(p.kind));
  // The pack already matches these papers and these rules. A draft never counts: it was built while something
  // was uncertain.
  if (packs.some((p) => builtFromCheck(p, shipment) && p.status !== 'draft')) return null;
  const built = await buildPapers(ctx, shipment.id, { by: ctx.agentActor('paperwork') });
  return built.papers.length ? built : null;
}
