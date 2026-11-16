// One-line questions from the Review agent. Answer inline (or pick an option), or dismiss.
// A missing paper is answered by uploading it.
import { html, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Button, Chip } from './ui.js';
import { Icon } from './icons.js';
import { FIELD_LABELS } from '../lib/labels.js';

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

  async function dismiss() {
    await call(jl.questions.dismiss(q.id));
  }

  return html`<div class=${`q-row${done ? ' answered' : ''}`}>
    <div class="q">
      <div>${q.text}</div>
      <div class="k">
        ${q.key ? `${FIELD_LABELS[q.key] || q.key}` : q.kind === 'missing_document' ? 'Missing paper' : q.kind === 'mismatch' ? 'Papers disagree' : 'Please confirm'}
        ${q.docId ? html` · <button class="link-btn" type="button" onClick=${() => nav.document(q.docId, q.key)}>see it on the page</button>` : null}
        ${done ? html` · ${q.status === 'answered' ? `Answered${q.answeredBy ? ` by ${q.answeredBy}` : ''}: ${q.answer}` : 'Dismissed'}` : null}
      </div>
    </div>
    ${done ? html`<${Chip} tone=${q.status === 'answered' ? 'ok' : 'muted'} small>${q.status}<//>`
      : q.kind === 'missing_document'
        ? html`<${Button} size="sm" onClick=${onUpload} icon=${Icon.upload}>Upload it<//>`
        : Array.isArray(q.options) && q.options.length
          ? html`<div class="q-options">${q.options.slice(0, 4).map((o) => html`<${Button} size="sm" onClick=${() => send(o)}>${o}<//>`)}</div>`
          : html`<form class="row-flex" onSubmit=${(e) => { e.preventDefault(); send(); }}>
              <input class="input input-sm ans" value=${answer} onInput=${(e) => setAnswer(e.currentTarget.value)} placeholder="Your answer" aria-label=${`Answer: ${q.text}`} />
              <${Button} size="sm" onClick=${() => send()} disabled=${!answer.trim()}>Answer<//>
            </form>`}
    ${done ? null : html`<button class="btn btn-sm btn-ghost btn-icon" type="button" onClick=${dismiss} title="Dismiss this question" aria-label="Dismiss">${Icon.x()}</button>`}
  </div>`;
}
