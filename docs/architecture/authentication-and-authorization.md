# Authentication and authorization

FloCafe authorizes in the backend. The renderer renders, and never decides. This page describes the
authentication lifecycle, the shape of the authorization surface, the configurable permission
layer, and the boundaries the product deliberately leaves open.

For the in-app permission editor and UI capability matrix, see
[the roles and permissions reference](../reference/roles-and-permissions.md). For the product rules
that constrain authorization, see
[the product invariants reference](../reference/product-invariants.md).

## Roles

FloCafe has five fixed staff identities, declared in
[`shared/role-permissions.ts`](../../shared/role-permissions.ts): `owner`, `manager`, `cashier`,
`server`, and `chef`. The identity a request acts under is read from the `users.role` column at
request time, not from the token, and there is no role editor — an install cannot add a sixth
identity or rename one.

What each identity is *allowed to do* is a separate, configurable layer. See
[Configurable permissions](#configurable-permissions) below.

`shared/role-permissions.ts` also exports `ROLE_ACCESS`, a map of nine named role groups. Those
groups now serve two purposes: they are the *shipped default* `defaultRoles` values in
[`shared/permissions.ts`](../../shared/permissions.ts) (`PERMISSION_DEFINITIONS`), and they remain
the direct gate for the small set of context-policy checks described below that are role-based by
product decision rather than by omission.

## Configurable permissions

Almost every protected action — 245 call sites — is gated by `requirePermission(id)` or
`requireAnyPermission(...ids)` from
[`main/services/authorization.ts`](../../main/services/authorization.ts), not by a fixed role
list. `requireRole` (in `main/middleware/security.ts`) still exists, but a static audit test
(`tests/authorization-static-audit.test.ts`) fails the build if a new call site under
`main/routes/` uses it; the few remaining direct role checks are reviewed context policy, covered
in their own sections below (KDS station/category scope, refund approver identity, the
override-PIN holder for item cancel/void, and the last-active-owner/staff-target rule).

**Resolution.** For every permission id, `resolveEffectivePermissions(userId)` evaluates, in
order: the protected-owner rule (for `authorization.manage` and `staff.privileged.manage` only,
always true for an active owner and never grantable to anyone else); an explicit user override;
an explicit role override; then the shipped default. It re-reads current SQLite state — an
`Authorization` header's JWT role claim is never authoritative, and neither is a cached
`permission_ids` list. `hasPermission(userId, id)` and `requirePermission(id)` are thin wrappers
around this resolver; `requireAnyPermission(...ids)` passes if any one resolves true.

**Storage.** `role_permission_overrides` and `user_permission_overrides` are sparse override
tables (schema migration v93): a missing row means "use the shipped default," so a permission
introduced by a later upgrade is judged on its own reviewed default rather than inheriting
whatever an old override happened to resolve to. `authorization_audit_log` records every write:
actor, target (role or user), permission id, previous effect, next effect. Writes go through the
owner-only `/api/authorization` API, one SQLite transaction per save, gated on a last-seen
`revision` string to reject a stale concurrent editor with `409` instead of silently overwriting
it.

**Migration guarantee.** The shipped defaults in `PERMISSION_DEFINITIONS` were derived from the
`ROLE_ACCESS` groups the routes used before this layer existed, so an installation with zero
override rows resolves identically to the fixed-role system it replaced. `authorization.manage`
and `staff.privileged.manage` are the two exceptions: they are `configurable: false` and always
resolve for an active owner, so an override can never remove the last administration path or hand
owner/manager account control to another role.

See [the roles and permissions reference](../reference/roles-and-permissions.md) for the editor
itself, the full permission catalog rendered as a matrix, and the owner-only management API.

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

There is no single authorization layer to read. Authorization is expressed as roughly 245
`requirePermission(`/`requireAnyPermission(` call sites across `main/routes/`, plus a small,
reviewed set of direct role checks left in place as context policy (see
[Configurable permissions](#configurable-permissions)). A gate is not the only way access is
checked. This section exists because the shape matters when you change an endpoint, not because
the count does — unlike the fixed-role predecessor, the count moves in both directions as an
owner-configurable feature area is added or a formerly-fixed check gets its own permission id.

**Router-level gates.** The common case. `requirePermission(id)` is a factory that returns Express
middleware and must follow `requireAuth`. It answers 401 when there is no authenticated user and
403 when the resolved effective permission set does not include `id`.

**Inline gates on the app object.** Nine endpoints are registered directly on `app` rather than on
a router, in [`main/routes/index.ts`](../../main/routes/index.ts). A static search for
`router.<verb>` does not find them.

**Gates inside transaction bodies.** The most important case. Some endpoints perform the
permission check inside the `withTxn` callback, after the transaction opens, using
`hasPermission(actorId, id)` against state read in the same transaction. `PATCH
/api/orders/:orderId/items/:itemId/cancel` and the matching `.../restore` endpoint do this, and
the override-PIN path additionally requires the presenting user to satisfy `hasRole(role,
ROLE_ACCESS.ownerManager)` — a deliberate context-policy role check, not a permission, because the
override PIN belongs to a person acting in an owner/manager capacity regardless of what their
`orders.item.void`/`orders.item.restore` grant says. The check cannot be hoisted into middleware
without changing the read the decision is based on, and it is invisible to anything that inspects
the route's middleware chain.

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
| `:3002` | `requireAuth` closure inside the server factory in [`main/kds-server.ts`](../../main/kds-server.ts) | Revocation, verify, uncached user lookup, staleness, then `hasPermission(user.id, 'kitchen.use')` and station resolution. |
| `:3003` | `requireServerAppAuth` in [`main/server-app.ts`](../../main/server-app.ts) | 404-when-disabled, then revocation, verify, uncached user lookup, staleness, then `hasPermission(user.id, 'server-app.use')`. |

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

KDS access requires `hasPermission(userId, 'kitchen.use')` (shipped to owner, manager, chef, and
independently configurable) and is then narrowed twice more, in
[`main/services/kds.ts`](../../main/services/kds.ts).

**Category narrowing.** Whether the caller is unrestricted is decided by
`hasRole(role, ROLE_ACCESS.ownerManager)` — a deliberate role check, not a permission, because
category scope is about which identity the KDS trusts to see the whole kitchen, independent of
whatever `kitchen.use` an owner may have granted to some other role. Owner and manager receive an
empty `categoryIds` array, which means unrestricted. A chef receives the `category_ids` recorded on
the user row. A chef whose item's category is not in that list is refused.

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

The standalone Server App on `:3003` is a filtered proxy. It is gated twice: `hasPermission(user.id,
'server-app.use')`, shipped by default to server, manager, and owner and independently
configurable, and when the feature is disabled every route returns 404 rather than 403, so a
disabled surface is not discoverable. The 404 check appears in three places in
`main/server-app.ts`, including the one that decides whether a path is proxied at all.

## Audit attribution

Every write records the authenticated actor. `order_audit_log` stores `actor_user_id`, `action`,
and a details payload per order or order item, indexed on both the order and the actor. Stock
movements record the same attribution: `applyStockChange` and `applySupplyStockChange` both require
an `actorUserId` and throw rather than write a movement without one.

This is the answer to "who did this", and it is why orders are not hidden between staff. The
authorization model restricts by permission and, for kitchen work, by station and stage. It does
not restrict by who created a record. See
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
