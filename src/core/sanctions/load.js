// Loads the OFAC SDN list.
// Order: a fresh cached download (less than maxAgeHours old) -> a new download from treasury.gov ->
// if that fails, the newest copy we already have (an older cached download, or the snapshot bundled
// with the app). index.source always says in plain words which copy is in use and why.
// A download can take a minute, so at start-up call loadSdn({ cacheDir, fetch: null }) for an index right
// away, then loadSdn({ cacheDir }) in the background and swap in the new index when it arrives.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR, OFAC_MAX_AGE_HOURS } from '../config.js';
import { buildSdnIndex } from './build.js';
import { screen } from './screen.js';

export const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
export const OFAC_ALT_URL = 'https://www.treasury.gov/ofac/downloads/alt.csv';

const BUNDLED_DIR = path.join(ASSETS_DIR, 'ofac');
const BUNDLED_FILES = { sdn: 'sdn.csv', alt: 'alt.csv', meta: 'snapshot.json' };
const CACHE_FILES = { sdn: 'ofac-sdn.csv', alt: 'ofac-alt.csv', meta: 'ofac-snapshot.json' };
const DOWNLOAD_TIMEOUT_MS = 180_000; // per file; Treasury's server is slow (about 45 s for both files in a test)
const MAX_REDIRECTS = 5;
const MIN_ENTRIES = 1000; // the real list has about 19,500 entries; far fewer means we got an error page

// The bundled snapshot never changes while the app runs, so we build its index only once.
const bundledIndexes = new Map();

/**
 * @param {{ cacheDir?: string, fetch?: Function|null, maxAgeHours?: number, bundledDir?: string, now?: Date }} options
 *   fetch: pass null to skip the download (offline).
 * @returns {Promise<object>} SdnIndex { count, date, source, sourceKind, refreshError, entries, ... }
 */
export async function loadSdn({
  cacheDir, fetch = globalThis.fetch, maxAgeHours = OFAC_MAX_AGE_HOURS, bundledDir = BUNDLED_DIR, now = new Date(),
} = {}) {
  // 1. A cached download that is still fresh.
  const cached = cacheDir ? await readCopy(cacheDir, CACHE_FILES) : null;
  let cachedIndex = null; // built only when we use it (building takes a few hundred ms)
  if (cached && ageInHours(cached.meta, now) < maxAgeHours) {
    cachedIndex = buildFromCopy(cached);
    if (cachedIndex.count >= MIN_ENTRIES) {
      return withSource(cachedIndex, 'cache', `Cached copy downloaded from treasury.gov on ${cached.meta.downloaded}.`);
    }
  }

  // 2. A new download.
  let refreshError = null;
  if (typeof fetch === 'function') {
    try {
      const fresh = await downloadList(fetch, now);
      const index = buildFromCopy(fresh);
      if (index.count < MIN_ENTRIES) throw new Error(`the download had only ${index.count} entries`);
      let saveNote = '';
      try {
        if (cacheDir) await saveCopy(cacheDir, fresh);
      } catch (error) {
        saveNote = ` Could not keep a copy on disk: ${error.message}.`; // the download is still good to use
      }
      return withSource(index, 'download', `Downloaded from treasury.gov on ${fresh.meta.downloaded}.${saveNote}`);
    } catch (error) {
      refreshError = describeError(error);
    }
  }
  const why = refreshError ? `Refresh failed: ${refreshError}.` : 'No refresh was tried.';

  // 3. The newest copy we already have.
  const bundled = await bundledIndex(bundledDir);
  if (cached && copyDate(cached.meta) > copyDate(bundled.meta)) {
    cachedIndex = cachedIndex || buildFromCopy(cached);
    if (cachedIndex.count >= MIN_ENTRIES) {
      return withSource(cachedIndex, 'cache', `Cached copy of ${cached.meta.downloaded}. ${why}`, refreshError);
    }
  }
  return withSource(bundled.index, 'bundled', `Bundled snapshot of ${bundled.meta.downloaded}. ${why}`, refreshError);
}

// ---------- copies on disk ----------

async function readCopy(dir, files) {
  try {
    const [sdnCsv, altCsv, metaText] = await Promise.all([
      fs.readFile(path.join(dir, files.sdn), 'utf8'),
      fs.readFile(path.join(dir, files.alt), 'utf8'),
      fs.readFile(path.join(dir, files.meta), 'utf8'),
    ]);
    return { sdnCsv, altCsv, meta: JSON.parse(metaText) };
  } catch {
    return null; // missing or unreadable: treat as no copy
  }
}

async function saveCopy(dir, copy) {
  await fs.mkdir(dir, { recursive: true });
  // Write to a temporary name first, then rename, so a crash never leaves half a file behind.
  const writes = [[CACHE_FILES.sdn, copy.sdnCsv], [CACHE_FILES.alt, copy.altCsv],
    [CACHE_FILES.meta, JSON.stringify(copy.meta, null, 2)]];
  for (const [fileName, text] of writes) {
    const target = path.join(dir, fileName);
    await fs.writeFile(`${target}.tmp`, text, 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }
}

// We keep the promise, so two calls at the same moment share one build.
function bundledIndex(dir) {
  if (!bundledIndexes.has(dir)) {
    const building = readCopy(dir, BUNDLED_FILES).then((copy) => {
      if (!copy) throw new Error(`The bundled OFAC snapshot is missing from ${dir}`);
      return { index: buildFromCopy(copy), meta: copy.meta };
    });
    building.catch(() => bundledIndexes.delete(dir)); // try again next time
    bundledIndexes.set(dir, building);
  }
  return bundledIndexes.get(dir);
}

function buildFromCopy(copy) {
  const date = copy.meta.published || copy.meta.downloaded || null;
  return buildSdnIndex({ sdnCsv: copy.sdnCsv, altCsv: copy.altCsv, date });
}

// A shallow copy, so the shared bundled index keeps its own source text.
function withSource(index, sourceKind, source, refreshError = null) {
  const result = { ...index, source, sourceKind, refreshError };
  warmUp(result);
  return result;
}

// The first screen() in a process is slow while the JavaScript engine compiles it. Do that once here,
// so the first real party name is as fast as the rest.
let warmedUp = false;
function warmUp(index) {
  if (warmedUp) return;
  screen('Jewel Labs warm up', index);
  warmedUp = true;
}

function ageInHours(meta, now) {
  const fetchedAt = Date.parse(meta.fetchedAt || `${meta.downloaded}T00:00:00Z`);
  if (Number.isNaN(fetchedAt)) return Infinity;
  return (now.getTime() - fetchedAt) / 3_600_000;
}

function copyDate(meta) {
  return String(meta.fetchedAt || meta.downloaded || '').slice(0, 10);
}

// ---------- download ----------

async function downloadList(fetchFn, now) {
  const sdn = await fetchText(fetchFn, OFAC_SDN_URL);
  const alt = await fetchText(fetchFn, OFAC_ALT_URL);
  const published = sdn.lastModified ? isoDate(new Date(sdn.lastModified)) : null;
  return {
    sdnCsv: sdn.text,
    altCsv: alt.text,
    meta: { source: OFAC_SDN_URL, alt: OFAC_ALT_URL, downloaded: isoDate(now), fetchedAt: now.toISOString(), published },
  };
}

// Treasury answers with a redirect to sanctionslistservice.ofac.treas.gov. fetch follows redirects itself;
// the loop below also follows them for a fetch that hands the redirect back to us.
async function fetchText(fetchFn, url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchFn(current, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'user-agent': 'JewelLabsDesk/1.0' },
    });
    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`treasury.gov answered ${response.status} for ${path.basename(url)}`);
    return { text: await response.text(), lastModified: response.headers?.get?.('last-modified') || null };
  }
  throw new Error(`too many redirects for ${path.basename(url)}`);
}

function isoDate(date) {
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// Node's fetch says only "fetch failed"; the reason (no network, DNS, timeout) is in error.cause.
function describeError(error) {
  const message = String(error?.message || error || 'unknown error').replace(/\.+$/, '');
  const cause = error?.cause?.code || error?.cause?.message;
  return cause && !message.includes(cause) ? `${message} (${cause})` : message;
}
