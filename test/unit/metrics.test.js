// Tests for metrics.js: per-house usage numbers and totals, built from synthetic SAMPLE events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../../src/core/metrics.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An ISO time `ms` before NOW. */
function ago(ms) {
  return new Date(NOW.getTime() - ms).toISOString();
}

function event(type, at, userId, extra = {}) {
  return { type, at, userId, ...extra };
}

// House A (live): two staff, one test login, one Jewel Labs desk user.
const S1_FIRST_UPLOAD = ago(3 * DAY);
const P1_SIGNED = ago(3 * DAY - 90 * 60 * 1000); // 90 minutes after the first upload of s1
const S2_FIRST_UPLOAD = ago(2 * DAY);
const P2_SIGNED = ago(2 * DAY - 4 * HOUR); // 240 minutes after the first upload of s2
const P3_SIGNED = ago(1 * DAY);

const HOUSE_A = {
  workspace: { id: 'ws-a', name: 'Sample House A', environment: 'live' },
  members: [
    { userId: 'u1', name: 'Sample Owner', email: 'owner@sample-house-a.test', role: 'owner' },
    { userId: 'u2', name: 'Sample Clerk', email: 'clerk@sample-house-a.test', role: 'preparer' },
    { userId: 't1', name: 'Jewel Labs Test', email: 'test@jewellabs.test', role: 'owner', test: true },
    { userId: 'd1', name: 'Desk Reviewer', email: 'desk@jewellabs.test', role: 'desk' },
  ],
  events: [
    event('sign_in', ago(1 * DAY), 'u1'),
    event('sign_in', ago(2 * DAY), 'u2'),
    event('sign_in', ago(8 * DAY), 'u1'), // older than 7 days
    event('sign_in', ago(7 * DAY), 'u2'), // exactly 7 days ago: outside the window
    event('sign_in', ago(1 * HOUR), 't1'), // test login: not counted
    event('sign_in', ago(3 * HOUR), 'd1'), // desk staff: not a house user
    event('upload', S1_FIRST_UPLOAD, 'u1', { shipmentId: 's1' }),
    event('upload', ago(3 * DAY - 30 * 60 * 1000), 'u2', { shipmentId: 's1' }),
    event('upload', S2_FIRST_UPLOAD, null, { shipmentId: 's2' }), // from the mailbox: no person
    event('question_asked', ago(3 * DAY - 60 * 60 * 1000), null, { shipmentId: 's1' }),
    event('question_answered', ago(3 * DAY - 70 * 60 * 1000), 'u2', { shipmentId: 's1' }),
    event('desk_edit', ago(2 * DAY - 2 * HOUR), 'd1', { shipmentId: 's2', paperId: 'p2' }), // before p2 was signed
    event('house_edit', ago(12 * HOUR), 'u1', { shipmentId: 's3' }), // after p3 was signed: p3 stays autonomous
    event('pack_signed', P1_SIGNED, 'u1', { shipmentId: 's1', paperId: 'p1' }),
    event('pack_sent', ago(3 * DAY - 100 * 60 * 1000), 'u1', { shipmentId: 's1', paperId: 'p1' }),
    event('pack_signed', P2_SIGNED, 'u2', { shipmentId: 's2', paperId: 'p2' }),
    event('pack_signed', ago(2 * HOUR), 't1', { shipmentId: 's9', paperId: 'p9' }), // test pack
  ],
  papers: [
    { id: 'p1', shipmentId: 's1', kind: 'export_pack', status: 'sent', signedAt: P1_SIGNED, sentAt: ago(3 * DAY - 100 * 60 * 1000), deskEdits: 0, houseEdits: 0 },
    { id: 'p2', shipmentId: 's2', kind: 'export_pack', status: 'signed', signedAt: P2_SIGNED, deskEdits: 1, houseEdits: 0 },
    { id: 'p3', shipmentId: 's3', kind: 'eu_dds', status: 'signed', signedAt: P3_SIGNED, deskEdits: 0, houseEdits: 0 },
    { id: 'p4', shipmentId: 's3', kind: 'export_pack', status: 'ready_to_sign', deskEdits: 0, houseEdits: 0 },
    { id: 'p9', shipmentId: 's9', kind: 'export_pack', status: 'signed', signedAt: ago(2 * HOUR), deskEdits: 0, houseEdits: 0 },
  ],
};

// House B (live): shipment records given; shares user u1 with house A (a broker working for both).
const HOUSE_B = {
  workspace: { id: 'ws-b', profile: { name: 'Sample House B' } },
  members: [{ id: 'u1', name: 'Sample Owner', role: 'preparer' }, { id: 'u3', name: 'Sample Buyer', role: 'owner' }],
  events: [
    event('sign_in', ago(1 * DAY), 'u1'),
    event('upload', ago(6 * DAY), 'u3', { shipmentId: 'b1' }),
  ],
  papers: [],
  shipments: [{ id: 'b1', status: 'sent' }, { id: 'b2', status: 'collecting' }, { id: 'b3', status: 'ready_to_sign' }],
};

// A sandbox house: listed, never in the totals.
const SANDBOX = {
  workspace: { id: 'ws-sandbox', name: 'Sample Sandbox', environment: 'sandbox' },
  members: [{ userId: 'u5', role: 'owner' }],
  events: [
    event('sign_in', ago(1 * HOUR), 'u5'),
    event('upload', ago(5 * HOUR), 'u5', { shipmentId: 'x1' }),
    event('pack_signed', ago(4 * HOUR), 'u5', { shipmentId: 'x1', paperId: 'x-p1' }),
  ],
  papers: [],
};

test('one house: counts, windows, packs, timing and autonomy', () => {
  const { houses } = computeMetrics({ workspaces: [HOUSE_A], now: NOW });
  const house = houses[0];
  assert.equal(house.id, 'ws-a');
  assert.equal(house.name, 'Sample House A');
  assert.equal(house.environment, 'live');
  assert.equal(house.inTotals, true);
  assert.equal(house.signInsLast7d, 2, 'u1 and u2 in the last 7 days; old, test and desk sign-ins left out');
  assert.equal(house.activeUsers7d, 2, 'u1 and u2; the desk user and the test login are not house users');
  assert.equal(house.uploads, 3);
  assert.equal(house.questionsAsked, 1);
  assert.equal(house.questionsAnswered, 1);
  assert.equal(house.deskEdits, 1);
  assert.equal(house.houseEdits, 1);
  assert.equal(house.packsSigned, 3, 'p1, p2, p3 (p9 was signed by a test login)');
  assert.equal(house.packsSent, 1);
  assert.equal(house.medianMinutesToSigned, 165, 'median of 90 (s1) and 240 (s2); s3 has no upload');
  assert.equal(house.autonomyRate, 0.667, 'p1 and p3 had no edits before signing; p2 had a desk edit');
  assert.equal(house.liveShipments, 2, 's2 and s3 are not sent; s1 is');
  assert.equal(house.testMembers, 1);
  assert.equal(house.testEvents, 2);
  assert.equal(house.lastActivityAt, ago(3 * HOUR), 'the desk sign-in; the test login\'s later events do not count');
});

test('members are listed with their test flag and last activity', () => {
  const { houses } = computeMetrics({ workspaces: [HOUSE_A], now: NOW });
  const members = houses[0].members;
  assert.equal(members.length, 4);
  const testLogin = members.find((member) => member.id === 't1');
  assert.equal(testLogin.test, true);
  assert.equal(testLogin.lastSeenAt, ago(1 * HOUR));
  const owner = members.find((member) => member.id === 'u1');
  assert.deepEqual(owner, { id: 'u1', name: 'Sample Owner', email: 'owner@sample-house-a.test', role: 'owner', test: false,
    lastSeenAt: ago(12 * HOUR) });
});

test('totals leave out sandbox houses and test members, and count shared users once', () => {
  const { houses, totals } = computeMetrics({ workspaces: [HOUSE_A, HOUSE_B, SANDBOX], now: NOW });
  assert.equal(houses.length, 3, 'the sandbox house is still listed');
  const sandbox = houses.find((house) => house.id === 'ws-sandbox');
  assert.equal(sandbox.environment, 'sandbox');
  assert.equal(sandbox.inTotals, false);
  assert.equal(sandbox.packsSigned, 1);
  assert.equal(sandbox.medianMinutesToSigned, 60);

  const houseB = houses.find((house) => house.id === 'ws-b');
  assert.equal(houseB.name, 'Sample House B', 'name from the workspace profile');
  assert.equal(houseB.liveShipments, 2, 'from the shipment records: b2 and b3');
  assert.equal(houseB.autonomyRate, null, 'nothing signed yet');
  assert.equal(houseB.medianMinutesToSigned, null);

  assert.equal(totals.liveHouses, 2);
  assert.equal(totals.sandboxHouses, 1);
  assert.equal(totals.testMembers, 1);
  assert.equal(totals.signInsLast7d, 3);
  assert.equal(totals.activeUsers7d, 3, 'u1 works for both houses and counts once');
  assert.equal(totals.uploads, 4);
  assert.equal(totals.questionsAsked, 1);
  assert.equal(totals.questionsAnswered, 1);
  assert.equal(totals.deskEdits, 1);
  assert.equal(totals.houseEdits, 1);
  assert.equal(totals.packsSigned, 3);
  assert.equal(totals.packsSent, 1);
  assert.equal(totals.liveShipments, 4);
  assert.equal(totals.medianMinutesToSigned, 165);
  assert.equal(totals.autonomyRate, 0.667);
});

test('a pack is counted once whether it shows up in papers, events or both', () => {
  const workspaces = [{
    workspace: { id: 'ws', name: 'Sample' },
    events: [
      event('upload', ago(5 * HOUR), 'u1', { shipmentId: 's1' }),
      event('pack_signed', ago(4 * HOUR), 'u1', { shipmentId: 's1', paperId: 'p1' }), // also in papers
      event('pack_signed', ago(3 * HOUR), 'u1', { shipmentId: 's2', paperId: 'p2' }), // only in events
      event('pack_signed', ago(2 * HOUR), 'u1', { shipmentId: 's3' }), // no paper id at all
    ],
    papers: [{ id: 'p1', shipmentId: 's1', status: 'signed', signedAt: ago(4 * HOUR) }],
    members: [],
  }];
  const [house] = computeMetrics({ workspaces, now: NOW }).houses;
  assert.equal(house.packsSigned, 3);
  assert.equal(house.autonomyRate, 1);
  assert.equal(house.medianMinutesToSigned, 60);
});

test('an edit before signing makes a pack not autonomous, an edit after does not', () => {
  const base = { workspace: { id: 'ws', name: 'Sample' }, members: [] };
  const signedAt = ago(2 * HOUR);
  const paper = { id: 'p1', shipmentId: 's1', status: 'signed', signedAt };
  const before = computeMetrics({
    workspaces: [{ ...base, papers: [paper], events: [event('house_edit', ago(3 * HOUR), 'u1', { paperId: 'p1' })] }],
    now: NOW,
  });
  assert.equal(before.houses[0].autonomyRate, 0);

  const after = computeMetrics({
    workspaces: [{ ...base, papers: [paper], events: [event('house_edit', ago(1 * HOUR), 'u1', { paperId: 'p1' })] }],
    now: NOW,
  });
  assert.equal(after.houses[0].autonomyRate, 1);

  const shipmentEdit = computeMetrics({
    workspaces: [{ ...base, papers: [paper], events: [event('desk_edit', ago(3 * HOUR), 'd1', { shipmentId: 's1' })] }],
    now: NOW,
  });
  assert.equal(shipmentEdit.houses[0].autonomyRate, 0, 'an edit to the shipment before signing counts too');

  const counted = computeMetrics({ workspaces: [{ ...base, papers: [{ ...paper, houseEdits: 2 }], events: [] }], now: NOW });
  assert.equal(counted.houses[0].autonomyRate, 0, 'the paper\'s own edit counters count');
});

test('median uses the middle value, or the mean of the two middle values', () => {
  const uploadsAndSigns = [10, 20, 60].flatMap((minutes, i) => [
    event('upload', ago(10 * HOUR), 'u1', { shipmentId: `s${i}` }),
    event('pack_signed', ago(10 * HOUR - minutes * 60 * 1000), 'u1', { shipmentId: `s${i}`, paperId: `p${i}` }),
  ]);
  const odd = computeMetrics({ workspaces: [{ workspace: { name: 'Sample' }, events: uploadsAndSigns }], now: NOW });
  assert.equal(odd.houses[0].medianMinutesToSigned, 20);
  const even = computeMetrics({ workspaces: [{ workspace: { name: 'Sample' }, events: uploadsAndSigns.slice(0, 4) }], now: NOW });
  assert.equal(even.houses[0].medianMinutesToSigned, 15);
});

test('no workspaces gives empty rows and zero totals', () => {
  const { houses, totals, generatedAt } = computeMetrics({ workspaces: [], now: NOW });
  assert.deepEqual(houses, []);
  assert.equal(totals.liveHouses, 0);
  assert.equal(totals.packsSigned, 0);
  assert.equal(totals.activeUsers7d, 0);
  assert.equal(totals.autonomyRate, null);
  assert.equal(totals.medianMinutesToSigned, null);
  assert.equal(generatedAt, NOW.toISOString());
  assert.deepEqual(computeMetrics().houses, []);
});

test('missing fields and odd values do not break the numbers', () => {
  const { houses } = computeMetrics({
    workspaces: [{ workspace: {}, events: [null, { type: 'sign_in', at: 'not a date', userId: 'u1' }, { type: 'upload' }],
      papers: [null], members: [null] }],
    now: NOW.toISOString(),
  });
  const [house] = houses;
  assert.equal(house.name, 'Unnamed house');
  assert.equal(house.environment, 'live');
  assert.equal(house.signInsLast7d, 0, 'a sign-in without a valid time is not in the 7-day window');
  assert.equal(house.uploads, 1);
  assert.equal(house.lastActivityAt, null);
  assert.equal(house.testEvents, 0, 'an empty slot in the event list is not a test event');
});

test('an upload counts for the shipment its paper was filed under', () => {
  // A paper is uploaded before Records files it, so its upload event names only the document.
  const house = {
    workspace: { id: 'ws-k', name: 'Sample House K', environment: 'live' },
    members: [{ userId: 'u1', name: 'Sample Clerk', role: 'preparer' }],
    events: [
      event('upload', ago(3 * HOUR), null, { docId: 'd1' }), // from the mailbox
      event('upload', ago(2 * HOUR), 'u1', { docId: 'd2' }),
      event('upload', ago(4 * HOUR), 'u1', { docId: 'd9' }), // a paper never filed under a shipment
      event('pack_signed', ago(1 * HOUR), 'u1', { shipmentId: 's1', paperId: 'p1' }),
    ],
    papers: [{ id: 'p1', shipmentId: 's1', kind: 'export_pack', status: 'signed', signedAt: ago(1 * HOUR), deskEdits: 0, houseEdits: 0 }],
    documents: [{ id: 'd1', shipmentId: 's1' }, { id: 'd2', shipmentId: 's1' }, { id: 'd9', shipmentId: null }],
  };
  const { houses, totals } = computeMetrics({ workspaces: [house], now: NOW });
  assert.equal(houses[0].medianMinutesToSigned, 120, 'from the first upload of s1 to its signed pack');
  assert.equal(totals.medianMinutesToSigned, 120);
  const { documents, ...withoutDocuments } = house;
  assert.equal(computeMetrics({ workspaces: [withoutDocuments], now: NOW }).houses[0].medianMinutesToSigned, null);
});

test('a person who dismissed a question about papers that disagree stepped in: those packs are not autonomous', () => {
  const papers = [
    { id: 'p1', shipmentId: 's1', status: 'signed', signedAt: ago(2 * HOUR) },
    { id: 'p2', shipmentId: 's2', status: 'signed', signedAt: ago(2 * HOUR) },
  ];
  const questions = [
    { shipmentId: 's1', kind: 'mismatch', status: 'dismissed', closedBy: 'Asha (SAMPLE clerk)' }, // older data: now refused
    { shipmentId: 's2', kind: 'mismatch', status: 'dismissed', closedBy: 'Review agent' }, // the agents closed it: no longer needed
    { shipmentId: 's2', kind: 'missing_document', status: 'dismissed', closedBy: 'Asha (SAMPLE clerk)' }, // "not needed" is no step-in
  ];
  const [house] = computeMetrics({ workspaces: [{ workspace: { id: 'ws', name: 'Sample' }, members: [], events: [], papers, questions }], now: NOW }).houses;
  assert.equal(house.packsSigned, 2);
  assert.equal(house.autonomyRate, 0.5);
});
