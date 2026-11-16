// Small line icons (16px grid, 1.5px strokes). Each takes optional props, e.g. <${Icon.check} class="x" />.
import { html } from '../vendor/preact-htm.mjs';

function svg(paths, { viewBox = '0 0 16 16', fill = 'none' } = {}) {
  return (props = {}) => html`<svg viewBox=${viewBox} fill=${fill} stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class=${`icon ${props.class || ''}`}>${paths}</svg>`;
}

export const Icon = {
  logo: (props = {}) => html`<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linejoin="round" aria-hidden="true" class=${`icon ${props.class || ''}`}>
    <polygon points="16,3 29,16 16,29 3,16" />
    <polygon points="16,10 22,16 16,22 10,16" />
    <line x1="16" y1="3" x2="16" y2="10" /><line x1="16" y1="29" x2="16" y2="22" />
    <line x1="3" y1="16" x2="10" y2="16" /><line x1="29" y1="16" x2="22" y2="16" />
  </svg>`,
  check: svg(html`<path d="M3.5 8.5l3 3 6-7" />`),
  x: svg(html`<path d="M4 4l8 8M12 4l-8 8" />`),
  plus: svg(html`<path d="M8 3v10M3 8h10" />`),
  minus: svg(html`<path d="M3 8h10" />`),
  search: svg(html`<circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" />`),
  gear: svg(html`<circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" />`),
  file: svg(html`<path d="M4 1.8h5.2L12 4.6v9.6H4z" /><path d="M9 1.8v3h3" />`),
  doc: svg(html`<path d="M4 1.8h5.2L12 4.6v9.6H4z" /><path d="M6 8h4M6 10.5h4" />`),
  folder: svg(html`<path d="M1.8 4.2h4.4l1.4 1.6h6.6v7.4H1.8z" />`),
  mail: svg(html`<rect x="1.8" y="3.5" width="12.4" height="9" rx="1" /><path d="M2.2 4.2L8 8.6l5.8-4.4" />`),
  chat: svg(html`<path d="M2.2 3h11.6v7.6H6.4L3.2 13.2v-2.6h-1z" />`),
  upload: svg(html`<path d="M8 10.5V2.5M5 5.2L8 2.3l3 2.9M2.5 10.5v3h11v-3" />`),
  download: svg(html`<path d="M8 2.5v8M5 7.6L8 10.5l3-2.9M2.5 10.5v3h11v-3" />`),
  print: svg(html`<path d="M4.5 5.5V2h7v3.5" /><rect x="2" y="5.5" width="12" height="5.5" rx="1" /><path d="M4.5 9.5H11.5V14H4.5z" />`),
  open: svg(html`<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4" />`),
  pen: svg(html`<path d="M10.8 2.4l2.8 2.8-8 8H2.8v-2.8z" /><path d="M9.4 3.8l2.8 2.8" />`),
  send: svg(html`<path d="M14 2L7 9M14 2l-4.5 12-2.5-5-5-2.5z" />`),
  play: svg(html`<path d="M5 3.2v9.6L12.6 8z" />`),
  bolt: svg(html`<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />`),
  shield: svg(html`<path d="M8 1.8l5.2 2v4.4c0 3-2.2 5.2-5.2 6-3-.8-5.2-3-5.2-6V3.8z" />`),
  gem: svg(html`<path d="M4 2.5h8l2.5 3.5L8 14 1.5 6z" /><path d="M1.5 6h13M6 2.5L5 6l3 8 3-8-1-3.5" />`),
  link: svg(html`<path d="M6.8 9.2a2.6 2.6 0 003.7 0l2.2-2.2a2.6 2.6 0 00-3.7-3.7l-.9.9" /><path d="M9.2 6.8a2.6 2.6 0 00-3.7 0L3.3 9a2.6 2.6 0 003.7 3.7l.9-.9" />`),
  arrowRight: svg(html`<path d="M3 8h10M9 4l4 4-4 4" />`),
  arrowLeft: svg(html`<path d="M13 8H3M7 4L3 8l4 4" />`),
  chevronDown: svg(html`<path d="M4 6l4 4 4-4" />`),
  chevronRight: svg(html`<path d="M6 4l4 4-4 4" />`),
  warn: svg(html`<path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" />`),
  info: svg(html`<circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 4.9v.1" />`),
  clock: svg(html`<circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.4" />`),
  refresh: svg(html`<path d="M13 3v3.5H9.5" /><path d="M12.6 6.4A5 5 0 103 8" />`),
  copy: svg(html`<rect x="5" y="5" width="8.5" height="8.5" rx="1" /><path d="M11 5V2.5H2.5V11H5" />`),
  user: svg(html`<circle cx="8" cy="5.5" r="2.7" /><path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3" />`),
  users: svg(html`<circle cx="6" cy="5.8" r="2.4" /><path d="M1.8 13.5c.5-2.4 2.2-3.7 4.2-3.7s3.7 1.3 4.2 3.7" /><path d="M10.4 3.6a2.4 2.4 0 010 4.5M12 9.9c1.2.5 2 1.7 2.3 3.6" />`),
  globe: svg(html`<circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2z" />`),
  plane: svg(html`<path d="M14 6.5c0-.8-.6-1.3-1.4-1.1L9.5 6.3 5.5 2H4l2.3 4.8-3 .8L2 6.4H1l.9 2.8 10.7-1.6c.8-.2 1.4-.4 1.4-1.1z" />`),
  box: svg(html`<path d="M2 4.8L8 2l6 2.8v6.4L8 14l-6-2.8z" /><path d="M2 4.8L8 7.6l6-2.8M8 7.6V14" />`),
  stamp: svg(html`<path d="M6 2.5h4l-.6 5H6.6z" /><path d="M3 9.5h10v2.2H3zM3.5 13.5h9" />`),
  pick: svg(html`<path d="M3 13l5-5M9.5 2.5c2.2.3 3.7 1.8 4 4l-3 .6-1.6-1.6z" /><path d="M7 4.5l4.5 4.5" />`),
  factory: svg(html`<path d="M1.8 14V7l4 2.4V7l4 2.4V3h4.4v11z" />`),
  scale: svg(html`<path d="M8 2.5v11M4.5 13.5h7M3 5h10M3 5l-1.8 4.2a2 2 0 003.6 0zM13 5l-1.8 4.2a2 2 0 003.6 0z" />`),
  receipt: svg(html`<path d="M3.5 1.8h9v12.4l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1z" /><path d="M5.5 5.5h5M5.5 8h5" />`),
  lock: svg(html`<rect x="3" y="7" width="10" height="7" rx="1.2" /><path d="M5.2 7V5a2.8 2.8 0 015.6 0v2" />`),
  more: svg(html`<circle cx="3.5" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12.5" cy="8" r=".6" />`),
  pause: svg(html`<path d="M5.5 3.5v9M10.5 3.5v9" />`),
  zoomIn: svg(html`<circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14M5 7h4M7 5v4" />`),
  zoomOut: svg(html`<circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14M5 7h4" />`),
  eye: svg(html`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" />`),
  qr: svg(html`<rect x="2" y="2" width="4.5" height="4.5" /><rect x="9.5" y="2" width="4.5" height="4.5" /><rect x="2" y="9.5" width="4.5" height="4.5" /><path d="M9.5 9.5h2v2M14 9.5v4.5h-4.5" />`),
};

/** The agent cursor: an arrow in the agent's colour with a thin dark outline. */
export function CursorArrow({ color }) {
  return html`<svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 1.5l11 6.2-4.9 1.1-2.2 4.7z" fill=${color} stroke="#0b0c0e" stroke-width="1.1" stroke-linejoin="round" />
  </svg>`;
}
