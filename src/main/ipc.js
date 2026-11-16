// The main-process side of the bridge: one handler per method in preload.cjs ('jl:<area>.<method>').
// Each handler checks its arguments, then calls the app state (state.js), the services, or Electron.
// registerIpc wraps every handler so nothing is thrown across the bridge: errors come back as { error }.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PAPER_KINDS, ROLES } from '../core/types.js';
import { needString, optionalString, needObject, optionalObject, needBoolean, isSafeExternalUrl } from './validate.js';
import { readDroppedPaths, writeTempFile, safeFileName, MAX_TOTAL_BYTES } from './files.js';
import { looksLikeOpenAIKey } from './openai-key.js';

const INVITE_ROLES = ROLES.filter((r) => r !== 'desk'); // desk staff are never invited by a house
const MAX_PREFS_BYTES = 32 * 1024;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

export function createHandlers({
  state, // state.js
  appInfo, // () => { name, version, platform, ... } from main.js
  dialog, // Electron dialog
  shell, // Electron shell
  getWindow = () => null, // the main window, so dialogs attach to it
  printer, // print.js
  makeQr, // (text) => data URL
  checkUpdate, // () => { latest, url } | null
  checkKey, // (key) => { ok, reason?, warning? } (openai-key.js)
  grants, // files.js path grants
  tempDir,
  documentsDir,
}) {
  const by = () => state.actor(); // { id, name, email }: who did it, for the audit trail
  const services = async () => (await state.ready()).services;

  function deskOnly() {
    if (!state.deskAllowed()) throw new Error('Only Jewel Labs desk staff can do this.');
  }

  // Dialogs attach to the window when there is one.
  function withWindow(show, options) {
    const win = getWindow();
    return win ? show(win, options) : show(options);
  }

  // jl.docs.add accepts [{ path }] (a file the person dropped or picked) or [{ name, bytes }].
  async function addFiles(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('Choose at least one file.');
    const files = [];
    const paths = [];
    for (const item of list) {
      if (item && typeof item.path === 'string' && item.path) {
        if (!grants.isAllowed(item.path)) {
          throw new Error(`${path.basename(item.path)} was not dropped or chosen in this window, so it was not read.`);
        }
        paths.push(item.path);
      } else if (item && typeof item.name === 'string' && (item.bytes instanceof Uint8Array || item.bytes instanceof ArrayBuffer)) {
        files.push({ name: safeFileName(item.name), bytes: item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes) });
      } else {
        throw new Error('Each file needs a path, or a name and its bytes.');
      }
    }
    files.push(...(await readDroppedPaths(paths)));
    if (!files.length) throw new Error('Nothing to add: the folder was empty.');
    const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
    if (total > MAX_TOTAL_BYTES) throw new Error('Those files are too large to add at once. Add them in smaller batches.');
    return state.addFiles(files, 'upload');
  }

  function paperKinds(kinds) {
    if (kinds === undefined || kinds === null) return undefined; // the agents pick what the shipment needs
    if (!Array.isArray(kinds) || kinds.some((k) => !PAPER_KINDS.includes(k))) {
      throw new Error(`Paper kinds must be from: ${PAPER_KINDS.join(', ')}.`);
    }
    return kinds;
  }

  // The desk's edits to a paper before approving or holding it: { fields: { 'goods.destinationCountry': 'BE' } }.
  function deskChanges(changes) {
    return changes === undefined || changes === null ? undefined : needObject(changes, 'changes');
  }

  function signature(sig) {
    needObject(sig, 'signature');
    const signatureDataUrl = optionalString(sig.signatureDataUrl, 'signature image', { max: MAX_SIGNATURE_BYTES });
    if (signatureDataUrl && !/^data:image\/(png|jpeg);base64,/.test(signatureDataUrl)) {
      throw new Error('The signature must be a PNG or JPEG image.');
    }
    return {
      name: needString(sig.name, 'name of the person signing', { max: 200 }),
      title: optionalString(sig.title, 'title', { max: 200 }),
      signatureDataUrl,
    };
  }

  function outgoingMail(mail) {
    needObject(mail, 'email details');
    const looksLikeAddresses = (value) =>
      (Array.isArray(value) ? value : String(value).split(/[,;]/))
        .map((a) => String(a).trim())
        .filter(Boolean)
        .every((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (!mail.to || !looksLikeAddresses(mail.to)) throw new Error('Add who it goes to, as email addresses.');
    if (mail.cc && !looksLikeAddresses(mail.cc)) throw new Error('The cc must be email addresses.');
    return {
      to: mail.to,
      cc: mail.cc || undefined,
      subject: optionalString(mail.subject, 'subject', { max: 500 }) || undefined,
      body: optionalString(mail.body, 'message', { max: 20000 }) || undefined,
    };
  }

  function mailboxOptions(opts) {
    needObject(opts, 'mailbox details');
    const port = opts.port === undefined || opts.port === null || opts.port === '' ? undefined : Number(opts.port);
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('The port must be a number.');
    return {
      ...opts,
      provider: needString(opts.provider, 'email provider', { max: 50 }),
      email: needString(opts.email, 'email address', { max: 320 }),
      appPassword: needString(opts.appPassword, 'app password', { max: 500 }),
      host: optionalString(opts.host, 'server', { max: 255 }) || undefined,
      port,
    };
  }

  async function settingsPatch(patch) {
    needObject(patch, 'settings');
    const clean = { ...patch };
    let warning = null;
    for (const key of ['autopilot', 'notifications', 'launchAtLogin']) {
      if (clean[key] !== undefined) needBoolean(clean[key], key);
    }
    if (clean.model !== undefined) clean.model = optionalString(clean.model, 'model', { max: 100 });
    if (clean.userName !== undefined) clean.userName = optionalString(clean.userName, 'name', { max: 200 });
    if (clean.openaiKey !== undefined && clean.openaiKey !== null && clean.openaiKey !== '') {
      if (!looksLikeOpenAIKey(clean.openaiKey)) throw new Error('That does not look like an OpenAI API key. It starts with sk-.');
      const check = await checkKey(clean.openaiKey);
      if (!check.ok) throw new Error(check.reason);
      warning = check.warning || null;
    }
    if (JSON.stringify(clean).length > MAX_PREFS_BYTES) throw new Error('Those settings are too large to save.');
    const saved = await state.updateSettings(clean);
    return warning ? { ...saved, warning } : saved;
  }

  async function openPaperFile(id) {
    const f = await state.paperFile(needString(id, 'paper'));
    const file = await writeTempFile(tempDir, f.name, f.bytes);
    const problem = await shell.openPath(file); // '' when it opened
    if (problem) throw new Error(problem);
    return { path: file };
  }

  return {
    // ----- app -----
    'app.info': () => ({ ...appInfo(), ...state.info() }),
    'app.openExternal': async (url) => {
      if (!isSafeExternalUrl(url)) throw new Error('Only https and email links can be opened.');
      await shell.openExternal(url);
      return true;
    },
    'app.showItem': (p) => {
      shell.showItemInFolder(needString(p, 'path', { max: 4096 }));
      return true;
    },
    'app.qr': (text) => makeQr(needString(text, 'text', { max: 2000 })),
    'app.checkUpdate': () => checkUpdate(),

    // ----- sign-in -----
    'auth.status': () => state.authStatus(),
    'auth.signIn': (creds) => {
      needObject(creds, 'email and password');
      return state.signIn({ email: needString(creds.email, 'email', { max: 320 }), password: needString(creds.password, 'password', { max: 500 }) });
    },
    'auth.signUp': (form) => {
      needObject(form, 'sign-up details');
      return state.signUp({
        email: needString(form.email, 'email', { max: 320 }),
        password: needString(form.password, 'password', { max: 500 }),
        name: optionalString(form.name, 'name', { max: 200 }) || undefined,
        inviteCode: optionalString(form.inviteCode, 'invite code', { max: 200 }) || undefined,
        houseName: optionalString(form.houseName, 'house name', { max: 200 }) || undefined,
      });
    },
    'auth.signOut': () => state.signOut(),

    // ----- workspaces -----
    'workspaces.list': () => state.listWorkspaces(),
    'workspaces.create': (profile) => {
      needObject(profile, 'workspace details');
      needString(profile.name, 'workspace name', { max: 200 });
      return state.createWorkspace(profile);
    },
    'workspaces.select': (id) => state.selectWorkspace(needString(id, 'workspace')),
    'workspaces.current': () => state.currentWorkspace(),
    'workspaces.update': (patch) => state.updateWorkspace(needObject(patch, 'changes')),
    'workspaces.join': (code) => state.joinWorkspace(needString(code, 'invite code', { max: 200 })),
    'workspaces.invite': (role) => {
      const inviteRole = role ?? 'preparer';
      if (!INVITE_ROLES.includes(inviteRole)) throw new Error(`Invite someone as ${INVITE_ROLES.join(', ')}.`);
      return state.invite(inviteRole);
    },
    'workspaces.members': () => state.members(),

    // ----- documents -----
    'docs.pick': async () => {
      const result = await withWindow((...a) => dialog.showOpenDialog(...a), {
        title: 'Add documents',
        buttonLabel: 'Add',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true, documentIds: [] };
      for (const p of result.filePaths) grants.allow(p);
      return addFiles(result.filePaths.map((p) => ({ path: p })));
    },
    'docs.add': (files) => addFiles(files),
    'docs.list': (q) => state.list('documents', optionalObject(q, 'filter')),
    'docs.get': (id) => state.get('documents', needString(id, 'document')),
    'docs.file': (id) => state.documentFile(needString(id, 'document')),
    'docs.remove': (id) => state.removeDocument(needString(id, 'document')),

    // ----- shipments and stones -----
    'shipments.list': (q) => state.list('shipments', optionalObject(q, 'filter')),
    'shipments.get': (id) => state.get('shipments', needString(id, 'shipment')),
    'shipments.update': (id, patch) => state.updateShipment(needString(id, 'shipment'), needObject(patch, 'changes')),
    'stones.list': (q) => state.list('stones', optionalObject(q, 'filter')),
    'stones.history': async (reportNumber) => (await services()).history(needString(reportNumber, 'report number', { max: 100 })),
    'stones.verify': (stoneId) => state.verifyStone(needString(stoneId, 'stone')),
    'checks.list': (q) => state.list('checks', optionalObject(q, 'filter')),
    'parties.list': (q) => state.list('parties', optionalObject(q, 'filter')),

    // ----- questions -----
    'questions.list': (q) => state.list('questions', optionalObject(q, 'filter')),
    'questions.answer': async (id, answer) =>
      (await services()).answerQuestion(needString(id, 'question'), needString(answer, 'answer', { max: 4000 }), by()),
    'questions.dismiss': (id) => state.dismissQuestion(needString(id, 'question')),

    // ----- papers -----
    'papers.list': (q) => state.list('papers', optionalObject(q, 'filter')),
    'papers.build': async (shipmentId, kinds) =>
      (await services()).buildPapers(needString(shipmentId, 'shipment'), { kinds: paperKinds(kinds), by: by() }),
    'papers.file': async (id) => {
      const f = await state.paperFile(needString(id, 'paper'));
      return { name: f.name, mime: f.mime, bytes: f.bytes };
    },
    'papers.open': (id) => openPaperFile(id),
    'papers.print': async (id) => {
      const f = await state.paperFile(needString(id, 'paper'));
      try {
        return await printer.print(f.bytes, { title: f.name });
      } catch (e) {
        // Printing from the app did not work: open it in the PDF app, which can print it.
        const opened = await openPaperFile(id);
        return { printed: false, opened: opened.path, reason: e.message };
      }
    },
    'papers.sign': async (id, sig) => (await services()).signPaper(needString(id, 'paper'), signature(sig), by()),
    'papers.send': async (id, mail) => (await services()).sendPaper(needString(id, 'paper'), outgoingMail(mail), by()),
    'papers.save': async (id) => {
      const f = await state.paperFile(needString(id, 'paper'));
      const result = await withWindow((...a) => dialog.showSaveDialog(...a), {
        title: 'Save paper',
        defaultPath: path.join(documentsDir, f.name),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.writeFile(result.filePath, f.bytes);
      return { path: result.filePath };
    },

    // ----- agents -----
    'agents.run': async (q) => {
      const o = optionalObject(q, 'request');
      return (await services()).run({
        shipmentId: optionalString(o.shipmentId, 'shipment') || undefined,
        reason: optionalString(o.reason, 'reason', { max: 500 }) || 'Asked from the app',
      });
    },
    'agents.ask': async (text, q) => {
      const o = optionalObject(q, 'request');
      return (await services()).ask(needString(text, 'question', { max: 4000 }), {
        shipmentId: optionalString(o.shipmentId, 'shipment') || undefined,
        by: by(),
      });
    },
    'agents.autopilot': async (on) => {
      if (on !== undefined && on !== null) await state.setAutopilot(needBoolean(on, 'autopilot'));
      return state.autopilotOn();
    },

    // ----- activity and messages -----
    'activity.list': (q) => state.list('activity', optionalObject(q, 'filter')),
    'messages.list': (q) => state.list('messages', optionalObject(q, 'filter')),
    'messages.send': (msg) => {
      needObject(msg, 'message');
      return state.sendMessage({
        text: needString(msg.text, 'message', { max: 4000 }),
        shipmentId: optionalString(msg.shipmentId, 'shipment'),
        to: optionalString(msg.to, 'recipient', { max: 100 }),
      });
    },

    // ----- the Jewel Labs desk -----
    'desk.queue': async () => {
      deskOnly();
      return (await services()).desk.queue();
    },
    // An optional third argument carries the desk's edits to the paper.
    'desk.approve': async (paperId, message, changes) => {
      deskOnly();
      const note = optionalString(message, 'message', { max: 4000 }) || '';
      return (await services()).desk.approve(needString(paperId, 'paper'), note, by(), deskChanges(changes));
    },
    'desk.hold': async (paperId, message, changes) => {
      deskOnly();
      const note = optionalString(message, 'message', { max: 4000 }) || '';
      return (await services()).desk.hold(needString(paperId, 'paper'), note, by(), deskChanges(changes));
    },
    'desk.houses': () => {
      deskOnly();
      return state.listWorkspaces();
    },
    'desk.onboard': (profile) => {
      deskOnly();
      needObject(profile, 'house details');
      needString(profile.name, 'house name', { max: 200 });
      return state.onboardHouse(profile);
    },

    // ----- sanctions -----
    'sanctions.status': () => state.sanctionsStatus(),
    'sanctions.screen': (name) => state.screenName(needString(name, 'name', { max: 300 })),
    'sanctions.refresh': () => state.refreshSanctions(),

    // ----- mailbox and watched folder -----
    'mail.connect': (opts) => state.connectMail(mailboxOptions(opts)),
    'mail.status': async () => (await services()).mail.status(),
    'mail.disconnect': () => state.disconnectMail(),
    'mail.pollNow': () => state.pollMail(),
    'folder.choose': async () => {
      const result = await withWindow((...a) => dialog.showOpenDialog(...a), {
        title: 'Choose the folder the agents watch',
        buttonLabel: 'Watch this folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      grants.allow(result.filePaths[0]);
      return state.setFolder(result.filePaths[0]);
    },
    'folder.status': async () => (await services()).folder.status(),

    // ----- settings, metrics, sample -----
    'settings.get': () => state.publicSettings(),
    'settings.set': (patch) => settingsPatch(patch),
    'metrics.get': async () => (await services()).metrics(),
    'demo.load': (options) => state.loadSample({ later: optionalObject(options, 'sample options').later === true }),
    'demo.reset': () => state.resetSample(),
  };
}

// Makes a result safe to send over IPC: plain data only. Functions and symbols are dropped, so a stray
// method on a record cannot break the call. Bytes and dates pass through as they are.
export function toPlain(value, depth = 0) {
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date) return value;
  if (depth > 50) return undefined;
  if (Array.isArray(value)) return value.map((v) => toPlain(v, depth + 1) ?? null);
  if (value instanceof Error) return { error: value.message };
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const plain = toPlain(v, depth + 1);
    if (plain !== undefined) out[key] = plain;
  }
  return out;
}

// Runs one handler. Untrusted senders are refused; errors become { error: message }.
export async function runHandler(name, fn, args, { trusted = true, log = console } = {}) {
  if (!trusted) return { error: 'This page is not allowed to use the app.' };
  try {
    return toPlain(await fn(...args));
  } catch (e) {
    log.warn?.(`${name} failed:`, e?.message || e);
    return { error: e?.message || String(e) };
  }
}

export function registerIpc(ipcMain, handlers, { isTrustedSender = () => true, grants = null, log = console } = {}) {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`jl:${name}`, (event, ...args) => runHandler(name, fn, args, { trusted: isTrustedSender(event), log }));
  }
  // The preload reports the path of each file dropped on the window, so docs.add may read it.
  if (grants) {
    ipcMain.on('jl:grant-path', (event, p) => {
      if (isTrustedSender(event) && typeof p === 'string') grants.allow(p);
    });
  }
}
