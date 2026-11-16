// The worker keeps the agents going on their own. Every few minutes it pulls new mail from the connected
// mailbox, picks up new files in the watched folder, retries documents that failed, and starts a run.
import fs from 'node:fs/promises';
import { MAILBOX_POLL_MINUTES } from '../config.js';
import { listFiles, readBytes, safeFileName } from './files.js';
import { plural } from './context.js';
import { MAX_RETRIES } from './retrieval.js';

const FIRST_POLL_DAYS = 14; // a new mailbox: look this far back the first time
const DAY_MS = 24 * 3600 * 1000;
const SEEN_IDS_KEPT = 1000;
const MAIL_PAGES_PER_POLL = 5; // pages of messages looked at in one poll; a bigger backlog goes on next poll
const SETTLE_MS = 5000; // a file changed in the last few seconds may still be copying in
const FOLDER_BATCH = 10; // read at most this many files into memory at once
const MAX_AI_REREADS = 3; // a paper read offline is read again with the AI at most this many times
const CLOSED = ['signed', 'sent'];
// An email or file is marked "in flight" while it is added. If the app stops then (it froze or crashed on that
// input), the next start finds it still in flight and does not add it again: it becomes a paper with this reason.
export const STUCK_EMAIL = 'This email stopped the agents while it was read, so it was not read again. Save its attachments and add them by hand.';
export const STUCK_FILE = 'This file stopped the agents while it was read, so it was not read again. Save it again (as PDF, say) and add it by hand.';

/** deps: { addFiles, run, needsRun, isAutopilot, getMailConfig, getMailboxState, getFolderState, intervalMinutes } */
export function createWorker(ctx, {
  addFiles, run, needsRun, isAutopilot, getMailConfig, getMailboxState, getFolderState, intervalMinutes = MAILBOX_POLL_MINUTES,
}) {
  const intervalMs = intervalMinutes * 60 * 1000;
  let timer = null;
  let ticking = null;
  const pulling = { mail: null, folder: null }; // the mail poll and folder scan going on now
  const state = {
    lastPollAt: null, nextPollAt: null, lastError: null,
    mail: { lastPollAt: null, error: null, pulled: 0 },
    folder: { lastScanAt: null, error: null, picked: 0, problems: [] },
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
    await once('mail', pollMailbox);
    await once('folder', scanFolder);
    await step(async () => {
      if (!(await isAutopilot())) return; // autopilot off: files come in, but the agents wait for a person
      await retryFailed();
      await rereadWithAi();
      // Not awaited: while the agents work through a big batch, the next mail and folder checks still come on time.
      if (await needsRun()) ctx.background(run({ reason: 'worker' }));
    }, null);
    state.lastPollAt = ctx.nowIso();
    state.nextPollAt = timer ? new Date(Date.now() + intervalMs).toISOString() : null;
    return status();
  }

  /** One mail poll (or folder scan) at a time: the loop and "Check now" share the one going on, never run two. */
  function once(part, fn) {
    if (!pulling[part]) pulling[part] = step(fn, part).finally(() => { pulling[part] = null; });
    return pulling[part];
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
    await once('mail', pollMailbox);
    if (state.mail.error) throw new Error(state.mail.error);
    return status();
  }

  async function scanNow() {
    await once('folder', scanFolder);
    if (state.folder.error) throw new Error(state.folder.error);
    return status();
  }

  /**
   * Pulls new mail from the mailbox connected on this computer, oldest first. Its progress (the last message looked
   * at) is kept on this computer too, so every message is looked at once, however much mail arrives in between.
   */
  async function pollMailbox() {
    const config = getMailConfig();
    if (!config) return { skipped: 'no mailbox' };
    const workspace = await ctx.store.workspace();
    if (workspace.permissions?.searchMailbox === false) return { skipped: 'the house turned mailbox search off' };
    // Only mail from the domains typed in when the mailbox was connected. With none, no mail comes in at all.
    if (!config.domains?.length) throw new Error('Add the email domains of your brokers, labs and shippers: only their mail is brought in.');
    const box = await getMailboxState();
    const saved = box.get().email === config.email ? box.get() : {}; // another mailbox's progress is not this one's
    const since = new Date(saved.lastSeenAt || saved.since || Date.now() - FIRST_POLL_DAYS * DAY_MS);
    const seen = new Set(saved.seen || []);
    const stuck = new Set(saved.inFlight || []); // added when the app stopped last time
    let cursor = { lastUid: saved.lastUid || 0, uidValidity: saved.uidValidity ?? null };
    let lastSeenAt = saved.lastSeenAt || null;
    const files = [];
    const tooBig = []; // messages too big to download: said once, here, so the house can add their papers by hand

    const mail = await ctx.load('mail');
    const mailbox = await mail.connectMailbox(config);
    try {
      for (let page = 0; page < MAIL_PAGES_PER_POLL; page += 1) {
        const messages = await mailbox.fetchSince(since, { domains: config.domains, afterUid: cursor.lastUid, uidValidity: cursor.uidValidity });
        // A message seen before (the first look goes back by whole days) is skipped by its id.
        for (const message of messages) {
          const id = message.messageId || `uid:${message.uid}`;
          if (seen.has(id) || files.some((f) => f.id === id)) continue;
          files.push({
            id,
            name: `${safeFileName(message.subject || 'Email')}.eml`,
            bytes: message.eml,
            source: { kind: 'email', from: message.from, ref: message.subject, receivedAt: message.date || ctx.nowIso() },
          });
          if (message.date && (!lastSeenAt || message.date > lastSeenAt)) lastSeenAt = message.date;
        }
        tooBig.push(...(messages.tooBig || []));
        if (messages.lastUid !== undefined) cursor = { lastUid: messages.lastUid, uidValidity: messages.uidValidity ?? null };
        if (!messages.more) break;
      }
    } finally {
      await mailbox.close().catch(() => {});
    }

    // One email at a time: each is saved as in flight before it is added and as seen once it is in, so an email that
    // freezes or crashes the app is never pulled in again on every start.
    const added = { documentIds: [] };
    for (const { id, ...file } of files) {
      const input = stuck.has(id) ? { ...file, error: STUCK_EMAIL } : file;
      box.set({ email: config.email, inFlight: [id], seen: [...seen].slice(-SEEN_IDS_KEPT) });
      await box.save();
      const result = await addFiles([input], { quiet: true }).catch(async (err) => {
        box.set({ inFlight: [] }); // an error is not a crash: the email is tried again next poll
        await box.save();
        throw err;
      });
      added.documentIds.push(...result.documentIds);
      seen.add(id);
      box.set({ inFlight: [], seen: [...seen].slice(-SEEN_IDS_KEPT) });
      await box.save();
    }
    box.set({
      email: config.email, lastUid: cursor.lastUid, uidValidity: cursor.uidValidity, lastSeenAt,
      lastPollAt: ctx.nowIso(), seen: [...seen].slice(-SEEN_IDS_KEPT), inFlight: [],
    });
    await box.save();
    state.mail.lastPollAt = ctx.nowIso();
    state.mail.pulled += files.length;
    if (files.length) {
      await ctx.log(ctx.agentActor('retrieval'), 'pulled', `Pulled ${plural(files.length, 'new email')} from ${config.email}`);
    }
    for (const big of tooBig) {
      const detail = `An email${big.from ? ` from ${big.from}` : ''}${big.subject ? ` ("${big.subject}")` : ''} is ${Math.round(big.size / (1024 * 1024))} MB, too big to bring in. Save its attachments and add them by hand.`;
      ctx.agentEvent('retrieval', 'error', detail);
      await ctx.log(ctx.agentActor('retrieval'), 'error', detail);
    }
    return { messages: files.length, added: added.documentIds.length };
  }

  async function scanFolder() {
    const folder = await getFolderState();
    const { path: folderPath, seen: seenBefore, inFlight: stuck = {} } = folder.get();
    if (!folderPath) {
      state.folder.problems = [];
      return { skipped: 'no folder' };
    }
    const files = await listFiles(folderPath);
    const seen = { ...(seenBefore || {}) };
    const changed = files.filter((f) => seen[f.rel] !== stamp(f) && Date.now() - f.mtimeMs > SETTLE_MS);
    const problems = [];
    let picked = 0;
    let already = 0;
    for (let i = 0; i < changed.length; i += FOLDER_BATCH) {
      const batch = [];
      const taken = [];
      for (const file of changed.slice(i, i + FOLDER_BATCH)) {
        // One file that cannot be read (open in another program, no permission) must not stop the others.
        try {
          batch.push({ name: file.rel.split('/').pop(), bytes: await readBytes(file.full), source: { kind: 'folder', ref: file.rel } });
          taken.push(file);
        } catch (err) {
          problems.push({ file: file.rel, reason: unreadable(err) }); // not marked as seen: tried again next round
        }
      }
      // One file at a time: in flight while it is added, seen once the agents have it. A file still in flight from
      // the last start (it stopped the app) is not added again. The same file under a new name is caught by its SHA-256.
      for (let k = 0; k < batch.length; k += 1) {
        const file = taken[k];
        const input = stuck[file.rel] === stamp(file) ? { ...batch[k], error: STUCK_FILE } : batch[k];
        folder.set({ seen: { ...seen }, inFlight: { [file.rel]: stamp(file) } });
        await folder.save();
        const result = await addFiles([input], { quiet: true }).catch(async (err) => {
          folder.set({ inFlight: {} }); // an error is not a crash: the file is tried again next round
          await folder.save();
          throw err;
        });
        seen[file.rel] = stamp(file);
        picked += result.documentIds.length;
        already += result.duplicates.length;
        folder.set({ seen: { ...seen }, inFlight: {} });
        await folder.save(); // after every file, so a crash does not mean reading the whole folder again
      }
    }
    folder.set({ seen: { ...seen }, inFlight: {}, lastScanAt: ctx.nowIso() });
    await folder.save();
    await reportProblems(problems, folderPath);
    state.folder.lastScanAt = ctx.nowIso();
    state.folder.picked += picked;
    if (picked) await ctx.log(ctx.agentActor('retrieval'), 'picked', `Picked up ${plural(picked, 'new file')} from ${folderPath}`);
    if (already) await ctx.log(ctx.agentActor('retrieval'), 'skipped', `${plural(already, 'file')} in ${folderPath} already on file`);
    return { files: files.length, picked, problems: problems.length };
  }

  /** Files that could not be read are shown in the folder status. Each one is logged once, when it first fails. */
  async function reportProblems(problems, folderPath) {
    const before = new Set(state.folder.problems.map((p) => p.file));
    const fresh = problems.filter((p) => !before.has(p.file));
    state.folder.problems = problems;
    if (!fresh.length) return;
    const detail = `${plural(fresh.length, 'file')} in ${folderPath} could not be read: ${fresh.map((p) => `${p.file} (${p.reason})`).join(', ')}. `
      + `The agents try again every ${plural(intervalMinutes, 'minute')}.`;
    ctx.agentEvent('retrieval', 'error', detail);
    await ctx.log(ctx.agentActor('retrieval'), 'error', detail);
  }

  async function retryFailed() {
    const failed = await ctx.store.list('documents', (d) => d.status === 'error' && (d.retries || 0) < MAX_RETRIES);
    for (const doc of failed) await ctx.store.put('documents', { ...doc, status: 'new', retries: (doc.retries || 0) + 1 });
    state.retried += failed.length;
    return { retried: failed.length };
  }

  /**
   * Papers the offline reader read because the AI could not be reached are read again once it answers. One small
   * call checks the AI first, only while such papers wait. A signed or sent shipment's papers are left as they are.
   */
  async function rereadWithAi() {
    const waiting = await ctx.store.list('documents', (d) => d.needsAiRead && d.status === 'read' && (d.aiRereads || 0) < MAX_AI_REREADS);
    if (!waiting.length) return { reread: 0 };
    const closed = new Set((await ctx.store.list('shipments', (s) => CLOSED.includes(s.status))).map((s) => s.id));
    const docs = waiting.filter((d) => !closed.has(d.shipmentId));
    if (!docs.length) return { reread: 0 };
    const ai = await ctx.getAI();
    if (!ai?.available || typeof ai.check !== 'function' || !(await ai.check()).ok) return { reread: 0 };
    for (const doc of docs) {
      const latest = await ctx.store.get('documents', doc.id);
      if (latest && latest.status === 'read' && latest.needsAiRead) {
        await ctx.store.put('documents', { ...latest, status: 'new', needsAiRead: false, aiRereads: (latest.aiRereads || 0) + 1 });
      }
    }
    if (docs.length) await ctx.log(ctx.agentActor('intake'), 'reading again', `The AI answers again: reading ${plural(docs.length, 'paper')} the offline reader read meanwhile`);
    return { reread: docs.length };
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

  return { start, stop, tick, status, pollNow, scanNow, retryFailed, rereadWithAi };
}

function stamp(file) {
  return `${Math.round(file.mtimeMs)}:${file.size}`;
}

/** Why a file in the watched folder could not be read, in plain words. */
function unreadable(err) {
  if (err?.code === 'EBUSY' || err?.code === 'EPERM') return 'in use by another program';
  if (err?.code === 'EACCES') return 'no permission to read it';
  if (err?.code === 'ENOENT') return 'removed while it was being read';
  return err?.message || String(err);
}

/** Checks that a folder exists before it is watched. */
export async function checkFolder(folderPath) {
  const stat = await fs.stat(folderPath).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('That folder could not be opened.');
  return folderPath;
}
