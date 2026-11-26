# Brief: lane H, the screen that loads a menu file

Read [../contract.md](../contract.md) (the menu file and how it maps onto the catalogue), [../README.md](../README.md), decisions D4 and D17 in [../decisions.md](../decisions.md), and the "Pizza menu" section of `docs/reference/api.md`.

What exists: `POST /api/pizza/menu/import` (the body is the menu file; answers `{ created, updated, unchanged, deactivated, untaxed }`, or 400 with `{ error, path }` naming the bad entry; permission `catalog.import-export`, owner and manager by default) and `GET /api/pizza/catalog` (the stored catalogue, or 404). In the browser, `frontend/src/lib/pizza/catalog.ts` has `loadPizzaCatalog`, `getPizzaCatalog` and `reloadPizzaCatalog`.

## Problem

A shop keeps its menu in one JSON file, outside this repository. There is no way to load it into the POS without calling the API by hand.

## Outcome

A screen an owner or manager can reach from the sidebar, "Pizza menu":

1. **What is loaded now.** How many pizzas, sizes, dips, sides, drinks and deals the stored menu has, or a plain "No pizza menu is loaded" when there is none.
2. **Load a file.** Choose a `.json` file. Before anything is sent, the screen says plainly what loading does: the file is the master copy; names, prices and which items are on sale follow the file; anything the file no longer has is switched off, not deleted; changes made to those items in the product screen are overwritten. Then a confirm button.
3. **The result.** On success, the counts the server returned, in words ("12 added, 3 changed, 58 unchanged, 1 switched off"). When the answer says `untaxed`, a clear warning that the store has no `food` and `soda` tax categories, so the items carry no tax category of their own. On a refusal, the server's message and, when given, the entry it names. A file that is not valid JSON is refused in the browser with a message, before anything is sent.
4. After a successful load the browser's copy of the menu is refreshed (`reloadPizzaCatalog()`), so the POS shows the new menu without signing out.
5. A user without the permission does not see the sidebar entry and cannot use the screen.

Text goes in `frontend/src/lib/i18n/messages-pizza/en.json` (the `pizza` namespace; English only by design). Controls are at least 48 px; the screen works with a keyboard.

## How to build it

- A new route under `frontend/src/app/(dashboard)/` (the app is a static export: no dynamic segments, no server code). New components in new files. The sidebar (`frontend/src/components/layout/Sidebar.tsx`) gets one entry, filtered by permission the way its other entries are.
- Read the Next.js docs bundled in `frontend/node_modules/next/dist/docs/` before relying on a Next.js API.
- Reuse the existing page layout, card, button and alert components, so the screen looks like part of FloCafe.
- Nothing in `main/` changes. If you find you need a server change, stop and report it.

## Tests

`frontend/e2e/pizza-menu.spec.ts` (Playwright, the existing `chromium` project). Look at an existing spec that uploads or imports a file (the database export and import spec) and at `frontend/e2e/helpers/` for sign-in and URLs.

- Run Playwright on your own ports so you never collide with other work on this machine: `E2E_BASE_URL=http://127.0.0.1:3421 E2E_KDS_PORT=3422 E2E_SERVER_APP_PORT=3423`, with a throwaway `HOME`, from `frontend/`: `npx playwright test --config=playwright.config.ts --project=chromium e2e/pizza-menu.spec.ts`. Build first (`npm run build` and `npm run build:frontend` in the repo root). Never run the Electron project.
- Use only `tests/fixtures/pizza-sample-menu.json` and edited copies of it made inside the test.
- Cases: (1) nothing loaded: the screen says so; (2) load the sample: the confirm step, then the counts, then "what is loaded now" shows the sample's numbers; (3) load it again: everything unchanged; (4) a copy with one pizza removed and one price changed: one switched off, the right number changed; (5) a broken copy (a deal naming an unknown size): the server's message and the entry it names, and "what is loaded now" is unchanged; (6) a file that is not JSON: refused in the browser, no request sent; (7) a cashier sees no sidebar entry and is turned away from the screen's address; (8) after a load, the POS page shows a pizza from the menu without signing out.
- **Screenshots.** At 1180 × 820, save one of the screen with a menu loaded and one of the confirm step, to a folder OUTSIDE the checkout (under the scratchpad, with `h-menu-screen` in its name). Open them yourself and fix what is clearly off.

## Verify before pushing

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Then the full core suite once under the machine lock (`python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>`), started in the background and waited on until it exits. Update `docs/architecture/frontend.md` and the operator-facing sentence in `pizza/headless.md` that says how a shop loads its menu (present tense, no history).

## Report

Branch and commit; the Playwright result for each case; the screenshot paths; full-suite totals; every upstream file edited with line counts; the new strings; anything you could not do as written.
