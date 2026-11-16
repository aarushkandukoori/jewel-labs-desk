// A stone's history as a vertical timeline: mined, rough, factory, graded, invoiced, packed, cleared,
// flown, statement, signed, sent. Steps the papers prove are lit; the rest wait, dashed.
import { html } from '../vendor/preact-htm.mjs';
import { Icon } from './icons.js';
import { HISTORY_STEPS } from '../lib/labels.js';
import { day } from '../lib/format.js';

const STEP_LOOK = {
  mined: { icon: 'pick', color: '#c4b5fd' },
  rough: { icon: 'gem', color: '#93b4ff' },
  factory: { icon: 'factory', color: '#7dd3fc' },
  graded: { icon: 'scale', color: '#86efac' },
  invoiced: { icon: 'receipt', color: '#fde68a' },
  packed: { icon: 'box', color: '#fdba74' },
  cleared: { icon: 'stamp', color: '#f9a8d4' },
  flown: { icon: 'plane', color: '#93b4ff' },
  statement: { icon: 'doc', color: '#c4c6ca' },
  signed: { icon: 'pen', color: '#86efac' },
  sent: { icon: 'send', color: '#86efac' },
};

/** Puts history events (from jl.stones.history) onto the fixed spine of steps. Pure, so it is tested. */
export function placeEvents(events = []) {
  return HISTORY_STEPS.map((step) => ({
    ...step,
    events: events.filter((e) => step.kinds.includes(e.kind)),
  })).concat(
    // Anything the spine does not know about still shows, at the end.
    events.filter((e) => !HISTORY_STEPS.some((s) => s.kinds.includes(e.kind)))
      .map((e) => ({ id: e.kind, title: e.title || e.kind, kinds: [e.kind], empty: '', events: [e] })),
  );
}

export function Timeline({ events, docs = [], onSource, lab }) {
  const steps = placeEvents(events);
  return html`<ol class="timeline" aria-label="The stone's history">
    ${steps.map((step) => {
      const done = step.events.length > 0;
      const look = STEP_LOOK[step.id] || { icon: 'info', color: '#c4c6ca' };
      const icon = Icon[look.icon] || Icon.info;
      const first = step.events[0];
      return html`<li class=${`tl-item${done ? ' done' : ''}`} key=${step.id} style=${{ '--c': look.color }}>
        <div class="tl-when" title=${done && !first?.at ? 'The date is not on file' : undefined}>${done && first?.at ? day(first.at) : done ? '–' : ''}</div>
        <div class="tl-rail"><span class="tl-node">${icon()}</span></div>
        <div class="tl-body">
          <div class="tl-title">${done && first?.title && first.title !== step.title ? first.title : step.title}
            ${step.id === 'mined' && first?.kind === 'grown' ? html`<span class="chip chip-info chip-sm">Lab-grown</span>` : null}</div>
          ${done
            ? step.events.map((e, i) => html`<div key=${i}>
                <div class="tl-detail">${e.detail}</div>
                ${e.docId ? html`<div class="tl-src"><button type="button" onClick=${() => onSource?.(e)} title="Open the paper at this spot">
                  ${Icon.link()}${docs.find((d) => d.id === e.docId)?.fileName || 'Source paper'}</button></div>` : null}
              </div>`)
            : html`<div class="tl-detail">${step.empty}</div>`}
        </div>
      </li>`;
    })}
  </ol>`;
}
