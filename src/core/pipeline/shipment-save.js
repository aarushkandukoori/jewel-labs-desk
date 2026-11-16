// How the agents save a shipment. A run works from a copy it read a moment ago; meanwhile a person may have
// answered a question, the desk may have approved, or someone may have signed. Those facts belong to people,
// so they are always taken from the newest record in the store, never from the agents' older copy.
import { applyAnswers } from './answers.js';
import { sameRecord } from './context.js';

const PERSON_FIELDS = ['answers', 'notNeeded', 'houseEdits', 'deskEdits', 'deskApproved'];
const CLOSED = ['signed', 'sent'];

export async function saveShipment(ctx, shipment) {
  const latest = await ctx.store.get('shipments', shipment.id);
  const merged = { ...shipment };
  if (latest) {
    for (const key of PERSON_FIELDS) if (latest[key] !== undefined) merged[key] = latest[key];
    if (CLOSED.includes(latest.status)) merged.status = latest.status; // a signed shipment stays signed
  }
  applyAnswers(merged); // what the house told us beats what the papers say
  if (latest && sameRecord(latest, merged)) return latest; // nothing new: leave the record (and its updatedAt) alone
  await ctx.store.put('shipments', merged);
  return merged;
}
