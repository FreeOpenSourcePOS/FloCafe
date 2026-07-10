import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Bonjour } from 'bonjour-service';
import { initDatabase, closeDatabase } from './db';
import { startServer, stopServer, getLocalIP, isServerRunning } from './server';
import { cloudSync } from './services/cloud-sync';
import { startKdsServer, stopKdsServer, getKdsPort, isKdsServerRunning } from './kds-server';
import { initPrinter, printReceipt, printKOT } from './printers/thermal';
import { registerIpcHandlers } from './ipc';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';

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

let updateAvailable = false;
let updateDownloaded = false;

function setupAutoUpdater(): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Update] Checking for updates...');
    mainWindow?.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Update] Update available:', info.version);
    updateAvailable = true;
    mainWindow?.webContents.send('update-status', { 
      status: 'available', 
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes 
    });
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Flo ${info.version} is available!`,
      detail: `Release date: ${info.releaseDate}\n\nWould you like to download it now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Update] No updates available');
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Update] Download progress: ${progress.percent.toFixed(1)}%`);
    mainWindow?.webContents.send('update-status', { 
      status: 'downloading',
      percent: progress.percent 
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Update] Download complete:', info.version);
    updateDownloaded = true;
    mainWindow?.webContents.send('update-status', { 
      status: 'ready-to-install',
      version: info.version
    });
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded successfully!',
      detail: `Version ${info.version} is ready to install.\n\nThe update will be installed when you quit the app.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    // 404 means no release artifacts published yet — treat as "up to date", not an error.
    // ENOENT means app-update.yml is missing (e.g. running from unpacked dir) — also not an error.
    const isNonError =
      err.message?.includes('404') ||
      err.message?.includes('Cannot find latest') ||
      err.message?.includes('ENOENT');
    if (isNonError) {
      log.debug('[Update] Skipping update — no config or release artifacts:', err.message);
      mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
    } else {
      log.error('[Update] Error:', err);
      mainWindow?.webContents.send('update-status', { status: 'error', error: err.message });
    }
  });
}

function checkForUpdates(): void {
  // Linux: auto-updater is not supported.
  // AppImage requires the APPIMAGE env var (not always set) and the deb
  // package is managed by apt — electron-updater cannot update either.
  // Skip silently so no error is logged and no error status is sent to the UI.
  if (process.platform === 'linux') return;

  if (isStoreBuild) {
    log.debug('[Update] Store build — updates handled by the platform store');
    mainWindow?.webContents.send('update-status', { status: 'store' });
    return;
  }

  // Unpacked dev builds (electron-builder --dir) don't ship app-update.yml.
  // app.isPackaged can still be true for unpacked builds, so check for the
  // file directly — if it's missing, skip the update check gracefully.
  const configPath = path.join(process.resourcesPath, 'app-update.yml');
  if (!fs.existsSync(configPath)) {
    log.debug('[Update] app-update.yml not found at', configPath, '— skipping (unpacked build)');
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
    return;
  }

  if (!isDev) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Update] Check failed:', err);
    });
  } else {
    log.debug('[Update] Skipping update check in dev mode');
    mainWindow?.webContents.send('update-status', { status: 'dev-mode' });
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bonjour: Bonjour | null = null;
let isQuitting = false;
let hasCleanedUp = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const PORT = parseInt(process.env.PORT || '3001', 10);

let ownsLinuxLock = false;
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

  const lockFilePath = path.join(app.getPath('userData'), 'singleton.lock');
  let isRunning = false;
  if (fs.existsSync(lockFilePath)) {
    try {
      const lockContent = fs.readFileSync(lockFilePath, 'utf8').trim();
      const lockPid = parseInt(lockContent, 10);
      if (!isNaN(lockPid) && fs.existsSync(`/proc/${lockPid}`)) {
        isRunning = true;
      }
    } catch (err) {
      console.error('[Lock] Failed to read existing lock file:', err);
    }
  }

  if (isRunning) {
    console.log('[Lock] Another instance is already running on Linux. Quitting.');
    app.quit();
    process.exit(0);
  } else {
    try {
      // Ensure the directory exists
      const userDataPath = app.getPath('userData');
      if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
      }
      fs.writeFileSync(lockFilePath, process.pid.toString(), 'utf8');
      gotSingleInstanceLock = true;
      ownsLinuxLock = true;
    } catch (err) {
      console.error('[Lock] Failed to write lock file:', err);
    }
  }
} else {
  gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  }
}

if (gotSingleInstanceLock) {
  // Focus the existing window if a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow(): void {
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
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Allow target="_blank" links to open new windows for local URLs (e.g. the KDS page).
  // External URLs are sent to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isLocal = url.startsWith(`http://localhost:${PORT}`) ||
                    url.startsWith(`http://127.0.0.1:${PORT}`) ||
                    url.startsWith(`http://${getLocalIP()}:${PORT}`);
    if (isLocal) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1280,
          height: 800,
          title: 'Flo - Kitchen Display',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    shell.openExternal(url);
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
              app.quit();
              // Fallback: force exit if will-quit does not fire in time
              setTimeout(() => {
                console.log('[Tray] app.quit() hung, forcing exit');
                app.exit(0);
              }, 1000);
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
      port: PORT,
      host: 'flo',   // resolves as flo.local on the LAN
      txt: { version: app.getVersion(), kds: `/kds`, kds_port: String(getKdsPort()) },
    });
    const ip = getLocalIP();
    console.log(`[mDNS] Advertising flo.local:${PORT}  (IP fallback: http://${ip}:${PORT})`);
    console.log(`[mDNS] KDS available at http://flo.local:${getKdsPort()}  (IP fallback: http://${ip}:${getKdsPort()})`);
  } catch (err) {
    console.warn('[mDNS] Could not start Bonjour:', err);
  }
}

function stopMdns(): void {
  if (bonjour) {
    bonjour.unpublishAll(() => bonjour?.destroy());
    bonjour = null;
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Order', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('new-order') },
        { label: 'Quick Search', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('quick-search') },
        { type: 'separator' },
        { label: 'Backup Database', click: () => mainWindow?.webContents.send('backup-database') },
        { label: 'Restore Backup', click: () => mainWindow?.webContents.send('restore-backup') },
        { type: 'separator' },
        { label: 'Exit', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
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
        { label: 'About Flo', click: () => showAbout() },
        ...(isStoreBuild
          ? []
          : [{ label: 'Check for Updates', click: () => checkForUpdates() }]),
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
      `POS URL: http://flo.local:${PORT}`,
      `KDS URL: http://flo.local:${kdsPort}`,
      '',
      `KDS IP fallback: http://${ip}:${kdsPort}`,
    ].join('\n'),
  });
}

async function initialize(): Promise<void> {
  try {
    console.log('[Flo] Initializing...');

    console.log('[Flo] Initializing database...');
    initDatabase();

    console.log('[Flo] Starting local server...');
    await startServer();

    console.log('[Flo] Starting cloud sync...');
    cloudSync.start();

    console.log('[Flo] Starting KDS server on port 3002...');
    await startKdsServer();

    console.log('[Flo] Starting mDNS advertisement...');
    startMdns();

    console.log('[Flo] Initializing printer...');
    await initPrinter();

    console.log('[Flo] Registering IPC handlers...');
    registerIpcHandlers();

    ipcMain.handle('get-update-status', () => ({
      status: updateDownloaded ? 'ready-to-install' as const
        : updateAvailable ? 'available' as const
        : 'up-to-date' as const,
      info: { version: app.getVersion() },
    }));

    ipcMain.handle('check-for-updates', () => {
      checkForUpdates();
    });

    ipcMain.handle('get-status', () => {
      const mem = process.memoryUsage();
      return {
        server: isServerRunning() ? 'running' : 'stopped',
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: process.uptime(),
        port: PORT,
      };
    });

    console.log('[Flo] Creating window...');
    createWindow();
    createTray();
    createMenu();
    // Auto-updater: not supported on Linux (AppImage needs APPIMAGE env var;
    // deb is managed by apt). Skip entirely on Linux to avoid error noise.
    if (!isStoreBuild && process.platform !== 'linux') {
      setupAutoUpdater();
      setTimeout(() => checkForUpdates(), 5000);
    }

    console.log('[Flo] Ready!');
  } catch (error) {
    console.error('[Flo] Initialization error:', error);
    dialog.showErrorBox('Initialization Error', `Failed to start Flo: ${error}`);
    app.quit();
    process.exit(1);
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

// --- Cleanup function (idempotent — safe to call from multiple places) ---
function runCleanup(): void {
  if (hasCleanedUp) return;
  hasCleanedUp = true;
  console.log('[Flo] Running cleanup...');

  // Remove Linux singleton lock
  if (process.platform === 'linux' && ownsLinuxLock) {
    try {
      const lockFilePath = path.join(app.getPath('userData'), 'singleton.lock');
      if (fs.existsSync(lockFilePath)) fs.unlinkSync(lockFilePath);
    } catch (e) { console.error('[Flo] Lock removal error:', e); }
  }

  // Destroy tray to prevent ghost icons on X11/GNOME/KDE
  if (tray) {
    try { tray.destroy(); } catch (e) { console.error('[Flo] tray.destroy error:', e); }
    tray = null;
  }

  // Tear down services — each wrapped so one failure doesn't block others
  try { cloudSync.stop(); } catch (e) { console.error('[Flo] cloudSync.stop error:', e); }
  try { stopMdns(); } catch (e) { console.error('[Flo] stopMdns error:', e); }
  try { stopKdsServer(); } catch (e) { console.error('[Flo] stopKdsServer error:', e); }
  try { stopServer(); } catch (e) { console.error('[Flo] stopServer error:', e); }
  try { closeDatabase(); } catch (e) { console.error('[Flo] closeDatabase error:', e); }

  console.log('[Flo] Goodbye!');
}

app.on('before-quit', () => {
  if (isQuitting) return; // guard against re-entry
  isQuitting = true;
});

app.on('will-quit', (event) => {
  // Run cleanup if it hasn't run yet
  if (!hasCleanedUp) {
    try {
      runCleanup();
    } catch (e) {
      console.error('[Flo] Cleanup failed, retrying:', e);
      event.preventDefault(); // delay quit to retry
      setTimeout(() => {
        runCleanup();
        app.exit(0); // force exit after retry
      }, 500);
      return;
    }
  }
  // Force-destroy window to prevent Linux compositor stall
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
});

app.on('quit', () => {
  runCleanup(); // fallback — defense in depth
});

// --- SIGTERM/SIGINT handlers (Linux/Unix — clean shutdown on external signals) ---
process.on('SIGTERM', () => {
  console.log('[Flo] SIGTERM received, cleaning up...');
  runCleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Flo] SIGINT received, cleaning up...');
  runCleanup();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log.error('[Flo] Uncaught exception:', error);
  console.error('[Flo] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('[Flo] Unhandled rejection:', reason);
  console.error('[Flo] Unhandled rejection:', reason);
});
