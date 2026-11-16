// A small QR code maker for the browser demo (the desktop app uses the qrcode package instead).
// Byte mode, error correction level M, versions 1 to 10: plenty for a wa.me link.
// It follows the QR standard (ISO/IEC 18004) step by step; test/unit/renderer.test.js checks it
// module for module against the qrcode package.

// For level M, per version: [total codewords, error-correction codewords per block, blocks].
const VERSIONS = {
  1: [26, 10, 1], 2: [44, 16, 1], 3: [70, 26, 1], 4: [100, 18, 2], 5: [134, 24, 2],
  6: [172, 16, 4], 7: [196, 18, 4], 8: [242, 22, 4], 9: [292, 22, 5], 10: [346, 26, 5],
};
const ALIGNMENT = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function dataCodewords(version) {
  const [total, ecPerBlock, blocks] = VERSIONS[version];
  return total - ecPerBlock * blocks;
}

// ---------- Reed-Solomon over GF(256), polynomial 0x11D ----------

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}

// ---------- data: mode, length, bytes, padding, error correction ----------

function utf8(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

function encodeData(bytes, version) {
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

function withErrorCorrection(data, version) {
  const [total, ecLen, numBlocks] = VERSIONS[version];
  const shortBlocks = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const divisor = rsDivisor(ecLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - ecLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - ecLen || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---------- the matrix ----------

function emptyMatrix(size) {
  return { size, dark: Array.from({ length: size }, () => new Array(size).fill(false)), fixed: Array.from({ length: size }, () => new Array(size).fill(false)) };
}

function set(m, x, y, dark) {
  m.dark[y][x] = dark;
  m.fixed[y][x] = true;
}

function drawFunctionPatterns(m, version) {
  const { size } = m;
  for (let i = 0; i < size; i++) {
    set(m, 6, i, i % 2 === 0); // timing patterns
    set(m, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finder patterns with separators
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(m, x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = ALIGNMENT[version];
  const last = pos.length - 1;
  pos.forEach((cx, i) => pos.forEach((cy, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(m, 0); // reserve the format areas; the real bits go in after masking
  drawVersion(m, version);
}

function drawFormat(m, mask) {
  const { size } = m;
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(m, 8, i, bit(i));
  set(m, 8, 7, bit(6));
  set(m, 8, 8, bit(7));
  set(m, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(m, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(m, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(m, 8, size - 15 + i, bit(i));
  set(m, 8, size - 8, true); // the dark module
}

function drawVersion(m, version) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(m, a, b, dark);
    set(m, b, a, dark);
  }
}

function drawCodewords(m, codewords) {
  const { size } = m;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.fixed[y][x] && i < codewords.length * 8) {
          m.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (!m.fixed[y][x] && MASKS[mask](x, y)) m.dark[y][x] = !m.dark[y][x];
}

// A simple penalty score (runs, 2x2 blocks, finder-like patterns, balance) to pick a readable mask.
function penalty(m) {
  const { size, dark } = m;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i]);
    lines.push(dark.map((row) => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const s = line.map((d) => (d ? '1' : '0')).join('');
    for (const p of ['10111010000', '00001011101']) for (let k = s.indexOf(p); k !== -1; k = s.indexOf(p, k + 1)) score += 40;
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
    }
  }
  const total = dark.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(total * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

/**
 * Makes the QR code for a text. Returns { version, mask, size, modules } where modules[y][x] is true for dark.
 * options.mask forces a mask (0..7); otherwise the one with the lowest penalty is used.
 */
export function makeQr(text, { mask: forcedMask } = {}) {
  const bytes = utf8(text);
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > 10) throw new Error('That text is too long for this QR code maker.');
  const codewords = withErrorCorrection(encodeData(bytes, version), version);

  const build = (mask) => {
    const m = emptyMatrix(version * 4 + 17);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormat(m, mask);
    return m;
  };
  let best = null;
  for (const mask of forcedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask]) {
    const m = build(mask);
    const score = forcedMask === undefined ? penalty(m) : 0;
    if (!best || score < best.score) best = { m, mask, score };
  }
  return { version, mask: best.mask, size: best.m.size, modules: best.m.dark };
}

/** Draws the QR code on a canvas (in the browser) and returns a PNG data URL. */
export function qrDataUrl(text, { scale = 8, margin = 4 } = {}) {
  const qr = makeQr(text);
  const px = (qr.size + margin * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, px, px);
  g.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) g.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return canvas.toDataURL('image/png');
}
