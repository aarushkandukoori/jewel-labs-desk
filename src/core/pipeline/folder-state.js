// The watched folder belongs to one computer, not to the shared workspace: a folder on this Mac means nothing
// on a colleague's Windows PC. Its path and the files already picked up live in a small JSON file here.
// With no local folder (tests), the state is kept in memory only.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFolderState(dir, workspaceId) {
  const file = dir ? path.join(dir, `watched-folder-${workspaceId}.json`) : null;
  let state = { path: null, seen: {}, lastScanAt: null };
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
  };
}
