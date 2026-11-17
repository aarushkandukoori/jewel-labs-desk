// Tests for scripts/clean-builds.js, which removes the unpacked "Jewel Labs.app" folders a Mac build leaves next to
// the .dmg files, so the Mac does not list one more "Jewel Labs" app after every build. Also checks the Mac signing
// setup the release workflow relies on. Every test works in a temporary folder with fake .app folders.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanBuilds, findMacFolders } from '../../scripts/clean-builds.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake repository with the build output electron-builder leaves: installers plus unpacked apps. */
function fakeBuildOutput() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-clean-'));
  tempDirs.push(root);
  const put = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  };
  for (const out of ['dist', 'dist-selfcheck']) {
    put(`${out}/Jewel-Labs-mac-arm64.dmg`);
    put(`${out}/Jewel-Labs-mac-arm64.dmg.blockmap`);
    put(`${out}/latest-mac.yml`);
    put(`${out}/mac/Jewel Labs.app/Contents/Info.plist`);
    put(`${out}/mac-arm64/Jewel Labs.app/Contents/Info.plist`);
  }
  put('dist/machine-notes.txt'); // a file, not a mac* folder: stays
  put('dist/macros/keep.txt'); // starts with "mac" but is not mac or mac-<arch>: stays
  return root;
}

test('cleanBuilds forgets every unpacked app, deletes the mac* folders and keeps the installers', () => {
  const root = fakeBuildOutput();
  const forgotten = [];
  const lines = [];
  const summary = cleanBuilds({ root, log: (line) => lines.push(line), unregister: (app) => forgotten.push(app) });

  const rel = (list) => list.map((p) => path.relative(root, p)).sort();
  assert.deepEqual(rel(summary.removed), ['dist-selfcheck/mac', 'dist-selfcheck/mac-arm64', 'dist/mac', 'dist/mac-arm64']);
  assert.deepEqual(rel(forgotten), [
    'dist-selfcheck/mac-arm64/Jewel Labs.app', 'dist-selfcheck/mac/Jewel Labs.app', 'dist/mac-arm64/Jewel Labs.app', 'dist/mac/Jewel Labs.app',
  ].sort());
  assert.deepEqual(rel(summary.unregistered), rel(forgotten));
  for (const gone of summary.removed) assert.ok(!fs.existsSync(gone), `${gone} was deleted`);
  for (const kept of ['dist/Jewel-Labs-mac-arm64.dmg', 'dist/Jewel-Labs-mac-arm64.dmg.blockmap', 'dist/latest-mac.yml',
    'dist-selfcheck/Jewel-Labs-mac-arm64.dmg', 'dist/machine-notes.txt', 'dist/macros/keep.txt']) {
    assert.ok(fs.existsSync(path.join(root, kept)), `${kept} is kept`);
  }
  assert.ok(lines.some((line) => line.startsWith('removed dist/mac-arm64')), 'it says what it did');
});

test('cleanBuilds unregisters each app before deleting its folder', () => {
  const root = fakeBuildOutput();
  const existedWhenForgotten = [];
  cleanBuilds({ root, log: () => {}, unregister: (app) => existedWhenForgotten.push(fs.existsSync(app)) });
  assert.equal(existedWhenForgotten.length, 4);
  assert.ok(existedWhenForgotten.every(Boolean));
});

test('cleanBuilds says so when there is nothing to clean, and copes with missing output folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-clean-empty-'));
  tempDirs.push(root);
  const lines = [];
  const summary = cleanBuilds({ root, log: (line) => lines.push(line), unregister: () => assert.fail('nothing to forget') });
  assert.deepEqual(summary, { removed: [], unregistered: [] });
  assert.match(lines.join('\n'), /nothing to clean/);
});

test('cleanBuilds refuses any folder outside the repository, before touching anything', () => {
  const root = fakeBuildOutput();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-outside-'));
  tempDirs.push(outside);
  fs.mkdirSync(path.join(outside, 'mac', 'Jewel Labs.app'), { recursive: true });
  const never = () => assert.fail('nothing may be unregistered');
  for (const folders of [[outside], ['..'], ['dist', '../..'], ['.'], [root], ['/']]) {
    assert.throws(() => cleanBuilds({ root, folders, log: () => {}, unregister: never }), /Refusing to clean/, JSON.stringify(folders));
  }
  assert.ok(fs.existsSync(path.join(outside, 'mac', 'Jewel Labs.app')), 'the outside folder is untouched');
  assert.ok(fs.existsSync(path.join(root, 'dist', 'mac', 'Jewel Labs.app')), 'a refused run deletes nothing, even inside');
});

test('findMacFolders picks mac and mac-<arch> folders only', () => {
  const root = fakeBuildOutput();
  assert.deepEqual(findMacFolders(path.join(root, 'dist')).map((p) => path.basename(p)).sort(), ['mac', 'mac-arm64']);
  assert.deepEqual(findMacFolders(path.join(root, 'no-such-folder')), []);
});

test('npm run dist:mac cleans up after itself, and npm run clean:builds exists', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(scripts['clean:builds'], 'node scripts/clean-builds.js');
  assert.match(scripts['dist:mac'], /^electron-builder --mac --publish never && node scripts\/clean-builds\.js$/);
  const packaged = fs.readFileSync(path.join(ROOT, 'test', 'e2e', 'packaged.spec.mjs'), 'utf8');
  assert.match(packaged, /unregisterApp\(appPath\)/, 'the packaged check forgets the app it started from the mounted image');
});

/* ───────── Mac signing setup ───────── */

test('the Mac build signs ad hoc by default with the explicit entitlements, and the workflow can switch to Developer ID', () => {
  const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /^ {2}identity: "-"$/m);
  assert.match(builder, /^ {2}hardenedRuntime: true$/m);
  assert.match(builder, /^ {2}entitlements: build\/entitlements\.mac\.plist$/m);
  assert.match(builder, /^ {2}entitlementsInherit: build\/entitlements\.mac\.plist$/m);
  assert.doesNotMatch(builder, /^\s*notarize:/m, 'notarize stays unset so it follows the APPLE_API_* variables');

  const plist = fs.readFileSync(path.join(ROOT, 'build', 'entitlements.mac.plist'), 'utf8');
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [
    'com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation',
  ]);
  assert.doesNotMatch(plist, /get-task-allow/);

  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(release.includes('-c.mac.identity="Developer ID Application"'));
  for (const secret of ['MAC_CERT_P12_BASE64', 'MAC_CERT_PASSWORD', 'APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    assert.equal((release.match(new RegExp(`secrets\\.${secret}\\b`, 'g')) || []).length, 1, `${secret} is given to one step only`);
  }
  assert.match(release, /unset CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID/);
  assert.match(release, /^permissions: \{\}$/m);
  for (const [, uses] of release.matchAll(/uses: (\S+)/g)) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is pinned to a commit`);
});
