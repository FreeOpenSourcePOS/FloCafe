# Pizza POS build plan

Fork FloCafe, add the pizza menu, publish the menu site on Vercel.

Written 2026-11-25, revised the same day after the code spikes. Approved by the owner.
Companion pages: [decisions.md](decisions.md) (what the spikes proved), [gap-analysis.md](gap-analysis.md) (what FloCafe already has), [baseline.md](baseline.md) (upstream's test results on our machines).

## 1. What gets built

| Part | What it is | Where it runs |
| :--- | :--- | :--- |
| **Pizza core** | One TypeScript package with the menu schema, pricing engine, validation, saved presets and the kitchen ticket text. Used by everything below, so prices and tickets cannot drift apart. | Inside the fork, `shared/pizza/` |
| **Pizza POS** | FloCafe with a pizza mode: pizza builder (whole, half and half, build your own), combos, quick buttons, pizza kitchen tickets, British Columbia tax, café features and outside connections switched off. | Locally, offline (Mac for development, Fedora as the stand-in for the shop's mini PC) |
| **Menu site** | A customer-facing, mobile-first site: the full menu plus a build-your-own-pizza builder with live prices. No ordering, no accounts, no payments. | Vercel |

Owner decisions: public fork `Anmolnoor/pizza-pos`, real shop menu, British Columbia, Vercel hosts the menu site only, pricing defaults in section 4 accepted.

### Not in this plan

Online ordering and order sync to the POS, Global Payments terminal integration and cash drawer wiring, delivery apps, buying or setting up shop hardware, signed desktop installers, and translations of the pizza screens.

## 2. Still needed from the owner

| # | Needed | Blocks |
| :--- | :--- | :--- |
| 1 | **The real menu**: pizzas and prices per size, crusts, toppings (and which are premium), combos, pasta, wings and sides, dips, drinks. | The menu file. Core work starts against a small test menu. |
| 2 | **Shop identity**: name, logo, colours, phone, address, hours, existing website. | Menu site design, receipt header. |
| 3 | A look at the preview link before the site goes to production. | Production deploy. |

## 3. Facts that shape the plan

FloCafe at `b5928ec` (v3.14.2, MIT): 127k lines of backend, 107k of frontend, 374 test files. Upstream's full suite passes on the Mac: 257 suites, no failures, under 8 minutes.

| Fact | Consequence |
| :--- | :--- |
| Sizes fit FloCafe's variants and toppings fit its add-ons, but add-on prices are flat: no per-size price, no left or right half, no removed default. | Pizza pricing is new code in the pizza core, run again on the server. |
| `order_items.modifier_selection` is stored, copied on voids and refunds, returned on reads, and used by nothing. | The pizza recipe is stored there. |
| The server decides a line's price in three places (order create, add or edit items, the cart's tax preview). | All three call the same pizza price helper, or the till and the bill disagree. |
| Migrations are one numbered list tracked by a single counter; any number we take blocks upstream's migration of the same number for good. | Pizza tables use a second list with its own counter (D3, proven). |
| A kitchen ticket is produced on four paths (server ESC/POS, browser ESC/POS, raster, browser HTML) and shown on three kitchen display views. None reads the recipe today. | The ticket text comes from one function in the core and each path prints its lines (D5). |
| The kitchen ticket prints no phone number or delivery address. | Added to the ticket header. |
| Finishing setup forces cloud sync on and sends the business name, owner name, email, phone and address to `blue.flopos.com`. Telemetry, update checks and a tax catalogue fetch also run unasked. | The fork ships with FloCafe's own offline mode on (D13). |
| Identical cart lines merge by themselves; nothing splits a line. Holding an order works only for dine-in tables. There are no combos, saved presets or item popups. | These are built. |
| Cash and card payments, change due, receipts, Z-report, day close, sales reports, exports, staff PINs, refunds, station routing, server-side printing from a tablet, customer phone lookup and scheduled orders exist. | Configured by the pizza setup profile, not rebuilt. |
| No Canada tax pack exists and community packs are not installable. The built-in manual tax setup can express GST on food plus PST on one category. | The pizza profile configures tax through that path, tax-exclusive (D12). |
| 32 languages, with a test that every used string exists in all of them. | Pizza strings are English only in their own file, with one four-line change to that test (D7). |
| `pos/page.tsx` is 4,872 lines, `orders.ts` 7,404, `db.ts` 12,233. | New code goes in new files; these files get one-line hooks. |
| Upstream's docs checker rejects plans, decision notes and branch names inside `docs/`. | Fork process documents live in `pizza/`, outside the checked tree. |

## 4. Pricing rules (accepted defaults)

All of these are settings in the menu file, changeable without code.

| Rule | Default |
| :--- | :--- |
| Half and half of two specialty pizzas | Charged at the price of the more expensive half |
| Topping on one half only | 50% of the whole-pizza topping price |
| Extra (double) topping | Counts as two toppings |
| Light topping | Same price as normal |
| Removing a default topping (`NO Pineapple`) | No credit |
| Topping tiers | Regular and premium, each with a price per size |
| Money | Whole cents in the core, rounded half up once per line; converted to FloCafe's dollar amounts at one place on the server |
| Tax (British Columbia) | GST 5% on food; GST 5% plus PST 7% on soda; prices shown before tax. Checked against the BC and CRA bulletins during the build; the shop's accountant should confirm. |

## 5. Decisions

Evidence for each is in [decisions.md](decisions.md).

| # | Decision | State |
| :--- | :--- | :--- |
| D1 | Pizza core in `shared/pizza/`, pure TypeScript, no Node, React or database imports. | Fits upstream's lint rule for `shared/` |
| D2 | A pizza is a normal order line. Recipe as JSON in `modifier_selection`, price in `unit_price`, computed by the server through one helper at the three price sites. An owner price override still wins. | Proven |
| D3 | Pizza tables come from a second migration list (`main/pizza/migrations.ts`) with its own counter in `_flo_meta`, run after upstream's. Every pizza migration is idempotent and creates only pizza tables. | Proven, with two follow-ups |
| D4 | The menu file `shared/pizza/menu/shop-menu.json` is the master copy. The POS imports it; the site reads it at build time. A price changed only inside the POS does not reach the site until the file is updated. | Planned |
| D5 | `shared/pizza/ticket.ts` turns a recipe into a heading and ready-wrapped detail lines for a given paper width. An optional `detailLines` field carries them through the print kernel; each ticket path, each receipt template in use, and the kitchen display views print them. | Proven for two paths |
| D6 | POS screens are new components under `frontend/src/components/pos/pizza/`, with one-line hooks in the POS page, cart store, cart identity, cart price and cart-to-order mapping. | Hook points located |
| D7 | Pizza screen text is English only in `frontend/src/lib/i18n/messages-pizza/en.json`, merged into the active language at load. The translations test gains four lines so it knows those keys. | Proven |
| D8 | Pizza shop mode is a setup profile, `pizza`. It sets counter service, no tables, no waiter app, kitchen ticket auto-print, drawer pulse on cash only, and imports the menu. The setup wizard pre-fills Canada, CAD and Vancouver time, because a profile cannot choose the region. | Planned |
| D9 | The menu site is a new app in `web/`: Next.js App Router, same Next, React and Tailwind versions as `frontend/`, fully static, no database, no secrets. | Planned |
| D10 | Tests: upstream's script pattern for core, backend and POS. `web/` uses Vitest with Testing Library, plus Playwright. One file of golden price cases is used by all four layers. | Planned |
| D11 | The fork starts from upstream `main` at `b5928ec`. Pulling upstream later is a deliberate task. | Done |
| D12 | BC tax is set by the pizza profile through FloCafe's manual tax configuration (categories `food` and `soda`, rules GST and PST, exclusive pricing), not by a new tax pack. | Planned |
| D13 | The fork turns FloCafe's `offline_mode` on by default and stops setup from forcing cloud sync on. Nothing contacts the internet unless the owner switches it on. | Planned |
| D14 | A pizza table (`pizza_products`) marks which products are pizzas. The server rejects a pizza line that has no valid recipe, and rejects ordinary add-ons on a pizza line. | Planned |
| D15 | The headless server is `node dev-server.js` with `PORT`, `KDS_PORT`, `SERVER_APP_PORT` and `FLO_DEV_USER_DATA`. Daily backups and LAN HTTPS do not start in that mode; the headless kit adds scheduled backups. | Proven on macOS |

## 6. Unit tests

Tests are written before the code they cover. Each file gets its own `test:pizza-*` script chained into `npm test`.

### Pizza core (`tests/pizza-*.test.ts`, no database)

| Test file | Cases |
| :--- | :--- |
| `pizza-menu-schema` | The shop menu file validates. Every specialty's default toppings exist. Every topping has a price for every size. Combos point at real items. No duplicate ids. All prices are whole cents. A broken menu fails with a message naming the bad entry. |
| `pizza-pricing` | Base price per size. Crust upcharge per size. Regular and premium toppings per size. Extra, light and removed toppings. A removed default gives no credit. An added non-default is charged. Half toppings at the configured rate. Quantity. Rounding. Each half-and-half rule. Half specialty with half custom. Build your own from zero toppings. Changing a rule setting changes the price. |
| `pizza-validation` | Size, crust and sauce required. Unknown or inactive ids rejected. Half and half needs both halves. The same topping on whole and on a half is normalised to one entry. Topping limit and warning threshold. Note length. Recipe size limit. Every rejection carries a message a cashier can act on. |
| `pizza-combos` | Slot rules. An unfilled slot is rejected. A wrong size in a slot is rejected. Deal price plus upcharges for premium and extra toppings. Each pizza in a deal keeps its own changes. |
| `pizza-presets` | Save and load give back the same recipe. Format version is stored. A preset in an older format is upgraded. A preset pointing at a deleted topping is reported, not silently changed. Optional `customer_id`. |
| `pizza-cart` | Two identical recipes merge into `2x`; any difference keeps them apart, whatever order the toppings were tapped in. "Customize 1" turns `2x` into `1x` unchanged plus `1x` changed. Splitting `1x` does nothing. |
| `pizza-ticket` | The ticket in the product plan (order #1042) is reproduced line for line at 42 and 48 columns, including the aligned `LEFT:` and `RIGHT:` labels. Long lines wrap at commas, never leaving a lone `+`. `NO` lines are upper case. Sides, dips and drinks print as plain lines. |
| `pizza-golden-prices` | Every case in `tests/fixtures/pizza-price-cases.json` gives the expected price. |
| `pizza-core-purity` | The core imports nothing from Node, Electron, React or the app. |

### Backend (real SQLite in a temporary folder, upstream's test runner)

| Test file | Cases |
| :--- | :--- |
| `pizza-migrations` | A new database gets the tables. A real upstream version 125 database upgrades and keeps its data. Running twice changes nothing. Health check and restore accept the tables; an undeclared table is still rejected. A backup made by upstream restores. A later upstream migration still runs. A pre-migration backup is taken when only pizza migrations are pending. A backup from an older pizza version is listed as valid for recovery. |
| `pizza-menu-import` | Importing the menu file creates the right rows. Importing again changes nothing. A changed price updates one row. A broken file imports nothing and says why. A currency reset keeps or clears pizza tables together with the rest of the menu. |
| `pizza-api` | Create, read, update and delete for sizes, crusts, toppings, defaults, combos and quick buttons. Permission checks. Quick buttons for the shop and for one customer. Bad input returns a clear error. |
| `pizza-order-pricing` | An order with a pizza is priced by the server at all three price sites, and the cart preview equals the placed order. A tampered client price is ignored. A pizza product with no recipe is rejected. Ordinary add-ons on a pizza line are rejected. An oversized or malformed recipe is rejected. The recipe is stored and returned. Mixed orders. Quantity edit, replacement edit, void and refund keep the recipe. An owner price override still works. The golden price cases pass through the real order route. |
| `pizza-tax-bc` | Pizza: GST only. Soda: GST and PST. A mixed order shows both lines. Prices are tax-exclusive. Rounding. |
| `pizza-setup-profile` | The `pizza` profile sets every switch in D8 and D12 and imports the menu. |
| `pizza-offline-default` | A fresh install has offline mode on. Completing setup does not turn cloud sync on and makes no outbound request (registration, telemetry, update check, tax catalogue). |
| `pizza-kot-print` | A pizza order prints the core's lines on the server ESC/POS path, the raster document path and the receipt templates in use. The header shows phone and delivery address for delivery orders. Station routing still works. Cash receipt shows change due. Upstream's print golden file is unchanged. |

### POS screen

| Test | Cases |
| :--- | :--- |
| `pizza-cart-store` (script) | Adding, editing and splitting pizzas in the cart store. Restoring a saved cart keeps two different pizzas apart. The cart's price equals the core's price for the golden cases. The cart-to-order mapping sends the recipe. Two different pizza carts get different retry fingerprints. |
| `pizza-kot-browser` (script) | The browser ESC/POS and browser HTML tickets print the same detail lines as the server. |
| `pizza-i18n` (script) | Pizza keys resolve under a non-English language. The pizza strings file has valid message syntax and no duplicate keys. |
| Playwright `pizza-*.spec.ts` | Build a half and half and pay cash. Build your own. Three pizzas edited separately. "Customize 1". A combo with tabs. A dip and a drink from the popups. Save a quick button, tap it, edit it. A customer's saved pizza by phone number. Editing a placed pizza keeps its recipe. The kitchen display shows the recipe. Kitchen ticket preview matches. |

### Menu site (`web/`)

| Test | Cases |
| :--- | :--- |
| Vitest | Every menu category and item from the menu file renders. The builder shows the core's price for the golden cases. Required choices block "done". The topping limit warning appears. |
| Playwright | Phone and desktop sizes: open the menu, build a pizza, check the price. Keyboard use. Automated accessibility check. Run on the local production build and again on the Vercel preview. |

## 7. Stages and gates

| Stage | Output | Gate | State |
| :--- | :--- | :--- | :--- |
| **1. Intake and gap analysis** | The real menu as a draft menu file. Pricing rules. [gap-analysis.md](gap-analysis.md). | Owner confirms the menu and the open questions. | Gap analysis done and scope confirmed; menu owed |
| **2. Fork, baseline and spike** | The fork. [baseline.md](baseline.md). [decisions.md](decisions.md). | Baseline on both machines. Decisions confirmed. | Decisions approved by the owner; see baseline.md for each machine |
| **3. Design** | Menu site: references from the shop's brand, a brand sheet, wireframes of the menu and builder. POS: builder, combo and quick button layouts in FloCafe's style. | Owner picks a direction. | Waiting for shop identity |
| **4. Task briefs** | One brief per pull request in `pizza/briefs/`: scope, files, tests to write first, how to verify. Reviewed against the architect, QA and security checklists. | No open review findings. | |
| **5. Build** | Waves 1 to 4 in section 8. | Each pull request: tests first and passing, local CI green, review clean. Each wave: full suite on Fedora. | |
| **6. Hardening** | QA against the product plan. Security pass on the new routes and the site's headers. Accessibility and speed pass on the site. POS running headless on Fedora, opened from another device. | No open findings. Golden prices identical in core, server, POS cart and site. | |
| **7. Deploy** | Section 9. | Preview verified, owner approves, production verified. | |
| **8. Learn** | Retrospective and updated notes. | — | |

## 8. Build plan: agents, machines, waves

### Roles of the two machines

| | MacBook Pro | Fedora |
| :--- | :--- | :--- |
| Role | Orchestrator and up to three coding agents | One integration agent; later one coding agent for the Linux work |
| Does | Writes code and tests, runs targeted tests, typecheck, lint; runs local CI for each pull request | Takes each pushed branch, opens the pull request, runs the review loop, merges. Runs the full suite once per wave. Acts as the shop's headless mini PC. |
| Limits | One full test suite at a time (machine lock). No native Electron tests. | At most three agents; one full suite at a time |

At most five agents run at once. Coding agents are Claude; Codex is kept for reviews because its quota is shared between the machines.

### Review and CI

- **Reviewer.** The standing reviewer is GPT-6.2 Sol. Its usage limit was reached on 2026-11-25 and returns on 2026-11-28. Until then Claude Opus 5.5 reviews each pull request in the same loop. On 2026-11-28 Sol reviews everything merged in the meantime, and its findings are fixed in follow-up pull requests.
- **CI.** GitHub Actions is not enabled on the fork. Each pull request is checked with `scripts/pizza/local-ci.sh`, which runs the steps of `.github/workflows/ci.yml`, and the result table is posted on the pull request. The Mac runs lint, typecheck, format, docs, builds, the full core suite and the Playwright browser suites. Fedora runs the native Electron suite under Xvfb, as upstream's CI does; it never runs on the Mac, where it raises a system keychain dialog. Dependency review and the Windows jobs are not run.

### Rules every agent follows

1. Own checkout (git worktree), never a shared one.
2. Tests first, then code.
3. Follow the repository's `AGENTS.md` (Conventional Commits, oxlint and oxfmt, docs updated in the same change) and [README.md](README.md) in this folder.
4. Before pushing: its own `test:pizza-*` scripts, `tsc --noEmit`, lint, lint budget, format check, test-script coverage check.
5. Push a branch and report the branch, commit and test output. Coding agents do not open pull requests.
6. A brief sent to the other machine stands alone.
7. A failure stops the work and is reported. No workarounds, no skipped tests, no temporary fixes.
8. Tests and servers run with a throwaway `HOME`. Never finish the setup wizard of a build that does not have offline mode on. Never launch the Electron app or its native tests on the Mac.

### Pull requests

| PR | Contents | Needs | Coder |
| :--- | :--- | :--- | :--- |
| 0 fork setup | The `pizza/` folder (this plan, decisions, gap analysis, baseline), the suite report tools, a pointer in `AGENTS.md`. | — | Orchestrator |
| 1 core contract | Types, menu schema, the real menu file, golden price cases, schema validation. | 0 | Mac, one agent |
| 2 pricing | Pricing engine, validation, combos, presets, cart merge and split. | 1 | Mac A |
| 3 ticket | Ticket formatter with its own wrapping; `detailLines` through the print kernel; server ESC/POS and raster paths; classic and compact receipts; phone and address in the ticket header. | 1 | Mac B |
| 4 database and API | Pizza migration list, tables including `pizza_products`, recovery reference keyed by pizza version, API routes, menu import, currency reset. | 1 | Mac C |
| 5 shop mode | Offline by default, `pizza` setup profile, wizard pre-fill, BC tax, sidebar, permission overrides that hide Dashboard, Inventory, Expenses and Staff where the shop does not use them. | 4 | Mac A |
| 6 order pricing | Price helper at the three sites, recipe validation at the API, the D14 guards, replacement edit keeps the recipe, kitchen display allow-list. | 2, 3, 4 | Mac B |
| 7 builder | Pizza builder, cart integration, "Customize 1", the order page's add and edit dialogs, browser ticket paths, kitchen display views. | 2, 3 | Mac C |
| 8 quick buttons and combos | Quick buttons, customer favourites, combo tabs, category popups, large category buttons. | 6, 7 | Mac A |
| 9 menu site | The site in `web/`. | 2, design | Mac B |
| 10 headless kit | systemd unit, install script, scheduled backups, restore, a printing check on Linux, headless smoke test. | 5 | Fedora |
| 11 hardening | Fixes from the QA, security and accessibility passes. | all | Mac |

### Waves

| Wave | In parallel | Then |
| :--- | :--- | :--- |
| 0 | PR 0. Baseline on both machines. Spikes. | Stage 2 gate |
| 1 | PR 1 alone: it is the contract everything else codes against. | Merge |
| 2 | PRs 2, 3, 4. Site design with the owner at the same time. | Merge in order; full suite |
| 3 | PRs 5, 6, 7 | Merge; full suite; first end-to-end pizza order |
| 4 | PRs 8, 9 (Mac) and 10 (Fedora) | Merge; full suite |
| 5 | Hardening, PR 11 | Stage 6 gate |
| 6 | Deploy | Stage 7 gate |

Every pull request goes through the review loop and is merged when local CI and the review are clean. One review loop and one local CI run happen at a time.

## 9. Deploying the menu site to Vercel

Nothing touches Vercel before stage 7. The repository is not connected to Vercel until the end, because a connected repository deploys on every push.

1. All pull requests merged, stage 6 gate passed.
2. Production build of `web/` locally: unit tests, Playwright, accessibility and speed checks.
3. Update the Vercel CLI, then create the project `pizza-pos-web` under the `anmolnoor` account, root folder `web/`, with access to `shared/`.
4. Preview deploy. Run the Playwright checks and the golden prices against the preview link. Check the security headers.
5. **The owner opens the preview link and approves.**
6. Production deploy. Run the same checks against the live address.
7. Optional, on the owner's word: connect the repository so later changes to `web/` deploy by themselves, and add a custom domain.

The site depends only on PRs 1, 2 and 9, so it could go live after wave 4 without waiting for the POS hardening. The default waits for everything.

## 10. Risks

| # | Risk | Handling |
| :--- | :--- | :--- |
| R1 | A backup taken before a newer pizza migration is listed as invalid by downgrade recovery. | PR 4 keys the recovery schema reference by pizza version; covered by `pizza-migrations`. |
| R2 | Plain ESC/POS printing in headless mode is unverified, and raster printing needs an Electron window. | PR 10 tests network ESC/POS printing on Linux. The shop uses ESC/POS printers, not raster. |
| R3 | The real menu has a rule the core does not model (a free topping count, a weekday special). | Stage 1 reads the whole menu before the schema is frozen. |
| R4 | A path we did not patch adds a pizza without a recipe (barcode scan, waiter app, order page). | D14: the server refuses it, so a missed path fails loudly instead of selling a blank pizza. |
| R5 | Codex review quota runs out again after it returns. | One review loop at a time; the Opus arrangement in section 8 is the standing answer. |
| R6 | The big upstream files change under us and later upstream pulls conflict. | One-line hooks only (D6); settings instead of deletions (D8); process docs outside `docs/`. |
| R7 | BC tax treatment is wrong for an item. | Checked against the official bulletins, covered by `pizza-tax-bc`, and kept as editable tax settings. |
| R8 | Something still phones home with offline mode on. | `pizza-offline-default` asserts no outbound request during install and setup. |
| R9 | Local CI differs from upstream's Linux CI (macOS, one machine, no Windows jobs). | The per-wave full suite on Fedora covers Linux. Enabling Actions on the fork later needs one click by the owner. |

## 11. Scope questions, decided

The owner accepted every default on 2026-11-25. Anything left out can come later as its own pull request.

| # | Question | Decision |
| :--- | :--- | :--- |
| Q1 | FloCafe can hold an order only for a dine-in table. Should the counter be able to park a pickup or delivery order and recall it? | Not built now. |
| Q2 | Does the shop charge a delivery fee? FloCafe's POS screen never fills its delivery charge field, and its custom charges are not taxed. | Not built now; delivery orders carry no fee. |
| Q3 | Order numbers are `ORD-20261125-0001` because a daily reset forces the date in. The ticket can also print a large short number. | Keep the dated number and print the large short number on tickets. |
| Q4 | The built-in card method is named "Card" and cannot be renamed, so receipts say "Card", not "Card - External Terminal". | Use the built-in "Card". |
| Q5 | Voids and refunds are recorded, and reports show refund totals, but there is no screen listing the audit log. | Not built now. |
