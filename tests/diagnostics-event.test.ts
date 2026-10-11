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
const bcrypt = require('bcryptjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostics-event-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.12.22' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedProduct,
  seedTable,
  seedCategory,
  seedCustomer,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { classifyOrderRequestFailure } = require('../frontend/src/lib/order-attempt');
const { buildDiagnosticEvent } = require('../main/routes/diagnostics');
const { registerRoutes } = require('../main/routes/index');
const { cloudSync } = require('../main/services/cloud-sync');

function latestLocalDiagnostic(db: any, reasonCode: string): any | null {
  const row = db
    .prepare('SELECT * FROM local_diagnostics WHERE event_code = ? ORDER BY id DESC LIMIT 1')
    .get(reasonCode) as any;
  if (!row) return null;
  let metadata = {};
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    /* malformed rows are not test evidence */
  }
  return { ...row, metadata };
}

function countLocalDiagnostics(db: any): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number })
    .count;
}

function countMetadataEntries(value: any): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + 1 + countMetadataEntries(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((count, item) => count + 1 + countMetadataEntries(item), 0);
  }
  return 0;
}

function createPaymentBill(
  db: any,
  label: string,
  options: { total?: number; paidAmount?: number; status?: string; customerId?: string } = {},
): number {
  const total = options.total ?? 10;
  const orderId = db
    .prepare(`INSERT INTO orders (order_number, customer_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, ?, 'takeaway', 'pending', ?, ?, ?, ?)`)
    .run(label, options.customerId ?? null, total, total, now(), now()).lastInsertRowid;
  return Number(
    db
      .prepare(`INSERT INTO bills (order_id, bill_number, customer_id, subtotal, discount_amount, tax_amount, total,
    paid_amount, balance, payment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`)
      .run(
        orderId,
        label,
        options.customerId ?? null,
        total,
        total,
        options.paidAmount ?? 0,
        total - (options.paidAmount ?? 0),
        options.status ?? 'unpaid',
        now(),
        now(),
      ).lastInsertRowid,
  );
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
  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  setSetting('diagnostics_consent', 'false');
  setSetting('diagnostics_transmission_enabled', 'false');
  setSetting('telemetry_enabled', 'false');
  setSetting('cloud_sync_enabled', '0');
  setSetting('cloud_api_key', '');

  const app = createApp({});
  registerRoutes(app);
  app.get('/api/test-unhandled-diagnostic', (_req: any, res: any) =>
    res.status(500).json({ error: 'synthetic failure' }),
  );
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
    const beforeLocal = (
      db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number }
    ).count;
    const eventResponse = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        event_code: 'order.place.failed',
        severity: 'error',
        message: 'UNIQUE constraint failed: orders.customer_id for customer Synthetic Person',
        metadata: { stage: 'order_place', detail: 'sensitive order detail' },
      },
    });
    assertEqual(eventResponse.status, 202, 'a supported legacy event is accepted');
    assert(
      await settle(
        () =>
          (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number })
            .count > beforeLocal,
      ),
      'the event is available in the local diagnostics log',
    );
    assertEqual(
      (
        db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as {
          count: number;
        }
      ).count,
      0,
      'legacy free-form events never enter the automatic outbox',
    );
    const eventRow = latestLocalDiagnostic(db, 'order.place.failed');
    assertEqual(
      eventRow?.metadata?.stage,
      'order_place',
      'event-specific safe metadata survives local projection',
    );
    assertEqual(eventRow?.metadata?.detail, undefined, 'unapproved free-form metadata is removed');

    console.log(
      '\n1b. Event authentication, schema, severity, code, and metadata bounds remain enforced',
    );
    const beforeRejected = countLocalDiagnostics(db);
    const unauthenticated = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      body: { event_code: 'order.place.failed', severity: 'error' },
    });
    assertEqual(unauthenticated.status, 401, 'unauthenticated event writes are rejected');
    const malformed = await fetch(`${baseUrl}/api/diagnostics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...owner.authHeader },
      body: '{not json',
    });
    assertEqual(malformed.status, 400, 'malformed JSON is rejected');
    const invalidEvents = [
      {},
      { event_code: 'order.place.failed' },
      { event_code: 'order.place.failed', severity: 'fatal' },
      { event_code: 'order.place.failed'.padEnd(100_000, 'x'), severity: 'error' },
      { event_code: 'Order Place Failed!', severity: 'error' },
      { event_code: 'order.place.unapproved', severity: 'error' },
      { event_code: 'order.place.failed', severity: 'error'.repeat(100_000) },
      { event_code: 'order.place.failed', severity: 'error', metadata: 'not-an-object' },
      { event_code: 'order.place.failed', severity: 'error', metadata: [1, 2, 3] },
    ];
    for (const invalid of invalidEvents) {
      const invalidResponse = await api(baseUrl, '/api/diagnostics/event', {
        method: 'POST',
        headers: owner.authHeader,
        body: invalid,
      });
      assertEqual(invalidResponse.status, 400, 'malformed event contract is rejected');
    }
    const boundedStringFields = buildDiagnosticEvent({
      event_code: 'server.internal_error',
      severity: 'error',
      correlation_id: 'c'.repeat(100_000),
      message: 'm'.repeat(100_000),
    });
    assertEqual(
      boundedStringFields?.correlation_id?.length,
      64,
      'long correlation identifiers are capped before normalization',
    );
    assertEqual(
      boundedStringFields?.message?.length,
      300,
      'long diagnostic messages are capped before normalization',
    );
    const hugeMetadata: Record<string, string> = {};
    for (let i = 0; i < 40; i++) hugeMetadata[`key_${i}`] = 'X'.repeat(300);
    const oversized = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: { event_code: 'payment.batch.failed', severity: 'error', metadata: hugeMetadata },
    });
    assertEqual(oversized.status, 400, 'metadata beyond the byte cap is rejected');
    assertEqual(
      countLocalDiagnostics(db),
      beforeRejected,
      'rejected event payloads do not create local rows',
    );
    const boundedArrayEvent = buildDiagnosticEvent({
      event_code: 'server.internal_error',
      severity: 'error',
      metadata: { items: Array.from({ length: 100_000 }, (_, index) => index) },
    });
    assertEqual(
      countMetadataEntries(boundedArrayEvent?.metadata),
      40,
      'metadata array contents share the cumulative entry budget',
    );
    const boundedNestedEvent = buildDiagnosticEvent({
      event_code: 'server.internal_error',
      severity: 'error',
      metadata: Object.fromEntries(
        Array.from({ length: 10 }, (_, group) => [
          `group_${group}`,
          Array.from({ length: 10 }, () =>
            Object.fromEntries(
              Array.from({ length: 10 }, (_, field) => [`field_${field}`, 'x'.repeat(40)]),
            ),
          ),
        ]),
      ),
    });
    assert(
      boundedNestedEvent,
      'nested fan-out metadata keeps a bounded event instead of rejecting after full traversal',
    );
    assertEqual(
      countMetadataEntries(boundedNestedEvent?.metadata),
      40,
      'arrays and objects share one cumulative metadata entry budget',
    );

    const nestedMetadata = await api(baseUrl, '/api/diagnostics/event', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        event_code: 'server.internal_error',
        severity: 'error',
        metadata: {
          route: '/api/orders',
          method: 'POST',
          status: 503,
          keep: 'unapproved',
          a: { b: { c: { d: 'trimmed' } } },
        },
      },
    });
    assertEqual(
      nestedMetadata.status,
      202,
      'deep metadata is trimmed to its safe event-specific projection',
    );
    assert(
      await settle(() => latestLocalDiagnostic(db, 'server.internal_error') !== null),
      'projected metadata is available locally',
    );
    const projected = latestLocalDiagnostic(db, 'server.internal_error')?.metadata;
    assertEqual(projected?.route, '/api/orders', 'the allowlisted route field survives');
    assertEqual(projected?.method, 'POST', 'the allowlisted method field survives');
    assertEqual(projected?.status, 503, 'the allowlisted status field survives');
    assertEqual(projected?.keep, undefined, 'unapproved metadata is removed');
    assertEqual(projected?.a, undefined, 'nested unapproved metadata is removed');

    const prototypeMetadata = await fetch(`${baseUrl}/api/diagnostics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...owner.authHeader },
      body: '{"event_code":"print.receipt.failed","severity":"info","metadata":{"__proto__":{"polluted":true},"kind":"receipt"}}',
    });
    assertEqual(
      prototypeMetadata.status,
      202,
      'prototype-shaped metadata does not break valid event capture',
    );
    assert(
      await settle(() => latestLocalDiagnostic(db, 'print.receipt.failed') !== null),
      'prototype-shaped metadata is processed',
    );
    const prototypeRow = latestLocalDiagnostic(db, 'print.receipt.failed');
    assertEqual(prototypeRow?.metadata?.kind, 'receipt', 'safe print metadata remains');
    assertEqual(
      Object.prototype.hasOwnProperty.call(prototypeRow?.metadata || {}, '__proto__'),
      false,
      'the prototype key is not persisted',
    );

    console.log('\n2. The frontend capture boundary accepts only its closed safe contract');
    const operationId = crypto.randomUUID();
    const response = await api(baseUrl, '/api/diagnostics/capture', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: operationId,
        outcome: 'unknown',
        facts: { failure_class: 'offline' },
      },
    });
    const body = response.data;
    assertEqual(response.status, 202, 'a registered frontend transport failure is accepted');
    assertEqual(
      body.reason_code,
      'request.transport_failed',
      'the response gives a stable reason code',
    );
    assertEqual(body.operation, 'order.create', 'the operation comes from the server registry');
    assertEqual(body.stage, 'submission', 'the stage comes from the server registry');
    assertEqual(
      body.classification,
      'unexpected_failure',
      'the response includes the closed failure class',
    );
    assertEqual(body.outcome, 'unknown', 'the supplied allowlisted outcome is echoed');
    assertEqual(
      body.correlation_id,
      operationId,
      'the caller operation UUID is retained for recovery',
    );

    const retryStateOperationId = crypto.randomUUID();
    const retryStateResponse = await api(baseUrl, '/api/diagnostics/capture', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        capture_point: 'fc.client.order.create.retry_state_update',
        operation_id: retryStateOperationId,
        outcome: 'applied',
      },
    });
    assertEqual(
      retryStateResponse.status,
      202,
      'a confirmed order retry-state persistence failure is accepted',
    );
    assertEqual(
      retryStateResponse.data.reason_code,
      'order.retry_state_failed',
      'retry-state failure has its own stable reason',
    );
    assertEqual(
      retryStateResponse.data.outcome,
      'applied',
      'retry-state failure reports the confirmed order outcome',
    );
    assertEqual(
      retryStateResponse.data.correlation_id,
      retryStateOperationId,
      'retry-state capture preserves the order operation UUID',
    );

    const additionalFrontendCaptures = [
      {
        capture_point: 'fc.client.payment.create.retry_state_update',
        outcome: 'applied',
        reason_code: 'payment.retry_state_failed',
        operation: 'payment.create',
        stage: 'retry_state',
      },
      {
        capture_point: 'fc.frontend.pos.order.create.held_cleanup',
        outcome: 'applied',
        reason_code: 'order.held_state.cleanup_failed',
        operation: 'order.create',
        stage: 'cleanup',
      },
      {
        capture_point: 'fc.frontend.pos.payment.create.held_cleanup',
        outcome: 'applied',
        reason_code: 'order.held_state.cleanup_failed',
        operation: 'payment.create',
        stage: 'cleanup',
      },
      {
        capture_point: 'fc.frontend.pos.order.append.transport',
        outcome: 'unknown',
        reason_code: 'request.transport_failed',
        operation: 'order.append',
        stage: 'submission',
        facts: { failure_class: 'offline' },
      },
      {
        capture_point: 'fc.frontend.pos.order.append.recovery',
        outcome: 'unknown',
        reason_code: 'request.outcome_unknown',
        operation: 'order.append',
        stage: 'recovery',
      },
    ];
    for (const capture of additionalFrontendCaptures) {
      const operationId = crypto.randomUUID();
      const captureResponse = await api(baseUrl, '/api/diagnostics/capture', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          capture_point: capture.capture_point,
          operation_id: operationId,
          outcome: capture.outcome,
          ...(capture.facts ? { facts: capture.facts } : {}),
        },
      });
      assertEqual(
        captureResponse.status,
        202,
        `${capture.capture_point} is accepted as a client-owned occurrence`,
      );
      assertEqual(
        captureResponse.data.reason_code,
        capture.reason_code,
        `${capture.capture_point} has its registered reason`,
      );
      assertEqual(
        captureResponse.data.operation,
        capture.operation,
        `${capture.capture_point} has its registered operation`,
      );
      assertEqual(
        captureResponse.data.stage,
        capture.stage,
        `${capture.capture_point} has its registered stage`,
      );
      assertEqual(
        captureResponse.data.correlation_id,
        operationId,
        `${capture.capture_point} retains the operation UUID`,
      );
    }

    const invalidRequests = [
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: 'bad-id',
        outcome: 'unknown',
        facts: { failure_class: 'offline' },
      },
      {
        capture_point: 'fc.backend.order.create.stock_validation',
        operation_id: crypto.randomUUID(),
        outcome: 'not_applied',
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'applied',
        facts: { failure_class: 'offline' },
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        facts: { failure_class: 'offline', customer_name: 'Synthetic Person' },
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        facts: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`fact_${i}`, 'offline'])),
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        facts: { failure_class: 'offline'.repeat(100_000) },
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        facts: { ['x'.repeat(100_000)]: 'offline' },
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport'.padEnd(100_000, 'x'),
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: 'x'.repeat(100_000),
        outcome: 'unknown',
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown'.repeat(100_000),
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        ['x'.repeat(100_000)]: 'rejected',
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        facts: { failure_class: 'raw exception text' },
      },
      {
        capture_point: 'fc.frontend.pos.order.create.transport',
        operation_id: crypto.randomUUID(),
        outcome: 'unknown',
        extra: 'rejected',
      },
    ];
    for (const invalid of invalidRequests) {
      const invalidResponse = await api(baseUrl, '/api/diagnostics/capture', {
        method: 'POST',
        headers: owner.authHeader,
        body: invalid,
      });
      assertEqual(
        invalidResponse.status,
        400,
        'an invalid UUID, point, outcome, fact, or extra field is rejected',
      );
    }
    assertEqual(
      (
        db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as {
          count: number;
        }
      ).count,
      0,
      'capture remains local while both delivery gates are off',
    );

    console.log('\n3. Health returns typed delivery state without failure text');
    const healthResponse = await api(baseUrl, '/api/diagnostics/health', {
      headers: owner.authHeader,
    });
    const health = healthResponse.data;
    assertEqual(healthResponse.status, 200, 'support staff can read diagnostics health');
    assertEqual(typeof health.effective_consent, 'boolean', 'consent is an explicit boolean');
    assertEqual(
      typeof health.transmission_enabled,
      'boolean',
      'the local transmission gate is separate',
    );
    assertEqual(health.transport, 'disabled', 'transport reflects both delivery gates');
    assertEqual(typeof health.pending_reports, 'number', 'health contains a safe pending count');
    assertEqual(health.last_error, undefined, 'health never exposes local error text');

    const genericFailure = await api(baseUrl, '/api/test-unhandled-diagnostic', {
      headers: owner.authHeader,
    });
    assertEqual(genericFailure.status, 500, 'an unexpected route failure keeps its HTTP response');
    assert(
      await settle(() => latestLocalDiagnostic(db, 'server.unhandled_error') !== null),
      'the central API boundary captures caught route failures',
    );
    const genericRow = latestLocalDiagnostic(db, 'server.unhandled_error');
    assertEqual(
      genericRow?.metadata?.operation,
      'api.request',
      'the central fallback uses a safe generic operation',
    );
    assertEqual(
      genericRow?.metadata?.stage,
      'handling',
      'the central fallback uses the server-owned stage',
    );
    assertEqual(
      genericRow?.metadata?.outcome,
      'unknown',
      'the central fallback does not infer whether a mutation committed',
    );
    assertEqual(
      JSON.stringify(genericRow?.metadata).includes('/api/test-unhandled-diagnostic'),
      false,
      'the request path is never included in the fallback payload',
    );
    const originalCapture = cloudSync.captureOperationFailure;
    cloudSync.captureOperationFailure = () => {
      throw new Error('capture unavailable');
    };
    const captureFailureResponse = await api(baseUrl, '/api/test-unhandled-diagnostic', {
      headers: owner.authHeader,
    });
    cloudSync.captureOperationFailure = originalCapture;
    assertEqual(
      captureFailureResponse.status,
      500,
      'a diagnostics failure cannot interrupt an already completed API response',
    );

    console.log(
      '\n4. Order quantity and stock rejection produce distinct backend-authoritative reasons',
    );
    const quantityId = crypto.randomUUID();
    const quantityResponse = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { ...owner.authHeader, 'x-operation-id': quantityId },
      body: {
        table_id: 'diag-table-1',
        type: 'dine_in',
        items: [{ product_id: 'p2', quantity: 0 }],
      },
    });
    const quantityBody = quantityResponse.data;
    assertEqual(quantityResponse.status, 400, 'invalid quantity remains a client validation error');
    assertEqual(
      quantityBody.reason_code,
      'order.quantity_invalid',
      'quantity failures have their own stable reason',
    );
    assertEqual(quantityBody.operation, 'order.create', 'quantity failure names order creation');
    assertEqual(quantityBody.stage, 'validation', 'quantity failure names validation');
    assertEqual(
      quantityBody.classification,
      'expected_rejection',
      'quantity failure is an expected rejection',
    );
    assertEqual(quantityBody.outcome, 'not_applied', 'the rejected order was not applied');
    assertEqual(quantityBody.correlation_id, quantityId, 'the route echoes the action UUID');
    assert(
      await settle(() => latestLocalDiagnostic(db, 'order.quantity_invalid') !== null),
      'the quantity reason is recorded locally',
    );

    const throwingCapture = cloudSync.captureOperationFailure;
    cloudSync.captureOperationFailure = () => {
      throw new Error('local diagnostics unavailable');
    };
    try {
      const uncapturedQuantity = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          table_id: 'diag-table-1',
          type: 'dine_in',
          items: [{ product_id: 'p2', quantity: 0 }],
        },
      });
      assertEqual(
        uncapturedQuantity.status,
        400,
        'a failed diagnostics write cannot mask order validation',
      );
      assertEqual(
        uncapturedQuantity.data.reason_code,
        'order.quantity_invalid',
        'the original order rejection is returned when diagnostics fails',
      );
    } finally {
      cloudSync.captureOperationFailure = throwingCapture;
    }

    const stockId = crypto.randomUUID();
    const stockResponse = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { ...owner.authHeader, 'x-operation-id': stockId },
      body: {
        table_id: 'diag-table-1',
        type: 'dine_in',
        items: [{ product_id: 'p1', quantity: 5 }],
      },
    });
    const stockBody = stockResponse.data;
    assertEqual(stockResponse.status, 400, 'insufficient stock remains a client validation error');
    assertEqual(
      stockBody.reason_code,
      'order.stock_insufficient',
      'stock failures have their own stable reason',
    );
    assertEqual(
      stockBody.classification,
      'expected_rejection',
      'stock failure is an expected rejection',
    );
    assertEqual(stockBody.outcome, 'not_applied', 'the rejected order was not applied');
    assertEqual(
      stockBody.correlation_id,
      stockId,
      'stock validation preserves the same action UUID',
    );
    assert(
      await settle(() => latestLocalDiagnostic(db, 'order.stock_insufficient') !== null),
      'the stock reason is recorded locally',
    );

    const missingBillOperationId = crypto.randomUUID();
    const missingBillResponse = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: { ...owner.authHeader, 'x-operation-id': missingBillOperationId },
      body: { order_id: 999999999 },
    });
    assertEqual(
      missingBillResponse.status,
      404,
      'bill generation preserves the missing-order response',
    );
    assertEqual(
      missingBillResponse.data.reason_code,
      'bill.order_unavailable',
      'missing-order bill rejection has its own stable reason',
    );
    assertEqual(
      missingBillResponse.data.operation,
      'bill.generate',
      'missing-order rejection names bill generation',
    );
    assertEqual(
      missingBillResponse.data.stage,
      'validation',
      'missing-order rejection names validation',
    );
    assertEqual(
      missingBillResponse.data.classification,
      'expected_rejection',
      'missing-order rejection is expected',
    );
    assertEqual(
      missingBillResponse.data.outcome,
      'not_applied',
      'an unavailable order cannot produce a bill',
    );
    assertEqual(
      missingBillResponse.data.correlation_id,
      missingBillOperationId,
      'bill rejection preserves the action UUID',
    );
    assert(
      await settle(() => latestLocalDiagnostic(db, 'bill.order_unavailable') !== null),
      'the unavailable-order reason is recorded locally',
    );

    console.log('\n4a. Bill charge changes report distinct validation and persisted outcomes');
    setSetting(
      'custom_charges',
      JSON.stringify([
        {
          id: 'optional_fee',
          name: 'Optional fee',
          type: 'fixed',
          value: 1,
          calculation_basis: 'gross',
          order_types: ['takeaway'],
          is_optional: true,
          is_default_active: true,
          is_active: true,
        },
        {
          id: 'mandatory_fee',
          name: 'Mandatory fee',
          type: 'fixed',
          value: 1,
          calculation_basis: 'gross',
          order_types: ['takeaway'],
          is_optional: false,
          is_default_active: true,
          is_active: true,
        },
        {
          id: 'dine_in_fee',
          name: 'Dine-in fee',
          type: 'fixed',
          value: 1,
          calculation_basis: 'gross',
          order_types: ['dine_in'],
          is_optional: true,
          is_default_active: false,
          is_active: true,
        },
      ]),
    );
    const assertBillChargeValidation = async (
      billId: string | number,
      body: Record<string, unknown>,
      displayCode: string,
      status: number,
    ) => {
      const operationId = crypto.randomUUID();
      const beforeDiagnostics = countLocalDiagnostics(db);
      const response = await api(baseUrl, `/api/bills/${billId}/charges`, {
        method: 'PATCH',
        headers: { ...owner.authHeader, 'x-operation-id': operationId },
        body,
      });
      assertEqual(response.status, status, `${displayCode} preserves its existing HTTP status`);
      assertEqual(
        response.data.reason_code,
        'bill.charge_rejected',
        `${displayCode} has a stable charge reason`,
      );
      assertEqual(
        response.data.operation,
        'bill.charge.update',
        `${displayCode} identifies the charge operation`,
      );
      assertEqual(response.data.stage, 'validation', `${displayCode} identifies validation`);
      assertEqual(
        response.data.classification,
        'expected_rejection',
        `${displayCode} is an expected rejection`,
      );
      assertEqual(
        response.data.outcome,
        'not_applied',
        `${displayCode} confirms the charge change was not applied`,
      );
      assertEqual(
        response.data.display_code,
        displayCode,
        `${displayCode} is the branch-assigned safe display code`,
      );
      assertEqual(
        response.data.correlation_id,
        operationId,
        `${displayCode} preserves the action UUID`,
      );
      assert(
        await settle(() => countLocalDiagnostics(db) > beforeDiagnostics),
        `${displayCode} is captured locally`,
      );
      assertEqual(
        latestLocalDiagnostic(db, 'bill.charge_rejected')?.metadata?.display_code,
        displayCode,
        `${displayCode} stores only its safe enum fact`,
      );
    };
    const simpleChargeBill = createPaymentBill(db, 'DIAG-CHARGE-SIMPLE');
    await assertBillChargeValidation(simpleChargeBill, {}, 'charge_required', 400);
    await assertBillChargeValidation(
      999999999,
      { charge_id: 'optional_fee', waived: true },
      'bill_not_found',
      404,
    );
    await assertBillChargeValidation(
      simpleChargeBill,
      { charge_id: 'missing_fee', waived: true },
      'charge_unavailable',
      404,
    );
    await assertBillChargeValidation(
      simpleChargeBill,
      { charge_id: 'dine_in_fee', applied: true },
      'order_type_unsupported',
      409,
    );
    await assertBillChargeValidation(
      simpleChargeBill,
      { charge_id: 'optional_fee' },
      'change_required',
      400,
    );
    await assertBillChargeValidation(
      simpleChargeBill,
      { charge_id: 'optional_fee', waived: 'true' },
      'invalid_change_type',
      400,
    );
    await assertBillChargeValidation(
      simpleChargeBill,
      { charge_id: 'mandatory_fee', waived: true },
      'charge_not_waivable',
      400,
    );
    await assertBillChargeValidation(
      simpleChargeBill,
      { charge_id: 'mandatory_fee', applied: false },
      'charge_always_applied',
      400,
    );

    const splitChargeBill = createPaymentBill(db, 'DIAG-CHARGE-SPLIT');
    db.prepare('UPDATE bills SET split_group_id = ? WHERE id = ?').run(
      'diag-charge-split',
      splitChargeBill,
    );
    await assertBillChargeValidation(
      splitChargeBill,
      { charge_id: 'optional_fee', waived: true },
      'split_check',
      409,
    );
    const paidChargeBill = createPaymentBill(db, 'DIAG-CHARGE-PAID', {
      paidAmount: 1,
      status: 'partial',
    });
    await assertBillChargeValidation(
      paidChargeBill,
      { charge_id: 'optional_fee', waived: true },
      'bill_paid',
      409,
    );
    const refundedChargeBill = createPaymentBill(db, 'DIAG-CHARGE-REFUNDED', {
      status: 'refunded',
    });
    await assertBillChargeValidation(
      refundedChargeBill,
      { charge_id: 'optional_fee', waived: true },
      'bill_refunded',
      409,
    );
    const cancelledChargeBill = createPaymentBill(db, 'DIAG-CHARGE-CANCELLED');
    const cancelledOrderId = (
      db.prepare('SELECT order_id FROM bills WHERE id = ?').get(cancelledChargeBill) as {
        order_id: number;
      }
    ).order_id;
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(cancelledOrderId);
    await assertBillChargeValidation(
      cancelledChargeBill,
      { charge_id: 'optional_fee', waived: true },
      'order_cancelled',
      409,
    );
    const missingOrderChargeBill = createPaymentBill(db, 'DIAG-CHARGE-MISSING-ORDER');
    const missingOrderId = `missing-${missingOrderChargeBill}`;
    db.pragma('foreign_keys = OFF');
    db.prepare('UPDATE bills SET order_id = ? WHERE id = ?').run(
      missingOrderId,
      missingOrderChargeBill,
    );
    db.pragma('foreign_keys = ON');
    await assertBillChargeValidation(
      missingOrderChargeBill,
      { charge_id: 'optional_fee', waived: true },
      'order_not_found',
      404,
    );
    db.prepare('DELETE FROM bills WHERE id = ?').run(missingOrderChargeBill);

    const rollbackChargeBill = createPaymentBill(db, 'DIAG-CHARGE-ROLLBACK');
    const rollbackChargeOrderId = (
      db.prepare('SELECT order_id FROM bills WHERE id = ?').get(rollbackChargeBill) as {
        order_id: number;
      }
    ).order_id;
    db.prepare(`CREATE TRIGGER diagnostics_force_bill_charge_rollback BEFORE UPDATE ON orders
      WHEN OLD.id = ${Number(rollbackChargeOrderId)} BEGIN SELECT RAISE(ABORT, 'private charge failure details'); END`).run();
    const rollbackChargeResponse = await api(baseUrl, `/api/bills/${rollbackChargeBill}/charges`, {
      method: 'PATCH',
      headers: { ...owner.authHeader, 'x-operation-id': crypto.randomUUID() },
      body: { charge_id: 'optional_fee', waived: true },
    });
    db.prepare('DROP TRIGGER diagnostics_force_bill_charge_rollback').run();
    assertEqual(
      rollbackChargeResponse.status,
      500,
      'charge persistence failure remains a server error',
    );
    assertEqual(
      rollbackChargeResponse.data.reason_code,
      'persistence.failed',
      'rolled-back charge persistence has the persistence reason',
    );
    assertEqual(
      rollbackChargeResponse.data.operation,
      'bill.charge.update',
      'charge persistence failure identifies the charge operation',
    );
    assertEqual(
      rollbackChargeResponse.data.outcome,
      'not_applied',
      'the SQLite transaction rollback proves the charge change was not applied',
    );
    assertEqual(
      (
        db
          .prepare('SELECT charges_breakdown FROM orders WHERE id = ?')
          .get(rollbackChargeOrderId) as { charges_breakdown: string | null }
      ).charges_breakdown,
      null,
      'rollback leaves the order charge snapshot unchanged',
    );

    const completionChargeBill = createPaymentBill(db, 'DIAG-CHARGE-COMPLETION');
    const responsePrototype = (app as any).response;
    const originalJson = responsePrototype.json;
    let failChargeResponseOnce = true;
    responsePrototype.json = function (body: unknown) {
      if (failChargeResponseOnce) {
        failChargeResponseOnce = false;
        throw new Error('synthetic response completion failure');
      }
      return originalJson.call(this, body);
    };
    let completionChargeResponse: any;
    try {
      completionChargeResponse = await api(baseUrl, `/api/bills/${completionChargeBill}/charges`, {
        method: 'PATCH',
        headers: { ...owner.authHeader, 'x-operation-id': crypto.randomUUID() },
        body: { charge_id: 'optional_fee', waived: true },
      });
    } finally {
      responsePrototype.json = originalJson;
    }
    assertEqual(
      completionChargeResponse.status,
      500,
      'post-commit response failure remains visible',
    );
    assertEqual(
      completionChargeResponse.data.reason_code,
      'operation.completion_failed',
      'post-commit charge failure has a completion reason',
    );
    assertEqual(
      completionChargeResponse.data.operation,
      'bill.charge.update',
      'completion failure identifies the charge operation',
    );
    assertEqual(
      completionChargeResponse.data.outcome,
      'applied',
      'the completed transaction is reported as applied',
    );
    const completionChargeSnapshot = JSON.parse(
      (
        db.prepare('SELECT charges_breakdown FROM orders WHERE id = ?').get(
          (
            db.prepare('SELECT order_id FROM bills WHERE id = ?').get(completionChargeBill) as {
              order_id: number;
            }
          ).order_id,
        ) as { charges_breakdown: string }
      ).charges_breakdown,
    );
    assertEqual(
      completionChargeSnapshot.find((charge: any) => charge.id === 'optional_fee')?.waived,
      true,
      'the persisted charge change survives the post-commit response failure',
    );

    console.log('\n4aa. Refund failures preserve operation context and transaction outcomes');
    setSetting('require_open_shift', 'false');
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
      bcrypt.hashSync('1234', 10),
      owner.userId,
    );
    const assertRefundFailure = async (
      body: Record<string, unknown>,
      displayCode: string,
      status: number,
      headers: Record<string, string> = {},
    ) => {
      const operationId = crypto.randomUUID();
      const beforeDiagnostics = countLocalDiagnostics(db);
      const response = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: { ...owner.authHeader, 'x-operation-id': operationId, ...headers },
        body,
      });
      assertEqual(response.status, status, `${displayCode} preserves the refund HTTP status`);
      assertEqual(
        response.data.reason_code,
        'refund.rejected',
        `${displayCode} has a stable refund reason`,
      );
      assertEqual(
        response.data.operation,
        'payment.refund',
        `${displayCode} identifies refund processing`,
      );
      assertEqual(response.data.stage, 'validation', `${displayCode} identifies validation`);
      assertEqual(
        response.data.classification,
        'expected_rejection',
        `${displayCode} is an expected rejection`,
      );
      assertEqual(
        response.data.outcome,
        'not_applied',
        `${displayCode} proves no refund was committed`,
      );
      assertEqual(
        response.data.display_code,
        displayCode,
        `${displayCode} is assigned by the refund guard`,
      );
      assertEqual(
        response.data.correlation_id,
        operationId,
        `${displayCode} preserves the operation UUID`,
      );
      assert(
        await settle(() => countLocalDiagnostics(db) > beforeDiagnostics),
        `${displayCode} is retained locally`,
      );
      assertEqual(
        latestLocalDiagnostic(db, 'refund.rejected')?.metadata?.display_code,
        displayCode,
        `${displayCode} stores only its safe enum fact`,
      );
      return response;
    };
    await assertRefundFailure({}, 'bill_id_required', 400);
    await assertRefundFailure(
      { bill_id: 1, order_item_id: 'bad', amount: 1 },
      'order_item_id_invalid',
      400,
    );
    await assertRefundFailure({ bill_id: 1, amount: '1.234' }, 'amount_invalid', 400);
    await assertRefundFailure(
      { bill_id: 1, amount: 1, approver_id: owner.userId, reason: 'x'.repeat(501) },
      'reason_too_long',
      400,
    );
    const approverRequired = await assertRefundFailure(
      { bill_id: 1, amount: 1 },
      'approver_required',
      400,
    );
    assertEqual(
      approverRequired.data.code,
      'APPROVER_REQUIRED',
      'the existing approver error code remains intact',
    );
    const approverConflict = await assertRefundFailure(
      { bill_id: 1, amount: 1, approver_id: 'owner-a', manager_id: 'owner-b' },
      'approver_conflict',
      400,
    );
    assertEqual(
      approverConflict.data.code,
      'APPROVER_CONFLICT',
      'the existing approver conflict code remains intact',
    );
    await assertRefundFailure(
      { bill_id: 1, amount: 1, approver_id: owner.userId },
      'idempotency_key_invalid',
      400,
      { 'Idempotency-Key': 'x'.repeat(129) },
    );
    await assertRefundFailure(
      { bill_id: 999999998, amount: 1, method: 'card', approver_id: owner.userId },
      'bill_unavailable',
      404,
    );
    const missingOrderRefundBill = createPaymentBill(db, 'DIAG-REFUND-MISSING-ORDER');
    db.pragma('foreign_keys = OFF');
    db.prepare('UPDATE bills SET order_id = ? WHERE id = ?').run(
      `refund-order-${missingOrderRefundBill}`,
      missingOrderRefundBill,
    );
    db.pragma('foreign_keys = ON');
    await assertRefundFailure(
      { bill_id: missingOrderRefundBill, amount: 1, method: 'card', approver_id: owner.userId },
      'order_unavailable',
      404,
    );
    db.prepare('DELETE FROM bills WHERE id = ?').run(missingOrderRefundBill);

    console.log(
      '\n4ab. An unrelated cash-session database failure keeps its original refund response',
    );
    setSetting('require_open_shift', 'true');
    const cashGuardBill = createPaymentBill(db, 'DIAG-REFUND-CASH-GUARD');
    const originalPrepare = db.prepare;
    const injectedCashGuardError = Object.assign(
      new Error('synthetic cash-session lookup failure'),
      { statusCode: 409 },
    );
    const beforeCashGuardDiagnostics = countLocalDiagnostics(db);
    (db as any).prepare = (sql: string) => {
      if (sql === "SELECT * FROM cash_sessions WHERE status = 'open' LIMIT 1")
        throw injectedCashGuardError;
      return originalPrepare.call(db, sql);
    };
    let cashGuardResponse: any;
    try {
      cashGuardResponse = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: { ...owner.authHeader, 'x-operation-id': crypto.randomUUID() },
        body: {
          bill_id: cashGuardBill,
          amount: 1,
          method: 'cash',
          approver_id: owner.userId,
          override_pin: '1234',
        },
      });
    } finally {
      (db as any).prepare = originalPrepare;
    }
    assertEqual(cashGuardResponse.status, 409, 'the database error status is preserved');
    assertEqual(
      cashGuardResponse.data.error,
      'synthetic cash-session lookup failure',
      'the original database error response is preserved',
    );
    assertEqual(
      cashGuardResponse.data.reason_code,
      undefined,
      'the database error is not mislabeled as a cash-session validation',
    );
    assertEqual(
      countLocalDiagnostics(db),
      beforeCashGuardDiagnostics,
      'the database error creates no false expected-rejection diagnostic',
    );
    setSetting('require_open_shift', 'false');

    const idempotentRefundBill = createPaymentBill(db, 'DIAG-REFUND-IDEMPOTENCY', {
      paidAmount: 10,
      status: 'paid',
    });
    const idempotentRefundBody = {
      bill_id: idempotentRefundBill,
      amount: 2,
      method: 'cash',
      approver_id: owner.userId,
      override_pin: '1234',
    };
    const firstIdempotentRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      headers: { ...owner.authHeader, 'Idempotency-Key': 'diagnostics-refund-key' },
      body: idempotentRefundBody,
    });
    assertEqual(firstIdempotentRefund.status, 201, 'the first refund request commits');
    const refundReplayConflict = await assertRefundFailure(
      { ...idempotentRefundBody, amount: 3 },
      'idempotency_conflict',
      409,
      { 'Idempotency-Key': 'diagnostics-refund-key' },
    );
    assertEqual(
      refundReplayConflict.data.outcome,
      'not_applied',
      'a conflicting idempotency replay does not apply a second refund',
    );
    assertEqual(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM refunds WHERE bill_id = ?')
          .get(idempotentRefundBill) as { count: number }
      ).count,
      1,
      'the idempotency conflict leaves one refund row',
    );

    const rollbackRefundBill = createPaymentBill(db, 'DIAG-REFUND-ROLLBACK', {
      paidAmount: 10,
      status: 'paid',
    });
    db.prepare(`CREATE TRIGGER diagnostics_force_refund_rollback BEFORE INSERT ON refunds
      WHEN NEW.bill_id = ${rollbackRefundBill} BEGIN SELECT RAISE(ABORT, 'private refund failure details'); END`).run();
    const rollbackRefundId = crypto.randomUUID();
    const rollbackRefundResponse = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      headers: { ...owner.authHeader, 'x-operation-id': rollbackRefundId },
      body: {
        bill_id: rollbackRefundBill,
        amount: 2,
        method: 'cash',
        approver_id: owner.userId,
        override_pin: '1234',
      },
    });
    db.prepare('DROP TRIGGER diagnostics_force_refund_rollback').run();
    assertEqual(rollbackRefundResponse.status, 500, 'a database error remains a server response');
    assertEqual(
      rollbackRefundResponse.data.reason_code,
      'persistence.failed',
      'the rolled-back refund uses a persistence reason',
    );
    assertEqual(
      rollbackRefundResponse.data.stage,
      'persistence',
      'the failed refund identifies its persistence stage',
    );
    assertEqual(
      rollbackRefundResponse.data.outcome,
      'not_applied',
      'the transaction rollback proves no refund was committed',
    );
    assertEqual(
      rollbackRefundResponse.data.correlation_id,
      rollbackRefundId,
      'the refund persistence failure preserves its action UUID',
    );
    assertEqual(
      (
        db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(rollbackRefundBill) as {
          payment_status: string;
        }
      ).payment_status,
      'paid',
      'the bill remains paid after refund rollback',
    );
    assertEqual(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM refunds WHERE bill_id = ?')
          .get(rollbackRefundBill) as { count: number }
      ).count,
      0,
      'rollback leaves no refund row',
    );

    const completionRefundBill = createPaymentBill(db, 'DIAG-REFUND-COMPLETION', {
      paidAmount: 10,
      status: 'paid',
    });
    const refundResponsePrototype = (app as any).response;
    const originalRefundJson = refundResponsePrototype.json;
    let failRefundResponseOnce = true;
    refundResponsePrototype.json = function (body: unknown) {
      if (failRefundResponseOnce) {
        failRefundResponseOnce = false;
        throw new Error('synthetic refund response completion failure');
      }
      return originalRefundJson.call(this, body);
    };
    let completionRefundResponse: any;
    try {
      completionRefundResponse = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          bill_id: completionRefundBill,
          amount: 2,
          method: 'cash',
          approver_id: owner.userId,
          override_pin: '1234',
        },
      });
    } finally {
      refundResponsePrototype.json = originalRefundJson;
    }
    assertEqual(
      completionRefundResponse.status,
      500,
      'a post-commit response failure remains visible',
    );
    assertEqual(
      completionRefundResponse.data.reason_code,
      'operation.completion_failed',
      'a post-commit refund failure uses the completion reason',
    );
    assertEqual(
      completionRefundResponse.data.operation,
      'payment.refund',
      'the completion failure identifies refund processing',
    );
    assertEqual(
      completionRefundResponse.data.outcome,
      'applied',
      'the committed refund is reported as applied',
    );
    assertEqual(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM refunds WHERE bill_id = ?')
          .get(completionRefundBill) as { count: number }
      ).count,
      1,
      'the refund remains committed after response failure',
    );
    assertEqual(
      (
        db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(completionRefundBill) as {
          payment_status: string;
        }
      ).payment_status,
      'partially_refunded',
      'the bill state reflects the committed refund',
    );

    const originalRefundCapture = cloudSync.captureOperationFailure;
    cloudSync.captureOperationFailure = () => {
      throw new Error('local diagnostics unavailable');
    };
    try {
      const captureUnavailable = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: owner.authHeader,
        body: {},
      });
      assertEqual(
        captureUnavailable.status,
        400,
        'a diagnostics sink error cannot mask refund validation',
      );
      assertEqual(
        captureUnavailable.data.reason_code,
        'refund.rejected',
        'the original refund rejection remains structured',
      );
    } finally {
      cloudSync.captureOperationFailure = originalRefundCapture;
    }

    console.log(
      '\n4b. Payment validation, rollback, and post-commit outcomes follow persisted state',
    );
    const paymentOrderId = db
      .prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('DIAG-PAYMENT-ROLLBACK', 'takeaway', 'pending', 10, 10, ?, ?)`)
      .run(now(), now()).lastInsertRowid;
    const rollbackBillId = db
      .prepare(`INSERT INTO bills (order_id, bill_number, subtotal, discount_amount, tax_amount, total,
      paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'DIAG-PAYMENT-ROLLBACK', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`)
      .run(paymentOrderId, now(), now()).lastInsertRowid;
    db.prepare(`CREATE TRIGGER diagnostics_force_payment_rollback BEFORE UPDATE ON bills
      WHEN OLD.id = ${Number(rollbackBillId)} BEGIN SELECT RAISE(ABORT, 'private database error details'); END`).run();
    const rollbackId = crypto.randomUUID();
    const rollbackResponse = await api(baseUrl, `/api/bills/${rollbackBillId}/payments`, {
      method: 'POST',
      headers: { ...owner.authHeader, 'x-operation-id': rollbackId },
      body: { payments: [{ method: 'cash', amount: 10 }] },
    });
    db.prepare('DROP TRIGGER diagnostics_force_payment_rollback').run();
    assertEqual(rollbackResponse.status, 500, 'a database failure remains a server error');
    assertEqual(
      rollbackResponse.data.reason_code,
      'persistence.failed',
      'payment database failures use the persistence reason',
    );
    assertEqual(
      rollbackResponse.data.operation,
      'payment.create',
      'the failed operation is payment creation',
    );
    assertEqual(rollbackResponse.data.stage, 'persistence', 'the failure stage is persistence');
    assertEqual(
      rollbackResponse.data.outcome,
      'not_applied',
      'the transaction rollback proves the payment was not applied',
    );
    assertEqual(rollbackResponse.data.correlation_id, rollbackId, 'the operation UUID is echoed');
    const rollbackBill = db
      .prepare('SELECT paid_amount, payment_details FROM bills WHERE id = ?')
      .get(rollbackBillId) as { paid_amount: number; payment_details: string | null };
    assertEqual(rollbackBill.paid_amount, 0, 'the bill remains unpaid after rollback');
    assertEqual(
      rollbackBill.payment_details,
      null,
      'no partial payment detail remains after rollback',
    );
    assert(
      await settle(() => latestLocalDiagnostic(db, 'persistence.failed') !== null),
      'the failed payment is captured in the local diagnostics row',
    );

    seedCustomer(db, 'diag-customer-a', 'Synthetic Customer A');
    seedCustomer(db, 'diag-customer-b', 'Synthetic Customer B');
    const mismatchOrderId = db
      .prepare(`INSERT INTO orders (order_number, customer_id, type, status, subtotal, total, created_at, updated_at)
      VALUES ('DIAG-PAYMENT-MISMATCH', 'diag-customer-a', 'takeaway', 'pending', 10, 10, ?, ?)`)
      .run(now(), now()).lastInsertRowid;
    const mismatchBillId = db
      .prepare(`INSERT INTO bills (order_id, bill_number, customer_id, subtotal, discount_amount, tax_amount, total,
      paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'DIAG-PAYMENT-MISMATCH', 'diag-customer-a', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`)
      .run(mismatchOrderId, now(), now()).lastInsertRowid;
    const mismatchResponse = await api(baseUrl, `/api/bills/${mismatchBillId}/payments`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { customer_id: 'diag-customer-b', payments: [{ method: 'cash', amount: 10 }] },
    });
    assertEqual(mismatchResponse.status, 400, 'a customer mismatch remains a validation rejection');
    assertEqual(
      mismatchResponse.data.reason_code,
      'payment.invalid',
      'payment validation has a distinct reason from order quantity or stock',
    );
    assertEqual(
      mismatchResponse.data.display_code,
      'customer_mismatch',
      'payment customer mismatch has a safe distinct display code',
    );
    assertEqual(
      mismatchResponse.data.classification,
      'expected_rejection',
      'payment validation is an expected rejection',
    );
    assertEqual(
      mismatchResponse.data.outcome,
      'not_applied',
      'the mismatched payment was not applied',
    );
    assertEqual(
      (
        db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(mismatchBillId) as {
          paid_amount: number;
        }
      ).paid_amount,
      0,
      'the mismatched bill remains unpaid',
    );
    assert(
      await settle(() => latestLocalDiagnostic(db, 'payment.invalid') !== null),
      'payment validation is retained as a local typed reason',
    );
    assertEqual(
      latestLocalDiagnostic(db, 'payment.invalid')?.metadata?.display_code,
      'customer_mismatch',
      'the local payment event retains only the safe display code',
    );
    cloudSync.captureOperationFailure = () => {
      throw new Error('local diagnostics unavailable');
    };
    try {
      const uncapturedPayment = await api(baseUrl, `/api/bills/${mismatchBillId}/payments`, {
        method: 'POST',
        headers: owner.authHeader,
        body: { customer_id: 'diag-customer-b', payments: [{ method: 'cash', amount: 10 }] },
      });
      assertEqual(
        uncapturedPayment.status,
        400,
        'a failed diagnostics write cannot mask payment validation',
      );
      assertEqual(
        uncapturedPayment.data.display_code,
        'customer_mismatch',
        'the safe payment validation code survives diagnostics failure',
      );
    } finally {
      cloudSync.captureOperationFailure = throwingCapture;
    }

    console.log(
      '\n4c. Payment validation codes identify actual bill, wallet, reference, and idempotency branches',
    );
    const rejectedPayment = async (
      billId: number,
      body: any,
      headers: Record<string, string> = {},
    ) =>
      api(baseUrl, `/api/bills/${billId}/payments`, {
        method: 'POST',
        headers: { ...owner.authHeader, ...headers },
        body,
      });
    const assertPaymentCode = async (response: any, code: string) => {
      assertEqual(
        response.status >= 400 && response.status < 500,
        true,
        `${code} remains a payment validation response`,
      );
      assertEqual(response.data.display_code, code, `${code} is assigned by its payment branch`);
      await settle(
        () => latestLocalDiagnostic(db, 'payment.invalid')?.metadata?.display_code === code,
      );
      assertEqual(
        latestLocalDiagnostic(db, 'payment.invalid')?.metadata?.display_code,
        code,
        `${code} is captured as a safe local fact`,
      );
    };

    const paidBillId = createPaymentBill(db, 'DIAG-PAYMENT-PAID', {
      status: 'paid',
      paidAmount: 10,
    });
    await assertPaymentCode(
      await rejectedPayment(paidBillId, { payments: [{ method: 'card', amount: 1 }] }),
      'bill_already_paid',
    );
    const refundedBillId = createPaymentBill(db, 'DIAG-PAYMENT-REFUNDED', { status: 'refunded' });
    await assertPaymentCode(
      await rejectedPayment(refundedBillId, { payments: [{ method: 'card', amount: 1 }] }),
      'bill_refunded',
    );

    const noCustomerWalletBillId = createPaymentBill(db, 'DIAG-PAYMENT-WALLET-NO-CUSTOMER');
    await assertPaymentCode(
      await rejectedPayment(noCustomerWalletBillId, {
        payments: [{ method: 'wallet', amount: 1 }],
      }),
      'wallet_customer_required',
    );
    const unavailableCustomerBillId = createPaymentBill(db, 'DIAG-PAYMENT-CUSTOMER-MISSING');
    await assertPaymentCode(
      await rejectedPayment(unavailableCustomerBillId, {
        customer_id: 'missing-diagnostic-customer',
        payments: [{ method: 'card', amount: 1 }],
      }),
      'customer_unavailable',
    );
    const walletBillId = createPaymentBill(db, 'DIAG-PAYMENT-WALLET-EMPTY', {
      customerId: 'diag-customer-a',
    });
    await assertPaymentCode(
      await rejectedPayment(walletBillId, { payments: [{ method: 'wallet', amount: 1 }] }),
      'wallet_insufficient',
    );

    const missingAmountBillId = createPaymentBill(db, 'DIAG-PAYMENT-AMOUNT-MISSING');
    await assertPaymentCode(
      await rejectedPayment(missingAmountBillId, {
        payments: [{ method: 'cash', amount: 1 }, { method: 'card' }],
      }),
      'amount_required',
    );
    const overBalanceBillId = createPaymentBill(db, 'DIAG-PAYMENT-OVER-BALANCE');
    await assertPaymentCode(
      await rejectedPayment(overBalanceBillId, { payments: [{ method: 'card', amount: 11 }] }),
      'non_cash_exceeds_balance',
    );
    const invalidAmountBillId = createPaymentBill(db, 'DIAG-PAYMENT-INVALID-AMOUNT');
    await assertPaymentCode(
      await rejectedPayment(invalidAmountBillId, { payments: [{ method: 'card', amount: -1 }] }),
      'payment_input_invalid',
    );
    const unavailableMethodBillId = createPaymentBill(db, 'DIAG-PAYMENT-METHOD-MISSING');
    await assertPaymentCode(
      await rejectedPayment(unavailableMethodBillId, {
        payments: [{ method: 'custom', payment_method_id: 987654, amount: 1 }],
      }),
      'payment_method_unavailable',
    );

    const zeroAppliedCashBillId = createPaymentBill(db, 'DIAG-PAYMENT-ZERO-CASH');
    await assertPaymentCode(
      await rejectedPayment(zeroAppliedCashBillId, {
        payments: [
          { method: 'cash', amount: 10 },
          { method: 'cash', amount: 1, transaction_id: 'diag-zero-cash-ref' },
        ],
      }),
      'cash_reference_zero_applied',
    );
    const duplicateReferenceBillId = createPaymentBill(db, 'DIAG-PAYMENT-DUPLICATE-REF');
    await assertPaymentCode(
      await rejectedPayment(duplicateReferenceBillId, {
        payments: [
          { method: 'card', amount: 1, transaction_id: 'diag-duplicate-ref' },
          { method: 'card', amount: 1, transaction_id: 'diag-duplicate-ref' },
        ],
      }),
      'transaction_reference_reused',
    );
    const referenceSourceBillId = createPaymentBill(db, 'DIAG-PAYMENT-REF-SOURCE');
    const referenceSource = await rejectedPayment(referenceSourceBillId, {
      payments: [{ method: 'card', amount: 1, transaction_id: 'diag-used-ref' }],
    });
    assertEqual(referenceSource.status, 200, 'the first transaction reference is accepted');
    const referenceTargetBillId = createPaymentBill(db, 'DIAG-PAYMENT-REF-TARGET');
    await assertPaymentCode(
      await rejectedPayment(referenceTargetBillId, {
        payments: [{ method: 'card', amount: 1, transaction_id: 'diag-used-ref' }],
      }),
      'transaction_reference_used',
    );

    const idempotencyBillId = createPaymentBill(db, 'DIAG-PAYMENT-IDEMPOTENCY');
    const idempotencyKey = 'diagnostics-payment-idempotency';
    const idempotencyFirst = await rejectedPayment(
      idempotencyBillId,
      { payments: [{ method: 'card', amount: 1 }] },
      { 'Idempotency-Key': idempotencyKey },
    );
    assertEqual(idempotencyFirst.status, 200, 'the initial idempotent payment is committed');
    await assertPaymentCode(
      await rejectedPayment(
        idempotencyBillId,
        { payments: [{ method: 'card', amount: 2 }] },
        { 'Idempotency-Key': idempotencyKey },
      ),
      'idempotency_conflict',
    );

    const kitchenBillId = createPaymentBill(db, 'DIAG-PAYMENT-KITCHEN');
    const kitchenOrderId = (
      db.prepare('SELECT order_id FROM bills WHERE id = ?').get(kitchenBillId) as {
        order_id: number;
      }
    ).order_id;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
      VALUES (?, 'p2', 'Latte', 4.5, 1, 4.5, 0, 4.5, 'pending', ?, ?)`).run(
      kitchenOrderId,
      now(),
      now(),
    );
    setSetting('require_kitchen_delivered_before_settlement', 'true');
    setSetting('kds_enabled', 'true');
    setSetting('billing_type', 'postpaid');
    await assertPaymentCode(
      await rejectedPayment(kitchenBillId, { payments: [{ method: 'card', amount: 1 }] }),
      'kitchen_undelivered',
    );
    setSetting('require_kitchen_delivered_before_settlement', 'false');

    setSetting('require_open_shift', 'true');
    const batchCashSessionBillId = createPaymentBill(db, 'DIAG-PAYMENT-CASH-SESSION-BATCH');
    const batchCashSessionOperationId = crypto.randomUUID();
    const batchCashSessionFailure = await rejectedPayment(
      batchCashSessionBillId,
      { payments: [{ method: 'cash', amount: 10 }] },
      { 'x-operation-id': batchCashSessionOperationId },
    );
    await assertPaymentCode(batchCashSessionFailure, 'cash_session_required');
    const trustedBatchCashSessionFailure = classifyOrderRequestFailure(
      {
        response: { status: batchCashSessionFailure.status, data: batchCashSessionFailure.data },
      },
      { operation: 'payment.create', correlationId: batchCashSessionOperationId },
    );
    assertEqual(
      trustedBatchCashSessionFailure.trusted,
      true,
      'the cashier trusts a structured batch cash-session rejection',
    );
    assertEqual(
      trustedBatchCashSessionFailure.displayCode,
      'cash_session_required',
      'the batch cash-session code reaches the cashier failure classifier',
    );

    const singleCashSessionBillId = createPaymentBill(db, 'DIAG-PAYMENT-CASH-SESSION-SINGLE');
    const singleCashSessionOperationId = crypto.randomUUID();
    const singleCashSessionFailure = await api(
      baseUrl,
      `/api/bills/${singleCashSessionBillId}/payment`,
      {
        method: 'POST',
        headers: { ...owner.authHeader, 'x-operation-id': singleCashSessionOperationId },
        body: { method: 'cash', amount: 10 },
      },
    );
    await assertPaymentCode(singleCashSessionFailure, 'cash_session_required');
    const trustedSingleCashSessionFailure = classifyOrderRequestFailure(
      {
        response: { status: singleCashSessionFailure.status, data: singleCashSessionFailure.data },
      },
      { operation: 'payment.create', correlationId: singleCashSessionOperationId },
    );
    assertEqual(
      trustedSingleCashSessionFailure.trusted,
      true,
      'the cashier trusts a structured single cash-session rejection',
    );
    assertEqual(
      trustedSingleCashSessionFailure.displayCode,
      'cash_session_required',
      'the single cash-session code reaches the cashier failure classifier',
    );
    setSetting('require_open_shift', 'false');

    const diagnosticRows = JSON.stringify(
      db.prepare('SELECT event_code, metadata_json FROM local_diagnostics').all(),
    );
    assert(
      !diagnosticRows.includes('diag-customer-a'),
      'payment captures never include customer identifiers',
    );
    assert(
      !diagnosticRows.includes('diag-used-ref'),
      'payment captures never include transaction references',
    );
    assert(
      !diagnosticRows.includes('Available: 0 points'),
      'payment captures never include wallet balance text',
    );

    const completionOrderId = db
      .prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('DIAG-PAYMENT-COMPLETION', 'takeaway', 'pending', 10, 10, ?, ?)`)
      .run(now(), now()).lastInsertRowid;
    const completionBillId = db
      .prepare(`INSERT INTO bills (order_id, bill_number, subtotal, discount_amount, tax_amount, total,
      paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, 'DIAG-PAYMENT-COMPLETION', 10, 0, 0, 10, 0, 10, 'unpaid', ?, ?)`)
      .run(completionOrderId, now(), now()).lastInsertRowid;
    const kds = require('../main/services/kds');
    const priorNotifyOrderUpdated = kds.notifyOrderUpdated;
    kds.notifyOrderUpdated = () => {
      throw new Error('private notification failure');
    };
    const completionDiagnosticsBefore = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM local_diagnostics WHERE event_code = 'operation.completion_failed'",
        )
        .get() as { count: number }
    ).count;
    cloudSync.captureOperationFailure = () => {
      throw new Error('local diagnostics unavailable');
    };
    try {
      const completionResponse = await api(baseUrl, `/api/bills/${completionBillId}/payments`, {
        method: 'POST',
        headers: { ...owner.authHeader, 'x-operation-id': crypto.randomUUID() },
        body: { payments: [{ method: 'cash', amount: 5 }] },
      });
      assertEqual(completionResponse.status, 500, 'a post-commit notification error is surfaced');
      assertEqual(
        completionResponse.data.reason_code,
        'operation.completion_failed',
        'post-commit errors have a completion reason',
      );
      assertEqual(
        completionResponse.data.stage,
        'completion',
        'the response distinguishes completion from persistence',
      );
      assertEqual(
        completionResponse.data.outcome,
        'applied',
        'the response reports the proven committed payment',
      );
      assertEqual(
        (
          db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(completionBillId) as {
            paid_amount: number;
          }
        ).paid_amount,
        5,
        'the committed payment remains persisted',
      );
      assertEqual(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM local_diagnostics WHERE event_code = 'operation.completion_failed'",
            )
            .get() as { count: number }
        ).count,
        completionDiagnosticsBefore,
        'a failed diagnostics sink does not alter post-commit handling',
      );
    } finally {
      kds.notifyOrderUpdated = priorNotifyOrderUpdated;
      cloudSync.captureOperationFailure = throwingCapture;
    }

    console.log('\n5. No raw request or exception contents enter the v2 queue');
    const automaticRows = JSON.stringify({
      outbox: db.prepare('SELECT payload FROM store_diagnostics_outbox').all(),
      aggregates: db.prepare('SELECT facts_json FROM diagnostics_hourly_aggregates').all(),
    });
    assert(
      !automaticRows.includes('Synthetic Person'),
      'customer text is absent from every automatic diagnostic payload',
    );
    assert(
      !automaticRows.includes('Synthetic Customer A'),
      'payment customer data is absent from automatic diagnostics',
    );
    assert(
      !automaticRows.includes('sensitive order detail'),
      'unapproved event metadata is absent from automatic diagnostics',
    );
    assertEqual(
      (
        db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as {
          count: number;
        }
      ).count,
      0,
      'no raw diagnostic payload was queued',
    );

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
