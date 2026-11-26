# Brief: never place an order at a price the cashier was not shown

Read [../README.md](../README.md), [../contract.md](../contract.md) ("Order lines"), and the POS's order paths in `frontend/src/app/(dashboard)/pos/page.tsx` and `main/routes/orders.ts` (create and add items).

## Problem

The POS sends order lines without prices; the server prices them from the catalogue in force and answers "order placed". Nothing compares the server's total with what the cart showed. So when prices change on another device (a menu load, or the prices screen that is being built), a till that has not caught up yet can place an order at the new prices while the cashier and the customer saw the old ones, and nobody is told. A till refreshes its menu within seconds, but an order can be placed inside that window.

## Outcome

1. **The till says what it showed.** When the POS places an order or adds items to one, it sends the amount it showed for those lines before tax (the cart's subtotal for the lines being sent, in the store's currency, as the cart computes it: unit price plus add-ons, times quantity, less item discounts and with price overrides), as one optional field (for example `expected_subtotal`).
2. **The server refuses a mismatch.** When the field is present, the route compares it with its own subtotal for those lines (the same decimal arithmetic the order uses, `lineSubtotal` in `main/services/tax.ts`), before anything is written. If they differ by a cent or more, it answers 409 with a code a client can test for and a message a cashier can act on: "Prices have changed. Check the order and place it again." Nothing is written: no order, no stock change, no ticket. When the field is absent the route behaves exactly as before, so the Server App, online orders, the API and upstream's tests are untouched.
3. **The POS recovers.** On that refusal the POS refreshes the menu, products and categories at once (the same combined refresh the POS already has), re-prices the cart from the fresh lists, keeps every line, shows the message and the new total, and leaves the cashier to place it again. A line whose item is no longer on sale is marked, not silently dropped.
4. The comparison is on the amount before tax and before order-level discounts and charges, so a tax or charge rule the browser does not compute cannot cause a false refusal. Say in the report what the cart's subtotal includes and prove the browser's and the server's figure agree for: a plain item, a sized pizza, a half and half with dips and toppings, a deal with toppings, a weighed item, a line with an item discount, a line with a price override, an online order with a platform price, quantities above one.

## Not in this change

The Server App, the Orders page's add-item and edit windows, quick buttons' stored contents, and any change to how prices are computed.

## Tests

Script first (chained into `"test"`): the route with the field equal (accepted), a cent off either way (409, nothing written: order count, stock and print jobs unchanged), absent (as before); each shape in item 4 priced by the cart's own function and by the server and found equal; add-items as well as create. Playwright `frontend/e2e/pizza-price-guard.spec.ts` (chromium, `loadSampleMenu` / `clearPizzaMenu`; ports `E2E_BASE_URL=http://127.0.0.1:3421 E2E_KDS_PORT=3422 E2E_SERVER_APP_PORT=3423`): build a cart, hold back the POS's menu refresh (route the catalogue and product requests so the till stays stale), change a size price through the API, place the order: the message shows, no order exists, the cart shows the new price with every line kept; placing again succeeds at the new price. A second case: nothing changed, the order goes through as always.

## Verify before pushing

Every `test:pizza-*`; every script with order, tax, bill, discount, pos, cart or server-app in its name; `test:dev-tooling`; then `npm run i18n:check`, `npm run test:script-coverage`, both `tsc --noEmit`, `npm run lint`, `npm run lint:budget`, `node scripts/ci/check-changed-format.cjs --base e9601bc8`, `npm run docs:check`; one Playwright run of every `e2e/pizza-*.spec.ts` plus pos-actions-menu, pos-keyboard-shortcuts and server-app-ordering with `--retries=0`. Do not run the full core suite. Update `docs/reference/api.md`, `docs/architecture/order-lifecycle.md` and `pizza/contract.md`.

## Report

Branch and commit; red then green; what the cart's subtotal includes and where the two figures could still differ; the Playwright result per case; every upstream file edited with line counts; new strings; anything not built or not verified.
