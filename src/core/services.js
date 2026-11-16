// createServices(): the one object the Electron main process talks to. It wires the agents, the store,
// the mailbox and the worker together. Every dependency comes in as an argument, so tests can pass fakes.
import { SAMPLES_DIR, MAILBOX_POLL_MINUTES } from './config.js';
import { createModuleLoader } from './pipeline/modules.js';
import { createContext, reportKey, byNewest, personName } from './pipeline/context.js';
import { createRunner } from './pipeline/runner.js';
import { createWorker, checkFolder } from './pipeline/worker.js';
import { addFiles, addGeneratedDocument } from './pipeline/retrieval.js';
import { buildPapers } from './pipeline/paperwork.js';
import { signPaper, sendPaper } from './pipeline/signing.js';
import { answerQuestion, dismissQuestion } from './pipeline/answers.js';
import { createDesk } from './pipeline/desk.js';
import { ask } from './pipeline/ask.js';
import { loadSample, resetSample } from './pipeline/sample.js';
import { createFolderState, createMailboxState } from './pipeline/folder-state.js';
import { cleanDomains } from './mail/domains.js';

/**
 * store, ai, sanctionsLoader, ocr, labsVerify?, rasterize?, notify?, paths, deviceId, clock?, lease? as in ARCHITECTURE.md.
 * Extra, optional: pace (ms between live field events, 0 in tests), modules (fake core modules for tests),
 * pollMinutes (worker interval), getMembers (the house's logins, for metrics), parallel (how many papers are read at
 * once; the demo recording reads one at a time so the replay follows them in order), pageDrawTimeoutMs (how long
 * drawing one page of a scan may take, 60 s; shorter in tests).
 */
export function createServices({
  store, ai, sanctionsLoader, ocr, labsVerify, rasterize, notify, paths = {}, deviceId = 'this-computer', clock, lease,
  pace = 120, modules = {}, pollMinutes = MAILBOX_POLL_MINUTES, getMembers, parallel, pageDrawTimeoutMs,
}) {
  if (!store) throw new Error('createServices needs a store.');
  const load = createModuleLoader(modules);
  const ctx = createContext({ store, ai, ocr, rasterize, notify, paths, deviceId, clock, pace, load, sanctionsLoader, labsVerify, pageDrawTimeoutMs });
  let mailConfig = null; // the mailbox login, kept in memory only (main stores the app password with safeStorage)

  const isAutopilot = async () => (await store.workspace()).autopilot !== false;
  const runner = createRunner(ctx, { lease, isAutopilot, parallel }); // parallel: papers read at once (default 3)
  const run = (options) => runner.run(options || {});
  const build = (shipmentId, options) => buildPapers(ctx, shipmentId, options);

  // Retrieval, then (autopilot on) the rest of the agents start on their own without making the caller wait.
  async function addAndRun(files, options) {
    const result = await addFiles(ctx, files, options);
    if (result.documentIds.length && (await isAutopilot())) ctx.background(run({ reason: 'new files' }));
    return result;
  }

  // The watched folder and the mailbox are kept per computer (see pipeline/folder-state.js), next to the app's cache.
  let folderState = null;
  async function getFolderState() {
    if (!folderState) folderState = createFolderState(paths.cacheDir || null, (await store.workspace()).id);
    await folderState.load();
    return folderState;
  }
  let mailboxState = null;
  async function getMailboxState() {
    if (!mailboxState) mailboxState = createMailboxState(paths.cacheDir || null, (await store.workspace()).id);
    await mailboxState.load();
    return mailboxState;
  }

  const worker = createWorker(ctx, {
    addFiles: addAndRun, run, needsRun: runner.needsRun, isAutopilot, getMailConfig: () => mailConfig,
    getMailboxState, getFolderState, intervalMinutes: pollMinutes,
  });
  const desk = createDesk(ctx, { run, buildPapers: build });
  if (typeof store.on === 'function') store.on('change', (change) => ctx.events.emit('change', change));

  // ---- stone history, lab check, metrics ----

  async function history(reportNumber) {
    const key = reportKey(reportNumber);
    const stone = key ? (await store.list('stones', (s) => reportKey(s.reportNumber) === key)).sort(byNewest)[0] : null;
    if (!stone) return { stone: null, shipment: null, events: [] };
    const shipment = await store.get('shipments', stone.shipmentId);
    const documents = await store.list('documents', (d) => d.status === 'read'); // rough-side papers may sit elsewhere
    const papers = await store.list('papers', (p) => p.shipmentId === stone.shipmentId);
    const records = await load('records');
    const events = (await records.buildHistory({ stone, shipment, documents, papers })) || stone.history || [];
    return { stone, shipment, events };
  }

  /**
   * Checks one stone on the lab's own website. labsVerify(stone) (src/main/labs-window.js) opens the official
   * report check, reads it and compares it: { status: 'match'|'mismatch'|'not_found', diffs, reason?, lab, url }.
   */
  async function verifyStone(stoneId, by) {
    const stone = await store.get('stones', stoneId);
    if (!stone) throw new Error('That stone is no longer there.');
    if (typeof labsVerify !== 'function') throw new Error('Lab checks are not available in this copy of the app.');
    const result = (await labsVerify(stone)) || { status: 'not_found', diffs: [] };
    const labCheck = {
      status: result.status, diffs: result.diffs || [], reason: result.reason || null, lab: result.lab || stone.lab || null,
      url: result.url || null, checkedAt: ctx.nowIso(), checkedBy: personName(by),
    };
    await store.put('stones', { ...stone, labCheck });
    const detail = labCheckDetail(stone, labCheck);
    ctx.agentEvent('records', 'check', detail, { shipmentId: stone.shipmentId });
    await ctx.log(ctx.personActor(by), 'lab check', detail, { shipmentId: stone.shipmentId });
    if (stone.shipmentId) ctx.background(run({ shipmentId: stone.shipmentId, reason: 'lab check' })); // the rules see the result
    return labCheck;
  }

  /** Usage numbers for this house (src/core/metrics.js). members: optional async () => [{ id, name, email, role, test }]. */
  async function metrics() {
    const house = {
      workspace: await store.workspace(),
      events: await store.list('events'),
      papers: await store.list('papers'),
      shipments: await store.list('shipments'),
      // Which shipment each paper was filed under: an upload event only knows its document.
      documents: (await store.list('documents')).map((d) => ({ id: d.id, shipmentId: d.shipmentId || null })),
      questions: (await store.list('questions', (q) => q.status === 'dismissed'))
        .map((q) => ({ shipmentId: q.shipmentId || null, kind: q.kind, status: q.status, closedBy: q.closedBy || null })),
      members: typeof getMembers === 'function' ? (await getMembers()) || [] : [],
    };
    return (await load('metrics')).computeMetrics({ workspaces: [house], now: ctx.now() });
  }

  // ---- mailbox ----

  async function mailStatus() {
    const saved = (await getMailboxState()).get();
    const w = await worker.status();
    // Connected by an older copy of the app with no domains: it brings in nothing until it is connected again.
    const needsDomains = Boolean(saved.email && saved.connected && !mailConfig && !(saved.domains || []).length);
    return {
      connected: Boolean(mailConfig),
      provider: mailConfig?.provider || saved.provider || null,
      email: mailConfig?.email || saved.email || null,
      domains: mailConfig?.domains || saved.domains || [],
      lastPollAt: w.mail.lastPollAt || saved.lastPollAt || null,
      lastSeenAt: saved.lastSeenAt || null,
      nextPollAt: mailConfig ? w.nextPollAt : null,
      lastError: w.mail.error || (needsDomains ? NO_DOMAINS : null),
      pulled: w.mail.pulled,
      // Connected on this computer before, but the app restarted without the app password: sign in again.
      needsPassword: Boolean(saved.email && saved.connected && !mailConfig),
      needsDomains,
    };
  }

  // The mailbox, its domains and how far the agents got in it belong to this computer: nothing about it goes into
  // the shared workspace, so a colleague's mailbox never mixes with this one, and nobody else can widen its domains.
  const mail = {
    /** options: { provider, email, appPassword, domains, host?, port?, smtpHost?, smtpPort?, since?, test?, by? } */
    async connect(options = {}) {
      const config = mailSettings(options);
      if (options.test !== false) {
        const mailbox = (await load('mail')).connectMailbox(config);
        try { await mailbox.test(); } finally { await mailbox.close().catch(() => {}); }
      }
      mailConfig = config;
      const box = await getMailboxState();
      const old = box.get().email === config.email ? box.get() : {}; // another mailbox starts from the beginning
      box.replace({
        ...old, email: config.email, provider: config.provider, host: config.host || null, domains: config.domains,
        since: options.since || old.since || null, connected: true, connectedAt: ctx.nowIso(),
      });
      await box.save();
      if (!old.connected) {
        await ctx.log(ctx.personActor(options.by), 'connected', `Connected the mailbox ${config.email}. The agents check it every ${pollMinutes} minutes for mail from ${config.domains.join(', ')}.`);
      }
      if (options.pollNow !== false) ctx.background(worker.pollNow());
      return mailStatus();
    },
    status: mailStatus,
    async disconnect(by) {
      mailConfig = null;
      const box = await getMailboxState();
      const email = box.get().email || '';
      box.set({ connected: false, disconnectedAt: ctx.nowIso() });
      await box.save();
      await ctx.log(ctx.personActor(by), 'disconnected', `Disconnected the mailbox ${email}`.trim());
      return mailStatus();
    },
    async pollNow() {
      if (!mailConfig) throw new Error('Connect a mailbox first.');
      await worker.pollNow();
      return mailStatus();
    },
  };

  // ---- watched folder ----

  async function folderStatus() {
    const state = (await getFolderState()).get();
    const w = await worker.status();
    return {
      path: state.path, watching: Boolean(state.path), lastScanAt: w.folder.lastScanAt || state.lastScanAt || null,
      files: Object.keys(state.seen || {}).length, lastError: w.folder.error,
      problems: w.folder.problems, // [{ file, reason }]: files that could not be read in the last scan
    };
  }

  const folder = {
    /** Main keeps the path in its own settings and calls set() again at start-up: only a new folder is logged. */
    async set(folderPath, by) {
      const state = await getFolderState();
      const before = state.get().path;
      if (!folderPath) {
        state.set({ path: null });
        await state.save();
        if (before) await ctx.log(ctx.personActor(by), 'folder', 'Stopped watching the folder');
        return folderStatus();
      }
      await checkFolder(folderPath);
      if (before !== folderPath) {
        state.set({ path: folderPath, seen: {}, inFlight: {}, lastScanAt: null });
        await state.save();
        await ctx.log(ctx.personActor(by), 'folder', `Watching ${folderPath}. New files there go to the agents.`);
      }
      ctx.background(worker.scanNow());
      return folderStatus();
    },
    status: folderStatus,
  };

  return {
    events: ctx.events,
    addFiles: addAndRun,
    run,
    idle: runner.idle, // resolves when every run, background step and live event is done
    autopilot: {
      get: isAutopilot,
      async set(on, by) {
        if ((await isAutopilot()) === Boolean(on)) return Boolean(on); // no change: nothing to log
        await store.updateWorkspace({ autopilot: Boolean(on) });
        const detail = on ? 'Autopilot on: the agents build the papers on their own' : 'Autopilot off: the papers wait for a person';
        await ctx.log(by ? ctx.personActor(by) : ctx.systemActor(), 'autopilot', detail);
        if (on) ctx.background(run({ reason: 'autopilot on' }));
        return Boolean(on);
      },
    },
    ask: (text, options = {}) => ask(ctx, { run, buildPapers: build, addGeneratedDocument: (input) => addGeneratedDocument(ctx, input) }, text, options),
    answerQuestion: (id, answer, by) => answerQuestion(ctx, { run }, id, answer, by),
    dismissQuestion: (id, by) => dismissQuestion(ctx, { run }, id, by),
    buildPapers: (shipmentId, options = {}) => build(shipmentId, options),
    signPaper: (paperId, signature, by) => signPaper(ctx, paperId, signature, by, {
      recheck: (shipmentId) => ctx.background(run({ shipmentId, reason: 'checked again before signing' })),
    }),
    sendPaper: (paperId, message, by) => sendPaper(ctx, paperId, message, by, { mailConfig }),
    desk,
    history,
    verifyStone,
    metrics,
    mail,
    folder,
    worker: { start: worker.start, stop: worker.stop, status: worker.status, tick: worker.tick },
    // loadSample() adds the SAMPLE papers except the late ones; loadSample({ later: true }) delivers those.
    loadSample: (options = {}) => loadSample(ctx, { addFiles: addAndRun, samplesDir: paths.samplesDir || SAMPLES_DIR, later: Boolean(options?.later) }),
    resetSample: () => resetSample(ctx),
    async shutdown() {
      worker.stop();
      if (ctx.ocr && typeof ctx.ocr.terminateOcr === 'function') await ctx.ocr.terminateOcr().catch(() => {});
    },
  };
}

function labCheckDetail(stone, check) {
  const name = `${check.lab || 'Lab'} report ${stone.reportNumber}`;
  if (check.status === 'match') return `${name} matches our record`;
  if (check.status === 'mismatch') return `${name} differs from our record: ${check.diffs.map((d) => d.field).join(', ')}`;
  if (check.status === 'unavailable') return `${name} could not be checked: ${check.reason || 'the lab has no online report check'}`;
  if (check.status === 'incomplete') return `${name} was not checked: ${check.reason || 'the check did not finish'}`;
  return `${name} was not found on the lab's site${check.reason ? `: ${check.reason}` : ''}`;
}

const NO_DOMAINS = 'Add the email domains of your brokers, labs and shippers first. The agents bring in mail from those domains only.';

/**
 * The login the mail module needs. Spaces are taken out of the app password (Google shows it in groups of four).
 * Mail is brought in only from the domains given here (brokers, labs, shippers), never from the house's own domain.
 */
function mailSettings(options) {
  const email = String(options.email || '').trim();
  const appPassword = String(options.appPassword || '').replace(/\s+/g, '');
  if (!email || !appPassword) throw new Error('Add the email address and its app password first.');
  const own = email.toLowerCase().split('@')[1] || '';
  const domains = cleanDomains(options.domains).filter((d) => d !== own);
  if (!domains.length) throw Object.assign(new Error(NO_DOMAINS), { code: 'no_domains' });
  return {
    provider: options.provider || 'gmail', email, appPassword, domains,
    host: options.host || undefined, port: options.port || undefined,
    smtpHost: options.smtpHost || undefined, smtpPort: options.smtpPort || undefined,
  };
}
