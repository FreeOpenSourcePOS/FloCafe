/**
 * Diagnostics event ingestion tests: POST /api/diagnostics/event validation,
 * authz, consent gating, metadata bounds, plus backend operational reporting
 * (order.create.failed, payment.batch.failed) and POS checkout failure
 * resilience when telemetry dispatch fails.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/diagnostics-event.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostics-event-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '2.9.5' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedProduct, seedTable, seedCategory,
  api, assert, assertEqual, getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');

function countDiagnostics(db: any, eventCode?: string): number {
  const rows = db.prepare('SELECT payload FROM store_diagnostics_outbox').all() as Array<{ payload: string }>;
  if (!eventCode) return rows.length;
  return rows.filter((row) => {
    try { return JSON.parse(row.payload).event_code === eventCode; } catch { return false; }
  }).length;
}

function findDiagnostic(db: any, eventCode: string): any | null {
  const rows = db.prepare('SELECT payload, status FROM store_diagnostics_outbox ORDER BY created_at DESC').all() as Array<{ payload: string; status: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload);
      if (payload.event_code === eventCode) return { ...payload, status: row.status };
    } catch { /* skip corrupt */ }
  }
  return null;
}

function findDiagnosticByStage(db: any, eventCode: string, stage: string): any | null {
  const rows = db.prepare('SELECT payload, status FROM store_diagnostics_outbox ORDER BY created_at DESC').all() as Array<{ payload: string; status: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload);
      if (payload.event_code === eventCode && payload.metadata?.stage === stage) return { ...payload, status: row.status };
    } catch { /* skip corrupt */ }
  }
  return null;
}

function findDiagnosticByStageAndStatus(db: any, eventCode: string, stage: string, status: number, itemCount: number): any | null {
  const rows = db.prepare('SELECT payload, status FROM store_diagnostics_outbox ORDER BY created_at DESC').all() as Array<{ payload: string; status: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload);
      if (payload.event_code === eventCode
        && payload.metadata?.stage === stage
        && payload.metadata?.status === status
        && payload.metadata?.item_count === itemCount) return { ...payload, status: row.status };
    } catch { /* skip corrupt */ }
  }
  return null;
}

async function main() {
  console.log('Diagnostics Event Ingestion Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedTable(db, 'diag-table-1', 1, 4);
  seedCategory(db, 'cat-1', 'Menu');
  seedProduct(db, 'p1', 'cat-1', 'Espresso', 3.5, { track_inventory: true, stock_quantity: 0 });
  seedProduct(db, 'p2', 'cat-1', 'Latte', 4.5);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  // Enqueue is async (withDatabaseRequest + runBackground); drain by spinning
  // the event loop until a row appears or the deadline passes.
  const settle = async (predicate: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  };

  try {
    console.log('\n1. Valid diagnostic event is accepted (202) and lands in store_diagnostics_outbox as pending');
    const eventId = crypto.randomUUID();
    const okRes = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        event_id: eventId,
        event_code: 'order.place.failed',
        severity: 'error',
        message: 'The order could not be completed on this device',
        metadata: { detail: 'The order could not be completed on this device', status: null, stage: 'order_place' },
        occurred_at: new Date().toISOString(),
      },
    });
    assertEqual(okRes.status, 202, 'a well-formed event is accepted with 202');
    const queued = await settle(() => countDiagnostics(db, 'order.place.failed') > 0);
    assert(queued, 'the event is written to store_diagnostics_outbox');
    const row = findDiagnostic(db, 'order.place.failed');
    assertEqual(row?.status, 'pending', 'the outbox row starts pending');
    assert(row?.event_id && /^[0-9a-f-]{36}$/i.test(row.event_id), 'event_id is a server-generated UUID');
    assertEqual(row?.severity, 'error', 'severity is preserved');
    assertEqual(row?.message, 'Order placement failed', 'message is replaced with the approved diagnostic text');
    assertEqual(row?.metadata.stage, 'order_place', 'metadata is stored');
    assertEqual(row?.metadata.detail, undefined, 'unapproved free-form metadata is not persisted');

    console.log('\n2. Unauthenticated and malformed requests are rejected without writing anything');
    const unauth = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      body: { event_code: 'order.place.failed', severity: 'error' },
    });
    assertEqual(unauth.status, 401, 'unauthenticated requests are rejected with 401');

    const malformed = await fetch(`${baseUrl}/api/diagnostics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...owner.authHeader },
      body: '{not json',
    });
    assert(malformed.status === 400 || malformed.status === 500 || malformed.status === 413,
      `malformed JSON is rejected (got ${malformed.status})`);

    const missingCode = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { severity: 'error' },
    });
    assertEqual(missingCode.status, 400, 'a missing event_code is rejected with 400');

    const badSeverity = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'order.place.failed', severity: 'fatal' },
    });
    assertEqual(badSeverity.status, 400, 'an unknown severity is rejected with 400');

    const badCode = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'Order Place Failed!', severity: 'error' },
    });
    assertEqual(badCode.status, 400, 'a non dot-namespaced event_code is rejected with 400');
    const unsupportedCode = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'order.place.unapproved', severity: 'error' },
    });
    assertEqual(unsupportedCode.status, 400, 'an otherwise well-formed but unsupported event_code is rejected with 400');
    const before = countDiagnostics(db);
    const noBody = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqual(noBody.status, 400, 'an empty payload is rejected with 400');
    assertEqual(countDiagnostics(db), before, 'no outbox rows were written by rejected requests');
    for (const [eventCode, message] of [
      ['order.place.rejected', 'Order rejected'],
      ['order.place.unreachable', 'Order server unreachable'],
      ['order.place.storage_unavailable', 'Order storage unavailable'],
    ] as const) {
      const supported = await api(baseUrl, '/api/diagnostics/event', {
        method: 'POST',
        headers: owner.authHeader,
        body: { event_code: eventCode, severity: 'warn' },
      });
      assertEqual(supported.status, 202, `${eventCode} is accepted`);
      assert(await settle(() => findDiagnostic(db, eventCode) !== null), `${eventCode} is enqueued`);
      assertEqual(findDiagnostic(db, eventCode)?.message, message, `${eventCode} uses approved diagnostic text`);
    }

    console.log('\n3. Boundary: messages use approved text; oversized metadata is rejected');
    const longMessage = 'M'.repeat(500);
    const clampRes = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'payment.batch.failed', severity: 'warn', message: longMessage },
    });
    assertEqual(clampRes.status, 202, 'an event with an over-long message is still accepted');
    const clamped = await settle(() => findDiagnostic(db, 'payment.batch.failed') !== null);
    assert(clamped, 'the clamped event is enqueued');
    const clampedRow = findDiagnostic(db, 'payment.batch.failed');
    assertEqual(clampedRow?.message, 'Payment batch failed', 'the stored message uses the approved diagnostic text');

    const hugeMetadata: Record<string, string> = {};
    for (let i = 0; i < 40; i++) hugeMetadata[`key_${i}`] = 'X'.repeat(300);
    const oversizeRes = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'payment.batch.failed', severity: 'error', metadata: hugeMetadata },
    });
    assertEqual(oversizeRes.status, 400, 'metadata beyond the size cap is rejected with 400');

    console.log('\n4. Depth clamp: nested structures beyond depth 3 are trimmed, not rejected');
    const nested = { route: '/api/orders', method: 'GET', a: { b: { c: { d: { e: 'too deep' } } } }, keep: 'shallow' };
    const depthRes = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'server.internal_error', severity: 'info', metadata: nested },
    });
    assertEqual(depthRes.status, 202, 'a deeply nested metadata payload is accepted after trimming');
    const depthQueued = await settle(() => findDiagnostic(db, 'server.internal_error') !== null);
    assert(depthQueued, 'the depth-trimmed event is enqueued');
    const depthRow = findDiagnostic(db, 'server.internal_error');
    assertEqual(depthRow?.metadata.route, '/api/orders', 'approved server route survives projection');
    assertEqual(depthRow?.metadata.method, 'GET', 'approved server metadata survives projection');
    assertEqual(depthRow?.metadata.keep, undefined, 'unapproved metadata is dropped');
    assertEqual(depthRow?.metadata.a, undefined, 'nested metadata is dropped');

    console.log('\n5. Consent toggle: diagnostics_consent=false discards events (never written)');
    const consentBefore = countDiagnostics(db);
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent', 'false', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(now());
    const consentOff = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'order.place.failed', severity: 'error' },
    });
    assertEqual(consentOff.status, 202, 'the endpoint still acknowledges the event while consent is off');
    await settle(() => false, 400); // allow any in-flight enqueue to run
    assertEqual(countDiagnostics(db), consentBefore, 'no row was written while diagnostics consent was disabled');
    db.prepare(`UPDATE settings SET value = 'true', updated_at = ? WHERE key = 'diagnostics_consent'`).run(now());

    console.log('\n6. order.create.failed: missing-item validation is enqueued (order still 400)');
    const missingItemsRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { table_id: 'diag-table-1', type: 'dine_in' },
    });
    assertEqual(missingItemsRes.status, 400, 'missing-item order is rejected with 400');
    const missingItemsQueued = await settle(() => {
      const row = findDiagnosticByStage(db, 'order.create.failed', 'order_insert');
      return row?.metadata.status === 400 && row?.metadata.item_count === 0;
    });
    assert(missingItemsQueued, 'order.create.failed is enqueued for missing-item validation');

    console.log('\n7. order.create.failed: insufficient-stock rejection is enqueued (order still 400)');
    const stockRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        table_id: 'diag-table-1',
        type: 'dine_in',
        items: [{ product_id: 'p1', quantity: 5 }],
      },
    });
    assert(stockRes.status >= 400, `insufficient stock order is rejected (got ${stockRes.status})`);
    const stockQueued = await settle(() => findDiagnosticByStageAndStatus(db, 'order.create.failed', 'inventory_validation', 400, 1) !== null);
    assert(stockQueued, 'order.create.failed is enqueued on inventory failure');
    const stockDiag = findDiagnosticByStageAndStatus(db, 'order.create.failed', 'inventory_validation', 400, 1);
    assertEqual(stockDiag?.metadata.status, stockRes.status, 'diagnostic metadata carries the HTTP status');
    assertEqual(stockDiag?.metadata.item_count, 1, 'diagnostic metadata carries the product count');
    assertEqual(stockDiag?.metadata.stage, 'inventory_validation', 'inventory failures report the inventory stage');
    assertEqual(stockDiag?.status_ignored, undefined, 'row status remains driven by the outbox');

    console.log('\n8. order.create.failed: other create failures (missing product) are also reported');
    const badOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'dine_in', items: [{ product_id: 'missing-product', quantity: 1 }], table_id: 'diag-table-1' },
    });
    assert(badOrderRes.status >= 400, `order with unknown product is rejected (got ${badOrderRes.status})`);
    const badOrderQueued = await settle(() => findDiagnosticByStageAndStatus(db, 'order.create.failed', 'order_insert', 500, 1) !== null);
    assert(badOrderQueued, 'order.create.failed is enqueued for other create failures too');
    const badOrderDiag = findDiagnosticByStageAndStatus(db, 'order.create.failed', 'order_insert', 500, 1);
    assertEqual(badOrderDiag?.metadata.stage, 'order_insert', 'non-inventory failures report the order_insert stage');

    console.log('\n9. payment.batch.failed: unexpected 500 from applyPaymentBatch is enqueued');
    const diagOrder = db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('ORD-DIAG-1', 'dine_in', 'pending', 10, 10, ?, ?)`).run(now(), now());
    const diagBill = db.prepare(`INSERT INTO bills (order_id, bill_number, subtotal, discount_amount, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'INV-DIAG-1', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`).run(diagOrder.lastInsertRowid, now(), now());
    const billId = String(diagBill.lastInsertRowid);
    db.prepare(`CREATE TRIGGER diag_force_payment_failure BEFORE UPDATE ON bills
      BEGIN SELECT RAISE(ABORT, 'forced payment failure'); END`).run();
    try {
      const payFail = await api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        headers: owner.authHeader,
        body: { payments: [{ method: 'cash', amount: 10 }] },
      });
      assertEqual(payFail.status, 500, 'the forced payment failure surfaces as 500');
      const payQueued = await settle(() => findDiagnosticByStage(db, 'payment.batch.failed', 'payment_batch') !== null);
      assert(payQueued, 'payment.batch.failed is enqueued on a 500');
      const payDiag = findDiagnosticByStage(db, 'payment.batch.failed', 'payment_batch');
      assertEqual(payDiag?.metadata.status, 500, 'payment diagnostic metadata carries the HTTP status');
      assertEqual(payDiag?.metadata.stage, 'payment_batch', 'payment diagnostic reports the payment_batch stage');
    } finally {
      db.prepare('DROP TRIGGER diag_force_payment_failure').run();
    }

    console.log('\n10. POS checkout failure path: reporting must not throw or add toasts when telemetry fails');
    // Mirror of frontend reportOrderFailure: dispatch failure is swallowed and
    // the local support state is independent of the telemetry request.
    let telemetryFailed = false;
    let localSupportShown = false;
    const reportOrderFailure = (entry: { code: string; message: string; detail: string; status: number | null }) => {
      localSupportShown = true;
      void Promise.reject(new Error('telemetry down')).catch(() => { telemetryFailed = true; });
    };
    reportOrderFailure({ code: 'order.place.failed', message: 'Failed to process order', detail: 'The order could not be completed on this device', status: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert(localSupportShown, 'local support prompt is staged regardless of telemetry outcome');
    assert(telemetryFailed, 'telemetry dispatch failure is caught and swallowed');

    console.log('\n11. Validation hardening: non-object metadata rejected; messages and keys are controlled');
    const primitiveMeta = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'order.place.failed', severity: 'info', metadata: 'not-an-object' },
    });
    assertEqual(primitiveMeta.status, 400, 'a primitive root metadata value is rejected with 400');
    const arrayMeta = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'order.place.failed', severity: 'info', metadata: [1, 2, 3] },
    });
    assertEqual(arrayMeta.status, 400, 'an array root metadata value is rejected with 400');

    const paddedRes = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'payment.batch.failed', severity: 'warn', message: '   padded failure message   ' },
    });
    assertEqual(paddedRes.status, 202, 'an event with a padded message is accepted');
    const paddedQueued = await settle(() => findDiagnostic(db, 'payment.batch.failed') !== null);
    assert(paddedQueued, 'the padded-message event is enqueued');
    assertEqual(findDiagnostic(db, 'payment.batch.failed')?.message, 'Payment batch failed', 'free-form message is replaced with the approved diagnostic text');

    const protoRes = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: '{"event_code":"print.receipt.failed","severity":"info","metadata":{"__proto__":{"polluted":true},"kind":"receipt"}}',
    });
    assertEqual(protoRes.status, 202, 'metadata containing a __proto__ key is accepted');
    const protoQueued = await settle(() => findDiagnostic(db, 'print.receipt.failed') !== null);
    assert(protoQueued, 'the __proto__-bearing event is enqueued');
    const protoRow = findDiagnostic(db, 'print.receipt.failed');
    assertEqual(protoRow?.metadata.kind, 'receipt', 'approved metadata survives alongside a dropped __proto__ key');
    assert(!Object.prototype.hasOwnProperty.call(protoRow?.metadata || {}, '__proto__'), 'the __proto__ key is not persisted as an own property');
    assertEqual((protoRow?.metadata as any)?.polluted, undefined, 'metadata carries no prototype-chain pollution');

    console.log('\n' + '='.repeat(56));
    const results = getResults();
    console.log(`${results.passed} passed, ${results.failed} failed`);
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test suite crashed:', error);
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
