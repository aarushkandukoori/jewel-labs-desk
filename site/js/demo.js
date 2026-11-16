// The live demo: the real app UI (the build copies it to app/) inside a macOS-style window frame.
// It replays a recorded run of the desktop agents on the fictional SAMPLE house (app/demo/sample-run.json).
// The app only loads when you scroll close to it, so the run starts about when you get there. It is drawn
// at a desktop size (1280 x 800) and scaled down to fit the frame, so it looks like the app on a laptop.

const APP_WIDTH = 1280;

export function initDemo(reduced = false) {
  const screen = document.getElementById('demo-screen');
  const frame = document.getElementById('demo-frame');
  const wait = document.getElementById('demo-wait');
  const replay = document.getElementById('demo-replay');
  const skip = document.getElementById('demo-skip');
  if (!screen || !frame) return;

  const fit = () => screen.style.setProperty('--scale', String(screen.clientWidth / APP_WIDTH));
  fit();
  new ResizeObserver(fit).observe(screen);

  // Opens the app in the frame.
  //   play = true: autoplay=1 skips the app's welcome screen and plays the recorded run from the start.
  //   play = false: the app opens with the run already finished.
  // Every load gets a new number in the address, because changing only the part after # would not
  // load the app again.
  let loads = 0;
  let playing = false;
  const open = (play, view) => {
    loads += 1;
    playing = play;
    frame.classList.remove('is-loaded');
    if (wait) wait.hidden = false;
    frame.src = `${frame.dataset.src}${play ? '&autoplay=1' : ''}&load=${loads}#/${view}`;
  };

  frame.addEventListener('load', () => {
    if (!frame.getAttribute('src')) return; // the empty frame's first load does not count
    frame.classList.add('is-loaded');
    if (wait) wait.hidden = true;
    if (playing) showReading(frame, reduced);
  });

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      if (!loads) open(true, 'home');
      io.disconnect();
    }, { rootMargin: '300px 0px' });
    io.observe(screen);
  } else {
    open(true, 'home');
  }

  // Replay starts the recorded run again from the beginning, on Home.
  if (replay) replay.addEventListener('click', () => open(true, 'home'));
  // Skip jumps to the end of the run: the papers the agents built, ready to sign.
  if (skip) skip.addEventListener('click', () => open(false, 'papers'));
}

/**
 * The app's Home view shows "Agents reading" (the page with the agents' boxes and cursors) below the fold
 * of the 800 px frame. When the agents start reading, scroll the app's page down to it, once, unless the
 * visitor has already scrolled or opened another view. If the app ever changes, this simply does nothing.
 */
function showReading(frame, reduced) {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    try {
      const reader = frame.contentDocument.querySelector('.reader');
      const page = reader && reader.closest('.page');
      if (page && frame.contentWindow.location.hash === '#/home' && page.scrollTop === 0) {
        const top = reader.getBoundingClientRect().top - page.getBoundingClientRect().top - 12;
        page.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
      }
      if (page || tries >= 120) clearInterval(timer); // found it, or gave up after 30 seconds (slow connections)
    } catch {
      clearInterval(timer); // the frame cannot be read (another origin): leave it as it is
    }
  }, 250);
}
