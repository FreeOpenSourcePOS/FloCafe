import { app, BrowserWindow } from 'electron';
import {
  getStatusMessage,
  resolveStatusLanguage,
  RTL_STATUS_LANGUAGES,
  type StatusKey,
} from './status-messages';

function buildPage(title: string, detail: string, dir: string): string {
  return `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1917;--muted:#78716c;--accent:#3646f5}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#fafaf9;--muted:#a8a29e;--accent:#7a86ff}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;box-sizing:border-box;border:1px solid rgba(120,113,108,.35)}
.spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(120,113,108,.3);border-top-color:var(--accent);animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:19px;font-weight:600;margin:0}
p{font-size:13px;line-height:1.45;color:var(--muted);margin:0;max-width:340px}
</style></head><body><div class="spinner"></div><h1 id="t">${escapeHtml(title)}</h1><p id="d">${escapeHtml(detail)}</p>
<script>window.__setStatus=function(t,d,dir){document.documentElement.dir=dir;document.getElementById('t').textContent=t;document.getElementById('d').textContent=d||''}</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

let statusWindow: BrowserWindow | null = null;
let statusLanguage: string | null = null;
let opening: Promise<void> | null = null;
let statusUnavailable = false;

function isOpen(): boolean {
  try {
    return statusWindow !== null && !statusWindow.isDestroyed();
  } catch {
    return false;
  }
}

/** The native E2E harness and unit tests run without a visible status window. */
function isSuppressed(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.FLO_E2E_HIDDEN_WINDOW === '1' ||
    Boolean(process.env.FLO_E2E_DB_PATH)
  );
}

export function hasStatusWindow(): boolean {
  return isOpen();
}

/** Sets the language of later messages from the saved store language (or any locale tag). */
export function setStatusLanguage(tag: string | null | undefined): void {
  if (tag) statusLanguage = resolveStatusLanguage(tag);
}

function currentLanguage(): string {
  if (!statusLanguage) {
    try {
      statusLanguage = resolveStatusLanguage(app.getLocale());
    } catch {
      statusLanguage = 'en';
    }
  }
  return statusLanguage;
}

/** Each message stays up at least this long so an operator can read it. */
const MIN_DWELL_MS = 450;
let messageAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until the current message has been on screen for `minMs`. No-op without a window. */
export async function holdStatus(minMs: number): Promise<void> {
  if (opening) await opening.catch(() => {});
  if (!isOpen()) return;
  const remaining = messageAt + minMs - Date.now();
  if (remaining > 0) await sleep(remaining);
}

/** Closes the window once its last message has been readable for `minMs`. */
export async function closeStatusWhenSeen(minMs: number): Promise<void> {
  statusUnavailable = false;
  const target = statusWindow;
  await holdStatus(minMs);
  if (statusWindow === target) closeStatus();
}

/** Shows (or updates) the small progress window. Never throws. */
export async function showStatus(key: StatusKey, alwaysOnTop = false): Promise<void> {
  if (isSuppressed()) return;
  if (key === 'closing') {
    statusUnavailable = false;
  }
  if (statusUnavailable) return;
  try {
    const language = currentLanguage();
    const [title, detail] = getStatusMessage(key, language);
    const dir = RTL_STATUS_LANGUAGES.has(language) ? 'rtl' : 'ltr';
    if (!isOpen()) {
      if (!opening) {
        opening = openWindow(alwaysOnTop, buildPage(title, detail, dir)).finally(() => {
          opening = null;
        });
        await opening;
        if (isOpen()) messageAt = Date.now();
        return;
      }
      await opening;
    }
    if (!isOpen()) return;
    await holdStatus(MIN_DWELL_MS);
    statusWindow?.setAlwaysOnTop(alwaysOnTop);
    await statusWindow?.webContents.executeJavaScript(
      `window.__setStatus(${JSON.stringify(title)},${JSON.stringify(detail)},${JSON.stringify(dir)})`,
    );
    messageAt = Date.now();
  } catch (error) {
    console.warn('[StatusWindow] Could not update:', error);
    statusUnavailable = true;
    closeStatus();
  }
}

async function openWindow(alwaysOnTop: boolean, page: string): Promise<void> {
  const window = new BrowserWindow({
    width: 440,
    height: 260,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    alwaysOnTop,
    title: 'Flo',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  statusWindow = window;
  window.on('closed', () => {
    if (statusWindow === window) statusWindow = null;
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 2000);
  });
  const load = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).then(
    () => true,
    (error) => {
      console.warn('[StatusWindow] Could not load:', error);
      return false;
    },
  );
  const loaded = await Promise.race([load, timeout]);
  if (timer) clearTimeout(timer);
  if (!loaded) {
    statusUnavailable = true;
    if (statusWindow === window) closeStatus();
    else if (!window.isDestroyed()) window.destroy();
    return;
  }
  if (!window.isDestroyed()) window.show();
}

/** Lets the window paint before a synchronous, blocking step starts. */
export function waitForPaint(): Promise<void> {
  if (!isOpen()) return Promise.resolve();
  return sleep(150);
}

export function closeStatus(): void {
  const window = statusWindow;
  statusWindow = null;
  try {
    if (window && !window.isDestroyed()) window.destroy();
  } catch (error) {
    console.warn('[StatusWindow] Could not close:', error);
  }
}
