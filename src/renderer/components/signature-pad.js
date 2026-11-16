// A signature pad: the person draws with a mouse, trackpad or pen. onChange gets a PNG data URL
// (or null when cleared). Plain canvas + pointer events, no library.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';

export function SignaturePad({ onChange }) {
  const canvas = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [empty, setEmpty] = useState(true);

  // Size the canvas to its box (sharp on Retina) and set the pen.
  useEffect(() => {
    const c = canvas.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(c.clientWidth * ratio);
    c.height = Math.round(c.clientHeight * ratio);
    const g = c.getContext('2d');
    g.scale(ratio, ratio);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#111827';
    g.lineWidth = 2.1;
  }, []);

  function point(e) {
    const r = canvas.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e) {
    e.preventDefault();
    canvas.current.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const g = canvas.current.getContext('2d');
    g.beginPath();
    g.arc(last.current.x, last.current.y, 1, 0, Math.PI * 2);
    g.fillStyle = '#111827';
    g.fill();
  }

  function move(e) {
    if (!drawing.current) return;
    const p = point(e);
    const g = canvas.current.getContext('2d');
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    // A soft curve through the midpoint keeps the stroke smooth.
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    g.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    setEmpty(false);
    onChange?.(trimmedPng(canvas.current));
  }

  function clear() {
    const c = canvas.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    onChange?.(null);
  }

  return html`<div class="sig-pad">
    <canvas ref=${canvas} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerLeave=${up}
      aria-label="Draw your signature here" role="img"></canvas>
    <div class="sig-line"></div>
    <div class="sig-hint">${empty ? 'Sign here with your mouse, trackpad or pen' : 'Signature'}</div>
    ${empty ? null : html`<button type="button" class="sig-clear" onClick=${clear}>Clear</button>`}
  </div>`;
}

/** The drawing as a PNG, cropped to the ink so it sits well on the paper. */
function trimmedPng(canvas) {
  const g = canvas.getContext('2d');
  const { width, height } = canvas;
  const pixels = g.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (pixels[(y * width + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 8;
  const w = Math.min(width, x1 - x0 + pad * 2);
  const h = Math.min(height, y1 - y0 + pad * 2);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, Math.max(0, x0 - pad), Math.max(0, y0 - pad), w, h, 0, 0, w, h);
  return out.toDataURL('image/png');
}
