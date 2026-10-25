import type { Database } from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { toCsvRow } from '../lib/csv';
import {
  dayBoundsInTimezone,
  getDatabase,
  localDateInTimezone,
  parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../db';
import { getCurrencyFractionDigits } from '../countries';
import { getTenantCurrency } from './refund';
import { resolveExportTimezone } from './daily-sales-export';

export const CUSTOMER_SALES_MAX_RANGE_DAYS = 366;

export const CUSTOMER_SALES_COLUMNS = [
  'business_date',
  'paid_at',
  'bill_number',
  'order_number',
  'order_type',
  'customer_name',
  'customer_country_code',
  'customer_phone',
  'customer_email',
  'product_name',
  'product_sku',
  'quantity',
  'gross_item_sales',
  'item_discounts',
  'net_item_sales',
  'tax_amount',
  'payment_methods',
  'bill_total',
] as const;

export type CustomerSalesRow = {
  business_date: string;
  paid_at: string;
  bill_number: string;
  order_number: string;
  order_type: string;
  customer_name: string;
  customer_country_code: string;
  customer_phone: string;
  customer_email: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  gross_item_sales: number;
  item_discounts: number;
  net_item_sales: number;
  tax_amount: number;
  payment_methods: string;
  /** Set on the first item row of each bill only, so a column SUM equals bill totals. */
  bill_total: number | null;
};

export type CustomerSalesDataset = {
  start_date: string;
  end_date: string;
  currency: string;
  rows: CustomerSalesRow[];
};

export class CustomerSalesRangeError extends Error {}

function dayCount(startDate: string, endDate: string): number {
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.floor(ms / 86_400_000) + 1;
}

// `sv-SE` formats as `YYYY-MM-DD HH:MM:SS`, matching the stored timestamp shape.
function storeLocalTimestamp(stored: string, timezone: string): string {
  const instant = parseDbTimestamp(stored);
  if (Number.isNaN(instant.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(instant);
}

function paymentMethodNames(paymentDetails: unknown, namesById: Map<number, string>): string {
  if (typeof paymentDetails !== 'string' || !paymentDetails) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(paymentDetails);
  } catch {
    return '';
  }
  const lines = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const entry = line as { payment_method_id?: unknown; method?: unknown };
    const byId = namesById.get(Number(entry.payment_method_id));
    const name = byId || (typeof entry.method === 'string' ? entry.method : '');
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join('; ');
}

/**
 * One row per item sold on bills paid in [startDate, endDate] (tenant business days), with the
 * bill's customer repeated on every row. Item inclusion and split-bill apportioning match the
 * daily sales export Items query.
 */
export function buildCustomerSalesDataset(
  startDate: string,
  endDate: string,
  db: Database = getDatabase(),
): CustomerSalesDataset {
  if (startDate > endDate) {
    throw new CustomerSalesRangeError('start_date must not be after end_date');
  }
  if (dayCount(startDate, endDate) > CUSTOMER_SALES_MAX_RANGE_DAYS) {
    throw new CustomerSalesRangeError(
      `Date range must not exceed ${CUSTOMER_SALES_MAX_RANGE_DAYS} days`,
    );
  }

  const timezone = resolveExportTimezone();
  const businessDayStart = tenantBusinessDayStartTime(db);
  const [start] = dayBoundsInTimezone(startDate, timezone, businessDayStart);
  const [, end] = dayBoundsInTimezone(endDate, timezone, businessDayStart);
  const currency = getTenantCurrency(db);

  const methodNames = new Map<number, string>();
  for (const pm of db.prepare('SELECT id, name FROM payment_methods').all() as Array<{
    id: number;
    name: string;
  }>) {
    methodNames.set(Number(pm.id), String(pm.name));
  }

  const lineRows = db
    .prepare(`
    SELECT
      b.id AS bill_id,
      b.bill_number AS bill_number,
      b.paid_at AS paid_at,
      b.total AS bill_total,
      b.payment_details AS payment_details,
      o.order_number AS order_number,
      o.type AS order_type,
      c.name AS customer_name,
      c.country_code AS customer_country_code,
      c.phone AS customer_phone,
      c.email AS customer_email,
      oi.product_name AS product_name,
      oi.product_sku AS product_sku,
      CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
           THEN oi.quantity ELSE bi.quantity END AS quantity,
      CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
           THEN oi.subtotal + COALESCE(oi.discount_amount, 0)
           ELSE (oi.subtotal + COALESCE(oi.discount_amount, 0)) * bi.quantity / NULLIF(oi.quantity, 0)
      END AS gross_item_sales,
      CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
           THEN COALESCE(oi.discount_amount, 0)
           ELSE COALESCE(oi.discount_amount, 0) * bi.quantity / NULLIF(oi.quantity, 0)
      END AS item_discounts,
      CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
           THEN oi.subtotal
           ELSE oi.subtotal * bi.quantity / NULLIF(oi.quantity, 0)
      END AS net_item_sales,
      CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
           THEN COALESCE(oi.tax_amount, 0)
           ELSE COALESCE(oi.tax_amount, 0) * bi.quantity / NULLIF(oi.quantity, 0)
      END AS tax_amount
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
    LEFT JOIN customers c ON c.id = COALESCE(NULLIF(b.customer_id, ''), NULLIF(o.customer_id, ''))
    WHERE b.paid_at >= ? AND b.paid_at < ?
      AND (oi.status IS NULL OR oi.status NOT IN ('cancelled', 'voided', 'void_adjustment'))
      AND (b.split_group_id IS NULL OR b.split_group_id = '' OR bi.bill_id IS NOT NULL)
    ORDER BY b.paid_at, b.id, oi.id
  `)
    .all(start, end) as Array<{
    bill_id: number;
    bill_number: string;
    paid_at: string;
    bill_total: number | null;
    payment_details: unknown;
    order_number: string;
    order_type: string | null;
    customer_name: string | null;
    customer_country_code: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    product_name: string;
    product_sku: string | null;
    quantity: number;
    gross_item_sales: number;
    item_discounts: number;
    net_item_sales: number;
    tax_amount: number;
  }>;

  const methodsByBill = new Map<number, string>();
  const seenBills = new Set<number>();
  const rows: CustomerSalesRow[] = lineRows.map((row) => {
    const firstOfBill = !seenBills.has(row.bill_id);
    seenBills.add(row.bill_id);
    if (firstOfBill) {
      methodsByBill.set(row.bill_id, paymentMethodNames(row.payment_details, methodNames));
    }
    return {
      business_date: localDateInTimezone(parseDbTimestamp(row.paid_at), timezone, businessDayStart),
      paid_at: storeLocalTimestamp(row.paid_at, timezone),
      bill_number: String(row.bill_number),
      order_number: String(row.order_number ?? ''),
      order_type: String(row.order_type ?? ''),
      customer_name: row.customer_name ?? '',
      customer_country_code: String(row.customer_country_code ?? '').replace(/^\+/, ''),
      customer_phone: row.customer_phone ?? '',
      customer_email: row.customer_email ?? '',
      product_name: String(row.product_name),
      product_sku: row.product_sku ?? '',
      quantity: Number(row.quantity || 0),
      gross_item_sales: Number(row.gross_item_sales || 0),
      item_discounts: Number(row.item_discounts || 0),
      net_item_sales: Number(row.net_item_sales || 0),
      tax_amount: Number(row.tax_amount || 0),
      payment_methods: methodsByBill.get(row.bill_id) ?? '',
      bill_total: firstOfBill ? Number(row.bill_total || 0) : null,
    };
  });

  return { start_date: startDate, end_date: endDate, currency, rows };
}

export type CustomerSalesExportFormat = 'xlsx' | 'csv';

export function customerSalesExportFilename(
  startDate: string,
  endDate: string,
  format: CustomerSalesExportFormat,
): string {
  const span = startDate === endDate ? startDate : `${startDate}_to_${endDate}`;
  return `customer-sales-${span}.${format}`;
}

const MONEY_COLUMNS = new Set([
  'gross_item_sales',
  'item_discounts',
  'net_item_sales',
  'tax_amount',
  'bill_total',
]);

export async function serializeCustomerSalesXlsx(dataset: CustomerSalesDataset): Promise<Buffer> {
  const fractionDigits = getCurrencyFractionDigits(dataset.currency);
  const moneyFmt = fractionDigits > 0 ? `#,##0.${'0'.repeat(fractionDigits)}` : '#,##0';

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customer sales');
  sheet.columns = CUSTOMER_SALES_COLUMNS.map((key) => ({
    header: key,
    key,
    width: key.includes('name') || key === 'payment_methods' ? 28 : 16,
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: CUSTOMER_SALES_COLUMNS.length },
  };

  for (const row of dataset.rows) {
    const entry = sheet.addRow({ ...row, bill_total: row.bill_total ?? '' });
    entry.getCell('quantity').numFmt = '#,##0.###';
    for (const key of MONEY_COLUMNS) {
      if (typeof entry.getCell(key).value === 'number') entry.getCell(key).numFmt = moneyFmt;
    }
    // Phone and SKU are identifiers; keep them as text so Excel does not drop leading zeros.
    entry.getCell('customer_phone').numFmt = '@';
    entry.getCell('customer_country_code').numFmt = '@';
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function serializeCustomerSalesCsv(dataset: CustomerSalesDataset): string {
  const lines = [toCsvRow([...CUSTOMER_SALES_COLUMNS])];
  for (const row of dataset.rows) {
    lines.push(toCsvRow(CUSTOMER_SALES_COLUMNS.map((column) => row[column])));
  }
  return lines.join('\n') + '\n';
}
