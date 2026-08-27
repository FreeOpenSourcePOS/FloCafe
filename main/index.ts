import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Bonjour } from 'bonjour-service';
import { getDatabase, initDatabase, closeDatabase, waitForDatabaseRequests, beginDatabaseShutdown, SchemaVersionMismatchError, now, withDatabaseRequest } from './db';
import { BETA_CHANNEL_SETTING_KEY, parseStoredBetaChannelEnabled, resolveUpdateChannel } from './update-channel';
import { computeTaxPackUpdates, fetchRemoteTaxPackCatalog } from './tax-packs/catalog';
import { startServer, stopServer, getLocalIP, isServerRunning, getServerPort } from './server';
import { cloudSync } from './services/cloud-sync';
import { telemetry, sendEvent as sendTelemetryEvent } from './services/telemetry';
import { googleDrive } from './services/google-drive';
import { startKdsServer, stopKdsServer, getKdsPort, isKdsServerRunning } from './kds-server';
import { startServerApp, stopServerApp, getServerAppPort, isServerAppRunning } from './server-app';
import { initPrinter } from './printers/thermal';
import { registerIpcHandlers } from './ipc';
import { authorizeMasterPin } from './services/master-pin';
import { initFromDb as initWhatsAppFromDb, requestShutdown as requestWhatsAppShutdown, shutdown as shutdownWhatsApp } from './services/whatsapp';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { isAllowedLocalWindowUrl, isSafeExternalUrl } from './security/url-allowlist';
import {
  classifyUpdateError,
  initialUpdateState,
  isMissingUpdateConfigError,
  isUpdateCheckInFlight,
  isInstallReady,
  isDevelopmentOrUnpackedArtifact,
  missingUpdateConfigState,
  oneShotUpdateState,
  toIpcUpdateStatus,
  type StoredUpdateStatus,
  type UpdateErrorPhase,
} from './update-state';
import { clearStaleRenderCachesOnVersionChange } from './startup-cache';
import { createLocalWindowOpenHandler, createMainWindow, resolveTitleBarMode, type TitleBarMode } from './window-options';
import {
  beginRendererDocument,
  getRendererDocumentNonce,
  getRendererReadinessEpoch,
  initWindowReadiness,
  isRendererReadinessFailSafeShown,
  isFullDocumentMainFrameNavigation,
  isWindowRendererReady,
} from './window-readiness';
import { setupWindowLoadRetry } from './window-load-retry';
import { registerUsbDevicePermissions } from './usb-device-permissions';
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
const UNPACKED_DEV_MARKER = 'flo-unpacked-dev.marker';

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
let betaChannelTransitionTail: Promise<void> = Promise.resolve();

// Beta-channel opt-in persistence (#463, decision #503). The preference lives
// in the same SQLite settings store as the rest of the app configuration so it
// survives restarts; failures degrade to "stable" (the safe default) instead
// of breaking the updater.
function readBetaChannelEnabled(): boolean {
  try {
    const row = getDatabase()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(BETA_CHANNEL_SETTING_KEY) as { value: string | null } | undefined;
    const prerelease = autoUpdater.currentVersion.prerelease[0];
    const isBetaBuild = prerelease === 'beta';
    return parseStoredBetaChannelEnabled(row?.value, isBetaBuild);
  } catch (error) {
    log.warn('[Update] Could not read beta-channel preference; using stable:', error);
    return false;
  }
}

function writeBetaChannelEnabled(enabled: boolean): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(BETA_CHANNEL_SETTING_KEY, enabled ? 'true' : 'false', now());
}

function enqueueBetaChannelTransition<T>(operation: () => Promise<T>): Promise<T> {
  const transition = betaChannelTransitionTail.then(operation, operation);
  betaChannelTransitionTail = transition.then(() => undefined, () => undefined);
  return transition;
}

function configureAutoUpdaterChannel(betaOptInOverride?: boolean): void {
  const prerelease = autoUpdater.currentVersion.prerelease[0];
  const versionChannel = typeof prerelease === 'string' ? prerelease : null;
  const resolved = resolveUpdateChannel({
    versionPrereleaseChannel: versionChannel,
    betaOptIn: betaOptInOverride ?? readBetaChannelEnabled(),
  });

  autoUpdater.channel = resolved.channel;
  autoUpdater.allowPrerelease = resolved.allowPrerelease;
  // Downgrade is only enabled for beta builds remaining on the beta feed;
  // opting out or running stable disables downgrades to safely graduate on
  // the next matching or newer stable release.
  autoUpdater.allowDowngrade = resolved.allowDowngrade;

  if (resolved.channel) {
    log.info(`[Update] Opted into ${resolved.channel} release channel`);
  } else if (versionChannel) {
    // Do not let an unsupported prerelease (nightly stamp, local alpha, ...)
    // accidentally subscribe an installation to an untracked channel (#503:
    // nightly releases are rejected; such installs get stable updates).
    log.warn(`[Update] Unsupported prerelease channel ${versionChannel}; using stable updates only`);
  }
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

  if (isUpdateCheckInFlight(storedUpdateStatus, updaterPhase)) {
    log.info('[Update] Ignoring check while another update operation is in progress');
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

  const isUpdaterDevelopmentArtifact = isDevelopmentOrUnpackedArtifact({
    defaultApp: (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true,
    packaged: app.isPackaged,
    unpackedMarker: fs.existsSync(path.join(process.resourcesPath, UNPACKED_DEV_MARKER)),
  });
  const configPath = path.join(process.resourcesPath, 'app-update.yml');
  let configMissing = false;
  let configProbeFailed = false;
  let configProbeError: unknown;
  if (!isUpdaterDevelopmentArtifact) {
    try {
      fs.statSync(configPath);
    } catch (error) {
      if (isMissingUpdateConfigError(error)) {
        configMissing = true;
      } else {
        configProbeFailed = true;
        configProbeError = error;
      }
    }
  }
  const configDetail = `app-update.yml not found at ${configPath}`;
  if (isUpdaterDevelopmentArtifact) {
    log.debug('[Update] Skipping update check in dev mode');
    setUpdateStatus(oneShotUpdateState('dev-mode'));
    return;
  }

  if (configProbeFailed) {
    const classified = classifyUpdateError(configProbeError, 'check');
    log.info(
      `[Update] Update configuration probe classified as ${classified.state}` +
      `/${classified.reason}:`, classified.detail
    );
    setUpdateStatus({
      status: classified.state,
      reason: classified.reason,
      error: classified.detail
    });
    return;
  }

  if (configMissing) {
    log.info('[Update] Packaged build is missing app-update.yml at', configPath);
    setUpdateStatus(missingUpdateConfigState(false, configDetail));
    return;
  }

  updaterPhase = 'check';
  setUpdateStatus({ status: 'checking' });
  autoUpdater.checkForUpdates().catch((err) => {
    // The `error` event above records the honest classified state; this
    // catch only prevents an unhandled promise rejection.
    console.error('[Update] Check failed:', err);
  });
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
// createWindow() can run more than once per app lifetime (renderer crash
// recovery, macOS 'activate') but every window shares the same default
// session (no partition/session is set in webPreferences) — registering
// again on each call would stack duplicate 'select-usb-device' listeners
// on that shared session, firing multiple confirmation dialogs per request.
let usbDevicePermissionsRegistered = false;

// Title-bar capability reported to the renderer via get-status; updated each
// time the main window is created.
let resolvedTitleBarMode: TitleBarMode = 'native-overlay';
let bonjour: InstanceType<typeof Bonjour> | null = null;
let isQuitting = false;

function showMainWindow(): boolean {
  if (
    (!isWindowRendererReady() && !isRendererReadinessFailSafeShown())
    || !mainWindow
    || mainWindow.isDestroyed()
  ) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  return true;
}

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
      if (showMainWindow()) {
        mainWindow.focus();
        if (process.platform === 'linux') {
          mainWindow.setAlwaysOnTop(true);
          mainWindow.setAlwaysOnTop(false);
          app.focus();
        }
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

  // Readiness lifecycle: register the fail-safe show path and begin the first
  // document epoch before anything loads. Every subsequent full-document
  // navigation re-begins via the did-start-navigation hook below.
  initWindowReadiness(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  beginRendererDocument();

  // Decide once per window whether the native titleBarOverlay can be relied
  // on (platform + Electron >= 33 + the overlay API actually present). When
  // it cannot, the window ships without overlay options and the renderer
  // mounts HTML fallback controls so we never end up hidden-with-no-controls.
  resolvedTitleBarMode = resolveTitleBarMode({
    platform: process.platform,
    electronVersion: process.versions.electron,
    overlayApiPresent: typeof BrowserWindow.prototype?.setTitleBarOverlay === 'function',
  });
  // The app currently has no dark mode (the .dark CSS class is never applied
  // and only light-theme CSS variables are defined). Pass false for isDark so
  // the native titleBarOverlay always uses the light palette (#ffffff bg,
  // #0a0a0a symbols) regardless of the OS light/dark setting, keeping the
  // controls visually consistent with the always-light app content.
  mainWindow = createMainWindow(
    BrowserWindow,
    path.join(__dirname, 'preload.js'),
    process.platform,
    false, // isDark: always light until the app implements a dark theme
    resolvedTitleBarMode,
  );

  mainWindow.once('ready-to-show', () => {
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Begin epochs before the new document's preload runs. Unlike
  // did-start-loading, did-start-navigation exposes whether a navigation is
  // same-document, so Next.js pushState route changes keep the current
  // readiness report while reloads and full navigations invalidate it.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (isFullDocumentMainFrameNavigation({ isSameDocument, isMainFrame })) {
      beginRendererDocument();
    }
  });

  // Always load from the embedded Express server (serves static Next.js export).
  // This avoids file:// protocol issues and keeps dev/prod behaviour identical.
  mainWindow.loadURL(`http://localhost:${getServerPort()}`);

  // Allow target="_blank" links to open new windows for local URLs (e.g. the KDS page)
  // and blank popup windows (e.g. browser print popups). External URLs are sent to the system browser.
  const localWindowOpenHandler = createLocalWindowOpenHandler(isAllowedLocalWindowUrl, getServerPort, getLocalIP);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const localWindowResponse = localWindowOpenHandler({ url });
    if (localWindowResponse) return localWindowResponse;

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

  // Required for the renderer's WebUSB printer flow (PrinterService.connect())
  // to resolve at all — see usb-device-permissions.ts. Registered at most
  // once per app lifetime; see usbDevicePermissionsRegistered above.
  if (!usbDevicePermissionsRegistered) {
    registerUsbDevicePermissions(mainWindow.webContents.session, `http://localhost:${getServerPort()}`);
    usbDevicePermissionsRegistered = true;
  }

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

  setupWindowLoadRetry(mainWindow, () => `http://localhost:${getServerPort()}`, { log });

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
              if (showMainWindow()) mainWindow.focus();
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
          if (showMainWindow()) mainWindow.focus();
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
      { label: 'Open Flo', click: () => { showMainWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);

    tray.setToolTip('Flo');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { showMainWindow(); });
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
        { label: 'Flo Cafe', click: () => { if (showMainWindow()) mainWindow?.focus(); } },
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
    message: 'Flo Cafe',
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
    registerIpcHandlers(shutdownSignal, () => mainWindow);

    // The app currently presents its light palette regardless of OS theme.
    // Keep the native overlay pinned to that palette until the renderer ships
    // the separate dark-theme behavior tracked in issue #513.

    ipcMain.handle('get-update-status', () =>
      // #467: return the real persisted state (including not-checked-yet and
      // one-shot states) so renderer reloads recover it.
      toIpcUpdateStatus(storedUpdateStatus, app.getVersion())
    );

    ipcMain.handle('check-for-updates', () => {
      checkForUpdates();
    });

    ipcMain.handle('updates:get-beta-channel', () =>
      // Persisted preference only — whether beta releases are *offered* is
      // decided by resolveUpdateChannel at check time, so this stays honest
      // even if the running version forces a specific channel.
      withDatabaseRequest(() => readBetaChannelEnabled())
    );

    ipcMain.handle('updates:set-beta-channel', (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'enabled must be a boolean' };
      }
      return enqueueBetaChannelTransition(() => withDatabaseRequest(async () => {
        // #467 honest-state model: never swap feeds underneath an in-flight or
        // staged update. The renderer surfaces the refusal as a real state
        // instead of silently masking what the updater is doing.
        if (isInstallReady(storedUpdateStatus, stagedUpdateReady)) {
          return { success: false, error: 'A downloaded update is waiting to be installed — install it before switching channels' };
        }
        if (isUpdateCheckInFlight(storedUpdateStatus, updaterPhase)) {
          return { success: false, error: 'An update check or download is in progress — try again once it finishes' };
        }
        try {
          writeBetaChannelEnabled(enabled);
        } catch (error) {
          log.error('[Update] Failed to persist beta-channel preference:', error);
          return { success: false, error: 'Could not save the channel preference' };
        }
        log.info(`[Update] Beta channel ${enabled ? 'enabled' : 'disabled'} by user`);
        // Re-derive allowPrerelease/channel for the running install, then reset
        // to the real pre-check state and immediately re-check against the new
        // feed — the renderer sees genuine states, not a fabricated answer.
        configureAutoUpdaterChannel(enabled);
        setUpdateStatus(initialUpdateState());
        checkForUpdates();
        return { success: true };
      }));
    });

    // #463: restarting to install takes the whole POS down (server, KDS,
    // printing) until the app comes back up, so it is gated behind manager or
    // owner PIN approval. The PIN check runs here in the main process — the
    // same authorizeMasterPin used by every other master-PIN-gated IPC
    // handler — so no renderer path can bypass the guard.
    ipcMain.handle('restart-and-install', (_event, pin?: unknown) => {
      if (!isInstallReady(storedUpdateStatus, stagedUpdateReady)) {
        log.warn('[Update] Ignoring install request before an update is downloaded');
        return { success: false, error: 'No downloaded update is ready to install.' };
      }
      const auth = authorizeMasterPin(typeof pin === 'string' ? pin : undefined, 'ipc:restart-and-install');
      if (!auth.ok) {
        log.warn(`[Update] Restart-to-install denied by Master PIN gate: ${auth.error}`);
        return { success: false, error: auth.error };
      }
      isQuitting = true;
      autoUpdater.quitAndInstall();
      return { success: true };
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
        titleBarMode: resolvedTitleBarMode,
        titleBarEpoch: getRendererReadinessEpoch(),
        titleBarDocumentNonce: getRendererDocumentNonce() ?? undefined,
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
    showMainWindow();
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
