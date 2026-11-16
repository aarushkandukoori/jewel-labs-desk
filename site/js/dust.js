// Slow ambient dust behind the whole page, like jewellabs.io: a few dozen faint motes drifting up.
// Motes lean gently toward the pointer. Pauses while the tab is hidden; off under reduced motion.
import { makeSprite } from './sprite.js';

export function initDust(canvas, { reduced }) {
  if (!canvas) return;
  if (reduced) {
    canvas.remove();
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const sprite = makeSprite('214,218,226');
  const count = window.innerWidth < 720 ? 26 : 54;
  const pointer = { x: -1, y: -1 };
  let ratio = 1;
  let width = 0;
  let height = 0;

  function fit() {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.width = Math.round(window.innerWidth * ratio);
    height = canvas.height = Math.round(window.innerHeight * ratio);
  }

  /** A new mote. `anywhere` places it at a random height; otherwise it enters from the bottom. */
  function mote(anywhere) {
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : height + 10 * ratio,
      r: (1.2 + Math.random() * 2.4) * ratio,
      vx: (Math.random() - 0.5) * 0.1, // pixels per frame at 60 frames a second
      vy: -(0.05 + Math.random() * 0.12),
      alpha: 0.1 + Math.random() * 0.28,
      phase: Math.random() * Math.PI * 2,
    };
  }

  fit();
  const motes = Array.from({ length: count }, () => mote(true));

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 150);
  });
  window.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX * ratio;
    pointer.y = e.clientY * ratio;
  }, { passive: true });

  let raf = 0;
  let last = 0;
  function frame(now) {
    const k = last ? Math.min(4, (now - last) / 16.7) : 1; // same speed on 60 Hz and 120 Hz screens
    last = now;
    ctx.clearRect(0, 0, width, height);
    const reach = 320 * ratio;
    for (const m of motes) {
      let ax = 0;
      let ay = 0;
      if (pointer.x >= 0) {
        const dx = pointer.x - m.x;
        const dy = pointer.y - m.y;
        const d = Math.hypot(dx, dy);
        if (d < reach && d > 1) {
          const pull = (1 - d / reach) * 0.18;
          ax = (dx / d) * pull;
          ay = (dy / d) * pull;
        }
      }
      m.x += (m.vx * ratio + ax) * k;
      m.y += (m.vy * ratio + ay) * k;
      if (m.y < -10 * ratio) Object.assign(m, mote(false));
      if (m.x < -10 * ratio) m.x = width + 10 * ratio;
      else if (m.x > width + 10 * ratio) m.x = -10 * ratio;
      ctx.globalAlpha = Math.max(0, m.alpha + Math.sin(now * 0.001 + m.phase) * 0.07);
      ctx.drawImage(sprite, m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  });
}
