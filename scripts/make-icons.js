// Draws the app and tray icons from assets/logo.svg with a headless browser (Playwright's Chromium).
// Run it after changing the logo:   node scripts/make-icons.js
//
//   build/icon.png                  1024x1024 Mac app icon: the logo on its own dark rounded square,
//                                   824 px wide in the middle, as Apple's icon grid expects
//   build/icon-win.png              1024x1024 Windows app icon: the same square, filling the picture
//   assets/icons/icon.png           512x512 copy used by the running app (About panel, Windows window icon)
//   assets/icons/trayTemplate.png   16x16 and @2x 32x32: the diamond mark only, black on transparent
//                                   (macOS tints "Template" images for light and dark menu bars)
//   assets/icons/tray.png           16x16 and @2x 32x32: the white mark, for dark Windows taskbars
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'), 'utf8');

// The mark is the <g> group of the logo (outer diamond, inner diamond, four lines), without the square.
const mark = logo.match(/<g[\s\S]*<\/g>/)?.[0];
if (!mark) throw new Error('assets/logo.svg has no <g> group with the diamond mark.');

// The mark alone, for a tiny icon of `size` pixels with lines `linePx` pixels wide.
// The mark spans 4..28 in the logo's 32-unit box; the view leaves room for the line so the points
// are not cut off. A 1-pixel line only looks sharp on a pixel's centre, so odd widths shift by half a pixel.
function markSvg(color, size, linePx) {
  const box = 26.8;
  const unit = box / size; // logo units per pixel
  const start = (2.6 - (linePx % 2 === 1 ? unit / 2 : 0)).toFixed(3);
  const group = mark
    .replace(/stroke="[^"]*"/, `stroke="${color}"`)
    .replace(/stroke-width="[^"]*"/, `stroke-width="${(linePx * unit).toFixed(3)}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${start} ${start} ${box} ${box}">${group}</svg>`;
}

function dataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Draws an SVG at `inner` pixels in the middle of a transparent `size` x `size` canvas and saves a PNG.
async function draw(page, svg, size, inner, file) {
  await page.setViewportSize({ width: size, height: size });
  const offset = (size - inner) / 2;
  await page.setContent(
    `<html><body style="margin:0;background:transparent">
       <img src="${dataUrl(svg)}" style="position:absolute;left:${offset}px;top:${offset}px;width:${inner}px;height:${inner}px">
     </body></html>`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
}

// A headless Chromium already in Playwright's download folder, for when this Playwright version's own
// browser has not been downloaded (npx playwright install). Any recent version draws SVG the same way.
function cachedHeadlessShell() {
  const home = os.homedir();
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? path.join(home, 'AppData', 'Local', 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright'));
  if (!fs.existsSync(cache)) return null;
  const versions = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const version of versions) {
    for (const build of fs.readdirSync(path.join(cache, version)).filter((d) => d.startsWith('chrome-headless-shell-'))) {
      const exe = path.join(cache, version, build, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    const exe = cachedHeadlessShell();
    if (!exe) throw error;
    console.log(`using the Chromium found at ${exe}`);
    return chromium.launch({ executablePath: exe });
  }
}

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await draw(page, logo, 1024, 824, path.join(ROOT, 'build', 'icon.png'));
  await draw(page, logo, 1024, 1024, path.join(ROOT, 'build', 'icon-win.png'));
  await draw(page, logo, 512, 512, path.join(ROOT, 'assets', 'icons', 'icon.png'));
  // Tray icons: 1-pixel lines at 16 px, 2-pixel lines at 32 px (the same look on a sharper screen).
  await draw(page, markSvg('#000000', 16, 1), 16, 16, path.join(ROOT, 'assets', 'icons', 'trayTemplate.png'));
  await draw(page, markSvg('#000000', 32, 2), 32, 32, path.join(ROOT, 'assets', 'icons', 'trayTemplate@2x.png'));
  await draw(page, markSvg('#ffffff', 16, 1), 16, 16, path.join(ROOT, 'assets', 'icons', 'tray.png'));
  await draw(page, markSvg('#ffffff', 32, 2), 32, 32, path.join(ROOT, 'assets', 'icons', 'tray@2x.png'));
} finally {
  await browser.close();
}
