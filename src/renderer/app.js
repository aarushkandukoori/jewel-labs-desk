// The app: one shared state (useReducer + context), a hash router, live events from the agents
// (jl.on), keyboard shortcuts, and the two shells: the house portal and the Jewel Labs desk.
import { html, render, useEffect, useMemo, useReducer, useRef, useState } from './vendor/preact-htm.mjs';
import { jl, call, isDemo, setErrorHandler } from './api.js';
import { AppContext, useApp } from './lib/context.js';
import { reducer, initialState, COLLECTIONS } from './lib/store.js';
import { parseHash, go, href } from './lib/router.js';
import { Boundary, Skeleton } from './components/ui.js';
import { StatusBar } from './components/status-bar.js';
import { Toasts } from './components/toasts.js';
import { Palette } from './components/palette.js';
import { HouseShell } from './views/house-shell.js';
import { DeskShell } from './views/desk-shell.js';
import { WelcomeView } from './views/welcome.js';

const STARTED_KEY = 'jl.started'; // this computer has chosen how to start (account, local or sample)

// How to list each collection through the bridge. checks and parties need jl.checks / jl.parties,
// which older copies of the app do not have: then they fill in from live 'change' events only.
const LISTERS = {
  documents: () => jl.docs.list(),
  shipments: () => jl.shipments.list(),
  stones: () => jl.stones.list(),
  questions: () => jl.questions.list(),
  papers: () => jl.papers.list(),
  activity: () => jl.activity.list({ limit: 500 }),
  messages: () => jl.messages.list({ limit: 300 }),
  checks: () => (jl.checks?.list ? jl.checks.list() : null),
  parties: () => (jl.parties?.list ? jl.parties.list() : null),
};

function readStarted() {
  try {
    return localStorage.getItem(STARTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markStarted(on = true) {
  try {
    if (on) localStorage.setItem(STARTED_KEY, '1');
    else localStorage.removeItem(STARTED_KEY);
  } catch {
    // private window: the welcome screen just shows again next time
  }
}

function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function isTyping(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"], button, a, summary, .modal-backdrop, .palette-backdrop'));
}

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({ ...initialState(), demo: isDemo }));
  const route = useHashRoute();
  const stateRef = useRef(state);
  stateRef.current = state;
  const reloadTimers = useRef({});

  const toast = (title, text, tone = 'info', action, key) => dispatch({ type: 'toast', toast: { title, text, tone, action, key } });

  // ---------- loading ----------

  async function loadCollection(name) {
    const lister = LISTERS[name];
    const request = lister ? lister() : null;
    if (!request) {
      dispatch({ type: 'set-collection', collection: name, rows: stateRef.current.data[name] });
      return;
    }
    const rows = await call(request, { quiet: true });
    if (Array.isArray(rows)) dispatch({ type: 'set-collection', collection: name, rows });
  }

  function reloadSoon(name) {
    clearTimeout(reloadTimers.current[name]);
    reloadTimers.current[name] = setTimeout(() => loadCollection(name), 350);
  }

  async function loadWorkspace() {
    const [workspace, workspaces, settings, info] = await Promise.all([
      call(jl.workspaces.current(), { quiet: true }),
      call(jl.workspaces.list(), { quiet: true }),
      call(jl.settings.get(), { quiet: true }),
      call(jl.app.info(), { quiet: true }),
    ]);
    if (workspace) dispatch({ type: 'workspace', workspace });
    if (Array.isArray(workspaces)) dispatch({ type: 'workspaces', workspaces });
    if (settings) dispatch({ type: 'settings', settings });
    if (info) dispatch({ type: 'info', info });
    await Promise.all(COLLECTIONS.map(loadCollection));
    call(jl.sanctions.status(), { quiet: true }).then((s) => s && dispatch({ type: 'sanctions', sanctions: s }));
  }

  async function refreshInfo() {
    const [info, settings, auth] = await Promise.all([
      call(jl.app.info(), { quiet: true }), call(jl.settings.get(), { quiet: true }), call(jl.auth.status(), { quiet: true }),
    ]);
    if (info) dispatch({ type: 'info', info });
    if (settings) dispatch({ type: 'settings', settings });
    if (auth) dispatch({ type: 'auth', auth });
  }

  // The agents may still be opening the workspace when the window appears: wait for them (20 s at most).
  async function waitUntilReady() {
    for (let i = 0; i < 50; i++) {
      const info = await call(jl.app.info(), { quiet: true });
      if (info) dispatch({ type: 'info', info });
      if (!info || info.ready !== false || info.error) return info;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }

  async function boot() {
    try {
      const info = await waitUntilReady();
      if (!isDemo && info?.platform) document.documentElement.dataset.platform = info.platform;
      const auth = await call(jl.auth.status(), { quiet: true });
      if (auth) dispatch({ type: 'auth', auth });
      if (info?.error) toast('The agents could not start', info.error, 'error');
      if (isDemo && jl.demo.status) dispatch({ type: 'boot', patch: { demoInfo: await jl.demo.status() } });

      const autoplay = isDemo && /[?&]autoplay=1/.test(location.search);
      const firstRun = !readStarted() && !auth?.signedIn && !autoplay;
      const current = parseHash(location.hash);
      if (firstRun) {
        go('welcome');
      } else if (!current.known || current.name === 'welcome' || !location.hash) {
        go(auth?.role === 'desk' ? 'desk' : 'home');
      }
      if (autoplay) {
        markStarted();
        await call(jl.demo.load());
      }
      await loadWorkspace();
      dispatch({ type: 'boot', patch: { boot: 'ready' } });
    } catch (e) {
      console.error(e);
      dispatch({ type: 'boot', patch: { boot: 'error', bootError: e?.message || String(e) } });
    }
  }

  // ---------- live events ----------

  useEffect(() => {
    setErrorHandler((message) => toast('That did not work', message, 'error'));
    const offs = [
      jl.on('agent', (event) => dispatch({ type: 'agent', event })),
      jl.on('activity', (entry) => entry?.id && dispatch({ type: 'upsert', collection: 'activity', value: entry })),
      jl.on('change', (change) => {
        if (change?.collection === 'workspace') {
          if (change.value) dispatch({ type: 'workspace', workspace: { ...stateRef.current.workspace, ...change.value } });
          clearTimeout(reloadTimers.current.workspaces);
          reloadTimers.current.workspaces = setTimeout(async () => {
            const list = await call(jl.workspaces.list(), { quiet: true });
            if (Array.isArray(list)) dispatch({ type: 'workspaces', workspaces: list });
          }, 350);
          return;
        }
        if (!change || !COLLECTIONS.includes(change.collection)) return;
        if (change.op === 'remove') dispatch({ type: 'remove', collection: change.collection, id: change.id });
        else if (change.value) dispatch({ type: 'upsert', collection: change.collection, value: change.value });
        else reloadSoon(change.collection);
      }),
      jl.on('notify', (n) => {
        if (!n) return;
        const title = typeof n === 'string' ? 'Jewel Labs' : n.title || 'Jewel Labs';
        const text = typeof n === 'string' ? n : n.body || n.message || n.text || '';
        toast(title, text, n.kind === 'error' ? 'error' : 'ok', undefined, n.shipmentId ? `shipment:${n.shipmentId}` : undefined);
      }),
      jl.on('auth', (auth) => {
        if (auth) dispatch({ type: 'auth', auth });
      }),
      jl.on('sync', (sync) => {
        if (!sync) return;
        if (sync.reason === 'opened') {
          dispatch({ type: 'reset-data' });
          loadWorkspace();
        } else if (sync.reason === 'autopilot') {
          dispatch({ type: 'autopilot', on: sync.autopilot });
        } else if (sync.reason === 'error') {
          toast('Something stopped', sync.error, 'error');
        } else {
          refreshInfo();
        }
      }),
    ];
    // Files dropped outside the drop zone do nothing (instead of the window trying to open them).
    const stopDrop = (e) => { if (!e.defaultPrevented) e.preventDefault(); };
    window.addEventListener('dragover', stopDrop);
    window.addEventListener('drop', stopDrop);
    boot();
    return () => {
      offs.forEach((off) => typeof off === 'function' && off());
      window.removeEventListener('dragover', stopDrop);
      window.removeEventListener('drop', stopDrop);
    };
  }, []);

  // ---------- navigation that knows which shell it is in ----------

  const inDesk = route.name === 'desk';
  const nav = useMemo(() => {
    // Desk pages live under #/desk/<page>/<id>, so shared screens stay inside the desk shell.
    const deskTo = (page, id, query) => {
      location.hash = href('desk', page, null) + (id ? `/${encodeURIComponent(id)}` : '') + (query ? href('', null, query).slice(2) : '');
    };
    return {
      home: () => (inDesk ? go('desk') : go('home')),
      shipments: () => (inDesk ? deskTo('data') : go('shipments')),
      shipment: (id, query) => (inDesk ? deskTo('shipments', id, query) : go('shipments', id, query)),
      document: (docId, key) => {
        const doc = stateRef.current.data.documents.find((d) => d.id === docId);
        const query = { doc: docId, field: key || undefined };
        const target = doc?.shipmentId || 'unfiled';
        if (inDesk) deskTo('shipments', target, query);
        else go('shipments', target, query);
      },
      questions: (questionId) => {
        const q = stateRef.current.data.questions.find((x) => x.id === questionId);
        const target = q?.shipmentId || 'unfiled';
        if (inDesk) deskTo('shipments', target, { tab: 'questions' });
        else go('shipments', target, { tab: 'questions' });
      },
      paper: (id, query) => (inDesk ? deskTo('papers', id, query) : go('papers', id, query)),
      papers: () => (inDesk ? deskTo('filings') : go('papers')),
      stone: (reportNumber) => (inDesk ? deskTo('stones', reportNumber) : go('stones', reportNumber)),
      stones: () => (inDesk ? deskTo('stones') : go('stones')),
      activity: () => (inDesk ? deskTo('audit') : go('activity')),
      settings: (section) => (inDesk ? deskTo('settings', section) : go('settings', section)),
      desk: (page, id) => (page ? deskTo(page, id) : go('desk')),
      house: () => go('home'),
      welcome: () => go('welcome'),
    };
  }, [inDesk]);

  // ---------- actions every screen may use ----------

  async function setAutopilot(on) {
    const result = await call(jl.agents.autopilot(on));
    if (result === null) return;
    const value = typeof result === 'boolean' ? result : on;
    dispatch({ type: 'autopilot', on: value });
    toast(value ? 'Autopilot on' : 'Autopilot off', value ? 'The agents read new papers and build the packs on their own.' : 'New papers wait for you. Press Space to run the agents.', 'ok');
  }

  async function runAgents(shipmentId) {
    const shipment = shipmentId ? stateRef.current.data.shipments.find((s) => s.id === shipmentId) : null;
    toast('Agents running', shipment ? `Working on ${shipment.ref}.` : 'Working on every open shipment.', 'info');
    await call(jl.agents.run({ shipmentId: shipmentId || undefined, reason: 'Run from the app' }));
  }

  async function startSample() {
    markStarted();
    const result = await call(jl.demo.load());
    if (result === null) return false;
    go('home');
    toast('Sample shipment loaded', 'A fictional SAMPLE parcel. Watch the agents read it.', 'ok');
    return true;
  }

  async function signOut() {
    await call(jl.auth.signOut());
    markStarted(false);
    await refreshInfo();
    go('welcome');
  }

  const commands = [
    { id: 'home', title: 'Home', run: () => nav.home() },
    { id: 'shipments', title: 'Shipments', run: () => nav.shipments() },
    { id: 'papers', title: 'Papers', run: () => nav.papers() },
    { id: 'stones', title: 'Stone history', run: () => nav.stones() },
    { id: 'activity', title: 'Activity', run: () => nav.activity() },
    { id: 'settings', title: 'Settings', run: () => nav.settings() },
    ...(state.auth?.deskAllowed !== false ? [
      { id: 'desk', title: 'Jewel Labs desk', run: () => go('desk') },
      { id: 'metrics', title: 'Desk metrics', run: () => nav.desk('metrics') },
      { id: 'counterparties', title: 'Counterparties', run: () => nav.desk('counterparties') },
    ] : []),
    { id: 'run', title: 'Run the agents now', hint: 'Space', run: () => runAgents(route.name === 'shipments' ? route.id : null) },
    { id: 'autopilot', title: state.autopilot ? 'Turn autopilot off' : 'Turn autopilot on', hint: 'A', run: () => setAutopilot(!state.autopilot) },
  ];

  // ---------- keyboard: Space runs the open view, A toggles autopilot, Cmd/Ctrl+K searches ----------

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch({ type: 'palette', open: !stateRef.current.palette });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || route.name === 'welcome') return;
      if (document.querySelector('.modal-backdrop, .palette-backdrop')) return;
      if (e.key === ' ') {
        e.preventDefault();
        const id = route.name === 'shipments' ? route.id : inDesk && route.id === 'shipments' ? route.sub : null;
        runAgents(id && id !== 'unfiled' ? id : null);
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setAutopilot(!stateRef.current.autopilot);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, inDesk]);

  const ctx = {
    state, dispatch, route, nav, toast, commands, call, jl,
    reload: loadWorkspace, refreshInfo, loadCollection, setAutopilot, runAgents, startSample, signOut, markStarted,
  };

  let body;
  if (state.boot === 'error') {
    body = html`<div class="page"><div class="error-panel"><div class="t">Jewel Labs could not start.</div><pre>${state.bootError}</pre></div></div>`;
  } else if (route.name === 'welcome') {
    body = html`<${Boundary} name="The welcome screen"><${WelcomeView} /><//>`;
  } else if (state.boot === 'loading') {
    body = html`<div class="page"><div class="page-inner"><${Skeleton} lines=${5} block /></div></div>`;
  } else if (inDesk && state.auth?.deskAllowed === false) {
    body = html`<div class="page"><div class="page-inner"><div class="error-panel" role="alert">
      <div class="t">The desk is for Jewel Labs staff.</div>
      <div class="soft">Your house's work is under Home, Shipments, Papers and Stones.</div>
      <div class="form-actions"><button class="btn btn-sm" type="button" onClick=${() => go('home')}>Go to Home</button></div>
    </div></div></div>`;
  } else if (inDesk) {
    body = html`<${DeskShell} />`;
  } else {
    body = html`<${HouseShell} />`;
  }

  return html`<${AppContext.Provider} value=${ctx}>
    <div class="app">
      ${state.demo ? html`<${DemoBanner} />` : null}
      <div class="app-body">${body}</div>
      <${StatusBar} />
      <${Toasts} />
      ${state.palette ? html`<${Palette} />` : null}
    </div>
  <//>`;
}

/** The slim line on top of the website demo: says what it is, and lets people replay it. */
function DemoBanner() {
  const { state, startSample } = useApp();
  const recorded = state.demoInfo?.recorded;
  return html`<div class="demo-banner drag" role="note">
    <span><b>Demo:</b> ${recorded ? 'a recorded run of the agents on a fictional sample shipment.' : 'a scripted run of the agents on a fictional sample shipment.'}</span>
    <button class="link" type="button" onClick=${() => { jl.demo.reset().then(() => startSample()); }}>Replay</button>
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
