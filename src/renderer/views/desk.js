// The desk dashboard, as in the walkthrough video: what customers sent, the agents' live activity,
// parcel requests to approve or hold, the agent pipeline, shipment records and the compliance chat.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Button, Chip, Dot, Toggle, StatusChip, Empty, Modal, Field } from '../components/ui.js';
import { CursorArrow } from '../components/icons.js';
import { TellTheAgents, senderOf } from '../components/chat.js';
import { AGENTS, agentOf } from '../lib/labels.js';
import { busyAgents } from '../lib/store.js';
import { actorName, actorAgentId } from '../lib/reading.js';
import { plural, clock, day, dayTime, ago, number, shipmentStatus, route, screeningStatus } from '../lib/format.js';

const AVATAR_AGENTS = ['retrieval', 'intake', 'sanctions', 'paperwork', 'review'];

// "2. Paper": which shipment records the list at the bottom shows.
const RECORD_FILTERS = [
  { id: 'all', label: 'Shipment records', test: () => true },
  { id: 'natural', label: 'Natural', test: (s) => s.goods?.nature === 'natural' },
  { id: 'lab', label: 'Lab-grown', test: (s) => s.goods?.nature === 'lab-grown' },
  { id: 'eu', label: 'EU statement', test: (s, papers) => (s.required || []).some((r) => r.kind === 'eu_dds') || papers.some((p) => p.shipmentId === s.id && p.kind === 'eu_dds') },
  { id: 'us', label: 'US certificate', test: (s, papers) => (s.required || []).some((r) => r.kind === 'us_cbp_certificate') || papers.some((p) => p.shipmentId === s.id && p.kind === 'us_cbp_certificate') },
  { id: 'pack', label: 'Export pack', test: (s, papers) => papers.some((p) => p.shipmentId === s.id && p.kind === 'export_pack') },
];

export function DeskDashboard({ onOnboard }) {
  const { state, nav } = useApp();
  const ws = state.workspace || {};
  const [filter, setFilter] = useState('all');
  return html`<div>
    <div class="desk-head">
      <div><div class="label">Jewel Labs dashboard</div><h1>Shipment records for ${ws.name || 'this house'}</h1></div>
      <div class="desk-head-right">
        <div class="avatars" aria-label="The agents">
          <div class="avatars-row">${AVATAR_AGENTS.map((id) => html`<span class="avatar" key=${id} style=${{ background: agentOf(id).color }} title=${`${agentOf(id).name}: ${agentOf(id).does}`}>${agentOf(id).letter}</span>`)}</div>
          <div class="avatar-cursors">${AVATAR_AGENTS.map((id) => html`<${CursorArrow} key=${id} color=${agentOf(id).color} />`)}</div>
        </div>
        <${MailChip} />
        <button class="btn btn-sm" type="button" onClick=${() => nav.desk('settings', 'mailbox')}>Connect company email</button>
      </div>
    </div>
    <${CompanyBar} />
    <${FromCustomers} />
    <${AgentsPanel} />
    <${FilterRow} filter=${filter} setFilter=${setFilter} />
    <${ParcelRequests} />
    <${Pipeline} />
    <div class="grid-main-side">
      <${ShipmentRecords} onOnboard=${onOnboard} filter=${filter} />
      <div><${TellTheAgents} title="Compliance agent" placeholder="Ask about a shipment, or tell the agents what to prepare" /></div>
    </div>
  </div>`;
}

function MailChip() {
  const { jl, call, state } = useApp();
  const [mail, setMail] = useState(null);
  useEffect(() => { call(jl.mail.status(), { quiet: true }).then(setMail); }, [state.workspace?.id]);
  return html`<span class=${`btn btn-sm${mail?.connected ? ' on' : ''}`} style=${{ cursor: 'default' }} title=${mail?.connected ? `Sending from ${mail.email}` : 'No mailbox: signed packs are downloaded and sent by hand'}>
    Email sending ${mail?.connected ? 'on' : 'off'}</span>`;
}

/** "Your company details go on every statement": shown until the house profile is filled in. */
function CompanyBar() {
  const { state, jl, call, dispatch, toast } = useApp();
  const ws = state.workspace || {};
  const [form, setForm] = useState({ legalName: '', address: '', city: '', eori: '' });
  if (!ws.id || (ws.legalName && ws.address)) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  async function save() {
    const saved = await call(jl.workspaces.update({ legalName: form.legalName || undefined, address: form.address || undefined, city: form.city || undefined, eori: form.eori || undefined }));
    if (saved) { dispatch({ type: 'workspace', workspace: { ...ws, ...saved } }); toast('Company details saved', 'They go on every statement.', 'ok'); }
  }
  return html`<div class="company-bar">
    <div class="t">Your company details go on every statement. Papers are filed under <b>${ws.name}</b> until you set them.</div>
    <input class="input input-sm" placeholder="Company name" value=${form.legalName} onInput=${set('legalName')} aria-label="Company name" />
    <input class="input input-sm" placeholder="Registered address" value=${form.address} onInput=${set('address')} aria-label="Registered address" />
    <input class="input input-sm hide-narrow" placeholder="City, country" value=${form.city} onInput=${set('city')} aria-label="City and country" />
    <input class="input input-sm hide-narrow" placeholder="EORI number (EU imports)" value=${form.eori} onInput=${set('eori')} aria-label="EORI number" />
    <${Button} size="sm" kind="primary" onClick=${save}>Save<//>
  </div>`;
}

function FromCustomers() {
  const { state, nav, jl, call } = useApp();
  const [members, setMembers] = useState([]);
  useEffect(() => { call(jl.workspaces.members(), { quiet: true }).then((m) => setMembers(Array.isArray(m) ? m : [])); }, [state.workspace?.id]);
  const docs = state.data.documents.filter((d) => d.source?.kind !== 'generated');
  const uploads = new Set(docs.map((d) => d.source?.receivedAt || d.createdAt?.slice(0, 16))).size;
  const latest = docs.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const names = latest.slice(0, 4).map((d) => d.fileName).join(', ');
  return html`<div class="desk-panel">
    <div class="desk-panel-head"><span class="label">From customers</span></div>
    <div class="desk-panel-body">
      ${!docs.length ? html`<div class="soft">Nothing yet. What the house sends from its portal shows here.</div>`
        : html`<div class="from-row"><div class="main"><div class="t">${state.workspace?.name} sent ${plural(docs.length, 'document')} in ${plural(Math.max(1, uploads), 'upload')}</div>
            <div class="d">Last upload ${day(latest[0]?.createdAt)}: ${names}${latest.length > 4 ? ` and ${latest.length - 4} more` : ''}</div></div>
            <button class="btn btn-sm" type="button" onClick=${() => nav.desk('data')}>Open records</button></div>`}
      <div class="label" style=${{ margin: '12px 0 2px' }}>Customer logins</div>
      ${members.map((m, i) => html`<div class="from-row" key=${m.id || m.email || i}><div class="main"><div class="t">${m.name || m.email}</div>
        <div class="d">${m.email ? `Signs in as ${m.email}` : 'Signed in on this computer'} · ${m.role || 'owner'}</div></div>
        <button class="btn btn-sm" type="button" onClick=${() => nav.desk('audit')}>Open records</button></div>`)}
    </div>
  </div>`;
}

function AgentsPanel() {
  const { state, nav, setAutopilot } = useApp();
  const rows = useMemo(() => state.data.activity.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8), [state.data.activity]);
  const ai = state.info?.ai || {};
  const where = ai.mode === 'direct' ? 'with your OpenAI key' : ai.mode === 'proxy' ? 'on the Jewel Labs cloud' : ai.mode === 'demo' ? 'browser demo' : 'offline reader';
  return html`<div class="desk-panel">
    <div class="desk-panel-body" style=${{ paddingTop: '14px' }}>
      <div class="agents-panel">
        <div>
          <div class="row-flex between">
            <div class="agents-on"><span class="label">Agents</span><${Chip} tone=${state.autopilot ? 'ok' : 'muted'} small>${state.autopilot ? 'On' : 'Off'}<//>
              <span class="muted small mono">${ai.model || 'offline'} · ${where}</span></div>
            <div class="row-flex"><button class="btn btn-sm btn-primary" type="button" onClick=${() => nav.desk('settings', 'mailbox')}>Connect a mailbox</button>
              <button class="btn btn-sm" type="button" onClick=${() => setAutopilot(!state.autopilot)}>${state.autopilot ? 'Turn off' : 'Turn on'}</button></div>
          </div>
          <div class="act-list">
            ${!rows.length ? html`<div class="muted small" style=${{ padding: '10px 0' }}>No activity yet.</div>` : rows.map((a) => {
              const agent = actorAgentId(a.actor);
              return html`<div class="act" key=${a.id}>
                <span class="t">${clock(a.at)}</span>
                <span class="a">${agent ? html`<span style=${{ color: agentOf(agent).color }}>${actorName(a.actor)}</span>` : actorName(a.actor)}</span>
                <span class=${`x${/missing|held|error|still needed/i.test(a.detail || '') ? ' warn' : ''}`}>${a.detail}</span>
              </div>`;
            })}
          </div>
        </div>
        <div>
          <div class="agents-note">Connect a mailbox and the agents check it every 5 minutes, file consignment mail under the right house, and draft the paper when a shipment is complete.</div>
          <button class="link-btn small mt-12" type="button" onClick=${() => nav.desk('audit')}>Show all activity (${state.data.activity.length})</button>
        </div>
      </div>
    </div>
  </div>`;
}

function FilterRow({ filter, setFilter }) {
  const { state, jl, call, toast } = useApp();
  const [screen, setScreen] = useState(null);
  const ws = state.workspace || {};
  useEffect(() => {
    const name = ws.legalName || ws.name;
    if (name) call(jl.sanctions.screen(name), { quiet: true }).then(setScreen);
  }, [ws.id, ws.legalName]);
  const s = screeningStatus(screen?.status);
  async function switchHouse(id) {
    if (!id || id === ws.id) return;
    const r = await call(jl.workspaces.select(id));
    if (r) toast('Now filing for', r.name, 'ok');
  }
  return html`<div class="filter-row">
    <div><div class="label mb-8">1. Company</div>
      <select class="select" value=${ws.id || ''} onChange=${(e) => switchHouse(e.currentTarget.value)} aria-label="Company">
        ${(state.workspaces || []).map((w) => html`<option value=${w.id}>${w.name}${w.id === ws.id ? ` (${plural(state.data.documents.length, 'record')})` : ''}</option>`)}
      </select></div>
    <div><div class="label mb-8">2. Paper</div>
      <div class="paper-kinds" role="tablist" aria-label="Which shipment records to list">${RECORD_FILTERS.map((f) => html`<button type="button" role="tab" aria-selected=${filter === f.id ? 'true' : 'false'}
        class=${filter === f.id ? 'active' : ''} onClick=${() => setFilter(f.id)}>${f.label}</button>`)}</div></div>
    <div><div class="label">Sanctions, OFAC SDN</div>
      <div class="sanction-line">${screen ? html`<${Chip} tone=${s.tone} small>${s.text}<//>` : html`<${Chip} small>Screening<//>`}
        <span>${screen?.status === 'clear' ? `No match in ${number(state.sanctions?.count)} entries, list of ${state.sanctions?.date || '…'}` : screen?.best ? `Closest: ${screen.best.sdnName} (${Math.round((screen.best.score || 0) * 100)}%)` : 'Each counterparty is screened when the agents run'}</span></div></div>
  </div>`;
}

function ParcelRequests() {
  const { state, jl, call } = useApp();
  const [queue, setQueue] = useState([]);
  const [compose, setCompose] = useState(false);
  const heldIds = state.data.papers.filter((p) => p.status === 'held_for_review').map((p) => `${p.id}:${p.version}`).join(',');
  useEffect(() => {
    call(jl.desk.queue(), { quiet: true }).then((q) => setQueue(Array.isArray(q) ? q : []));
  }, [heldIds, state.workspace?.id]);

  const returned = state.data.papers.filter((p) => p.approvedAt || p.heldAt).filter((p) => !queue.some((q) => q.paper.id === p.id)).slice(0, 3);
  const messages = state.data.messages.filter((m) => senderOf(m) !== 'agents' && m.kind !== 'request').slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);

  return html`<div class="desk-panel">
    <div class="desk-panel-head"><span class="label">Parcel requests and messages</span>
      <div class="row-flex"><span class="muted small">${queue.length} open · ${returned.length} returned</span>
        <button class="btn btn-sm" type="button" onClick=${() => setCompose(true)}>New message</button></div></div>
    <div class="desk-panel-body">
      ${!queue.length && !returned.length ? html`<div class="soft" style=${{ padding: '4px 0 6px' }}>No packs waiting for review. Packs the rules hold come here for approval before the house signs.</div>` : null}
      ${queue.map((item) => html`<${RequestCard} key=${item.paper.id} item=${item} />`)}
      ${returned.map((p) => html`<${RequestCard} key=${p.id} item=${{ paper: p, shipment: state.data.shipments.find((s) => s.id === p.shipmentId), checks: [], questions: [] }} done />`)}
      ${messages.length ? html`<div class="label" style=${{ margin: '18px 0 4px' }}>Messages with the client</div>
        <div class="messages-list">${messages.map((m) => html`<div class="m" key=${m.id}>
          <div class="meta">${senderOf(m) === 'desk' ? `Jewel Labs desk${m.author ? ` · ${m.author}` : ''}` : `Client: ${m.author || state.workspace?.name || 'the house'}`} · ${dayTime(m.at)}</div>
          <div class="text">${m.text}</div></div>`)}</div>` : null}
    </div>
    ${compose ? html`<${ComposeModal} onClose=${() => setCompose(false)} />` : null}
  </div>`;
}

function RequestCard({ item, done }) {
  const { state, nav, jl, call, toast } = useApp();
  const { paper, shipment, checks = [], questions = [] } = item;
  const [message, setMessage] = useState('');
  const request = state.data.messages.filter((m) => senderOf(m) === 'house' && m.shipmentId === paper.shipmentId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const steps = state.data.activity.filter((a) => a.shipmentId === paper.shipmentId && a.actor?.type === 'agent')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  async function approve() {
    const r = await call(jl.desk.approve(paper.id, message.trim()));
    if (r) toast(`Approved ${paper.ref}`, 'Sent to the client: it is ready to sign in their portal.', 'ok');
  }
  async function hold() {
    if (!message.trim()) return toast('Add a message first', 'Tell the house what to fix.', 'warn');
    const r = await call(jl.desk.hold(paper.id, message.trim()));
    if (r) toast(`Held ${paper.ref}`, 'Your message went to the client.', 'ok');
    return undefined;
  }

  const status = done ? (paper.status === 'held_for_review' ? { text: 'Held, waiting for the client', tone: 'warn' } : { text: 'Sent to the client', tone: 'ok' }) : { text: 'Ready for your approval', tone: 'warn' };
  return html`<div class="request-card">
    <div class="top"><span class="ref">${shipment?.ref || paper.ref}</span><${Chip} tone=${status.tone} small>${status.text}<//></div>
    <div class="text">${request?.text || `Prepare the papers for ${shipment?.ref || 'this parcel'}`}</div>
    <details><summary>Agent activity · ${plural(steps.length, 'step')}</summary>
      <div class="act-list" style=${{ borderTop: 0 }}>${steps.slice(-12).map((a) => html`<div class="act" key=${a.id}><span class="t">${clock(a.at)}</span><span class="a">${actorName(a.actor)}</span><span class="x">${a.detail}</span></div>`)}</div>
    </details>
    ${!done && (checks.length || questions.length) ? html`<div class="issues">
      ${questions.length ? html`<div>Still open: ${questions.map((q) => q.text).join(' ')}</div>` : null}
      ${checks.length ? html`<div>Checks to resolve: ${checks.map((c) => c.title).join(', ')}</div>` : null}
    </div>` : null}
    <div class="btn-row">
      <button class="btn btn-sm" type="button" onClick=${() => nav.paper(paper.id)}>Review ${paper.ref}</button>
      ${done ? null : html`<button class="btn btn-sm" type="button" onClick=${() => nav.shipment(paper.shipmentId)}>Open the shipment</button>`}
    </div>
    ${done ? (paper.deskNote ? html`<div class="issues">Message sent: ${paper.deskNote}</div>` : null) : html`<div class="reply">
      <label class="field-label muted" for=${`msg-${paper.id}`}>Message to the client</label>
      <textarea id=${`msg-${paper.id}`} class="textarea" rows="3" value=${message} onInput=${(e) => setMessage(e.currentTarget.value)} placeholder="Approved. Ready to sign."></textarea>
      <div class="form-actions"><${Button} kind="primary" size="sm" onClick=${approve}>Approve and send to the client<//><${Button} size="sm" onClick=${hold}>Hold with message<//></div>
    </div>`}
  </div>`;
}

function ComposeModal({ onClose }) {
  const { state, jl, call, toast } = useApp();
  const [text, setText] = useState('');
  const [shipmentId, setShipmentId] = useState('');
  async function send() {
    const r = await call(jl.messages.send({ text: text.trim(), shipmentId: shipmentId || null, to: 'house' }));
    if (r) { toast('Message sent', 'The house sees it under Back from Jewel Labs.', 'ok'); onClose(); }
  }
  return html`<${Modal} title="New message to the client" onClose=${onClose} size="narrow"
    footer=${html`<span></span><div class="row-flex"><button class="btn" type="button" onClick=${onClose}>Cancel</button><${Button} kind="primary" onClick=${send} disabled=${!text.trim()}>Send<//></div>`}>
    <div class="form-grid">
      <${Field} label="About" class="span-all"><select class="select" value=${shipmentId} onChange=${(e) => setShipmentId(e.currentTarget.value)}>
        <option value="">No shipment</option>${state.data.shipments.map((s) => html`<option value=${s.id}>${s.ref}</option>`)}</select><//>
      <${Field} label="Message" class="span-all"><textarea class="textarea" rows="5" value=${text} onInput=${(e) => setText(e.currentTarget.value)} placeholder="Please send the packing list for ..."></textarea><//>
    </div>
  <//>`;
}

function Pipeline() {
  const { state, setAutopilot, jl, call } = useApp();
  const busy = busyAgents(state);
  const [mail, setMail] = useState(null);
  useEffect(() => { call(jl.mail.status(), { quiet: true }).then(setMail); }, [state.workspace?.id]);
  const notes = {
    retrieval: mail?.connected ? `checks ${mail.email} every 5 min` : 'needs your company email',
    intake: 'reads every document', records: 'files papers, traces stones', sanctions: 'OFAC SDN screen',
    origin: 'checks origin against the rules', review: 'flags what is missing', paperwork: 'writes and cites',
  };
  return html`<div class="pipeline" aria-label="The agent pipeline">
    ${AGENTS.map((a) => html`<div class="pipe" key=${a.id} style=${{ '--c': a.color }}>
      <div class="t"><${Dot} agent=${a.id} pulse=${Boolean(busy[a.id])} />${a.name}<span class=${`state${busy[a.id] ? ' working' : ''}`}>${busy[a.id] ? 'WORKING' : a.id === 'retrieval' && !mail?.connected ? 'WAITING' : 'ON'}</span></div>
      <div class="d" title=${busy[a.id]?.message || notes[a.id]}>${busy[a.id]?.message || notes[a.id]}</div>
    </div>`)}
    <div class="pipe autopilot"><${Toggle} checked=${state.autopilot} onChange=${setAutopilot} label="Autopilot" /></div>
  </div>`;
}

function ShipmentRecords({ onOnboard, filter = 'all' }) {
  const { state, nav } = useApp();
  const test = (RECORD_FILTERS.find((f) => f.id === filter) || RECORD_FILTERS[0]).test;
  const rows = state.data.shipments.filter((s) => test(s, state.data.papers)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const finals = state.data.papers.filter((p) => p.status === 'signed' || p.status === 'sent').length;
  return html`<div class="desk-panel" style=${{ marginBottom: 0 }}>
    <div class="desk-panel-head"><span class="label">3. Shipment records</span>
      <button class="btn btn-sm" type="button" onClick=${onOnboard}>Upload records (.zip)</button></div>
    <div class="desk-panel-body" style=${{ paddingBottom: '4px' }}>
      <div class="muted small mb-8">${plural(rows.length, 'shipment')}, ${plural(state.data.documents.length, 'document')} each listed once, ${plural(finals, 'final paper')} created. Open any one.</div>
    </div>
    ${!rows.length ? html`<${Empty} title=${state.data.shipments.length ? 'None of this kind' : 'No shipment records yet'}>${state.data.shipments.length ? 'Pick another kind under 2. Paper.' : 'Onboard a house or upload its records to begin.'}<//>` : html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Reference</th><th>Route</th><th>Parties</th><th class="num">Papers</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${rows.map((s) => html`<tr class="clickable" key=${s.id} onClick=${() => nav.shipment(s.id)}>
        <td><span class="ref">${s.ref}</span></td><td>${route(s)}</td>
        <td class="ellipsis" style=${{ maxWidth: '240px' }}>${[s.exporter?.name, s.consignee?.name].filter(Boolean).join(' → ')}</td>
        <td class="num">${state.data.documents.filter((d) => d.shipmentId === s.id).length}</td>
        <td><${StatusChip} status=${shipmentStatus(s.status)} small /></td><td class="muted nowrap">${ago(s.updatedAt)}</td>
      </tr>`)}</tbody></table></div>`}
  </div>`;
}
