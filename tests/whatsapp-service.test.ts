/**
 * whatsapp-service.test.ts
 *
 * Smoke test for the service module's public API and shutdown persistence.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
const realLoad = (Module as any)._load;

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
  sendMessage: async () => ({ key: { id: 'shutdown-test-message' } }),
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
    const testDir = path.join(os.tmpdir(), 'flo-whatsapp-shutdown-test');
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

async function main(): Promise<void> {
  console.log('Testing WhatsApp service API surface...');
  const failures: string[] = [];
  const assert = (cond: unknown, msg: string): void => {
    if (!cond) failures.push(msg);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  };

  // Lifecycle
  assert(typeof whatsapp.getStatus === 'function', 'exports getStatus()');
  assert(typeof whatsapp.enable === 'function', 'exports enable()');
  assert(typeof whatsapp.disable === 'function', 'exports disable()');
  assert(typeof whatsapp.connectWithQr === 'function', 'exports connectWithQr()');
  assert(typeof whatsapp.connectWithPairingCode === 'function', 'exports connectWithPairingCode()');
  assert(typeof whatsapp.disconnect === 'function', 'exports disconnect()');
  assert(typeof whatsapp.shutdown === 'function', 'exports shutdown()');
  assert(typeof whatsapp.initFromDb === 'function', 'exports initFromDb()');

  // Send + storage
  assert(typeof whatsapp.sendMessage === 'function', 'exports sendMessage()');
  assert(typeof whatsapp.listMessages === 'function', 'exports listMessages()');
  assert(typeof whatsapp.listInbox === 'function', 'exports listInbox()');
  assert(typeof whatsapp.listBlocklist === 'function', 'exports listBlocklist()');
  assert(typeof whatsapp.addToBlocklist === 'function', 'exports addToBlocklist()');
  assert(typeof whatsapp.removeFromBlocklist === 'function', 'exports removeFromBlocklist()');

  // Status shape sanity (no socket started, so connected state)
  const s = whatsapp.getStatus();
  assert(typeof s === 'object' && s !== null, 'getStatus() returns an object');
  assert(typeof s.enabled === 'boolean', 'status.enabled is boolean');
  assert(typeof s.state === 'string', 'status.state is string');
  assert(
    ['disconnected', 'connecting', 'waiting_qr', 'waiting_pairing', 'connected', 'cooldown'].includes(s.state),
    `status.state is one of the known values (got ${s.state})`,
  );

  // Send before enable returns feature_off (without touching the socket)
  const result = await whatsapp.sendMessage({
    phoneE164: '+15555550100',
    body: 'test',
    billId: null,
    customerId: null,
    kind: 'manual_reply',
    userId: null,
  });
  assert(result.ok === false, 'sendMessage returns ok=false when feature is off');
  assert(result.reason === 'feature_off', `sendMessage reason is 'feature_off' (got ${result.reason})`);

  const testDir = path.join(os.tmpdir(), 'flo-whatsapp-shutdown-test');
  const originalFetch = globalThis.fetch;
  const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
  initDatabase();
  globalThis.fetch = (() => Promise.reject(new Error('offline test network'))) as typeof fetch;
  try {
    await whatsapp.enable('shutdown-test-user');
    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));

    const sendPromise = whatsapp.sendMessage({
      phoneE164: '+15555550100',
      body: 'shutdown cancellation test',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: null,
    });
    await presenceStartedPromise;
    const shutdownPromise = whatsapp.shutdown();
    let sendSettled = false;
    void sendPromise.then(() => { sendSettled = true; }, () => { sendSettled = true; });
    let shutdownSettled = false;
    void shutdownPromise.then(() => { shutdownSettled = true; }, () => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert(sendSettled, 'shutdown cancels the send wrapper before raw WhatsApp work settles');
    assert(!shutdownSettled, 'shutdown remains pending while underlying WhatsApp work is active');
    releasePendingPresence();
    const cancelled = await sendPromise;
    await shutdownPromise;
    const row = getDatabase().prepare(`
      SELECT status, error, failed_at FROM whatsapp_messages
      WHERE direction = 'outbound' AND body = ?
      ORDER BY id DESC LIMIT 1
    `).get('shutdown cancellation test') as { status: string; error: string; failed_at: string | null };
    assert(cancelled.ok === false && cancelled.reason === 'send_failed', 'shutdown-cancelled send returns send_failed');
    assert(row.status === 'failed', 'shutdown-cancelled send persists a failed status');
    assert(row.error === 'WhatsApp is shutting down.' && row.failed_at !== null, 'shutdown-cancelled send records its failure details');
    assert(presenceSettled, 'shutdown waits for the underlying WhatsApp operation to settle');
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nAll WhatsApp service API assertions passed.');
  }
}

main().catch((err) => {
  (Module as any)._load = realLoad;
  console.error('Test crashed:', err);
  process.exit(1);
});
