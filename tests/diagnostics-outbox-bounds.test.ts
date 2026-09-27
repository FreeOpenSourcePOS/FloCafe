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
  initTestDb, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const {
  captureRestoreProtectedSettings, mergeRestoreProtectedSettings,
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
  assertEqual(readSetting(db, 'diagnostics_transmission_enabled'), 'false', 'a fresh database seeds the transmission setting as false');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  cloudSync.reportDiagnostic(event({ message: 'no such table: orders' }));
  const captured = await settle(() => countRows(db, 'local_diagnostics') === 1);
  assert(captured, 'the failure is captured locally for the diagnostics screen');
  assertEqual(countRows(db, 'store_diagnostics_outbox'), 0, 'nothing is queued for transmission while the setting is off');
  assertEqual(
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
  assert(localSettled, 'every failure is still captured locally with transmission on');
  assertEqual(countRows(db, 'store_diagnostics_outbox'), 0, 'with cloud sync off nothing accumulates, so 25 failures leave the outbox empty');

  setSetting(db, 'cloud_sync_enabled', '1');
  setSetting(db, 'cloud_api_key', '');
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  for (let i = 0; i < 25; i++) cloudSync.reportDiagnostic(event({ message: `failure ${i} of 25` }));
  const noKeySettled = await settle(() => countRows(db, 'local_diagnostics') === 50);
  assert(noKeySettled, 'capture continues locally while the outbox stays empty');
  assertEqual(countRows(db, 'store_diagnostics_outbox'), 0, 'a till with no cloud key never queues an undeliverable row');

  console.log('\n3. With a deliverable configuration the outbox is written and bounded at 200');
  setSetting(db, 'cloud_api_key', 'test-key');
  setSetting(db, 'cloud_registration_status', 'registered');
  setSetting(db, 'cloud_services_disabled_by_user', 'false');
  setSetting(db, 'cloud_server_url', 'http://127.0.0.1:1');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  const totalWrites = DIAGNOSTIC_LOG_MAX_ROWS + 25;
  const writtenIds: string[] = [];
  for (let i = 0; i < totalWrites; i++) {
    const eventId = crypto.randomUUID();
    writtenIds.push(eventId);
    cloudSync.reportDiagnostic(event({ event_id: eventId, message: `failure ${i} of ${totalWrites}` }));
  }
  const filled = await settle(() => countRows(db, 'store_diagnostics_outbox') >= DIAGNOSTIC_LOG_MAX_ROWS);
  assert(filled, 'the outbox reaches its cap');
  const outboxSettled = await settle(() => countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS);
  assert(outboxSettled, 'the outbox never exceeds the cap of 200 rows');

  const localSettledCap = await settle(() => countRows(db, 'local_diagnostics') === DIAGNOSTIC_LOG_MAX_ROWS);
  assert(localSettledCap, 'the local failure log never exceeds the cap of 200 rows');
  assertEqual(countRows(db, 'local_diagnostics'), DIAGNOSTIC_LOG_MAX_ROWS, 'the local log is exactly at the cap after 225 writes');

  // Eviction policy: oldest first, so the 200 survivors are the newest 200.
  const oldestOutbox = db.prepare('SELECT event_id FROM store_diagnostics_outbox ORDER BY rowid ASC LIMIT 1')
    .get() as { event_id: string };
  const newestOutbox = db.prepare('SELECT event_id FROM store_diagnostics_outbox ORDER BY rowid DESC LIMIT 1')
    .get() as { event_id: string };
  assertEqual(
    oldestOutbox.event_id,
    writtenIds[totalWrites - DIAGNOSTIC_LOG_MAX_ROWS],
    'the oldest surviving outbox row is the first write after the evicted 25, not the first write overall',
  );
  assertEqual(
    newestOutbox.event_id,
    writtenIds[totalWrites - 1],
    'the newest outbox row is the most recent write',
  );
  assert(
    writtenIds.slice(0, 25).every((id) => !db
      .prepare('SELECT event_id FROM store_diagnostics_outbox WHERE event_id = ?')
      .get(id)),
    'every one of the 25 oldest writes was evicted from the outbox',
  );
  const oldestLocal = db.prepare('SELECT id FROM local_diagnostics ORDER BY id ASC LIMIT 1').get() as { id: number };
  const newestLocal = db.prepare('SELECT id FROM local_diagnostics ORDER BY id DESC LIMIT 1').get() as { id: number };
  assertEqual(newestLocal.id - oldestLocal.id + 1, DIAGNOSTIC_LOG_MAX_ROWS, 'the local log holds a contiguous window of the newest 200 writes');
  assertEqual(countRows(db, 'local_diagnostics'), DIAGNOSTIC_LOG_MAX_ROWS, 'the local log evicted the 25 oldest rows');

  console.log('\n4. The cap holds when the log is read repeatedly between writes');
  const beforeReads = countRows(db, 'local_diagnostics');
  for (let i = 0; i < 5; i++) cloudSync.listLocalDiagnostics(50);
  assertEqual(countRows(db, 'local_diagnostics'), beforeReads, 'reading the screen never grows or shrinks the log');
  const listed = cloudSync.listLocalDiagnostics(50);
  assertEqual(listed.length, 50, 'the screen reads a bounded page of failures');
  assertEqual(cloudSync.listLocalDiagnostics(10_000).length, DIAGNOSTIC_LOG_MAX_ROWS, 'an unbounded limit is clamped to the cap');

  console.log('\n5. Clearing the log leaves nothing behind');
  const removed = cloudSync.clearLocalDiagnostics();
  assertEqual(removed, DIAGNOSTIC_LOG_MAX_ROWS, 'clearing reports how many local failures were dropped');
  assertEqual(countRows(db, 'local_diagnostics'), 0, 'no local failure survives a clear');

  console.log('\n6. The transmission setting survives a restore, not just a list entry');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  const preserved = captureRestoreProtectedSettings(db);
  const capturedState = preserved.find((state: any) => state.key === 'diagnostics_transmission_enabled');
  assert(Boolean(capturedState), 'the transmission setting is captured for restore');
  assertEqual(capturedState?.value, 'true', 'its current value is what restore will re-apply');
  // Simulate the restore: the incoming database says the opposite.
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  assertEqual(readSetting(db, 'diagnostics_transmission_enabled'), 'false', 'precondition: the restored database disagrees');
  mergeRestoreProtectedSettings(db, preserved);
  assertEqual(readSetting(db, 'diagnostics_transmission_enabled'), 'true', 'a customer who restored a backup does not silently lose the setting');

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
