# Regional snapshot

**Status: ACTIVE DESIGN — approved 2026-09-18 (owner decision recorded in [business-decisions.md](business-decisions.md), "Regional settings come from signup, never from a fallback").**

This note defines one backend resolver for a store's regional identity (country, currency, number formatting, business timezone) so that every surface renders money and dates from the same answer. It is the design that PR #697 was closed in favour of, and the contract that issue #693 (locale-aware price input and CSV parsing) is re-implemented against.

The rule it implements is short: **the country the owner selects at signup, and the ISO 4217 currency that follows from it, are the only source of regional truth. Everything else is derived from international conventions (CLDR via `Intl`, IANA time zones). There is no default country, no hard-coded symbol, and no override mechanism.**

## Problem

Today each surface resolves the store's regional settings on its own, with its own India defaults. The inventory below is the evidence:

| Site | What it resolves | Hard-coded fallback |
| --- | --- | --- |
| `main/db.ts` `seedInstallDefaults()` | writes regional keys before the owner has chosen anything | `country=IN`, `currency=INR`, `currency_symbol=₹`, `timezone=Asia/Kolkata` |
| `frontend/src/app/setup/page.tsx` | signup wizard initial state | country preselected to `'IN'`, timezone `'Asia/Kolkata'` |
| `main/routes/auth.ts` `POST /setup/initialize` | accepts a missing country | `country = 'IN'`, `currency = 'INR'`, `timezone = 'Asia/Kolkata'` |
| `main/routes/auth.ts` `buildLocalTenant()` | the desktop renderer's tenant object | `'IN'`, `'INR'`, `'₹'`, `'Asia/Kolkata'` |
| `main/routes/settings.ts` `businessShape()` / `deriveCurrencySymbol()` | the Settings page | `'IN'`, `'INR'`, `'Asia/Kolkata'` |
| `main/server-app.ts` `/api/server-app/info` | the `:3003` server app (added by #705) | `getCountryByCode('IN')!` |
| `main/routes/printers.ts` (bill print payload) | country, currency, symbol, timezone | `'IN'`, `'Asia/Kolkata'` |
| `main/printers/document-classic.ts`, `document-compact.ts` | currency prefix | `'₹'` |
| `main/db.ts` (order-number generation) | timezone | `'Asia/Kolkata'` |
| `main/countries.ts` `formatCurrencyForTenant()`, `formatNumberForTenant()`, `formatDateForTenant()` | locale from country | `countryCode ?? 'IN'` |
| `frontend/src/hooks/useFormatCurrency.ts`, `useCurrencyUnitAdapter.ts`, `useCashClose.ts` | currency, country | `'INR'` |
| `frontend/src/lib/printer/web-print.ts` | browser receipts | `'INR'`, `'IN'` |
| `frontend/src/app/server-standalone/page.tsx` | server app UI, even after `/info` exists | `'INR'` |

Two consequences:

1. **The `₹` / INR fallback leaks on non-Indian installs.** Any path where a value is absent silently renders Indian defaults, and none of them log. Because the install seed writes India before the wizard runs, a store that never completes the country step still "looks configured".
2. **Surfaces disagree on the currency symbol.** `main/routes/printers.ts` derives the symbol from the currency, while `main/printers/thermal.ts` and `main/server-app.ts` prefer the stored `currency_symbol` key. The same store can print one symbol on the browser receipt and another on the thermal bill.

UI language (`settings.language`, `frontend/src/lib/i18n`) is a separate domain (`AGENTS.md` invariant 3) and is not touched by this design.

## Proposal

Add one read-only function to `main/countries.ts`:

```ts
export function resolveRegionalSnapshot(settings: Record<string, string | undefined>): RegionalSnapshot;
// throws RegionalNotConfiguredError when settings.country is missing or not a known profile

interface RegionalSnapshot {
  country: string;            // ISO 3166-1 alpha-2, e.g. 'CO'
  locale: string;             // BCP-47 tag from the country profile, e.g. 'es-CO'
  currency: string;           // ISO 4217, e.g. 'COP'
  currencySymbol: string;     // CLDR narrow symbol via Intl, e.g. '$', 'د.ك.', '₹'; the code when CLDR has none
  currencyPosition: 'prefix' | 'suffix';
  currencyFractionDigits: number;   // 0 for COP, 2 for USD, 3 for KWD
  decimalSeparator: string;   // ',' for es-CO, '.' for en-US
  groupSeparator: string;     // '.' for es-CO, ',' for en-US
  timezone: string;           // IANA, e.g. 'America/Bogota'
  preferences: {              // existing validated display prefs, passed through unchanged
    currencyDisplay: CurrencyDisplay;   // 'rial' | 'toman' | 'toman_short'
    digits: DigitMode;                  // 'locale' | 'latin'
    calendar: CalendarMode;             // 'locale' | 'persian' | 'gregorian'
  };
}
```

Every field is derived from the selected country and currency using conventions that already exist in the codebase or in the platform. Nothing is looked up from a per-store override:

| Field | Rule |
| --- | --- |
| `country` | `getCountryByCode(settings.country)`. Missing or unknown → throw. There is no default. |
| `locale` | `country.locale` from the profile. Never from the UI language. |
| `currency` | `resolveTenantCurrency(settings.currency, country)` — the ISO 4217 code the wizard wrote from the country profile, or a valid code the owner later set in Business Settings. Its internal `'INR'` fallback is removed; with a known country it is unreachable anyway. |
| `currencySymbol` | `getCurrencySymbol(currency, locale)` — `Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })`. The stored `currency_symbol` key is **not** an input; the key remains in the database untouched (no migration) but nothing reads it once a surface adopts the resolver. |
| `currencyPosition` | From `Intl.NumberFormat(...).formatToParts(1)` — whether the currency part precedes the integer part. The `currencyPosition()` helper currently private to `main/server-app.ts` moves next to the resolver. |
| `currencyFractionDigits` | `getCurrencyFractionDigits(currency)` — ISO 4217 minor units via `Intl` (keeps the existing IRR special case). |
| `decimalSeparator`, `groupSeparator` | From `Intl.NumberFormat(locale).formatToParts(12345.6)`; empty string when the locale has no group separator. These are what the price input and the CSV importer parse against. |
| `timezone` | `settings.timezone` if `isValidTimeZone()`, otherwise `country.timezone` from the profile. The wizard already writes the profile timezone as its default; the owner can pick another IANA zone for multi-zone countries. |
| `preferences` | `settings.currency_display`, `number_digits`, `calendar`, validated per country exactly as `resolveStoredLocalePreference()` in `main/routes/settings.ts` does today. |

The resolver is pure: same settings in, same snapshot out, no I/O, no memoization.

### No fallback

If `settings.country` is missing or unknown the resolver throws `RegionalNotConfiguredError`. HTTP handlers that call it respond `409 { error: 'regional_not_configured' }`. No surface formats money, numbers, or business dates before it has a snapshot.

For the desktop app this state is already unreachable: `AuthGuard` (`frontend/src/components/layout/AuthGuard.tsx`) redirects to the signup wizard while `GET /auth/setup-status` reports `needsSetup`, and the wizard cannot complete without a country. The rule exists so that the *code* stops carrying India as an implicit answer, not because the state is expected in practice.

### Removing the India defaults at their source (required, same change as surface 1)

- `seedInstallDefaults()` in `main/db.ts` stops writing `country`, `currency`, `currency_symbol`, and `timezone`. The wizard writes them. Existing installs already have real values, so no migration and no data change.
- The signup wizard starts with **no** country selected and requires one; its timezone default becomes the selected country's profile timezone instead of `'Asia/Kolkata'`.
- `POST /setup/initialize` returns `400` when `country` is absent instead of defaulting to `'IN'`.
- Every `?? 'IN'` / `|| 'INR'` / `?? '₹'` / `|| 'Asia/Kolkata'` fallback is deleted, not replaced. The inventory table above lists only the primary resolution points; the compliance grep at the end of this note finds **136 sites across 54 files** as of 2026-09-18 (phone normalization, customers, tax packs, WhatsApp share text, reports, and the print encoders account for most of the rest). That sweep is its own PR, sequenced after the resolver lands so every caller has a snapshot value to pass. Where a helper currently accepts an optional country (`formatCurrencyForTenant`, `formatNumberForTenant`, `formatDateForTenant`, the print `options.currencySymbol`, `normalizeOptionalPhone`), the parameter becomes required and TypeScript drives the caller fixes. Surfaces that have not adopted the resolver keep their own resolution logic — they just lose the silent default.

Implementation order, one PR each: (1) resolver + contract tests + seed/wizard/initialize changes; (2) the fallback sweep, reviewed by the compliance grep reaching zero; (3) surface 1, the server app; (4) surface 2 and the fresh #693 work.

### Transport (no new state)

The snapshot travels through channels that already exist:

- **Desktop renderer:** `buildLocalTenant()` in `main/routes/auth.ts` spreads the snapshot into the tenant object it already returns (`currency_symbol`, `currency_position`, `currency_fraction_digits`, `decimal_separator`, `group_separator` are added; existing field names are kept). The renderer keeps reading `useAuthStore().currentTenant`.
- **Server app:** `/api/server-app/info` in `main/server-app.ts` returns the snapshot fields; its inline resolution block is replaced by the resolver call.

## Hard constraints

A PR implementing this design is rejected if it does any of the following:

- adds a database migration;
- adds a new key to the `settings` table;
- adds any per-store override of a value the snapshot derives (symbol, position, separators);
- writes a sentinel value anywhere to mean "unset" or "legacy";
- adds client-side caching of regional values beyond the existing `currentTenant` object;
- adds a backward-compatibility shim, feature flag, or dual code path to preserve the old per-surface fallbacks;
- lets the resolver depend on the UI language;
- reintroduces a default country anywhere, including the wizard's initial state.

## Initial surfaces (exactly two)

1. **Standalone server app** (`:3003`) — `main/server-app.ts` `/api/server-app/info` and `frontend/src/app/server-standalone/page.tsx`. Phase 2a (#705) already made the endpoint derive currency at request time; this design moves that derivation into the resolver and removes the page's `|| 'INR'` client fallbacks. The page renders no amounts until `/info` has resolved. COP and KWD fixtures for this surface already exist in `tests/server-app-server-role.test.ts`.
2. **Currency input and display path** — the surface #697 tried to fix: `frontend/src/hooks/useFormatCurrency.ts`, `useCurrencyUnitAdapter.ts`, `frontend/src/lib/currency-input.ts`, the price `<input type="number">` fields in `frontend/src/app/(dashboard)/products/page.tsx` and `addon-groups/page.tsx`, and price parsing in `main/routes/menu-csv.ts`. These consume the snapshot fields from `currentTenant` (the CSV route calls the resolver directly).

### What the fresh #693 PR delivers

- A localized price input that groups digits with the snapshot's separators as typed, and blocks decimal entry when `currencyFractionDigits === 0`.
- CSV price parsing that interprets `.` / `,` per the snapshot separators and strips the snapshot's symbol (`11.000` → `11000` for `es-CO`, `1.234,50` → `1234.5` for `de-DE`).

### What #693 asked for that is decided against

- **Editable currency symbol** and **selectable prefix/suffix position.** Both are per-store overrides of a CLDR convention. Colombia renders `$ 11.000` because that is what `es-CO` renders everywhere else Colombians use software; the grouping already distinguishes it from `$11,000.00`. If a real discrepancy with a locale's convention is found, the fix is to correct the country profile in `main/countries.ts` for every store in that country, not to add a per-store knob.

## Expansion rule

A third surface (`main/routes/printers.ts`, `main/printers/thermal.ts`, `frontend/src/lib/printer/web-print.ts`, `useFormatDate`, reports, WhatsApp share text, …) adopts the resolver **only** when a concrete discrepancy is filed against that surface — an issue showing two surfaces rendering the same store differently, with the settings and both outputs. The symbol disagreement between `printers.ts` and `thermal.ts` is the obvious first candidate and is deliberately left for its own reviewed change.

Adopting a surface means: replace its local resolution with the snapshot and add it to the contract test matrix. It does not mean touching neighbouring surfaces.

## Contract tests

One new suite, `tests/regional-snapshot.test.ts`, wired into `npm run test:currency` (already required to be reachable from `npm test` by the coverage validator). For each archetype the test builds the settings map the wizard would write, calls the resolver, and asserts every field plus one formatted amount and one parsed input. Values below were checked against Node's `Intl` and `dayBoundsInTimezone()` on 2026-09-18:

| Archetype | Settings | Asserts |
| --- | --- | --- |
| USD / 2 | `US`, `USD` | `$`, prefix, 2, `.` / `,`, `$1,234.50`, `"1,234.50"` → `1234.5` |
| COP / 0 | `CO`, `COP` | `$`, prefix, 0, `,` / `.`, `$ 11.000`, `"11.000"` → `11000`, decimal keys blocked |
| EUR with comma input | `DE`, `EUR` | `€`, suffix, 2, `,` / `.`, `1.234,50 €`, `"1.234,50"` → `1234.5` |
| KWD / 3 | `KW`, `KWD` | 3 fraction digits, `"1.250"` round-trips without loss |
| Persian RTL / Toman | `IR`, `IRR`, `currency_display=toman` | locale `fa-IR`, 2 fraction digits, preferences passed through, formatted amount ends in `تومان` with Persian digits |
| INR | `IN`, `INR` | `₹`, prefix, 2, `.` / `,`, `₹1,234.50` — reached the same way as every other country, with no special-casing |
| Missing country | `country` absent | throws `RegionalNotConfiguredError`; nothing is formatted |
| Unknown country | `country=ZZ` | throws `RegionalNotConfiguredError` |
| DST timezone | `US`, `timezone=America/New_York` | `dayBoundsInTimezone('2026-03-08', snapshot.timezone)` is the 23-hour range `[2026-03-08 05:00:00, 2026-03-09 04:00:00)` |
| Non-DST timezone | `IN`, `timezone=Asia/Kolkata` | `dayBoundsInTimezone('2026-03-08', snapshot.timezone)` is `[2026-03-07 18:30:00, 2026-03-08 18:30:00)` |
| Invalid stored timezone | `CO`, `timezone=Not/AZone` | `snapshot.timezone === 'America/Bogota'` from the profile |

`test:currency`, `test:country-localization`, `test:e2e-argentina-flow`, `test:issue-266-currency-symbol-print`, `test:first-run`, and `test:server-app-server-role` must keep passing — they are the regression fence for the surfaces this design does not touch. `currency.test.ts`'s "missing country defaults to IN" case is deleted; it encoded the behaviour this design removes.

## What this design does not change

- Which currency a country maps to (`COUNTRIES` in `main/countries.ts`) and the owner's ability to set a different valid ISO code in Business Settings.
- `business_day_start_time`. It travels with the timezone in `dayBoundsInTimezone()` but is an operational setting, not part of a store's regional identity.
- Tax, tax packs, and anything under `main/tax-packs/` (`AGENTS.md` invariant 3).
- Thermal, browser, and plugin-template print rendering, beyond losing their silent `'₹'` default (see the expansion rule).

## How to verify compliance

- `grep -rn "|| 'IN'\|?? 'IN'\||| 'INR'\|?? 'INR'\||| '₹'\|?? '₹'\||| 'Asia/Kolkata'\|?? 'Asia/Kolkata'\|getCountryByCode('IN')" main frontend/src shared --include='*.ts' --include='*.tsx'` returns nothing outside test files.
- `grep -n "'IN'\|'INR'\|'Asia/Kolkata'" main/db.ts` returns nothing in `seedInstallDefaults()`.
- `npm run test:currency`, `npm run test:first-run`, and `npm run test:server-app-server-role` pass.

## Decision record

- **Drafted:** 2026-09-18, as Phase 3 of the stabilization milestone. Supersedes the approach in PR #697 (closed); prerequisite for the fresh #693 implementation.
- **Approved:** 2026-09-18 by the product owner, with the rule that regional settings come only from signup and international conventions — no default country, no hard-coded symbol, no per-store override. The first draft's "fall back to the install default with a warning" and "stored symbol wins" rules were rejected and replaced by this version.
