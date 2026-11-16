// Tests for the website: the build script (scripts/build-site.js), the small pure helpers in
// site/js, and the page content rules (copy, links, agents, image sizes, no secrets).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSite, checkAppImports } from '../../scripts/build-site.js';
import {
  BRILLIANT, ROUGH, brilliantCut, edgePositions, makeRandom, pointAt, roughCrystal, seedPoints, sortByHeight,
} from '../../site/js/diamond-geometry.js';
import {
  INSTALLERS, RELEASES_API, detectSystem, downloadUrl, formatSize, heroButtons, macChipFromGpu, matchingCard,
  pickRelease, summarizeRelease, versionLabel,
} from '../../site/js/downloads.js';
import { nextCheck } from '../../site/js/team.js';
import { countReached, railProgress } from '../../site/js/history.js';
import { VARIANTS } from '../../site/js/statement.js';
import { AGENTS } from '../../src/core/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = path.join(ROOT, 'site');
const HTML = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

/* ───────── helpers ───────── */

const tempDirs = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jl-site-${name}-`));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A tiny fake repository with just what the build reads. */
function fakeRepo() {
  const root = tempDir('repo');
  write(root, 'site/index.html', '<html><body><section id="watch" data-video="pending" data-video-src="media/demo.mp4" data-video-poster="media/demo-poster.jpg"></section></body></html>');
  write(root, 'site/css/site.css', 'body { color: white; }');
  write(root, 'site/.DS_Store', 'junk');
  write(root, 'src/renderer/fonts/Geist-Medium.woff2', 'font bytes');
  write(root, 'src/renderer/fonts/notes.txt', 'not a font');
  write(root, 'src/renderer/index.html', '<link rel="stylesheet" href="styles/app.css"><script type="module" src="app.js"></script>');
  write(root, 'src/renderer/styles/app.css', 'body {}');
  write(root, 'src/renderer/app.js', "import { AGENTS } from './lib/labels.js';\n");
  write(root, 'src/renderer/lib/labels.js', 'export const AGENTS = [];\n');
  write(root, 'assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}

const quiet = () => {};

/** Every file under a folder, as paths relative to it. */
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

/* ───────── the build ───────── */

test('build copies the site, fonts, favicon and app, and writes .nojekyll', () => {
  const root = fakeRepo();
  const out = path.join(root, 'site-dist');
  const summary = buildSite({ root, out, log: quiet });

  assert.ok(fs.existsSync(path.join(out, 'index.html')));
  assert.ok(fs.existsSync(path.join(out, 'css', 'site.css')));
  assert.ok(!fs.existsSync(path.join(out, '.DS_Store')), 'hidden files are left out');
  assert.ok(fs.existsSync(path.join(out, 'fonts', 'Geist-Medium.woff2')));
  assert.ok(!fs.existsSync(path.join(out, 'fonts', 'notes.txt')), 'only .woff2 files go to fonts/');
  assert.ok(fs.existsSync(path.join(out, 'favicon.svg')));
  assert.ok(fs.existsSync(path.join(out, 'app', 'index.html')));
  assert.ok(fs.existsSync(path.join(out, 'app', 'lib', 'labels.js')));
  assert.equal(fs.readFileSync(path.join(out, '.nojekyll'), 'utf8'), '');

  assert.equal(summary.app, 'renderer');
  assert.equal(summary.samples, false);
  assert.equal(summary.video, 'pending');
  assert.equal(summary.fonts, 1);
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.files, listFiles(out).length);
});

test('build copies the sample shipment into app/samples when it exists', () => {
  const root = fakeRepo();
  write(root, 'samples/sample-shipment/SAMPLE-invoice.pdf', '%PDF-1.4 sample');
  write(root, 'samples/sample-shipment/__MACOSX/junk', 'junk');
  const out = path.join(root, 'site-dist');
  const summary = buildSite({ root, out, log: quiet });
  assert.equal(summary.samples, true);
  assert.ok(fs.existsSync(path.join(out, 'app', 'samples', 'SAMPLE-invoice.pdf')));
  assert.ok(!fs.existsSync(path.join(out, 'app', 'samples', '__MACOSX')));
});

test('build switches the video section on only when media/demo.mp4 exists', () => {
  const root = fakeRepo();
  const out = path.join(root, 'site-dist');
  const html = () => fs.readFileSync(path.join(out, 'index.html'), 'utf8');

  buildSite({ root, out, log: quiet });
  assert.match(html(), /data-video="pending"/);

  write(root, 'site/media/demo.mp4', 'fake video');
  let summary = buildSite({ root, out, log: quiet });
  assert.equal(summary.video, 'ready');
  assert.match(html(), /data-video="ready"/);
  assert.match(html(), /data-video-poster=""/, 'no poster file, so no poster is requested');

  write(root, 'site/media/demo-poster.jpg', 'fake jpg');
  summary = buildSite({ root, out, log: quiet });
  assert.match(html(), /data-video-poster="media\/demo-poster.jpg"/);
});

test('build writes a placeholder app page when the app UI is not there yet', () => {
  const root = fakeRepo();
  fs.rmSync(path.join(root, 'src', 'renderer', 'index.html'));
  const out = path.join(root, 'site-dist');
  const summary = buildSite({ root, out, log: quiet });
  assert.equal(summary.app, 'placeholder');
  assert.match(fs.readFileSync(path.join(out, 'app', 'index.html'), 'utf8'), /The app preview is being prepared/);
  assert.equal(summary.warnings.length, 1);
});

test('build empties the output folder first, so deleted files do not linger', () => {
  const root = fakeRepo();
  const out = path.join(root, 'site-dist');
  write(out, 'old-page.html', 'stale');
  buildSite({ root, out, log: quiet });
  assert.ok(!fs.existsSync(path.join(out, 'old-page.html')));
});

test('build refuses to write over the repository or its source folders', () => {
  const root = fakeRepo();
  assert.throws(() => buildSite({ root, out: root, log: quiet }), /Refusing/);
  assert.throws(() => buildSite({ root, out: path.join(root, 'site'), log: quiet }), /Refusing/);
  assert.throws(() => buildSite({ root, out: path.join(root, 'src', 'renderer'), log: quiet }), /Refusing/);
  assert.throws(() => buildSite({ root, out: path.parse(root).root, log: quiet }), /Refusing/);
  assert.ok(fs.existsSync(path.join(root, 'site', 'index.html')), 'nothing was deleted');
});

test('the app import check flags files outside app/ and missing files, and skips vendor/', () => {
  const app = tempDir('app');
  write(app, 'index.html', '<script type="module" src="main.js"></script><link rel="icon" href="logo.svg">');
  write(app, 'main.js', "import { a } from './ok.js';\nimport { b } from '../core/types.js';\nconst m = import('./demo/mock-api.js');\nimport x from 'preact';\n");
  write(app, 'ok.js', 'export const a = 1;');
  write(app, 'logo.svg', '<svg/>');
  write(app, 'vendor/lib.mjs', "import y from '../../outside.js';");
  const problems = checkAppImports(app);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems.join('\n'), /\.\.\/core\/types\.js, which is outside the app folder/);
  assert.match(problems.join('\n'), /\.\/demo\/mock-api\.js, which does not exist/);
});

test('the real site builds, and every file the page refers to is in the output', () => {
  const out = path.join(tempDir('real'), 'site-dist');
  const summary = buildSite({ root: ROOT, out, log: quiet });
  assert.ok(summary.fonts >= 8, 'fonts are copied');
  assert.ok(fs.existsSync(path.join(out, 'favicon.svg')));
  assert.ok(fs.existsSync(path.join(out, 'app', 'index.html')));

  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  // Whole attribute names only (data-video-src is the optional video, checked by the build test above).
  const refs = [...html.matchAll(/\s(?:src|href|data-src)="([^"]+)"/g)].map((m) => m[1])
    .filter((ref) => !/^(https?:|mailto:|#|data:)/.test(ref));
  assert.ok(refs.length >= 6);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `${ref} must be relative so the site works under /jewel-labs-desk/`);
    const file = path.join(out, ref.split(/[?#]/)[0]);
    assert.ok(fs.existsSync(file), `index.html refers to ${ref}, which is not in site-dist`);
  }

  // Every module the page scripts import exists.
  for (const name of fs.readdirSync(path.join(out, 'js'))) {
    const code = fs.readFileSync(path.join(out, 'js', name), 'utf8');
    for (const [, spec] of code.matchAll(/from\s+'(\.[^']+)'/g)) {
      assert.ok(fs.existsSync(path.join(out, 'js', spec)), `js/${name} imports ${spec}, which is missing`);
    }
  }

  // Every font the stylesheet names exists.
  const css = fs.readFileSync(path.join(out, 'css', 'site.css'), 'utf8');
  const urls = [...css.matchAll(/url\('(\.\.\/fonts\/[^']+)'\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 10);
  for (const url of urls) assert.ok(fs.existsSync(path.join(out, 'css', url)), `${url} is missing`);
  assert.doesNotMatch(css, /url\(['"]?\//, 'no absolute paths in the CSS');
});

/* ───────── the particle diamond's shapes ───────── */

test('the brilliant cut has the expected edges and facets', () => {
  const cut = brilliantCut();
  assert.equal(cut.edges.length, 104); // 8 x 5 on the crown + 16 x 4 around the girdle and pavilion
  assert.equal(cut.faces.length, 94); // table, stars, kites, upper girdle, girdle band, pavilion
  assert.equal(cut.tips.length, 1);
  const ys = cut.edges.flat().map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...ys) + Math.min(...ys)) < 0.01, 'the stone is centred on 0');
});

test('the rough crystal is an octahedron, a bit larger than the polished stone', () => {
  const rough = roughCrystal(makeRandom(7));
  assert.equal(rough.edges.length, 12);
  assert.equal(rough.faces.length, 8);
  const radius = (shape) => Math.max(...shape.edges.flat().map((p) => Math.hypot(...p)));
  assert.ok(radius(rough) > radius(BRILLIANT));
});

test('seeding gives exactly the requested number of particles, the same every time', () => {
  const a = seedPoints(BRILLIANT, 1500, makeRandom(11), { edgeShare: 0.55 });
  const b = seedPoints(BRILLIANT, 1500, makeRandom(11), { edgeShare: 0.55 });
  assert.equal(a.length, 1500);
  assert.deepEqual(a, b);
  const edgeCount = a.filter((p) => p[3] === 1).length;
  assert.ok(edgeCount > 1500 * 0.5 && edgeCount < 1500 * 0.65, `edge share was ${edgeCount / 1500}`);
  for (const [x, y, z, w] of a) {
    assert.ok(Math.hypot(x, y, z) < 1.3);
    assert.ok(w === 1 || w === 0.6);
  }
  assert.equal(seedPoints(ROUGH, 300, makeRandom(2), { jitter: 0.035 }).length, 300);
});

test('particles sort bottom to top, and morphing goes from the rough to the cut', () => {
  const rough = sortByHeight(seedPoints(ROUGH, 200, makeRandom(1)));
  const cut = sortByHeight(seedPoints(BRILLIANT, 200, makeRandom(2)));
  for (let i = 1; i < cut.length; i++) assert.ok(cut[i][1] >= cut[i - 1][1]);
  const out = [0, 0, 0, 0];
  for (const i of [0, 77, 199]) {
    assert.deepEqual(pointAt(rough, cut, i, 0, out).map((v) => +v.toFixed(9)), rough[i].map((v) => +v.toFixed(9)));
    assert.deepEqual(pointAt(rough, cut, i, 1, out).map((v) => +v.toFixed(9)), cut[i].map((v) => +v.toFixed(9)));
  }
  // Halfway, the height is halfway too (the swirl only turns around the vertical axis).
  pointAt(rough, cut, 50, 0.5, out);
  assert.ok(Math.abs(out[1] - (rough[50][1] + cut[50][1]) / 2) < 1e-9);
});

test('edge positions are six numbers per edge', () => {
  assert.equal(edgePositions(BRILLIANT).length, BRILLIANT.edges.length * 6);
});

/* ───────── downloads ───────── */

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
};

test('the download links are exactly the release assets the workflow uploads', () => {
  const base = 'https://github.com/aarushkandukoori/jewel-labs-desk/releases/latest/download/';
  assert.equal(downloadUrl('mac-arm64'), `${base}Jewel-Labs-mac-arm64.dmg`);
  assert.equal(downloadUrl('mac-x64'), `${base}Jewel-Labs-mac-x64.dmg`);
  assert.equal(downloadUrl('windows'), `${base}Jewel-Labs-windows-setup.exe`);
  for (const key of Object.keys(INSTALLERS)) assert.ok(HTML.includes(downloadUrl(key)), `${key} link is in index.html`);
  // electron-builder.yml names the files the same way.
  const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /Jewel-Labs-mac-\$\{arch\}\.\$\{ext\}/);
  assert.match(builder, /Jewel-Labs-windows-setup\.\$\{ext\}/);
  assert.equal(RELEASES_API, 'https://api.github.com/repos/aarushkandukoori/jewel-labs-desk/releases?per_page=10');
});

test('detectSystem tells Mac, Windows and everything else apart', () => {
  assert.equal(detectSystem({ userAgent: UA.macChrome, platform: 'MacIntel' }), 'mac');
  assert.equal(detectSystem({ userAgent: UA.windows, platform: 'Win32' }), 'windows');
  assert.equal(detectSystem({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }), 'other');
  assert.equal(detectSystem({ userAgent: UA.android, platform: 'Linux armv8l' }), 'other');
  assert.equal(detectSystem({ userAgent: UA.linux, platform: 'Linux x86_64' }), 'other');
  // An iPad asking for the desktop site looks like a Mac but has a touch screen.
  assert.equal(detectSystem({ userAgent: UA.macChrome, platform: 'MacIntel', maxTouchPoints: 5 }), 'other');
  assert.equal(detectSystem(), 'other');
});

test('macChipFromGpu reads Apple silicon and Intel from the graphics chip name', () => {
  assert.equal(macChipFromGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)'), 'arm64');
  assert.equal(macChipFromGpu('Apple M1'), 'arm64');
  assert.equal(macChipFromGpu('ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)'), 'x64');
  assert.equal(macChipFromGpu('AMD Radeon Pro 5500M OpenGL Engine'), 'x64');
  assert.equal(macChipFromGpu('Apple GPU'), null, 'Safari does not say which Mac');
  assert.equal(macChipFromGpu(''), null);
});

test('heroButtons offers this computer first and the other system second', () => {
  const mac = heroButtons('mac', 'arm64');
  assert.equal(mac[0].label, 'Download for Mac');
  assert.match(mac[0].href, /mac-arm64\.dmg$/);
  assert.equal(mac[1].label, 'Download for Windows');
  assert.match(heroButtons('mac', 'x64')[0].href, /mac-x64\.dmg$/);
  assert.match(heroButtons('mac', null)[0].href, /mac-arm64\.dmg$/, 'unknown Mac gets Apple silicon');
  const windows = heroButtons('windows', null);
  assert.equal(windows[0].label, 'Download for Windows');
  assert.equal(windows[1].href, '#download', 'Windows visitors pick the Mac type in the Download section');
  const phone = heroButtons('other', null);
  assert.deepEqual(phone.map((b) => [b.label, b.href]), [['Download for Mac', '#download'], ['Download for Windows', '#download']]);
});

test('matchingCard only marks a card when it is sure', () => {
  assert.equal(matchingCard('windows', null), 'windows');
  assert.equal(matchingCard('mac', 'arm64'), 'mac-arm64');
  assert.equal(matchingCard('mac', 'x64'), 'mac-x64');
  assert.equal(matchingCard('mac', null), null);
  assert.equal(matchingCard('other', null), null);
});

test('release helpers pick the newest real release and read the installer sizes', () => {
  const list = [
    { tag_name: 'v1.1.0', draft: true, prerelease: false, assets: [] },
    { tag_name: 'v1.1.0-beta', draft: false, prerelease: true, assets: [] },
    {
      tag_name: 'v1.0.0', draft: false, prerelease: false, html_url: 'https://github.com/x/y/releases/tag/v1.0.0',
      published_at: '2026-11-16T10:00:00Z',
      assets: [{ name: 'Jewel-Labs-mac-arm64.dmg', size: 131234567 }, { name: 'Jewel-Labs-windows-setup.exe', size: 104857600 }],
    },
  ];
  const release = pickRelease(list);
  assert.equal(release.tag_name, 'v1.0.0');
  const summary = summarizeRelease(release);
  assert.equal(summary.tag, 'v1.0.0');
  assert.equal(summary.assets['mac-arm64'].size, 131234567);
  assert.equal(summary.assets['mac-x64'], null, 'missing installer is marked missing');
  assert.equal(summary.assets.windows.size, 104857600);
  assert.equal(pickRelease([]), null);
  assert.equal(pickRelease({ message: 'Not Found' }), null);
  assert.equal(summarizeRelease(null), null);
});

test('formatSize and versionLabel', () => {
  assert.equal(formatSize(104857600), '100 MB');
  assert.equal(formatSize(131234567), '125 MB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(undefined), '');
  assert.equal(versionLabel('v1.0.0'), 'Version 1.0.0');
  assert.equal(versionLabel('2.3.1'), 'Version 2.3.1');
  assert.equal(versionLabel(''), '');
});

/* ───────── other page helpers ───────── */

test('nextCheck counts down to the next 5-minute mark', () => {
  const FIVE = 5 * 60 * 1000;
  assert.deepEqual(nextCheck(0), { label: '5:00', justChecked: true });
  assert.deepEqual(nextCheck(1000), { label: '4:59', justChecked: true });
  assert.deepEqual(nextCheck(4000), { label: '4:56', justChecked: false });
  assert.deepEqual(nextCheck(FIVE - 1000), { label: '0:01', justChecked: false });
  assert.equal(nextCheck(10 * FIVE + 61000).label, '3:59');
});

test('the timeline counts steps past the reading line and fills the rail', () => {
  assert.equal(countReached([100, 300, 500, 700], 450), 2);
  assert.equal(countReached([100, 300], 50), 0);
  assert.equal(countReached([], 400), 0);
  assert.equal(railProgress(100, 1000, 600), 0.5);
  assert.equal(railProgress(100, 1000, 50), 0);
  assert.equal(railProgress(100, 1000, 5000), 1);
  assert.equal(railProgress(100, 0, 600), 0);
});

test('the statement card has an EU and a US version with matching rows', () => {
  assert.equal(VARIANTS.eu.title, 'Due Diligence Statement on Diamond Origin');
  assert.equal(VARIANTS.us.title, 'US CBP self-certification');
  assert.equal(VARIANTS.eu.rows.length, VARIANTS.us.rows.length);
  // The page's own copy of the EU card shows the same values the script writes.
  for (const [label, value] of VARIANTS.eu.rows) {
    assert.ok(HTML.includes(`<dt>${label}</dt>`), `${label} is in the card`);
    assert.ok(HTML.includes(`>${value}</dd>`), `${value} is in the card`);
  }
});

/* ───────── page content ───────── */

test('the agent cards follow AGENTS in src/core/types.js: names, colours and order', () => {
  const list = HTML.slice(HTML.indexOf('<ol class="agents"'), HTML.indexOf('</ol>', HTML.indexOf('<ol class="agents"')));
  const cards = [...list.matchAll(/data-agent="([^"]+)" style="--c: (#[0-9a-f]{6})"[\s\S]*?<h3 class="card__title">([^<]+)<\/h3>/g)]
    .map(([, id, color, name]) => ({ id, color, name }));
  assert.equal(cards.length, AGENTS.length + 1, 'seven agents plus the person who signs');
  AGENTS.forEach((agent, i) => {
    assert.equal(cards[i].id, agent.id);
    assert.equal(cards[i].color, agent.color);
    assert.equal(cards[i].name, agent.name);
  });
  assert.equal(cards[7].name, 'You sign. You send.');
});

test('the page has the required title, copy and links', () => {
  assert.match(HTML, /<title>Jewel Labs Desk<\/title>/);
  const required = [
    'The desktop app for diamond export papers',
    'Every diamond export,<br> <em>ready for customs.</em>',
    'Your export team sends the shipment papers. Agents read every line, trace every stone, check origin and hand back the pack your buyer and customs need, ready to sign.',
    'Watch it work',
    'This is the real app UI replaying a recorded run of the agents on a fictional sample shipment.',
    'The app is not notarized yet. Right-click the app, choose Open, then Open again (or System Settings &gt; Privacy &amp; Security &gt; Open Anyway).',
    'If SmartScreen appears, click More info, then Run anyway.',
    'https://github.com/aarushkandukoori/jewel-labs-desk/releases"',
    'https://cal.com/soham-jariwala-4fvbkw/30min',
    'Multiplayer, agentic AI infrastructure for the diamond trade',
    'href="https://jewellabs.io"',
    'mailto:hello@jewellabs.io',
    'https://github.com/aarushkandukoori/jewel-labs-desk"',
    '© 2026 Jewel Labs',
    'data-src="app/index.html?demo=1"',
    'property="og:image"',
    'rel="icon" href="favicon.svg"',
  ];
  for (const text of required) assert.ok(HTML.includes(text), `missing: ${text}`);

  const navText = [...HTML.slice(HTML.indexOf('id="nav-links"'), HTML.indexOf('</nav>')).matchAll(/class="nav__link"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(navText, ['Product', 'How it works', 'Stone history', 'Download', 'Security']);

  const marquee = [
    'Commercial invoices', 'Packing lists', 'GIA and IGI reports', 'Kimberley Process certificates', 'Shipping bills and LEO',
    'Air waybills', 'Insurance certificates', 'WhatsApp exports', 'Email threads', 'Phone photos',
  ];
  for (const item of marquee) assert.ok(HTML.includes(`</svg>${item}</li>`), `marquee item: ${item}`);

  const faqs = (HTML.match(/<details class="faq__item">/g) || []).length;
  assert.ok(faqs >= 5 && faqs <= 6, `${faqs} FAQ items`);
  for (const id of ['top', 'product', 'how', 'demo', 'history', 'team', 'download', 'watch', 'security', 'faq']) {
    assert.ok(HTML.includes(`id="${id}"`), `section #${id}`);
  }
});

/** Every text file in site/, with its contents. */
function siteTextFiles() {
  return listFiles(SITE)
    .filter((rel) => /\.(html|css|js)$/.test(rel))
    .map((rel) => ({ rel, text: fs.readFileSync(path.join(SITE, rel), 'utf8') }));
}

test('site copy follows the house rules: no em dashes, never "filed", no names that must not appear', () => {
  for (const { rel, text } of siteTextFiles()) {
    assert.ok(!text.includes('\u2014'), `${rel} has an em dash`);
    assert.doesNotMatch(text, /\bfiled\b|\bfiling\b/i, `${rel} says filed or filing`);
    assert.doesNotMatch(text, /\bYC\b|Y Combinator|\bBrad\b/, `${rel} names something that must not appear`);
  }
});

test('nothing in the site looks like a secret key', () => {
  const patterns = [
    /sk-[A-Za-z0-9_-]{16,}/, /\bsk_(live|test)_/, /\brk_(live|test)_/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/,
    /whsec_/, /xox[bp]-/, /hf_[A-Za-z0-9]{20,}/, /sb_secret_/,
  ];
  for (const { rel, text } of siteTextFiles()) {
    for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${rel} matches ${pattern}`);
  }
});

test('no image in the site is heavier than 200 KB', () => {
  const images = listFiles(SITE).filter((rel) => /\.(png|jpe?g|webp|gif|avif)$/i.test(rel));
  assert.ok(images.includes('og.png'));
  assert.ok(images.includes('apple-touch-icon.png'));
  for (const rel of images) {
    const size = fs.statSync(path.join(SITE, rel)).size;
    assert.ok(size <= 200 * 1024, `${rel} is ${Math.round(size / 1024)} KB`);
  }
});
