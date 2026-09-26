import assert from 'node:assert/strict';

import { localDateInTimezone } from '../main/db';
import { businessDateForInstant, dayBoundsInTimezone, normalizeBusinessDayStartTime } from '../shared/business-date';

/** The backend and the renderer each answer "what is today's business date?" for the same
 *  instant, tenant timezone and `business_day_start_time`. The two copies of that rule were
 *  written differently - the backend from an instant, the renderer from wall-clock minutes with
 *  a narrower accepted range of start times - so they disagreed on afternoon day starts and on
 *  the repeated hour of a daylight-saving fall-back. The expected value is pinned here so a
 *  divergence fails on its own rather than by comparing two implementations to each other.
 *
 *  The instants sit on the 2026 US transitions in America/New_York (2026-03-08 02:00 EST ->
 *  03:00 EDT, 2026-11-01 02:00 EDT -> 01:00 EST), which is where a wall-clock-minute comparison
 *  and an instant comparison stop being the same function. The 13:00 and 12:00 rows are the
 *  afternoon case: those values are outside the tenant's start-time contract, so the settings
 *  endpoint rejects them and the backend's own read path normalises them to midnight. A renderer
 *  that honoured them would name a day the backend does not, which is the divergence these rows
 *  pin shut. */
const cases = [
  {
    timezone: 'America/New_York',
    instant: '2026-03-08T07:30:00Z', // 03:30 EDT, after the spring-forward gap
    startTime: '00:00',
    businessDate: '2026-03-08',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-03-08T07:30:00Z',
    startTime: '04:00', // 03:30 local is before the 04:00 cutoff: still the previous day
    businessDate: '2026-03-07',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-03-08T07:30:00Z',
    startTime: '13:00', // outside the tenant contract, so midnight on both sides
    businessDate: '2026-03-08',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-03-08T17:00:00Z', // 13:00 EDT, the afternoon cutoff instant itself
    startTime: '00:00',
    businessDate: '2026-03-08',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-03-08T17:00:00Z',
    startTime: '04:00',
    businessDate: '2026-03-08',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-03-08T17:00:00Z',
    startTime: '13:00', // also outside the contract, so still the plain calendar day
    businessDate: '2026-03-08',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-11-01T05:45:00Z', // 01:45 EDT, the first pass of the repeated hour
    startTime: '01:30',
    businessDate: '2026-11-01',
  },
  {
    timezone: 'America/New_York',
    instant: '2026-11-01T06:15:00Z', // 01:15 EST, the second pass: the day started at 05:30Z
    startTime: '01:30',
    businessDate: '2026-11-01',
  },
  {
    timezone: 'UTC',
    instant: '2026-04-21T09:00:00Z', // outside the tenant contract, no daylight saving involved
    startTime: '12:00',
    businessDate: '2026-04-21',
  },
  {
    timezone: 'UTC',
    instant: '2026-04-21T14:00:00Z',
    startTime: '12:00',
    businessDate: '2026-04-21',
  },
] as const;

for (const testCase of cases) {
  const instant = new Date(testCase.instant);
  const label = `${testCase.timezone} ${testCase.instant} business_day_start_time=${testCase.startTime}`;
  const backendDate = localDateInTimezone(instant, testCase.timezone, testCase.startTime);
  const rendererDate = businessDateForInstant({
    instant,
    timezone: testCase.timezone,
    startTime: testCase.startTime,
  });

  assert.equal(backendDate, testCase.businessDate, `${label}: backend business date`);
  assert.equal(rendererDate, testCase.businessDate, `${label}: renderer business date`);
  assert.equal(
    rendererDate,
    backendDate,
    `${label}: the renderer and the backend name the same business day`,
  );
}

console.log(`Business-day parity tests passed (${cases.length} start-time and DST cases)`);

/** The start-time contract itself, so the renderer and the backend's settings read path
 *  cannot drift apart on which values count. The backend resolves the stored setting
 *  through tenantBusinessDayStartTime(), which delegates to this function. */
const contractCases = [
  ['00:00', '00:00'],
  ['04:00', '04:00'],
  ['  07:15  ', '07:15'],
  ['11:59', '11:59'],
  ['12:00', '00:00'],
  ['13:00', '00:00'],
  ['23:59', '00:00'],
  ['24:00', '00:00'],
  ['9:00', '00:00'],
  ['garbage', '00:00'],
  ['', '00:00'],
  [null, '00:00'],
  [undefined, '00:00'],
] as const;

for (const [stored, effective] of contractCases) {
  assert.equal(
    normalizeBusinessDayStartTime(stored),
    effective,
    `stored start time ${JSON.stringify(stored)} resolves to ${effective}`,
  );
}

/** The day-bounds primitive stays wider than the tenant contract on purpose: every
 *  backend caller normalises the setting before reaching it, and narrowing it here
 *  would silently move an existing store's report range. */
assert.deepEqual(
  dayBoundsInTimezone('2026-04-21', 'UTC', '13:00'),
  ['2026-04-21 13:00:00', '2026-04-22 13:00:00'],
  'dayBoundsInTimezone still honours a 13:00 offset for backend report ranges',
);

console.log('Business-day start-time contract tests passed');
