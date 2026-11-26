# Brief: lane E, the recipe on an order line (server side)

Read [../contract.md](../contract.md) first, sections "Pure functions", "Recipe rules" and "Order lines". Then [../README.md](../README.md) and decisions D2, D5, D14 and D18 in [../decisions.md](../decisions.md). D2 lists every place in `main/routes/orders.ts` where `modifier_selection` is stored, copied or dropped; line numbers there are for upstream `b5928ec` and have shifted a little.

This branch sits on the tables branch (`pizza_products`, `pizza_menu`) and on the pizza core (`validateRecipe`, `ticketLines` in `shared/pizza/`).

## Outcome

**1. Validation at the API.** A new file `main/pizza/order-recipe.ts` with one entry point the order routes call for every incoming line. It reads the catalogue from `pizza_menu` and the line's product from `pizza_products`, and applies the contract's "Order lines" rules:

- A product that is not in `pizza_products`: a `modifier_selection` whose `kind` is `pizza` or `deal` is refused; anything else passes through untouched, as today.
- A pizza product: a recipe is optional. When present it is validated and normalised with `validateRecipe`, and it must agree with the line: `sizeId` matches the variant's derived id, `whole.pizzaId` is the product's menu id.
- The half-and-half product and every deal product: a valid recipe is required, and it must agree with the line (`halves` only on the half-and-half product; `dealId` is the product's menu id).
- A refusal answers 400 with the `RecipeError` message, and nothing is written.
- The normalised recipe is what gets stored.
- The price is FloCafe's own, from the variant and add-ons. A recipe never changes it.

Hooks, each a line or two: order create, `insertOrderItems` (add items and edits), and the replacement-edit path, where a line that arrives without a recipe keeps the stored one.

**2. Kitchen and receipts, server paths.** The print layer already prints an item's `detailLines`. Fill them from the recipe with `ticketLines(catalog, recipe, columns)` wherever the server builds print data for kitchen tickets and for the classic and compact receipts (`main/printers/document-kot.ts`, `document-classic.ts`, `document-compact.ts`). The item heading stays FloCafe's own (product and variant); only the detail lines come from the recipe. No detail line may be wider than the printer's columns less three, for the real column count including the halved widths of large text sizes: find where the column count is known and call `ticketLines` there.

**3. Kitchen display.** Restricted stations project items through an allow-list (`projectKdsItem` in `main/db.ts`). Let the recipe through, so the display can show it.

## Not in this lane

The browser print paths, the kitchen display screens and everything in `frontend/`: lane F does those. Menu import: lane B2. Quick buttons.

## Tests to write first

Through `node tests/run-electron-node-test.cjs`, each with a `test:pizza-*` script chained at the end of `"test"`. Build the catalogue rows the tests need with a small helper (`tests/helpers/pizza-fixture.ts`) that parses the sample menu and inserts the `pizza_menu` row, the `pizza_products` rows and the products and variants with the contract's derived ids; do not depend on lane B2's importer.

`tests/pizza-order-recipe.test.ts`
1. A whole pizza, a half and half, and each kind of sample deal are accepted through the real order route and stored normalised (send removals out of order and a pop with a zero count; read back sorted and without it).
2. Refused with 400 and the recipe error message, with nothing written: an unknown ingredient; identical halves; a recipe whose size disagrees with the variant; `whole` naming a different pizza than the product; `halves` on a plain pizza product; a half-and-half line with no recipe; a deal line with no recipe; a deal with the wrong number of pizzas; a `kind: "pizza"` recipe on a product that is not a pizza; a recipe larger than the core allows.
3. A plain pizza with no recipe is accepted.
4. The price is the catalogue's whatever `unit_price` the client sends, with and without a recipe.
5. Add items, quantity edit, replacement edit with a new recipe, replacement edit with no recipe (the stored one is kept), void and refund all keep or update the recipe as stated.
6. A non-pizza product with some other object in `modifier_selection` still passes through unchanged.

`tests/pizza-order-print.test.ts`
1. A half and half with removals and a three-pizza deal print the contract's detail lines on the server kitchen ticket and on the classic and compact receipts, at 42 and 48 columns and at a large text size.
2. A line without a recipe prints as before.
3. A restricted kitchen display station's projected item carries the recipe.

Upstream's order and print suites must pass untouched.

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-order-recipe && HOME=$(mktemp -d) npm run test:pizza-order-print
npm run test:script-coverage
npx tsc --noEmit && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>
```

The last command is the full core suite under the machine lock; run it once at the end and wait for it. Use a report folder name no other agent would pick. No Playwright.

Update `docs/architecture/order-lifecycle.md` and `docs/architecture/printing.md` in the same change (present tense, no history).

## Report

Branch and commit, red-then-green output, full-suite totals, every upstream file edited with line counts, where you call `ticketLines` and how the column count gets there, and any path that stores or copies `modifier_selection` that you found and did not cover.
