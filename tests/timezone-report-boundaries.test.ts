import assert from 'node:assert/strict';
import { dayBoundsInTimezone, localDateInTimezone } from '../main/db';

/** Fixed-instant coverage for tenant-local report dates and UTC SQL ranges. */
const cases = [
  {
    timezone: 'UTC',
    instant: '2026-04-21T23:30:00Z',
    date: '2026-04-21',
    bounds: ['2026-04-21 00:00:00', '2026-04-22 00:00:00'],
  },
  {
    timezone: 'Asia/Kolkata',
    instant: '2026-04-21T20:00:00Z',
    date: '2026-04-22',
    bounds: ['2026-04-21 18:30:00', '2026-04-22 18:30:00'],
  },
  {
    timezone: 'America/Los_Angeles',
    instant: '2026-04-22T01:30:00Z',
    date: '2026-04-21',
    bounds: ['2026-04-21 07:00:00', '2026-04-22 07:00:00'],
  },
] as const;

for (const testCase of cases) {
  const instant = new Date(testCase.instant);
  assert.equal(
    localDateInTimezone(instant, testCase.timezone),
    testCase.date,
    `${testCase.timezone}: fixed instant resolves to the tenant-local dashboard date`,
  );
  assert.deepEqual(
    dayBoundsInTimezone(testCase.date, testCase.timezone),
    testCase.bounds,
    `${testCase.timezone}: report range starts and ends at tenant-local midnight`,
  );
}

console.log(`Timezone report boundary tests passed (${cases.length} zones)`);
