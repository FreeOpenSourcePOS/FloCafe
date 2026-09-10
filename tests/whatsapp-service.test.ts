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
let makeSocketCalls = 0;
let authStateCalls = 0;
let holdAuthState = false;
let authStateStarted!: () => void;
const authStateStartedPromise = new Promise<void>((resolve) => { authStateStarted = resolve; });
let releaseAuthState!: () => void;
const authStateGate = new Promise<void>((resolve) => { releaseAuthState = resolve; });
let holdRecoveryAuthState = false;
let recoveryAuthStateStarted!: () => void;
const recoveryAuthStateStartedPromise = new Promise<void>((resolve) => { recoveryAuthStateStarted = resolve; });
let releaseRecoveryAuthState!: () => void;
const recoveryAuthStateGate = new Promise<void>((resolve) => { releaseRecoveryAuthState = resolve; });
let holdRequestAuthState = false;
let requestAuthStateStarted!: () => void;
const requestAuthStateStartedPromise = new Promise<void>((resolve) => { requestAuthStateStarted = resolve; });
let releaseRequestAuthState!: () => void;
const requestAuthStateGate = new Promise<void>((resolve) => { releaseRequestAuthState = resolve; });
const baileysLogLines: string[] = [];
let holdCredentialWrite = false;
let credentialWriteStarted!: () => void;
const credentialWriteStartedPromise = new Promise<void>((resolve) => { credentialWriteStarted = resolve; });
let releaseCredentialWrite!: () => void;
const credentialWriteGate = new Promise<void>((resolve) => { releaseCredentialWrite = resolve; });
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
  useMultiFileAuthState: async () => {
    authStateCalls++;
    if (holdAuthState) {
      authStateStarted();
      await authStateGate;
    }
    if (holdRecoveryAuthState) {
      recoveryAuthStateStarted();
      await recoveryAuthStateGate;
    }
    if (holdRequestAuthState) {
      requestAuthStateStarted();
      await requestAuthStateGate;
    }
    return {
      state: {},
      saveCreds: async () => {
        if (holdCredentialWrite) {
          credentialWriteStarted();
          await credentialWriteGate;
        }
      },
    };
  },
  makeWASocket: (options: any) => {
    makeSocketCalls++;
    options.logger.warn({ body: 'private bill body', phone: '+15555550100' }, 'Baileys warning for +15555550100');
    return fakeSocket;
  },
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
const { createShutdownEntrypoints } = require('../main/shutdown');

async function main(): Promise<void> {
  console.log('Testing WhatsApp service API surface...');
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.includes('"event":"baileys_log"')) baileysLogLines.push(line);
    originalConsoleWarn(...args);
  };
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
  assert(
    whatsapp.sanitizeLogText(new Error('recipient +1 555 555 0100 via https://wa.me/15555550100?text=private-bill'))
      === 'recipient [redacted-number] via [redacted-url]',
    'diagnostic sanitizer redacts formatted phone numbers and share URLs',
  );

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
  fs.rmSync(testDir, { recursive: true, force: true });
  initDatabase();
  globalThis.fetch = (() => Promise.reject(new Error('offline test network'))) as typeof fetch;
  try {
    await whatsapp.enable('shutdown-test-user');

    holdAuthState = true;
    const socketCallsBeforeRace = makeSocketCalls;
    whatsapp.initFromDb();
    whatsapp.initFromDb();
    await authStateStartedPromise;
    releaseAuthState();
    await new Promise((resolve) => setImmediate(resolve));
    assert(makeSocketCalls === socketCallsBeforeRace + 1, 'duplicate startup initialization creates one socket');
    assert(
      baileysLogLines.some((line) => line.includes('Baileys warning for [redacted-number]')),
      'Baileys warning details are retained and sanitized in diagnostics',
    );
    assert(
      baileysLogLines.every((line) => !line.includes('private bill body')),
      'Baileys diagnostics do not include logger object message bodies',
    );
    holdAuthState = false;

    await whatsapp.connectWithQr();
    eventHandlers.get('connection.update')?.({ connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));

    holdCredentialWrite = true;
    const authStateCallsBeforeCredentialRecovery = authStateCalls;
    eventHandlers.get('creds.update')?.({});
    await credentialWriteStartedPromise;
    whatsapp.disconnect();
    await whatsapp.enable('credential-recovery-test-user');
    const credentialRecovery = whatsapp.connectWithQr();
    let credentialRecoverySettled = false;
    void credentialRecovery.then(() => { credentialRecoverySettled = true; }, () => { credentialRecoverySettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert(!credentialRecoverySettled, 'startup waits for asynchronous credential persistence before reopening auth');
    releaseCredentialWrite();
    holdCredentialWrite = false;
    await credentialRecovery;
    assert(authStateCalls === authStateCallsBeforeCredentialRecovery + 1, 'credential cleanup completes before the replacement startup');

    holdRecoveryAuthState = true;
    const authStateCallsBeforeRecovery = authStateCalls;
    whatsapp.disconnect();
    await whatsapp.enable('startup-recovery-test-user');
    const cancelledStartup = whatsapp.connectWithQr().catch(() => undefined);
    await recoveryAuthStateStartedPromise;
    await whatsapp.enable('startup-recovery-test-user');
    const socketCallsBeforeRecovery = makeSocketCalls;
    whatsapp.disconnect();
    releaseRecoveryAuthState();
    holdRecoveryAuthState = false;
    await cancelledStartup;
    assert(whatsapp.getStatus().lastErrorReason === null, 'intentional startup cancellation does not report a failure');
    await whatsapp.enable('startup-recovery-test-user');
    const restartedStartup = whatsapp.connectWithQr();
    const restartedResult = await restartedStartup;
    assert(restartedResult.ok === true, 're-enable starts a fresh socket after cancellation');
    assert(makeSocketCalls === socketCallsBeforeRecovery + 1, 'cancelled startup does not create a duplicate socket');
    assert(authStateCalls === authStateCallsBeforeRecovery + 2, 're-enable waits for the cancelled startup before retrying');

    holdRequestAuthState = true;
    const authStateCallsBeforeRequestCancellation = authStateCalls;
    whatsapp.disconnect();
    await whatsapp.enable('request-cancellation-test-user');
    const requestAbort = new AbortController();
    const cancelledRequest = whatsapp.connectWithQr(requestAbort.signal).then(() => 'resolved', () => 'rejected');
    await requestAuthStateStartedPromise;
    requestAbort.abort();
    const retriedRequest = whatsapp.connectWithQr();
    releaseRequestAuthState();
    holdRequestAuthState = false;
    const [cancelledRequestResult, retriedRequestResult] = await Promise.all([cancelledRequest, retriedRequest]);
    assert(cancelledRequestResult === 'rejected', 'aborted connect request is rejected');
    assert(retriedRequestResult.ok === true, 'retry joins request-independent startup');
    assert(authStateCalls === authStateCallsBeforeRequestCancellation + 1, 'request cancellation does not restart shared auth loading');

    const sendAbort = new AbortController();
    const sendPromise = whatsapp.sendMessage({
      phoneE164: '+15555550100',
      body: 'shutdown cancellation test',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: null,
      signal: sendAbort.signal,
    });
    await presenceStartedPromise;
    const shutdownEntrypoints = createShutdownEntrypoints({
      app: { on: () => {}, quit: () => {}, exit: () => {} },
      process: { on: () => {}, exit: () => {} },
      cleanup: () => whatsapp.shutdown(),
      setQuitting: () => {},
      onShutdownRequested: whatsapp.requestShutdown,
      destroyWindow: () => {},
    });
    const shutdownPromise = shutdownEntrypoints.runCleanup();
    sendAbort.abort();
    let sendSettled = false;
    void sendPromise.then(() => { sendSettled = true; }, () => { sendSettled = true; });
    let shutdownSettled = false;
    void shutdownPromise.then(() => { shutdownSettled = true; }, () => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert(!sendSettled, 'shutdown joins the send wrapper until raw WhatsApp work settles');
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
    console.warn = originalConsoleWarn;
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
