// The runner puts the agents to work in order: Intake reads new documents (a few at a time),
// Records files them under shipments, then for each open shipment Sanctions, Origin and Review run.
// Only one run happens at a time. Asking for a run while one is going queues a single follow-up run.
import { AI_MAX_PARALLEL } from '../config.js';
import { readDocuments } from './intake.js';
import { runRecords } from './records-stage.js';
import { currentListDate, screenShipmentParties } from './sanctions-stage.js';
import { checkShipment } from './origin-stage.js';
import { buildIfReady, currentRulesVersion, shipmentBasis } from './paperwork.js';

const CLOSED = ['signed', 'sent'];
const LEASE_SECONDS = 180;
const LEASE_RENEW_MS = 60 * 1000;

/**
 * lease (cloud only): { acquire(workspaceId, holder, ttlSeconds) -> boolean, release(workspaceId, holder) },
 * or just an acquire function. It stops two installs of the same house from working on the same papers.
 */
export function createRunner(ctx, { lease, isAutopilot, parallel }) {
  parallel = parallel || AI_MAX_PARALLEL;
  let running = null; // the run in progress
  let next = null; // { options, promise } for the one run waiting behind it
  let blockedBefore = null; // why the last run could not start ('held' or 'offline'), so it is logged once

  function run(options = {}) {
    if (!running && !next) return start(options);
    if (next) {
      next.options = mergeOptions(next.options, options);
      return next.promise;
    }
    const waiting = { options };
    waiting.promise = running.catch(() => {}).then(() => {
      next = null;
      return start(waiting.options);
    });
    next = waiting;
    return waiting.promise;
  }

  function start(options) {
    running = runOnce(options).finally(() => { running = null; });
    return running;
  }

  /** Resolves when no run is going or waiting and every live event has been shown. */
  async function idle() {
    for (;;) {
      if (running || next) {
        await (next ? next.promise : running).catch(() => {});
      } else if (ctx.hasBackground()) {
        await ctx.backgroundDone();
      } else {
        await ctx.playbackDone();
        if (!running && !next && !ctx.hasBackground()) return;
      }
    }
  }

  async function runOnce(options) {
    const workspace = await ctx.store.workspace();
    const got = await takeLease(workspace.id);
    if (got !== 'ok') {
      if (blockedBefore !== got) {
        await ctx.log(ctx.systemActor(), 'waiting', got === 'offline'
          ? 'The cloud cannot be reached, so the agents wait. They start again once the connection is back.'
          : 'Another computer of this house is working on these papers. This one will try again.');
      }
      blockedBefore = got;
      return { skipped: 'lease', reason: got };
    }
    blockedBefore = null;
    const hold = holdLease(workspace.id);
    try {
      const result = await runStages(options, hold.lost);
      if (hold.lost()) {
        await ctx.log(ctx.systemActor(), 'stopped', 'This computer lost its turn on these papers (asleep or offline for a while), so it stopped. Another computer of the house can carry on.');
        return { ...result, stopped: 'lease' };
      }
      return result;
    } finally {
      hold.stop();
      await releaseLease(workspace.id);
    }
  }

  /**
   * Keeps the lease while a run goes on. lost() turns true when another computer took it over, or when it was not
   * renewed in time (the laptop slept, the network stalled): then the other computer may be working on the papers.
   */
  function holdLease(workspaceId) {
    if (!lease) return { lost: () => false, stop() {} };
    let renewedAt = ctx.now().getTime();
    let takenOver = false;
    const timer = setInterval(async () => {
      const got = await takeLease(workspaceId);
      if (got === 'ok') renewedAt = ctx.now().getTime();
      if (got === 'held') takenOver = true;
    }, LEASE_RENEW_MS);
    if (timer.unref) timer.unref();
    return {
      lost: () => takenOver || ctx.now().getTime() - renewedAt > LEASE_SECONDS * 1000,
      stop: () => clearInterval(timer),
    };
  }

  async function runStages(options, lost) {
    const { store } = ctx;
    const fresh = await store.list('documents', (d) => d.status === 'new');
    if (fresh.length) await readDocuments(ctx, fresh, { parallel, shouldStop: lost });
    if (lost()) return { read: fresh.length, shipments: [] };
    try {
      await runRecords(ctx);
    } catch (err) {
      await stageError('records', null, err);
    }

    const autopilot = await isAutopilot();
    const listDate = await currentListDate(ctx);
    const only = targetIds(options); // null means every open shipment
    const forced = new Set([...(options.forceIds || []), ...(only || [])]);
    const shipments = await store.list('shipments', (s) => !CLOSED.includes(s.status) && (!only || only.includes(s.id)));
    const results = [];
    for (const shipment of shipments) {
      if (lost()) break;
      results.push(await runShipment(shipment, { force: Boolean(options.force) || forced.has(shipment.id), autopilot, listDate, lost }));
    }
    return { read: fresh.length, shipments: results };
  }

  /**
   * Sanctions, Origin and Review for one shipment. The rules run again only when its papers or answers changed
   * since the last check, when a newer OFAC SDN list came out since its parties were screened, or when the rules
   * themselves changed (a new version of the app): a shipment the old rules called ready may not be ready now.
   */
  async function runShipment(shipment, { force, autopilot, listDate, lost }) {
    try {
      const { basis, changed } = await changedSince(shipment, listDate);
      const mustCheck = force || changed;
      let current = shipment;
      if (mustCheck) {
        const screenings = await screenShipmentParties(ctx, shipment);
        current = (await checkShipment(ctx, { ...shipment, checkedBasis: basis, sdnListDate: listDate }, screenings)).shipment;
      }
      const built = lost() ? null : await buildIfReady(ctx, current, { autopilot, fresh: mustCheck });
      return { shipmentId: shipment.id, checked: mustCheck, status: built ? built.status : current.status, built: Boolean(built) };
    } catch (err) {
      await stageError('origin', shipment, err);
      return { shipmentId: shipment.id, error: err.message };
    }
  }

  /** { basis, changed }: the fingerprint of the shipment's papers now, and whether it must be checked again. */
  async function changedSince(shipment, listDate) {
    const documents = await ctx.store.list('documents', (d) => d.shipmentId === shipment.id && d.status === 'read');
    const basis = shipmentBasis(shipment, documents);
    const rulesVersion = await currentRulesVersion(ctx);
    const changed = shipment.checkedBasis !== basis || Boolean(listDate && shipment.sdnListDate !== listDate)
      || (shipment.rulesVersion || null) !== rulesVersion;
    return { basis, changed };
  }

  async function stageError(agent, shipment, err) {
    const message = `${shipment?.ref ? `${shipment.ref}: ` : ''}${err.message}`;
    ctx.agentEvent(agent, 'error', message, { shipmentId: shipment?.id });
    await ctx.log(ctx.agentActor(agent), 'error', message, { shipmentId: shipment?.id });
  }

  /** 'ok', 'held' (another computer has it) or 'offline' (the cloud cannot be reached: do not risk two at once). */
  async function takeLease(workspaceId) {
    if (!lease) return 'ok';
    const acquire = typeof lease === 'function' ? lease : lease.acquire.bind(lease);
    try {
      return (await acquire(workspaceId, ctx.deviceId, LEASE_SECONDS)) !== false ? 'ok' : 'held';
    } catch {
      return 'offline';
    }
  }

  async function releaseLease(workspaceId) {
    if (!lease || typeof lease.release !== 'function') return;
    try { await lease.release(workspaceId, ctx.deviceId); } catch { /* the lease runs out on its own */ }
  }

  /**
   * Is there work? A new document, or an open shipment that changed since its last check (an answer given
   * on another computer, say, whose run had to wait for the lease), or one screened against an older SDN list.
   */
  async function needsRun() {
    if ((await ctx.store.list('documents', (d) => d.status === 'new')).length) return true;
    const open = await ctx.store.list('shipments', (s) => !CLOSED.includes(s.status));
    if (!open.length) return false;
    const listDate = await currentListDate(ctx);
    for (const shipment of open) {
      if ((await changedSince(shipment, listDate)).changed) return true;
    }
    return false;
  }

  return { run, idle, needsRun, isRunning: () => Boolean(running) };
}

/** Two waiting requests become one run. Every shipment someone asked for by name is still checked. */
export function mergeOptions(a = {}, b = {}) {
  const idsA = targetIds(a);
  const idsB = targetIds(b);
  return {
    shipmentIds: idsA && idsB ? [...new Set([...idsA, ...idsB])] : null,
    forceIds: [...new Set([...(a.forceIds || []), ...(b.forceIds || []), ...(idsA || []), ...(idsB || [])])],
    force: Boolean(a.force || b.force),
    reason: [a.reason, b.reason].filter(Boolean).join(', '),
  };
}

/** { shipmentId } or { shipmentIds } -> list of ids, or null for every open shipment. */
function targetIds(options) {
  if (options.shipmentIds) return options.shipmentIds;
  return options.shipmentId ? [options.shipmentId] : null;
}
