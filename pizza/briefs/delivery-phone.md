# Brief: a phone number box on a delivery order

Read [../README.md](../README.md), how the POS takes a delivery order today (`frontend/src/components/pos/CartPanel.tsx` around the order type switch and the delivery address, and the POS page's order paths), how a customer is found or created by phone (`frontend/src/components/pos/CustomerSearch.tsx` and the customers routes), and how the delivery slip gets its contact (`main/printers/document-delivery-slip.ts`, `frontend/src/lib/printer/delivery-slip-*.ts`).

## Problem

The owner, in their words: "I want to get a text input for the phone number while I take a delivery order, because I need that for my delivery slip." Today the POS lets a delivery order be placed with an address and no customer at all. The delivery slip already prints the customer's phone number, but with no customer there is no number to print. The only way to give one is the "Search by phone or name" box at the top of the screen, which nobody connects with a delivery.

## Outcome

With the pizza setup (and only then; any other store is unchanged):

1. **When the order type is Delivery, the delivery details show a "Phone number" box beside the address**, labelled, with the store's country code handled the way the customer search already handles it (the owner types a local number).
2. **Typing a number does what the customer search does.** If a customer has that number, they are attached to the order and their name shows (and their saved address is offered as the address, if the address box is empty). If no customer has it, the order is placed with a new customer made from that number (and the name, if the cashier typed one in an optional "Name" box next to it). Use the existing find-by-phone and create-customer code paths; do not write a second customer store. If the order already has a customer (picked from the top search), the box shows their number and changing it changes the customer.
3. **A delivery order cannot be placed without a phone number.** The Place Order button stays usable, but pressing it with the box empty or holding something that is not a phone number puts the focus in the box with the message "Add the customer's phone number for a delivery." Nothing is sent.
4. **The number prints.** The delivery slip (every renderer) and the kitchen ticket of a delivery order carry it, as they already do for an order with a customer; prove it with the print data of an order taken this way.
5. Takeaway orders are unchanged: no phone box, no requirement.

Controls at least 48 px, labelled, keyboard-usable; the phone box uses a telephone keypad on a touch screen (`inputMode="tel"`). Text in `messages-pizza/en.json`.

## How

New code in new files under `frontend/src/components/pos/pizza/` and `frontend/src/lib/pizza/`; the smallest hooks in `CartPanel.tsx` and the POS page. How the requirement is decided: the pizza setup (`setup_profile` is `pizza`, or the same signal the order type switch uses for `pos_order_types`); say in the report where that lives. Nothing in `main/` changes unless a route cannot do what is needed (then stop and report).

## Tests

Script (chained into `"test"`): the pure rule (when a number is required, what counts as a number, the request the POS sends for a new and for an existing customer). Playwright `frontend/e2e/pizza-delivery-phone.spec.ts` (chromium; set the pizza settings through the settings API in `beforeAll` and restore them in `afterAll`, as `e2e/pizza-counter.spec.ts` does; made-up 555 numbers; remove or deactivate what it creates): the box shows for Delivery and not for Takeaway; Place Order with no number is stopped with the message and the focus in the box; a new number places the order with a new customer and the order read back through the API has that customer and phone; a known number attaches that customer and offers their address; the delivery slip's print data for that order carries the number; keyboard only.

Ports: `E2E_BASE_URL=http://127.0.0.1:3411 E2E_KDS_PORT=3412 E2E_SERVER_APP_PORT=3413`, throwaway `HOME`, `PLAYWRIGHT_BROWSERS_PATH=/Users/anmolnoor/.cache/pizza-pos/ms-playwright`, from `frontend/` after both builds.

## Verify before pushing

Every `test:pizza-*`; any script with customer, delivery, pos or cart in its name; `test:dev-tooling`; `npm run i18n:check`, `npm run test:script-coverage`, both `tsc --noEmit`, `npm run lint`, `npm run lint:budget`, the changed-format check against your base, `npm run docs:check`; one Playwright run of every `e2e/pizza-*.spec.ts` plus pos-actions-menu, pos-keyboard-shortcuts and server-app-ordering with `--retries=0`. Do not run the full core suite. A screenshot of the delivery details with the phone box at 1180 x 820, opened and checked. Update `docs/architecture/frontend.md` and `pizza/decisions.md` (D8).

## Report

Branch and commit; red then green; the Playwright result per case; the screenshot path; where the "pizza setup" decision lives; every upstream file edited with line counts; new strings; anything not built or not verified.
