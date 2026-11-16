// The worker keeps the agents going on their own. Every few minutes it pulls new mail from the connected
// mailbox, picks up new files in the watched folder, retries documents that failed, and starts a run.
import fs from 'node:fs/promises';
import { MAILBOX_POLL_MINUTES } from '../config.js';
import { listFiles, readBytes, safeFileName } from './files.js';
import { plural } from './context.js';
import { MAX_RETRIES } from './retrieval.js';

const FIRST_POLL_DAYS = 14; // a new mailbox: look this far back the first time
const SEEN_IDS_KEPT = 1000;
const SETTLE_MS = 5000; // a file changed in the last few seconds may still be copying in
const FOLDER_BATCH = 10; // read at most this many files into memory at once

/** deps: { addFiles, run, needsRun, isAutopilot, getMailConfig, getFolderState, intervalMinutes } */
export function createWorker(ctx, { addFiles, run, needsRun, isAutopilot, getMailConfig, getFolderState, intervalMinutes = MAILBOX_POLL_MINUTES }) {
  const intervalMs = intervalMinutes * 60 * 1000;
  let timer = null;
  let ticking = null;
  const state = {
    lastPollAt: null, nextPollAt: null, lastError: null,
    mail: { lastPollAt: null, error: null, pulled: 0 },
    folder: { lastScanAt: null, error: null, picked: 0 },
    retried: 0,
  };

  async function start() {
    if (timer) return status();
    await recoverStale();
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs); // errors are kept in status()
    if (timer.unref) timer.unref();
    state.nextPollAt = new Date(Date.now() + intervalMs).toISOString();
    ctx.background(tick());
    return status();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    state.nextPollAt = null;
  }

  /** One round. A second call while a round is going waits for that round. */
  function tick() {
    if (!ticking) ticking = round().finally(() => { ticking = null; });
    return ticking;
  }

  async function round() {
    state.lastError = null;
    await step(pollMailbox, 'mail');
    await step(scanFolder, 'folder');
    await step(async () => {
      if (!(await isAutopilot())) return; // autopilot off: files come in, but the agents wait for a person
      await retryFailed();
      if (await needsRun()) await run({ reason: 'worker' });
    }, null);
    state.lastPollAt = ctx.nowIso();
    state.nextPollAt = timer ? new Date(Date.now() + intervalMs).toISOString() : null;
    return status();
  }

  // Each part catches its own error, so a mailbox problem never stops the folder or the retries.
  async function step(fn, part) {
    try {
      await fn();
      if (part) state[part].error = null;
    } catch (err) {
      state.lastError = err.message;
      if (part) state[part].error = err.message;
      ctx.agentEvent('retrieval', 'error', err.message);
    }
  }

  /** "Check now" buttons: same as the loop, but the error comes back to the caller. */
  async function pollNow() {
    await step(pollMailbox, 'mail');
    if (state.mail.error) throw new Error(state.mail.error);
    return status();
  }

  async function scanNow() {
    await step(scanFolder, 'folder');
    if (state.folder.error) throw new Error(state.folder.error);
    return status();
  }

  async function pollMailbox() {
    const config = getMailConfig();
    if (!config) return { skipped: 'no mailbox' };
    const workspace = await ctx.store.workspace();
    if (workspace.permissions?.searchMailbox === false) return { skipped: 'the house turned mailbox search off' };
    const mail = await ctx.load('mail');
    const saved = workspace.mailbox || {};
    const since = new Date(saved.lastSeenAt || saved.since || Date.now() - FIRST_POLL_DAYS * 24 * 3600 * 1000);
    const domains = ctx.houseSetting(workspace, 'emailDomains') || [];
    const seen = new Set(saved.seen || []);

    const mailbox = await mail.connectMailbox(config);
    let messages;
    try {
      messages = await mailbox.fetchSince(since, { domains });
    } finally {
      await mailbox.close().catch(() => {});
    }

    // IMAP "since" works by whole days, so the same mail comes back each poll: skip what we already took.
    const files = [];
    let lastSeenAt = saved.lastSeenAt || null;
    for (const message of messages) {
      const id = message.messageId || `uid:${message.uid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      files.push({
        name: `${safeFileName(message.subject || 'Email')}.eml`,
        bytes: message.eml,
        source: { kind: 'email', from: message.from, ref: message.subject, receivedAt: message.date || ctx.nowIso() },
      });
      if (message.date && (!lastSeenAt || message.date > lastSeenAt)) lastSeenAt = message.date;
    }
    const added = files.length ? await addFiles(files, { quiet: true }) : { documentIds: [] };
    const latest = await ctx.store.workspace();
    await ctx.store.updateWorkspace({
      mailbox: { ...(latest.mailbox || saved), lastSeenAt, lastPollAt: ctx.nowIso(), seen: [...seen].slice(-SEEN_IDS_KEPT) },
    });
    state.mail.lastPollAt = ctx.nowIso();
    state.mail.pulled += files.length;
    if (files.length) {
      await ctx.log(ctx.agentActor('retrieval'), 'pulled', `Pulled ${plural(files.length, 'new email')} from ${config.email}`);
    }
    return { messages: messages.length, added: added.documentIds.length };
  }

  async function scanFolder() {
    const folder = await getFolderState();
    const { path: folderPath, seen: seenBefore } = folder.get();
    if (!folderPath) return { skipped: 'no folder' };
    const files = await listFiles(folderPath);
    const seen = { ...(seenBefore || {}) };
    const changed = files.filter((f) => seen[f.rel] !== stamp(f) && Date.now() - f.mtimeMs > SETTLE_MS);
    let picked = 0;
    let already = 0;
    for (let i = 0; i < changed.length; i += FOLDER_BATCH) {
      const batch = [];
      for (const file of changed.slice(i, i + FOLDER_BATCH)) {
        batch.push({ name: file.rel.split('/').pop(), bytes: await readBytes(file.full), source: { kind: 'folder', ref: file.rel } });
        seen[file.rel] = stamp(file);
      }
      const result = await addFiles(batch, { quiet: true }); // the same file under a new name is caught by its SHA-256
      picked += result.documentIds.length;
      already += result.duplicates.length;
      folder.set({ seen });
      await folder.save(); // after every batch, so a crash does not mean reading the whole folder again
    }
    folder.set({ seen, lastScanAt: ctx.nowIso() });
    await folder.save();
    state.folder.lastScanAt = ctx.nowIso();
    state.folder.picked += picked;
    if (picked) await ctx.log(ctx.agentActor('retrieval'), 'picked', `Picked up ${plural(picked, 'new file')} from ${folderPath}`);
    if (already) await ctx.log(ctx.agentActor('retrieval'), 'skipped', `${plural(already, 'file')} in ${folderPath} already on file`);
    return { files: files.length, picked };
  }

  async function retryFailed() {
    const failed = await ctx.store.list('documents', (d) => d.status === 'error' && (d.retries || 0) < MAX_RETRIES);
    for (const doc of failed) await ctx.store.put('documents', { ...doc, status: 'new', retries: (doc.retries || 0) + 1 });
    state.retried += failed.length;
    return { retried: failed.length };
  }

  /** After a crash, a document left half-read is read again from the start. */
  async function recoverStale() {
    const stale = await ctx.store.list('documents', (d) => d.status === 'reading');
    for (const doc of stale) await ctx.store.put('documents', { ...doc, status: 'new' });
  }

  async function status() {
    const docs = await ctx.store.list('documents');
    const count = (s) => docs.filter((d) => d.status === s).length;
    return {
      running: Boolean(timer),
      intervalMinutes,
      lastPollAt: state.lastPollAt,
      nextPollAt: state.nextPollAt,
      lastError: state.lastError,
      counts: {
        documents: docs.length, new: count('new'), reading: count('reading'), read: count('read'), error: count('error'),
        pulledFromMail: state.mail.pulled, pickedFromFolder: state.folder.picked, retried: state.retried,
      },
      mail: { ...state.mail },
      folder: { ...state.folder },
    };
  }

  return { start, stop, tick, status, pollNow, scanNow, retryFailed };
}

function stamp(file) {
  return `${Math.round(file.mtimeMs)}:${file.size}`;
}

/** Checks that a folder exists before it is watched. */
export async function checkFolder(folderPath) {
  const stat = await fs.stat(folderPath).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('That folder could not be opened.');
  return folderPath;
}
