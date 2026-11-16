// Stone history: search a report number and see the stone's whole chain, from the mine (KP
// certificate countries) to the signed statement, each step tied to the paper that proves it.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Section, Chip, Empty, Skeleton, Button } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { Timeline } from '../components/timeline.js';
import { carat, growthLabel, labCheckStatus, country, route } from '../lib/format.js';
import { squash } from '../lib/search.js';

export function StonesView({ reportNumber }) {
  const { state, nav, jl, call, toast } = useApp();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null); // { stone, shipment, events }
  const [loading, setLoading] = useState(false);

  const stones = useMemo(() => {
    const q = squash(query);
    return state.data.stones
      .filter((s) => !q || squash(s.reportNumber).includes(q) || squash(s.ref).includes(q))
      .slice()
      .sort((a, b) => Number(b.carat || 0) - Number(a.carat || 0));
  }, [state.data.stones, query]);

  // Open the stone in the address (or the biggest one) when the page opens.
  useEffect(() => {
    const target = reportNumber || state.data.stones.slice().sort((a, b) => Number(b.carat || 0) - Number(a.carat || 0))[0]?.reportNumber;
    if (target) load(target);
    else setResult(null);
  }, [reportNumber, state.data.stones.length, state.data.papers.length]);

  async function load(rn) {
    setLoading(true);
    const r = await call(jl.stones.history(rn), { quiet: true });
    setLoading(false);
    setResult(r && r.stone ? r : { stone: null, events: [], missing: rn });
  }

  function search(e) {
    e.preventDefault();
    const q = query.trim();
    if (q) nav.stone(q.replace(/\s+/g, ''));
  }

  async function verify(stone) {
    const r = await call(jl.stones.verify(stone.id));
    if (!r) return;
    if (r.status === 'open_in_browser' && r.url) {
      await call(jl.app.openExternal(r.url));
      toast(`Opened the ${r.lab} report check`, 'Compare the grades on the lab’s own page.', 'info');
    } else {
      toast(`${stone.lab || 'Lab'} report ${stone.reportNumber}`, labCheckStatus(r).text, 'ok');
      load(stone.reportNumber);
    }
  }

  const stone = result?.stone;
  const shipment = result?.shipment || (stone ? state.data.shipments.find((s) => s.id === stone.shipmentId) : null);
  const check = labCheckStatus(stone?.labCheck);

  return html`<div class="page-inner wide">
    <div class="page-head">
      <div><div class="eyebrow">Stone history</div><h1>Every stone, from the mine to the signature</h1>
        <div class="sub">Search a grading report number. Each step links to the paper that proves it.</div></div>
    </div>
    <div class="history-layout">
      <div>
        <form class="stone-search" onSubmit=${search} role="search">
          <input class="input" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Search a report number" aria-label="Report number" />
          <button class="btn btn-primary" type="submit" style=${{ height: '38px' }} aria-label="Look up">${Icon.search()}</button>
        </form>
        <div class="panel stone-list">
          ${!stones.length ? html`<${Empty} title=${state.data.stones.length ? 'No stone matches' : 'No stones yet'}>${state.data.stones.length ? 'Press Enter to look the number up anyway.' : 'Stones appear once an invoice or packing list is read.'}<//>`
            : stones.slice(0, 60).map((s) => html`<button type="button" key=${s.id} class=${`stone-item${stone?.id === s.id ? ' active' : ''}`} onClick=${() => nav.stone(s.reportNumber || s.id)}>
                <span class="rn">${s.reportNumber || s.ref}</span><span class="muted tiny">${s.lab || ''}</span>
                <span class="grades">${[carat(s.carat), s.color, s.clarity, s.shape].filter(Boolean).join(' · ')}</span>
                <span>${s.growth ? html`<${Chip} small tone=${/lab/i.test(s.growth) ? 'info' : 'plain'}>${growthLabel(s.growth)}<//>` : null}</span>
              </button>`)}
        </div>
      </div>
      <div>
        ${loading && !stone ? html`<${Skeleton} block lines=${4} />`
          : !stone ? html`<${Section}><${Empty} icon=${Icon.gem} title=${result?.missing ? `No stone with report ${result.missing}` : 'Pick a stone'}>
              ${result?.missing ? 'The agents have not seen this report number on any paper yet.' : 'Choose a stone on the left, or search a report number.'}<//><//>`
          : html`<div class="passport">
              <div class="passport-top">
                <div>
                  <div class="label">${stone.lab || 'Lab'} report</div>
                  <div class="rn">${stone.reportNumber || '–'}</div>
                  <div class="lab">${[stone.shape, carat(stone.carat), stone.color, stone.clarity].filter(Boolean).join(' · ')}</div>
                </div>
                <svg class="passport-gem" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
                  <path d="M16 10h32l12 16L32 58 4 26z" /><path d="M4 26h56M24 10l-6 16 14 32 14-32-6-16M18 26l6-16M46 26l-6-16M32 10v16" opacity="0.6" />
                </svg>
              </div>
              <div class="passport-grid">
                <div><div class="label">Growth</div><div class="v">${growthLabel(stone.growth) || '–'}</div></div>
                <div><div class="label">Mined in</div><div class="v">${(stone.kp?.countries || []).map(country).join(', ') || '–'}</div></div>
                <div><div class="label">KP certificate</div><div class="v mono small">${stone.kp?.certificateNumber || '–'}</div></div>
                <div><div class="label">Shipment</div><div class="v">${shipment ? html`<button class="link-btn mono" type="button" onClick=${() => nav.shipment(shipment.id, { tab: 'stones' })}>${shipment.ref}</button>` : '–'}</div></div>
                <div><div class="label">Route</div><div class="v">${shipment ? route(shipment) : '–'}</div></div>
                <div><div class="label">Papers</div><div class="v">${(stone.sources || []).length}</div></div>
              </div>
              <div class="passport-foot">
                <${Chip} tone=${check.tone}>${check.text}<//>
                ${stone.labCheck?.diffs?.length ? html`<span class="small fail">${stone.labCheck.diffs.map((d) => `${d.field}: ours ${d.ours}, lab ${d.lab}`).join('; ')}</span>` : null}
                <span class="spacer" style=${{ flex: 1 }}></span>
                <${Button} size="sm" onClick=${() => verify(stone)} icon=${Icon.shield}>Verify on ${stone.lab || 'the lab'}<//>
              </div>
            </div>
            <${Section} title="History">
              <div class="section-body"><${Timeline} events=${result.events || []} docs=${state.data.documents} lab=${stone.lab}
                onSource=${(e) => nav.document(e.docId, e.field || undefined)} /></div>
            <//>`}
      </div>
    </div>
  </div>`;
}
