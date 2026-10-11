/**
 * Bounds on the diagnostics channel:
 *
 *   1. The local failure log is capped at 200 rows and the cap is enforced on
 *      write, evicting the OLDEST row first (a ring buffer, so the most recent
 *      failures are always the ones an operator can read out).
 *   2. A till that could never deliver an outbox row - no cloud key, or cloud
 *      sync off - does not enqueue at all, so nothing accumulates.
 *   3. The one-time upgrade enables safe automatic transmission for legacy
 *      installs without explicit refusal provenance, while explicit opt-outs persist.
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
const originalFetch = globalThis.fetch;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.11.0' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
  seedCustomer,
} = require('./helpers/test-setup');
const {
  captureRestoreProtectedSettings,
  mergeRestoreProtectedSettings,
  captureRestoreOutboxState,
  mergeRestoreOutboxState,
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

// A previous section's background writes can still be landing and evicting while
// the next builds a fixture, so wait until the count stops moving.
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
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
    key,
    value,
    now(),
  );
}

function readSetting(db: any, key: string): string | undefined {
  return (
    db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  )?.value;
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

  let db = initTestDb();

  console.log(
    '\n1. The migrated default is on, and an explicit local opt-out retains only local evidence',
  );
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_transmission_enabled'),
    'true',
    'a fresh database enables safe automatic transmission after the one-time migration',
  );
  setSetting(db, 'diagnostics_settings_explicit', 'true');
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  cloudSync.reportDiagnostic(event({ message: 'no such table: orders' }));
  const captured = await settle(() => countRows(db, 'local_diagnostics') === 1);
  assertOrThrow(captured, 'the failure is captured locally for the diagnostics screen');
  assertEqualOrThrow(
    countRows(db, 'store_diagnostics_outbox'),
    0,
    'nothing is queued for transmission while the setting is off',
  );
  assertEqualOrThrow(
    (db.prepare('SELECT signature FROM local_diagnostics').get() as { signature: string })
      .signature,
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
  assertEqualOrThrow(
    countRows(db, 'store_diagnostics_outbox'),
    0,
    'with cloud sync off nothing accumulates, so 25 failures leave the outbox empty',
  );

  setSetting(db, 'cloud_sync_enabled', '1');
  setSetting(db, 'cloud_api_key', '');
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  for (let i = 0; i < 25; i++) cloudSync.reportDiagnostic(event({ message: `failure ${i} of 25` }));
  const noKeySettled = await settle(() => countRows(db, 'local_diagnostics') === 50);
  assertOrThrow(noKeySettled, 'capture continues locally while the outbox stays empty');
  assertEqualOrThrow(
    countRows(db, 'store_diagnostics_outbox'),
    0,
    'a till with no cloud key never queues an undeliverable row',
  );

  console.log('\n3. With a deliverable configuration the outbox is written and bounded at 200');
  await drain(db);
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'telemetry_enabled', 'true');
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', '');
  process.env.FLO_MATRIX_OFFLINE = '1';
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  const totalWrites = DIAGNOSTIC_LOG_MAX_ROWS + 25;
  const writtenIds: string[] = [];
  const captureBase = Date.now();
  const captureAt = (index: number) =>
    new Date(captureBase - (totalWrites - index) * 60 * 60_000).toISOString();
  const expectedHour = (index: number) => {
    const hour = new Date(captureAt(index));
    hour.setUTCMinutes(0, 0, 0);
    return hour.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const localHas = (id: string) =>
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM local_diagnostics WHERE metadata_json LIKE ?')
        .get(`%${id}%`) as { count: number }
    ).count === 1;
  // Every write is awaited on a unique marker rather than on a row count: the
  // local log always keeps the newest rows, so a marker is present exactly once
  // this write's background task has run. Settling on a count would pass
  // immediately when the count is already at the cap, proving nothing.
  for (let i = 0; i < DIAGNOSTIC_LOG_MAX_ROWS; i++) {
    const eventId = crypto.randomUUID();
    writtenIds.push(eventId);
    cloudSync.captureOperationFailure({
      capture_point: 'fc.backend.order.create.persistence',
      outcome: 'not_applied',
      correlation_id: eventId,
      occurred_at: captureAt(i),
    });
    assertOrThrow(
      await settle(() => localHas(eventId)),
      `write ${i + 1} completed its background work`,
    );
    await (cloudSync as any).flushDiagnosticsOutbox();
  }
  assertOrThrow(
    countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS,
    'the outbox reaches exactly its cap',
  );
  for (let i = 0; i < 25; i++) {
    const eventId = crypto.randomUUID();
    writtenIds.push(eventId);
    cloudSync.captureOperationFailure({
      capture_point: 'fc.backend.order.create.persistence',
      outcome: 'not_applied',
      correlation_id: eventId,
      occurred_at: captureAt(DIAGNOSTIC_LOG_MAX_ROWS + i),
    });
    assertOrThrow(
      await settle(() => localHas(eventId)),
      `overflow write ${i + 1} completed its background work`,
    );
    await (cloudSync as any).flushDiagnosticsOutbox();
  }
  assertOrThrow(
    countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS,
    'after 25 overflow writes the outbox is still exactly at its cap, so none exceeded it',
  );
  assertEqualOrThrow(
    countRows(db, 'diagnostics_hourly_aggregates'),
    25,
    'new occurrences remain in the bounded aggregate table while the full queue is pending',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(count), 0) AS count FROM diagnostics_delivery_gaps WHERE reason_code = 'queue_eviction'",
        )
        .get() as { count: number }
    ).count,
    0,
    'a full pending queue does not cause avoidable report eviction',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(count), 0) AS count FROM diagnostics_delivery_gaps WHERE reason_code = 'local_retention'",
        )
        .get() as { count: number }
    ).count,
    25,
    'the bounded local detail log still records its 25 evicted rows',
  );
  assertEqualOrThrow(
    countRows(db, 'local_diagnostics'),
    DIAGNOSTIC_LOG_MAX_ROWS,
    'the local failure log is capped at 200 rows',
  );

  // Eviction policy: oldest first among rows that are equally eligible.
  const survivingWindows = (
    db.prepare('SELECT payload FROM store_diagnostics_outbox ORDER BY rowid ASC').all() as Array<{
      payload: string;
    }>
  ).map((row) => JSON.parse(row.payload).window_start);
  assertEqualOrThrow(
    survivingWindows[0],
    expectedHour(0),
    'the oldest pending report remains queued while the queue is full',
  );
  assertEqualOrThrow(
    survivingWindows.at(-1),
    expectedHour(DIAGNOSTIC_LOG_MAX_ROWS - 1),
    'the queue contains only the original reports, without sacrificing pending evidence',
  );
  const oldestLocal = db
    .prepare('SELECT id FROM local_diagnostics ORDER BY id ASC LIMIT 1')
    .get() as { id: number };
  const newestLocal = db
    .prepare('SELECT id FROM local_diagnostics ORDER BY id DESC LIMIT 1')
    .get() as { id: number };
  assertEqualOrThrow(
    newestLocal.id - oldestLocal.id + 1,
    DIAGNOSTIC_LOG_MAX_ROWS,
    'the local log holds a contiguous window of the newest 200 writes',
  );

  console.log('\n3b. The outbox evicts delivered rows before undelivered ones');
  await drain(db);
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'telemetry_enabled', 'true');
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', '');
  // The scenario the finding describes: 190 older undelivered rows and 10 NEWER
  // delivered ones, so insertion-order and delivered-first eviction cannot pick
  // the same rows. next_attempt_at far in the future keeps the background
  // flusher away from the fixture, so only the cap can remove these rows.
  const fixture = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO store_diagnostics_outbox (event_id, payload, status, next_attempt_at, created_at, updated_at, transport, permanent_failure)
     VALUES (?, '{}', ?, '2999-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'anonymous', 0)`,
      )
      .run(id, status);
  for (let i = 0; i < 190; i++) fixture(`undelivered-${i}`, 'pending');
  for (let i = 0; i < 10; i++) fixture(`delivered-${i}`, 'delivered');
  assertEqualOrThrow(
    countRows(db, 'store_diagnostics_outbox'),
    DIAGNOSTIC_LOG_MAX_ROWS,
    'the fixture fills the outbox to the cap',
  );
  for (let i = 0; i < 25; i++) {
    const eventId = crypto.randomUUID();
    cloudSync.captureOperationFailure({
      capture_point: 'fc.backend.order.create.persistence',
      outcome: 'not_applied',
      correlation_id: eventId,
      occurred_at: captureAt(DIAGNOSTIC_LOG_MAX_ROWS + i),
    });
    assertOrThrow(
      await settle(() => localHas(eventId)),
      `probe ${i + 1} completed its background work`,
    );
    await (cloudSync as any).flushDiagnosticsOutbox();
  }
  assertOrThrow(
    countRows(db, 'store_diagnostics_outbox') === DIAGNOSTIC_LOG_MAX_ROWS,
    'the outbox stayed at its cap through 25 probes',
  );
  const countPrefix = (prefix: string) =>
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE event_id LIKE ?')
        .get(prefix) as { count: number }
    ).count;
  assertEqualOrThrow(
    countPrefix('delivered-%'),
    0,
    'the 10 newer delivered rows were evicted before any undelivered row',
  );
  assertEqualOrThrow(
    countPrefix('undelivered-%'),
    190,
    'new diagnostic reports never evict older pending reports',
  );
  assertOrThrow(
    !db
      .prepare("SELECT event_id FROM store_diagnostics_outbox WHERE event_id LIKE 'delivered-%'")
      .get(),
    'delivered rows are reclaimed to make room before new reports are deferred',
  );
  assertEqualOrThrow(
    countRows(db, 'diagnostics_hourly_aggregates'),
    15,
    'reports that do not fit remain in the bounded aggregate table',
  );

  console.log('\n3b continued. Permanent rejections release queue space after gap accounting');
  await drain(db);
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'telemetry_enabled', 'true');
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', '');
  delete process.env.FLO_MATRIX_OFFLINE;
  for (let i = 0; i < DIAGNOSTIC_LOG_MAX_ROWS; i++) {
    const id = `permanent-rejection-${i}`;
    db.prepare(`INSERT INTO store_diagnostics_outbox (
      event_id, payload, status, created_at, updated_at, transport, permanent_failure
    ) VALUES (?, ?, 'failed', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'anonymous', 1)`).run(
      id,
      JSON.stringify({
        schema_version: 2,
        report_id: id,
        capture_point: 'fc.backend.order.create.quantity_validation',
        count: 1,
      }),
    );
  }
  db.prepare(`INSERT INTO diagnostics_delivery_gaps (reason_code, count, updated_at)
    VALUES ('permanent_rejection', ?, ?)`).run(DIAGNOSTIC_LOG_MAX_ROWS, now());
  globalThis.fetch = (async () =>
    new Response('{}', {
      status: 429,
      headers: { 'Retry-After': '3600' },
    })) as unknown as typeof fetch;
  const recoveredEventId = crypto.randomUUID();
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.quantity_validation',
    outcome: 'not_applied',
    correlation_id: recoveredEventId,
    occurred_at: new Date().toISOString(),
  });
  assertOrThrow(await settle(() => localHas(recoveredEventId)), 'the recovery probe is captured');
  await (cloudSync as any).flushDiagnosticsOutbox();
  const queuedRecoveryReport = db
    .prepare(
      "SELECT payload FROM store_diagnostics_outbox WHERE permanent_failure = 0 AND payload LIKE '%fc.backend.order.create.quantity_validation%' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { payload: string } | undefined;
  assertOrThrow(
    Boolean(queuedRecoveryReport),
    'the new aggregate is queued after reclaiming permanent rejections',
  );
  assertEqualOrThrow(
    countRows(db, 'store_diagnostics_outbox'),
    DIAGNOSTIC_LOG_MAX_ROWS,
    'reclaiming terminal rows keeps the outbox at its cap',
  );
  assertOrThrow(
    (
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE permanent_failure = 1',
        )
        .get() as { count: number }
    ).count < DIAGNOSTIC_LOG_MAX_ROWS,
    'permanent rejection rows no longer block all outbox capacity',
  );
  const gapRow = db
    .prepare(
      "SELECT count FROM diagnostics_delivery_gaps WHERE reason_code = 'permanent_rejection'",
    )
    .get() as { count: number } | undefined;
  const sealedGapReport = db
    .prepare(
      'SELECT payload FROM store_diagnostics_outbox WHERE payload LIKE \'%"gap_reason":"permanent_rejection"%\'',
    )
    .get() as { payload: string } | undefined;
  const totalPermanentRejectionGapCount =
    (gapRow?.count ?? 0) +
    (sealedGapReport ? (JSON.parse(sealedGapReport.payload).count as number) : 0);
  assertEqualOrThrow(
    totalPermanentRejectionGapCount,
    DIAGNOSTIC_LOG_MAX_ROWS,
    'reclaiming already-accounted rejections does not count their occurrences twice',
  );

  console.log(
    '\n3c. Local retention gaps reach the collector after a full queue drains, without a new capture',
  );
  await drain(db);
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  db.prepare('DELETE FROM local_diagnostics').run();
  process.env.FLO_MATRIX_OFFLINE = '1';
  const overflowWrites = DIAGNOSTIC_LOG_MAX_ROWS + 5;
  const overflowCaptureBase = Date.now();
  for (let i = 0; i < overflowWrites; i++) {
    const eventId = crypto.randomUUID();
    cloudSync.captureOperationFailure({
      capture_point: 'fc.backend.order.create.persistence',
      outcome: 'not_applied',
      correlation_id: eventId,
      occurred_at: new Date(overflowCaptureBase - (overflowWrites - i) * 60 * 60_000).toISOString(),
    });
    assertOrThrow(
      await settle(() => localHas(eventId)),
      `offline overflow capture ${i + 1} completed`,
    );
    await (cloudSync as any).flushDiagnosticsOutbox();
  }
  assertEqualOrThrow(
    countRows(db, 'store_diagnostics_outbox'),
    DIAGNOSTIC_LOG_MAX_ROWS,
    'the offline queue remains capped at 200',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT count FROM diagnostics_delivery_gaps WHERE reason_code = 'local_retention'",
        )
        .get() as { count: number }
    ).count,
    5,
    'five local detail rows aged out of the bounded log remain visible as a gap',
  );
  assertEqualOrThrow(
    countRows(db, 'diagnostics_hourly_aggregates'),
    5,
    'overflow occurrences remain in the bounded hourly aggregate table',
  );
  const originalReportIds = (
    db.prepare('SELECT event_id FROM store_diagnostics_outbox').all() as Array<{ event_id: string }>
  ).map((row) => row.event_id);
  const acceptedGapReasons: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.payload.report.capture_point === 'fc.diagnostics.delivery.queue_gap') {
      acceptedGapReasons.push(body.payload.report.facts.gap_reason);
    }
    return new Response(
      JSON.stringify({
        schema_version: 2,
        report_id: body.payload.report.report_id,
        disposition: 'accepted',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
  delete process.env.FLO_MATRIX_OFFLINE;
  db.prepare(
    "UPDATE store_diagnostics_outbox SET status = 'pending', next_attempt_at = NULL, attempt_count = 0 WHERE permanent_failure = 0",
  ).run();
  const originalPendingCount = () => {
    const placeholders = originalReportIds.map(() => '?').join(',');
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE event_id IN (${placeholders}) AND status IN ('pending', 'failed')`,
        )
        .get(...originalReportIds) as { count: number }
    ).count;
  };
  for (let i = 0; i < 20 && originalPendingCount() > 0; i++) {
    await (cloudSync as any).flushDiagnosticsOutbox();
  }
  assertEqualOrThrow(
    originalPendingCount(),
    0,
    'the original offline reports drain before the retained aggregate and gap snapshots',
  );
  assertEqualOrThrow(acceptedGapReasons.length, 0, 'gap reports wait behind older queued reports');
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE status IN ('pending', 'failed') AND payload LIKE '%fc.diagnostics.delivery.queue_gap%'",
        )
        .get() as { count: number }
    ).count,
    1,
    'a gap report remains pending after the older reports have drained',
  );
  await (cloudSync as any).flushDiagnosticsOutbox();
  assertOrThrow(
    acceptedGapReasons.includes('local_retention'),
    'a subsequent flush delivers the gap snapshot without a new capture',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(count), 0) AS count FROM diagnostics_delivery_gaps WHERE reason_code = 'local_retention'",
        )
        .get() as { count: number }
    ).count,
    0,
    'the acknowledged local-retention snapshot clears its local counter',
  );

  console.log('\n3d. Aggregate and gap sealing work stays bounded and gives gaps a delivery slot');
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'telemetry_enabled', 'true');
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', '');
  setSetting(db, 'cloud_deletion_status', '');
  delete process.env.FLO_MATRIX_OFFLINE;
  const extremeCount = Number.MAX_SAFE_INTEGER;
  const aggregateAt = new Date();
  aggregateAt.setUTCMinutes(0, 0, 0);
  const aggregateWindow = aggregateAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const aggregateFirst = new Date(aggregateAt.getTime() + 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const aggregateLast = new Date(aggregateAt.getTime() + 120_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  db.prepare(`INSERT INTO diagnostics_hourly_aggregates (
    aggregate_key, capture_point, reason_code, classification, operation, stage, outcome,
    window_start, count, first_occurred_at, last_occurred_at, app_version, app_build, platform,
    examples_json, facts_json, updated_at
  ) VALUES ('extreme-aggregate', 'fc.backend.order.create.persistence', 'persistence.failed',
    'unexpected_failure', 'order.create', 'persistence', 'not_applied', ?, ?, ?, ?, '3.12.22', 'dev', 'unknown', '[]', '{}', ?)`).run(
    aggregateWindow,
    extremeCount,
    aggregateFirst,
    aggregateLast,
    now(),
  );
  db.prepare(
    "INSERT INTO diagnostics_delivery_gaps (reason_code, count, updated_at) VALUES ('local_retention', ?, ?)",
  ).run(extremeCount, now());
  const sealedCounts: number[] = [];
  const sealedPoints: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    sealedCounts.push(body.payload.report.count);
    sealedPoints.push(body.payload.report.capture_point);
    return new Response(
      JSON.stringify({
        schema_version: 2,
        report_id: body.payload.report.report_id,
        disposition: 'accepted',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
  await (cloudSync as any).flushDiagnosticsOutbox();
  assertEqualOrThrow(
    sealedCounts.length,
    20,
    'one flush seals no more than the 20-report batch budget',
  );
  assertOrThrow(
    sealedCounts.every((count) => count === 100_000),
    'each sealed extreme-count report respects the 100,000 occurrence cap',
  );
  assertEqualOrThrow(
    sealedPoints.filter((point) => point === 'fc.backend.order.create.persistence').length,
    19,
    'the aggregate keeps most of the bounded flush budget',
  );
  assertEqualOrThrow(
    sealedPoints.filter((point) => point === 'fc.diagnostics.delivery.queue_gap').length,
    1,
    'a pending gap receives one report slot before the aggregate is exhausted',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT count FROM diagnostics_hourly_aggregates WHERE aggregate_key = 'extreme-aggregate'",
        )
        .get() as { count: number }
    ).count,
    extremeCount - 1_900_000,
    'unsealed aggregate occurrences remain locally accounted for after one fair bounded flush',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT count FROM diagnostics_delivery_gaps WHERE reason_code = 'local_retention'",
        )
        .get() as { count: number }
    ).count,
    extremeCount - 100_000,
    'unsealed gap occurrences remain locally accounted for after one bounded flush',
  );
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  globalThis.fetch = originalFetch;

  console.log('\n3e. Both anonymous and signed retry paths honor a one-hour Retry-After');
  const retryEventId = crypto.randomUUID();
  globalThis.fetch = (async () =>
    new Response('{}', {
      status: 429,
      headers: { 'Retry-After': '3600' },
    })) as unknown as typeof fetch;
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.quantity_validation',
    outcome: 'not_applied',
    correlation_id: retryEventId,
    occurred_at: captureAt(overflowWrites + 1),
  });
  assertOrThrow(await settle(() => localHas(retryEventId)), 'the retry probe is captured');
  await (cloudSync as any).flushDiagnosticsOutbox();
  const anonymousRetry = db
    .prepare(
      "SELECT next_attempt_at FROM store_diagnostics_outbox WHERE status = 'failed' AND transport = 'anonymous' AND last_error = 'network_error' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { next_attempt_at: string } | undefined;
  assertOrThrow(Boolean(anonymousRetry?.next_attempt_at), 'an anonymous 429 remains queued');
  const anonymousRetryAt = Date.parse(`${anonymousRetry!.next_attempt_at.replace(' ', 'T')}Z`);
  assertOrThrow(
    anonymousRetryAt >= Date.now() + 3_590_000,
    'anonymous retry does not run early at the 30-minute exponential cap',
  );

  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  setSetting(db, 'cloud_sync_enabled', '1');
  setSetting(db, 'cloud_api_key', 'synthetic-test-key');
  setSetting(db, 'cloud_server_url', 'https://example.invalid');
  setSetting(db, 'cloud_registration_status', 'registered');
  setSetting(db, 'cloud_services_disabled_by_user', 'false');
  const priorSignedFetch = (cloudSync as any).signedFetch;
  const signedReportBodies: string[] = [];
  const signedStatuses = [429, 503];
  (cloudSync as any).signedFetch = async (url: string, options: RequestInit = {}) => {
    if (url === '/api/pos/diagnostics-consent') {
      return new Response(
        JSON.stringify({ schema_version: 2, enabled: true, revision: 1, initialized: true }),
        { status: 200 },
      );
    }
    signedReportBodies.push(String(options.body || ''));
    return new Response(
      JSON.stringify({
        schema_version: 2,
        report_id: crypto.randomUUID(),
        disposition: 'accepted',
      }),
      {
        status: signedStatuses.shift() || 503,
        headers: { 'Retry-After': '3600' },
      },
    );
  };
  const signedRetryEventId = crypto.randomUUID();
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.stock_validation',
    outcome: 'not_applied',
    correlation_id: signedRetryEventId,
    occurred_at: captureAt(overflowWrites + 2),
  });
  assertOrThrow(
    await settle(() => localHas(signedRetryEventId)),
    'the signed retry probe is captured',
  );
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  await (cloudSync as any).flushDiagnosticsOutbox();
  const signedRetry = db
    .prepare(
      "SELECT event_id, payload, next_attempt_at, permanent_failure FROM store_diagnostics_outbox WHERE status = 'failed' AND transport = 'signed' AND last_error = 'http_429' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as
    | { event_id: string; payload: string; next_attempt_at: string; permanent_failure: number }
    | undefined;
  assertOrThrow(Boolean(signedRetry?.next_attempt_at), 'a signed 429 remains queued');
  const signedRetryAt = Date.parse(`${signedRetry!.next_attempt_at.replace(' ', 'T')}Z`);
  assertOrThrow(
    signedRetryAt >= Date.now() + 3_590_000,
    'signed retry honors the full one-hour server hint',
  );
  assertEqualOrThrow(
    signedRetry?.permanent_failure,
    0,
    'a misleading mismatched ack cannot make a signed 429 permanent',
  );
  assertEqualOrThrow(
    JSON.parse(signedRetry!.payload).report_id,
    signedRetry?.event_id,
    'the retry row keeps its frozen report UUID',
  );
  const frozenSignedPayload = signedRetry!.payload;
  db.prepare('UPDATE store_diagnostics_outbox SET next_attempt_at = NULL WHERE event_id = ?').run(
    signedRetry!.event_id,
  );
  await (cloudSync as any).flushDiagnosticsOutbox();
  assertEqualOrThrow(
    signedReportBodies.length,
    2,
    'the retry reaches the sender again after the test advances its deadline',
  );
  assertEqualOrThrow(
    signedReportBodies[0],
    frozenSignedPayload,
    'the first signed attempt sends the frozen report bytes',
  );
  assertEqualOrThrow(
    signedReportBodies[1],
    frozenSignedPayload,
    'a misleading 503 ack retries the same frozen report bytes',
  );
  const signedAfter503 = db
    .prepare(
      'SELECT payload, next_attempt_at, permanent_failure, last_error FROM store_diagnostics_outbox WHERE event_id = ?',
    )
    .get(signedRetry!.event_id) as {
    payload: string;
    next_attempt_at: string;
    permanent_failure: number;
    last_error: string;
  };
  assertEqualOrThrow(
    signedAfter503.payload,
    frozenSignedPayload,
    'the signed 503 preserves report identity and count',
  );
  assertEqualOrThrow(
    signedAfter503.last_error,
    'http_503',
    'a signed 503 remains retryable despite the mismatched ack',
  );
  assertEqualOrThrow(
    signedAfter503.permanent_failure,
    0,
    'a signed 503 does not create a permanent rejection',
  );
  const signedRetry503At = Date.parse(`${signedAfter503.next_attempt_at.replace(' ', 'T')}Z`);
  assertOrThrow(
    signedRetry503At >= Date.now() + 3_590_000,
    'signed 503 honors the full one-hour server hint',
  );
  (cloudSync as any).signedFetch = priorSignedFetch;
  globalThis.fetch = originalFetch;
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', '');
  process.env.FLO_MATRIX_OFFLINE = '1';

  console.log("\n3f. A restore keeps this device's own failure log and drops the incoming one");
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  db.prepare(`INSERT INTO store_diagnostics_outbox (
    event_id, payload, status, next_attempt_at, created_at, updated_at, transport, permanent_failure
  ) VALUES ('permanent-rejection-probe', '{}', 'failed', '2999-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'anonymous', 1)`).run();
  db.prepare(`INSERT INTO store_diagnostics_outbox (
    event_id, payload, status, next_attempt_at, created_at, updated_at, transport, permanent_failure
  ) VALUES ('restore-route-probe', '{"schema_version":2,"report_id":"7db72a4f-195f-4e5c-a11c-d3ed89afbcaf"}',
    'failed', '2999-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'anonymous', 0)`).run();
  db.prepare(`INSERT INTO diagnostics_hourly_aggregates (
    aggregate_key, capture_point, reason_code, classification, operation, stage, outcome,
    window_start, count, first_occurred_at, last_occurred_at, app_version, app_build, platform,
    examples_json, facts_json, updated_at
  ) VALUES ('restore-probe', 'fc.backend.order.create.stock_validation', 'order.stock_insufficient',
    'expected_rejection', 'order.create', 'validation', 'not_applied', '2026-10-09T01:00:00Z',
    2, '2026-10-09T01:02:00Z', '2026-10-09T01:03:00Z', '3.12.22', 'dev', 'darwin', '[]', '{}', ?)`).run(
    now(),
  );
  db.prepare(
    `INSERT INTO diagnostics_delivery_gaps (reason_code, count, updated_at) VALUES ('local_retention', 4, ?)`,
  ).run(now());
  const preservedLocal = captureRestoreOutboxState(db);
  assertOrThrow(
    Array.isArray(preservedLocal.local),
    'the local failure log is captured across a restore',
  );
  assertEqualOrThrow(
    preservedLocal.diagnosticsAggregates.length,
    1,
    'pending hourly aggregates are captured across a restore',
  );
  assertEqualOrThrow(
    preservedLocal.diagnosticsGaps.length,
    1,
    'delivery gap counters are captured across a restore',
  );
  const anonymousFixture = preservedLocal.diagnostics.find(
    (row: any) => row.event_id === 'restore-route-probe',
  );
  assertEqualOrThrow(
    anonymousFixture?.transport,
    'anonymous',
    'restore state captures the original anonymous route',
  );
  assertEqualOrThrow(
    anonymousFixture?.permanent_failure,
    0,
    'restore state preserves retryable report status',
  );
  const permanentFixture = preservedLocal.diagnostics.find(
    (row: any) => row.event_id === 'permanent-rejection-probe',
  );
  assertEqualOrThrow(
    permanentFixture?.permanent_failure,
    1,
    'restore state preserves permanent rejection status',
  );
  db.prepare(
    "DELETE FROM diagnostics_hourly_aggregates WHERE aggregate_key = 'restore-probe'",
  ).run();
  db.prepare(
    "UPDATE diagnostics_delivery_gaps SET count = 9 WHERE reason_code = 'local_retention'",
  ).run();
  db.prepare('DELETE FROM local_diagnostics').run();
  db.prepare(
    "INSERT INTO local_diagnostics (event_code, severity, error_class, signature, summary, occurred_at, created_at) VALUES ('server.internal_error', 'error', 'Error', 'Error: other till', 'Another till failed here', ?, ?)",
  ).run(now(), now());
  assertOrThrow(
    countRows(db, 'local_diagnostics') >= 1,
    'precondition: the database now holds a foreign failure row',
  );
  mergeRestoreOutboxState(db, preservedLocal);
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT count FROM diagnostics_hourly_aggregates WHERE aggregate_key = 'restore-probe'",
        )
        .get() as { count: number }
    ).count,
    2,
    "restore reinstates the receiving till's pending aggregate without changing its count",
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT count FROM diagnostics_delivery_gaps WHERE reason_code = 'local_retention'",
        )
        .get() as { count: number }
    ).count,
    4,
    "restore reinstates the receiving till's delivery gap count",
  );
  const afterRestore = db.prepare('SELECT signature FROM local_diagnostics').all() as Array<{
    signature: string;
  }>;
  assertOrThrow(
    !afterRestore.some((row) => row.signature.includes('other till')),
    "a restored backup no longer leaves another till's failures on this device",
  );
  const preservedSignatures = (preservedLocal.local as Array<{ signature: string }>).map(
    (row) => row.signature,
  );
  assertOrThrow(
    preservedSignatures.length > 0,
    'precondition: this device had its own failures before the restore',
  );
  assertOrThrow(
    afterRestore.every((row) => preservedSignatures.includes(row.signature)),
    "the restored log contains only this device's own failures",
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
  assertEqualOrThrow(
    countRows(db, 'local_diagnostics'),
    beforeReads,
    'reading the screen never grows or shrinks the log',
  );
  const listed = cloudSync.listLocalDiagnostics(50);
  assertEqualOrThrow(listed.length, 25, 'the screen reads the whole log when it is under the cap');
  assertEqualOrThrow(
    cloudSync.listLocalDiagnostics(10).length,
    10,
    'a smaller page size is honoured',
  );
  assertEqualOrThrow(
    cloudSync.listLocalDiagnostics(10_000).length,
    25,
    'an oversized limit does not read past what exists',
  );

  console.log('\n5. Clearing the log leaves nothing behind');
  const removed = cloudSync.clearLocalDiagnostics();
  assertEqualOrThrow(removed, 25, 'clearing reports how many local failures were dropped');
  assertEqualOrThrow(countRows(db, 'local_diagnostics'), 0, 'no local failure survives a clear');

  console.log('\n6. The transmission setting survives a restore, not just a list entry');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'diagnostics_settings_explicit', 'true');
  setSetting(db, 'diagnostics_consent_sync_pending', 'true');
  setSetting(db, 'diagnostics_consent_remote_initialized', 'true');
  setSetting(db, 'cloud_sync_enabled', '1');
  setSetting(db, 'cloud_api_key', 'synthetic-health-test-key');
  assertEqualOrThrow(
    cloudSync.listDiagnosticDeliveryHealth().transport,
    'disabled',
    'a pending signed consent acknowledgment is not reported as transmitting',
  );
  const preserved = captureRestoreProtectedSettings(db);
  const capturedState = preserved.find(
    (state: any) => state.key === 'diagnostics_transmission_enabled',
  );
  assertOrThrow(Boolean(capturedState), 'the transmission setting is captured for restore');
  assertEqualOrThrow(
    capturedState?.value,
    'true',
    'its current value is what restore will re-apply',
  );
  assertEqualOrThrow(
    preserved.find((state: any) => state.key === 'diagnostics_settings_explicit')?.value,
    'true',
    'the explicit owner-choice marker is captured for restore',
  );
  assertEqualOrThrow(
    preserved.find((state: any) => state.key === 'diagnostics_consent_sync_pending')?.value,
    'true',
    'a pending consent acknowledgment is captured for restore',
  );
  assertEqualOrThrow(
    preserved.find((state: any) => state.key === 'diagnostics_consent_remote_initialized')?.value,
    'true',
    'the remote initialization marker is captured for restore',
  );
  // Simulate the restore: the incoming database says the opposite.
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  setSetting(db, 'diagnostics_settings_explicit', 'false');
  setSetting(db, 'diagnostics_consent_sync_pending', 'false');
  setSetting(db, 'diagnostics_consent_remote_initialized', 'false');
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_transmission_enabled'),
    'false',
    'precondition: the restored database disagrees',
  );
  mergeRestoreProtectedSettings(db, preserved);
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_transmission_enabled'),
    'true',
    'a customer who restored a backup does not silently lose the setting',
  );
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_settings_explicit'),
    'true',
    'restore retains diagnostics choice provenance',
  );
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_consent_sync_pending'),
    'true',
    'restore retains unsynchronized consent changes',
  );
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_consent_remote_initialized'),
    'true',
    'restore retains the remote initialization state',
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT transport FROM store_diagnostics_outbox WHERE event_id = 'restore-route-probe'",
        )
        .get() as { transport: string }
    ).transport,
    'anonymous',
    "restore reinstates the receiving till's pending report transport",
  );
  assertEqualOrThrow(
    (
      db
        .prepare(
          "SELECT permanent_failure FROM store_diagnostics_outbox WHERE event_id = 'permanent-rejection-probe'",
        )
        .get() as { permanent_failure: number }
    ).permanent_failure,
    1,
    'restore retains a permanently rejected report state',
  );

  console.log(
    '\n7. The legacy false default migrates once, while explicit refusal provenance remains off',
  );
  seedCustomer(db, 'diagnostics-upgrade-customer', 'Synthetic Upgrade Customer');
  const preservedOrder = db
    .prepare(`INSERT INTO orders (
    order_number, type, status, subtotal, total, created_at, updated_at
  ) VALUES ('DIAG-UPGRADE-ORDER', 'takeaway', 'completed', 25, 25, ?, ?)`)
    .run(now(), now()).lastInsertRowid;
  db.prepare(`INSERT INTO bills (
    bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at
  ) VALUES ('DIAG-UPGRADE-BILL', ?, 25, 25, 25, 0, 'paid', ?, ?)`).run(
    preservedOrder,
    now(),
    now(),
  );
  db.prepare('DELETE FROM store_diagnostics_outbox').run();
  db.prepare('DELETE FROM diagnostics_hourly_aggregates').run();
  db.prepare('DELETE FROM diagnostics_delivery_gaps').run();
  db.prepare(`INSERT INTO store_diagnostics_outbox (
    event_id, payload, status, created_at, updated_at, transport, permanent_failure
  ) VALUES ('legacy-source-probe', ?, 'pending', ?, ?, 'anonymous', 0)`).run(
    JSON.stringify({
      event_id: 'legacy-source-probe',
      event_code: 'server.internal_error',
      severity: 'error',
      message: 'Error: SQLITE_CONSTRAINT: UNIQUE constraint failed: orders.customer_id',
      metadata: { customer_name: 'Synthetic Upgrade Customer' },
    }),
    now(),
    now(),
  );
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  db.prepare("DELETE FROM settings WHERE key = 'diagnostics_settings_explicit'").run();
  db.pragma('user_version = 108');
  closeDatabase();
  db = initTestDb();
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_transmission_enabled'),
    'true',
    'an unproven legacy false is enabled on upgrade',
  );
  assertEqualOrThrow(
    (
      db.prepare("SELECT name FROM customers WHERE id = 'diagnostics-upgrade-customer'").get() as {
        name: string;
      }
    ).name,
    'Synthetic Upgrade Customer',
    'the upgrade leaves existing customer data intact',
  );
  assertEqualOrThrow(
    (
      db.prepare("SELECT total FROM bills WHERE bill_number = 'DIAG-UPGRADE-BILL'").get() as {
        total: number;
      }
    ).total,
    25,
    'the upgrade leaves existing paid financial records intact',
  );
  setSetting(db, 'diagnostics_consent', 'false');
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  setSetting(db, 'telemetry_enabled', 'false');
  setSetting(db, 'cloud_sync_enabled', '0');
  setSetting(db, 'cloud_api_key', '');
  const startupOperationId = crypto.randomUUID();
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.quantity_validation',
    outcome: 'not_applied',
    correlation_id: startupOperationId,
  });
  assertOrThrow(
    await settle(() => localHas(startupOperationId)),
    'the startup probe is captured while transmission is disabled',
  );
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'diagnostics_transmission_enabled', 'true');
  setSetting(db, 'telemetry_enabled', 'true');
  const anonymousBodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    anonymousBodies.push(body);
    return new Response(
      JSON.stringify({
        schema_version: 2,
        report_id: body.payload.report.report_id,
        disposition: 'accepted',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  delete process.env.FLO_MATRIX_OFFLINE;
  await cloudSync.setDiagnosticsConsent(true);
  assertOrThrow(
    await settle(
      () =>
        (
          db
            .prepare(
              "SELECT permanent_failure FROM store_diagnostics_outbox WHERE event_id = 'legacy-source-probe'",
            )
            .get() as { permanent_failure: number } | undefined
        )?.permanent_failure === 1,
    ),
    'the opt-in flush retains an unsafe legacy row locally with a visible gap',
  );
  assertOrThrow(
    await settle(() => {
      const row = db
        .prepare(
          "SELECT status FROM store_diagnostics_outbox WHERE event_id = 'legacy-source-probe'",
        )
        .get() as { status: string } | undefined;
      return row?.status === 'failed';
    }),
    'the legacy report remains in the local queue with a retained delivery state',
  );
  assertEqualOrThrow(
    anonymousBodies.length,
    1,
    'the unpaired startup path sends one safe diagnostic report without a signed API key',
  );
  assertEqualOrThrow(
    anonymousBodies[0]?.event_type,
    'diagnostic_counts',
    'startup uses the anonymous diagnostics collector',
  );
  assertEqualOrThrow(
    anonymousBodies[0]?.payload?.report?.capture_point,
    'fc.backend.order.create.quantity_validation',
    'startup sends only the registered safe report',
  );
  assertEqualOrThrow(
    anonymousBodies[0]?.payload?.report?.examples,
    undefined,
    'anonymous delivery omits linked operation references',
  );
  assertOrThrow(
    !JSON.stringify(anonymousBodies).includes('UNIQUE constraint failed'),
    'the legacy SQL payload never reaches anonymous delivery',
  );
  assertOrThrow(
    !JSON.stringify(anonymousBodies).includes('Synthetic Upgrade Customer'),
    'legacy customer data never reaches anonymous delivery',
  );
  setSetting(db, 'telemetry_enabled', 'false');
  const telemetryOffId = crypto.randomUUID();
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.stock_validation',
    outcome: 'not_applied',
    correlation_id: telemetryOffId,
  });
  assertOrThrow(
    await settle(() => localHas(telemetryOffId)),
    'a failure is still captured locally when telemetry is off',
  );
  cloudSync.reload();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEqualOrThrow(
    anonymousBodies.length,
    1,
    'anonymous startup does not send when telemetry is disabled',
  );
  setSetting(db, 'telemetry_enabled', 'true');
  setSetting(db, 'diagnostics_consent', 'false');
  const consentOffId = crypto.randomUUID();
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.quantity_validation',
    outcome: 'not_applied',
    correlation_id: consentOffId,
  });
  assertOrThrow(
    await settle(() => localHas(consentOffId)),
    'a failure is still captured locally when diagnostics consent is off',
  );
  cloudSync.reload();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEqualOrThrow(
    anonymousBodies.length,
    1,
    'anonymous startup does not send without diagnostics consent',
  );
  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'cloud_deletion_status', 'pending');
  assertEqualOrThrow(
    cloudSync.listDiagnosticDeliveryHealth().transport,
    'disabled',
    'pending cloud deletion is shown as blocked diagnostics transport',
  );
  const deletionPendingId = crypto.randomUUID();
  cloudSync.captureOperationFailure({
    capture_point: 'fc.backend.order.create.stock_validation',
    outcome: 'not_applied',
    correlation_id: deletionPendingId,
  });
  assertOrThrow(
    await settle(() => localHas(deletionPendingId)),
    'a failure is still captured locally while cloud deletion is pending',
  );
  cloudSync.reload();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEqualOrThrow(
    anonymousBodies.length,
    1,
    'anonymous startup does not send while cloud deletion is pending',
  );
  assertOrThrow(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM diagnostics_delivery_gaps WHERE reason_code = 'local_retention' AND count > 0",
        )
        .get() as { count: number }
    ).count > 0,
    'the unsent legacy row remains visible as a delivery gap',
  );
  assertOrThrow(
    String(
      (
        db
          .prepare(
            "SELECT payload FROM store_diagnostics_outbox WHERE event_id = 'legacy-source-probe'",
          )
          .get() as { payload: string }
      ).payload,
    ).includes('Synthetic Upgrade Customer'),
    'the old report remains available locally for historical evidence',
  );
  cloudSync.stop();
  globalThis.fetch = originalFetch;

  setSetting(db, 'diagnostics_consent', 'false');
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  db.prepare("DELETE FROM settings WHERE key = 'diagnostics_settings_explicit'").run();
  db.pragma('user_version = 108');
  closeDatabase();
  db = initTestDb();
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_consent'),
    'false',
    'an existing explicit consent refusal remains disabled on upgrade',
  );
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_transmission_enabled'),
    'false',
    'transmission remains off with the refused consent',
  );
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_settings_explicit'),
    'true',
    'the preserved refusal gains durable provenance',
  );

  setSetting(db, 'diagnostics_consent', 'true');
  setSetting(db, 'diagnostics_transmission_enabled', 'false');
  db.pragma('user_version = 108');
  closeDatabase();
  db = initTestDb();
  assertEqualOrThrow(
    readSetting(db, 'diagnostics_transmission_enabled'),
    'false',
    'a proven future opt-out is not overwritten by the migration',
  );

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
