// Stone history. As you scroll, each step of the timeline lights up, the line fills, the sample
// stone's card updates, and the particle diamond follows the story: a rough crystal until "Cut and
// polished", a light passes over it at "Graded", and it lights up when the statement is signed.
import { createDiamond } from './diamond.js';

/** How many steps are reached: a step counts once its dot has passed the reading line. */
export function countReached(dotTops, line) {
  let reached = 0;
  for (const top of dotTops) if (top <= line) reached++;
  return reached;
}

/** How much of the rail is filled (0 to 1), given where the rail is and where the reading line is. */
export function railProgress(railTop, railHeight, line) {
  if (railHeight <= 0) return 0;
  return Math.max(0, Math.min(1, (line - railTop) / railHeight));
}

export async function initHistory({ reduced, small }) {
  const section = document.getElementById('history');
  const host = document.getElementById('history-stone');
  if (!section) return;
  const steps = [...section.querySelectorAll('.timeline__step')];
  const rail = section.querySelector('.timeline__rail');
  const fill = document.getElementById('timeline-fill');
  const card = {
    step: document.getElementById('stone-step'),
    shape: document.getElementById('stone-shape'),
    report: document.getElementById('stone-report'),
    now: document.getElementById('stone-now'),
  };
  const morphAt = steps.findIndex((s) => s.hasAttribute('data-morph')); // "Cut and polished"
  const scanAt = steps.findIndex((s) => s.hasAttribute('data-scan')); // "Graded"
  const signedAt = steps.findIndex((s) => s.hasAttribute('data-signed')); // "Statement signed"

  let diamond = null;
  let reached = -1;

  /** Shows the state after `count` steps; `before` is how many were reached until now. */
  function apply(count, before) {
    steps.forEach((step, i) => {
      step.classList.toggle('is-on', i < count);
      step.classList.toggle('is-current', i === count - 1);
    });
    const latest = steps[Math.max(0, count - 1)];
    card.step.textContent = `Step ${Math.max(1, count)} of ${steps.length}`;
    card.shape.textContent = latest.dataset.shape;
    card.report.textContent = latest.dataset.report;
    card.now.textContent = latest.querySelector('.timeline__title').textContent;

    if (!diamond) return;
    diamond.setMorph(count > morphAt ? 1 : 0);
    diamond.setGlow(count > signedAt ? 1 : 0);
    if (count > before && before >= 0) diamond.flash();
    if (count > scanAt && before <= scanAt && !reduced) replay(host, 'is-scanning');
    if (count > signedAt && before <= signedAt && !reduced) replay(host, 'is-signed');
  }

  function update() {
    const line = window.innerHeight * 0.58;
    const tops = steps.map((step) => step.querySelector('.timeline__dot').getBoundingClientRect().top + 6);
    const count = reduced ? steps.length : countReached(tops, line);
    if (rail && fill) {
      const box = rail.getBoundingClientRect();
      fill.style.setProperty('--progress', reduced ? '1' : railProgress(box.top, box.height, line).toFixed(4));
    }
    if (count !== reached) {
      apply(count, reached);
      reached = count;
    }
  }

  // Scroll work only while the section is near the screen, at most once per frame.
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      update();
    });
  };
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      window.addEventListener('scroll', onScroll, { passive: true });
      update();
    } else {
      window.removeEventListener('scroll', onScroll);
    }
  }, { rootMargin: '200px 0px' }).observe(section);
  window.addEventListener('resize', onScroll);
  update();

  if (host) {
    diamond = await createDiamond(host, {
      count: small ? 900 : 1500,
      morph: reduced ? 1 : 0,
      spin: 0.00024,
      tilt: 0.4,
      distance: 5.2,
      reduced,
    });
    if (diamond) {
      const count = Math.max(0, reached);
      diamond.setMorph(count > morphAt ? 1 : 0);
      diamond.setGlow(count > signedAt ? 1 : 0);
    }
  }
}

/** Restarts a one-shot CSS animation by removing its class and adding it back. */
function replay(el, className) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth; // forces the browser to notice the class was removed
  el.classList.add(className);
}
