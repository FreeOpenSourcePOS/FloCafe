import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
const calls: { channel: string; args: unknown[] }[] = [];
const syncCalls: { channel: string; args: unknown[] }[] = [];
const eventHandlers = new Map<string, (...args: unknown[]) => void>();
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
        sendSync: (channel: string, ...args: unknown[]) => {
          syncCalls.push({ channel, args });
          return { success: true };
        },
        invoke: (channel: string, ...args: unknown[]) => {
          calls.push({ channel, args });
          return Promise.resolve();
        },
        on: (channel: string, handler: (...args: unknown[]) => void) => {
          eventHandlers.set(channel, handler);
        },
        removeListener: (channel: string, handler: (...args: unknown[]) => void) => {
          if (eventHandlers.get(channel) === handler) eventHandlers.delete(channel);
        },
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
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].channel, 'window-document');
  const documentNonce = syncCalls[0].args[0];
  assert.match(
    String(documentNonce),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(Object.keys(exposedApi!).sort(), [
    'backupDatabase', 'checkForUpdates', 'dbApplySafeFixes', 'dbHealthCheck',
    'dbInitialize', 'getAppInfo', 'getBetaChannel', 'getDailySummary', 'getKdsInfo',
    'getMasterPinStatus', 'getPrinters', 'getSettings', 'getStatus', 'getUpdateStatus',
    'onMenuAction', 'onUpdateStatus', 'openKdsWindow', 'platform', 'restartAndInstall',
    'restoreBackup', 'savePrinter', 'setBetaChannel', 'setSetting', 'setThemeEffective',
    'windowAction', 'windowReady',
  ].sort());

  assert.equal(typeof exposedApi!.setThemeEffective, 'function');

  const call = (name: string, ...args: unknown[]) =>
    (exposedApi![name] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
  await call('getSettings');
  await call('setSetting', 'business_name', 'Flo Cafe');
  await call('getKdsInfo');
  await call('openKdsWindow');
  await call('getPrinters');
  await call('savePrinter', { name: 'Kitchen Printer', connection_type: 'network' });
  await call('getDailySummary');
  await call('getBetaChannel');
  await call('setBetaChannel', true);
  await call('windowReady', { epoch: 1 });
  await call('windowAction', 'minimize');

  const receivedStatuses: unknown[] = [];
  const unsubscribe = (exposedApi!['onUpdateStatus'] as (callback: (status: unknown) => void) => () => void)(
    (status) => receivedStatuses.push(status),
  );
  const structuredReleaseNotes = {
    status: 'available',
    releaseNotes: [{ version: '3.4.0', note: 'Improved update delivery' }],
  };
  eventHandlers.get('update-status')?.({}, structuredReleaseNotes);
  assert.deepEqual(receivedStatuses, [structuredReleaseNotes]);
  unsubscribe();
  assert.equal(eventHandlers.has('update-status'), false);

  assert.deepEqual(calls, [
    { channel: 'get-settings', args: [] },
    { channel: 'set-setting', args: ['business_name', 'Flo Cafe'] },
    { channel: 'get-kds-info', args: [] },
    { channel: 'open-kds-window', args: [] },
    { channel: 'get-printers', args: [] },
    { channel: 'save-printer', args: [{ name: 'Kitchen Printer', connection_type: 'network' }] },
    { channel: 'get-daily-summary', args: [] },
    { channel: 'updates:get-beta-channel', args: [] },
    { channel: 'updates:set-beta-channel', args: [true] },
    { channel: 'window-ready', args: [{ epoch: 1, documentNonce }] },
    { channel: 'window-action', args: ['minimize'] },
  ]);

  console.log('Electron preload methods expose the expected narrow IPC channels.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
