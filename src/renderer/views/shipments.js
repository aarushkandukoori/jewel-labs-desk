// Shipments: every parcel the agents have put together, newest first.
import { html, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Section, StatusChip, Empty, Skeleton, Chip } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { shipmentStatus, route, ago, number, money } from '../lib/format.js';
import { useUpload, DropZone } from '../components/upload.js';

export function ShipmentsView() {
  const { state, nav } = useApp();
  const [filter, setFilter] = useState('open');
  const upload = useUpload();

  const rows = useMemo(() => {
    const all = state.data.shipments.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    if (filter === 'open') return all.filter((s) => s.status !== 'sent');
    if (filter === 'done') return all.filter((s) => s.status === 'signed' || s.status === 'sent');
    return all;
  }, [state.data.shipments, filter]);
  const unfiled = state.data.documents.filter((d) => !d.shipmentId && d.status !== 'error' && d.source?.kind !== 'generated');

  return html`<div class="page-inner wide">
    ${upload.input}
    <div class="page-head">
      <div><div class="eyebrow">Shipments</div><h1>Every parcel, with its papers</h1>
        <div class="sub">The Records agent files each paper under its shipment and traces every stone in it.</div></div>
      <div class="page-head-actions">
        <div class="seg">${[['open', 'Open'], ['done', 'Signed or sent'], ['all', 'All']].map(([v, l]) => html`<button type="button" class=${filter === v ? 'active' : ''} onClick=${() => setFilter(v)}>${l}</button>`)}</div>
        <button class="btn" type="button" onClick=${() => upload.choose()}>${Icon.upload()}Add documents</button>
      </div>
    </div>
    ${!state.loaded.shipments ? html`<${Skeleton} lines=${6} />` : !rows.length && !unfiled.length
      ? html`<${Section}><${Empty} icon=${Icon.box} title="No shipments yet">Drop a parcel’s papers and the agents put the shipment together.<//>
          <${DropZone} upload=${upload} /><//>`
      : html`<div class="panel"><div class="table-wrap"><table class="table">
          <thead><tr><th>Reference</th><th>Route</th><th>Consignee</th><th class="num">Papers</th><th class="num">Stones</th><th class="num">Carats</th><th class="num">Value</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            ${rows.map((s) => {
              const docs = state.data.documents.filter((d) => d.shipmentId === s.id).length;
              const stones = state.data.stones.filter((x) => x.shipmentId === s.id).length;
              return html`<tr class="clickable" key=${s.id} onClick=${() => nav.shipment(s.id)} tabindex="0" onKeyDown=${(e) => e.key === 'Enter' && nav.shipment(s.id)}>
                <td><span class="ref">${s.ref}</span></td>
                <td>${route(s)}</td>
                <td class="ellipsis" style=${{ maxWidth: '220px' }}>${s.consignee?.name || '–'}</td>
                <td class="num">${docs}</td>
                <td class="num">${stones || s.totals?.pieces || ''}</td>
                <td class="num">${s.totals?.carats ? number(s.totals.carats, 2) : ''}</td>
                <td class="num">${s.totals?.value ? money(s.totals.value, s.totals.currency) : ''}</td>
                <td><${StatusChip} status=${shipmentStatus(s.status)} small /></td>
                <td class="muted nowrap">${ago(s.updatedAt)}</td>
              </tr>`;
            })}
            ${unfiled.length ? html`<tr class="clickable" onClick=${() => nav.shipment('unfiled')}>
              <td><span class="muted">Not filed yet</span></td><td colspan="2" class="muted">Papers the agents could not place under a shipment yet</td>
              <td class="num">${unfiled.length}</td><td></td><td></td><td></td><td><${Chip} small tone="warn">Needs a look<//></td><td></td>
            </tr>` : null}
          </tbody>
        </table></div></div>`}
  </div>`;
}
