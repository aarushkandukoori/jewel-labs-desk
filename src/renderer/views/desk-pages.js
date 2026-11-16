// Desk pages: 02 Data (every document), 03 Filings (every paper), 04 Counterparties (OFAC screening),
// 05 Audit trail, 06 Metrics (per house: shipments, staff, packs, minutes to signature, autonomy).
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Section, Chip, StatusChip, Empty, Skeleton } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { ActivityList } from './activity.js';
import { docTypeLabel, sourceLabel, docStatus, confidence, ago, paperStatus, paperKindLabel, screeningStatus, number, percent, country, plural } from '../lib/format.js';

function Head({ eyebrow, title, sub, right }) {
  return html`<div class="desk-head"><div><div class="label">${eyebrow}</div><h1>${title}</h1>${sub ? html`<div class="soft small mt-4">${sub}</div>` : null}</div>
    ${right ? html`<div class="desk-head-right">${right}</div>` : null}</div>`;
}

export function DataPage() {
  const { state, nav } = useApp();
  const [q, setQ] = useState('');
  const docs = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.data.documents
      .filter((d) => !needle || `${d.fileName} ${docTypeLabel(d.docType)}`.toLowerCase().includes(needle))
      .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [state.data.documents, q]);
  return html`<div>
    <${Head} eyebrow="02 Data" title=${`Every paper from ${state.workspace?.name || 'this house'}`} sub="Each file once, with where it came from, what the agents read it as, and how sure they are."
      right=${html`<input class="input input-sm" style=${{ width: '260px' }} placeholder="Search file names and types" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Search documents" />`} />
    ${!state.loaded.documents ? html`<${Skeleton} lines=${8} />` : !docs.length ? html`<${Section}><${Empty} icon=${Icon.file} title="No documents">Nothing has come in yet.<//><//>`
      : html`<div class="panel"><div class="table-wrap"><table class="table">
        <thead><tr><th>File</th><th>Read as</th><th>Source</th><th>Shipment</th><th class="num">Fields</th><th class="num">Sure</th><th>Status</th><th>Received</th></tr></thead>
        <tbody>${docs.map((d) => {
          const s = state.data.shipments.find((x) => x.id === d.shipmentId);
          const st = docStatus(d.status);
          return html`<tr class="clickable" key=${d.id} onClick=${() => nav.document(d.id)}>
            <td class="strong ellipsis" style=${{ maxWidth: '260px' }}>${d.fileName}</td><td>${docTypeLabel(d.docType)}</td>
            <td><${Chip} mono small>${sourceLabel(d.source)}<//></td><td>${s ? html`<span class="ref">${s.ref}</span>` : html`<span class="muted">Not filed yet</span>`}</td>
            <td class="num">${(d.fields || []).length}</td><td class="num">${d.classifyConfidence ? confidence(d.classifyConfidence) : ''}</td>
            <td><${Chip} tone=${st.tone} small>${st.text}<//></td><td class="muted nowrap">${ago(d.createdAt)}</td>
          </tr>`;
        })}</tbody></table></div></div>`}
  </div>`;
}

export function FilingsPage() {
  const { state, nav } = useApp();
  const papers = state.data.papers.slice().sort((a, b) => String(b.updatedAt || b.builtAt || '').localeCompare(String(a.updatedAt || a.builtAt || '')));
  const held = papers.filter((p) => p.status === 'held_for_review').length;
  return html`<div>
    <${Head} eyebrow="03 Filings" title="Packs and statements" sub="Jewel Labs prepares them; the house signs, and the house or its broker lodges them."
      right=${held ? html`<${Chip} tone="warn">${plural(held, 'pack')} held for review<//>` : null} />
    ${!papers.length ? html`<${Section}><${Empty} icon=${Icon.doc} title="No papers yet">They appear when the agents finish a shipment.<//><//>`
      : html`<div class="panel"><div class="table-wrap"><table class="table">
        <thead><tr><th>Reference</th><th>Paper</th><th>Shipment</th><th class="num">Version</th><th class="num">Pages</th><th>Status</th><th>Signed or sent</th><th>Updated</th></tr></thead>
        <tbody>${papers.map((p) => {
          const s = state.data.shipments.find((x) => x.id === p.shipmentId);
          return html`<tr class="clickable" key=${p.id} onClick=${() => nav.paper(p.id)}>
            <td><span class="ref">${p.ref}</span></td><td>${paperKindLabel(p.kind)}</td><td>${s ? html`<span class="ref">${s.ref}</span>` : ''}</td>
            <td class="num">v${p.version || 1}</td><td class="num">${p.pages || ''}</td><td><${StatusChip} status=${paperStatus(p.status)} small /></td>
            <td class="small">${p.sentTo ? `Sent to ${p.sentTo}` : p.signedBy ? `Signed by ${p.signedBy}` : ''}</td><td class="muted nowrap">${ago(p.updatedAt || p.builtAt)}</td>
          </tr>`;
        })}</tbody></table></div></div>`}
  </div>`;
}

/** Counterparties with their latest OFAC screening. Uses jl.parties when the app has it, else screens the names on the shipments. */
export function CounterpartiesPage() {
  const { state, jl, call } = useApp();
  const [screened, setScreened] = useState(null);

  const names = useMemo(() => {
    const out = new Map();
    for (const s of state.data.shipments) {
      for (const [role, p] of [['Exporter', s.exporter], ['Consignee', s.consignee], ['Buyer', s.buyer], ['Supplier', s.supplier]]) {
        if (!p?.name) continue;
        const key = p.name.toLowerCase();
        const row = out.get(key) || { name: p.name, country: p.country, roles: new Set(), shipments: new Set() };
        row.roles.add(role);
        row.shipments.add(s.ref);
        out.set(key, row);
      }
    }
    return [...out.values()];
  }, [state.data.shipments]);

  useEffect(() => {
    if (state.data.parties.length) return;
    let live = true;
    (async () => {
      const rows = [];
      for (const n of names) rows.push({ ...n, screening: await call(jl.sanctions.screen(n.name), { quiet: true }) });
      if (live) setScreened(rows);
    })();
    return () => { live = false; };
  }, [names, state.data.parties.length]);

  const rows = state.data.parties.length
    ? state.data.parties.map((p) => ({ name: p.name, country: p.country, roles: new Set(p.roles || (p.role ? [p.role] : [])), shipments: new Set(p.shipmentRefs || []), screening: p.screening || p }))
    : screened;
  const listDate = state.sanctions?.date;

  return html`<div>
    <${Head} eyebrow="04 Counterparties" title="Everyone in the papers, screened" sub=${`Each party is compared with the OFAC SDN list (${state.sanctions ? `${number(state.sanctions.count)} entries, ${listDate}` : 'loading'}). A close name goes to review, never straight through.`} />
    ${rows === null ? html`<${Skeleton} lines=${6} />` : !rows.length ? html`<${Section}><${Empty} icon=${Icon.shield} title="No counterparties yet">They appear once the agents read the parties on an invoice.<//><//>`
      : html`<div class="panel"><div class="table-wrap"><table class="table">
        <thead><tr><th>Party</th><th>Country</th><th>Role</th><th>Screening</th><th class="num">Names compared</th><th>Closest SDN name</th><th>List date</th></tr></thead>
        <tbody>${rows.map((r, i) => {
          const s = screeningStatus(r.screening?.status);
          return html`<tr key=${r.name + i}>
            <td class="strong">${r.name}</td><td>${country(r.country) || '–'}</td><td class="small">${[...(r.roles || [])].join(', ')}</td>
            <td><${Chip} tone=${s.tone} small>${s.text}<//></td><td class="num">${r.screening?.compared ?? ''}</td>
            <td class="small">${r.screening?.best ? `${r.screening.best.sdnName} (${Math.round((r.screening.best.score || 0) * 100)}%)` : html`<span class="muted">None close</span>`}</td>
            <td class="muted">${r.screening?.listDate || listDate || ''}</td>
          </tr>`;
        })}</tbody></table></div></div>`}
  </div>`;
}

export function AuditPage() {
  return html`<div>
    <${Head} eyebrow="05 Audit trail" title="Every step, with its time" sub="Agents and people alike. Nothing is edited after the fact." />
    <${ActivityList} limit=${600} />
  </div>`;
}

export function MetricsPage() {
  const { jl, call, state } = useApp();
  const [metrics, setMetrics] = useState(null);
  useEffect(() => { call(jl.metrics.get()).then((m) => setMetrics(m || { houses: [], totals: {} })); }, [state.data.papers.length, state.workspace?.id]);
  const houses = metrics?.houses || [];
  const t = metrics?.totals || {};
  const sum = (k) => houses.filter((h) => h.inTotals !== false).reduce((n, h) => n + (Number(h[k]) || 0), 0);
  const tiles = [
    ['Live shipments', t.liveShipments ?? sum('liveShipments'), 'not yet sent'],
    ['Staff signing in', t.activeUsers7d ?? sum('activeUsers7d'), 'house staff, last 7 days'],
    ['Packs signed', t.packsSigned ?? sum('packsSigned'), 'all time'],
    ['Packs sent', t.packsSent ?? sum('packsSent'), 'from the house’s mailbox'],
    ['Minutes to sign', t.medianMinutesToSigned ?? houses[0]?.medianMinutesToSigned, 'median, first upload to signed'],
    ['Autonomy rate', t.autonomyRate ?? houses[0]?.autonomyRate, 'signed with no person editing'],
  ];
  return html`<div>
    <${Head} eyebrow="06 Metrics" title="How the houses use Jewel Labs" sub="Sandbox houses get a row but stay out of the totals. Test logins are listed, never counted." />
    ${!metrics ? html`<${Skeleton} lines=${6} />` : html`
      <div class="stats six mb-16">${tiles.map(([label, value, note]) => html`<div class="stat"><div class="label">${label}</div>
        <div class="v">${value === null || value === undefined ? '–' : label === 'Autonomy rate' ? percent(value) : label === 'Minutes to sign' ? html`${number(value)}<small>min</small>` : number(value)}</div>
        <div class="d">${note}</div></div>`)}</div>
      <div class="panel"><div class="table-wrap"><table class="table house-table">
        <thead><tr><th>House</th><th>Environment</th><th class="num" title="Shipments not yet sent">Live</th><th class="num" title="House staff who signed in during the last 7 days">Staff</th><th class="num" title="Sign-ins during the last 7 days">Sign-ins 7d</th><th class="num">Signed</th><th class="num">Sent</th><th class="num" title="Median minutes from the first upload to the signed pack">Minutes to sign</th><th title="Signed packs no person edited">Autonomy</th><th>Last activity</th></tr></thead>
        <tbody>${!houses.length ? html`<tr><td colspan="10"><${Empty}>No houses yet.<//></td></tr>` : houses.map((h) => html`<tr key=${h.id || h.name}>
          <td><span class="name">${h.name || 'House'}</span></td>
          <td><${Chip} small tone=${h.environment === 'sandbox' ? 'warn' : 'ok'}>${h.environment || 'live'}<//></td>
          <td class="num">${number(h.liveShipments ?? h.shipments)}</td><td class="num">${number(h.activeUsers7d)}</td><td class="num">${number(h.signInsLast7d)}</td>
          <td class="num">${number(h.packsSigned ?? h.signed)}</td><td class="num">${number(h.packsSent ?? h.sent)}</td>
          <td class="num">${h.medianMinutesToSigned == null ? '–' : number(h.medianMinutesToSigned)}</td>
          <td class="nowrap">${h.autonomyRate == null ? html`<span class="muted">none signed</span>` : html`${percent(h.autonomyRate)}<span class="rate-bar"><i style=${{ width: `${Math.round(h.autonomyRate * 100)}%` }}></i></span>`}</td>
          <td class="muted nowrap">${h.lastActivityAt ? ago(h.lastActivityAt) : '–'}</td>
        </tr>`)}</tbody></table></div></div>`}
  </div>`;
}
