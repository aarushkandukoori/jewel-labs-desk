// Which development and test switches a copy of the app honours. A copy a house installs (packaged) honours
// none of them: one `launchctl setenv` by other software must not move the data folder, answer the file
// dialogs, turn off the daily OFAC download, or point sign-in and the AI at another server. A self-check build
// (electron-builder -c.extraMetadata.selfCheck=true, for test/e2e/packaged.spec.mjs) keeps the test switches only.
// env.js runs this before anything reads process.env. Plain Node, so the unit tests can run it.
import fs from 'node:fs';
import path from 'node:path';

// Test switches: src/main/e2e.js and main.js.
export const TEST_ENV = ['JL_E2E', 'JL_E2E_OPEN_FILES', 'JL_E2E_SAVE_DIR', 'JL_E2E_REPORT', 'JL_E2E_QUIT', 'JL_USER_DATA'];
// Back-end switches: src/core/config.js. Development only, never in a packaged copy.
export const BACKEND_ENV = ['JL_SUPABASE_URL', 'JL_SUPABASE_PUBLISHABLE_KEY', 'JL_SUPABASE_ANON_KEY'];
// Command-line switches that would let another program drive the app (Chromium remote debugging, the Node
// inspector). The electron fuses already turn the Node ones off in a packaged copy; these are refused too.
export const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'];

/** True when the packaged app was built for the self-check (package.json "selfCheck": true). */
export function isSelfCheckBuild(appPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')).selfCheck === true;
  } catch {
    return false;
  }
}

/**
 * Removes the switches this copy must not honour from env. Returns { testSwitches, removed }:
 * testSwitches is true in development and in a self-check build.
 */
export function scrubSwitches(env, { packaged, selfCheck = false }) {
  const testSwitches = !packaged || selfCheck;
  const remove = [...(packaged ? BACKEND_ENV : []), ...(testSwitches ? [] : TEST_ENV)];
  const removed = remove.filter((name) => name in env);
  for (const name of removed) delete env[name];
  return { testSwitches, removed };
}

/** The first debugging switch a packaged copy was started with, or null. hasSwitch: app.commandLine.hasSwitch. */
export function forbiddenDebugSwitch(hasSwitch, { packaged }) {
  if (!packaged) return null;
  return DEBUG_SWITCHES.find((name) => hasSwitch(name)) || null;
}
