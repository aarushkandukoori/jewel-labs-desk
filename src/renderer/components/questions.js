// One-line questions from the Review agent. Answer inline, or pick an option. A missing paper is answered
// by uploading it, or by saying it is not needed (asked once more first: the pack is then built without it).
// Questions about papers that disagree, or a possible sanctions match, have no way to close them unanswered.
import { html, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Button, Chip } from './ui.js';
import { Icon } from './icons.js';
import { FIELD_LABELS } from '../lib/labels.js';

export const NOT_NEEDED_CONFIRM = 'Mark this paper as not needed? The pack will be built without it.';

/**
 * The small label under a question: the field it fills, else what kind of question it is. Keys only the rules read
 * (stone.<report>.carat, sanctions.<party>.<entry>) are never shown as they are.
 */
export function questionLabel(q) {
  if (FIELD_LABELS[q.key]) return FIELD_LABELS[q.key];
  if (q.check === 'sanctions') return 'OFAC SDN screen';
  if (q.key === 'house.eori') return 'EORI number';
  if (q.key === 'doc.checkedBy') return 'Packing list draft';
  if (q.kind === 'missing_document') return 'Missing paper';
  if (q.kind === 'mismatch') return 'Papers disagree';
  return 'Please confirm';
}

export function QuestionRow({ question, onUpload }) {
  const { jl, call, toast, nav } = useApp();
  const [answer, setAnswer] = useState('');
  const q = question;
  const done = q.status !== 'open';

  async function send(value) {
    const text = String(value ?? answer).trim();
    if (!text) return;
    const result = await call(jl.questions.answer(q.id, text));
    if (result !== null) {
      setAnswer('');
      toast('Answer saved', 'The agents check the shipment again with it.', 'ok');
    }
  }

  // "Not needed" goes in as an answer, so the agents record it on the shipment and the pack says so.
  function notNeeded() {
    if (window.confirm(NOT_NEEDED_CONFIRM)) send('Not needed');
  }

  return html`<div class=${`q-row${done ? ' answered' : ''}`}>
    <div class="q">
      <div>${q.text}</div>
      <div class="k">
        ${questionLabel(q)}
        ${q.docId ? html` · <button class="link-btn" type="button" onClick=${() => nav.document(q.docId, q.key)}>see it on the page</button>` : null}
        ${done ? html` · ${q.status === 'answered' ? `Answered${q.answeredBy ? ` by ${q.answeredBy}` : ''}: ${q.answer}` : 'Dismissed'}` : null}
      </div>
    </div>
    ${done ? html`<${Chip} tone=${q.status === 'answered' ? 'ok' : 'muted'} small>${q.status}<//>`
      : q.kind === 'missing_document'
        ? html`<div class="q-options"><${Button} size="sm" onClick=${onUpload} icon=${Icon.upload}>Upload it<//>
            <button class="btn btn-sm btn-ghost" type="button" onClick=${notNeeded}>Not needed</button></div>`
        : Array.isArray(q.options) && q.options.length
          ? html`<div class="q-options">${q.options.slice(0, 4).map((o) => html`<${Button} size="sm" onClick=${() => send(o)}>${o}<//>`)}</div>`
          : html`<form class="row-flex" onSubmit=${(e) => { e.preventDefault(); send(); }}>
              <input class="input input-sm ans" value=${answer} onInput=${(e) => setAnswer(e.currentTarget.value)} placeholder="Your answer" aria-label=${`Answer: ${q.text}`} />
              <${Button} size="sm" onClick=${() => send()} disabled=${!answer.trim()}>Answer<//>
            </form>`}
  </div>`;
}
