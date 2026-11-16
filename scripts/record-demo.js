// Records a short demo video of the real desktop app, start to finish, with the real AI:
// welcome -> try the sample -> the agents read the papers -> their questions -> "Build the packing list
// from the chat" -> the pack is ready -> sign it -> a stone's history -> the Jewel Labs desk.
//
//   node scripts/record-demo.js          -> test/.tmp/demo/demo-raw.webm (1440x900, about 90 seconds)
//
// It needs an OpenAI key in a file (JL_DEV_OPENAI_KEY_FILE, default ~/.config/jewel-labs/openai_key); the
// app reads it itself in development and the key never appears in the video. A pointer is drawn on the
// page so viewers can follow the clicks. Every run starts from an empty, throwaway data folder.
//
// The frames come from Chromium's own screencast of the page (Playwright's recordVideo option stops
// Electron 45 at launch), and ffmpeg (on the PATH) joins them into the video at their real timing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, closeApp, waitFor, sleep, tempDir, bridge, setWindowSize, TMP, DEFAULT_KEY_FILE } from '../test/e2e/helpers.mjs';

const OUT_DIR = path.join(TMP, 'demo');
const OUT_FILE = path.join(OUT_DIR, 'demo-raw.webm');
const SIZE = { width: 1440, height: 900 };
const KEY_FILE = process.env.JL_DEV_OPENAI_KEY_FILE || DEFAULT_KEY_FILE;

if (!fs.existsSync(KEY_FILE)) {
  console.error(`No OpenAI key file at ${KEY_FILE}. Set JL_DEV_OPENAI_KEY_FILE.`);
  process.exit(1);
}

const frameDir = tempDir('jl-demo-frames-');
const userData = tempDir('jl-demo-data-');
const { app, page } = await launchApp({ userData, env: { JL_DEV_OPENAI_KEY_FILE: KEY_FILE } });

// ---------- recording: every frame the page paints, with its time ----------

async function startRecording() {
  const cdp = await page.context().newCDPSession(page);
  const frames = []; // { file, at } in seconds
  let cut = 0; // seconds left out of the video so far (time spent waiting for the agents, off camera)
  let pausedAt = null;
  const options = { format: 'jpeg', quality: 92, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 };
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (pausedAt !== null) return;
    const file = path.join(frameDir, `f${String(frames.length + 1).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, at: metadata.timestamp - cut });
  });
  await cdp.send('Page.startScreencast', options);
  return {
    // Waiting for the agents off camera: the video jumps from before the pause to after it.
    async pause() {
      pausedAt = Date.now() / 1000;
    },
    async resume() {
      if (pausedAt === null) return;
      cut += Date.now() / 1000 - pausedAt;
      pausedAt = null;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.send('Page.startScreencast', options); // sends the current picture straight away
    },
    stop,
  };

  async function stop() {
    await cdp.send('Page.stopScreencast').catch(() => {});
    const end = Date.now() / 1000 - cut;
    // Each frame stays on screen until the next one arrived; ffmpeg then makes a steady 30 frames a second.
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? end) - f.at).toFixed(3)}`);
    list.push(`file '${frames[frames.length - 1].file}'`);
    const listFile = path.join(frameDir, 'frames.txt');
    fs.writeFileSync(listFile, list.join('\n'));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `fps=30,scale=${SIZE.width}:${SIZE.height},format=yuv420p`,
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', OUT_FILE]);
    return frames.length;
  }
}

// ---------- a visible pointer, moved smoothly before each click ----------

async function showPointer() {
  await page.evaluate(() => {
    if (document.getElementById('demo-pointer')) return;
    const el = document.createElement('div');
    el.id = 'demo-pointer';
    el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.5 12.6 Z" fill="#ffffff" stroke="#000000" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(el.style, {
      position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(720px, 600px)', transition: 'transform 650ms cubic-bezier(0.22, 1, 0.36, 1)',
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))',
    });
    document.body.append(el);
  });
}

async function pointAt(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return;
  const x = Math.round(box.x + Math.min(box.width / 2, 60));
  const y = Math.round(box.y + box.height / 2);
  await showPointer();
  await page.evaluate(([px, py]) => {
    document.getElementById('demo-pointer').style.transform = `translate(${px}px, ${py}px)`;
  }, [x, y]);
  await sleep(750);
}

async function click(locator, pause = 500) {
  await pointAt(locator);
  await locator.click();
  await sleep(pause);
}

async function type(locator, text) {
  await click(locator, 150);
  await locator.fill(''); // a field may come pre-filled (the signer's name)
  await locator.pressSequentially(text, { delay: 38 });
  await sleep(350);
}

/** Scrolls the page (the app scrolls inside its main area) so the element sits near the top, smoothly. */
async function scrollTo(locator, offset = 120) {
  await locator.evaluate((el, off) => {
    const scroller = el.closest('main.page, .desk-content');
    if (!scroller) return el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - off;
    scroller.scrollTo({ top, behavior: 'smooth' });
    return undefined;
  }, offset);
  await sleep(900);
}

async function scrollBy(dy, steps = 6, every = 220) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((d) => document.querySelector('main.page, .desk-content')?.scrollBy({ top: d, behavior: 'smooth' }), Math.round(dy / steps));
    await sleep(every);
  }
}

const agentsIdle = () => app.evaluate(async () => {
  const { services } = await globalThis.__jlTest.state.ready();
  await services.idle();
  return true;
});

// ---------- the story ----------

const started = Date.now();
const mark = (what) => console.log(`${String(Math.round((Date.now() - started) / 1000)).padStart(3)} s  ${what}`);
let recording = null;
try {
  await setWindowSize(app, page, SIZE);
  await bridge(page, 'settings.set', { userName: 'Ravi Mehta (SAMPLE)' });
  await waitFor(() => page.getByRole('button', { name: /Try the sample shipment/ }).isVisible(), 20000, 'the welcome screen');
  await showPointer();
  recording = await startRecording();
  mark('welcome');
  await sleep(3000);

  await click(page.getByRole('button', { name: /Try the sample shipment/ }), 1200);
  mark('sample loaded');
  await waitFor(async () => (await page.locator('.reader .fbox').count()) > 0, 120000, 'the agents to start reading');
  await scrollTo(page.locator('.section[aria-label="2. Documents"]'), 8);
  await sleep(1200);
  await scrollTo(page.locator('.reader'), 6);
  mark('agents reading');
  // Let the cursors play while the agents read: about 15 seconds of it, then wait for them off camera.
  await sleep(15000);
  await scrollTo(page.locator('.agent-strip'), 40);
  await sleep(1500);
  await recording.pause();
  await agentsIdle();
  await recording.resume();
  mark('reading done');
  await sleep(800);

  await scrollTo(page.locator('.needs'), 40);
  await sleep(600);
  await pointAt(page.locator('.needs-row', { hasText: /Packing list for KG\/26-27\/041/ }));
  await sleep(1300);
  await pointAt(page.locator('.q-row', { hasText: /Report 7391020002 weighs/ }));
  mark('questions');
  await sleep(1800);

  await scrollTo(page.locator('#tell'), 60);
  await type(page.locator('input[aria-label="Tell the agents"]'), 'Build the packing list from the chat');
  await click(page.locator('.chat-input button[type="submit"]'), 300);
  await waitFor(() => page.locator('.msg.agents .msg-text', { hasText: /packing list/i }).isVisible(), 120000, 'the agents to reply');
  await sleep(800);
  await scrollTo(page.locator('.msg.agents').last(), 40);
  mark('packing list drafted');
  await sleep(2600);

  // The draft counts as the packing list once the clerk has checked it against the parcel.
  const draft = page.locator('.q-row', { hasText: /drafted the packing list for KG\/26-27\/041/ });
  await scrollTo(draft, 220);
  await sleep(1000);
  await click(draft.getByRole('button', { name: 'Yes, use it as our packing list' }), 1200);
  await recording.pause();
  await agentsIdle();
  await recording.resume();

  // Which weight is right: the lab report's 0.70 ct.
  const question = page.locator('.q-row', { hasText: /Report 7391020002 weighs/ });
  await scrollTo(question, 220);
  await sleep(800);
  await click(question.getByRole('button', { name: '0.70 ct', exact: true }), 1200);
  await recording.pause();
  await agentsIdle();
  await recording.resume();
  // The invoice and the packing list still print 0.71 ct: the clerk ships with that difference.
  const accept = page.locator('.q-row', { hasText: /ship with this difference/ });
  await scrollTo(accept, 220);
  await sleep(1000);
  await click(accept.getByRole('button', { name: 'Ship with this difference' }), 1200);
  await recording.pause();
  await agentsIdle();
  await recording.resume();
  // The real AI sometimes reads a party differently on one paper and the agents ask to confirm it:
  // answer such a question with its first option, on camera, as the clerk would.
  for (let round = 0; round < 3; round++) {
    const shipment = (await bridge(page, 'shipments.list')).find((x) => x.ref === 'KG/26-27/041');
    const open = (await bridge(page, 'questions.list')).filter((q) => q.status === 'open' && q.shipmentId === shipment?.id && q.options?.length);
    if (!open.length) break;
    const row = page.locator('.q-row', { hasText: open[0].text.slice(0, 40) });
    await scrollTo(row, 220);
    await sleep(1200);
    await click(row.getByRole('button', { name: open[0].options[0], exact: true }), 800);
    await recording.pause();
    await agentsIdle();
    await recording.resume();
  }
  await recording.pause();
  await waitFor(async () => (await page.locator('.paper-row', { hasText: /ready to sign/i }).count()) > 0, 120000, 'the pack to be ready');
  await agentsIdle();
  await recording.resume();
  await scrollTo(page.locator('.section[aria-label="4. Back from Jewel Labs"]'), 60);
  mark('ready to sign');
  await sleep(2200);

  await click(page.locator('nav.tabs button', { hasText: 'Papers' }), 400);
  const pack = page.locator('.paper-item', { hasText: 'JL-EXP' }).first();
  await click(pack, 1600);
  await page.locator('.preview .pages').evaluate((el) => el.scrollBy({ top: 520, behavior: 'smooth' }));
  await sleep(1600);
  mark('pack preview');
  await click(page.locator('.preview-bar').getByRole('button', { name: 'Sign' }), 500);
  const dialog = page.getByRole('dialog');
  await type(dialog.getByLabel('Name of the person signing'), 'Ravi Mehta (SAMPLE)');
  const pad = await dialog.locator('.sig-pad canvas').boundingBox();
  await pointAt(dialog.locator('.sig-pad canvas'));
  await page.mouse.move(pad.x + 40, pad.y + pad.height * 0.62);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    const x = pad.x + 40 + i * 10;
    const y = pad.y + pad.height * (0.6 - 0.22 * Math.sin(i / 2.6) - (i > 22 ? (i - 22) * 0.02 : 0));
    await page.mouse.move(x, y, { steps: 2 });
    await page.evaluate(([px, py]) => { document.getElementById('demo-pointer').style.transform = `translate(${px}px, ${py}px)`; }, [Math.round(x), Math.round(y)]);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(300);
  await click(dialog.locator('.check'), 400);
  await click(dialog.getByRole('button', { name: 'Sign the paper' }), 1200);
  await waitFor(() => dialog.getByRole('button', { name: /Download instead/ }).isVisible(), 20000, 'the send dialog');
  mark('signed');
  await sleep(1200);
  await click(dialog.getByRole('button', { name: 'Cancel' }), 1800);

  await click(page.locator('nav.tabs button', { hasText: 'Stones' }), 500);
  await type(page.locator('.stone-search input'), '7391020001');
  await page.locator('.stone-search input').press('Enter');
  await waitFor(async () => (await page.locator('.timeline .tl-item.done').count()) >= 5, 20000, 'the stone history');
  mark('stone history');
  await sleep(1600);
  await scrollBy(900, 10, 230);
  await sleep(1400);

  await click(page.locator('.topbar').getByRole('button', { name: 'Desk' }), 900);
  mark('desk');
  await sleep(2200);
  await scrollBy(1300, 10, 200);
  await sleep(2400);
  mark('end');
} finally {
  if (recording) {
    const frames = await recording.stop();
    console.log(`Video: ${path.relative(process.cwd(), OUT_FILE)}, ${frames} frames, ${Math.round(fs.statSync(OUT_FILE).size / 1024)} KB`);
  }
  await closeApp(app);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
