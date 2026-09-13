# Support ticket log attachment — handoff for the floadmin/cloud service

**Status:** CURRENT — describes payload FloCafe now sends; for the team operating the
cloud endpoint FloCafe posts to (`POST /api/pos/support-ticket`), which lives outside
this repository.

## What changed

FloCafe's support ticket submission (`main/routes/support-ticket.ts`,
`main/services/cloud-sync.ts`) now optionally includes a `log_tail` field in the
ticket payload it delivers to the cloud endpoint. This is the desktop app's own
`electron-log` file content at submission time, attached when the user leaves the
"Attach log file" checkbox checked (on by default) in the support ticket form —
available both from the authenticated in-app Support page and from a new
unauthenticated "Submit Ticket" option on the login screen.

## Payload shape

The existing ticket payload gains one new, optional, top-level string field:

```json
{
  "client_ticket_id": "…",
  "subject": "…",
  "message": "…",
  "severity": "normal",
  "event_code": "support.bug",
  "correlation_id": "…",
  "contact": { "name": "…", "email": "…", "phone": "…" },
  "app_version": "3.8.5",
  "platform": "darwin",
  "diagnostics": { "...": "..." },
  "log_tail": "…plain text…"
}
```

- **`log_tail`** — plain UTF-8 text, or **absent** (not `null`, not `""`) when the
  user unchecked "Attach log file", or when this build predates this feature.
  Treat missing as "no log provided," not an error.
- Size cap: FloCafe truncates to the **most recent 200,000 characters** before
  sending (tail, not head — oldest lines are dropped first). Enforced both
  client-side (the log is read via IPC with the same cap) and again server-side in
  `submitTicketHandler` as a defense-in-depth measure. Expect payloads up to
  roughly 200 KB larger than before for tickets with a log attached.
- Format: raw electron-log line output (timestamp, level, message per line), the
  same format visible via the app's "Open Logs Folder" menu action. No
  compression, no structured/JSON framing — it's a plain text blob.

## Handling recommendations for the receiving side

1. **Treat as optional and backward-compatible.** Older FloCafe builds will never
   send this field; do not require it.
2. **Store like an attachment, not an indexed/searchable field.** It's arbitrary
   free text up to ~200 KB — store as a blob/file linked to the ticket record
   rather than inlining into a searchable ticket-body column.
3. **Apply the same retention and access policy as the rest of ticket data.**
   FloCafe's own privacy note shown to users says "no customer names, phone
   numbers, order contents, passwords, or API keys are included automatically" for
   the structured `diagnostics` block — but a raw log tail is a different
   guarantee. It can incidentally contain order IDs, customer-facing error
   strings, IP/hostname info, or (in a misbehaving future build) something more
   sensitive. Do not assume it is scrubbed; handle it with at least the same
   care as the rest of the support ticket (which already carries the customer's
   name/email/phone).
4. **No secrets by design, but verify.** FloCafe's own settings export already
   redacts credential-shaped values before they reach logs in normal operation
   (see `main/ipc.ts` `maskSetting`), so the log tail should not contain raw
   secrets in the common case — but this is a property of the sender, not
   something the receiver should rely on for anything security-critical.
5. **Size/rate limiting on your side is still worth having.** FloCafe rate-limits
   submission of the new unauthenticated pre-login path itself (5 tickets per
   15 minutes per IP, private IPs included), but that's a client-side control —
   apply your own ingestion limits as you would for any user-submitted content.

## Ingestion & storage recipe

Concrete steps for `POST /api/pos/support-ticket` to go from "JSON field" to
"a `.log` file a support agent can open":

1. **Re-check the size server-side, don't trust the client cap.** FloCafe
   truncates to 200,000 characters before sending, but a modified or future
   client could send more. Reject or hard-truncate anything over, say,
   256 KB before it touches storage:
   ```js
   const MAX_LOG_BYTES = 256 * 1024;
   const logTail = typeof body.log_tail === 'string'
     ? Buffer.from(body.log_tail, 'utf8').subarray(-MAX_LOG_BYTES).toString('utf8')
     : null;
   ```
2. **Write it as its own object, not a DB column.** Use whatever blob/object
   store you already use for other ticket attachments (S3-compatible bucket,
   GCS, Azure Blob, or a local/NFS attachments directory) — don't add a `TEXT`
   column to the tickets table for this. Suggested key/path convention, one
   file per ticket:
   ```
   support-tickets/<ticket_id>/app.log
   ```
   using the ticket's own id (`client_ticket_id`, already a UUID — safe to use
   directly as a path segment with no further sanitization needed beyond the
   UUID format check FloCafe already performs before accepting it).
3. **Set correct metadata on the object**, so it downloads/opens cleanly for a
   support agent:
   - `Content-Type: text/plain; charset=utf-8`
   - `Content-Disposition: attachment; filename="<ticket_id>.log"` (or a
     friendlier name like `<support_code>.log` once one is assigned)
4. **Record only a pointer on the ticket row**, e.g. add a nullable column such
   as `log_attachment_key` (the object storage key/path above) or a boolean
   `has_log_attachment` plus a lookup table if you support multiple
   attachments per ticket. Leave it `NULL`/`false` when `log_tail` was absent.
5. **Skip the write entirely when `log_tail` is absent** (undefined/null after
   step 1) — don't create empty placeholder objects.
6. **Surface it in the agent-facing ticket view** as a "Download log" action
   that streams the stored object with the headers from step 3, rather than
   inlining hundreds of lines of log text into the ticket detail page.
7. **Tie its lifecycle to the ticket's.** When a ticket is deleted or purged
   under your existing retention policy, delete the corresponding log object
   in the same operation — otherwise you accumulate orphaned blobs no ticket
   references.
8. **No parsing needed on your side.** It's a flat, human-readable log file
   (the same content a user would get from the app's "Open Logs Folder" menu
   action) — treat it as opaque text, not a format you need to parse or
   validate beyond size/type.

## Where this comes from in the FloCafe codebase

- `main/ipc.ts` — `get-log-tail` IPC handler reads the last 200,000 bytes of the
  current `electron-log` file.
- `frontend/src/components/support/SupportTicketForm.tsx` — the checkbox and the
  call to attach the tail before submission.
- `main/routes/support-ticket.ts` — `submitTicketHandler` accepts, caps, and
  forwards `body.log_tail`.
- `main/services/cloud-sync.ts` — `SupportTicketInput.log_tail` carries it through
  the local outbox into the payload posted to your endpoint.
