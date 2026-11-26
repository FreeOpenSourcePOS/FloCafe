# Brief: lane B2, loading a menu file into the POS

Read [../contract.md](../contract.md) first: the section "How a menu maps onto FloCafe's catalogue" is the specification, including every derived id and the add-on group settings. Then [../README.md](../README.md) and decisions D4, D12, D14 and D17 in [../decisions.md](../decisions.md).

This branch sits on the tables branch, so `pizza_products`, `pizza_menu` and `pizza_quick_buttons` exist (`main/pizza/migrations.ts`), and on the pizza core, so `parseMenuFile` exists (`shared/pizza/menu.ts`).

## Outcome

**1. `main/pizza/menu-import.ts`**

```ts
export function importMenu(db: Database, catalog: PizzaCatalog): { created: number; updated: number; unchanged: number; deactivated: number; untaxed: boolean };
```

- Writes FloCafe's own rows exactly as the contract's mapping table says: categories, products, variants, add-on groups and add-ons with the derived ids and the add-on group settings given there; the half-and-half product; one `pizza_products` row per pizza, for the half-and-half product and per deal; and the whole catalogue as JSON in `pizza_menu`.
- One transaction. Loading the same file twice changes nothing (`unchanged` counts every row). A changed price or name updates that row only.
- Something this import created earlier that is no longer in the file is switched off (`is_active = 0`), not deleted, because orders point at it. If it comes back in a later file it is switched on again. Rows the import did not create are never touched.
- Tax: drinks get the tax category `soda` when `drinksPst`, everything else `food`. Look the two up in the store's active tax configuration (`tax_categories.category_id`, as `docs/architecture/taxation.md` describes). If a category does not exist, leave the product without one and return `untaxed: true`.
- Money is converted from cents with `getCurrencyMinorUnitFactor`, in one place.
- Category colours are colour names (see the named list in `frontend/src/components/pos/ProductGrid.tsx`), one per category.

**2. `main/routes/pizza.ts`**, mounted with one line in the server's route index:

- `POST /api/pizza/menu/import`: the body is the menu file. It is parsed with `parseMenuFile` before anything is written; a `MenuError` answers 400 with its `path` and message and writes nothing. Success answers with the summary. Allowed for the bulk import permission, `catalog.import-export`.
- `GET /api/pizza/catalog`: the stored `PizzaCatalog`, for any signed-in POS user; 404 when no menu has been loaded.

## Rules

- New code in the two new files; one line in the route index. No other upstream file changes unless you must, and then say why.
- Use only `tests/fixtures/pizza-sample-menu.json`. No real shop's names or prices.
- Update `docs/reference/api.md` for the two routes (present tense, no history).
- A settings screen for choosing the file is not part of this lane.

## Tests to write first

`tests/pizza-menu-import.test.ts`, through `node tests/run-electron-node-test.cjs`, with a `test:pizza-menu-import` script chained at the end of `"test"`. Each case fails before the code exists.

1. After importing the sample, every row in the contract's mapping table exists with its derived id, price and settings; `pizza_menu` holds the catalogue; `pizza_products` has the pizzas, the half-and-half product and the deals.
2. No id repeats within any table.
3. A second import reports everything unchanged and leaves every row byte for byte the same.
4. A changed pizza size price updates exactly the variants at that size; a renamed pizza updates one product.
5. A pizza removed from the file is switched off and its `pizza_products` row kept; put back, it is switched on.
6. A product created by hand in the same category is untouched by an import.
7. With the pizza setup profile applied first (see `tests/pizza-tax-bc.test.ts`), drinks carry `soda` and everything else `food`, and an order of one large pizza, one can and two of the same dip through the real order route is accepted and priced from the catalogue. Without it, products have no tax category and the summary says `untaxed`.
8. The route: a broken file answers 400 naming the entry and writes nothing; a user without the permission is refused; `GET /api/pizza/catalog` answers 404 before and the catalogue after.

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-menu-import
npm run test:script-coverage
npx tsc --noEmit && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>
```

The last command is the full core suite under the machine lock; run it once at the end and wait for it. Use a report folder name no other agent would pick. No Playwright.

## Report

Branch and commit, red-then-green output, full-suite totals, the permission used, every upstream file edited, and anything in the mapping you could not express in FloCafe's tables.
