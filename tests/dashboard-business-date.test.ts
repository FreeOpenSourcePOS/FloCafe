import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { businessDateForInstant } from '../shared/business-date';

/** The dashboard used to derive "today" from the tenant timezone alone, so a store
 *  whose business day starts later than midnight saw the dashboard disagree with the
 *  cash-close modal for the first hours of its own day, and the day picker's upper
 *  bound was a day ahead of the day a close would land on. */
const dashboardPage = fs.readFileSync(
  path.join(__dirname, '../frontend/src/app/(dashboard)/dashboard/page.tsx'),
  'utf8',
);

assert.doesNotMatch(
  dashboardPage,
  /getLocalDateString/,
  'the dashboard must not carry its own business-date helper',
);
assert.match(
  dashboardPage,
  /import \{ businessDateForInstant \} from '@shared\/business-date'/,
  'the dashboard resolves the business date through the shared rule',
);
assert.match(
  dashboardPage,
  /businessDateForInstant\(\{[^}]*startTime: currentTenant\?\.business_day_start_time/s,
  'the dashboard passes the store business_day_start_time into the rule it shares with cash close',
);

/** What the operator sees before the day's start time: the same business date the
 *  cash-close modal already showed, and not the tenant-local calendar date. */
const instant = new Date('2026-03-08T07:30:00Z'); // 03:30 America/New_York on the spring-forward day
const startTime = '04:00';
const calendarDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(instant);

assert.equal(calendarDate, '2026-03-08', 'the tenant-local calendar date the dashboard used to show');
assert.equal(
  businessDateForInstant({ instant, timezone: 'America/New_York', startTime }),
  '2026-03-07',
  'the dashboard business date follows the store business day, as cash close already did',
);
assert.equal(
  businessDateForInstant({ instant, timezone: 'America/New_York', startTime: '00:00' }),
  calendarDate,
  'a store with a midnight business day is unchanged',
);

console.log('Dashboard business date follows business_day_start_time');
