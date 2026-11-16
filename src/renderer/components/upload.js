// Adding files: the drop zone, "click to choose", and "Upload it" buttons all end up here.
// In the desktop app a click opens the system file dialog (jl.docs.pick); dropped files and the
// browser demo go through jl.docs.add with the File objects.
import { html, useRef, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { plural } from '../lib/format.js';

/** Hook: { choose(accept?), add(files), busy, input }: render `input` once in the component. */
export function useUpload() {
  const { jl, call, toast, state } = useApp();
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const accept = useRef('');

  async function done(result) {
    if (!result || result.canceled) return result;
    const n = result.documentIds?.length || 0;
    if (n) toast(`${plural(n, 'document')} sent`, state.autopilot ? 'The agents are reading them now.' : 'Autopilot is off. Press Space to run the agents.', 'ok');
    else toast('Already on file', 'Those files were added before, so nothing new was read.', 'info');
    return result;
  }

  async function add(files) {
    const list = Array.from(files || []);
    if (!list.length) return null;
    setBusy(true);
    try {
      return await done(await call(jl.docs.add(list)));
    } finally {
      setBusy(false);
    }
  }

  async function choose(kind = '') {
    // The desktop app's own dialog remembers folders and allows many files; the browser uses an input.
    if (!state.demo && !kind && jl.docs.pick) {
      setBusy(true);
      try {
        return await done(await call(jl.docs.pick()));
      } finally {
        setBusy(false);
      }
    }
    accept.current = kind === 'chat' ? '.zip,.txt' : '';
    if (input.current) {
      input.current.accept = accept.current;
      input.current.value = '';
      input.current.click();
    }
    return null;
  }

  const element = html`<input type="file" multiple ref=${input} hidden aria-hidden="true" tabindex="-1"
    onChange=${(e) => add(e.currentTarget.files)} />`;

  return { add, choose, busy, input: element };
}

/** The dashed drop zone: "Drop your documents here, or click to choose". */
export function DropZone({ upload, title = 'Drop your documents here, or click to choose', hint }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return html`<div class=${`dropzone${over ? ' over' : ''}`} role="button" tabindex="0"
    aria-label="Add documents: drop files here or press Enter to choose"
    onClick=${() => upload.choose()}
    onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); upload.choose(); } }}
    onDragEnter=${(e) => { e.preventDefault(); depth.current += 1; setOver(true); }}
    onDragOver=${(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
    onDragLeave=${() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
    onDrop=${(e) => { e.preventDefault(); depth.current = 0; setOver(false); upload.add(e.dataTransfer.files); }}>
    ${upload.busy ? html`<div class="busy"><span class="spinner"></span> Sending to the agents…</div>` : html`
      <div class="t">${title}</div>
      <div class="d">${hint || 'Invoices, packing lists, shipping bills, air waybills, certificates, email threads (.eml), WhatsApp exports, or the whole folder as a .zip'}</div>`}
  </div>`;
}
