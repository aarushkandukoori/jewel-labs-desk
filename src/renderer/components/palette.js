// Cmd/Ctrl+K: find a shipment, a stone, a report number, a paper or a document, or run a command.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { searchAll } from '../lib/search.js';
import { Icon } from './icons.js';

const KIND_ICONS = { shipment: 'box', stone: 'gem', paper: 'doc', document: 'file', command: 'arrowRight' };

export function Palette() {
  const { state, dispatch, nav, commands } = useApp();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  const groups = useMemo(() => {
    const found = searchAll(state.data, query);
    const q = query.trim().toLowerCase();
    const cmds = commands.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0, q ? 5 : 8)
      .map((c) => ({ kind: 'command', id: c.id, ref: '', title: c.title, meta: c.hint || '', run: c.run }));
    return cmds.length ? [...found, { group: 'Go to', items: cmds }] : found;
  }, [query, state.data]);

  const flat = groups.flatMap((g) => g.items);
  const close = () => dispatch({ type: 'palette', open: false });

  function open(item) {
    close();
    if (!item) return;
    if (item.kind === 'command') item.run();
    else if (item.kind === 'shipment') nav.shipment(item.id);
    else if (item.kind === 'stone') nav.stone(item.id);
    else if (item.kind === 'paper') nav.paper(item.id);
    else if (item.kind === 'document') nav.document(item.id);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); open(flat[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  let index = -1;
  return html`<div class="palette-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Search">
      <div class="palette-input">
        ${Icon.search()}
        <input ref=${input} value=${query} placeholder="Find a shipment, stone, report number or paper"
          onInput=${(e) => { setQuery(e.currentTarget.value); setActive(0); }} onKeyDown=${onKey} aria-label="Search" />
      </div>
      <div class="palette-list" role="listbox">
        ${!flat.length ? html`<div class="empty">Nothing matches “${query}”.</div>` : null}
        ${groups.map((g) => html`<div key=${g.group}>
          <div class="palette-group">${g.group}</div>
          ${g.items.map((item) => {
            index += 1;
            const i = index;
            const icon = Icon[KIND_ICONS[item.kind]] || Icon.arrowRight;
            return html`<button type="button" role="option" aria-selected=${i === active ? 'true' : 'false'}
              class=${`palette-item${i === active ? ' active' : ''}`} onMouseEnter=${() => setActive(i)} onClick=${() => open(item)}>
              ${icon()}${item.ref ? html`<span class="ref">${item.ref}</span>` : null}<span class="ellipsis">${item.title}</span>
              ${item.meta ? html`<span class="meta">${String(item.meta).replace(/_/g, ' ')}</span>` : null}
            </button>`;
          })}
        </div>`)}
      </div>
      <div class="palette-foot"><span>↑ ↓ to move</span><span>Enter to open</span><span>Esc to close</span></div>
    </div>
  </div>`;
}
