// The document viewer: the page with every field box, and the record table beside it. Click a field
// in the table and the page scrolls to its box and pulses it: every field links to its spot on the page.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { PageView } from './page-view.js';
import { Chip, Dot } from './ui.js';
import { Icon } from './icons.js';
import { agentOf, FIELD_LABELS } from '../lib/labels.js';
import { docTypeLabel, confidence, sourceLabel, docStatus, carat } from '../lib/format.js';
import { boxesOf, bestPage, displayAgent, isConversation, layoutChips, labelKeyFields } from '../lib/reading.js';

export function DocumentViewer({ doc, focusKey, onFocus }) {
  const fieldOfKey = (key) => (doc.fields || []).find((f) => f.key === key);
  const startPage = () => fieldOfKey(focusKey)?.page || bestPage(doc);
  const [page, setPage] = useState(startPage);
  const [pages, setPages] = useState(doc.pages || 1);
  const [pulse, setPulse] = useState(0);
  const pageBox = useRef(null);

  useEffect(() => { setPage(startPage()); }, [doc.id]);

  // Focusing a field: go to its page, scroll its box into view and pulse it.
  useEffect(() => {
    if (!focusKey) return;
    const f = fieldOfKey(focusKey);
    if (f?.page && f.page !== page) setPage(f.page);
    setPulse((n) => n + 1);
    const timer = setTimeout(() => {
      const el = pageBox.current?.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 260);
    return () => clearTimeout(timer);
  }, [focusKey, doc.id]);

  const all = boxesOf(doc, page).map((b) => ({
    ...b,
    pulse: focusKey === b.key && pulse > 0,
    dim: Boolean(focusKey) && focusKey !== b.key,
    id: `${b.id}:${focusKey === b.key ? pulse : 0}`, // a new id restarts the pulse animation
  }));
  // The focused field carries its label; with none focused, the key fields do.
  const focused = all.filter((b) => b.key === focusKey);
  const boxes = focusKey && focused.length ? layoutChips([...all.filter((b) => b.key !== focusKey), ...focused], { max: focused.length }) : labelKeyFields(all, 5);
  const fields = (doc.fields || []).filter((f) => f.value !== null && f.value !== undefined && f.value !== '');
  const status = docStatus(doc.status);

  return html`<div class="viewer">
    <div class="viewer-page" ref=${pageBox}>
      ${isConversation(doc)
        ? html`<div class="reader-empty" style=${{ width: '100%' }}><div class="t">${doc.fileName}</div><div>${doc.summary || 'A conversation, read as text.'}</div></div>`
        : html`<${PageView} docId=${doc.id} page=${page} boxes=${boxes} onPages=${setPages} onBox=${(b) => onFocus?.(b.key)}
            fallback=${doc.content?.sheet?.text ? html`<pre class="panel mono small" style=${{ padding: '14px', whiteSpace: 'pre-wrap', width: '100%', maxHeight: '520px', overflow: 'auto', margin: 0 }}>${doc.content.sheet.text.slice(0, 4000)}</pre>` : null} />`}
      ${pages > 1 ? html`<div class="viewer-pager">
        <button class="btn btn-sm btn-icon" type="button" disabled=${page <= 1} onClick=${() => setPage(page - 1)} aria-label="Previous page">${Icon.arrowLeft()}</button>
        <span>Page ${page} of ${pages}</span>
        <button class="btn btn-sm btn-icon" type="button" disabled=${page >= pages} onClick=${() => setPage(page + 1)} aria-label="Next page">${Icon.arrowRight()}</button>
      </div>` : null}
    </div>
    <div class="viewer-fields">
      <div class="vf-head">
        <div class="t" title=${doc.fileName}>${doc.fileName}</div>
        <div class="s">${docTypeLabel(doc.docType)}${doc.classifyConfidence ? ` · ${confidence(doc.classifyConfidence)} sure` : ''}</div>
        <div class="row-flex mt-8 wrap">
          <${Chip} mono small>${sourceLabel(doc.source)}<//>
          <${Chip} tone=${status.tone} small>${status.text}<//>
          ${doc.ocrUsed ? html`<${Chip} small tone="info">OCR<//>` : null}
          ${doc.readBy ? html`<span class="muted tiny">by ${doc.readBy}</span>` : null}
        </div>
        ${doc.summary ? html`<div class="soft small mt-8">${doc.summary}</div>` : null}
        ${doc.needsAiRead ? html`<div class="note-warn small mt-8" role="status">Read by the offline reader while the AI could not be reached; it is read again when the AI is back. Check its values meanwhile.</div>` : null}
      </div>
      ${!fields.length ? html`<div class="empty">${doc.status === 'read' ? 'No fields on this paper.' : 'The agents have not read this paper yet.'}</div>` : null}
      ${fields.map((f) => {
        const agent = displayAgent(f.key, f.agent || 'intake', f.confidence);
        const hasBox = Array.isArray(f.box);
        return html`<button type="button" key=${f.key + (f.page || '')} class=${`field-row${focusKey === f.key ? ' active' : ''}${hasBox ? '' : ' nobox'}`}
          style=${{ '--c': agentOf(agent).color }} onClick=${() => onFocus?.(f.key)} title=${hasBox ? 'Show it on the page' : 'Read from the text; no spot on the page'}>
          <span class="k"><${Dot} agent=${agent} />${FIELD_LABELS[f.key] || f.key}${f.page ? html`<span class="muted"> · p${f.page}</span>` : null}
            <span class="c">${f.confidence !== undefined ? confidence(f.confidence) : ''}</span></span>
          <span class="v">${f.value}</span>
        </button>`;
      })}
      ${(doc.lines || []).length ? html`<div class="vf-head" style=${{ borderTop: '1px solid var(--line)' }}><div class="label">Lines</div></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>#</th><th>Report</th><th class="num">Carat</th><th>Col.</th><th>Cla.</th></tr></thead>
          <tbody>${doc.lines.slice(0, 40).map((l, i) => html`<tr key=${i}><td class="muted">${l.lineNo ?? i + 1}</td><td class="mono small">${l.reportNumber || '–'}</td>
            <td class="num">${l.carat != null ? Number(l.carat).toFixed(2) : ''}</td><td>${l.color || ''}</td><td>${l.clarity || ''}</td></tr>`)}</tbody>
        </table></div>` : null}
    </div>
  </div>`;
}

/** One row in a document list. */
export function DocItem({ doc, active, onClick }) {
  const status = docStatus(doc.status);
  return html`<button type="button" class=${`doc-item${active ? ' active' : ''}`} onClick=${onClick} aria-current=${active ? 'true' : undefined}>
    <span class="fname" title=${doc.fileName}>${doc.fileName}</span>
    <span class="conf">${doc.classifyConfidence ? confidence(doc.classifyConfidence) : ''}</span>
    <span class="dtype">${docTypeLabel(doc.docType)}</span>
    <span class="meta"><${Chip} mono small>${sourceLabel(doc.source)}<//><${Chip} tone=${status.tone} small>${status.text}<//></span>
  </button>`;
}
