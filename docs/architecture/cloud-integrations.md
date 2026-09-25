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

**Enabled by** the `telemetry_enabled` setting. It ships **off**: a fresh install writes
`telemetry_enabled` as `'false'`.

**Offline behaviour.** Events are dropped, not queued. There is no telemetry outbox.

## Store-attributed diagnostics

A second, separate channel that attaches store identity to a diagnostic report, including system
diagnostics, optional device details, and a log tail.

**Enabled by** the `diagnostics_consent` setting, which is independent of the anonymous telemetry
toggle and ships **on**. A fresh install writes `diagnostics_consent` as `'true'`, and
`isDiagnosticsConsentEnabled()` treats anything other than the literal string `'false'` as consent.
It is surfaced in Settings, so a merchant can turn it off, but it is on unless they act.

This default is deliberate rather than a leftover, and it is the opposite of what an earlier
planning document in this repository claimed. Do not treat it as a bug to be fixed without a product
decision: changing it changes what a merchant sends by default.

**Offline behaviour.** Diagnostics are queued in the `store_diagnostics_outbox` table and flushed in
the background, so a diagnostic raised while offline is delivered when connectivity returns.

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

**Billing never blocks on the cloud.** A paid bill calls `cloudSync.reportDiagnostic()` on a
best-effort basis. A cloud failure cannot fail a sale.

**Offline behaviour.** `reload()` starts three interval flushers, for the sync outbox, the support
ticket outbox, and the diagnostics outbox. They are independent timers; one failing does not stop
the others, and each is a no-op without a configured API key.

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

The same tuple is what a support ticket carries in `correlation_id`, capped at 64 characters, so a
merchant-reported ticket can be matched to a log line.

## Verification

```sh
npm run test:google-drive
npm run test:telemetry
npm run test:support-ticket
npm run test:cloud-account-status
npm run test:recovery-cloud   # includes tests/cloud-deletion-recovery.test.ts
```
