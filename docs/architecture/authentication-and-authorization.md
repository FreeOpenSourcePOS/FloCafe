# Authentication and authorization

FloCafe authorizes in the backend. The renderer renders, and never decides. This page describes the
authentication lifecycle, the shape of the authorization surface, and the boundaries the product
deliberately leaves open.

For the in-app UI capability matrix, see
[the roles and permissions reference](../reference/roles-and-permissions.md). For the product rules
that constrain authorization, see
[the product invariants reference](../reference/product-invariants.md).

## Roles

FloCafe has five fixed staff roles, declared in
[`shared/role-permissions.ts`](../../shared/role-permissions.ts): `owner`, `manager`, `cashier`,
`server`, and `chef`. There is no role editor, no permission toggle, and no IAM layer. The role a
request acts under is read from the `users.role` column at request time, not from the token.

The same file also exports `ROLE_ACCESS`, a map of nine named role groups that both the backend
middleware and the renderer use. Route gates pass a group, for example
`requireRole(...ROLE_ACCESS.ownerManager)`, so the route gate and the displayed matrix are derived
from one list rather than from two.

## JWT lifecycle

**Secret.** `getJWTSecret()` in
[`main/routes/auth.ts`](../../main/routes/auth.ts) reads `process.env.JWT_SECRET` when set and
otherwise reads the `jwt_secret` row in the `settings` table, generating one on first launch. The
value is cached in a module-level variable, so each install has its own secret and a token from
one install does not validate against another.

**Issuance.** `jwt.sign` runs on login and on the token-refresh paths. A token without the remember
option expires in 24 hours; with it, in 10 days.

**Verification.** `requireAuth` in
[`main/server.ts`](../../main/server.ts) guards paths under `/api`. It passes through `/api/health`,
everything under `/api/auth` (which verifies its own tokens), product image GETs, and a fixed list
of pre-login support-ticket paths. Those pre-login paths are matched by exact path and by a UUID
pattern rather than by prefix, so a look-alike path cannot skip authentication.

A request that presents a bearer token is rejected unless all of the following hold:

1. `isTokenRevoked(token)` is false.
2. `jwt.verify` succeeds against the install secret.
3. `getUserAuthStatus` reports an existing, active user.
4. `isTokenStale(decoded.iat, tokensValidAfter)` is false.

**Revocation.** `revokeToken` records the SHA-256 hash of the token in the `revoked_tokens` table
with the token's expiry, so revocation stops mattering on its own. A `Set` of raw tokens in memory
is the fast path, bounded at 5,000 entries. `isTokenRevoked` fails closed: if the database lookup
throws, the token is rejected rather than accepted.

**Staleness.** `tokens_valid_after` on the `users` row is compared against the token's `iat` at
second resolution. A password or PIN change bumps this column, which invalidates every token
issued before it without needing to enumerate them.

**Role freshness.** The role attached to the request is the value read from the database, not the
role claim inside the token, so a role change takes effect on the next request. `getUserAuthStatus`
caches active status, role, and `tokens_valid_after` for 30 seconds to bound how long a deactivated
or demoted user's tokens keep working. KDS, kitchen, and order-item requests pass `fresh: true` and
bypass that cache, because a stage transition that a demoted chef can still perform is a real
security gap.

## The shape of the authorization surface

There is no single authorization layer to read. Authorization is expressed as roughly 225
`requireRole(` call sites across 31 files in `main/routes/`, and a route gate is not the only way a
role is checked. This section exists because the number matters when you change an endpoint.

**Router-level gates.** The common case. `requireRole` is a factory that returns Express middleware
and must follow `requireAuth`. It answers 401 when there is no authenticated user and 403 when the
role is not in the allowed list.

**Inline gates on the app object.** Nine endpoints are registered directly on `app` rather than on
a router, in [`main/routes/index.ts`](../../main/routes/index.ts). A static search for
`router.<verb>` does not find them.

**Gates inside transaction bodies.** The most important case. Some endpoints perform the role check
inside the `withTxn` callback, after the transaction opens, using the actor's role read from the
database in the same transaction. `PATCH /api/orders/:orderId/items/:itemId/cancel` and the matching
`PATCH /api/orders/:orderId/items/:itemId/restore` endpoint do this. The check cannot be hoisted
into middleware without changing the read the decision is based on, and it is invisible to
anything that inspects the route's middleware chain.

**KDS WebSocket authorization.** The KDS socket authenticates with the same bearer token but
authorizes per message. See below.

### Three separate token-verification middlewares

`isTokenRevoked`, `isTokenStale`, `getJWTSecret`, `rateLimit`, `authRateLimit`, and
`staticRouteRateLimit` are exported from one module and imported by all three servers, so the
primitives are shared. The *middleware body* that sequences them is not: each server writes its
own.

| Server | Middleware | Shape |
| --- | --- | --- |
| `:3001` | `requireAuth` in [`main/server.ts`](../../main/server.ts) | Guards `/api`, with an unauthenticated-path allowlist, then revocation, verify, cached user lookup, staleness. |
| `:3002` | `requireAuth` closure inside the server factory in [`main/kds-server.ts`](../../main/kds-server.ts) | Revocation, verify, uncached user lookup, staleness, then the kitchen role check and station resolution. |
| `:3003` | `requireServerAppAuth` in [`main/server-app.ts`](../../main/server-app.ts) | 404-when-disabled, then revocation, verify, uncached user lookup, staleness, then the Server App role check. |

The three already differ in one observable way. `:3001` reads user active status, role, and
`tokens_valid_after` through `getUserAuthStatus`, which caches for 30 seconds. `:3002` and `:3003`
query the `users` row on every request and do not cache.

That divergence is a correctness risk, not a style preference. A change to the order of the checks,
to the status codes, or to the role gate has to be made in three places, and the three are free to
drift apart without any test failing. Treat them as a set. Note also that `:3002` re-checks
`is_active`, revocation, and staleness a second time inside its status-update transaction
(`main/kds-server.ts:410`), which is a defence in depth rather than a duplicate bug.

## Master PIN as a second factor

The master PIN is a 4-digit PIN, separate from a staff password, used to gate destructive
operations. It is enforced by `requireMasterPin` in
[`main/middleware/master-pin.ts`](../../main/middleware/master-pin.ts), which delegates the decision
to `authorizeMasterPin` in
[`main/services/master-pin.ts`](../../main/services/master-pin.ts).

`authorizeMasterPin` is a fail-closed ladder, in order:

| Condition | Result |
| --- | --- |
| OS-backed encryption unavailable | 503, and the gated operation is blocked rather than allowed through |
| PIN not set on this device | 409 |
| Rate limit reached for this key | 429 |
| PIN absent, not a string, or not exactly 4 digits | 403 |
| PIN does not verify | 403, and the attempt is recorded; 429 once the limit is reached |

The PIN hash is stored through Electron `safeStorage` in `master-pin.enc` under the app's
`userData` directory, written with mode `0o600`. Rate limiting is in memory, keyed by IP and route
path, at 5 attempts per 15 minutes.

The rate-limit key includes the route, so attempts against one endpoint do not consume another's
budget. A caller with a different route can therefore attempt the PIN 5 times per route. That is
the intended scoping, not an oversight.

## KDS station and category narrowing

KDS access is role-gated to `ROLE_ACCESS.kitchen` (owner, manager, chef) and then narrowed twice
more, in [`main/services/kds.ts`](../../main/services/kds.ts).

**Category narrowing.** Owner and manager receive an empty `categoryIds` array, which means
unrestricted. A chef receives the `category_ids` recorded on the user row. A chef whose item's
category is not in that list is refused.

**Station narrowing.** The user's assigned stations come from `getUserKdsStationIds`. If station
assignments are configured for the user and the resolved list is empty, authentication fails rather
than granting unrestricted access. An exception is thrown if the station lookup itself returns
`null`, so a failed query is an error, not a grant.

**The gate is re-read inside the transaction.** The station decision for a status update is made
inside a `withTxn` callback, after resolving the order's `kitchen_station_id` and calling
`getKdsStationRoutingScope` and `isKdsStationItemAllowed`. Re-reading inside the transaction is what
makes the decision correct against the data being written. Do not cache the station scope across
the transaction boundary or move this check above it.

## Server App authorization

The standalone Server App on `:3003` is a filtered proxy. It is gated twice: the role list is
`ROLE_ACCESS.serverApp` (server, manager, owner), and when the feature is disabled every route
returns 404 rather than 403, so a disabled surface is not discoverable. The 404 check appears in
three places in `main/server-app.ts`, including the one that decides whether a path is proxied at
all.

## Audit attribution

Every write records the authenticated actor. `order_audit_log` stores `actor_user_id`, `action`,
and a details payload per order or order item, indexed on both the order and the actor. Stock
movements record the same attribution: `applyStockChange` and `applySupplyStockChange` both require
an `actorUserId` and throw rather than write a movement without one.

This is the answer to "who did this", and it is why orders are not hidden between staff. The
authorization model restricts by role and, for kitchen work, by station and stage. It does not
restrict by who created a record. See
[the product invariants reference](../reference/product-invariants.md).

## Fail-closed inventory behaviour

Two inventory services write append-only movement ledgers, and both refuse to write a row without
attribution:

- `adjustProductStock` in `main/services/inventory.ts` throws a 400 `InventoryServiceError` when
  `actorUserId` is missing, before any `UPDATE`.
- `applySupplyStockChange` in `main/services/supplies.ts` throws a 400 `SupplyServiceError` when
  `actorUserId` is missing, and resolves the resulting stock level inside the caller's
  transaction.

Recipe depletion uses a snapshot rather than a live recipe. `buildRecipeSnapshot` captures the
components scaled to the ordered quantity, and `applyRecipeSnapshot` applies the deltas from that
snapshot. A recipe edited after an order was placed does not change what that order consumes.
`parseRecipeSnapshot` returns `null` for anything it cannot parse, so a corrupt snapshot skips
depletion instead of guessing at quantities.

## Boundaries we do not harden

These are deliberate product decisions, not gaps that were overlooked. Each one is a place where
FloCafe relies on the deployment environment rather than on the application.

**LAN traffic is unencrypted.** The API server binds `0.0.0.0` and speaks HTTP and unencrypted
WebSocket. The CORS origin check restricts which browser origins may call the API, and CORS is not
transport security: it does not stop an attacker on the same network from reading a bearer token
from the wire. The deployment rule is to treat the LAN as trusted. Do not expose the API or KDS
port to a guest or shared network.

**The renderer sandbox is disabled.** The main window sets `sandbox: false`, and the Windows build
appends Chromium's `disable-gpu-sandbox` switch as a compatibility workaround.
`contextIsolation: true`, `nodeIntegration: false`, the CSP, and the external-window URL allowlist
carry the isolation instead. A renderer compromise has less process isolation than Electron's
preferred configuration.

**The WhatsApp session is not encrypted at rest.** `main/services/whatsapp.ts` creates the
credential directory with mode `0o700`, so another OS user cannot read it, but the session files
themselves are not encrypted with the OS keychain. Malware or another process running as the same
user can copy the linked session.

**Inline script is allowed by the Content Security Policy.** `main/csp.ts` emits
`script-src 'self' 'unsafe-inline'`. Remote script and `eval` are blocked; inline script is not.
`connect-src` is widened to the request's own origin when the `Host` header matches a safe pattern,
so that LAN devices can connect. The policy is pinned by `tests/csp-lan-header.test.ts`.

**Rate limiting is asymmetric.** The general API limiter in `main/middleware/security.ts` bypasses
requests from private, loopback, and Tailscale addresses, because a busy in-store POS and a
kitchen display share one network. The authentication limiter deliberately does not: it sets
`bypassPrivateIp: false`, so login attempts from a LAN address are limited like any other. A rate
limit that exempted the LAN would exempt exactly the attacker standing next to the till.
