// The app menu: Jewel Labs (About, Check for updates, Quit), Edit, View, Window.
// Reload and developer tools are only there while developing.

export function appMenuTemplate({ appName = 'Jewel Labs', platform = process.platform, isDev = false, onAbout, onCheckUpdates }) {
  const isMac = platform === 'darwin';
  const appMenu = {
    label: appName,
    submenu: [
      { label: `About ${appName}`, click: onAbout },
      { label: 'Check for updates…', click: onCheckUpdates },
      { type: 'separator' },
      ...(isMac ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] : []),
      { role: 'quit', label: `Quit ${appName}` },
    ],
  };
  const viewMenu = {
    label: 'View',
    submenu: [
      ...(isDev ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  return [appMenu, { role: 'editMenu' }, viewMenu, { role: 'windowMenu' }];
}

export function buildAppMenu({ Menu, ...options }) {
  return Menu.buildFromTemplate(appMenuTemplate(options));
}
