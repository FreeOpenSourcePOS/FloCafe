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
const realProcessExit = process.exit.bind(process);
let releaseServerStart;
let rejectServerStart;

if (startupRace || startupFailureRace) {
  process.exit = (code = 0) => { exitCodes.push(code); };
}

function register(event, listener) {
  const listeners = appListeners.get(event) || [];
  listeners.push(listener);
  appListeners.set(event, listeners);
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
  quit: () => { events.push('app.quit'); },
  exit: (code = 0) => { exitCodes.push(code); },
  focus() {},
};

const log = {
  initialize() {},
  transports: {
    file: { level: 'info', getFile: () => ({ path: path.join(testDir, 'test.log') }) },
    console: { level: 'debug' },
  },
  debug() {},
  error() {},
  warn() {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app,
      BrowserWindow: class {},
      ipcMain: { handle() {} },
      dialog: { showErrorBox: () => { events.push('dialog.showErrorBox'); } },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
      Tray: class {},
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  if (request === 'electron-log/main' || request === 'electron-log') return log;
  if (request === 'electron-updater') return { autoUpdater: { on() {} } };
  if (request === './db') {
    class SchemaVersionMismatchError extends Error {}
    return {
      initDatabase: () => {
        events.push('database.init');
        if (!startupRace && !startupFailureRace) throw new Error('simulated startup failure');
      },
      beginDatabaseShutdown: () => { events.push('database.admission'); },
      closeDatabase: () => { events.push('database.close'); },
      waitForDatabaseRequests: () => Promise.resolve(),
      SchemaVersionMismatchError,
    };
  }
  if (request === './server') return {
    startServer: () => {
      events.push('server.start');
      if (!startupRace && !startupFailureRace) return Promise.resolve();
      return new Promise((resolve, reject) => {
        releaseServerStart = resolve;
        rejectServerStart = reject;
      });
    },
    stopServer: async () => {
      events.push('server.stop');
      if (startupFailureRace) rejectServerStart?.(new Error('simulated startup failure after shutdown'));
      else releaseServerStart?.();
    },
    getLocalIP: () => '127.0.0.1',
    getServerPort: () => 0,
    isServerRunning: () => false,
  };
  if (request === './kds-server') return {
    startKdsServer: async () => { events.push('kds.start'); },
    stopKdsServer: async () => { events.push('kds.stop'); },
    getKdsPort: () => 0,
    isKdsServerRunning: () => false,
  };
  if (request === './server-app') return {
    startServerApp: async () => { events.push('server-app.start'); },
    stopServerApp: async () => { events.push('server-app.stop'); },
    getServerAppPort: () => 0,
    isServerAppRunning: () => false,
  };
  if (request === './services/cloud-sync') return { cloudSync: { shutdown: async () => { events.push('cloud.shutdown'); } } };
  if (request === './services/telemetry') return {
    telemetry: {
      start() { events.push('telemetry.start'); },
      stop: () => { events.push('telemetry.stop'); },
    },
    sendEvent: async () => { events.push('telemetry.startup-failed'); return true; },
  };
  if (request === './services/google-drive') return {
    googleDrive: {
      start() { events.push('drive.start'); },
      stop: () => { events.push('drive.stop'); },
    },
  };
  if (request === './printers/thermal') return { initPrinter: async () => {}, printReceipt() {}, printKOT() {} };
  if (request === './ipc') return { registerIpcHandlers() {} };
  if (request === './services/whatsapp') return {
    initFromDb() {},
    requestShutdown() {},
    shutdown: async () => { events.push('whatsapp.stop'); },
  };
  return originalLoad.apply(this, arguments);
};

require('../main/index.ts');

if (startupRace || startupFailureRace) {
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0);
}

setTimeout(() => {
  const expectedOrder = startupRace || startupFailureRace
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
      'telemetry.startup-failed',
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
  const passed = orderMatches && (startupFailureRace
    ? exitCodes.length === 1 && exitCodes[0] === 1 && !events.includes('telemetry.start') && !events.includes('drive.start')
    : startupRace
    ? exitCodes.length === 1 && exitCodes[0] === 0 && !events.includes('telemetry.start') && !events.includes('drive.start')
    : exitCodes.length === 1 && exitCodes[0] === 1);
  process.stdout.write(JSON.stringify({ passed, events, exitCodes }) + '\n');
  fs.rmSync(testDir, { recursive: true, force: true });
  Module._load = originalLoad;
  realProcessExit(passed ? 0 : 1);
}, startupRace || startupFailureRace ? 100 : 50);
