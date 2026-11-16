// Cloud store: the same Store interface as local.js, shared through Supabase by everyone in the house.
//
// How it works, in four parts:
// 1. Cache. Every record is kept in memory (instant reads) and saved under cacheDir/<workspaceId>/ in the same
//    layout as a local workspace, so the house still opens when the internet is down.
// 2. Outbox. Each local change is queued in order. A sender pushes the queue to Supabase (records in batches) and,
//    while the network is down, retries with a growing wait. The queue is saved to disk, so changes made offline
//    survive a restart.
// 3. Realtime. Changes made on other computers arrive through a Supabase Realtime subscription. The database bumps
//    a revision number (rev) on every save of a row, so an older or repeated change, like the echo of our own
//    save, is ignored.
// 4. Reload. On open and after every reconnect the store reads the whole house again and reconciles.
//
// The `api` object (makeApi in cloud-api.js) is the only code that talks to Supabase. Tests pass a fake one.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createJsonFolder,
  fileNotFound,
  readFileOrNull,
  removeTempFiles,
  savedCollectionNames,
  writeFileAtomic,
} from './disk.js';
import { makeApi } from './cloud-api.js';
import {
  friendlyMessage,
  isRetryableError,
  recordToRow,
  rowToRecord,
  workspaceFromRow,
  workspacePatchForServer,
} from './rows.js';
import {
  applyWorkspacePatch,
  checkCollection,
  checkFileKey,
  checkWorkspaceId,
  copy,
  encodeFileKey,
  isCollectionName,
  matches,
  normalizeWorkspace,
  recordId,
  sameJson,
  sortRecords,
  stampRecord,
  toBytes,
} from './shared.js';

const BATCH_ROWS = 100; // records per upsert request
const BATCH_BYTES = 1_000_000; // and roughly this much JSON per request
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const REALTIME_WAIT_MS = 10000; // how long open() waits for the live connection before loading anyway
const CLOSE_WAIT_MS = 3000; // how long close() gives the outbox to reach the server

/**
 * openCloudStore({ cloud, workspaceId, cacheDir }) -> Store (same interface as openLocalStore).
 * cacheDir: a folder for this app's cloud cache; the house is kept in cacheDir/<workspaceId>/.
 * Extra: store.syncStatus(), store.flush(), store.removeFile(key), and 'sync' events
 * ({ kind, online, realtime, pending, lastError, lastErrorAt, lastSyncedAt }) besides 'change' events
 * (with remote: true for changes from other computers). The other options are for tests.
 */
export async function openCloudStore({
  cloud,
  workspaceId,
  cacheDir,
  api,
  flushDelayMs,
  retryDelaysMs = RETRY_DELAYS_MS,
  realtimeWaitMs = REALTIME_WAIT_MS,
} = {}) {
  checkWorkspaceId(workspaceId);
  if (!cacheDir) throw new Error('openCloudStore needs a cacheDir');
  if (!api && !cloud?.client) throw new Error('openCloudStore needs a signed-in cloud (from createCloud)');
  const server = api || makeApi(cloud.client, workspaceId);
  const root = path.join(cacheDir, workspaceId);

  let settings = null; // the workspace (house settings)
  let settingsRev = 0;
  const collections = new Map(); // collection name -> Map(id -> record)
  const versions = new Map(); // "collection/id" -> { rev, at } of the row we last saw from the server
  const outbox = new Map(); // key -> change waiting to be sent, oldest first
  const doubt = new Set(); // keys that changed on the server while our own change was on its way
  const touched = new Map(); // key -> number of our latest local change to it (used by reload)
  let changeCount = 0;
  let entryCount = 0;
  let closed = false;
  let sending = null; // the running send, if any
  let sendScheduled = false;
  let retryTimer = null;
  let retryCount = 0;
  let loading = false; // a full reload is running: hold realtime events until it ends
  let held = [];
  let reloading = null;
  let reloadAgain = false;
  let loadedOnce = false;
  let everLive = false;
  let subscription = null;
  let lastSignature = '';
  let errorIsNetwork = false;
  const status = { online: true, realtime: 'connecting', lastError: null, lastErrorAt: null, lastSyncedAt: null };
  const events = new EventEmitter();
  events.setMaxListeners(100);

  const folder = createJsonFolder(root, { delayMs: flushDelayMs, snapshot });

  function snapshot(name) {
    if (name === 'workspace') return JSON.stringify(settings, null, 2);
    if (name === '_sync') {
      return JSON.stringify({
        workspaceRev: settingsRev,
        versions: Object.fromEntries(versions),
        outbox: [...outbox.values()].map(({ seq, ...entry }) => entry),
      });
    }
    return JSON.stringify(Object.fromEntries(collections.get(name) || []));
  }

  // ---------- small helpers ----------

  const keyOf = (collection, id) => `${collection}/${id}`;
  const entryKey = (entry) => (entry.fileKey ? `file:${entry.fileKey}` : keyOf(entry.collection, entry.id));
  const cachedFile = (fileKey) => path.join(root, 'files', ...encodeFileKey(fileKey).split('/'));

  function ensureOpen() {
    if (closed) throw new Error('This store is closed');
  }

  function tableFor(collection) {
    let records = collections.get(collection);
    if (!records) {
      records = new Map();
      collections.set(collection, records);
    }
    return records;
  }

  function emitChange(collection, id, op, value, remote) {
    if (events.listenerCount('change') === 0) return;
    try {
      events.emit('change', { collection, id, op, value: copy(value), remote });
    } catch (err) {
      console.error('[store] a change listener failed:', err);
    }
  }

  function syncStatus() {
    return { kind: 'cloud', ...status, pending: outbox.size };
  }

  // 'sync' events only when something people would notice changes (not on every single save).
  function emitSync() {
    const now = syncStatus();
    const signature = [now.online, now.realtime, now.pending > 0, now.lastError].join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;
    try {
      events.emit('sync', now);
    } catch (err) {
      console.error('[store] a sync listener failed:', err);
    }
  }

  // ---------- 1. cache on disk ----------

  async function loadCache() {
    await removeTempFiles(root);
    const saved = await folder.read('workspace');
    if (saved) settings = normalizeWorkspace({ ...saved, id: workspaceId });
    const sync = (await folder.read('_sync')) || {};
    settingsRev = Number(sync.workspaceRev) || 0;
    for (const [key, version] of Object.entries(sync.versions || {})) versions.set(key, version);
    for (const entry of sync.outbox || []) outbox.set(entryKey(entry), { ...entry, seq: ++entryCount });
    for (const name of await savedCollectionNames(root)) {
      collections.set(name, new Map(Object.entries((await folder.read(name)) || {})));
    }
    return Boolean(saved);
  }

  // ---------- applying what the server says ----------

  function applyRow(row) {
    const record = rowToRecord(row);
    tableFor(row.collection).set(record.id, record);
    versions.set(keyOf(row.collection, record.id), { rev: Number(row.rev), at: row.updated_at });
    folder.markDirty(row.collection);
    folder.markDirty('_sync');
    emitChange(row.collection, record.id, 'put', record, true);
  }

  function applyRemoval(collection, id) {
    if (versions.delete(keyOf(collection, id))) folder.markDirty('_sync');
    const records = collections.get(collection);
    const before = records?.get(id);
    if (!before) return;
    records.delete(id);
    folder.markDirty(collection);
    emitChange(collection, id, 'remove', before, true);
  }

  function applyWorkspaceRow(row, { force = false } = {}) {
    if (!row || row.id !== workspaceId) return;
    if (!force && Number(row.rev) <= settingsRev) return; // old news, or the echo of our own change
    settingsRev = Number(row.rev) || 0;
    folder.markDirty('_sync');
    const next = workspaceFromRow(row);
    if (settings && sameJson(next, settings)) return;
    settings = next;
    folder.markDirty('workspace');
    emitChange('workspace', workspaceId, 'put', settings, true);
  }

  /** Asks the server for one row and takes it as the truth (unless something newer already arrived). */
  async function refetch(collection, id, { force = false } = {}) {
    const key = keyOf(collection, id);
    const before = versions.get(key);
    let row;
    try {
      row = await server.getRecord(collection, id);
    } catch {
      return; // offline: the next reload catches up
    }
    if (closed || outbox.has(key)) return; // a newer local change is on its way
    const now = versions.get(key);
    if (row) {
      if (force || !now || Number(row.rev) > now.rev || !collections.get(collection)?.has(id)) applyRow(row);
    } else if (force || now === before) {
      applyRemoval(collection, id);
    }
  }

  // ---------- 3. realtime ----------

  function onEvent(event) {
    if (closed) return;
    if (loading) {
      held.push(event); // decide after the reload, which may already include this change
      return;
    }
    handleEvent(event);
  }

  function handleEvent(event) {
    if (event.kind === 'workspace') {
      applyWorkspaceRow(event.row);
      return;
    }
    const { type, row, incomplete } = event;
    // Deletes from every house reach every listener (Realtime cannot filter them), so check the house here.
    if (!row || row.workspace_id !== workspaceId || !isCollectionName(row.collection)) return;
    const key = keyOf(row.collection, String(row.id));
    if (outbox.has(key)) {
      doubt.add(key); // our own change to this record is on its way: check the server once it lands
      return;
    }
    if (type === 'remove') {
      applyRemoval(row.collection, String(row.id));
      return;
    }
    const known = versions.get(key);
    if (known && Number(row.rev) <= known.rev) return; // old news, or the echo of our own save
    if (incomplete) {
      refetch(row.collection, String(row.id)); // too big for Realtime: fetch the whole row
      return;
    }
    applyRow(row);
  }

  function startRealtime() {
    return new Promise((resolve) => {
      let ready = false;
      const finish = () => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, realtimeWaitMs);
      subscription = server.subscribe({
        onRecord: (event) => onEvent({ kind: 'record', ...event }),
        onWorkspace: (row) => onEvent({ kind: 'workspace', row }),
        onStatus: (state, err) => {
          if (closed) return;
          if (state === 'SUBSCRIBED') {
            status.realtime = 'live';
            // Subscribed again after a drop, or later than open() waited: we may have missed changes.
            if (everLive || ready) reloadInBackground();
            everLive = true;
          } else {
            status.realtime = state === 'CLOSED' ? 'off' : 'reconnecting';
            if (err) console.error(`[store] realtime ${state}:`, err.message || err);
          }
          emitSync();
          finish();
        },
      });
    });
  }

  // ---------- 4. reload ----------

  async function loadFromServer() {
    loading = true;
    const startedAt = changeCount;
    try {
      const row = await server.loadWorkspace();
      if (!row) {
        throw Object.assign(new Error('This house was not found, or you are no longer a member.'), {
          code: 'NOT_FOUND',
          status: 404,
          retryable: false,
        });
      }
      const rows = await server.listRecords();
      applyWorkspaceRow(row, { force: true });
      reconcile(rows, startedAt);
      loadedOnce = true;
    } finally {
      loading = false;
      const waiting = held;
      held = [];
      for (const event of waiting) handleEvent(event);
    }
  }

  /** Makes the cache match the server, except records changed here that the server has not seen yet. */
  function reconcile(rows, startedAt) {
    const busy = (key) => outbox.has(key) || (touched.get(key) || 0) > startedAt;
    const onServer = new Set();
    for (const row of rows) {
      if (!isCollectionName(row.collection)) continue;
      const id = String(row.id);
      const key = keyOf(row.collection, id);
      onServer.add(key);
      if (busy(key)) continue;
      const known = versions.get(key);
      const unchanged = known && known.rev === Number(row.rev) && known.at === row.updated_at;
      if (unchanged && collections.get(row.collection)?.has(id)) continue;
      applyRow(row);
    }
    for (const [collection, records] of collections) {
      for (const id of [...records.keys()]) {
        const key = keyOf(collection, id);
        if (!onServer.has(key) && !busy(key)) applyRemoval(collection, id);
      }
    }
  }

  /** Reloads the house. Only one reload runs at a time; asking during one makes it run once more at the end. */
  function reload() {
    if (closed) return Promise.resolve();
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    reloading = (async () => {
      try {
        do {
          reloadAgain = false;
          await loadFromServer();
        } while (reloadAgain && !closed);
        markOnline();
      } catch (err) {
        if (isRetryableError(err)) markOffline(err);
        else reportError(err);
        throw err;
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  }

  // The problem is already in status (and the 'sync' event), so background reloads need not throw.
  const reloadInBackground = () => reload().catch(() => {});

  // ---------- 2. outbox ----------

  function queue(entry) {
    const key = entryKey(entry);
    outbox.delete(key); // a newer change replaces an older one and goes to the back of the line
    outbox.set(key, { ...entry, seq: ++entryCount });
    touched.set(key, ++changeCount);
    folder.markDirty('_sync');
    emitSync();
    sendSoon();
  }

  function sendSoon() {
    if (sendScheduled || sending || retryTimer || closed) return;
    sendScheduled = true;
    // Wait one turn so many saves made together go out in one request.
    setImmediate(() => {
      sendScheduled = false;
      sendNow();
    });
  }

  function sendNow() {
    if (closed) return Promise.resolve();
    if (!sending) {
      sending = drain().finally(() => {
        sending = null;
        emitSync();
      });
    }
    return sending;
  }

  async function drain() {
    while (!closed && outbox.size > 0) {
      const ok = await sendBatch(nextBatch());
      if (!ok) return; // network trouble: a retry is scheduled
    }
  }

  /** The next request: a run of record saves (up to BATCH_ROWS / BATCH_BYTES), or one other change. */
  function nextBatch() {
    const batch = [];
    let bytes = 0;
    for (const [key, entry] of outbox) {
      if (entry.op !== 'put') {
        if (batch.length === 0) batch.push({ key, entry });
        break;
      }
      const record = collections.get(entry.collection)?.get(entry.id);
      if (!record) {
        if (batch.length === 0) batch.push({ key, entry, row: null });
        break;
      }
      const row = recordToRow(workspaceId, entry.collection, record);
      const size = JSON.stringify(row.data).length;
      if (batch.length > 0 && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) break;
      batch.push({ key, entry, row });
      bytes += size;
    }
    return batch;
  }

  async function sendBatch(batch) {
    try {
      await sendToServer(batch);
      if (markOnline()) reloadInBackground(); // back online: catch up on what we missed
      return true;
    } catch (err) {
      if (isRetryableError(err)) {
        markOffline(err);
        return false;
      }
      if (batch.length > 1) {
        // One bad row fails the whole request. Send them one by one so only the bad one is dropped.
        for (const item of batch) {
          if (!(await sendBatch([item]))) return false;
        }
        return true;
      }
      drop(batch[0], err);
      return true;
    }
  }

  async function sendToServer(batch) {
    const { entry } = batch[0];
    if (entry.op === 'put') {
      const rows = batch.filter((item) => item.row).map((item) => item.row);
      const saved = rows.length ? await server.upsertRecords(rows) : [];
      const byKey = new Map((saved || []).map((row) => [keyOf(row.collection, String(row.id)), row]));
      for (const item of batch) done(item, byKey.get(item.key));
    } else if (entry.op === 'remove') {
      await server.deleteRecord(entry.collection, entry.id);
      done(batch[0]);
    } else if (entry.op === 'putFile') {
      const bytes = await readFileOrNull(cachedFile(entry.fileKey));
      if (bytes) await server.uploadFile(entry.fileKey, new Uint8Array(bytes), entry.mime);
      done(batch[0]);
    } else if (entry.op === 'removeFile') {
      await server.removeFile(entry.fileKey);
      done(batch[0]);
    }
  }

  /** A change reached the server. */
  function done({ key, entry }, savedRow) {
    if (outbox.get(key)?.seq === entry.seq) outbox.delete(key);
    if (entry.op === 'put' && savedRow) {
      const known = versions.get(key);
      if (!known || Number(savedRow.rev) > known.rev) versions.set(key, { rev: Number(savedRow.rev), at: savedRow.updated_at });
    }
    if (entry.op === 'remove') versions.delete(key);
    folder.markDirty('_sync');
    // Someone else changed this record while ours was on its way: ask the server who won.
    if (!outbox.has(key) && doubt.delete(key)) refetch(entry.collection, entry.id);
  }

  /** The server refused a change for good (no permission, bad data). Drop it and show the server's version. */
  function drop({ key, entry }, err) {
    if (outbox.get(key)?.seq === entry.seq) outbox.delete(key);
    doubt.delete(key); // the forced refetch below takes the server's version anyway
    folder.markDirty('_sync');
    const what = entry.fileKey ? `file ${entry.fileKey}` : `${entry.collection} ${entry.id}`;
    console.error(`[store] the cloud refused a change (${what}):`, err.message);
    setError(`A change could not be saved to the cloud (${what}). ${friendlyMessage(err)}`, false);
    emitSync();
    if (!entry.fileKey) refetch(entry.collection, entry.id, { force: true });
  }

  function setError(message, isNetwork) {
    status.lastError = message;
    status.lastErrorAt = message ? new Date().toISOString() : null;
    errorIsNetwork = isNetwork;
  }

  /** Returns true when we were offline until now. */
  function markOnline() {
    const wasOffline = !status.online;
    status.online = true;
    status.lastSyncedAt = new Date().toISOString();
    if (errorIsNetwork) setError(null, false); // a refused change stays visible; a network problem is over
    retryCount = 0;
    emitSync();
    return wasOffline;
  }

  function markOffline(err) {
    status.online = false;
    setError(friendlyMessage(err), true);
    emitSync();
    scheduleRetry();
  }

  function reportError(err) {
    console.error('[store] cloud sync problem:', err.message);
    setError(friendlyMessage(err), false);
    emitSync();
  }

  function scheduleRetry() {
    if (retryTimer || closed) return;
    const wait = retryDelaysMs[Math.min(retryCount, retryDelaysMs.length - 1)];
    retryCount += 1;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (closed) return;
      await reloadInBackground(); // catches up, and tells us whether the server answers again
      if (status.online && outbox.size > 0) sendNow();
    }, wait);
  }

  // ---------- open ----------

  const hadCache = await loadCache();
  await startRealtime();
  try {
    await reload();
  } catch (err) {
    // Offline with a saved copy: open from it and catch up when the network is back (a retry is scheduled).
    if (!(loadedOnce || (hadCache && isRetryableError(err)))) {
      closed = true;
      clearTimeout(retryTimer);
      subscription?.close();
      throw Object.assign(new Error(friendlyMessage(err)), { code: err.code, status: err.status, cause: err });
    }
  }
  sendSoon();

  // ---------- the Store ----------

  return Object.assign(events, {
    kind: 'cloud',
    workspaceId,
    dir: root,
    problems: folder.problems,

    async workspace() {
      ensureOpen();
      return copy(settings);
    },

    /** Saves house settings on the server first (needs the network), then here. */
    async updateWorkspace(patch) {
      ensureOpen();
      const merged = applyWorkspacePatch(settings, patch);
      let row;
      try {
        row = await server.updateWorkspace(workspacePatchForServer(merged, patch));
      } catch (err) {
        throw Object.assign(new Error(`Could not save the house settings. ${friendlyMessage(err)}`), { cause: err });
      }
      if (Number(row?.rev) >= settingsRev) applyWorkspaceRow(row, { force: true });
      return copy(settings);
    },

    async list(collection, filter) {
      ensureOpen();
      checkCollection(collection);
      const records = collections.get(collection);
      if (!records) return [];
      const found = [];
      for (const record of records.values()) {
        if (matches(record, filter)) found.push(copy(record));
      }
      return sortRecords(found);
    },

    async get(collection, id) {
      ensureOpen();
      checkCollection(collection);
      const record = collections.get(collection)?.get(String(id));
      return record ? copy(record) : null;
    },

    async put(collection, obj) {
      ensureOpen();
      checkCollection(collection);
      const records = tableFor(collection);
      const id = recordId(obj);
      const record = stampRecord(obj, id, records.get(id), workspaceId);
      records.set(id, record);
      folder.markDirty(collection);
      queue({ op: 'put', collection, id });
      emitChange(collection, id, 'put', record, false);
      return copy(record);
    },

    async remove(collection, id) {
      ensureOpen();
      checkCollection(collection);
      const records = collections.get(collection);
      const before = records?.get(String(id));
      if (!before) return;
      records.delete(String(id));
      folder.markDirty(collection);
      queue({ op: 'remove', collection, id: String(id) });
      emitChange(collection, String(id), 'remove', before, false);
    },

    /** Saves the file here at once and uploads it in the background (before any record saved after it). */
    async putFile(key, bytes, mime) {
      ensureOpen();
      checkFileKey(key);
      await writeFileAtomic(cachedFile(key), toBytes(bytes));
      queue({ op: 'putFile', fileKey: key, mime: mime || 'application/octet-stream' });
      await folder.flush(); // the upload must survive a crash
      return key;
    },

    /** From the cache, or downloaded once and cached. */
    async getFile(key) {
      ensureOpen();
      checkFileKey(key);
      const local = await readFileOrNull(cachedFile(key));
      if (local) return new Uint8Array(local);
      let bytes;
      try {
        bytes = await server.downloadFile(key);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw fileNotFound(key, `This file is not in the cloud yet: ${key}. It appears once the computer that added it is online.`);
        }
        throw Object.assign(new Error(`Could not download ${key}. ${friendlyMessage(err)}`), { cause: err });
      }
      await writeFileAtomic(cachedFile(key), bytes);
      return new Uint8Array(bytes);
    },

    async removeFile(key) {
      ensureOpen();
      checkFileKey(key);
      await fs.rm(cachedFile(key), { force: true });
      queue({ op: 'removeFile', fileKey: key });
    },

    syncStatus,

    /** Sends the outbox now (one attempt) and saves the cache to disk. */
    async flush() {
      ensureOpen();
      await sendNow();
      await folder.flush();
    },

    async close() {
      if (closed) return;
      await withTimeout(sendNow(), CLOSE_WAIT_MS); // last chance for the outbox to reach the server
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      subscription?.close();
      await folder.close(); // whatever is still waiting is saved and sent next time
      events.removeAllListeners();
    },
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
