// The app's one shared state and the reducer that changes it. Pure functions (no DOM, no API),
// so test/unit/renderer.test.js can check every action. app.js wires it to useReducer + context.

export const COLLECTIONS = ['documents', 'shipments', 'stones', 'checks', 'questions', 'papers', 'parties', 'activity', 'messages'];
const KEEP = { activity: 600, messages: 400 }; // long lists are cut to the newest rows
const MAX_AGENT_EVENTS = 200;
const MAX_TOASTS = 3;

export function initialState() {
  return {
    boot: 'loading', // 'loading' | 'ready' | 'error'
    bootError: null,
    demo: false, // true when the in-browser demo API is running
    demoInfo: null, // { recorded, title } for the banner
    scrollToReader: false, // scroll Home to the agents reading once they start (the sample, a first upload)
    info: null, // jl.app.info()
    auth: null, // jl.auth.status()
    workspace: null, // jl.workspaces.current()
    workspaces: [],
    settings: null,
    sanctions: null, // { count, date, source }
    autopilot: true,
    data: Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
    loaded: Object.fromEntries(COLLECTIONS.map((c) => [c, false])),
    agentEvents: [], // newest first
    working: {}, // agentId -> { at, message } while an agent is busy
    toasts: [],
    palette: false,
  };
}

/** Upsert by id; newest rows go first so lists show recent work at the top. */
export function upsert(rows, value) {
  if (!value || !value.id) return rows;
  const i = rows.findIndex((r) => r.id === value.id);
  if (i === -1) return [value, ...rows];
  const next = rows.slice();
  next[i] = { ...rows[i], ...value };
  return next;
}

function cut(collection, rows) {
  const max = KEEP[collection];
  return max && rows.length > max ? rows.slice(0, max) : rows;
}

export function reducer(state, action) {
  switch (action.type) {
    case 'boot':
      return { ...state, ...action.patch };
    case 'info':
      return { ...state, info: action.info, autopilot: action.info?.autopilot ?? state.autopilot };
    case 'auth':
      return { ...state, auth: action.auth };
    case 'workspace':
      return { ...state, workspace: action.workspace };
    case 'workspaces':
      return { ...state, workspaces: action.workspaces || [] };
    case 'settings':
      return { ...state, settings: action.settings, autopilot: action.settings?.autopilot ?? state.autopilot };
    case 'sanctions':
      return { ...state, sanctions: action.sanctions };
    case 'autopilot':
      return { ...state, autopilot: Boolean(action.on) };
    case 'set-collection': {
      if (!COLLECTIONS.includes(action.collection)) return state;
      const rows = Array.isArray(action.rows) ? action.rows : [];
      return {
        ...state,
        data: { ...state.data, [action.collection]: cut(action.collection, rows) },
        loaded: { ...state.loaded, [action.collection]: true },
      };
    }
    case 'upsert': {
      if (!COLLECTIONS.includes(action.collection)) return state;
      const rows = upsert(state.data[action.collection], action.value);
      return { ...state, data: { ...state.data, [action.collection]: cut(action.collection, rows) } };
    }
    case 'remove': {
      if (!COLLECTIONS.includes(action.collection)) return state;
      const rows = state.data[action.collection].filter((r) => r.id !== action.id);
      return { ...state, data: { ...state.data, [action.collection]: rows } };
    }
    case 'reset-data':
      return {
        ...state,
        data: Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
        loaded: Object.fromEntries(COLLECTIONS.map((c) => [c, false])),
        agentEvents: [],
        working: {},
      };
    case 'agent':
      return agentEvent(state, action.event);
    case 'idle':
      return { ...state, working: {} };
    case 'toast': {
      const toast = { id: action.toast.id || `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ...action.toast };
      const same = state.toasts.find((t) => t.title === toast.title && t.text === toast.text);
      if (same) return state; // the same notice twice in a row shows once
      const others = toast.key ? state.toasts.filter((t) => t.key !== toast.key) : state.toasts;
      return { ...state, toasts: [...others, toast].slice(-MAX_TOASTS) };
    }
    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'palette':
      return { ...state, palette: Boolean(action.open) };
    default:
      return state;
  }
}

// Agent events: keep the newest 200, and remember which agents are busy right now.
function agentEvent(state, event) {
  if (!event || !event.agent) return state;
  const at = event.at || new Date().toISOString();
  const stamped = { ...event, at, seq: (state.agentEvents[0]?.seq || 0) + 1 };
  const working = { ...state.working };
  if (event.action === 'done' || event.action === 'error') delete working[event.agent];
  else working[event.agent] = { at, message: event.message || '' };
  return { ...state, agentEvents: [stamped, ...state.agentEvents].slice(0, MAX_AGENT_EVENTS), working };
}

/** Agents seen working in the last few seconds (a run that went quiet stops pulsing). */
export function busyAgents(state, now = Date.now(), windowMs = 6000) {
  const out = {};
  for (const [id, w] of Object.entries(state.working || {})) {
    if (now - new Date(w.at).getTime() < windowMs) out[id] = w;
  }
  return out;
}

// ---------- selectors: what the screens ask the state ----------

/** What each open shipment still needs: missing papers from open questions, grouped by shipment. */
export function stillNeeded(state) {
  const groups = [];
  for (const s of state.data.shipments) {
    if (s.status === 'signed' || s.status === 'sent') continue;
    const missing = state.data.questions.filter((q) => q.shipmentId === s.id && q.status === 'open' && q.kind === 'missing_document');
    if (missing.length) groups.push({ shipment: s, missing });
  }
  return groups;
}

/** Counts for the agent strip under the drop zone. */
export function agentStripCounts(state) {
  const docs = state.data.documents;
  const read = docs.filter((d) => d.status === 'read').length;
  const reading = docs.find((d) => d.status === 'reading') || null;
  const filed = docs.filter((d) => d.shipmentId).length;
  const missing = state.data.questions.filter((q) => q.status === 'open' && q.kind === 'missing_document').length;
  return { total: docs.length, read, reading, filed, unfiled: docs.length - filed, missing };
}

/** A parcel line of many stones (a lot) rather than one graded stone. */
export const isLot = (stone) => Number(stone?.pieces) > 1;

/** Single stones first (biggest first), then lots: a 119-piece lot is not the biggest stone. */
export function sortStones(stones) {
  return stones.slice().sort((a, b) => isLot(a) - isLot(b) || Number(b.carat || 0) - Number(a.carat || 0));
}

/** Pieces in a parcel: the invoice total, else every stone the agents traced (a lot counts each stone in it). */
export function piecesOf(shipment, stones) {
  if (shipment.totals?.pieces != null) return shipment.totals.pieces;
  const own = stones.filter((x) => x.shipmentId === shipment.id);
  return own.length ? own.reduce((n, x) => n + (Number(x.pieces) || 1), 0) : '';
}
