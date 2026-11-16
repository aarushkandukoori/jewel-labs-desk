// Starts every part of the page. Each part starts on its own, so if one fails (for example WebGL
// is switched off), the rest of the page still works.
import { initAgentRun, initCardLights, initCursorGlow, initDownloadPill, initNav, initReveal } from './page.js';
import { initDust } from './dust.js';
import { initParticleText } from './particle-text.js';
import { createDiamond } from './diamond.js';
import { initDownloads } from './downloads.js';
import { initStatement } from './statement.js';
import { initDemo } from './demo.js';
import { initHistory } from './history.js';
import { initTeam } from './team.js';
import { initWatch } from './watch.js';
import { initClosingStone } from './closing.js';

window.jlStarted = true; // tells the fail-safe timer in index.html that the script is running

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = window.innerWidth < 720;

function start(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch((error) => warn(name, error));
  } catch (error) {
    warn(name, error);
  }
}
function warn(name, error) {
  console.warn(`Jewel Labs site: ${name} could not start.`, error);
}

start('reveal', () => initReveal(reduced));
start('nav', () => initNav());
start('hero word', async () => {
  const slot = document.getElementById('hero-word');
  const ok = await initParticleText({
    hero: document.getElementById('top'),
    canvas: document.getElementById('hero-particles'),
    slot,
    reduced,
  });
  if (!ok) slot.classList.add('is-solid'); // no canvas: show the plain word
});
start('hero stone', () => {
  const host = document.getElementById('hero-stone');
  if (getComputedStyle(host).display === 'none') return null; // hidden on phones: do not spend battery on it
  return createDiamond(host, {
    count: small ? 800 : 1800,
    morph: 1,
    spin: 0.00026,
    tilt: 0.42,
    follow: !small,
    reduced,
  });
});
start('dust', () => initDust(document.getElementById('dust'), { reduced }));
start('cursor glow', () => initCursorGlow(document.getElementById('cursor-glow'), reduced));
start('card lights', () => initCardLights());
start('downloads', () => initDownloads());
start('download pill', () => initDownloadPill());
start('statement', () => initStatement(reduced));
start('agents', () => initAgentRun(reduced));
start('demo', () => initDemo(reduced));
start('history', () => initHistory({ reduced, small }));
start('team', () => initTeam(reduced));
start('watch', () => initWatch());
start('closing stone', () => initClosingStone({ reduced, small }));
