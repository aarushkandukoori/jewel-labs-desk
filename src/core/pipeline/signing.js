// A person signs a paper (the PDF is stamped and its SHA-256 recorded) and sends it from the house's own mailbox.
// Jewel Labs never lodges anything: the house or its broker does. Statuses are "signed" and "sent".
import { PAPER_KIND_LABELS } from '../types.js';
import { personName, sha256Hex } from './context.js';
import { PACK_KINDS, STATEMENT_KINDS, builtFromCheck, changedSinceCheck, currentRulesVersion } from './paperwork.js';
import { currentListDate } from './sanctions-stage.js';

/**
 * options.recheck(shipmentId): asks the agents to check the shipment again. It is called when signing has to wait
 * for that (the papers changed since this version was built, or a newer OFAC SDN list came out).
 */
export async function signPaper(ctx, paperId, signature = {}, by, { recheck } = {}) {
  const { store } = ctx;
  const paper = await store.get('papers', paperId);
  if (!paper) throw new Error('That paper is no longer there.');
  if (paper.status === 'held_for_review') throw new Error('This pack is held for review. It can be signed once Jewel Labs approves it.');
  if (paper.status === 'signed' || paper.status === 'sent') throw new Error('This paper is already signed.');
  if (paper.status !== 'ready_to_sign') throw new Error('This paper is a draft. Answer the open questions, then build it again to sign it.');
  const shipment = await store.get('shipments', paper.shipmentId);
  await checkStillReady(ctx, paper, shipment, recheck);
  const name = String(signature.name || (by ? personName(by) : '')).trim();
  if (!name) throw new Error('Type the name of the person signing.');

  const papersModule = await ctx.load('papers');
  const signedAt = ctx.nowIso();
  const unsigned = await store.getFile(paper.fileKey);
  const signed = await papersModule.signPdf(unsigned, {
    name, title: signature.title || '', signedAt, signatureDataUrl: signature.signatureDataUrl,
  });
  const fileKey = `papers/${paper.id}/${paper.ref}-v${paper.version}-signed.pdf`;
  await store.putFile(fileKey, signed.bytes, 'application/pdf');
  const next = {
    ...paper, status: 'signed', unsignedFileKey: paper.fileKey, fileKey,
    sha256: signed.sha256 || sha256Hex(signed.bytes), signedBy: name, signerTitle: signature.title || null, signedAt,
  };
  await store.put('papers', next);
  await setShipmentStatus(ctx, next, 'signed');

  const label = PAPER_KIND_LABELS[paper.kind] || paper.kind;
  // On an export the importer signs the statement itself; the house's signature only says it checked the draft.
  const what = forImporter(paper, shipment)
    ? `Checked ${label} ${paper.ref} v${paper.version}. The importer signs it.`
    : `Signed ${label} ${paper.ref} v${paper.version}`;
  await ctx.usage('pack_signed', { paperId, shipmentId: paper.shipmentId, kind: paper.kind, by: personName(by || name) }, by || name);
  await ctx.log(ctx.personActor(by || name), 'signed', what, { shipmentId: paper.shipmentId, paperId });
  return next;
}

/**
 * A paper is signed only as it was built from the shipment as the agents last checked it (under the rules this copy
 * of the app runs), with no question open, and screened against the newest OFAC SDN list. Otherwise signing waits,
 * and the agents check the shipment again.
 */
async function checkStillReady(ctx, paper, shipment, recheck) {
  if (!shipment) return;
  const open = await ctx.store.list('questions', (q) => q.shipmentId === shipment.id && q.status === 'open');
  if (open.length) throw new Error(`Answer the open questions on ${shipment.ref || 'this shipment'} before signing: ${open[0].text}`);
  const again = () => { if (typeof recheck === 'function') recheck(shipment.id); };
  // A new version of the app may bring new rules: a paper built under the old ones is not signed as it is.
  const rules = await currentRulesVersion(ctx);
  if ((paper.rulesVersion || null) !== rules || (shipment.rulesVersion || null) !== rules) {
    again();
    throw new Error('The compliance rules were updated after this version was built. The agents check the shipment again: build the papers once it is ready, then sign the new version.');
  }
  if (!builtFromCheck(paper, shipment) || (await changedSinceCheck(ctx, shipment))) {
    again();
    throw new Error('New papers or answers came in after this version was built. The agents check the shipment again: build the papers once it is ready, then sign the new version.');
  }
  const listDate = await currentListDate(ctx);
  if (listDate && shipment.sdnListDate !== listDate) {
    again();
    throw new Error(`The OFAC SDN list was updated (${listDate}) after ${shipment.ref || 'this shipment'} was screened. The agents screen it again: sign once it shows Ready to sign.`);
  }
}

/** On an export, the statements (EU DDS, US CBP self-certification, G7 note) are drafts the importer signs. */
function forImporter(paper, shipment) {
  return STATEMENT_KINDS.includes(paper.kind) && shipment?.direction !== 'import';
}

/**
 * Sends a signed paper. With no mailbox connected it returns { error, code: 'no_mailbox', download: true }
 * so the screen can offer a download instead.
 */
export async function sendPaper(ctx, paperId, mail = {}, by, { mailConfig } = {}) {
  const { store } = ctx;
  const paper = await store.get('papers', paperId);
  if (!paper) throw new Error('That paper is no longer there.');
  if (paper.status !== 'signed' && paper.status !== 'sent') throw new Error('Sign this paper before sending it.');
  const to = addressList(mail.to);
  if (!to.length) throw new Error('Add who to send it to.');
  if (!mailConfig) {
    return {
      error: 'No mailbox is connected. Download the pack and send it from your own email, or connect your mailbox in Settings.',
      code: 'no_mailbox',
      download: true,
    };
  }

  const mailModule = await ctx.load('mail');
  const shipment = await store.get('shipments', paper.shipmentId);
  const label = PAPER_KIND_LABELS[paper.kind] || 'Paper';
  const bytes = await store.getFile(paper.fileKey);
  const cc = addressList(mail.cc);
  const signedLine = forImporter(paper, shipment)
    ? `checked by ${paper.signedBy}, for the importer to sign`
    : `signed by ${paper.signedBy}`;
  const sent = await mailModule.sendMail({
    ...mailConfig,
    to,
    cc,
    subject: mail.subject || `${label} ${paper.ref}${shipment?.ref ? ` for ${shipment.ref}` : ''}`,
    text: mail.body || `Please find attached ${label} ${paper.ref}, version ${paper.version}, ${signedLine}.`,
    attachments: [{ filename: `${paper.ref}-v${paper.version}.pdf`, content: bytes, contentType: 'application/pdf' }],
  });

  const next = { ...paper, status: 'sent', sentTo: to.join(', '), sentCc: cc.join(', ') || null, sentAt: ctx.nowIso(), messageId: sent?.messageId || null };
  await store.put('papers', next);
  await setShipmentStatus(ctx, next, 'sent');
  await ctx.usage('pack_sent', { paperId, shipmentId: paper.shipmentId, kind: paper.kind, to: next.sentTo, by: personName(by) }, by);
  await ctx.log(ctx.personActor(by), 'sent', `Sent ${label} ${paper.ref} v${paper.version} to ${next.sentTo} from ${mailConfig.email}`, { shipmentId: paper.shipmentId, paperId });
  return next;
}

/** 'a@x.com, b@y.com' or ['a@x.com'] -> clean list. */
function addressList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  return list.map((v) => String(v || '').trim()).filter(Boolean);
}

/** Signing or sending the pack itself moves the whole shipment along. */
async function setShipmentStatus(ctx, paper, status) {
  if (!PACK_KINDS.includes(paper.kind)) return;
  const shipment = await ctx.store.get('shipments', paper.shipmentId);
  if (shipment) await ctx.store.put('shipments', { ...shipment, status });
}
