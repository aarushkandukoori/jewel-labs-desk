// Unit tests for the Electron shell (src/main). Electron itself is never started here: every file
// that needs Electron takes it as an argument, so these tests pass small fakes instead.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { needString, optionalString, needObject, optionalObject, needBoolean, isSafeExternalUrl } from '../../src/main/validate.js';
import { createPathGrants, readDroppedPaths, safeFileName, writeTempFile } from '../../src/main/files.js';
import { createSettings } from '../../src/main/settings.js';
import { createSecrets, NO_SAFE_STORAGE } from '../../src/main/secrets.js';
import { compareVersions, checkForUpdate, pickDownload } from '../../src/main/updates.js';
import { looksLikeOpenAIKey, checkOpenAIKey } from '../../src/main/openai-key.js';
import { createNotifier, normalizeNotice } from '../../src/main/notify.js';
import { createLog } from '../../src/main/log.js';
import { appMenuTemplate } from '../../src/main/menu.js';
import { trayIconFile, trayMenuTemplate } from '../../src/main/tray.js';
import { makeAppUrlCheck, boundsThatFit, guardContents, contextMenuTemplate } from '../../src/main/window.js';
import { createHandlers, registerIpc, runHandler, toPlain } from '../../src/main/ipc.js';
import { createAppState, matches, newestFirst, labCheckDetail, LOCAL_WORKSPACE_NAME, SAMPLE_WORKSPACE_NAME } from '../../src/main/state.js';
import { createLabsVerify } from '../../src/main/labs-window.js';
import { createRasterizer, dataUrlToBytes, wasmUrlFor } from '../../src/main/rasterize.js';
import { createPrinter } from '../../src/main/print.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = path.join(HERE, '..', '..', 'src', 'main');
const require = createRequire(import.meta.url);

// A tiny PNG (1x1), as pdf.js would return it from canvas.toDataURL.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
// Fake keys are built at run time so nothing in the repo looks like a real key.
const FAKE_OPENAI_KEY = ['sk', 'test', 'a'.repeat(24)].join('-');

let tmpRoot;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-main-test-'));
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
function tmpDir(name) {
  const dir = path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// "Encrypts" by hex-encoding behind a marker: enough to prove the file never holds plain text.
// Same shape as Electron's async safeStorage API.
function fakeSafeStorage({ available = true, backend = 'keychain', rotate = false } = {}) {
  const fake = {
    encrypted: 0,
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (text) => {
      fake.encrypted += 1;
      return Buffer.from(`enc:${Buffer.from(text).toString('hex')}`);
    },
    decryptStringAsync: async (buf) => {
      const t = buf.toString();
      if (!t.startsWith('enc:')) throw new Error('not ours');
      return { result: Buffer.from(t.slice(4), 'hex').toString(), shouldReEncrypt: rotate };
    },
  };
  return fake;
}

const quietLog = { info() {}, warn() {}, error() {}, log() {} };

// ---------------------------------------------------------------------------------------------

describe('validate', () => {
  test('needString trims and refuses empty or long text', () => {
    assert.equal(needString('  abc ', 'name'), 'abc');
    assert.throws(() => needString('', 'name'), /Missing name/);
    assert.throws(() => needString(5, 'name'), /Missing name/);
    assert.throws(() => needString('abcdef', 'name', { max: 3 }), /too long/);
  });

  test('optional values and objects', () => {
    assert.equal(optionalString(undefined, 'x'), null);
    assert.equal(optionalString('', 'x'), null);
    assert.throws(() => optionalString(3, 'x'), /must be text/);
    assert.deepEqual(optionalObject(undefined, 'x'), {});
    assert.throws(() => needObject([], 'filter'), /Missing filter/);
    assert.throws(() => needBoolean('yes', 'autopilot'), /true or false/);
    assert.equal(needBoolean(false, 'autopilot'), false);
  });

  test('only https and mailto links leave the app', () => {
    assert.equal(isSafeExternalUrl('https://jewellabs.io'), true);
    assert.equal(isSafeExternalUrl('mailto:hello@example.com'), true);
    assert.equal(isSafeExternalUrl('http://example.com'), false);
    assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('not a url'), false);
  });
});

describe('files', () => {
  test('path grants cover the chosen file or folder only', () => {
    const grants = createPathGrants();
    const dir = path.join(tmpRoot, 'granted');
    grants.allow(dir);
    assert.equal(grants.isAllowed(path.join(dir, 'a.pdf')), true);
    assert.equal(grants.isAllowed(dir), true);
    assert.equal(grants.isAllowed(`${dir}-other/a.pdf`), false);
    assert.equal(grants.isAllowed('/etc/passwd'), false);
    assert.equal(grants.isAllowed(''), false);
  });

  test('readDroppedPaths reads files and walks folders, skipping hidden files', async () => {
    const dir = tmpDir('drop');
    fs.writeFileSync(path.join(dir, 'invoice.pdf'), 'pdf');
    fs.mkdirSync(path.join(dir, 'chat'));
    fs.writeFileSync(path.join(dir, 'chat', '_chat.txt'), 'hello');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(dir, '__MACOSX'));
    fs.writeFileSync(path.join(dir, '__MACOSX', 'junk'), 'x');
    const files = await readDroppedPaths([dir]);
    assert.deepEqual(files.map((f) => f.name).sort(), ['_chat.txt', 'invoice.pdf']);
    assert.ok(files[0].bytes instanceof Uint8Array);
  });

  test('readDroppedPaths enforces the limits', async () => {
    const dir = tmpDir('limits');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'aaaa');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bbbb');
    await assert.rejects(readDroppedPaths([dir], { maxFiles: 1 }), /more than 1 files/);
    await assert.rejects(readDroppedPaths([dir], { maxBytes: 5 }), /too large/);
  });

  test('safeFileName removes folders and odd characters', () => {
    assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(safeFileName('JL-EXP-1115-01-v1.pdf'), 'JL-EXP-1115-01-v1.pdf');
    assert.equal(safeFileName('a:b*c?.pdf'), 'a_b_c_.pdf');
    assert.equal(safeFileName(''), 'file');
  });

  test('writeTempFile writes inside the folder', async () => {
    const dir = path.join(tmpRoot, 'temp-out');
    const file = await writeTempFile(dir, '../escape.pdf', new Uint8Array([1, 2, 3]));
    assert.equal(path.dirname(file), dir);
    assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
  });
});

describe('settings', () => {
  test('starts from defaults, keeps a device id, saves patches', () => {
    const file = path.join(tmpDir('settings'), 'settings.json');
    const settings = createSettings({ file });
    const first = settings.get();
    assert.equal(first.autopilot, true);
    assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
    settings.set({ autopilot: false });
    const again = createSettings({ file }).get();
    assert.equal(again.autopilot, false);
    assert.equal(again.deviceId, first.deviceId);
  });

  test('per-workspace settings and a damaged file', () => {
    const file = path.join(tmpDir('settings2'), 'settings.json');
    fs.writeFileSync(file, '{ not json');
    const settings = createSettings({ file });
    assert.equal(settings.get().notifications, true);
    settings.setWorkspace('w1', { folder: '/papers' });
    settings.setWorkspace('w1', { mail: { email: 'ops@example.com' } });
    assert.deepEqual(settings.workspace('w1'), { folder: '/papers', mail: { email: 'ops@example.com' } });
    assert.deepEqual(settings.workspace('nope'), {});
  });

  test('get returns a copy', () => {
    const settings = createSettings({ file: path.join(tmpDir('settings3'), 'settings.json') });
    settings.get().workspaces.x = 1;
    assert.equal(settings.get().workspaces.x, undefined);
  });
});

describe('secrets', () => {
  test('stores only ciphertext and reads it back', async () => {
    const file = path.join(tmpDir('secrets'), 'secrets.json');
    const secrets = createSecrets({ file, safeStorage: fakeSafeStorage() });
    assert.equal(secrets.available(), null); // the Keychain is not touched until a secret is needed
    assert.equal(await secrets.init(), true);
    assert.equal(secrets.available(), true);
    await secrets.set('openai', FAKE_OPENAI_KEY);
    assert.equal(await secrets.get('openai'), FAKE_OPENAI_KEY);
    assert.equal(secrets.has('openai'), true);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(FAKE_OPENAI_KEY));
    secrets.remove('openai');
    assert.equal(await secrets.get('openai'), null);
    assert.equal(secrets.has('openai'), false);
  });

  test('re-encrypts when the system rotated its key', async () => {
    const safeStorage = fakeSafeStorage({ rotate: true });
    const secrets = createSecrets({ file: path.join(tmpDir('secrets-rotate'), 'secrets.json'), safeStorage });
    await secrets.set('openai', FAKE_OPENAI_KEY);
    assert.equal(await secrets.get('openai'), FAKE_OPENAI_KEY);
    assert.equal(safeStorage.encrypted, 2);
  });

  test('refuses to store when the computer cannot encrypt', async () => {
    const file = path.join(tmpDir('secrets2'), 'secrets.json');
    const secrets = createSecrets({ file, safeStorage: fakeSafeStorage({ available: false }) });
    await assert.rejects(secrets.set('openai', 'x'), (e) => e.message === NO_SAFE_STORAGE);
    assert.equal(secrets.available(), false);
    assert.equal(fs.existsSync(file), false);
  });

  test('Linux without a keyring counts as unavailable', async () => {
    const secrets = createSecrets({ file: path.join(tmpRoot, 'nope.json'), safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux' });
    assert.equal(await secrets.init(), false);
  });

  test('session storage falls back to memory without encryption', async () => {
    const file = path.join(tmpDir('secrets3'), 'secrets.json');
    const storage = createSecrets({ file, safeStorage: fakeSafeStorage({ available: false }) }).storage('supabase');
    await storage.setItem('session', '{"a":1}');
    assert.equal(await storage.getItem('session'), '{"a":1}');
    assert.equal(fs.existsSync(file), false);
    await storage.removeItem('session');
    assert.equal(await storage.getItem('session'), null);
  });

  test('session storage is encrypted when it can be', async () => {
    const file = path.join(tmpDir('secrets4'), 'secrets.json');
    const secrets = createSecrets({ file, safeStorage: fakeSafeStorage() });
    await secrets.storage('supabase').setItem('sb-token', 'session-value');
    assert.equal(await secrets.get('supabase:sb-token'), 'session-value');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('session-value'));
  });
});

describe('updates', () => {
  test('compareVersions', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('v1.2.0', '1.1.9'), 1);
    assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
    assert.equal(compareVersions('1.0', '1.0.1'), -1);
    assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), 0);
  });

  test('pickDownload matches the release file names', () => {
    const assets = [
      { name: 'Jewel-Labs-mac-arm64.dmg', browser_download_url: 'https://x/arm' },
      { name: 'Jewel-Labs-mac-x64.dmg', browser_download_url: 'https://x/intel' },
      { name: 'Jewel-Labs-windows-setup.exe', browser_download_url: 'https://x/win' },
    ];
    assert.equal(pickDownload(assets, 'darwin', 'arm64'), 'https://x/arm');
    assert.equal(pickDownload(assets, 'darwin', 'x64'), 'https://x/intel');
    assert.equal(pickDownload(assets, 'win32', 'x64'), 'https://x/win');
    assert.equal(pickDownload(assets, 'linux', 'x64'), null);
  });

  function fakeFetch(status, body) {
    const calls = [];
    const fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
    return { fetch, calls };
  }

  test('checkForUpdate reports a newer release', async () => {
    const { fetch, calls } = fakeFetch(200, {
      tag_name: 'v1.1.0',
      html_url: 'https://github.com/aarushkandukoori/jewel-labs-desk/releases/tag/v1.1.0',
      assets: [{ name: 'Jewel-Labs-windows-setup.exe', browser_download_url: 'https://x/win' }],
    });
    const update = await checkForUpdate({ currentVersion: '1.0.0', platform: 'win32', arch: 'x64', fetch });
    assert.deepEqual(update, { latest: '1.1.0', url: 'https://github.com/aarushkandukoori/jewel-labs-desk/releases/tag/v1.1.0', download: 'https://x/win' });
    assert.equal(calls[0].url, 'https://api.github.com/repos/aarushkandukoori/jewel-labs-desk/releases/latest');
  });

  test('checkForUpdate returns null when current or when there is no release', async () => {
    assert.equal(await checkForUpdate({ currentVersion: '1.1.0', fetch: fakeFetch(200, { tag_name: 'v1.1.0' }).fetch }), null);
    assert.equal(await checkForUpdate({ currentVersion: '1.0.0', fetch: fakeFetch(404, {}).fetch }), null);
    await assert.rejects(checkForUpdate({ currentVersion: '1.0.0', fetch: fakeFetch(500, {}).fetch }), /GitHub answered 500/);
  });
});

describe('openai key', () => {
  test('looksLikeOpenAIKey', () => {
    assert.equal(looksLikeOpenAIKey(FAKE_OPENAI_KEY), true);
    assert.equal(looksLikeOpenAIKey(`  ${FAKE_OPENAI_KEY}  `), true);
    assert.equal(looksLikeOpenAIKey('sk-short'), false);
    assert.equal(looksLikeOpenAIKey('hello'), false);
    assert.equal(looksLikeOpenAIKey(null), false);
  });

  test('checkOpenAIKey', async () => {
    const answer = (status) => async () => ({ status, ok: status === 200 });
    assert.deepEqual(await checkOpenAIKey(FAKE_OPENAI_KEY, { fetch: answer(200) }), { ok: true });
    assert.equal((await checkOpenAIKey(FAKE_OPENAI_KEY, { fetch: answer(401) })).ok, false);
    const rateLimited = await checkOpenAIKey(FAKE_OPENAI_KEY, { fetch: answer(429) });
    assert.equal(rateLimited.ok, true);
    assert.match(rateLimited.warning, /429/);
    const offline = await checkOpenAIKey(FAKE_OPENAI_KEY, {
      fetch: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(offline.ok, true);
    assert.match(offline.warning, /Could not reach OpenAI/);
  });
});

describe('notify', () => {
  class FakeNotification extends EventEmitter {
    static shown = [];
    static isSupported() {
      return true;
    }
    constructor(opts) {
      super();
      this.opts = opts;
    }
    show() {
      FakeNotification.shown.push(this.opts);
    }
  }

  test('normalizeNotice', () => {
    assert.deepEqual(normalizeNotice('Hello'), { title: 'Jewel Labs', body: 'Hello' });
    assert.equal(normalizeNotice({ message: 'Ready to sign' }).body, 'Ready to sign');
    assert.equal(normalizeNotice({ title: 'Pack', body: 'x', shipmentId: 's1' }).shipmentId, 's1');
  });

  test('sends each notice once, and to the desktop only when the window is not in front', () => {
    FakeNotification.shown = [];
    const events = [];
    let focused = true;
    let t = 1000;
    const notifier = createNotifier({
      Notification: FakeNotification,
      sendEvent: (name, payload) => events.push([name, payload.body]),
      isWindowFocused: () => focused,
      now: () => t,
    });
    assert.equal(notifier.notify({ title: 'Pack', body: 'JL-EXP-1115-01 is ready to sign' }), true);
    assert.equal(notifier.notify({ title: 'Pack', body: 'JL-EXP-1115-01 is ready to sign' }), false); // same message again
    assert.equal(events.length, 1);
    assert.equal(FakeNotification.shown.length, 0); // window in front: the screens show it
    focused = false;
    t += 10000;
    notifier.notify({ title: 'Pack', body: 'JL-EXP-1115-01 is ready to sign' });
    assert.equal(events.length, 2);
    assert.equal(FakeNotification.shown.length, 1);
  });

  test('respects the notifications setting', () => {
    FakeNotification.shown = [];
    const notifier = createNotifier({ Notification: FakeNotification, isEnabled: () => false });
    notifier.notify('Hello');
    assert.equal(FakeNotification.shown.length, 0);
  });
});

describe('log', () => {
  test('prints with a prefix and appends to the log file', () => {
    const lines = [];
    const out = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
    const log = createLog({ out });
    const file = path.join(tmpDir('log'), 'main.log');
    log.setFile(file);
    log.info('hello', { a: 1 });
    log.error(new Error('broken'));
    assert.match(lines[0], /^\[jewel-labs\] info hello \{"a":1\}/);
    assert.match(lines[1], /^\[jewel-labs\] error Error: broken/);
    assert.match(fs.readFileSync(file, 'utf8'), /info hello/);
    assert.equal(log.file, file);
  });
});

describe('menu and tray', () => {
  const labels = (items) => items.map((i) => i.label || i.role || i.type);

  test('app menu: about, updates, quit; reload only while developing', () => {
    const prod = appMenuTemplate({ platform: 'darwin', isDev: false, onAbout() {}, onCheckUpdates() {} });
    assert.deepEqual(labels(prod[0].submenu).filter((l) => l !== 'separator').slice(0, 2), ['About Jewel Labs', 'Check for updates…']);
    assert.ok(labels(prod[0].submenu).includes('Quit Jewel Labs'));
    assert.equal(prod[1].role, 'editMenu');
    assert.ok(!labels(prod[2].submenu).includes('reload'));
    const dev = appMenuTemplate({ platform: 'win32', isDev: true, onAbout() {}, onCheckUpdates() {} });
    assert.ok(labels(dev[2].submenu).includes('reload'));
    assert.ok(!labels(dev[0].submenu).includes('hide')); // Mac-only items stay off Windows
  });

  test('tray icon per platform', () => {
    assert.equal(path.basename(trayIconFile('/i', 'darwin', true)), 'trayTemplate.png');
    assert.equal(path.basename(trayIconFile('/i', 'win32', true)), 'tray.png');
    assert.equal(path.basename(trayIconFile('/i', 'win32', false)), 'trayTemplate.png');
  });

  test('tray menu items and the autopilot toggle', () => {
    let toggled = null;
    const items = trayMenuTemplate({ autopilot: true, onOpen() {}, onToggleAutopilot: (on) => (toggled = on), onCheckMail() {}, onQuit() {} });
    assert.deepEqual(labels(items).filter((l) => l !== 'separator'), ['Open Jewel Labs', 'Autopilot: On', 'Check mail now', 'Quit']);
    items.find((i) => i.label === 'Autopilot: On').click();
    assert.equal(toggled, false);
    assert.equal(trayMenuTemplate({ autopilot: false })[2].label, 'Autopilot: Off');
  });

  test('icon files exist and have the right sizes', () => {
    const root = path.join(HERE, '..', '..');
    const pngSize = (file) => {
      const b = fs.readFileSync(path.join(root, file));
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    assert.deepEqual(pngSize('build/icon.png'), [1024, 1024]);
    assert.deepEqual(pngSize('assets/icons/trayTemplate.png'), [16, 16]);
    assert.deepEqual(pngSize('assets/icons/trayTemplate@2x.png'), [32, 32]);
    assert.deepEqual(pngSize('assets/icons/tray.png'), [16, 16]);
  });
});

describe('window rules', () => {
  test('makeAppUrlCheck accepts only our pages', () => {
    const dir = path.join(tmpRoot, 'app', 'src', 'renderer');
    const fallback = path.join(tmpRoot, 'app', 'src', 'main', 'fallback.html');
    const isAppUrl = makeAppUrlCheck({ dirs: [dir], files: [fallback] });
    assert.equal(isAppUrl(`${pathToFileURL(path.join(dir, 'index.html')).href}#/papers`), true);
    assert.equal(isAppUrl(pathToFileURL(fallback).href), true);
    assert.equal(isAppUrl(pathToFileURL(path.join(tmpRoot, 'app', 'src', 'main', 'rasterize.html')).href), false);
    assert.equal(isAppUrl(`${pathToFileURL(dir).href}-evil/index.html`), false);
    assert.equal(isAppUrl('https://jewellabs.io'), false);
    assert.equal(isAppUrl(undefined), false);
  });

  test('boundsThatFit drops a position on a missing screen', () => {
    const displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
    assert.deepEqual(boundsThatFit({ x: 10, y: 10, width: 1200, height: 800 }, displays), { x: 10, y: 10, width: 1200, height: 800 });
    assert.equal(boundsThatFit({ x: 3000, y: 10, width: 1200, height: 800 }, displays), null);
    assert.equal(boundsThatFit(null, displays), null);
  });

  test('guardContents: no new windows, https goes to the browser, navigation stays home', () => {
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = (fn) => (contents.openHandler = fn);
    const opened = [];
    guardContents(contents, { isAppUrl: (u) => u.startsWith('file:///app/'), openExternal: (u) => opened.push(u) });
    assert.deepEqual(contents.openHandler({ url: 'https://www.gia.edu' }), { action: 'deny' });
    assert.deepEqual(contents.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
    assert.deepEqual(opened, ['https://www.gia.edu']);

    const navigate = (url) => {
      let prevented = false;
      contents.emit('will-navigate', { url, preventDefault: () => (prevented = true) });
      return prevented;
    };
    assert.equal(navigate('file:///app/index.html#/home'), false);
    assert.equal(navigate('https://evil.example'), true);
    assert.deepEqual(opened, ['https://www.gia.edu', 'https://evil.example']);
    let webviewBlocked = false;
    contents.emit('will-attach-webview', { preventDefault: () => (webviewBlocked = true) });
    assert.equal(webviewBlocked, true);
  });

  test('context menu offers spelling and editing', () => {
    const items = contextMenuTemplate({ dictionarySuggestions: ['carat'], isEditable: true }, { replaceMisspelling() {} });
    assert.deepEqual(items.map((i) => i.label || i.role || i.type), ['carat', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    assert.deepEqual(contextMenuTemplate({ selectionText: 'JL-EXP' }, {}).map((i) => i.role), ['copy']);
    assert.deepEqual(contextMenuTemplate({}, {}), []);
  });
});

// ---------------------------------------------------------------------------------------------
// preload.cjs, loaded with a fake 'electron'

function loadPreload() {
  const exposed = {};
  const sent = [];
  const listeners = new Map();
  const ipcRenderer = {
    invokeResult: async (channel, args) => ({ channel, args }),
    invoke(channel, ...args) {
      return this.invokeResult(channel, args);
    },
    send: (channel, value) => sent.push([channel, value]),
    on: (channel, fn) => listeners.set(fn, channel),
    removeListener: (_channel, fn) => listeners.delete(fn),
  };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
    ipcRenderer,
    webUtils: { getPathForFile: (file) => file.path || '' },
  };
  const electronPath = require.resolve('electron');
  const preloadPath = path.join(MAIN_DIR, 'preload.cjs');
  const saved = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron };
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    if (saved) require.cache[electronPath] = saved;
    else delete require.cache[electronPath];
  }
  const emit = (message) => {
    for (const [fn, channel] of listeners) if (channel === 'jl:event') fn({}, message);
  };
  return { jl: exposed.jl, ipcRenderer, sent, listeners, emit };
}

// The bridge exactly as docs/ARCHITECTURE.md lists it.
const CONTRACT = {
  app: ['info', 'openExternal', 'showItem', 'qr', 'checkUpdate', 'pathForFile'],
  auth: ['status', 'signIn', 'signUp', 'signOut'],
  workspaces: ['list', 'create', 'select', 'current', 'update', 'join', 'invite', 'members'],
  docs: ['pick', 'add', 'list', 'get', 'file', 'remove'],
  shipments: ['list', 'get', 'update'],
  stones: ['list', 'history', 'verify'],
  questions: ['list', 'answer', 'dismiss'],
  papers: ['list', 'build', 'file', 'open', 'print', 'sign', 'send', 'save'],
  agents: ['run', 'ask', 'autopilot'],
  activity: ['list'],
  checks: ['list'],
  parties: ['list'],
  messages: ['list', 'send'],
  desk: ['queue', 'approve', 'hold', 'houses', 'onboard'],
  sanctions: ['status', 'screen', 'refresh'],
  mail: ['connect', 'status', 'disconnect', 'pollNow'],
  folder: ['choose', 'status'],
  settings: ['get', 'set'],
  metrics: ['get'],
  demo: ['load', 'reset'],
};

describe('preload bridge', () => {
  test('exposes window.jl with exactly the contract methods', () => {
    const { jl } = loadPreload();
    const shape = Object.fromEntries(Object.entries(jl).filter(([k]) => k !== 'on').map(([area, methods]) => [area, Object.keys(methods).sort()]));
    const expected = Object.fromEntries(Object.entries(CONTRACT).map(([area, methods]) => [area, [...methods].sort()]));
    assert.deepEqual(shape, expected);
    assert.equal(typeof jl.on, 'function');
  });

  test('each method invokes jl:<area>.<method> with its arguments', async () => {
    const { jl } = loadPreload();
    assert.deepEqual(await jl.papers.build('s1', ['eu_dds']), { channel: 'jl:papers.build', args: ['s1', ['eu_dds']] });
    assert.deepEqual(await jl.app.info(), { channel: 'jl:app.info', args: [] });
  });

  test('errors come back as { error }, never thrown', async () => {
    const { jl, ipcRenderer } = loadPreload();
    ipcRenderer.invokeResult = async () => {
      throw new Error('An object could not be cloned.');
    };
    assert.deepEqual(await jl.docs.list({}), { error: 'An object could not be cloned.' });
  });

  test('jl.on filters by event name and unsubscribes', () => {
    const { jl, emit, listeners } = loadPreload();
    const seen = [];
    const off = jl.on('agent', (payload) => seen.push(payload));
    emit({ name: 'agent', payload: { agent: 'intake', action: 'read' } });
    emit({ name: 'notify', payload: { title: 'x' } });
    assert.deepEqual(seen, [{ agent: 'intake', action: 'read' }]);
    off();
    assert.equal(listeners.size, 0);
    assert.equal(typeof jl.on('agent', null), 'function');
  });

  test('pathForFile reports dropped paths to the main process', () => {
    const { jl, sent } = loadPreload();
    assert.equal(jl.app.pathForFile({ path: '/Users/x/invoice.pdf' }), '/Users/x/invoice.pdf');
    assert.equal(jl.app.pathForFile({}), '');
    assert.deepEqual(sent, [['jl:grant-path', '/Users/x/invoice.pdf']]);
  });

  test('docs.add turns File objects into paths or bytes', async () => {
    const { jl } = loadPreload();
    const onDisk = { name: 'invoice.pdf', path: '/Users/x/invoice.pdf', arrayBuffer: async () => new ArrayBuffer(1) };
    const fromWeb = { name: 'photo.jpg', arrayBuffer: async () => new Uint8Array([7, 8]).buffer };
    const result = await jl.docs.add([onDisk, fromWeb, { path: '/already/a/path.pdf' }]);
    assert.equal(result.channel, 'jl:docs.add');
    const [list] = result.args;
    assert.deepEqual(list[0], { path: '/Users/x/invoice.pdf' });
    assert.equal(list[1].name, 'photo.jpg');
    assert.deepEqual([...list[1].bytes], [7, 8]);
    assert.deepEqual(list[2], { path: '/already/a/path.pdf' });
  });
});

// ---------------------------------------------------------------------------------------------
// state.js with a fake core (in-memory stores, fake services and AI)

function memoryStore(workspace) {
  const data = {};
  const files = {};
  return {
    closed: false,
    data,
    workspace: async () => ({ ...workspace }),
    updateWorkspace: async (patch) => Object.assign(workspace, patch),
    list: async (collection, filter = () => true) => Object.values(data[collection] || {}).filter(filter),
    get: async (collection, id) => data[collection]?.[id] ?? null,
    put: async (collection, obj) => {
      data[collection] ||= {};
      data[collection][obj.id] = { ...obj };
      return { ...obj };
    },
    remove: async (collection, id) => {
      delete data[collection]?.[id];
    },
    putFile: async (key, bytes) => {
      files[key] = bytes;
      return key;
    },
    getFile: async (key) => files[key],
    close: async function close() {
      this.closed = true;
    },
  };
}

function fakeServices(opts) {
  const calls = [];
  let autopilot = true; // the workspace default
  return {
    opts,
    calls,
    events: new EventEmitter(),
    autopilot: {
      get: async () => autopilot,
      set: async (on, by) => {
        calls.push(['autopilot.set', on, by]);
        autopilot = on;
      },
    },
    worker: { start: async () => calls.push('worker.start'), stop: async () => calls.push('worker.stop'), status: () => ({}) },
    folder: {
      set: async (p, by) => {
        calls.push(['folder.set', p, by]);
        return { path: p, watching: true };
      },
      status: async () => ({ watching: true }),
    },
    mail: {
      connect: async (o) => {
        calls.push(['mail.connect', o]);
        return { connected: true, email: o.email };
      },
      disconnect: async (by) => calls.push(['mail.disconnect', by]),
      status: async () => ({ connected: false }),
      pollNow: async () => ({ fetched: 2 }),
    },
    addFiles: async (files) => {
      calls.push(['addFiles', files]);
      return { documentIds: files.map((_, i) => `doc${i + 1}`) };
    },
    run: async (q) => calls.push(['run', q]),
    history: async (n) => ({ stone: { reportNumber: n }, events: [] }),
    loadSample: async () => {
      calls.push('loadSample');
      return { documentIds: ['s1'] };
    },
    resetSample: async () => calls.push('resetSample'),
  };
}

function fakeCloudModule({ desk = false } = {}) {
  let session = null;
  const shared = [{ id: 'cloud-1', name: 'SAMPLE Diamond House', role: 'exporter', myRole: desk ? 'desk' : 'owner' }];
  const cloud = {
    auth: {
      signIn: async ({ email }) => {
        session = { user: { id: 'u1', email, name: 'Sample Person' }, isDesk: desk, isTest: false };
      },
      signUp: async () => {},
      signOut: async () => {
        session = null;
      },
      session: async () => session,
      onChange() {},
    },
    workspaces: {
      list: async () => (session ? shared : []),
      create: async (profile) => ({ id: 'cloud-2', ...profile }),
      join: async () => shared[0],
      invite: async () => ({ code: 'INVITE-1' }),
      members: async () => [{ name: 'Sample Person', role: 'owner' }],
    },
    lease: { acquire: async () => true, release: async () => {} },
    aiProxyUrl: 'https://example.invalid/functions/v1/ai',
    accessToken: () => 'token-for-tests',
  };
  return { createCloud: () => cloud };
}

function fakeCore({ cloud = null } = {}) {
  const workspaces = new Map();
  const stores = new Map();
  const services = [];
  let next = 1;
  const storeFor = (workspace) => {
    if (!stores.has(workspace.id)) stores.set(workspace.id, memoryStore(workspace));
    const s = stores.get(workspace.id);
    s.closed = false;
    return s;
  };
  return {
    workspaces,
    stores,
    allServices: services,
    store: {
      listLocalWorkspaces: async () => [...workspaces.values()],
      createLocalWorkspace: async ({ profile }) => {
        const w = { id: `local-${next++}`, ...profile };
        workspaces.set(w.id, w);
        return w;
      },
      openLocalStore: async ({ workspaceId }) => storeFor(workspaces.get(workspaceId)),
      openCloudStore: async ({ workspaceId }) => storeFor({ id: workspaceId, name: 'Cloud house' }),
    },
    services: {
      createServices: (opts) => {
        const svc = fakeServices(opts);
        services.push(svc);
        return svc;
      },
    },
    ai: { createAI: (opts) => ({ mode: opts.mode, model: opts.model || 'gpt-5-mini', available: opts.mode !== 'off', opts }) },
    sanctions: {
      loadSdn: async () => ({ count: 17589, date: '2026-11-02', source: 'snapshot', entries: [] }),
      screen: (name) => ({ name, status: 'clear', best: null, compared: 41 }),
    },
    ocr: { terminateOcr: async () => {} },
    labs: {},
    cloud,
    get lastServices() {
      return services[services.length - 1];
    },
  };
}

function makeState({ core = fakeCore(), safeStorage = fakeSafeStorage(), config = {}, ...rest } = {}) {
  const dir = tmpDir('state');
  const settings = createSettings({ file: path.join(dir, 'settings.json') });
  const secrets = createSecrets({ file: path.join(dir, 'secrets.json'), safeStorage });
  const events = [];
  const notices = [];
  const autopilotChanges = [];
  const state = createAppState({
    core,
    config: { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', AI_MODELS: ['gpt-5-mini'], MAILBOX_POLL_MINUTES: 5, OFAC_MAX_AGE_HOURS: 24, ...config },
    paths: { userData: dir, localDir: path.join(dir, 'local'), cacheDir: path.join(dir, 'cache'), tempDir: path.join(dir, 'tmp') },
    settings,
    secrets,
    sendEvent: (name, payload) => events.push({ name, payload }),
    notify: (n) => notices.push(n),
    system: { onAutopilotChange: (on) => autopilotChanges.push(on) },
    log: quietLog,
    ...rest,
  });
  return { state, core, settings, secrets, events, notices, autopilotChanges };
}

describe('app state', () => {
  test('first start makes a Local and a Sample workspace and opens the local one with the offline reader', async () => {
    const { state, core, settings, events } = makeState();
    await state.start();
    const names = [...core.workspaces.values()].map((w) => w.name).sort();
    assert.deepEqual(names, [LOCAL_WORKSPACE_NAME, SAMPLE_WORKSPACE_NAME]);
    const info = state.info();
    assert.equal(info.ready, true);
    assert.equal(info.mode, 'local');
    assert.equal(info.workspaceId, settings.get().localWorkspaceId);
    assert.equal(info.ai.mode, 'off');
    assert.equal(info.deskAllowed, true);
    const opts = core.lastServices.opts;
    assert.equal(opts.deviceId, settings.get().deviceId);
    assert.equal(typeof opts.sanctionsLoader, 'function');
    assert.equal(opts.lease, undefined);
    assert.equal(await core.lastServices.autopilot.get(), true);
    assert.ok(events.some((e) => e.name === 'sync' && e.payload.reason === 'opened'));
  });

  test('a second start reuses the same workspaces', async () => {
    const core = fakeCore();
    const first = makeState({ core });
    await first.state.start();
    const again = createAppState({
      core,
      config: { AI_MODELS: [], MAILBOX_POLL_MINUTES: 5, OFAC_MAX_AGE_HOURS: 24 },
      paths: { localDir: '/x', cacheDir: '/y' },
      settings: first.settings,
      secrets: first.secrets,
      log: quietLog,
    });
    await again.start();
    assert.equal(core.workspaces.size, 2);
  });

  test('forwards agent events and routes notices', async () => {
    const { state, core, events, notices } = makeState();
    await state.start();
    core.lastServices.events.emit('agent', { agent: 'intake', action: 'read', message: 'Reading invoice' });
    core.lastServices.events.emit('notify', { title: 'Pack', body: 'Ready to sign' });
    assert.ok(events.some((e) => e.name === 'agent' && e.payload.agent === 'intake'));
    assert.deepEqual(notices, [{ title: 'Pack', body: 'Ready to sign' }]);
  });

  test('a stored OpenAI key switches the AI to direct mode', async () => {
    const { state, secrets, core } = makeState();
    await secrets.set('openai', FAKE_OPENAI_KEY);
    await state.start();
    assert.equal(state.info().ai.mode, 'direct');
    assert.equal(core.lastServices.opts.ai.opts.apiKey, FAKE_OPENAI_KEY);
  });

  test('ready() explains when the core did not load', async () => {
    const { state } = makeState({ core: { error: new Error('Cannot find module store') } });
    await assert.rejects(state.start(), /Cannot find module store/);
    await assert.rejects(state.ready(), /The agents could not start: Cannot find module store/);
    assert.match(state.info().startError, /could not start/);
    assert.equal('error' in state.info(), false); // the screens read any `error` field as a failed call
  });

  test('list filters, searches, sorts newest first and limits', async () => {
    const { state, core, settings } = makeState();
    await state.start();
    const store = core.stores.get(settings.get().localWorkspaceId);
    await store.put('documents', { id: 'a', shipmentId: 's1', fileName: 'invoice.pdf', createdAt: '2026-11-01T00:00:00Z' });
    await store.put('documents', { id: 'b', shipmentId: 's1', fileName: 'awb.pdf', createdAt: '2026-11-03T00:00:00Z' });
    await store.put('documents', { id: 'c', shipmentId: 's2', fileName: 'kp.pdf', createdAt: '2026-11-02T00:00:00Z' });
    assert.deepEqual((await state.list('documents', { shipmentId: 's1' })).map((d) => d.id), ['b', 'a']);
    assert.deepEqual((await state.list('documents', { shipmentId: ['s1', 's2'], limit: 2 })).map((d) => d.id), ['b', 'c']);
    assert.deepEqual((await state.list('documents', { search: 'KP.PDF' })).map((d) => d.id), ['c']);
  });

  test('addFiles stamps the source', async () => {
    const { state, core } = makeState();
    await state.start();
    const result = await state.addFiles([{ name: 'a.pdf', bytes: new Uint8Array([1]) }], 'upload');
    assert.deepEqual(result, { documentIds: ['doc1'] });
    const [, files] = core.lastServices.calls.find((c) => c[0] === 'addFiles');
    assert.equal(files[0].source.kind, 'upload');
    assert.match(files[0].source.receivedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test('removeDocument updates the shipment and the audit trail', async () => {
    const { state, core, settings } = makeState();
    await state.start();
    const store = core.stores.get(settings.get().localWorkspaceId);
    await store.put('documents', { id: 'd1', fileName: 'invoice.pdf', shipmentId: 's1' });
    await store.put('shipments', { id: 's1', ref: 'EXP/26-27/28', documentIds: ['d1', 'd2'] });
    assert.equal(await state.removeDocument('d1'), true);
    assert.equal(await store.get('documents', 'd1'), null);
    assert.deepEqual((await store.get('shipments', 's1')).documentIds, ['d2']);
    const [activity] = await store.list('activity');
    assert.equal(activity.action, 'document.remove');
    assert.equal(activity.actor.type, 'person');
    await assert.rejects(state.removeDocument('nope'), /not found/);
  });

  test('updateShipment keeps protected fields', async () => {
    const { state, core, settings } = makeState();
    await state.start();
    const store = core.stores.get(settings.get().localWorkspaceId);
    await store.put('shipments', { id: 's1', workspaceId: 'w', ref: 'EXP/1', destinationCountry: 'BE' });
    const saved = await state.updateShipment('s1', { destinationCountry: 'US', id: 'hacked', workspaceId: 'other' });
    assert.equal(saved.id, 's1');
    assert.equal(saved.workspaceId, 'w');
    assert.equal(saved.destinationCountry, 'US');
  });

  test('dismissQuestion records who dismissed it', async () => {
    const { state, core, settings } = makeState();
    settings.set({ userName: 'Export clerk' });
    await state.start();
    const store = core.stores.get(settings.get().localWorkspaceId);
    await store.put('questions', { id: 'q1', text: 'Is the HS code 7102.39?', status: 'open' });
    const saved = await state.dismissQuestion('q1');
    assert.equal(saved.status, 'dismissed');
    assert.equal(saved.answeredBy, 'Export clerk');
  });

  test('autopilot is a workspace switch: set through the agents, remembered for the tray', async () => {
    const { state, core, settings, autopilotChanges } = makeState();
    await state.start();
    assert.deepEqual(autopilotChanges, [true]); // read from the workspace when it opened
    await state.setAutopilot(false);
    assert.equal(await core.lastServices.autopilot.get(), false);
    const [, on, by] = core.lastServices.calls.find((c) => c[0] === 'autopilot.set');
    assert.equal(on, false);
    assert.equal(by.name, state.personName());
    assert.equal(settings.get().autopilot, false);
    assert.deepEqual(autopilotChanges, [true, false]);
    assert.equal(state.autopilotOn(), false);
  });

  test('autopilot switched elsewhere (another computer, an agent) reaches the tray', async () => {
    const { state, core, events, autopilotChanges } = makeState();
    await state.start();
    core.lastServices.events.emit('change', { collection: 'workspace', id: 'w', op: 'put', value: { autopilot: false } });
    assert.equal(state.autopilotOn(), false);
    assert.deepEqual(autopilotChanges, [true, false]);
    assert.ok(events.some((e) => e.name === 'change' && e.payload.collection === 'workspace'));
  });

  test('settings: a new key restarts the agents, preferences are kept, internal keys are not', async () => {
    const { state, core, secrets, settings } = makeState();
    await state.start();
    const before = core.allServices.length;
    const result = await state.updateSettings({ openaiKey: FAKE_OPENAI_KEY, view: 'desk', deviceId: 'hacked', notifications: false });
    assert.equal(await secrets.get('openai'), FAKE_OPENAI_KEY);
    assert.equal(core.allServices.length, before + 1);
    assert.equal(result.aiMode, 'direct');
    assert.equal(result.hasOpenAIKey, true);
    assert.equal(result.view, 'desk');
    assert.equal(result.notifications, false);
    assert.notEqual(settings.get().deviceId, 'hacked');
    assert.equal('openaiKey' in result, false);
    const cleared = await state.updateSettings({ openaiKey: '' });
    assert.equal(cleared.hasOpenAIKey, false);
    assert.equal(cleared.aiMode, 'off');
  });

  test('mailbox: password encrypted, address saved, restored on the next start', async () => {
    const core = fakeCore();
    const { state, secrets, settings } = makeState({ core });
    await state.start();
    const id = settings.get().localWorkspaceId;
    const result = await state.connectMail({ provider: 'gmail', email: 'ops@example.com', appPassword: 'app-password-for-tests' });
    assert.equal(result.saved, true);
    assert.equal(result.connected, true);
    assert.equal(await secrets.get(`mail:${id}`), 'app-password-for-tests');
    assert.deepEqual(settings.workspace(id).mail, { provider: 'gmail', email: 'ops@example.com' });
    assert.ok(!fs.readFileSync(settings.file, 'utf8').includes('app-password-for-tests'));

    const folder = await state.setFolder('/Users/x/Shipments');
    assert.deepEqual(folder, { path: '/Users/x/Shipments', watching: true });

    // A fresh start reconnects the mailbox (the services keep the watched folder themselves).
    const again = createAppState({
      core,
      config: { AI_MODELS: [], MAILBOX_POLL_MINUTES: 5, OFAC_MAX_AGE_HOURS: 24 },
      paths: { localDir: '/x', cacheDir: '/y' },
      settings,
      secrets,
      log: quietLog,
    });
    await again.start();
    await new Promise((r) => setTimeout(r, 10));
    const calls = core.lastServices.calls;
    assert.deepEqual(calls.find((c) => c[0] === 'mail.connect')[1], {
      provider: 'gmail',
      email: 'ops@example.com',
      appPassword: 'app-password-for-tests',
      test: false,
    });
    assert.equal(calls.find((c) => c[0] === 'folder.set'), undefined);

    await again.disconnectMail();
    assert.equal(await secrets.get(`mail:${id}`), null);
    assert.equal(settings.workspace(id).mail, null);
  });

  test('a house that saves no secret never touches the Keychain', async () => {
    let asked = 0;
    const safeStorage = { ...fakeSafeStorage(), isAsyncEncryptionAvailable: async () => (asked += 1) > 0 };
    const { state } = makeState({ safeStorage });
    await state.start();
    await state.setAutopilot(false);
    state.publicSettings();
    assert.equal(asked, 0);
    assert.equal(state.info().secureStorage, null);
  });

  test('mailbox without safe storage: connected for now, with a warning', async () => {
    const { state, settings } = makeState({ safeStorage: fakeSafeStorage({ available: false }) });
    await state.start();
    const result = await state.connectMail({ provider: 'gmail', email: 'ops@example.com', appPassword: 'pw' });
    assert.equal(result.saved, false);
    assert.equal(result.warning, NO_SAFE_STORAGE);
    assert.equal(settings.workspace(settings.get().localWorkspaceId).mail, undefined);
  });

  test('the sample opens in the Sample workspace', async () => {
    const { state, core, settings } = makeState();
    await state.start();
    const result = await state.loadSample();
    assert.deepEqual(result, { documentIds: ['s1'] });
    assert.equal(state.info().workspaceId, settings.get().sampleWorkspaceId);
    assert.equal(state.info().sample, true);
    assert.ok(core.lastServices.calls.includes('loadSample'));
    await state.resetSample();
    assert.ok(core.lastServices.calls.includes('resetSample'));
  });

  test('switching workspaces stops the old agents and closes the old store', async () => {
    const { state, core, settings } = makeState();
    await state.start();
    const oldServices = core.lastServices;
    const oldStore = core.stores.get(settings.get().localWorkspaceId);
    const w = await state.selectWorkspace(settings.get().sampleWorkspaceId);
    assert.equal(w.sample, true);
    assert.ok(oldServices.calls.includes('worker.stop'));
    assert.equal(oldStore.closed, true);
    assert.deepEqual(settings.get().selected, { kind: 'local', id: settings.get().sampleWorkspaceId });
    await assert.rejects(state.selectWorkspace('nope'), /not found/);
  });

  test('createWorkspace opens the new local workspace', async () => {
    const { state } = makeState();
    await state.start();
    const w = await state.createWorkspace({ name: 'SAMPLE Exports LLP', country: 'IN' });
    assert.equal(w.name, 'SAMPLE Exports LLP');
    assert.equal(w.kind, 'local');
    assert.equal(state.info().workspaceId, w.id);
  });

  test('verifyStone saves the lab check and logs it', async () => {
    const labsVerify = async (stone) => ({ status: 'match', diffs: [], lab: stone.lab });
    const { state, core, settings } = makeState({ labsVerify });
    await state.start();
    const store = core.stores.get(settings.get().localWorkspaceId);
    await store.put('stones', { id: 'st1', shipmentId: 's1', reportNumber: '7451234567', lab: 'GIA', carat: 0.71 });
    const result = await state.verifyStone('st1');
    assert.equal(result.status, 'match');
    const stone = await store.get('stones', 'st1');
    assert.equal(stone.labCheck.status, 'match');
    const [activity] = await store.list('activity');
    assert.match(activity.detail, /GIA report 7451234567 matches/);
  });

  test('stone checks and dismissals go through the services when they offer them', async () => {
    const core = fakeCore();
    const realCreate = core.services.createServices;
    core.services.createServices = (opts) => {
      const svc = realCreate(opts);
      svc.verifyStone = async (id, by) => ({ status: 'match', id, by: by.name });
      svc.dismissQuestion = async (id, by) => ({ id, status: 'dismissed', by: by.name });
      return svc;
    };
    const { state } = makeState({ core, labsVerify: async () => assert.fail('the services check the stone themselves') });
    await state.start();
    assert.deepEqual(await state.verifyStone('st1'), { status: 'match', id: 'st1', by: state.personName() });
    assert.deepEqual(await state.dismissQuestion('q1'), { id: 'q1', status: 'dismissed', by: state.personName() });
  });

  test('onboarding a house locally screens it against the sanctions list', async () => {
    const { state } = makeState();
    await state.start();
    const result = await state.onboardHouse({ name: 'SAMPLE Gems Pvt Ltd', country: 'IN' });
    assert.equal(result.workspace.kind, 'local');
    assert.equal(result.screening.status, 'clear');
    assert.equal(result.invite, null);
    assert.deepEqual(await state.sanctionsStatus(), { count: 17589, date: '2026-11-02', source: 'snapshot' });
  });

  test('sending a message from a house goes to the desk', async () => {
    const { state } = makeState();
    await state.start();
    const message = await state.sendMessage({ text: 'Please check the KP certificate', shipmentId: 's1' });
    assert.equal(message.to, 'desk');
    assert.equal(message.from.type, 'person');
  });

  test('cloud: signing in opens the shared workspace with the Jewel Labs AI service', async () => {
    const core = fakeCore({ cloud: fakeCloudModule() });
    const { state, events } = makeState({ core, config: { SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'anon' } });
    await state.start();
    assert.equal(state.info().mode, 'local');
    assert.equal(state.authStatus().cloud, true);
    const status = await state.signIn({ email: 'clerk@example.com', password: 'pw' });
    assert.equal(status.signedIn, true);
    assert.equal(status.user.name, 'Sample Person');
    assert.equal(status.deskAllowed, false); // a house user cannot use the desk
    assert.equal(state.info().mode, 'cloud');
    assert.equal(state.info().ai.mode, 'proxy');
    const ai = core.lastServices.opts.ai.opts;
    assert.equal(ai.proxyUrl, 'https://example.invalid/functions/v1/ai');
    assert.equal(ai.getAccessToken(), 'token-for-tests');
    assert.ok(core.lastServices.opts.lease);
    assert.deepEqual(await state.invite('preparer'), { code: 'INVITE-1' });
    assert.ok(events.some((e) => e.name === 'auth'));
    const workspaces = await state.listWorkspaces();
    assert.deepEqual(workspaces.map((w) => w.kind), ['cloud', 'local', 'local']);

    await state.signOut();
    assert.equal(state.info().mode, 'local');
    assert.equal(state.info().ai.mode, 'off');
    await assert.rejects(state.invite('viewer'), /Sign in first/);
  });

  test('cloud: desk staff may use the desk', async () => {
    const core = fakeCore({ cloud: fakeCloudModule({ desk: true }) });
    const { state } = makeState({ core, config: { SUPABASE_URL: 'https://example.invalid' } });
    await state.start();
    await state.signIn({ email: 'desk@example.com', password: 'pw' });
    assert.equal(state.authStatus().role, 'desk');
    assert.equal(state.deskAllowed(), true);
  });

  test('without the cloud, signing in explains why', async () => {
    const { state } = makeState();
    await state.start();
    await assert.rejects(state.signIn({ email: 'a@b.co', password: 'x' }), /not set up/);
    assert.deepEqual(await state.members(), [{ name: state.personName(), email: null, role: 'owner', you: true }]);
  });

  test('stop closes the workspace', async () => {
    const { state, core, settings } = makeState();
    await state.start();
    const store = core.stores.get(settings.get().localWorkspaceId);
    await state.stop();
    assert.equal(store.closed, true);
    assert.equal(state.info().ready, false);
  });

  test('helpers: matches, newestFirst, labCheckDetail', () => {
    assert.equal(matches({ a: 1, b: 'x' }, { a: 1 }), true);
    assert.equal(matches({ a: 1 }, { a: [2, 3] }), false);
    assert.equal(matches({ a: 1 }, { a: undefined }), true);
    assert.deepEqual([{ at: '2026-01-01' }, { at: '2026-02-01' }].sort(newestFirst)[0], { at: '2026-02-01' });
    assert.match(labCheckDetail({ lab: 'IGI', reportNumber: '1' }, { status: 'mismatch', diffs: [{ field: 'carat' }] }), /differs .*: carat/);
    assert.match(labCheckDetail({ lab: 'IGI', reportNumber: '1' }, { status: 'not_found' }), /could not be confirmed/);
  });
});

// ---------------------------------------------------------------------------------------------
// ipc.js

function fakeIpcState(overrides = {}) {
  const calls = [];
  const services = {
    history: async (n) => ({ reportNumber: n }),
    answerQuestion: async (...a) => calls.push(['answerQuestion', ...a]),
    buildPapers: async (...a) => calls.push(['buildPapers', ...a]),
    signPaper: async (...a) => calls.push(['signPaper', ...a]),
    sendPaper: async (...a) => calls.push(['sendPaper', ...a]),
    run: async (q) => calls.push(['run', q]),
    ask: async (text, q) => ({ reply: `You asked: ${text}`, actions: [], q }),
    desk: { queue: async () => [], approve: async () => true, hold: async () => true },
    mail: { status: async () => ({ connected: false }) },
    folder: { status: async () => ({ path: null }) },
    metrics: async () => ({ houses: [], totals: {} }),
  };
  const state = {
    calls,
    services,
    info: () => ({ ready: true, mode: 'local' }),
    ready: async () => ({ services }),
    personName: () => 'Export clerk',
    actor: () => ({ id: 'u1', name: 'Export clerk', email: null }),
    deskAllowed: () => true,
    addFiles: async (files, kind) => {
      calls.push(['addFiles', files, kind]);
      return { documentIds: files.map((f) => f.name) };
    },
    paperFile: async () => ({ name: 'JL-EXP-1115-01-v1.pdf', mime: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) }),
    updateSettings: async (patch) => {
      calls.push(['updateSettings', patch]);
      return { saved: true };
    },
    setAutopilot: async (on) => calls.push(['setAutopilot', on]),
    autopilotOn: () => true,
    list: async (collection, q) => [{ collection, q }],
    invite: async (role) => ({ code: 'X', role }),
    ...overrides,
  };
  return state;
}

function makeHandlers({ state = fakeIpcState(), ...overrides } = {}) {
  const grants = createPathGrants();
  const opened = [];
  const shell = { openExternal: async (u) => opened.push(u), openPath: async (p) => (opened.push(p), ''), showItemInFolder: (p) => opened.push(p) };
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  };
  const handlers = createHandlers({
    state,
    appInfo: () => ({ name: 'Jewel Labs', version: '1.0.0', platform: 'darwin' }),
    dialog,
    shell,
    printer: { print: async () => ({ printed: true, pages: 1 }) },
    makeQr: async (text) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`,
    checkUpdate: async () => null,
    checkKey: async () => ({ ok: true }),
    grants,
    tempDir: tmpDir('ipc-temp'),
    documentsDir: tmpDir('ipc-docs'),
    ...overrides,
  });
  return { handlers, state, grants, opened, dialog, shell };
}

describe('ipc handlers', () => {
  test('there is one handler for every bridge method', () => {
    const { handlers } = makeHandlers();
    const bridge = Object.entries(CONTRACT).flatMap(([area, methods]) => methods.filter((m) => m !== 'pathForFile').map((m) => `${area}.${m}`));
    assert.deepEqual(Object.keys(handlers).sort(), bridge.sort());
  });

  test('runHandler turns errors into { error } and refuses unknown pages', async () => {
    assert.deepEqual(await runHandler('x', async () => 5, []), 5);
    assert.deepEqual(
      await runHandler('x', async () => {
        throw new Error('Missing shipment.');
      }, [], { log: quietLog }),
      { error: 'Missing shipment.' },
    );
    assert.deepEqual(await runHandler('x', async () => 5, [], { trusted: false }), { error: 'This page is not allowed to use the app.' });
  });

  test('toPlain keeps data and drops functions', () => {
    const bytes = new Uint8Array([1, 2]);
    const plain = toPlain({ a: 1, fn() {}, nested: { b: [1, () => 2], bytes }, when: new Date(0), err: new Error('x') });
    assert.deepEqual(plain, { a: 1, nested: { b: [1, null], bytes }, when: new Date(0), err: { error: 'x' } });
    assert.equal(toPlain(undefined), undefined);
    assert.equal(toPlain('x'), 'x');
  });

  test('registerIpc registers jl:<name> channels and checks the sender', async () => {
    const registered = {};
    const listeners = {};
    const ipcMain = { handle: (ch, fn) => (registered[ch] = fn), on: (ch, fn) => (listeners[ch] = fn) };
    const grants = createPathGrants();
    registerIpc(ipcMain, { 'app.info': async () => ({ version: '1.0.0' }) }, { isTrustedSender: (e) => e.senderFrame?.url === 'file:///app/index.html', grants, log: quietLog });
    assert.deepEqual(await registered['jl:app.info']({ senderFrame: { url: 'file:///app/index.html' } }), { version: '1.0.0' });
    assert.match((await registered['jl:app.info']({ senderFrame: { url: 'https://evil.example' } })).error, /not allowed/);
    listeners['jl:grant-path']({ senderFrame: { url: 'file:///app/index.html' } }, '/Users/x/a.pdf');
    listeners['jl:grant-path']({ senderFrame: { url: 'https://evil.example' } }, '/etc');
    assert.equal(grants.isAllowed('/Users/x/a.pdf'), true);
    assert.equal(grants.isAllowed('/etc/passwd'), false);
  });

  test('app.info merges the app and state info', async () => {
    const { handlers } = makeHandlers();
    assert.deepEqual(await handlers['app.info'](), { name: 'Jewel Labs', version: '1.0.0', platform: 'darwin', ready: true, mode: 'local' });
  });

  test('app.openExternal only opens https and mail links', async () => {
    const { handlers, opened } = makeHandlers();
    assert.equal(await handlers['app.openExternal']('https://wa.me/910000000000'), true);
    await assert.rejects(handlers['app.openExternal']('file:///etc/passwd'), /Only https/);
    assert.deepEqual(opened, ['https://wa.me/910000000000']);
  });

  test('app.qr returns a data URL', async () => {
    const { handlers } = makeHandlers();
    assert.match(await handlers['app.qr']('https://wa.me/910000000000'), /^data:image\/png;base64,/);
    assert.throws(() => handlers['app.qr'](''), /Missing text/);
  });

  test('docs.add reads granted paths, accepts bytes, refuses other paths', async () => {
    const { handlers, grants, state } = makeHandlers();
    const dir = tmpDir('ipc-add');
    const file = path.join(dir, 'invoice.pdf');
    fs.writeFileSync(file, '%PDF');
    await assert.rejects(handlers['docs.add']([{ path: file }]), /was not dropped or chosen/);
    grants.allow(file);
    const result = await handlers['docs.add']([{ path: file }, { name: '../photo.jpg', bytes: new Uint8Array([1]) }]);
    assert.deepEqual(result, { documentIds: ['_photo.jpg', 'invoice.pdf'] });
    const [, files, kind] = state.calls.find((c) => c[0] === 'addFiles');
    assert.equal(kind, 'upload');
    assert.equal(Buffer.from(files[1].bytes).toString(), '%PDF');
    await assert.rejects(handlers['docs.add']([]), /at least one file/);
    await assert.rejects(handlers['docs.add']([{ name: 'x' }]), /a path, or a name and its bytes/);
  });

  test('docs.pick adds what the person chose', async () => {
    const dir = tmpDir('ipc-pick');
    const file = path.join(dir, 'packing-list.xlsx');
    fs.writeFileSync(file, 'xlsx');
    const { handlers, dialog } = makeHandlers();
    assert.deepEqual(await handlers['docs.pick'](), { canceled: true, documentIds: [] });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    assert.deepEqual(await handlers['docs.pick'](), { documentIds: ['packing-list.xlsx'] });
  });

  test('papers.print falls back to opening the PDF', async () => {
    const { handlers, opened } = makeHandlers({
      printer: {
        print: async () => {
          throw new Error('no printer');
        },
      },
    });
    const result = await handlers['papers.print']('p1');
    assert.equal(result.printed, false);
    assert.equal(result.reason, 'no printer');
    assert.ok(result.opened.endsWith('JL-EXP-1115-01-v1.pdf'));
    assert.ok(opened.includes(result.opened));
  });

  test('papers.save writes where the person chose', async () => {
    const target = path.join(tmpDir('ipc-save'), 'pack.pdf');
    const { handlers, dialog } = makeHandlers();
    assert.deepEqual(await handlers['papers.save']('p1'), { canceled: true });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    assert.deepEqual(await handlers['papers.save']('p1'), { path: target });
    assert.equal(fs.readFileSync(target, 'utf8'), '%PDF');
  });

  test('papers.sign and papers.send check their details and pass who did it', async () => {
    const { handlers, state } = makeHandlers();
    await handlers['papers.sign']('p1', { name: 'A. Signer', title: 'Partner', signatureDataUrl: PNG_DATA_URL });
    const sign = state.calls.find((c) => c[0] === 'signPaper');
    assert.deepEqual(sign.slice(1), ['p1', { name: 'A. Signer', title: 'Partner', signatureDataUrl: PNG_DATA_URL }, { id: 'u1', name: 'Export clerk', email: null }]);
    await assert.rejects(handlers['papers.sign']('p1', { name: 'A', signatureDataUrl: 'javascript:alert(1)' }), /PNG or JPEG/);
    await assert.rejects(handlers['papers.sign']('p1', {}), /name of the person signing/);
    await handlers['papers.send']('p1', { to: 'broker@example.com, ops@example.com', subject: 'Pack' });
    assert.equal(state.calls.find((c) => c[0] === 'sendPaper')[2].to, 'broker@example.com, ops@example.com');
    await assert.rejects(handlers['papers.send']('p1', { to: 'not an email' }), /email addresses/);
  });

  test('papers.build checks the paper kinds', async () => {
    const { handlers, state } = makeHandlers();
    await handlers['papers.build']('s1', ['export_pack', 'eu_dds']);
    assert.deepEqual(state.calls.find((c) => c[0] === 'buildPapers').slice(1), ['s1', { kinds: ['export_pack', 'eu_dds'], by: { id: 'u1', name: 'Export clerk', email: null } }]);
    await assert.rejects(handlers['papers.build']('s1', ['nonsense']), /Paper kinds must be from/);
  });

  test('agents.autopilot reads and sets', async () => {
    const { handlers, state } = makeHandlers();
    assert.equal(await handlers['agents.autopilot'](), true);
    await handlers['agents.autopilot'](false);
    assert.deepEqual(state.calls.find((c) => c[0] === 'setAutopilot'), ['setAutopilot', false]);
    await assert.rejects(handlers['agents.autopilot']('off'), /true or false/);
  });

  test('desk methods are refused for house staff', async () => {
    const { handlers } = makeHandlers({ state: fakeIpcState({ deskAllowed: () => false }) });
    await assert.rejects(handlers['desk.queue'](), /Only Jewel Labs desk staff/);
    assert.throws(() => handlers['desk.onboard']({ name: 'X' }), /Only Jewel Labs desk staff/);
  });

  test('workspaces.invite allows house roles only', async () => {
    const { handlers } = makeHandlers();
    assert.deepEqual(await handlers['workspaces.invite'](), { code: 'X', role: 'preparer' });
    assert.throws(() => handlers['workspaces.invite']('desk'), /Invite someone as/);
  });

  test('settings.set checks the OpenAI key before saving it', async () => {
    let checked = null;
    const { handlers, state } = makeHandlers({ checkKey: async (k) => ((checked = k), { ok: true, warning: 'Could not reach OpenAI' }) });
    const saved = await handlers['settings.set']({ openaiKey: FAKE_OPENAI_KEY, autopilot: true });
    assert.equal(checked, FAKE_OPENAI_KEY);
    assert.deepEqual(saved, { saved: true, warning: 'Could not reach OpenAI' });
    await assert.rejects(handlers['settings.set']({ openaiKey: 'hello' }), /does not look like an OpenAI API key/);
    await assert.rejects(handlers['settings.set']({ autopilot: 'yes' }), /true or false/);
    await handlers['settings.set']({ openaiKey: null });
    assert.deepEqual(state.calls.filter((c) => c[0] === 'updateSettings').at(-1)[1], { openaiKey: null });

    const refused = makeHandlers({ checkKey: async () => ({ ok: false, reason: 'OpenAI did not accept this key.' }) });
    await assert.rejects(refused.handlers['settings.set']({ openaiKey: FAKE_OPENAI_KEY }), /did not accept/);
  });

  test('mail.connect checks the mailbox details', async () => {
    let passed = null;
    const { handlers } = makeHandlers({ state: fakeIpcState({ connectMail: async (o) => (passed = o) }) });
    await handlers['mail.connect']({ provider: 'gmail', email: 'ops@example.com', appPassword: 'pw', port: '993' });
    assert.equal(passed.port, 993);
    assert.throws(() => handlers['mail.connect']({ provider: 'gmail', email: 'ops@example.com' }), /app password/);
    assert.throws(() => handlers['mail.connect']({ provider: 'custom', email: 'a@b.co', appPassword: 'x', port: 'abc' }), /port/);
  });

  test('list handlers pass the filter on', async () => {
    const { handlers } = makeHandlers();
    assert.deepEqual(await handlers['questions.list']({ status: 'open' }), [{ collection: 'questions', q: { status: 'open' } }]);
    assert.deepEqual(await handlers['activity.list'](), [{ collection: 'activity', q: {} }]);
    assert.throws(() => handlers['docs.list']('x'), /Missing filter/);
  });

  test('agents.ask and stones.history reach the services', async () => {
    const { handlers } = makeHandlers();
    assert.equal((await handlers['agents.ask']('What is still missing?', { shipmentId: 's1' })).reply, 'You asked: What is still missing?');
    assert.deepEqual(await handlers['stones.history']('7451234567'), { reportNumber: '7451234567' });
  });
});

// ---------------------------------------------------------------------------------------------
// labs-window.js, rasterize.js and print.js with fake windows

describe('lab report check window', () => {
  const labs = {
    detectLab: (n, hint) => hint || (n.startsWith('LG') ? 'IGI' : 'GIA'),
    reportCheckUrl: (lab, n) => (lab === 'GCAL' ? null : `https://example.invalid/${lab}/${n}`),
    parseLabPage: (_lab, text) => {
      if (text.includes('REPORT 7451234567')) return { found: true, reportNumber: '7451234567', carat: 0.71 };
      return { found: false, reason: text.includes('No such report') ? 'not_found' : 'no_result' };
    },
    compareLab: (stone, parsed) => (stone.carat === parsed.carat ? { status: 'match', diffs: [] } : { status: 'mismatch', diffs: [{ field: 'carat', ours: stone.carat, lab: parsed.carat }] }),
  };

  function fakeWindowClass(pages) {
    return class FakeWindow {
      static last = null;
      constructor(opts) {
        this.opts = opts;
        this.destroyed = false;
        this.pages = [...pages];
        this.listeners = {};
        this.webContents = {
          setWindowOpenHandler: (fn) => (this.openHandler = fn),
          mainFrame: {
            framesInSubtree: [{ executeJavaScript: async () => (this.pages.length > 1 ? this.pages.shift() : this.pages[0]) }],
          },
        };
        FakeWindow.last = this;
      }
      on(name, fn) {
        this.listeners[name] = fn;
      }
      loadURL(url) {
        this.url = url;
        return Promise.resolve();
      }
      isDestroyed() {
        return this.destroyed;
      }
      close() {
        this.destroyed = true;
      }
    };
  }

  test('waits for the report, compares it and closes the window', async () => {
    const BrowserWindow = fakeWindowClass(['', 'Checking your browser...', 'GIA REPORT 7451234567 0.71 carat']);
    const verify = createLabsVerify({ BrowserWindow, labs, pollMs: 1, timeoutMs: 2000 });
    const result = await verify({ reportNumber: '7451234567', lab: 'GIA', carat: 0.71 });
    assert.equal(result.status, 'match');
    assert.equal(result.url, 'https://example.invalid/GIA/7451234567');
    const win = BrowserWindow.last;
    assert.equal(win.opts.title, 'Checking GIA report 7451234567');
    assert.equal(win.opts.width, 900);
    assert.equal(win.opts.webPreferences.sandbox, true);
    assert.equal(win.opts.webPreferences.preload, undefined);
    assert.deepEqual(win.openHandler(), { action: 'deny' });
    assert.equal(win.destroyed, true);
  });

  test('uses the URL the services pass and returns the page text', async () => {
    const BrowserWindow = fakeWindowClass(['GIA REPORT 7451234567 0.71']);
    const verify = createLabsVerify({ BrowserWindow, labs, pollMs: 1 });
    const result = await verify({ lab: 'GIA', reportNumber: '7451234567', url: 'https://example.invalid/report-check?r=7451234567' });
    assert.equal(BrowserWindow.last.url, 'https://example.invalid/report-check?r=7451234567');
    assert.equal(result.text, 'GIA REPORT 7451234567 0.71');
    assert.equal(result.parsed.found, true);
  });

  test('stops when the lab says twice that there is no such report', async () => {
    const BrowserWindow = fakeWindowClass(['No such report', 'No such report']);
    const verify = createLabsVerify({ BrowserWindow, labs, pollMs: 1, timeoutMs: 5000 });
    const started = Date.now();
    const result = await verify({ lab: 'GIA', reportNumber: '1234567890', carat: 0.5 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.parsed.reason, 'not_found');
    assert.equal(result.text, 'No such report');
  });

  test('reports a mismatch', async () => {
    const BrowserWindow = fakeWindowClass(['GIA REPORT 7451234567']);
    const verify = createLabsVerify({ BrowserWindow, labs, pollMs: 1 });
    const result = await verify({ reportNumber: '7451234567', lab: 'GIA', carat: 0.7 });
    assert.equal(result.status, 'mismatch');
  });

  test('gives up after the timeout, or when there is no online check', async () => {
    const BrowserWindow = fakeWindowClass(['still loading']);
    const verify = createLabsVerify({ BrowserWindow, labs, pollMs: 1, timeoutMs: 30 });
    const late = await verify({ reportNumber: '7451234567', lab: 'GIA', carat: 0.71 });
    assert.equal(late.status, 'not_found');
    assert.match(late.reason, /did not show within/);
    const none = await verify({ reportNumber: '123', lab: 'GCAL' });
    assert.match(none.reason, /no online report check/);
    const noNumber = await verify({ lab: 'GIA' });
    assert.match(noNumber.reason, /no report number/);
  });
});

// A window whose page is a fake `window.raster`: executeJavaScript evaluates the call against it.
function fakeRasterWindowClass({ printResult = [true, ''] } = {}) {
  return class FakeRasterWindow {
    static created = 0;
    static loads = 0;
    constructor(opts) {
      FakeRasterWindow.created += 1;
      this.opts = opts;
      this.destroyed = false;
      const loaded = new Set();
      const raster = {
        has: (key) => loaded.has(key),
        load: (key, b64) => {
          FakeRasterWindow.loads += 1;
          assert.ok(b64.length > 0);
          loaded.add(key);
          return 2;
        },
        render: (key, page, scale) => {
          assert.ok(loaded.has(key));
          assert.equal(scale, 2);
          if (page > 2) throw new Error('The PDF has 2 pages, not 3.');
          return PNG_DATA_URL;
        },
        showAll: () => 2,
      };
      this.webContents = {
        executeJavaScript: async (code) => new Function('window', `return ${code}`)({ raster }),
        print: (_opts, callback) => callback(...printResult),
      };
    }
    loadFile(file) {
      this.file = file;
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  };
}

describe('rasterize', () => {
  test('draws a page to PNG bytes and reuses the loaded PDF', async () => {
    const BrowserWindow = fakeRasterWindowClass();
    const { rasterize, close } = createRasterizer({ BrowserWindow, htmlPath: '/app/rasterize.html', wasmDir: '/app/wasm', idleMs: 5 });
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
    const png = await rasterize(pdf, 1);
    assert.ok(png instanceof Uint8Array);
    assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    await rasterize(pdf, 2);
    assert.equal(BrowserWindow.created, 1);
    assert.equal(BrowserWindow.loads, 1);
    await assert.rejects(rasterize(pdf, 3), /2 pages, not 3/);
    await assert.rejects(rasterize(new Uint8Array(), 1), /bytes of a PDF/);
    await assert.rejects(rasterize(pdf, 0), /start at 1/);
    close();
  });

  test('dataUrlToBytes and wasmUrlFor', () => {
    assert.equal(dataUrlToBytes(PNG_DATA_URL).length, Buffer.from(PNG_B64, 'base64').length);
    assert.throws(() => dataUrlToBytes('data:text/plain,hi'), /could not be drawn/);
    assert.equal(wasmUrlFor(null), null);
    assert.match(wasmUrlFor(path.join(tmpRoot, 'wasm')), /^file:\/\/.*wasm\/$/);
  });

  test('the hidden page loads the vendored pdf.js', () => {
    const html = fs.readFileSync(path.join(MAIN_DIR, 'rasterize.html'), 'utf8');
    const page = fs.readFileSync(path.join(MAIN_DIR, 'rasterize-page.mjs'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /src="rasterize-page.mjs"/);
    assert.match(page, /\.\.\/renderer\/vendor\/pdfjs\/pdf\.mjs/);
    assert.ok(fs.existsSync(path.join(MAIN_DIR, '..', 'renderer', 'vendor', 'pdfjs', 'pdf.mjs')));
  });
});

describe('print', () => {
  test('prints, reports a cancel, and throws on failure', async () => {
    const ok = createPrinter({ BrowserWindow: fakeRasterWindowClass({ printResult: [true, ''] }), htmlPath: '/app/rasterize.html' });
    assert.deepEqual(await ok.print(new Uint8Array([1, 2, 3])), { printed: true, pages: 2 });
    const cancelled = createPrinter({ BrowserWindow: fakeRasterWindowClass({ printResult: [false, 'cancelled'] }), htmlPath: '/x' });
    assert.deepEqual(await cancelled.print(new Uint8Array([1])), { printed: false, cancelled: true, pages: 2 });
    const failed = createPrinter({ BrowserWindow: fakeRasterWindowClass({ printResult: [false, 'failed'] }), htmlPath: '/x' });
    await assert.rejects(failed.print(new Uint8Array([1])), /Printing did not work \(failed\)/);
  });
});
