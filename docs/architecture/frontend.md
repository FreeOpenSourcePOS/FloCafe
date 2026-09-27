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

| Server | Port | Serves |
| --- | --- | --- |
| [`main/server.ts`](../../main/server.ts) | 3001 | the API under `/api` and the exported pages |
| [`main/kds-server.ts`](../../main/kds-server.ts) | 3002 | the standalone KDS |
| [`main/server-app.ts`](../../main/server-app.ts) | 3003 | the standalone Server App |

A page is a file, not a request that runs code. The export has no Next.js server runtime behind
it, so there are no route handlers, no server actions, no middleware, and no server cookies in the
shipped build, and a file that uses them compiles without complaint and is dead in every build that
ships. [What does not exist in the desktop build](desktop-build.md#what-does-not-exist-in-the-desktop-build)
enumerates the absences and why the build stays quiet about them.

**A new screen cannot call the backend the way a web app would.** There are two routes out of the
renderer and no third:

1. **HTTP**, through the axios client in [`frontend/src/lib/api.ts`](../../frontend/src/lib/api.ts).
   The KDS live feed rides the same route as a WebSocket upgrade on the same ports.
2. **Native capability**, through the `window.electronAPI` bridge described in
   [the interface contract](#the-interface-contract).

Anything that needs a database row, an authorization decision, a tax calculation, or a print job is
an Express route on the backend, not renderer code. See
[Backend-authoritative security and tax](../decisions/0002-backend-authoritative-security-and-tax.md).

The KDS window and the Server App page load without a preload bridge, so on those two surfaces the
IPC route does not exist at all.

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
| [`kds-standalone/page.tsx`](../../frontend/src/app/kds-standalone/page.tsx) | builds its own axios instance on its own origin, because it runs on the `:3002` server without the POS window, and on a `401` clears the token and reloads instead of redirecting |
| [`server-standalone/page.tsx`](../../frontend/src/app/server-standalone/page.tsx) | the same, against the filtered `:3003` proxy |
| [`i18n/server-language.ts`](../../frontend/src/lib/i18n/server-language.ts) | bare `fetch`, because it reads the tenant's language before a session exists |
| the KDS live feed | a WebSocket, described below |

The other `axios` imports in the renderer are `axios.isAxiosError` for error shape, not a second
client.

### The KDS live feed is a WebSocket, not a request

[`useKdsConnection`](../../frontend/src/hooks/useKdsConnection.ts) opens a socket to
`<ws|wss>://<host>/kds`, deriving the host from the axios `baseURL` so a dev proxy reaches the
right backend, and falling back to the page origin. The same path is upgraded on both `:3001` and
`:3002`.

Authentication is a message, not a header. The client sends `{ type: 'auth', token }` after `open`
and must be authenticated within 5 seconds, or the server sends `auth_error` and closes with code
`1008`. A socket that is refused, times out, or drops does not become a dead screen: the hook falls
back to REST polling on a 5-second interval and reports which mode it is in through
`connectionMode`. Reconnect uses exponential backoff from 1 to 30 seconds.

Which REST route it polls depends on the surface, because the hook takes its endpoints as a
parameter. The in-dashboard KDS polls `GET /api/kitchen/orders`; `/kds-standalone` passes
`orders: '/api/kds/orders'` and the rest of the `:3002` REST surface to the same hook.

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

### The administrative floor

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
row when a pending change would take one of the four away from the actor who is making it. A save
in that state goes through a Master PIN prompt and sends the value as `override_pin`, the same
request field bills, orders, and refunds use. The server refuses the save regardless; the
renderer's copy is there so the cost is named before it is paid, not only in a refusal afterwards.

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

- `getLandingPage` picks the first page in a fixed list the tenant can reach, so a cashier lands
  on the POS and an owner lands on the dashboard.
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
[`frontend/src/types/electron.d.ts`](../../frontend/src/types/electron.d.ts), and
[`electron-api-contract.ts`](../../frontend/src/types/electron-api-contract.ts) pins a set of those
signatures with type-level assertions, so a change on one side of the bridge that misses the other
side does not compile.

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

The settings screen runs the same repairs over HTTP, where the acting user is known: the
 `/api/db-tools` routes all require `database.manage`, and `POST /api/db-tools/apply-safe-fixes` and
 `POST /api/db-tools/initialize` add the Master PIN and, for initialise, the same `INITIALIZE`
 phrase.

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
| [`cart.ts`](../../frontend/src/store/cart.ts) | cart items with their addons and instructions, order type, table, customer, guest count, delivery details, and the subtotal and item count selectors | none |
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
the address, the full contact block, and the order lines, and it resolves through three routes:

1. `POST /api/printers/print-delivery-slip` when a hardware printer is configured.
2. `buildDeliverySlipBytes` in
   [`delivery-slip-encoder.ts`](../../frontend/src/lib/printer/delivery-slip-encoder.ts) over
   WebUSB.
3. `generateDeliverySlipHtml` in
   [`delivery-slip-web-print.ts`](../../frontend/src/lib/printer/delivery-slip-web-print.ts) for
   the system print dialog.

Both renderer-side slip files build the slip from a small order projection rather than from the
kernel's `DeliverySlipDocument`. That model and `buildDeliverySlipDocument` exist in
`shared/print/document.ts` and are consumed by the backend renderer
[`main/printers/document-delivery-slip.ts`](../../main/printers/document-delivery-slip.ts), so the
rule that a renderer consumes a document does not hold for the WebUSB and browser slip paths.

The action is reachable on an unpaid delivery order, because that is the workflow: the courier
leaves before the customer settles. `OrderCard` renders it outside the payment branches, limited to
delivery orders and hidden for cancelled ones. The slip prefers the address confirmed on that
order and falls back to the customer's standing address, which is what every order created before
the column existed resolves to.

Whether the customer's phone number appears on the slip is a deliberate divergence from the
receipt, and the rule is a product decision rather than an implementation detail: the slip is a
separate document kind with its own builder, so it resolves the number through
`shouldShowCustomerNumber` in the shared kernel instead of passing through `buildBillDocument`.
The renderer and the backend call the same function, so a slip and a delivery receipt cannot
disagree. The setting behind the override is `bill_delivery_show_customer_phone_always`; see
[product invariants](../reference/product-invariants.md#a-receipt-and-a-courier-slip-are-not-secure-artefacts)
for the rule and the panel text that states it.

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
│   ├── kds-standalone/         Standalone KDS, served by the :3002 server
│   ├── server-standalone/      Standalone Server App, served by the :3003 server
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
│   │   GeneralSettingsTab, HealthCheckDialog, InitializeDatabaseDialog,
│   │   LocalePreferencesPanel, MasterPinPrompt, PaymentMethodsSettings,
│   │   PermissionAuditLog, PermissionMatrix, PrintersSettingsTab,
│   │   SettingsTabShell, TaxConfigurationPanel, Toggle, WhatsAppEnableCard
│   ├── support/                Support ticket form
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
