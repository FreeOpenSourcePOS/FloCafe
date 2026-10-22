# Cloud integrations

Every network feature FloCafe has, what it talks to, what enables it, and what happens when the
network is absent. The principle that keeps all of them optional is
[0001: offline-first core](../decisions/0001-offline-first-core.md); this page is the current
inventory, not the rationale.

All outbound work is either an outbox flush or a best-effort background task. Nothing on this page
sits on a path between an order and a paid bill.

## Offline mode

The owner can switch every optional outbound connection off with the `offline_mode` setting
(`PUT /api/settings/offline-mode`, permission `offline-mode.manage`, Settings → Privacy). It is off
by default. `main/services/offline-mode.ts` exposes `isOfflineMode()`, which is also true when
`FLO_MATRIX_OFFLINE` is `1`. While it is on:

- FloAdmin cloud sync starts no timers and `trackedFetch` refuses every request.
- Google Drive scheduled backups do not run, and connecting, listing, backing up and restoring fail
  with the `offline` error code, and in-flight Drive work is cancelled. Disconnecting retains the
  local tokens and records the revoke as unconfirmed, which blocks further Drive access.
- WhatsApp closes its socket without unpairing, refuses to connect and does not start; turning the
  mode off reconnects it.
- Update checks report the `offline` update state, an in-flight update download is cancelled, and
  the startup tax pack check and the tax pack catalog download are refused.
- Telemetry, diagnostics and PostHog send nothing, and web image import returns `503`.

The Express API, KDS and Server App stay bound to `0.0.0.0`, so devices on the local network keep
working.

## Google Drive backup

Backs up the local database to a folder in the merchant's own Google Drive, and restores from it.

**Enabled by** an OAuth flow the merchant completes. The redirect is served from an ephemeral
loopback listener bound to `127.0.0.1` on a kernel-assigned port, and the authorization request uses
PKCE with `code_challenge_method: 'S256'`.

**Scope rule.** `DRIVE_FILE_SCOPE` is `https://www.googleapis.com/auth/drive.file`, requesting access
only to files the app creates, alongside `openid` and `email` for identity. The scope must not be
widened: `drive.file` is what keeps a compromised token from being able to enumerate the merchant's
whole Drive. Authorization URLs are additionally checked by `isSafeGoogleAuthorizationUrl()` before
the browser is opened.

**Credential storage.** Tokens are encrypted with Electron's `safeStorage` before being written, and
decrypted on read. Backup directories, including the staging area, are created with mode `0o700`.

**Warning gate.** Before a backup runs, the merchant must acknowledge a warning, recorded under the
`google_drive_warning_acknowledged` setting. A backup attempt without that acknowledgement fails
with `warning_acknowledgement_required`.

**Revoke on disconnect.** Disconnecting revokes the grant at Google rather than only deleting the
local token.

**Offline behaviour.** Every operation fails with a `driveError` code rather than hanging. The last
error code is persisted so the settings screen can explain the failure after a restart.

## Anonymous telemetry

Posts anonymous usage and error events to `https://telemetry.flopos.com/collect`.

**Enabled by** the `telemetry_enabled` setting, read as on when the value is `'true'`. It ships
**on** for a new install, which writes `telemetry_enabled` as `'true'`. An install that already
carries an explicit value keeps it, because the `telemetry_default_on_for_new_installs` migration
that flips the default uses `INSERT OR IGNORE`; an install that already ran the earlier
`seed_telemetry_settings` migration therefore still holds `'false'`.

**Offline behaviour.** Events are dropped, not queued. There is no telemetry outbox.

The same `telemetry_enabled` switch also gates PostHog usage events and the installation email,
described under PostHog below. The collector at `https://telemetry.flopos.com/collect` sends no name
and no email.

**Run mode and install source.** Every telemetry event and every FloAdmin registration carries two
provenance fields, so a merchant install is distinguishable from a developer's local run. `run_mode`
is `packaged` or `dev`, read from `app.isPackaged`. `install_source` is `github`, `ms_store`,
`mac_app_store`, `snap`, `appimage`, `flatpak`, `deb`, `rpm`, `linux_package`, or `dev`, resolved in
this order:

1. An unpackaged build reports `dev` for both fields, which also covers non-Electron hosts.
2. `process.windowsStore` -> `ms_store`; `process.mas` -> `mac_app_store`.
3. `SNAP` -> `snap`; `APPIMAGE` -> `appimage`; `FLATPAK_ID` -> `flatpak`. An empty or whitespace
   variable is not a signal.
4. `win32` or `darwin` -> `github`, the GitHub-release installers.
5. Anything else is a native Linux package, and its format is read from `/etc/os-release`:
   `ID` first, then the `ID_LIKE` family list, giving `deb` for the Debian/Ubuntu families and `rpm`
   for the RHEL/Fedora/SUSE families. Derivatives resolve through `ID_LIKE`, so Rocky or Linux Mint
   are classified without being listed themselves.

An unreadable or unrecognised `/etc/os-release` reports `linux_package`. That is a real value, not a
placeholder for "unknown": the distribution could not be identified, so the format is not guessed and
neither `deb` nor `rpm` is claimed. Detection is total - outside Electron, in unit tests and scripts,
it degrades to `dev` rather than throwing.

## PostHog

Optional product analytics and error tracking, next to the anonymous collector. The client sends
only when a project token and a host resolve. `readPostHogConfig()` in
`main/services/posthog-config.ts` takes the token from `FLO_POSTHOG_DEV_TOKEN` (development only),
then the `posthog_project_token` setting, then `posthog_project_token` in
`dist/main/build-identity.json`; the host comes from the `posthog_host` setting, then
`posthog_host` in `build-identity.json`, then the EU Cloud public capture host
`https://eu.i.posthog.com`. No migration seeds either setting. `scripts/copy-runtime-assets.cjs`
writes the build-time `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` into `build-identity.json`, and
only the release and Mac App Store workflows set them, so local builds and forks carry no token. No
environment variable configures the client at runtime other than the development overrides below.
A host that is not `http` or `https`, or that includes credentials, is ignored, and the client sends
nothing.

**Only released builds count.** `postHogEnvironment()` in `main/services/posthog-config.ts`
decides, and only for an Electron main process (`process.type === 'browser'`); test suites run as
plain Node and never connect, even when they stub `app.isPackaged`.

| Run                                                                               | Environment         |
| --------------------------------------------------------------------------------- | ------------------- |
| Packaged build whose `dist/main/build-identity.json` has `official_release: true` | `production`        |
| Any Electron run with `FLO_POSTHOG_DEV=1`                                         | `development`       |
| Anything else: `npm run dev`, local `release:*` packages, CI and matrix packages  | none; no connection |

`official_release` is written by `scripts/copy-runtime-assets.cjs` only when the build runs with
`FLO_OFFICIAL_RELEASE=1`, which only the release and Mac App Store workflows set. Every event and
the person carry `environment` and `release_channel` (`stable` or `beta`). In development,
`FLO_POSTHOG_DEV_TOKEN` (and optionally `FLO_POSTHOG_DEV_HOST`) sends to a separate project
instead of the release one. The client also sends nothing when `CI` is set, when
`FLO_MATRIX_OFFLINE` is `1`, or when the e2e harness is running (`E2E_TASK_LOCAL_PORTS`).

In the PostHog project, **Settings → Project → Filter out internal and test users** should exclude
person property `environment` = `development` and the team's email domain, with **Enable this
filter on all new insights** turned on.

Every event passes through `scrubPostHogEvent` in `shared/posthog-scrub.ts`, in the main process
(`posthog-node`) and in the renderer (`posthog-js`). It is an allowlist: an event name, property, or
person property it does not list is dropped. Every event carries `app_version`, `platform`,
`run_mode`, `install_source`, `environment`, and `release_channel`; `install_ref` is added at the
`anonymous` and `full` levels, and `store_ref` at `full` only (see **Sharing levels** below).

**Sharing levels** (`product_analytics_level`, read by `readProductAnalyticsLevel()` in
`main/services/posthog-identity.ts`).

| Level       | Distinct id          | Person properties                         | Links                                                                           |
| ----------- | -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `full`      | Account (`acct_`)    | Store email and store configuration       | `install_ref`, `store_ref`, `staff_ref`; the device is aliased into the account |
| `anonymous` | Device (`inst_`)     | Store configuration only, never the email | `install_ref`, `staff_ref`                                                      |
| `off`       | Per launch (`anon_`) | None                                      | None; only exceptions, when diagnostics transmission is on                      |

`telemetry_enabled` set to anything but `true` means `off`. Otherwise a stored `full` is `full`,
any other stored value is `anonymous`, and a store with no stored level is `anonymous` once
`onboarding_completed` is `true` and `off` before setup. `PUT /api/settings/product-analytics`
(`settings.manage`) stores the level and writes `telemetry_enabled` and `anonymous_data_consent`
(`false` for `off`, `true` otherwise), so the anonymous collector follows the same choice.
`product_analytics_level` is restore-protected like `telemetry_enabled`. The scrubber's
`accountLinked` option is on only at `full`; below it the scrubber drops `$create_alias`, any event
on an `acct_` id, and `email` and `store_ref` wherever they appear.

Setup asks for the level with two equal options, "Link my email" (`full`) and "Keep it anonymous"
(`anonymous`), plus "Don't share usage data" (`off`); none is preselected and setup cannot
continue without one. A setup request without a level stores none. An onboarded store with
telemetry on and no stored level, such as one upgraded from a release without PostHog, shares
anonymously and shows `ProductAnalyticsDialog` once to users with `settings.manage`. The dialog
opens outside POS and KDS, only when `readProductAnalyticsChoice()` reports `choice_pending` (a
configured client that can send), and offers the same two options with the error-report switch.
Closing it without an answer asks again on the next launch. Settings → Privacy offers all three
levels.

**Identities** (`main/services/posthog-identity.ts`). The collector keeps `telemetry_anon_id`;
PostHog does not use it.

| Id               | Value                                                                                                        | Lifetime                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Account (person) | `acct_` + 16 hex of SHA-256 over the lower-cased store email                                                 | Same for every terminal and every reinstall that uses that email       |
| Device           | `inst_` + 16 hex of SHA-256 over `posthog_install_seed`, a random UUID generated once and stored in settings | Same for the life of the database; a new database gets a new device id |
| Per launch       | `anon_` + a random UUID                                                                                      | One app launch                                                         |

At `full`, the account is the person once a store email exists. Main sends one `$create_alias`
that folds the device into the account (`posthog_aliased` records the pair), so events the device
sent at `anonymous` join the account. The first account key a database derives is kept in
`posthog_account_ref`, so editing the store email does not split the person; a reinstall derives it
again from the current email. At `anonymous`, main sets store configuration on the device person
with a `$set` event and never derives the account key. Moving from `full` to `anonymous` stops new
links; events already linked stay linked. At `off`, exceptions use the per-launch id with
`$process_person_profile` set to `false`. Stopping cloud services or requesting cloud deletion
turns telemetry off and rotates `telemetry_anon_id`, but `posthog_install_seed` does not rotate, so
a later opt-in on the same database links to the same device again.

Only the main process sets the person, on launch and when the level, email or store settings change.
The renderer does not call `posthog.init` until main returns the id over `get-posthog-bootstrap`;
init disables persistence and bootstraps that id, so the SDK cannot mint another one. Main checks
consent and the id on every send (cached for up to 30 seconds and invalidated immediately when
`settings` or `users` rows change via `getSettingsRevision()` or `invalidatePostHogConsentCache()`);
the renderer re-reads both every 30 seconds and on focus and
stamps the current id on each event, so a level change takes effect without a reload. When usage
and diagnostics were both off at load, the same check starts PostHog once either is turned on, and
the current screen is recorded then. At `off`, renderer events move to the per-launch id and the
scrubber drops `install_ref`, `store_ref`, and `staff_ref`; below `full` it drops `store_ref`. Only the Electron main window loads PostHog; the Server App,
KDS, and customer display do not.

**Staff are dimensions, not persons.** Many staff share one terminal, and group analytics is a paid
add-on, so a person is never a staff member. The renderer tags events with `staff_role` (the
signed-in role) and `staff_ref` (the first 16 hex characters of SHA-256 over the distinct id and the
user id), and drops both on logout; logout never changes the distinct id. One email shared by
several branches is one account; terminals are told apart by `install_ref`. A database restored
onto another terminal brings its seed, so both terminals share a device id.

**Usage follows the sharing level.** At `anonymous` and `full`:

- Person properties are store configuration (`country`, `currency`, `language`, `service_model`,
  `kds_enabled`), plus the store email at `full`. The email is `settings.email`, the store email
  cloud registration also sends, or the email of the earliest `users` row when that setting is
  empty. No name is sent.
- A usage event keeps only the properties in `POSTHOG_USAGE_PROPERTY_KEYS`; any other property is
  dropped.
- `app_launch` and `feature_used` mirror the collector events. `daily_ping` runs on the
  collector's hourly check but does not depend on the collector: it is sent at most once every 24
  hours (`posthog_last_daily_ping_at`) with counts for the last 24 hours (orders by type, including
  `online`, cancelled orders, paid bills, staff who rang up an order) and totals (active staff,
  products, tables, customers, printers, kitchen stations). `setup_completed` records the setup
  profile, service model, and business type. `first_order_created` and `first_bill_paid` are sent
  once per installation with `hours_since_setup`, read hourly from the database. A milestone older
  than the first check on this installation (`posthog_milestones_since`), such as an upgraded
  store's first order, carries `backfilled: true`.
- The renderer sends at most one `$pageview` per screen per staff member every 30 minutes
  (`shared/posthog-screen-views.ts`); views inside the window are folded into the next pageview's
  `repeat_views`. A screen is the route path with id-like segments removed, plus `settings_tab` on
  Settings. No other query value, hash, or title is sent.

At `off`, nothing is identified and no usage event or pageview is sent. Autocapture, heatmaps, dead clicks, performance events, session replay,
surveys, and feature-flag requests are off. `disable_external_dependency_loading` stops the renderer
SDK from loading remote scripts.

GeoIP enrichment is on in both SDKs (`posthog-node` needs `disableGeoip: false`), so PostHog adds
`$geoip_*` location properties from the store's public IP at ingestion. Whether the IP itself is
stored follows the project's IP data capture setting.

**Exceptions follow diagnostics transmission.** `isDiagnosticsTransmissionEnabled()` is the existing
"Sending diagnostics automatically" check: `diagnostics_consent` is on unless it is the string
`false`, and `diagnostics_transmission_enabled` must be the string `true`. A scrubbed exception is
sent when that check is on, at every sharing level. When the check is off, the
exception stays on the machine. The client itself is disabled only at `off` with diagnostics
transmission also off. `sendAnonymousDiagnosticReport` is unchanged and still requires
both checks.

| Capture point                             | Source                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uncaughtException`, `unhandledRejection` | Main process handlers in `main/index.ts`                                                                                                                |
| `renderer-autocapture`                    | Unhandled errors and rejections in the main window (bundled `posthog-js` extension, always loaded; the scrubber drops them while diagnostics is off)    |
| `react-error-boundary`                    | `reportRendererError`, called by the dashboard and global error boundaries                                                                              |
| `api-5xx`                                 | A local API response with status 500 or higher: method, route pattern (mount prefix included, also for errors from the global handler), and status only |

An exception keeps its type, a redacted first line of the message, the mechanism, and stack frames
with a project-relative file (`_next/static/...` for the packaged renderer), line, column, function
name, and chunk id. Message redaction replaces emails, URLs, quoted text, and digit runs. Request
params, query, body, digest, log tail, and any order or customer field are dropped. Release builds upload source maps when PostHog credentials are configured; see
[PostHog release builds](../maintainers/releases.md#posthog-release-builds).

**Offline behaviour.** Sends are best-effort. A failed send is dropped; there is no PostHog outbox,
and a send does not sit on the path between an order and a paid bill. Shutdown waits at most
`POSTHOG_SHUTDOWN_TIMEOUT_MS` (2 s) for pending events, so an unreachable host cannot hold up the
database close.

## Store-attributed diagnostics

Diagnostics have a local support view and a separate automatic aggregate channel. Capture does not
depend on either transmission setting. The local `local_diagnostics` log is capped at 200 rows. Its
access controls, legacy event intake, and clearing behavior are documented in the
[API reference](../reference/api.md#diagnostics).

Automatic reports come from the closed capture registry in
[`main/lib/operation-failure.ts`](../../main/lib/operation-failure.ts). A report contains the
registered reason, operation, stage, classification, outcome, count, bounded time window, optional
UUID correlation references, and allowlisted facts. It contains no exception text, SQL, request path,
customer or order identifiers, payment amounts, or transaction references. Frontend, Electron, and
backend capture call sites use the registry; it owns the exact list and normalized tuples. Legacy
source-derived signatures remain local support evidence and are never sent through the v2 automatic
channel.

Menu CSV imports capture malformed input and row rejections with only bounded failed and changed-row
counts; the outcome is `partial` only when the import actually changed at least one row. Routine
login failures, authentication middleware rejections, and ordinary empty query results are not
capture points.

Reports are aggregated by UTC hour, sealed with immutable report IDs, and stored in
`store_diagnostics_outbox` before sending. The outbox holds at most 200 rows, and each flush sends at
most 20 reports. If reports are evicted, permanently rejected, or cannot be acknowledged, bounded
delivery-gap counters remain visible locally and are retried as safe aggregate reports when space is
available. Retries honor server `Retry-After` hints up to one hour. A report with an invalid or
mismatched acknowledgment is retained as a visible permanent rejection.

**Transmission gates.** Automatic delivery requires both `diagnostics_consent` and
`diagnostics_transmission_enabled`. The one-time upgrade migration enables transmission for
unconfigured legacy installs that already have users while preserving an explicit refusal; a fresh
install keeps transmission off until the merchant opts in through Settings. A merchant can change the
choice at any time through Settings. Consent changes synchronize with FloAdmin
using an idempotent change ID, and remote opt-out takes precedence over startup initialization. Cloud
deletion blocks all diagnostics delivery. With a configured signed cloud connection reports go to
FloAdmin. Without one, they use the anonymous collector only when `telemetry_enabled` is also on;
otherwise they remain local. Consent and transmission are separate from anonymous usage telemetry.

The health endpoint's response contract is documented in the
[API reference](../reference/api.md#diagnostics). Support tickets remain a separate user-initiated
channel and their outbox is unaffected by diagnostics preferences.

## WhatsApp receipt delivery

Sends a receipt to the customer's phone number over WhatsApp.

**Enabled by** the merchant through the WhatsApp settings route, which calls `enable()`. The module
starts with `state.enabled` false, so nothing is connected until a merchant turns it on.

Receipt outcome is summarised on the order as `whatsapp_receipt_status`, which `GET /api/orders`
returns per order.

**Offline behaviour.** No work is started when the module is disabled, when it is in a terminal
shutdown state, or when the request signal is aborted. Work already in flight is cancelled during
shutdown rather than left to fail late.

**Credential handling.** The session directory is created with mode `0o700`. The session credential
is not encrypted at rest, which is a deliberate consequence of the library FloCafe uses for the
WhatsApp protocol and is a reason the containing filesystem matters.

## FloAdmin cloud sync

Optional synchronisation with the FloAdmin back office, plus account deletion and recovery.

**Enabled by** `cloud_sync_enabled`, which ships **on**: a fresh install writes it as `'1'`. Other
flags in the same group are `cloud_orders_enabled`, `cloud_reports_enabled`, and
`cloud_command_polling_enabled`.

**Upgrade behaviour.** Migration 40, `v2_cloud_defaults_and_tax_toggle`, flips a store that had
`cloud_sync_enabled` set to `'0'` back on, but only when the setting's `updated_at` still lacks a
`T`. Seed-written SQLite timestamps have no `T`; an ISO timestamp means a merchant deliberately
changed it. The discriminator is that timestamp shape, and the migration deletes the obsolete
`cloud_pending_store_id` setting in the same step.

**Registration is zero-touch.** `start()` calls `maybeAutoRegister()` once at boot. The code states
the contract directly: the v2 endpoint creates or finds the live store and returns a working API
key immediately, so **there is no claim step, no pending state, and no human approval**. The
`cloud_registration_status` values in use are `unregistered`, `registered`, `registration_failed`,
`deletion_pending`, and `deleted`.

**One stale claim message survives.** `mobilePairingErrorMessage()` in
[`main/routes/index.ts`](../../main/routes/index.ts) still tells a merchant that the POS "hasn't
been claimed in FloAdmin yet" and to complete registration there, returned with HTTP 409 when the
backend reports the store is not registered. That message contradicts the zero-touch behaviour
above: the merchant has nothing to claim. The message is reachable from the mobile pairing
endpoint, so this is shipped behaviour, not dead text. Treat it as a product-copy bug to raise
separately, not as a description of how registration works.

**Payment outcomes stay local-authoritative.** Payment routes capture typed diagnostics only after
the operation's outcome is known. A rollback is recorded as not applied; a notification failure
after commit is recorded as applied. Captures are queued asynchronously, and delivery does not
participate in the bill transaction or change its financial result.

**Offline behaviour.** `reload()` starts the signed sync and support-ticket flushers when cloud sync
is configured. The diagnostics flusher runs when consent and transmission are enabled and either a
signed connection or permitted anonymous telemetry is available. It uses its own timer and does not
require an API key for the anonymous path. A failure in one flusher does not stop the others.

**Deletion and recovery.** A deletion request puts the store into `deletion_pending` or `deleted`.
`isCloudDeletionBlocking()` reports whether the current status blocks normal cloud work, and while
it does, `start()` returns without starting and queueing refuses with `queued: false`. Deletion
clears `cloud_sync_outbox`, `support_ticket_outbox`, and `store_diagnostics_outbox` together, so a
store that has asked for deletion is not holding queued payload for it.

## RevFlo pairing

RevFlo is the mobile companion app, and pairing happens through a pairing code the store issues and
the phone redeems.

`getCachedPairingCode()` and `setCachedPairingCode()` in
[`main/db.ts`](../../main/db.ts) keep the code locally under the `mobile_pairing_code` and
`mobile_pairing_code_expires_at` settings, with an expiry. The code is stored in plaintext: the
cloud returns it exactly once, so the local copy is the only one, and the code is short-lived and
useless without the store's API key. Both settings are cleared as part of the cloud data deletion
path.

Issuing a pairing code is the endpoint that returns the stale claim message described above, and
its failure is reported as HTTP 409 for an unregistered store and HTTP 502 for any other cloud
failure, so a connectivity problem is distinguishable from a registration problem.

## Support ticket outbox

A support request is written to the `support_ticket_outbox` table with a `status` of `pending`,
`sending`, `delivered`, or `failed`, plus `attempt_count`, `next_attempt_at`, and `last_error`. The
endpoint returns HTTP 202 when the ticket was queued and HTTP 503 when it could not be, so the
merchant gets a distinct answer for "saved, will send later" and "not accepted".

### The `log_tail` field

A ticket may carry a `log_tail` string holding the tail of the current session's log file.

- **Cap.** `LOG_TAIL_MAX_BYTES` is 200,000. The tail is cut from the end, keeping the most recent
  bytes, in both the IPC handler and the route.
- **Window.** `LOG_TAIL_MAX_AGE_MS` is 7 days. The cut is made at the first line whose timestamp
  falls inside the window, not at a byte offset, so a quiet store's log is not cut mid-record. The
  byte cap is the backstop when the windowed content is still large.
- **Absent, not null.** A ticket with no log tail omits the field rather than sending an empty
  string. `logTail` is `undefined` when the request body has no non-blank `log_tail`.
- **Where it is persisted.** In the outbox row's `payload`, alongside the ticket's other fields,
  and sent by `queueSupportTicket()` as the `log_tail` property.

**There is no test covering `log_tail`.** `grep -rn "log_tail\|get-log-tail" tests/` returns
nothing: the 200,000-byte cap, the 7-day window, and the absent-not-null semantics are unenforced
by the suite, and a change to any of them would not be caught. This is a coverage gap, not a
statement that the behaviour is wrong.

### Linking a ticket to a known operation failure

When a cashier opens help from a structured failure, `POST /api/support-ticket` may include a
top-level `operation_failure` object:

```json
{
  "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
  "client_ticket_id": "a stable UUID for this ticket submission",
  "operation_failure": {
    "capture_point": "fc.backend.payment.create.validation",
    "operation_id": "550e8400-e29b-41d4-a716-446655440000",
    "outcome": "not_applied",
    "facts": { "display_code": "customer_mismatch" }
  }
}
```

`operation_id` must be a UUID and must exactly match the top-level `correlation_id`. The server
validates the capture point, outcome, and optional facts against its closed operation-failure
registry, then stores the normalized tuple under `diagnostics.operation_failure`. The normalized
tuple contains the server-owned reason, operation, stage, classification, outcome, correlation ID,
and validated facts; callers cannot supply or override those fields. Invalid or unregistered
context is rejected without queuing a ticket. `client_ticket_id` remains the independent replay key,
so retrying the same ticket does not replace its original correlation or operation context.

Tickets without `operation_failure` retain the existing manual-help contract. The optional
structured context does not add raw automatic logs or change the permission required to submit a
support ticket.

## Error taxonomy and correlation

[`main/errors.ts`](../../main/errors.ts) gives every network operation a `FloErrorCode` and a
`correlationId`.

- `FloErrorCode` is a template-literal union namespaced by subsystem: `print.`, `tax.`,
  `migration.`, `backup.`, `cloud.`, and `update.`. A new subsystem adds a namespace rather than a
  new ad hoc string.
- `correlationId()` returns a `randomUUID()`.
- `correlatedError(code, message, cause?)` builds an error named `FloOperationError` carrying the
  code, the correlation id, and optionally the cause.
- `errorDetails(error, fallbackCode)` reads a code and correlation id off any thrown value, falling
  back to a supplied code and a fresh correlation id, and always returns a `message`.

For support-ticket correlation, see
[Linking a ticket to a known operation failure](#linking-a-ticket-to-a-known-operation-failure).

## Verification

```sh
npm run test:google-drive
npm run test:telemetry
npm run test:support-ticket
npm run test:cloud-account-status
npm run test:cloud-live-orders-batching
npm run test:recovery-cloud   # includes tests/cloud-deletion-recovery.test.ts
```
