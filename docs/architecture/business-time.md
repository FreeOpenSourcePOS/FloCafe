# Business time

FloCafe stores every timestamp in UTC and presents it in the tenant's configured timezone. The
stored value is the record; the timezone is a presentation and boundary concern layered on top.
Getting the two apart is the whole discipline on this page.

The primitives live in [`main/db.ts`](../../main/db.ts) and are used by reports, cash closures,
refunds, printing, and the frontend.

## The storage convention

`now()` writes the SQLite `CURRENT_TIMESTAMP` format: `YYYY-MM-DD HH:MM:SS`, in UTC, with no zone
suffix and no fractional seconds.

That form is **not** what `new Date(string)` expects. In V8, a space-delimited timestamp parses as
machine-local time, so a naive parse shifts every reading by the developer's own UTC offset.

`parseDbTimestamp` in the backend handles both stored forms:

```ts
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN);
  // Space form: append a Z so V8 parses it as UTC instead of machine-local.
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts);
}
```

It returns an invalid `Date` for a missing value rather than the epoch, so a missing timestamp
fails a comparison instead of silently reading as 1970.

The frontend has an identical helper in
[`frontend/src/lib/utils.ts`](../../frontend/src/lib/utils.ts). Use one or the other; never call
`new Date()` on a value that came out of the database.

## Day boundaries

A business day is a half-open UTC range `[start, end)` for one calendar date in an IANA timezone,
optionally shifted by a configured day-start offset.

| Function | Returns |
| --- | --- |
| `dayBoundsInTimezone(date, timezone, startTime?)` | The `[start, end)` pair, formatted as `YYYY-MM-DD HH:MM:SS` UTC strings. |
| `utcDayBounds(date, startTime?)` | The same shape for a UTC calendar date, with no timezone applied. |
| `localDateInTimezone(instant, timezone, startTime?)` | The `YYYY-MM-DD` business date an instant falls on. |
| `utcTodayDate()` | Today's date in UTC, for the cases that are genuinely not tenant-scoped. |

The day-start offset comes from the `business_day_start_time` setting through
`tenantBusinessDayStartTime`, which accepts `00:00` through `11:59` and falls back to `00:00` for
anything absent or malformed. A start time later than midday is rejected because a business day
longer than twelve hours is not a thing a store configures.

`dayBoundsInTimezone` resolves the zone offset with `Intl.DateTimeFormat` and iterates the
local-to-UTC conversion up to three times, which is what makes it correct across a daylight-saving
transition. If the timezone is unusable it falls back to `utcDayBounds`.

`localDateInTimezone` with a non-zero day start compares the instant against the day's start bound;
an instant that falls before the start belongs to the previous calendar date. That is what makes a
store that opens at 06:00 not split its 01:00 trade into the previous day's revenue.

## The trap: an unresolved timezone silently means UTC

This is the single most consequential failure mode in the codebase, and it is silent.

`dayBoundsInTimezone` and `localDateInTimezone` take a `timezone` **string**. They do not look one
up. If you pass `undefined`, an empty string, or an invalid zone, the `Intl` calls throw, the
`catch` runs, and you get `utcDayBounds` behaviour. No error, no log - just a UTC answer.

That produces wrong numbers rather than a failure. A store in `Asia/Kolkata` would see its closing
hour counted in the previous UTC day; a store in `America/New_York` would see its opening hour
counted in the next one.

**The rule: resolve the timezone through the regional snapshot, or you get UTC.**

`resolveRegionalSnapshot` in [`main/countries.ts`](../../main/countries.ts) is the only supported
resolver. It has no default country, so an unconfigured tenant throws `RegionalNotConfiguredError`
(a `409`) rather than guessing.

The three call sites that had to learn this each carry the same comment explaining the failure mode:

```ts
function tenantTimezone(): string {
  return resolveRegionalSnapshot({
    country: getSettingValue('country') ?? undefined,
    currency: getSettingValue('currency') ?? undefined,
    timezone: getSettingValue('timezone') ?? undefined,
  }).timezone;
}
```

- [`main/routes/reports.ts`](../../main/routes/reports.ts), `tenantTimezone`, guards
  `bucketByLocalHourAndWeekday` and `dayBoundsInTimezone` in reporting.
- [`main/routes/cash-closures.ts`](../../main/routes/cash-closures.ts) exports `tenantTimezone` so
  that `cash-sessions.ts` resolves the same window rather than a second, divergent one.
- [`main/services/refund.ts`](../../main/services/refund.ts) resolves inline, because a wrong
  business-day end there can wrongly accept or reject a late refund.

Pass `getSettingValue('timezone')` straight into `dayBoundsInTimezone` and you have reintroduced
the trap. Go through the snapshot.

## Where the boundaries are applied

### Reporting

`main/routes/reports.ts` builds today's date and any requested date range from
`dayBoundsInTimezone(date, tenantTimezone(), tenantStartTime())`, and buckets rows by local hour and
weekday from the same resolved zone. Row-level dates use `localDateInTimezone` so a sale is
attributed to the business date on which it happened in the store, not the one in UTC.

### Cash closures

`main/routes/cash-closures.ts` computes `todayLocal` the same way, and derives the start of the first
day and the end of the last day from `dayBoundsInTimezone` at both ends. Cash movements, X-reports,
and the Z-report all key off the resulting `businessDate`, which is why a closure total and a sales
report for the same day agree.

### Refunds

`main/services/refund.ts` allows a refund freely within `REFUND_WINDOW_MS` of order creation, which
is one hour. After that window the order's business day is computed with `localDateInTimezone`, and
if the current instant has passed that day's end the refund is refused with a `409`. Before the
`409`, a late refund requires an owner Master PIN.

`parseDbTimestamp` is used on both ends of that comparison, so the boundary is an instant
comparison in UTC rather than a string comparison.

### Printing

`main/printers/document-classic.ts`, `document-compact.ts`, and `document-kot.ts` all parse the
document's timestamp with `parseDbTimestamp` and format it for the requested locale and timezone.
The print timezone comes from the print language policy, not from the host machine, so a receipt
prints the store's local time regardless of which machine renders it.

## Frontend boundaries

The renderer does not compute business days. It receives `businessDate` and the report rows from the
API and renders them, and the only timestamp parsing it does is `parseDbTimestamp` for display
values such as elapsed KDS time and image cache keys.

## Verifying a change here

| Concern | Command |
| --- | --- |
| Day and reporting boundaries across zones | `npm run test:timezone-report-boundaries` |
| Stored timezone override | `npm run test:issue-389-timezone-override` |
| Regional resolution contract | `npm run test:currency`, `npm run test:country-provenance` |
| Server-side rendering of dates | `npm run test:i18n-ssr-timezone` |

When you add a code path that buckets or bounds time by day, test it at a tenant offset from UTC
and across a daylight-saving transition. Both are covered by
`tests/timezone-report-boundaries.test.ts`.
