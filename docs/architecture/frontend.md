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

| Server | Default port | Serves |
| --- | --- | --- |
| [`main/server.ts`](../../main/server.ts) | `PORT`, else 3001 | the API under `/api` and the exported pages |
| [`main/kds-server.ts`](../../main/kds-server.ts) | `KDS_PORT`, else 3002 | the standalone KDS |
| [`main/server-app.ts`](../../main/server-app.ts) | `SERVER_APP_PORT`, else 3003 | the standalone Server App |

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
  view renders its own inline login, and on the login page itself, where the login form reports the
  error.
- A `403` carrying `{ code: 'permission_denied' }` dispatches a `flo:authorization-denied` window
  event. [`AuthGuard`](../../frontend/src/components/layout/AuthGuard.tsx) listens for it and calls
  `refreshAuthContext`, so an owner tightening a permission takes effect on the next request
  instead of at the next sign-in.

Four things do not use it, and a new screen has to notice which kind it is:

| Path | How it reaches the API |
| --- | --- |
| [`kds-standalone/page.tsx`](../../frontend/src/app/kds-standalone/page.tsx) | builds its own axios instance on its own origin, because it runs on the `:3002` base port rather than the POS window's `:3001`, and on a `401` clears the token and reloads instead of redirecting |
| [`server-standalone/page.tsx`](../../frontend/src/app/server-standalone/page.tsx) | the same, against the filtered `:3003` proxy |
| [`i18n/server-language.ts`](../../frontend/src/lib/i18n/server-language.ts) | bare `fetch`, because it reads the tenant's language before a session exists |
| the KDS live feed | a WebSocket, described below |

The other `axios` imports in the renderer are `axios.isAxiosError` for error shape, not a second
client.

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

| | `shared/role-permissions.ts` | `shared/permissions.ts` |
| --- | --- | --- |
| Holds | the five role identities in `ROLE_DEFINITIONS`, the named role groups in `ROLE_ACCESS`, and the capability table `PERMISSION_CAPABILITIES` | `PERMISSION_DEFINITIONS`, one entry per runtime permission id, with its area, shipped default roles, `configurable` flag, and risk tier |
| Owner-editable | no, the identity list is a constant in the module | the grants are editable; the ids are not, because they are persistence keys |
| Who reads it | backend route middleware imports `ROLE_ACCESS` and `hasRole` | the backend resolves the effective set from SQLite on every protected action |

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

| Guard | Refuses | Status | Can a PIN satisfy it |
| --- | --- | --- | --- |
| `assertAdministrationReachable` | a write that would leave the install with no account that can administer it | 400 `administration_unreachable` | no, nothing rescues a stranded store |
| `assertActorKeepsOwnAdministration` | a write that would take any of the four away from the actor making it | 428 `self_privilege_change_requires_factor`, 403 if the factor is wrong, 409 if the actor has no PIN set | yes |

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
tenantCan(tenant, permissionId)
```

It returns `false` when there is no tenant. When the tenant payload carries a `permission_ids`
array it answers from that; otherwise it falls back to the shipped default for the tenant's role.
The array is what makes an owner-configurable grant visible to the renderer without a rebuild.

This is a UX gate. It decides what to draw, not what is allowed, and the backend re-resolves live
authorization on every protected request. A renderer that shows a control is not evidence that the
call behind it will succeed, and a renderer that hides one is not a security control.

Route gating lives in `AuthGuard`:

- `getLandingPage` returns the first page in a fixed list the tenant can reach. The list is ordered,
  not role-aware: `pos.use` is checked before `dashboard.view`, and `pos.use` ships to owners, so
  an owner lands on the POS like anyone else. The list is a fallback order for whichever surfaces
  are available, not a statement about what a role prefers.
- `PAGE_PERMISSIONS` maps a guarded route to the single permission id it needs. `/staff` and
  `/settings` are the two exceptions and carry an any-of list instead, because either screen
  aggregates several permissions. Adding a route means adding it to one of those three; a route in
  none of them is behind authentication and nothing else.
- `PUBLIC_PATHS` holds the unauthenticated surfaces: `/kds`, `/kds-standalone`,
  `/server-standalone`, `/auth/login`, `/auth/register`, `/auth/recover`, and `/setup`. The
  standalone KDS and Server App pages run their own session and skip the shared auth store, so
  loading it there would clear their token.
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
wrapper, which calls `isTrustedSender` before the listener runs and returns
`{ error: 'Unauthorized sender' }` to anything else. `isTrustedSender` requires the calling
frame's URL to be `http:` on `localhost` or `127.0.0.1`. That establishes **which window is
calling**. It does not establish **who is signed in**, and the single POS window serves every role
from chef to owner. Everything else in this section follows from that gap.

Registering a privileged channel with a bare `ipcMain.handle` skips the check. `pick-restore-file`,
`backup-database`, `restore-backup`, and `db-initialize` did that once; they go through the wrapper
now, and a new channel does too or it has not been reviewed.

### What the settings channel may write

One key. `set-setting` checks the key against `ALLOWED_IPC_KEYS`, which contains `theme_mode` and
nothing else, and rejects a value that is not one of `light`, `dark`, or `system`. Every other
setting is written over a permission-gated HTTP route, where the acting user is known. The read
side, `get-settings`, masks `jwt_secret`, `cloud_api_key`, `cloud_device_secret`,
`cloud_deletion_status_token`, and `cloud_last_error`, and collapses `cloud_last_error` to a
generic string.

The renderer writes the theme over HTTP too, with `PUT /api/settings/theme_mode`, which requires
`settings.manage`. The IPC settings channel exists with the theme key allowed; no renderer code
calls it today. Widening `ALLOWED_IPC_KEYS` means moving an authorization decision from a
permission-gated route onto a window-origin check, which is a different and weaker boundary.

### The database channels

Five channels do database work, and they are gated two different ways on purpose.

| Channel | Gate |
| --- | --- |
| `db-health-check` | sender check only; it reports, it does not write |
| `db-apply-safe-fixes` | sender check, then `authorizeMasterPin(pin, 'ipc:apply-safe-fixes')`, failing closed on a missing or wrong PIN |
| `backup-database` | sender check, then `authorizeMasterPin(pin, 'ipc:backup')` |
| `restore-backup` | sender check, then `authorizeMasterPin(pin, 'ipc:restore')` |
| `db-initialize` | sender check, then `authorizeMasterPin(pin, 'ipc:initialize')` **and** the exact confirmation phrase `INITIALIZE` |

`pick-restore-file` is the odd one out and is deliberately not Master-PIN gated. It opens the
native file picker and returns a path bound to a single-use token; it performs no destructive step.
The restore that path feeds is authorised over HTTP by a session holding `database.manage`, so the
origin check is the right gate for the picker and adding a PIN prompt to it would be theatre.

The HTTP twins of those repairs are gated separately, and not uniformly, by
[`main/routes/database-tools.ts`](../../main/routes/database-tools.ts). Every one of its nine routes
requires `database.manage`. Three of them add `requireMasterPin` on a `master_pin` body field:

| Route | Extra requirement |
| --- | --- |
| `POST /api/db-tools/initialize` | the Master PIN, then the `INITIALIZE` phrase |
| `POST /api/db-tools/currency-reset` | the Master PIN |
| `POST /api/db-tools/backups/:fileName/delete` | the Master PIN |

Of the remaining six, one matters here because its IPC twin is gated the other way:

| Interface | Gate |
| --- | --- |
| `db-apply-safe-fixes` over IPC | sender check, then the Master PIN, failing closed without it |
| `POST /api/db-tools/apply-safe-fixes` over HTTP | `database.manage`, and no PIN of any kind |

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
`isTrustedSender` applies, and a matching entry in `ElectronAPI`. If it is a privileged write, it
also needs an authorization step that can see the signed-in user, because the origin check cannot.

## State stores

Zustand holds the renderer's client state. Five stores live in
[`frontend/src/store/`](../../frontend/src/store), and the printer store lives with the printer
hook because it carries the transport:

| Store | Holds | Persistence |
| --- | --- | --- |
| [`auth.ts`](../../frontend/src/store/auth.ts) | `user`, `token`, `tenants`, `currentTenant`, `loading`, and the locales that failed to warm at bootstrap | token and tenant in `localStorage`; throws `StorageUnavailableError` when storage is unavailable |
| [`cart.ts`](../../frontend/src/store/cart.ts) | cart items with their addons, instructions and selected product variant, order type, table, customer, guest count, delivery details, and the subtotal and item count selectors | none |
| [`held-orders.ts`](../../frontend/src/store/held-orders.ts) | suspended orders keyed by table, and the fetch, hold, restore, remove, and lookup actions over `/held-orders` | none |
| [`pos-settings.ts`](../../frontend/src/store/pos-settings.ts) | the tenant's POS configuration, printer defaults, bill template and provenance, receipt and kitchen-ticket language policy | `persist` under the `pos-settings` key, version 4, with backend-synced fields excluded by `partialize` |
| [`theme.ts`](../../frontend/src/store/theme.ts) | `mode` and whether this session made an explicit choice | none; `useThemeModeToggle` writes through the API and rolls the store back when the write fails |
| [`usePrinterStore`](../../frontend/src/hooks/usePrinter.ts) | connection status, the hardware and WebUSB printer records, the print method, the last emitted bytes, and the print actions: `printBill`, `printTaxBill`, `printKot`, `printDeliverySlip` | `persist` |

`held-orders.ts` exports `createHeldOrdersStore(apiClient)`, so a test can pass its own client
instead of the shared one.

## Printing

The renderer's print surface is a decision tree, not a single path. All of it lives in
[`usePrinterStore`](../../frontend/src/hooks/usePrinter.ts), and the shared kernel, renderers, and
transports are described in [Printing architecture](printing.md).

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

`printDeliverySlip` is the fourth print action, and it has no raster path. A delivery slip carries
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
cart records both delivery details beside the delivery address, and only for delivery orders.

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

| Path | How it decides |
| --- | --- |
| renderer slip, `printDeliverySlip` in [`usePrinter.ts`](../../frontend/src/hooks/usePrinter.ts) | `billDeliveryShowCustomerPhoneAlways \|\| billShowCustomerPhone` |
| backend slip, `main/routes/printers.ts` | the same boolean, read from the settings table directly |

The two agree today because the rule is two settings wide. They are separate code, so a change to
one does not reach the other, and this is the duplication that let a slip lose the number when the
delivery override was off. Treat a change to this rule as a change in four places, or fix the
duplication first. [Product invariants](../reference/product-invariants.md#a-receipt-and-a-courier-slip-are-not-secure-artefacts)
owns the rule itself.

Warnings travel with every result. `hasFinancialPrintWarning` refuses the whole receipt rather than
print a total the printer cannot represent, which is why a capability failure is a thrown error and
not a toast.

Print locales are warmed at authentication, not lazily at render time. `syncPrintPoliciesAtBootstrap`
applies the tenant's receipt and kitchen-ticket language policy and loads the bundles it selects,
and the auth store keeps the languages that failed. Every print action calls
`ensurePrintLanguagesLoaded` again before it encodes, and a locale that still will not load becomes
a receipt warning saying English labels were used. A receipt that renders in the wrong language is
a financial document, not a cosmetic bug.

## Internationalization: 24 locales

[`frontend/src/lib/i18n/languages.ts`](../../frontend/src/lib/i18n/languages.ts) is the renderer's
registry. It holds 24 entries, and
[`frontend/src/lib/i18n/messages/`](../../frontend/src/lib/i18n/messages) holds one JSON file per
entry. Each registry entry carries the BCP-47 locale tag, the native name, the text direction, the
`selectable` flag, and a dynamic chunk loader.

[`loader.ts`](../../frontend/src/lib/i18n/loader.ts) imports English statically and seeds the cache
with it, then loads every other locale through its dynamic import. In-flight requests are
deduplicated, and an unregistered locale key falls back to English.
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

## Tech stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 App Router |
| UI runtime | React 19 |
| State | Zustand 5 |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui primitives vendored in `src/components/ui`, built on `radix-ui` |
| Icons | lucide-react |
| API client | axios |
| Notifications | react-hot-toast |
| Messages | use-intl |
| Drag and drop | `@dnd-kit/react` and `@dnd-kit/dom` |
| Drawer | vaul |
| Receipt encoding | `@point-of-sale/receipt-printer-encoder`, plus the shared kernel in `shared/print` |
| Device I/O | WebUSB (`navigator.usb`) and the `window.electronAPI` bridge |
| Image handling | react-dropzone, react-easy-crop |
| Phone numbers | libphonenumber-js |

The `shadcn` CLI is a development dependency used to add primitives; the primitives themselves are
committed under `src/components/ui` and are edited in place.

## Project structure

```text
frontend/src/
├── app/                        App Router routes
│   ├── (dashboard)/            Authenticated shell: AuthGuard, title bar, sidebar, status bar
│   │   ├── addon-groups/  customers/  dashboard/  inventory/  kds/
│   │   ├── order-history-demo/  orders/  pos/  print-test/  products/
│   │   ├── settings/  staff/  support/  tables/  whatsapp/
│   ├── auth/                   login, register, recover
│   ├── customer-display/       Customer-facing second display
│   ├── kds-standalone/         Standalone KDS, served by the :3002 base port
│   ├── server-standalone/      Standalone Server App, on the :3003 base port
│   └── setup/                  First-run setup wizard
├── components/
│   ├── dashboard/              Cash close, cash drawer movement, shift open and close
│   ├── kds/                    Kitchen display, login, tabs and kanban views
│   ├── layout/                 Title bar, sidebar, status bar, auth guard, theme sync
│   ├── orders/                 Order card, history grid, refund modal
│   ├── pos/                    Cart, product grid, payment, number pad, checkout modals
│   ├── products/               Product image uploader
│   ├── providers/              I18nProvider
│   ├── settings/               The settings screen's building blocks:
│   │   BetaChannelToggle, CurrencyResetDialog, DatabaseSettingsTab,
│   │   GeneralSettingsTab, HealthCheckDialog,
│   │   InitializeDatabaseDialog, LocalePreferencesPanel, MasterPinPrompt,
│   │   PaymentMethodsSettings, PermissionAuditLog, PermissionMatrix,
│   │   PrintersSettingsTab, SettingsTabShell, TaxConfigurationPanel,
│   │   Toggle, WhatsAppEnableCard
│   ├── support/                The support hub: SupportTicketForm, DiagnosticsPanel
│   ├── tables/                 Floorplan editor, table turnover badge
│   ├── ui/                     shadcn/ui primitives
│   └── updates/                Update install guard dialog
├── hooks/                      Printer, KDS, theme, update, cash, and formatting hooks
├── lib/
│   ├── i18n/                   Language registry, loader, and the 24 message files
│   ├── printer/                Encoders, document builders, warnings, WebUSB bridge,
│   │                           and the delivery-slip encoder and browser renderer
│   ├── updates/                Beta channel and restart-and-install helpers
│   ├── api.ts                  The shared axios client for the authenticated pages
│   ├── api-error.ts            Localized text for a backend error
│   └── permissions.ts          tenantCan
├── store/                      auth, cart, held-orders, pos-settings, theme
└── types/                      Electron bridge declarations and the type-level contract
```

## Verification

| Change | Check |
| --- | --- |
| Any renderer change | `npm run lint` and `npm run build:frontend` |
| A message key, a new locale, or a changed label | `npm run i18n:check` |
| A permission the renderer gates on | `npm run test:authorization-permissions` and `npm run test:auth-ui-deterministic` |
| A new or renamed IPC channel | `npm run test:electron-api-contract` and `npm run test:printer-ipc` |
| The sender check on a database channel | `npm run test:kds-window-hardening`, which drives `pick-restore-file`, `backup-database`, `restore-backup`, and `db-initialize` from an untrusted sender |
| A print path, template, or column width | `npm run test:receipt-column-oracle` |
| The courier slip | `npm run test:delivery-slip` |
| A user-facing flow | `npm run test:e2e:browser` from the repository root |

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
the static export cannot use `next/image`. The React and React Hooks rules without compatible
native implementations use the versions from the prior lockfile through Oxlint's JS plugin bridge.

`npm run lint:budget` reads the Oxlint JSON report for each scope and fails on an error-severity
diagnostic, on a run whose report it cannot read, and on warnings above
`scripts/ci/lint-budget.json`. Those limits are ceilings that ratchet down manually as warnings are
fixed incidentally, not targets to spend.
