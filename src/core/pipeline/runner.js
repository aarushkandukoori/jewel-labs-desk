// The runner puts the agents to work in order: Intake reads new documents (a few at a time),
// Records files them under shipments, then for each open shipment Sanctions, Origin and Review run.
// Only one run happens at a time. Asking for a run while one is going queues a single follow-up run.
import { AI_MAX_PARALLEL } from '../config.js';
import { readDocuments } from './intake.js';
import { runRecords } from './records-stage.js';
import { screenShipmentParties } from './sanctions-stage.js';
import { checkShipment } from './origin-stage.js';
import { reviewShipment, shipmentBasis } from './paperwork.js';

const CLOSED = ['signed', 'sent'];
const LEASE_SECONDS = 180;
const LEASE_RENEW_MS = 60 * 1000;

/**
 * lease (cloud only): { acquire(workspaceId, holder, ttlSeconds) -> boolean, release(workspaceId, holder) },
 * or just an acquire function. It stops two installs of the same house from working on the same papers.
 */
export function createRunner(ctx, { lease, isAutopilot, parallel = AI_MAX_PARALLEL }) {
  let running = null; // the run in progress
  let next = null; // { options, promise } for the one run waiting behind it
  let blockedBefore = false;

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
    if (!(await takeLease(workspace.id))) {
      if (!blockedBefore) {
        await ctx.log(ctx.systemActor(), 'waiting', 'Another computer of this house is working on these papers. This one will try again.');
      }
      blockedBefore = true;
      return { skipped: 'lease' };
    }
    blockedBefore = false;
    const renew = lease ? setInterval(() => { takeLease(workspace.id).catch(() => {}); }, LEASE_RENEW_MS) : null;
    if (renew && renew.unref) renew.unref();
    try {
      return await runStages(options);
    } finally {
      if (renew) clearInterval(renew);
      await releaseLease(workspace.id);
    }
  }

  async function runStages(options) {
    const { store } = ctx;
    const fresh = await store.list('documents', (d) => d.status === 'new');
    if (fresh.length) await readDocuments(ctx, fresh, { parallel });
    try {
      await runRecords(ctx);
    } catch (err) {
      await stageError('records', null, err);
    }

    const autopilot = await isAutopilot();
    const only = targetIds(options); // null means every open shipment
    const forced = new Set([...(options.forceIds || []), ...(only || [])]);
    const shipments = await store.list('shipments', (s) => !CLOSED.includes(s.status) && (!only || only.includes(s.id)));
    const results = [];
    for (const shipment of shipments) {
      results.push(await runShipment(shipment, { force: Boolean(options.force) || forced.has(shipment.id), autopilot }));
    }
    return { read: fresh.length, shipments: results };
  }

  /** Sanctions, Origin and Review for one shipment. Skips the rules when nothing changed since the last check. */
  async function runShipment(shipment, { force, autopilot }) {
    try {
      const documents = await ctx.store.list('documents', (d) => d.shipmentId === shipment.id && d.status === 'read');
      const basis = shipmentBasis(shipment, documents);
      const mustCheck = force || shipment.checkedBasis !== basis;
      let current = shipment;
      if (mustCheck) {
        const screenings = await screenShipmentParties(ctx, shipment);
        current = (await checkShipment(ctx, { ...shipment, checkedBasis: basis }, screenings)).shipment;
      }
      const built = await reviewShipment(ctx, current, { autopilot, fresh: mustCheck });
      return { shipmentId: shipment.id, checked: mustCheck, status: built ? built.status : current.status, built: Boolean(built) };
    } catch (err) {
      await stageError('origin', shipment, err);
      return { shipmentId: shipment.id, error: err.message };
    }
  }

  async function stageError(agent, shipment, err) {
    const message = `${shipment?.ref ? `${shipment.ref}: ` : ''}${err.message}`;
    ctx.agentEvent(agent, 'error', message, { shipmentId: shipment?.id });
    await ctx.log(ctx.agentActor(agent), 'error', message, { shipmentId: shipment?.id });
  }

  async function takeLease(workspaceId) {
    if (!lease) return true;
    const acquire = typeof lease === 'function' ? lease : lease.acquire.bind(lease);
    try {
      return (await acquire(workspaceId, ctx.deviceId, LEASE_SECONDS)) !== false;
    } catch {
      return false; // cannot reach the cloud: do not risk two computers working on the same papers
    }
  }

  async function releaseLease(workspaceId) {
    if (!lease || typeof lease.release !== 'function') return;
    try { await lease.release(workspaceId, ctx.deviceId); } catch { /* the lease runs out on its own */ }
  }

  /**
   * Is there work? A new document, or an open shipment that changed since its last check (an answer given
   * on another computer, say, whose run had to wait for the lease).
   */
  async function needsRun() {
    if ((await ctx.store.list('documents', (d) => d.status === 'new')).length) return true;
    for (const shipment of await ctx.store.list('shipments', (s) => !CLOSED.includes(s.status))) {
      const documents = await ctx.store.list('documents', (d) => d.shipmentId === shipment.id && d.status === 'read');
      if (shipment.checkedBasis !== shipmentBasis(shipment, documents)) return true;
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
