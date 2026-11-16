// Toasts: short notices in the bottom-right corner. Errors stay a little longer.
import { html, useEffect } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Icon } from './icons.js';

function Toast({ toast, onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, toast.tone === 'error' ? 9000 : 5500);
    return () => clearTimeout(timer);
  }, []);
  const dot = toast.tone === 'error' ? 'dot-fail' : toast.tone === 'warn' ? 'dot-warn' : toast.tone === 'ok' ? 'dot-ok' : 'dot-info';
  return html`<div class=${`toast${toast.tone === 'error' ? ' error' : ''}`} role=${toast.tone === 'error' ? 'alert' : 'status'}>
    <span class=${`dot ${dot}`}></span>
    <div class="body">
      ${toast.title ? html`<div class="title">${toast.title}</div>` : null}
      ${toast.text ? html`<div class="text">${toast.text}</div>` : null}
      ${toast.action ? html`<div class="mt-8"><button class="btn btn-sm" onClick=${() => { toast.action.run(); onClose(); }}>${toast.action.label}</button></div>` : null}
    </div>
    <button class="close" type="button" onClick=${onClose} aria-label="Dismiss">${Icon.x()}</button>
  </div>`;
}

export function Toasts() {
  const { state, dispatch } = useApp();
  return html`<div class="toasts" aria-live="polite">
    ${state.toasts.map((t) => html`<${Toast} key=${t.id} toast=${t} onClose=${() => dispatch({ type: 'dismiss-toast', id: t.id })} />`)}
  </div>`;
}
