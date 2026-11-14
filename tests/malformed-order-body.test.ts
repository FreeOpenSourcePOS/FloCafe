/**
 * Malformed JSON on order writes answers a structured validation.rejected failure
 * (support finding: response_unconfirmed on /api/orders), while other routes keep the bare 400.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-malformed-order-body-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function postRaw(baseUrl: string, pathName: string, rawBody: string, operationId?: string) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(operationId ? { 'x-operation-id': operationId } : {}),
    },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const { initDatabase, closeDatabase } = await import('../main/db');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  initDatabase();
  await startServer();
  const baseUrl = `http://127.0.0.1:${getServerPort()}`;
  const operationId = '55555555-5555-4555-8555-555555555555';

  try {
    const create = await postRaw(baseUrl, '/api/orders', '{"items": [', operationId);
    assert.equal(create.status, 400);
    assert.equal(create.body.reason_code, 'validation.rejected');
    assert.equal(create.body.display_code, 'malformed_body');
    assert.equal(create.body.operation, 'order.create');
    assert.equal(create.body.classification, 'expected_rejection');
    assert.equal(create.body.outcome, 'not_applied');
    assert.equal(create.body.correlation_id, operationId);

    const append = await postRaw(baseUrl, '/api/orders/order-1/items?x=1', '{nope', operationId);
    assert.equal(append.status, 400);
    assert.equal(append.body.reason_code, 'validation.rejected');
    assert.equal(append.body.display_code, undefined);
    assert.equal(append.body.operation, 'order.append');

    const mixedCreate = await postRaw(baseUrl, '/API/ORDERS', '{nope', operationId);
    assert.equal(mixedCreate.body.reason_code, 'validation.rejected');
    assert.equal(mixedCreate.body.operation, 'order.create');

    const mixedAppend = await postRaw(baseUrl, '/api/orders/123/ITEMS', '{nope', operationId);
    assert.equal(mixedAppend.body.reason_code, 'validation.rejected');
    assert.equal(mixedAppend.body.operation, 'order.append');

    const other = await postRaw(baseUrl, '/api/auth/login', '{nope');
    assert.equal(other.status, 400);
    assert.equal(other.body.error, 'Malformed JSON request body');
    assert.equal(other.body.reason_code, undefined);
  } finally {
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  console.log('ALL PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
