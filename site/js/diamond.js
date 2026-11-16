// The particle diamond. It appears twice: large in the hero, and next to the stone history timeline,
// where it starts as a rough crystal and becomes a polished brilliant as you scroll.
// Drawn with three.js r128 from cdnjs (the same build jewellabs.io uses). If three.js cannot load,
// or the computer has no WebGL, the same particles are drawn on a plain 2D canvas instead.
import { BRILLIANT, ROUGH, edgePositions, makeRandom, pointAt, seedPoints, sortByHeight } from './diamond-geometry.js';
import { makeSprite } from './sprite.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
// The file's fingerprint as published by cdnjs (api.cdnjs.com/libraries/three.js/r128?fields=sri).
// The browser refuses to run the script if the bytes it gets do not match, and the 2D canvas takes over.
const THREE_SRI = 'sha512-dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==';
let threeLoading = null;

/** Loads three.js once for the whole page. Resolves to THREE, or to null if it cannot load in time. */
export function loadThree(timeoutMs = 7000) {
  if (window.THREE) return Promise.resolve(window.THREE);
  if (!threeLoading) {
    threeLoading = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = THREE_URL;
      script.async = true;
      script.integrity = THREE_SRI;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      const timer = setTimeout(() => resolve(null), timeoutMs);
      script.onload = () => {
        clearTimeout(timer);
        resolve(window.THREE || null);
      };
      script.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }
  return threeLoading;
}

/**
 * Puts a particle diamond inside `host` (an empty element that has a size).
 * options:
 *   count   number of particles
 *   morph   0 = rough crystal, 1 = polished brilliant
 *   spin    how fast it turns, in radians per millisecond
 *   tilt    how far the top leans toward you, in radians
 *   distance how far the camera is from the stone (smaller is bigger on screen)
 *   follow  lean a little toward the pointer
 *   reduced draw still frames only (prefers-reduced-motion)
 * Returns { setMorph(value), setGlow(value), flash() }, or null if nothing can be drawn.
 */
export async function createDiamond(host, options = {}) {
  const o = { count: 1600, morph: 1, spin: 0.00028, tilt: 0.42, distance: 6.2, follow: false, reduced: false, ...options };
  const stone = makeStone(o.count);

  const THREE = await loadThree();
  let view = THREE ? threeView(THREE, host, stone, o.distance) : null;
  if (!view) view = canvasView(host, stone, o.distance);
  if (!view) return null;

  const state = {
    morph: o.morph,
    tween: null, // { from, to, start } while the stone is changing shape
    glow: 0,
    glowTarget: 0,
    flash: 0,
    angle: 0.5,
    leanX: 0,
    leanY: 0,
  };
  let pointerX = 0;
  let pointerY = 0;
  if (o.follow) {
    window.addEventListener('pointermove', (e) => {
      pointerX = (e.clientX / window.innerWidth) * 2 - 1;
      pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
  }

  let raf = 0;
  let running = false;
  let onScreen = false;
  let last = 0;

  function frame(now) {
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    state.angle += dt * o.spin;
    if (state.tween) {
      const t = Math.min(1, (now - state.tween.start) / 1500);
      state.morph = state.tween.from + (state.tween.to - state.tween.from) * easeInOut(t);
      if (t >= 1) state.tween = null;
    }
    state.glow += (state.glowTarget - state.glow) * (1 - Math.exp(-dt / 600));
    state.flash *= Math.exp(-dt / 520);
    if (o.follow) {
      state.leanX += (pointerX * 0.35 - state.leanX) * 0.04;
      state.leanY += (pointerY * 0.16 - state.leanY) * 0.04;
    }
    draw(now);
    if (running) raf = requestAnimationFrame(frame);
  }

  function draw(now) {
    view.draw({
      time: now,
      morph: state.morph,
      glow: state.glow,
      flash: state.flash,
      spin: state.angle + state.leanX,
      tilt: o.tilt + state.leanY,
    });
  }

  function start() {
    if (running || o.reduced || !onScreen || document.hidden) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  // Keep the drawing size equal to the box size.
  const resize = () => {
    const box = host.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    view.resize(box.width, box.height);
    if (!running) draw(performance.now());
  };
  resize();
  new ResizeObserver(resize).observe(host);

  // Only animate while the stone is on screen and the tab is visible.
  new IntersectionObserver((entries) => {
    onScreen = entries[0].isIntersecting;
    if (onScreen) start();
    else stop();
  }, { rootMargin: '80px' }).observe(host);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  host.classList.add('is-ready');

  return {
    /** Changes the shape: 0 rough, 1 polished. Animates over 1.5 seconds. */
    setMorph(value) {
      const to = Math.max(0, Math.min(1, value));
      if (o.reduced) {
        state.morph = to;
        draw(performance.now());
        return;
      }
      if ((state.tween ? state.tween.to : state.morph) === to) return;
      state.tween = { from: state.morph, to, start: performance.now() };
    },
    /** How bright the whole stone is, from 0 (normal) to 1 (lit up). */
    setGlow(value) {
      state.glowTarget = Math.max(0, Math.min(1, value));
      if (o.reduced) {
        state.glow = state.glowTarget;
        draw(performance.now());
      }
    },
    /** A short burst of light, used when a timeline step lands. */
    flash() {
      if (!o.reduced) state.flash = 1;
    },
  };
}

/** The particles for one stone: positions as a rough crystal and as a brilliant, plus a twinkle phase each. */
function makeStone(count) {
  const random = makeRandom(11);
  const cut = sortByHeight(seedPoints(BRILLIANT, count, random, { edgeShare: 0.55 }));
  const rough = sortByHeight(seedPoints(ROUGH, count, random, { edgeShare: 0.4, jitter: 0.035 }));
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  const blue = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    phase[i] = random() * Math.PI * 2;
    speed[i] = 0.6 + random() * 0.9;
    blue[i] = random() < 0.22 ? 1 : 0; // a few particles are a cooler, icy blue
  }
  return { count, cut, rough, phase, speed, blue };
}

/** How bright particle i is right now: it twinkles, and the whole stone can glow or flash. */
function brightness(stone, i, weight, f) {
  const twinkle = 0.68 + 0.32 * Math.sin(f.time * 0.0022 * stone.speed[i] + stone.phase[i]);
  return weight * twinkle * (0.85 + 0.4 * f.glow + 0.7 * f.flash);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/* ───────── three.js view ───────── */

function threeView(THREE, host, stone, distance) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null; // no WebGL on this computer: the 2D canvas takes over
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Black fog dims the far side of the stone. With additive blending on black, that reads as depth.
  scene.fog = new THREE.Fog(0x000000, distance - 1.3, distance + 1.6);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, distance);

  const group = new THREE.Group();
  scene.add(group);

  const n = stone.count;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.085,
    map: dotTexture(THREE),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  group.add(points);

  // Faint facet lines under the particles, one set per shape. They cross-fade as the stone changes.
  const cutLines = lines(THREE, edgePositions(BRILLIANT));
  const roughLines = lines(THREE, edgePositions(ROUGH));
  group.add(cutLines, roughLines);

  // A loose shell of dust around the stone, turning slowly.
  const dust = dustShell(THREE, 150);
  scene.add(dust);

  const p = [0, 0, 0, 0];
  let lastMorph = -1;

  return {
    resize(width, height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    draw(f) {
      const moved = f.morph !== lastMorph;
      for (let i = 0; i < n; i++) {
        pointAt(stone.rough, stone.cut, i, f.morph, p);
        if (moved) {
          positions[i * 3] = p[0];
          positions[i * 3 + 1] = p[1];
          positions[i * 3 + 2] = p[2];
        }
        const b = brightness(stone, i, p[3], f);
        colors[i * 3] = (stone.blue[i] ? 0.72 : 0.93) * b;
        colors[i * 3 + 1] = (stone.blue[i] ? 0.85 : 0.96) * b;
        colors[i * 3 + 2] = b;
      }
      if (moved) geometry.attributes.position.needsUpdate = true; // positions only change while the shape changes
      geometry.attributes.color.needsUpdate = true;
      lastMorph = f.morph;

      cutLines.material.opacity = 0.11 * f.morph * (1 + 0.8 * f.glow);
      roughLines.material.opacity = 0.09 * (1 - f.morph);
      group.rotation.set(f.tilt, f.spin, 0);
      dust.rotation.y = f.time * 0.00004;
      dust.rotation.x = f.time * 0.00002;
      renderer.render(scene, camera);
    },
  };
}

/**
 * A soft round dot used as the texture for every particle. It is built from numbers rather than
 * drawn on a canvas, so the browser never has to copy a canvas back from the graphics card.
 */
function dotTexture(THREE) {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2); // 0 at the centre, 1 at the edge
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(Math.pow(Math.max(0, 1 - d), 1.6) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function lines(THREE, flatPositions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(flatPositions, 3));
  const material = new THREE.LineBasicMaterial({ color: 0xc8d4e6, transparent: true, opacity: 0, depthWrite: false });
  return new THREE.LineSegments(geometry, material);
}

function dustShell(THREE, count) {
  const random = makeRandom(5);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 2.1 + random() * 1.8;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xb8bcc4, size: 0.022, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}

/* ───────── 2D canvas view (fallback) ───────── */

function canvasView(host, stone, distance) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  host.appendChild(canvas);
  const white = makeSprite('232,244,255');
  const blue = makeSprite('190,214,248');
  let width = 0;
  let height = 0;
  let ratio = 1;
  const p = [0, 0, 0, 0];

  return {
    resize(w, h) {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.width = Math.round(w * ratio);
      height = canvas.height = Math.round(h * ratio);
    },
    draw(f) {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      const scale = Math.min(width, height) * 0.3 * (6.2 / distance);
      const cosY = Math.cos(f.spin);
      const sinY = Math.sin(f.spin);
      const cosX = Math.cos(f.tilt);
      const sinX = Math.sin(f.tilt);
      for (let i = 0; i < stone.count; i++) {
        pointAt(stone.rough, stone.cut, i, f.morph, p);
        // Same turn as three.js: spin around the stone's own axis, then tilt the top toward you.
        const x1 = p[0] * cosY + p[2] * sinY;
        const z1 = -p[0] * sinY + p[2] * cosY;
        const y2 = p[1] * cosX - z1 * sinX;
        const z2 = p[1] * sinX + z1 * cosX;
        const k = 5 / (5 - z2); // nearer particles are a little bigger and further out
        const depth = Math.max(0, Math.min(1, (z2 + 1.2) / 2.4));
        const alpha = Math.min(1, brightness(stone, i, p[3], f) * (0.45 + 0.8 * depth));
        if (alpha < 0.01) continue;
        const size = (1.6 + 2 * depth) * (0.6 + 0.4 * p[3]) * ratio;
        ctx.globalAlpha = alpha;
        ctx.drawImage(stone.blue[i] ? blue : white, width / 2 + x1 * scale * k - size / 2, height / 2 - y2 * scale * k - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },
  };
}
