// The hero word: "Jewel Labs" made of glittering particles, like the intro on jewellabs.io.
//   1. The word is drawn once on a hidden canvas. Every few pixels that land inside a letter
//      become the target of one particle.
//   2. The particles start scattered over the whole hero, gather into the Jewel Labs diamond mark,
//      hold for a moment, then flow into the word from left to right, warming from gold to white.
//   3. Then they stay in place and shimmer. The pointer pushes nearby particles aside; they spring back.
// The canvas covers the hero (not the window), so the word scrolls away with the page like text.
import { makeSprite } from './sprite.js';

const WORD = 'Jewel Labs';
const GATHER = 1700; // ms: particles fly in and form the mark
const HOLD = 450; // ms: the mark holds still
const SPREAD = 550; // ms: the left end of the word starts flowing this much before the right end
const FLOW = 1300; // ms: one particle's trip from the mark into the word
const DONE = GATHER + HOLD + SPREAD + FLOW;

// The Jewel Labs mark as line segments, in units of half its height: outer diamond, inner
// diamond, and the four short lines between them.
const MARK = [
  [[0, -1], [1, 0]], [[1, 0], [0, 1]], [[0, 1], [-1, 0]], [[-1, 0], [0, -1]],
  [[0, -0.46], [0.46, 0]], [[0.46, 0], [0, 0.46]], [[0, 0.46], [-0.46, 0]], [[-0.46, 0], [0, -0.46]],
  [[0, -1], [0, -0.46]], [[1, 0], [0.46, 0]], [[0, 1], [0, 0.46]], [[-1, 0], [-0.46, 0]],
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * hero: the section the canvas covers. canvas: the drawing surface. slot: the empty box in the
 * layout where the word belongs. Returns false if particles cannot run (the plain word shows instead).
 */
export async function initParticleText({ hero, canvas, slot, reduced }) {
  const ctx = canvas && canvas.getContext('2d');
  if (!ctx) return false;
  await fontReady();

  // From warm champagne (while gathering) to white (once in the word).
  const sprites = ['236,224,190', '241,234,212', '246,244,236', '244,248,255'].map((rgb) => makeSprite(rgb));
  let ratio = 1;
  let width = 0;
  let height = 0;
  let size = 1; // particle size for this word size
  let particles = [];
  let startedAt = 0; // when the intro began; positions are worked out from the time since then
  let raf = 0;
  let running = false;
  let onScreen = true;
  const pointer = { x: -1e6, y: -1e6 };

  function build() {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    const heroBox = hero.getBoundingClientRect();
    const slotBox = slot.getBoundingClientRect();
    width = canvas.width = Math.round(heroBox.width * ratio);
    height = canvas.height = Math.round(heroBox.height * ratio);
    const box = {
      x: (slotBox.left - heroBox.left) * ratio,
      y: (slotBox.top - heroBox.top) * ratio,
      w: slotBox.width * ratio,
      h: slotBox.height * ratio,
    };
    size = clamp(slotBox.height / 120, 0.75, 1.15) * ratio;
    const targets = sampleWord(box);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const t of targets) {
      minX = Math.min(minX, t.x);
      maxX = Math.max(maxX, t.x);
    }
    const markX = (minX + maxX) / 2;
    const markY = box.y + box.h / 2;
    const markR = box.h * 0.5;

    particles = targets.map((t) => {
      const [[x0, y0], [x1, y1]] = MARK[Math.floor(Math.random() * MARK.length)];
      const u = Math.random();
      return {
        sx: lerp(-0.2, 1.2, Math.random()) * width, // start anywhere over the hero, a bit past its edges
        sy: lerp(-0.2, 1.2, Math.random()) * height,
        mx: markX + lerp(x0, x1, u) * markR, // a point on the diamond mark
        my: markY + lerp(y0, y1, u) * markR,
        tx: t.x, // its place in the word
        ty: t.y,
        delay: Math.random() * 0.3, // particles arrive at different times
        flowDelay: (t.x - minX) / (maxX - minX || 1), // the left of the word fills first
        phase: Math.random() * Math.PI * 2,
        speed: 0.6 + Math.random() * 0.9,
        pushX: 0,
        pushY: 0,
      };
    });
  }

  /** Draws the word on a hidden canvas and returns a point for every few pixels inside the letters. */
  function sampleWord(box) {
    const off = document.createElement('canvas');
    off.width = Math.max(2, Math.round(box.w));
    off.height = Math.max(2, Math.round(box.h));
    const g = off.getContext('2d', { willReadFrequently: true });
    let fontSize = Math.floor(off.height * 0.7);
    const font = (s) => `500 ${s}px Geist, Inter, system-ui, sans-serif`;
    g.font = font(fontSize);
    while (g.measureText(WORD).width > off.width * 0.98 && fontSize > 10) {
      fontSize -= 2;
      g.font = font(fontSize);
    }
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(WORD, 2, off.height / 2);
    const data = g.getImageData(0, 0, off.width, off.height).data;
    const step = Math.max(2, Math.round(off.height / 64));
    const points = [];
    for (let y = 0; y < off.height; y += step) {
      for (let x = 0; x < off.width; x += step) {
        if (data[(y * off.width + x) * 4 + 3] <= 128) continue;
        // A little random offset hides the sampling grid, so the letters look sprinkled, not printed.
        points.push({ x: box.x + x + (Math.random() - 0.5) * step * 0.9, y: box.y + y + (Math.random() - 0.5) * step * 0.9 });
      }
    }
    // Keep at most `cap` particles, picked evenly across the word.
    const cap = window.innerWidth < 720 ? 800 : 1500;
    if (points.length <= cap) return points;
    const stride = points.length / cap;
    return Array.from({ length: cap }, (_, i) => points[Math.floor(i * stride)]);
  }

  /** Where a particle is `t` ms into the intro, and how far through the intro it is (0..1). */
  function place(p, t) {
    if (t < GATHER + HOLD) {
      const g = easeOut(clamp((t / GATHER - p.delay) / (1 - p.delay), 0, 1));
      const wobble = (1 - g) * 12 * ratio;
      return [
        lerp(p.sx, p.mx, g) + Math.sin(t * 0.0035 + p.phase) * wobble,
        lerp(p.sy, p.my, g) + Math.cos(t * 0.003 + p.phase) * wobble,
        g * 0.4,
      ];
    }
    const f = easeInOut(clamp((t - GATHER - HOLD - p.flowDelay * SPREAD) / FLOW, 0, 1));
    return [lerp(p.mx, p.tx, f), lerp(p.my, p.ty, f), 0.4 + f * 0.6];
  }

  function draw(now) {
    const t = reduced ? DONE : now - startedAt;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    const reach = 70 * ratio;
    for (const p of particles) {
      let [x, y, progress] = place(p, t);
      if (t >= DONE && !reduced) {
        // A slow drift so the word never sits perfectly still.
        x += Math.sin(t * 0.0007 + p.phase) * 0.6 * ratio;
        y += Math.cos(t * 0.00058 + p.phase * 1.3) * 0.6 * ratio;
        // The pointer pushes particles aside; they spring back when it moves on.
        let wantX = 0;
        let wantY = 0;
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < reach && d > 0.01) {
          const force = (1 - d / reach) * 20 * ratio;
          wantX = (dx / d) * force;
          wantY = (dy / d) * force;
        }
        p.pushX += (wantX - p.pushX) * 0.14;
        p.pushY += (wantY - p.pushY) * 0.14;
        x += p.pushX;
        y += p.pushY;
      }
      const twinkle = 0.5 + 0.5 * Math.sin(t * 0.0024 * p.speed + p.phase);
      // Now and then a particle flares: that is the glitter.
      const sparkle = Math.sin(t * 0.0011 * p.speed + p.phase * 3) > 0.99 ? 1 : 0;
      // Dimmer while the particles crowd into the mark, full strength once they are in the word.
      const strength = progress < 0.4 ? 0.25 + progress * 0.9 : 0.6 + (progress - 0.4) * 0.67;
      const alpha = reduced ? 0.7 : Math.min(1, (0.34 + 0.34 * twinkle + 0.45 * sparkle) * strength);
      const s = (1.15 + 0.5 * twinkle) * size * (sparkle ? 2 : 1);
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites[Math.min(3, Math.floor(progress * 4))], x - s, y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    if (!startedAt) startedAt = now;
    draw(now);
    if (running) raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running || reduced || !onScreen || document.hidden) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  build();
  slot.classList.add('is-particles');
  if (reduced) draw(0);
  else start();

  // Rebuild for the new size. If the intro already ran, the particles go straight to the word.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      build();
      if (startedAt) startedAt = Math.min(startedAt, performance.now() - DONE);
      if (!running) draw(performance.now());
    }, 200);
  });

  hero.addEventListener('pointermove', (e) => {
    const box = hero.getBoundingClientRect();
    pointer.x = (e.clientX - box.left) * ratio;
    pointer.y = (e.clientY - box.top) * ratio;
  }, { passive: true });
  hero.addEventListener('pointerleave', () => {
    pointer.x = -1e6;
    pointer.y = -1e6;
  });

  new IntersectionObserver((entries) => {
    onScreen = entries[0].isIntersecting;
    if (onScreen) start();
    else stop();
  }).observe(hero);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  return true;
}

/** Waits for the Geist font (up to 1.5 s), so the particles take the shape of the real letters. */
async function fontReady() {
  if (!document.fonts || !document.fonts.load) return;
  const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    await Promise.race([document.fonts.load('500 100px Geist'), timeout]);
  } catch {
    // Use whatever font is there.
  }
}
