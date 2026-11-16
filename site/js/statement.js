// The statement card in the "EU deadline" section. When it scrolls into view the agents fill it in:
// each field shows a reading bar, then its value; the status goes Agents reading, Checking origin,
// Ready to sign. Then it switches destination (EU, then US) and runs again, to show one upload
// becoming a different statement per destination. The EU values are the ones the agents wrote for the
// fictional SAMPLE shipment KG/26-27/041 in the live demo's recorded run; the US card shows the same
// stones as if the parcel went to a (fictional) US buyer instead.

export const VARIANTS = {
  eu: {
    title: 'Due Diligence Statement on Diamond Origin',
    basis: 'Council Regulation (EU) 833/2014, Article 3p',
    rows: [
      ['Importer', 'Lumen Diamant BV (SAMPLE)'],
      ['Commodity code', 'CN 7102 39 00'],
      ['Stones of 0.50 ct and up', '5 / 4.64 ct'],
      ['Country of mining', 'Botswana, Namibia'],
      ['KP certificate', 'AE-SAMPLE-0001234', 'mono'],
      ['Russian origin', 'None found'],
    ],
  },
  us: {
    title: 'US CBP self-certification',
    basis: 'For entry into the United States',
    rows: [
      ['Importer of record', 'Sample Jewelers Inc'],
      ['HTS code', '7102.39.00'],
      ['Stones of 0.50 ct and up', '5 / 4.64 ct'],
      ['Country of mining', 'Botswana, Namibia'],
      ['KP certificate', 'AE-SAMPLE-0001234', 'mono'],
      ['Russian origin', 'None found'],
    ],
  },
};

const FOOT_DONE = 'Every value links to the page it came from.';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function initStatement(reduced) {
  const card = document.getElementById('statement');
  if (!card) return;
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const title = field('title');
  const basis = field('basis');
  const status = field('status');
  const rows = field('rows');
  const bar = field('bar');
  const foot = field('foot');
  const tabs = [...card.querySelectorAll('.statement__tab')];

  let run = 0; // goes up on every new run, so an older run notices and stops
  let auto = !reduced; // switch destinations by itself until someone picks a tab
  let visible = false;
  let current = 'eu';
  let started = false;

  function selectTab(name) {
    for (const tab of tabs) {
      const on = tab.dataset.variant === name;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-pressed', String(on));
    }
  }

  function setStatus(kind, text) {
    status.className = `chip chip--${kind}`;
    status.textContent = text;
  }

  /** Writes the rows, either filled in or waiting to be read. */
  function render(name, filled) {
    const variant = VARIANTS[name];
    title.textContent = variant.title;
    basis.textContent = variant.basis;
    rows.replaceChildren(...variant.rows.map(([label, value, style]) => {
      const row = document.createElement('div');
      row.className = `statement__row ${filled ? 'is-in' : 'is-pending'}`;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (style === 'mono') dd.className = 'mono';
      row.append(dt, dd);
      return row;
    }));
    bar.style.setProperty('--fill', filled ? '100%' : '0%');
    if (filled) {
      setStatus('ok', 'Ready to sign');
      foot.textContent = FOOT_DONE;
    }
  }

  async function play(name) {
    const id = ++run;
    const stillMine = () => id === run;
    current = name;
    selectTab(name);
    render(name, false);
    setStatus('info', 'Agents reading');
    foot.textContent = 'Reading the shipment papers';
    await wait(500);
    const list = [...rows.children];
    for (let i = 0; i < list.length; i++) {
      if (!stillMine()) return;
      list[i].classList.add('is-reading');
      await wait(430);
      if (!stillMine()) return;
      list[i].classList.remove('is-reading', 'is-pending');
      list[i].classList.add('is-in');
      bar.style.setProperty('--fill', `${Math.round(((i + 1) / list.length) * 100)}%`);
    }
    setStatus('warn', 'Checking origin');
    foot.textContent = 'Checking origin and screening parties';
    await wait(950);
    if (!stillMine()) return;
    setStatus('ok', 'Ready to sign');
    foot.textContent = FOOT_DONE;
    await wait(4200);
    if (stillMine() && auto && visible) play(name === 'eu' ? 'us' : 'eu');
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      auto = false;
      if (reduced) {
        run++;
        selectTab(tab.dataset.variant);
        render(tab.dataset.variant, true);
      } else {
        play(tab.dataset.variant);
      }
    });
  }

  if (reduced) return; // the card already shows the finished EU statement
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && (!started || auto)) {
      started = true;
      play(current);
    } else if (!visible) {
      run++; // stop quietly while it is off screen
      render(current, true);
    }
  }, { threshold: 0.35 }).observe(card);
}
