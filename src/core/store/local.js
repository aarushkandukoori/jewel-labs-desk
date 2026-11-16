// Local store: one workspace kept in JSON files on this computer. No account or network needed.
//
// Layout:  <dir>/workspaces/<workspaceId>/workspace.json      the house settings
//                                        /<collection>.json     one object keyed by record id
//                                        /files/<key>           originals and generated PDFs
//
// Every record is held in memory, so reads are instant. A change updates memory at once and is written
// to disk in the background (a moment later, atomically), and always before close() returns.
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
import {
  applyWorkspacePatch,
  checkCollection,
  checkWorkspaceId,
  copy,
  encodeFileKey,
  isWorkspaceId,
  matches,
  newWorkspace,
  normalizeWorkspace,
  recordId,
  sortRecords,
  stampRecord,
  toBytes,
} from './shared.js';

/** The folder of one local workspace. */
export function workspaceDir(dir, workspaceId) {
  if (!dir) throw new Error('A data folder (dir) is required');
  return path.join(dir, 'workspaces', checkWorkspaceId(workspaceId));
}

/** Creates <dir>/workspaces/<id>/workspace.json from the onboarding profile and returns the workspace. */
export async function createLocalWorkspace({ dir, profile = {} } = {}) {
  const workspace = newWorkspace(profile);
  const file = path.join(workspaceDir(dir, workspace.id), 'workspace.json');
  if (await readFileOrNull(file)) throw new Error(`A workspace with id ${workspace.id} already exists`);
  await writeFileAtomic(file, JSON.stringify(workspace, null, 2));
  return workspace;
}

/** Every local workspace under dir, oldest first. Folders without a readable workspace.json are skipped. */
export async function listLocalWorkspaces({ dir } = {}) {
  let names;
  try {
    names = await fs.readdir(path.join(dir, 'workspaces'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const workspaces = [];
  for (const name of names.filter(isWorkspaceId)) {
    const bytes = await readFileOrNull(path.join(dir, 'workspaces', name, 'workspace.json'));
    if (!bytes) continue;
    try {
      workspaces.push(normalizeWorkspace({ ...JSON.parse(bytes.toString('utf8')), id: name }));
    } catch {
      console.error(`[store] skipped workspace ${name}: workspace.json could not be read`);
    }
  }
  return sortRecords(workspaces);
}

/** Opens one local workspace. See docs/ARCHITECTURE.md for the Store interface. */
export async function openLocalStore({ dir, workspaceId, flushDelayMs } = {}) {
  const root = workspaceDir(dir, workspaceId);
  const collections = new Map(); // collection name -> Map(id -> record)
  let settings = null; // the workspace (house settings)
  let closed = false;

  const folder = createJsonFolder(root, {
    delayMs: flushDelayMs,
    snapshot: (name) =>
      name === 'workspace'
        ? JSON.stringify(settings, null, 2)
        : JSON.stringify(Object.fromEntries(collections.get(name) || [])),
  });

  // Load everything from disk.
  await removeTempFiles(root);
  const saved = await folder.read('workspace');
  if (!saved) throw new Error(`No local workspace found at ${root}`);
  settings = normalizeWorkspace({ ...saved, id: workspaceId });
  for (const name of await savedCollectionNames(root)) {
    const records = (await folder.read(name)) || {};
    collections.set(name, new Map(Object.entries(records)));
  }

  const events = new EventEmitter();
  events.setMaxListeners(100);

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

  function filePath(key) {
    return path.join(root, 'files', ...encodeFileKey(key).split('/'));
  }

  function emitChange(collection, id, op, value) {
    if (events.listenerCount('change') === 0) return;
    try {
      events.emit('change', { collection, id, op, value: copy(value), remote: false });
    } catch (err) {
      // A broken listener must not break the save that already happened.
      console.error('[store] a change listener failed:', err);
    }
  }

  return Object.assign(events, {
    kind: 'local',
    workspaceId,
    dir: root,
    problems: folder.problems,

    async workspace() {
      ensureOpen();
      return copy(settings);
    },

    async updateWorkspace(patch) {
      ensureOpen();
      settings = applyWorkspacePatch(settings, patch);
      folder.markDirty('workspace');
      await folder.flush(); // settings are rare and important: save them right away
      emitChange('workspace', workspaceId, 'put', settings);
      return copy(settings);
    },

    /** Records of a collection, oldest first. filter: (record) => boolean, or { field: value }. */
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

    /** Saves the whole record (replaces the old one with the same id). */
    async put(collection, obj) {
      ensureOpen();
      checkCollection(collection);
      const records = tableFor(collection);
      const id = recordId(obj);
      const record = stampRecord(obj, id, records.get(id), workspaceId);
      records.set(id, record);
      folder.markDirty(collection);
      emitChange(collection, id, 'put', record);
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
      emitChange(collection, String(id), 'remove', before);
    },

    async putFile(key, bytes, mime) {
      ensureOpen();
      await writeFileAtomic(filePath(key), toBytes(bytes));
      return key;
    },

    async getFile(key) {
      ensureOpen();
      const bytes = await readFileOrNull(filePath(key));
      if (!bytes) throw fileNotFound(key);
      return new Uint8Array(bytes); // a plain Uint8Array copy: pdf.js refuses Node Buffers
    },

    async removeFile(key) {
      ensureOpen();
      await fs.rm(filePath(key), { force: true });
    },

    syncStatus() {
      return { kind: 'local', online: true, realtime: 'off', pending: 0, lastError: null, lastErrorAt: null, lastSyncedAt: null };
    },

    /** Writes every pending change to disk now. */
    async flush() {
      ensureOpen();
      await folder.flush();
    },

    async close() {
      if (closed) return;
      closed = true;
      await folder.close();
      events.removeAllListeners();
    },
  });
}
