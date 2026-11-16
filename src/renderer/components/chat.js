// "Tell the agents": a short chat. The person types a request; the agents reply with the steps they
// ran (dots fill as each step finishes) and buttons for what they made.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.mjs';
import { jl, call } from '../api.js';
import { useApp } from '../lib/context.js';
import { Chip } from './ui.js';
import { Icon } from './icons.js';
import { dayTime } from '../lib/format.js';

export const SUGGESTIONS = [
  'Prepare the papers for my latest shipment',
  'What is still missing?',
  'Prepare the export paper and the EU statement',
];

// The steps shown while the agents work, filled in as their live events arrive.
const LIVE_STEPS = [
  { text: 'Sending your request', agents: [] },
  { text: 'Matching your documents', agents: ['records', 'intake'] },
  { text: 'Sanctions check', agents: ['sanctions'] },
  { text: 'Checking the documents', agents: ['origin', 'review'] },
  { text: 'Building the papers', agents: ['paperwork'] },
];

/** Who wrote a message: 'house', 'agents' or 'desk' (records use a string or a { type, role } object). */
export function senderOf(message) {
  const from = message?.from;
  if (typeof from === 'string') return from === 'person' ? 'house' : from;
  if (from?.role === 'desk') return 'desk';
  if (from?.type === 'agent') return 'agents';
  return 'house';
}

function senderName(message) {
  const who = senderOf(message);
  if (who === 'agents') return 'Agents';
  if (who === 'desk') return `Jewel Labs${message.author ? ` · ${message.author}` : ''}`;
  return message.author || message.from?.name || 'You';
}

/** Steps with dots. done = how many are finished (the rest wait); reveal fills them one by one. */
export function Steps({ steps, done = steps.length, active = -1 }) {
  return html`<div class="steps">
    ${steps.map((s, i) => {
      const text = typeof s === 'string' ? s : s.text;
      const detail = typeof s === 'string' ? null : s.detail;
      const state = i < done ? 'done' : i === active ? 'active' : 'pending';
      return html`<div class=${`step ${state}`} key=${i}>
        <span class=${`dot${state === 'active' ? ' dot-ok pulse' : ''}`}></span>
        <div><div class="st">${text}</div>${detail ? html`<div class="sd">${detail}</div>` : null}</div>
      </div>`;
    })}
  </div>`;
}

/** Fills a finished reply's steps one by one, so the person sees the work happen. */
function RevealSteps({ steps, animate }) {
  const [done, setDone] = useState(animate ? 0 : steps.length);
  useEffect(() => {
    if (!animate) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      setDone(n);
      if (n >= steps.length) clearInterval(timer);
    }, 260);
    return () => clearInterval(timer);
  }, []);
  return html`<${Steps} steps=${steps} done=${done} active=${done} />`;
}

/** The chat section with its suggestion chips under it. props: title, shipmentId (optional), placeholder. */
export function TellTheAgents({ title = '3. Tell the agents', shipmentId = null, placeholder, id }) {
  const { state, nav } = useApp();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // { text, at } while the agents work
  const log = useRef(null);
  const sentAt = useRef(0); // replies newer than this fill their steps one by one

  const messages = useMemo(() => {
    return state.data.messages
      .filter((m) => m.kind !== 'request' && (!shipmentId || !m.shipmentId || m.shipmentId === shipmentId))
      .slice()
      .sort((a, b) => String(a.at || a.createdAt || '').localeCompare(String(b.at || b.createdAt || '')))
      .slice(-30);
  }, [state.data.messages, shipmentId]);

  // Live progress while waiting: which steps have agents worked on since the request went out?
  const liveDone = useMemo(() => {
    if (!pending) return 0;
    const since = sentAt.current;
    const seen = new Set(state.agentEvents.filter((e) => new Date(e.at).getTime() >= since - 500).map((e) => e.agent));
    let done = 1;
    for (let i = 1; i < LIVE_STEPS.length; i++) if (LIVE_STEPS[i].agents.some((a) => seen.has(a))) done = i + 1;
    return done;
  }, [pending, state.agentEvents]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  async function send(value) {
    const request = String(value ?? text).trim();
    if (!request || pending) return;
    setText('');
    sentAt.current = Date.now();
    setPending({ text: request, at: new Date().toISOString() });
    await call(jl.agents.ask(request, shipmentId ? { shipmentId } : {}));
    setPending(null);
  }

  const isFresh = (m) => sentAt.current > 0 && new Date(m.at || m.createdAt || 0).getTime() >= sentAt.current - 1000;

  function actionButton(action, i) {
    if (action.kind === 'paper') {
      return html`<button class="btn btn-sm" key=${i} onClick=${() => nav.paper(action.paperId)}>${Icon.doc()}Open ${action.ref || 'the paper'}</button>`;
    }
    if (action.kind === 'question') {
      return html`<button class="btn btn-sm" key=${i} onClick=${() => nav.questions(action.questionId)}>${Icon.chat()}Answer: ${truncate(action.text, 48)}</button>`;
    }
    if (action.kind === 'document') {
      return html`<button class="btn btn-sm" key=${i} onClick=${() => nav.document(action.docId)}>${Icon.file()}Open the draft</button>`;
    }
    return null;
  }

  return html`<section class="section" id=${id || undefined} aria-label="Tell the agents">
    <div class="section-head"><div class="label">${title}</div></div>
    <div class="chat-log" ref=${log}>
      ${!messages.length && !pending ? html`<div class="chat-empty">No messages yet.</div>` : null}
      ${messages.map((m) => {
        const who = senderOf(m);
        return html`<div class=${`msg ${who === 'house' ? 'mine' : 'agents'}`} key=${m.id}>
          <div class="msg-meta"><span>${senderName(m)}</span><span>·</span><span>${dayTime(m.at || m.createdAt)}</span>
            ${m.status === 'open' ? html`<${Chip} small tone="warn">Open<//>` : null}</div>
          ${who === 'agents' && Array.isArray(m.steps) && m.steps.length ? html`<${RevealSteps} steps=${m.steps} animate=${isFresh(m)} />` : null}
          <div class=${`msg-text${who === 'agents' && m.steps?.length ? ' mt-8' : ''}`}>${m.text}</div>
          ${Array.isArray(m.actions) && m.actions.length ? html`<div class="msg-actions">${m.actions.slice(0, 4).map(actionButton)}</div>` : null}
        </div>`;
      })}
      ${pending ? html`<div class="msg mine"><div class="msg-meta">You · just now</div><div class="msg-text">${pending.text}</div></div>
        <div class="msg agents"><div class="msg-meta">Agents · working</div>
          <${Steps} steps=${LIVE_STEPS.map((s) => s.text)} done=${liveDone} active=${liveDone} />
        </div>` : null}
    </div>
    <form class="chat-input" onSubmit=${(e) => { e.preventDefault(); send(); }}>
      <input class="input" value=${text} onInput=${(e) => setText(e.currentTarget.value)} disabled=${Boolean(pending)}
        placeholder=${placeholder || 'For example: I need the export papers for my Antwerp parcel by Friday'} aria-label="Tell the agents" />
      <button class="btn btn-primary" type="submit" disabled=${!text.trim() || Boolean(pending)}>${pending ? 'Working…' : 'Send'}</button>
    </form>
  </section>
  <${Suggestions} onPick=${(s) => send(s)} />`;
}

export function Suggestions({ onPick }) {
  return html`<div class="suggestions">
    ${SUGGESTIONS.map((s) => html`<button class="suggestion" type="button" onClick=${() => onPick(s)}>${s}</button>`)}
  </div>`;
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
