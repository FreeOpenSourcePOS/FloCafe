# Cloud integrations

Every network feature FloCafe has, what it talks to, what enables it, and what happens when the
network is absent. The principle that keeps all of them optional is
[0001: offline-first core](../decisions/0001-offline-first-core.md); this page is the current
inventory, not the rationale.

All outbound work is either an outbox flush or a best-effort background task. Nothing on this page
sits on a path between an order and a paid bill.

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

## Store-attributed diagnostics

Diagnostics have a local support view and a separate automatic aggregate channel. Capture does not
depend on either transmission setting. The local `local_diagnostics` log is capped at 200 rows and
is available to staff with `support.use`; clearing it removes only local evidence. The legacy
`POST /api/diagnostics/event` intake remains for older callers, but is local-only and does not enqueue
its message or metadata for automatic transmission.

Automatic reports come from the closed capture registry in
[`main/lib/operation-failure.ts`](../../main/lib/operation-failure.ts). A report contains the
registered reason, operation, stage, classification, outcome, count, bounded time window, optional
UUID correlation references, and allowlisted facts. It contains no exception text, SQL, request path,
customer, order, or payment data. Frontend captures cover client-owned transport, recovery, and retry
storage failures; backend routes record authoritative operation failures. Legacy source-derived
signatures remain local support evidence and are never sent through the v2 automatic channel.

Backend capture points cover typed staff validation and administration safeguards, recovery races,
permission administration and input validation, customer validation and phone conflicts, product and
stock validation, category validation and delete safeguards, add-on validation and selection bounds,
inventory and supply movement queries, supply and recipe validation, linked-supply deletion, and
report date-range validation. Menu CSV imports capture malformed input and row rejections with only
bounded failed and changed-row counts; the outcome is `partial` only when the import actually changed
at least one row. Routine login failures, authentication middleware rejections, and ordinary empty query
results are not capture points. The typed list and exact tuple rules live in the source registry.

Reports are aggregated by UTC hour, sealed with immutable report IDs, and stored in
`store_diagnostics_outbox` before sending. The outbox holds at most 200 rows, and each flush sends at
most 20 reports. If reports are evicted, permanently rejected, or cannot be acknowledged, bounded
delivery-gap counters remain visible locally and are retried as safe aggregate reports when space is
available. Retries honor server `Retry-After` hints up to one hour. A report with an invalid or
mismatched acknowledgment is retained as a visible permanent rejection.

**Transmission gates.** Automatic delivery requires both `diagnostics_consent` and
`diagnostics_transmission_enabled`. The one-time upgrade migration enables transmission for
unconfigured legacy installs while preserving an explicit refusal; a fresh install receives the same
enabled default. A merchant can opt out through Settings. Consent changes synchronize with FloAdmin
using an idempotent change ID, and remote opt-out takes precedence over startup initialization. Cloud
deletion blocks all diagnostics delivery. With a configured signed cloud connection reports go to
FloAdmin. Without one, they use the anonymous collector only when `telemetry_enabled` is also on;
otherwise they remain local. Consent and transmission are separate from anonymous usage telemetry.

`GET /api/diagnostics/health` returns only typed queue counts, delivery-gap counts, consent state,
transport, and delayed status. It does not return report bytes or local error text. Support tickets
remain a separate user-initiated channel and their outbox is unaffected by diagnostics preferences.

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

Operation failures use a separate closed registry in `main/lib/operation-failure.ts`. A support
ticket can carry its validated operation UUID in `correlation_id` and the normalized tuple in
`diagnostics.operation_failure`, allowing staff to link the report to the same operation without
deriving context from ticket text.

## Verification

```sh
npm run test:google-drive
npm run test:telemetry
npm run test:support-ticket
npm run test:cloud-account-status
npm run test:recovery-cloud   # includes tests/cloud-deletion-recovery.test.ts
```
