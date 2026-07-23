/**
 * whatsapp-service.test.ts
 *
 * Smoke test that verifies the service module's public API surface is intact.
 * If a future refactor drops or renames one of these exports, this test goes
 * red. Pattern: assert the wiring surface (did we accidentally remove the
 * entry points?) without mocking the internals.
 *
 * Behavioral coverage (rate gates, content filter, LID translation, etc.)
 * needs an Electron runtime or a deep mock — out of scope here. The schema
 * test covers the data layer, this covers the wiring layer.
 */

// Stub the electron module before importing the service (which uses `app`).
import Module from 'node:module';
const realResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === 'electron') return require.resolve('./_electron-stub.cjs');
  return realResolve.call(this, request, ...rest);
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

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nAll WhatsApp service API assertions passed.');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
