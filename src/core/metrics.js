// Usage numbers for the Jewel Labs desk: one row per house, plus totals.
//
// Input: computeMetrics({ workspaces: [{ workspace, events, papers, members, shipments?, documents?, questions? }], now })
//   events:  { type, at, userId, shipmentId?, paperId?, docId? }, type is one of sign_in, upload, question_asked,
//            question_answered, desk_edit, house_edit, pack_signed, pack_sent
//   papers:  Paper records (status, signedAt, sentAt, deskEdits, houseEdits, shipmentId)
//   members: { userId or id, name, email, role, test }
//   documents: { id, shipmentId }. A paper is uploaded before it is filed, so its upload event names only the
//            document; this says which shipment the document was filed under.
//   questions: { shipmentId, kind, status, closedBy }. A question about papers that disagree (or one to confirm)
//            that a person closed without answering is a person stepping in on that shipment.
//
// Rules:
// - Members flagged test (our own test logins) are listed, but nothing they did is counted.
// - Sandbox houses get a row of their own but are left out of the totals.
// - signInsLast7d and activeUsers7d look at the last 7 days and count house staff only (not role 'desk').
//   The other counts cover all time.
// - A pack counts as signed when its paper says so or when a pack_signed event names it (each pack once).
// - medianMinutesToSigned: per shipment, minutes from its first upload to its first signed pack.
// - autonomyRate: signed packs that no person edited (no desk or house edit before signing, and no question
//   about papers that disagree dismissed on the shipment) / all signed packs. null when nothing is signed yet.
//   Every edit counts here, even a test member's, so the rate is never better than the truth.

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 7;
const EDIT_TYPES = new Set(['desk_edit', 'house_edit']);
const REVIEW_AGENT = 'Review agent'; // the Review agent closes questions that no longer apply; that is no person
const MUST_ANSWER = new Set(['mismatch', 'confirm']);

/** @returns {{ houses: object[], totals: object, generatedAt: string }} */
export function computeMetrics({ workspaces = [], now = new Date() } = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const results = workspaces.map((item) => measureHouse(item || {}, nowMs));
  return {
    houses: results.map((result) => result.row),
    totals: totalsOf(results),
    generatedAt: new Date(nowMs).toISOString(),
  };
}

// ---------- one house ----------

function measureHouse({ workspace = {}, events = [], papers = [], members = [], shipments, documents = [], questions = [] }, nowMs) {
  const testIds = testMemberIds(members);
  const byTestMember = (event) => event && testIds.has(event.userId);
  const realEvents = events.filter((event) => event && !byTestMember(event));
  // Packs a test member signed are test packs.
  const testPaperIds = new Set(events.filter((event) => byTestMember(event) && event.type === 'pack_signed')
    .map((event) => event.paperId).filter(Boolean));
  const realPapers = papers.filter((paper) => paper && !testPaperIds.has(paper.id) && !signedByTest(paper, members));

  const since = nowMs - RECENT_DAYS * DAY_MS;
  const recent = realEvents.filter((event) => isBetween(event.at, since, nowMs));
  const count = (type) => realEvents.filter((event) => event.type === type).length;

  const signed = signedPacks(realPapers, realEvents);
  const sent = sentPacks(realPapers, realEvents);
  const durations = minutesToSigned(signed, realEvents, shipmentOfDocument(documents));
  // Older data can hold a question about papers that disagree that a person dismissed (now refused): that shipment
  // had a person step in, so its packs do not count as done by the agents alone.
  const steppedIn = new Set(questions.filter((q) => q && q.status === 'dismissed' && MUST_ANSWER.has(q.kind)
    && q.shipmentId && q.closedBy !== REVIEW_AGENT).map((q) => q.shipmentId));
  const autonomous = [...signed.values()].filter((pack) => !steppedIn.has(pack.shipmentId) && noEditsBeforeSigning(pack, events)).length;

  // Sign-ins and active users are about the house's own staff: Jewel Labs desk staff (role 'desk', or anyone
  // making a desk edit) do not count as house users.
  const deskIds = new Set(members.filter((member) => member && member.role === 'desk').map(memberId).filter(Boolean));
  const byHouseUser = (event) => Boolean(event.userId) && !deskIds.has(event.userId) && event.type !== 'desk_edit';
  const activeUserIds = new Set(recent.filter(byHouseUser).map((event) => event.userId));
  const environment = houseEnvironment(workspace);

  const row = {
    id: workspace.id ?? null,
    name: houseName(workspace),
    environment,
    inTotals: environment !== 'sandbox',
    liveShipments: liveShipmentCount(shipments, realEvents, realPapers, sent),
    signInsLast7d: recent.filter((event) => event.type === 'sign_in' && !deskIds.has(event.userId)).length,
    activeUsers7d: activeUserIds.size,
    uploads: count('upload'),
    questionsAsked: count('question_asked'),
    questionsAnswered: count('question_answered'),
    deskEdits: count('desk_edit'),
    houseEdits: count('house_edit'),
    packsSigned: signed.size,
    packsSent: sent.size,
    medianMinutesToSigned: median(durations),
    autonomyRate: signed.size ? round(autonomous / signed.size, 3) : null,
    lastActivityAt: latestTime(realEvents),
    members: members.filter(Boolean).map((member) => describeMember(member, events)),
    testMembers: testIds.size,
    testEvents: events.filter(byTestMember).length,
  };
  // The raw numbers the totals need (users seen in several houses count once; medians are not summable).
  return { row, activeUserIds, durations, autonomous };
}

function houseName(workspace) {
  return workspace.name || workspace.profile?.name || workspace.houseName || workspace.id || 'Unnamed house';
}

function houseEnvironment(workspace) {
  const env = String(workspace.environment ?? workspace.env ?? '').toLowerCase();
  return env === 'sandbox' || env === 'test' || workspace.sandbox === true ? 'sandbox' : 'live';
}

function memberId(member) {
  return member.userId ?? member.user_id ?? member.id ?? null;
}

function isTestMember(member) {
  return member.test === true || member.isTest === true;
}

function testMemberIds(members) {
  return new Set(members.filter((member) => member && isTestMember(member)).map(memberId).filter(Boolean));
}

// paper.signedBy may hold the signer's id, email or name.
function signedByTest(paper, members) {
  if (!paper.signedBy) return false;
  return members.some((member) => member && isTestMember(member)
    && [memberId(member), member.email, member.name].includes(paper.signedBy));
}

function describeMember(member, events) {
  const id = memberId(member);
  const own = events.filter((event) => event && event.userId === id);
  return {
    id,
    name: member.name ?? null,
    email: member.email ?? null,
    role: member.role ?? null,
    test: isTestMember(member),
    lastSeenAt: latestTime(own),
  };
}

// ---------- packs ----------

/** paperId -> { paperId, shipmentId, signedAt } for every signed pack, from papers and events. */
function signedPacks(papers, events) {
  const packs = new Map();
  for (const paper of papers) {
    if (paper.signedAt || paper.status === 'signed' || paper.status === 'sent') {
      packs.set(paper.id, { paperId: paper.id, shipmentId: paper.shipmentId ?? null, signedAt: toMs(paper.signedAt),
        paper });
    }
  }
  for (const event of events) {
    if (event.type !== 'pack_signed') continue;
    const key = event.paperId ?? `event-${packs.size}`; // an event without a paper id still counts once
    const pack = packs.get(key);
    const at = toMs(event.at);
    if (!pack) packs.set(key, { paperId: event.paperId ?? null, shipmentId: event.shipmentId ?? null, signedAt: at });
    else if (pack.signedAt === null || (at !== null && at < pack.signedAt)) pack.signedAt = at;
  }
  return packs;
}

function sentPacks(papers, events) {
  const ids = new Set();
  const shipmentIds = new Set();
  let unnamed = 0;
  for (const paper of papers) {
    if (paper.sentAt || paper.status === 'sent') {
      ids.add(paper.id);
      if (paper.shipmentId) shipmentIds.add(paper.shipmentId);
    }
  }
  for (const event of events) {
    if (event.type !== 'pack_sent') continue;
    if (event.paperId) ids.add(event.paperId);
    else unnamed++;
    if (event.shipmentId) shipmentIds.add(event.shipmentId);
  }
  return { size: ids.size + unnamed, shipmentIds };
}

/** docId -> shipmentId, for the documents filed under a shipment. */
function shipmentOfDocument(documents) {
  const map = new Map();
  for (const doc of documents) if (doc && doc.id && doc.shipmentId) map.set(doc.id, doc.shipmentId);
  return map;
}

/** Per shipment: minutes from its first upload to its first signed pack. */
function minutesToSigned(signed, events, shipmentOf) {
  const firstUpload = new Map();
  for (const event of events) {
    const at = toMs(event.at);
    const shipmentId = event.shipmentId || shipmentOf.get(event.docId) || null;
    if (event.type !== 'upload' || !shipmentId || at === null) continue;
    if (!firstUpload.has(shipmentId) || at < firstUpload.get(shipmentId)) firstUpload.set(shipmentId, at);
  }
  const firstSigned = new Map();
  for (const pack of signed.values()) {
    if (!pack.shipmentId || pack.signedAt === null) continue;
    if (!firstSigned.has(pack.shipmentId) || pack.signedAt < firstSigned.get(pack.shipmentId)) {
      firstSigned.set(pack.shipmentId, pack.signedAt);
    }
  }
  const minutes = [];
  for (const [shipmentId, signedAt] of firstSigned) {
    const uploadedAt = firstUpload.get(shipmentId);
    if (uploadedAt !== undefined && signedAt >= uploadedAt) minutes.push((signedAt - uploadedAt) / 60_000);
  }
  return minutes;
}

/** True when no person edited the pack (or, without a paper id, its shipment) before it was signed. */
function noEditsBeforeSigning(pack, allEvents) {
  if (pack.paper && ((pack.paper.deskEdits || 0) > 0 || (pack.paper.houseEdits || 0) > 0)) return false;
  return !allEvents.some((event) => {
    if (!event || !EDIT_TYPES.has(event.type)) return false;
    const aboutThisPack = event.paperId ? event.paperId === pack.paperId
      : Boolean(event.shipmentId) && event.shipmentId === pack.shipmentId;
    if (!aboutThisPack) return false;
    const at = toMs(event.at);
    return pack.signedAt === null || at === null || at <= pack.signedAt;
  });
}

// ---------- shipments ----------

/** Shipments not sent yet. Uses the shipment records when given, else the shipments seen in events and papers. */
function liveShipmentCount(shipments, events, papers, sent) {
  if (Array.isArray(shipments)) return shipments.filter((shipment) => shipment && shipment.status !== 'sent').length;
  const seen = new Set();
  for (const event of events) if (event.shipmentId) seen.add(event.shipmentId);
  for (const paper of papers) if (paper.shipmentId) seen.add(paper.shipmentId);
  return [...seen].filter((shipmentId) => !sent.shipmentIds.has(shipmentId)).length;
}

// ---------- totals ----------

const SUMMED = ['liveShipments', 'signInsLast7d', 'uploads', 'questionsAsked', 'questionsAnswered', 'deskEdits',
  'houseEdits', 'packsSigned', 'packsSent'];

function totalsOf(results) {
  const included = results.filter((result) => result.row.inTotals);
  const totals = {};
  for (const key of SUMMED) totals[key] = included.reduce((sum, result) => sum + result.row[key], 0);

  const users = new Set();
  for (const result of included) for (const id of result.activeUserIds) users.add(id);
  totals.activeUsers7d = users.size;

  totals.medianMinutesToSigned = median(included.flatMap((result) => result.durations));
  const autonomous = included.reduce((sum, result) => sum + result.autonomous, 0);
  totals.autonomyRate = totals.packsSigned ? round(autonomous / totals.packsSigned, 3) : null;

  totals.liveHouses = included.length;
  totals.sandboxHouses = results.length - included.length;
  totals.testMembers = results.reduce((sum, result) => sum + result.row.testMembers, 0);
  return totals;
}

// ---------- small helpers ----------

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isBetween(value, fromMs, toMsValue) {
  const ms = toMs(value);
  return ms !== null && ms > fromMs && ms <= toMsValue;
}

function latestTime(events) {
  let latest = null;
  for (const event of events) {
    const ms = toMs(event.at);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return round(value, 1);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
