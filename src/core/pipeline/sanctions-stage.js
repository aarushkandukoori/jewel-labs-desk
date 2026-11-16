// Sanctions agent: screens every party on a shipment against the OFAC SDN list.
// A name screened in the last 24 hours (against the same list) is not screened again.
import { newId, normalizeName, hoursBetween } from './context.js';

export const PARTY_ROLES = ['exporter', 'consignee', 'buyer', 'supplier', 'carrier', 'broker', 'insurer'];
const RESCREEN_HOURS = 24;

/** Returns the screenings for the rules: [{ name, role, roles, status, best, compared, listDate, partyId }]. */
export async function screenShipmentParties(ctx, shipment) {
  const documents = await ctx.store.list('documents', (d) => d.shipmentId === shipment.id && d.status === 'read');
  const parties = collectParties(shipment, documents);
  if (!parties.length) return [];
  const house = await ctx.store.workspace();
  if (house.permissions?.ofacScreen === false) {
    ctx.agentEvent('sanctions', 'done', 'OFAC screening is off for this house', { shipmentId: shipment.id });
    return parties.map((p) => ({ name: p.name, role: p.roles[0], roles: p.roles, status: 'not_screened', best: null, compared: 0, listDate: null, partyId: null }));
  }
  const sanctions = await ctx.load('sanctions');
  const index = await ctx.getSdnIndex();
  const screenings = [];
  for (const party of parties) screenings.push(await screenParty(ctx, sanctions, index, party, shipment));
  return screenings;
}

/** Distinct parties from the shipment record and from every document field like "carrier.name". */
export function collectParties(shipment, documents = []) {
  const byName = new Map();
  const add = (role, name, country) => {
    const normalized = normalizeName(name);
    if (normalized.length < 2) return;
    if (!byName.has(normalized)) byName.set(normalized, { name: String(name).trim(), normalized, roles: [], country: null });
    const party = byName.get(normalized);
    if (!party.roles.includes(role)) party.roles.push(role);
    if (!party.country && country) party.country = country;
  };
  for (const role of PARTY_ROLES) {
    const party = shipment?.[role];
    if (party?.name) add(role, party.name, party.country);
  }
  for (const doc of documents) {
    for (const field of doc.fields || []) {
      const [role, part] = String(field.key || '').split('.');
      if (part === 'name' && PARTY_ROLES.includes(role) && field.value) add(role, field.value, null);
    }
  }
  return [...byName.values()];
}

async function screenParty(ctx, sanctions, index, party, shipment) {
  const { store } = ctx;
  const old = (await store.list('parties', (p) => p.normalized === party.normalized))[0] || null;
  const recent = old?.screenedAt && hoursBetween(old.screenedAt, ctx.now()) < RESCREEN_HOURS && old.listDate === (index?.date ?? null);

  let record;
  if (recent) {
    record = { ...old };
  } else {
    const result = index ? await sanctions.screen(party.name, index, { country: party.country || undefined }) : null;
    record = {
      ...old,
      id: old?.id || newId('pty'),
      name: party.name,
      normalized: party.normalized,
      country: party.country || old?.country || null,
      status: result ? result.status : 'not_screened',
      best: result?.best || null,
      compared: result?.compared ?? 0,
      listDate: index?.date ?? null,
      listCount: index?.count ?? 0,
      listSource: index?.source ?? null,
      screenedAt: result ? ctx.nowIso() : null, // not screened means try again next run
    };
    const message = screenMessage(record);
    ctx.agentEvent('sanctions', 'screen', message, { shipmentId: shipment.id });
    await ctx.log(ctx.agentActor('sanctions'), 'screened', message, { shipmentId: shipment.id });
  }
  record.roles = union(old?.roles, party.roles);
  record.shipmentIds = union(old?.shipmentIds, [shipment.id]);
  await store.put('parties', record);
  return {
    name: record.name, role: party.roles[0], roles: party.roles, status: record.status, best: record.best,
    compared: record.compared, listDate: record.listDate, partyId: record.id,
  };
}

export function screenMessage(party) {
  if (party.status === 'clear') return `${party.name}: no match on the OFAC SDN list (${party.compared} similar names compared)`;
  if (party.status === 'review') return `${party.name}: close to ${party.best?.sdnName || 'a listed name'} on the OFAC SDN list, a person should check`;
  if (party.status === 'match') return `${party.name}: matches ${party.best?.sdnName || 'a listed name'} on the OFAC SDN list`;
  return `${party.name}: not screened yet, the OFAC SDN list could not be loaded`;
}

function union(a = [], b = []) {
  return [...new Set([...(a || []), ...(b || [])])];
}
