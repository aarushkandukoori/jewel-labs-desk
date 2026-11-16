// End-to-end flows on the real desktop app, driven through its screens with Playwright.
//
//   node test/e2e/flow.spec.mjs        both flows
//   node test/e2e/flow.spec.mjs A      flow A only: local workspace, the SAMPLE shipment, the real AI
//   node test/e2e/flow.spec.mjs B      flow B only: two people in one shared house (Supabase)
//
// Flow A needs an OpenAI key in a file: JL_DEV_OPENAI_KEY_FILE (default ~/.config/jewel-labs/openai_key).
// The app reads it itself (development only) and the test never prints it.
// Flow B creates two TEST accounts (jl-test-...@example.com, random passwords kept in memory only).
//
// Every run uses fresh throwaway data folders. Screenshots and results go to test/.tmp/e2e-flow/.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, TMP, DEFAULT_KEY_FILE, sleep, waitFor, tempDir, launchApp, closeApp, bridge, errorLines,
} from './helpers.mjs';

const OUT = path.join(TMP, 'e2e-flow');
const KEY_FILE = process.env.JL_DEV_OPENAI_KEY_FILE || DEFAULT_KEY_FILE;
const which = (process.argv[2] || 'AB').toUpperCase();
const results = [];
const cleanups = [];
let failed = false;

fs.mkdirSync(OUT, { recursive: true });

// ---------- recording each step ----------

async function step(flow, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ flow, step: name, ok: true, ms: Date.now() - started, detail: detail ?? null });
    console.log(`ok    ${flow} ${name}${detail ? `: ${detail}` : ''}`);
    return true;
  } catch (error) {
    failed = true;
    results.push({ flow, step: name, ok: false, ms: Date.now() - started, error: error.message });
    console.log(`FAIL  ${flow} ${name}: ${error.message}`);
    return false;
  }
}

let shotFlow = 'A'; // screenshots are named A-01-welcome.png, B-01-b1-house.png ...
let shotNumber = 0;
async function shot(page, name) {
  shotNumber += 1;
  const file = path.join(OUT, `${shotFlow}-${String(shotNumber).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  return path.relative(ROOT, file);
}

function watchPage(page, label, problems) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`${label} console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`${label} page error: ${error.message}`));
}

/** Waits until the agents have nothing left to do (every run, background step and live event). */
function agentsIdle(app, timeoutMs = 240000) {
  return app.evaluate(async (_electron, ms) => {
    const { services } = await globalThis.__jlTest.state.ready();
    await Promise.race([services.idle(), new Promise((_r, reject) => setTimeout(() => reject(new Error('the agents are still busy')), ms))]);
    return true;
  }, timeoutMs);
}

/** True when some pixel of the canvas is not white or transparent (the page really drew). */
function canvasHasInk(locator) {
  return locator.evaluate((canvas) => {
    if (!canvas.width || !canvas.height) return false;
    const g = canvas.getContext('2d');
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4 * 97) if (data[i + 3] > 0 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) return true;
    return false;
  });
}

async function cursorPositions(page) {
  return page.locator('.reader .cursor').evaluateAll((els) => els.map((el) => `${el.style.left},${el.style.top}`));
}

/** Files under a folder, read as text (for the "the key never leaks" check). */
function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (entry.isFile() && fs.statSync(full).size < 20 * 1024 * 1024) out.push(full);
  }
  return out;
}

// ---------- Flow A: local workspace, the SAMPLE shipment, the real AI ----------

async function flowA() {
  const F = 'A';
  shotFlow = F;
  shotNumber = 0;
  if (!fs.existsSync(KEY_FILE)) {
    results.push({ flow: F, step: 'setup', ok: false, error: `No OpenAI key file at ${KEY_FILE}` });
    failed = true;
    return;
  }
  const userData = tempDir('jl-e2e-a-');
  const saveDir = tempDir('jl-e2e-save-');
  cleanups.push(userData, saveDir);
  const problems = [];
  const { app, page, lines } = await launchApp({
    userData,
    env: { JL_DEV_OPENAI_KEY_FILE: KEY_FILE, JL_E2E_SAVE_DIR: saveDir },
    viewport: { width: 1440, height: 900 },
  });
  watchPage(page, 'A', problems);
  let paperRef = null;
  let savedPdf = null; // { file, pages } of the signed pack saved to disk

  try {
    await step(F, 'welcome screen', async () => {
      await waitFor(() => page.getByRole('button', { name: /Try the sample shipment/ }).isVisible(), 20000, 'the welcome screen');
      const info = await bridge(page, 'app.info');
      assert.equal(info.ai.mode, 'direct', `the AI should read with the developer key, got ${info.ai.mode}`);
      return `${await shot(page, 'welcome')}, AI ${info.ai.mode} ${info.ai.model}`;
    });

    // The person signing later, so papers and messages carry a SAMPLE name, not the computer's user name.
    await bridge(page, 'settings.set', { userName: 'Ravi Mehta (SAMPLE)' });

    await step(F, 'try the sample shipment', async () => {
      await page.getByRole('button', { name: /Try the sample shipment/ }).click();
      await waitFor(() => page.locator('.portal-head h1').isVisible(), 20000, 'the house home');
      const name = await page.locator('.portal-head h1').textContent();
      assert.match(name, /Kavya Gems/);
      return `home of ${name}`;
    });

    await step(F, 'agents reading: page, field boxes, moving cursors', async () => {
      const reader = page.locator('.reader');
      await waitFor(async () => (await page.locator('.reader .fbox').count()) > 0, 120000, 'field boxes on the page');
      await reader.scrollIntoViewIfNeeded();
      assert.ok(await canvasHasInk(page.locator('.reader canvas').first()).catch(() => true), 'the page did not draw');
      const first = await cursorPositions(page);
      await sleep(1200);
      const second = await cursorPositions(page);
      const moved = first.filter((p, i) => p !== second[i]).length;
      const shots = [await shot(page, 'agents-reading-1')];
      await sleep(2500);
      await reader.scrollIntoViewIfNeeded();
      const third = await cursorPositions(page);
      shots.push(await shot(page, 'agents-reading-2'));
      const movedLater = second.filter((p, i) => p !== third[i]).length;
      assert.ok(first.length >= 4, `expected the agent cursors, found ${first.length}`);
      assert.ok(moved + movedLater > 0, 'no agent cursor moved');
      const file = await page.locator('.reader-head .file').textContent();
      return `${await page.locator('.reader .fbox').count()} boxes on ${file}, cursors moved ${moved + movedLater} times; ${shots.join(', ')}`;
    });

    await step(F, 'shipments appear', async () => {
      await agentsIdle(app);
      const shipments = await bridge(page, 'shipments.list');
      assert.ok(shipments.some((s) => s.ref === 'KG/26-27/041'), `shipments: ${shipments.map((s) => s.ref).join(', ')}`);
      return shipments.map((s) => `${s.ref} (${s.status})`).join(', ');
    });

    await step(F, 'questions: packing list missing, carat mismatch', async () => {
      const needs = page.locator('.needs');
      await waitFor(() => needs.getByText(/Packing list for KG\/26-27\/041 is not on file/).isVisible(), 30000, 'the missing packing list');
      await waitFor(() => page.locator('.q-row', { hasText: /0\.70 ct/ }).isVisible(), 30000, 'the carat question');
      await page.locator('.q-row', { hasText: /0\.70 ct/ }).scrollIntoViewIfNeeded();
      return shot(page, 'questions');
    });

    await step(F, 'tell the agents: build the packing list from the chat', async () => {
      const input = page.locator('input[aria-label="Tell the agents"]');
      await input.scrollIntoViewIfNeeded();
      await input.fill('Build the packing list from the chat');
      await page.locator('.chat-input button[type="submit"]').click();
      const reply = page.locator('.msg.agents .msg-text', { hasText: /packing list/i });
      await waitFor(() => reply.isVisible(), 120000, 'the agents to reply');
      const text = await reply.last().textContent();
      assert.match(text, /Drafted a packing list for KG\/26-27\/041/);
      await agentsIdle(app);
      await page.locator('.msg.agents').last().scrollIntoViewIfNeeded();
      return `${text.trim()} ${await shot(page, 'packing-list-drafted')}`;
    });

    await step(F, 'answer the carat question', async () => {
      const row = page.locator('.q-row', { hasText: /0\.70 ct/ });
      await row.scrollIntoViewIfNeeded();
      await row.locator('input.ans').fill('0.70 ct, as on the lab report');
      await row.getByRole('button', { name: 'Answer' }).click();
      await waitFor(async () => (await page.locator('.q-row', { hasText: /0\.70 ct/ }).count()) === 0, 30000, 'the question to close');
      await agentsIdle(app);
      // The real AI sometimes reads a party differently on one paper; the Review agent then asks to confirm.
      // Answer such questions about this shipment with their first option, as a clerk would, and say so.
      const also = [];
      for (let round = 0; round < 4; round++) {
        const shipment = (await bridge(page, 'shipments.list')).find((x) => x.ref === 'KG/26-27/041');
        const open = (await bridge(page, 'questions.list')).filter((q) => q.status === 'open' && q.shipmentId === shipment?.id && q.options?.length);
        if (!open.length) break;
        const q = open[0];
        const qRow = page.locator('.q-row', { hasText: q.text.slice(0, 40) });
        await qRow.scrollIntoViewIfNeeded();
        await qRow.getByRole('button', { name: q.options[0], exact: true }).click();
        also.push(`"${q.text}" -> ${q.options[0]}`);
        await waitFor(async () => (await bridge(page, 'questions.list')).find((x) => x.id === q.id)?.status !== 'open', 30000, 'the answer to land');
        await agentsIdle(app);
      }
      return also.length ? `answered; also confirmed ${also.join('; ')}` : 'answered';
    });

    await step(F, 'papers ready to sign', async () => {
      const ready = page.locator('.paper-row', { hasText: /ready to sign/i });
      await waitFor(async () => (await ready.count()) > 0, 120000, 'a paper ready to sign');
      await ready.first().scrollIntoViewIfNeeded();
      const papers = await bridge(page, 'papers.list');
      const pack = papers.find((p) => p.kind === 'export_pack' && p.status === 'ready_to_sign');
      assert.ok(pack, `papers: ${papers.map((p) => `${p.ref} ${p.status}`).join(', ')}`);
      paperRef = pack.ref;
      return `${papers.filter((p) => p.status === 'ready_to_sign').map((p) => p.ref).join(', ')}; ${await shot(page, 'ready-to-sign')}`;
    });

    await step(F, 'open the pack preview', async () => {
      await page.locator('nav.tabs button', { hasText: 'Papers' }).click();
      await page.locator('.paper-item', { hasText: paperRef }).click();
      await waitFor(async () => (await page.locator('.preview-bar .title').textContent()).includes(paperRef), 10000, `the preview of ${paperRef}`);
      const firstPage = page.locator('.preview .pdf-page canvas').first();
      await waitFor(() => canvasHasInk(firstPage), 30000, 'the first page of the pack');
      const pages = await waitFor(async () => page.locator('.preview .pdf-page').count(), 10000, 'the pages of the pack');
      return `${paperRef}: ${pages} pages drawn; ${await shot(page, 'pack-preview')}`;
    });

    await step(F, 'sign: typed name, drawn signature, authorised', async () => {
      await page.locator('.preview-bar').getByRole('button', { name: 'Sign' }).click();
      const dialog = page.getByRole('dialog');
      await waitFor(() => dialog.isVisible(), 10000, 'the sign dialog');
      await dialog.getByLabel('Name of the person signing').fill('Ravi Mehta (SAMPLE)');
      const pad = await dialog.locator('.sig-pad canvas').boundingBox();
      await page.mouse.move(pad.x + 30, pad.y + pad.height * 0.6);
      await page.mouse.down();
      for (let i = 1; i <= 24; i++) {
        await page.mouse.move(pad.x + 30 + i * 12, pad.y + pad.height * (0.6 - 0.25 * Math.sin(i / 3)), { steps: 2 });
      }
      await page.mouse.up();
      await dialog.locator('.check input[type="checkbox"]').check();
      await shot(page, 'sign-dialog');
      await dialog.getByRole('button', { name: 'Sign the paper' }).click();
      await waitFor(async () => {
        const papers = await bridge(page, 'papers.list');
        return papers.find((p) => p.ref === paperRef)?.status === 'signed';
      }, 30000, 'the paper to be signed');
      return 'signed';
    });

    await step(F, 'status shows Signed', async () => {
      // After signing, the Send dialog opens; the status behind it reads Signed.
      const meta = page.locator('.paper-meta');
      await waitFor(async () => /signed/i.test(await meta.textContent()), 10000, 'Signed on the paper');
      const paper = (await bridge(page, 'papers.list')).find((p) => p.ref === paperRef);
      assert.ok(paper.sha256 && paper.signedBy, 'no fingerprint or signer');
      return `${paper.ref} v${paper.version} signed by ${paper.signedBy}, sha256 ${paper.sha256.slice(0, 12)}...`;
    });

    await step(F, 'save the signed pack', async () => {
      const dialog = page.getByRole('dialog');
      await waitFor(() => dialog.getByRole('button', { name: /Download instead/ }).isVisible(), 10000, 'the send dialog');
      await shot(page, 'send-dialog');
      await dialog.getByRole('button', { name: /Download instead/ }).click();
      const saved = await waitFor(() => fs.readdirSync(saveDir).find((f) => f.endsWith('.pdf')), 15000, 'the saved PDF');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      const file = path.join(saveDir, saved);
      const bytes = new Uint8Array(fs.readFileSync(file));
      assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
      const { pdfInfo } = await import('../../src/core/ingest/pdf.js');
      const info = await pdfInfo(bytes);
      assert.ok(info.pages > 1, `the saved PDF has ${info.pages} pages`);
      assert.match(info.text, /Ravi Mehta \(SAMPLE\)/, 'the signer name is not in the saved PDF');
      savedPdf = { file, pages: info.pages };
      return `${saved}: ${bytes.length} bytes, ${info.pages} pages, opens and names the signer`;
    });

    await step(F, 'print: every page drawn for the printer', async () => {
      // What papers.print does before the system print dialog opens (the dialog itself needs a person).
      const data = fs.readFileSync(savedPdf.file).toString('base64');
      const pages = await app.evaluate(async ({ BrowserWindow }, args) => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        try {
          await win.loadFile(args.html);
          return await win.webContents.executeJavaScript(`window.raster.showAll(${JSON.stringify(args.data)}, null, 'print test')`);
        } finally {
          win.destroy();
        }
      }, { html: path.join(ROOT, 'src', 'main', 'rasterize.html'), data });
      assert.equal(pages, savedPdf.pages);
      return `${pages} pages ready to print`;
    });

    await step(F, 'stone history: 7391020001', async () => {
      await page.locator('nav.tabs button', { hasText: 'Stones' }).click();
      const search = page.locator('.stone-search input');
      await search.fill('7391020001');
      await search.press('Enter');
      await waitFor(async () => (await page.locator('.passport .rn').textContent()).includes('7391020001'), 15000, 'the stone passport');
      const done = page.locator('.timeline .tl-item.done');
      await waitFor(async () => (await done.count()) >= 5, 15000, 'the history timeline');
      const titles = await done.locator('.tl-title').allTextContents();
      return `${titles.length} steps: ${titles.map((t) => t.trim()).join(' > ')}; ${await shot(page, 'stone-history')}`;
    });

    await step(F, 'desk view', async () => {
      await page.locator('.topbar').getByRole('button', { name: 'Desk' }).click();
      await waitFor(() => page.locator('.desk .sidebar').isVisible(), 10000, 'the desk');
      await sleep(600);
      return shot(page, 'desk');
    });

    await step(F, 'onboard a house', async () => {
      await page.locator('.desk-topbar').getByRole('button', { name: 'Connect' }).click();
      const dialog = page.getByRole('dialog');
      await waitFor(() => dialog.isVisible(), 10000, 'the onboarding dialog');
      await dialog.getByLabel('House name', { exact: true }).fill('Meridian Stones (SAMPLE)');
      await dialog.getByLabel('Legal entity', { exact: true }).fill('Meridian Stones BV (SAMPLE)');
      await dialog.getByLabel('Country', { exact: true }).fill('Belgium');
      await dialog.getByLabel('City', { exact: true }).fill('Antwerp');
      await dialog.getByLabel(/^Contact emails/).fill('desk@meridian-stones.example.com');
      await dialog.getByLabel('Contact name', { exact: true }).fill('Lena Peeters (SAMPLE)');
      await dialog.getByLabel('WhatsApp numbers, with country code').fill('+32 3 555 0101');
      await waitFor(() => dialog.locator('.qr-card img').isVisible(), 10000, 'the WhatsApp QR code');
      await shot(page, 'onboard-form');
      await dialog.getByRole('button', { name: 'Onboard the house' }).click();
      const result = dialog.locator('.result-box');
      await waitFor(() => result.isVisible(), 30000, 'the onboarding result');
      const text = (await result.textContent()).replace(/\s+/g, ' ');
      assert.match(text, /Meridian Stones \(SAMPLE\) is onboarded/);
      const file = await shot(page, 'onboarded');
      await dialog.getByRole('button', { name: 'Close' }).click();
      return `${text.slice(0, 160)}; ${file}`;
    });

    // A dialog left open by a failed step would block every click after it.
    if (await page.getByRole('dialog').isVisible().catch(() => false)) await page.keyboard.press('Escape');

    await step(F, 'metrics', async () => {
      await page.locator('.sidebar').getByRole('button', { name: /Metrics/ }).click();
      await waitFor(async () => (await page.locator('.desk-content').textContent()).length > 200, 10000, 'the metrics page');
      await sleep(800);
      return shot(page, 'metrics');
    });

    await step(F, 'settings', async () => {
      await page.locator('.sidebar').getByRole('button', { name: /Settings/ }).click();
      await waitFor(() => page.locator('#settings-profile').isVisible(), 10000, 'the settings page');
      await sleep(500);
      return shot(page, 'settings');
    });

    await step(F, 'the OpenAI key never leaves the app', async () => {
      const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
      const leakedInOutput = lines.some((line) => line.includes(key));
      const leakedInFiles = filesUnder(userData).filter((f) => fs.readFileSync(f).includes(key)).map((f) => path.relative(userData, f));
      assert.equal(leakedInOutput, false, 'the key appeared in the app output');
      assert.deepEqual(leakedInFiles, [], 'the key was written to disk');
      return 'not in the output, settings, secrets, logs or workspace files';
    });
  } finally {
    await step(F, 'no errors in the app', async () => {
      const mainErrors = errorLines(lines);
      assert.deepEqual(problems, [], 'the screens logged errors');
      assert.deepEqual(mainErrors, [], 'the main process logged errors');
      return 'none';
    });
    const quit = await closeApp(app);
    await step(F, 'the app quits', async () => assert.ok(quit, 'it had to be killed'));
  }
}

// ---------- Flow B: two people, one shared house (Supabase) ----------

function testEmail() {
  return `jl-test-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}@example.com`;
}

function testPassword() {
  return `${crypto.randomBytes(18).toString('base64url')}aA1`;
}

async function createAccount(page, { name, email, password, houseName, inviteCode }) {
  await page.getByRole('tab', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  if (inviteCode) await page.getByLabel('Invite code').fill(inviteCode);
  else await page.getByLabel('House name').fill(houseName);
  await page.locator('.auth-card').getByRole('button', { name: 'Create the account' }).click();
  await waitFor(async () => {
    const error = await page.locator('.auth-card .form-error').textContent().catch(() => null);
    if (error) throw new Error(`the app said: ${error}`);
    return (await bridge(page, 'auth.status')).signedIn;
  }, 60000, 'the new account to sign in');
  await waitFor(async () => (await bridge(page, 'workspaces.current'))?.kind === 'cloud', 60000, 'the shared house to open');
  return bridge(page, 'workspaces.current');
}

async function flowB() {
  const F = 'B';
  shotFlow = F;
  shotNumber = 0;
  const people = [
    { name: 'Test Owner (SAMPLE)', email: testEmail(), password: testPassword() },
    { name: 'Test Preparer (SAMPLE)', email: testEmail(), password: testPassword() },
  ];
  const houseName = `Test House ${crypto.randomBytes(2).toString('hex')} (SAMPLE)`;
  const sampleDoc = path.join(ROOT, 'samples', 'sample-shipment', 'drop', 'shipment-c', 'Invoice KG-26-27-043.pdf');
  const dirs = [tempDir('jl-e2e-b1-'), tempDir('jl-e2e-b2-')];
  cleanups.push(...dirs);
  const problems = [];
  let one = null;
  let two = null;
  let house = null;
  let code = null;

  try {
    one = await launchApp({ userData: dirs[0], env: { JL_E2E_OPEN_FILES: sampleDoc }, viewport: { width: 1440, height: 900 } });
    watchPage(one.page, 'B1', problems);

    await step(F, 'account 1 creates a house', async () => {
      await waitFor(() => one.page.getByRole('tab', { name: 'Create an account' }).isVisible(), 20000, 'the welcome screen');
      house = await createAccount(one.page, { ...people[0], houseName });
      assert.equal(house.name, houseName);
      return `${people[0].email.replace(/-[0-9a-f]{6}@/, '-…@')} owns "${house.name}" (${house.myRole}); ${await shot(one.page, 'b1-house')}`;
    });

    await step(F, 'account 1 creates an invite code in Settings', async () => {
      await one.page.locator('.topbar').getByRole('button', { name: 'Settings' }).click();
      await waitFor(() => one.page.locator('#settings-team').isVisible(), 10000, 'the Team settings');
      await one.page.locator('#settings-team').scrollIntoViewIfNeeded();
      await one.page.locator('#settings-team').getByRole('button', { name: 'Create an invite code' }).click();
      const box = one.page.locator('#settings-team .code-box');
      await waitFor(() => box.isVisible(), 20000, 'the invite code');
      code = (await box.locator('span').first().textContent()).trim();
      assert.ok(code.length >= 6, `odd code: ${code}`);
      return `code of ${code.length} characters; ${await shot(one.page, 'b1-invite')}`;
    });

    two = await launchApp({ userData: dirs[1], viewport: { width: 1440, height: 900 } });
    watchPage(two.page, 'B2', problems);

    await step(F, 'account 2 joins with the invite code', async () => {
      await waitFor(() => two.page.getByRole('tab', { name: 'Create an account' }).isVisible(), 20000, 'the second welcome screen');
      const joined = await createAccount(two.page, { ...people[1], inviteCode: code });
      assert.equal(joined.id, house.id, 'account 2 opened a different house');
      return `"${joined.name}" as ${joined.myRole}; ${await shot(two.page, 'b2-joined')}`;
    });

    await step(F, 'account 1 adds a document', async () => {
      await one.page.locator('nav.tabs button', { hasText: 'Home' }).click();
      await waitFor(() => one.page.locator('.dropzone').isVisible(), 10000, 'the drop zone');
      await one.page.locator('.dropzone').click();
      await waitFor(async () => (await bridge(one.page, 'docs.list')).some((d) => d.fileName === path.basename(sampleDoc)), 30000, 'the document');
      return path.basename(sampleDoc);
    });

    await step(F, 'account 1 reads it with the Jewel Labs AI service', async () => {
      const doc = await waitFor(async () => (await bridge(one.page, 'docs.list')).find((d) => d.fileName === path.basename(sampleDoc) && d.status === 'read'), 120000, 'the document to be read');
      const { ai } = await bridge(one.page, 'app.info');
      assert.equal(ai.mode, 'proxy', `a signed-in house without its own key should use the service, got ${ai.mode}`);
      assert.ok(ai.calls > 0, 'no call reached the AI service');
      assert.equal(ai.lastError, null, `the AI service failed: ${ai.lastError?.message}`);
      // The offline reader never claims more than 0.6; the AI does.
      const sure = (doc.fields || []).filter((f) => f.confidence > 0.6).length;
      assert.ok(sure > 0, 'every field looks read offline');
      return `${doc.docType}, ${doc.fields?.length || 0} fields (${sure} read with high confidence), ${ai.calls} AI calls through the service`;
    });

    await step(F, 'account 2 sees the document', async () => {
      const name = path.basename(sampleDoc);
      const started = Date.now();
      // Realtime first; after 25 s the screens are reloaded (a refresh), as a person would.
      let how = 'realtime';
      await waitFor(async () => {
        if (Date.now() - started > 25000 && how === 'realtime') {
          how = 'refresh';
          await two.page.reload();
        }
        return (await bridge(two.page, 'docs.list')).some((d) => d.fileName === name);
      }, 60000, 'the document on the second computer');
      await two.page.locator('nav.tabs button', { hasText: 'Home' }).click();
      await waitFor(async () => /1 document sent|documents? sent/i.test(await two.page.locator('.section-head .counter').first().textContent()), 20000, 'the document count on screen');
      return `${how} after ${Math.round((Date.now() - started) / 1000)} s; ${await shot(two.page, 'b2-sees-document')}`;
    });

    await step(F, 'both sign out', async () => {
      for (const [label, who] of [['1', one], ['2', two]]) {
        await who.page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
        await waitFor(async () => !(await bridge(who.page, 'auth.status')).signedIn, 20000, `account ${label} to sign out`);
        await waitFor(() => who.page.getByRole('tab', { name: 'Sign in' }).isVisible(), 10000, `the welcome screen for ${label}`);
      }
      return 'signed out, back on the welcome screen';
    });
  } catch (error) {
    failed = true;
    results.push({ flow: F, step: 'flow', ok: false, error: error.message });
    console.log(`FAIL  ${F}: ${error.message}`);
  } finally {
    const errors = [...errorLines(one?.lines || []), ...errorLines(two?.lines || [])];
    await step(F, 'no errors in the app', async () => {
      assert.deepEqual(problems, [], 'the screens logged errors');
      assert.deepEqual(errors, [], 'the main process logged errors');
      return 'none';
    });
    const quits = [await closeApp(one?.app), await closeApp(two?.app)];
    await step(F, 'both apps quit', async () => assert.ok(quits.every(Boolean), 'one had to be killed'));
  }
}

// ---------- run ----------

const started = Date.now();
try {
  if (which.includes('A')) await flowA();
  if (which.includes('B')) await flowB();
} finally {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), results }, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} steps passed in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(failed ? 'E2E FLOWS FAILED' : 'E2E FLOWS PASSED');
}
process.exit(failed ? 1 : 0);
