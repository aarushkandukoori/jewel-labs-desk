// The sample workspace panel in the team section. Members appear one by one, the invite code
// types itself, and the autopilot line counts down to the next mailbox check (every 5 minutes,
// the real autopilot interval).

/** Time left until the next 5-minute mark of the clock, as "4:59". `justChecked` is true for 3 seconds after a mark. */
export function nextCheck(nowMs, everyMinutes = 5) {
  const period = everyMinutes * 60 * 1000;
  const sinceLast = nowMs % period;
  const secondsLeft = Math.ceil((period - sinceLast) / 1000);
  return {
    label: `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`,
    justChecked: sinceLast < 3000,
  };
}

export function initTeam(reduced) {
  const panel = document.getElementById('workspace');
  const code = document.getElementById('invite-code');
  const next = document.getElementById('autopilot-next');

  if (next) {
    const tick = () => {
      const { label, justChecked } = nextCheck(Date.now());
      next.textContent = justChecked ? 'Checking the mailbox now' : `Next mailbox check in ${label}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  if (!panel || reduced || !('IntersectionObserver' in window)) return;
  const members = [...panel.querySelectorAll('.workspace__members li')];
  panel.classList.add('is-waiting');
  const io = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    io.disconnect();
    members.forEach((li, i) => (li.style.transitionDelay = `${250 + i * 140}ms`));
    panel.classList.remove('is-waiting');
    if (code) setTimeout(() => typeCode(code), 250 + members.length * 140);
  }, { threshold: 0.35 });
  io.observe(panel);
}

/** Types the invite code in, one character at a time, with a caret while typing. */
function typeCode(el) {
  const text = el.textContent;
  let shown = 0;
  el.textContent = '';
  el.classList.add('is-typing');
  const timer = setInterval(() => {
    shown++;
    el.textContent = text.slice(0, shown);
    if (shown >= text.length) {
      clearInterval(timer);
      setTimeout(() => el.classList.remove('is-typing'), 900);
    }
  }, 85);
}
