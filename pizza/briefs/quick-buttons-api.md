# Brief: lane G, saved quick buttons (server side)

Read [../contract.md](../contract.md) first: the `pizza_quick_buttons` table and the "Order lines" rules. Then [../README.md](../README.md) and decision D18 in [../decisions.md](../decisions.md). The chosen screen is 4A in [../design/decision.md](../design/decision.md) if that folder is present on your branch; if it is not, the description below is complete.

This branch sits on the order-API branch, so `main/pizza/order-recipe.ts` (the recipe check for order lines), `main/routes/pizza.ts` (the pizza routes) and the three pizza tables exist.

## Problem

A cashier wants to save a configured item ("Large half Island / half Classic, no pineapple") as a one-tap button, for the whole shop or for one customer found by phone number, and later tap it to add the same thing to an order. The table exists; nothing reads or writes it.

## Outcome

Routes under `/api/pizza/quick-buttons`, in `main/routes/pizza.ts`, with the logic in a new file `main/pizza/quick-buttons.ts`:

| Route | Does |
| :--- | :--- |
| `GET /api/pizza/quick-buttons` | The shop-wide buttons, in `sort_order`. With `?customer_id=<id>`, that customer's buttons as well, marked as theirs. |
| `POST /api/pizza/quick-buttons` | Saves a button. |
| `PUT /api/pizza/quick-buttons/:id` | Changes its label, colour, order, or what it holds. |
| `DELETE /api/pizza/quick-buttons/:id` | Removes it. |

A button holds exactly what one cart line holds: `product_id`, optional `variant_id`, optional `recipe`, optional `addons` (the cart's add-on shape: id and quantity), optional `note`, plus `label`, `color` and optional `customer_id`.

Rules:

- **Saving checks the button the way an order line is checked.** The product must exist and be active; the variant must belong to it; the recipe goes through the same check order lines use in `main/pizza/order-recipe.ts` (reuse it; do not write a second validator) and is stored normalised; add-ons must exist and belong to the product or its category. A refusal answers 400 with a message a cashier can act on.
- **A stored button can go stale** when the menu changes: a pizza or dip leaves the menu, a size is removed, an ingredient is renamed. Nothing rewrites a stored button. Each button the list returns says whether it can be added right now (`usable: true`), and when it cannot, why, in words a cashier can act on (`reason`). A stale button is still listed, so staff can edit or delete it.
- **No prices are stored or returned.** A button's price is whatever its product, variant and add-ons cost when it is tapped.
- **`color`** is one of the colour names the POS already uses for categories (see `frontend/src/components/pos/ProductGrid.tsx`); anything else is refused.
- **`label`**: required, trimmed, at most 24 characters. **`note`**: at most 140.
- **Who may do what.** Reading: any signed-in POS user. Saving, changing or deleting a customer's button: any user who may take orders. Saving, changing or deleting a shop-wide button: users who may manage the catalogue. Use existing permission names and say which.
- A button for a customer that no longer exists is not listed.

## Not in this lane

Anything in `frontend/`. Order parking. Sharing buttons between shops.

## Tests to write first

`tests/pizza-quick-buttons.test.ts`, through `node tests/run-electron-node-test.cjs`, with a `test:pizza-quick-buttons` script chained at the end of `"test"`. Use the fixture helper the order tests use (`tests/helpers/pizza-fixture.ts`) or the real importer (`importMenu` with the sample menu) for the catalogue. Each case fails before the code exists.

1. Save, list, change and delete a shop-wide button and a customer's button; the list for a customer has both, the list without one has only the shop's.
2. A saved recipe comes back normalised (send removals out of order).
3. Refused with 400 and a clear message, nothing written: an unknown product; a variant of another product; an invalid recipe (identical halves); a half-and-half button with no recipe; an add-on that is not the product's; a colour that is not a known name; a label that is empty or too long.
4. Staleness: after the stored menu changes so that the button's pizza is gone, its size is gone, a dip is gone, or a removed ingredient is renamed, the button is listed with `usable: false` and a reason naming what changed; a button whose items are all still there is `usable: true`. After the product is switched off by a menu load, the same.
5. Permissions: a cashier can save and delete a customer's button but not a shop-wide one; a manager can do both; a signed-out request is refused.
6. No price appears anywhere in a response.
7. A currency reset leaves no buttons (the tables lane already drops them; assert it through the list route).

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-quick-buttons
HOME=$(mktemp -d) npm run test:pizza-order-recipe
npm run test:script-coverage
npx tsc --noEmit && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Then the full core suite once under the machine lock: `python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <a report folder of your own, outside the checkout>`. Start it and wait for it to exit before you end your turn. No Playwright.

Update `docs/reference/api.md` for the four routes and add a short "Quick buttons" section to `pizza/contract.md` with the request and response shapes (present tense).

## Report

Branch and commit, red-then-green output, full-suite totals, the permission names used, every upstream file edited with line counts, the exact response shape of the list route (the screens lane builds on it), and anything about staleness you could not detect.
