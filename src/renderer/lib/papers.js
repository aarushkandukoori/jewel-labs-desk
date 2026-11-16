// What the screens say about a paper: who signs it, the note under it, the email that goes with it. Pure
// functions, so test/unit/renderer.test.js checks them.
import { paperKindLabel, day, dayTime } from './format.js';

const PACKS = ['export_pack', 'import_pack'];
const IMPORTER_STATEMENTS = ['eu_dds', 'us_cbp_certificate'];

/**
 * True for an EU or US statement the house drafted for its importer: on any shipment that is not an import, the
 * importer signs the statement and the house only signs the "Prepared and checked by" strip. Mirrors
 * letterheadFor in src/core/papers/statements.js (the screens cannot import src/core: the website ships this folder).
 */
export function isImporterDraft(paper, shipment) {
  return IMPORTER_STATEMENTS.includes(paper?.kind) && shipment?.direction !== 'import';
}

export const isPack = (paper) => PACKS.includes(paper?.kind);

/** "pack" for packs, "paper" for statements. */
export function paperNoun(paper) {
  return isPack(paper) ? 'pack' : 'paper';
}

/**
 * Why a pack is held. Signed in, Jewel Labs reviews it. In a local workspace nobody else sees it, so the note
 * says what failed and how to go on, instead of promising a review that never comes.
 */
function heldNote({ checks = [], signedIn }) {
  if (signedIn) return 'Held for review: Jewel Labs checks it before you sign. You get a message when it is approved.';
  const failed = checks.filter((c) => c.severity === 'fail').map((c) => c.title).filter(Boolean);
  if (failed.length) return `A check failed: ${failed.join('; ')}. Fix it and run the agents again, or sign in so Jewel Labs can review it.`;
  return 'Held for review by Jewel Labs. Sign in so Jewel Labs can review it; this workspace is on this computer only.';
}

/** The one-line note under a paper: what happens next. context: { shipment, checks, signedIn }. */
export function paperNote(paper, { shipment = null, checks = [], signedIn = true } = {}) {
  if (paper.deskNote && paper.status !== 'sent') return paper.deskNote;
  const forImporter = isImporterDraft(paper, shipment);
  const importer = shipment?.consignee?.name || 'the importer';
  switch (paper.status) {
    case 'held_for_review':
      return heldNote({ checks, signedIn });
    case 'ready_to_sign':
      return forImporter
        ? `Draft for ${importer}. Check it and sign as the preparer; the importer signs the statement.`
        : 'Ready to sign. Check it, then sign it and send it from your own mailbox.';
    case 'signed':
      return forImporter
        ? `Checked by ${paper.signedBy || 'you'}${paper.signedAt ? ` on ${day(paper.signedAt)}` : ''}. Send it to the importer to sign.`
        : `Signed by ${paper.signedBy || 'you'}${paper.signedAt ? ` on ${day(paper.signedAt)}` : ''}. Send it to your broker or download it.`;
    case 'sent':
      return forImporter
        ? `Sent to ${paper.sentTo || 'the importer'}${paper.sentAt ? ` on ${dayTime(paper.sentAt)}` : ''} for the importer to sign.`
        : `Sent to ${paper.sentTo || 'your broker'}${paper.sentAt ? ` on ${dayTime(paper.sentAt)}` : ''}.`;
    case 'draft':
      return 'A draft from the agents. Check it before you use it.';
    default:
      return '';
  }
}

/** paperNote with the paper's shipment and checks from the app state. */
export function paperNoteFor(paper, state) {
  return paperNote(paper, {
    shipment: state.data.shipments.find((s) => s.id === paper.shipmentId) || null,
    checks: state.data.checks.filter((c) => c.shipmentId === paper.shipmentId),
    signedIn: Boolean(state.auth?.signedIn),
  });
}

/** The first message of the email: what is attached and what the reader does with it. */
export function sendBody(paper, { shipment, house, signer }) {
  const forShipment = shipment?.ref ? ` for shipment ${shipment.ref}` : '';
  const sign = `\n\nRegards,\n${signer || ''}\n${house}`;
  if (isImporterDraft(paper, shipment)) {
    return `Hello,\n\nAttached is the ${paperKindLabel(paper.kind)} ${paper.ref}${forShipment}, prepared and checked by ${house}. `
      + 'Please sign it as the importer. It goes with the shipment at import, and you keep it for 5 years.'
      + sign;
  }
  const label = paperKindLabel(paper.kind).replace(' (draft)', '');
  const consignee = shipment?.consignee?.name ? ` to ${shipment.consignee.name}` : '';
  const originals = isPack(paper) ? ' The originals follow in the order customs reads them.' : '';
  return `Hello,\n\nAttached is the signed ${label} ${paper.ref}${forShipment}${consignee}.${originals}\n\nPlease lodge it with the declaration.${sign}`;
}
