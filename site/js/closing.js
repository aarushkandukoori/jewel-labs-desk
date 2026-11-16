// The particle stone behind the closing card. It is only made when the card comes near, so the page
// starts light. It appears as a rough crystal and is polished once the card is in view: papers in,
// finished pack out.
import { createDiamond } from './diamond.js';

export function initClosingStone({ reduced, small }) {
  const host = document.getElementById('cta-stone');
  if (!host || !('IntersectionObserver' in window)) return;

  let stone = null; // a promise of the stone, or of null when nothing can be drawn
  const make = () => {
    if (!stone) {
      stone = createDiamond(host, {
        count: small ? 700 : 1400,
        morph: reduced ? 1 : 0,
        spin: 0.0002,
        tilt: 0.5,
        distance: 5.4,
        reduced,
      });
    }
    return stone;
  };

  new IntersectionObserver((entries, io) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    make();
  }, { rootMargin: '500px 0px' }).observe(host);

  if (reduced) return;
  new IntersectionObserver(async (entries, io) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    const made = await make();
    if (made) setTimeout(() => made.setMorph(1), 500);
  }, { threshold: 0.6 }).observe(host);
}
