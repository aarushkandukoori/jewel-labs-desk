// The live demo: the real app UI (the build copies it to app/) inside a macOS-style window frame.
// The app only loads when you scroll near it. It is drawn at a desktop size (1280 x 800) and
// scaled down to fit the frame, so it looks exactly like the app on a laptop screen.

const APP_WIDTH = 1280;

export function initDemo() {
  const screen = document.getElementById('demo-screen');
  const frame = document.getElementById('demo-frame');
  const wait = document.getElementById('demo-wait');
  const replay = document.getElementById('demo-replay');
  if (!screen || !frame) return;

  const fit = () => screen.style.setProperty('--scale', String(screen.clientWidth / APP_WIDTH));
  fit();
  new ResizeObserver(fit).observe(screen);

  frame.addEventListener('load', () => {
    if (!frame.getAttribute('src')) return; // the empty frame's first load does not count
    frame.classList.add('is-loaded');
    if (wait) wait.hidden = true;
  });

  const load = () => {
    if (!frame.getAttribute('src')) frame.src = frame.dataset.src;
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      load();
      io.disconnect();
    }, { rootMargin: '700px 0px' });
    io.observe(screen);
  } else {
    load();
  }

  // Replay starts the recorded run again from the beginning.
  if (replay) {
    replay.addEventListener('click', () => {
      if (!frame.getAttribute('src')) return load();
      frame.classList.remove('is-loaded');
      if (wait) wait.hidden = false;
      try {
        frame.contentWindow.location.reload();
      } catch {
        frame.src = frame.dataset.src;
      }
    });
  }
}
