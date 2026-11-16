// The main window, and the rules that keep it safe: it only shows our own screens, links open in the
// default browser, and it never opens other windows. Electron is passed in, so this file has no
// Electron import of its own.
//
// The screens are served from app://jewel-labs/ (main.js registers the scheme), not from file://. On a file://
// page Chromium counts every file on the disk as 'self', so the page's Content-Security-Policy would let a
// script from anywhere on the computer run; app://jewel-labs/ only ever serves the renderer folder. The hidden
// pdf.js page (rasterize.html) is served from app://pages/ the same way.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSafeExternalUrl } from './validate.js';

export const WINDOW_SIZE = { width: 1440, height: 900, minWidth: 1100, minHeight: 700 };
export const APP_SCHEME = 'app';
export const APP_ORIGIN = 'app://jewel-labs'; // the screens
export const PAGES_ORIGIN = 'app://pages'; // the hidden pdf.js page that draws and prints PDF pages

// True for our own pages: pages of the given origins (app://jewel-labs), files inside the given folders,
// or one of the given files.
export function makeAppUrlCheck({ origins = [], dirs = [], files = [] }) {
  const prefixes = [...origins.map((o) => `${o.replace(/\/$/, '')}/`), ...dirs.map((d) => pathToFileURL(d).href.replace(/\/?$/, '/'))];
  const exact = files.map((f) => pathToFileURL(f).href);
  return (url) => {
    if (typeof url !== 'string') return false;
    const bare = url.split(/[?#]/)[0];
    return prefixes.some((p) => bare.startsWith(p)) || exact.includes(bare);
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/**
 * The app:// handler (protocol.handle). sites maps each host to what it serves: { '/folder/': dir } serves the
 * files inside dir, { '/file.html': file } serves that one file. Anything else (an unknown host, a path that
 * climbs out of its folder, a missing file) is a 404.
 *   createAppProtocolHandler({ sites: { 'jewel-labs': { '/': rendererDir } } })
 */
export function createAppProtocolHandler({ sites, readFile = (file) => fs.readFile(file) }) {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return async function serve(request) {
    let url;
    let pathname;
    try {
      url = new URL(request.url);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound(); // not an address, or a broken %-escape
    }
    const mounts = url.protocol === `${APP_SCHEME}:` ? sites[url.host] : null;
    const file = mounts ? fileFor(mounts, pathname) : null;
    if (!file) return notFound();
    try {
      const bytes = await readFile(file);
      return new Response(bytes, { headers: { 'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return notFound();
    }
  };
}

// The file an address path names, or null. The longest mount wins; a folder never lets the path climb out of it.
function fileFor(mounts, pathname) {
  for (const [mount, target] of Object.entries(mounts).sort((a, b) => b[0].length - a[0].length)) {
    if (!target) continue;
    if (!mount.endsWith('/')) {
      if (pathname === mount) return target;
      continue;
    }
    if (!pathname.startsWith(mount)) continue;
    const root = path.resolve(target);
    const file = path.resolve(root, `./${pathname.slice(mount.length)}`);
    return file.startsWith(root + path.sep) ? file : null;
  }
  return null;
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
  indexUrl, // app://jewel-labs/index.html
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

  win.loadURL(indexUrl).catch(() => {}); // failures are handled by did-fail-load above
  return win;
}
