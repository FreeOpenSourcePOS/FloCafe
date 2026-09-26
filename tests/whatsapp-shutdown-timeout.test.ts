/**
 * Regression test for the WhatsApp shutdown drain hang. Wired into
 * `test:whatsapp-service`.
 *
 * `inFlightWhatsAppWork` is a
 * `Map<Promise<unknown>, WhatsAppWorkCancellation>`: the in-flight operation is
 * the KEY and its cancellation callback is the VALUE (`abortable` calls
 * `trackWhatsAppWork(operation, cancel)`). `waitForWhatsAppWork()` drains it with
 * `Promise.allSettled([...inFlightWhatsAppWork])`.
 *
 * Spreading a Map iterates its default entry sequence, so that expression is an
 * array of `[operation, cancel]` ENTRY ARRAYS, not a flat list of keys and
 * values. An entry array is not a thenable, so `allSettled` resolves on the next
 * microtask without awaiting a single operation. The `while (size > 0)` loop then
 * re-checks a map that only empties when the operations actually settle, so it
 * spins, awaiting an already-settled promise each pass. That is microtask work
 * only: the macrotask queue never runs, so neither the `SHUTDOWN_TIMEOUT_MS`
 * timer in `waitForWhatsAppWork` nor the fatal step timeout in
 * `runShutdownSteps` can ever fire. The suite hangs instead of failing.
 *
 * The fix is `[...inFlightWhatsAppWork.keys()]`, which yields the operations so
 * `allSettled` waits for them. Not `values()`: those are the cancellation
 * callbacks, equally non-thenable.
 *
 * A second `whatsapp.shutdown()` call used to sit here claiming to cover the same
 * drain. It covered nothing: `shutdown()` memoizes `whatsappShutdownPromise` and never
 * clears it, so the second call returns the promise the first call already rejected and
 * the assertion could not fail. It was removed. Worse, the drain was only ever asserted
 * through `runShutdownSteps`, which arms its per-step budget *before* the step runs, so
 * the rejection that arrived was that budget's `ERR_SHUTDOWN_TIMEOUT` and not the
 * service's. The drain is now asserted directly, first, and matched against the
 * service's own error message so the two can be told apart.
 *
 * The sample number has to pass `libphonenumber-js` validation, because
 * `resolveJid` returns null before ever calling `sock.onWhatsApp` for an invalid
 * number. An invalid one leaves `presenceSubscribe` uncalled, so the pending
 * presence promise this test parks on never settles - and an awaited promise
 * with nothing else queued lets Node exit 0 with no assertion ever executed.
 * `withDeadline` below turns both that mistake and the original hang into
 * ordinary failures.
 *
 * CORRECTION when this test was restored: its last three assertions demanded
 * that the drained send leave the row untouched, which is not the contract this
 * service offers. `whatsapp-service.test.ts` already pins the opposite in the
 * default suite - `shutdown-cancelled send persists a failed status` and
 * `shutdown-cancelled send records its failure details` - and it passes. A send
 * cancelled by `requestShutdown()` unwinds through `abortable`'s join timeout,
 * which is armed before the drain's own budget, so `shutdownFailure()` runs
 * while the write is still correct and truthful. This test now asserts the same
 * contract as its sibling rather than contradicting it.
 */
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
  onWhatsApp: async () => [{ exists: true, jid: '919812345678@s.whatsapp.net' }],
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

/** Rejects instead of hanging forever, so a never-settling wait fails the suite. */
function withDeadline<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      void promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

const whatsapp = require('../main/services/whatsapp');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { runShutdownSteps, SHUTDOWN_TIMEOUT_MS } = require('../main/shutdown');

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
      phoneE164: '+919812345678',
      body: 'shutdown timeout test',
      billId: null,
      customerId: null,
      kind: 'manual_reply',
      userId: null,
    });
    await withDeadline(presenceStartedPromise, 'WhatsApp presence subscribe never started, so no in-flight work is parked');
    (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      originalSetTimeout(handler, delay === 10_000 ? 1 : delay, ...args)) as typeof setTimeout;

    // The property this branch fixes, asserted directly: the service's own drain reaches
    // its bounded shutdown instead of spinning. This has to be the first shutdown call
    // in the process. runShutdownSteps arms its per-step budget before the step runs, so
    // driven through the coordinator this same rejection would arrive with that budget's
    // error instead, and the assertion could not tell the two apart.
    await assert.rejects(
      withDeadline(whatsapp.shutdown(), 'WhatsApp drain never reached its own bounded shutdown'),
      (error: any) => error?.code === 'ERR_SHUTDOWN_TIMEOUT'
        && error?.message === `WhatsApp shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`,
    );

    // shutdown() memoizes, so this re-observes the rejection above rather than draining
    // again. What it still covers is the coordinator contract: a bounded WhatsApp timeout
    // blocks the database step and invokes fatal termination.
    let databaseClosed = false;
    let fatalTimeoutObserved = false;
    await assert.rejects(
      withDeadline(runShutdownSteps([
        { name: 'WhatsApp', blocksDatabase: true, run: () => whatsapp.shutdown() },
        { name: 'database', databaseClose: true, run: () => { databaseClosed = true; } },
      ], { onFatalTimeout: () => { fatalTimeoutObserved = true; } }), 'shutdown drain never completed'),
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
    assert.equal(row.status, 'failed', 'a drained send still records the shutdown failure once its work settles');
    assert.equal(row.error, 'WhatsApp is shutting down.', 'a drained send records why it failed');
    assert.notEqual(row.failed_at, null, 'a drained send records when it failed');
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
