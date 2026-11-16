// One shipment: header and totals, then its documents (with the viewer), checks, questions,
// stones, papers and activity. Everything links back to the page a value came from.
import { html, useMemo } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { replaceQuery } from '../lib/router.js';
import { Section, StatusChip, Chip, Button, Empty, Dot } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { DocumentViewer, DocItem } from '../components/doc-viewer.js';
import { QuestionRow } from '../components/questions.js';
import { useUpload } from '../components/upload.js';
import { usePaperActions, PaperButtons, paperNote } from '../components/paper-actions.js';
import { shipmentStatus, paperStatus, paperKindLabel, route, money, number, carat, growthLabel, labCheckStatus, severityTone, dayTime, plural } from '../lib/format.js';
import { activityChip, actorName } from '../lib/reading.js';
import { FIELD_LABELS } from '../lib/labels.js';

const TABS = ['documents', 'checks', 'questions', 'stones', 'papers', 'activity'];
const TAB_LABELS = { documents: 'Documents', checks: 'Checks', questions: 'Questions', stones: 'Stones', papers: 'Papers', activity: 'Activity' };

export function ShipmentView({ id, query = {} }) {
  const { state, nav, route: current, jl, call, toast, runAgents } = useApp();
  const upload = useUpload();
  const unfiled = id === 'unfiled';
  const shipment = unfiled
    ? { id: 'unfiled', ref: 'Not filed yet', status: 'collecting', totals: {}, documentIds: [] }
    : state.data.shipments.find((s) => s.id === id);

  const docs = useMemo(() => state.data.documents
    .filter((d) => (unfiled ? !d.shipmentId : d.shipmentId === id))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))), [state.data.documents, id]);
  const checks = state.data.checks.filter((c) => c.shipmentId === id);
  const questions = state.data.questions.filter((q) => q.shipmentId === id && q.status === 'open');
  const stones = state.data.stones.filter((s) => s.shipmentId === id);
  const papers = state.data.papers.filter((p) => p.shipmentId === id);
  const activity = state.data.activity.filter((a) => a.shipmentId === id).slice(0, 60);

  const tab = TABS.includes(query.tab) ? query.tab : 'documents';
  const docId = query.doc && docs.some((d) => d.id === query.doc) ? query.doc : docs[0]?.id;
  const doc = docs.find((d) => d.id === docId);
  const setQuery = (patch) => replaceQuery(current, patch);

  if (!shipment) {
    return html`<div class="page-inner"><button class="back-link" type="button" onClick=${() => nav.shipments()}>${Icon.arrowLeft()} All shipments</button>
      <${Section}><${Empty} title="This shipment is not here">It may still be loading, or it was removed.<//><//></div>`;
  }

  const counts = { documents: docs.length, checks: checks.length, questions: questions.length, stones: stones.length, papers: papers.length, activity: activity.length };
  const warn = checks.filter((c) => c.severity === 'warn' || c.severity === 'fail').length;

  async function build() {
    const result = await call(jl.papers.build(id));
    if (result) toast('Building the papers', 'The Paperwork agent writes the pack and cites every value.', 'ok');
  }

  return html`<div class="page-inner wide">
    ${upload.input}
    <button class="back-link" type="button" onClick=${() => nav.shipments()}>${Icon.arrowLeft()} All shipments</button>
    <div class="ship-head">
      <div style=${{ minWidth: 0 }}>
        <div class="eyebrow">Shipment${shipment.direction && shipment.direction !== 'unknown' ? ` · ${shipment.direction}` : ''}</div>
        <h1>${shipment.ref}</h1>
        ${unfiled ? html`<div class="route">Papers the Records agent could not place yet. Answer its questions or add the invoice that ties them together.</div>`
          : html`<div class="route">
            <span>${shipment.exporter?.name || 'Exporter not read yet'}</span><span class="arrow">→</span><span>${shipment.consignee?.name || 'Consignee not read yet'}</span>
            <span class="muted">·</span><span>${route(shipment)}</span>
            <${StatusChip} status=${shipmentStatus(shipment.status)} small />
          </div>`}
      </div>
      ${unfiled ? null : html`<div class="page-head-actions">
        <${Button} onClick=${() => runAgents(id)} icon=${Icon.play} kbd="Space">Run the agents<//>
        <${Button} onClick=${() => upload.choose()} icon=${Icon.upload}>Add papers<//>
        ${['ready_to_sign', 'held_for_review', 'questions'].includes(shipment.status) ? html`<${Button} kind="primary" onClick=${build} icon=${Icon.doc}>Build the papers<//>` : null}
      </div>`}
    </div>

    ${unfiled ? null : html`<div class="totals">
      <div><div class="label">Pieces</div><div class="v">${shipment.totals?.pieces ?? (stones.length || '–')}</div></div>
      <div><div class="label">Carats</div><div class="v">${shipment.totals?.carats ? number(shipment.totals.carats, 2) : '–'}</div></div>
      <div><div class="label">Value</div><div class="v">${shipment.totals?.value ? money(shipment.totals.value, shipment.totals.currency) : '–'}</div></div>
      <div><div class="label">Invoice</div><div class="v mono">${shipment.invoiceNumber || '–'}</div></div>
      <div><div class="label">Shipping bill</div><div class="v mono">${shipment.shippingBillNumber || '–'}</div></div>
      <div><div class="label">Air waybill</div><div class="v mono">${shipment.hawb || shipment.mawb || '–'}</div></div>
      <div><div class="label">Checks</div><div class="v">${shipment.summary?.total ? `${shipment.summary.passed} of ${shipment.summary.total}` : checks.length ? `${checks.filter((c) => c.severity === 'pass').length} of ${checks.length}` : '–'}</div></div>
    </div>`}

    <div class="tabs-inline" role="tablist">
      ${TABS.map((t) => html`<button type="button" role="tab" aria-selected=${tab === t ? 'true' : 'false'} class=${tab === t ? 'active' : ''}
        onClick=${() => setQuery({ tab: t === 'documents' ? undefined : t })}>${TAB_LABELS[t]}<span class="n">${counts[t]}</span>
        ${t === 'questions' && counts.questions ? html` <${Dot} tone="warn" />` : null}${t === 'checks' && warn ? html` <${Dot} tone="warn" />` : null}</button>`)}
    </div>

    ${tab === 'documents' ? html`
      ${!docs.length ? html`<${Section}><${Empty} icon=${Icon.file} title="No papers yet" action=${html`<button class="btn" type="button" onClick=${() => upload.choose()}>Add papers</button>`}>Add the invoice, packing list and the rest; the agents file them here.<//><//>`
        : html`<div class="doc-layout">
          <div class="panel doc-list">${docs.map((d) => html`<${DocItem} key=${d.id} doc=${d} active=${d.id === docId} onClick=${() => setQuery({ doc: d.id, field: undefined })} />`)}</div>
          ${doc ? html`<${DocumentViewer} doc=${doc} focusKey=${query.field} onFocus=${(key) => setQuery({ doc: doc.id, field: key })} />` : null}
        </div>`}` : null}

    ${tab === 'checks' ? html`<${Section} title="Checks" right=${shipment.summary?.total ? `${shipment.summary.passed} of ${shipment.summary.total} consistent` : ''}>
      ${!checks.length ? html`<${Empty} title="No checks yet">The Origin agent runs the rules once the papers are read.<//>`
        : html`<div>${sortChecks(checks).map((c) => html`<${CheckRow} key=${c.id} check=${c} docs=${state.data.documents} onEvidence=${(e) => nav.document(e.docId, e.key)} />`)}</div>`}
    <//>` : null}

    ${tab === 'questions' ? html`<${Section} title="Questions from the agents" right=${questions.length ? plural(questions.length, 'open question') : ''}>
      ${!questions.length ? html`<${Empty} title="No questions">Nothing uncertain. The agents only ask when a paper is missing or two papers disagree.<//>`
        : questions.map((q) => html`<${QuestionRow} key=${q.id} question=${q} onUpload=${() => upload.choose()} />`)}
    <//>` : null}

    ${tab === 'stones' ? html`<${StonesTable} stones=${stones} />` : null}

    ${tab === 'papers' ? html`<${ShipmentPapers} papers=${papers} shipment=${shipment} onBuild=${build} />` : null}

    ${tab === 'activity' ? html`<${Section} title="Activity for this shipment">
      ${!activity.length ? html`<${Empty}>Nothing yet.<//>` : html`<div class="feed">${activity.map((a) => {
        const chip = activityChip(a.action);
        return html`<div class="feed-row" key=${a.id}><span class="who ellipsis">${actorName(a.actor)}</span><${Chip} tone=${chip.tone} small>${chip.text}<//>
          <span class="what">${a.detail}</span><span class="when">${dayTime(a.at)}</span></div>`;
      })}</div>`}
    <//>` : null}
  </div>`;
}

function sortChecks(checks) {
  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  return checks.slice().sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
}

const CHECK_ICONS = { pass: 'check', info: 'info', warn: 'warn', fail: 'x' };

function CheckRow({ check, docs, onEvidence }) {
  const icon = Icon[CHECK_ICONS[check.severity] || 'info'];
  return html`<div class="check-row">
    <span class=${`check-icon ${check.severity}`}>${icon()}</span>
    <div style=${{ minWidth: 0 }}>
      <div class="t">${check.title}</div>
      ${check.detail ? html`<div class="d">${check.detail}</div>` : null}
      ${(check.evidence || []).length ? html`<div class="evidence">${check.evidence.slice(0, 6).map((e, i) => {
        const doc = docs.find((d) => d.id === e.docId);
        return html`<button type="button" key=${i} onClick=${() => onEvidence(e)} title="Show it on the page">${Icon.link()}${doc?.fileName || 'Paper'}${e.key ? ` · ${FIELD_LABELS[e.key] || e.key}` : ''}</button>`;
      })}</div>` : null}
    </div>
    <${Chip} tone=${severityTone(check.severity)} small>${check.severity}<//>
  </div>`;
}

export function StonesTable({ stones }) {
  const { jl, call, toast, nav } = useApp();
  async function verify(stone) {
    const result = await call(jl.stones.verify(stone.id));
    if (!result) return;
    if (result.status === 'open_in_browser' && result.url) {
      await call(jl.app.openExternal(result.url));
      toast(`Opened the ${result.lab} report check`, 'Compare the grades on the lab’s own page.', 'info');
    } else {
      const s = labCheckStatus(result);
      toast(`${stone.lab || 'Lab'} report ${stone.reportNumber}`, s.text, s.tone === 'fail' ? 'error' : 'ok');
    }
  }
  if (!stones.length) return html`<${Section} title="Stones"><${Empty} icon=${Icon.gem} title="No stones traced yet">The Records agent lists each stone once the invoice or packing list is read.<//><//>`;
  return html`<div class="panel"><div class="table-wrap"><table class="table">
    <thead><tr><th>Report</th><th>Lab</th><th>Shape</th><th class="num">Carat</th><th>Colour</th><th>Clarity</th><th>Growth</th><th class="num">Sources</th><th>Lab check</th><th></th></tr></thead>
    <tbody>${stones.map((s) => {
      const check = labCheckStatus(s.labCheck);
      return html`<tr key=${s.id}>
        <td><button class="link-btn mono" type="button" onClick=${() => nav.stone(s.reportNumber || s.id)} title="Open this stone’s history">${s.reportNumber || s.ref || '–'}</button></td>
        <td>${s.lab || '–'}</td><td>${s.shape || ''}</td><td class="num">${s.carat != null ? Number(s.carat).toFixed(2) : ''}</td>
        <td>${s.color || ''}</td><td>${s.clarity || ''}</td>
        <td>${s.growth ? html`<${Chip} small tone=${/lab/i.test(s.growth) ? 'info' : 'plain'}>${growthLabel(s.growth)}<//>` : ''}</td>
        <td class="num">${(s.sources || []).length}</td>
        <td><${Chip} small tone=${check.tone}>${check.text}<//></td>
        <td class="right"><button class="btn btn-sm" type="button" onClick=${() => verify(s)} disabled=${!s.reportNumber}>Verify on ${s.lab || 'the lab'}</button></td>
      </tr>`;
    })}</tbody>
  </table></div></div>`;
}

function ShipmentPapers({ papers, shipment, onBuild }) {
  const actions = usePaperActions();
  return html`<${Section} title="Papers" right=${['ready_to_sign', 'held_for_review'].includes(shipment.status) ? html`<${Button} size="sm" onClick=${onBuild}>Build again<//>` : ''}>
    ${!papers.length ? html`<${Empty} icon=${Icon.doc} title="No papers yet">When every check passes, the Paperwork agent builds the origin pack here.<//>`
      : html`<div class="rows">${papers.map((p) => html`<div class="paper-row" key=${p.id}>
          <div class="main"><div class="line1"><span class="ref">${p.ref} v${p.version || 1}</span><span class="soft">${paperKindLabel(p.kind)}</span><${StatusChip} status=${paperStatus(p.status)} small /></div>
            <div class="note">${paperNote(p)}</div></div>
          <${PaperButtons} paper=${p} actions=${actions} />
        </div>`)}</div>`}
    ${actions.modals}
  <//>`;
}
