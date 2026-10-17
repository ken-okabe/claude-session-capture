const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { mergeLines, prepareVisible, cleanOutput, GAP_MARKER } = require('./merge');

// Dedicated session partition so that login state is kept between runs
const PARTITION = 'persist:claude-capture';
const MAX_STEPS = 500;
// Any claude.ai page is allowed; the capture works on whatever page is open
const ALLOWED_URL = /^https:\/\/claude\.ai\//;

let captureWin = null;

// ---- Scripts executed inside the page -------------------------------------

// Find the element that actually scrolls (often an inner container, not the window)
// and tag it with a data attribute so later steps can find it.
const FIND_SCROLLER_JS = `(() => {
  const cands = [document.scrollingElement, ...document.querySelectorAll('*')];
  let best = null;
  let bestRange = 0;
  for (const el of cands) {
    if (!el) continue;
    const isRoot = el === document.scrollingElement;
    if (!isRoot) {
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
    }
    const range = el.scrollHeight - el.clientHeight;
    if (range > bestRange) { bestRange = range; best = el; }
  }
  if (!best) return null;
  document.querySelectorAll('[data-capture-scroller]').forEach(e => e.removeAttribute('data-capture-scroller'));
  best.setAttribute('data-capture-scroller', '1');
  return { range: bestRange, height: best.scrollHeight, client: best.clientHeight };
})()`;

const READ_JS = `(() => {
  const s = document.querySelector('[data-capture-scroller]') || document.scrollingElement;
  if (!s) return null;
  return { text: s.innerText || '', top: s.scrollTop, client: s.clientHeight, height: s.scrollHeight };
})()`;

const STEP_JS = `(() => {
  const s = document.querySelector('[data-capture-scroller]') || document.scrollingElement;
  s.scrollTop = s.scrollTop + Math.round(s.clientHeight * 0.7);
  return true;
})()`;

const TO_TOP_JS = `(() => {
  const s = document.querySelector('[data-capture-scroller]') || document.scrollingElement;
  s.scrollTop = 0;
  return true;
})()`;

const DOM_DUMP_JS = `document.documentElement.outerHTML`;

// ---- Helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Progress is shown next to the capture button in the page
function send(channel, payload) {
  if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send(channel, payload);
}

// ---- Capture ---------------------------------------------------------------

async function runCapture(wc) {
  const found = await wc.executeJavaScript(FIND_SCROLLER_JS);
  if (!found) throw new Error('No scrollable element found on this page.');
  send('log', `Scroll container found (scrollable range ${found.range}px)`);

  await wc.executeJavaScript(TO_TOP_JS);
  await sleep(1500);

  let acc = [];
  let stableBottom = 0;
  let lastHeight = -1;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const snap = await wc.executeJavaScript(READ_JS);
    if (!snap) throw new Error('The scroll container disappeared (the page may have navigated).');

    const visible = prepareVisible(snap.text);
    acc = mergeLines(acc, visible);
    send('progress', { step, lines: acc.length, top: Math.round(snap.top), height: snap.height });

    // Stop once we are at the bottom and the height stays the same for 3 checks
    const atBottom = snap.top + snap.client >= snap.height - 4;
    if (atBottom && snap.height === lastHeight) {
      stableBottom++;
      if (stableBottom >= 3) break;
    } else {
      stableBottom = 0;
    }
    lastHeight = snap.height;

    await wc.executeJavaScript(STEP_JS);
    await sleep(1000); // wait for rendering and lazy loading
  }
  const gaps = acc.filter((l) => l === GAP_MARKER).length;
  if (gaps > 0) send('log', `Warning: ${gaps} place(s) could not be matched; check the output around the gap markers.`);
  return acc;
}

function saveResult(rawLines, meta) {
  const lines = cleanOutput(rawLines);
  return dialog
    .showSaveDialog(captureWin || undefined, {
      title: 'Choose where to save',
      defaultPath: `claude-session-${Date.now()}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    .then(({ canceled, filePath }) => {
      if (canceled || !filePath) return null;
      const header =
        `# ${meta.title}\n\n` +
        `- Source URL: ${meta.url}\n` +
        `- Captured at: ${new Date().toISOString()}\n` +
        `- Lines captured: ${lines.length}\n\n---\n\n`;
      fs.writeFileSync(filePath, header + lines.join('\n\n'), 'utf8');
      fs.writeFileSync(
        filePath.replace(/\.md$/i, '.json'),
        JSON.stringify({ meta, lines }, null, 2),
        'utf8'
      );
      return filePath;
    });
}

// ---- Window ----------------------------------------------------------------

const START_URL = 'https://claude.ai/';

// One window: the user logs in here, then uses the same page to capture.
function createCaptureWindow() {
  captureWin = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'Claude session (log in, then press "Start capture" at the bottom right)',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-capture.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWin.on('closed', () => { captureWin = null; });

  // Diagnostics: print the page load state to the terminal so a blank window can be explained.
  const wc = captureWin.webContents;
  console.log(`[capture] loading ${START_URL}`);
  wc.on('did-start-loading', () => console.log('[capture] did-start-loading'));
  wc.on('did-finish-load', () => console.log(`[capture] did-finish-load: ${wc.getURL()}`));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.log(`[capture] did-fail-load: code=${code} ${desc} url=${url}`);
  });
  wc.on('render-process-gone', (_e, details) => console.log(`[capture] renderer gone: ${details.reason}`));

  captureWin.once('ready-to-show', () => {
    console.log('[capture] window ready, showing');
    captureWin.show();
  });

  captureWin.loadURL(START_URL).catch((err) => console.log(`[capture] loadURL error: ${err.message}`));
}

// Each clearing step is time-boxed. Storage deletion can hang (e.g. a damaged
// service-worker database never resolves), so a step that takes too long is
// logged and skipped instead of blocking the window from opening.
const CLEAR_STEP_TIMEOUT_MS = 5000;

function withTimeout(promise, name) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.log(`[capture] ${name}: no response after ${CLEAR_STEP_TIMEOUT_MS / 1000}s, skipping`);
      resolve(false);
    }, CLEAR_STEP_TIMEOUT_MS);
    promise.then(
      () => { if (!finished) { finished = true; clearTimeout(timer); console.log(`[capture] ${name}: done`); resolve(true); } },
      (err) => { if (!finished) { finished = true; clearTimeout(timer); console.log(`[capture] ${name}: failed (${err.message})`); resolve(false); } }
    );
  });
}

// Clear the cookies and other stored data of the capture partition,
// so every run starts from the login screen. Never throws.
async function clearLoginState() {
  const ses = session.fromPartition(PARTITION);

  const cookiesCleared = await withTimeout(
    ses.clearStorageData({ storages: ['cookies'] }),
    'clear cookies'
  );
  if (!cookiesCleared) {
    // Fallback: remove the cookies one by one.
    const list = await withTimeout(
      ses.cookies.get({}).then(async (cookies) => {
        for (const c of cookies) {
          const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
          await ses.cookies.remove(url, c.name).catch(() => {});
        }
      }),
      'remove cookies one by one'
    );
    void list;
  }

  await withTimeout(ses.clearCache(), 'clear cache');

  await withTimeout(
    ses.clearStorageData({
      storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem'],
    }),
    'clear site data'
  );
}

// ---- IPC -------------------------------------------------------------------

ipcMain.handle('start-capture', async () => {
  if (!captureWin || captureWin.isDestroyed()) {
    return { ok: false, error: 'Open the login window first.' };
  }
  const wc = captureWin.webContents;
  try {
    const url = wc.getURL();
    if (!ALLOWED_URL.test(url)) {
      return { ok: false, error: 'The current page is not on claude.ai.' };
    }

    const lines = await runCapture(wc);
    const meta = { title: wc.getTitle(), url };

    if (lines.length === 0) {
      // Dump the DOM so the cause can be inspected
      const dump = await wc.executeJavaScript(DOM_DUMP_JS);
      const dumpPath = path.join(app.getPath('userData'), `debug-${Date.now()}.html`);
      fs.writeFileSync(dumpPath, dump, 'utf8');
      return { ok: false, error: `No content was captured. Debug DOM saved to: ${dumpPath}` };
    }

    const saved = await saveResult(lines, meta);
    if (!saved) return { ok: false, error: 'Save was cancelled.' };
    return { ok: true, count: lines.length, path: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- App lifecycle ---------------------------------------------------------

app.whenReady().then(async () => {
  console.log('[capture] clearing stored login state');
  await clearLoginState();
  console.log('[capture] creating window');
  createCaptureWindow();
});
app.on('window-all-closed', () => app.quit());
