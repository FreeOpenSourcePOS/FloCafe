# Daily sales export (XLSX / CSV)

Contract for `GET /api/reports/daily-sales/export`: an owner-only export of one tenant business
day as a single XLSX workbook or a three-file CSV set.

## Scope

- One business day at a time (no multi-day ranges).
- Formats: `xlsx` (Summary + Items + Payments sheets in one workbook) and `csv` (separate `summary`, `items`, and `payments` files; each request returns one part).
- Owner-only. No PII, no staff/Addons sheets.

## Architecture

| Layer             | File                                              | Responsibility                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset builder   | `main/services/daily-sales-export.ts`             | Single source of truth for all accounting: `buildDailySalesExportDataset`, `dailySalesSummaryMetricRows`, `DAILY_SALES_ITEM_COLUMNS`, `DAILY_SALES_PAYMENT_COLUMNS`.                                                                                        |
| Serializers       | `main/services/daily-sales-export-files.ts`       | Encode only - no accounting math. `serializeDailySalesExportXlsx`, `serializeDailySalesExportCsv`, `dailySalesExportFilename`.                                                                                                                              |
| Shared CSV helper | `main/lib/csv.ts`                                 | `toCsvRow` with CWE-1236 formula neutralization (leading quote on `= + - @` non-numerics); `main/routes/menu-csv.ts` wraps it via `toQuoteV1CsvRow` (see [product invariants](product-invariants.md#catalog-csv-encoding-and-legacy-apostrophe-ambiguity)). |
| Endpoint          | `main/routes/reports.ts`                          | Validation, serialization, headers, error mapping (400 / 401 / 403 / 409 / 500).                                                                                                                                                                            |
| Frontend          | `frontend/src/app/(dashboard)/dashboard/page.tsx` | Blob download only; two buttons shown when `periodMode === 'day'` (CSV downloads all three parts).                                                                                                                                                          |

Backend owns all logic; the frontend never computes totals.

## Accounting rules (approved contract)

- **Sale day:** keyed on `bills.paid_at`. Include cancelled-but-paid bills; exclude open/unpaid and pre-payment voided bills.
- **Refunds:** keyed on `refunds.created_at` (not attributed to the original pay day).
- **`net_collected = gross_collected - refunds_issued`.**
- **Counts:** both `order_count` (distinct orders) and `paid_bill_count`.
- **Payment methods:** `paymentMethodBreakdown(paidOnly, refunds-by-created_at, keyByPaidAt)` so `Σ payment totals = net_collected`. Only totals are exported (no per-method `count` - that count covers payment+refund lines, not payments). Summary keys use stable snake_case (`payment_visa_terminal_2` for `Visa Terminal 2`).
- **Items:** products on paid bills, split via `bill_items`; exclude `status IN ('cancelled','voided','void_adjustment')`; include `refunded` originals (they were collected; cash reversal lives only in `refunds_issued`). Group by `product_id` + snapshot `product_name` + `product_sku`. Add-ons fold into the parent item. Order-level discounts are Summary-only. Ingredient cost, profit, and margin use frozen `order_items.ingredient_cost` on lines with `ingredient_cost_known = 1` (allocated by `bi.quantity / oi.quantity` on split bills) against ex-tax net item sales of those known-cost lines (`known_cost_net_item_sales`); `cost_status` and `cost_coverage_status` are `known`, `partial`, or `unknown` (when `unknown`, cost, profit, and margin are `null`; see [product invariants](product-invariants.md#supplies-stock-and-recipe-depletion)).
- **Payments:** one row per `bills.payment_details` ledger line of every bill paid in the window, including lines recorded on an earlier day for a bill settled in this one. `payment_time` is the line's timestamp in the store timezone (`YYYY-MM-DD HH:MM:SS`); `method` resolves custom methods to their current name; `transaction_id` is the stored external reference verbatim (empty when none), so card lines can be matched against the card terminal's batch report. Refunds are not rows here.
- **`discount_total`** = order-level (`bills.discount_amount`) + item-level discounts.
- **No** tips, no alternate refund attribution, no `net_ex_tax` metric.

### Reconciliation identities

| Identity             | Expected                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `Σ net_item_sales`   | `= Σ bills.subtotal` (paid window)                                  |
| `Σ gross_item_sales` | `= Σ net_item_sales + Σ item_discounts`                             |
| `Σ payment_<method>` | `= net_collected`                                                   |
| `Σ Payments.amount`  | `= gross_collected`                                                 |
| `Σ item tax_amount`  | `≠ tax_total` - intentional (per-line tax vs aggregated components) |

## File formats

- **XLSX:** sheets `Summary`, `Items`, then `Payments`. Money cells are numeric with `moneyNumFmt(fractionDigits)` and percentage cells (`*_percent`) use `'0.00'`; `null` cost, profit, and margin values are empty string `""`; no formulas. Frozen header row.
- **CSV:** stable English snake_case headers; ASCII `.` decimals; formula-neutralized via shared `toCsvRow`.
- **Filenames:** `daily-sales-YYYY-MM-DD.xlsx`, `daily-sales-YYYY-MM-DD-summary.csv`, `daily-sales-YYYY-MM-DD-items.csv`, `daily-sales-YYYY-MM-DD-payments.csv` (from `dailySalesExportFilename`).

### Summary metric field order

`business_date`, `timezone`, `business_day_start`, `currency`, `order_count`, `paid_bill_count`, `gross_collected`, `refunds_issued`, `net_collected`, `tax_total`, `discount_total`, `service_charge_total`, `packaging_charge_total`, `delivery_charge_total`, `known_cost_net_item_sales`, `ingredient_cost_total`, `gross_profit_total`, `gross_margin_percent`, `cost_coverage_status`, then one `payment_<method>` total per method (snake_case key via `dailySalesPaymentMetricKey`).

### Items columns

`product_id`, `product_name`, `product_sku`, `quantity`, `gross_item_sales`, `item_discounts`, `net_item_sales`, `tax_amount`, `ingredient_cost`, `profit`, `margin_percent`, `cost_status`.

### Payments columns

`bill_number`, `order_number`, `payment_time`, `method`, `amount`, `transaction_id`.

## API

See [API.md § GET `/api/reports/daily-sales/export`](api.md#get-apireportsdaily-salesexport).

## Customer sales export

`GET /api/reports/customer-sales/export` is a separate owner-only export (`reports.customer-sales.export`, default role owner) of one row per item sold on bills paid in a business-date range, with the bill's customer repeated on every row. It carries customer PII, which is why it has its own permission and is not part of the daily sales workbook.

- **Range:** `start_date` (defaults to the current business date) to `end_date` (defaults to `start_date`), inclusive, at most 366 days. A reversed or oversized range returns `400`.
- **Formats:** `xlsx` (one `Customer sales` sheet) or `csv` (one file). Filename `customer-sales-<date>.<ext>` or `customer-sales-<start>_to_<end>.<ext>`.
- **Item rules:** the same inclusion and split-bill apportioning as the Items query; cancelled, voided and void-adjustment lines are excluded.
- **Columns:** `business_date`, `paid_at`, `bill_number`, `order_number`, `order_type`, `customer_name`, `customer_country_code`, `customer_phone`, `customer_email`, `product_name`, `product_sku`, `quantity`, `gross_item_sales`, `item_discounts`, `net_item_sales`, `tax_amount`, `payment_methods`, `bill_total`.
- **`bill_total`** is set on the first item row of each bill only, so summing the column equals the sum of bill totals. Walk-in bills have blank customer columns. Refunds are not reflected.
- **Code:** `main/services/customer-sales-export.ts` builds and serializes; `main/routes/reports.ts` validates and sets headers.

## Tests

- `tests/daily-sales-export.test.ts` (`npm run test:daily-sales-export`) - role gating, validation, XLSX sheet/metric assertions, Payments rows (store-local time, verbatim transaction id), CSV headers and filenames, formula neutralization, empty-day header-only Items and Payments.
- Script coverage gate: `test:daily-sales-export` is chained from `npm test`; `npm run test:script-coverage` fails if it is removed from the chain without adding it to `TEST_EXCLUSIONS`.
- `tests/customer-sales-export.test.ts` (`npm run test:customer-sales-export`) - customer sales export: role gating, range validation, repeated customer columns, first-row `bill_total`, split bills, CSV neutralization, XLSX.
