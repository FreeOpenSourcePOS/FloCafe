# Daily sales export (XLSX / CSV)

CURRENT contract for `GET /api/reports/daily-sales/export` — owner-only export of one tenant business day as a single XLSX workbook or a two-file CSV pair.

## Scope

- One business day at a time (no multi-day ranges).
- Formats: `xlsx` (Summary + Items sheets in one workbook) and `csv` (separate `summary` and `items` files; each request returns one part).
- Owner-only. No PII, no staff/Transactions/Addons sheets.

## Architecture

| Layer | File | Responsibility |
|-------|------|----------------|
| Dataset builder | `main/services/daily-sales-export.ts` | Single source of truth for all accounting: `buildDailySalesExportDataset`, `dailySalesSummaryMetricRows`, `DAILY_SALES_ITEM_COLUMNS`. |
| Serializers | `main/services/daily-sales-export-files.ts` | Encode only — no accounting math. `serializeDailySalesExportXlsx`, `serializeDailySalesExportCsv`, `dailySalesExportFilename`. |
| Shared CSV helper | `main/lib/csv.ts` | `toCsvRow` with CWE-1236 formula neutralization (leading quote on `= + - @` non-numerics). Also used by `main/routes/menu-csv.ts`. |
| Endpoint | `main/routes/reports.ts` | Validation, serialization, headers, error mapping (400 / 401 / 403 / 409 / 500). |
| Frontend | `frontend/src/app/(dashboard)/dashboard/page.tsx` | Blob download only; two buttons shown when `periodMode === 'day'`. |

Backend owns all logic; the frontend never computes totals.

## Accounting rules (approved contract)

- **Sale day:** keyed on `bills.paid_at`. Include cancelled-but-paid bills; exclude open/unpaid and pre-payment voided bills.
- **Refunds:** keyed on `refunds.created_at` (not attributed to the original pay day).
- **`net_collected = gross_collected - refunds_issued`.**
- **Counts:** both `order_count` (distinct orders) and `paid_bill_count`.
- **Payment methods:** `paymentMethodBreakdown(paidOnly, refunds-by-created_at, keyByPaidAt)` so `Σ payment totals = net_collected`. Only totals are exported (no per-method `count` — that count covers payment+refund lines, not payments). Summary keys use stable snake_case (`payment_visa_terminal_2` for `Visa Terminal 2`).
- **Items:** products on paid bills, split via `bill_items`; exclude `status IN ('cancelled','voided','void_adjustment')`; include `refunded` originals (they were collected; cash reversal lives only in `refunds_issued`). Group by `product_id` + snapshot `product_name` + `product_sku`. Add-ons fold into the parent item. Order-level discounts are Summary-only.
- **`discount_total`** = order-level (`bills.discount_amount`) + item-level discounts.
- **No** tips, no alternate refund attribution, no `net_ex_tax` metric.

### Reconciliation identities

| Identity | Expected |
|----------|----------|
| `Σ net_item_sales` | `= Σ bills.subtotal` (paid window) |
| `Σ gross_item_sales` | `= Σ net_item_sales + Σ item_discounts` |
| `Σ payment_<method>` | `= net_collected` |
| `Σ item tax_amount` | `≠ tax_total` — intentional (per-line tax vs aggregated components) |

## File formats

- **XLSX:** sheets `Summary` then `Items`. Money cells are numeric with `moneyNumFmt(fractionDigits)`; no formulas. Frozen header row.
- **CSV:** stable English snake_case headers; ASCII `.` decimals; formula-neutralized via shared `toCsvRow`.
- **Filenames:** `daily-sales-YYYY-MM-DD.xlsx`, `daily-sales-YYYY-MM-DD-summary.csv`, `daily-sales-YYYY-MM-DD-items.csv` (from `dailySalesExportFilename`).

### Summary metric field order

`business_date`, `timezone`, `business_day_start`, `currency`, `order_count`, `paid_bill_count`, `gross_collected`, `refunds_issued`, `net_collected`, `tax_total`, `discount_total`, `service_charge_total`, `packaging_charge_total`, `delivery_charge_total`, then one `payment_<method>` total per method (snake_case key via `dailySalesPaymentMetricKey`).

### Items columns

`product_id`, `product_name`, `product_sku`, `quantity`, `gross_item_sales`, `item_discounts`, `net_item_sales`, `tax_amount`.

## API

See [API.md § GET `/api/reports/daily-sales/export`](API.md#get-apireportsdaily-salesexport).

## Tests

- `tests/daily-sales-export.test.ts` (`npm run test:daily-sales-export`) — role gating, validation, XLSX sheet/metric assertions, CSV headers and filenames, formula neutralization, empty-day header-only Items.
- Script coverage gate: `test:daily-sales-export` is chained from `npm test`; `npm run test:script-coverage` fails if it is removed from the chain without adding it to `TEST_EXCLUSIONS`.
