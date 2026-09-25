# Locale & tax-plugin fields in telemetry/registration — handoff for the floadmin/cloud service

**Status:** CURRENT — describes payloads FloCafe now sends; for the team operating
the cloud endpoints FloCafe posts to (`POST https://telemetry.flopos.com/collect`
and `POST /api/pos/register`), which live outside this repository. Also covers
what FloAdmin's separate self-registration/signup portal should capture on its
own side, since that surface is not part of this repository either.

## What changed

FloCafe already reported a user-confirmed `country` on both the anonymous
telemetry ping and the FloAdmin registration call. It now also reports the
store's **currency**, **UI language**, and **active tax plugin** on both, so
FloAdmin can answer questions like "which UI language is most used" or
"which countries are running which tax pack" without joining against other
systems.

### 1. Telemetry payload (`POST /collect`)

Every event (`app_launch`, `daily_ping`, `feature_used`, `print_failed`, …)
gains three new, optional, top-level fields:

```json
{
  "anon_id": "…",
  "app": "flocafe",
  "app_version": "3.11.0",
  "event_type": "app_launch",
  "platform": "darwin",
  "country": "IN",
  "currency": "INR",
  "language": "hi",
  "tax_pack": { "id": "official-in", "publisher": "official" },
  "payload": { "...": "..." }
}
```

- **`currency`** — the store's configured ISO 4217-ish currency code (`settings.currency`,
  e.g. `"INR"`, `"USD"`). Present whenever the store has any currency configured;
  unlike `country`, this is not gated on an explicit confirmation stamp — FloCafe
  seeds it from the regional default during setup the same way it always has, and
  the existing `/api/pos/register` payload already reported it unconditionally.
- **`language`** — FloCafe's own UI language code (`settings.language`, e.g. `"en"`,
  `"es"`, `"hi"`, `"ar"`). This is the display language of the desktop app, not the
  OS locale (`os_locale`, already reported separately on registration) and not the
  billing/regional locale. See [i18n.md](i18n.md) for the set of supported codes.
- **`tax_pack`** — `{ "id": string, "publisher": string }` describing the currently
  **active** tax plugin for the store's confirmed country, or **absent** when none
  applies. Absent means one of:
  - taxes are disabled for the store (`settings.taxes_enabled !== 'true'`),
  - the store's country is unconfirmed (same withholding rule as `country` itself —
    see `main/services/country-provenance.ts`), or
  - only the bundled generic fallback pack is active (`publisher: "local"`) — this
    is FloCafe's built-in no-tax default and is deliberately never reported as a
    "plugin in use," since every unconfigured store would otherwise look identical.
  `id` is the tax pack identifier as installed locally (e.g. `"official-in"`,
  `"official-th"`, or a community pack's id); `publisher` is `"official"`,
  `"community"`, or a specific vendor name — see [tax-packs.md](tax-packs.md) for
  the full schema.

All three fields follow the same **optional/backward-compatible** rule as every
other telemetry field: older FloCafe builds simply won't send them.

### 2. Registration payload (`POST /api/pos/register`)

`body.business` already carried `currency`; it now also carries `language` and
`tax_pack` with the exact same semantics as above (`tax_pack` is `null` rather
than absent here, matching how this object already uses `null` for other unset
business fields):

```json
{
  "business": {
    "name": "…",
    "contact_name": "…",
    "email": "…",
    "phone": "…",
    "country": "IN",
    "country_source": "user",
    "os_country": "IN",
    "os_locale": "en-IN",
    "os_timezone": "Asia/Kolkata",
    "timezone": "Asia/Kolkata",
    "currency": "INR",
    "language": "hi",
    "tax_pack": { "id": "official-in", "publisher": "official" },
    "address": "…"
  }
}
```

This call fires on initial signup and again on every subsequent settings
change/startup refresh (`refreshRegistrationProfile()`), so FloAdmin will see
`language`/`tax_pack` update live as a merchant changes their UI language or
activates/switches a tax pack — not just once at signup.

## Handling recommendations for the receiving side

1. **Treat both new fields as optional and backward-compatible.** Older
   FloCafe builds and unregistered/pre-setup stores will omit or null them;
   do not require them.
2. **`tax_pack` is a compound value, not a flat string.** Store `id` and
   `publisher` as two columns (or a small JSON/jsonb column) rather than
   concatenating them, since `publisher` is the more useful group-by dimension
   (official vs. community packs) independent of which specific pack.
3. **Aggregate `language` and `currency` the same way you already aggregate
   `country`.** These are exactly what's needed to answer "which language is
   used most" — a simple `GROUP BY language` over the latest telemetry ping or
   registration row per `anon_id`/`pos_id` gives that directly.
4. **Prefer the registration payload as the source of truth for current state**
   (`pos_id`-keyed, updates on every refresh) and use telemetry pings for
   activity/liveness and event-level breakdowns — the two are complementary,
   not duplicates.
5. **No PII in any of the three new fields.** `currency`, `language`, and
   `tax_pack` are all low-cardinality configuration values, same privacy class
   as `country`/`platform`/`app_version` already in these payloads.

## Separate: what the self-registration/signup portal should capture

FloAdmin's own self-registration (signup) portal — the surface someone fills in
directly on floadmin.com/blue.flopos.com to create a cloud account, as opposed
to a FloCafe desktop install calling `/api/pos/register` on their behalf — is a
different codebase outside this repository, so FloCafe cannot make this change
for you. For the same "which language/currency/tax jurisdiction is most common"
reporting to work consistently across both signup paths, that portal should
independently capture and store, at signup time:

- **Country** the signer-up selects (or resolves via IP geolocation, mirroring
  the fallback FloCafe's own `country` omission already relies on).
- **Currency** they select or that's implied by their country.
- **UI language** the portal itself is being used in (its own i18n, if any) —
  this is a different signal from the FloCafe desktop app's `language` above,
  since a signup can happen before any FloCafe install exists.
- **Tax plugin/jurisdiction** they indicate interest in or that's implied by
  their country, if the portal asks about tax setup during signup.

These should land in the same reporting dimension/table as the FloCafe-sourced
fields above (e.g. a shared `country`/`currency`/`language`/`tax_pack` view
across both "registered via desktop app" and "registered via portal" rows) so
downstream analysis doesn't have to special-case the two intake paths.

## Where this comes from in the FloCafe codebase

- `main/services/telemetry.ts` — `sendEventImpl` adds `currency`, `language`,
  and `tax_pack` to every outgoing event.
- `main/services/cloud-sync.ts` — `CloudSyncService.register()` adds `language`
  and `tax_pack` to `body.business`.
- `main/services/tax.ts` — `isTaxModuleActiveForCountry()` and
  `getActiveCountryPack()`, the shared helpers both call sites use to resolve
  the active tax plugin.
- `main/services/country-provenance.ts` — the confirmed/default distinction
  that gates `country` (and, transitively, `tax_pack`) the same way it always
  has.
- Tests: `tests/telemetry-delivery.test.ts` and `tests/country-provenance.test.ts`
  cover the new fields on both payloads, including the "no official pack active"
  and "unconfirmed country" omission cases.
