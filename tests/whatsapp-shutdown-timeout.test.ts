import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import * as assert from 'node:assert/strict';

const realLoad = (Module as any)._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-whatsapp-timeout-'));
const eventHandlers = new Map<string, (value: any) => void>();
let presenceStarted!: () => void;
const presenceStartedPromise = new Promise<void>((resolve) => { presenceStarted = resolve; });
let releasePendingPresence!: () => void;
const pendingPresence = new Promise<void>((resolve) => { releasePendingPresence = resolve; });
let presenceSettled = false;
void pendingPresence.then(() => { presenceSettled = true; });

const fakeSocket = {
  ev: { on: (event: string, handler: (value: any) => void) => { eventHandlers.set(event, handler); } },
  onWhatsApp: async () => [{ exists: true, jid: '15555550100@s.whatsapp.net' }],
  presenceSubscribe: async () => { presenceStarted(); return pendingPresence; },
  sendPresenceUpdate: async () => {},
  sendMessage: async () => ({ key: { id: 'timeout-test-message' } }),
  end: () => {},
};
const fakeBaileys = {
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1] }),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  makeWASocket: () => fakeSocket,
  Browsers: { macOS: () => ({}) },
  proto: { Message: { create: () => ({}) } },
};

(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'electron') {
    return {
      app: { getPath: () => testDir, getVersion: () => 'test', isPackaged: true },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    };
  }
  if (request === '../baileys-loader.cjs') return { loadBaileys: async () => fakeBaileys };
  return realLoad.call(this, request, ...rest);
};

const whatsapp = require('../main/services/whatsapp');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { runShutdownSteps } = require('../main/shutdown');

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  initDatabase();
  globalThis.fetch = (() => Promise.reject(new Error('offline test network'))) as typeof fetch;
  try {
    await whatsapp.enable('shutdown-timeout-test-user');
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));

    const sendPromise = whatsapp.sendMessage({
      phoneE164: '+15555550100',
      body: 'shutdown timeout test',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: null,
    });
    await presenceStartedPromise;
    (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      originalSetTimeout(handler, delay === 10_000 ? 1 : delay, ...args)) as typeof setTimeout;

    let databaseClosed = false;
    let fatalTimeoutObserved = false;
    await assert.rejects(
      runShutdownSteps([
        { name: 'WhatsApp', blocksDatabase: true, run: () => whatsapp.shutdown() },
        { name: 'database', databaseClose: true, run: () => { databaseClosed = true; } },
      ], { onFatalTimeout: () => { fatalTimeoutObserved = true; } }),
      (error: any) => error?.code === 'ERR_SHUTDOWN_TIMEOUT',
    );
    assert.equal(databaseClosed, false, 'a bounded WhatsApp timeout blocks database closure');
    assert.equal(fatalTimeoutObserved, true, 'a bounded WhatsApp timeout invokes fatal termination');
    assert.equal(presenceSettled, false, 'terminal shutdown reports a bounded error while raw WhatsApp work remains pending');

    releasePendingPresence();
    await sendPromise;
    const row = getDatabase().prepare(`
      SELECT status, error, failed_at FROM whatsapp_messages
      WHERE direction = 'outbound' AND body = ?
      ORDER BY id DESC LIMIT 1
    `).get('shutdown timeout test') as { status: string; error: string | null; failed_at: string | null };
    assert.equal(row.status, 'queued', 'raw WhatsApp completion does not write after terminal shutdown');
    assert.equal(row.error, null, 'terminal shutdown does not add a late database error');
    assert.equal(row.failed_at, null, 'terminal shutdown does not add a late failure timestamp');
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
    try { releasePendingPresence(); } catch { }
    try { closeDatabase(); } catch { }
    fs.rmSync(testDir, { recursive: true, force: true });
    (Module as any)._load = realLoad;
  }
}

main().catch((error) => {
  (Module as any)._load = realLoad;
  console.error(error);
  process.exit(1);
});
