// Small building blocks used on every screen: chips, dots, sections, buttons, toggles, modals.
import { html, useEffect, useRef, useState, useErrorBoundary } from '../vendor/preact-htm.mjs';
import { Icon } from './icons.js';

/** A status chip. tone: ok | warn | fail | info | muted | plain. */
export function Chip({ tone = 'muted', children, title, small, mono }) {
  const cls = `chip chip-${tone}${small ? ' chip-sm' : ''}${mono ? ' chip-src' : ''}`;
  return html`<span class=${cls} title=${title || undefined}>${children}</span>`;
}

/** A chip from a { text, tone } pair (see lib/format.js). */
export function StatusChip({ status, small }) {
  if (!status) return null;
  return html`<${Chip} tone=${status.tone} small=${small}>${status.text}<//>`;
}

export function Dot({ tone, agent, pulse, title }) {
  const cls = `dot${tone ? ` dot-${tone}` : ''}${agent ? ` dot-${agent}` : ''}${pulse ? ' pulse' : ''}`;
  return html`<span class=${cls} title=${title || undefined} aria-hidden=${title ? undefined : 'true'}></span>`;
}

export function Spinner() {
  return html`<span class="spinner" aria-label="Working"></span>`;
}

/**
 * A button that shows a spinner while its onClick promise runs, so nobody clicks twice.
 * kind: '' | 'primary' | 'ghost'; size: '' | 'sm' | 'lg'.
 */
export function Button({ kind = '', size = '', onClick, disabled, children, title, icon, type = 'button', class: extra = '', kbd, ariaLabel }) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  async function handle(e) {
    if (!onClick || busy) return;
    const result = onClick(e);
    if (result && typeof result.then === 'function') {
      setBusy(true);
      try {
        await result;
      } finally {
        if (mounted.current) setBusy(false);
      }
    }
  }
  const cls = ['btn', kind && `btn-${kind}`, size && `btn-${size}`, !children && 'btn-icon', extra].filter(Boolean).join(' ');
  return html`<button type=${type} class=${cls} onClick=${handle} disabled=${disabled || busy} title=${title || undefined}
    aria-label=${ariaLabel || title || undefined} aria-busy=${busy ? 'true' : undefined}>
    ${busy ? html`<${Spinner} />` : icon ? icon() : null}${children}${kbd ? html`<span class="kbd">${kbd}</span>` : null}
  </button>`;
}

/** A bordered section like the customer portal's "1. CONNECT". */
export function Section({ title, right, children, id, class: extra = '', flush }) {
  return html`<section class=${`section${flush ? ' flush' : ''} ${extra}`} id=${id || undefined} aria-label=${typeof title === 'string' ? title : undefined}>
    ${title || right ? html`<div class="section-head"><div class="label">${title}</div><div class="right-side">${right}</div></div>` : null}
    ${children}
  </section>`;
}

export function Empty({ title, children, action, icon }) {
  return html`<div class="empty">
    ${icon ? html`<div class="empty-art">${icon()}</div>` : null}
    ${title ? html`<div class="t">${title}</div>` : null}
    <div>${children}</div>
    ${action || null}
  </div>`;
}

export function Skeleton({ lines = 3, block }) {
  const widths = ['w-90', 'w-70', 'w-50', 'w-70', 'w-30'];
  return html`<div class="skeleton" aria-label="Loading" role="status">
    ${block ? html`<div class="skel block"></div>` : null}
    ${Array.from({ length: lines }, (_, i) => html`<div class=${`skel ${widths[i % widths.length]}`}></div>`)}
  </div>`;
}

export function Toggle({ checked, onChange, label, disabled, title }) {
  return html`<label class="toggle" title=${title || undefined}>
    <input type="checkbox" checked=${Boolean(checked)} disabled=${disabled} onChange=${(e) => onChange?.(e.currentTarget.checked)}
      aria-label=${typeof label === 'string' ? label : title || 'Toggle'} />
    <span class="track"></span>
    ${label ? html`<span class="t-label">${label}</span>` : null}
  </label>`;
}

export function Segmented({ value, options, onChange, full, ariaLabel }) {
  return html`<div class=${`seg${full ? ' full' : ''}`} role="tablist" aria-label=${ariaLabel || undefined}>
    ${options.map((o) => html`<button type="button" role="tab" aria-selected=${value === o.value ? 'true' : 'false'}
      class=${value === o.value ? 'active' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

export function Check({ checked, onChange, children }) {
  return html`<label class="check"><input type="checkbox" checked=${Boolean(checked)} onChange=${(e) => onChange?.(e.currentTarget.checked)} />${children}</label>`;
}

/** A labelled form field: <Field label="Email"><input class="input" /></Field>. */
export function Field({ label, hint, children, class: extra = '' }) {
  return html`<label class=${`field ${extra}`}><span>${label}</span>${children}${hint ? html`<span class="hint">${hint}</span>` : null}</label>`;
}

/** A modal dialog. Escape and a click outside close it. */
export function Modal({ title, onClose, children, footer, size = '', tabs, label }) {
  const box = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const first = box.current?.querySelector('input, select, textarea, button:not(.modal-close)');
    first?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return html`<div class="modal-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class=${`modal ${size}`} role="dialog" aria-modal="true" aria-label=${label || (typeof title === 'string' ? title : 'Dialog')} ref=${box}>
      <div class="modal-head">
        <div class="label">${title}</div>
        <button class="modal-close" type="button" onClick=${onClose} aria-label="Close" title="Close (Esc)">${Icon.x()}</button>
      </div>
      ${tabs || null}
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-foot">${footer}</div>` : null}
    </div>
  </div>`;
}

/** Catches a crash in one screen and shows it, instead of a blank window. */
export function Boundary({ children, name = 'This screen' }) {
  const [error, reset] = useErrorBoundary((e) => console.error(e));
  if (error) {
    return html`<div class="error-panel" role="alert">
      <div class="t">${name} hit a problem and stopped.</div>
      <div class="soft">The agents keep working. Try again, or reload the window.</div>
      <pre>${String(error?.message || error)}</pre>
      <div class="form-actions"><button class="btn btn-sm" onClick=${reset}>Try again</button></div>
    </div>`;
  }
  return children;
}

/** Copies text and briefly says so. */
export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      setDone(false);
    }
  }
  return html`<button type="button" class="btn btn-sm" onClick=${copy} title="Copy to the clipboard">
    ${done ? Icon.check() : Icon.copy()}${done ? 'Copied' : label}
  </button>`;
}
