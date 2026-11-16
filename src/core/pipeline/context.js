// The shared toolbox every agent step gets: the store, the clock, the activity log, live events and
// notifications. Keeping these in one object means each stage file stays short and easy to follow.
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { AGENT_BY_ID } from '../types.js';

// When this many field events are waiting to be shown, show the rest at once so the view never lags far behind.
const MAX_PACED_BACKLOG = 40;
const SDN_MEMO_MS = 60 * 60 * 1000; // re-read the sanctions list at most once an hour

export function createContext({
  store, ai, ocr, rasterize, notify, paths = {}, deviceId = 'this-computer', clock, pace = 0, load, sanctionsLoader, labsVerify,
  pageDrawTimeoutMs,
}) {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const background = new Set();
  let playback = Promise.resolve();
  let waitingToShow = 0;
  let sdn = { index: null, at: 0 };

  const ctx = { store, ai, ocr, rasterize, paths, deviceId, events, load, labsVerify, pace, pageDrawTimeoutMs };

  ctx.now = () => (clock ? new Date(clock()) : new Date());
  ctx.nowIso = () => ctx.now().toISOString();

  // ---- activity log: every step by an agent or a person ----
  ctx.agentActor = (agentId) => ({ type: 'agent', name: AGENT_BY_ID[agentId]?.name || agentId });
  ctx.personActor = (by) => ({ type: 'person', name: personName(by) });
  ctx.systemActor = () => ({ type: 'system', name: 'Jewel Labs' });

  ctx.log = async (actor, action, detail, extra = {}) => {
    const entry = {
      id: newId('act'), at: ctx.nowIso(), actor, action, detail,
      shipmentId: extra.shipmentId ?? null, docId: extra.docId ?? null, paperId: extra.paperId ?? null,
    };
    await store.put('activity', entry);
    events.emit('activity', entry);
    return entry;
  };

  // ---- live agent events (drive the cursors and the feed) ----
  ctx.agentEvent = (agent, action, message, extra = {}) => {
    const event = { agent, action, message, at: ctx.nowIso(), ...extra };
    safeEmit('agent', event);
    return event;
  };

  // Field events are shown one by one with a short pause so the cursors can glide between boxes.
  // They play on their own queue: the agents never wait for the animation.
  ctx.playFields = (list) => {
    waitingToShow += list.length;
    playback = playback.then(async () => {
      for (const event of list) {
        waitingToShow -= 1;
        safeEmit('agent', { at: ctx.nowIso(), ...event });
        if (ctx.pace > 0 && waitingToShow < MAX_PACED_BACKLOG) await sleep(ctx.pace);
      }
    });
    return playback;
  };
  ctx.playbackDone = () => playback;

  // ---- messages between the house, the desk and the agents ----
  // from: { type: 'person'|'agent', name, role }, to: 'house'|'desk'|'agents' (same shape as main's sendMessage).
  ctx.postMessage = async ({ from, to, text, ...extra }) => {
    const message = { id: newId('msg'), at: ctx.nowIso(), from, to, text, ...extra };
    await store.put('messages', message);
    return message;
  };
  ctx.personFrom = (by, role = 'house') => ({ type: 'person', name: personName(by), role: (by && by.role) || role });
  ctx.agentsFrom = () => ({ type: 'agent', name: 'Agents', role: 'agents' });

  // ---- usage events for metrics (upload, question answered, desk edit, pack signed, pack sent) ----
  ctx.usage = async (type, data = {}, by = null) => {
    const event = { id: newId('evt'), type, at: ctx.nowIso(), userId: personId(by), deviceId, ...data };
    await store.put('events', event);
    return event;
  };

  // ---- notifications (OS notification through the injected notify function + a 'notify' event) ----
  ctx.notifyUser = async ({ kind, title, body, shipmentId = null, paperId = null }) => {
    const note = { kind, title, body, shipmentId, paperId, at: ctx.nowIso() };
    safeEmit('notify', note);
    if (typeof notify === 'function') {
      try { await notify(note); } catch { /* a failed OS notification must never stop the agents */ }
    }
    return note;
  };

  // ---- work that runs on its own (a scheduled run, a first mailbox poll) ----
  ctx.background = (work) => {
    const task = Promise.resolve(work)
      .catch((err) => ctx.agentEvent('review', 'error', `Background step failed: ${err.message}`))
      .finally(() => background.delete(task));
    background.add(task);
    return task;
  };
  ctx.hasBackground = () => background.size > 0;
  ctx.backgroundDone = async () => {
    while (background.size) await Promise.allSettled([...background]);
  };

  // ---- the readers: AI (or the offline reader), OCR, the sanctions list ----
  ctx.getAI = async () => {
    if (!ctx.ai) ctx.ai = (await load('ai')).createAI({ mode: 'off' });
    return ctx.ai;
  };
  ctx.getOCR = async () => ctx.ocr || (ctx.ocr = await load('ocr'));

  ctx.getSdnIndex = async () => {
    if (sdn.index && ctx.now().getTime() - sdn.at < SDN_MEMO_MS) return sdn.index;
    try {
      sdn = { index: await loadSdnIndex(), at: ctx.now().getTime() };
    } catch (err) {
      ctx.agentEvent('sanctions', 'error', `Could not load the OFAC SDN list: ${err.message}`);
    }
    return sdn.index;
  };

  async function loadSdnIndex() {
    if (typeof sanctionsLoader === 'function') return sanctionsLoader();
    if (sanctionsLoader && typeof sanctionsLoader.load === 'function') return sanctionsLoader.load();
    const sanctions = await load('sanctions');
    return sanctions.loadSdn({ cacheDir: paths.cacheDir || paths.userData });
  }

  // A house setting can sit at the top of the workspace, under settings, or under profile.
  ctx.houseSetting = (workspace, key) => workspace?.[key] ?? workspace?.settings?.[key] ?? workspace?.profile?.[key];

  function safeEmit(name, payload) {
    try { events.emit(name, payload); } catch { /* a broken listener must not break the agents */ }
  }

  return ctx;
}

// ---- small helpers used by many stages ----

let idCounter = 0;

/**
 * doc_<time><counter><random>. Time comes first, so ids sort in the order they were made: the store breaks
 * ties between records saved in the same millisecond by id, and the audit trail must stay in order.
 */
export function newId(prefix) {
  idCounter = (idCounter + 1) % 1679616; // four base-36 digits
  const time = Date.now().toString(36).padStart(9, '0');
  const count = idCounter.toString(36).padStart(4, '0');
  const random = randomUUID().replace(/-/g, '').slice(0, 6);
  return `${prefix}_${time}${count}${random}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "ABC Diamonds Pvt. Ltd." -> "abc diamonds pvt ltd" (for matching the same company written two ways). */
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "GIA 2141-438-172" or "2141438172" -> "2141438172": a key for comparing report numbers typed any way. */
export function reportKey(value) {
  return String(value || '').replace(/[^0-9a-z]/gi, '').toUpperCase().replace(/^(GIA|IGI|HRD|GCAL|GSI)(?=\d|LG\d)/, '');
}

/** The id metrics count people by: a user id, else an email, else the name. */
export function personId(by) {
  if (!by) return null;
  if (typeof by === 'string') return by;
  return by.id || by.userId || by.email || by.name || null;
}

/** `by` can be a user object or a plain name. */
export function personName(by) {
  if (!by) return 'Someone';
  if (typeof by === 'string') return by;
  return by.name || by.email || 'Someone';
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hoursBetween(isoA, dateB) {
  return Math.abs(new Date(dateB).getTime() - new Date(isoA).getTime()) / 3600000;
}

export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(data || []);
}

/** plural(2, 'paper') -> "2 papers" */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * True when two records hold the same facts (times and the workspace id aside). Saving an unchanged record would
 * only bump its updatedAt, which reorders lists, and costs a write on a cloud house.
 */
export function sameRecord(a, b) {
  const strip = (r) => {
    const { updatedAt, createdAt, workspaceId, ...rest } = r || {};
    return rest;
  };
  return stableJson(strip(a)) === stableJson(strip(b));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Newest first, by updatedAt then createdAt. */
export function byNewest(a, b) {
  return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
}
