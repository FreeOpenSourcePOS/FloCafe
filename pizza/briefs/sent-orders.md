# Brief: a pizza that has been sent can be seen and changed

Read `docs/architecture/frontend.md` (the pizza sections), [../contract.md](../contract.md) (the "Order lines" rules: on a replacement edit an absent `modifier_selection` keeps the stored recipe, an explicit `null` clears it, the size follows the variant, and the server checks every recipe), [../README.md](../README.md), and `tests/pizza-order-recipe.test.ts` (Cases 6, 6b, 7) for what the order routes do with an edited line.

What exists: the cart shows a pizza or deal line's detail lines (`cartLineDetailLines`), and `orderItemDetailLines` builds the same lines for an order item that came from the server. The pizza sheet and the deal configurator open on a cart line (`usePizzaPos`: `edit`). Once an order is placed, nothing on screen shows what is on a pizza, and nothing can change it.

## Problem

A customer phones back: "make that second one no onions". Today the Orders page and the POS's "Already ordered" list show `1× Half & Half (Large)` with no halves, removals or deal contents, and the edit window can change size, dips and quantity but not the recipe. Staff would have to void the line and add it again, blind. And from two places an order can be given a pizza the server then refuses: the Orders page's "Add items" and the Server App both use upstream's product dialog, so adding a Half & Half or a deal there fails at save with "Pick the two halves" or "Pick what goes in this deal".

## Outcome

With a pizza menu loaded (with none, everything is exactly upstream):

1. **Sent lines show what is on them.** Wherever a placed order's items are listed for staff, a pizza or deal line shows its detail lines under the name, the same lines the cart shows: the POS's "Already ordered" list, the Orders page's order view, and the Server App's existing-lines list. One small component, used in each place. When the lines cannot be built (no menu in the browser, or a recipe the menu no longer fits), show the words the kitchen ticket prints, `RECIPE NOT PRINTED - CHECK ORDER`, with a warning mark, never nothing.
2. **A sent pizza or deal can be changed from the POS.** Edit on a sent pizza line opens the pizza sheet loaded with that line; on a sent deal line, the deal configurator. Saving sends the replacement through the order's existing edit route with the new `modifier_selection` (and variant and add-ons), under the same permission and the same rules upstream applies to editing a sent line (find them: void or manager approval once an item is being prepared, and so on; do not loosen any). A refusal shows the server's message. Quantity and note behave as upstream's edit does.
3. **The Orders page's edit window** keeps doing what it does for size, dips and quantity, and no longer loses a recipe (it must not send `modifier_selection: null` for a pizza it did not change; check what it sends today and pin it with a test). If opening the sheet from the Orders page is a small step once item 2 exists, do it; if not, the Orders page shows the lines and says to change the pizza from the POS, and you report that.
4. **No path can build an order the server refuses.** In the Orders page's "Add items" and in the Server App, a Half & Half or a deal cannot be added through upstream's dialog: tapping one says where to add it ("Add a half and half or a deal from the POS") and adds nothing. A plain pizza with a size, a side or a drink is added as today.

## Not in this change

Printing, the kitchen display, reports, the customer display, pickup time, anything in `main/` (if a route cannot do what item 2 needs, stop on that point and report exactly what is missing).

## How

New code in new files under `frontend/src/components/pos/pizza/` and `frontend/src/lib/pizza/`; the smallest hooks in upstream files, and with no pizza menu those hooks do nothing. Text in `messages-pizza/en.json`. Controls at least 48 px, colour never the only cue, dialogs keyboard-usable.

## Tests

Pure logic first as a script test (`tests/pizza-*.test.ts`, chained into `"test"`): the replacement an edited sent line sends, for a plain pizza, a half and half, and a deal; an untouched line sends no recipe change.

Then `frontend/e2e/pizza-sent-orders.spec.ts` (Playwright, the `chromium` project; `loadSampleMenu` in `beforeAll` and `clearPizzaMenu` in `afterAll` from `frontend/e2e/helpers/pizza-menu.ts`; cancel or pay every order it places; never assert "no menu" against the server). Cases: (1) place a half and half with a removal and a deal, reopen the order in the POS: both show their lines under "Already ordered"; (2) the Orders page shows the same lines; (3) Edit the sent half and half in the POS, remove another ingredient, save: the lines change, and the order read back through the API holds the new recipe and the same price; (4) Edit the sent deal, change one pizza, save: same checks; (5) the Orders page's own edit window changes the quantity of a sent pizza and the recipe read back is unchanged; (6) "Add items" on the Orders page: a Half & Half and a deal show the message and add nothing, a drink is added; (7) with the catalogue request mocked away, a sent pizza line shows the warning words; (8) a cashier without the right to edit a sent line is refused as upstream refuses. Cover the Server App's list and its guard with one case if its spec helpers make that cheap; otherwise say it is untested.

Ports: `E2E_BASE_URL=http://127.0.0.1:3421 E2E_KDS_PORT=3422 E2E_SERVER_APP_PORT=3423`, throwaway `HOME`, `PLAYWRIGHT_BROWSERS_PATH=/Users/anmolnoor/.cache/pizza-pos/ms-playwright`, from `frontend/` after `npm run build` and `npm run build:frontend`. Finish with one run of your spec plus `e2e/pizza-pos.spec.ts`, `e2e/pizza-deal.spec.ts`, `e2e/pizza-quick-buttons.spec.ts`, `e2e/pizza-small-items.spec.ts`, pos-actions-menu, pos-keyboard-shortcuts, server-app-ordering, and any upstream spec with `orders` in its name.

Screenshots at 1180 × 820, outside the checkout: the POS with a reopened order showing sent pizza lines, and the Orders page's order view. Open them and fix what is clearly off.

## Verify before pushing

Every `test:pizza-*` script, `test:dev-tooling`, `test:translations`, every script with `pos`, `cart` or `order` in its name (each with a throwaway `HOME`), then:

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Do not run the full core suite; CI runs it. Update `docs/architecture/frontend.md` (present tense, no history).

## Report

Branch and commit; red-then-green; the Playwright result per case; which upstream rules govern editing a sent line and that none was loosened; what the Orders page and the Server App ended up doing; screenshot paths; every upstream file edited with line counts; new strings; anything not built or not verified.
