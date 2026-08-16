import * as assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import {
  databaseMaintenanceMiddleware,
  registerDatabaseMaintenanceStartListener,
  withDatabaseMaintenanceLock,
  withDatabaseRequest,
} from '../main/db';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const events: string[] = [];
  const first = withDatabaseMaintenanceLock(async () => {
    events.push('first-start');
    await delay(20);
    events.push('first-end');
    return 'first';
  });
  const second = withDatabaseMaintenanceLock(async () => {
    events.push('second-start');
    events.push('second-end');
    return 'second';
  });
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end'], 'maintenance operations are serialized');

  await assert.rejects(
    withDatabaseMaintenanceLock(async () => {
      throw new Error('expected failure');
    }),
    /expected failure/,
  );
  assert.equal(
    await withDatabaseMaintenanceLock(async () => 'after-failure'),
    'after-failure',
    'a failed maintenance operation releases the lock',
  );

  const activeResponse = new EventEmitter() as EventEmitter & { status: (code: number) => typeof activeResponse; json: (body: unknown) => void };
  activeResponse.status = () => activeResponse;
  activeResponse.json = () => undefined;
  let activeNextCalled = false;
  databaseMaintenanceMiddleware({ path: '/api/test' } as any, activeResponse as any, () => { activeNextCalled = true; });
  assert.equal(activeNextCalled, true, 'normal requests enter while maintenance is idle');

  let maintenanceStarted = false;
  const maintenance = withDatabaseMaintenanceLock(async () => {
    maintenanceStarted = true;
    await delay(10);
  });
  await delay(1);
  assert.equal(maintenanceStarted, false, 'maintenance waits for active requests to finish');
  activeResponse.emit('finish');
  await maintenance;

  const blockedResponse = new EventEmitter() as EventEmitter & { status: (code: number) => typeof blockedResponse; json: (body: unknown) => void };
  let blockedStatus = 0;
  blockedResponse.status = (code: number) => { blockedStatus = code; return blockedResponse; };
  blockedResponse.json = () => undefined;
  let blockedNextCalled = false;
  const activeMaintenance = withDatabaseMaintenanceLock(async () => { await delay(10); });
  await delay(1);
  databaseMaintenanceMiddleware({ path: '/api/test' } as any, blockedResponse as any, () => { blockedNextCalled = true; });
  assert.equal(blockedNextCalled, false, 'new requests are rejected during maintenance');
  assert.equal(blockedStatus, 503, 'maintenance requests receive retryable status');

  for (const path of ['/api/db/import', '/api/db/backup', '/api/db/download', '/api/db-tools/initialize']) {
    const ownerResponse = new EventEmitter() as EventEmitter & { status: (code: number) => typeof ownerResponse; json: (body: unknown) => void };
    let ownerStatus = 0;
    ownerResponse.status = (code: number) => { ownerStatus = code; return ownerResponse; };
    ownerResponse.json = () => undefined;
    let ownerNextCalled = false;
    databaseMaintenanceMiddleware({ path } as any, ownerResponse as any, () => { ownerNextCalled = true; });
    assert.equal(ownerNextCalled, false, `${path} is rejected before route/auth middleware during maintenance`);
    assert.equal(ownerStatus, 503, `${path} receives a retryable maintenance response`);
  }
  await activeMaintenance;

  // Exercise the middleware at the same position as the production Express
  // stack: a second maintenance request must be rejected before auth/route
  // middleware can touch the database.
  const app = express();
  app.use(databaseMaintenanceMiddleware);
  let authTouched = false;
  app.use((_req, _res, next) => { authTouched = true; next(); });
  app.post('/api/db/backup', (_req, res) => res.json({ reached: true }));
  let routeMaintenanceStarted!: () => void;
  const routeMaintenanceStartedSignal = new Promise<void>((resolve) => {
    routeMaintenanceStarted = resolve;
  });
  const unregisterMaintenanceStart = registerDatabaseMaintenanceStartListener(() => {
    routeMaintenanceStarted();
  });
  let releaseMaintenance!: () => void;
  const maintenanceHold = new Promise<void>((resolve) => {
    releaseMaintenance = resolve;
  });
  const activeRouteMaintenance = withDatabaseMaintenanceLock(async () => {
    await maintenanceHold;
  });
  await routeMaintenanceStartedSignal;
  try {
    const concurrentRoute = await request(app).post('/api/db/backup');
    assert.equal(concurrentRoute.status, 503, 'concurrent maintenance route receives 503 before auth/route middleware');
    assert.equal(authTouched, false, 'concurrent maintenance route does not reach later middleware');
  } finally {
    releaseMaintenance();
    await activeRouteMaintenance;
    unregisterMaintenanceStart();
  }

  // A maintenance route is excluded from the active-request count by the
  // production middleware. This verifies that its handler can acquire the
  // lock and complete its response instead of waiting for itself forever.
  const routeApp = express();
  routeApp.use(databaseMaintenanceMiddleware);
  routeApp.post('/api/db/backup', async (_req, res) => {
    await withDatabaseMaintenanceLock(async () => { await delay(5); });
    res.json({ reached: true });
  });
  const routeResponse = await request(routeApp).post('/api/db/backup').timeout({ response: 500 });
  assert.equal(routeResponse.status, 200, 'maintenance route completes through the production middleware');
  assert.deepEqual(routeResponse.body, { reached: true });

  // ── Maintenance drain is bounded: a stuck active request fails fast ────
  let releaseActive!: () => void;
  const hold = new Promise<void>((resolve) => { releaseActive = resolve; });
  const activeRequest = withDatabaseRequest(() => hold);
  await delay(1); // let the active-request counter observe the held request
  await assert.rejects(
    withDatabaseMaintenanceLock(async () => 'never-runs', undefined, 30),
    /timed out after 30ms waiting for active requests to drain/,
  );
  releaseActive();
  await activeRequest;

  console.log('✅ Database maintenance lock tests passed');
}

const keepAlive = setInterval(() => undefined, 50);
run().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => clearInterval(keepAlive));
