# Brief: a screen where the owner changes prices

Read [../README.md](../README.md), [../contract.md](../contract.md) (the menu file, how it maps onto the catalogue, ownership and the switch-off rule), decision D4 in [../decisions.md](../decisions.md), `main/pizza/menu-import.ts` and the menu screen (`frontend/src/app/(dashboard)/pizza-menu/page.tsx`).

The owner wants to change any price at any time from the POS, without editing a file: the three pizza sizes, the topping price, a dip, each side, each drink size, each deal.

## Problem

The menu file is the master copy: a load overwrites names and prices. A price the owner changes in FloCafe's product screen is silently lost at the next load, and the pizza sizes and the topping price are spread over many rows (one variant per pizza per size).

## Outcome

1. **Prices set in the POS are kept apart from the file and win over it.** A stored list of price overrides, keyed by what the owner thinks of as one price (`size:<id>`, `topping`, `dip`, `side:<id>`, `drink:<id>:<variant>`, `deal:<id>`), in the fork's own table or column (a pizza migration). The menu load applies them on top of the file every time, so a reload never loses them, and the stored catalogue the browser and the ticket code read carries the price in force. An override for something the file no longer has is kept but unused, and is listed as such.
2. **A "Prices" section on the Pizza menu screen**, for a user with `catalog.manage`: one row per price with the file's price, the price in force and an input; Save applies every changed price in one step through the same code path as a menu load (so every pizza's size variant, the topping add-ons including the half price, and so on change together, in one transaction); "Use the menu's price" removes an override. It shows what will change before saving (for example "Large: 22.00 to 23.00, on 26 pizzas"). Amounts are validated as money in the store's currency.
3. **Nothing sold changes.** Placed orders keep their prices. Open carts on any till pick the new prices up the way they pick up a menu reload (see how the catalogue refresh works on this branch) and the server charges the price in force when the order is placed.
4. **Routes**: read the price list, and save changes, under `/api/pizza`, with `catalog.manage` to write and `catalog.view` to read, documented in `docs/reference/api.md` and the contract.
5. The menu screen's "what loading does" text says that prices set in the POS are kept.

## Not in this change

Renaming items, adding or removing items, tax rates, prices by day or time, prices per order type.

## Tests

Script: overrides applied on load and kept across a reload with a different file price; removing an override returns the file's price; the topping override changes both topping add-ons; a size override changes every pizza's and the half-and-half's variant and nothing else; an override for a removed item is kept and unused; a bad amount is refused and nothing is written; a placed order's price is unchanged; permissions. Playwright (chromium, `loadSampleMenu` / `clearPizzaMenu`, and remove the overrides in `afterAll`): change the Large price, see the preview, save, the POS tile shows it without signing out, an order charges it; "Use the menu's price" puts it back; a cashier does not see the section.

## Report

Branch and commit; red then green; where overrides are stored and the migration; the Playwright result per case; a screenshot of the section at 1180 x 820, opened and checked; every upstream file edited with line counts; new strings; anything not built.
