// The status bar along the bottom (always visible): environment, model, OCR, rules, OFAC list, audit
// trail size, and the keyboard hints on the right.
import { html } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { number } from '../lib/format.js';
import { busyAgents } from '../lib/store.js';
import { agentOf } from '../lib/labels.js';

function modelText(info) {
  const ai = info?.ai;
  if (!ai) return 'Offline reader';
  if (ai.mode === 'off') return 'Offline reader';
  const where = ai.mode === 'proxy' ? 'Jewel Labs cloud' : ai.mode === 'direct' ? 'your OpenAI key' : ai.mode === 'demo' ? 'demo' : '';
  return `${ai.model || 'AI'}${where ? ` · ${where}` : ''}`;
}

export function StatusBar() {
  const { state, dispatch } = useApp();
  const info = state.info || {};
  const sample = info.sample || state.workspace?.sample;
  const env = state.demo ? 'Demo' : sample ? 'Sandbox' : 'Live';
  const busy = busyAgents(state);
  const busyNames = Object.keys(busy).map((id) => agentOf(id).name);
  const ofac = state.sanctions;
  const audit = state.data.activity.length;
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');

  return html`<footer class="statusbar" role="contentinfo">
    <span class="item env"><span class=${`dot ${env === 'Live' ? 'dot-ok live-dot' : env === 'Demo' ? 'dot-info' : 'dot-warn'}`}></span>${env}</span>
    <span class="item">Model <b>${modelText(info)}</b></span>
    <span class="item opt">OCR <b>Tesseract 7</b></span>
    <span class="item opt">Rules <b class="mono">compliance.js</b></span>
    <span class="item" title=${ofac?.source || 'OFAC Specially Designated Nationals list'}>OFAC <b>${ofac ? `${number(ofac.count)} entries, ${ofac.date || 'date unknown'}` : 'loading'}</b></span>
    <span class="item">Audit <b>${number(audit)} ${audit === 1 ? 'entry' : 'entries'}</b></span>
    ${busyNames.length ? html`<span class="item"><span class="dot dot-ok pulse"></span><b>${busyNames.join(', ')}</b> working</span>` : null}
    <span class="spacer"></span>
    <button class="btnlike" type="button" onClick=${() => dispatch({ type: 'palette', open: true })} title="Find a shipment, stone or report number">
      <span class="kbd-hint">${isMac ? '⌘' : 'Ctrl'} K</span> search
    </button>
    <span class="item opt">Space runs the open view. A runs autopilot.</span>
  </footer>`;
}
