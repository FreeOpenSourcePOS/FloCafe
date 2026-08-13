const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-startup-failure-'));
const events = [];
const exitCodes = [];
const appListeners = new Map();

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
      initDatabase: () => { events.push('database.init'); throw new Error('simulated startup failure'); },
      closeDatabase: () => { events.push('database.close'); },
      waitForDatabaseRequests: () => Promise.resolve(),
      SchemaVersionMismatchError,
    };
  }
  if (request === './server') return {
    startServer: async () => { events.push('server.start'); },
    stopServer: async () => { events.push('server.stop'); },
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
    telemetry: { start() {}, stop: () => { events.push('telemetry.stop'); } },
    sendEvent: async () => { events.push('telemetry.startup-failed'); return true; },
  };
  if (request === './services/google-drive') return { googleDrive: { start() {}, stop: () => { events.push('drive.stop'); } } };
  if (request === './printers/thermal') return { initPrinter: async () => {}, printReceipt() {}, printKOT() {} };
  if (request === './ipc') return { registerIpcHandlers() {} };
  if (request === './services/whatsapp') return { initFromDb() {}, shutdown: async () => { events.push('whatsapp.stop'); } };
  return originalLoad.apply(this, arguments);
};

require('../main/index.ts');

setTimeout(() => {
  const expectedOrder = [
    'dialog.showErrorBox',
    'telemetry.startup-failed',
    'cloud.shutdown',
    'telemetry.stop',
    'drive.stop',
    'whatsapp.stop',
    'server-app.stop',
    'server.stop',
    'kds.stop',
    'database.close',
  ];
  const orderMatches = expectedOrder.every((event, index) => events[index] === event);
  const passed = orderMatches && exitCodes.length === 1 && exitCodes[0] === 1;
  process.stdout.write(JSON.stringify({ passed, events, exitCodes }) + '\n');
  fs.rmSync(testDir, { recursive: true, force: true });
  Module._load = originalLoad;
  process.exit(passed ? 0 : 1);
}, 50);
