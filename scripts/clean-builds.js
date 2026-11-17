// Removes the unpacked app folders a Mac build leaves behind:   node scripts/clean-builds.js [folder ...]
//
// electron-builder writes the installers (dist/*.dmg) and, next to them, the unpacked app it put inside each one
// (dist/mac/Jewel Labs.app for Intel, dist/mac-arm64/Jewel Labs.app for Apple silicon). macOS notices every
// "Jewel Labs.app" on the disk and lists it (Launchpad, Spotlight, "Open With"), so after a few builds and self-check
// builds the Mac shows several "Jewel Labs" apps. This script tells macOS to forget each of those apps
// (lsregister -u) and deletes the folders. The .dmg files, the blockmaps and latest-mac.yml stay.
//
// With no arguments it cleans dist/ and dist-selfcheck/. It refuses any folder outside the repository.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FOLDERS = ['dist', 'dist-selfcheck'];
// The macOS tool that keeps the list of apps on the disk. Built in, part of every macOS.
export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * Tells macOS to forget the app at `appPath`, so it no longer shows up as one more "Jewel Labs".
 * Safe on any path: it removes nothing from the disk. Returns true when lsregister ran and said yes
 * (it says no for an app macOS never listed, which is fine too). Does nothing off macOS.
 */
export function unregisterApp(appPath) {
  if (process.platform !== 'darwin' || !fs.existsSync(LSREGISTER)) return false;
  const result = spawnSync(LSREGISTER, ['-u', appPath], { stdio: 'ignore' });
  return result.status === 0;
}

/** True when `target` is inside `root` (not `root` itself). */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The unpacked app folders electron-builder leaves in one output folder: mac, mac-arm64, mac-universal ... */
export function findMacFolders(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^mac(-|$)/.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

/** The .app bundles directly inside a folder. */
function findApps(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Cleans the given output folders (relative to `root`, or absolute inside it). For each unpacked mac* folder:
 * unregisters every .app in it, then deletes the folder. Throws before touching anything when a folder is outside
 * the repository. Returns { removed: [folders], unregistered: [apps] }.
 */
export function cleanBuilds({ root = ROOT, folders = DEFAULT_FOLDERS, log = console.log, unregister = unregisterApp } = {}) {
  root = path.resolve(root);
  const dirs = folders.map((folder) => path.resolve(root, folder));
  for (const dir of dirs) {
    if (!isInside(root, dir)) throw new Error(`Refusing to clean ${dir}: it is not inside the repository ${root}`);
  }
  const summary = { removed: [], unregistered: [] };
  for (const dir of dirs) {
    for (const macFolder of findMacFolders(dir)) {
      for (const app of findApps(macFolder)) {
        unregister(app);
        summary.unregistered.push(app);
        log(`forgot ${path.relative(root, app)} (macOS no longer lists it)`);
      }
      fs.rmSync(macFolder, { recursive: true, force: true });
      summary.removed.push(macFolder);
      log(`removed ${path.relative(root, macFolder)}/`);
    }
  }
  if (!summary.removed.length) log('nothing to clean: no unpacked app folders');
  return summary;
}

// Run from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const folders = process.argv.slice(2);
  try {
    cleanBuilds({ folders: folders.length ? folders : DEFAULT_FOLDERS });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
