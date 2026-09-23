import type { Database } from 'better-sqlite3';
import {
  dayBoundsInTimezone,
  getDatabase,
  getSettingValue,
  tenantBusinessDayStartTime,
} from '../db';
import { getCurrencyMinorUnitFactor, resolveRegionalSnapshot } from '../countries';
import { getTenantCurrency } from './refund';
import { aggregateTaxComponents } from './tax-components';
import { getOrdersWithItemsForBills } from '../routes/bills';
import { paymentMethodBreakdown } from '../routes/cash-closures';

export type DailySalesExportItemRow = {
  product_id: string;
  product_name: string;
  product_sku: string | null;
  quantity: number;
  gross_item_sales: number;
  item_discounts: number;
  net_item_sales: number;
  tax_amount: number;
};

export type DailySalesExportPaymentRow = {
  method: string;
  total: number;
};

export type DailySalesExportSummary = {
  business_date: string;
  timezone: string;
  business_day_start: string;
  currency: string;
  order_count: number;
  paid_bill_count: number;
  gross_collected: number;
  refunds_issued: number;
  net_collected: number;
  tax_total: number;
  discount_total: number;
  service_charge_total: number;
  packaging_charge_total: number;
  delivery_charge_total: number;
  payment_methods: DailySalesExportPaymentRow[];
};

export type DailySalesExportDataset = {
  summary: DailySalesExportSummary;
  items: DailySalesExportItemRow[];
};

function resolveExportTimezone(): string {
  return resolveRegionalSnapshot({
    country: getSettingValue('country') ?? undefined,
    currency: getSettingValue('currency') ?? undefined,
    timezone: getSettingValue('timezone') ?? undefined,
  }).timezone;
}

/** Stable snake_case Summary key for a payment method (custom names may contain spaces). */
export function dailySalesPaymentMetricKey(method: string): string {
  const key = String(method)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'unknown';
}

/**
 * One normalized daily-sales export dataset for a tenant business date.
 *
 * Summary cash rules (approved contract):
 * - gross_collected / counts / charges / order-level discount: bills paid in window (`paid_at`)
 * - refunds_issued: refunds issued in window (`created_at`) — NOT attributed to the original pay day
 * - payment_method rows use paymentMethodBreakdown(paidOnly, refunds-by-created_at, keyByPaidAt)
 *   so Σ payment totals = net_collected
 *
 * Items: products on paid bills (split via bill_items), excluding void/cancel/adjustment
 * rows so item refunds do not double-count against refunds_issued. Refunded originals stay
 * (they were collected); cash reversal lives only in Summary.refunds_issued.
 */
export function buildDailySalesExportDataset(
  businessDate: string,
  db: Database = getDatabase(),
): DailySalesExportDataset {
  const timezone = resolveExportTimezone();
  const businessDayStart = tenantBusinessDayStartTime(db);
  const [start, end] = dayBoundsInTimezone(businessDate, timezone, businessDayStart);
  const currency = getTenantCurrency(db);
  const minorFactor = getCurrencyMinorUnitFactor(currency);

  const billRow = db.prepare(`
    SELECT
      COUNT(*) AS paid_bill_count,
      COUNT(DISTINCT order_id) AS order_count,
      COALESCE(SUM(paid_amount), 0) AS gross_collected,
      COALESCE(SUM(discount_amount), 0) AS order_discount_total,
      COALESCE(SUM(service_charge), 0) AS service_charge_total,
      COALESCE(SUM(packaging_charge), 0) AS packaging_charge_total,
      COALESCE(SUM(delivery_charge), 0) AS delivery_charge_total
    FROM bills
    WHERE paid_at >= ? AND paid_at < ?
  `).get(start, end) as {
    paid_bill_count: number;
    order_count: number;
    gross_collected: number;
    order_discount_total: number;
    service_charge_total: number;
    packaging_charge_total: number;
    delivery_charge_total: number;
  };

  const refundRow = db.prepare(`
    SELECT COALESCE(SUM(CAST(amount_cents AS REAL)) / ?, 0) AS refunds_issued
    FROM refunds
    WHERE created_at >= ? AND created_at < ?
  `).get(minorFactor, start, end) as { refunds_issued: number };

  // Tax components: same paid-window hydration as computeDayAggregates / X-report.
  type PaidBillTaxRow = {
    id: number;
    tax_amount?: number | null;
    tax_snapshot?: unknown;
    tax_breakdown?: unknown;
  };
  const bills = db.prepare(`
    SELECT b.*
    FROM bills b
    WHERE b.paid_at >= ? AND b.paid_at < ?
    ORDER BY b.paid_at, b.id
  `).all(start, end) as PaidBillTaxRow[];
  const orders = getOrdersWithItemsForBills(db, bills);
  const taxDocuments = bills.map((bill) => ({
    tax_amount: bill.tax_amount,
    tax_snapshot: bill.tax_snapshot,
    tax_breakdown: bill.tax_breakdown,
    items: orders.get(Number(bill.id))?.items || [],
  }));
  const taxComponents = aggregateTaxComponents(taxDocuments);
  const taxTotal = taxComponents.reduce((sum, component) => sum + Number(component.amount || 0), 0);

  const itemRows = db.prepare(`
    SELECT
      oi.product_id AS product_id,
      oi.product_name AS product_name,
      oi.product_sku AS product_sku,
      SUM(CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
               THEN oi.quantity ELSE bi.quantity END) AS quantity,
      SUM(CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
               THEN oi.subtotal + COALESCE(oi.discount_amount, 0)
               ELSE (oi.subtotal + COALESCE(oi.discount_amount, 0)) * bi.quantity / NULLIF(oi.quantity, 0)
          END) AS gross_item_sales,
      SUM(CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
               THEN COALESCE(oi.discount_amount, 0)
               ELSE COALESCE(oi.discount_amount, 0) * bi.quantity / NULLIF(oi.quantity, 0)
          END) AS item_discounts,
      SUM(CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
               THEN oi.subtotal
               ELSE oi.subtotal * bi.quantity / NULLIF(oi.quantity, 0)
          END) AS net_item_sales,
      SUM(CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
               THEN COALESCE(oi.tax_amount, 0)
               ELSE COALESCE(oi.tax_amount, 0) * bi.quantity / NULLIF(oi.quantity, 0)
          END) AS tax_amount
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
    WHERE b.paid_at >= ? AND b.paid_at < ?
      AND (oi.status IS NULL OR oi.status NOT IN ('cancelled', 'voided', 'void_adjustment'))
      AND (b.split_group_id IS NULL OR b.split_group_id = '' OR bi.bill_id IS NOT NULL)
    GROUP BY oi.product_id, oi.product_name, oi.product_sku
    ORDER BY net_item_sales DESC, product_name ASC
  `).all(start, end) as Array<{
    product_id: string;
    product_name: string;
    product_sku: string | null;
    quantity: number;
    gross_item_sales: number;
    item_discounts: number;
    net_item_sales: number;
    tax_amount: number;
  }>;

  const items: DailySalesExportItemRow[] = itemRows.map((row) => ({
    product_id: String(row.product_id),
    product_name: String(row.product_name),
    product_sku: row.product_sku == null ? null : String(row.product_sku),
    quantity: Number(row.quantity || 0),
    gross_item_sales: Number(row.gross_item_sales || 0),
    item_discounts: Number(row.item_discounts || 0),
    net_item_sales: Number(row.net_item_sales || 0),
    tax_amount: Number(row.tax_amount || 0),
  }));

  const itemDiscountsTotal = items.reduce((sum, item) => sum + item.item_discounts, 0);
  const grossCollected = Number(billRow.gross_collected || 0);
  const refundsIssued = Number(refundRow.refunds_issued || 0);

  // paidOnly + refunds by created_at + keyByPaidAt ⇒ Σ method totals = net_collected
  // under the approved refund-day rule (attributeRefundsToBillDate=false).
  // count is intentionally dropped: paymentMethodBreakdown COUNT(*) covers
  // payment+refund lines, which is not a payment count (review: misleading).
  const paymentMethods = paymentMethodBreakdown(
    db,
    { startDate: businessDate, endDate: businessDate, paidOnly: true, attributeRefundsToBillDate: false, keyByPaidAt: true },
  ).map((row) => ({
    method: String(row.method || 'unknown'),
    total: Number(row.total || 0),
  }));

  return {
    summary: {
      business_date: businessDate,
      timezone,
      business_day_start: businessDayStart,
      currency,
      order_count: Number(billRow.order_count || 0),
      paid_bill_count: Number(billRow.paid_bill_count || 0),
      gross_collected: grossCollected,
      refunds_issued: refundsIssued,
      net_collected: grossCollected - refundsIssued,
      tax_total: taxTotal,
      // Order-level (bills.discount_amount) + item-level historical discounts on paid bills.
      discount_total: Number(billRow.order_discount_total || 0) + itemDiscountsTotal,
      service_charge_total: Number(billRow.service_charge_total || 0),
      packaging_charge_total: Number(billRow.packaging_charge_total || 0),
      delivery_charge_total: Number(billRow.delivery_charge_total || 0),
      payment_methods: paymentMethods,
    },
    items,
  };
}

/** Flat metric/value rows for the Summary sheet / summary CSV (stable field order). */
export function dailySalesSummaryMetricRows(
  summary: DailySalesExportSummary,
): Array<{ metric: string; value: string | number }> {
  const rows: Array<{ metric: string; value: string | number }> = [
    { metric: 'business_date', value: summary.business_date },
    { metric: 'timezone', value: summary.timezone },
    { metric: 'business_day_start', value: summary.business_day_start },
    { metric: 'currency', value: summary.currency },
    { metric: 'order_count', value: summary.order_count },
    { metric: 'paid_bill_count', value: summary.paid_bill_count },
    { metric: 'gross_collected', value: summary.gross_collected },
    { metric: 'refunds_issued', value: summary.refunds_issued },
    { metric: 'net_collected', value: summary.net_collected },
    { metric: 'tax_total', value: summary.tax_total },
    { metric: 'discount_total', value: summary.discount_total },
    { metric: 'service_charge_total', value: summary.service_charge_total },
    { metric: 'packaging_charge_total', value: summary.packaging_charge_total },
    { metric: 'delivery_charge_total', value: summary.delivery_charge_total },
  ];
  for (const payment of summary.payment_methods) {
    rows.push({ metric: `payment_${dailySalesPaymentMetricKey(payment.method)}`, value: payment.total });
  }
  return rows;
}

export const DAILY_SALES_ITEM_COLUMNS = [
  'product_id',
  'product_name',
  'product_sku',
  'quantity',
  'gross_item_sales',
  'item_discounts',
  'net_item_sales',
  'tax_amount',
] as const;
