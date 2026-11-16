// Download buttons. Points the hero buttons at the right installer for this computer, marks the
// matching card in the Download section, and shows the version and size of the latest GitHub
// release when GitHub answers (if it does not, the page stays as it is).
// The small helpers at the top have no browser code, so the unit tests check them in Node.

export const REPO = 'aarushkandukoori/jewel-labs-desk';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const LATEST_DOWNLOAD = `https://github.com/${REPO}/releases/latest/download/`;

/** The three installers the release workflow uploads (names come from electron-builder.yml). */
export const INSTALLERS = {
  'mac-arm64': 'Jewel-Labs-mac-arm64.dmg',
  'mac-x64': 'Jewel-Labs-mac-x64.dmg',
  windows: 'Jewel-Labs-windows-setup.exe',
};

/** The always-current download link for one installer (GitHub sends it to the newest release). */
export function downloadUrl(key) {
  return LATEST_DOWNLOAD + INSTALLERS[key];
}

/** 'mac', 'windows' or 'other' (phones, tablets, Linux), from what the browser says about itself. */
export function detectSystem({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  const ua = userAgent.toLowerCase();
  const pf = platform.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(ua)) return 'other';
  // An iPad asking for the desktop site says it is a Mac, but it has a touch screen.
  if (pf.startsWith('mac') || ua.includes('mac os x')) return maxTouchPoints > 1 ? 'other' : 'mac';
  if (pf.startsWith('win') || ua.includes('windows')) return 'windows';
  return 'other';
}

/** 'arm64' (Apple silicon), 'x64' (Intel) or null, from the graphics chip name the browser reports. */
export function macChipFromGpu(name = '') {
  if (/apple m\d/i.test(name)) return 'arm64';
  if (/intel|amd|radeon|nvidia|geforce/i.test(name)) return 'x64';
  return null; // Safari only says "Apple GPU", which is true on both kinds of Mac
}

/**
 * What the two hero buttons offer. On Windows the Mac button opens the Download section, since we
 * cannot tell which Mac. On phones and tablets both open the Download section instead of starting
 * a large download the phone cannot use.
 */
export function heroButtons(system, chip) {
  const macKey = chip === 'x64' ? 'mac-x64' : 'mac-arm64';
  const mac = { label: 'Download for Mac', href: downloadUrl(macKey), key: macKey };
  const windows = { label: 'Download for Windows', href: downloadUrl('windows'), key: 'windows' };
  const pick = (label) => ({ label, href: '#download', key: null });
  if (system === 'windows') return [windows, pick('Download for Mac')];
  if (system === 'other') return [pick('Download for Mac'), pick('Download for Windows')];
  return [mac, windows];
}

/** Which Download card fits this computer, or null when we cannot be sure. */
export function matchingCard(system, chip) {
  if (system === 'windows') return 'windows';
  if (system === 'mac' && chip) return chip === 'x64' ? 'mac-x64' : 'mac-arm64';
  return null;
}

/** 141 MB style size. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** "v1.0.0" becomes "Version 1.0.0". */
export function versionLabel(tag) {
  const version = String(tag || '').replace(/^v/i, '');
  return version ? `Version ${version}` : '';
}

/** The newest published release from GitHub's list (skipping drafts and pre-releases), or null. */
export function pickRelease(list) {
  if (!Array.isArray(list)) return null;
  return list.find((release) => release && !release.draft && !release.prerelease) || null;
}

/** The parts of a GitHub release the page shows: tag, page, date and, per installer, its size (null if missing). */
export function summarizeRelease(release) {
  if (!release) return null;
  const assets = {};
  for (const [key, file] of Object.entries(INSTALLERS)) {
    const asset = (release.assets || []).find((a) => a.name === file);
    assets[key] = asset ? { size: asset.size } : null;
  }
  return { tag: release.tag_name, url: release.html_url, published: release.published_at, assets };
}

/* ───────── the part that touches the page ───────── */

export async function initDownloads() {
  const system = detectSystem(navigator);
  const chip = system === 'mac' ? await detectMacChip() : null;

  const buttons = heroButtons(system, chip);
  const heroLinks = [document.getElementById('hero-download-1'), document.getElementById('hero-download-2')];
  heroLinks.forEach((link, i) => {
    if (!link) return;
    link.href = buttons[i].href;
    link.dataset.asset = buttons[i].key || '';
    link.querySelector('span').textContent = buttons[i].label;
  });
  writeNote(system, chip);

  const match = matchingCard(system, chip);
  for (const card of document.querySelectorAll('.dl[data-asset]')) {
    card.classList.toggle('is-match', card.dataset.asset === match);
  }
  const grid = document.querySelector('.downloads');
  if (grid) grid.classList.toggle('has-match', Boolean(match));

  // Ask GitHub about the latest release once the page has settled.
  setTimeout(() => {
    fetchRelease().then(showRelease).catch(() => {});
  }, 1200);
}

/** The small line under the hero buttons. */
function writeNote(system, chip) {
  const note = document.getElementById('hero-note');
  if (!note) return;
  const link = (text, href) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    return a;
  };
  const parts = [];
  if (system === 'mac' && chip === 'x64') parts.push('Mac with Apple silicon? ', link('Get that version', downloadUrl('mac-arm64')), '. ');
  else if (system === 'mac') parts.push('Mac with an Intel processor? ', link('Get the Intel version', downloadUrl('mac-x64')), '. ');
  else if (system === 'windows') parts.push('For Windows 10 and 11, 64-bit. ');
  else parts.push('Open this page on your Mac or PC to install. ');
  parts.push(link('All downloads', '#download'));
  note.replaceChildren(...parts);
}

/** Apple silicon or Intel? Chrome and Edge say so directly; otherwise the graphics chip name gives it away. */
async function detectMacChip() {
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
      if (architecture === 'arm') return 'arm64';
      if (architecture === 'x86') return 'x64';
    }
  } catch {
    // fall through to the graphics chip check
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext(); // give the graphics context back straight away
    return macChipFromGpu(name);
  } catch {
    return null;
  }
}

/**
 * Asks GitHub for the releases (remembered for 10 minutes in this tab, to stay far below GitHub's limit).
 * Resolves to the release summary, null when there is no release yet, or undefined when GitHub did not answer.
 */
async function fetchRelease() {
  const KEY = 'jl-release';
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && Date.now() - saved.at < 10 * 60 * 1000) return saved.data;
  } catch {
    // storage blocked: just ask GitHub
  }
  const response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) return undefined;
  const data = summarizeRelease(pickRelease(await response.json()));
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // fine, we just ask again next time
  }
  return data;
}

function showRelease(release) {
  if (release === undefined) return; // GitHub did not answer: keep the page as it is
  const line = document.getElementById('release-line');

  if (release === null) {
    // No release yet: the download links would lead nowhere, so send people to the releases page.
    if (line) line.textContent = 'The first release is on its way.';
    for (const a of document.querySelectorAll('.dl .btn, #hero-download-1, #hero-download-2')) {
      if (a.getAttribute('href') !== '#download') a.href = RELEASES_PAGE;
    }
    return;
  }

  const published = release.published ? new Date(release.published) : null;
  const date = published && !Number.isNaN(published.getTime())
    ? published.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  if (line) line.textContent = `Latest release: ${versionLabel(release.tag)}${date ? `, published ${date}` : ''}.`;

  for (const card of document.querySelectorAll('.dl[data-asset]')) {
    const asset = release.assets[card.dataset.asset];
    const version = card.querySelector('[data-version]');
    const size = card.querySelector('[data-size]');
    if (version) version.textContent = versionLabel(release.tag);
    if (size) size.textContent = asset ? formatSize(asset.size) : 'Not in this release yet';
    // An installer missing from this release would be a dead link, so point at the release page instead.
    if (!asset) card.querySelector('.btn').href = release.url;
  }
  for (const link of document.querySelectorAll('#hero-download-1, #hero-download-2')) {
    if (link.dataset.asset && !release.assets[link.dataset.asset]) link.href = release.url;
  }
}
