// Plain settings in userData/settings.json. Nothing secret goes here: keys and passwords live in
// secrets.js. Per-workspace settings (watched folder, mailbox address) sit under `workspaces[id]`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SETTINGS = {
  autopilot: true, // the agents work on their own as papers arrive
  notifications: true,
  launchAtLogin: false,
  model: null, // null = the AI module's default model
  workspaces: {},
  prefs: {}, // small things the screens remember (last view, collapsed panels ...)
};

export function createSettings({ file }) {
  let data = null;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {}; // first start, or a damaged file: start from the defaults
    }
  }

  // Write to a temp file first, then rename, so a crash never leaves half a file.
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function get() {
    if (!data) {
      data = { ...DEFAULT_SETTINGS, ...load() };
      if (!data.deviceId) {
        data.deviceId = crypto.randomUUID(); // names this computer when workspaces are shared
        save();
      }
    }
    return structuredClone(data);
  }

  function set(patch) {
    get();
    data = { ...data, ...patch };
    save();
    return get();
  }

  function workspace(id) {
    return { ...(get().workspaces?.[id] || {}) };
  }

  function setWorkspace(id, patch) {
    const all = { ...get().workspaces };
    all[id] = { ...all[id], ...patch };
    return set({ workspaces: all });
  }

  return { get, set, workspace, setWorkspace, file };
}
