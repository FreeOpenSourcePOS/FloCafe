import { app, BrowserWindow } from 'electron';
import {
  getStatusMessage,
  resolveStatusLanguage,
  RTL_STATUS_LANGUAGES,
  type StatusKey,
} from './status-messages';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1917;--muted:#78716c;--accent:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#fafaf9;--muted:#a8a29e;--accent:#f59e0b}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;box-sizing:border-box;border:1px solid rgba(120,113,108,.35)}
.spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(120,113,108,.3);border-top-color:var(--accent);animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:19px;font-weight:600;margin:0}
p{font-size:13px;line-height:1.45;color:var(--muted);margin:0;max-width:340px}
</style></head><body><div class="spinner"></div><h1 id="t"></h1><p id="d"></p>
<script>window.__setStatus=function(t,d,dir){document.documentElement.dir=dir;document.getElementById('t').textContent=t;document.getElementById('d').textContent=d||''}</script></body></html>`;

let statusWindow: BrowserWindow | null = null;
let statusLanguage: string | null = null;
let opening: Promise<void> | null = null;

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

/** Shows (or updates) the small progress window. Never throws. */
export async function showStatus(key: StatusKey, alwaysOnTop = false): Promise<void> {
  if (isSuppressed()) return;
  try {
    if (!isOpen()) {
      opening ??= openWindow(alwaysOnTop).finally(() => {
        opening = null;
      });
      await opening;
    }
    if (!isOpen()) return;
    const language = currentLanguage();
    const [title, detail] = getStatusMessage(key, language);
    const dir = RTL_STATUS_LANGUAGES.has(language) ? 'rtl' : 'ltr';
    statusWindow?.setAlwaysOnTop(alwaysOnTop);
    await statusWindow?.webContents.executeJavaScript(
      `window.__setStatus(${JSON.stringify(title)},${JSON.stringify(detail)},${JSON.stringify(dir)})`,
    );
  } catch (error) {
    console.warn('[StatusWindow] Could not update:', error);
    closeStatus();
  }
}

async function openWindow(alwaysOnTop: boolean): Promise<void> {
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
  const loaded = new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.once('did-fail-load', () => resolve());
    setTimeout(resolve, 2000);
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => {});
  await loaded;
  if (!window.isDestroyed()) window.show();
}

/** Lets the window paint before a synchronous, blocking step starts. */
export function waitForPaint(): Promise<void> {
  if (!isOpen()) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, 80));
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
