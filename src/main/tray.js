// The tray icon (menu bar on a Mac, system tray on Windows). It keeps the agents within reach while
// the window is closed and autopilot keeps working.
import path from 'node:path';

// Which picture to use. macOS tints "Template" images for light and dark menu bars by itself.
// On Windows the white mark suits a dark taskbar and the black one a light taskbar.
export function trayIconFile(iconsDir, platform, darkTaskbar = true) {
  if (platform === 'darwin') return path.join(iconsDir, 'trayTemplate.png');
  return path.join(iconsDir, darkTaskbar ? 'tray.png' : 'trayTemplate.png');
}

export function trayMenuTemplate({ autopilot, onOpen, onToggleAutopilot, onCheckMail, onQuit }) {
  return [
    { label: 'Open Jewel Labs', click: onOpen },
    { type: 'separator' },
    { label: `Autopilot: ${autopilot ? 'On' : 'Off'}`, type: 'checkbox', checked: autopilot, click: () => onToggleAutopilot(!autopilot) },
    { label: 'Check mail now', click: onCheckMail },
    { type: 'separator' },
    { label: 'Quit', click: onQuit },
  ];
}

export function createTray({ Tray, Menu, nativeImage, nativeTheme, iconsDir, platform = process.platform, getAutopilot, onOpen, onToggleAutopilot, onCheckMail, onQuit }) {
  const image = () => nativeImage.createFromPath(trayIconFile(iconsDir, platform, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI));
  const tray = new Tray(image());
  tray.setToolTip('Jewel Labs');

  function refresh() {
    const template = trayMenuTemplate({ autopilot: getAutopilot(), onOpen, onToggleAutopilot, onCheckMail, onQuit });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  if (platform !== 'darwin') tray.on('click', onOpen); // Windows: left click opens, right click shows the menu
  if (platform === 'win32') nativeTheme.on('updated', () => tray.setImage(image())); // taskbar went light or dark
  refresh();

  return { refresh, destroy: () => tray.destroy() };
}
