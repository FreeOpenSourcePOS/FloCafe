# Brief: lane K, pizza lines on the kitchen display

Read [../contract.md](../contract.md) (ticket text and its layout rules), [../README.md](../README.md), decision D5 in [../decisions.md](../decisions.md), and in `docs/architecture/printing.md` the part on recipe detail lines and the warning line.

What exists: order lines store a validated recipe in `modifier_selection`. `main/pizza/order-recipe.ts` fills print data with the recipe's lines (`withRecipeDetailLines`, which reads the stored menu once, calls `ticketLines`, and falls back to the single line `RECIPE NOT PRINTED - CHECK ORDER` when a recipe or the menu cannot be read). Restricted kitchen stations already receive `modifier_selection`. One route, `GET /api/kds/orders`, returns it as a JSON string while the other kitchen routes return it parsed.

## Problem

The kitchen display shows a pizza as a bare name. A cook reading the screen does not see `NO OLIVES`, which half is which, or what is inside a deal. The kitchen display runs as its own page with its own sign-in, and may run on its own port; it should not need the menu in the browser to show a line of text.

## Outcome

1. **The server puts the lines on every kitchen display item.** Wherever an order item is prepared for the kitchen display (the kitchen routes on the main API, the kitchen display server, the live broadcast, and the restricted-station projection), an item whose `modifier_selection` is a recipe also carries `recipe_lines`: the same lines the kitchen ticket prints, built at a fixed width of 48 columns, including the warning line in the same cases. An item with no recipe has no such field, or an empty list; choose one and use it everywhere. Reuse `withRecipeDetailLines` or the function under it; do not write a second formatter.
2. **The three kitchen display views show them** under the item name, above add-ons and the note: `frontend/src/components/kds/KdsItemModal.tsx`, `KdsTabsView.tsx` and `KdsKanbanBoard.tsx` (both places it lists items). The lines keep their leading spaces (they carry the nesting of a half or of a pizza inside a deal), in a monospace face, large enough to read from across a kitchen. The warning line stands out (colour plus a symbol or word, never colour alone).
3. With no recipe on any item, the kitchen display looks exactly as upstream.

## Not in this lane

The POS screens, the menu-loading screen, the customer display, printing, and the recipe check itself.

## How to build it

- Server: new logic beside the existing code in `main/pizza/order-recipe.ts`; hooks of a line or two where kitchen display items are built. Find every such place: `projectKdsItem` in `main/db.ts`, `main/routes/kds.ts`, `main/kds-server.ts`, `main/services/kds.ts`, and anything they call. List them in your report.
- Frontend: one small component for the lines, used in all three views; the smallest hooks in those views. The item type gains the optional field.
- Read the Next.js docs bundled in `frontend/node_modules/next/dist/docs/` before relying on a Next.js API.

## Tests to write first

`tests/pizza-kds-lines.test.ts`, through `node tests/run-electron-node-test.cjs`, with a `test:pizza-kds-lines` script chained at the end of `"test"` in `package.json`. Use `tests/helpers/pizza-fixture.ts` or the real importer with the sample menu.

1. An order with a half and half with one removal, a three-pizza deal, a plain pizza and an ordinary item: on each server path that prepares kitchen display items (name each path in the test), the half and half and the deal carry the contract's lines, and the plain pizza and the ordinary item carry none.
2. A restricted station's projection carries them too.
3. With the stored menu removed, a recipe item carries the single warning line, and the route still answers.
4. `GET /api/kds/orders` (the route that returns the recipe as a string) carries the lines as a list.
5. An order with no recipes: every payload is identical to the payload before your change (pin with hashes taken before you change any code, as `tests/pizza-print-detail-lines.test.ts` does).

`frontend/e2e/pizza-kds.spec.ts` (Playwright, the existing `chromium` project; see `frontend/e2e/helpers/kitchen-fixture.ts` and an existing kitchen display spec):

- Run Playwright on your own ports so you never collide with other work on this machine: `E2E_BASE_URL=http://127.0.0.1:3431 E2E_KDS_PORT=3432 E2E_SERVER_APP_PORT=3433`, with a throwaway `HOME`, from `frontend/`: `npx playwright test --config=playwright.config.ts --project=chromium e2e/pizza-kds.spec.ts`. Build first (`npm run build` and `npm run build:frontend` in the repo root). Never run the Electron project.
- Load the sample menu through `POST /api/pizza/menu/import` as the owner, place an order through the API with a half and half (one removal) and a three-pizza deal, then open the kitchen display.
- Cases: the lines show under each item in each of the three views, in order, with their indentation; an order with no recipes shows as upstream; with the stored menu removed, the warning line shows and stands out.
- **Screenshots.** Save one of each view with the two pizza items, at 1280 × 800, to a folder OUTSIDE the checkout (under the scratchpad, with `k-kitchen-display` in its name). Open them yourself and fix what is clearly off (clipped lines, lost indentation, text too small).

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-kds-lines
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Run upstream's kitchen display suites and name them (`kds-contract`, `kds-integration` and any other with `kds` in its script name). Then the full core suite once under the machine lock (`python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>`), started in the background and waited on until it exits. Update `docs/architecture/printing.md` where it says the kitchen display shows no detail lines, and the kitchen display page under `docs/` if there is one (present tense, no history).

## Report

Branch and commit; red-then-green for the script test; the Playwright result for each case; the screenshot paths; full-suite totals; every server path that prepares kitchen display items and whether it is hooked; every upstream file edited with line counts; anything you could not do as written.
