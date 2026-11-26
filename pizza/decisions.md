# Decisions

Each decision lists what was decided, how it was checked, and what a builder must not miss. Line numbers refer to upstream commit `b5928ec`. The spike code is on the branches `spike/pizza-db` (`30650cf6`) and `spike/pizza-ui` (`09a9e922`); it is evidence only and is not merged.

## D1. Pizza core in `shared/pizza/`

Pure TypeScript. Upstream's lint rule for `shared/` already forbids `any`, `require`, Node built-ins, Electron, React, Express, Next and imports from `main/` or `frontend/` (`.oxlintrc.json:84-121`). `main/` imports it by relative path, `frontend/` by the `@shared/*` alias, tests by the same alias. Existing examples of the pattern: `shared/charges.ts` with `tests/charges-calculation.test.ts`, and `shared/print/` with `tests/kernel-purity.test.ts`.

Not checked by a spike: nothing here is new to the codebase.

## D2. A pizza is a normal order line; the server prices it

**Revised by D18.** The shop's menu has one price per size and no paid toppings, so FloCafe's own variant and add-on prices are the pizza's price and no pricing hook is needed. The recipe is still stored and validated as described here, and the three price sites below matter again only if paid toppings are added later.

The recipe is JSON in `order_items.modifier_selection` with `kind: "pizza"` and a format version. The price goes in `unit_price`.

**Checked.** `tests/spike-pizza-modifier-selection.test.ts` on `spike/pizza-db` posts real orders over HTTP: the recipe is stored byte for byte and returned parsed on create, on read, on adding items and on a quantity edit, and a client-sent `unit_price` of 0.01 is ignored.

**Where the unit price is decided** (three places; all three need the hook):

| Site | Location |
| :--- | :--- |
| Order create | `main/routes/orders.ts:2458-2461`, owner override at `2463-2475` |
| Add or edit items (`insertOrderItems`) | `main/routes/orders.ts:1121-1126`, override at `1128-1139` |
| Cart quote (`POST /api/tax/preview`) | `main/services/tax.ts:1546-1553` |

**The hook.** A helper in `main/pizza/pricing.ts`, `pizzaUnitPrice(db, item, product, variant): number | null`, returns null for lines that are not pizzas. At each site it wraps only the catalogue price: `pizzaUnitPrice(...) ?? (variant ? ... : ...)`. At the add-or-edit site the existing expression starts with `context.preserveUnitPrice ? Number(item.unit_price) : ...`; the helper goes inside the second branch, so a quantity edit keeps the stored price. Placed before `menuUnitPrice = unitPrice`, it leaves the owner price override working, and the override audit records the computed pizza price as the original.

**Must not miss:**

- The helper validates and normalises the recipe and writes the normalised object back to `item.modifier_selection`. Today the column is stored with no shape or size check, and the request body limit is 50 MB (`main/http-limits.ts:1`).
- The core works in whole cents. Convert once, at the helper's return: `cents / getCurrencyMinorUnitFactor(getTenantCurrency())` (`main/countries.ts:652`).
- Client `addons` are added on top of the unit price (`orders.ts:1161-1183`), so a pizza line must reject them or it is charged twice.
- A replacement edit stores whatever the client sends (`orders.ts:6089, 6901`), and the order page's edit dialog sends no recipe (`frontend/src/components/orders/EditOrderItemModal.tsx:259`). Without a fix, editing a placed pizza erases its recipe.
- Restricted kitchen display stations drop the column through an allow-list (`projectKdsItem`, `main/db.ts:11966`).
- Quantity edits keep the stored price (`preserveUnitPrice`), so a later menu price change does not reprice a sold line. That is the wanted behaviour.

Copied unchanged with no work needed: voids (`orders.ts:6401-6418`), refunds (`main/services/refund.ts:466, 484`), split checks, scheduled orders, held orders, cloud order snapshots.

## D3. A second migration list for pizza tables

Pizza tables are created by `PIZZA_MIGRATIONS` in `main/pizza/migrations.ts`, with their own counter stored as `_flo_meta.pizza_schema_version`, run right after upstream's migrations and also when the reference schema is built.

**Why not upstream's list.** `PRAGMA user_version` is the only cursor (`if (migration.version <= current) continue`, `main/db.ts:10550`). If a pizza migration took number 126, a shop database stamped 126 would skip upstream's real 126 for good. A far-away number range fails the same way: the cursor jumps past every later upstream migration, and upstream tests require the list to be contiguous from 1.

**Checked.** `tests/spike-pizza-migrations.test.ts` on `spike/pizza-db`, 14 assertions, all passing. The "existing install" is a database produced by pristine upstream code extracted with `git archive`. Proven: a new database gets the table and the counter; a real upstream version 125 database gains the table and keeps its rows; a second open changes nothing; the health check reports no findings; a backup containing the pizza table is accepted and an undeclared table is still rejected; an upstream-made backup restores and then gains the pizza table; a pre-migration backup is taken when only pizza migrations are pending; a later upstream migration 126 runs on a pizza database and leaves the pizza track alone; with both tracks pending, one backup is taken and both run. Upstream's `schema-health`, `schema-reference-cache`, `migration-registry`, `product-variants-db`, `upgrade-path`, `backup-restore-production` and `newer-db-downgrade-recovery` suites still pass with the hook in place.

The change to `main/db.ts` in the spike is 14 lines: an import, a rename of the existing runner to `runCoreMigrations`, and a wrapper.

**Must not miss:**

- Every pizza migration is idempotent (`IF NOT EXISTS`, column checks). When an upstream-made backup is restored, upstream's schema repair creates the missing pizza table before the pizza track stamps its counter, and the migration then runs against a table that already exists.
- Pizza migrations create only pizza tables, because they also run when the reference schema for an older upstream version is built.
- The reference schema is "upstream at version N plus all pizza migrations". A file at the same upstream version but an older pizza version fails the strict health predicate. Normal restore is unaffected, but downgrade-recovery discovery (`inspectOpenBackupDatabaseForDowngrade`, `main/db.ts:3968-3982`) would list such a backup as invalid. Fix: key `getRecoverySchemaReference` by the candidate's pizza version as well (call sites `main/db.ts:1526, 1861, 5449`).
- Keep `-pre-v` in the pre-migration backup's file name; that substring classifies it as an automatic backup (`main/db.ts:3622, 3768`).
- A pizza counter newer than the build should enter the same downgrade-recovery flow as upstream's, not throw a plain error.

**Other code that lists tables:**

| Area | Location | Needs a change |
| :--- | :--- | :--- |
| Currency reset | `captureCurrencyResetMenu`, `restoreCurrencyResetMenu` (`main/db.ts:3304, 3336`) | Yes: a hard-coded list of menu tables |
| Menu CSV | `main/routes/menu-csv.ts` | Only if pizza data should travel by CSV; the menu file covers it |
| Setup seeders | `seedSetupProfile` (`main/setup/seed-data.ts:2421`) | Yes, for the pizza profile |
| JSON export and import | `main/routes/database.ts:103, 210, 1003` | No: tables are discovered at run time. Import order for new foreign keys is unverified. |
| File backups | `createBackupUnlocked` (`main/db.ts:2973`) | No: whole file |
| Factory reset | `resetDatabaseWithBackupUnlocked` (`main/db.ts:3137`) | No: the file is recreated, so pizza tables come back empty and the menu is imported again |

## D4. A shop's menu is one file, loaded into the POS

**Revised.** The menu file has the shape of `tests/fixtures/pizza-sample-menu.json` (type `MenuFile` in `shared/pizza/types.ts`). It is the same file the shop's customer ordering app reads, so the two cannot disagree on a price. The POS loads it and maps it onto FloCafe's own catalogue: sizes become variants, dips and flavours become add-on groups, deals become fixed-price products ([contract.md](contract.md)). Loading is idempotent and keyed by ids derived from the menu's ids.

A price changed only inside the POS back office is overwritten by the next load of the file. The file is the master.

## D5. One ticket formatter, printed on every path

`shared/pizza/ticket.ts` turns a recipe into a heading and detail lines.

**What the spike found.** The assumption that the print kernel feeds every ticket path is false. A kitchen ticket is produced four ways:

| Path | Location | Input |
| :--- | :--- | :--- |
| Server ESC/POS | `main/printers/document-kot.ts` (`buildKotPrintData:45`, `kotItemLines:436`) | Kernel document |
| Browser ESC/POS | `frontend/src/lib/printer/kot-encoder.ts` (`buildKotBytes:92`) | Raw order, not the kernel |
| Raster | `frontend/src/lib/printer/print-document.ts` (`buildFrontendKotDocument:317`) to the server renderer | Kernel document |
| Browser HTML | `frontend/src/lib/printer/kot-web-print.ts:211-240` | Raw order |

The kitchen display has three more views: `KdsItemModal.tsx:62-110`, `KdsTabsView.tsx:161-183`, `KdsKanbanBoard.tsx:297-315, 377-395`. None of these seven reads `modifier_selection` today, so an unpatched path shows a pizza as a bare heading.

**Checked.** On `spike/pizza-ui`, an optional `detailLines` field on `KotItemSnapshot` (13 lines in `shared/print/document.ts`) carried five lines to the server ESC/POS path and the browser ESC/POS path. `tests/spike-pizza-ticket.test.ts` decodes the real bytes from both and finds the same lines at 42 and 48 columns. Upstream's `print-kernel`, `kernel-purity`, `receipt-column-oracle` (golden file untouched), `print-parity`, `kot-order-notes` and `variant-pos-surface` suites still pass.

**Must not miss:**

- The existing wrap helper splits on whitespace and rejoins with single spaces (`shared/print/width.ts:238-241`), so `LEFT:  + Mushrooms` loses its alignment, and a line can end in a lone `+`. The pizza formatter therefore takes the column count, wraps at commas itself, and returns lines that renderers print as they are.
- New field, not a reused one: add-on lines are truncated and are priced records; notes would mix with the cashier's own note.
- The two ESC/POS renderers already differ outside pizza lines (heading prefix, blank lines, add-on indent). The guarantee is "same detail lines", not "same ticket".
- The server's print route uses the client's `items` array when one is sent (`main/routes/printers.ts:1474`), so what prints is what the browser holds.
- Receipts: classic and compact are driven by the kernel's bill document, so `detailLines` on `OrderItemSnapshot` and `ItemTableRow` (`shared/print/document.ts:103-110, 313-323`) reaches `main/printers/document-classic.ts:809`, `document-compact.ts:429` and `frontend/src/lib/printer/receipt-encoder.ts:813, 1366`. The detailed receipt, tax bill, compliance templates, delivery slip and payment ticket are not document-driven and each needs its own edit if the shop uses it.
- The ticket header prints no phone number or delivery address today (`shared/print/document.ts:1610-1698`); the product plan needs both.

## D6. POS hooks

New components live under `frontend/src/components/pos/pizza/`. The hook points, each a small edit:

| What | Location |
| :--- | :--- |
| Product tap decides direct add or dialog | `frontend/src/app/(dashboard)/pos/page.tsx:1940-1948` |
| Dialog state and mounts | `pos/page.tsx:327-331, 4551-4584` |
| Edit a cart line | `CartPanel.tsx:995-998`, `pos/page.tsx:3863, 1970-1979` |
| Dialog-open guard and Escape handler | `pos/page.tsx:1984-1985, 3993-4000` |
| Cart line identity (a hash of product, variant, add-ons, note, override) | `frontend/src/lib/cart-identity.ts:61-81` |
| Cart store | `frontend/src/store/cart.ts:130-154, 156-211, 224, 249` |
| Restoring a saved cart | `normalizeCartItems`, `cart-identity.ts:93-99` |
| Displayed unit price | `frontend/src/lib/cart-price.ts:249-261` |
| Cart to API | `frontend/src/lib/cart-order-item.ts:35-59` |
| Retry fingerprint | `frontend/src/lib/order-attempt.ts:132-134` |
| Lines under a cart item | `CartPanel.tsx:923, 962-981` |
| Category chips | `frontend/src/components/pos/ProductGrid.tsx:64-146, 391-409, 499-535` |

**Must not miss:**

- Add the recipe to the identity hash and to `normalizeCartItems`. If the second is missed, restoring a saved cart merges two different pizzas of the same product and drops one recipe.
- Paths that add a product without the POS page's handler: barcode scan of a variant (`pos/page.tsx:1950-1958`), the scale path, the waiter app's own dialog (`frontend/src/app/server-standalone/page.tsx:896-985`), and the order page's add-items dialog (`frontend/src/app/(dashboard)/orders/page.tsx:3278`). D14 makes the server refuse a pizza without a recipe, so a missed path fails loudly.
- There is no saved-favourites feature. `CollapsiblePosChoices.tsx:165` is a presentational chip row that quick buttons can reuse; `CustomerTopItems.tsx` lists a customer's most-ordered products but replays no configuration.

Analysis only; no code was run for this decision.

## D7. English-only pizza strings

Pizza strings live in `frontend/src/lib/i18n/messages-pizza/en.json` and are merged as the `pizza` namespace into whichever language is active (`frontend/src/lib/i18n/loader.ts`), with `messages.d.ts` extended so a wrong key is a compile error.

**Checked.** On `spike/pizza-ui`: pizza keys render under German, Arabic and Traditional Chinese next to translated core strings; the frontend typecheck passes and a misspelled key fails it; the loader suites `phase6-locale-loading`, `kot-locale-cold-start` and `decoupled-ui-locale` still pass.

**Two upstream tests change.** Two tests scan the frontend for literal `t()` keys and fail on pizza keys: check 7a of `tests/translations.test.ts`, which wants each key in the 32 language files, and step 4 of `tests/e2e-argentina-flow.test.ts`, which wants it in `en.json`. Each gets the pizza file's keys added to its known set (four lines at `tests/translations.test.ts:3206`, two lines in `runArgentinaTranslations`); `npm run i18n:check` and `npm run test:e2e-argentina-flow` then pass. The second file was not formatted, and the changed-file format gate checks a touched file whole, so it is also formatted. Parity and the identical-to-English checks for the 32 languages are untouched.

**Must not miss:** the pizza file gets no message-syntax, duplicate-key or placeholder checks from upstream's test, so `pizza-i18n` adds them.

**Rejected:** adding every key to all 32 files plus about 30 allowlist sets inside a 4,821-line upstream test. Upstream changed the messages folder in 101 commits in 60 days; nearly every sync would conflict. Also rejected: a wrapper hook that hides the keys from the test's scanner. It needs no test edit but passes only because the scanner misses it, and breaks on nested keys.

## D8. Pizza shop mode is a setup profile

A new profile `pizza` next to `empty`, `express` and `demo` (`main/routes/auth.ts:116`), with a branch in `seedSetupProfile` (`main/setup/seed-data.ts:2421`) and a card in the wizard (`frontend/src/app/setup/page.tsx:43-61`). The seed runs inside the setup transaction after the settings are written (`auth.ts:1836-1890`), so it can set them.

| Setting | Value | Why |
| :--- | :--- | :--- |
| `service_model`, `tables_required`, `billing_type` | `qsr`, `false`, `prepaid` | Counter service. The profile writes all three itself, whatever the request carries |
| `kds_enabled`, `server_app_enabled` | owner's choice, default off | Hides the kitchen display and waiter app |
| `auto_print_kot` | `true` | Default is `false` (`main/routes/settings.ts:182`) |
| `cash_drawer_pulse_enabled`, `cash_drawer_pulse_methods` | `true`, `["cash"]` | The default method list includes card |
| `kot_show_customer_contact` | `true` | Kitchen tickets print the customer's contact details |
| `taxes_enabled` | `true` | Default is `false` (`main/db.ts:11240`) |

The profile seeds no menu, printers, kitchen stations or permission overrides.

A profile cannot choose the region: country, currency and time zone come from the setup request, and upstream forbids a fallback country. The pizza wizard pre-fills Canada, CAD and `America/Vancouver`. The wizard asks for the region at step 1 and the profile at step 4, so choosing the pizza card overwrites the country, currency and time zone the owner picked at step 1; the owner goes back to step 1 to change the currency or time zone.

The tax is British Columbia's, so the setup route refuses the profile with a 400 unless the country is `CA` and `state_code` is absent or `BC`, and writes nothing. The wizard has no province field. It shows one generic error for any refusal from the setup route, so it checks the country itself before sending and says what to change.

Wizard edge cases, left as they are: switching from the pizza card to another card keeps Canada, CAD, `America/Vancouver` and counter service; the pizza card is not offered on an install that is finishing a currency reset, where the server seeds nothing.

The tax category ids come from the labels: `Food` gives `food` and `Soda` gives `soda`, held in `tax_categories.category_id` and in `products.tax_category_id`. They change if the owner renames a category in Settings. The pack names `food` (GST only) as the default category for products and for packaging, delivery and service charges. The product screen pre-selects it, so a soda added by hand is GST only until its category is changed. A charge is taxed only once the owner gives it a tax category in Settings; the profile does not, so charges are untaxed until then.

Category colours are stored as names (`red`, `orange`), not hex; upstream's own seeds store hex and those show uncoloured (`ProductGrid.tsx:153-287`).

## D9. The menu site

**Withdrawn by D16.** The text below is kept for the record only.

A new app in `web/`: Next.js App Router with the same Next, React and Tailwind versions as `frontend/`, statically rendered, no database, no secrets. It imports `shared/pizza` and the menu file. The Vercel project's root is `web/` with files outside the root included.

## D10. Tests

**Revised by D16.** The `web/` package and the shared price-cases fixture are withdrawn; the rest stands.

Upstream's pattern for the core, backend and POS: plain scripts with the `assert*OrThrow` helpers from `tests/helpers/test-setup.ts`, one `test:<name>` script per file, chained into `npm test` (the `test:script-coverage` gate fails otherwise). `web/` is a new package and uses Vitest with Testing Library and Playwright. `tests/fixtures/pizza-price-cases.json` is read by the core, the server, the POS cart and the site.

Tests in `tests/` cannot resolve `react` or `use-intl` by bare name, because they live in `frontend/node_modules`; require them by path.

## D11. Fork base

`main` starts at upstream `b5928ec`. The `upstream` remote's push address is disabled in each checkout.

## D12. British Columbia tax through manual configuration

FloCafe's engine gives each line one tax category; a category lists the rules that apply to it (`docs/architecture/taxation.md:31-53`, `main/services/tax-engine.ts:265-290`). BC fits as category `food` with rule GST 5%, and category `soda` with rules GST 5% and PST 7%.

A new tax pack file does nothing by itself: only `generic.json` is bundled (`main/tax-packs/bundled.ts:4-6`), the community packs are reference data, and the catalogue accepts only signed releases. The pizza profile calls `saveManualConfig()`, the function behind `POST /api/tax-packs/manual-config` (`main/routes/tax-packs.ts`), with `inclusive: false`, because that path defaults to tax-inclusive prices and Canada needs exclusive.

Reports merge tax lines by label and rate (`main/services/tax-components.ts:124`), so both GST lines carry the same label.

## D13. Offline by default

Upstream's setup sets `cloud_sync_enabled` to on unconditionally (`main/routes/auth.ts:1787, 1875`) and then registers the install (`auth.ts:1896-1906`). The registration body includes the business name, owner name, email, phone, Instagram handle, address, host name, OS locale and time zone (`main/services/cloud-sync.ts:1554-1580`), sent to `https://blue.flopos.com/`. Separately, the desktop app sends a telemetry event on every launch including the first one before setup (`main/services/telemetry.ts:465-477`), checks GitHub for updates five seconds after launch (`main/index.ts:1712-1722`), and fetches a tax catalogue from GitHub (`main/tax-packs/catalog.ts:12`).

FloCafe has one switch that stops all of these: the `offline_mode` setting (`main/services/offline-mode.ts`, `docs/architecture/cloud-integrations.md:11-35`). The fork seeds it on at install and makes setup respect it instead of forcing cloud sync on. The owner can switch it off in settings.

`pizza-offline-default` asserts that install and setup make no outbound request, and that switching offline mode off afterwards starts neither cloud registration nor the telemetry collector.

**What this does not cover:**

- A database created before this change has no `offline_mode` row and stays as it was; the default is seeded only when a database is created.
- Restoring a full-file backup replaces the settings with the backup's. A backup made by upstream FloCafe has no `offline_mode` row, so the store is online after the restore (`restoreBackup` in `main/db.ts` copies the backup file whole), and it registers if that backup had cloud sync on.
- The owner picking "anonymous" or "full" sharing in the setup wizard counts as switching telemetry on; it starts sending once offline mode is off.
- Upstream's tests that exercise cloud, telemetry, Drive and WhatsApp features put the store online first (`tests/helpers/test-setup.ts`, and one line after each `initDatabase()` call in twelve test files).

## D14. The server knows which products are pizzas

**Revised.** A pizza table, `pizza_products(product_id, kind, ...)`, marks pizzas, the half-and-half product and deals; no column is added to upstream's `products` table. A plain pizza needs no recipe: it is the product, its size variant and its dips. The half-and-half product and every deal product require a valid recipe, and the server refuses the line without one. This closes every entry path at once, including the ones in D6 that bypass the POS page. Dips stay ordinary add-ons and are allowed on a pizza line.

## D15. Running headless

`better-sqlite3` 13.2.0 is built on Node-API and ships one binary per platform in its `prebuilds/` folder; plain Node 22 and Electron loaded the same file on macOS, so the headless server needs no second build. Installing it still runs a `node-gyp` step, which failed on Fedora for want of `make`.

Upstream's full suite passes on Fedora with plain Node 22 ([baseline.md](baseline.md)).

**Checked on macOS** (`spike/pizza-db`): after `npm run build` and `npm run build:frontend`, `node dev-server.js` with `PORT`, `KDS_PORT`, `SERVER_APP_PORT` and `FLO_DEV_USER_DATA` served `/api/health` on all three ports and the login page, wrote its database under the data folder, and exited cleanly on `SIGTERM`. Not checked: the headless server on Linux, a real browser session, printing.

**Does not start in this mode** (`main/standalone-startup.ts` against `initialize()` in `main/index.ts`): daily, startup and shutdown backups (`index.ts:1613-1628, 1911-1918`); schema self-repair (`index.ts:1609`); LAN HTTPS and mDNS (`index.ts:1640-1645`); cloud sync, telemetry and Drive. Restore over HTTP needs a token from a native file dialog (`main/routes/database.ts:865, 884`). Raster printing and PDF need an Electron window. On a taken port the server moves to the next one silently (`main/server.ts:446-459`).

The headless kit therefore adds scheduled backups, a restore procedure, a fixed-port check and a network ESC/POS print test.

## D16. The customer site is a separate project

The shop already has a customer ordering app, built and owned outside this repository, with its own hosting. This repository builds no customer site and deploys nothing to Vercel. The link between the two is the menu file (D4).

Decided by the owner on 2026-11-25. It withdraws D9, the site tests in D10, and the deploy stage of the first plan.

## D17. No real shop's data in this repository

The repository is public. It carries a made-up sample menu, `tests/fixtures/pizza-sample-menu.json`, in the real format. A shop's name, address, phone number, items and prices stay in the shop's own file, which is loaded at install. Tests, examples and documents use the sample only.

Decided by the owner on 2026-11-25.

## D18. The first builder does what the menu supports

The shop's menu has one price per size for every pizza, dips at one price, and fixed-price deals. It has no topping prices, no crust choices and no build-your-own pizza.

So the first version offers: size, dips, a note, removing an ingredient at no charge, half and half of any two menu pizzas at the size price, cook and cut notes, deals with each pizza changed separately, and quick buttons. None of these changes a price, which is why D2 needs no pricing hook. The ingredient list a cashier removes from is parsed from each pizza's description.

Paid extra toppings, crusts and build-your-own are added when the shop supplies prices. At that point the per-size topping prices go into the menu format and the pricing hook in D2 is built.

Decided by the owner on 2026-11-25.
