const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-startup-failure-'));
const events = [];
const exitCodes = [];
const appListeners = new Map();
const startupRace = process.env.FLO_STARTUP_RACE === '1';
const startupFailureRace = process.env.FLO_STARTUP_FAILURE_RACE === '1';
const newerDbMode = process.env.FLO_STARTUP_NEWER_DB_MODE || '';
if (newerDbMode === 'restore') {
  process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK = '1';
}
const realProcessExit = process.exit.bind(process);
let releaseServerStart;
let rejectServerStart;

if (startupRace || startupFailureRace || newerDbMode === 'shutdown') {
  process.exit = (code = 0) => {
    exitCodes.push(code);
  };
}

function register(event, listener) {
  const listeners = appListeners.get(event) || [];
  listeners.push(listener);
  appListeners.set(event, listeners);
}

function emitAppEvent(event, ...args) {
  for (const listener of appListeners.get(event) || []) {
    listener(...args);
  }
}

const app = {
  isPackaged: true,
  commandLine: { appendSwitch() {} },
  name: 'flo-test',
  setPath() {},
  getPath: () => testDir,
  getVersion: () => 'test',
  getName: () => 'Flo Test',
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  on: register,
  quit: () => {
    events.push('app.quit');
  },
  relaunch: () => {
    events.push('app.relaunch');
  },
  exit: (code = 0) => {
    exitCodes.push(code);
  },
  focus() {},
};

const log = {
  initialize() {},
  transports: {
    file: { level: 'info', getFile: () => ({ path: path.join(testDir, 'test.log') }) },
    console: { level: 'debug' },
  },
  debug() {},
  info() {},
  error() {},
  warn() {},
};

let initDatabaseCalls = 0;
let messageBoxCalls = 0;
let serverRunning = false;
let kdsRunning = false;
let serverAppRunning = false;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app,
      BrowserWindow: class {
        webContents = {
          on() {},
          once() {},
          send() {},
          setWindowOpenHandler() {},
          getURL: () => 'http://127.0.0.1:3001/',
          focus() {},
          session: {
            on() {},
            setDevicePermissionHandler() {},
          },
        };
        on() {}
        once() {}
        loadURL() {
          return Promise.resolve();
        }
        isDestroyed() {
          return false;
        }
        isMinimized() {
          return false;
        }
        isMaximized() {
          return false;
        }
        isFullScreen() {
          return false;
        }
        isVisible() {
          return true;
        }
        getSize() {
          return [1280, 800];
        }
        setSize() {}
        hide() {}
        restore() {}
        show() {}
        focus() {}
        destroy() {}
      },
      ipcMain: { handle() {}, removeHandler() {} },
      dialog: {
        showErrorBox: () => {
          events.push('dialog.showErrorBox');
        },
        showMessageBox: async (options) => {
          messageBoxCalls += 1;
          events.push(`dialog.showMessageBox:${options.title}`);
          if (newerDbMode === 'exit') {
            await new Promise((resolve) => setImmediate(resolve));
            emitAppEvent('activate');
            emitAppEvent('second-instance');
            return { response: 3 };
          }
          if (newerDbMode === 'update') {
            return { response: 0 };
          }
          if (newerDbMode === 'restore' || newerDbMode === 'shutdown') {
            if (messageBoxCalls === 1) {
              if (newerDbMode === 'restore') {
                await new Promise((resolve) => setImmediate(resolve));
                emitAppEvent('activate');
                emitAppEvent('second-instance');
              }
              return { response: 2 };
            }
            if (messageBoxCalls === 2) return { response: 0 };
            if (messageBoxCalls === 3) return { response: 0 };
          }
          return { response: options.cancelId ?? 0 };
        },
      },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
      Tray: class {
        setToolTip() {}
        setContextMenu() {}
        on() {}
        destroy() {}
      },
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
      nativeTheme: { shouldUseDarkColors: false, on() {} },
      powerMonitor: { on() {} },
      session: { defaultSession: { setDevicePermissionHandler() {} } },
      shell: {
        openExternal: () => {
          events.push('shell.openExternal');
          return Promise.resolve();
        },
        openPath: () => {
          events.push('shell.openPath');
          return Promise.resolve('');
        },
      },
    };
  }
  if (request === 'electron-log/main' || request === 'electron-log') return log;
  if (request === 'electron-updater')
    return { autoUpdater: { on() {}, currentVersion: { prerelease: [] } } };
  if (request === './db') {
    class SchemaVersionMismatchError extends Error {
      constructor(dbVersion, appVersion, dbAppVersion = null) {
        super(`Database schema (v${dbVersion}) is newer than v${appVersion}`);
        this.name = 'SchemaVersionMismatchError';
        this.dbVersion = dbVersion;
        this.appVersion = appVersion;
        this.dbAppVersion = dbAppVersion;
      }
    }
    return {
      initDatabase: () => {
        initDatabaseCalls += 1;
        events.push('database.init');
        if (newerDbMode && initDatabaseCalls === 1) {
          throw new SchemaVersionMismatchError(999, 121, '9.9.9');
        }
        if (newerDbMode === 'restore' && initDatabaseCalls > 1) {
          return;
        }
        if (!startupRace && !startupFailureRace) throw new Error('simulated startup failure');
      },
      getDatabase: () => ({
        prepare: () => ({ get: () => undefined }),
      }),
      getBackupDir: () => path.join(testDir, 'backups'),
      getDbPath: () => path.join(testDir, 'flo.db'),
      discoverDowngradeBackups: () => ({
        backupDir: path.join(testDir, 'backups'),
        maxSupportedSchemaVersion: 121,
        compatible: [
          {
            fileName: 'flo-backup-2026-10-28-pre-v120-to-v121.db',
            path: path.join(testDir, 'backups', 'flo-backup-2026-10-28-pre-v120-to-v121.db'),
            sizeBytes: 4096,
            createdAt: '2026-10-28T10:00:00.000Z',
            backupCreatedAt: '2026-10-28T10:00:00.000Z',
            appVersion: '3.13.14',
            schemaVersion: 120,
            kind: 'pre-upgrade',
          },
        ],
        incompatibleNewer: [],
        corruptOrInvalid: [],
      }),
      planNewerDatabaseArchivePath: (version) =>
        path.join(testDir, 'backups', `flo-preserved-newer-v${version}-test.db`),
      restoreCompatibleBackupForDowngrade: async (backupPath, options) => {
        const hasSignal = Boolean(options?.signal && typeof options.signal.aborted === 'boolean');
        events.push(
          hasSignal ? 'database.downgradeRestore' : 'database.downgradeRestore:missingSignal',
        );
        if (newerDbMode === 'shutdown') {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                events.push('database.downgradeRestore.aborted');
                const abortErr = new Error('Database maintenance cancelled during shutdown');
                abortErr.code = 'ERR_SHUTDOWN_ABORTED';
                reject(abortErr);
              },
              { once: true },
            );
            setImmediate(() => process.emit('SIGTERM'));
          });
        }
        return {
          restoredBackupPath: backupPath,
          backupSchemaVersion: 120,
          restoredSchemaVersion: 121,
          preservedDbPath: path.join(testDir, 'backups', 'flo-preserved-newer-v999-test.db'),
          preservedSidecarPaths: [],
        };
      },
      isSchemaVersionMismatchError: (err) => err instanceof SchemaVersionMismatchError,
      beginDatabaseShutdown: () => {
        events.push('database.admission');
      },
      closeDatabase: () => {
        events.push('database.close');
      },
      waitForDatabaseRequests: () => Promise.resolve(),
      now: () => '2026-10-29 00:00:00',
      withDatabaseRequest: (fn) => fn(),
      SchemaVersionMismatchError,
    };
  }
  if (request === './server')
    return {
      startServer: () => {
        events.push('server.start');
        if (!startupRace && !startupFailureRace) {
          serverRunning = true;
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          releaseServerStart = resolve;
          rejectServerStart = reject;
        });
      },
      stopServer: async () => {
        serverRunning = false;
        events.push('server.stop');
        if (startupFailureRace)
          rejectServerStart?.(new Error('simulated startup failure after shutdown'));
        else releaseServerStart?.();
      },
      getLocalIP: () => '127.0.0.1',
      getServerPort: () => 0,
      isServerRunning: () => serverRunning,
    };
  if (request === './kds-server')
    return {
      startKdsServer: async () => {
        kdsRunning = true;
        events.push('kds.start');
      },
      stopKdsServer: async () => {
        kdsRunning = false;
        events.push('kds.stop');
      },
      getKdsPort: () => 0,
      isKdsServerRunning: () => kdsRunning,
    };
  if (request === './server-app')
    return {
      startServerApp: async () => {
        serverAppRunning = true;
        events.push('server-app.start');
      },
      stopServerApp: async () => {
        serverAppRunning = false;
        events.push('server-app.stop');
      },
      getServerAppPort: () => 0,
      isServerAppRunning: () => serverAppRunning,
    };
  if (request === './services/cloud-sync')
    return {
      cloudSync: {
        start: () => {
          if (newerDbMode === 'restore') events.push('cloud.start');
        },
        captureOperationFailure: () => {
          events.push('diagnostics.capture');
        },
        shutdown: async () => {
          events.push('cloud.shutdown');
        },
      },
    };
  if (newerDbMode === 'restore' && request === './services/local-backup')
    return {
      localBackup: {
        start: () => {
          events.push('local-backup.start');
        },
        stop: () => {},
      },
    };
  if (newerDbMode === 'restore' && request === './services/posthog')
    return {
      startPostHog: () => {},
      stopPostHog: () => {},
      capturePostHogException: () => {},
    };
  if (request === './services/telemetry')
    return {
      telemetry: {
        start() {
          events.push('telemetry.start');
        },
        stop: () => {
          events.push('telemetry.stop');
        },
      },
    };
  if (request === './services/google-drive')
    return {
      googleDrive: {
        start() {
          events.push('drive.start');
        },
        stop: () => {
          events.push('drive.stop');
        },
      },
    };
  if (request === './printers/thermal')
    return { initPrinter: async () => {}, printReceipt() {}, printKOT() {} };
  if (request === './backend-health')
    return {
      probeBackendHealth: async () => serverRunning && kdsRunning && serverAppRunning,
    };
  if (request === './ipc') return { registerIpcHandlers() {} };
  if (request === './services/whatsapp')
    return {
      initFromDb() {},
      requestShutdown() {},
      shutdown: async () => {
        events.push('whatsapp.stop');
      },
    };
  return originalLoad.apply(this, arguments);
};

require('../main/index.ts');

if (startupRace || startupFailureRace) {
  setTimeout(() => process.emit('SIGTERM'), 0);
}

setTimeout(
  () => {
    let passed = false;
    if (newerDbMode === 'exit') {
      const expectedExitOrder = [
        'database.init',
        'database.close',
        'dialog.showMessageBox:Newer Database Detected',
        'server-app.stop',
        'server.stop',
        'kds.stop',
        'cloud.shutdown',
        'telemetry.stop',
        'drive.stop',
        'whatsapp.stop',
        'database.admission',
        'database.close',
      ];
      passed =
        expectedExitOrder.every((event, index) => events[index] === event) &&
        !events.includes('app.relaunch') &&
        !events.includes('dialog.showErrorBox') &&
        !events.includes('diagnostics.capture') &&
        exitCodes.length === 1 &&
        exitCodes[0] === 0;
    } else if (newerDbMode === 'update') {
      const expectedUpdateOrder = [
        'database.init',
        'database.close',
        'dialog.showMessageBox:Newer Database Detected',
        'shell.openExternal',
        'server-app.stop',
        'server.stop',
        'kds.stop',
        'cloud.shutdown',
        'telemetry.stop',
        'drive.stop',
        'whatsapp.stop',
        'database.admission',
        'database.close',
      ];
      passed =
        expectedUpdateOrder.every((event, index) => events[index] === event) &&
        !events.includes('app.relaunch') &&
        !events.includes('dialog.showErrorBox') &&
        !events.includes('diagnostics.capture') &&
        exitCodes.length === 1 &&
        exitCodes[0] === 0;
    } else if (newerDbMode === 'restore') {
      const expectedRestoreOrder = [
        'database.init',
        'database.close',
        'dialog.showMessageBox:Newer Database Detected',
        'dialog.showMessageBox:Select Compatible Backup',
        'dialog.showMessageBox:Confirm Backup Restore',
        'database.downgradeRestore',
        'database.init',
        'server.start',
        'cloud.start',
        'telemetry.start',
        'drive.start',
        'local-backup.start',
        'kds.start',
        'server-app.start',
      ];
      passed =
        expectedRestoreOrder.every((event, index) => events[index] === event) &&
        !events.includes('app.relaunch') &&
        !events.includes('dialog.showErrorBox') &&
        !events.includes('diagnostics.capture') &&
        exitCodes.length === 0;
    } else if (newerDbMode === 'shutdown') {
      const expectedShutdownOrder = [
        'database.init',
        'database.close',
        'dialog.showMessageBox:Newer Database Detected',
        'dialog.showMessageBox:Select Compatible Backup',
        'dialog.showMessageBox:Confirm Backup Restore',
        'database.downgradeRestore',
        'database.downgradeRestore.aborted',
        'server-app.stop',
        'server.stop',
        'kds.stop',
        'cloud.shutdown',
        'telemetry.stop',
        'drive.stop',
        'whatsapp.stop',
        'database.admission',
        'database.close',
      ];
      passed =
        expectedShutdownOrder.every((event, index) => events[index] === event) &&
        !events.includes('dialog.showMessageBox:Backup Restore Failed') &&
        !events.includes('app.relaunch') &&
        !events.includes('dialog.showErrorBox') &&
        !events.includes('diagnostics.capture') &&
        exitCodes.length === 1 &&
        exitCodes[0] === 0;
    } else {
      const expectedOrder =
        startupRace || startupFailureRace
          ? [
              'database.init',
              'server.start',
              'server-app.stop',
              'server.stop',
              'kds.stop',
              'cloud.shutdown',
              'telemetry.stop',
              'drive.stop',
              'whatsapp.stop',
              'database.admission',
              'database.close',
            ]
          : [
              'database.init',
              'dialog.showErrorBox',
              'diagnostics.capture',
              'server-app.stop',
              'server.stop',
              'kds.stop',
              'cloud.shutdown',
              'telemetry.stop',
              'drive.stop',
              'whatsapp.stop',
              'database.admission',
              'database.close',
            ];
      const orderMatches = expectedOrder.every((event, index) => events[index] === event);
      passed =
        orderMatches &&
        (startupFailureRace
          ? exitCodes.length === 1 &&
            exitCodes[0] === 1 &&
            !events.includes('telemetry.start') &&
            !events.includes('drive.start')
          : startupRace
            ? exitCodes.length === 1 &&
              exitCodes[0] === 0 &&
              !events.includes('telemetry.start') &&
              !events.includes('drive.start')
            : exitCodes.length === 1 && exitCodes[0] === 1);
    }
    process.stdout.write(JSON.stringify({ passed, events, exitCodes }) + '\n');
    fs.rmSync(testDir, { recursive: true, force: true });
    Module._load = originalLoad;
    realProcessExit(passed ? 0 : 1);
  },
  startupRace || startupFailureRace || newerDbMode ? 100 : 50,
);
