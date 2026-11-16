// A soft round dot, drawn once on a tiny canvas and then stamped many times.
// Stamped with 'lighter' blending, overlapping dots add up and glow, which is what makes the
// particles read as light instead of a grid of little squares.

/** `rgb` is the colour of the dot's soft edge, like '232,244,255'. The centre is always white. */
export function makeSprite(rgb = '255,255,255') {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, `rgba(${rgb},0.8)`);
  gradient.addColorStop(0.6, `rgba(${rgb},0.2)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return canvas;
}
