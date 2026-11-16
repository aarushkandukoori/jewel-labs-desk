// Checks a stone's grading report on the lab's own website (GIA, IGI, HRD ...).
// The window is visible on purpose: if the lab's site shows a check ("are you human?"), the person
// solves it. We never try to get around such checks. We only read the page text once the report shows,
// hand it to core/labs parseLabPage, and compare it with our record.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gives up on a frame that does not answer in time (it may be busy loading).
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(''), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The visible text of the page and its frames (some labs show the report inside a frame).
export async function readPageText(win, maxChars = 200000) {
  const frames = win.webContents.mainFrame?.framesInSubtree || [];
  const texts = [];
  for (const frame of frames) {
    try {
      const text = await withTimeout(frame.executeJavaScript(`document.body ? document.body.innerText.slice(0, ${maxChars}) : ''`), 5000);
      if (text) texts.push(String(text));
    } catch {
      // the frame is loading or gone; read it on the next round
    }
  }
  return texts.join('\n');
}

export function createLabsVerify({
  BrowserWindow,
  labs, // src/core/labs: detectLab, reportCheckUrl, parseLabPage, compareLab
  session = null, // Electron session module, to lock down the labs' own browsing session
  partition = 'persist:labs', // cookies stay here, apart from the app, so a solved check lasts
  pollMs = 1500,
  timeoutMs = 90000,
}) {
  let sessionReady = false;

  // The lab sites get no permissions (camera, location ...) and cannot download files.
  function prepareSession() {
    if (sessionReady || !session) return;
    const s = session.fromPartition(partition);
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.on('will-download', (event) => event.preventDefault());
    sessionReady = true;
  }

  // Reads the page every pollMs until parseLabPage finds the report. "No such report" must show on two
  // reads in a row before we believe it, so a page that is still loading is not taken for an answer.
  async function waitForReport(win, lab) {
    const started = Date.now();
    let notFoundReads = 0;
    while (Date.now() - started < timeoutMs) {
      if (win.isDestroyed()) return null;
      const text = await readPageText(win);
      const parsed = text ? labs.parseLabPage(lab, text) : null;
      if (parsed?.found) return { parsed, text };
      notFoundReads = parsed?.reason === 'not_found' ? notFoundReads + 1 : 0;
      if (notFoundReads >= 2) return { parsed, text };
      await sleep(pollMs);
    }
    return null;
  }

  function compare(stone, parsed) {
    try {
      return labs.compareLab(stone, parsed);
    } catch {
      return { status: parsed.found ? 'unknown' : 'not_found', diffs: [] }; // the caller compares again with its full record
    }
  }

  // stone: a stone record, or { lab, reportNumber, url } from the services. Returns the comparison
  // { status, diffs } plus the page text, so the services can parse and compare it with their own record.
  return async function labsVerify(stone) {
    if (!stone?.reportNumber) return { status: 'not_found', diffs: [], reason: 'The stone has no report number.', text: '' };
    const lab = stone.lab || labs.detectLab(stone.reportNumber, null);
    const url = stone.url || (lab ? labs.reportCheckUrl(lab, stone.reportNumber) : null);
    if (!url) {
      return { status: 'not_found', diffs: [], reason: lab ? `${lab} has no online report check.` : 'The lab is not known.', text: '' };
    }

    prepareSession();
    const win = new BrowserWindow({
      width: 900,
      height: 800,
      title: `Checking ${lab} report ${stone.reportNumber}`,
      autoHideMenuBar: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    win.on('page-title-updated', (event) => event.preventDefault()); // keep our title, not the site's
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadURL(url).catch(() => {}); // a failed load shows in the window; we keep reading until the timeout

    try {
      const found = await waitForReport(win, lab);
      if (!found) {
        const reason = win.isDestroyed()
          ? 'The window was closed before the report showed.'
          : `The report did not show within ${Math.round(timeoutMs / 1000)} seconds.`;
        return { status: 'not_found', diffs: [], reason, lab, url, text: '' };
      }
      return { ...compare(stone, found.parsed), lab, url, text: found.text, parsed: found.parsed };
    } finally {
      if (!win.isDestroyed()) win.close();
    }
  };
}
