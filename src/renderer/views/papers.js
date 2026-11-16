// Papers: every pack and statement the agents built. Preview the PDF, then sign, send, print or download.
import { html, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Section, StatusChip, Chip, Empty, Skeleton, Button, CopyButton } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { PdfPreview } from '../components/pdf-preview.js';
import { usePaperActions, paperNote } from '../components/paper-actions.js';
import { paperStatus, paperKindLabel, day, dayTime, ago, plural } from '../lib/format.js';

const FILTERS = [['all', 'All'], ['ready_to_sign', 'To sign'], ['held_for_review', 'Held'], ['signed', 'Signed'], ['sent', 'Sent']];

export function PapersView({ id, query = {} }) {
  const { state, nav, route } = useApp();
  const [filter, setFilter] = useState('all');
  const actions = usePaperActions();
  const jump = route.query?.page || query.page;

  const papers = useMemo(() => state.data.papers
    .filter((p) => filter === 'all' || p.status === filter)
    .slice()
    .sort((a, b) => String(b.updatedAt || b.builtAt || '').localeCompare(String(a.updatedAt || a.builtAt || ''))), [state.data.papers, filter]);
  const paper = state.data.papers.find((p) => p.id === id) || (!id ? papers[0] : null);
  const shipment = paper ? state.data.shipments.find((s) => s.id === paper.shipmentId) : null;

  return html`<div class="page-inner wide">
    <div class="page-head">
      <div><div class="eyebrow">Papers</div><h1>Packs ready to sign, signed and sent</h1>
        <div class="sub">Each pack is versioned. Signing locks it with a SHA-256 fingerprint; the house or its broker lodges it.</div></div>
      <div class="page-head-actions">
        <div class="seg">${FILTERS.map(([v, l]) => html`<button type="button" class=${filter === v ? 'active' : ''} onClick=${() => setFilter(v)}>${l}</button>`)}</div>
      </div>
    </div>
    ${!state.loaded.papers ? html`<${Skeleton} lines=${6} />`
      : !state.data.papers.length ? html`<${Section}><${Empty} icon=${Icon.doc} title="No papers yet">When the agents finish a shipment, its origin pack comes back here, ready to sign.<//><//>`
      : html`<div class="papers-layout">
          <div class="panel paper-list">
            ${!papers.length ? html`<${Empty}>No papers in this list.<//>` : papers.map((p) => {
              const s = state.data.shipments.find((x) => x.id === p.shipmentId);
              return html`<button type="button" key=${p.id} class=${`paper-item${paper?.id === p.id ? ' active' : ''}`} onClick=${() => nav.paper(p.id)}>
                <div class="l1"><span class="ref">${p.ref} <span class="muted">v${p.version || 1}</span></span><${StatusChip} status=${paperStatus(p.status)} small /></div>
                <div class="l2">${paperKindLabel(p.kind)}${s ? ` · ${s.ref}` : ''}</div>
                <div class="l3">${p.pages ? `${plural(p.pages, 'page')} · ` : ''}${ago(p.updatedAt || p.builtAt)}</div>
              </button>`;
            })}
          </div>
          <div>
            ${paper ? html`
              <${PdfPreview} paper=${paper} title=${`${paper.ref} v${paper.version || 1} · ${paperKindLabel(paper.kind)}`} jumpTo=${jump}
                toolbar=${html`<span style=${{ width: '8px' }}></span>
                  <${Button} size="sm" onClick=${() => actions.print(paper)} icon=${Icon.print}>Print<//>
                  <${Button} size="sm" onClick=${() => actions.download(paper)} icon=${Icon.download}>Download<//>
                  ${paper.status === 'ready_to_sign' ? html`<${Button} size="sm" kind="primary" onClick=${() => actions.sign(paper)} icon=${Icon.pen}>Sign<//>` : null}
                  ${paper.status === 'signed' ? html`<${Button} size="sm" kind="primary" onClick=${() => actions.send(paper)} icon=${Icon.send}>Send<//>` : null}`} />
              <div class="panel mt-12">
                <div class="paper-meta">
                  <div><div class="label">Status</div><div class="v"><${StatusChip} status=${paperStatus(paper.status)} small /></div></div>
                  <div><div class="label">Shipment</div><div class="v">${shipment ? html`<button class="link-btn mono" type="button" onClick=${() => nav.shipment(shipment.id, { tab: 'papers' })}>${shipment.ref}</button>` : '–'}</div></div>
                  <div><div class="label">${paper.status === 'sent' ? 'Sent' : paper.status === 'signed' ? 'Signed' : 'Built'}</div>
                    <div class="v">${paper.status === 'sent' ? `${paper.sentTo || ''} · ${dayTime(paper.sentAt)}` : paper.status === 'signed' ? `${paper.signedBy} · ${dayTime(paper.signedAt)}` : dayTime(paper.builtAt || paper.createdAt)}</div></div>
                  <div><div class="label">Pages</div><div class="v">${paper.pages || '–'}</div></div>
                </div>
                <div class="section-body" style=${{ borderTop: '1px solid var(--line)' }}>
                  <div class="soft">${paperNote(paper)}</div>
                  ${paper.sha256 ? html`<div class="row-flex mt-12"><span class="label">SHA-256</span><span class="hash ellipsis" title=${paper.sha256}>${paper.sha256}</span><${CopyButton} text=${paper.sha256} /></div>` : null}
                  ${(paper.contents || []).length ? html`<div class="mt-16"><div class="label mb-8">In this pack, in the order customs reads them</div>
                    <ol class="soft small" style=${{ margin: 0, paddingLeft: '18px', lineHeight: 1.8 }}>
                      ${paper.contents.map((c, i) => html`<li key=${i}>${c.docId ? html`<button class="link-btn" type="button" onClick=${() => nav.document(c.docId)}>${c.title}</button>` : c.title}</li>`)}
                    </ol></div>` : null}
                  ${(paper.versions || []).length > 1 ? html`<div class="mt-16"><div class="label mb-8">Versions</div>
                    ${paper.versions.slice().reverse().map((v) => html`<div class="row-flex small soft" key=${v.version}><span class="mono">v${v.version}</span><span>${day(v.builtAt)}</span><${Chip} small>${String(v.status || '').replace(/_/g, ' ')}<//></div>`)}</div>` : null}
                </div>
              </div>` : html`<${Section}><${Empty}>Pick a paper on the left.<//><//>`}
          </div>
        </div>`}
    ${actions.modals}
  </div>`;
}
