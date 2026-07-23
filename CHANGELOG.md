# Changelog

All notable changes to Flo Cafe are documented here. Dates are release dates, not commit dates. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [2.0.3] - 2026-07-23

### Fixed
- Standalone Kitchen Display (the separate device page served on port 3002, as opposed to the dashboard-embedded KDS) failed to log in with "Login failed — the database may have an error" — the frontend was calling the main server's API paths (`/auth/login`, `/kitchen/orders`, `/order-items/:id/status`, `/auth/me`), none of which exist on the standalone KDS server, which exposes its own smaller route set. The standalone page now talks to the correct paths, and the standalone server gained the `/api/auth/me` route it was missing (needed to restore a session after a page reload instead of forcing a fresh login every time).

### Added
- Standalone uninstaller scripts for macOS and Windows, attached to this and every future release. Useful when the packaged per-platform uninstaller is missing or a reinstall needs a clean slate. Removes the app and its support files (preferences, caches, shortcuts, auto-update state); leaves your database, backups, and Master PIN alone unless you explicitly pass `--purge-data` / `-PurgeData`.

## [2.0.2] - 2026-07-23

### Security
- Fixed stored XSS in bill printing: product/customer names, special instructions, and other database-sourced values are now HTML-entity-encoded before being written into the print window, closing a path for staff-injected script payloads to run when a bill is printed.
- KDS server login (port 3002) is now rate-limited the same as the main server's login — it previously had no brute-force protection at all.
- `GET /api/held-orders` now requires the same owner/manager/cashier/waiter role as its POST/DELETE siblings; any authenticated user (including chefs) could previously read held-order customer data and table assignments.
- The legacy (pre-Base64) product image endpoint no longer redirects to arbitrary stored URLs — it now requires HTTPS and blocks private/internal/link-local addresses, closing an unauthenticated open-redirect path.
- Global error handlers no longer echo raw exception messages (internal paths, DB schema details) back to API clients.
- Bumped `sharp` to 0.35.3, resolving four libvips memory-corruption CVEs (CVE-2026-33327/33328/35590/35591).

## [2.0.1] - 2026-07-22

### Fixed
- **Windows auto-update had the same silent-breakage bug as macOS in 2.0.0**: the release pipeline only uploaded the `.exe` installer, not the `latest.yml` manifest + `.exe.blockmap` electron-updater needs to find and apply updates. Both macOS and Windows release jobs now verify the auto-update assets actually got uploaded before a release is considered done, so this can't silently ship broken again.
- Pre-migration auto-backup now runs before *every* upgrade, not just two specific hardcoded versions — an install that's been stuck for a long time and jumps through a dozen+ migrations at once is now just as protected as one applying a single routine update.
- "Check for Updates" (Settings → Updates) did nothing when clicked on Linux — no error, no spinner, no message, because the button's handler never sent anything back to the screen for that platform. It now explains that Linux (AppImage/deb) isn't covered by auto-updates and points to GitHub Releases.
- WhatsApp: a status could reach "read" while still showing blank "sent"/"delivered" timestamps, because Baileys sometimes skips straight from ack to read. Earlier timestamps now backfill together with the one that actually arrived (carvalab, #139).
- WhatsApp: a packaging issue with the logging library (`pino`) could crash the app at startup — not just for WhatsApp, for every route, whether WhatsApp was enabled or not. It now falls back to a no-op logger instead of failing the whole process.

### Added
- WhatsApp e-billing is now opt-in: enable it from Settings → WhatsApp, and the sidebar entry stays hidden until you do, instead of being on and visible for every operator by default (carvalab, #139).
- Backup History (Settings → Database Tools) now has a delete button per backup, and shows each backup's schema version (#120).

### Changed
- RevFlo was split across a generic "More Apps" card and a separate "Mobile App" pairing-code card. It's now one consolidated section in Settings → Integrations: download/QR, app (pairing) code, and paired devices together.
- "Enable bill sync to FloAdmin" is renamed to "Enable sales sync to FloAdmin" — it was never syncing full bills, only live sales totals and order status for RevFlo's reports.
- Anonymous telemetry is now on by default for new installs (still fully opt-out anytime in Settings → Integrations → Privacy).
- Removed the OrderFlow "How it works" steps in Settings → Integrations — that flow hasn't actually been decided yet and the steps shown didn't reflect anything real.

## [2.0.0] - 2026-07-22

### Fixed
- **Critical**: macOS auto-update has been silently broken since v1.6.7 — every install has been permanently stuck on whichever version it originally shipped with, and every "check for update" has failed with a 404 on `latest-mac.yml`. The mac build only produced a `.dmg`, but silent background updates require a `.zip` artifact plus that manifest file, and the release pipeline never uploaded either. All previous releases have been removed from GitHub (binaries only — the version history and changelog stay) and republished cleanly starting with this version, so every existing Mac install can finally update again.
- Forgot-password recovery page was unreachable — a logged-out user clicking "Forgot password?" was bounced straight back to the login screen before the PIN form could render (missing route in the auth guard's public-path whitelist). Also now shows upfront whether recovery is available on this device, instead of only after filling in the whole form.

### Added
- If the database has already been migrated by a newer app version than the one currently running (e.g. a stale/un-updated install sharing a database with an updated one), the app now fails at startup with a clear "please update" message instead of crashing later mid-order on a column a later migration already dropped.
- Startup failures — including the schema-version case above — are now reported through the existing anonymous telemetry pipe (opt-in only), with the app/DB schema version numbers attached, so installs stuck on a stale build can be spotted without waiting on a support ticket.

## [1.9.11] - 2026-07-22

### Changed
- The POS no longer sends any customer data (name, phone, email) to the cloud under any circumstance. Cross-store customer recognition (introduced in 1.9.9 as the one thing kept when bill/order/payment sync was removed) is retired along with it — accepted tradeoff, not a bug.

## [1.9.10] - 2026-07-22

### Added
- Password recovery: an owner locked out of their account can now reset their password from the login screen using their Master PIN, with no existing session required (#127). First-run setup now explains that the Master PIN doubles as recovery, and adds an optional Cloud Services opt-in step with clear guidance on what depends on it (#128).

## [1.9.9] - 2026-07-22

### Added
- Kitchen Display System and KOT (kitchen ticket) printing now have independent on/off toggles, for businesses that only use one or neither (#133).
- Barcode scanning for product lookup at the POS (#137).
- Optional automated database backups to Google Drive, alongside the existing local backup history (#129).
- WhatsApp-based e-billing: send bills to customers over WhatsApp, with ban-avoidance safeguards on the underlying connection.

### Changed
- Cloud registration no longer asks for an owner email — it was never actually stored or used on the receiving end, and owners don't log into the cloud admin panel. Registering is now a single click.
- The POS no longer sends bill, order, or payment details to the cloud under any circumstance. Customer name/phone/email still sync for cross-store recognition, through a dedicated endpoint that never carries financial data.
- Zero-touch cloud registration announces itself automatically again on startup for installs that have already opted into cloud sync (previously required a manual click every time).
- Mobile pairing code (Settings → Mobile App): the code now displays in uppercase, and failure messages explain the actual reason (e.g. this install hasn't been claimed yet) instead of a generic error.

### Fixed
- Barcode search box didn't accept manual/typed entry, only actual scanner input (#137).
- Mobile pairing code generation could fail if attempted in the brief moment before the app finished checking whether the store was cloud-registered.

## [1.9.8] - 2026-07-21

### Fixed
- **Critical**: fixed "Initialization error: Failed to start Flo: SQLite error: no such column: country_code" — any install upgrading from before that column existed on `customers` failed to start entirely. A second instance of the same bug (`customers.tag_counts`, missing the same way) would have crashed on the first order placed for a returning customer instead; fixed the same way.
- Orders: selected addons are now read from a single normalized table everywhere (list, detail, KDS, kitchen display, printing, cloud sync) instead of a JSON column some paths trusted and others didn't; the JSON column itself has been removed (#125).

## [1.9.7] - 2026-07-21

### Added
- Kitchen Stations: route order items to per-category prep stations (bar, dessert, pizza, etc.), each with its own printer and assigned staff logins. KOT printing now splits an order across stations automatically; orders with no stations configured print exactly as before (#134).

### Fixed
- Settings: creating a kitchen station now actually assigns it an id — it previously left the row unfetchable after creation.

## [1.9.4] - 2026-07-20

### Added
- Dashboard: Average Order Value, Top Staff, Top Categories, and a Business Patterns panel (busiest/quietest hour and day of week, computed in the tenant's local timezone); a date picker to view any past day's totals instead of only today (#77).
- Settings: Backup Management & History panel — lists past backups, restores from any of them through the existing Master PIN flow, and supports choosing a custom save location for a backup (#120).
- Orders: selected addons are now also snapshotted into a normalized `order_item_addons` table alongside the existing JSON column, enabling indexed addon reporting (#125).

### Fixed
- Orders: new orders are now attributed to the authenticated staff member server-side. Previously every order was created with `user_id` unset, so a waiter could never see their own orders in the Orders list.

## [1.9.2] - 2026-07-15

### Added
- Products: "Out of Stock" badges, a "Low Stock Threshold" field, and required-field indicators on product forms and modals.

### Changed
- Settings: reorganized into five groups (Store, Operations, Customers, Data, Account), unified global save, and various layout/UI fixes — sidebar active-state for shortcut items, unsaved-changes popup animation, app version always visible in the Updates tab.

### Fixed
- Loyalty: legacy point-expiry dates no longer collapse a customer's wallet balance; the now-meaningless "Next Expiry" UI is removed (#78).
- Addon Groups: min/max selection bounds are now validated on save, and removing or deactivating an addon that would break a group's minimum selection is blocked (#82).
- i18n: native currency symbols restored globally.

## [1.9.1] - 2026-07-14

### Fixed
- Windows: Fix `better_sqlite3.node is not a valid Win32 application` error by ensuring native dependencies are correctly built for the Electron target runtime using `electron-builder install-app-deps`.

## [1.9.0] - 2026-07-14

### Added
- Full Spanish/English internationalization: 727 translation keys with verified EN/ES parity, migrated from a 2014-line inline i18n file to a JSON-backed loader with ICU plural support.
- Language-first setup wizard with country-driven business profiles; Argentina profile wires local IVA tax handling end-to-end, including a matching bilingual demo restaurant seed.
- Master PIN protection for sensitive actions (database reset, critical settings changes), with its own backend service, middleware, and Settings UI.
- Database health check and repair tooling, exposed via a new Database Tools API and the Settings → Data tab.
- Cloud sync, reports, and command polling now enabled by default, with reworked Cloud Sync settings copy, a register confirmation step, and zero-touch device registration against FloAdmin (register → pending → claim).

### Changed
- README rewritten to be version-agnostic, with donationware/RevFlo messaging.

### Fixed
- Addon groups: editing a group no longer clobbers each addon's active/inactive state (#86).
- Various lint and TypeScript build errors resolved (login page, Sidebar, and other preexisting warnings).
- Settings: unescaped single quote in JSX corrected.

## [1.8.7] - 2026-07-12

### Added
- POS: "New Order" button on a customer's order card copies their profile straight into a fresh POS order.
- POS: Enter key now confirms customer selection, and the auto-select-after-timeout behavior was removed in favor of explicit selection.

### Changed
- Settings: General tab save buttons merged into a single inline footer card.
- Orders: action buttons on order cards now wrap and stretch on narrow viewports instead of overflowing.
- Orders: postpaid unpaid orders now follow their own flow, decoupled from the standard button layout.
- Products: form modals widened and the drag-and-drop image uploader redesigned for clarity; scrollbars no longer protrude through rounded corners.
- POS: table fetching is skipped when table settings are disabled, reducing unnecessary requests.

### Fixed
- Orders: receipts now auto-print when checkout is completed from the orders list.
- Security: the local rate limiter no longer throttles requests from loopback and private-subnet IPs.
- Data: table "active" UI checks, soft-deleted customer/addon leaks, and CSV reactivation edge cases corrected.

## [1.8.6] - 2026-07-12

### Changed
- Customers, dine-in tables, staff, addon groups, and kitchen stations are no longer hard-deleted — matching the existing products/categories behavior, they're now deactivated instead, so historical orders/bills/reports never lose a name to a deletion.
- Dine-in tables gained a proper active/inactive state: a Deactivate/Reactivate toggle on the Tables page, and the POS table picker's `active` filter (previously a no-op) now actually excludes deactivated tables.

### Fixed
- Deactivating the sole remaining owner account is now blocked (previously only blocked on the old hard-delete path, not on deactivate).

## [1.8.5] - 2026-07-12

### Added
- Product image upload and display: full upload pipeline with compression and cropping, thumbnails on the POS grid and Products list, and colored placeholder tiles with product initials for items without images.

### Fixed
- Long order cards now expand properly in grid view on the Orders page.
- Products are hidden from POS when their category is disabled.
- `is_active` is now coerced to an integer for SQLite category updates, with added error logging.
- Deleting a category with active products no longer throws a console 400 — product count is checked client-side first.
- Image caching bug that prevented overwritten product images from updating in the UI.
- Deleting an existing product image no longer fails.

## [1.8.3] - 2026-07-12

### Added
- Zero-touch cloud registration on the POS side (register → pending → claim flow against FloAdmin).
- Reference/demo dashboard pages for a masonry-style KDS board and a settled-order history grid, for layout comparison against the live pages.

### Fixed
- KDS order cards no longer stretch to match the tallest card in their grid row — a 1-item ticket now sizes to its own content instead of a 6-item neighbor's height.
- `GET /tables` no longer queries the nonexistent `is_active` column; added back an `active` query param for frontend API compatibility.
- Category deletion now warns and offers reassign-or-bulk-delete when a category still has active products, instead of orphaning them.
- Table checkout modal edge case that could leave bad data in place if no matching branch applied.
- Table list now refreshes after holding or restoring an order in POS.

### Known issues
- **Orders page grid layout (WIP):** re-restored the 2-3 column grid on the Orders and Held Orders tabs after it was reverted to a vertical list with no explanation. Not yet re-verified visually as working correctly — treat as work in progress.

## [1.8.2] - 2026-07-11

### Added
- Cross-device held orders synchronization via the backend, complete with a resume button in POS.
- Dynamic IP detection and Tailscale/VPN/Mesh network support for Kitchen Display System (KDS) pairing.
- Bill-style order cards on the Orders page for a more intuitive layout.
- Dashboard insights and owner-restricted analytics.
- Cart quantity aggregation for product grid badges in POS.

### Fixed
- Reverted all order tabs (including held orders) to the standard vertical list layout.
- Corrected an invalid column reference (`t.name` to `t.number`) in the `recentOrders` SQL query.
- Linux restore from tray issues and implemented a singleton lock mechanism for graceful resource cleanup on force exit.
- Ensured a unique ID is assigned when creating a new category.
- Improved POS phone lookup to show the matched customer name before auto-selecting.

## [1.8.0] - 2026-07-09

### Added
- Classic receipt template redesigned: header now shows the store name in a large Font A, followed by the customer's name (Font B) and mobile number when the bill has a customer attached.
- Loyalty points on the printed bill: redeemed points shown above the subtotal, and a new "Points Earned" / "Points Balance" section sourced from the loyalty ledger.
- Footer now prints store address, phone, and Instagram handle (new `Settings → General → Instagram Handle` field) instead of a plain "Thank you!" line. Every optional line — customer info, discount, points, each footer field — is only printed when that data actually exists.
- Real ESC/POS Font A/Font B switching in the thermal printer driver.

### Fixed
- Amount columns on thermal receipts no longer wrap a trailing "00" onto the next line. The currency symbol is now resolved to its final printed form (unicode symbol or 2-letter ASCII code, e.g. `Rs`) *before* column padding is computed, instead of being swapped in afterwards and silently overflowing the line width.
- Business address and phone number were silently blank on every printed bill — the print route was reading them from settings keys that are never written. Fixed to read the keys the Settings page actually saves to.
- Inclusive tax was being double-counted against order totals and discounts (#66).

## [1.7.9] - 2026-07-07

### Added
- Split payments, discounts, and wallet (loyalty) redemption in cart checkout.

### Fixed
- Discount edits no longer clobber existing payment splits; hardened the discount PIN flow.
- Bill printing now actually attempts the print before reporting success; added a reprint banner.
- Stopped discount tax compounding and blocked restoring items on already-paid orders.
- Restored first-run restaurant onboarding flow.

### Changed
- Simplified the loyalty program to fixed cashback/redemption rates.

---

Older releases: see [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases).
