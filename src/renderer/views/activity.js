// Activity: the audit trail. Every step by an agent or a person, with its time. Searchable.
import { html, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Section, Chip, Empty } from '../components/ui.js';
import { activityChip, actorName } from '../lib/reading.js';
import { dayTime } from '../lib/format.js';

export function ActivityList({ limit = 300, compact }) {
  const { state, nav } = useApp();
  const [q, setQ] = useState('');
  const [who, setWho] = useState('all');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.data.activity
      .filter((a) => who === 'all' || (who === 'agents' ? a.actor?.type === 'agent' : a.actor?.type !== 'agent'))
      .filter((a) => !needle || `${a.detail} ${a.action} ${actorName(a.actor)}`.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit);
  }, [state.data.activity, q, who]);

  return html`<${Section} title=${`Audit trail · ${state.data.activity.length} entries`} right=${html`
      <div class="seg">${[['all', 'Everyone'], ['agents', 'Agents'], ['people', 'People']].map(([v, l]) => html`<button type="button" class=${who === v ? 'active' : ''} onClick=${() => setWho(v)}>${l}</button>`)}</div>
      <input class="input input-sm" style=${{ width: '220px' }} value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Search the trail" aria-label="Search the audit trail" />`}>
    ${!rows.length ? html`<${Empty} title="Nothing here yet">Every step the agents take, and every person’s change, is written here with its time.<//>`
      : html`<div class="feed">${rows.map((a) => {
          const chip = activityChip(a.action);
          const shipment = a.shipmentId ? state.data.shipments.find((s) => s.id === a.shipmentId) : null;
          return html`<div class="feed-row" key=${a.id} style=${{ gridTemplateColumns: compact ? '80px 88px minmax(0,1fr) auto' : '110px 92px minmax(0,1fr) 120px 110px' }}>
            <span class="who ellipsis">${actorName(a.actor)}</span>
            <${Chip} tone=${chip.tone} small>${chip.text}<//>
            <span class="what">${a.detail}</span>
            ${compact ? null : html`<span class="small">${shipment ? html`<button class="link-btn mono" type="button" onClick=${() => nav.shipment(shipment.id)}>${shipment.ref}</button>` : ''}</span>`}
            <span class="when">${dayTime(a.at)}</span>
          </div>`;
        })}</div>`}
  <//>`;
}

export function ActivityView() {
  return html`<div class="page-inner wide">
    <div class="page-head"><div><div class="eyebrow">Activity</div><h1>Everything the agents and your team did</h1>
      <div class="sub">An audit trail you can hand to customs or your bank: who did what, and when.</div></div></div>
    <${ActivityList} />
  </div>`;
}
