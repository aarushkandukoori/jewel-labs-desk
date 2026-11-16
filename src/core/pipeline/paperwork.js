// Paperwork agent: builds the statements the rules ask for plus the export or import pack.
// Each paper keeps one record per shipment and kind; a rebuild adds a new version file next to the old ones.
import { PAPER_KIND_LABELS, SHIPMENT_STATUS_LABELS } from '../types.js';
import { newId, sha256Hex } from './context.js';
import { saveShipment } from './shipment-save.js';

export const STATEMENT_KINDS = ['eu_dds', 'us_cbp_certificate', 'g7_gf_declaration'];
export const PACK_KINDS = ['export_pack', 'import_pack'];
const BUILD_READY = ['ready_to_sign', 'held_for_review'];

/** A short fingerprint of what the papers are built from. Same fingerprint = nothing to rebuild. */
export function shipmentBasis(shipment, documents) {
  const docs = documents
    .map((d) => [d.id, d.sha256, d.docType, (d.fields || []).map((f) => `${f.key}=${f.value}`).join(';')])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const input = JSON.stringify({ docs, answers: shipment.answers || {}, notNeeded: shipment.notNeeded || [] });
  return sha256Hex(input).slice(0, 16);
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

/** Held for a person when the house asked the desk to review every pack, or when a check failed. */
function paperStatus(ctx, house, checks, shipment) {
  if (ctx.houseSetting(house, 'deskReview') === true) return 'held_for_review';
  const failed = checks.some((c) => c.severity === 'fail');
  const approved = shipment.deskApproved && shipment.deskApproved.basis === shipment.checkedBasis;
  return failed && !approved ? 'held_for_review' : 'ready_to_sign';
}

/** buildPapers(shipmentId, { kinds, by }) -> { papers, status } */
export async function buildPapers(ctx, shipmentId, { kinds, by } = {}) {
  const { store } = ctx;
  const shipment = await store.get('shipments', shipmentId);
  if (!shipment) throw new Error('That shipment is no longer there.');
  const papersModule = await ctx.load('papers');
  const house = await store.workspace();
  const documents = await store.list('documents', (d) => d.shipmentId === shipmentId && d.status === 'read');
  const stones = await store.list('stones', (s) => s.shipmentId === shipmentId);
  const checks = await store.list('checks', (c) => c.shipmentId === shipmentId);
  const status = paperStatus(ctx, house, checks, shipment);
  const wanted = orderKinds((kinds && kinds.length ? kinds : defaultKinds(shipment)).filter(isBuildable));
  if (!wanted.length) throw new Error('Nothing to build: pick a statement or a pack.');
  const job = {
    shipment, documents, stones, checks, house, status,
    basis: shipment.checkedBasis || shipmentBasis(shipment, documents),
    actor: by && by.type === 'agent' ? by : ctx.personActor(by),
  };

  const built = [];
  for (const kind of wanted) {
    const paper = await buildOne(ctx, papersModule, { ...job, kind });
    if (paper) built.push(paper);
  }
  if (!built.length) return { papers: [], status: shipment.status }; // signed while the agents were working: nothing replaced

  const latest = (await store.get('shipments', shipmentId)) || shipment;
  const next = { ...latest, status, papersBuiltAt: ctx.nowIso() };
  // A person rebuilding a signed pack wants it signed again; the agents never reopen a signed shipment.
  if (job.actor.type === 'agent') await saveShipment(ctx, next);
  else await store.put('shipments', next);
  await announce(ctx, shipment, built, status, job.actor);
  return { papers: built, status };
}

async function buildOne(ctx, papersModule, { kind, shipment, documents, stones, checks, house, status, basis, actor }) {
  const { previous, ref, version } = await nextVersion(ctx, papersModule, shipment, kind);
  // The agents never write over a paper a person has signed or sent.
  if (actor.type === 'agent' && previous && (previous.status === 'signed' || previous.status === 'sent')) return null;
  const output = STATEMENT_KINDS.includes(kind)
    ? await papersModule.buildStatement({ kind, shipment, stones, house, status })
    : await papersModule.buildPack({
      kind, shipment, documents, stones, checks, required: shipment.required || [], house,
      getFile: (key) => ctx.store.getFile(key), ref, version, status,
    });
  return savePaper(ctx, { previous, kind, shipment, ref, version, status, output, basis, actor });
}

/** The ref stays the same across versions; a new kind gets the next free ref. */
export async function nextVersion(ctx, papersModule, shipment, kind) {
  const all = await ctx.store.list('papers');
  const previous = all.filter((p) => p.shipmentId === shipment.id && p.kind === kind).sort((a, b) => b.version - a.version)[0] || null;
  const version = previous ? previous.version + 1 : 1;
  const ref = previous?.ref || (await papersModule.nextRef(kind, ctx.now(), all.map((p) => p.ref)));
  return { previous, ref, version };
}

/** Stores the PDF at papers/<paperId>/<ref>-v<version>.pdf and the paper record (one record per shipment and kind). */
export async function savePaper(ctx, { previous, kind, shipment, ref, version, status, output, basis, actor }) {
  const id = previous?.id || newId('pap');
  const fileKey = `papers/${id}/${ref}-v${version}.pdf`;
  await ctx.store.putFile(fileKey, output.bytes, 'application/pdf');
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
    deskEdits: shipment.deskEdits || 0,
    houseEdits: shipment.houseEdits || 0,
    signedBy: null, signerTitle: null, signedAt: null, unsignedFileKey: null,
    sentTo: null, sentCc: null, sentAt: null, deskNote: null, approvedBy: null, approvedAt: null,
    versions: [...versions, { version, fileKey, sha256, builtAt, status }],
  };
  await ctx.store.put('papers', paper);
  return paper;
}

async function announce(ctx, shipment, built, status, actor) {
  const name = shipment.ref || 'the shipment';
  for (const paper of built) {
    const label = PAPER_KIND_LABELS[paper.kind] || paper.kind;
    const detail = `${label} ${paper.ref} v${paper.version} for ${name}: ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}`;
    ctx.agentEvent('paperwork', 'paper', detail, { shipmentId: shipment.id, paperId: paper.id });
    await ctx.log(actor.type === 'agent' ? actor : ctx.agentActor('paperwork'), 'built', detail, { shipmentId: shipment.id, paperId: paper.id });
    await ctx.usage('pack_built', { paperId: paper.id, shipmentId: shipment.id, kind: paper.kind, version: paper.version, status });
  }
  const refs = built.map((p) => p.ref).join(', ');
  await ctx.notifyUser(status === 'held_for_review'
    ? { kind: 'pack_held', shipmentId: shipment.id, title: `Pack held for review: ${name}`, body: `${refs} waits for a person at Jewel Labs to check it.` }
    : { kind: 'pack_ready', shipmentId: shipment.id, title: `Ready to sign: ${name}`, body: `${refs} is ready to sign.` });
}

/** Review step after the rules: with autopilot on, build the papers once the shipment is ready. */
export async function reviewShipment(ctx, shipment, { autopilot, fresh }) {
  if (!BUILD_READY.includes(shipment.status)) return null;
  const name = shipment.ref || 'the shipment';
  if (!autopilot) {
    if (fresh) ctx.agentEvent('review', 'done', `${name} is ready to build. Autopilot is off, so the papers wait for you.`, { shipmentId: shipment.id });
    return null;
  }
  const packs = await ctx.store.list('papers', (p) => p.shipmentId === shipment.id && PACK_KINDS.includes(p.kind));
  if (packs.some((p) => p.basis && p.basis === shipment.checkedBasis)) return null; // the pack already matches these papers
  return buildPapers(ctx, shipment.id, { by: ctx.agentActor('paperwork') });
}
