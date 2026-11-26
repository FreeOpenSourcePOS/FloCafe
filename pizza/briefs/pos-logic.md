# Brief: lane F0, the logic under the POS pizza screens

The screens themselves come next; this lane builds everything they stand on, with no new visible component, so it can be tested without a browser.

Read [../contract.md](../contract.md) first. Then [../README.md](../README.md), decision D6 in [../decisions.md](../decisions.md) (it lists every hook point in the POS page and cart files with line numbers for upstream `b5928ec`), and the chosen layouts in [../design/decision.md](../design/decision.md) with the notes in [../design/notes.md](../design/notes.md). Open [../design/index.html](../design/index.html) in a browser if you want to see what the logic has to support: screens 1A (home), 2A (pizza sheet) and the cart on 1A.

This branch sits on the pizza core (`shared/pizza/`: `validateRecipe`, `recipeKey`, `ticketLines`, the types).

## Outcome

**1. The catalogue in the browser.** `frontend/src/lib/pizza/catalog.ts`: fetches `GET /api/pizza/catalog` (answers the stored `PizzaCatalog`, or 404 when no menu is loaded) through the existing API client, keeps it for the session, and exposes a way to read it synchronously once loaded and to reload it. A 404 means "no pizza menu"; the POS then behaves exactly as upstream.

**2. Sheet state.** `frontend/src/lib/pizza/sheet-state.ts`: a pure reducer for the pizza sheet (screen 2A) with no React in it.

- State: the size; whole or half and half; the pizza of each half; removed ingredients per half; cook and cut notes; dip counts; the free-text note; quantity.
- Actions for every control on the sheet, and one to load an existing cart line for editing.
- Derived, from the state and the catalogue: the recipe (`PizzaRecipe` or none for a plain pizza), the product and variant ids the line needs (the contract's derived ids; the half-and-half product for a half and half), the add-ons for the dips, the unit price in cents (size price plus dips), the detail lines for the "prints as" box (`ticketLines`), and whether Add is allowed, with the message to show when not (no size yet; half and half with one half missing; identical halves, using the core's message).
- Opening on a tile's size button (screen 1A) adds a plain pizza without the sheet; the reducer supports starting from a pizza and size.

**3. The cart.** Smallest possible changes to the existing files.

- `CartItem` gains an optional recipe. Two lines merge only when their recipes have the same `recipeKey`; this goes into the line identity (`frontend/src/lib/cart-identity.ts`) and into `normalizeCartItems`, so restoring a saved cart never merges two different pizzas.
- "Customize 1": a pure function that splits a line of `Nx` into `(N-1)x` unchanged and `1x`, returning the new line to open in the sheet; on a `1x` line it returns the line itself.
- The cart-to-order mapping (`frontend/src/lib/cart-order-item.ts`) sends the recipe as `modifier_selection`. The retry fingerprint (`frontend/src/lib/order-attempt.ts`) therefore differs for two carts that differ only in a recipe: prove it.
- The displayed unit price needs no change (the variant and add-ons already price it): prove that with a test rather than adding code.
- A cart line exposes its detail lines for display (from `ticketLines` at a fixed width suited to the cart panel).

**4. Browser print paths and the kitchen display data.** The print layer already prints an item's `detailLines`. Fill them from the item's `modifier_selection` and the catalogue with `ticketLines` in the browser paths: `frontend/src/lib/printer/kot-encoder.ts`, `print-document.ts` (kitchen ticket and bill documents), `kot-web-print.ts` and `receipt-encoder.ts`. Add one helper, used by those, that turns an order item into its detail lines. With no catalogue loaded, or an item with no recipe, output is unchanged.

## Not in this lane

New React components, the POS page layout, the deal configurator, quick buttons, the small-items popup, and anything under `main/`.

## Tests to write first

Script tests under `tests/`, each with a `test:pizza-*` script chained at the end of `"test"`. Load frontend modules the way `tests/helpers/pizza-print-harness.ts` and `tests/cart-variant-identity.test.ts` do. Build the catalogue with `parseMenuFile` on `tests/fixtures/pizza-sample-menu.json`.

`tests/pizza-sheet-state.test.ts`: every action; each derived value for a plain pizza, a pizza with removals, a half and half with removals on one half, and with dips; Add refused with the right message in each refused state; loading a cart line and saving it back gives the same recipe; the reducer never mutates its input.

`tests/pizza-cart-store.test.ts`: the `pizza-cart-store` row in section 4 of [../plan.md](../plan.md), plus the fingerprint and unit-price proofs above.

`tests/pizza-kot-browser.test.ts`: for a half and half with removals and a three-pizza deal, the browser ESC/POS ticket, the raster document, the browser HTML ticket and the browser receipts carry the same detail lines as `ticketLines` gives, at 42 and 48 columns; an item without a recipe, and any item when no catalogue is loaded, prints byte for byte as before (pin with hashes taken before your change, as `tests/pizza-print-detail-lines.test.ts` does).

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-sheet-state && HOME=$(mktemp -d) npm run test:pizza-cart-store && HOME=$(mktemp -d) npm run test:pizza-kot-browser
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>
```

The last command is the full core suite under the machine lock; run it once at the end and wait for it. Use a report folder name no other agent would pick. No Playwright, and never the Electron app.

Commit `pizza/design/` (the chosen wireframes and notes) with your work. Update `docs/architecture/frontend.md` and `docs/architecture/printing.md` where they describe the cart line identity and the browser print paths (present tense, no history).

## Report

Branch and commit, red-then-green output, full-suite totals, every upstream file edited with line counts, the exported names the screens will use, and anything on screens 1A and 2A the reducer cannot express.
