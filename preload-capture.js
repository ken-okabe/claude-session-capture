// Shows a "Start capture" panel on the claude.ai page (bottom right)
const { ipcRenderer } = require('electron');

let btn = null;
let statusEl = null;
let running = false;

function buildPanel() {
  const wrap = document.createElement('div');
  wrap.id = '__capture_panel';
  Object.assign(wrap.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    background: '#ffffff',
    color: '#222222',
    border: '1px solid #bbbbbb',
    borderRadius: '8px',
    padding: '10px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '13px',
    maxWidth: '280px',
  });

  btn = document.createElement('button');
  btn.textContent = 'Start capture';
  Object.assign(btn.style, {
    padding: '8px 14px',
    fontSize: '14px',
    cursor: 'pointer',
    background: '#d97757',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
  });

  statusEl = document.createElement('div');
  statusEl.style.marginTop = '8px';
  statusEl.textContent = 'Open the session you want, then press this button.';

  btn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    btn.disabled = true;
    btn.textContent = 'Capturing...';
    const res = await ipcRenderer.invoke('start-capture');
    running = false;
    btn.disabled = false;
    btn.textContent = 'Start capture';
    statusEl.textContent = res.ok
      ? `Done: saved ${res.count} lines.`
      : `Error: ${res.error}`;
  });

  wrap.append(btn, statusEl);
  document.documentElement.appendChild(wrap);
}

// Logged in = not on a login/auth page AND the chat composer is present.
// The login page has no chat input, so the panel stays hidden until login succeeds.
const LOGIN_PATH = /^\/(login|magic-link|oauth|logout|verify)/;
function isLoggedIn() {
  if (LOGIN_PATH.test(location.pathname)) return false;
  return !!document.querySelector('[contenteditable="true"], textarea');
}

// Show the panel only after login; hide it again on the login page.
// While a capture is running, the panel is never removed.
function ensurePanel() {
  if (!document.documentElement) return;
  const existing = document.getElementById('__capture_panel');
  const loggedIn = isLoggedIn();
  if (loggedIn && !existing) buildPanel();
  if (!loggedIn && existing && !running) existing.remove();
}

ipcRenderer.on('progress', (_e, p) => {
  if (statusEl && running) {
    statusEl.textContent = `Capturing: step ${p.step} / ${p.lines} lines`;
  }
});

setInterval(ensurePanel, 1500);
window.addEventListener('DOMContentLoaded', ensurePanel);
