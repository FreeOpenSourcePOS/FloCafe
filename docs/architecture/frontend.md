# The frontend

The renderer is the Next.js application in [`frontend/`](../../frontend). This page describes what
that code is allowed to do: the boundary a new screen sits behind, how it decides what a user may
see, what it may ask the host for, and where its state, its printing, and its messages live.

Three subjects it does not own are documented elsewhere. The build-time fork, the IPC handler
inventory, the title bar, and the Content Security Policy belong to
[Desktop build and window surfaces](desktop-build.md). The permission catalog, its resolution
order, and the in-app editor belong to
[Roles and permissions](../reference/roles-and-permissions.md). The backend enforcement surface
belongs to [Authentication and authorization](authentication-and-authorization.md). The print
kernel, its renderers, and its transports belong to [Printing architecture](printing.md), and the
message model belongs to [Internationalization](internationalization.md). This page covers the
renderer side of each and links out for the rest.

## What the renderer is

`frontend/src` is a client-only application. There is no server-side execution of any kind in the
build the application ships.

### The static-export boundary

[`frontend/next.config.ts`](../../frontend/next.config.ts) reads `NEXT_BUILD_MODE`. The root
`build:frontend` script sets it to `desktop`, which switches `output` to `'export'`, sets
`trailingSlash` to true, and sets `images.unoptimized` to true. The result is static HTML, CSS, and
JavaScript in `frontend/out/`, served as files by three local servers:

| Server                                           | Default port                 | Serves                                      |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------- |
| [`main/server.ts`](../../main/server.ts)         | `PORT`, else 3001            | the API under `/api` and the exported pages |
| [`main/kds-server.ts`](../../main/kds-server.ts) | `KDS_PORT`, else 3002        | the standalone KDS                          |
| [`main/server-app.ts`](../../main/server-app.ts) | `SERVER_APP_PORT`, else 3003 | the standalone Server App                   |

Those are the base ports, not the addresses to code against. Each server resolves its port at bind
time, and on `EADDRINUSE` or `EACCES` it increments and retries rather than failing. **Derive a
client target from what the page was served from, never from a literal port.** The shared `api`
client already does this with `` `${window.location.origin}/api` ``, the KDS socket derives its host
from that `baseURL`, and a client that needs the KDS or Server App port asks for it: `get-kds-info`
over IPC returns the bound KDS port and the machine's LAN address. See
[the port retry ladder](../architecture/overview.md#the-port-retry-ladder) for the accessors and
the ten-attempt bound.

A page is a file, not a request that runs code. The export has no Next.js server runtime behind
it, so there are no route handlers, no server actions, no middleware, and no server cookies in the
shipped build, and a file that uses them compiles without complaint and is dead in every build that
ships. [What does not exist in the desktop build](desktop-build.md#what-does-not-exist-in-the-desktop-build)
enumerates the absences and why the build stays quiet about them.

**A new screen cannot call the backend the way a web app would.** There are three routes out of the
renderer:

1. **HTTP**, through the axios client in [`frontend/src/lib/api.ts`](../../frontend/src/lib/api.ts).
2. **WebSocket**, on the same base ports, for live updates. Two screens open one today, through
   two different clients; see [the KDS live feed](#the-kds-live-feed-is-a-websocket-not-a-request).
3. **Native capability**, through the `window.electronAPI` bridge described in
   [the interface contract](#the-interface-contract).

Anything that needs a database row, an authorization decision, a tax calculation, or a print job is
an Express route on the backend, not renderer code. See
[Backend-authoritative security and tax](../decisions/0002-backend-authoritative-security-and-tax.md).

The KDS window and the Server App page load without a preload bridge, so on those two surfaces the
native route does not exist at all.

### The HTTP client

`api` is the axios instance the authenticated pages share, and the default way to reach the API.

- `baseURL` is `` `${window.location.origin}/api` ``, resolved at module load, so a page served
  from a LAN host reaches that host's API rather than a hard-coded address.
- The request interceptor attaches `Bearer <token>` from `localStorage.token` when a token exists.
- A `401` clears the token and hard-navigates to `/auth/login`, except on `/kds`, where the KDS
  view renders its own inline login, on the login page itself, where the login form reports the
  error, and when the request passes `skipAuthRedirect: true` (used by `loadFromStorage`'s startup
  `GET /auth/me` probe so [`AuthGuard`](../../frontend/src/components/layout/AuthGuard.tsx) routes
  cleanly after clearing the expired session).
- A `403` carrying `{ code: 'permission_denied' }` dispatches a `flo:authorization-denied` window
  event. [`AuthGuard`](../../frontend/src/components/layout/AuthGuard.tsx) listens for it and calls
  `refreshAuthContext`, so an owner tightening a permission takes effect on the next request
  instead of at the next sign-in.

Four things do not use it, and a new screen has to notice which kind it is:

| Path                                                                              | How it reaches the API                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`kds-standalone/page.tsx`](../../frontend/src/app/kds-standalone/page.tsx)       | builds its own axios instance on its own origin, because it runs on the `:3002` base port rather than the POS window's `:3001`, and on a `401` clears the token and reloads instead of redirecting |
| [`server-standalone/page.tsx`](../../frontend/src/app/server-standalone/page.tsx) | the same, against the filtered `:3003` proxy                                                                                                                                                       |
| [`i18n/server-language.ts`](../../frontend/src/lib/i18n/server-language.ts)       | bare `fetch`, because it reads the tenant's language and theme defaults before a session exists                                                                                                    |
| the KDS live feed                                                                 | a WebSocket, described below                                                                                                                                                                       |

The other `axios` imports in the renderer are `axios.isAxiosError` for error shape, not a second
client.

### Durable manual item-edit recovery is re-sent only by staff action

The Orders pages retry an item edit whose browser response was lost, but never automatically. The
saved record lives in `localStorage` under one key per order item,
[`flo.orders.item-edit.attempt.v1:<tenant>:<actor>:<order>:<item>`](../../frontend/src/lib/order-item-edit-attempt.ts).
Enumeration
([`listOrderItemEditAttempts`](../../frontend/src/lib/order-item-edit-attempt.ts)) reads only keys in
that exact tenant/actor/order prefix and validates the snapshot it finds there: the key's item suffix,
the stored tenant/actor/order/item IDs, the declared edit mode, and a body operation matching that
mode. The stored `path` must equal the canonical `PATCH /orders/:orderId/items/:itemId/edit` path
derived from those IDs, so a tampered record cannot redirect the replay at an arbitrary URL. Malformed
or mismatched records inside the current scope are left intact, counted as unreadable, and never sent
or cleared; they produce a translated storage warning. Records in other scopes are ignored.

Mounted order surfaces lazily run that enumeration and render one shared
[`PendingOrderItemEdits`](../../frontend/src/components/orders/PendingOrderItemEdits.tsx) notice above
their item lists (both the card and the detail layouts, outside the active/inactive line filter, so
history-hidden superseded lines still surface their unresolved attempt). The notice renders for saved
records, storage warnings, or outstanding resolution notices. The browser sends nothing until staff click _Resolve pending
edit_. Resolving re-reads the record under the attempt's Web Locks critical section, verifies the
re-read still matches the offered operation, then replays the stored path, frozen body, and
idempotency key through the axios client. Because the idempotency key is reused, a replay of an edit
that already committed is a no-op refresh, not a second mutation.

Clearing is compare-and-clear: a 2xx for the saved request, or a definitive current-route rejection
(400/404/409/422), clears the record only if storage still holds the same idempotency key.
Transport timeouts and 5xx, authentication/permission/rate-limit
responses (401/403/429), and failed local clears all preserve the record and surface an inline
message (sign-in for 401, rate limit for 429, the generic hint plus any server message otherwise):
the 403/429 classes cannot establish whether an earlier request committed, so no
automatic retry timer runs for them. A confirmed edit whose order refresh failed is reported as a
refresh failure, not an edit failure, and the cleared attempt is not re-created.

The Orders page owns the data result: after a resolved edit it refetches the current order and
the already-loaded list pages through its existing fetch/refresh routines. A failed detail refresh after
either confirmation or definitive rejection leaves a visible refresh warning with a retry action; only
the confirmed case says the edit was confirmed.
Scoped native custom events
(`flo.orders.item-edit.attempt.changed`) refresh mounted notices in the current tab after the edit
modal persists or resolves an attempt, and the browser `storage` event covers other tabs.
An identity change during an item-edit commit closes the stale editor and refreshes the current
order or table context without installing the returned order from the previous identity. Recovery
notices, inline issues, refresh errors, storage warnings, and in-flight resolution handlers are
scoped to the selected `(tenantId, actorId, orderId)` so switching orders or identities clears
transient notices and ignores late-settling responses from another order.

### Split-check availability is a state, not a hidden button

The POS payment modal consolidates equal-amount shares and item-based check splitting into a unified
Split card inside the tender column of the three-column checkout workspace, rather than splitting
controls across separate panels. It derives
item-based split-check availability through explicit states rather than a boolean that silently hid the
control. The feature setting (`split_checks_enabled`) lookup reports loading, ready, and error states:
while loading the item-split panel stays hidden, on failure it displays an inline error with a retry
action, and a `settings.view` denial explains the account cannot check availability. When enabled, a
two-tab mode switcher toggles between item-based check splitting and equal-amount shares. A successfully
read `false` removes the item-split mode switcher and controls, leaving only the equal-amount share
calculator when a balance remains.

Both equal-amount sharing and [`SplitCheckModal`](../../frontend/src/components/pos/SplitCheckModal.tsx)
provide `-` / `+` steppers for numeric values. Equal-share payer counts also have quick presets
(`2`, `3`, `4`). In table mode, check allocators rebalance quantities across checks or reset evenly
in a single tap without over-allocating.

Eligibility resolves in a fixed order so staff always see the same reason for the same bill:
billing permissions, an unresolved payment or split in progress, anything other than an untouched
unpaid bill, a non-dine-in order type, fractional item quantities, fewer than two whole eligible
units, and finally an incomplete bill/order projection, which is reported as an availability unknown
with a check action, never as "cannot split". Definitive reasons render as visible text beside the
disabled action, so no reason depends on hovering.

Opening the allocator is guarded, not assumed. The modal re-fetches the bill (`GET /bills/:id`,
with the existing whole-order fallback only for an as-yet-unsplit bill) and re-evaluates payment
status, permissions, order type, and units from the fresh result before offering the split, passing
the refreshed bill and its matching order projection to
[`SplitCheckModal`](../../frontend/src/components/pos/SplitCheckModal.tsx). For a split-group child
the child's own projection is authoritative; a paid sibling never leaks into the editor. Stale or
racing lookups are ignored by lookup id, rapid clicks open at most one allocator, and while the
explicit split-opening request is in flight competing payment and split mutations are disabled until
it finally releases.

### Add-on groups have one editor

Add-on groups are managed only in Products, on the tab selected by `/products?tab=addons`. The
Products page reads `tab` (`products`, `categories`, or `addons`; anything else selects Products)
inside a Suspense boundary and writes tab clicks back with `router.replace`, keeping other query
parameters. The tab is shown to restaurants and to any business whose role grants `catalog.manage`.
The legacy `/addon-groups` route is kept for bookmarks and the static export; it makes no API call and
client-redirects to `/products?tab=addons` with `router.replace`.

The group editor echoes each saved add-on's `tax_category_id`, `tax_behavior`, and
`inherit_parent_tax_category` back on save, and sends `stock_quantity` only when the stock field was
edited, so an ordinary save cannot overwrite stock moved since the editor opened.

### Charge identity is chosen, not typed

[`ChargesSettingsCard`](../../frontend/src/components/settings/ChargesSettingsCard.tsx) offers Service,
Packaging, and Custom kinds for a new charge. Service and Packaging use the reserved IDs
`service_charge` and `packaging_charge` (which feed the standard report columns); if that ID already
exists, choosing the kind opens the saved definition instead of applying defaults. Custom charges get
an opaque `charge-<32 hex>` ID from `crypto.getRandomValues`, generated once per draft. IDs are never
derived from names or editable, so renaming a charge keeps its identity. Choosing a kind writes
nothing; only Save persists. Editing an existing charge reloads definitions before building the
replacement list. An edit therefore does not recreate a charge already deleted on the server or
replace other definitions from its old snapshot. A failed reload retains the draft and blocks saving
until Retry succeeds. Creation retries reuse the draft's stable ID, including after a committed
attempt's response is lost.

### The KDS live feed is a WebSocket, not a request

Two surfaces open a socket to the same `/kds` path. The base ports for that path are `:3001` and
`:3002`, and the retry ladder can change either bound port, so neither client may name a literal.
Both derive the host from the origin they were served from. The two clients are not
interchangeable.

[`useKdsConnection`](../../frontend/src/hooks/useKdsConnection.ts) is the streaming one. The KDS
views use it. It derives the host from the axios `baseURL` so a dev proxy reaches the right backend
and falls back to the page origin, and it carries the order list in the frames themselves.
Authentication is a message, not a header: the client sends `{ type: 'auth', token }` after `open`
and must be authenticated within 5 seconds, or the server sends `auth_error` and closes with code
`1008`. A socket that is refused, times out, or drops does not become a dead screen: the hook falls
back to REST polling on a 5-second interval and reports which mode it is in through
`connectionMode`. Reconnect uses exponential backoff from 1 to 30 seconds.

The orders screen writes its own client inside the page effect instead. It connects to
`window.location.host`, sends the same `auth` message, and uses the socket only as a signal: on
`order_updated`, `orders`, or `initial_data` it refetches over HTTP rather than consuming the
frame. It reconnects on a flat 3-second timer, not the hook's backoff, and a 10-second HTTP poll
runs alongside it so a socket that never opens still refreshes the list.

Which REST route a poll hits depends on the surface, because the hook takes its endpoints as a
parameter. The in-dashboard KDS polls `GET /api/kitchen/orders`; `/kds-standalone` passes
`orders: '/api/kds/orders'` and the rest of that base port's REST surface to the same hook.

The frames, the handshake, and the server-side conditions live in
[the API reference](../reference/api.md#kds-websocket-kds).

## The permission model

### Two catalogs, and which one you are looking at

The codebase holds two different tables about who may do what. Confusing them is the main way a
permission change goes to the wrong place.

|                | `shared/role-permissions.ts`                                                                                                               | `shared/permissions.ts`                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Holds          | the five role identities in `ROLE_DEFINITIONS`, the named role groups in `ROLE_ACCESS`, and the capability table `PERMISSION_CAPABILITIES` | `PERMISSION_DEFINITIONS`, one entry per runtime permission id, with its area, shipped default roles, `configurable` flag, and risk tier |
| Owner-editable | no, the identity list is a constant in the module                                                                                          | the grants are editable; the ids are not, because they are persistence keys                                                             |
| Who reads it   | backend route middleware imports `ROLE_ACCESS` and `hasRole`                                                                               | the backend resolves the effective set from SQLite on every protected action                                                            |

What an owner can change is the grants, not the shape. From **Staff > Role permissions** the owner
edits role defaults and per-user exceptions. Two entries in `PERMISSION_DEFINITIONS` carry
`configurable: false` and are protected: `authorization.manage`, which decides who can reach that
editor at all, and `staff.privileged.manage`, which decides who can modify an owner or manager
account. Both always resolve to the active owner, with no override able to take them away. See
[Resolution model](../reference/roles-and-permissions.md#resolution-model) for the precedence
order and [Owner-configurable permissions with fixed context policy](../decisions/0005-owner-configurable-permissions-with-fixed-context-policy.md)
for why the split exists.

`PERMISSION_CAPABILITIES` is a third, older shape: each row names an `allowedRoles` group rather
than being an owner-editable id. The renderer does not read it. Reach for
`PERMISSION_DEFINITIONS` and a permission id when writing renderer code.

### The administrative floor and the two refusals

Being protected and being administrative are different things. `configurable: false` marks the two
permissions that always resolve to the active owner. Separately, the backend refuses a save that
would leave no account able to manage staff, permissions, or store settings, using
`ADMINISTRATIVE_PERMISSION_IDS` in
[`main/services/authorization.ts`](../../main/services/authorization.ts):

```text
authorization.manage
staff.privileged.manage
staff.operational.manage
settings.manage
```

`PermissionMatrix` keeps its own copy of that list, mirroring the backend constant, and marks the
row when a pending change would take one of the four away from the actor who is making it. It is a
warning, not a block: the save goes out, and the server applies two separate guards that need to be
told apart.

| Guard                               | Refuses                                                                     | Status                                                                                                   | Can a PIN satisfy it                 |
| ----------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `assertAdministrationReachable`     | a write that would leave the install with no account that can administer it | 400 `administration_unreachable`                                                                         | no, nothing rescues a stranded store |
| `assertActorKeepsOwnAdministration` | a write that would take any of the four away from the actor making it       | 428 `self_privilege_change_requires_factor`, 403 if the factor is wrong, 409 if the actor has no PIN set | yes                                  |

The second guard's factor is the **actor's own staff PIN**, verified against `users.pin_hash` from
the request body's `override_pin` and rate-limited per client IP. It is not the Master PIN, and the
component that collects it is named `MasterPinPrompt` because the same component drives the
Master PIN flows. **When another account can still administer the store, a confirmed self-access
change succeeds**; the 400 is the case no factor can rescue. The store check runs first, so a
stranded install is refused as a 400 naming the remedy rather than as a 428 naming a PIN.

`preflightOverrides` in [`main/routes/authorization.ts`](../../main/routes/authorization.ts) runs
both before the write, so a refusal stores nothing.

### How the renderer reads a permission

[`frontend/src/lib/permissions.ts`](../../frontend/src/lib/permissions.ts) exposes one function:

```ts
tenantCan(tenant, permissionId);
```

It returns `false` when there is no tenant. When the tenant payload carries a `permission_ids`
array it answers from that; otherwise it falls back to the shipped default for the tenant's role.
The array is what makes an owner-configurable grant visible to the renderer without a rebuild.

This is a UX gate. It decides what to draw, not what is allowed, and the backend re-resolves live
authorization on every protected request. A renderer that shows a control is not evidence that the
call behind it will succeed, and a renderer that hides one is not a security control.

Route gating lives in `AuthGuard`:

- `AuthGuard` and the dashboard layout strip trailing slashes from `usePathname()` (preserving
  root `/`) before comparing routes. This keeps permission gates for `/staff` and `/settings` and
  POS/KDS/settings scroll-shell selection consistent with the desktop export's `trailingSlash`
  setting (see the [build-time fork](desktop-build.md#the-build-time-fork)).
- `getLandingPage` returns the first page in a fixed list the tenant can reach. The list is ordered,
  not role-aware: `pos.use` is checked before `dashboard.view`, and `pos.use` ships to owners, so
  an owner lands on the POS like anyone else. The list is a fallback order for whichever surfaces
  are available, not a statement about what a role prefers. When `/auth/login` carries a
  `?redirect=` query parameter, `resolveSafeRedirect` accepts only a normalized same-origin internal
  path outside `/auth` and `/setup`; any other value falls back to `getLandingPage`.
- `PAGE_PERMISSIONS` maps a guarded route to the single permission id it needs. `/staff` and
  `/settings` are the two exceptions and carry an any-of list instead, because either screen
  aggregates several permissions. Adding a route means adding it to one of those three; a route in
  none of them is behind authentication and nothing else.
- `PUBLIC_PATHS` holds the unauthenticated surfaces: `/kds`, `/kds-standalone`,
  `/server-standalone`, `/customer-display`, `/auth/login`, `/auth/register`, `/auth/recover`, and
  `/setup`. The standalone KDS, Server App, and paired customer display pages run their own session
  and skip the shared auth store, so loading it there would clear their token; `/kds` loads the
  shared store only when both `token` and `tenant` are already in `localStorage`.
- Once a user and tenant are resolved, the guard refreshes the auth context on window focus, every
  30 seconds, and on `flo:authorization-denied`.

The permission editor does not read the catalog out of the bundle.
[`PermissionMatrix`](../../frontend/src/components/settings/PermissionMatrix.tsx) fetches
`GET /authorization/catalog` and `GET /authorization/roles` and takes the role key list from
`ROLE_KEYS`, so the matrix renders the effective state the backend resolves rather than the shipped
defaults.

## The interface contract

[`main/preload.ts`](../../main/preload.ts) exposes one object, `window.electronAPI`, through
`contextBridge`. Its type is `ElectronAPI` in
[`frontend/src/types/electron.d.ts`](../../frontend/src/types/electron.d.ts).

**The compile-time checks over that boundary are partial, so verify both sides by hand.**
[`electron-api-contract.ts`](../../frontend/src/types/electron-api-contract.ts) makes two different
kinds of assertion:

- `ElectronApiContractChecks` pins twelve exact signatures with `Equal<>`: `dbApplySafeFixes`,
  `getMasterPinStatus`, `getSettings`, `setSetting`, `setThemeEffective`, `getKdsInfo`,
  `openKdsWindow`, `openWhatsAppShare`, `getAppInfo`, `getPrinters`, `getStatus`, `onUpdateStatus`.
- `ElectronApiMethodPresence` is a `Pick<>`, so the other listed members including
  `backupDatabase`, `restoreBackup`, `pickRestoreFile`, `dbHealthCheck`, `dbInitialize`,
  `getUpdateStatus`, `checkForUpdates`, and `restartAndInstall` are checked for **presence only**.

On top of that, `preload.ts` is CommonJS and never mentions `ElectronAPI`, so it is not
type-bound to the renderer declaration at all. A preload signature change can therefore compile
with the renderer still expecting the old shape, and a presence-only member can have its arguments
change without anything failing to build. `npm run test:electron-api-contract` is the check to run
for the channel list and the absence assertions; argument and return-type changes on a
presence-only member need a look at both files.

Every privileged channel in [`main/ipc.ts`](../../main/ipc.ts) is registered through the `handle`
wrapper, which calls `isTrustedMainWindowSender` before the listener runs and returns
`{ error: 'Unauthorized sender' }` to anything else. `isTrustedMainWindowSender` requires the caller
to be the active main `BrowserWindow`, its current top-level `mainFrame`, and `http:` on `localhost`
or `127.0.0.1` at the active Express server port. That establishes **which window is calling**. To
establish **who is signed in** for renderer mutations, privileged IPC channels (`set-setting`,
`updates:set-auto-check`, `updates:set-beta-channel`) receive the caller's JWT forwarded from
renderer storage via [`main/preload.ts`](../../main/preload.ts) and authorize it through
`authorizeRendererPermission` in [`main/security/ipc-auth.ts`](../../main/security/ipc-auth.ts),
checking active status, revocation, staleness, and permissions against the database.

Registering a privileged channel with a bare `ipcMain.handle` skips the check. All privileged
channels in [`main/ipc.ts`](../../main/ipc.ts) go through the `handle` wrapper, and direct update
and status handlers in [`main/update-ipc.ts`](../../main/update-ipc.ts) go through
`registerDirectUpdateIpcHandlers`, both using `isTrustedMainWindowSender`; any new channel must
enforce sender validation.

### What the settings channel may write

`set-setting` checks the key against `ALLOWED_IPC_KEYS`, which contains `theme_mode` (accepted
values: `light`, `dark`, `system`) and `orders_layout` (accepted values: `split`, `cards`). Writes
require `settings.manage` via `authorizeRendererPermission`. Before initial setup creates any users,
unauthenticated writes are allowed for `theme_mode` only (`allowPreSetup: true`) so initial theme
preference can be applied; once users exist, `settings.manage` is strictly enforced. Desktop update
settings written via IPC (`updates:set-auto-check` and `updates:set-beta-channel` in
[`main/update-ipc.ts`](../../main/update-ipc.ts)) similarly require sender validation and
`settings.manage` authorization.

Every other setting is written over a permission-gated HTTP route, where the acting user is known.
The read side, `get-settings`, masks `jwt_secret`, `auth_clock_high_water_ms`, `cloud_api_key`,
`cloud_device_secret`, `cloud_deletion_status_token`, and `cloud_last_error`, and collapses
`cloud_last_error` to a generic string.

### The database channels

Five channels do database work, and they are gated two different ways on purpose.

| Channel               | Gate                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `db-health-check`     | sender check only; it reports, it does not write                                                                  |
| `db-apply-safe-fixes` | sender check, then `authorizeMasterPin(pin, 'ipc:apply-safe-fixes')`, failing closed on a missing or wrong PIN    |
| `backup-database`     | sender check, then `authorizeMasterPin(pin, 'ipc:backup')`                                                        |
| `restore-backup`      | sender check, then `authorizeMasterPin(pin, 'ipc:restore')`                                                       |
| `db-initialize`       | sender check, then `authorizeMasterPin(pin, 'ipc:initialize')` **and** the exact confirmation phrase `INITIALIZE` |

`pick-restore-file` is the odd one out and is deliberately not Master-PIN gated. It opens the
native file picker and returns a path bound to a single-use token; it performs no destructive step.
The restore that path feeds is authorised over HTTP by a session holding `database.manage`, so the
origin check is the right gate for the picker and adding a PIN prompt to it would be theatre.

The HTTP twins of those repairs are gated separately, and not uniformly, by
[`main/routes/database-tools.ts`](../../main/routes/database-tools.ts). Every one of its ten routes
requires `database.manage`. Four of them add `requireMasterPin` (reading `master_pin` from the
request body or `x-master-pin` header):

| Route                                         | Extra requirement                                     |
| --------------------------------------------- | ----------------------------------------------------- |
| `POST /api/db-tools/initialize`               | the Master PIN, then the `INITIALIZE` phrase          |
| `POST /api/db-tools/currency-reset`           | the Master PIN                                        |
| `POST /api/db-tools/backups/:fileName/delete` | the Master PIN                                        |
| `POST /api/db-tools/master-pin/reset`         | the current Master PIN when one is already configured |

Of the remaining six, one matters here because its IPC twin is gated the other way:

| Interface                                       | Gate                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `db-apply-safe-fixes` over IPC                  | sender check, then the Master PIN, failing closed without it |
| `POST /api/db-tools/apply-safe-fixes` over HTTP | `database.manage`, and no PIN of any kind                    |

A caller holding `database.manage` can run the repair over HTTP with no second factor, and cannot
run it over IPC without one. Neither gate implies the other; do not reason about one from the
other.

### Two privileged channels are absent

`savePrinter` and `getDailySummary` are not on the bridge. Naming either in `ElectronAPI` would
not compile, and the type file says so in a comment so the absence does not read as an oversight.
`tests/electron-api-contract.test.ts` and `tests/printer-ipc.test.ts` assert that the
`save-printer` and `get-daily-summary` channels are not registered, so the gap cannot quietly
reopen.

### Adding a setting

Write it on the HTTP settings route, gated on the same permission as its neighbours, and read it
through `api`. Use the IPC settings channel for nothing. A genuinely new native capability needs
three things together: a `contextBridge` entry in `preload.ts`, a `handle` wrapper in `ipc.ts` so
`isTrustedMainWindowSender` applies, and a matching entry in `ElectronAPI`. If it is a privileged
write, it also needs an authorization step that verifies the signed-in user against the backend
permission model via `authorizeRendererPermission` in
[`main/security/ipc-auth.ts`](../../main/security/ipc-auth.ts), because the window-origin check
establishes only the calling window.

## State stores

Zustand holds the renderer's client state. Eight stores live in
[`frontend/src/store/`](../../frontend/src/store) (alongside
[`session-events.ts`](../../frontend/src/store/session-events.ts) for session-boundary reset
notifications), and the printer store lives with the printer hook because it carries the transport:

| Store                                                           | Holds                                                                                                                                                                                                                                    | Persistence                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`auth.ts`](../../frontend/src/store/auth.ts)                   | `user`, `token`, `tenants`, `currentTenant`, `loading`, `isLocked`, and the locales that failed to warm at bootstrap                                                                                                                     | token and tenant in `localStorage`; throws `StorageUnavailableError` when storage is unavailable                                                                                                                                                  |
| [`cart.ts`](../../frontend/src/store/cart.ts)                   | cart items with their addons, instructions, selected product variant and pizza recipe, order type, table, customer, guest count, delivery details, and the subtotal and item count selectors                                                           | none                                                                                                                                                                                                                                              |
| [`charges.ts`](../../frontend/src/store/charges.ts)             | `charges`, `loading`, `error`, and the `load` and `save` actions over `/settings/charges`                                                                                                                                                | none in the store (persisted via `PUT /api/settings/charges`)                                                                                                                                                                                     |
| [`cloud-attention.ts`](../../frontend/src/store/cloud-attention.ts) | per-tenant `emailNeedsAttention`, `deletionNeedsAttention`, and `anyNeedsAttention` indicators shared by the sidebar Settings badge and Settings sub-navigation (`Account`, `Privacy`), derived from `/settings/cloud/account` and `/settings/cloud` | none (reset on session boundaries via `session-events.ts`)                                                                                                                                                                                        |
| [`held-orders.ts`](../../frontend/src/store/held-orders.ts)     | suspended orders keyed by table, and the fetch, hold, restore, remove, and lookup actions over `/held-orders`                                                                                                                            | none                                                                                                                                                                                                                                              |
| [`orders-layout.ts`](../../frontend/src/store/orders-layout.ts) | `layout` (`'split'` or `'cards'`) and the `userSelected` session guard                                                                                                                                                                   | none in the store (persisted via `PUT /api/settings/orders_layout`)                                                                                                                                                                               |
| [`pos-settings.ts`](../../frontend/src/store/pos-settings.ts)   | the tenant's POS configuration, printer defaults, bill template and provenance, receipt and kitchen-ticket language policy, and idle `autoLockMinutes`                                                                                   | `persist` under the `pos-settings` key, version 6; `partialize` excludes `whatsappEnabled`, `billLanguagePolicy`, `kotLanguagePolicy`, and `autoLockMinutes`                                                                                      |
| [`theme.ts`](../../frontend/src/store/theme.ts)                 | `mode`, whether this session made an explicit choice, and whether server theme info has synced                                                                                                                                           | none in the store; `useThemeModeToggle` and Settings write `PUT /api/settings/theme_mode` (clearing `flo-kds-theme-override` after a successful save, while a failed save rolls back the mode and keeps the override; `useThemeModeToggle` also clears the override when the selected mode is already active), and the KDS header toggle persists a local override under `flo-kds-theme-override` |
| [`usePrinterStore`](../../frontend/src/hooks/usePrinter.ts)     | connection status, the hardware and WebUSB printer records, the print method, the last emitted bytes, and the print actions: `printBill`, `printTaxBill`, `printKot`, `printDeliverySlip`                                                | `persist`                                                                                                                                                                                                                                         |

`held-orders.ts` exports `createHeldOrdersStore(apiClient)`, so a test can pass its own client
instead of the shared one.

### Cart line identity

A cart line's `id` is a digest of what the line holds, built by `generateCartItemId` in
[`cart-identity.ts`](../../frontend/src/lib/cart-identity.ts): the product, the selected variant,
the add-ons in any order, the note, an owner price override, and the recipe of a pizza or deal.
Two adds that produce the same id are one line with a higher quantity, and every cart action that
changes a line rebuilds its id from the same fields. The recipe enters the digest as its
`recipeKey` (`shared/pizza/recipe.ts`), so the same pizza is the same line whatever order its
removals were tapped in, and two different pizzas of one product and size stay on two lines. A line
without a recipe has the id it would have if recipes did not exist. `lineRecipe` treats the recipe
of a plain pizza, a whole pizza with nothing removed and no cook or cut note, as no recipe, so such
a line has that same id and merges with a line that carries no recipe.

`updateItemDetails` can change a line's variant, which for a pizza is its size. A pizza recipe
names its size too, so the store rewrites the recipe's `sizeId` from the new variant id with
`recipeForVariant`, for a whole pizza and for a half and half, and the line's id follows.

`normalizeCartItems` gives restored lines their ids again and merges the ones that match; a held
order resumed into the cart keeps two different pizzas apart because it reads each line's recipe.
`cartItemToOrderItem` in [`cart-order-item.ts`](../../frontend/src/lib/cart-order-item.ts) is the
only cart-to-request projection, and it sends the recipe as `modifier_selection`. A pizza line
with no recipe, which is a product whose id starts with `pz-`, sends `modifier_selection: null`,
so that saving an edited pizza as plain clears a recipe the order already stores; a line for any
other product sends no such field. The retry
fingerprint in `order-attempt.ts` is built from that projection, so two carts that differ only in
a recipe are two different attempts. The displayed unit price is the variant price plus the
add-ons; a recipe never changes it.

### Pizza logic

[`frontend/src/lib/pizza/`](../../frontend/src/lib/pizza) holds the logic the pizza screens stand
on, with no React in it:

| Module | Contents |
| --- | --- |
| `catalog.ts` | `loadPizzaCatalog()` requests `GET /api/pizza/catalog` once and keeps the answer; `getPizzaCatalog()` reads it synchronously; `reloadPizzaCatalog()` fetches it again. A 404 means the shop has no pizza menu, and the catalogue is then `null`. `hasPizzaMenu()` is true when the catalogue held has at least one pizza: a stored menu with no pizzas counts as no menu, and that one function decides it. A failed fetch keeps the catalogue already held, and only the latest fetch changes it, whatever order the answers arrive in. A login or a logout clears the catalogue and any fetch in flight, so the next `loadPizzaCatalog()` asks again; locking the screen and unlocking it with a PIN keep the catalogue, because the store and its menu are the same. The dashboard layout loads it for every dashboard screen through `usePizzaCatalog()`; see [pizza screens](#pizza-screens). The screen that loads a new menu calls `reloadPizzaCatalog()`. |
| `sheet-state.ts` | `newSheet`, `sheetReducer`, and `sheetLine`: the state of the pizza sheet, one action per control, and the cart line that state describes. `sheetLine` runs the state through `validateRecipe` in `shared/pizza/recipe.ts`, so Add is off, with that function's message, until the recipe is valid against the catalogue. A plain pizza has no recipe. The `load` action opens a cart line whose product id starts with `pz-`; any other line leaves the state as it is. `sheetDraft` is the pizza the state holds as it stands, finished or not, which is what `validateRecipe` is asked about. |
| `deal-state.ts` | `newDeal`, `dealReducer`, and `dealLine`: the state of the deal configurator and the cart line it describes. The state holds one sheet state per pizza of the deal, each at the size the deal sets and changed only through `sheetReducer`, the cans, the bottle, and the wing flavour. `dealLine` gives one tab per choice the deal asks for, worked out with `dealPickCount`: a tab per pizza in pick order, then `drinks` for a deal with pops or with cans or a bottle, then `wings`. Each tab says whether its choice is made, the choice in one line, and the choice as `ticketLines` prints it. The ticket's closing `INCLUDES:` lines belong to no tab: `dealLine` gives them once, as `includes`. A pizza, drink or flavour the menu does not have counts as not chosen, so no tab is missing exactly when `validateRecipe` accepts the deal; `dealLine` then gives that function's normalised recipe, and otherwise its message. Switching between cans and the bottle clears the side left. `newDeal(deal, recipe)` loads the recipe of a cart line, and saving it unchanged gives the same recipe. `tests/pizza-deal-state.test.ts` covers it for every deal of the sample menu. |
| `cart-lines.ts` | `customizeOne` takes one off a line of several and gives it a line of its own; `replaceCartLine` saves an edited line where it stood, and merges it into a line it has become identical to. Both return a new item list and change nothing. "Customize 1" gives the split line a temporary id, because it holds the same pizza as the line it came from. When the sheet is closed without saving, the screen calls `replaceCartLine(items, temporaryId, line)` to merge it back. `sheetAddons` gives the add-ons of a line the sheet saves: the add-ons the line had that are not dips, unchanged, then the sheet's dips. |
| `line-recipe.ts` | `lineRecipe` and `recipeForVariant`: the recipe a line is identified and sent by, and a pizza recipe at the size of the line's variant. |
| `small-items.ts` | The dips and drinks popup and the folded cart rows as plain data. `smallItemRows(catalog, products)` gives the popup's rows: the dips, then one row per drink size, each with one tile per choice. A tile is on a row only when the menu has the item and the POS page's product list sells it, found by the ids the menu load derives: the product `sd-dip` with the add-on `ad-dip-<modifier>-<dip>`, and the product `dr-<drink>` with the variant `dr-<drink>-<size>`. A row with no tile is left out, so a menu with no dips or no drinks has no such row. `tileAdd` gives the arguments of `useCartStore.addItem` for one tap, which are the ones the product grid's dialog passes for the same choice, so both add to one cart line. `tileLines` and `tileCount` find the cart lines that hold a tile's item: the same product, variant and add-ons, whatever the note. A dip that is an add-on on a pizza is not counted. `tileSoldOut` is true for a sold-out size and for a tracked dip the whole order already holds all of, which is stricter than the product grid's dialog, where the limit is per line. `popupCategory` names the category whose block opens the popup: the drinks' category, and only while every active product in it is on a tile in every active size it has, so a drink added by hand or a size the menu does not list stays reachable through a plain block. `touchedLine` names the line a cart change added or changed, and `foldsActions` says whether a pizza line hides its action row: the order has more than three lines and another line was touched last. |
| `detail-lines.ts` | `orderItemDetailLines` and `cartLineDetailLines`: the lines under a pizza or deal, from its recipe and the loaded catalogue. See [item detail lines](printing.md#item-detail-lines). |
| `sent-line.ts` | A pizza or deal line of an order already placed. `sentDetailLines(catalog, item, columns)` gives the lines under it from the recipe in its `modifier_selection`: none for an item without a recipe, and the one line `RECIPE NOT PRINTED - CHECK ORDER` when no catalogue is held or `ticketLines` cannot write the recipe out. `sentLine` reads what the item holds, `sheetSource` is the line the sheet's `load` action opens on, and `sheetSentLine` is what the sheet saves over it: the add-ons that are not dips, unchanged, then the sheet's dips. `sentLineEdit(item, now)` is the body of the edit sent to `PATCH /orders/:orderId/items/:itemId/edit`: `null` when nothing changed, `{ quantity }` when only the quantity did, so the stored recipe is not sent again, and otherwise a `replacement` with the product, variant, quantity, add-ons, note and `modifier_selection`, which is `null` for a pizza made plain. Each body carries the item's `edit_version` as `expected_edit_version`. `needsPizzaScreen(productId)` is true for the half-and-half product and for a deal, the two products the server refuses without a recipe. |

`tests/pizza-sheet-state.test.ts`, `tests/pizza-cart-store.test.ts`, and
`tests/pizza-kot-browser.test.ts` cover these modules and the cart and print hooks that call them.
`tests/pizza-small-items.test.ts` runs `small-items.ts` against the product list of a store the real
importer loaded the sample menu into.
`tests/pizza-pos-order-seam.test.ts` posts the requests these modules build to the real order routes
of a store with the sample menu loaded, and reads the catalogue through `GET /api/pizza/catalog`.
`tests/pizza-sent-line.test.ts` covers `sent-line.ts`: the edit a changed plain pizza, half and half
and deal send, an untouched line sending nothing, and the lines under a sent line.
`tests/pizza-server-app-catalog.test.ts` reads the menu through the Server App's forward.

### Pizza menu screen

`/pizza-menu` (`frontend/src/app/(dashboard)/pizza-menu/page.tsx`) is where an owner or a manager
loads the shop's menu file. The sidebar shows its entry only for a tenant with
`catalog.import-export`, and `PAGE_PERMISSIONS` guards the route with the same permission. Its text
is in the
[English-only pizza strings](internationalization.md#english-only-pizza-strings).

- **What is loaded now** counts the pizzas, sizes, dips, sides, drinks and deals of the catalogue
  `reloadPizzaCatalog()` answers when the screen opens, or says that no pizza menu is loaded.
- **Choosing a file** reads it in the browser. A file that is not a JSON object is refused there,
  and nothing is sent. A file that is one opens a confirm step that says what loading does: the
  file is the master copy, names, prices and what is on sale follow it, what it no longer has is
  switched off and not deleted, and changes made in the product screen are overwritten.
- **Confirming** sends the parsed file to
  [`POST /api/pizza/menu/import`](../reference/api.md#pizza-menu). On success the screen shows the
  four row counts of the answer, and a warning when the answer says `untaxed`. On a refusal it shows
  the server's message and, on a line of its own, the entry the answer names.
- After a successful load the screen calls `reloadPizzaCatalog()`, so the catalogue the POS reads is
  the new one without a sign-out.

`frontend/e2e/pizza-menu.spec.ts` drives the screen against the sample menu and copies of it. A
spec that loads a menu uses `loadSampleMenu` and, in `test.afterAll`, `clearPizzaMenu` from
`frontend/e2e/helpers/pizza-menu.ts`, because the suite shares one database and a loaded menu puts
its categories first in the POS.

### Order types the POS offers

The order type switch of the cart panel offers Dine-in, Takeaway, Delivery and Online. The setting
`pos_order_types` narrows it: a comma-separated list of `dine_in`, `takeaway`, `delivery` and
`online`, written with `PUT /api/settings/pos_order_types`. `GET /api/settings/business` returns it
as an array with the spaces around each entry removed, `hydrateReceiptSettings()` stores it as `posOrderTypes`, and `offeredOrderTypes()` in
`frontend/src/lib/pizza/order-types.ts` applies it:

- An absent or empty setting, or one that names no known type, offers every type.
- The switch keeps its own order. A new order whose type the setting hides moves to the first type
  offered (`orderTypeToStartOn()`); without the setting the cart's order type is left alone.
- An order being added to keeps its own type on the switch even when the setting hides it.

The store keeps `posOrderTypes` in memory only: it is left out of what `pos-settings` persists, so
a new cart is moved only by what the store's settings say on this visit, never by a list kept from
an earlier one. A sign-out or a change of store empties it (`useReceiptSettingsSync.ts`), so the
next store starts with every type offered until its own settings arrive.

The setting changes only the switch. The order routes accept every type whatever it holds, and no
Settings screen exposes it. `tests/pizza-order-types.test.ts` covers the rule.

### Pizza screens

[`frontend/src/components/pos/pizza/`](../../frontend/src/components/pos/pizza) holds the pizza
screens of the cashier POS. They show only while `hasPizzaMenu()` holds, which needs a loaded menu
with at least one pizza. Otherwise `usePizzaPos` returns `null` and the POS page, the product grid,
and the cart panel render as they do without the fork.

| Module | Contents |
| --- | --- |
| `usePizzaCatalog.ts` | `usePizzaCatalog()` holds the pizza menu as React state, `null` unless `hasPizzaMenu()` accepts the catalogue. It calls `loadPizzaCatalog()` when its component mounts and again whenever the session token changes, which covers a sign-in. The dashboard layout calls it, so every dashboard screen has the catalogue, and a reprint from the orders page builds its detail lines from it. |
| `usePizzaPos.tsx` | `usePizzaPos(products, categories, selectCategory)` is the POS page's one pizza hook. It owns the open sheet, calls `usePizzaDeal` for deals, `useQuickButtonSheet` for quick buttons and `useSmallItems` for the dips and drinks popup, and returns a `PizzaPos`: the category blocks and the tile renderer for the product grid, which draws a pizza product as a `PizzaTile` and a deal product as a `PizzaDealTile`, `sorted`, which puts the half-and-half product first whatever order the grid sorted its products in, `open` for a product reached without a pizza tile (search, a customer's top items, a scanned product, a deal's tile), `edit`, `customizeOne`, `lineClass` and `lineMark` for the cart panel, `above` for the quick buttons over the tiles, and the element the page mounts, which is the open sheet or the open deal configurator. `open` on a deal product, and `edit` and `customizeOne` on a deal line, open the configurator; a deal line counts as a pizza line, so it has the same action row. It selects the Pizzas category once, when the catalogue and that category are both present. |
| `PizzaHome.tsx` | `PizzaCategoryBlocks` takes the props of the product grid's category row and shows the top-level categories, with All first, as blocks in each category's colour; the chosen block has a ring and a tick. `PizzaTile` shows a menu pizza in two rows of 48 px. The first is its number and its name, which wraps and is never clamped, and is one button named "Customize" with the pizza's name: it opens the sheet on that pizza with no size chosen. The second has one button per size variant: a tap adds that plain pizza. The tile has no ingredient line; the sheet shows the ingredients. `HalfAndHalfTile` is the `pz-half-and-half` product as one row across the grid, first on the screen: a size button opens the sheet as a half and half at that size. `PIZZA_GRID_CLASS` lays the tiles in three columns beside the open sidebar at 1180 × 820, so that row and twelve pizzas show without scrolling. A product that is neither a pizza nor a deal keeps the grid's own tile and dialog. |
| `PizzaSheet.tsx` | The pizza sheet, a Radix dialog over `sheetReducer` and `sheetLine`: size, whole or half and half, the pizza on each half side by side (a `PizzaChoice` each), ingredient chips, cook, cut, dip steppers, note, quantity, the price, and the "Prints as" box. A tapped ingredient is pressed and reads `NO` with its name struck through. Add (Save when a cart line is open) is disabled while `sheetLine` refuses the pizza, and its message shows beside the button. The message sits in a status element that is always present and describes the button. A tap outside the dialog does not close it; Escape and the close button do. On close the focus returns to the control that opened the sheet, or, when that control is gone because the line it stood on was saved under a new identity or merged, to the Edit button of the line the sheet wrote. Prices are the catalogue's cents divided by 100, which is exact because the menu load refuses a currency not counted in hundredths. The file exports the editor's parts, which the deal configurator shows on each pizza tab: `WholeOrHalf`, `PizzaHalves`, `CookAndCut`, and under them `Segmented` and `PizzaStepper`. |
| `PizzaCartLine.tsx` | `PizzaLineDetails` puts `cartLineDetailLines` under a line's name. `PizzaLineActions` is the action row of a pizza line: a quantity stepper, "Customize 1" on a line of two or more, and Edit. It replaces the cart panel's own edit and quantity controls on that line; remove and price override stay the cart panel's. While `usePizzaLineFolded` holds for the line it shows `PizzaLineFold` in place of the row. |
| `usePizzaDeal.tsx` | `usePizzaDeal(catalog)` owns the open deal configurator. A product or cart line is a deal when its product id is `dl-` and the id of a deal in the catalogue; `of` gives that deal. `open` starts a deal with nothing chosen and `edit` loads a cart line's recipe. `PizzaDealDialog`, in the same file, renders the open configurator and saves it. Saving a new deal calls `useCartStore.addItem` with the deal product and the recipe. Saving an edited line calls `replaceCartLine` with only the recipe changed, so the quantity, note, add-ons and price override stay, and hands the new item list to `usePizzaPos`, which writes the cart and owns the "Customize 1" split and the focus. The line costs the product's price; the recipe never changes it. |
| `PizzaDeal.tsx` | The deal configurator, a Radix dialog over `dealReducer` and `dealLine`. The header has the deal's name, what it includes, its fixed price, and how many choices are made. Under it is a Radix tab row with one tab per choice: a done tab has a tick and its one-line summary, a missing one has `!`, a dashed edge and words. A pizza tab shows the size as set by the deal and the sheet's editor parts: whole or half and half, the pizza on each half, ingredient removals, cook and cut. It has no size, dips, note or quantity. The drinks tab has a stepper per drink whose plus switches off once the deal's cans are chosen, and, for a deal that offers cans or a bottle, the choice between them and one button per two-litre bottle. The wings tab has one button per flavour. Back and Next under the panel move along the tabs. The right-hand column has "Summary · prints as" (the heading, each done tab's ticket lines, one line in words per missing choice, and the `INCLUDES:` lines), a "Still missing" box whose buttons open the tab and move the focus to it, the deal price, and the Add button. Until every choice is made the button is disabled and reads how many choices are left, and `dealLine`'s message, which is `validateRecipe`'s, sits above it in a status element that describes the button; a pizza tab also shows that pizza's own message. A tap outside does not close the dialog. It opens with the focus on the open tab, and on close the focus returns as the sheet's does. |
| `PizzaChoice.tsx` | `PizzaChoice` is which pizza a half, or the whole pizza, is, in the sheet and on a deal's pizza tab. With no pizza chosen it lists every pizza of the menu as a grid of buttons with number and name. Once one is chosen it shows only that pizza and a Change button, so the ingredient chips stay on screen however long the menu is; Change lists the pizzas again with the chosen one pressed. After a tap that swaps the list for the pizza, or back, the focus moves to the control that took the tapped one's place. |
| `PizzaDealTile.tsx` | `PizzaDealTile` is a deal on the home screen: its name, its price, and the deal's description from the menu file cut to two lines. The configurator it opens shows the description whole. It carries the grid's `pos-product-card` test id, and a tap goes through the product grid's own click, so a quantity typed in the search (`3*`) is checked there and the configurator adds that many. |
| `SmallItems.tsx` | The dips and drinks popup and the folded cart rows. `SmallItemBlocks` is the category row of the pizza home: `PizzaCategoryBlocks` with a Dips block after the category the dip is sold under. That block and the block of the category `popupCategory` names open the popup and select no category; the block that opened it is shown as chosen while it is open. With no dips row and no drinks row the blocks are plain categories. The popup is a sheet over the lower part of the product area, drawn in a portal at the measured place of the product grid. It is not modal: the product grid behind it is dimmed and `inert`, and the cart panel and the POS shortcuts stay in use. It has one labelled group per row of `smallItemRows`, with the row's price, and one tile per choice. A tap on a tile calls `useCartStore.addItem` with `tileAdd`. A tile whose item is in the order shows the count from `tileCount` and a minus that takes one off the last line of `tileLines`; a tile `tileSoldOut` refuses is disabled and reads "Sold out". Done, Escape and a tap on the dimmed area close it, and nothing is pending when it closes. Escape is heard on `window` and acted on only after every other listener has run, and is left alone once the POS page's own handler or a dialog has taken it, so a window opened from the order closes first. The focus starts on the sheet itself, so the Enter that ends a barcode scan presses no tile, and returns to the block that opened it. A tap on a tile or its minus with a pointer puts the focus back on the sheet for the same reason; a key press leaves it on the control. If the rows go away while it is open, or the chosen category changes, it closes and stays closed. The Quick Buttons block stays last in the row and is not the popup's: the popup opens over the quick buttons page as over any category, and that page is there again when it closes. `useSmallItems(catalog, products)` keeps the rows in a small store, because the product grid renders the blocks and gives them no product list. The store also holds the line a tile just added to and the line last touched; a subscription to the cart clears the first and moves the second on every change of the cart's lines. `lineMark` puts the word "added" beside the name of the line just added, and `lineClass` tints it. A folded line also hides the "Save as quick button" row under it, through the class `lineClass` gives every cart line; an ordinary line and the unfolded line keep that row. `PizzaLineFold` is a folded pizza line's quantity and one button whose tap target is the whole line; it unfolds that line, which folds the others, and moves the focus to the line's Edit button. |

Saving looks up the product, the size variant, and the dip add-ons in the POS page's product list
by the ids `sheetLine` derives. If one is missing, because the catalogue was edited after the menu
was loaded, the sheet adds nothing and shows a message. A new pizza goes through
`useCartStore.addItem`; an edited line goes through `replaceCartLine`, keeping its price override
and, through `sheetAddons`, its add-ons from any group other than dips. "Customize 1" writes
`customizeOne`'s item list to the cart and opens the sheet on the split line; closing the sheet
unsaved merges that line back with `replaceCartLine`, and so does the POS page unmounting while
the sheet is open.

The hooks in upstream files are: `usePizzaCatalog()` in the dashboard layout; in the POS page the
`usePizzaPos` call, one line each in the product tap handler, the dialog-open guard, and the cart
panel's edit handler, the `pizza` prop on the product grid and the cart panel, and the sheet mount;
in `ProductGrid.tsx` the `pizza` prop, which swaps the category row, the grid columns, the order of
the products, and the tile of a pizza or deal product; in `CartPanel.tsx` the `pizza` prop, which adds the detail lines, the action row, the
classes of a cart line, and the "added" mark beside its name. Every pizza control is at least 48 px in both directions.

`frontend/e2e/pizza-pos.spec.ts` drives these screens in Chromium against the sample menu: the home
with a menu, with none, and with one that has no pizzas, a one-tap pizza, a half and half, identical
halves, "Customize 1", an edit that merges two lines, leaving the POS with a "Customize 1" sheet
open, a cash order read back through the API, the sheet with the keyboard alone, and
control sizes at 1180 × 820. Every spec shares one database and a loaded menu cannot be unloaded.
So the spec answers the catalogue request itself for the two cases without a pizza menu, loads the
sample with `loadSampleMenu` from `frontend/e2e/helpers/pizza-menu.ts`, and ends with that file's
`clearPizzaMenu`, which leaves the POS as it is without the fork for the specs that run after it.

`frontend/e2e/pizza-deal.spec.ts` drives the deal configurator the same way, at 1180 × 820: the
tabs of each deal in the sample, Add off with its count until every choice is made, the three-pizza
deal's summary and cart line, "Still missing", an edited deal line, a cash order whose stored
`modifier_selection` is the recipe built, the six-pizza deal with nothing scrolling sideways and
every control at 48 px, and the keyboard alone.

### Sent pizzas and deals

[`SentPizzaLine.tsx`](../../frontend/src/components/pos/pizza/SentPizzaLine.tsx) shows what is on a
pizza or deal line of an order already placed, and lets it be changed. `SentPizzaLine` renders the
lines of `sentDetailLines` under the item's name, at the cart's width. A recipe that cannot be
written out shows `RECIPE NOT PRINTED - CHECK ORDER` with a warning icon, once the catalogue request
has answered. An item with no recipe renders nothing, so a shop with no pizza menu sees upstream's
list. It is mounted in three lists: "Already ordered" in the POS cart panel, the item list of the
Orders page in both layouts (`OrderDetailPanel.tsx` and `OrderCard.tsx`), and the kitchen list of
the Server App's ticket panel. The Server App page has its own API client and sign-in, so it
fetches the menu itself with `useFetchedPizzaMenu(api, user?.id)`, through its server's forward of
`GET /api/pizza/catalog`, and hands it to `SentPizzaLine` as `menu`.

Given the order, the component also shows "Change pizza" on a line of a pizza product and "Change
deal" on a deal line, 48 px high. The button shows when a catalogue is held, the lines could be
written, the user has `orders.item.edit`, and `isOrderItemEditLocked` does not lock the order: a
paid, completed or cancelled order, or a paid scheduled one, has no button. Two more lines have
none: one whose earlier edit has no confirmed answer yet, as upstream hides its own edit control
until the Orders page resolves it, and one with an add-on that has no id (`sentLineChangeable`),
which the route would refuse. It opens the pizza sheet or the deal
configurator on the sent line. An item the kitchen has started does not open: the tap shows
upstream's message that only the quantity can change. A line with a price override or a discount
(`sentLineRepriced`) opens with a warning that saving a change returns it to the menu price, because
the server prices a replacement from the catalogue. Save sends `sentLineEdit`'s body through the
order's item edit route as the Orders page's edit window does: the attempt is stored with
`order-item-edit-attempt.ts` before it goes, under a fresh `Idempotency-Key`, and cleared on a
commit or a refusal, so an answer that never arrives is resolved from the Orders page. A refusal shows the server's message and leaves the sheet
open; a `409` also reads the order again. After a commit the component reads the order with
`GET /orders/:id` and hands it to `onSaved`: the POS page sets it as the reopened order, and the
Orders page refreshes its list. The server cancels the changed line and adds a new one, so the
focus moves to the "Change" button of the order's newest item. The deal configurator changes the
recipe only; quantity, add-ons and note stay. Saving an unchanged line sends nothing.
`useSentLineOpen()` is true while a sent line is open, and `usePizzaPos` counts it in `sheet`, so
the POS page suspends its barcode scanner and shortcuts.

`sentToPos(product, message)` in `lib/pizza/sent-to-pos.ts` is the guard on the three places that add a product through
upstream's dialog, which cannot build a recipe: "Add Item" on the Orders page, the product grid of
the Server App (a tap and a scanned size), and "Replace item" in the Orders page's edit window when
the product picked is not the line's own. For the half-and-half product and for a deal it shows "Add
a half and half or a deal from the POS" and adds nothing; any other product goes on as before. The
edit window itself sends no `modifier_selection`, so a changed quantity or size keeps the stored
recipe.

The hooks in upstream files are: in `CartPanel.tsx` the `onExistingOrderChange` prop and
`SentPizzaLine` under each "Already ordered" row; in the POS page that prop set to the reopened
order's setter; in `OrderDetailPanel.tsx` and `OrderCard.tsx` `SentPizzaLine` under each item; in
the Orders page and `EditOrderItemModal.tsx` the `sentToPos` line; in the Server App page
`SentPizzaLine` under each kitchen row, the `useFetchedPizzaMenu` call, and the `sentToPos` line in
the two product handlers; in `main/server-app.ts` the forward of `GET /api/pizza/catalog`.

`frontend/e2e/pizza-sent-orders.spec.ts` drives this in Chromium at 1180 × 820 against the sample
menu, with the shop set to pay-later with tables for its duration, because the POS reopens an order
from its table: the lines in the POS and on the Orders page, a half and half and a deal changed from
the POS and read back at the same price, a pizza changed from the Orders page, a refusal shown in
the server's words, the edit window changing quantity and size with the recipe kept, "Add Item"
refusing a half and half and a deal and adding a drink, the warning words with the catalogue request
answered 404, a cashier with no change button and a 403 from the route, a line with an unanswered
edit, a line with a price override, and the Server App's list and guard. It cancels every order it
places and deactivates the cashier and the tables it creates.

`frontend/e2e/pizza-full-menu.spec.ts` loads a menu of 26 pizzas and 8 deals grown from the sample,
with three names of 38 or 39 characters, and checks at 1180 × 820 that the half-and-half row and
twelve pizzas show without scrolling, that the list is about two screens long, that a long name
shows whole on two lines, that with both halves chosen in the sheet and on a deal's pizza tab the
ingredient chips of both are on screen and Change brings the list back, that the Deals category
shows all eight deals with their descriptions, and that the kitchen display's lines for a deal end
with `INCLUDES:`. How many tiles fit depends on the rows of category blocks above them, four blocks
to a row, so the spec answers the page's category request with the menu's four categories only,
which with All, Dips and Quick Buttons make two rows. One case adds two more categories: the ninth
block starts a third row, and nine pizzas show without scrolling.

### Quick buttons

A quick button is one cart line saved under a label and a colour, for the whole shop or for one
customer. The routes are [pizza quick buttons](../reference/api.md#pizza-quick-buttons). The screens
show with the pizza screens, while `usePizzaPos` returns a `PizzaPos`.

| Module | Contents |
| --- | --- |
| `lib/pizza/quick-buttons.ts` | No React. `fetchQuickButtons`, `saveQuickButton`, `updateQuickButton`, and `deleteQuickButton` are the four requests. `buttonContents` gives what the route stores of a cart line: product, variant, the recipe through `lineRecipe`, add-ons as id and quantity, and the note. `buttonLine` builds the line a tap adds from the POS page's product list, with that product's own variant and add-on objects, so `generateCartItemId` gives the id of the line the button was saved from. It is `null` when the button's `usable` is false, when the list lacks the product, the variant, or an add-on, or when `buttonSoldOut` finds the variant sold out by `isVariantSoldOut`, the rule the size buttons of a pizza tile use. `buttonPrice` is the variant or product price plus the add-ons, at the variant's online price while the order is for an online platform, as the cart charges it; the server stores no price. `buttonSummary` is the one line a tile shows. `buttonSheetLine` turns a button into the line the pizza sheet opens on, under an id `sheetButtonId` reads back, and `isPizzaButton` says which buttons the sheet can open. `refusalMessage` reads the server's `error` text. |
| `components/pos/pizza/useQuickButtons.tsx` | `useQuickButtonStore` is a Zustand store of the listed buttons and the open dialog; `load(customerId)` lists for that customer, `load()` lists again for the last one, and only the latest answer is kept. The area passes the id of `cart.customer`, the customer the cart panel shows, when the user may keep a customer's buttons, and no customer otherwise, because the route refuses a customer's list to anyone else. The same customer is the one a save is for. `useQuickButtonRights()` mirrors the routes: `catalog.manage` for shop-wide buttons, `orders.create` for a customer's. `QuickButtonsBlock` is the block among the category blocks, with the number of shop-wide buttons. `QuickButtonSaveAction` is the "Save as quick button" control of a cart line and of the pizza sheet; it renders nothing for a user who may save for neither the shop nor the order's customer. `useQuickButtonSheet()` tells `usePizzaPos` whether a dialog is open and takes a pizza the sheet saves for a button. |
| `components/pos/pizza/QuickButtons.tsx` | `QuickButtonsArea` sits in the product grid's scroll area above the tiles. It lists the buttons when it mounts and when the cart's customer changes, shows the page or the favourites row, and mounts the open dialog: save, label and colour, or the delete confirm. |

The Quick Buttons block selects the id `quick-buttons` in place of a category. No product has that
category, so the product grid shows no tiles and `QuickButtonsArea` shows the page: the favourites
of the order's customer first, with a tile that saves a line of the order for them, then the
shop-wide buttons in the server's order. Each tile has the button's colour, its label,
`buttonSummary`, and `buttonPrice`. A tap calls `useCartStore.addItem` with quantity 1, so a second
tap raises the quantity of the same line. A button with no `buttonLine` is grey and shows, beside an icon, the server's
`reason` or that its size is sold out. Its add control is `aria-disabled` and ignores a tap, so the
keyboard still reaches the reason. While the Pizzas category or All is open
and the customer has buttons, they show as one row above the pizza tiles.

The `⋯` menu of a tile shows only to a user who may change that button. "Edit label & colour" and
"Delete button" open a dialog; "Edit the item", offered on a pizza or half-and-half button, opens the
pizza sheet on `buttonSheetLine`, and the sheet's Save sends the button's new contents with
`updateQuickButton` and leaves the cart alone. A menu entry acts after the menu has closed and the
focus is back on `⋯`, so the dialog or sheet returns the focus there; when the tile is gone after a
delete, the open category block takes it. The save dialog shows what the button adds, a preview
tile, the label with its count out of 24, one swatch per category colour with its name and a tick on
the chosen one, and "Show for": the shop, the order's customer, or both, as the user's permissions
allow. The pizza sheet shows "Save as quick button" for a new pizza it accepts; that opens the save
dialog over the sheet and adds nothing to the order. A request the server refuses shows its message
as a toast and leaves the dialog open.

The hooks in shared and upstream files are: in `ProductGrid.tsx` the exported `CATEGORY_COLORS` and
the `pizza.above(selectedCategory)` slot; in `CartPanel.tsx` `QuickButtonLineAction` under each cart
line; in `PizzaHome.tsx` `QuickButtonsBlock` after the category blocks; in `PizzaSheet.tsx` the
`onSaveButton` prop; in `usePizzaPos.tsx` the `above` slot, the `useQuickButtonSheet()` call that
`save` asks first, and `sheet`, which is `true` while a quick button dialog is open and no sheet is,
so the POS page suspends its barcode scanner and shortcuts as for any modal.

`tests/pizza-quick-buttons-ui.test.ts` runs `lib/pizza/quick-buttons.ts` against the real routes of
a store with the sample menu loaded: each kind of cart line is saved and comes back under the same
cart line id. `frontend/e2e/pizza-quick-buttons.spec.ts` drives the screens in Chromium: the block
and the page, saving from a cart line and from the sheet, a tap and a second tap, relabel and
recolour, "Edit the item", delete with its confirm, a customer's favourites, a button whose pizza
left the menu, a deal saved from its cart line, a cashier's view, a refused request, and the keyboard alone. It deletes every button
it saves and deactivates the cashier it creates; the API has no route that deletes a customer, so
its two customers stay.

`frontend/e2e/pizza-small-items.spec.ts` drives the popup and the folded rows the same way, at
1180 × 820: both blocks opening the popup beside a usable order, two taps making one line of two,
the minus down to nothing, a can and a two-litre as separate lines, the three ways to close, Escape
with an edit window, the quick-button dialog or the pizza sheet open over the popup, Enter on a
popup that has just opened and after a tap, a folded deal or pizza line without the quick-button row and an ordinary line with it, five pizza
lines in the cart without scrolling,
the popup over the quick buttons page, the
folding past three lines, an order from the popup stored with the same lines, totals and tax as the
same items from the product grid, the popup with the keyboard alone, control sizes, and a menu
with no dips and no drinks.

## Printing

The renderer's print surface is a decision tree, not a single path. All of it lives in
[`usePrinterStore`](../../frontend/src/hooks/usePrinter.ts), and the shared kernel, renderers, and
transports are described in [Printing architecture](printing.md). Before dispatching a bill or tax
bill, `usePrinterStore` awaits tenant-scoped receipt settings hydration
(`ensureReceiptSettingsLoaded(expectedTenantId)`, backed by
[`useReceiptSettingsSync`](../../frontend/src/hooks/useReceiptSettingsSync.ts)) so storefront
branding and receipt metadata are loaded into `pos-settings.ts` from `GET /api/settings/business`
before rendering. Switching `currentTenant` invalidates cached hydration and forces an immediate
re-sync (bypassing the 60-second focus throttle), and any in-flight bill or tax-bill print whose
active tenant changes aborts with `PrintCancelledOnTenantChangeError`.

For a bill or a kitchen ticket, in the order the store tries them:

1. **Hardware thermal printer, ESC/POS.** `POST /api/printers/print-bill` or `/printers/print-kot`,
   which requires `printing.execute`. The backend encodes and sends. If the backend reports that no
   default printer is configured, the store falls through to browser printing and says so in a
   toast.
2. **Native raster, then WebUSB.** When the printer's profile advertises raster support, the
   renderer builds a `PrintDocument` or `KotDocument` and asks the main process to rasterize it
   through `rasterizePrintDocument` or `rasterizeKotDocument`, then writes the returned bytes over
   `navigator.usb`. A raster failure is not fatal: the store falls back to the encoder path and
   records a warning.
3. **WebUSB, encoder output.** `buildClassicReceiptBytes`, `buildCompactReceiptBytes`,
   `buildTaxBillBytes`, and `buildKotBytes` encode in the renderer, and `PrinterService` writes
   the bytes over `navigator.usb`. The store awaits any startup reconnect first, so a silent
   re-attach is not mistaken for an absent printer.
4. **Browser printing.** `lib/printer/web-print.ts` and `kot-web-print.ts` render HTML and open the
   system print dialog. This is also the fallback whenever no thermal transport is connected.

### The courier slip takes a shorter path

`printDeliverySlip` is the fourth print action, and it skips step 2's main-process raster IPC. A
delivery slip carries
the address, the full contact block, payment/collection status, and order lines, and it resolves
through three routes:

1. `POST /api/printers/print-delivery-slip` when a hardware printer is configured.
2. `buildDeliverySlipBytes` in
   [`delivery-slip-encoder.ts`](../../frontend/src/lib/printer/delivery-slip-encoder.ts) over
   WebUSB.
3. `generateDeliverySlipHtml` in
   [`delivery-slip-web-print.ts`](../../frontend/src/lib/printer/delivery-slip-web-print.ts) for
   the system print dialog.

Both renderer-side slip files build the slip from a small order projection and the order's latest
bill summary rather than from the kernel's `DeliverySlipDocument`. That model and
`buildDeliverySlipDocument` exist in
`shared/print/document.ts` and are consumed by the backend renderer
[`main/printers/document-delivery-slip.ts`](../../main/printers/document-delivery-slip.ts), so the
rule that a renderer consumes a document does not hold for the WebUSB and browser slip paths.
The projection carries the order and delivery notes, and the summary from
`GET /api/printers/delivery-slip-payment/:orderId` carries the expected collection method, which
all three paths word through `deliverySlipExpectedPaymentText` in `shared/print/document.ts`. The
cart records both delivery details and the delivery address in its order-details summary and drawer,
and only for delivery orders.

The action is reachable on an unpaid delivery order, because that is the workflow: the courier
leaves before the customer settles. `OrderCard` renders it outside the payment branches, limited to
delivery orders and hidden for cancelled ones. The slip prefers the address confirmed on that
order and falls back to the customer's standing address, which is what every order created before
the column existed resolves to.

Whether the customer's phone number appears is the one place where the two slip paths are **not**
reading a shared rule, and the duplication is load-bearing to know about. The bill paths call the
kernel's `shouldShowCustomerNumber`: the renderer bill document in
[`print-document.ts`](../../frontend/src/lib/printer/print-document.ts), the renderer tax-bill
encoder, and the backend bill route in
[`main/routes/printers.ts`](../../main/routes/printers.ts). The slip paths each re-implement the
rule inline instead, with no call into the kernel:

| Path                                                                                            | How it decides                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| renderer slip, `printDeliverySlip` in [`usePrinter.ts`](../../frontend/src/hooks/usePrinter.ts) | `billDeliveryShowCustomerPhoneAlways \|\| billShowCustomerPhone` |
| backend slip, `main/routes/printers.ts`                                                         | the same boolean, read from the settings table directly          |

The two agree today because the rule is two settings wide. They are separate code, so a change to
one does not reach the other, and this is the duplication that let a slip lose the number when the
delivery override was off. Treat a change to this rule as a change in four places, or fix the
duplication first. [Product invariants](../reference/product-invariants.md#a-receipt-and-a-courier-slip-are-not-secure-artefacts)
owns the rule itself.

Warnings travel with every result. `hasFinancialPrintWarning` refuses the whole receipt rather than
print a total the printer cannot represent, which is why a capability failure is a thrown error and
not a toast.

Print locales are warmed at authentication and gated behind the active tenant's bootstrap barrier
before any print resolves or encodes labels; see
[warming print locales at bootstrap](internationalization.md#warming-print-locales-at-bootstrap).
The auth store keeps any languages that failed to warm, and a locale that still will not load
becomes a receipt warning saying English labels were used. A receipt that renders in the wrong
language is a financial document, not a cosmetic bug.

## Internationalization: 32 locales

[`frontend/src/lib/i18n/languages.ts`](../../frontend/src/lib/i18n/languages.ts) is the renderer's
registry. It holds 32 entries, and
[`frontend/src/lib/i18n/messages/`](../../frontend/src/lib/i18n/messages) holds one JSON file per
entry. Each registry entry carries the BCP-47 locale tag, the native name, the text direction, the
`selectable` flag, and a dynamic chunk loader.

[`loader.ts`](../../frontend/src/lib/i18n/loader.ts) imports English statically and seeds the cache
with it, then loads every other locale through its dynamic import. In-flight requests are
deduplicated, and an unregistered locale key falls back to English. It adds the English-only pizza
strings to every catalogue as the `pizza` namespace; see
[internationalization](internationalization.md#english-only-pizza-strings).
[`I18nProvider`](../../frontend/src/components/providers/I18nProvider.tsx) wraps the tree in
`use-intl`'s provider, holds the last language that actually loaded, and reverts the store to it
when a later load fails, so a broken chunk leaves the screen in the language it had rather than in
none.

Direction is applied rather than assumed: `getLanguageDirection` feeds `HtmlLangSync`, the `Ltr`
island wrapper, and `DirectionalToaster`, so a right-to-left locale mirrors the chrome and leaves
numeric and Latin runs isolated.

Backend enums reach the interface through
[`frontend/src/lib/i18n-enums.ts`](../../frontend/src/lib/i18n-enums.ts), which maps each enum value
to a message key rather than carrying English text.

Adding a locale is a scripted procedure with its own verification commands, documented in
[Adding a language](../guides/adding-a-language.md). `npm run i18n:check` is the gate: leaf parity
against `en.json`, the derived print-label table, and a `tsc` pass over the frontend.

## Customer display

`/customer-display` is a signed-in order-status board. Without a paired display token it loads the
staff session from storage and redirects to `/auth/login?redirect=/customer-display` (or adds
`select_tenant=true` when a user is signed in without a selected tenant) so signing in returns to
`/customer-display`. Once signed in, it pages through `GET /orders` with
`view=active`, `board_status` set to the configured statuses, and `type` set to the configured
`order_types` via `before_id` cursor pagination (100 orders per page, up to 50 pages) so effective
board status and order-type eligibility apply in SQL before pagination, projects effective board
status from `order.items` for settled `completed` orders via `projectBoardStatusFromItems` in
[`shared/order-item-status.ts`](../../shared/order-item-status.ts) (see
[Order lifecycle](order-lifecycle.md#order-status)), and shows eligible orders in a Preparing
column (`pending`, `preparing`) and a Ready column (`ready`).
It re-reads `GET /settings/customer-display` on every poll cycle, so changes made in Settings >
Kitchen Display apply without reloading the board. The tenant-wide config sets which statuses show
(`statuses`, defaulting to `['pending', 'preparing', 'ready']`), which order types show
(`order_types`, defaulting to `['takeaway']` so Dine-in, Online, and Delivery orders stay off the
pickup screen unless enabled), the refresh interval (`refresh_seconds`), and whether the
last-updated time is shown (`show_updated`). Deduplicated orders are sorted oldest first and
applied atomically once all pages complete in a cycle, preserving the ten-second TV
visual page rotation. At desktop widths, each column renders complete bill or order numbers in
readable rows and independently rotates measured pages every ten seconds when needed, showing a
multi-page indicator (`1 / N`, page dots, and a `+count` overflow pill) and a ten-second progress
bar in the column header when orders span multiple pages. Newly ready
orders take priority on the next rotation, interleaved with existing pages. At narrow widths the rows
remain in one scrollable flow. A failed poll retains the last successful orders and reports that the
feed is stale. Multi-page poll cycles automatically pace their interval above the configured refresh
time when necessary to stay within the 120 requests per minute API limit. The same settings card
shows the display URL with copy and open actions. Strings come from the `customerDisplay` message
namespace.

An owner or manager can also pair a standalone device (a TV or tablet browser) from the same card.
The card loads the POS server's LAN addresses and uses the selected address for both the display URL
and pairing link. The primary LAN address is selected first; other network interfaces, mDNS, and a
clearly labelled local preview can be selected before pairing. Switching addresses updates the
one-time link without creating another token. If no LAN address is available, the card says so and
offers only the local preview; if address lookup fails, it shows an error and retry action. The board
moves the token from the URL fragment into `localStorage` and polls
`GET /api/customer-display/feed` ([API reference](../reference/api.md#customer-display-feed)) with
it instead of using a staff session, so it needs no login and can read nothing but order numbers and
statuses. It follows `next_cursor` across pages (100 orders
per page, up to 50 pages) to display the complete eligible queue, deduplicating orders and updating
the board state atomically per poll cycle. When the feed answers `401` (the token was revoked),
in-flight requests abort immediately, the board clears the stored token and orders, and shows an
unpaired screen.

## Tech stack

| Layer            | Technology                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- |
| Framework        | Next.js 16 App Router                                                              |
| UI runtime       | React 19                                                                           |
| State            | Zustand 5                                                                          |
| Styling          | Tailwind CSS v4                                                                    |
| Components       | shadcn/ui primitives vendored in `src/components/ui`, built on `radix-ui`          |
| Icons            | lucide-react                                                                       |
| API client       | axios                                                                              |
| Notifications    | react-hot-toast                                                                    |
| Messages         | use-intl                                                                           |
| Drag and drop    | `@dnd-kit/react` and `@dnd-kit/dom`                                                |
| Drawer           | vaul                                                                               |
| Receipt encoding | `@point-of-sale/receipt-printer-encoder`, plus the shared kernel in `shared/print` |
| Device I/O       | WebUSB (`navigator.usb`) and the `window.electronAPI` bridge                       |
| Image handling   | react-dropzone, react-easy-crop                                                    |
| Phone numbers    | libphonenumber-js                                                                  |

The `shadcn` CLI can be invoked on demand via `npx shadcn` to add primitives; the primitives under
`src/components/ui` and the Tailwind utilities in `src/app/shadcn-tailwind.css` are vendored in the
repository and edited in place.

## Project structure

```text
frontend/src/
├── app/                        App Router routes
│   ├── (dashboard)/            Authenticated shell: AuthGuard, title bar, sidebar, status bar
│   │   ├── addon-groups/  customers/  dashboard/  inventory/  kds/
│   │   ├── order-history-demo/  orders/  pizza-menu/  pos/  print-test/
│   │   ├── products/  settings/  staff/  support/  tables/  whatsapp/
│   ├── auth/                   login, register, recover
│   ├── customer-display/       Customer-facing order-status board
│   ├── kds-standalone/         Standalone KDS, served by the :3002 base port
│   ├── server-standalone/      Standalone Server App, on the :3003 base port
│   └── setup/                  First-run setup wizard
├── components/
│   ├── dashboard/              Cash close, cash drawer movement, shift open and close
│   ├── kds/                    Kitchen display, login, tabs and kanban views
│   ├── layout/                 Title bar, sidebar, status bar, auth guard, theme sync
│   ├── orders/                 Order card, history grid, refund modal
│   ├── pos/                    Cart, product grid, payment, number pad, checkout modals,
│   │   │                       payment queue drawer, payment ticket modal
│   │   └── pizza/              Pizza home tiles and category blocks, the pizza sheet,
│   │                           the deal configurator, pizza cart lines, the dips and drinks popup
│   ├── products/               Product image uploader
│   ├── providers/              I18nProvider
│   ├── settings/               The settings screen's building blocks:
│   │   BetaChannelToggle, ChargesSettingsCard, CountersSettingsTab,
│   │   CurrencyResetDialog, DatabaseSettingsTab, GeneralSettingsTab,
│   │   HealthCheckDialog, InitializeDatabaseDialog, LocalePreferencesPanel,
│   │   MasterPinPrompt, PaymentMethodsSettings, PermissionAuditLog,
│   │   PermissionMatrix, PrintersSettingsTab, SettingsTabShell,
│   │   TaxConfigurationPanel, Toggle, WhatsAppEnableCard
│   ├── support/                The support hub: SupportTicketForm, DiagnosticsPanel
│   ├── tables/                 Floorplan editor, table move modal, table turnover badge
│   ├── ui/                     shadcn/ui primitives
│   └── updates/                Update download prompt and install guard dialog
├── hooks/                      Printer, KDS, theme, update, cash, approver, and formatting hooks
├── lib/
│   ├── i18n/                   Language registry, loader, and the 32 message files
│   ├── pizza/                  Pizza catalogue, sheet and deal state, cart line changes, detail lines,
│   │                           popup rows
│   ├── printer/                Encoders, document builders, warnings, WebUSB bridge,
│   │                           and the delivery-slip encoder and browser renderer
│   ├── updates/                Beta channel, auto-check, and restart-and-install helpers
│   ├── api.ts                  The shared axios client for the authenticated pages
│   ├── api-error.ts            Localized text for a backend error
│   └── permissions.ts          tenantCan
├── store/                      auth, cart, charges, cloud-attention, held-orders,
│                               orders-layout, pos-settings, session-events, theme
└── types/                      Electron bridge declarations and the type-level contract
```

## Verification

| Change                                          | Check                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any renderer change                             | `npm run lint` and `npm run build:frontend`                                                                                                              |
| A message key, a new locale, or a changed label | `npm run i18n:check`                                                                                                                                     |
| A permission the renderer gates on              | `npm run test:authorization-permissions` and `npm run test:auth-ui-deterministic`                                                                        |
| A new or renamed IPC channel                    | `npm run test:electron-api-contract` and `npm run test:printer-ipc`                                                                                      |
| An IPC permission or settings authorization gate | `npm run test:settings-ipc-rbac` and `npm run test:update-ipc-sender-validation`                                                                         |
| The sender check on a database channel          | `npm run test:kds-window-hardening`, which drives `pick-restore-file`, `backup-database`, `restore-backup`, and `db-initialize` from an untrusted sender |
| A print path, template, or column width         | `npm run test:receipt-column-oracle`                                                                                                                     |
| The courier slip                                | `npm run test:delivery-slip`                                                                                                                             |
| A user-facing flow                              | `npm run test:e2e:browser` from the repository root                                                                                                      |

`npm run build:frontend` is the check that catches a server-side construct: it is the only build
that switches the export target on, so run it rather than a bare `next dev`.

### Lint engine

Oxlint lints both scopes, pinned to an exact version in each `package.json`. `npm run lint:backend`
runs `main/` and `shared/` against the root `.oxlintrc.json`; `npm run lint` adds the renderer
against `frontend/.oxlintrc.json`. Both configs switch every Oxlint category off and name each rule
with its severity, so a rule runs only because the config lists it. Explicit `any` is a warning
under `main/` and an error under `shared/`, which is also where the pure-kernel import boundary is
enforced at error severity.

Renderer declarations are linted except `next-env.d.ts` and
`src/types/receipt-printer-encoder.d.ts`. Oxlint reports a false `TS(2309)` for that ambient module
declaration ending in `export =`, which `tsc` accepts. `@next/next/no-img-element` stays off because
the static export cannot use `next/image`. React and React Hooks rules run directly as native Oxlint
rules without a JS plugin bridge.

`npm run lint:budget` reads the Oxlint JSON report for each scope and fails on an error-severity
diagnostic, on a run whose report it cannot read, and on warnings above
`scripts/ci/lint-budget.json`. Those limits are ceilings that ratchet down manually as warnings are
fixed incidentally, not targets to spend.
