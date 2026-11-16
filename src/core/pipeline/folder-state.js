// The watched folder and the mailbox belong to one computer, not to the shared workspace: a folder on this Mac
// means nothing on a colleague's Windows PC, and each person connects their own mailbox on their own computer.
// Their settings and progress (files already picked up, the last message looked at) live in small JSON files here.
// With no local folder (tests), the state is kept in memory only.
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The watched folder: { path, seen: { [file]: stamp }, inFlight: { [file]: stamp }, lastScanAt }. inFlight is the file
 * being added right now; one still there at the next start stopped the app, and is not added again.
 */
export function createFolderState(dir, workspaceId) {
  return createLocalState(dir, `watched-folder-${workspaceId}.json`, { path: null, seen: {}, inFlight: {}, lastScanAt: null });
}

/**
 * The mailbox connected on this computer and how far the agents got in it:
 * { email, provider, host, since, domains, connected, uidValidity, lastUid, lastSeenAt, lastPollAt, seen, inFlight }.
 * inFlight holds the id of the email being added right now (see createFolderState).
 */
export function createMailboxState(dir, workspaceId) {
  return createLocalState(dir, `mailbox-${workspaceId}.json`, { email: null, connected: false, seen: [] });
}

function createLocalState(dir, fileName, initial) {
  const file = dir ? path.join(dir, fileName) : null;
  let state = { ...initial };
  let loaded = false;

  async function load() {
    if (loaded) return state;
    loaded = true;
    if (!file) return state;
    try {
      state = { ...state, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch {
      // no file yet (first time), or a damaged one: start fresh, the SHA-256 check still stops duplicates
    }
    return state;
  }

  async function save() {
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state));
    await fs.rename(temp, file); // write then rename, so a crash never leaves half a file
  }

  return {
    load,
    save,
    get: () => state,
    set(patch) { state = { ...state, ...patch }; },
    replace(next) { state = { ...initial, ...next }; },
  };
}
