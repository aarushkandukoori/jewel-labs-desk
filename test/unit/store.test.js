// Tests for src/core/store: the local JSON store, the shared helpers, the cloud row helpers, and the cloud store
// driven by an in-memory fake of the Supabase calls (no network). All data here is fictional SAMPLE data.
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { makeApi } from '../../src/core/store/cloud-api.js';
import { writeFileAtomic } from '../../src/core/store/disk.js';
import {
  createCloud,
  createLocalWorkspace,
  listLocalWorkspaces,
  openCloudStore,
  openLocalStore,
} from '../../src/core/store/index.js';
import {
  cleanForPostgres,
  friendlyMessage,
  housePayload,
  isRetryable,
  recordEventFromPayload,
  recordToRow,
  rowToRecord,
  toCloudError,
  toStorageError,
  workspaceFromRow,
  workspacePatchForServer,
  workspaceToRow,
} from '../../src/core/store/rows.js';
import { applyWorkspacePatch, encodeFileKey, normalizeWorkspace, sameJson } from '../../src/core/store/shared.js';

const tempDirs = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-store-test-'));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SAMPLE_PROFILE = {
  name: 'SAMPLE Diamonds',
  legalEntity: 'SAMPLE Diamonds Pvt Ltd',
  country: 'IN',
  city: 'Surat',
  commodities: ['Diamonds'],
  contactEmails: ['Exports@Sample-Diamonds.example'],
  emailDomains: ['@sample-diamonds.example'],
  destinations: ['BE', 'US'],
};

async function newLocal(options = {}) {
  const dir = await tempDir();
  const workspace = await createLocalWorkspace({ dir, profile: SAMPLE_PROFILE });
  const store = await openLocalStore({ dir, workspaceId: workspace.id, flushDelayMs: 20, ...options });
  return { dir, workspace, store, root: path.join(dir, 'workspaces', workspace.id) };
}

// ===================================================================================================
describe('local workspaces', () => {
  test('createLocalWorkspace writes workspace.json with defaults', async () => {
    const dir = await tempDir();
    const ws = await createLocalWorkspace({ dir, profile: SAMPLE_PROFILE });
    assert.match(ws.id, /^[0-9a-f-]{36}$/);
    assert.equal(ws.name, 'SAMPLE Diamonds');
    assert.equal(ws.autopilot, true);
    assert.equal(ws.environment, 'sandbox');
    assert.equal(ws.deskReview, false);
    assert.deepEqual(ws.permissions, { searchMailbox: true, readWhatsApp: true, draftRequests: true, ofacScreen: true });
    assert.deepEqual(ws.contactEmails, ['exports@sample-diamonds.example']);
    assert.deepEqual(ws.emailDomains, ['sample-diamonds.example']);
    assert.equal(ws.letterhead.companyName, 'SAMPLE Diamonds Pvt Ltd');
    assert.equal(ws.letterhead.cityCountry, 'Surat, IN');
    assert.ok(ws.createdAt && ws.updatedAt);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'workspaces', ws.id, 'workspace.json'), 'utf8'));
    assert.deepEqual(saved, ws);
  });

  test('createLocalWorkspace needs a house name and refuses an id that exists', async () => {
    const dir = await tempDir();
    await assert.rejects(createLocalWorkspace({ dir, profile: { city: 'Surat' } }), /house name is required/);
    await createLocalWorkspace({ dir, profile: { name: 'SAMPLE One', id: 'sample-house' } });
    await assert.rejects(createLocalWorkspace({ dir, profile: { name: 'SAMPLE Two', id: 'sample-house' } }), /already exists/);
    await assert.rejects(createLocalWorkspace({ dir, profile: { name: 'SAMPLE Bad', id: '../escape' } }), /Bad workspace id/);
  });

  test('listLocalWorkspaces lists them oldest first and skips broken folders', async () => {
    const dir = await tempDir();
    assert.deepEqual(await listLocalWorkspaces({ dir }), []); // no folder yet
    const first = await createLocalWorkspace({ dir, profile: { name: 'SAMPLE First' } });
    await wait(5);
    const second = await createLocalWorkspace({ dir, profile: { name: 'SAMPLE Second' } });
    await fs.mkdir(path.join(dir, 'workspaces', 'broken-one'), { recursive: true });
    await fs.writeFile(path.join(dir, 'workspaces', 'broken-one', 'workspace.json'), '{not json');
    await fs.mkdir(path.join(dir, 'workspaces', 'empty-one'), { recursive: true });
    await fs.writeFile(path.join(dir, 'workspaces', '.DS_Store'), '');
    const list = await listLocalWorkspaces({ dir });
    assert.deepEqual(list.map((w) => w.id), [first.id, second.id]);
  });

  test('openLocalStore refuses a workspace that does not exist', async () => {
    const dir = await tempDir();
    await assert.rejects(openLocalStore({ dir, workspaceId: 'missing-house' }), /No local workspace/);
    await assert.rejects(openLocalStore({ dir, workspaceId: '../../etc' }), /Bad workspace id/);
  });
});

// ===================================================================================================
describe('local store records', () => {
  test('put fills id, workspaceId and timestamps; get and list return copies', async () => {
    const { store, workspace } = await newLocal();
    const doc = await store.put('documents', { fileName: 'SAMPLE invoice.pdf', status: 'new' });
    assert.match(doc.id, /^[0-9a-f-]{36}$/);
    assert.equal(doc.workspaceId, workspace.id);
    assert.ok(doc.createdAt && doc.updatedAt);

    const got = await store.get('documents', doc.id);
    assert.deepEqual(got, doc);
    got.status = 'changed by the caller';
    assert.equal((await store.get('documents', doc.id)).status, 'new', 'changing a returned copy must not change the store');

    await wait(5);
    const again = await store.put('documents', { id: doc.id, fileName: 'SAMPLE invoice.pdf', status: 'read' });
    assert.equal(again.createdAt, doc.createdAt, 'createdAt is kept');
    assert.ok(again.updatedAt > doc.updatedAt, 'updatedAt moves on');
    assert.equal(again.status, 'read');
    assert.equal(await store.get('documents', 'no-such-id'), null);
    assert.deepEqual(await store.list('never_used'), []);
    await store.close();
  });

  test('list filters with a function or an object and sorts oldest first', async () => {
    const { store } = await newLocal();
    await store.put('stones', { id: 'c', carat: 1.2, shipmentId: 's1', createdAt: '2026-11-03T00:00:00.000Z' });
    await store.put('stones', { id: 'a', carat: 0.4, shipmentId: 's1', createdAt: '2026-11-01T00:00:00.000Z' });
    await store.put('stones', { id: 'b', carat: 0.9, shipmentId: 's2', createdAt: '2026-11-02T00:00:00.000Z' });
    assert.deepEqual((await store.list('stones')).map((s) => s.id), ['a', 'b', 'c']);
    assert.deepEqual((await store.list('stones', (s) => s.carat >= 0.5)).map((s) => s.id), ['b', 'c']);
    assert.deepEqual((await store.list('stones', { shipmentId: 's1' })).map((s) => s.id), ['a', 'c']);
    await store.close();
  });

  test('remove deletes, and removing a missing record does nothing', async () => {
    const { store } = await newLocal();
    await store.put('questions', { id: 'q1', text: 'Which KP certificate covers line 3?' });
    await store.remove('questions', 'q1');
    assert.equal(await store.get('questions', 'q1'), null);
    await store.remove('questions', 'q1');
    await store.remove('questions', 'never-there');
    await store.close();
  });

  test('bad collection names and ids are refused', async () => {
    const { store } = await newLocal();
    for (const name of ['../escape', 'Documents', 'workspace', '', 'a/b', 'files.json', '_sync']) {
      await assert.rejects(store.put(name, { x: 1 }), /Bad collection name/, name);
    }
    await assert.rejects(store.put('documents', { id: 'bad\nid' }), /Bad record id/);
    await assert.rejects(store.put('documents', { id: 'x'.repeat(201) }), /Bad record id/);
    await assert.rejects(store.put('documents', ['not', 'an', 'object']), /plain object/);
    const numeric = await store.put('documents', { id: 42 });
    assert.equal(numeric.id, '42');
    assert.ok(await store.get('documents', 42));
    await store.close();
  });

  test("'change' events for put, remove and workspace updates", async () => {
    const { store, workspace } = await newLocal();
    const seen = [];
    store.on('change', (event) => seen.push(event));
    const shipment = await store.put('shipments', { ref: 'JL-EXP-1115-01' });
    await store.remove('shipments', shipment.id);
    await store.remove('shipments', shipment.id); // nothing left: no event
    await store.updateWorkspace({ autopilot: false });
    assert.deepEqual(
      seen.map((e) => [e.collection, e.op, e.remote]),
      [
        ['shipments', 'put', false],
        ['shipments', 'remove', false],
        ['workspace', 'put', false],
      ],
    );
    assert.equal(seen[0].id, shipment.id);
    assert.equal(seen[0].value.ref, 'JL-EXP-1115-01');
    assert.equal(seen[1].value.ref, 'JL-EXP-1115-01', 'remove events carry the removed record');
    assert.equal(seen[2].id, workspace.id);
    seen[0].value.ref = 'changed by a listener';
    assert.equal(seen.length, 3);
    await store.close();
  });

  test('a listener that throws does not break the save', async () => {
    const { store } = await newLocal();
    const original = console.error;
    console.error = () => {};
    try {
      store.on('change', () => {
        throw new Error('listener bug');
      });
      const saved = await store.put('activity', { action: 'read' });
      assert.ok(await store.get('activity', saved.id));
    } finally {
      console.error = original;
    }
    await store.close();
  });

  test('updateWorkspace merges letterhead and permissions and saves at once', async () => {
    const { dir, store, workspace } = await newLocal();
    const updated = await store.updateWorkspace({
      permissions: { ofacScreen: false },
      letterhead: { iec: 'SAMPLE-IEC-0001' },
      id: 'cannot-change',
      createdAt: '1999-01-01T00:00:00.000Z',
      mailboxProvider: 'gmail',
    });
    assert.equal(updated.id, workspace.id);
    assert.equal(updated.createdAt, workspace.createdAt);
    assert.equal(updated.permissions.ofacScreen, false);
    assert.equal(updated.permissions.readWhatsApp, true);
    assert.equal(updated.letterhead.iec, 'SAMPLE-IEC-0001');
    assert.equal(updated.letterhead.companyName, 'SAMPLE Diamonds Pvt Ltd');
    assert.equal(updated.mailboxProvider, 'gmail', 'extra settings are kept');
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'workspaces', workspace.id, 'workspace.json'), 'utf8'));
    assert.equal(onDisk.permissions.ofacScreen, false);
    await store.close();
  });
});

// ===================================================================================================
describe('local store persistence', () => {
  test('saves in the background (debounced) and on flush, keyed by id', async () => {
    const { store, root } = await newLocal({ flushDelayMs: 150 });
    const doc = await store.put('documents', { fileName: 'SAMPLE packing list.pdf' });
    const file = path.join(root, 'documents.json');
    await assert.rejects(fs.access(file), 'not written at once');
    await wait(400);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(saved), [doc.id]);
    assert.equal(saved[doc.id].fileName, 'SAMPLE packing list.pdf');

    await store.put('documents', { id: doc.id, fileName: 'renamed.pdf' });
    await store.flush();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[doc.id].fileName, 'renamed.pdf');
    await store.close();
  });

  test('everything is back after close and reopen', async () => {
    const { dir, store, workspace } = await newLocal();
    await store.put('shipments', { id: 's1', ref: 'JL-EXP-1115-01', totals: { carats: 12.5 } });
    await store.put('stones', { id: 'st1', reportNumber: 'SAMPLE-2201', carat: 0.71 });
    await store.put('stones', { id: 'st2', reportNumber: 'SAMPLE-2202', carat: 0.52 });
    await store.remove('stones', 'st2');
    await store.updateWorkspace({ autopilot: false });
    await store.close();
    await assert.rejects(store.get('stones', 'st1'), /closed/);

    const reopened = await openLocalStore({ dir, workspaceId: workspace.id });
    assert.equal((await reopened.get('shipments', 's1')).totals.carats, 12.5);
    assert.deepEqual((await reopened.list('stones')).map((s) => s.id), ['st1']);
    assert.equal((await reopened.workspace()).autopilot, false);
    await reopened.close();
  });

  test('many puts at once all land, and the last put of an id wins', async () => {
    const { dir, store, workspace } = await newLocal({ flushDelayMs: 1 });
    const puts = [];
    for (let i = 0; i < 300; i += 1) {
      const collection = ['documents', 'activity', 'events'][i % 3];
      puts.push(store.put(collection, { id: `r${i}`, n: i }));
    }
    for (let i = 0; i < 20; i += 1) puts.push(store.put('shipments', { id: 'same', version: i }));
    await Promise.all(puts);
    await store.close();
    const reopened = await openLocalStore({ dir, workspaceId: workspace.id });
    const counts = await Promise.all(['documents', 'activity', 'events'].map((c) => reopened.list(c)));
    assert.deepEqual(counts.map((list) => list.length), [100, 100, 100]);
    assert.equal((await reopened.get('shipments', 'same')).version, 19);
    await reopened.close();
  });

  test('writes are atomic: no temp files left, leftovers cleaned on open', async () => {
    const { dir, store, workspace, root } = await newLocal();
    await store.put('papers', { id: 'p1', ref: 'JL-EXP-1115-01' });
    await store.flush();
    assert.deepEqual((await fs.readdir(root)).filter((n) => n.endsWith('.tmp')), []);
    await store.close();

    await fs.writeFile(path.join(root, 'papers.json.ab12cd34.tmp'), '{"half":');
    const reopened = await openLocalStore({ dir, workspaceId: workspace.id });
    assert.deepEqual((await fs.readdir(root)).filter((n) => n.endsWith('.tmp')), []);
    assert.ok(await reopened.get('papers', 'p1'));
    await reopened.close();
  });

  test('a failed atomic write leaves the old file and no temp file', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'blocked.json');
    await fs.mkdir(target); // a folder where the file should go makes the rename fail
    await assert.rejects(writeFileAtomic(target, '{"a":1}'));
    assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
    assert.ok((await fs.stat(target)).isDirectory());
  });

  test('a corrupt collection file is set aside and the store still opens', async () => {
    const { dir, store, workspace, root } = await newLocal();
    await store.put('documents', { id: 'd1' });
    await store.put('shipments', { id: 's1' });
    await store.close();
    await fs.writeFile(path.join(root, 'documents.json'), '{"d1": {"id": "d1"'); // cut off
    const original = console.error;
    console.error = () => {};
    let reopened;
    try {
      reopened = await openLocalStore({ dir, workspaceId: workspace.id });
    } finally {
      console.error = original;
    }
    assert.deepEqual(await reopened.list('documents'), []);
    assert.ok(await reopened.get('shipments', 's1'), 'other collections are fine');
    assert.equal(reopened.problems.length, 1);
    assert.match(reopened.problems[0].movedTo, /documents\.corrupt-\d+\.json\.bak$/);
    await fs.access(reopened.problems[0].movedTo);
    await reopened.close();
  });
});

// ===================================================================================================
describe('local store files', () => {
  test('putFile and getFile round-trip bytes and return a plain Uint8Array', async () => {
    const { store, root } = await newLocal();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x10]);
    const docPath = 'docs/d1/SAMPLE invoice.pdf';
    assert.equal(await store.putFile(docPath, bytes, 'application/pdf'), docPath);
    const back = await store.getFile(docPath);
    assert.equal(Object.getPrototypeOf(back), Uint8Array.prototype, 'not a Node Buffer');
    assert.deepEqual([...back], [...bytes]);
    await fs.access(path.join(root, 'files', 'docs', 'd1', 'SAMPLE invoice.pdf'));
    const { getFile } = store; // works when passed around on its own
    assert.equal((await getFile(docPath)).length, bytes.length);
    await store.putFile('docs/d2/notes.txt', 'plain text', 'text/plain');
    assert.equal(new TextDecoder().decode(await store.getFile('docs/d2/notes.txt')), 'plain text');
    await store.close();
  });

  test('odd file names stay inside the files folder; bad keys are refused', async () => {
    const { store, root } = await newLocal();
    const oddPath = 'docs/d1/Facture n°12 <final>: copy?.pdf';
    await store.putFile(oddPath, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...(await store.getFile(oddPath))], [1, 2, 3]);
    const names = await fs.readdir(path.join(root, 'files', 'docs', 'd1'));
    assert.equal(names.length, 1);
    assert.match(names[0], /^[A-Za-z0-9._() $-]+$/);
    for (const bad of ['../outside.pdf', 'docs/../../x', '/abs/path', 'docs//x', '', 'docs/./x']) {
      await assert.rejects(store.putFile(bad, new Uint8Array([1])), /Bad file key/, bad);
    }
    await assert.rejects(store.getFile('docs/none/missing.pdf'), { code: 'ENOENT' });
    await store.removeFile(oddPath);
    await assert.rejects(store.getFile(oddPath), { code: 'ENOENT' });
    await store.close();
  });
});

// ===================================================================================================
describe('shared helpers', () => {
  test('encodeFileKey keeps plain names and escapes everything else', () => {
    assert.equal(encodeFileKey('docs/abc/SAMPLE invoice (1).pdf'), 'docs/abc/SAMPLE invoice (1).pdf');
    assert.equal(encodeFileKey('docs/abc/naïve.pdf'), 'docs/abc/na$C3$AFve.pdf');
    assert.equal(encodeFileKey('docs/abc/a$b.pdf'), 'docs/abc/a$24b.pdf');
    assert.equal(encodeFileKey('docs/abc/CON.pdf'), 'docs/abc/$43ON.pdf');
    assert.equal(encodeFileKey('docs/abc/name.'), 'docs/abc/name$2E');
    assert.equal(encodeFileKey('docs/abc/back\\slash.pdf'), 'docs/abc/back$5Cslash.pdf');
    const long = encodeFileKey(`docs/abc/${'x'.repeat(300)}.pdf`).split('/')[2];
    assert.ok(long.length <= 120);
    assert.notEqual(long, encodeFileKey(`docs/abc/${'x'.repeat(301)}.pdf`).split('/')[2], 'long names stay unique');
    assert.throws(() => encodeFileKey('docs/../x'), /Bad file key/);
  });

  test('normalizeWorkspace fills defaults and keeps extra fields', () => {
    const ws = normalizeWorkspace({ name: '  SAMPLE House ', commodities: 'Diamonds, Gold', environment: 'nonsense', extra: 1 });
    assert.equal(ws.name, 'SAMPLE House');
    assert.deepEqual(ws.commodities, ['Diamonds', 'Gold']);
    assert.equal(ws.environment, 'sandbox');
    assert.equal(ws.extra, 1);
    assert.equal(normalizeWorkspace({}).name, 'My house');
    assert.deepEqual(normalizeWorkspace({ commodities: [] }).commodities, [], 'an explicit empty list is kept');
    assert.equal(normalizeWorkspace({ environment: 'live' }).environment, 'live');
  });

  test('applyWorkspacePatch merges nested settings one level deep', () => {
    const current = normalizeWorkspace({ id: 'w1', name: 'SAMPLE', createdAt: '2026-01-01T00:00:00.000Z' });
    const next = applyWorkspacePatch(current, { permissions: { draftRequests: false } }, '2026-02-01T00:00:00.000Z');
    assert.equal(next.permissions.draftRequests, false);
    assert.equal(next.permissions.ofacScreen, true);
    assert.equal(next.updatedAt, '2026-02-01T00:00:00.000Z');
    assert.equal(next.createdAt, '2026-01-01T00:00:00.000Z');
  });

  test('sameJson ignores key order', () => {
    assert.ok(sameJson({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }));
    assert.ok(!sameJson({ a: 1 }, { a: 2 }));
  });
});

// ===================================================================================================
describe('cloud row helpers', () => {
  const WS = '11111111-1111-4111-8111-111111111111';

  test('records go into rows and come back the same', () => {
    const record = { id: 'd1', workspaceId: WS, docType: 'lab_report', fields: [{ key: 'lab.carat', value: '0.71' }] };
    const row = recordToRow(WS, 'documents', record);
    assert.deepEqual(row, { workspace_id: WS, collection: 'documents', id: 'd1', data: record });
    assert.deepEqual(rowToRecord({ ...row, rev: 3, updated_at: '2026-11-15T00:00:00+00:00' }), record);
    assert.deepEqual(rowToRecord({ workspace_id: WS, collection: 'documents', id: 'x', data: null }), { id: 'x', workspaceId: WS });
  });

  test('cleanForPostgres removes what jsonb refuses', () => {
    const cleaned = cleanForPostgres({ text: 'a\u0000b', broken: 'x\uD800y', list: [undefined, NaN, 1], gone: undefined, 'k\u0000ey': 1 });
    assert.equal(cleaned.text, 'ab');
    assert.equal(cleaned.broken, 'x�y');
    assert.deepEqual(cleaned.list, [null, null, 1]);
    assert.ok(!('gone' in cleaned));
    assert.equal(cleaned.key, 1);
  });

  test('workspaces go into rows and come back the same', () => {
    const ws = normalizeWorkspace({ ...SAMPLE_PROFILE, id: WS, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' });
    const row = { id: WS, ...workspaceToRow(ws), created_at: ws.createdAt, created_by: null, rev: 1 };
    assert.equal(row.data.name, undefined, 'name is a column, not in data');
    assert.ok(sameJson(workspaceFromRow(row), { ...ws, createdBy: null }));
  });

  test('housePayload and workspacePatchForServer send only what the server should store', () => {
    const payload = housePayload({ ...SAMPLE_PROFILE, id: 'ignored', myRole: 'owner' });
    assert.equal(payload.name, 'SAMPLE Diamonds');
    assert.ok(!('id' in payload) && !('myRole' in payload) && !('createdAt' in payload));
    assert.throws(() => housePayload({ city: 'Surat' }), /house name is required/);

    const current = normalizeWorkspace({ ...SAMPLE_PROFILE, id: WS });
    const merged = applyWorkspacePatch(current, { permissions: { ofacScreen: false } });
    const patch = workspacePatchForServer(merged, { permissions: { ofacScreen: false } });
    assert.deepEqual(Object.keys(patch).sort(), ['permissions', 'updatedAt']);
    assert.equal(patch.permissions.readWhatsApp, true, 'nested settings are sent whole');
  });

  test('Realtime payloads become put/remove events', () => {
    const row = { workspace_id: WS, collection: 'stones', id: 's1', data: { carat: 0.7 }, rev: 2 };
    assert.deepEqual(recordEventFromPayload({ eventType: 'INSERT', new: row, old: {}, errors: null }), { type: 'put', row, incomplete: false });
    assert.deepEqual(recordEventFromPayload({ eventType: 'DELETE', new: {}, old: { workspace_id: WS, collection: 'stones', id: 's1' } }).type, 'remove');
    assert.equal(recordEventFromPayload({ eventType: 'UPDATE', new: { ...row, data: null }, errors: ['Error 413: Payload Too Large'] }).incomplete, true);
  });

  test('errors: which ones are worth retrying, and what people read', () => {
    for (const status of [0, undefined, 401, 408, 429, 500, 503]) assert.equal(isRetryable(status), true, String(status));
    for (const status of [400, 403, 404, 409, 413, 422]) assert.equal(isRetryable(status), false, String(status));
    const rls = toCloudError({ message: 'new row violates row-level security policy', code: '42501' }, 403);
    assert.equal(rls.retryable, false);
    assert.equal(friendlyMessage(rls), 'You do not have permission to change this.');
    const network = toCloudError({ message: 'TypeError: fetch failed', code: '' }, 0);
    assert.equal(network.retryable, true);
    assert.match(friendlyMessage(network), /Could not reach Jewel Labs/);
    const missing = toStorageError({ message: 'Object not found', statusCode: '404', status: 400 });
    assert.equal(missing.code, 'ENOENT');
    assert.equal(missing.retryable, false);
    const raised = toCloudError({ message: 'Only the house owner or Jewel Labs can create invite codes.', code: 'P0001' }, 400);
    assert.equal(friendlyMessage(raised), 'Only the house owner or Jewel Labs can create invite codes.');
  });
});

// ===================================================================================================
// A small in-memory stand-in for Supabase: tables, storage and Realtime, with switches for "offline",
// "refuse these rows" and "slow answers". Realtime events arrive a moment after a change, like the real thing.

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '33333333-3333-4333-8333-333333333333';
const clone = (value) => (value === undefined || value === null ? value ?? null : JSON.parse(JSON.stringify(value)));

function fakeSupabase() {
  const rows = new Map(); // "ws|collection|id" -> row
  const files = new Map(); // "ws/fileKey" -> { bytes, mime }
  const listeners = new Set();
  const house = { id: WS, name: 'SAMPLE Exports', environment: 'sandbox', data: { city: 'Surat' }, rev: 1, created_at: '2026-11-01T00:00:00.000Z', created_by: null };
  const state = { offline: false, refuse: null, slowAnswer: null, calls: [], missing: false };
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 15) + (tick += 1)).toISOString().replace('Z', '+00:00');

  function check(name) {
    state.calls.push(name);
    if (state.offline) throw Object.assign(new Error('TypeError: fetch failed'), { status: 0, retryable: true });
  }
  function emit(fn) {
    setImmediate(() => {
      for (const handlers of listeners) fn(handlers);
    });
  }
  function save(ws, collection, id, data) {
    const key = `${ws}|${collection}|${id}`;
    const old = rows.get(key);
    const row = { workspace_id: ws, collection, id, data: clone(data), rev: old ? old.rev + 1 : 1, updated_at: stamp() };
    rows.set(key, row);
    return row;
  }
  const putEvent = (row) => emit((h) => h.onRecord({ type: 'put', row: clone(row), incomplete: false }));
  const removeEvent = (ws, collection, id) => emit((h) => h.onRecord({ type: 'remove', row: { workspace_id: ws, collection, id }, incomplete: false }));

  const api = {
    async loadWorkspace() {
      check('loadWorkspace');
      return state.missing ? null : clone(house);
    },
    async listRecords() {
      check('listRecords');
      return [...rows.values()]
        .filter((row) => row.workspace_id === WS)
        .sort((a, b) => `${a.collection}/${a.id}`.localeCompare(`${b.collection}/${b.id}`))
        .map(clone);
    },
    async getRecord(collection, id) {
      check('getRecord');
      return clone(rows.get(`${WS}|${collection}|${id}`) || null);
    },
    async upsertRecords(list) {
      check('upsertRecords');
      if (state.refuse && list.some(state.refuse)) {
        throw Object.assign(new Error('new row violates row-level security policy'), { status: 403, code: '42501', retryable: false });
      }
      const saved = list.map((row) => save(row.workspace_id, row.collection, row.id, row.data));
      saved.forEach(putEvent); // the echo of our own save
      if (state.slowAnswer) await state.slowAnswer;
      return saved.map((row) => ({ collection: row.collection, id: row.id, rev: row.rev, updated_at: row.updated_at }));
    },
    async deleteRecord(collection, id) {
      check('deleteRecord');
      rows.delete(`${WS}|${collection}|${id}`);
      removeEvent(WS, collection, id);
    },
    async updateWorkspace(patch) {
      check('updateWorkspace');
      const { name, environment, ...data } = patch;
      if (name) house.name = name;
      if (environment) house.environment = environment;
      house.data = { ...house.data, ...clone(data) };
      house.rev += 1;
      emit((h) => h.onWorkspace(clone(house)));
      return clone(house);
    },
    async uploadFile(fileKey, bytes, mime) {
      check('uploadFile');
      files.set(`${WS}/${fileKey}`, { bytes: new Uint8Array(bytes), mime });
    },
    async downloadFile(fileKey) {
      check('downloadFile');
      const file = files.get(`${WS}/${fileKey}`);
      if (!file) throw Object.assign(new Error('Object not found'), { status: 404, code: 'ENOENT', retryable: false });
      return new Uint8Array(file.bytes);
    },
    async removeFile(fileKey) {
      check('removeFile');
      files.delete(`${WS}/${fileKey}`);
    },
    subscribe(handlers) {
      listeners.add(handlers);
      emit((h) => h === handlers && h.onStatus('SUBSCRIBED'));
      return { close: () => listeners.delete(handlers) };
    },
  };

  return {
    api,
    rows,
    files,
    house,
    state,
    row: (collection, id, ws = WS) => rows.get(`${ws}|${collection}|${id}`),
    // Changes made by another computer. quiet: the change happens while we are not listening.
    remotePut(collection, id, data, { quiet = false, ws = WS } = {}) {
      const row = save(ws, collection, id, { ...data, id, workspaceId: ws });
      if (!quiet) putEvent(row);
      return row;
    },
    remoteDelete(collection, id, { quiet = false, ws = WS } = {}) {
      rows.delete(`${ws}|${collection}|${id}`);
      if (!quiet) removeEvent(ws, collection, id);
    },
    remoteBigPut(collection, id, data) {
      const row = save(WS, collection, id, { ...data, id, workspaceId: WS });
      emit((h) => h.onRecord({ type: 'put', row: { ...clone(row), data: null }, incomplete: true }));
      return row;
    },
    remoteSettings(changes) {
      house.data = { ...house.data, ...changes };
      house.rev += 1;
      emit((h) => h.onWorkspace(clone(house)));
    },
    reconnect() {
      emit((h) => h.onStatus('CHANNEL_ERROR'));
      emit((h) => h.onStatus('SUBSCRIBED'));
    },
  };
}

async function openCloud(fake, cacheDir) {
  return openCloudStore({
    workspaceId: WS,
    cacheDir: cacheDir || (await tempDir()),
    api: fake.api,
    flushDelayMs: 5,
    retryDelaysMs: [20, 40],
    realtimeWaitMs: 300,
  });
}

const settle = () => wait(30); // lets fake Realtime events and background work finish

describe('cloud store (fake Supabase)', () => {
  test('opens with the house and only its own records', async () => {
    const fake = fakeSupabase();
    fake.remotePut('shipments', 's2', { ref: 'JL-EXP-1115-02', createdAt: '2026-11-15T09:00:00.000Z' }, { quiet: true });
    fake.remotePut('shipments', 's1', { ref: 'JL-EXP-1115-01', createdAt: '2026-11-15T08:00:00.000Z' }, { quiet: true });
    fake.remotePut('shipments', 'x1', { ref: 'not ours' }, { quiet: true, ws: OTHER_WS });
    const store = await openCloud(fake);
    assert.equal(store.kind, 'cloud');
    assert.deepEqual((await store.list('shipments')).map((s) => s.id), ['s1', 's2']);
    assert.equal((await store.workspace()).name, 'SAMPLE Exports');
    assert.equal((await store.workspace()).city, 'Surat');
    assert.equal(store.syncStatus().online, true);
    assert.equal(store.syncStatus().realtime, 'live');
    await store.close();
  });

  test('put and remove reach the server; the echo of our own save is ignored', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    const remote = [];
    store.on('change', (event) => event.remote && remote.push(event));

    const doc = await store.put('documents', { fileName: 'SAMPLE invoice.pdf', status: 'new' });
    assert.equal(store.syncStatus().pending, 1);
    await store.flush();
    await settle();
    assert.equal(fake.row('documents', doc.id).rev, 1);
    assert.equal(fake.row('documents', doc.id).data.fileName, 'SAMPLE invoice.pdf');

    await store.put('documents', { ...doc, status: 'read' });
    await store.flush();
    await settle();
    assert.equal(fake.row('documents', doc.id).rev, 2);
    assert.equal(fake.row('documents', doc.id).data.status, 'read');

    await store.remove('documents', doc.id);
    await store.flush();
    await settle();
    assert.equal(fake.row('documents', doc.id), undefined);
    assert.deepEqual(remote, [], 'no remote change events for our own saves');
    assert.equal(store.syncStatus().pending, 0);
    await store.close();
  });

  test('many saves in one go are sent together, in order', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    fake.state.calls.length = 0;
    const saves = [];
    for (let i = 0; i < 250; i += 1) saves.push(store.put('activity', { id: `a${i}`, action: 'read' }));
    await Promise.all(saves);
    await store.flush();
    const upserts = fake.state.calls.filter((name) => name === 'upsertRecords').length;
    assert.equal(upserts, 3, '250 rows go out as 3 requests of up to 100');
    assert.equal([...fake.rows.values()].filter((row) => row.collection === 'activity').length, 250);
    await store.close();
  });

  test('changes from other computers arrive; deletes of other houses are ignored', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    const seen = [];
    store.on('change', (event) => seen.push([event.collection, event.id, event.op, event.remote]));

    fake.remotePut('questions', 'q1', { text: 'Which KP certificate covers line 3?' });
    await settle();
    assert.equal((await store.get('questions', 'q1')).text, 'Which KP certificate covers line 3?');
    fake.remotePut('questions', 'q1', { text: 'Answered', status: 'answered' });
    await settle();
    assert.equal((await store.get('questions', 'q1')).status, 'answered');
    fake.remoteDelete('questions', 'q1', { ws: OTHER_WS }); // another house: must be ignored
    await settle();
    assert.ok(await store.get('questions', 'q1'));
    fake.remoteDelete('questions', 'q1');
    await settle();
    assert.equal(await store.get('questions', 'q1'), null);
    assert.deepEqual(seen, [
      ['questions', 'q1', 'put', true],
      ['questions', 'q1', 'put', true],
      ['questions', 'q1', 'remove', true],
    ]);
    await store.close();
  });

  test('a change too big for Realtime is fetched in full', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    fake.remoteBigPut('documents', 'big', { words: Array.from({ length: 50 }, (_, i) => ({ text: `w${i}` })) });
    await settle();
    assert.equal((await store.get('documents', 'big')).words.length, 50);
    await store.close();
  });

  test('when someone else saves right after us, their save wins here too', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    let answer;
    fake.state.slowAnswer = new Promise((resolve) => {
      answer = resolve;
    });
    await store.put('shipments', { id: 's1', status: 'reading' });
    await settle(); // our save is in the database, its answer is still on the way
    fake.remotePut('shipments', 's1', { status: 'questions' }); // another computer saves right after
    await settle();
    fake.state.slowAnswer = null;
    answer();
    await store.flush();
    await settle();
    assert.equal(fake.row('shipments', 's1').data.status, 'questions');
    assert.equal((await store.get('shipments', 's1')).status, 'questions');
    await store.close();
  });

  test('a change the server refuses is dropped and the record goes back to the server copy', async () => {
    const fake = fakeSupabase();
    fake.remotePut('papers', 'p0', { status: 'ready_to_sign' }, { quiet: true });
    const store = await openCloud(fake);
    fake.state.refuse = (row) => row.collection === 'papers';
    const original = console.error;
    console.error = () => {};
    try {
      await store.put('papers', { id: 'p0', status: 'signed' }); // refused: back to ready_to_sign
      await store.put('papers', { id: 'p9', status: 'draft' }); // refused and new: removed here
      await store.put('messages', { id: 'm1', text: 'Fine to send' }); // same request, allowed
      await store.flush();
      await settle();
    } finally {
      console.error = original;
    }
    assert.equal((await store.get('papers', 'p0')).status, 'ready_to_sign');
    assert.equal(await store.get('papers', 'p9'), null);
    assert.ok(fake.row('messages', 'm1'), 'the good row in the same request still got saved');
    assert.match(store.syncStatus().lastError, /could not be saved/);
    assert.equal(store.syncStatus().pending, 0);
    await store.close();
  });

  test('changes made offline are kept, survive a restart, and are sent later in order', async () => {
    const fake = fakeSupabase();
    const cacheDir = await tempDir();
    const store = await openCloud(fake, cacheDir);
    await store.put('shipments', { id: 's1', ref: 'JL-EXP-1115-01' });
    await store.flush();

    fake.state.offline = true;
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await store.putFile('papers/p1/JL-EXP-1115-01-v1.pdf', pdf, 'application/pdf');
    await store.put('papers', { id: 'p1', ref: 'JL-EXP-1115-01', fileKey: 'papers/p1/JL-EXP-1115-01-v1.pdf' });
    await store.flush();
    assert.equal(store.syncStatus().online, false);
    assert.equal(store.syncStatus().pending, 2);
    assert.match(store.syncStatus().lastError, /Could not reach Jewel Labs/);
    await store.close();

    // Reopen while still offline: the saved copy opens.
    const again = await openCloud(fake, cacheDir);
    assert.equal((await again.get('papers', 'p1')).ref, 'JL-EXP-1115-01');
    assert.equal((await again.get('shipments', 's1')).ref, 'JL-EXP-1115-01');
    assert.deepEqual([...(await again.getFile('papers/p1/JL-EXP-1115-01-v1.pdf'))], [...pdf]);
    assert.equal(again.syncStatus().online, false);

    fake.state.offline = false;
    fake.state.calls.length = 0;
    await again.flush();
    await settle();
    assert.ok(fake.row('papers', 'p1'));
    assert.deepEqual([...fake.files.get(`${WS}/papers/p1/JL-EXP-1115-01-v1.pdf`).bytes], [...pdf]);
    const order = fake.state.calls.filter((name) => name === 'uploadFile' || name === 'upsertRecords');
    assert.deepEqual(order.slice(0, 2), ['uploadFile', 'upsertRecords'], 'the file goes up before the record that points to it');
    assert.equal(again.syncStatus().online, true);
    assert.equal(again.syncStatus().pending, 0);
    await again.close();
  });

  test('after a reconnect it catches up on changes it missed', async () => {
    const fake = fakeSupabase();
    fake.remotePut('shipments', 's2', { ref: 'JL-EXP-1115-02' }, { quiet: true });
    const store = await openCloud(fake);
    await store.put('shipments', { id: 'mine', ref: 'kept' });
    await store.flush();
    fake.remotePut('stones', 'st1', { carat: 0.71 }, { quiet: true }); // missed while the connection was down
    fake.remoteDelete('shipments', 's2', { quiet: true });
    fake.reconnect();
    await wait(80);
    assert.equal((await store.get('stones', 'st1')).carat, 0.71);
    assert.equal(await store.get('shipments', 's2'), null);
    assert.ok(await store.get('shipments', 'mine'));
    await store.close();
  });

  test('files: uploaded once, downloaded and cached on another computer', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.putFile('docs/d1/SAMPLE packing list.pdf', bytes, 'application/pdf');
    await store.flush();
    assert.equal(fake.files.get(`${WS}/docs/d1/SAMPLE packing list.pdf`).mime, 'application/pdf');

    const other = await openCloud(fake);
    assert.deepEqual([...(await other.getFile('docs/d1/SAMPLE packing list.pdf'))], [...bytes]);
    fake.state.calls.length = 0;
    await other.getFile('docs/d1/SAMPLE packing list.pdf');
    assert.ok(!fake.state.calls.includes('downloadFile'), 'the second read comes from the cache');
    await assert.rejects(other.getFile('docs/none/missing.pdf'), { code: 'ENOENT' });

    await store.removeFile('docs/d1/SAMPLE packing list.pdf');
    await store.flush();
    assert.equal(fake.files.size, 0);
    await other.close();
    await store.close();
  });

  test('house settings: saved on the server, and changes from others arrive', async () => {
    const fake = fakeSupabase();
    const store = await openCloud(fake);
    const changes = [];
    store.on('change', (event) => event.collection === 'workspace' && changes.push(event));
    const updated = await store.updateWorkspace({ permissions: { ofacScreen: false } });
    assert.equal(updated.permissions.ofacScreen, false);
    assert.equal(updated.permissions.readWhatsApp, true);
    assert.equal(fake.house.data.permissions.ofacScreen, false);
    await settle();
    fake.remoteSettings({ autopilot: false });
    await settle();
    assert.equal((await store.workspace()).autopilot, false);
    assert.equal(changes.at(-1).remote, true);

    fake.state.offline = true;
    await assert.rejects(store.updateWorkspace({ deskReview: true }), /Could not save the house settings/);
    fake.state.offline = false;
    await store.close();
  });

  test('open fails clearly when there is no saved copy and no network, or no access', async () => {
    const fake = fakeSupabase();
    fake.state.offline = true;
    await assert.rejects(openCloud(fake), /Could not reach Jewel Labs/);
    fake.state.offline = false;
    fake.state.missing = true;
    await assert.rejects(openCloud(fake), /not found, or you are no longer a member/);
  });
});

// ===================================================================================================
// The real supabase-js library against a tiny local HTTP stand-in for Supabase, so the requests the app sends
// (paths, filters, headers, bodies) are checked too. Nothing leaves this computer.

async function startFakeHttp(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://local');
    const request = {
      method: req.method,
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      raw,
      json: () => JSON.parse(raw.toString('utf8') || 'null'),
    };
    requests.push(request);
    let reply;
    try {
      reply = (await handler(request)) || { status: 404, json: { message: `no route for ${req.method} ${request.path}` } };
    } catch (err) {
      reply = { status: 500, json: { message: err.message } };
    }
    const headers = { ...(reply.headers || {}) };
    let body = '';
    if (reply.bytes) {
      body = Buffer.from(reply.bytes);
      headers['content-type'] ||= 'application/octet-stream';
    } else if (reply.json !== undefined) {
      body = JSON.stringify(reply.json);
      headers['content-type'] ||= 'application/json';
    }
    res.writeHead(reply.status || 200, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    find: (method, pathName) => requests.filter((r) => r.method === method && r.path === pathName),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const TEST_KEY = ['sample', 'publishable', 'key'].join('-'); // not a real key format

describe('cloud over HTTP (real supabase-js, local stand-in server)', () => {
  test('makeApi sends the right requests and maps answers and errors', async () => {
    const house = { id: WS, name: 'SAMPLE Exports', environment: 'sandbox', data: { city: 'Surat' }, rev: 4, created_at: '2026-11-01T00:00:00+00:00', created_by: null };
    const rowOf = (collection, id) => ({ workspace_id: WS, collection, id, data: { id }, rev: 1, updated_at: '2026-11-15T09:00:00+00:00' });
    const serverRows = [rowOf('activity', 'a1'), rowOf('activity', 'a2'), rowOf('activity', 'a3'), rowOf('documents', 'd1')];
    const objects = new Map();
    const after = (row, c, i) => row.collection > c || (row.collection === c && row.id > i);
    const fake = await startFakeHttp((r) => {
      if (r.method === 'GET' && r.path === '/rest/v1/workspaces') return { json: r.query.id === `eq.${WS}` ? [house] : [] };
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/list_records') {
        const body = r.json();
        // This server returns at most 2 rows per page, whatever the app asks for.
        return { json: serverRows.filter((row) => after(row, body.p_after_collection, body.p_after_id)).slice(0, 2) };
      }
      if (r.method === 'POST' && r.path === '/rest/v1/records') {
        const rows = r.json();
        if (rows.some((row) => row.collection === 'locked')) {
          return { status: 403, json: { code: '42501', message: 'new row violates row-level security policy for table "records"', details: null, hint: null } };
        }
        return { status: 201, json: rows.map((row, n) => ({ collection: row.collection, id: row.id, rev: 7 + n, updated_at: '2026-11-15T10:00:00.123456+00:00' })) };
      }
      if (r.method === 'DELETE' && r.path === '/rest/v1/records') return { status: 204 };
      if (r.method === 'GET' && r.path === '/rest/v1/records') return { json: [] };
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/update_house') {
        return { json: { ...house, rev: 5, data: { ...house.data, ...r.json().p_patch } } };
      }
      const prefix = '/storage/v1/object/documents/';
      if (r.path.startsWith(prefix)) {
        const name = r.path.slice(prefix.length);
        if (r.method === 'POST') {
          objects.set(name, { bytes: r.raw, mime: r.headers['content-type'], upsert: r.headers['x-upsert'] });
          return { json: { Key: `documents/${name}`, Id: 'object-1' } };
        }
        if (r.method === 'GET') {
          return objects.has(name)
            ? { bytes: objects.get(name).bytes }
            : { status: 400, json: { statusCode: '404', error: 'not_found', message: 'Object not found' } };
        }
      }
      if (r.method === 'DELETE' && r.path === '/storage/v1/object/documents') {
        for (const name of r.json().prefixes) objects.delete(name);
        return { json: [] };
      }
      return null;
    });
    try {
      const client = createClient(fake.url, TEST_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const api = makeApi(client, WS);

      assert.equal((await api.loadWorkspace()).name, 'SAMPLE Exports');

      const rows = await api.listRecords();
      assert.deepEqual(rows.map((row) => `${row.collection}/${row.id}`), ['activity/a1', 'activity/a2', 'activity/a3', 'documents/d1']);
      const pages = fake.find('POST', '/rest/v1/rpc/list_records').map((r) => r.json());
      assert.equal(pages.length, 3, 'keeps asking until an empty page, even when pages come back short');
      assert.deepEqual(pages[1], { p_workspace: WS, p_after_collection: 'activity', p_after_id: 'a2', p_limit: 1000 });

      const saved = await api.upsertRecords([recordToRow(WS, 'documents', { id: 'd9', fileName: 'SAMPLE.pdf' })]);
      assert.deepEqual(saved, [{ collection: 'documents', id: 'd9', rev: 7, updated_at: '2026-11-15T10:00:00.123456+00:00' }]);
      const upsert = fake.find('POST', '/rest/v1/records').at(-1);
      assert.equal(upsert.query.on_conflict, 'workspace_id,collection,id');
      assert.match(upsert.headers.prefer, /resolution=merge-duplicates/);
      assert.match(upsert.headers.prefer, /return=representation/);
      assert.deepEqual(upsert.json()[0], { workspace_id: WS, collection: 'documents', id: 'd9', data: { id: 'd9', fileName: 'SAMPLE.pdf' } });

      await assert.rejects(api.upsertRecords([recordToRow(WS, 'locked', { id: 'l1' })]), (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, '42501');
        assert.equal(err.retryable, false);
        return true;
      });

      await api.deleteRecord('documents', 'd1');
      const del = fake.find('DELETE', '/rest/v1/records').at(-1);
      assert.deepEqual([del.query.workspace_id, del.query.collection, del.query.id], [`eq.${WS}`, 'eq.documents', 'eq.d1']);

      assert.equal(await api.getRecord('documents', 'nope'), null);
      const updated = await api.updateWorkspace({ autopilot: false });
      assert.equal(updated.rev, 5);
      assert.equal(updated.data.autopilot, false);

      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]);
      await api.uploadFile('docs/d1/SAMPLE invoice.pdf', pdf, 'application/pdf');
      const stored = objects.get(`${WS}/docs/d1/SAMPLE invoice.pdf`);
      assert.equal(stored.mime, 'application/pdf');
      assert.equal(stored.upsert, 'true');
      assert.deepEqual([...(await api.downloadFile('docs/d1/SAMPLE invoice.pdf'))], [...pdf]);
      await assert.rejects(api.downloadFile('docs/none/missing.pdf'), (err) => err.code === 'ENOENT' && err.retryable === false);
      await api.removeFile('docs/d1/SAMPLE invoice.pdf');
      assert.equal(objects.size, 0);

      // Nothing listening: fails fast and is worth retrying later.
      const deadApi = makeApi(createClient('http://127.0.0.1:9', TEST_KEY, { auth: { persistSession: false, autoRefreshToken: false } }), WS);
      const started = Date.now();
      await assert.rejects(deadApi.loadWorkspace(), (err) => err.retryable === true);
      assert.ok(Date.now() - started < 3000, 'no built-in retries on reads');
    } finally {
      await fake.close();
    }
  });

  test('createCloud: sign-up, sign-in, houses, invites, members, lease, sign-out', async () => {
    const USER = '44444444-4444-4444-8444-444444444444';
    const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const accessToken = [
      base64url({ alg: 'HS256', typ: 'JWT' }),
      base64url({ sub: USER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }),
      base64url('signature'),
    ].join('.');
    const session = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'sample-refresh',
      user: { id: USER, email: 'clerk@sample.example', aud: 'authenticated', role: 'authenticated', user_metadata: { name: 'SAMPLE Clerk' } },
    };
    const fake = await startFakeHttp((r) => {
      if (r.method === 'POST' && r.path === '/functions/v1/signup') {
        const body = r.json();
        if (body.email === 'taken@sample.example') {
          return { status: 409, json: { ok: false, error: 'An account with this email already exists. Sign in instead.' } };
        }
        return { json: { ok: true, workspaceId: WS } };
      }
      if (r.method === 'POST' && r.path === '/auth/v1/token') {
        return r.json().password === 'a long sample password'
          ? { json: session }
          : { status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
      }
      if (r.method === 'POST' && r.path === '/auth/v1/logout') return { status: 204 };
      if (r.method === 'GET' && r.path === '/rest/v1/profiles') return { json: [{ name: 'SAMPLE Clerk', is_desk: true, is_test: false }] };
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/list_my_workspaces') {
        return { json: [{ id: WS, name: 'SAMPLE Exports', environment: 'sandbox', data: { city: 'Surat' }, rev: 2, created_by: null, created_at: '2026-11-01T00:00:00+00:00', my_role: 'preparer' }] };
      }
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/join_with_code') return { json: { id: null, name: null, environment: null, data: null } };
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/create_invite') return { json: 'ABCDEFGH' };
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/create_house') {
        const { p_payload } = r.json();
        return { json: { id: OTHER_WS, name: p_payload.name, environment: 'sandbox', data: p_payload, rev: 1, created_by: USER, created_at: '2026-11-15T00:00:00+00:00' } };
      }
      if (r.method === 'GET' && r.path === '/rest/v1/members') {
        return { json: [{ user_id: USER, email: 'clerk@sample.example', name: 'SAMPLE Clerk', role: 'preparer', created_at: '2026-11-02T00:00:00+00:00' }] };
      }
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/acquire_lease') return { json: true };
      if (r.method === 'POST' && r.path === '/rest/v1/rpc/release_lease') return { status: 204 };
      return null;
    });
    const saved = new Map();
    const sessionStorage = {
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => saved.set(key, value),
      removeItem: async (key) => saved.delete(key),
    };
    const cloud = createCloud({ url: `${fake.url}/`, anonKey: TEST_KEY, sessionStorage });
    try {
      assert.equal(cloud.aiProxyUrl, `${fake.url}/functions/v1/ai`);
      assert.equal(await cloud.auth.session(), null);

      await assert.rejects(
        cloud.auth.signUp({ email: 'taken@sample.example', password: 'a long sample password', name: 'SAMPLE Clerk' }),
        /already exists/,
      );
      const signedUp = await cloud.auth.signUp({ email: 'clerk@sample.example', password: 'a long sample password', name: 'SAMPLE Clerk' });
      assert.deepEqual(signedUp.user, { id: USER, email: 'clerk@sample.example', name: 'SAMPLE Clerk' });
      assert.equal(signedUp.isDesk, true);
      assert.equal(signedUp.workspaceId, WS);
      const signupBody = fake.find('POST', '/functions/v1/signup').at(-1).json();
      assert.deepEqual(Object.keys(signupBody).sort(), ['email', 'name', 'password'], 'empty invite code and house name are not sent');
      assert.ok(saved.has('jl-auth'), 'the sign-in is kept in the given storage');
      assert.equal((await cloud.auth.session()).user.id, USER);
      assert.equal(await cloud.accessToken(), accessToken);

      const houses = await cloud.workspaces.list();
      assert.equal(houses.length, 1);
      assert.equal(houses[0].myRole, 'preparer');
      assert.equal(houses[0].city, 'Surat');
      assert.equal(fake.find('POST', '/rest/v1/rpc/list_my_workspaces').at(-1).headers.authorization, `Bearer ${accessToken}`);

      await assert.rejects(cloud.workspaces.join('ZZZZ-ZZZZ'), /not valid or has expired/);
      assert.deepEqual(await cloud.workspaces.invite(WS), { code: 'ABCDEFGH' });
      assert.deepEqual(fake.find('POST', '/rest/v1/rpc/create_invite').at(-1).json(), { p_workspace: WS, p_role: 'preparer' });

      const created = await cloud.workspaces.create({ name: 'SAMPLE New House', city: 'Surat' });
      assert.equal(created.myRole, 'owner');
      assert.equal(created.name, 'SAMPLE New House');
      const payload = fake.find('POST', '/rest/v1/rpc/create_house').at(-1).json().p_payload;
      assert.ok(!('id' in payload) && payload.autopilot === true && payload.city === 'Surat');

      assert.deepEqual(await cloud.workspaces.members(WS), [
        { userId: USER, email: 'clerk@sample.example', name: 'SAMPLE Clerk', role: 'preparer', createdAt: '2026-11-02T00:00:00+00:00' },
      ]);
      assert.equal(await cloud.lease.acquire(WS, 'mac-1', 60), true);
      assert.deepEqual(fake.find('POST', '/rest/v1/rpc/acquire_lease').at(-1).json(), { p_workspace: WS, p_holder: 'mac-1', p_ttl_seconds: 60 });
      await cloud.lease.release(WS, 'mac-1');

      await assert.rejects(cloud.auth.signIn({ email: 'clerk@sample.example', password: 'wrong password' }), /Wrong email or password/);
      await cloud.auth.signOut();
      assert.equal(await cloud.auth.session(), null);
      assert.ok(!saved.has('jl-auth'));
    } finally {
      await cloud.close();
      await fake.close();
    }
  });
});
