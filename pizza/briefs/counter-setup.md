# Brief: a pizza counter out of the box

Read [../README.md](../README.md), [../decisions.md](../decisions.md) (D8, the `pizza` setup profile; D5, the ticket header), [../contract.md](../contract.md), `main/pizza/setup-profile.ts`, `shared/print/kot-contact.ts` and `main/pizza/menu-import.ts` with their tests.

The owner has decided each point below. Each gets a test that fails first.

## Outcomes

1. **Pickup time.** A phone order has a time the customer will come.
   - The `pizza` setup profile turns scheduled orders on (`scheduled_orders_enabled`), so the POS offers upstream's own "ready at" control. Find how upstream schedules an order and when it releases it to the kitchen, and use that unchanged.
   - The kitchen ticket prints the time. A scheduled order's ticket header carries one line, `PICKUP <time>` for a pickup order and `DELIVERY <time>` for a delivery order (the shop's time zone and clock format, as upstream formats times on tickets), on every renderer: the server paths and the browser ESC/POS, raster and HTML paths. Put it through `kotContactLines` or beside it so all of them get it. An order that is not scheduled prints no such line, and with the setting off tickets are byte-for-byte as before (pin with the existing golden hashes).
   - The kitchen display shows the same line on the order card if the card has a natural place for it and the data is already in its payload; if that needs new plumbing, leave it and say so.
2. **Customer contact on delivery tickets only.** Today the profile sets `kot_show_customer_contact` so name, phone and address print on every ticket. Keep the setting's meaning for upstream users, and make the pizza profile's default print the phone number and address only on delivery orders; a pickup order's ticket carries the customer's name only. If that needs a second value for the setting (for example `delivery`), add it, keep `true` and `false` working, and document it in `docs/` where the setting is described.
3. **Counter order types.** A pizza counter takes pickup and delivery. With the `pizza` profile, the POS's order type switch shows only Takeaway and Delivery, and Takeaway is the default. Use upstream's own settings if they exist (look for enabled order types, `tables_required`, online ordering); only if none can hide a type, add the smallest setting that does. An order that already has a hidden type still opens and can be paid.
4. **Sidebar.** With the `pizza` profile the sidebar shows what a pizza counter uses: POS, Orders, Customers, Pizza menu, Products, Staff, Settings, and Dashboard or reports as upstream names them. WhatsApp, Inventory, Expenses and KDS are hidden when their feature is off in settings; use upstream's own switches for them where they exist and report any that has none (do not invent a setting for those; just list them).
5. **A menu load never takes over a row it does not own.** Today a load overwrites, and may later switch off, any product or category whose id equals one the menu derives, even if no earlier load created it (for example a product made by hand or by a CSV import). Refuse the load with a `MenuImportError` that names the row ("A product with the id pz-garden already exists and was not made by a menu load. Rename or remove it, then load the menu again."), writing nothing. A row an earlier load owned is still updated, and is switched back on if someone switched it off or deleted it by hand: the file is the master (pin that with a test and say so in the contract).
6. **Two follow-ups from the last review.**
   - `tests/pizza-ticket.test.ts`: the wrapping case was rewritten to set `ingredients` after parsing because a 159-character description broke a 120-character cap; the cap is 240 now, so restore the original form of that case (the description parsed through `ingredientsOf`) and remove the comment that says it is too long.
   - `frontend/src/components/pos/pizza/QuickButtons.tsx` (~586): the list is fetched with the cart's customer whatever the user's rights are, so a user without `orders.create` gets a 403 and never sees the shop's buttons. Fetch with the customer only when the user may see a customer's buttons (`rights.customers`, or what the hook calls it).

## Not in this change

Showing or editing sent pizzas, the pizza screens' layout, receipts and slips printed from the browser, reports.

## How

Server and shared code first, with script tests (`tests/pizza-*.test.ts`, chained into `"test"`). Existing stores that already ran the profile are not changed by an upgrade; the new defaults apply when the profile is applied (say in the report what an existing store has to switch by hand). One-line hooks in upstream files; with a non-pizza profile nothing changes.

Browser proof in `frontend/e2e/pizza-counter.spec.ts` (Playwright `chromium`): the e2e store is not a pizza-profile store, so set the settings the profile writes through the settings API in `beforeAll` and restore them in `afterAll` (other specs share the database and expect upstream's defaults). Cases: the order type switch shows only Takeaway and Delivery; the sidebar entries; a scheduled pickup order placed from the POS shows its time where upstream shows it. Ports `E2E_BASE_URL=http://127.0.0.1:3411 E2E_KDS_PORT=3412 E2E_SERVER_APP_PORT=3413`, throwaway `HOME`, `PLAYWRIGHT_BROWSERS_PATH=/Users/anmolnoor/.cache/pizza-pos/ms-playwright`, from `frontend/` after both builds; file filters as paths (`e2e/pizza-counter.spec.ts`). Finish with one run of your spec plus `e2e/pizza-pos.spec.ts`, `e2e/pizza-quick-buttons.spec.ts`, pos-actions-menu, pos-keyboard-shortcuts, server-app-ordering and any upstream spec with `scheduled` in its name.

## Verify before pushing

Every `test:pizza-*` script, `test:dev-tooling`, `test:translations`, every script with `print`, `kot`, `escpos`, `setup`, `scheduled` or `sidebar` in its name (each with a throwaway `HOME`), then:

```sh
npm run i18n:check
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
```

Do not run the full core suite; CI runs it. Update `pizza/decisions.md` (D5, D8), `pizza/contract.md`, `pizza/headless.md` if a first-run step changes, and the `docs/` pages for any setting touched (present tense, no history).

## Report

Branch and commit; red-then-green per outcome; which upstream settings you used and which you had to add; what an existing pizza store must switch by hand; the Playwright result per case; every upstream file edited with line counts; anything not built or not verified.
