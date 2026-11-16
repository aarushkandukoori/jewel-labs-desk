// The main window, and the rules that keep it safe: it only shows our own screens, links open in the
// default browser, and it never opens other windows. Electron is passed in, so this file has no
// Electron import of its own.
import { pathToFileURL } from 'node:url';
import { isSafeExternalUrl } from './validate.js';

export const WINDOW_SIZE = { width: 1440, height: 900, minWidth: 1100, minHeight: 700 };

// True for our own pages: files inside the given folders, or one of the given files.
export function makeAppUrlCheck({ dirs = [], files = [] }) {
  const prefixes = dirs.map((d) => pathToFileURL(d).href.replace(/\/?$/, '/'));
  const exact = files.map((f) => pathToFileURL(f).href);
  return (url) => {
    if (typeof url !== 'string') return false;
    const bare = url.split(/[?#]/)[0];
    return prefixes.some((p) => bare.startsWith(p)) || exact.includes(bare);
  };
}

// The saved window position, if it still fits on one of the screens (a monitor may be gone).
export function boundsThatFit(saved, displays) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null;
  const visible = displays.some(({ workArea: a }) => {
    const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    return w >= 200 && h >= 100;
  });
  return visible ? saved : null;
}

// Links never navigate the app away from its screens and never open new windows.
export function guardContents(contents, { isAppUrl, openExternal }) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(event.url)) openExternal(event.url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

// Right-click menu: spelling suggestions, cut, copy, paste.
export function contextMenuTemplate(params, contents) {
  const items = [];
  for (const word of params.dictionarySuggestions || []) {
    items.push({ label: word, click: () => contents.replaceMisspelling(word) });
  }
  if (items.length) items.push({ type: 'separator' });
  if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  else if (params.selectionText) items.push({ role: 'copy' });
  return items;
}

export function createMainWindow({
  BrowserWindow,
  Menu,
  screen,
  preload,
  indexFile,
  fallbackFile,
  isAppUrl,
  openExternal,
  savedBounds = null,
  icon = undefined,
  platform = process.platform,
  show = true,
  log = console,
}) {
  const work = screen.getPrimaryDisplay().workAreaSize;
  const size = { width: Math.min(WINDOW_SIZE.width, work.width), height: Math.min(WINDOW_SIZE.height, work.height) };
  const win = new BrowserWindow({
    ...(boundsThatFit(savedBounds, screen.getAllDisplays()) || size),
    minWidth: WINDOW_SIZE.minWidth,
    minHeight: WINDOW_SIZE.minHeight,
    show: false,
    title: 'Jewel Labs',
    backgroundColor: '#000000',
    // On a Mac the screens draw their own top bar; jl.app.info().platform tells them to leave room
    // for the window buttons. Windows keeps its normal (dark) title bar and hides the menu bar until Alt.
    ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true, icon }),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  guardContents(win.webContents, { isAppUrl, openExternal });
  win.webContents.on('context-menu', (_event, params) => {
    const items = contextMenuTemplate(params, win.webContents);
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Show once the first screen is drawn (no white flash). If that never comes, show anyway.
  win.once('ready-to-show', () => show && win.show());
  setTimeout(() => {
    if (show && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 6000).unref?.();

  // The screens are missing or broken: show a short page that says how to fix it.
  const indexUrl = pathToFileURL(indexFile).href;
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !String(url).startsWith(indexUrl)) return; // -3: a reload cut short
    log.error('The screens did not load:', description, url);
    win.loadFile(fallbackFile).catch(() => {});
  });

  // If the screens crash, reload them (a few times at most).
  let crashes = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    log.error('The window stopped:', details.reason);
    crashes += 1;
    if (crashes <= 3) setTimeout(() => !win.isDestroyed() && win.reload(), 1000);
  });

  win.loadFile(indexFile).catch(() => {}); // failures are handled by did-fail-load above
  return win;
}
