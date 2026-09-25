# Regional settings

A store's regional identity is its country and its currency. Every other regional value is derived
from those two through international conventions rather than configured or hard-coded. This page
describes the resolver, the three invariants it holds, its consumers, and the one place the
fail-closed rule is deliberately relaxed.

The product rule behind this design, its destructive post-setup currency change, and the compliance
grep that proves it are in
[product invariants](../reference/product-invariants.md). This page describes the mechanism; that
page states the rule.

## The resolver

`resolveRegionalSnapshot(settings)` in `main/countries.ts` maps a store's settings to a
`RegionalSnapshot`. It is pure: the same settings in produce the same snapshot, and it performs no
I/O. `RegionalSnapshot` is mirrored in the renderer at `frontend/src/lib/types.ts`, so the type
cannot drift between the two.

| Field | Derivation |
| --- | --- |
| `country` | The stored country code, normalised through the country profile. |
| `locale` | The country profile's BCP-47 locale. |
| `currency` | The stored currency when it is supported, otherwise the country profile's currency. |
| `currencySymbol` | `Intl.NumberFormat` for the country locale with the resolved currency. |
| `currencyPosition` | Whether `Intl` places the currency part before or after the integer part for this locale and currency pair. |
| `currencyFractionDigits` | The ISO 4217 minor-unit exponent for the currency. |
| `decimalSeparator` | `Intl.NumberFormat` for the country locale. |
| `groupSeparator` | `Intl.NumberFormat` for the country locale. |
| `timezone` | The stored `settings.timezone` when it is a valid IANA zone, otherwise the country profile's zone. |
| `preferences.currencyDisplay` | The stored `currency_display`, or the country profile's default. |
| `preferences.digits` | The stored `number_digits`, or the country profile's default. |
| `preferences.calendar` | The stored `calendar`, or the country profile's default. |

Everything except the seven stored keys (`country`, `currency`, `timezone`, `currency_display`,
`number_digits`, `calendar`) is computed. There is no per-store override for a derived value, and
the fix for a wrong rendering is the country profile, which corrects every store in that country.

## Invariants

**No default country.** The resolver reads the store's country and has no fallback. A store without a
resolvable country cannot produce a snapshot.

**No per-store override of a derived value.** Symbol, position, fraction digits, and separators
come from the country profile and the currency, never from a store setting.

**Fail closed.** A missing or unresolvable country raises `RegionalNotConfiguredError`, which
carries `statusCode = 409`. Callers surface it rather than substituting a value, so a store with
incomplete setup returns a 409 instead of silently rendering the wrong currency.

### The one deliberate exception

`buildLocalTenant()` in `main/routes/auth.ts` wraps the resolver in a try/catch and degrades to a
neutral `en-US`-shaped value when it throws, so that a login never fails because of an unconfigured
snapshot. The degraded value has an empty country and currency, an empty currency symbol, a `prefix`
currency position, 2 fraction digits, `.` and `,` separators, and the stored timezone if there is
one. It never claims a country or a currency.

The rationale is that the store object is assembled on the login path, before the renderer has a
token, and failing there would lock a user out of a store whose data is intact. Every other consumer
propagates the error.

## Stored overrides

`settings.timezone` is the only legitimate stored override of a regional value. It selects a zone
within the resolved country; it cannot substitute a country or a currency. An invalid or unparseable
value is ignored in favour of the country profile's zone.

A currency cannot be changed after setup. The only path is the owner-only, Master-PIN-gated reset
at `POST /api/db-tools/currency-reset`, which is destructive by design; see
[product invariants](../reference/product-invariants.md). Ordinary settings writes reject a currency
change with `currency_change_requires_reset`.

## Why the resolver is shared with the renderer

`main/countries.ts` is aliased into the frontend as `@countries`, in both `frontend/tsconfig.json`
and `frontend/next.config.ts`. The renderer therefore imports the same functions the backend uses
rather than a copy of the derivation.

That alias is the mechanism behind two guarantees. It is why `canonicalizeLocalizedAmount()`, which
the renderer uses to interpret a localized price as the user types, cannot disagree with what the
backend writes to the database. And it is why the renderer's print path in
`frontend/src/lib/printer/print-document.ts` can resolve the same currency symbol and tenant currency
the backend will print. `frontend/src/lib/countries.ts` re-exports the country and currency helpers
through the alias and adds locale-aware display formatting on top.

Files that import through the alias: `frontend/src/lib/currency-input.ts`,
`frontend/src/lib/countries.ts`, and `frontend/src/lib/printer/print-document.ts`. Changes to
`main/countries.ts` are therefore frontend changes as well, and must keep the module free of
Node-only dependencies.

## Consumers

`resolveRegionalSnapshot()` has 11 call sites in the backend, across 9 files:

| File | Use |
| --- | --- |
| `main/routes/auth.ts` | The local-tenant snapshot at login. |
| `main/server-app.ts` | The Server App tenant snapshot at `/api/server-app/info`, mapping the resolver's error to a 409 `regional_not_configured` response. |
| `main/routes/reports.ts` | Currency minor-unit factor for every monetary report. |
| `main/routes/cash-closures.ts` | Currency minor-unit factor for cash-closure arithmetic. |
| `main/services/refund.ts` | Refund minor units and the business timezone used for the refund window. |
| `main/services/daily-sales-export.ts` | Currency minor-unit factor for the accounting export. |
| `main/routes/menu-csv.ts` | Amount formatting and separators for menu and add-on CSV export. |
| `main/db.ts` | `requireTenantTimezone()` for order and bill numbering, and the target-currency snapshot taken inside the destructive currency reset. |
| `main/printers/thermal.ts` | Receipt currency symbol, fraction digits, and business timezone. |

The renderer consumes the same module through the `@countries` alias rather than calling the
resolver, because the renderer is handed a tenant object that already carries the resolved fields.

The severity of the fail-closed rule differs by consumer, and each of them documents its own
handling at the call site: authentication degrades as described above, the Server App returns a 409
with a `regional_not_configured` body, and the rest propagate the error.

## Localized amount input and CSV

`canonicalizeLocalizedAmount()` in `main/countries.ts` converts a user-typed localized string into a
plain number using the snapshot's separators. It keeps only digits and at most one decimal
separator, and it validates the digit grouping against what `Intl` would produce for the locale
rather than assuming fixed three-digit groups, so a locale with two-three-three grouping round-trips
correctly and malformed grouping such as a two-digit trailing group is rejected instead of silently
stripped.

The renderer half is `frontend/src/lib/currency-input.ts`, which re-exports
`canonicalizeLocalizedAmount()` through the alias and adds the keystroke-sanitising, display, and
parse helpers. `CurrencyAmountInput` in `frontend/src/components/ui/CurrencyAmountInput.tsx` is the
component built on it: it groups digits with the store's own separators as the user types, blocks
decimal entry entirely for a currency with no fraction digits, and re-derives its display when the
value or the store's regional format changes underneath it. It takes its separators as a `format`
prop and never assumes `.` and `,`.

`formatAmountForCsv()` in `main/countries.ts` renders a number with the snapshot's decimal
separator for CSV output. It is used by `main/routes/menu-csv.ts` for menu, add-on-group, and add-on
price and cost columns. `toCsvRow()` in `main/lib/csv.ts` then quotes fields and neutralises
spreadsheet formula triggers on non-numeric strings, so a product name beginning with `=`, `+`, `-`,
or `@` cannot execute when the export is opened in a spreadsheet.

## Compliance

The product invariants page owns the rule that regional settings never fall back to a hard-coded
country or currency, and the grep that checks it. That grep returns exactly two permitted hits, both
annotated one-time migration exceptions in `main/db.ts` that normalize pre-existing customer phone
numbers on an upgrading install. Both the rule and the allowlist are stated in
[product invariants](../reference/product-invariants.md); they are not repeated here so the two
pages cannot disagree.

## Verification

```sh
npm run test:currency
```

That script runs the currency, country-profile, locale, and regional-snapshot suites plus the
minor-unit, refund, and currency-reset suites. `tests/regional-snapshot.test.ts` contains 14
contract tests covering the derivation and each currency archetype, and `tests/currency.test.ts`
covers currency change, reset, and split checks.
