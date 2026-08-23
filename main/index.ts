import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Bonjour } from 'bonjour-service';
import { getDatabase, initDatabase, closeDatabase, waitForDatabaseRequests, beginDatabaseShutdown, SchemaVersionMismatchError } from './db';
import { computeTaxPackUpdates, fetchRemoteTaxPackCatalog } from './tax-packs/catalog';
import { startServer, stopServer, getLocalIP, isServerRunning, getServerPort } from './server';
import { cloudSync } from './services/cloud-sync';
import { telemetry, sendEvent as sendTelemetryEvent } from './services/telemetry';
import { googleDrive } from './services/google-drive';
import { startKdsServer, stopKdsServer, getKdsPort, isKdsServerRunning } from './kds-server';
import { startServerApp, stopServerApp, getServerAppPort, isServerAppRunning } from './server-app';
import { initPrinter } from './printers/thermal';
import { registerIpcHandlers } from './ipc';
import { initFromDb as initWhatsAppFromDb, requestShutdown as requestWhatsAppShutdown, shutdown as shutdownWhatsApp } from './services/whatsapp';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { isAllowedLocalWindowUrl, isSafeExternalUrl } from './security/url-allowlist';
import {
  classifyUpdateError,
  initialUpdateState,
  isInstallReady,
  oneShotUpdateState,
  toIpcUpdateStatus,
  type StoredUpdateStatus,
  type UpdateErrorPhase,
} from './update-state';
import { clearStaleRenderCachesOnVersionChange } from './startup-cache';
import {
  createShutdownCoordinator,
  createShutdownEntrypoints,
  SHUTDOWN_TIMEOUT_MS,
  waitForHttpShutdownWork,
  type ShutdownEntrypointApp,
  type ShutdownEntrypointProcess,
} from './shutdown';

// ── GPU compatibility ────────────────────────────────────────────────────────
// On Windows, some systems hit "GPU process exited unexpectedly" (exit code
// 0xC0000135 = STATUS_DLL_NOT_FOUND) because the GPU sandbox can't find
// required DLLs (outdated drivers, missing Vulkan, etc.).  Disabling the GPU
// sandbox lets the renderer fall back to software/Skia rendering which is
// slower but reliable.  This is a no-op on macOS/Linux.
//
// Trade-off: this removes Chromium's GPU isolation for ALL Windows users,
// not just those with the DLL crash.  For a local desktop POS app the attack
// surface is already large (server binds 0.0.0.0), so the practical risk is
// low.  A conditional approach (detect crash, store flag, re-launch with
// sandbox disabled) adds complexity for minimal security gain here.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// Mac App Store builds: Electron sets process.mas = true inside the MAS sandbox.
// MAS_BUILD=1 is the build-time fallback (dev/CI).
const isMasBuild =
  process.env.MAS_BUILD === '1' ||
  (process as NodeJS.Process & { mas?: boolean }).mas === true;

// Microsoft Store (MSIX) builds: Electron has no process.msix equivalent.
// MSIX apps are always installed under C:\Program Files\WindowsApps\ so
// checking the executable path is the most reliable runtime detection.
const isMsixBuild =
  process.platform === 'win32' &&
  process.execPath.toLowerCase().includes('windowsapps');

// Either store build: skip third-party auto-updater entirely.
const isStoreBuild = isMasBuild || isMsixBuild;

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
const logPath = log.transports.file.getFile().path.replace(/[^\/\\]+$/, '');
console.log('[Log] Log files location:', logPath);

// Single persisted update state (#467): every transition (including one-shot
// startup states and failures) goes through here so a renderer reload can
// recover the truth via get-update-status instead of racing push events.
let storedUpdateStatus: StoredUpdateStatus = initialUpdateState();
let updaterPhase: UpdateErrorPhase = 'check';
let stagedUpdateReady = false;
let startupFailure = false;

function configureAutoUpdaterChannel(): void {
  const prerelease = autoUpdater.currentVersion.prerelease[0];
  const channel = typeof prerelease === 'string' ? prerelease : null;

  // Stable installs intentionally leave channel unset. GitHub's stable
  // provider then follows the repository's explicitly selected latest release.
  // Beta/nightly builds opt in through their semver channel and use the
  // corresponding beta.yml/nightly.yml manifest instead.
  if (channel === 'beta' || channel === 'nightly') {
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = true;
    // Switching between a prerelease channel and stable can legitimately move
    // to a lower semver value, so electron-updater must be allowed to do that.
    autoUpdater.allowDowngrade = true;
    log.info(`[Update] Opted into ${channel} release channel`);
    return;
  }

  // Do not let an unsupported prerelease (for example, a local alpha build)
  // accidentally subscribe an installation to an untracked channel.
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if (channel) log.warn(`[Update] Unsupported prerelease channel ${channel}; using stable updates only`);
}

function setUpdateStatus(next: StoredUpdateStatus): void {
  if (next.status !== storedUpdateStatus.status) {
    const reasonSuffix = next.reason ? ` (${next.reason})` : '';
    log.info(`[Update] Status change: ${storedUpdateStatus.status} -> ${next.status}${reasonSuffix}`);
  }
  storedUpdateStatus = next;
  mainWindow?.webContents.send('update-status', storedUpdateStatus);
}

function setupAutoUpdater(): void {
  autoUpdater.logger = log;
  configureAutoUpdaterChannel();
  // Downloading is harmless and lets the user see a ready-to-install build,
  // but installation must always be an explicit action. A POS may be closed
  // while a payment, printer job, or end-of-day workflow is still in flight.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Update] Checking for updates...');
    updaterPhase = 'check';
    setUpdateStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    // autoDownload is true, so electron-updater starts downloading right after
    // this fires on its own — no dialog, no manual download-update call needed.
    console.log('[Update] Update available, downloading silently:', info.version);
    updaterPhase = 'download';
    setUpdateStatus({
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Update] No updates available');
    setUpdateStatus({ status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Update] Download progress: ${progress.percent.toFixed(1)}%`);
    setUpdateStatus({
      status: 'downloading',
      percent: progress.percent,
      version: storedUpdateStatus.version
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // The renderer's update badge shows a "Restart Now" prompt. Because
    // autoInstallOnAppQuit is disabled, only that explicit action installs it.
    console.log('[Update] Download complete:', info.version);
    stagedUpdateReady = true;
    updaterPhase = 'check';
    setUpdateStatus({
      status: 'ready-to-install',
      version: info.version
    });
  });

  autoUpdater.on('error', (err) => {
    // #467: classify by error code/phase — never emit up-to-date from an
    // error path. The historical substring mask (404 / Cannot find latest /
    // ENOENT => "up to date") hid real check failures from users.
    const errorPhase = updaterPhase;
    const classified = classifyUpdateError(err, errorPhase);
    updaterPhase = 'check';
    log.info(
      `[Update] Updater error classified as ${classified.state}` +
      `/${classified.reason}:`, classified.detail
    );
    if (isInstallReady(storedUpdateStatus, stagedUpdateReady)) {
      log.info('[Update] Preserving ready-to-install status while staged update awaits installation');
      return;
    }
    setUpdateStatus({
      status: classified.state,
      reason: classified.reason,
      error: classified.detail
    });
  });
}

function checkForUpdates(): void {
  if (isInstallReady(storedUpdateStatus, stagedUpdateReady)) {
    log.info('[Update] Ignoring check while a staged update awaits installation');
    return;
  }

  if (updaterPhase === 'download') {
    log.info('[Update] Ignoring check while an update download is in progress');
    return;
  }

  // Linux: only AppImage supports self-update via electron-updater (it sets
  // the APPIMAGE env var at launch). deb/rpm/snap are managed by their
  // package manager / the snap daemon instead — electron-updater can't
  // update those, so tell the renderer and stop instead of letting
  // "Check for Updates" sit there doing nothing forever when clicked.
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    log.info('[Update] Linux non-AppImage install — updates managed by package manager');
    setUpdateStatus(oneShotUpdateState('linux-managed'));
    return;
  }

  if (isStoreBuild) {
    log.debug('[Update] Store build — updates handled by the platform store');
    setUpdateStatus(oneShotUpdateState('store-managed'));
    return;
  }

  // Unpacked dev builds (electron-builder --dir) don't ship app-update.yml.
  // app.isPackaged can still be true for unpacked builds, so check for the
  // file directly — if it's missing, skip the update check gracefully.
  const configPath = path.join(process.resourcesPath, 'app-update.yml');
  if (!fs.existsSync(configPath)) {
    // Unpacked builds cannot self-update; surface that honestly as dev-mode
    // instead of pretending to be up to date (#467).
    log.debug('[Update] app-update.yml not found at', configPath, '— skipping (unpacked build)');
    setUpdateStatus(oneShotUpdateState('dev-mode'));
    return;
  }

  if (!isDev) {
    updaterPhase = 'check';
    setUpdateStatus({ status: 'checking' });
    autoUpdater.checkForUpdates().catch((err) => {
      // The `error` event above records the honest classified state; this
      // catch only prevents an unhandled promise rejection.
      console.error('[Update] Check failed:', err);
    });
  } else {
    log.debug('[Update] Skipping update check in dev mode');
    setUpdateStatus(oneShotUpdateState('dev-mode'));
  }
}

// Separate from the app self-updater above: tax packs are the only plugin
// type FloCafe currently supports, installed from the FloCafe-Plugins GitHub
// Releases catalog rather than through electron-updater. This is a
// best-effort, network-optional check — a store must keep working offline,
// so a failure here only logs and never blocks startup.
async function checkTaxPackUpdatesOnStartup(): Promise<void> {
  try {
    const remote = await fetchRemoteTaxPackCatalog();
    const installedRows = getDatabase().prepare(`
      SELECT pack.id AS pack_id, pack.country, pack.publisher, version.version
      FROM country_packs AS pack
      JOIN country_pack_versions AS version ON version.id = pack.active_version_id
      WHERE pack.status = 'active'
    `).all() as Array<{ pack_id: string; country: string; publisher: string; version: string }>;
    const updates = computeTaxPackUpdates(
      installedRows.map((row) => (
        { packId: row.pack_id, country: row.country, publisher: row.publisher, version: row.version }
      )),
      remote.catalog,
    );
    if (updates.length > 0) {
      const summary = updates.map((update) => `${update.packId} ${update.currentVersion} -> ${update.latestVersion}`).join(', ');
      console.log(`[Tax Packs] ${updates.length} plugin update(s) available: ${summary}`);
    } else {
      console.log('[Tax Packs] Plugin update check: all installed tax packs are up to date');
    }
  } catch (error) {
    console.warn('[Tax Packs] Startup plugin update check skipped (offline or catalog unavailable):', error);
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bonjour: InstanceType<typeof Bonjour> | null = null;
let isQuitting = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let gotSingleInstanceLock = false;

// ── Single-instance lock ──────────────────────────────────────────────────────
// Prevent multiple instances of the app from running simultaneously.
// This is especially important on Linux where the AppImage can be launched
// multiple times without the OS preventing it.
if (process.platform === 'linux') {
  // Explicitly set app name and userData path to prevent Electron from
  // resolving them inside temporary mount paths (e.g. /tmp/.mount_FloXXXXXX)
  app.name = 'flo-desktop';
  app.setPath('userData', path.join(os.homedir(), '.config', 'flo-desktop'));
}

gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[Lock] Another instance is already running. Quitting.');
  app.quit();
  process.exit(0);
}

if (gotSingleInstanceLock) {
  // Focus the existing window if a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (process.platform === 'linux') {
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setAlwaysOnTop(false);
        app.focus();
      }
    }
  });
}

function createWindow(): void {
  // Runs on every call, not just the initial one — the crash-recovery path
  // below (render-process-gone) and the macOS 'activate' handler both call
  // createWindow() again without going through initialize(). If a stale
  // cache directory failed to clear on the previous attempt (e.g. a
  // transient lock), retrying here means the app can still self-heal within
  // the same run instead of only on the next full relaunch.
  clearStaleRenderCachesOnVersionChange(app.getPath('userData'), process.versions.electron, log);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Flo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Always load from the embedded Express server (serves static Next.js export).
  // This avoids file:// protocol issues and keeps dev/prod behaviour identical.
  mainWindow.loadURL(`http://localhost:${getServerPort()}`);

  // Allow target="_blank" links to open new windows for local URLs (e.g. the KDS page)
  // and blank popup windows (e.g. browser print popups). External URLs are sent to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isBlank = url === 'about:blank' || url === '';
    const isLocal = isAllowedLocalWindowUrl(url, getServerPort(), getLocalIP());
    if (isLocal) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: isBlank ? 800 : 1280,
          height: isBlank ? 600 : 800,
          title: isBlank ? 'Print Receipt' : 'Flo - Kitchen Display',
          autoHideMenuBar: isBlank,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => console.warn('[Flo] Failed to open external URL:', err?.message || err));
    } else {
      console.warn('[Flo] Blocked unsafe external URL scheme:', url);
    }
    return { action: 'deny' };
  });

  // Intercept all renderer downloads and show a save dialog instead of
  // auto-saving to Downloads — required for MAS sandbox compliance.
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('documents'), item.getFilename()),
    });
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error('[Window] Renderer process gone:', details.reason);
    console.error('[Window] Renderer process gone:', details.reason);
    
    if (details.reason !== 'clean-exit') {
      dialog.showMessageBox({
        type: 'error',
        title: 'App Crashed',
        message: 'The app crashed and will restart.',
        detail: `Reason: ${details.reason}`,
        buttons: ['OK'],
      }).then(() => {
        mainWindow?.destroy();
        mainWindow = null;
        createWindow();
      });
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log.error('[Window] Failed to load:', errorCode, errorDescription);
    console.error('[Window] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Window] Window became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[Window] Window became responsive again');
  });
}

function createTray(): void {
  if (process.platform === 'linux') {
    // ── Linux system tray ────────────────────────────────────────────────────
    // On Linux the window close button hides the window (same as other
    // platforms), but there is no native macOS-style dock or Windows taskbar
    // integration to bring it back. A system-tray icon gives Linux users a
    // persistent, discoverable way to show the window or fully quit the app
    // (which triggers the existing quit handler that tears down DB, servers,
    // mDNS, etc.).
    const linuxIconPath = isDev
      ? path.join(__dirname, '../../assets/icon-512.png')
      : path.join(process.resourcesPath, 'assets/icon-512.png');

    try {
      const linuxIcon = nativeImage.createFromPath(linuxIconPath);
      tray = new Tray(linuxIcon.resize({ width: 22, height: 22 }));

      const linuxMenu = Menu.buildFromTemplate([
        {
          label: 'Show',
          click: () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            isQuitting = true;
            // On Debian/AppIndicator, quitting while the context menu is open
            // can cause a deadlock. Defer the teardown so the menu can close.
            setTimeout(() => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.destroy();
              }
              // Explicitly destroy tray to release the AppIndicator lock
              if (tray) {
                tray.destroy();
                tray = null;
              }
              // will-quit owns the same awaited cleanup sequence as every
              // other Electron entrypoint. Do not force-exit while resources
              // are still draining.
              app.quit();
            }, 100);
          },
        },
      ]);

      tray.setToolTip('Flo Cafe');
      tray.setContextMenu(linuxMenu);
      // Single-click also shows the window on Linux (no double-click standard).
      tray.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });

      console.log('[Tray] Linux tray created');
    } catch {
      console.log('[Tray] Linux icon not found, skipping tray');
    }
    return;
  }

  // ── macOS / Windows tray ─────────────────────────────────────────────────
  const iconPath = isDev
    ? path.join(__dirname, '../../assets/icon.png')
    : path.join(process.resourcesPath, 'assets/icon.png');

  try {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open Flo', click: () => mainWindow?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);

    tray.setToolTip('Flo');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => mainWindow?.show());
  } catch {
    console.log('[Tray] Icon not found, skipping tray');
  }
}

function startMdns(): void {
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: 'Flo',
      type: 'http',
      port: getServerPort(),
      host: 'flo',   // resolves as flo.local on the LAN
      txt: { version: app.getVersion(), kds: `/kds`, kds_port: String(getKdsPort()), server_app: '/server-standalone', server_app_port: String(getServerAppPort()) },
    });
    const ip = getLocalIP();
    console.log(`[mDNS] Advertising flo.local:${getServerPort()}  (IP fallback: http://${ip}:${getServerPort()})`);
    console.log(`[mDNS] KDS available at http://flo.local:${getKdsPort()}  (IP fallback: http://${ip}:${getKdsPort()})`);
    console.log(`[mDNS] Server App available at http://flo.local:${getServerAppPort()}  (IP fallback: http://${ip}:${getServerAppPort()})`);
  } catch (err) {
    console.warn('[mDNS] Could not start Bonjour:', err);
  }
}

function stopMdns(): Promise<void> {
  // Capture the instance before clearing the global reference. Bonjour invokes
  // this callback later, after unpublishAll has finished.
  const instance = bonjour;
  bonjour = null;
  if (!instance) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Bonjour shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`));
    }, SHUTDOWN_TIMEOUT_MS);

    const finish = (unpublishError?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        instance.destroy();
      } catch (destroyError) {
        if (unpublishError) {
          reject(new AggregateError([unpublishError, destroyError], 'Bonjour shutdown failed'));
        } else {
          reject(destroyError);
        }
        return;
      }
      if (unpublishError) reject(unpublishError);
      else resolve();
    };

    try {
      instance.unpublishAll(() => finish());
    } catch (error) {
      finish(error);
    }
  });
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.getName(),
      submenu: [
        { label: `About ${app.getName()}`, click: () => showAbout() },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Order', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('new-order') },
        { label: 'Quick Search', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('quick-search') },
        { type: 'separator' },
        { label: 'Backup Database', click: () => mainWindow?.webContents.send('backup-database') },
        { label: 'Restore Backup', click: () => mainWindow?.webContents.send('restore-backup') },
        { type: 'separator' },
        { label: 'Database Health Check', click: () => mainWindow?.webContents.send('menu-db-health-check') },
        { label: 'Initialize Database', click: () => mainWindow?.webContents.send('menu-db-initialize') },
        { label: 'Master PIN…', click: () => mainWindow?.webContents.send('menu-master-pin') },
        { type: 'separator' },
        { label: 'Exit', accelerator: process.platform === 'darwin' ? undefined : 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ],
    },
    {
      label: 'Orders',
      submenu: [
        { label: 'View All Orders', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('view-orders') },
      ],
    },
    {
      label: 'Reports',
      submenu: [
        { label: 'Daily Summary', click: () => mainWindow?.webContents.send('report-daily') },
        { label: 'Sales Report', click: () => mainWindow?.webContents.send('report-sales') },
        { label: 'X Report', click: () => mainWindow?.webContents.send('report-x') },
        { label: 'Z Report', click: () => mainWindow?.webContents.send('report-z') },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Business Settings', click: () => mainWindow?.webContents.send('settings-business') },
        { label: 'Tax Settings', click: () => mainWindow?.webContents.send('settings-tax') },
        { label: 'Printer Setup', click: () => mainWindow?.webContents.send('settings-printer') },
        { label: 'Kitchen Stations', click: () => mainWindow?.webContents.send('settings-kitchen') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Flo Cafe', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: 'separator' },
        { role: 'minimize' },
        ...(process.platform === 'darwin' ? [
          { role: 'zoom' as const },
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...(process.platform !== 'darwin' ? [{ label: 'About Flo', click: () => showAbout() }] : []),
        ...(isStoreBuild
          ? []
          : [{ label: 'Check for Updates', click: () => checkForUpdates() }]),
        { label: 'Open Logs Folder', click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
      ],
    },
  ];

  if (isDev) {
    template.push({
      label: 'Developer',
      submenu: [
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function showAbout(): void {
  const ip = getLocalIP();
  const kdsPort = getKdsPort();
  const serverAppPort = getServerAppPort();
  dialog.showMessageBox({
    type: 'info',
    title: 'About Flo',
    message: 'Flo Desktop',
    detail: [
      `Version: ${app.getVersion()}`,
      `Electron: ${process.versions.electron}`,
      `Node: ${process.versions.node}`,
      '',
      'A self-hosted, offline-first Point of Sale system.',
      'Your data stays yours.',
      '',
      `POS URL: http://flo.local:${getServerPort()}`,
      `KDS URL: http://flo.local:${kdsPort}`,
      `Server App URL: http://flo.local:${serverAppPort}`,
      '',
      `KDS IP fallback: http://${ip}:${kdsPort}`,
      `Server App IP fallback: http://${ip}:${serverAppPort}`,
    ].join('\n'),
  });
}

async function initialize(): Promise<void> {
  try {
    if (isShutdownRequested()) return;
    console.log('[Flo] Initializing...');

    console.log('[Flo] Initializing database...');
    initDatabase();
    if (isShutdownRequested()) return;

    console.log('[Flo] Starting local server...');
    await startServer();
    if (isShutdownRequested()) return;

    cloudSync.start();
    telemetry.start();
    googleDrive.start();

    console.log('[Flo] Starting KDS server on port 3002...');
    await startKdsServer();
    if (isShutdownRequested()) return;

    console.log('[Flo] Starting Server App on port 3003...');
    await startServerApp();
    if (isShutdownRequested()) return;

    console.log('[Flo] Initializing WhatsApp service...');
    initWhatsAppFromDb();

    console.log('[Flo] Starting mDNS advertisement...');
    startMdns();

    console.log('[Flo] Initializing printer...');
    await initPrinter();
    if (isShutdownRequested()) return;

    console.log('[Flo] Registering IPC handlers...');
    registerIpcHandlers(shutdownSignal);

    ipcMain.handle('get-update-status', () =>
      // #467: return the real persisted state (including not-checked-yet and
      // one-shot states) so renderer reloads recover it.
      toIpcUpdateStatus(storedUpdateStatus, app.getVersion())
    );

    ipcMain.handle('check-for-updates', () => {
      checkForUpdates();
    });

    ipcMain.handle('restart-and-install', () => {
      if (!isInstallReady(storedUpdateStatus, stagedUpdateReady)) {
        log.warn('[Update] Ignoring install request before an update is downloaded');
        return;
      }
      isQuitting = true;
      autoUpdater.quitAndInstall();
    });

    ipcMain.handle('get-status', () => {
      const mem = process.memoryUsage();
      return {
        server: isServerRunning() ? 'running' : 'stopped',
        kdsServer: isKdsServerRunning() ? 'running' : 'stopped',
        serverApp: isServerAppRunning() ? 'running' : 'stopped',
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: process.uptime(),
        port: getServerPort(),
      };
    });

    console.log('[Flo] Creating window...');
    createWindow();
    createTray();
    createMenu();
    // Auto-updater: wired up on every non-store platform, including Linux now
    // (#58) — checkForUpdates() itself decides whether Linux's build format
    // (AppImage vs deb/rpm/snap) actually supports self-update.
    if (!isStoreBuild) {
      setupAutoUpdater();
      setTimeout(() => checkForUpdates(), 5000);
    } else {
      // Store builds skip electron-updater entirely; seed the persisted state
      // so the renderer shows honest "managed by the store" status from the
      // first load instead of a stale never-checked default (#467).
      setUpdateStatus(oneShotUpdateState('store-managed'));
    }
    setTimeout(() => { void checkTaxPackUpdatesOnStartup(); }, 5000);

    console.log('[Flo] Ready!');
  } catch (error) {
    console.error('[Flo] Initialization error:', error);
    const errorDetails = error as { code?: unknown; name?: unknown } | null;
    const expectedShutdownCancellation = errorDetails?.code === 'ERR_SHUTDOWN_ABORTED'
      || errorDetails?.code === 'ABORT_ERR'
      || errorDetails?.name === 'AbortError';
    if (!expectedShutdownCancellation) startupFailure = true;
    if (isShutdownRequested()) {
      try {
        await runCleanup();
      } catch (cleanupError) {
        console.error('[Flo] Cleanup after interrupted initialization failed:', cleanupError);
      }
      return;
    }
    dialog.showErrorBox('Initialization Error', `Failed to start Flo: ${error}`);

    // Best-effort: report the fatal startup failure so support can see which
    // installs are stuck on a stale build without waiting for a user to
    // describe the error message themselves. The cleanup below remains safe
    // even when initialization failed before the database or listeners opened.
    try {
      const payload: Record<string, unknown> = {
        error_message: String(error instanceof Error ? error.message : error).slice(0, 500),
      };
      if (error instanceof SchemaVersionMismatchError) {
        payload.db_schema_version = error.dbVersion;
        payload.app_schema_version = error.appVersion;
      }
      await sendTelemetryEvent('startup_failed', payload);
    } catch (telemetryError) {
      console.error('[Flo] Failed to report startup error via telemetry:', telemetryError);
    }

    isQuitting = true;
    try {
      await runCleanup();
    } catch (cleanupError) {
      console.error('[Flo] Cleanup after initialization failure failed:', cleanupError);
    }
    // Cleanup has settled (or reported its bounded failure) before exiting.
    app.exit(1);
  }
}

app.whenReady().then(initialize);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// --- Cleanup function (idempotent — safe to call from every entrypoint) ---
const cleanupCoordinator = createShutdownCoordinator(() => [
  {
    name: 'tray',
    run: () => {
      const currentTray = tray;
      tray = null;
      if (currentTray) currentTray.destroy();
    },
  },
  // The Server App can be forwarding an active request to the main API, so
  // drain it before closing the API listener it depends on.
  { name: 'Server App', run: () => stopServerApp(), blocksDatabase: true },
  { name: 'Main server', run: () => stopServer(), blocksDatabase: true },
  { name: 'KDS server', run: () => stopKdsServer(), blocksDatabase: true },
  { name: 'cloud sync', run: () => cloudSync.shutdown(), blocksDatabase: true },
  { name: 'telemetry', run: () => telemetry.stop(), blocksDatabase: true },
  { name: 'Google Drive', run: () => googleDrive.stop(), blocksDatabase: true },
  { name: 'WhatsApp', run: () => shutdownWhatsApp(), blocksDatabase: true },
  { name: 'Bonjour', run: () => stopMdns() },
  { name: 'HTTP handler cleanup', run: () => waitForHttpShutdownWork(), blocksDatabase: true },
  { name: 'database admission', run: () => beginDatabaseShutdown(), blocksDatabase: true },
  { name: 'database requests', run: () => waitForDatabaseRequests(), blocksDatabase: true },
  // Database closure is deliberately last: all HTTP and WebSocket work must
  // have settled before handlers can lose access to SQLite.
  { name: 'database', run: () => closeDatabase(), databaseClose: true },
], { onFatalTimeout: () => app.exit(1) });

const { runCleanup, isShutdownRequested, shutdownSignal } = createShutdownEntrypoints({
  app: app as unknown as ShutdownEntrypointApp,
  process: process as unknown as ShutdownEntrypointProcess,
  cleanup: async () => {
    console.log('[Flo] Running cleanup...');
    try {
      await cleanupCoordinator();
      console.log('[Flo] Goodbye!');
    } catch (error) {
      console.error('[Flo] Cleanup failed:', error);
      throw error;
    }
  },
  setQuitting: () => {
    isQuitting = true;
  },
  onShutdownRequested: requestWhatsAppShutdown,
  destroyWindow: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  },
  reportFailure: (context, error) => {
    console.error(`[Flo] Cleanup failed before ${context}:`, error);
  },
  getSignalExitCode: () => startupFailure ? 1 : 0,
  getQuitExitCode: () => startupFailure ? 1 : 0,
});

process.on('uncaughtException', (error) => {
  log.error('[Flo] Uncaught exception:', error);
  console.error('[Flo] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('[Flo] Unhandled rejection:', reason);
  console.error('[Flo] Unhandled rejection:', reason);
});
