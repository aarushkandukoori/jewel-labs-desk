// The app's working state: who is signed in, which workspace is open, and the services (the agents)
// running on it. main.js creates one; ipc.js calls it for everything that touches data.
// It never imports Electron, so the unit tests run it in plain Node with small fakes.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { NO_SAFE_STORAGE } from './secrets.js';
import { isPlainObject } from './validate.js';

export const LOCAL_WORKSPACE_NAME = 'Local workspace';
// The sandbox's name (the same as SAMPLE_WORKSPACE_NAME in pipeline/sample.js, which gives the sandbox the SAMPLE
// house's details when the sample is loaded and keeps any other name the person chose).
export const SAMPLE_WORKSPACE_NAME = 'Sample workspace';
export const DESK_ONLY = 'Only Jewel Labs desk staff can do this.';
export const DESK_APPROVAL_ONLY =
  'Only a signed-in Jewel Labs desk account can approve a held pack. Fix what the checks found and run the agents again, or sign in so Jewel Labs can review it.';
export const ANSWER_FIRST = 'Answer this question; the agents need to know which is right.';

// Record fields the screens may never overwrite.
const PROTECTED_FIELDS = ['id', 'workspaceId', 'createdAt', 'updatedAt'];
// What a person may change on a shipment directly: only their own note. Everything else comes from the papers, the
// answers to the agents' questions and the checks (status, approvals, the papers it needs), never from a screen.
const SHIPMENT_EDITABLE = ['note'];
// Settings the app manages itself; the screens cannot set them as preferences.
const INTERNAL_SETTINGS = new Set([
  'deviceId', 'selected', 'localWorkspaceId', 'sampleWorkspaceId', 'workspaces', 'windowBounds', 'toldAboutTray', 'prefs', 'autopilot',
]);

export function createAppState({
  core, // the loaded src/core modules { store, ai, sanctions, ocr, labs, services, cloud }, or { error }
  config, // src/core/config.js
  paths, // { userData, localDir, cacheDir, tempDir, samplesDir, assetsDir }
  settings, // settings.js
  secrets, // secrets.js
  sendEvent = () => {}, // (name, payload) -> the screens
  notify = () => {}, // agent notices -> the screens and desktop notifications
  rasterize = null,
  labsVerify = null,
  system = {}, // { setLaunchAtLogin(on), getLaunchAtLogin(), onAutopilotChange(on) } from main.js
  devApiKey = null, // OPENAI_API_KEY from the environment, used in development only
  ofacDownload = true, // false in tests: use the OFAC list on this computer, never download it
  log = console,
  now = () => new Date(),
}) {
  let cloud = null; // the Supabase client (src/core/store/cloud.js), when the cloud is configured
  let session = null; // the signed-in session { user: { id, email, name }, isDesk }, or null
  let cloudWorkspaces = []; // last list from the cloud; each carries myRole, the person's role there
  let housesUnknown = false; // the list of houses could not be read at start (offline, a cloud blip)
  let fellBack = false; // the saved house did not open (offline, signed out): reopen it once the sign-in is back
  let current = null; // the open workspace: { kind: 'local' | 'cloud', id }
  let store = null;
  let ai = null;
  let services = null;
  let autopilot = null; // the open workspace's autopilot switch, kept here so the tray can read it at once
  let lastError = null; // why the last workspace failed to open
  let detach = []; // removes our listeners from the open services
  let mailRetry = null; // timer that retries the mailbox after a failed reconnect
  let queue = Promise.resolve(); // workspace changes run one at a time, in order
  let sdn = null; // { promise, at }: the OFAC list, loaded once and refreshed daily

  // ---------- opening and closing workspaces ----------

  function runInOrder(task) {
    const run = queue.then(task);
    queue = run.catch(() => {}); // the next change still runs if this one failed
    return run;
  }

  function start() {
    return runInOrder(async () => {
      if (core.error) throw core.error;
      const localIds = await ensureLocalWorkspaces();
      if (config.SUPABASE_URL && core.cloud) await connectCloud();
      const saved = settings.get().selected;
      const target = pickStartWorkspace(localIds);
      // Opening at start never changes the saved choice: a fallback (offline, signed out) is not what the
      // person picked, and the next start, or the sign-in coming back, opens their house again.
      fellBack = saved?.kind === 'cloud' && target.id !== saved.id;
      try {
        await open(target, { remember: false });
      } catch (error) {
        if (target.kind !== 'cloud') throw error;
        log.warn('The shared workspace did not open, using the local one:', error.message);
        fellBack = true;
        await open(localRef(), { remember: false }); // offline or the cloud is down: keep working locally
      }
    });
  }

  // Sign-in is optional: if the cloud cannot be reached, the app works in local mode.
  async function connectCloud() {
    try {
      cloud = await core.cloud.createCloud({
        url: config.SUPABASE_URL,
        anonKey: config.SUPABASE_PUBLISHABLE_KEY,
        sessionStorage: secrets.storage('supabase'),
      });
      session = await readSession();
      if (session) {
        cloudWorkspaces = await cloud.workspaces.list().catch(() => {
          housesUnknown = true; // offline: the saved house still opens from its copy on this computer
          return [];
        });
      }
      cloud.auth.onChange?.(() => onSessionChange());
    } catch (error) {
      log.warn('Sign-in is not available right now:', error.message);
      cloud = null;
      session = null;
    }
  }

  async function stop() {
    await runInOrder(close);
    await settle(() => core.ocr?.terminateOcr?.(), 'stop OCR');
    if (cloud) await settle(() => cloud.close?.(), 'close the cloud connection');
  }

  function openWorkspace(ref) {
    return runInOrder(() => open(ref));
  }

  // remember: false opens a workspace without making it the person's choice (start-up and fallbacks).
  async function open(ref, { remember = true } = {}) {
    if (remember) fellBack = false;
    await close();
    lastError = null;
    try {
      store =
        ref.kind === 'cloud'
          ? await core.store.openCloudStore({ cloud, workspaceId: ref.id, cacheDir: path.join(paths.cacheDir, 'cloud'), userId: session?.user?.id || null })
          : await core.store.openLocalStore({ dir: paths.localDir, workspaceId: ref.id });
      current = ref;
      ai = await makeAI();
      services = await core.services.createServices({
        store,
        ai,
        sanctionsLoader: loadSanctions,
        ocr: core.ocr,
        labsVerify: labsVerify || undefined,
        rasterize: rasterize || undefined,
        notify,
        paths,
        deviceId: settings.get().deviceId,
        lease: ref.kind === 'cloud' ? cloud.lease : undefined,
        getMembers: ref.kind === 'cloud' ? () => cloud.workspaces.members(ref.id) : undefined,
      });
      listenTo(services);
      rememberAutopilot((await services.autopilot.get()) !== false);
      reconnectMail(ref);
      startWorker(services);
      if (remember) settings.set({ selected: ref });
      sendEvent('sync', { reason: 'opened', workspaceId: ref.id, kind: ref.kind });
    } catch (error) {
      lastError = error;
      log.error('The workspace did not open:', error);
      await close();
      // The server says this person is no longer in the house: its copy on this computer goes too.
      if (ref.kind === 'cloud' && error?.code === 'NOT_FOUND') await forgetHouse(ref.id);
      throw error;
    }
  }

  async function close() {
    clearTimeout(mailRetry);
    mailRetry = null;
    for (const off of detach) off();
    detach = [];
    const old = { services, store };
    services = null;
    store = null;
    ai = null;
    if (old.services) await settle(() => old.services.worker.stop(), 'stop the agents');
    if (old.store) await settle(() => old.store.close(), 'close the workspace');
  }

  // Waits for any workspace change in progress, then hands out the open store and services.
  async function ready() {
    await queue;
    if (core.error) throw new Error(`The agents could not start: ${core.error.message}`);
    if (!services || !store) {
      throw new Error(lastError ? `The workspace did not open: ${lastError.message}` : 'The workspace is still opening. Try again in a moment.');
    }
    return { store, services };
  }

  async function settle(fn, what) {
    try {
      await fn();
    } catch (e) {
      log.warn(`Could not ${what}:`, e?.message || e);
    }
  }

  // Every house starts with its own "Local workspace" and a "Sample workspace" with SAMPLE papers.
  // Returns the ids of all local workspaces.
  async function ensureLocalWorkspaces() {
    const s = settings.get();
    const list = await core.store.listLocalWorkspaces({ dir: paths.localDir });
    const ids = new Set(list.map((w) => w.id));
    const findOrCreate = async (savedId, isMatch, profile) => {
      if (savedId && ids.has(savedId)) return savedId;
      const found = list.find(isMatch);
      if (found) return found.id;
      const created = await core.store.createLocalWorkspace({ dir: paths.localDir, profile });
      ids.add(created.id);
      return created.id;
    };
    const localWorkspaceId = await findOrCreate(s.localWorkspaceId, (w) => w.name === LOCAL_WORKSPACE_NAME && !w.sample, {
      name: LOCAL_WORKSPACE_NAME,
    });
    const sampleWorkspaceId = await findOrCreate(s.sampleWorkspaceId, (w) => w.sample === true, {
      name: SAMPLE_WORKSPACE_NAME,
      sample: true,
    });
    if (localWorkspaceId !== s.localWorkspaceId || sampleWorkspaceId !== s.sampleWorkspaceId) {
      settings.set({ localWorkspaceId, sampleWorkspaceId });
    }
    return ids;
  }

  function localRef() {
    return { kind: 'local', id: settings.get().localWorkspaceId };
  }

  // Reopens the workspace used last time, or the first shared one after a sign-in, or the local one.
  // A saved house opens even when the list of houses could not be read (offline): its copy on this computer opens.
  function pickStartWorkspace(localIds) {
    const saved = settings.get().selected;
    if (saved?.kind === 'cloud' && session && (housesUnknown || cloudWorkspaces.some((w) => w.id === saved.id))) return saved;
    if (saved?.kind === 'local' && localIds.has(saved.id)) return saved;
    if (session && cloudWorkspaces[0]) return { kind: 'cloud', id: cloudWorkspaces[0].id };
    return localRef();
  }

  // The AI client: the house's own OpenAI key first, then the Jewel Labs service for signed-in
  // houses, else the offline reader (less accurate, but the app still works).
  async function makeAI() {
    const model = settings.get().model || undefined;
    const apiKey = (await secrets.get('openai')) || devApiKey;
    if (apiKey) return core.ai.createAI({ mode: 'direct', apiKey, model });
    // The Jewel Labs service counts each call against a house the person belongs to: the open one, or
    // their first house while a local workspace is open.
    const houseId = current?.kind === 'cloud' ? current.id : cloudWorkspaces[0]?.id;
    if (cloud && session && houseId) {
      return core.ai.createAI({
        mode: 'proxy',
        proxyUrl: cloud.aiProxyUrl || `${config.SUPABASE_URL}/functions/v1/ai`,
        getAccessToken: () => cloud.accessToken(),
        model,
        workspaceId: houseId, // sent as x-jl-workspace
      });
    }
    return core.ai.createAI({ mode: 'off', model });
  }

  function listenTo(svc) {
    const handlers = {
      agent: (payload) => sendEvent('agent', payload),
      activity: (payload) => sendEvent('activity', payload),
      change: (payload) => {
        // Autopilot lives on the workspace; another computer or an agent may have switched it.
        if (payload?.collection === 'workspace' && payload.value) rememberAutopilot(payload.value.autopilot !== false);
        sendEvent('change', payload);
      },
      notify: (payload) => notify(payload),
    };
    for (const [name, fn] of Object.entries(handlers)) {
      svc.events.on(name, fn);
      detach.push(() => svc.events.removeListener(name, fn));
    }
  }

  function startWorker(svc) {
    // Not awaited: the worker's first round (mail, folder) must not hold up opening the window.
    Promise.resolve()
      .then(() => svc.worker.start())
      .catch((e) => log.warn('The agents did not start their loop:', e?.message || e));
  }

  // The mailbox password is kept on this computer only (secrets.js). After a restart, connect again
  // without a test login, so a slow network does not hold anything up; the worker reports problems.
  function reconnectMail(ref) {
    const svc = services;
    const saved = settings.workspace(ref.id).mail;
    if (!svc || !saved) return;
    secrets
      .get(mailSecretName(ref.id))
      .then((appPassword) => appPassword && svc.mail.connect({ ...saved, appPassword, test: false }))
      .catch((e) => {
        // Saved by an older copy with no domains: retrying cannot help. The mailbox status asks for them.
        if (e?.code === 'no_domains') {
          log.warn('The mailbox did not reconnect: it has no email domains to bring mail in from.');
          return;
        }
        log.warn('The mailbox did not reconnect; trying again in a few minutes:', e?.message || e);
        mailRetry = setTimeout(() => services === svc && reconnectMail(ref), config.MAILBOX_POLL_MINUTES * 60 * 1000);
        mailRetry.unref?.();
      });
  }

  // ---------- who is using the app ----------

  async function readSession() {
    try {
      return (await cloud.auth.session()) || null;
    } catch {
      return null;
    }
  }

  async function onSessionChange() {
    session = await readSession();
    if (!session && current?.kind === 'cloud') {
      // The sign-in ran out (offline, or signed out on another computer): work locally for now, keep the house as
      // the saved choice, and reopen it when the sign-in comes back.
      await runInOrder(async () => {
        await open(localRef(), { remember: false });
        fellBack = true;
      }).catch(() => {});
    }
    if (session) await reopenSavedHouse();
    sendEvent('auth', authStatus());
  }

  // After an offline start (or a sign-in that ran out) the app works in another workspace. Once the sign-in is
  // back (the token refreshes about a minute after the network returns), the saved house opens again, with the AI.
  async function reopenSavedHouse() {
    const saved = settings.get().selected;
    if (!fellBack || saved?.kind !== 'cloud' || !cloud) return;
    const list = await cloud.workspaces.list().catch(() => null);
    if (!list) return; // still offline: try again on the next sign-in change
    cloudWorkspaces = list;
    housesUnknown = false;
    if (!list.some((w) => w.id === saved.id)) return;
    await runInOrder(async () => {
      if (!fellBack) return; // the person opened a workspace themselves meanwhile
      await open(saved, { remember: false });
      fellBack = false;
    }).catch((e) => log.warn('The house did not reopen yet:', e?.message || e));
  }

  function isDeskUser() {
    return Boolean(session?.isDesk) || cloudWorkspaces.some((w) => w.myRole === 'desk');
  }

  // Local mode has no accounts: everything is the person's own data, so the desk views are allowed.
  function deskAllowed() {
    return !session || isDeskUser();
  }

  // Approving a held pack is the Jewel Labs review itself: only a signed-in desk account may do it, never the
  // house's own clerk in a local workspace.
  function canApprove() {
    return Boolean(session) && isDeskUser();
  }

  function role() {
    if (!session) return 'owner';
    if (isDeskUser()) return 'desk';
    return cloudWorkspaces.find((w) => w.id === current?.id)?.myRole || 'preparer';
  }

  function personName() {
    const user = session?.user;
    let osName = null;
    try {
      osName = os.userInfo().username;
    } catch {
      osName = null;
    }
    return user?.name || user?.email || settings.get().userName || osName || 'You';
  }

  // Who did something, for the services' audit trail and usage numbers.
  function actor() {
    const user = session?.user;
    return { id: user?.id || settings.get().deviceId, name: personName(), email: user?.email || null };
  }

  function authStatus() {
    const user = session?.user;
    return {
      cloud: Boolean(cloud),
      signedIn: Boolean(session),
      user: user ? { id: user.id || null, email: user.email || null, name: user.name || user.email || null } : null,
      role: role(),
      deskAllowed: deskAllowed(),
      canApprove: canApprove(),
    };
  }

  function requireCloud() {
    if (!cloud) throw new Error('Sign-in is not set up in this copy of the app. Your work stays on this computer.');
  }

  function requireSession() {
    requireCloud();
    if (!session) throw new Error('Sign in first.');
  }

  async function signIn({ email, password }) {
    requireCloud();
    await cloud.auth.signIn({ email, password });
    session = await readSession();
    if (!session) throw new Error('Sign-in did not finish. Check the email and password.');
    await afterSignIn();
    return authStatus();
  }

  async function signUp(form) {
    requireCloud();
    await cloud.auth.signUp(form);
    session = await readSession();
    if (!session) return { ...authStatus(), needsConfirmation: true }; // the person confirms by email first
    await afterSignIn();
    return authStatus();
  }

  async function afterSignIn() {
    cloudWorkspaces = await cloud.workspaces.list().catch(() => []);
    const target = cloudWorkspaces[0] ? { kind: 'cloud', id: cloudWorkspaces[0].id } : current || localRef();
    await openWorkspace(target); // also switches the AI to the Jewel Labs service
    sendEvent('auth', authStatus());
  }

  // Signing out sends what is still waiting while the sign-in works, then removes this computer's copies of the
  // houses (cache/cloud/<houseId>/), so the next person at this computer, or a member who was removed, keeps none.
  // A house with changes that could not be sent (offline) is kept, so no work is lost: keptUnsent says how many.
  async function signOut() {
    const house = current?.kind === 'cloud' ? store : null;
    if (typeof house?.flush === 'function') await settle(() => withTimeout(house.flush(), 5000), 'send the last changes');
    if (cloud) await settle(() => cloud.auth.signOut(), 'sign out of the cloud');
    session = null;
    cloudWorkspaces = [];
    housesUnknown = false;
    await openWorkspace(current?.kind === 'local' ? current : localRef());
    const kept = await forgetHouses();
    sendEvent('auth', authStatus());
    return { ...authStatus(), keptUnsent: kept.length };
  }

  // ---------- this computer's copies of the shared houses ----------

  function houseCacheDir(id) {
    return path.join(paths.cacheDir, 'cloud', path.basename(String(id)));
  }

  // True when the house's copy still holds changes that never reached the server (cloud-store.js keeps them in
  // _sync.json as its outbox). An unreadable file counts as unsent: keeping it is the safe side.
  async function hasUnsentChanges(dir) {
    try {
      const sync = JSON.parse(await fs.readFile(path.join(dir, '_sync.json'), 'utf8'));
      return Array.isArray(sync?.outbox) && sync.outbox.length > 0;
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  }

  // Removes one house's copy unless it holds unsent changes. Returns true when it is gone.
  async function forgetHouse(id) {
    const dir = houseCacheDir(id);
    if (await hasUnsentChanges(dir)) {
      log.warn('A house copy kept on this computer: it has changes that were not sent yet.');
      return false;
    }
    await settle(() => fs.rm(dir, { recursive: true, force: true }), 'remove a house copy');
    return true;
  }

  // Removes the copy of every house on this computer. Returns the ids that were kept (unsent changes).
  async function forgetHouses() {
    const names = await fs.readdir(path.join(paths.cacheDir, 'cloud')).catch(() => []);
    const kept = [];
    for (const id of names) if (!(await forgetHouse(id))) kept.push(id);
    return kept;
  }

  // ---------- workspaces ----------

  async function listWorkspaces() {
    const s = settings.get();
    const local = (await core.store.listLocalWorkspaces({ dir: paths.localDir })).map((w) => ({
      ...w,
      kind: 'local',
      sample: w.id === s.sampleWorkspaceId || w.sample === true,
    }));
    if (!session) return local;
    cloudWorkspaces = await cloud.workspaces.list();
    housesUnknown = false;
    return [...cloudWorkspaces.map((w) => ({ ...w, kind: 'cloud', sample: false })), ...local];
  }

  async function selectWorkspace(id) {
    const found = (await listWorkspaces()).find((w) => w.id === id);
    if (!found) throw new Error('That workspace was not found.');
    await openWorkspace({ kind: found.kind, id: found.id });
    return currentWorkspace();
  }

  async function currentWorkspace() {
    const { store: s } = await ready();
    const w = await s.workspace();
    return { ...w, kind: current.kind, sample: current.id === settings.get().sampleWorkspaceId, myRole: role() };
  }

  async function createWorkspace(profile) {
    const created = session
      ? await cloud.workspaces.create(profile)
      : await core.store.createLocalWorkspace({ dir: paths.localDir, profile });
    if (session) cloudWorkspaces = await cloud.workspaces.list().catch(() => cloudWorkspaces);
    await openWorkspace({ kind: session ? 'cloud' : 'local', id: created.id });
    return currentWorkspace();
  }

  async function updateWorkspace(patch) {
    const { store: s } = await ready();
    return s.updateWorkspace(withoutProtected(patch));
  }

  async function joinWorkspace(code) {
    requireSession();
    const joined = await cloud.workspaces.join(code);
    cloudWorkspaces = await cloud.workspaces.list().catch(() => cloudWorkspaces);
    await openWorkspace({ kind: 'cloud', id: joined.id });
    return currentWorkspace();
  }

  async function invite(inviteRole) {
    requireSession();
    if (current?.kind !== 'cloud') throw new Error('Invites work for shared workspaces. Open your house workspace first.');
    return cloud.workspaces.invite(current.id, inviteRole);
  }

  // Withdraws an invite code (the house owner or Jewel Labs): nobody can join with it any more.
  async function revokeInvite(code) {
    requireSession();
    const revoked = await cloud.workspaces.revoke(code);
    if (!revoked) throw new Error('That code was not found, or only the house owner can withdraw it.');
    await logActivity(store, { action: 'invite.revoke', detail: 'Withdrew an invite code' }).catch(() => {});
    return { revoked: true };
  }

  async function members() {
    if (session && current?.kind === 'cloud') return cloud.workspaces.members(current.id);
    return [{ name: personName(), email: null, role: 'owner', you: true }];
  }

  // ---------- records ----------

  async function list(collection, q = {}) {
    const { store: s } = await ready();
    const { limit, search, ...filters } = q || {};
    const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const rows = await s.list(collection, (row) => matches(row, filters) && (!needle || JSON.stringify(row).toLowerCase().includes(needle)));
    rows.sort(newestFirst);
    return Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows;
  }

  async function get(collection, id) {
    const { store: s } = await ready();
    return s.get(collection, id);
  }

  async function logActivity(s, { shipmentId = null, action, detail }) {
    await s.put('activity', {
      id: crypto.randomUUID(),
      at: now().toISOString(),
      shipmentId,
      actor: { type: 'person', name: personName() },
      action,
      detail,
    });
  }

  async function addFiles(files, kind = 'upload') {
    const { services: svc } = await ready();
    const receivedAt = now().toISOString();
    return svc.addFiles(files.map((f) => ({ name: f.name, bytes: f.bytes, source: { kind, receivedAt } })));
  }

  async function documentFile(id) {
    const { store: s } = await ready();
    const doc = await s.get('documents', id);
    if (!doc) throw new Error('That document was not found.');
    return { name: doc.fileName, mime: doc.mime, bytes: await s.getFile(doc.fileKey) };
  }

  async function removeDocument(id) {
    const { store: s, services: svc } = await ready();
    if (typeof svc.removeDocument === 'function') return svc.removeDocument(id, actor());
    const doc = await s.get('documents', id);
    if (!doc) throw new Error('That document was not found.');
    await s.remove('documents', id);
    if (doc.shipmentId) {
      const shipment = await s.get('shipments', doc.shipmentId);
      if (shipment) await s.put('shipments', { ...shipment, documentIds: (shipment.documentIds || []).filter((d) => d !== id) });
      if (autopilotOn()) {
        Promise.resolve()
          .then(() => svc.run({ shipmentId: doc.shipmentId, reason: 'A document was removed' }))
          .catch((e) => log.warn('Re-checking the shipment failed:', e?.message || e));
      }
    }
    await logActivity(s, { shipmentId: doc.shipmentId || null, action: 'document.remove', detail: `Removed ${doc.fileName}` });
    return true;
  }

  async function updateShipment(id, patch) {
    const { store: s } = await ready();
    const shipment = await s.get('shipments', id);
    if (!shipment) throw new Error('That shipment was not found.');
    const changes = withoutProtected(patch);
    const refused = Object.keys(changes).filter((key) => !SHIPMENT_EDITABLE.includes(key));
    if (refused.length) {
      throw new Error(`${refused.join(', ')} cannot be changed here. Answer the agents' questions, or add corrected papers.`);
    }
    if (changes.note !== undefined && changes.note !== null && typeof changes.note !== 'string') throw new Error('The note must be text.');
    const saved = await s.put('shipments', { ...shipment, ...changes, id });
    const what = Object.keys(changes).join(', ') || 'nothing';
    await logActivity(s, { shipmentId: id, action: 'shipment.edit', detail: `Edited ${what} on ${shipment.ref || 'the shipment'}` });
    return saved;
  }

  async function dismissQuestion(id) {
    const { store: s, services: svc } = await ready();
    const question = await s.get('questions', id);
    if (!question) throw new Error('That question was not found.');
    // Two papers that disagree, or a possible sanctions match, need an answer: closing the question unanswered
    // would let the shipment go on to Ready to sign.
    if (question.kind === 'mismatch' || question.kind === 'confirm') throw new Error(ANSWER_FIRST);
    if (typeof svc.dismissQuestion === 'function') return svc.dismissQuestion(id, actor());
    const saved = await s.put('questions', {
      ...question,
      status: 'dismissed',
      answeredBy: personName(),
      answeredAt: now().toISOString(),
    });
    await logActivity(s, { shipmentId: question.shipmentId || null, action: 'question.dismiss', detail: `Dismissed: ${question.text}` });
    return saved;
  }

  // Checks one stone on the lab's own website (a visible window; see labs-window.js).
  async function verifyStone(stoneId) {
    const { store: s, services: svc } = await ready();
    if (typeof svc.verifyStone === 'function') return svc.verifyStone(stoneId, actor());
    if (!labsVerify) throw new Error('Lab checks are not available in this copy of the app.');
    const stone = await s.get('stones', stoneId);
    if (!stone) throw new Error('That stone was not found.');
    const result = await labsVerify(stone);
    await s.put('stones', {
      ...stone,
      labCheck: { status: result.status, checkedAt: now().toISOString(), diffs: result.diffs || [] },
    });
    await logActivity(s, { shipmentId: stone.shipmentId || null, action: 'lab.check', detail: labCheckDetail(stone, result) });
    return result;
  }

  async function paperFile(id) {
    const { store: s } = await ready();
    const paper = await s.get('papers', id);
    if (!paper) throw new Error('That paper was not found.');
    const signed = paper.status === 'signed' || paper.status === 'sent' ? '-signed' : '';
    return { name: `${paper.ref}-v${paper.version}${signed}.pdf`, mime: 'application/pdf', bytes: await s.getFile(paper.fileKey) };
  }

  async function sendMessage({ text, shipmentId = null, to = null }) {
    const { store: s } = await ready();
    return s.put('messages', {
      id: crypto.randomUUID(),
      at: now().toISOString(),
      shipmentId: shipmentId || null,
      from: { type: 'person', name: personName(), role: role() },
      to: to || (role() === 'desk' ? 'house' : 'desk'),
      text,
    });
  }

  // ---------- autopilot (a switch on the workspace) ----------

  // Before a workspace is open, the last value seen is used (it decides whether the app starts in the tray).
  function autopilotOn() {
    return autopilot ?? settings.get().autopilot !== false;
  }

  function rememberAutopilot(on) {
    const changed = on !== autopilot;
    autopilot = on;
    if (settings.get().autopilot !== on) settings.set({ autopilot: on });
    if (changed) system.onAutopilotChange?.(on);
  }

  async function setAutopilot(on) {
    const { services: svc } = await ready();
    await svc.autopilot.set(on, actor());
    rememberAutopilot(on);
    return on;
  }

  // ---------- the Jewel Labs desk ----------

  async function onboardHouse(profile) {
    if (!deskAllowed()) throw new Error(DESK_ONLY);
    const workspace = session
      ? await cloud.workspaces.create(profile)
      : await core.store.createLocalWorkspace({ dir: paths.localDir, profile });
    const screening = await screenName(profile.legalEntity || profile.name, { country: profile.country || undefined }).catch((e) => ({
      name: profile.legalEntity || profile.name,
      status: 'review',
      best: null,
      compared: 0,
      error: e.message,
    }));
    const inviteCode = session ? await cloud.workspaces.invite(workspace.id, 'owner').catch((e) => ({ error: e.message })) : null;
    if (session) cloudWorkspaces = await cloud.workspaces.list().catch(() => cloudWorkspaces);
    // The new house opens at once, so its mailbox, chat export and records go to it, never to the house that was
    // open before (another customer). If it does not open, the old house is closed all the same (open() closes
    // first), so nothing can land there; the result still carries the invite code.
    let openError = null;
    await openWorkspace({ kind: session ? 'cloud' : 'local', id: workspace.id }).catch((e) => {
      openError = e.message;
    });
    return { workspace: { ...workspace, kind: session ? 'cloud' : 'local' }, screening, invite: inviteCode, opened: !openError, openError };
  }

  // ---------- OFAC sanctions list ----------

  // The copy on this computer (the last download, or the snapshot that ships with the app) is ready at
  // once. A download from treasury.gov takes about a minute, so it runs in the background and replaces
  // the list when it arrives; the agents never wait for it. force (Settings, Refresh) waits for it.
  function loadSanctions({ force = false } = {}) {
    const maxAgeMs = config.OFAC_MAX_AGE_HOURS * 3600 * 1000;
    const cacheDir = path.join(paths.cacheDir, 'ofac');
    if (force) {
      const promise = Promise.resolve().then(() => core.sanctions.loadSdn({ cacheDir, maxAgeHours: 0 }));
      return promise.then((index) => {
        sdn = { promise, at: Date.now() };
        return index;
      });
    }
    if (!sdn || Date.now() - sdn.at > maxAgeMs) {
      const first = !sdn;
      const promise = first
        ? Promise.resolve().then(() => core.sanctions.loadSdn({ cacheDir, fetch: null }))
        : sdn.promise; // keep using the list we have while a fresh one downloads
      sdn = { promise, at: Date.now() };
      promise.catch(() => {
        if (sdn?.promise === promise) sdn = null; // try again next time
      });
      if (ofacDownload) refreshSanctionsInBackground(cacheDir);
    }
    return sdn.promise;
  }

  let sdnRefreshing = false;
  function refreshSanctionsInBackground(cacheDir) {
    if (sdnRefreshing) return;
    sdnRefreshing = true;
    Promise.resolve()
      .then(() => core.sanctions.loadSdn({ cacheDir, maxAgeHours: config.OFAC_MAX_AGE_HOURS }))
      .then((index) => {
        if (index?.count) sdn = { promise: Promise.resolve(index), at: Date.now() };
      })
      .catch((e) => log.warn('The OFAC list did not refresh; the copy on this computer is used:', e?.message || e))
      .finally(() => {
        sdnRefreshing = false;
      });
  }

  async function sanctionsStatus() {
    const index = await loadSanctions();
    return { count: index.count, date: index.date, source: index.source };
  }

  async function screenName(name, opts = {}) {
    return core.sanctions.screen(name, await loadSanctions(), opts);
  }

  async function refreshSanctions() {
    await loadSanctions({ force: true });
    return sanctionsStatus();
  }

  // ---------- mailbox and watched folder ----------

  async function connectMail(opts) {
    const { services: svc } = await ready();
    const result = await svc.mail.connect({ ...opts, by: actor() });
    let saved = false;
    let warning = null;
    if (opts.keepConnected !== false) {
      try {
        await secrets.set(mailSecretName(current.id), opts.appPassword);
        const { appPassword, ...withoutPassword } = opts;
        settings.setWorkspace(current.id, { mail: withoutPassword });
        saved = true;
      } catch {
        warning = NO_SAFE_STORAGE; // connected for now; the password is asked again after a restart
      }
    }
    return { ...(isPlainObject(result) ? result : { connected: true }), saved, warning };
  }

  async function disconnectMail() {
    const { services: svc } = await ready();
    const result = await svc.mail.disconnect(actor());
    secrets.remove(mailSecretName(current.id));
    settings.setWorkspace(current.id, { mail: null });
    return result ?? true;
  }

  async function pollMail() {
    const { services: svc } = await ready();
    return svc.mail.pollNow();
  }

  // The services keep the watched folder on the workspace and scan it on their own.
  async function setFolder(dir) {
    const { services: svc } = await ready();
    return svc.folder.set(dir, actor());
  }

  // ---------- settings ----------

  function publicSettings() {
    const s = settings.get();
    const mail = current ? settings.workspace(current.id).mail : null;
    let launchAtLogin = Boolean(s.launchAtLogin);
    try {
      launchAtLogin = system.getLaunchAtLogin ? Boolean(system.getLaunchAtLogin()) : launchAtLogin;
    } catch {
      // keep the saved value
    }
    return {
      ...s.prefs,
      autopilot: autopilotOn(),
      notifications: s.notifications !== false,
      launchAtLogin,
      userName: s.userName || null,
      model: s.model || null,
      models: config.AI_MODELS,
      hasOpenAIKey: secrets.has('openai'),
      secureStorage: secrets.available(),
      aiMode: ai?.mode || 'off',
      mailbox: mail ? { provider: mail.provider || null, email: mail.email || null, savedOnThisComputer: true } : null,
    };
  }

  // The patch is already checked by ipc.js. A new key or model restarts the agents with the new AI client.
  async function updateSettings(patch) {
    const { openaiKey, autopilot: autopilotPatch, launchAtLogin, notifications, model, userName, ...rest } = patch;
    let restart = false;
    if (openaiKey !== undefined) {
      if (openaiKey) await secrets.set('openai', openaiKey.trim());
      else secrets.remove('openai');
      restart = true;
    }
    if (model !== undefined) {
      settings.set({ model: model || null });
      restart = true;
    }
    if (notifications !== undefined) settings.set({ notifications });
    if (userName !== undefined) settings.set({ userName: userName || null });
    if (launchAtLogin !== undefined) {
      system.setLaunchAtLogin?.(launchAtLogin);
      settings.set({ launchAtLogin });
    }
    if (autopilotPatch !== undefined) await setAutopilot(autopilotPatch);
    const prefs = Object.fromEntries(Object.entries(rest).filter(([key]) => !INTERNAL_SETTINGS.has(key)));
    if (Object.keys(prefs).length) settings.set({ prefs: { ...settings.get().prefs, ...prefs } });
    if (restart && current) await openWorkspace(current);
    return publicSettings();
  }

  // ---------- the sample workspace ----------

  async function openSample() {
    const sampleId = settings.get().sampleWorkspaceId;
    if (current?.id !== sampleId) await openWorkspace({ kind: 'local', id: sampleId });
    return (await ready()).services;
  }

  // options.later: true delivers the papers that arrive late in the sample's story (the packing list). The services
  // give the sandbox the SAMPLE house's details the first time (pipeline/sample.js).
  async function loadSample(options = {}) {
    const svc = await openSample();
    return svc.loadSample({ later: options?.later === true });
  }

  async function resetSample() {
    return (await openSample()).resetSample();
  }

  // ---------- what the screens see ----------

  function info() {
    const s = settings.get();
    return {
      ready: Boolean(services),
      // Not called `error`: the screens treat any result with an `error` field as a failed call.
      startError: core.error ? `The agents could not start: ${core.error.message}` : lastError ? lastError.message : null,
      mode: current?.kind || 'local',
      workspaceId: current?.id || null,
      sample: Boolean(current && current.id === s.sampleWorkspaceId),
      cloud: Boolean(cloud),
      signedIn: Boolean(session),
      role: role(),
      deskAllowed: deskAllowed(),
      canApprove: canApprove(),
      ai: ai ? aiInfo(ai) : { mode: 'off', model: null, available: false, calls: 0, lastError: null },
      autopilot: autopilotOn(),
      secureStorage: secrets.available(),
    };
  }

  return {
    start,
    stop,
    ready,
    info,
    authStatus,
    signIn,
    signUp,
    signOut,
    personName,
    actor,
    deskAllowed,
    canApprove,
    listWorkspaces,
    selectWorkspace,
    currentWorkspace,
    createWorkspace,
    updateWorkspace,
    joinWorkspace,
    invite,
    revokeInvite,
    members,
    list,
    get,
    addFiles,
    documentFile,
    removeDocument,
    updateShipment,
    dismissQuestion,
    verifyStone,
    paperFile,
    sendMessage,
    autopilotOn,
    setAutopilot,
    onboardHouse,
    loadSanctions,
    sanctionsStatus,
    screenName,
    refreshSanctions,
    connectMail,
    disconnectMail,
    pollMail,
    setFolder,
    publicSettings,
    updateSettings,
    loadSample,
    resetSample,
  };
}

// What the screens may know about the AI: its mode and model, how many calls it made, and its last problem
// in plain words (a bad key, no credit, offline ...). Never the key.
function aiInfo(ai) {
  let calls = 0;
  try {
    calls = ai.usage?.().calls || 0;
  } catch {
    calls = 0;
  }
  const last = ai.lastError;
  return {
    mode: ai.mode,
    model: ai.model || null,
    available: Boolean(ai.available),
    calls,
    lastError: last ? { code: last.code || null, message: last.message || null, at: last.at || null } : null,
  };
}

function mailSecretName(workspaceId) {
  return `mail:${workspaceId}`;
}

// Waits for the promise, but never longer than ms (then carries on; the promise may still finish later).
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function withoutProtected(patch) {
  const copy = { ...patch };
  for (const key of PROTECTED_FIELDS) delete copy[key];
  return copy;
}

// A record matches when every filter key equals its value (an array means "any of these").
export function matches(row, filters) {
  for (const [key, want] of Object.entries(filters || {})) {
    if (want === undefined) continue;
    const have = row?.[key];
    if (Array.isArray(want) ? !want.includes(have) : have !== want) return false;
  }
  return true;
}

// Newest first, by the activity time or when the record was created.
export function newestFirst(a, b) {
  const time = (r) => String(r?.at || r?.createdAt || r?.updatedAt || '');
  return time(b).localeCompare(time(a));
}

// The audit line for a lab check. A check that could not run (no online check, the window closed, a timeout)
// never reads as "not found": that would sound like a fake report.
export function labCheckDetail(stone, result) {
  const name = `${stone.lab || 'Lab'} report ${stone.reportNumber}`;
  if (result.status === 'match') return `${name} matches the lab's record.`;
  if (result.status === 'mismatch') {
    const fields = (result.diffs || []).map((d) => d.field).join(', ');
    return `${name} differs from the lab's record${fields ? `: ${fields}` : ''}.`;
  }
  if (result.status === 'unavailable') return `${name} could not be checked: ${result.reason || 'the lab has no online report check.'}`;
  if (result.status === 'incomplete') return `${name} was not checked: ${result.reason || 'the check did not finish.'}`;
  return `${name} could not be confirmed on the lab's site.`;
}
