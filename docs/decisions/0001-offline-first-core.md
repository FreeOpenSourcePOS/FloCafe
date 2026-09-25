# 0001: Core POS operation is offline-first, and network features are optional

Status: Accepted
Date: 2026-09-25

## Context

FloCafe runs on a single computer on a merchant's premises. A café may have no internet
connection at all, or an intermittent one. Orders, billing, kitchen display, and printing are the
product; they cannot depend on a remote service being reachable.

At the same time FloCafe has accumulated real integrations with remote systems: Google Drive
backup, anonymous telemetry, store-attributed diagnostics, WhatsApp receipt delivery, and FloAdmin
cloud sync. Each of these is genuinely useful and none of them is required to take an order.

The tempting failure mode is that a new integration, added for its own sake, ends up on a path
that the POS depends on: awaited during startup, required before a bill can be paid, or retried
until it succeeds. Nothing about writing such code looks wrong locally, and on a developer machine
with good connectivity it works.

## Decision

Core POS operation is offline-first. Orders, billing, KDS, and printing function with no network
connectivity at all. Every network feature is optional, is enabled only when explicitly
configured, and degrades gracefully when the network is absent or the remote service is down.

Two conventions make this enforceable in practice:

1. **Optional services are started without `await` and wrapped in error handling.** In
   `main/index.ts`, `cloudSync.start()`, `telemetry.start()`, and `googleDrive.start()` are
   launched fire-and-forget. A slow or failing remote service delays nothing.
2. **The `FLO_E2E_SKIP_OPTIONAL_NETWORK` environment variable exists to disable mDNS, the
   updater, and the tax-pack catalog in tests.** It exists because those are the network
   dependencies that would otherwise make the test suite non-deterministic. Its presence in
   `main/index.ts` is the clearest evidence that these are genuinely optional rather than
   load-bearing.

## Consequences

Positive:

- The POS stays usable on a dead connection, which is the common case for a small merchant.
- Remote outages are never a local outage.
- The test suite runs deterministically without network access.

Negative:

- Every optional service must handle its own failure, retry, and user-facing error state. There is
  no single place that reconciles them.
- "Works on my machine" bugs in integration code are invisible locally, so each integration needs
  its own focused test coverage.

## Alternatives rejected

**Awaiting optional services during startup, with a timeout.** Rejected: a timeout still makes
startup latency depend on a remote system, and it turns a network problem into a startup problem.

**A single "connectivity" gate that enables a subsystem when the network is available.** Rejected:
it makes behaviour depend on a condition that is not observable up front, so the offline path is
the one that goes untested.

<!-- docs:policy-allow: past-tense-without-verification -->
