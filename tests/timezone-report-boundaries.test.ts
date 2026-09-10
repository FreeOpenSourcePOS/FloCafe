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

/** Cutoff coverage: 04:00 AM day start shifts boundaries and keeps cross-midnight sales on previous business day. */
const cutoffCases = [
  {
    timezone: 'UTC',
    instantPreCutoff: '2026-04-22T03:30:00Z',
    instantPostCutoff: '2026-04-22T04:00:00Z',
    date: '2026-04-21',
    bounds: ['2026-04-21 04:00:00', '2026-04-22 04:00:00'],
  },
  {
    timezone: 'Asia/Kolkata',
    instantPreCutoff: '2026-04-21T20:00:00Z', // 01:30 IST on 2026-04-22 -> belongs to 2026-04-21
    instantPostCutoff: '2026-04-21T22:30:00Z', // 04:00 IST on 2026-04-22 -> rolls over to 2026-04-22
    date: '2026-04-21',
    bounds: ['2026-04-20 22:30:00', '2026-04-21 22:30:00'],
  },
  {
    timezone: 'America/Los_Angeles',
    instantPreCutoff: '2026-04-22T08:30:00Z', // 01:30 PDT on 2026-04-22 -> belongs to 2026-04-21
    instantPostCutoff: '2026-04-22T11:00:00Z', // 04:00 PDT on 2026-04-22 -> rolls over to 2026-04-22
    date: '2026-04-21',
    bounds: ['2026-04-21 11:00:00', '2026-04-22 11:00:00'],
  },
] as const;

for (const testCase of cutoffCases) {
  assert.equal(
    localDateInTimezone(new Date(testCase.instantPreCutoff), testCase.timezone, '04:00'),
    testCase.date,
    `${testCase.timezone}: pre-cutoff instant (01:30-03:30) resolves to previous business date`,
  );
  assert.equal(
    localDateInTimezone(new Date(testCase.instantPostCutoff), testCase.timezone, '04:00'),
    '2026-04-22',
    `${testCase.timezone}: post-cutoff instant (04:00) rolls over to next business date`,
  );
  assert.deepEqual(
    dayBoundsInTimezone(testCase.date, testCase.timezone, '04:00'),
    testCase.bounds,
    `${testCase.timezone}: day bounds shifted to 04:00 local wall time`,
  );
}

console.log(`Timezone report boundary tests passed (${cases.length} default + ${cutoffCases.length} cutoff zones)`);
