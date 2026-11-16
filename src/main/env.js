// The first file main.js loads: before src/core/config.js reads JL_SUPABASE_URL, it removes the development and
// test switches a packaged copy must not honour (switches.js). It also finds a remote-debugging or inspector
// switch a packaged copy was started with; main.js then refuses to start.
import { app } from 'electron';
import { scrubSwitches, isSelfCheckBuild, forbiddenDebugSwitch } from './switches.js';

const packaged = app.isPackaged;

export const { testSwitches: TEST_SWITCHES } = scrubSwitches(process.env, {
  packaged,
  selfCheck: packaged && isSelfCheckBuild(app.getAppPath()),
});

export const REFUSED_SWITCH = forbiddenDebugSwitch((name) => app.commandLine.hasSwitch(name), { packaged });
