// Small page behaviours: the nav (menu on phones, current section), sections fading in as you
// scroll, the soft light under the pointer, the light inside cards, the floating Download pill,
// and the agent cards lighting up in pipeline order.

/** The phone menu, and the nav link of the section in view. */
export function initNav() {
  const nav = document.getElementById('nav');
  const button = document.getElementById('nav-menu');
  const links = document.getElementById('nav-links');
  if (!nav || !button || !links) return;

  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
  };
  button.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  links.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      setOpen(false);
      button.focus();
    }
  });

  // A thin band across the middle of the screen: the section crossing it is the current one.
  const linkFor = new Map();
  for (const a of links.querySelectorAll('a[href^="#"]')) {
    const section = document.querySelector(a.getAttribute('href'));
    if (section) linkFor.set(section, a);
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const link = linkFor.get(entry.target);
      link.classList.toggle('is-current', entry.isIntersecting);
      if (entry.isIntersecting) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const section of linkFor.keys()) io.observe(section);
}

/** Elements with data-reveal fade up when they scroll into view. data-delay (ms) staggers them. */
export function initReveal(reduced) {
  const items = [...document.querySelectorAll('[data-reveal]')];
  const show = (el) => el.classList.add('is-in');
  if (reduced || !('IntersectionObserver' in window)) {
    items.forEach(show);
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const delay = Number(el.dataset.delay) || 0;
      el.style.transitionDelay = `${delay}ms`;
      show(el);
      io.unobserve(el);
      // Clear the delay afterwards, or hover effects on cards would wait for it too.
      setTimeout(() => (el.style.transitionDelay = ''), delay + 900);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.1 });
  items.forEach((el) => io.observe(el));
}

/** A large, very soft light that follows the pointer (mouse and trackpad only). */
export function initCursorGlow(el, reduced) {
  if (!el) return;
  if (reduced || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    el.remove();
    return;
  }
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let targetX = x;
  let targetY = y;
  let raf = 0;
  const tick = () => {
    x += (targetX - x) * 0.12;
    y += (targetY - y) * 0.12;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    raf = Math.abs(targetX - x) + Math.abs(targetY - y) > 0.5 ? requestAnimationFrame(tick) : 0;
  };
  window.addEventListener('pointermove', (e) => {
    targetX = e.clientX;
    targetY = e.clientY;
    el.classList.add('is-on');
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => el.classList.remove('is-on'));
}

/** Cards get a soft light where the pointer is (CSS reads --mx and --my). */
export function initCardLights() {
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('pointermove', (e) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - box.left}px`);
      card.style.setProperty('--my', `${e.clientY - box.top}px`);
    });
  }
}

/** The floating Download pill: shows once you scroll past the hero, hides near the downloads and the footer. */
export function initDownloadPill() {
  const pill = document.getElementById('dl-pill');
  const hero = document.getElementById('top');
  const hideNear = [document.getElementById('download'), document.querySelector('.footer')].filter(Boolean);
  if (!pill || !hero) return;
  let pastHero = false;
  const near = new Set();
  const update = () => pill.classList.toggle('is-shown', pastHero && near.size === 0);

  new IntersectionObserver(([entry]) => {
    pastHero = entry.intersectionRatio < 0.5;
    update();
  }, { threshold: [0, 0.5, 1] }).observe(hero);

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) near.add(entry.target);
      else near.delete(entry.target);
    }
    update();
  });
  hideNear.forEach((el) => io.observe(el));
}

/** While the agent cards are on screen, light them one after another, like a shipment moving down the desk. */
export function initAgentRun(reduced) {
  const list = document.getElementById('agents');
  const cards = list ? [...list.querySelectorAll('.agent')] : [];
  if (!cards.length || reduced) return;
  let index = -1;
  let timer = 0;
  const step = () => {
    cards.forEach((card) => card.classList.remove('is-active'));
    index = (index + 1) % (cards.length + 2); // two quiet beats before it starts again
    if (index < cards.length) cards[index].classList.add('is-active');
  };
  new IntersectionObserver(([entry]) => {
    clearInterval(timer);
    if (entry.isIntersecting) timer = setInterval(step, 1100);
  }, { threshold: 0.25 }).observe(list);
}
