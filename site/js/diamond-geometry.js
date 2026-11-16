// Shapes for the particle diamond: a round brilliant cut, and the rough crystal it is cut from.
// Pure math with no browser code, so the unit tests can check it in Node.
// Coordinates: x to the right, y up, z toward the viewer. Both stones are about 2 units wide
// and centred on (0, 0, 0).

/**
 * A tiny seeded random number generator (the well-known "mulberry32").
 * Seeded so every visitor sees the same stone, and the tests get the same numbers every run.
 */
export function makeRandom(seed = 1) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A round brilliant, simplified to the lines the eye reads: an 8-sided table, 8 star points,
 * a 16-sided girdle, and the pavilion meeting at the culet (the point at the bottom).
 * Returns { edges: [[a, b], ...], faces: [[a, b, c], ...], tips: [point] } where points are [x, y, z].
 */
export function brilliantCut() {
  const LIFT = 0.2; // moves the stone up so its height is centred on 0
  const table = [];
  const star = [];
  const girdleTop = [];
  const girdleBottom = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    table.push([Math.cos(a) * 0.5, 0.44 + LIFT, Math.sin(a) * 0.5]);
    const b = a + Math.PI / 8; // star points sit between two table corners
    star.push([Math.cos(b) * 0.72, 0.27 + LIFT, Math.sin(b) * 0.72]);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8;
    girdleTop.push([Math.cos(a), 0.025 + LIFT, Math.sin(a)]);
    girdleBottom.push([Math.cos(a), -0.025 + LIFT, Math.sin(a)]);
  }
  const culet = [0, -0.84 + LIFT, 0];

  const next8 = (i) => (i + 1) % 8;
  const prev8 = (i) => (i + 7) % 8;
  const next16 = (i) => (i + 1) % 16;

  const edges = [];
  const faces = [];
  const quad = (a, b, c, d) => faces.push([a, b, c], [a, c, d]);

  for (let i = 1; i < 7; i++) faces.push([table[0], table[i], table[i + 1]]); // the flat table on top
  for (let i = 0; i < 8; i++) {
    edges.push([table[i], table[next8(i)]]); // table outline
    edges.push([table[i], star[i]], [table[next8(i)], star[i]]); // star facets
    edges.push([star[i], girdleTop[2 * i + 1]]); // star point down to the girdle
    edges.push([table[i], girdleTop[2 * i]]); // table corner down to the girdle
    faces.push([table[i], table[next8(i)], star[i]]); // star facet
    quad(table[i], star[i], girdleTop[2 * i], star[prev8(i)]); // kite (bezel) facet
    faces.push([star[i], girdleTop[2 * i + 1], girdleTop[2 * i]]); // upper girdle facets
    faces.push([star[i], girdleTop[next16(2 * i + 1)], girdleTop[2 * i + 1]]);
  }
  for (let i = 0; i < 16; i++) {
    edges.push([girdleTop[i], girdleTop[next16(i)]]); // girdle, top ring
    edges.push([girdleBottom[i], girdleBottom[next16(i)]]); // girdle, bottom ring
    edges.push([girdleTop[i], girdleBottom[i]]); // girdle thickness
    edges.push([girdleBottom[i], culet]); // pavilion lines down to the culet
    quad(girdleTop[i], girdleTop[next16(i)], girdleBottom[next16(i)], girdleBottom[i]); // girdle band
    faces.push([girdleBottom[i], girdleBottom[next16(i)], culet]); // pavilion facet
  }
  return { edges, faces, tips: [culet] };
}

/**
 * A rough diamond crystal: an octahedron, slightly uneven and turned, a little larger than the
 * polished stone (cutting removes more than half of the rough).
 */
export function roughCrystal(random = makeRandom(7)) {
  const SIZE = 1.18;
  const raw = [
    [0, 1, 0], [0, -1, 0], // top and bottom points
    [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], // the four corners around the middle
  ];
  // Each corner pushed in or out a little, so it does not look machine-made.
  const corners = raw.map(([x, y, z]) => {
    const k = SIZE * (0.9 + random() * 0.18);
    return turn([x * k, y * k, z * k], 0.32, 0.5);
  });
  const [top, bottom, ...ring] = corners;
  const edges = [];
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    edges.push([a, b], [top, a], [bottom, a]);
    faces.push([top, a, b], [bottom, b, a]);
  }
  return { edges, faces, tips: [] };
}

/** Turns a point around the z axis (tilt) and then the y axis (spin). Used to set the rough crystal at an angle. */
function turn([x, y, z], tilt, spin) {
  const x1 = x * Math.cos(tilt) - y * Math.sin(tilt);
  const y1 = x * Math.sin(tilt) + y * Math.cos(tilt);
  return [x1 * Math.cos(spin) + z * Math.sin(spin), y1, -x1 * Math.sin(spin) + z * Math.cos(spin)];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function triangleArea([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return Math.hypot(cross[0], cross[1], cross[2]) / 2;
}

/** A random point inside a triangle, spread evenly. */
function pointInTriangle([a, b, c], random) {
  let u = random();
  let v = random();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  return [
    a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
    a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v,
    a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v,
  ];
}

/**
 * Turns a shape into exactly `count` particles, each [x, y, z, weight].
 * About half sit on the edges (weight 1, bright: they draw the facet lines). Edge particles are
 * spread in proportion to edge length, so long edges do not look thin. The rest fill the facets
 * (weight 0.6, dimmer: they give the stone a body). Bigger facets get more particles.
 * `jitter` scatters facet particles a little, which makes the rough crystal look frosted.
 */
export function seedPoints(shape, count, random = makeRandom(3), { edgeShare = 0.46, jitter = 0 } = {}) {
  const points = [];

  const lengths = shape.edges.map(([a, b]) => distance(a, b));
  const totalLength = lengths.reduce((sum, len) => sum + len, 0);
  const edgeBudget = Math.round(count * edgeShare);
  shape.edges.forEach(([a, b], i) => {
    const n = Math.max(2, Math.round((edgeBudget * lengths[i]) / totalLength));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1]);
    }
  });

  // Pack a few particles at each tip so the culet reads as a sharp point.
  for (const tip of shape.tips) {
    for (let j = 0; j < 18; j++) {
      const r = random() * random() * 0.02;
      const a = random() * Math.PI * 2;
      points.push([tip[0] + Math.cos(a) * r, tip[1] + random() * 0.012, tip[2] + Math.sin(a) * r, 1]);
    }
  }

  // Fill the facets. A facet is picked with a chance in proportion to its area.
  const areas = shape.faces.map(triangleArea);
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  while (points.length < count) {
    let pick = random() * totalArea;
    let face = 0;
    while (face < areas.length - 1 && pick > areas[face]) {
      pick -= areas[face];
      face++;
    }
    const [x, y, z] = pointInTriangle(shape.faces[face], random);
    const j = jitter ? jitter * (random() * 2 - 1) : 0;
    points.push([x * (1 + j), y * (1 + j), z * (1 + j), 0.6]);
  }

  return points.slice(0, count);
}

/**
 * Sorts particles from bottom to top. The rough and the polished stone are both sorted this way,
 * so particle number i sits at about the same height in both shapes and the change from one shape
 * to the other looks like the stone settling, not like particles flying across the screen.
 */
export function sortByHeight(points) {
  return [...points].sort((a, b) => a[1] - b[1]);
}

/** The edges as one flat list of numbers [x1, y1, z1, x2, y2, z2, ...] for drawing lines with three.js. */
export function edgePositions(shape) {
  const out = new Float32Array(shape.edges.length * 6);
  shape.edges.forEach(([a, b], i) => out.set([...a, ...b], i * 6));
  return out;
}

/**
 * Where particle i sits when the stone is `morph` of the way from rough (0) to polished (1).
 * Halfway through, each particle also swings around the vertical axis, so the change reads as a swirl.
 * Writes [x, y, z, weight] into `out` (no new arrays, because this runs for every particle every frame).
 */
export function pointAt(rough, cut, i, morph, out) {
  const a = rough[i];
  const b = cut[i];
  let x = a[0] + (b[0] - a[0]) * morph;
  const y = a[1] + (b[1] - a[1]) * morph;
  let z = a[2] + (b[2] - a[2]) * morph;
  const swirl = Math.sin(Math.PI * morph) * 1.2; // zero at both ends of the change
  if (swirl > 0.0001) {
    const c = Math.cos(swirl);
    const s = Math.sin(swirl);
    const nx = x * c - z * s;
    z = x * s + z * c;
    x = nx;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = a[3] + (b[3] - a[3]) * morph;
  return out;
}

/** The two shapes, built once. */
export const BRILLIANT = brilliantCut();
export const ROUGH = roughCrystal();
