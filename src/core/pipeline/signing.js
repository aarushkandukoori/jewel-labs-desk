// A person signs a paper (the PDF is stamped and its SHA-256 recorded) and sends it from the house's own mailbox.
// Jewel Labs never lodges anything: the house or its broker does. Statuses are "signed" and "sent".
import { PAPER_KIND_LABELS } from '../types.js';
import { personName, sha256Hex } from './context.js';
import { PACK_KINDS } from './paperwork.js';

export async function signPaper(ctx, paperId, signature = {}, by) {
  const { store } = ctx;
  const paper = await store.get('papers', paperId);
  if (!paper) throw new Error('That paper is no longer there.');
  if (paper.status === 'held_for_review') throw new Error('This pack is held for review. It can be signed once Jewel Labs approves it.');
  if (paper.status === 'signed' || paper.status === 'sent') throw new Error('This paper is already signed.');
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
  await ctx.usage('pack_signed', { paperId, shipmentId: paper.shipmentId, kind: paper.kind, by: personName(by || name) }, by || name);
  await ctx.log(ctx.personActor(by || name), 'signed', `Signed ${label} ${paper.ref} v${paper.version}`, { shipmentId: paper.shipmentId, paperId });
  return next;
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
  const sent = await mailModule.sendMail({
    ...mailConfig,
    to,
    cc,
    subject: mail.subject || `${label} ${paper.ref}${shipment?.ref ? ` for ${shipment.ref}` : ''}`,
    text: mail.body || `Please find attached ${label} ${paper.ref}, version ${paper.version}, signed by ${paper.signedBy}.`,
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
