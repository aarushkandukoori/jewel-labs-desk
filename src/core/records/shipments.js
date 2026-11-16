// Shipment grouping: papers that share a reference belong to the same parcel.
//
// How it works, in plain steps:
// 1. Read the references on every paper (invoice no., shipping bill no., air waybill nos., KP no., PO no.,
//    report numbers on list lines, refs the chat or email reader found in doc.refs).
// 2. Strong references (invoice, shipping bill, house air waybill, bill of entry and packing list
//    numbers) always join papers. Weak ones (master air waybill, KP certificate, PO, report numbers,
//    supplier invoice, insurance certificate, chat mentions, attachments of one email) can be shared by
//    several parcels, so they only join papers when that does not put two different invoices, two
//    customs declarations or two air waybills into one shipment.
// 3. Each connected group with at least one shipment paper becomes a shipment. Chats and emails are
//    filed with the shipment they mention most, but never join two shipments.
// 4. A group reuses an existing shipment that already owns one of its papers or shares a reference.
import {
  getField, docLines, parseNumber, parseDate, parseCurrency, normalizeRef, isUsefulRef, namesMatch, shortHash, round,
} from '../rules/fields.js';
import { normalizeCountry, countryName, airportCountry } from '../rules/formats.js';
import { classifyGoods, PARCEL_DOC_TYPES } from '../rules/goods.js';

// Papers that make a shipment on their own.
const ANCHOR_TYPES = [
  'commercial_invoice', 'proforma_invoice', 'packing_list', 'shipping_bill', 'bill_of_entry', 'air_waybill',
  'insurance_certificate', 'customs_declaration', 'purchase_order',
];
// Papers that only join a shipment (a lab report or a KP certificate alone is not a parcel). All their refs are weak.
const JOIN_ONLY_TYPES = [
  'lab_report', 'kp_certificate', 'supplier_invoice', 'supplier_declaration', 'g7_gf_declaration', 'factory_record', 'other',
];
// Chats and emails talk about many parcels: filed with one, never a bridge between two.
const CONTAINER_TYPES = ['whatsapp_chat', 'email'];
// House papers, not parcel papers.
const IGNORED_TYPES = ['kyc_document'];

/** The best paper to read shipment details from comes first. */
export const DOC_PRIORITY = [
  'commercial_invoice', 'packing_list', 'shipping_bill', 'bill_of_entry', 'air_waybill', 'insurance_certificate',
  'proforma_invoice', 'customs_declaration', 'purchase_order', 'g7_gf_declaration', 'supplier_declaration',
  'lab_report', 'factory_record', 'supplier_invoice', 'kp_certificate', 'other', 'email', 'whatsapp_chat',
];

// What a field's number is.
const FIELD_KINDS = {
  'invoice.number': 'invoice',
  'shippingBill.number': 'shippingBill',
  'leo.number': 'leo',
  'billOfEntry.number': 'billOfEntry',
  'awb.hawb': 'hawb',
  'awb.mawb': 'mawb',
  'kp.certificateNumber': 'kp',
  'po.number': 'po',
  'lab.reportNumber': 'report',
};
// What a paper's own document number is.
const DOC_NUMBER_KINDS = {
  commercial_invoice: 'invoice', proforma_invoice: 'proforma', packing_list: 'packingList',
  shipping_bill: 'shippingBill', bill_of_entry: 'billOfEntry', air_waybill: 'hawb', kp_certificate: 'kp',
  supplier_invoice: 'supplierInvoice', lab_report: 'report', insurance_certificate: 'insurance',
  purchase_order: 'po', factory_record: 'factoryLot', customs_declaration: 'customs',
};
// References that several parcels can share. An insurance certificate's own number is weak too, because
// a reader may take the annual policy number for it, and one policy covers every parcel of the year.
const WEAK_KINDS = new Set(['mawb', 'kp', 'po', 'proforma', 'report', 'supplierInvoice', 'factoryLot', 'insurance', 'mention']);
// Weak links are tried in this order, so lab reports find their packing list before anything else.
const WEAK_ORDER = ['report', 'factoryLot', 'kp', 'supplierInvoice', 'mention', 'mawb', 'insurance', 'po', 'proforma'];

/**
 * The references printed on one paper: [{ kind, value, norm, own, strong }].
 * own: the paper's own number. strong: safe to join papers on.
 */
export function documentRefs(doc) {
  const refs = [];
  const ownKind = DOC_NUMBER_KINDS[doc.docType];
  const allWeak = JOIN_ONLY_TYPES.includes(doc.docType) || CONTAINER_TYPES.includes(doc.docType);
  const add = (kind, value) => {
    if (value === null || value === undefined) return;
    const norm = normalizeRef(value);
    if (!isUsefulRef(norm, kind === 'report' ? 6 : 4)) return;
    if (refs.some((ref) => ref.norm === norm)) return;
    refs.push({ kind, value: String(value).trim(), norm, own: kind === ownKind, strong: !allWeak && !WEAK_KINDS.has(kind) });
  };

  if (ownKind) add(ownKind, getField(doc, 'doc.number'));
  for (const field of doc.fields || []) {
    const kind = field ? fieldKind(doc.docType, field.key) : null;
    if (kind) add(kind, field.value); // only reference fields: dates and totals are not references
  }
  for (const line of docLines(doc)) add('report', line.reportNumber);
  // Refs the chat or email reader found (doc.refs). source.ref is not used: it is the chat title or the
  // email subject, shared by every attachment, so it would tie unrelated papers together.
  for (const value of doc.refs || []) add('mention', value);
  return refs;
}

function fieldKind(docType, key) {
  const kind = FIELD_KINDS[key];
  // On a supplier invoice or a proforma, "invoice number" is that paper's own number.
  if (kind === 'invoice' && docType === 'supplier_invoice') return 'supplierInvoice';
  if (kind === 'invoice' && docType === 'proforma_invoice') return 'proforma';
  return kind || null;
}

// The numbers that name one parcel. Two different ones of the same kind cannot be one shipment.
function identityOf(doc, refs) {
  const own = (kind) => refs.filter((ref) => ref.kind === kind && ref.own).map((ref) => ref.norm);
  const identity = { invoice: [], customs: [], awb: [] };
  if (doc.docType === 'commercial_invoice') identity.invoice = own('invoice');
  if (doc.docType === 'shipping_bill') identity.customs = own('shippingBill').map((n) => `SB${n}`);
  if (doc.docType === 'bill_of_entry') identity.customs = own('billOfEntry').map((n) => `BE${n}`);
  if (doc.docType === 'air_waybill') {
    const hawb = own('hawb');
    identity.awb = hawb.length ? hawb : refs.filter((ref) => ref.kind === 'mawb').map((ref) => ref.norm);
  }
  return identity;
}

// ---------- groups of papers (union-find) ----------

function createGroups(docIds, identities) {
  const parent = new Map(docIds.map((id) => [id, id]));
  const identity = new Map(docIds.map((id) => [id, identities.get(id)]));

  function find(id) {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(id, root);
    return root;
  }

  // Two groups conflict when both name a parcel of the same kind and share no number.
  function conflicts(a, b) {
    const x = identity.get(a);
    const y = identity.get(b);
    return ['invoice', 'customs', 'awb'].some((kind) => {
      if (!x[kind].length || !y[kind].length) return false;
      return !x[kind].some((value) => y[kind].includes(value));
    });
  }

  /** Join two papers' groups. Weak joins are refused when they would mix two parcels. */
  function join(a, b, { weak = false } = {}) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return true;
    if (weak && conflicts(rootA, rootB)) return false;
    parent.set(rootB, rootA);
    const x = identity.get(rootA);
    const y = identity.get(rootB);
    identity.set(rootA, {
      invoice: [...new Set([...x.invoice, ...y.invoice])],
      customs: [...new Set([...x.customs, ...y.customs])],
      awb: [...new Set([...x.awb, ...y.awb])],
    });
    return true;
  }

  return { find, join };
}

// ---------- groupShipments ----------

/**
 * Group papers into shipments.
 * Pass every document of the workspace and every existing shipment.
 * house: { name, legalEntity?, legalName?, aliases?, country? } (a workspace profile works too).
 * @returns {{ shipments: object[], assignments: Object<string,string>, merged: Array<{from:string, into:string}> }}
 */
export function groupShipments({ documents = [], shipments = [], house = null } = {}) {
  const docs = [...documents]
    .filter((doc) => doc && doc.id && !IGNORED_TYPES.includes(doc.docType))
    .sort(byCreated);
  const papers = docs.filter((doc) => !CONTAINER_TYPES.includes(doc.docType));
  const containers = docs.filter((doc) => CONTAINER_TYPES.includes(doc.docType));
  const docById = new Map(docs.map((doc) => [doc.id, doc]));

  const refsById = new Map(docs.map((doc) => [doc.id, documentRefs(doc)]));
  const identities = new Map(papers.map((doc) => [doc.id, identityOf(doc, refsById.get(doc.id))]));
  const groups = createGroups(papers.map((doc) => doc.id), identities);
  const owner = ownership(docs, shipments);

  // Who prints which number.
  const carriers = new Map(); // number -> papers that print it
  const strongCarriers = new Map(); // number -> papers where it is a strong reference
  const kindsOf = new Map(); // number -> the kinds it was printed as
  for (const doc of papers) {
    for (const ref of refsById.get(doc.id)) {
      addTo(carriers, ref.norm, doc.id);
      addTo(kindsOf, ref.norm, ref.kind);
      if (ref.strong) addTo(strongCarriers, ref.norm, doc.id);
    }
  }

  // Strong references always join.
  for (const ids of strongCarriers.values()) {
    for (const id of ids.slice(1)) groups.join(ids[0], id);
  }

  // Weak references join when nothing contradicts, kind by kind in a fixed order, then any number left.
  for (const kind of [...WEAK_ORDER, 'any']) {
    for (const [norm, ids] of carriers) {
      if (kind !== 'any' && !kindsOf.get(norm).includes(kind)) continue;
      for (const id of ids.slice(1)) groups.join(ids[0], id, { weak: true });
    }
  }

  // Attachments of one email (or of one chat message) travel together.
  for (const siblings of attachmentSets(papers, docById)) {
    for (const id of siblings.slice(1)) groups.join(siblings[0], id, { weak: true });
  }

  // Papers an existing shipment already owns stay together when nothing contradicts.
  const byOwner = new Map();
  for (const doc of papers) {
    const shipmentId = owner.get(doc.id);
    if (shipmentId) byOwner.set(shipmentId, [...(byOwner.get(shipmentId) || []), doc.id]);
  }
  for (const ids of byOwner.values()) {
    for (const id of ids.slice(1)) groups.join(ids[0], id, { weak: true });
  }

  // Collect the groups that make a shipment.
  const members = new Map();
  for (const doc of papers) {
    const root = groups.find(doc.id);
    members.set(root, [...(members.get(root) || []), doc]);
  }
  const components = [...members.values()].filter((group) =>
    group.some((doc) => ANCHOR_TYPES.includes(doc.docType) || owner.has(doc.id)));

  // File each chat and email with the shipment it talks about most.
  for (const container of containers) {
    const best = bestComponentFor(container, components, refsById, owner);
    if (best) best.push(container);
  }

  return buildShipments({ components, shipments, owner, refsById, house, docs });
}

function byCreated(a, b) {
  return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id));
}

function addTo(map, key, value) {
  const list = map.get(key) || [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

// docId -> existing shipment id, from the shipment's list and from the document itself.
function ownership(docs, shipments) {
  const owner = new Map();
  const known = new Set(shipments.map((s) => s.id));
  for (const doc of docs) {
    if (doc.shipmentId && known.has(doc.shipmentId)) owner.set(doc.id, doc.shipmentId);
  }
  for (const shipment of shipments) {
    for (const id of shipment.documentIds || []) if (!owner.has(id)) owner.set(id, shipment.id);
  }
  return owner;
}

// Sets of papers that came in as attachments of the same email, or of the same chat message.
function attachmentSets(papers, docById) {
  const sets = new Map();
  for (const doc of papers) {
    if (!doc.parentId) continue;
    const parent = docById.get(doc.parentId);
    const fromChat = (parent && parent.docType === 'whatsapp_chat') || (doc.source && doc.source.kind === 'whatsapp');
    // In a chat export only files sent in the same message belong together.
    if (fromChat && !(doc.source && doc.source.chatAt)) continue;
    const key = fromChat ? `${doc.parentId}|${doc.source.chatAt}` : doc.parentId;
    sets.set(key, [...(sets.get(key) || []), doc.id]);
  }
  return [...sets.values()].filter((ids) => ids.length > 1);
}

function bestComponentFor(container, components, refsById, owner) {
  const norms = new Set(refsById.get(container.id).map((ref) => ref.norm));
  let best = null;
  let bestScore = 0;
  for (const group of components) {
    const groupNorms = new Set(group.flatMap((doc) => (refsById.get(doc.id) || []).map((ref) => ref.norm)));
    const shared = [...norms].filter((norm) => groupNorms.has(norm)).length;
    const attachments = group.filter((doc) => doc.parentId === container.id).length;
    const owned = owner.has(container.id) && group.some((doc) => owner.get(doc.id) === owner.get(container.id)) ? 1 : 0;
    // Mentions count most, then its own attachments, then where it was filed before.
    const score = shared * 100 + attachments * 10 + owned;
    if (score > bestScore) {
      best = group;
      bestScore = score;
    }
  }
  return best;
}

// ---------- building the shipment records ----------

function buildShipments({ components, shipments, owner, refsById, house, docs }) {
  const known = new Set(docs.map((doc) => doc.id));
  const claimed = new Set();
  const merged = [];
  const built = [];
  const assignments = {};

  const ordered = [...components].sort((a, b) => byCreated(a[0], b[0]));
  for (const group of ordered) {
    const groupIds = new Set(group.map((doc) => doc.id));
    const strongNorms = new Set(group.flatMap((doc) => refsById.get(doc.id).filter((r) => r.strong).map((r) => r.norm)));

    // Existing shipments that own one of these papers or carry one of these references.
    const candidates = shipments.filter((s) => !claimed.has(s.id) && (
      group.some((doc) => owner.get(doc.id) === s.id) || shipmentNorms(s).some((norm) => strongNorms.has(norm))));
    const ownedCount = (s) => group.filter((doc) => owner.get(doc.id) === s.id).length;
    candidates.sort((a, b) => ownedCount(b) - ownedCount(a) || byCreated(a, b));

    const base = candidates[0] || null;
    if (base) claimed.add(base.id);
    // Other shipments whose papers all ended up here are merged into this one.
    for (const other of candidates.slice(1)) {
      const theirs = [...owner.entries()].filter(([, shipmentId]) => shipmentId === other.id).map(([docId]) => docId);
      if (theirs.every((docId) => groupIds.has(docId) || !known.has(docId))) {
        claimed.add(other.id);
        merged.push({ from: other.id, into: base.id });
      }
    }

    const id = base ? base.id : `shp_${shortHash(group.map((doc) => doc.id).sort().join(','))}`;
    const shipment = describeShipment({ id, base, group, house, refsById });
    built.push(shipment);
    for (const doc of group) assignments[doc.id] = id;
  }

  // Shipments nobody claimed keep the papers that did not move elsewhere (papers not passed in, such as
  // ones still being read, stay listed). One left with no papers is not returned, so the caller can remove it.
  for (const shipment of shipments) {
    if (claimed.has(shipment.id)) continue;
    const documentIds = (shipment.documentIds || []).filter((docId) => !assignments[docId]);
    if (documentIds.length) built.push({ ...shipment, documentIds });
  }

  return { shipments: built, assignments, merged };
}

function shipmentNorms(shipment) {
  const values = [shipment.ref, shipment.invoiceNumber, shipment.shippingBillNumber, shipment.hawb,
    shipment.billOfEntryNumber, ...(shipment.refs || [])];
  return values.map(normalizeRef).filter((norm) => isUsefulRef(norm));
}

function priority(doc) {
  const at = DOC_PRIORITY.indexOf(doc.docType);
  return at === -1 ? DOC_PRIORITY.length : at;
}

function describeShipment({ id, base, group, house, refsById }) {
  const docs = [...group].sort((a, b) => priority(a) - priority(b) || byCreated(a, b));
  const anchors = docs.filter((doc) => ANCHOR_TYPES.includes(doc.docType));
  const first = (key, list = anchors) => {
    for (const doc of list) {
      const value = getField(doc, key);
      if (value) return value;
    }
    return null;
  };
  const ofType = (type) => anchors.filter((doc) => doc.docType === type);
  const ownNumber = (type, key) => first(key, ofType(type)) || first('doc.number', ofType(type));

  const invoiceNumber = ownNumber('commercial_invoice', 'invoice.number') || first('invoice.number');
  const shippingBillNumber = ownNumber('shipping_bill', 'shippingBill.number') || first('shippingBill.number');
  const billOfEntryNumber = ownNumber('bill_of_entry', 'billOfEntry.number') || first('billOfEntry.number');
  const awbFirst = [...ofType('air_waybill'), ...anchors];
  const hawb = first('awb.hawb', awbFirst);
  const mawb = first('awb.mawb', awbFirst);

  const strongRefs = docs.flatMap((doc) => refsById.get(doc.id).filter((ref) => ref.strong));
  const ref = base && base.refManual
    ? base.ref
    : invoiceNumber || shippingBillNumber || hawb || mawb || billOfEntryNumber
      || (strongRefs[0] && strongRefs[0].value) || `Shipment ${id.slice(-4).toUpperCase()}`;

  const exporter = party(anchors, 'exporter');
  const consignee = party(anchors, 'consignee');
  const buyer = party(anchors, 'buyer');
  const supplier = party(anchors, 'supplier');
  // Airports on the air waybill route ("BOM-DXB-BRU") are a last resort for the countries.
  const awbRoute = first('awb.route', awbFirst);
  const stops = awbRoute ? awbRoute.toUpperCase().split(/[^A-Z]+/).filter((code) => airportCountry(code)) : [];

  const originCountry = normalizeCountry(first('exporter.country')) || normalizeCountry(first('exporter.address'))
    || normalizeCountry(first('goods.portOfLoading')) || (stops.length ? airportCountry(stops[0]) : null);
  const destinationCountry = normalizeCountry(first('goods.destinationCountry'))
    || normalizeCountry(first('consignee.country')) || normalizeCountry(first('consignee.address'))
    || normalizeCountry(first('buyer.country')) || normalizeCountry(first('buyer.address'))
    || normalizeCountry(first('goods.portOfDischarge')) || (stops.length > 1 ? airportCountry(stops[stops.length - 1]) : null);

  const goods = classifyGoods({ documents: docs.filter((doc) => PARCEL_DOC_TYPES.includes(doc.docType)), stones: [] });

  return {
    ...(base || {}),
    id,
    workspaceId: (base && base.workspaceId) || (house && (house.workspaceId || house.id)) || docs[0].workspaceId || null,
    ref,
    direction: decideDirection(anchors, house),
    exporter,
    consignee,
    buyer,
    supplier,
    originCountry,
    destinationCountry,
    route: originCountry && destinationCountry ? `${countryName(originCountry)} to ${countryName(destinationCountry)}` : null,
    invoiceNumber,
    invoiceDate: parseDate(first('invoice.date') || first('doc.date', ofType('commercial_invoice'))),
    shippingBillNumber,
    leoDate: parseDate(first('leo.date')),
    billOfEntryNumber,
    hawb,
    mawb,
    flight: first('awb.flight', awbFirst),
    goods: {
      nature: goods.nature,
      form: goods.form,
      hsCodes: goods.hsCodes,
      description: first('goods.description'),
    },
    totals: shipmentTotals(anchors),
    refs: [...new Set(docs.flatMap((doc) => refsById.get(doc.id))
      .filter((r) => r.strong || r.kind === 'mawb' || r.kind === 'kp')
      .map((r) => r.value))],
    documentIds: docs.map((doc) => doc.id),
    status: (base && base.status) || 'collecting',
    required: (base && base.required) || [],
  };
}

// A party's name, address and country from the best paper that names it.
function party(anchors, role) {
  const doc = anchors.find((d) => getField(d, `${role}.name`));
  if (!doc) return { name: null, address: null, country: null };
  const address = getField(doc, `${role}.address`);
  const printed = getField(doc, `${role}.country`);
  const code = normalizeCountry(printed) || normalizeCountry(address);
  return { name: getField(doc, `${role}.name`), address, country: code ? countryName(code) : printed };
}

/** 'export' when the house is the exporter or shipper, 'import' when it is the consignee or buyer. */
export function decideDirection(anchors, house) {
  const names = houseNames(house);
  if (!names.length) return 'unknown';
  const isHouse = (name) => Boolean(name) && names.some((houseName) => namesMatch(name, houseName));
  if (anchors.some((doc) => isHouse(getField(doc, 'exporter.name')))) return 'export';
  if (anchors.some((doc) => isHouse(getField(doc, 'consignee.name')) || isHouse(getField(doc, 'buyer.name')))) return 'import';
  return 'unknown';
}

/** Every name the house goes by: its name, legal entity, letterhead and aliases. */
export function houseNames(house) {
  if (!house) return [];
  const profile = house.profile || {};
  const letterhead = house.letterhead || {};
  return [house.name, house.legalEntity, house.legalName, letterhead.companyName, profile.name, profile.legalEntity,
    profile.legalName, ...(house.aliases || []), ...(profile.aliases || [])].filter(Boolean);
}

// Totals as printed on the best paper; when nothing prints them, the lines are added up.
function shipmentTotals(anchors) {
  const firstNumber = (key) => {
    for (const doc of anchors) {
      const value = parseNumber(getField(doc, key));
      if (value !== null) return value;
    }
    return null;
  };
  let pieces = firstNumber('goods.totalPieces');
  let carats = firstNumber('goods.totalCarats');
  let value = firstNumber('goods.totalValue');
  let currency = null;
  for (const doc of anchors) {
    currency = parseCurrency(getField(doc, 'goods.currency')) || parseCurrency(getField(doc, 'goods.totalValue'));
    if (currency) break;
  }

  const list = anchors.find((doc) => docLines(doc).length > 0);
  if (list) {
    const lines = docLines(list);
    const sum = (pick) => lines.reduce((total, line) => total + (pick(line) || 0), 0);
    if (pieces === null) pieces = sum((line) => parseNumber(line.pieces) || 1);
    if (carats === null) carats = sum((line) => parseNumber(line.carat));
    if (value === null && lines.some((line) => parseNumber(line.amount) !== null)) value = sum((line) => parseNumber(line.amount));
  }
  return { pieces, carats: round(carats, 3), value: round(value, 2), currency };
}
