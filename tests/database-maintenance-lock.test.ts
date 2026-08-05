import * as assert from 'node:assert/strict';
import { withDatabaseMaintenanceLock } from '../main/db';

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

  console.log('✅ Database maintenance lock tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
