# Brief: detail lines and customer contact on kitchen tickets

Implements the print-layer half of decision D5 in [../decisions.md](../decisions.md). Read that entry and [../README.md](../README.md) first. The spike branch `spike/pizza-ui` (commit `09a9e922`) shows a working minimal version for two of the paths; read it, do not merge it.

## Problem

A pizza must print with lines such as:

```text
1x LARGE (14") - THIN CRUST
   HALF: PEPPERONI / HALF: HAWAIIAN
   WHOLE: + Extra Cheese, Well Done
   LEFT:  + Mushrooms
   RIGHT: NO PINEAPPLE, + Jalapenos
```

Today an order item can print only a heading, add-on lines and a note. Add-on lines are truncated, and the wrap helper collapses runs of spaces. Also, the kitchen ticket header prints no phone number and no delivery address, which a pizza shop's make line needs for delivery orders.

## Outcome

**Part A: detail lines.** An order item can carry an optional list of ready-formatted text lines, `detailLines`, and every ticket and receipt path prints them under the item heading, before add-ons.

- A line that fits the available width prints exactly as given, including runs of spaces. A line that does not fit is wrapped with the existing kernel helper; nothing is dropped or truncated.
- An item without `detailLines` prints byte for byte as it does today.
- Paths to cover: server ESC/POS kitchen ticket (`main/printers/document-kot.ts`), browser ESC/POS kitchen ticket (`frontend/src/lib/printer/kot-encoder.ts`), the raster kitchen ticket document (`frontend/src/lib/printer/print-document.ts`, `buildFrontendKotDocument`), the browser HTML kitchen ticket (`frontend/src/lib/printer/kot-web-print.ts`), and the classic and compact customer receipts on the server and in the browser (`main/printers/document-classic.ts`, `document-compact.ts`, `frontend/src/lib/printer/receipt-encoder.ts`).
- This change does not produce the lines. The functions that build print data accept `detailLines` on the item they are given and pass it through. A later change fills it from the pizza recipe.

**Part B: customer contact on the kitchen ticket.** A new setting, `kot_show_customer_contact`, default off. When on, the kitchen ticket header also prints the customer's phone number when the order has one, and the delivery address and delivery note when the order type is delivery. With the setting off, tickets are unchanged.

- Reuse existing print labels (the delivery slip already prints phone and address). Do not add keys to the 32 language files.
- Cover the same four kitchen ticket paths.

## Where to look

| What | Location |
| :--- | :--- |
| Kitchen ticket model and builder | `shared/print/document.ts`: `KotItemSnapshot` `864-869`, `buildKotDocument` `1610`, validator `1536` |
| Bill item model | `shared/print/document.ts`: `OrderItemSnapshot` `103-110`, `ItemTableRow` `313-323`, `buildBillDocument` `582` |
| Delivery slip (labels, phone, address) | `shared/print/document.ts:955-1040`, `1816` |
| Server kitchen ticket | `main/printers/document-kot.ts`: `buildKotPrintData` `45`, `kotItemLines` `436` |
| Wrap helper | `shared/print/width.ts:236` (`wrapToDisplayCells`) |
| Settings allow-list | `main/routes/settings.ts` (`ALLOWED_WILDCARD_KEYS`, near `2011`) |
| Architecture page | `docs/architecture/printing.md` |

## Tests to write first

New files, each with its own `test:pizza-*` script chained into `"test"` in `package.json`. Use the `assert*OrThrow` helpers. Each case must fail before your change and pass after.

`tests/pizza-print-detail-lines.test.ts`
1. The five lines above, on one item, come out in order and unchanged (including the two spaces after `LEFT:`) from the server ESC/POS path and the browser ESC/POS path at 42 and at 48 columns. Decode real bytes, as the spike test does with `measureEscPos`.
2. The raster kitchen ticket document and the browser HTML ticket contain the same lines.
3. A 95-character line wraps without losing text, the same way on the server and browser paths.
4. Classic and compact receipts, server and browser, print the lines under the item.
5. An item without `detailLines`: output is identical to the output before the change, on every path.

`tests/pizza-kot-customer-contact.test.ts`
1. Setting off: a delivery order's ticket has no phone and no address.
2. Setting on, delivery order: phone, address and delivery note appear in the header on all four paths.
3. Setting on, pickup order with a phone: phone only.
4. Setting on, order with no customer: nothing added, no empty label lines.

Upstream's print tests must pass untouched: `npm run test:print-kernel`, `test:receipt-column-oracle`, `test:print-parity`, `test:kot-order-notes`, `test:variant-pos-surface`. The golden file must not change.

## Constraints

- Smallest diff to upstream files; put new helpers in new files where that is natural.
- `shared/` stays pure (the `kernel-purity` test).
- Update `docs/architecture/printing.md` and the settings reference in `docs/` in the same change. Upstream's docs rules apply there: describe the present, no history, no plans.
- Do not touch anything under `pizza/` except this brief.
- The kitchen display views and the other receipt templates (detailed, tax bill, compliance, delivery slip, payment ticket) are not part of this change.

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-print-detail-lines
HOME=$(mktemp -d) npm run test:pizza-kot-customer-contact
HOME=$(mktemp -d) npm run test:print-kernel && HOME=$(mktemp -d) npm run test:receipt-column-oracle && HOME=$(mktemp -d) npm run test:print-parity
npm run test:script-coverage
npx tsc --noEmit && npx tsc --noEmit -p frontend/tsconfig.json && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <report folder outside the checkout>
```

The last command is the full core suite under the machine lock. Run it once at the end; another agent may hold the lock, in which case it waits. Do not run Playwright or `scripts/pizza/local-ci.sh`.

## Report

Branch and commit, the red-then-green output of the new tests, the full-suite totals, every upstream file you edited with the line count, and any path you could not cover and why.
