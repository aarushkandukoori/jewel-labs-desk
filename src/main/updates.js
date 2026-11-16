// "Check for updates": asks GitHub for the latest release and compares it with this version.
// The app is not signed with an Apple Developer ID, so it cannot replace itself; we point the
// person at the download instead.
import { GITHUB_REPO } from '../core/config.js';

// Compares versions like "1.2.10" and "v1.3.0". Returns -1, 0 or 1. Anything after "-" is ignored.
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v || '0')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Picks the download that fits this computer from the release files.
export function pickDownload(assets, platform, arch) {
  const names = (assets || []).map((a) => ({ name: String(a.name || ''), url: a.browser_download_url }));
  let wanted = null;
  if (platform === 'darwin') wanted = arch === 'arm64' ? 'Jewel-Labs-mac-arm64.dmg' : 'Jewel-Labs-mac-x64.dmg';
  if (platform === 'win32') wanted = 'Jewel-Labs-windows-setup.exe';
  return names.find((a) => a.name === wanted)?.url || null;
}

// Returns { latest, url, download } when GitHub has a newer release, or null when this is the latest.
export async function checkForUpdate({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  repo = GITHUB_REPO,
  fetch = globalThis.fetch,
  timeoutMs = 10000,
}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Jewel-Labs-Desk' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null; // no release published yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`);
  const release = await res.json();
  const latest = String(release.tag_name || '').replace(/^v/i, '');
  if (!latest || compareVersions(latest, currentVersion) <= 0) return null;
  return { latest, url: release.html_url, download: pickDownload(release.assets, platform, arch) };
}
