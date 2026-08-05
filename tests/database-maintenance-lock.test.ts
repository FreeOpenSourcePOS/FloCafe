import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { databaseMaintenanceMiddleware, withDatabaseMaintenanceLock } from '../main/db';

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
  await activeMaintenance;

  console.log('✅ Database maintenance lock tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
