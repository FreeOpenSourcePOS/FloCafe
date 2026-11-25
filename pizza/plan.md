# Pizza POS build plan

Turn this FloCafe fork into a pizza-shop POS that takes a shop's menu file and runs offline at the counter.

Revised 2026-11-25 after the owner pointed to the shop's real menu and to the existing customer ordering app. Companion pages: [contract.md](contract.md) (types, signatures, tables, lanes), [decisions.md](decisions.md), [gap-analysis.md](gap-analysis.md), [baseline.md](baseline.md).

## 1. What gets built

| Part | What it is | Where it runs |
| :--- | :--- | :--- |
| **Pizza core** | Pure TypeScript in `shared/pizza/`: reads a menu file, validates the recipe on an order line, and writes the kitchen ticket text. | Inside the POS, server and browser |
| **Pizza POS** | FloCafe with a pizza mode: a pizza sheet (size, dips, remove an ingredient, half and half, cook and cut notes), a deal configurator, quick buttons, pizza kitchen tickets, British Columbia tax, café features and outside connections switched off. | Locally, offline |
| **Headless kit** | Service, scheduled backups, restore and health checks for running the POS on a small Linux PC with no monitor. | The shop's mini PC |

### Not in this plan

- **A customer website.** The shop's customer ordering app is a separate project owned by the same developer. It is the customer site; nothing in this repository is hosted on Vercel.
- **A real shop's menu.** This repository carries a made-up sample menu. A shop's own file is loaded at install.
- Paid extra toppings, crust choices and build-your-own pizzas. The shop's menu has no prices for them. They are added when the shop supplies prices.
- Online order sync into the POS, card terminal integration, delivery apps, shop hardware, signed desktop installers, translations of the pizza screens, order parking, a delivery fee, an audit-log screen.

## 2. What the real menu looks like

The sample menu has the same shape as the shop's, with different names and prices.

| Part | Shape |
| :--- | :--- |
| Pizzas | A list of named pizzas, all at one price per size (small, medium, large). The description is the ingredient list. |
| Dips | Two kinds at one price, added to a pizza. |
| Sides | Wings with a required flavour, a pasta with a required type, salad, garlic toast. |
| Drinks | A few brands, each as a can or a two-litre bottle. |
| Deals | Fixed-price bundles: some pizzas of one size, plus pops, a wing flavour, or a choice between cans and a bottle. Sides inside a deal are not chosen. |
| Tax | GST 5% on everything. PST 7% on drinks. A deal is charged GST only until the shop's accountant says how to treat the pops inside it. |

Most of this fits FloCafe's own catalogue: sizes are variants, dips and flavours are add-on groups, and FloCafe already prices those on the server. What it cannot hold is the recipe: which half is which, what was removed, and what is inside a deal.

## 3. Decisions

Evidence and detail are in [decisions.md](decisions.md).

| # | Decision | State |
| :--- | :--- | :--- |
| D1 | Pizza core in `shared/pizza/`, pure TypeScript. | In progress |
| D2 | A pizza or deal is a normal order line: product, size variant, add-ons, price from FloCafe's catalogue. The recipe is JSON in `modifier_selection`, validated by the server. A recipe never changes the price. | Revised |
| D3 | Pizza tables come from a second migration list with its own counter. | Proven |
| D4 | A shop's menu is one file, loaded into the POS and mapped onto FloCafe's products, variants and add-on groups. Loading it again is safe. | Revised |
| D5 | One function writes the ticket lines; every ticket path, receipt and kitchen display view prints them through `detailLines`. | Print layer merged |
| D6 | POS screens are new components with one-line hooks in the POS page and cart files. | Planned |
| D7 | Pizza screen text is English only in its own file, with a four-line change to the translations test. | Proven |
| D8 | Pizza shop mode is a setup profile, `pizza`. The wizard pre-fills Canada, CAD and Vancouver time. | In progress |
| D11 | The fork starts from upstream `b5928ec`. Pulling upstream later is a deliberate task. | Done |
| D12 | BC tax through FloCafe's manual tax configuration: categories `food` and `soda`, exclusive prices. | In progress |
| D13 | Offline by default. | Merged |
| D14 | The `pizza_products` table marks pizzas, the half-and-half product and deals. The half-and-half product and deals require a recipe; a plain pizza does not. | Revised |
| D15 | Headless: `node dev-server.js` with fixed ports, plus the headless kit. | In progress |
| D16 | The customer site is a separate project. No `web/` app here and nothing deployed to Vercel from this repository. | Decided by the owner |
| D17 | The repository holds a made-up sample menu only. | Decided by the owner |
| D18 | First version of the builder does what the menu supports. | Decided by the owner |

D9 (a menu site in `web/`) and D10's site tests are withdrawn.

## 4. Tests

Written before the code they cover. Each file has a `test:pizza-*` script chained into `npm test`.

| Test file | Cases |
| :--- | :--- |
| `pizza-menu` | The sample menu parses. Prices become whole cents; a price with a fraction of a cent is rejected. Ingredients are split from the description. Dips come from the `dip` side. A deal pointing at an unknown size is rejected. Duplicate ids are rejected. Every error names the bad entry. Unknown extra fields are ignored. |
| `pizza-recipe` | Whole pizza, half and half, removals. Unknown pizza, size or ingredient is rejected with a message a cashier can act on. Two identical halves are rejected. Same recipe gives the same key whatever the tap order. A deal needs one pizza per pick at the deal's size, pops adding up, a wing flavour when asked, and exactly one answer to a choice. An oversized or malformed recipe is rejected. |
| `pizza-ticket` | Every example in the contract prints line for line at 42 and 48 columns. Long removal lists wrap at commas. No line is wider than the paper. The sample's `jalapeño pepper` is upper-cased with the Ñ kept. |
| `pizza-migrations` | A new database gets the tables. A real upstream database upgrades and keeps its data. Running twice changes nothing. Health check and restore accept the tables; an undeclared table is still rejected. A later upstream migration still runs. A backup at an older pizza version is listed as valid for recovery. A currency reset treats pizza tables like the rest of the menu. |
| `pizza-menu-import` | Importing the sample menu creates the products, variants and add-on groups in the contract's table. Importing again changes nothing. A changed price updates one row. A broken file imports nothing and says why. Drinks get the `soda` tax category. |
| `pizza-setup-profile` | The `pizza` profile sets counter service, no tables, kitchen ticket auto-print, drawer pulse on cash only, customer contact on kitchen tickets, and taxes on. Offline mode stays on. |
| `pizza-tax-bc` | Food: GST only. A drink: GST and PST. A large pizza plus a can gives the totals worked out by hand in the test. A deal: GST only. Prices are tax-exclusive. |
| `pizza-i18n` | Pizza keys resolve under a non-English language. The strings file has valid message syntax and no duplicate keys. |
| `pizza-order-recipe` | The server stores a valid recipe normalised and rejects an invalid one. A recipe that disagrees with the line's product or size is rejected. A half-and-half or deal line without a recipe is rejected; a plain pizza without one is accepted. Quantity edit, replacement edit, void and refund keep the recipe. The price is FloCafe's, whatever the client sends. |
| `pizza-order-print` | A pizza and a deal print the core's lines on every ticket path, the classic and compact receipts, and the kitchen display. |
| `pizza-cart-store` | Identical recipes merge into `2x`; different ones stay apart. "Customize 1" splits `2x` into `1x` and `1x`. Restoring a saved cart keeps two different pizzas apart. The cart sends the recipe. |
| `pizza-headless-*` | Health check, backup while running, restore, unit files, headless printing. |
| Playwright `pizza-*.spec.ts` | Half and half with a removal, paid in cash. Three pizzas changed separately. "Customize 1". Each kind of deal. A dip and a drink from the popups. Save a quick button, tap it, edit it. A customer's saved pizza by phone number. Editing a placed pizza keeps its recipe. The kitchen display shows the recipe. |

## 5. Pull requests

| PR | Contents | Needs | State |
| :--- | :--- | :--- | :--- |
| 1 | Plan, decisions, gap analysis, baseline, tools | — | Merged |
| 2 | Offline by default | — | Merged |
| 3 | Detail lines and customer contact on tickets | — | Merged |
| 4 | Contract: types, sample menu, this plan | — | Open |
| 5 | Lane A: menu parser, recipe validation, ticket text | 4 | |
| 6 | Lane B1: pizza migration list and tables | 4 | |
| 7 | Lane C: `pizza` setup profile, BC tax, wizard pre-fill, English-only strings | 4 | |
| 8 | Headless kit (Fedora) | 2 | In progress |
| 9 | Lane B2: menu import and its route | 5, 6 | |
| 10 | Lane E: recipe at the order API, print wiring, kitchen display | 5, 6 | |
| 11 | Lane F: pizza sheet, "Customize 1", cart | 10, design | |
| 12 | Lane F: deal configurator | 11 | |
| 13 | Lane F: quick buttons, category popups, large category buttons | 11 | |
| 14 | Hardening | all | |

Lanes A, B1 and C run at the same time on the Mac while the headless kit is built on Fedora. Wireframes for the POS screens are drawn in the same period, so the owner can pick a layout before lane F starts.

## 6. How the work is run

### Machines

| | MacBook Pro | Fedora |
| :--- | :--- | :--- |
| Does | Orchestrator, up to three coding agents, reviewers | One coding agent for Linux work; the Linux half of every check run |
| Limits | One full test suite at a time (machine lock). No native Electron tests. | At most three agents; one full suite at a time |

At most five agents run at once.

### Rules every agent follows

1. Own checkout (git worktree), never a shared one.
2. Tests first, then code.
3. Follow `AGENTS.md`, [README.md](README.md) and [contract.md](contract.md).
4. Before pushing: its own `test:pizza-*` scripts, `tsc --noEmit`, lint, lint budget, format check, test-script coverage check, docs check.
5. Push a branch and report the branch, commit and test output. Coding agents do not open pull requests.
6. A brief sent to the other machine stands alone.
7. A failure stops the work and is reported. No workarounds, no skipped tests, no temporary fixes.
8. Tests and servers run with a throwaway `HOME`. Never launch the Electron app or its native tests on the Mac.
9. No real shop's name, address, phone number, items or prices in this repository.

### Review and checks

- **Reviewer.** The standing reviewer is GPT-6.2 Sol. Its usage limit was reached on 2026-11-25 and returns on 2026-11-28. Until then Claude Opus 5.5 reviews each pull request in the same loop. On 2026-11-28 Sol reviews everything merged in the meantime, and its findings are fixed in follow-up pull requests.
- **Checks.** GitHub Actions is not enabled on the fork, by the owner's choice. Each pull request is checked with `scripts/pizza/local-ci.sh`, which runs the steps of `.github/workflows/ci.yml`, split between the machines so the two halves run at the same time: part `a` on the Mac (static checks, builds, core suite, release regressions, first half of the browser tests), part `b` on Fedora (builds, second half of the browser tests, the tier set, the native Electron suite). The result table goes in the pull request. Dependency review and the Windows jobs are not run.
- Review fixes are made in a second checkout, so they never wait on a check run.

## 7. Stages

| Stage | Gate | State |
| :--- | :--- | :--- |
| 1. Intake and gap analysis | Menu shape known; scope confirmed | Done |
| 2. Fork, baseline and spike | Baseline on both machines; decisions confirmed | Done |
| 3. Design of the POS screens | Owner picks a layout for the pizza sheet, deal configurator, quick buttons and popups | Wireframes in progress |
| 4. Briefs | One brief per lane in `pizza/briefs/` | Written as each lane starts |
| 5. Build | Per pull request: tests first, checks green, review clean | In progress |
| 6. Hardening | The product plan demonstrated screen by screen; security pass on the new routes; the POS running headless on Fedora with the shop's real menu loaded, opened from another device | |
| 7. Install at the shop | Outside this plan | |
| 8. Learn | Retrospective | |

## 8. Risks

| # | Risk | Handling |
| :--- | :--- | :--- |
| R1 | A backup taken before a newer pizza migration is listed as invalid by downgrade recovery. | Lane B1 keys the recovery schema reference by pizza version; covered by `pizza-migrations`. |
| R2 | Plain ESC/POS printing in headless mode is unverified. | The headless kit tests it against a loopback printer. |
| R3 | The shop's file has something the sample does not. | The real file is loaded in hardening on a developer machine, outside the repository; any gap becomes a sample-menu case first. |
| R4 | A path we did not patch sends a half-and-half or deal line without a recipe. | The server refuses it (D14). |
| R5 | The big upstream files change under us and later upstream pulls conflict. | One-line hooks only; settings instead of deletions; process documents outside `docs/`. |
| R6 | BC tax treatment is wrong for an item, or for the pops inside a deal. | Checked against the official bulletins, covered by `pizza-tax-bc`, and kept as editable tax settings. The deal question is the shop's accountant's. |
| R7 | The POS and the customer ordering app drift apart on prices. | Both read the same menu file. The POS takes prices only from it. |

## 9. Open questions for the shop's owner

None of these block the build; each is a setting or a later pull request.

| # | Question |
| :--- | :--- |
| Q1 | Extra-topping prices per size, and whether a build-your-own pizza is sold. |
| Q2 | Crust options, if any. |
| Q3 | Whether half and half is sold at the plain size price. The build assumes yes. |
| Q4 | How the pops inside a deal are taxed. |
| Q5 | Whether the pasta in a "two for one" is two of the same or one of each. |
