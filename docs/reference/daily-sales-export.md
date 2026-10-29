# Daily sales export (XLSX / CSV / PDF-HTML)

Accounting, reconciliation, and file-format contract for
[`GET /api/reports/daily-sales/export`](api.md#get-apireportsdaily-salesexport).

## Scope

- Single tenant business day (`?date=YYYY-MM-DD`, defaults to the current business date) or inclusive business-date range (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, up to 93 calendar days per request).
- Formats: `xlsx` (`Summary` + `Daily` + `Taxes` + `Items` + `Payments` sheets in one workbook), `csv` (separate `summary`, `daily`, `taxes`, `items`, and `payments` files; each request returns one part), and `html` (print-styled HTML document used for desktop `save-html-as-pdf` and browser print; see [File formats](#file-formats)).
- Gated by `reports.daily-sales.export` (owner by default). No PII, no staff/Addons sheets.

## Architecture

| Layer             | File                                              | Responsibility                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dataset builder   | `main/services/daily-sales-export.ts`             | Single source of truth for all accounting and plain-text WhatsApp summary formatting: `buildDailySalesExportDataset`, `resolveDailySalesExportRange`, `formatDailySalesWhatsAppMessage`, `dailySalesSummaryMetricRows`, `DAILY_SALES_DAILY_COLUMNS`, `DAILY_SALES_TAX_COLUMNS`, `DAILY_SALES_ITEM_COLUMNS`, `DAILY_SALES_PAYMENT_COLUMNS`. |
| Serializers       | `main/services/daily-sales-export-files.ts`       | Encode only - no accounting math. `serializeDailySalesExportXlsx`, `serializeDailySalesExportCsv`, `serializeDailySalesExportHtml`, `dailySalesExportFilename`.                                                                                              |
| Shared CSV helper | `main/lib/csv.ts`                                 | `toCsvRow` with CWE-1236 formula neutralization (leading quote on `= + - @` non-numerics); `main/routes/menu-csv.ts` wraps it via `toQuoteV1CsvRow` (see [product invariants](product-invariants.md#catalog-csv-encoding-and-legacy-apostrophe-ambiguity)).  |
| Endpoint          | `main/routes/reports.ts`                          | Validation, serialization, headers, WhatsApp plain-text dispatch (`POST /api/reports/daily-sales/whatsapp`), and error mapping (400 / 401 / 403 / 409 / 429 / 500).                                                                                          |
| Frontend          | `frontend/src/app/(dashboard)/dashboard/page.tsx` | Blob download (`xlsx`/`csv`), PDF/print export (`frontend/src/lib/export-pdf.ts`), and recipient-modal WhatsApp send (`frontend/src/lib/whatsapp-share.ts`); single-day (`date`) or range (`from`/`to`) export buttons in the reports dashboard (CSV downloads all five parts). |

Backend owns all logic; the frontend never computes totals.

## Accounting rules (approved contract)

- **Range & cutoff:** Each business day in `[from, to]` is evaluated in the store's configured `timezone` using `business_day_start_time`. A range export over `N` days equals the exact sum of the `N` single-day exports across orders, daily summaries, payments, and taxes. Period profitability margins (`gross_margin_percent`, item `margin_percent`) and cost coverage (`cost_coverage_status`, item `cost_status`) are recomputed from summed underlying revenue and cost amounts rather than averaging daily percentages.
- **Sale day:** keyed on `bills.paid_at`. Include cancelled-but-paid bills; exclude open/unpaid and pre-payment voided bills.
- **Refunds:** keyed on `refunds.created_at` (not attributed to the original pay day).
- **`net_collected = gross_collected - refunds_issued`.**
- **Counts:** both `order_count` (distinct orders per day, summed across the range) and `paid_bill_count`.
- **Payment methods:** `paymentMethodBreakdown(paidOnly, refunds-by-created_at, keyByPaidAt)` so `Σ payment totals = net_collected`. Only totals are exported (no per-method `count` - that count covers payment+refund lines, not payments). Summary keys use stable snake_case (`payment_visa_terminal_2` for `Visa Terminal 2`).
- **Daily summaries (`Daily` sheet / `part=daily`):** one row per business day in `[from, to]` with the day's counts, collections, tax, discounts, charges, and profitability metrics.
- **Per-tax-rate summary (`Taxes` sheet / `part=taxes`):** one row per tax component and rate per business day where tax or taxable base is recorded, derived exclusively from historical snapshot and breakdown evidence stored on bills and order items (`order_items.tax_snapshot`, `order_items.tax_breakdown`, `order_items.tax_amount`, `bills.tax_snapshot`, `bills.tax_breakdown`, `bills.tax_amount`), never from current mutable product tax configuration.
  - Separate named tax components (for example `CGST` at `2.5%` and `SGST` at `2.5%`) remain distinct rows.
  - When multiple tax components share the same taxable base on an item or bill, those rows carry `shared_base = true` and `base_additive = false` so accountants do not double-count `taxable_base` or `gross_amount` when summing across components. Single-component tax rows carry `shared_base = false` and `base_additive = true`.
  - When historical records store a non-zero `tax_amount` without a complete rate or taxable-base breakdown, unknown `tax_rate` values as well as `taxable_base` and `gross_amount` are left blank (`null` in the dataset, `""` in XLSX/CSV), while the stored `tax_amount` is preserved in reconciliation (under the stored component name or `Unknown` when none was recorded) with `incomplete_detail = true` and an explicit `warning` message (also surfaced on `Summary` via `tax_detail_complete` and `tax_detail_warning`).
- **Items:** products on paid bills, split via `bill_items`; exclude `status IN ('cancelled','voided','void_adjustment')`; include `refunded` originals (they were collected; cash reversal lives only in `refunds_issued`). Group by `product_id` + snapshot `product_name` + `product_sku`. Add-ons fold into the parent item. Order-level discounts are Summary-only. Ingredient cost, profit, and margin use frozen `order_items.ingredient_cost` on lines with `ingredient_cost_known = 1` (allocated by `bi.quantity / oi.quantity` on split bills) against ex-tax net item sales of those known-cost lines (`known_cost_net_item_sales`); `cost_status` and `cost_coverage_status` are `known`, `partial`, or `unknown` (when `unknown`, cost, profit, and margin are `null`; see [product invariants](product-invariants.md#supplies-stock-and-recipe-depletion)).
- **Payments:** one row per `bills.payment_details` ledger line of every bill paid in the window, including lines recorded on an earlier day for a bill settled in this one. `payment_time` is the line's timestamp in the store timezone (`YYYY-MM-DD HH:MM:SS`); `method` resolves custom methods to their current name; `transaction_id` is the stored external reference verbatim (empty when none), so card lines can be matched against the card terminal's batch report. Refunds are not rows here.
- **`discount_total`** = order-level (`bills.discount_amount`) + item-level discounts.
- **No** tips, no alternate refund attribution, no `net_ex_tax` metric.

### Reconciliation identities

| Identity             | Expected                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `Σ net_item_sales`   | `= Σ bills.subtotal` (paid window)                                    |
| `Σ gross_item_sales` | `= Σ net_item_sales + Σ item_discounts`                               |
| `Σ payment_<method>` | `= net_collected`                                                     |
| `Σ Payments.amount`  | `= gross_collected`                                                   |
| `Σ Taxes.tax_amount` | `= Summary.tax_total = Σ Daily.tax_total`                             |
| `Σ item tax_amount`  | `≠ tax_total` - intentional (per-line tax vs bill-level tax snapshot) |

## File formats

- **XLSX:** sheets `Summary`, `Daily`, `Taxes`, `Items`, then `Payments`. Money cells are numeric with `moneyNumFmt(fractionDigits)`, percentage cells (`*_percent`) use `'0.00'`, and `tax_rate` cells use `'0.##'`; `null` rate, base, gross, cost, profit, and margin values are empty string `""`; no formulas. Frozen header row.
- **CSV:** stable English snake_case headers; ASCII `.` decimals; formula-neutralized via shared `toCsvRow`.
- **HTML (PDF / Print):** self-contained A4 landscape HTML5 document (`serializeDailySalesExportHtml`) containing the store header, optional `tax_detail_warning` alert banner, Summary metrics, Payment Methods summary, Daily Breakdown, Tax Summary, and Item Sales tables from the same dataset (returning `400` if the rendered HTML exceeds the 15 MB PDF export limit).
- **WhatsApp plain text (`POST /api/reports/daily-sales/whatsapp`):** localized plain-text summary (`formatDailySalesWhatsAppMessage`, gated by `reports.view`, `reports.daily-sales.export`, and `whatsapp.use`) using the store `language`, regional number/currency formatting (`resolveRegionalSnapshot`), store `timezone`, and `business_day_start_time` across up to 93 business dates. Includes the period, order and paid-bill counts, gross/refunded/net collections, tax, discount, service/packaging/delivery charges, payment mix, and top five items by `net_item_sales`. No PDF or file attachments are sent; if the text would exceed the 4096-character WhatsApp transport limit, top-item detail is progressively shortened and omitted before financial totals are ever dropped.
- **Filenames:** `daily-sales-YYYY-MM-DD.xlsx` / `.html` (single day) or `daily-sales-YYYY-MM-DD_to_YYYY-MM-DD.xlsx` / `.html` (multi-day range), and `-summary.csv`, `-daily.csv`, `-taxes.csv`, `-items.csv`, `-payments.csv` (from `dailySalesExportFilename`).

### Summary metric field order

`business_date` (`YYYY-MM-DD` for single-day exports or `YYYY-MM-DD..YYYY-MM-DD` for multi-day ranges), `from_date`, `to_date`, `day_count`, `timezone`, `business_day_start`, `currency`, `order_count`, `paid_bill_count`, `gross_collected`, `refunds_issued`, `net_collected`, `tax_total`, `discount_total`, `service_charge_total`, `packaging_charge_total`, `delivery_charge_total`, `known_cost_net_item_sales`, `ingredient_cost_total`, `gross_profit_total`, `gross_margin_percent`, `cost_coverage_status`, `tax_detail_complete`, `tax_detail_warning`, then one `payment_<method>` total per method (snake_case key via `dailySalesPaymentMetricKey`).

### Daily columns

`business_date`, `order_count`, `paid_bill_count`, `gross_collected`, `refunds_issued`, `net_collected`, `tax_total`, `discount_total`, `service_charge_total`, `packaging_charge_total`, `delivery_charge_total`, `known_cost_net_item_sales`, `ingredient_cost_total`, `gross_profit_total`, `gross_margin_percent`, `cost_coverage_status`.

### Taxes columns

`business_date`, `tax_name`, `tax_rate`, `taxable_base`, `tax_amount`, `gross_amount`, `shared_base`, `base_additive`, `incomplete_detail`, `warning`.

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

- `tests/daily-sales-export.test.ts` (`npm run test:daily-sales-export`) - role gating, single-day and date-range validation (93-day cap, reversed/mixed/incomplete/invalid dates), range equivalence (`N`-day range equals sum of `N` single-day exports), business-day cutoff across multi-day ranges, XLSX sheet/metric assertions (`Summary`, `Daily`, `Taxes`, `Items`, `Payments`), per-tax-rate summary reconciliation, shared-base multi-component taxes, historical snapshot immunity to product tax changes, incomplete historical detail warnings, Payments rows (store-local time, verbatim transaction id), CSV headers and filenames, `format=html` parity with XLSX (single-day and range, non-Latin store names, HTML escaping, and large-dataset rendering without row truncation), formula neutralization, and empty-day header-only sheets.
- `tests/reports-export.test.ts` (`npm run test:reports-export`) - X and Z report `csv`, `xlsx`, and `html`/PDF export parity, locale currency formatting, non-Latin store names, HTML escaping, and native Electron `printToPDF` rendering and staging cleanup.
- Script coverage gate: `test:daily-sales-export` is chained from `npm test`; `npm run test:script-coverage` fails if it is removed from the chain without adding it to `TEST_EXCLUSIONS`.
- `tests/customer-sales-export.test.ts` (`npm run test:customer-sales-export`) - customer sales export: role gating, range validation, repeated customer columns, first-row `bill_total`, split bills, CSV neutralization, XLSX.
