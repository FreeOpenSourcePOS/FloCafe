/**
 * Bounds on the diagnostics channel:
 *
 *   1. The local failure log is capped at 200 rows and the cap is enforced on
 *      write, evicting the OLDEST row first (a ring buffer, so the most recent
 *      failures are always the ones an operator can read out).
 *   2. A till that could never deliver an outbox row - no cloud key, or cloud
 *      sync off - does not enqueue at all, so nothing accumulates.
 *   3. Automatic transmission is off by default: with
 *      `diagnostics_transmission_enabled` unset or false, nothing is queued,
 *      while the local log still captures the failure for the screen.
 *   4. `diagnostics_transmission_enabled` survives a restore, not merely
 *      appearing in the protected-key list.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/diagnostics-outbox-bounds.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostics-bounds-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.11.0' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const {
  captureRestoreProtectedSettings, mergeRestoreProtectedSettings,
  captureRestoreOutboxState, mergeRestoreOutboxState,
} = require('../main/db');
const { cloudSync, DIAGNOSTIC_LOG_MAX_ROWS } = require('../main/services/cloud-sync');

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: crypto.randomUUID(),
    event_code: 'server.internal_error',
    severity: 'error',
    occurred_at: new Date().toISOString(),
    ...overrides,
  } as any;
}

/**
 * reportDiagnostic writes in the background, so a previous section's inserts can
 * still be landing - and evicting - while the next section builds a fixture.
 * Wait until the outbox count stops moving.
 */
async function drain(db: any, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const current = countRows(db, 'store_diagnostics_outbox');
    if (current === previous) return;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function countRows(db: any, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function setSetting(db: any, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, now());
}

function readSetting(db: any, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

const settle = async (predicate: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

async function main() {
  console.log('Diagnostics Bounds Tests');
  console.log('='.repeat(56));

  const db = initTestDb();

  console.log('\n1. Transmission is off by default: the local log captures, the outbox does not');
  assertEqualOrThrow(readSetting(db, 'diagnostics_transmission_enabled'), 'false', 'a fresh database seeds the transmission setting as false');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  cloudSync.reportDiagnostic(event({ message: 'no such table: orders' }));
  const captured = await settle(() => countRows(db, 'local_diagnostics') === 1);
  assertOrThrow(captured, 'the failure is captured locally for the diagnostics screen');
  assertEqualOrThrow(countRows(db, 'store_diagnostics_outbox'), 0, 'nothing is queued for transmission while the setting is off');
  assertEqualOrThrow(
    (db.prepare('SELECT signature FROM local_diagnostics').get() as { signature: string }).signature,
    'Error: no such table: orders',
    'the locally captured row carries the derived signature',
  );

  console.log('\n2. A till that could never deliver does not enqueue at all');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', 'test-key');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  for (let i = 0; i < 25; i++) cloudSync.reportDiagnostic(event({ message: `failure ${i} of 25` }));
  const localSettled = await settle(() => countRows(db, 'local_diagnostics') === 25);
  assertOrThrow(localSettled, 'every failure is still captured locally with transmission on');
  assertEqualOrThrow(countRows(db, 'store_diagnostics_outbox'), 0, 'with cloud sync off nothing accumulates, so 25 failures leave the outbox empty');

  setSetting(db, 'cloud_sync_enabled', '1');
  setSetting(db, 'cloud_api_key', '');
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  for (let i = 0; i < 25; i++) cloudSync.reportDiagnostic(event({ message: `failure ${i} of 25` }));
  const noKeySettled = await settle(() => countRows(db, 'local_diagnostics') === 50);
  assertOrThrow(noKeySettled, 'capture continues locally while the outbox stays empty');
  assertEqualOrThrow(countRows(db, 'store_diagnostics_outbox'), 0, 'a till with no cloud key never queues an undeliverable row');

  console.log('\n3. With a deliverable configuration the outbox is written and bounded at 200');
  await drain(db);
  setSetting(db, 'cloud_api_key', 'test-key');
  setSetting(db, 'cloud_registration_status', 'registered');
  setSetting(db, 'cloud_services_disabled_by_user', 'false');
  setSetting(db, 'cloud_server_url', 'http://127.0.0.1:1');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  const totalWrites = DIAGNOSTIC_LOG_MAX_ROWS + 25;
  const writtenIds: string[] = [];
  const report = (message: string) => {
    const eventId = crypto.randomUUID();
    writtenIds.push(eventId);
    cloudSync.reportDiagnostic(event({ event_id: eventId, message }));
  };
  // Each write is awaited individually so completion is proven, not guessed: the
  // local log grows monotonically to its cap, and past the cap each write must
  // evict exactly one outbox row.
  for (let i = 0; i < DIAGNOSTIC_LOG_MAX_ROWS; i++) {
    report(`failure ${i} of ${totalWrites}`);
    assertOrThrow(await settle(() => countRows(db, 'local_diagnostics') === i + 1), `write ${i + 1} completed`);
  }
  assertOrThrow(countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS, 'the outbox reaches exactly its cap');
  for (let i = 0; i < 25; i++) {
    report(`failure ${DIAGNOSTIC_LOG_MAX_ROWS + i} of ${totalWrites}`);
    assertOrThrow(
      await settle(() => countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS),
      `overflow write ${i + 1} evicted exactly one row, so the outbox never exceeds the cap`,
    );
  }
  assertEqualOrThrow(countRows(db, 'local_diagnostics'), DIAGNOSTIC_LOG_MAX_ROWS, 'the local failure log is capped at 200 rows');

  // Eviction policy: oldest first among rows that are equally eligible.
  const oldestOutbox = db.prepare('SELECT event_id FROM store_diagnostics_outbox ORDER BY rowid ASC LIMIT 1')
    .get() as { event_id: string };
  const newestOutbox = db.prepare('SELECT event_id FROM store_diagnostics_outbox ORDER BY rowid DESC LIMIT 1')
    .get() as { event_id: string };
  assertEqualOrThrow(oldestOutbox.event_id, writtenIds[25], 'the oldest surviving outbox row is the first write after the 25 evicted to stay under the cap');
  assertEqualOrThrow(newestOutbox.event_id, writtenIds[totalWrites - 1], 'the newest outbox row is the most recent write');
  assertOrThrow(
    writtenIds.slice(0, 25).every((id) => !db
      .prepare('SELECT event_id FROM store_diagnostics_outbox WHERE event_id = ?')
      .get(id)),
    'the 25 oldest writes are the ones evicted from the outbox',
  );
  const oldestLocal = db.prepare('SELECT id FROM local_diagnostics ORDER BY id ASC LIMIT 1').get() as { id: number };
  const newestLocal = db.prepare('SELECT id FROM local_diagnostics ORDER BY id DESC LIMIT 1').get() as { id: number };
  assertEqualOrThrow(newestLocal.id - oldestLocal.id + 1, DIAGNOSTIC_LOG_MAX_ROWS, 'the local log holds a contiguous window of the newest 200 writes');

  console.log('\n3b. The outbox evicts delivered rows before undelivered ones');
  await drain(db);
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'cloud_sync_enabled', '1');
  setSetting(db, 'cloud_api_key', 'test-key');
  setSetting(db, 'cloud_registration_status', 'registered');
  setSetting(db, 'cloud_services_disabled_by_user', 'false');
  setSetting(db, 'cloud_server_url', 'http://127.0.0.1:1');
  // The scenario the finding describes: 190 older undelivered rows and 10 NEWER
  // delivered ones, so insertion-order and delivered-first eviction cannot pick
  // the same rows. next_attempt_at far in the future keeps the background
  // flusher away from the fixture, so only the cap can remove these rows.
  const fixture = (id: string, status: string) => db.prepare(
    `INSERT INTO store_diagnostics_outbox (event_id, payload, status, next_attempt_at, created_at, updated_at)
     VALUES (?, '{}', ?, '2999-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run(id, status);
  for (let i = 0; i < 190; i++) fixture(`undelivered-${i}`, 'pending');
  for (let i = 0; i < 10; i++) fixture(`delivered-${i}`, 'delivered');
  assertEqualOrThrow(countRows(db, 'store_diagnostics_outbox'), DIAGNOSTIC_LOG_MAX_ROWS, 'the fixture fills the outbox to the cap');
  for (let i = 0; i < 25; i++) {
    cloudSync.reportDiagnostic(event({ message: `eviction probe ${i}` }));
    assertOrThrow(
      await settle(() => countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS),
      `probe ${i + 1} evicted exactly one row`,
    );
  }
  const countPrefix = (prefix: string) => (db.prepare(
    "SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE event_id LIKE ?",
  ).get(prefix) as { count: number }).count;
  assertEqualOrThrow(countPrefix('delivered-%'), 0, 'the 10 newer delivered rows were evicted before any undelivered row');
  assertEqualOrThrow(countPrefix('undelivered-%'), 175, 'only 15 of the 190 older undelivered rows were sacrificed, and never to a delivered row');
  assertOrThrow(
    !db.prepare("SELECT event_id FROM store_diagnostics_outbox WHERE event_id LIKE 'delivered-%'").get(),
    'an undelivered failure was never discarded while a newer delivered row survived',
  );

  console.log('\n3c. A restore keeps this device\'s own failure log and drops the incoming one');
  const preservedLocal = captureRestoreOutboxState(db);
  assertOrThrow(Array.isArray(preservedLocal.local), 'the local failure log is captured across a restore');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare("INSERT INTO local_diagnostics (event_code, severity, error_class, signature, summary, occurred_at, created_at) VALUES ('server.internal_error', 'error', 'Error', 'Error: other till', 'Another till failed here', ?, ?)").run(now(), now());
  assertOrThrow(countRows(db, 'local_diagnostics') >= 1, 'precondition: the database now holds a foreign failure row');
  mergeRestoreOutboxState(db, preservedLocal);
  const afterRestore = db.prepare('SELECT signature FROM local_diagnostics').all() as Array<{ signature: string }>;
  assertOrThrow(
    !afterRestore.some((row) => row.signature.includes('other till')),
    'a restored backup no longer leaves another till\'s failures on this device',
  );
  const preservedSignatures = (preservedLocal.local as Array<{ signature: string }>).map((row) => row.signature);
  assertOrThrow(preservedSignatures.length > 0, 'precondition: this device had its own failures before the restore');
  assertOrThrow(
    afterRestore.every((row) => preservedSignatures.includes(row.signature)),
    'the restored log contains only this device\'s own failures',
  );
  assertOrThrow(
    countRows(db, 'local_diagnostics') <= DIAGNOSTIC_LOG_MAX_ROWS,
    'the restored log is re-capped rather than inheriting an unbounded backup',
  );

  console.log('\n4. The cap holds when the log is read repeatedly between writes');
  // Self-contained: seed a known number of rows rather than inheriting a count.
  db.prepare('DELETE FROM local_diagnostics').run();
  for (let i = 0; i < 25; i++) {
    db.prepare(
      `INSERT INTO local_diagnostics (event_code, severity, error_class, signature, summary, occurred_at, created_at)
       VALUES ('server.internal_error', 'error', 'Error', ?, ?, ?, ?)`,
    ).run(`Error: seed ${i}`, `seed failure ${i}`, now(), now());
  }
  const beforeReads = countRows(db, 'local_diagnostics');
  assertEqualOrThrow(beforeReads, 25, 'precondition: 25 seeded local failures');
  for (let i = 0; i < 5; i++) cloudSync.listLocalDiagnostics(50);
  assertEqualOrThrow(countRows(db, 'local_diagnostics'), beforeReads, 'reading the screen never grows or shrinks the log');
  const listed = cloudSync.listLocalDiagnostics(50);
  assertEqualOrThrow(listed.length, 25, 'the screen reads the whole log when it is under the cap');
  assertEqualOrThrow(cloudSync.listLocalDiagnostics(10).length, 10, 'a smaller page size is honoured');
  assertEqualOrThrow(cloudSync.listLocalDiagnostics(10_000).length, 25, 'an oversized limit does not read past what exists');

  console.log('\n5. Clearing the log leaves nothing behind');
  const removed = cloudSync.clearLocalDiagnostics();
  assertEqualOrThrow(removed, 25, 'clearing reports how many local failures were dropped');
  assertEqualOrThrow(countRows(db, 'local_diagnostics'), 0, 'no local failure survives a clear');

  console.log('\n6. The transmission setting survives a restore, not just a list entry');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  const preserved = captureRestoreProtectedSettings(db);
  const capturedState = preserved.find((state: any) => state.key === 'diagnostics_transmission_enabled');
  assertOrThrow(Boolean(capturedState), 'the transmission setting is captured for restore');
  assertEqualOrThrow(capturedState?.value, 'true', 'its current value is what restore will re-apply');
  // Simulate the restore: the incoming database says the opposite.
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  assertEqualOrThrow(readSetting(db, 'diagnostics_transmission_enabled'), 'false', 'precondition: the restored database disagrees');
  mergeRestoreProtectedSettings(db, preserved);
  assertEqualOrThrow(readSetting(db, 'diagnostics_transmission_enabled'), 'true', 'a customer who restored a backup does not silently lose the setting');

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
