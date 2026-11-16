// The status bar along the bottom (always visible): environment, model, OCR, rules, OFAC list, audit
// trail size, and the keyboard hints on the right.
import { html, useEffect } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { number } from '../lib/format.js';
import { busyAgents } from '../lib/store.js';
import { agentOf } from '../lib/labels.js';

// A failed AI call this recent means the agents are reading with the offline reader right now.
const AI_TROUBLE_MS = 15 * 60 * 1000;
// How often the bar asks again who is reading (the AI can stop answering at any time).
const REFRESH_MS = 30 * 1000;

/** True when the last AI call failed recently, so papers are being read without the AI. */
export function aiUnreachable(ai, now = Date.now()) {
  const at = Date.parse(ai?.lastError?.at || '');
  return Boolean(ai && ai.mode !== 'off' && Number.isFinite(at) && now - at < AI_TROUBLE_MS);
}

/** Who reads the papers: the model and where it runs, or the offline reader (also while the AI is unreachable). */
export function modelText(info, now = Date.now()) {
  const ai = info?.ai;
  if (!ai || ai.mode === 'off') return 'Offline reader';
  if (aiUnreachable(ai, now)) return 'Offline reader (AI unreachable)';
  const where = ai.mode === 'proxy' ? 'Jewel Labs cloud' : ai.mode === 'direct' ? 'your OpenAI key' : ai.mode === 'demo' ? 'demo' : '';
  return `${ai.model || 'AI'}${where ? ` · ${where}` : ''}`;
}

export function StatusBar() {
  const { state, dispatch, refreshInfo } = useApp();
  const info = state.info || {};
  const sample = info.sample || state.workspace?.sample || state.workspace?.environment === 'sandbox';
  const env = state.demo ? 'Demo' : sample ? 'Sandbox' : 'Live';
  const busy = busyAgents(state);
  const busyNames = Object.keys(busy).map((id) => agentOf(id).name);
  const ofac = state.sanctions;
  const audit = state.data.activity.length;
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const offline = aiUnreachable(info.ai);

  useEffect(() => {
    if (state.demo || !refreshInfo) return undefined;
    const timer = setInterval(() => refreshInfo(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [state.demo]);

  return html`<footer class="statusbar" role="contentinfo">
    <span class="item env"><span class=${`dot ${env === 'Live' ? 'dot-ok live-dot' : env === 'Demo' ? 'dot-info' : 'dot-warn'}`}></span>${env}</span>
    <span class="item" title=${offline ? `The last AI call failed: ${info.ai.lastError.message || 'no answer'}. New papers are read with the offline reader; check their values.` : undefined}>
      Model <b class=${offline ? 'warn' : ''}>${modelText(info)}</b></span>
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
