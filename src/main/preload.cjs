// The bridge between the screens (renderer) and the app (main process).
// The screens get window.jl and nothing else: no Node, no Electron. Each method sends one IPC call,
// 'jl:<area>.<method>', handled in ipc.js. This file runs sandboxed, so it can only require 'electron'.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Every bridge method, by area. Keep this in step with docs/ARCHITECTURE.md ("Electron bridge").
const METHODS = {
  app: ['info', 'openExternal', 'showItem', 'qr', 'checkUpdate'],
  auth: ['status', 'signIn', 'signUp', 'signOut'],
  workspaces: ['list', 'create', 'select', 'current', 'update', 'join', 'invite', 'revoke', 'members'],
  docs: ['pick', 'add', 'list', 'get', 'file', 'remove'],
  shipments: ['list', 'get', 'update'],
  stones: ['list', 'history', 'verify'],
  checks: ['list'],
  parties: ['list'],
  questions: ['list', 'answer', 'dismiss'],
  papers: ['list', 'build', 'file', 'open', 'print', 'sign', 'send', 'save'],
  agents: ['run', 'ask', 'autopilot'],
  activity: ['list'],
  messages: ['list', 'send'],
  desk: ['queue', 'approve', 'hold', 'houses', 'onboard'],
  sanctions: ['status', 'screen', 'refresh'],
  mail: ['connect', 'status', 'disconnect', 'pollNow'],
  folder: ['choose', 'status'],
  settings: ['get', 'set'],
  metrics: ['get'],
  demo: ['load', 'reset'],
};

function errorResult(e) {
  return { error: e && e.message ? e.message : String(e) };
}

// Calls the main process. Errors come back as { error } objects, never thrown.
function call(channel, args) {
  return ipcRenderer.invoke(`jl:${channel}`, ...args).catch(errorResult);
}

// The full path of a file dropped on the window ('' for files that are not on disk).
// The main process only reads paths reported here or chosen in a file dialog.
function pathForFile(file) {
  let p = '';
  try {
    p = webUtils.getPathForFile(file) || '';
  } catch {
    p = '';
  }
  if (p) ipcRenderer.send('jl:grant-path', p);
  return p;
}

// docs.add also takes File objects straight from a drop or a file input: files on disk are sent by
// path, anything else (an image dragged from a web page) by its bytes.
async function prepareFiles(files) {
  const out = [];
  for (const f of Array.from(files || [])) {
    const isFile = f && typeof f.arrayBuffer === 'function' && typeof f.name === 'string';
    if (!isFile) {
      out.push(f);
      continue;
    }
    const p = pathForFile(f);
    out.push(p ? { path: p } : { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

const jl = {};
for (const [area, names] of Object.entries(METHODS)) {
  jl[area] = {};
  for (const name of names) jl[area][name] = (...args) => call(`${area}.${name}`, args);
}

jl.app.pathForFile = pathForFile;
jl.docs.add = (files) => prepareFiles(files).then((list) => call('docs.add', [list]), errorResult);

// Live events from the agents and the app: 'agent' | 'activity' | 'change' | 'notify' | 'auth' | 'sync'.
// Returns a function that stops listening.
jl.on = (event, fn) => {
  if (typeof fn !== 'function') return () => {};
  const listener = (_e, message) => {
    if (message && message.name === event) fn(message.payload);
  };
  ipcRenderer.on('jl:event', listener);
  return () => ipcRenderer.removeListener('jl:event', listener);
};

contextBridge.exposeInMainWorld('jl', jl);
