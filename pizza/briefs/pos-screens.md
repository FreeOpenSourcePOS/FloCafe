# Brief: lane F1, the POS home and the pizza sheet

The first pizza screens a cashier sees. Everything they stand on is already built and tested: read `docs/architecture/frontend.md` (the sections on cart line identity and the pizza logic modules), then [../contract.md](../contract.md), [../README.md](../README.md), and the chosen layouts in [../design/decision.md](../design/decision.md) with [../design/notes.md](../design/notes.md). **Open [../design/index.html](../design/index.html) in a browser and study screens 1A (home) and 2A (pizza sheet): those two frames are what you are building.** Decision D6 in [../decisions.md](../decisions.md) lists the hook points in the POS page and cart files.

What exists, under `frontend/src/lib/pizza/`: `loadPizzaCatalog` / `getPizzaCatalog` / `reloadPizzaCatalog` (catalog.ts); `newSheet`, `sheetReducer`, `sheetLine` (sheet-state.ts); `customizeOne`, `replaceCartLine` (cart-lines.ts); `cartLineDetailLines`, `orderItemDetailLines` (detail-lines.ts); `useCartStore.addItem(product, quantity, addons, note, variant, recipe)`. The server validates every recipe and the menu import creates the products with derived ids (`pz-<pizza>`, `pz-<pizza>-<size>`, `pz-half-and-half`, `ad-dips-<option>`).

## Outcome

With no pizza menu loaded (`getPizzaCatalog()` is null) every screen looks and behaves exactly as upstream. With one loaded:

1. **The catalogue is loaded for every dashboard screen**: at the dashboard layout's mount and again after a sign-in, not only on the POS page, so a reprint from the orders page has it.
2. **POS home (screen 1A).**
   - The top-level categories are large colour-coded blocks.
   - Each pizza tile shows its three size buttons with prices. One tap on a size adds that plain pizza. "Customize" opens the sheet for that pizza. A "Half & Half" tile opens the sheet in half-and-half mode.
   - Other products keep upstream's tile and dialog.
3. **Pizza sheet (screen 2A)**, a dialog driven by `sheetReducer` and `sheetLine`: size; whole or half and half; the pizza on each half, side by side; ingredient chips where a tap strikes the ingredient out and shows `NO`; cook and cut toggles; dip steppers; note; quantity; the live price; a "Prints as" box; Add. Add is off, with the message from `sheetLine`, while the pizza cannot be added.
4. **Cart.** A pizza line shows its detail lines under the name (`cartLineDetailLines`). Edit on a pizza line opens the sheet loaded with that line; saving replaces the line (`replaceCartLine`), and an edit that makes it equal to another line merges them. A `2x` pizza line has "Customize 1" (`customizeOne`), which opens the sheet on the split line; closing without saving puts the cart back as it was.
5. Text for these screens goes in `frontend/src/lib/i18n/messages-pizza/en.json` (the `pizza` namespace; English only by design).

Every control is at least 48 px in both directions. Colour is never the only cue (a removed ingredient shows `NO` and a strike-through). The dialog works with a keyboard and has proper labels.

## Not in this lane

The deal configurator, quick buttons (leave "Save as quick button" out of the sheet for now), the dips and drinks popup, the kitchen display, the menu-loading screen, and anything in `main/`. Do not change the order page's edit dialog.

## How to build it

- New components under `frontend/src/components/pos/pizza/`. The POS page (`frontend/src/app/(dashboard)/pos/page.tsx`, 4,900 lines), `ProductGrid.tsx` and `CartPanel.tsx` get the smallest hooks that work.
- Read the Next.js docs bundled in `frontend/node_modules/next/dist/docs/` before relying on a Next.js API; the app is a static export.
- Reuse the existing dialog, button and stepper components and Tailwind tokens, so the sheet looks like part of FloCafe.

## Tests

**Browser tests are the proof here.** Write `frontend/e2e/pizza-pos.spec.ts` (Playwright, the existing `chromium` project). Look at an existing spec that takes an order and pays (for example the checkout specs) and at `frontend/e2e/helpers/` for sign-in and URLs.

- Run Playwright on your own ports so you never collide with other work on this machine: `E2E_BASE_URL=http://127.0.0.1:3411 E2E_KDS_PORT=3412 E2E_SERVER_APP_PORT=3413`, with a throwaway `HOME`, from `frontend/`: `npx playwright test --config=playwright.config.ts --project=chromium e2e/pizza-pos.spec.ts`. Build first (`npm run build` and `npm run build:frontend` in the repo root). Never run the Electron project.
- In the spec's setup, load `tests/fixtures/pizza-sample-menu.json` through `POST /api/pizza/menu/import` as the owner.
- Cases: (1) with no menu loaded the POS home matches upstream (no size buttons, no blocks); (2) one tap on Large adds a plain large pizza at the menu price; (3) half and half with one removal and a dip: the sheet's price and "Prints as" lines, then the cart line's detail lines; (4) identical halves switch Add off with the message; (5) "Customize 1" on `2x`, remove an ingredient, save: two lines; cancel instead: one `2x` line again; (6) editing a line to equal another merges them; (7) place and pay the order in cash, then read it back through the API: each line's `modifier_selection` is what the sheet built; (8) the sheet with the keyboard only.
- **Screenshots.** At 1180 × 820 (iPad landscape), save a screenshot of the POS home with a cart holding a `2x` pizza and a half and half, and of the pizza sheet in half-and-half mode with one removal, to a folder OUTSIDE the checkout (under the scratchpad, with `f1-pos-screens` in its name). Open each screenshot yourself and compare it with the wireframe frame; fix what is clearly off (overflow, clipped text, targets under 48 px, unreadable contrast) and say in your report what still differs and why.

Script tests are welcome for any new pure helper, with a `test:pizza-*` script chained at the end of `"test"` in `package.json`.

## Verify before pushing

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Then the full core suite once under the machine lock (`python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>`), started in the background and waited on until it exits. Update `docs/architecture/frontend.md` (present tense, no history).

## Report

Branch and commit; the Playwright result for each case; the screenshot paths and what differs from the wireframes; full-suite totals; every upstream file edited with line counts; the new strings; and anything on screens 1A and 2A you did not build.
