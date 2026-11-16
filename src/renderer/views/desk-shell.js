// The Jewel Labs desk (role desk): a numbered sidebar, a top bar with Review / Generate / Connect /
// Autopilot, and the desk pages. Shared screens (shipment, papers, stones) open inside this shell.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { go } from '../lib/router.js';
import { Boundary, Segmented, Dot } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { DeskDashboard } from './desk.js';
import { DataPage, FilingsPage, CounterpartiesPage, AuditPage, MetricsPage } from './desk-pages.js';
import { OnboardModal } from './onboard.js';
import { ShipmentView } from './shipment.js';
import { PapersView } from './papers.js';
import { StonesView } from './stones.js';
import { SettingsView } from './settings.js';
import { number } from '../lib/format.js';
import { agentOf } from '../lib/labels.js';

const NAV = [
  { id: 'dashboard', num: '01', label: 'Dashboard' },
  { id: 'data', num: '02', label: 'Data', count: (s) => s.data.documents.length },
  { id: 'filings', num: '03', label: 'Filings', count: (s) => s.data.papers.length },
  { id: 'counterparties', num: '04', label: 'Counterparties', count: (s) => counterpartyCount(s) },
  { id: 'audit', num: '05', label: 'Audit trail', count: (s) => s.data.activity.length },
  { id: 'metrics', num: '06', label: 'Metrics' },
];

function counterpartyCount(state) {
  if (state.data.parties.length) return state.data.parties.length;
  const names = new Set();
  for (const s of state.data.shipments) for (const p of [s.exporter, s.consignee, s.buyer, s.supplier]) if (p?.name) names.add(p.name.toLowerCase());
  return names.size;
}

export function DeskShell() {
  const { state, route } = useApp();
  const [onboard, setOnboard] = useState(false);
  const content = useRef(null);
  const page = route.id || 'dashboard';
  useEffect(() => {
    content.current?.scrollTo?.({ top: 0 });
    setOnboard(false); // a new page closes the onboarding dialog
  }, [route.id, route.sub]);

  let view;
  if (page === 'data') view = html`<${DataPage} />`;
  else if (page === 'filings') view = html`<${FilingsPage} />`;
  else if (page === 'counterparties') view = html`<${CounterpartiesPage} />`;
  else if (page === 'audit') view = html`<${AuditPage} />`;
  else if (page === 'metrics') view = html`<${MetricsPage} />`;
  else if (page === 'shipments') view = route.sub ? html`<${ShipmentView} id=${route.sub} query=${route.query} />` : html`<${DataPage} />`;
  else if (page === 'papers') view = html`<${PapersView} id=${route.sub} query=${route.query} />`;
  else if (page === 'stones') view = html`<${StonesView} reportNumber=${route.sub} />`;
  else if (page === 'settings') view = html`<${SettingsView} section=${route.sub} />`;
  else view = html`<${DeskDashboard} onOnboard=${() => setOnboard(true)} />`;

  return html`<div class="desk">
    <${Sidebar} page=${page} />
    <div class="desk-main">
      <${DeskTopBar} onConnect=${() => setOnboard(true)} />
      <main class="desk-content" ref=${content}>
        <div class="view-enter" key=${`${page}/${route.sub || ''}`}><${Boundary} name="This desk page">${view}<//></div>
      </main>
    </div>
    ${onboard ? html`<${OnboardModal} onClose=${() => setOnboard(false)} />` : null}
  </div>`;
}

function Sidebar({ page }) {
  const { state, nav, jl, call, toast, signOut, startSample } = useApp();
  const ws = state.workspace || {};
  const sample = state.info?.sample || ws.sample;
  const auth = state.auth || {};

  async function switchHouse(id) {
    if (!id || id === ws.id) return;
    const r = await call(jl.workspaces.select(id));
    if (r) toast('Now filing for', r.name, 'ok');
  }
  async function environment(value) {
    if (value === 'sandbox') return startSample().then(() => go('desk'));
    const live = (state.workspaces || []).find((w) => !w.sample);
    if (live) return switchHouse(live.id);
    return undefined;
  }

  return html`<aside class="sidebar" aria-label="Desk">
    <div class="sidebar-top drag"><a class="brand" href="#/desk"><span class="brand-mark">${Icon.logo()}</span>Jewel Labs</a></div>
    <div class="sidebar-house">
      <div class="name ellipsis">${ws.name || 'No house open'}</div>
      <div class="meta ellipsis">${ws.legalName || (ws.city ? `${ws.city}${ws.country ? `, ${ws.country}` : ''}` : 'Not set')}</div>
      <select class="select input-sm" value="" onChange=${(e) => switchHouse(e.currentTarget.value)} aria-label="Switch company you file for">
        <option value="">Switch company you file for</option>
        ${(state.workspaces || []).map((w) => html`<option value=${w.id}>${w.name}${w.sample ? ' (sample)' : ''}</option>`)}
      </select>
    </div>
    <nav class="nav">
      ${NAV.map((n) => {
        const count = n.count ? n.count(state) : null;
        return html`<button type="button" class=${`nav-item${page === n.id ? ' active' : ''}`} onClick=${() => (n.id === 'dashboard' ? go('desk') : nav.desk(n.id))}
          aria-current=${page === n.id ? 'page' : undefined}>
          <span class="num">${n.num}</span><span>${n.label}</span><span class="n">${count === null ? '' : count}</span>
        </button>`;
      })}
    </nav>
    <div class="nav-more"><span>More tools</span>${Icon.plus({ class: 'muted' })}</div>
    <nav class="nav">
      <button type="button" class=${`nav-item${page === 'stones' ? ' active' : ''}`} onClick=${() => nav.desk('stones')}><span class="num">${Icon.gem({ class: 'muted' })}</span><span>Stone history</span><span></span></button>
      <button type="button" class=${`nav-item${page === 'settings' ? ' active' : ''}`} onClick=${() => nav.desk('settings')}><span class="num">${Icon.gear({ class: 'muted' })}</span><span>Settings</span><span></span></button>
      <button type="button" class="nav-item" onClick=${() => go('home')}><span class="num">${Icon.users({ class: 'muted' })}</span><span>Customer portal</span><span></span></button>
    </nav>
    <div class="sidebar-fill"></div>
    <div class="sidebar-block">
      <div class="label">Signed in</div>
      <div class="sidebar-signed">
        <span class="who">${auth.signedIn ? auth.user?.name || auth.user?.email : state.demo ? 'Demo visitor' : 'This computer'}</span>
        ${auth.signedIn ? html`<button class="btn btn-sm" type="button" onClick=${signOut}>Sign out</button>` : null}
      </div>
    </div>
    <div class="sidebar-block">
      <div class="label">Environment</div>
      <${Segmented} full value=${sample ? 'sandbox' : 'live'} onChange=${environment} options=${[{ value: 'sandbox', label: 'Sandbox' }, { value: 'live', label: 'Live' }]} ariaLabel="Environment" />
      <div class="sidebar-note">${sample ? 'Sandbox: fictional SAMPLE papers to practise on. Nothing here is real.' : 'Live: the house’s real papers. The model, the OFAC list and the rules are the same as in Sandbox.'}</div>
    </div>
    <div class="sidebar-versions">
      <div>${state.info?.ai?.model || 'offline reader'} · ${state.info?.ai?.mode || 'off'}</div>
      <div>Tesseract 7 · compliance.js</div>
      <div>OFAC ${state.sanctions ? `${number(state.sanctions.count)} · ${state.sanctions.date || ''}` : '…'}</div>
    </div>
  </aside>`;
}

function DeskTopBar({ onConnect }) {
  const { state, nav, jl, call, toast, setAutopilot } = useApp();
  const ws = state.workspace || {};
  const latest = state.agentEvents[0];
  const review = state.data.papers.filter((p) => p.status === 'held_for_review').length;
  const live = state.data.shipments.filter((s) => s.status !== 'sent').length;
  const toSign = state.data.papers.filter((p) => p.status === 'ready_to_sign').length;

  async function generate() {
    const target = state.data.shipments.find((s) => ['ready_to_sign', 'held_for_review', 'questions'].includes(s.status)) || state.data.shipments[0];
    if (!target) return toast('Nothing to build yet', 'Add a shipment’s papers first.', 'info');
    const r = await call(jl.papers.build(target.id));
    if (r) toast(`Building the papers for ${target.ref}`, 'The Paperwork agent writes the pack and cites every value.', 'ok');
    return undefined;
  }

  return html`<header class="desk-topbar drag">
    <span class="house ellipsis" style=${{ maxWidth: '200px' }}>${ws.name || 'Jewel Labs'}</span>
    <span class="ticker"><span><${Dot} tone="ok" /> Live <b>${live}</b></span><span><${Dot} tone="info" /> To sign <b>${toSign}</b></span></span>
    <div class="live-field" title=${latest?.message || ''}>
      <span class="live live-dot">LIVE</span>
      ${latest ? html`<span class="msg"><span style=${{ color: agentOf(latest.agent).color }}>${agentOf(latest.agent).name}</span> · ${latest.message}</span>` : html`<span class="msg">Agents standing by</span>`}
    </div>
    <button class="btn btn-sm" type="button" onClick=${() => nav.desk('filings')} title="Packs held for your review">Review<span class="kbd">${review}</span></button>
    <button class="btn btn-sm" type="button" onClick=${generate} title="Build the papers for the next shipment">Generate</button>
    <button class="btn btn-sm btn-primary" type="button" onClick=${onConnect} title="Onboard a house: past clients, email, records or WhatsApp">Connect</button>
    <button class=${`btn btn-sm${state.autopilot ? ' on' : ''}`} type="button" onClick=${() => setAutopilot(!state.autopilot)} title="Autopilot (A)">Autopilot<span class="kbd">A</span></button>
  </header>`;
}
