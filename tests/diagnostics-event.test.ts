/**
 * Diagnostics ingestion, safe frontend captures, and authoritative order failures.
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
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.12.22' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedProduct, seedTable, seedCategory, seedCustomer,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
  const { registerRoutes } = require('../main/routes/index');
const { cloudSync } = require('../main/services/cloud-sync');

function latestLocalDiagnostic(db: any, reasonCode: string): any | null {
  const row = db.prepare('SELECT * FROM local_diagnostics WHERE event_code = ? ORDER BY id DESC LIMIT 1').get(reasonCode) as any;
  if (!row) return null;
  let metadata = {};
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch { /* malformed rows are not test evidence */ }
  return { ...row, metadata };
}

function countLocalDiagnostics(db: any): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number }).count;
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
  const setSetting = (key: string, value: string) => db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
  setSetting('diagnostics_consent', 'false');
  setSetting('diagnostics_transmission_enabled', 'false');
  setSetting('telemetry_enabled', 'false');
  setSetting('cloud_sync_enabled', '0');
  setSetting('cloud_api_key', '');

  const app = createApp({});
  registerRoutes(app);
  app.get('/api/test-unhandled-diagnostic', (_req: any, res: any) => res.status(500).json({ error: 'synthetic failure' }));
  const { baseUrl, server } = await startServer(app);
  const settle = async (predicate: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  };

  try {
    console.log('\n1. Legacy event ingestion keeps derived evidence local');
    const beforeLocal = (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number }).count;
    const eventResponse = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST', headers: owner.authHeader,
      body: {
        event_code: 'order.place.failed', severity: 'error',
        message: 'UNIQUE constraint failed: orders.customer_id for customer Synthetic Person',
        metadata: { stage: 'order_place', detail: 'sensitive order detail' },
      },
    });
    assertEqual(eventResponse.status, 202, 'a supported legacy event is accepted');
    assert(await settle(() => (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number }).count > beforeLocal), 'the event is available in the local diagnostics log');
    assertEqual((db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as { count: number }).count, 0, 'legacy free-form events never enter the automatic outbox');
    const eventRow = latestLocalDiagnostic(db, 'order.place.failed');
    assertEqual(eventRow?.metadata?.stage, 'order_place', 'event-specific safe metadata survives local projection');
    assertEqual(eventRow?.metadata?.detail, undefined, 'unapproved free-form metadata is removed');

    console.log('\n1b. Event authentication, schema, severity, code, and metadata bounds remain enforced');
    const beforeRejected = countLocalDiagnostics(db);
    const unauthenticated = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST', body: { event_code: 'order.place.failed', severity: 'error' },
    });
    assertEqual(unauthenticated.status, 401, 'unauthenticated event writes are rejected');
    const malformed = await fetch(`${baseUrl}/api/diagnostics/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...owner.authHeader }, body: '{not json',
    });
    assertEqual(malformed.status, 400, 'malformed JSON is rejected');
    const invalidEvents = [
      {},
      { event_code: 'order.place.failed' },
      { event_code: 'order.place.failed', severity: 'fatal' },
      { event_code: 'Order Place Failed!', severity: 'error' },
      { event_code: 'order.place.unapproved', severity: 'error' },
      { event_code: 'order.place.failed', severity: 'error', metadata: 'not-an-object' },
      { event_code: 'order.place.failed', severity: 'error', metadata: [1, 2, 3] },
    ];
    for (const invalid of invalidEvents) {
      const invalidResponse = await api(baseUrl, '/api/diagnostics/event', {
        method: 'POST', headers: owner.authHeader, body: invalid,
      });
      assertEqual(invalidResponse.status, 400, 'malformed event contract is rejected');
    }
    const hugeMetadata: Record<string, string> = {};
    for (let i = 0; i < 40; i++) hugeMetadata[`key_${i}`] = 'X'.repeat(300);
    const oversized = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST', headers: owner.authHeader,
      body: { event_code: 'payment.batch.failed', severity: 'error', metadata: hugeMetadata },
    });
    assertEqual(oversized.status, 400, 'metadata beyond the byte cap is rejected');
    assertEqual(countLocalDiagnostics(db), beforeRejected, 'rejected event payloads do not create local rows');

    const nestedMetadata = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST', headers: owner.authHeader,
      body: { event_code: 'server.internal_error', severity: 'error', metadata: {
        route: '/api/orders', method: 'POST', status: 503, keep: 'unapproved', a: { b: { c: { d: 'trimmed' } } },
      } },
    });
    assertEqual(nestedMetadata.status, 202, 'deep metadata is trimmed to its safe event-specific projection');
    assert(await settle(() => latestLocalDiagnostic(db, 'server.internal_error') !== null), 'projected metadata is available locally');
    const projected = latestLocalDiagnostic(db, 'server.internal_error')?.metadata;
    assertEqual(projected?.route, '/api/orders', 'the allowlisted route field survives');
    assertEqual(projected?.method, 'POST', 'the allowlisted method field survives');
    assertEqual(projected?.status, 503, 'the allowlisted status field survives');
    assertEqual(projected?.keep, undefined, 'unapproved metadata is removed');
    assertEqual(projected?.a, undefined, 'nested unapproved metadata is removed');

    const prototypeMetadata = await fetch(`${baseUrl}/api/diagnostics/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...owner.authHeader },
      body: '{"event_code":"print.receipt.failed","severity":"info","metadata":{"__proto__":{"polluted":true},"kind":"receipt"}}',
    });
    assertEqual(prototypeMetadata.status, 202, 'prototype-shaped metadata does not break valid event capture');
    assert(await settle(() => latestLocalDiagnostic(db, 'print.receipt.failed') !== null), 'prototype-shaped metadata is processed');
    const prototypeRow = latestLocalDiagnostic(db, 'print.receipt.failed');
    assertEqual(prototypeRow?.metadata?.kind, 'receipt', 'safe print metadata remains');
    assertEqual(Object.prototype.hasOwnProperty.call(prototypeRow?.metadata || {}, '__proto__'), false, 'the prototype key is not persisted');

    console.log('\n2. The frontend capture boundary accepts only its closed safe contract');
    const operationId = crypto.randomUUID();
    const response = await api(baseUrl, '/api/diagnostics/capture', {
      method: 'POST', headers: owner.authHeader,
      body: {
        capture_point: 'fc.frontend.pos.order.create.transport', operation_id: operationId,
        outcome: 'unknown', facts: { failure_class: 'offline' },
      },
    });
    const body = response.data;
    assertEqual(response.status, 202, 'a registered frontend transport failure is accepted');
    assertEqual(body.reason_code, 'request.transport_failed', 'the response gives a stable reason code');
    assertEqual(body.operation, 'order.create', 'the operation comes from the server registry');
    assertEqual(body.stage, 'submission', 'the stage comes from the server registry');
    assertEqual(body.classification, 'unexpected_failure', 'the response includes the closed failure class');
    assertEqual(body.outcome, 'unknown', 'the supplied allowlisted outcome is echoed');
    assertEqual(body.correlation_id, operationId, 'the caller operation UUID is retained for recovery');

    const invalidRequests = [
      { capture_point: 'fc.frontend.pos.order.create.transport', operation_id: 'bad-id', outcome: 'unknown', facts: { failure_class: 'offline' } },
      { capture_point: 'fc.backend.order.create.stock_validation', operation_id: crypto.randomUUID(), outcome: 'not_applied' },
      { capture_point: 'fc.frontend.pos.order.create.transport', operation_id: crypto.randomUUID(), outcome: 'applied', facts: { failure_class: 'offline' } },
      { capture_point: 'fc.frontend.pos.order.create.transport', operation_id: crypto.randomUUID(), outcome: 'unknown', facts: { failure_class: 'offline', customer_name: 'Synthetic Person' } },
      { capture_point: 'fc.frontend.pos.order.create.transport', operation_id: crypto.randomUUID(), outcome: 'unknown', facts: { failure_class: 'raw exception text' } },
      { capture_point: 'fc.frontend.pos.order.create.transport', operation_id: crypto.randomUUID(), outcome: 'unknown', extra: 'rejected' },
    ];
    for (const invalid of invalidRequests) {
      const invalidResponse = await api(baseUrl, '/api/diagnostics/capture', {
        method: 'POST', headers: owner.authHeader, body: invalid,
      });
      assertEqual(invalidResponse.status, 400, 'an invalid UUID, point, outcome, fact, or extra field is rejected');
    }
    assertEqual((db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as { count: number }).count, 0, 'capture remains local while both delivery gates are off');

    console.log('\n3. Health returns typed delivery state without failure text');
    const healthResponse = await api(baseUrl, '/api/diagnostics/health', { headers: owner.authHeader });
    const health = healthResponse.data;
    assertEqual(healthResponse.status, 200, 'support staff can read diagnostics health');
    assertEqual(typeof health.effective_consent, 'boolean', 'consent is an explicit boolean');
    assertEqual(typeof health.transmission_enabled, 'boolean', 'the local transmission gate is separate');
    assertEqual(health.transport, 'disabled', 'transport reflects both delivery gates');
    assertEqual(typeof health.pending_reports, 'number', 'health contains a safe pending count');
    assertEqual(health.last_error, undefined, 'health never exposes local error text');

    const genericFailure = await api(baseUrl, '/api/test-unhandled-diagnostic', { headers: owner.authHeader });
    assertEqual(genericFailure.status, 500, 'an unexpected route failure keeps its HTTP response');
    assert(await settle(() => latestLocalDiagnostic(db, 'server.unhandled_error') !== null), 'the central API boundary captures caught route failures');
    const genericRow = latestLocalDiagnostic(db, 'server.unhandled_error');
    assertEqual(genericRow?.metadata?.operation, 'api.request', 'the central fallback uses a safe generic operation');
    assertEqual(genericRow?.metadata?.stage, 'handling', 'the central fallback uses the server-owned stage');
    assertEqual(genericRow?.metadata?.outcome, 'unknown', 'the central fallback does not infer whether a mutation committed');
    assertEqual(JSON.stringify(genericRow?.metadata).includes('/api/test-unhandled-diagnostic'), false, 'the request path is never included in the fallback payload');
    const originalCapture = cloudSync.captureOperationFailure;
    cloudSync.captureOperationFailure = () => { throw new Error('capture unavailable'); };
    const captureFailureResponse = await api(baseUrl, '/api/test-unhandled-diagnostic', { headers: owner.authHeader });
    cloudSync.captureOperationFailure = originalCapture;
    assertEqual(captureFailureResponse.status, 500, 'a diagnostics failure cannot interrupt an already completed API response');

    console.log('\n4. Order quantity and stock rejection produce distinct backend-authoritative reasons');
    const quantityId = crypto.randomUUID();
    const quantityResponse = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: { ...owner.authHeader, 'x-operation-id': quantityId },
      body: { table_id: 'diag-table-1', type: 'dine_in', items: [{ product_id: 'p2', quantity: 0 }] },
    });
    const quantityBody = quantityResponse.data;
    assertEqual(quantityResponse.status, 400, 'invalid quantity remains a client validation error');
    assertEqual(quantityBody.reason_code, 'order.quantity_invalid', 'quantity failures have their own stable reason');
    assertEqual(quantityBody.operation, 'order.create', 'quantity failure names order creation');
    assertEqual(quantityBody.stage, 'validation', 'quantity failure names validation');
    assertEqual(quantityBody.classification, 'expected_rejection', 'quantity failure is an expected rejection');
    assertEqual(quantityBody.outcome, 'not_applied', 'the rejected order was not applied');
    assertEqual(quantityBody.correlation_id, quantityId, 'the route echoes the action UUID');
    assert(await settle(() => latestLocalDiagnostic(db, 'order.quantity_invalid') !== null), 'the quantity reason is recorded locally');

    const stockId = crypto.randomUUID();
    const stockResponse = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: { ...owner.authHeader, 'x-operation-id': stockId },
      body: { table_id: 'diag-table-1', type: 'dine_in', items: [{ product_id: 'p1', quantity: 5 }] },
    });
    const stockBody = stockResponse.data;
    assertEqual(stockResponse.status, 400, 'insufficient stock remains a client validation error');
    assertEqual(stockBody.reason_code, 'order.stock_insufficient', 'stock failures have their own stable reason');
    assertEqual(stockBody.classification, 'expected_rejection', 'stock failure is an expected rejection');
    assertEqual(stockBody.outcome, 'not_applied', 'the rejected order was not applied');
    assertEqual(stockBody.correlation_id, stockId, 'stock validation preserves the same action UUID');
    assert(await settle(() => latestLocalDiagnostic(db, 'order.stock_insufficient') !== null), 'the stock reason is recorded locally');

    const missingBillOperationId = crypto.randomUUID();
    const missingBillResponse = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', headers: { ...owner.authHeader, 'x-operation-id': missingBillOperationId },
      body: { order_id: 999999999 },
    });
    assertEqual(missingBillResponse.status, 404, 'bill generation preserves the missing-order response');
    assertEqual(missingBillResponse.data.reason_code, 'bill.order_unavailable', 'missing-order bill rejection has its own stable reason');
    assertEqual(missingBillResponse.data.operation, 'bill.generate', 'missing-order rejection names bill generation');
    assertEqual(missingBillResponse.data.stage, 'validation', 'missing-order rejection names validation');
    assertEqual(missingBillResponse.data.classification, 'expected_rejection', 'missing-order rejection is expected');
    assertEqual(missingBillResponse.data.outcome, 'not_applied', 'an unavailable order cannot produce a bill');
    assertEqual(missingBillResponse.data.correlation_id, missingBillOperationId, 'bill rejection preserves the action UUID');
    assert(await settle(() => latestLocalDiagnostic(db, 'bill.order_unavailable') !== null), 'the unavailable-order reason is recorded locally');

    console.log('\n4b. Payment validation, rollback, and post-commit outcomes follow persisted state');
    const paymentOrderId = db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('DIAG-PAYMENT-ROLLBACK', 'takeaway', 'pending', 10, 10, ?, ?)`).run(now(), now()).lastInsertRowid;
    const rollbackBillId = db.prepare(`INSERT INTO bills (order_id, bill_number, subtotal, discount_amount, tax_amount, total,
      paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'DIAG-PAYMENT-ROLLBACK', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`).run(paymentOrderId, now(), now()).lastInsertRowid;
    db.prepare(`CREATE TRIGGER diagnostics_force_payment_rollback BEFORE UPDATE ON bills
      WHEN OLD.id = ${Number(rollbackBillId)} BEGIN SELECT RAISE(ABORT, 'private database error details'); END`).run();
    const rollbackId = crypto.randomUUID();
    const rollbackResponse = await api(baseUrl, `/api/bills/${rollbackBillId}/payments`, {
      method: 'POST', headers: { ...owner.authHeader, 'x-operation-id': rollbackId },
      body: { payments: [{ method: 'cash', amount: 10 }] },
    });
    db.prepare('DROP TRIGGER diagnostics_force_payment_rollback').run();
    assertEqual(rollbackResponse.status, 500, 'a database failure remains a server error');
    assertEqual(rollbackResponse.data.reason_code, 'persistence.failed', 'payment database failures use the persistence reason');
    assertEqual(rollbackResponse.data.operation, 'payment.create', 'the failed operation is payment creation');
    assertEqual(rollbackResponse.data.stage, 'persistence', 'the failure stage is persistence');
    assertEqual(rollbackResponse.data.outcome, 'not_applied', 'the transaction rollback proves the payment was not applied');
    assertEqual(rollbackResponse.data.correlation_id, rollbackId, 'the operation UUID is echoed');
    const rollbackBill = db.prepare('SELECT paid_amount, payment_details FROM bills WHERE id = ?').get(rollbackBillId) as { paid_amount: number; payment_details: string | null };
    assertEqual(rollbackBill.paid_amount, 0, 'the bill remains unpaid after rollback');
    assertEqual(rollbackBill.payment_details, null, 'no partial payment detail remains after rollback');
    assert(await settle(() => latestLocalDiagnostic(db, 'persistence.failed') !== null), 'the failed payment is captured in the local diagnostics row');

    seedCustomer(db, 'diag-customer-a', 'Synthetic Customer A');
    seedCustomer(db, 'diag-customer-b', 'Synthetic Customer B');
    const mismatchOrderId = db.prepare(`INSERT INTO orders (order_number, customer_id, type, status, subtotal, total, created_at, updated_at)
      VALUES ('DIAG-PAYMENT-MISMATCH', 'diag-customer-a', 'takeaway', 'pending', 10, 10, ?, ?)`).run(now(), now()).lastInsertRowid;
    const mismatchBillId = db.prepare(`INSERT INTO bills (order_id, bill_number, customer_id, subtotal, discount_amount, tax_amount, total,
      paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'DIAG-PAYMENT-MISMATCH', 'diag-customer-a', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`).run(mismatchOrderId, now(), now()).lastInsertRowid;
    const mismatchResponse = await api(baseUrl, `/api/bills/${mismatchBillId}/payments`, {
      method: 'POST', headers: owner.authHeader,
      body: { customer_id: 'diag-customer-b', payments: [{ method: 'cash', amount: 10 }] },
    });
    assertEqual(mismatchResponse.status, 400, 'a customer mismatch remains a validation rejection');
    assertEqual(mismatchResponse.data.reason_code, 'payment.invalid', 'payment validation has a distinct reason from order quantity or stock');
    assertEqual(mismatchResponse.data.classification, 'expected_rejection', 'payment validation is an expected rejection');
    assertEqual(mismatchResponse.data.outcome, 'not_applied', 'the mismatched payment was not applied');
    assertEqual((db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(mismatchBillId) as { paid_amount: number }).paid_amount, 0, 'the mismatched bill remains unpaid');
    assert(await settle(() => latestLocalDiagnostic(db, 'payment.invalid') !== null), 'payment validation is retained as a local typed reason');

    const completionOrderId = db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('DIAG-PAYMENT-COMPLETION', 'takeaway', 'pending', 10, 10, ?, ?)`).run(now(), now()).lastInsertRowid;
    const completionBillId = db.prepare(`INSERT INTO bills (order_id, bill_number, subtotal, discount_amount, tax_amount, total,
      paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'DIAG-PAYMENT-COMPLETION', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`).run(completionOrderId, now(), now()).lastInsertRowid;
    const kds = require('../main/services/kds');
    const priorNotifyOrderUpdated = kds.notifyOrderUpdated;
    kds.notifyOrderUpdated = () => { throw new Error('private notification failure'); };
    try {
      const completionResponse = await api(baseUrl, `/api/bills/${completionBillId}/payments`, {
        method: 'POST', headers: { ...owner.authHeader, 'x-operation-id': crypto.randomUUID() },
        body: { payments: [{ method: 'cash', amount: 5 }] },
      });
      assertEqual(completionResponse.status, 500, 'a post-commit notification error is surfaced');
      assertEqual(completionResponse.data.reason_code, 'operation.completion_failed', 'post-commit errors have a completion reason');
      assertEqual(completionResponse.data.stage, 'completion', 'the response distinguishes completion from persistence');
      assertEqual(completionResponse.data.outcome, 'applied', 'the response reports the proven committed payment');
      assertEqual((db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(completionBillId) as { paid_amount: number }).paid_amount, 5, 'the committed payment remains persisted');
      assert(await settle(() => latestLocalDiagnostic(db, 'operation.completion_failed') !== null), 'post-commit completion failure is captured locally');
    } finally {
      kds.notifyOrderUpdated = priorNotifyOrderUpdated;
    }

    console.log('\n5. No raw request or exception contents enter the v2 queue');
    const automaticRows = JSON.stringify({
      outbox: db.prepare('SELECT payload FROM store_diagnostics_outbox').all(),
      aggregates: db.prepare('SELECT facts_json FROM diagnostics_hourly_aggregates').all(),
    });
    assert(!automaticRows.includes('Synthetic Person'), 'customer text is absent from every automatic diagnostic payload');
    assert(!automaticRows.includes('Synthetic Customer A'), 'payment customer data is absent from automatic diagnostics');
    assert(!automaticRows.includes('sensitive order detail'), 'unapproved event metadata is absent from automatic diagnostics');
    assertEqual((db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as { count: number }).count, 0, 'no raw diagnostic payload was queued');

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
