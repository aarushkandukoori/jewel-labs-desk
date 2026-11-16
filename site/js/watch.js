// "Watch it work": the walkthrough video.
// The build sets data-video="ready" on the section once site/media/demo.mp4 exists. Until then the
// stylesheet hides the whole section and the hero's "Watch it work" link goes to the live demo.
// If the video file still fails to load, the section hides itself again.

export function initWatch() {
  const section = document.getElementById('watch');
  const video = document.getElementById('watch-video');
  const play = document.getElementById('watch-play');
  const heroLink = document.getElementById('watch-link');
  if (!section || !video || section.dataset.video !== 'ready') return; // the hero link already points to #demo

  if (heroLink) heroLink.href = '#watch';
  video.addEventListener('error', () => {
    section.hidden = true;
    if (heroLink) heroLink.href = '#demo';
  });

  // Nothing is fetched until the section comes near: browsers download a poster as soon as it is set.
  const attach = () => {
    if (video.getAttribute('src')) return;
    if (section.dataset.videoPoster) video.poster = section.dataset.videoPoster;
    video.src = section.dataset.videoSrc;
  };
  // Then fetch only the start of the file (its length and first frame).
  new IntersectionObserver((entries, io) => {
    if (!entries[0].isIntersecting) return;
    video.preload = 'metadata';
    attach();
    io.disconnect();
  }, { rootMargin: '800px 0px' }).observe(section);

  if (play) {
    play.addEventListener('click', () => {
      attach();
      video.controls = true;
      section.classList.add('is-playing');
      video.play().catch(() => {
        // Autoplay rules or a missing file: the controls are there, and the error handler hides a broken video.
      });
    });
  }
}
