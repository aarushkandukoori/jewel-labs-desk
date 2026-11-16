// Jewel Labs desktop app: the Electron main process.
// It opens the window, keeps the tray icon and the menu, and runs the agents (services) for the open
// workspace. Workspace and data logic live in state.js; the bridge to the screens is ipc.js + preload.cjs.
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  nativeTheme,
  nativeImage,
  screen,
  session,
} from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import * as config from '../core/config.js';
import { createLog } from './log.js';
import { createSettings } from './settings.js';
import { createSecrets } from './secrets.js';
import { createAppState } from './state.js';
import { createHandlers, registerIpc, toPlain } from './ipc.js';
import { createMainWindow, makeAppUrlCheck } from './window.js';
import { buildAppMenu } from './menu.js';
import { createTray } from './tray.js';
import { createNotifier } from './notify.js';
import { createRasterizer } from './rasterize.js';
import { createPrinter } from './print.js';
import { createLabsVerify } from './labs-window.js';
import { checkForUpdate } from './updates.js';
import { checkOpenAIKey } from './openai-key.js';
import { createPathGrants } from './files.js';
import { isSafeExternalUrl } from './validate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(HERE, '..', 'renderer');
const INDEX_FILE = path.join(RENDERER_DIR, 'index.html');
const FALLBACK_FILE = path.join(HERE, 'fallback.html');
const PAGES_FILE = path.join(HERE, 'rasterize.html');
const ICONS_DIR = path.join(config.ASSETS_DIR, 'icons');
const IS_E2E = process.env.JL_E2E === '1';
const IS_DEV = !app.isPackaged;
const LOGIN_ARGS = ['--hidden']; // Windows: started at login, so start quietly in the tray
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

const log = createLog();
const isAppUrl = makeAppUrlCheck({ dirs: [RENDERER_DIR], files: [FALLBACK_FILE] });

let mainWindow = null;
let tray = null;
let state = null;
let settings = null;
let notifier = null;
let quitting = false;
let cleanedUp = false;

// Tests (and developers) can keep the app's data in a separate folder.
if (process.env.JL_USER_DATA || IS_E2E) {
  app.setPath('userData', process.env.JL_USER_DATA || path.join(os.tmpdir(), 'jewel-labs-e2e'));
}
if (process.platform === 'win32') app.setAppUserModelId('io.jewellabs.desk'); // Windows notifications need it
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection:', reason));

// One copy of the app at a time: opening it again brings the first window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow()); // macOS: the Dock icon was clicked
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', onWillQuit);
  app.on('window-all-closed', () => {}); // closing the main window decides what happens (onWindowClosed)
  app.on('web-contents-created', (_event, contents) => {
    // Every window, including hidden ones: no embedded browsers, and links go to the default browser.
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  app.whenReady().then(startApp).catch((error) => {
    log.error('Jewel Labs could not start:', error);
    dialog.showErrorBox('Jewel Labs could not start', error.message);
    app.exit(1);
  });
}

async function startApp() {
  nativeTheme.themeSource = 'dark'; // dark title bar on Windows, dark menus and dialogs everywhere
  const userData = app.getPath('userData');
  const ownDataFolder = Boolean(process.env.JL_USER_DATA || IS_E2E);
  log.setFile(path.join(ownDataFolder ? path.join(userData, 'logs') : app.getPath('logs'), 'main.log'));
  log.info(`Starting Jewel Labs ${app.getVersion()} on ${process.platform} ${process.arch}, Electron ${process.versions.electron}`);

  const paths = {
    userData,
    localDir: path.join(userData, 'local-workspaces'),
    cacheDir: path.join(userData, 'cache'),
    tempDir: path.join(app.getPath('temp'), 'jewel-labs'),
    samplesDir: config.SAMPLES_DIR,
    assetsDir: config.ASSETS_DIR,
  };
  settings = createSettings({ file: path.join(userData, 'settings.json') });
  const secrets = createSecrets({ file: path.join(userData, 'secrets.json'), safeStorage });
  const grants = createPathGrants();
  notifier = createNotifier({
    Notification,
    sendEvent,
    isWindowFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
    isEnabled: () => !IS_E2E && settings.get().notifications !== false,
    onClick: () => showWindow(),
  });
  const wasmDir = pdfjsWasmDir();
  const rasterizer = createRasterizer({ BrowserWindow, htmlPath: PAGES_FILE, wasmDir });
  const printer = createPrinter({ BrowserWindow, htmlPath: PAGES_FILE, wasmDir });
  const core = await loadCore();

  state = createAppState({
    core,
    config,
    paths,
    settings,
    secrets,
    sendEvent,
    notify: notifier.notify,
    rasterize: rasterizer.rasterize,
    labsVerify: core.labs ? createLabsVerify({ BrowserWindow, labs: core.labs, session }) : null,
    devApiKey: IS_DEV && !IS_E2E ? process.env.OPENAI_API_KEY || null : null, // a developer's own key, never in tests
    system: {
      setLaunchAtLogin,
      getLaunchAtLogin,
      onAutopilotChange: (on) => {
        tray?.refresh();
        sendEvent('sync', { reason: 'autopilot', autopilot: on });
      },
    },
    log,
  });

  // Our pages may copy, paste and go full screen; nothing else (camera, location ...).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  const handlers = createHandlers({
    state,
    appInfo,
    dialog,
    shell,
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    printer,
    makeQr: (text) => QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M' }),
    checkUpdate: () => checkForUpdate({ currentVersion: app.getVersion() }),
    checkKey: (key) => checkOpenAIKey(key),
    grants,
    tempDir: paths.tempDir,
    documentsDir: app.getPath('documents'),
  });
  registerIpc(ipcMain, handlers, { isTrustedSender: (event) => isAppUrl(event.senderFrame?.url), grants, log });

  Menu.setApplicationMenu(
    buildAppMenu({
      Menu,
      appName: config.APP_NAME,
      platform: process.platform,
      isDev: IS_DEV,
      onAbout: () => app.showAboutPanel(),
      onCheckUpdates: () => checkUpdatesFromMenu(),
    }),
  );
  app.setAboutPanelOptions({
    applicationName: config.APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Jewel Labs',
    website: config.SITE_URL,
    iconPath: path.join(ICONS_DIR, 'icon.png'),
  });
  if (IS_DEV && process.platform === 'darwin') {
    const devIcon = path.join(config.ROOT_DIR, 'build', 'icon.png'); // the packaged app gets its icon from the build
    if (fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  }

  // Started at login with autopilot on: stay in the tray and let the agents work.
  mainWindow = openMainWindow({ show: !(openedAtLogin() && state.autopilotOn()) });
  tray = makeTray();

  state.start().catch((error) => {
    if (!core.error) log.error('The agents did not start:', error); // a core load error was logged above
    sendEvent('sync', { reason: 'error', message: error.message });
  });

  if (IS_E2E) globalThis.__jlTest = { rasterize: rasterizer.rasterize, info: () => ({ ...appInfo(), ...state.info() }), quit: () => app.quit() };
}

// The core modules (src/core) are loaded here rather than imported at the top, so a broken core file
// shows a clear message in the window instead of stopping the app before it opens.
async function loadCore() {
  const imports = Promise.all([
    import('../core/store/index.js'),
    import('../core/ai/index.js'),
    import('../core/sanctions/index.js'),
    import('../core/ocr/index.js'),
    import('../core/labs/index.js'),
    import('../core/services.js'),
    config.SUPABASE_URL ? import('../core/store/cloud.js') : null,
  ]);
  let timer;
  const tooSlow = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Loading the agents took longer than 30 seconds.')), 30000);
  });
  try {
    const [store, ai, sanctions, ocr, labs, services, cloud] = await Promise.race([imports, tooSlow]);
    return { store, ai, sanctions, ocr, labs, services, cloud };
  } catch (error) {
    log.error('The app could not load its agents:', error);
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

function appInfo() {
  return {
    name: config.APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isDev: IS_DEV,
    e2e: IS_E2E,
    locale: app.getLocale(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    logFile: log.file,
    site: config.SITE_URL,
    repo: config.GITHUB_REPO,
  };
}

// Sends a live event to the screens (jl.on in preload.cjs).
function sendEvent(name, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('jl:event', { name, payload: toPlain(payload) });
  } catch (error) {
    log.warn(`Could not send the ${name} event:`, error.message);
  }
}

function openMainWindow({ show = true } = {}) {
  const win = createMainWindow({
    BrowserWindow,
    Menu,
    screen,
    preload: path.join(HERE, 'preload.cjs'),
    indexFile: INDEX_FILE,
    fallbackFile: FALLBACK_FILE,
    isAppUrl,
    openExternal: (url) => shell.openExternal(url),
    savedBounds: settings.get().windowBounds,
    icon: path.join(ICONS_DIR, 'icon.png'),
    platform: process.platform,
    show,
    log,
  });
  win.on('close', (event) => onWindowClose(event, win));
  win.on('closed', () => onWindowClosed(win));
  return win;
}

function showWindow() {
  if (!state) return; // still starting; the window opens on its own
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = openMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function onWindowClose(event, win) {
  settings.set({ windowBounds: win.getNormalBounds() }); // reopen at the same size and place
  if (quitting || !tray || !state.autopilotOn()) return; // a real close
  event.preventDefault(); // autopilot is on: hide the window, the agents keep working
  win.hide();
  tellOnceAboutTray();
}

function onWindowClosed(win) {
  if (mainWindow === win) mainWindow = null;
  // With autopilot off, closing the window ends the app on Windows. A Mac app stays in the Dock.
  if (!quitting && process.platform !== 'darwin') app.quit();
}

function tellOnceAboutTray() {
  if (IS_E2E || settings.get().toldAboutTray) return;
  settings.set({ toldAboutTray: true });
  const where = process.platform === 'darwin' ? 'the menu bar' : 'the system tray';
  const body = `Autopilot is on, so the agents keep reading new papers. Open Jewel Labs from ${where}.`;
  if (Notification.isSupported()) new Notification({ title: 'Jewel Labs is still running', body }).show();
  else dialog.showMessageBox({ type: 'info', message: 'Jewel Labs is still running', detail: body });
}

function makeTray() {
  try {
    return createTray({
      Tray,
      Menu,
      nativeImage,
      nativeTheme,
      iconsDir: ICONS_DIR,
      platform: process.platform,
      getAutopilot: () => state.autopilotOn(),
      onOpen: () => showWindow(),
      onToggleAutopilot: (on) => state.setAutopilot(on).catch((e) => log.warn('Autopilot did not change:', e.message)),
      onCheckMail: () => checkMailFromTray(),
      onQuit: () => app.quit(),
    });
  } catch (error) {
    log.warn('No tray icon on this system:', error.message); // closing the window then quits the app
    return null;
  }
}

async function checkMailFromTray() {
  try {
    await state.pollMail();
  } catch (error) {
    notifier.notify({ title: 'Mail was not checked', body: error.message });
  }
}

async function checkUpdatesFromMenu() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const show = (options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  try {
    const update = await checkForUpdate({ currentVersion: app.getVersion() });
    if (!update) {
      await show({ type: 'info', message: 'You have the latest version.', detail: `Jewel Labs ${app.getVersion()}` });
      return;
    }
    const { response } = await show({
      type: 'info',
      message: `Jewel Labs ${update.latest} is ready to download.`,
      detail: 'Download it and install it over this copy. Your workspaces stay as they are.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(update.download || update.url);
  } catch (error) {
    log.warn('Update check failed:', error.message);
    await show({ type: 'warning', message: 'Could not check for updates.', detail: 'Check the internet connection and try again.' });
  }
}

function loginItemOptions() {
  return process.platform === 'win32' ? { args: LOGIN_ARGS } : undefined;
}

function setLaunchAtLogin(on) {
  if (IS_E2E) return;
  app.setLoginItemSettings({ openAtLogin: on, ...loginItemOptions() });
}

function getLaunchAtLogin() {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function openedAtLogin() {
  try {
    if (process.platform === 'darwin') return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
    return process.argv.includes(LOGIN_ARGS[0]);
  } catch {
    return false;
  }
}

// pdf.js image decoders. The installed app keeps pdfjs-dist outside app.asar (see electron-builder.yml).
function pdfjsWasmDir() {
  const dir = path.join(config.ROOT_DIR, 'node_modules', 'pdfjs-dist', 'wasm');
  const unpacked = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : null;
}

// Quitting: the windows are closed by now. Stop the agents and save the workspace (at most a few
// seconds), then exit. app.exit, not app.quit: a second quit after this pause is not reliable.
function onWillQuit(event) {
  if (cleanedUp || !state) return;
  event.preventDefault();
  cleanedUp = true;
  log.info('Quitting: stopping the agents');
  const giveUp = new Promise((resolve) => setTimeout(resolve, 4000));
  Promise.race([state.stop(), giveUp])
    .catch((error) => log.warn('Stopping took a wrong turn:', error.message))
    .finally(() => {
      log.info('Stopped; quitting now');
      tray?.destroy();
      app.exit(0);
    });
}
