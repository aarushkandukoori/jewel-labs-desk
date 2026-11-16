// "Agents reading": the page the agents are reading right now, with a coloured box and label on each
// field they read, and each agent's cursor gliding from field to field as 'agent' events arrive.
// Events are queued and played at a calm pace, so a burst from the agents still looks smooth.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { jl } from '../api.js';
import { PageView, isValidBox } from './page-view.js';
import { CursorArrow } from './icons.js';
import { Chip, Dot } from './ui.js';
import { agentOf, FIELD_LABELS } from '../lib/labels.js';
import { docTypeLabel, clock } from '../lib/format.js';
import {
  CURSOR_AGENTS, displayAgent, cursorPoint, parkedCursors, parkPoint, pace, readLine, boxesOf, bestPage,
  isConversation, latestReadDocument, boxMentioned, layoutChips, labelKeyFields,
} from '../lib/reading.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IDLE_PARK_MS = 7000;
const MAX_BOXES = 18;

function stillView(doc) {
  if (!doc) return { docId: null, page: 1, boxes: [] };
  const page = bestPage(doc);
  return { docId: doc.id, page, boxes: boxesOf(doc, page).slice(0, MAX_BOXES) };
}

/** props: documents (all document records), onOpen(docId, key) to open a field in the document viewer. */
export function AgentsReading({ documents, onOpen }) {
  const docsRef = useRef(documents);
  docsRef.current = documents;

  const [view, setView] = useState(() => stillView(latestReadDocument(documents)));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [cursors, setCursors] = useState(parkedCursors);
  const [recent, setRecent] = useState([]); // newest last, at most 3 lines
  const [live, setLive] = useState(false);
  const [pages, setPages] = useState(1);

  const queue = useRef([]);
  const running = useRef(false);
  const alive = useRef(true);
  const idleTimer = useRef(null);

  // Nothing on the page yet and a document gets read: show it.
  useEffect(() => {
    if (!viewRef.current.docId && !running.current) {
      const latest = latestReadDocument(documents);
      if (latest) setView(stillView(latest));
    }
  }, [documents]);

  useEffect(() => {
    alive.current = true;
    const off = jl.on('agent', (event) => {
      if (!event) return;
      queue.current.push(event);
      if (queue.current.length > 400) queue.current.splice(0, queue.current.length - 400); // far behind: skip ahead
      pump();
    });
    return () => {
      alive.current = false;
      clearTimeout(idleTimer.current);
      if (typeof off === 'function') off();
    };
  }, []);

  function update(patch) {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setView(next);
  }

  function moveCursor(agent, point) {
    if (!CURSOR_AGENTS.includes(agent)) return;
    setCursors((old) => ({ ...old, [agent]: { ...point, parked: false } }));
  }

  function remember(agent, text) {
    setRecent((old) => [...old, { id: `${Date.now()}-${Math.random()}`, agent, text }].slice(-3));
  }

  async function pump() {
    if (running.current) return;
    running.current = true;
    setLive(true);
    clearTimeout(idleTimer.current);
    while (queue.current.length && alive.current) {
      const event = queue.current.shift();
      try {
        await play(event, queue.current.length);
      } catch (e) {
        console.warn('Could not show an agent event:', e);
      }
    }
    running.current = false;
    if (!alive.current) return;
    idleTimer.current = setTimeout(() => {
      if (!alive.current) return;
      setLive(false);
      setCursors(parkedCursors()); // the agents step back from the page when they are done
    }, IDLE_PARK_MS);
  }

  async function play(event, backlog) {
    const { docId, action } = event;
    const doc = docId ? docsRef.current.find((d) => d.id === docId) : null;

    // A new document: switch the page, clear the boxes, and send the cursors back to their corner.
    if (docId && ['start', 'read', 'field'].includes(action) && viewRef.current.docId !== docId) {
      update({ docId, page: event.page || 1, boxes: [] });
      setPages(1);
      setCursors(parkedCursors());
      await sleep(backlog > 12 ? 120 : 520);
    }

    if (action === 'field' && isValidBox(event.box) && docId === viewRef.current.docId) {
      const page = event.page || 1;
      if (viewRef.current.page !== page) {
        update({ page, boxes: viewRef.current.boxes });
        await sleep(300);
      }
      const field = (doc?.fields || []).find((f) => f.key === event.key);
      const agent = displayAgent(event.key, event.agent, field?.confidence);
      const wait = pace(backlog);
      moveCursor(agent, cursorPoint(event.box));
      await sleep(Math.min(420, wait * 0.6));
      const label = event.label || FIELD_LABELS[event.key] || event.key;
      const box = {
        id: `${docId}:${event.key}:${page}:${event.box.join(',')}`,
        key: event.key, page, box: event.box, value: event.value,
        label: `${label}: ${event.value}`, agent, color: agentOf(agent).color, shown: true,
      };
      const others = viewRef.current.boxes.filter((b) => b.id !== box.id);
      update({ boxes: [...others, box].slice(-MAX_BOXES) });
      remember(agent, readLine(agent, label, event.value));
      await sleep(Math.max(60, wait - 420));
      return;
    }

    // Other agents at work: if they name something on the page, their cursor goes there.
    if (event.message && CURSOR_AGENTS.includes(event.agent) && !docId) {
      const target = boxMentioned(viewRef.current.boxes, event.message);
      if (target) {
        moveCursor(event.agent, cursorPoint(target.box));
        if (event.action === 'screen' || event.action === 'check') remember(event.agent, `${agentOf(event.agent).name} agent: ${event.message}`);
        await sleep(backlog > 8 ? 120 : 640);
        return;
      }
    }
    await sleep(backlog > 8 ? 20 : 90);
  }

  const doc = view.docId ? documents.find((d) => d.id === view.docId) : null;
  // Live: the newest four boxes carry their label. Still: the key fields do. The rest keep their outline.
  const onPage = view.boxes.filter((b) => (b.page || 1) === view.page);
  const pageBoxes = live ? layoutChips(onPage, { max: 4 }) : labelKeyFields(onPage, 5);

  return html`<div class="reader" aria-live="polite">
    <div class="reader-head">
      <span class="label">Agents reading</span>
      ${doc ? html`<span class="file ellipsis">${doc.fileName}</span><span class="type">${docTypeLabel(doc.docType)}</span>` : null}
      <span class="spacer"></span>
      ${pages > 1 ? html`<span class="muted small">Page ${view.page} of ${pages}</span>` : null}
      ${live ? html`<${Chip} tone="ok" small><${Dot} tone="ok" pulse /> Live<//>` : null}
    </div>
    ${!doc
      ? html`<div class="reader-empty"><div class="t">Nothing to read yet.</div><div>Drop documents above and watch the agents read them here, field by field.</div></div>`
      : isConversation(doc)
        ? html`<${Conversation} doc=${doc} />`
        : html`<div class="reader-stage">
            <${PageView} docId=${doc.id} page=${view.page} boxes=${pageBoxes} onPages=${setPages}
              onBox=${onOpen ? (b) => onOpen(doc.id, b.key) : undefined}>
              ${CURSOR_AGENTS.map((id) => {
                const c = cursors[id] || parkPoint(id);
                const agent = agentOf(id);
                return html`<div class="cursor" key=${id} style=${{ left: `${c.x}%`, top: `${c.y}%`, '--c': agent.color }} aria-hidden="true">
                  <${CursorArrow} color=${agent.color} /><span class="tag">${agent.name}</span>
                </div>`;
              })}
            <//>
          </div>`}
    <div class="reader-events">
      ${recent.map((r) => html`<div class="reader-event" key=${r.id}><${Dot} agent=${r.agent} /><span>${r.text}</span></div>`)}
    </div>
  </div>`;
}

/** A WhatsApp chat or an email, shown as the agents read it: who wrote what, and when. */
function Conversation({ doc }) {
  const chat = doc.content?.chat;
  const email = doc.content?.email;
  const relevant = new Set((doc.insights?.relevant || []).map((r) => String(r.text || '').trim()));
  if (chat?.messages?.length) {
    return html`<div class="section-body" style=${{ paddingTop: 0 }}>
      <div class="row-flex mb-8"><span class="label">WhatsApp chat</span><span class="strong">${chat.title || doc.fileName}</span></div>
      <div class="rows">
        ${chat.messages.slice(-14).map((m, i) => html`<div class="feed-row" key=${i} style=${{ gridTemplateColumns: '120px minmax(0,1fr) auto' }}>
          <span class="who ellipsis">${m.author}</span>
          <span class="what">${m.attachment ? html`<span class="muted mono tiny">FILE </span>${m.attachment}` : m.text}
            ${relevant.has(String(m.text || '').trim()) ? html` <${Chip} tone="info" small>Relevant<//>` : null}</span>
          <span class="when">${clock(m.at)}</span>
        </div>`)}
      </div>
    </div>`;
  }
  if (email) {
    return html`<div class="section-body" style=${{ paddingTop: 0 }}>
      <div class="kv">
        <div class="k">From</div><div class="v">${email.from}</div>
        <div class="k">Subject</div><div class="v">${email.subject}</div>
      </div>
      <div class="msg-text mt-12 soft">${String(email.text || '').slice(0, 900)}</div>
    </div>`;
  }
  return html`<div class="reader-empty"><div class="t">${doc.fileName}</div><div>${doc.summary || 'Read as text.'}</div></div>`;
}
