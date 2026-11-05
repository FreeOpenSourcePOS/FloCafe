import assert from 'node:assert/strict';

import { localDateInTimezone } from '../main/db';
import {
  businessDateForInstant,
  dateTimeFormat,
  dayBoundsInTimezone,
  normalizeBusinessDayStartTime,
  utcDayBounds,
} from '../shared/business-date';

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

/** The formatter cache exists because a report that formats one timestamp per row built
 *  a new Intl.DateTimeFormat per row. The cache must be invisible in the output, so every
 *  cached result is compared against a formatter built fresh at that moment, on both sides
 *  of a daylight-saving transition, and an unusable zone must still fail or fall back
 *  exactly as the uncached code did. */
const cachedFormatterCases = [
  { timezone: 'America/New_York', instant: '2026-03-08T06:30:00Z' }, // 01:30 EST, before spring-forward
  { timezone: 'America/New_York', instant: '2026-03-08T07:30:00Z' }, // 03:30 EDT, after the gap
  { timezone: 'Asia/Kolkata', instant: '2026-11-01T06:15:00Z' }, // a half-hour zone, no DST
  { timezone: 'Australia/Sydney', instant: '2026-10-03T15:59:00Z' }, // 01:59 AEST, before spring-forward
  { timezone: 'Australia/Sydney', instant: '2026-10-03T16:30:00Z' }, // 03:30 AEDT, after the gap
] as const;

const formatterVariants: { locale: string; options: Intl.DateTimeFormatOptions }[] = [
  { locale: 'en-US', options: { year: 'numeric', month: '2-digit', day: '2-digit' } },
  {
    locale: 'sv-SE',
    options: {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
  },
  { locale: 'en-GB', options: { dateStyle: 'medium', timeStyle: 'short' } },
];

const assertSameAsFresh = (
  locale: string,
  options: Intl.DateTimeFormatOptions,
  instant: Date,
): void => {
  const label = `${locale} ${options.timeZone} ${instant.toISOString()}`;
  const fresh = new Intl.DateTimeFormat(locale, { ...options }).format(instant);
  assert.equal(
    dateTimeFormat(locale, options).format(instant),
    fresh,
    `${label}: cached formatter prints what a fresh one prints`,
  );
  assert.equal(
    dateTimeFormat(locale, { ...options }).format(instant),
    fresh,
    `${label}: a re-built options object hits the same cache entry`,
  );
};

for (const testCase of cachedFormatterCases) {
  for (const { locale, options } of formatterVariants) {
    assertSameAsFresh(
      locale,
      { ...options, timeZone: testCase.timezone },
      new Date(testCase.instant),
    );
  }
}
assert.equal(
  dateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', hour: '2-digit' }),
  dateTimeFormat('sv-SE', { hour: '2-digit', timeZone: 'Asia/Kolkata' }),
  'option order does not create a second cache entry',
);
assert.notEqual(
  dateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata' }),
  dateTimeFormat('sv-SE', { timeZone: 'UTC' }),
  'a different time zone gets its own formatter',
);

assert.throws(
  () => dateTimeFormat('sv-SE', { timeZone: 'Not/AZone', year: 'numeric' }),
  RangeError,
  'an unusable time zone still throws as an unfetched formatter would',
);
assert.throws(
  () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Not/AZone', year: 'numeric' }),
  RangeError,
  'the uncached call it replaces throws the same way',
);
const invalidZoneInstant = new Date('2026-11-01T06:15:00Z');
assert.equal(
  businessDateForInstant({ instant: invalidZoneInstant, timezone: 'Not/AZone' }),
  invalidZoneInstant.toISOString().slice(0, 10),
  'an unusable zone still falls back to the UTC calendar day',
);
assert.deepEqual(
  dayBoundsInTimezone('2026-11-01', 'Not/AZone', '00:00'),
  utcDayBounds('2026-11-01', '00:00'),
  'an unusable zone still falls back to UTC day bounds',
);

console.log('Cached formatter parity tests passed');
