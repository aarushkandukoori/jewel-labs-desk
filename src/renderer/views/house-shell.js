// The house view (customer portal): top bar, the HOME / SHIPMENTS / PAPERS / STONES tabs, and the page.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { go } from '../lib/router.js';
import { Boundary, Dot } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { HomeView } from './home.js';
import { ShipmentsView } from './shipments.js';
import { ShipmentView } from './shipment.js';
import { PapersView } from './papers.js';
import { StonesView } from './stones.js';
import { ActivityView } from './activity.js';
import { SettingsView } from './settings.js';

const TABS = [
  { name: 'home', label: 'Home' },
  { name: 'shipments', label: 'Shipments' },
  { name: 'papers', label: 'Papers' },
  { name: 'stones', label: 'Stones' },
];

export function HouseShell() {
  const { state, route } = useApp();
  const page = useRef(null);
  const toSign = state.data.papers.filter((p) => p.status === 'ready_to_sign').length;

  // A new screen starts at the top.
  useEffect(() => { page.current?.scrollTo?.({ top: 0 }); }, [route.name, route.id]);

  let view;
  if (route.name === 'shipments') view = route.id ? html`<${ShipmentView} id=${route.id} query=${route.query} />` : html`<${ShipmentsView} />`;
  else if (route.name === 'papers') view = html`<${PapersView} id=${route.id} />`;
  else if (route.name === 'stones') view = html`<${StonesView} reportNumber=${route.id} />`;
  else if (route.name === 'activity') view = html`<${ActivityView} />`;
  else if (route.name === 'settings') view = html`<${SettingsView} section=${route.id} />`;
  else view = html`<${HomeView} />`;

  return html`<${TopBar} />
    <nav class="tabs" aria-label="Sections">
      ${TABS.map((t) => html`<button type="button" class=${`tab${route.name === t.name ? ' active' : ''}`} onClick=${() => go(t.name)}
        aria-current=${route.name === t.name ? 'page' : undefined}>
        ${t.label}${t.name === 'papers' && toSign ? html`<span class="count">${toSign}</span>` : null}
      </button>`)}
    </nav>
    <main class="page" ref=${page}>
      <div class="view-enter" key=${`${route.name}/${route.id || ''}`}>
        <${Boundary} name="This screen">${view}<//>
      </div>
    </main>`;
}

function TopBar() {
  const { state, nav, signOut, setAutopilot, dispatch } = useApp();
  const auth = state.auth || {};
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  return html`<header class="topbar drag">
    <a class="brand" href="#/home" aria-label="Jewel Labs home"><span class="brand-mark">${Icon.logo()}</span><span class="brand-name">Jewel Labs</span></a>
    <${WorkspaceMenu} />
    <span class="topbar-spacer"></span>
    <div class="topbar-right">
      <button type="button" class=${`btn btn-sm${state.autopilot ? ' on' : ''}`} onClick=${() => setAutopilot(!state.autopilot)}
        title="Autopilot: the agents read new papers and build packs on their own (A)">
        <${Dot} tone=${state.autopilot ? 'ok' : undefined} pulse=${state.autopilot} />Autopilot ${state.autopilot ? 'on' : 'off'}<span class="kbd">A</span>
      </button>
      <button type="button" class="btn btn-sm btn-ghost" onClick=${() => dispatch({ type: 'palette', open: true })} title="Search (${isMac ? '⌘' : 'Ctrl'}+K)" aria-label="Search">
        ${Icon.search()}<span class="kbd">${isMac ? '⌘' : 'Ctrl'} K</span>
      </button>
      ${auth.deskAllowed !== false ? html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => go('desk')} title="The Jewel Labs desk: every house, approvals and metrics">Desk</button>` : null}
      <button type="button" class="btn btn-sm btn-ghost btn-icon" onClick=${() => nav.settings()} title="Settings" aria-label="Settings">${Icon.gear()}</button>
      ${auth.signedIn
        ? html`<span class="signed-in">Signed in as <b>${auth.user?.name || auth.user?.email}</b></span>
            <button type="button" class="btn btn-sm" onClick=${signOut}>Sign out</button>`
        : html`<span class="signed-in">${state.demo ? 'Demo, nothing leaves this tab' : 'On this computer'}</span>
            ${state.demo ? null : html`<button type="button" class="btn btn-sm" onClick=${() => nav.welcome()}>Sign in</button>`}`}
    </div>
  </header>`;
}

/** The open workspace's name; click to switch (your house, the sample, other shared workspaces). */
function WorkspaceMenu() {
  const { state, call, jl, toast } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const current = state.workspace;
  async function pick(w) {
    setOpen(false);
    if (w.id === current?.id) return;
    const result = await call(jl.workspaces.select(w.id));
    if (result) toast('Workspace open', w.name, 'ok');
  }
  return html`<div class="no-drag" style=${{ position: 'relative' }} ref=${box}>
    <button type="button" class="topbar-workspace" onClick=${() => setOpen(!open)} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'} title="Switch workspace">
      <span class="ellipsis" style=${{ maxWidth: '240px' }}>${current?.name || 'Workspace'}</span>
      ${current?.sample ? html`<span class="chip chip-warn chip-sm">Sample</span>` : null}
      ${Icon.chevronDown({ class: 'muted' })}
    </button>
    ${open ? html`<div class="panel" role="menu" style=${{ position: 'absolute', top: '36px', left: 0, minWidth: '260px', zIndex: 40, boxShadow: '0 20px 50px rgba(0,0,0,0.6)' }}>
      <div class="panel-head"><span class="label">Workspaces</span></div>
      <div class="rows">
        ${(state.workspaces || []).map((w) => html`<button type="button" role="menuitem" class="row compact clickable" style=${{ width: '100%', border: 0, background: 'none', textAlign: 'left', color: 'inherit' }}
          onClick=${() => pick(w)}>
          <div class="row-main"><div class="row-title">${w.name}</div><div class="row-sub">${w.sample ? 'Fictional SAMPLE papers' : w.kind === 'cloud' ? 'Shared with your team' : 'On this computer'}</div></div>
          ${w.id === current?.id ? Icon.check({ class: 'soft' }) : null}
        </button>`)}
      </div>
    </div>` : null}
  </div>`;
}
