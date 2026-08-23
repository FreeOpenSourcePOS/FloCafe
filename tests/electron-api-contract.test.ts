import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
const calls: { channel: string; args: unknown[] }[] = [];
let exposedApi: Record<string, unknown> | undefined;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      contextBridge: {
        exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
          assert.equal(name, 'electronAPI');
          exposedApi = api;
        },
      },
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => {
          calls.push({ channel, args });
          return Promise.resolve();
        },
        on: () => {},
        removeListener: () => {},
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

try {
  require('../main/preload');
} finally {
  Module._load = originalLoad;
}

async function run(): Promise<void> {
  assert.ok(exposedApi, 'preload exposes electronAPI');
  assert.deepEqual(Object.keys(exposedApi!).sort(), [
    'backupDatabase', 'checkForUpdates', 'dbApplySafeFixes', 'dbHealthCheck',
    'dbInitialize', 'getAppInfo', 'getDailySummary', 'getKdsInfo', 'getMasterPinStatus',
    'getPrinters', 'getSettings', 'getStatus', 'getUpdateStatus', 'onMenuAction',
    'onUpdateStatus', 'openKdsWindow', 'platform', 'restartAndInstall', 'restoreBackup',
    'savePrinter', 'setSetting',
  ].sort());

  const call = (name: string, ...args: unknown[]) =>
    (exposedApi![name] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
  await call('getSettings');
  await call('setSetting', 'business_name', 'Flo Cafe');
  await call('getKdsInfo');
  await call('openKdsWindow');
  await call('getPrinters');
  await call('savePrinter', { name: 'Kitchen Printer', connection_type: 'network' });
  await call('getDailySummary');

  assert.deepEqual(calls, [
    { channel: 'get-settings', args: [] },
    { channel: 'set-setting', args: ['business_name', 'Flo Cafe'] },
    { channel: 'get-kds-info', args: [] },
    { channel: 'open-kds-window', args: [] },
    { channel: 'get-printers', args: [] },
    { channel: 'save-printer', args: [{ name: 'Kitchen Printer', connection_type: 'network' }] },
    { channel: 'get-daily-summary', args: [] },
  ]);

  console.log('Electron preload methods expose the expected narrow IPC channels.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
