import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import {
  dayBoundsInTimezone,
  getDatabase,
  getSettingValue,
  parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../db';
import {
  formatMoney,
  formatNumber,
  getCountryByCode,
  getCurrencyMinorUnitFactor,
  resolveRegionalSnapshot,
  type LocalePreferences,
} from '../countries';
import { getOrdersWithItemsForBills } from '../routes/bills';
import { getTenantCurrency } from './refund';
import { getActiveCountryPack } from './tax';
import { resolveTaxComponents, type DisplayTaxComponent } from './tax-components';
import {
  buildDailySalesExportDataset,
  DailySalesExportValidationError,
  dailySalesSummaryMetricRows,
  MAX_DAILY_SALES_HTML_BYTES,
  resolveDailySalesExportRange,
  resolveExportTimezone,
  type DailySalesExportDataset,
  type DailySalesExportQueryInput,
} from './daily-sales-export';
import { isExcludedFromBillReceipt } from '../../shared/order-item-status';
import { receiptChargeLines } from '../../shared/charges';

export const DAILY_INVOICES_EXPORT_MAX_RANGE_DAYS = 366;
export const MAX_DAILY_INVOICES_COUNT = 5000;
const SQLITE_IN_CHUNK_SIZE = 500;

export function dailyInvoicesExportFilename(
  range: { fromDate: string; toDate: string } | string,
  ext: 'html' | 'pdf' = 'html',
): string {
  const fromDate = typeof range === 'string' ? range : range.fromDate;
  const toDate = typeof range === 'string' ? range : range.toDate;
  const span = fromDate === toDate ? fromDate : `${fromDate}_to_${toDate}`;
  return `invoices-${span}.${ext}`;
}

export type DailyInvoiceStatus = 'paid' | 'partially_refunded' | 'refunded';

export type DailyInvoiceLineItem = {
  id: number;
  product_id: string;
  product_name: string;
  product_sku: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  variant_label: string;
  addons_label: string;
  status: string;
};

export type DailyInvoicePaymentLine = {
  method: string;
  amount: number;
  transaction_id: string;
  timestamp_local: string;
};

export type DailyInvoiceRefundLine = {
  id: number;
  amount: number;
  method: string;
  reason: string;
  created_at_local: string;
  in_window: boolean;
  scope_label: 'In Period' | 'Outside Period';
  item_name: string | null;
  item_quantity: number | null;
  item_variant: string;
};

export type DailyInvoicePriorBillRefundLine = {
  id: number;
  bill_id: number;
  bill_number: string;
  bill_paid_at_local: string;
  amount: number;
  method: string;
  reason: string;
  created_at_local: string;
  item_name: string | null;
  item_quantity: number | null;
  item_variant: string;
};

export type DailyInvoiceCard = {
  id: number;
  bill_number: string;
  order_id: number;
  order_number: string;
  order_type: string;
  table_number: string | null;
  server_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_tax_id: string | null;
  status: DailyInvoiceStatus;
  status_badge: '[PAID]' | '[PARTIALLY REFUNDED]' | '[REFUNDED]';
  created_at_local: string;
  paid_at_local: string;
  subtotal: number;
  discount_amount: number;
  service_charge: number;
  packaging_charge: number;
  delivery_charge: number;
  charges_breakdown: string | null;
  tax_amount: number;
  tax_components: DisplayTaxComponent[];
  tip_amount: number;
  round_off: number;
  total: number;
  paid_amount: number;
  items: DailyInvoiceLineItem[];
  payments: DailyInvoicePaymentLine[];
  refunds: DailyInvoiceRefundLine[];
  refund_total: number;
  refund_in_window_total: number;
  refund_out_of_window_total: number;
};

export type DailyInvoicesVatSummaryRow = {
  tax_name: string;
  tax_rate: number | null;
  taxable_base: number | null;
  tax_amount: number;
  gross_amount: number | null;
  shared_base: boolean;
  base_additive: boolean;
  incomplete_detail: boolean;
};

export type DailyInvoicesExportDataset = {
  store: {
    legal_name: string;
    tax_id: string;
    tax_id_label: string;
    address: string;
    country: string;
  };
  currency: string;
  locale: string;
  locale_preferences: LocalePreferences;
  timezone: string;
  business_day_start: string;
  business_date: string;
  from_date: string;
  to_date: string;
  day_count: number;
  total_invoices_count: number;
  total_gross_sales: number;
  net_base: number;
  tax_collected: number;
  total_refunds: number;
  in_window_refunds_on_included_bills: number;
  in_window_refunds_on_prior_bills: number;
  post_window_refunds_on_included_bills: number;
  lifetime_refunds_on_included_bills: number;
  prior_bill_refunds: DailyInvoicePriorBillRefundLine[];
  net_revenue: number;
  vat_summary: DailyInvoicesVatSummaryRow[];
  sales: DailySalesExportDataset;
  invoices: DailyInvoiceCard[];
};

export type DailyInvoicesExportOptions = {
  maxInvoicesCount?: number;
};

export type DailyInvoicesHtmlOptions = {
  locale?: string;
  preferences?: LocalePreferences;
};

const REPORT_FONT_STACK = [
  'system-ui',
  '-apple-system',
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  '"Noto Sans"',
  '"Noto Sans Arabic"',
  '"Noto Sans Hebrew"',
  '"Noto Sans Devanagari"',
  '"Noto Sans Bengali"',
  '"Noto Sans Tamil"',
  '"Noto Sans Thai"',
  '"Noto Sans CJK SC"',
  '"PingFang SC"',
  '"Microsoft YaHei"',
  '"Hiragino Sans"',
  '"Malgun Gothic"',
  'sans-serif',
].join(', ');

const REPORT_MONO_STACK = [
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  '"Liberation Mono"',
  'monospace',
  REPORT_FONT_STACK,
].join(', ');

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readDbSetting(db: Database, key: string): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value?: unknown }
      | undefined;
    if (typeof row?.value === 'string' && row.value.trim()) {
      return row.value.trim();
    }
  } catch {}
  const fallback = getSettingValue(key);
  return typeof fallback === 'string' ? fallback.trim() : '';
}

function resolveTaxIdLabel(db: Database, storeCountry: string): string {
  const normalizedCountry = storeCountry.trim().toUpperCase();
  try {
    const row = db
      .prepare(
        `
        SELECT pack.id AS pack_id, pack.country AS pack_country, version.pack_json
        FROM country_packs AS pack
        JOIN country_pack_versions AS version ON version.id = pack.active_version_id
        WHERE pack.country IN (?, '*') AND pack.status = 'active'
        ORDER BY CASE WHEN pack.country = ? THEN 0 ELSE 1 END, pack.updated_at DESC
        LIMIT 1
      `,
      )
      .get(normalizedCountry, normalizedCountry) as
      | { pack_id?: string; pack_country?: string; pack_json?: string }
      | undefined;
    if (
      row?.pack_json &&
      (row.pack_country === normalizedCountry ||
        (row.pack_country !== '*' && row.pack_id !== 'local-generic'))
    ) {
      const parsed = JSON.parse(row.pack_json) as { registrationNumberLabel?: unknown };
      if (
        typeof parsed?.registrationNumberLabel === 'string' &&
        parsed.registrationNumberLabel.trim()
      ) {
        return parsed.registrationNumberLabel.trim();
      }
    }
  } catch {}

  try {
    const activePack = getActiveCountryPack(normalizedCountry);
    if (
      activePack &&
      (activePack.country === normalizedCountry ||
        (activePack.country !== '*' && activePack.id !== 'local-generic')) &&
      typeof activePack.registrationNumberLabel === 'string' &&
      activePack.registrationNumberLabel.trim()
    ) {
      return activePack.registrationNumberLabel.trim();
    }
  } catch {}

  return getCountryByCode(normalizedCountry)?.taxIdLabel || 'Tax ID';
}

function extractBillSequenceNumber(billNumber: string): number | null {
  const match = /(?:^|[^0-9])(\d{1,12})$/.exec(String(billNumber ?? '').trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function resolveBusinessDateForTimestamp(
  paidAtUtc: string,
  dayWindows: Array<{ businessDate: string; start: string; end: string }>,
): string {
  for (const w of dayWindows) {
    if (paidAtUtc >= w.start && paidAtUtc < w.end) {
      return w.businessDate;
    }
  }
  return dayWindows[0]?.businessDate ?? '';
}

function storeLocalTimestamp(stored: string | null | undefined, timezone: string): string {
  if (!stored) return '';
  const instant = parseDbTimestamp(stored);
  if (Number.isNaN(instant.getTime())) return String(stored);
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

function formatVariantLabel(raw: unknown): string {
  if (!raw) return '';
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return String(entry ?? '').trim();
        const obj = entry as Record<string, unknown>;
        const name = String(obj.option_name ?? obj.name ?? obj.value ?? obj.label ?? '').trim();
        const group = String(obj.group_name ?? obj.group ?? '').trim();
        return group && name ? `${group}: ${name}` : name;
      })
      .filter(Boolean)
      .join(', ');
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name === 'string' || typeof obj.option_name === 'string') {
      const name = String(obj.option_name ?? obj.name ?? '').trim();
      const group = String(obj.group_name ?? obj.group ?? '').trim();
      return group && name ? `${group}: ${name}` : name;
    }
    return Object.entries(obj)
      .map(([k, v]) => {
        if (v && typeof v === 'object') {
          const inner = v as Record<string, unknown>;
          const val = String(inner.name ?? inner.option_name ?? inner.value ?? '').trim();
          return val ? `${k}: ${val}` : '';
        }
        const val = String(v ?? '').trim();
        return val ? `${k}: ${val}` : '';
      })
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

function formatAddonsLabel(effectiveAddons: unknown, rawAddons: unknown): string {
  const source =
    Array.isArray(effectiveAddons) && effectiveAddons.length > 0
      ? effectiveAddons
      : (() => {
          if (Array.isArray(rawAddons)) return rawAddons;
          if (typeof rawAddons === 'string' && rawAddons.trim()) {
            try {
              const parsed = JSON.parse(rawAddons);
              if (Array.isArray(parsed)) return parsed;
            } catch {}
          }
          return [];
        })();
  if (!Array.isArray(source) || source.length === 0) return '';
  return source
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const obj = entry as Record<string, unknown>;
      const name = String(obj.addon_name ?? obj.name ?? '').trim();
      if (!name) return '';
      const qty = Number(obj.quantity ?? 1);
      return Number.isFinite(qty) && qty > 1 ? `+ ${name} (x${qty})` : `+ ${name}`;
    })
    .filter(Boolean)
    .join(', ');
}

function statusBadgeForPaymentStatus(status: string): {
  normalized: DailyInvoiceStatus;
  badge: '[PAID]' | '[PARTIALLY REFUNDED]' | '[REFUNDED]';
} {
  if (status === 'refunded') {
    return { normalized: 'refunded', badge: '[REFUNDED]' };
  }
  if (status === 'partially_refunded') {
    return { normalized: 'partially_refunded', badge: '[PARTIALLY REFUNDED]' };
  }
  return { normalized: 'paid', badge: '[PAID]' };
}

function aggregateVatSummaryByRate(
  salesDataset: DailySalesExportDataset,
): DailyInvoicesVatSummaryRow[] {
  const merged = new Map<
    string,
    {
      tax_name: string;
      tax_rate: number | null;
      taxable_base: Decimal | null;
      tax_amount: Decimal;
      gross_amount: Decimal | null;
      shared_base: boolean;
      base_additive: boolean;
      incomplete_detail: boolean;
    }
  >();

  for (const row of salesDataset.taxes) {
    const rateKey = row.tax_rate === null ? '' : String(row.tax_rate);
    const key = `${row.tax_name}\u0000${rateKey}\u0000${row.incomplete_detail ? '1' : '0'}\u0000${row.shared_base ? '1' : '0'}`;
    const existing = merged.get(key);
    if (existing) {
      existing.tax_amount = existing.tax_amount.plus(row.tax_amount);
      if (existing.taxable_base !== null && row.taxable_base !== null) {
        existing.taxable_base = existing.taxable_base.plus(row.taxable_base);
      } else {
        existing.taxable_base = null;
      }
      if (existing.gross_amount !== null && row.gross_amount !== null) {
        existing.gross_amount = existing.gross_amount.plus(row.gross_amount);
      } else {
        existing.gross_amount = null;
      }
      existing.shared_base = existing.shared_base || row.shared_base;
      existing.base_additive = existing.base_additive && row.base_additive;
      existing.incomplete_detail = existing.incomplete_detail || row.incomplete_detail;
    } else {
      merged.set(key, {
        tax_name: row.tax_name,
        tax_rate: row.tax_rate,
        taxable_base: row.taxable_base === null ? null : new Decimal(row.taxable_base),
        tax_amount: new Decimal(row.tax_amount),
        gross_amount: row.gross_amount === null ? null : new Decimal(row.gross_amount),
        shared_base: row.shared_base,
        base_additive: row.base_additive,
        incomplete_detail: row.incomplete_detail,
      });
    }
  }

  return Array.from(merged.values()).map((entry) => ({
    tax_name: entry.tax_name,
    tax_rate: entry.tax_rate,
    taxable_base:
      entry.taxable_base === null
        ? null
        : entry.taxable_base.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    tax_amount: entry.tax_amount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    gross_amount:
      entry.gross_amount === null
        ? null
        : entry.gross_amount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    shared_base: entry.shared_base,
    base_additive: entry.base_additive,
    incomplete_detail: entry.incomplete_detail,
  }));
}

function isDatabaseInstance(value: unknown): value is Database {
  return Boolean(
    value && typeof value === 'object' && typeof (value as Database).prepare === 'function',
  );
}

export function buildDailyInvoicesExportDataset(
  inputOrDb: DailySalesExportQueryInput | Database,
  dbOrInput?: Database | DailySalesExportQueryInput,
  options?: DailyInvoicesExportOptions,
): DailyInvoicesExportDataset {
  const db: Database = isDatabaseInstance(inputOrDb)
    ? inputOrDb
    : isDatabaseInstance(dbOrInput)
      ? dbOrInput
      : getDatabase();
  const rawInput: DailySalesExportQueryInput = isDatabaseInstance(inputOrDb)
    ? ((dbOrInput as DailySalesExportQueryInput) ?? '')
    : inputOrDb;

  const normalizedInput: DailySalesExportQueryInput =
    typeof rawInput === 'object' &&
    rawInput !== null &&
    'fromDate' in (rawInput as Record<string, unknown>) &&
    'toDate' in (rawInput as Record<string, unknown>)
      ? {
          from: (rawInput as Record<string, unknown>).fromDate,
          to: (rawInput as Record<string, unknown>).toDate,
        }
      : rawInput;

  const range = resolveDailySalesExportRange(
    normalizedInput,
    undefined,
    DAILY_INVOICES_EXPORT_MAX_RANGE_DAYS,
  );

  const prelimTimezone = readDbSetting(db, 'timezone') || resolveExportTimezone();
  const prelimBusinessDayStart = tenantBusinessDayStartTime(db);
  const prelimDayWindows = range.dates.map((businessDate) => {
    const [start, end] = dayBoundsInTimezone(businessDate, prelimTimezone, prelimBusinessDayStart);
    return { businessDate, start, end };
  });
  const prelimStartUtc = prelimDayWindows[0].start;
  const prelimEndUtc = prelimDayWindows[prelimDayWindows.length - 1].end;

  const maxInvoicesCount = options?.maxInvoicesCount ?? MAX_DAILY_INVOICES_COUNT;
  const countRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM bills b
      WHERE b.paid_at >= ? AND b.paid_at < ?
        AND b.payment_status IN ('paid', 'partially_refunded', 'refunded')
    `,
    )
    .get(prelimStartUtc, prelimEndUtc) as { count?: number } | undefined;
  const totalMatchingBills = Number(countRow?.count ?? 0);
  if (totalMatchingBills > maxInvoicesCount) {
    throw new DailySalesExportValidationError(
      `Export exceeds maximum invoice count (${maxInvoicesCount}); please narrow the date range`,
    );
  }

  const sales = buildDailySalesExportDataset(
    range.isSingleDay ? { date: range.fromDate } : { from: range.fromDate, to: range.toDate },
    db,
    { maxRangeDays: DAILY_INVOICES_EXPORT_MAX_RANGE_DAYS },
  );

  const timezone = sales.summary.timezone || prelimTimezone;
  const businessDayStart = sales.summary.business_day_start || prelimBusinessDayStart;
  const currency = sales.summary.currency || getTenantCurrency(db);
  const minorFactor = getCurrencyMinorUnitFactor(currency);

  const storeLegalName = readDbSetting(db, 'business_name') || 'FloCafe Store';
  const storeAddress = readDbSetting(db, 'business_address');
  const storeTaxId = readDbSetting(db, 'tax_registration_number');
  const storeCountry = readDbSetting(db, 'country');
  const taxIdLabel = resolveTaxIdLabel(db, storeCountry);

  let resolvedLocale = 'en-US';
  let resolvedPreferences: LocalePreferences = {
    currencyDisplay: 'rial',
    digits: 'locale',
    calendar: 'locale',
  };
  try {
    const regionalSnapshot = resolveRegionalSnapshot({
      country: storeCountry || undefined,
      currency: currency || undefined,
      timezone: timezone || undefined,
      currency_display: readDbSetting(db, 'currency_display') || undefined,
      number_digits: readDbSetting(db, 'number_digits') || undefined,
      calendar: readDbSetting(db, 'calendar') || undefined,
    });
    resolvedLocale = regionalSnapshot.locale || 'en-US';
    resolvedPreferences = regionalSnapshot.preferences;
  } catch {}

  const dayWindows = range.dates.map((businessDate) => {
    const [start, end] = dayBoundsInTimezone(businessDate, timezone, businessDayStart);
    return { businessDate, start, end };
  });
  const windowStartUtc = dayWindows[0].start;
  const windowEndUtc = dayWindows[dayWindows.length - 1].end;

  type BillQueryRow = {
    id: number;
    bill_number: string;
    order_id: number;
    customer_id: string | null;
    split_group_id: string | null;
    subtotal: number;
    tax_amount: number;
    tax_breakdown: string | null;
    tax_snapshot: string | null;
    discount_amount: number;
    delivery_charge: number;
    packaging_charge: number;
    service_charge: number;
    charges_breakdown: string | null;
    round_off: number;
    total: number;
    paid_amount: number;
    payment_status: string;
    payment_details: string | null;
    paid_at: string;
    created_at: string;
    order_number: string | null;
    order_type: string | null;
    table_number: string | null;
    server_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
  };

  const rawBillRows = db
    .prepare(
      `
      SELECT
        b.id,
        b.bill_number,
        b.order_id,
        b.customer_id,
        b.split_group_id,
        COALESCE(b.subtotal, 0) AS subtotal,
        COALESCE(b.tax_amount, 0) AS tax_amount,
        b.tax_breakdown,
        b.tax_snapshot,
        COALESCE(b.discount_amount, 0) AS discount_amount,
        COALESCE(b.delivery_charge, 0) AS delivery_charge,
        COALESCE(b.packaging_charge, 0) AS packaging_charge,
        COALESCE(b.service_charge, 0) AS service_charge,
        b.charges_breakdown AS charges_breakdown,
        COALESCE(b.round_off, 0) AS round_off,
        COALESCE(b.total, 0) AS total,
        COALESCE(b.paid_amount, 0) AS paid_amount,
        b.payment_status,
        b.payment_details,
        b.paid_at,
        b.created_at,
        o.order_number AS order_number,
        o.type AS order_type,
        t.number AS table_number,
        u.name AS server_name,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email
      FROM bills b
      LEFT JOIN orders o ON o.id = b.order_id
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN customers c ON c.id = COALESCE(b.customer_id, o.customer_id)
      WHERE b.paid_at >= ? AND b.paid_at < ?
        AND b.payment_status IN ('paid', 'partially_refunded', 'refunded')
      ORDER BY b.paid_at ASC, b.id ASC
    `,
    )
    .all(windowStartUtc, windowEndUtc) as BillQueryRow[];

  const billSortMeta = new Map<number, { businessDate: string; seq: number | null }>();
  for (const row of rawBillRows) {
    billSortMeta.set(Number(row.id), {
      businessDate: resolveBusinessDateForTimestamp(row.paid_at, dayWindows),
      seq: extractBillSequenceNumber(row.bill_number),
    });
  }

  const billRows = [...rawBillRows].sort((a, b) => {
    const metaA = billSortMeta.get(Number(a.id))!;
    const metaB = billSortMeta.get(Number(b.id))!;
    if (metaA.businessDate !== metaB.businessDate) {
      return metaA.businessDate < metaB.businessDate ? -1 : 1;
    }
    if (metaA.seq !== null && metaB.seq !== null && metaA.seq !== metaB.seq) {
      return metaA.seq - metaB.seq;
    }
    if (a.paid_at !== b.paid_at) {
      return a.paid_at < b.paid_at ? -1 : 1;
    }
    if (Number(a.id) !== Number(b.id)) {
      return Number(a.id) - Number(b.id);
    }
    return String(a.bill_number).localeCompare(String(b.bill_number));
  });

  const paymentMethodMap = new Map<number, string>();
  try {
    const pmRows = db.prepare('SELECT id, name FROM payment_methods').all() as Array<{
      id: number;
      name: string;
    }>;
    for (const pm of pmRows) {
      paymentMethodMap.set(Number(pm.id), String(pm.name));
    }
  } catch {}

  const ordersByBillId = getOrdersWithItemsForBills(db, billRows);

  type RawRefundRow = {
    id: number;
    bill_id: number;
    order_item_id: number | null;
    amount_cents: number;
    method: string | null;
    reason: string | null;
    created_at: string;
    item_name: string | null;
    item_quantity: number | null;
    item_variant: string | null;
  };

  const refundsByBillId = new Map<number, RawRefundRow[]>();
  const includedBillIds = billRows.map((b) => Number(b.id));
  const includedBillIdSet = new Set<number>(includedBillIds);

  for (let i = 0; i < includedBillIds.length; i += SQLITE_IN_CHUNK_SIZE) {
    const chunk = includedBillIds.slice(i, i + SQLITE_IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `
        SELECT
          r.id,
          r.bill_id,
          r.order_item_id,
          r.amount_cents,
          r.method,
          r.reason,
          r.created_at,
          oi.product_name AS item_name,
          oi.quantity AS item_quantity,
          oi.variant_selection AS item_variant
        FROM refunds r
        LEFT JOIN order_items oi ON oi.id = r.order_item_id
        WHERE r.bill_id IN (${placeholders})
        ORDER BY r.created_at ASC, r.id ASC
      `,
      )
      .all(...chunk) as RawRefundRow[];

    for (const r of rows) {
      const billId = Number(r.bill_id);
      const list = refundsByBillId.get(billId) ?? [];
      list.push(r);
      refundsByBillId.set(billId, list);
    }
  }

  type RawWindowRefundRow = RawRefundRow & {
    bill_number: string | null;
    bill_paid_at: string | null;
  };

  const windowRefundRows = db
    .prepare(
      `
      SELECT
        r.id,
        r.bill_id,
        b.bill_number,
        b.paid_at AS bill_paid_at,
        r.order_item_id,
        r.amount_cents,
        r.method,
        r.reason,
        r.created_at,
        oi.product_name AS item_name,
        oi.quantity AS item_quantity,
        oi.variant_selection AS item_variant
      FROM refunds r
      LEFT JOIN bills b ON b.id = r.bill_id
      LEFT JOIN order_items oi ON oi.id = r.order_item_id
      WHERE r.created_at >= ? AND r.created_at < ?
      ORDER BY r.created_at ASC, r.id ASC
    `,
    )
    .all(windowStartUtc, windowEndUtc) as RawWindowRefundRow[];

  let priorBillsRefundDec = new Decimal(0);
  const priorBillRefunds: DailyInvoicePriorBillRefundLine[] = [];
  for (const r of windowRefundRows) {
    if (includedBillIdSet.has(Number(r.bill_id))) continue;
    const amountDec = new Decimal(Number(r.amount_cents || 0)).div(minorFactor);
    priorBillsRefundDec = priorBillsRefundDec.plus(amountDec);
    priorBillRefunds.push({
      id: Number(r.id),
      bill_id: Number(r.bill_id),
      bill_number: String(r.bill_number ?? `#${r.bill_id}`),
      bill_paid_at_local: storeLocalTimestamp(r.bill_paid_at, timezone),
      amount: amountDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      method: String(r.method || 'cash'),
      reason: String(r.reason || ''),
      created_at_local: storeLocalTimestamp(r.created_at, timezone),
      item_name: r.item_name ? String(r.item_name) : null,
      item_quantity: r.item_quantity == null ? null : Number(r.item_quantity),
      item_variant: formatVariantLabel(r.item_variant),
    });
  }

  let includedInWindowRefundsDec = new Decimal(0);
  let includedOutWindowRefundsDec = new Decimal(0);
  let includedLifetimeRefundsDec = new Decimal(0);

  const invoices: DailyInvoiceCard[] = billRows.map((bill) => {
    const hydratedOrder = ordersByBillId.get(Number(bill.id)) as
      | {
          order_number?: string;
          type?: string;
          items?: Array<Record<string, unknown>>;
        }
      | undefined;

    const rawItems = Array.isArray(hydratedOrder?.items) ? hydratedOrder!.items : [];
    const activeBillItems = rawItems.filter((item) => !isExcludedFromBillReceipt(item.status));

    const items: DailyInvoiceLineItem[] = activeBillItems.map((item) => {
      const qty = Number(item.quantity ?? 1);
      const unitPrice = Number(item.unit_price ?? 0);
      const subtotal = Number(item.subtotal ?? unitPrice * qty);
      const discountAmount = Number(item.discount_amount ?? 0);
      const taxAmount = Number(item.tax_amount ?? 0);
      const total = Number(item.total ?? subtotal);
      return {
        id: Number(item.id ?? 0),
        product_id: String(item.product_id ?? ''),
        product_name: String(item.product_name ?? 'Item'),
        product_sku: item.product_sku == null ? null : String(item.product_sku),
        quantity: qty,
        unit_price: unitPrice,
        subtotal,
        discount_amount: discountAmount,
        tax_amount: taxAmount,
        total,
        variant_label: formatVariantLabel(item.variant_selection),
        addons_label: formatAddonsLabel(item.effective_addons, item.addons),
        status: String(item.status ?? 'ready'),
      };
    });

    const taxComponents = resolveTaxComponents({
      tax_amount: bill.tax_amount,
      tax_snapshot: bill.tax_snapshot,
      tax_breakdown: bill.tax_breakdown,
      items: activeBillItems.map((item) => ({
        tax_snapshot: item.tax_snapshot,
        tax_breakdown: item.tax_breakdown,
        status: null,
      })),
    });

    const payments: DailyInvoicePaymentLine[] = [];
    let tipAmount = 0;
    if (bill.payment_details) {
      try {
        const parsed = JSON.parse(bill.payment_details);
        const entries = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object'
            ? [parsed]
            : [];
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue;
          const obj = entry as Record<string, unknown>;
          const pmId = Number(obj.payment_method_id);
          const method =
            (Number.isFinite(pmId) && paymentMethodMap.get(pmId)) ||
            (typeof obj.method === 'string' && obj.method.trim()) ||
            'unknown';
          const amount = Number(obj.amount ?? 0);
          const txId = typeof obj.transaction_id === 'string' ? obj.transaction_id.trim() : '';
          const tsRaw =
            typeof obj.timestamp === 'string' && obj.timestamp.trim()
              ? obj.timestamp
              : bill.paid_at;
          if (typeof obj.tip === 'number' && Number.isFinite(obj.tip)) {
            tipAmount += obj.tip;
          } else if (typeof obj.tip_amount === 'number' && Number.isFinite(obj.tip_amount)) {
            tipAmount += obj.tip_amount;
          }
          payments.push({
            method,
            amount,
            transaction_id: txId,
            timestamp_local: storeLocalTimestamp(tsRaw, timezone),
          });
        }
      } catch {}
    }

    const rawRefunds = refundsByBillId.get(Number(bill.id)) ?? [];

    let refundTotalDec = new Decimal(0);
    let refundInWindowDec = new Decimal(0);
    let refundOutWindowDec = new Decimal(0);

    const refunds: DailyInvoiceRefundLine[] = rawRefunds.map((r) => {
      const amountDec = new Decimal(Number(r.amount_cents || 0)).div(minorFactor);
      const inWindow = r.created_at >= windowStartUtc && r.created_at < windowEndUtc;
      refundTotalDec = refundTotalDec.plus(amountDec);
      if (inWindow) {
        refundInWindowDec = refundInWindowDec.plus(amountDec);
      } else {
        refundOutWindowDec = refundOutWindowDec.plus(amountDec);
      }
      return {
        id: Number(r.id),
        amount: amountDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
        method: String(r.method || 'cash'),
        reason: String(r.reason || ''),
        created_at_local: storeLocalTimestamp(r.created_at, timezone),
        in_window: inWindow,
        scope_label: inWindow ? 'In Period' : 'Outside Period',
        item_name: r.item_name ? String(r.item_name) : null,
        item_quantity: r.item_quantity == null ? null : Number(r.item_quantity),
        item_variant: formatVariantLabel(r.item_variant),
      };
    });

    includedInWindowRefundsDec = includedInWindowRefundsDec.plus(refundInWindowDec);
    includedOutWindowRefundsDec = includedOutWindowRefundsDec.plus(refundOutWindowDec);
    includedLifetimeRefundsDec = includedLifetimeRefundsDec.plus(refundTotalDec);

    const { normalized, badge } = statusBadgeForPaymentStatus(bill.payment_status);

    return {
      id: Number(bill.id),
      bill_number: String(bill.bill_number),
      order_id: Number(bill.order_id),
      order_number: String(bill.order_number ?? hydratedOrder?.order_number ?? `#${bill.order_id}`),
      order_type: String(bill.order_type ?? hydratedOrder?.type ?? 'takeaway'),
      table_number: bill.table_number ? String(bill.table_number) : null,
      server_name: bill.server_name ? String(bill.server_name) : null,
      customer_name: bill.customer_name ? String(bill.customer_name) : null,
      customer_phone: bill.customer_phone ? String(bill.customer_phone) : null,
      customer_email: bill.customer_email ? String(bill.customer_email) : null,
      customer_tax_id: null,
      status: normalized,
      status_badge: badge,
      created_at_local: storeLocalTimestamp(bill.created_at, timezone),
      paid_at_local: storeLocalTimestamp(bill.paid_at, timezone),
      subtotal: Number(bill.subtotal || 0),
      discount_amount: Number(bill.discount_amount || 0),
      service_charge: Number(bill.service_charge || 0),
      packaging_charge: Number(bill.packaging_charge || 0),
      delivery_charge: Number(bill.delivery_charge || 0),
      charges_breakdown: bill.charges_breakdown ? String(bill.charges_breakdown) : null,
      tax_amount: Number(bill.tax_amount || 0),
      tax_components: taxComponents,
      tip_amount: tipAmount,
      round_off: Number(bill.round_off || 0),
      total: Number(bill.total || 0),
      paid_amount: Number(bill.paid_amount || 0),
      items,
      payments,
      refunds,
      refund_total: refundTotalDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      refund_in_window_total: refundInWindowDec
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      refund_out_of_window_total: refundOutWindowDec
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
    };
  });

  const netBase = new Decimal(sales.summary.gross_collected)
    .minus(sales.summary.tax_total)
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
    .toNumber();

  const vatSummary = aggregateVatSummaryByRate(sales);

  return {
    store: {
      legal_name: storeLegalName,
      tax_id: storeTaxId,
      tax_id_label: taxIdLabel,
      address: storeAddress,
      country: storeCountry,
    },
    currency,
    locale: resolvedLocale,
    locale_preferences: resolvedPreferences,
    timezone,
    business_day_start: businessDayStart,
    business_date: sales.summary.business_date,
    from_date: sales.summary.from_date,
    to_date: sales.summary.to_date,
    day_count: sales.summary.day_count,
    total_invoices_count: invoices.length,
    total_gross_sales: sales.summary.gross_collected,
    net_base: netBase,
    tax_collected: sales.summary.tax_total,
    total_refunds: sales.summary.refunds_issued,
    in_window_refunds_on_included_bills: includedInWindowRefundsDec
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
      .toNumber(),
    in_window_refunds_on_prior_bills: priorBillsRefundDec
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
      .toNumber(),
    post_window_refunds_on_included_bills: includedOutWindowRefundsDec
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
      .toNumber(),
    lifetime_refunds_on_included_bills: includedLifetimeRefundsDec
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
      .toNumber(),
    prior_bill_refunds: priorBillRefunds,
    net_revenue: sales.summary.net_collected,
    vat_summary: vatSummary,
    sales,
    invoices,
  };
}

export function serializeDailyInvoicesExportHtml(
  dataset: DailyInvoicesExportDataset,
  options?: DailyInvoicesHtmlOptions,
): string {
  let locale = options?.locale || dataset.locale || '';
  let preferences = options?.preferences || dataset.locale_preferences;

  if (!locale || !preferences) {
    try {
      const snapshot = resolveRegionalSnapshot({
        country: dataset.store?.country || (getSettingValue('country') ?? undefined),
        currency: dataset.currency || (getSettingValue('currency') ?? undefined),
        timezone: dataset.timezone || (getSettingValue('timezone') ?? undefined),
        currency_display: getSettingValue('currency_display') ?? undefined,
        number_digits: getSettingValue('number_digits') ?? undefined,
        calendar: getSettingValue('calendar') ?? undefined,
      });
      if (!locale) locale = snapshot.locale;
      if (!preferences) preferences = snapshot.preferences;
    } catch {
      if (!locale) locale = 'en-US';
    }
  }

  const resolvedLocale = locale || 'en-US';
  const resolvedPrefs: LocalePreferences = preferences ?? {
    currencyDisplay: 'rial',
    digits: 'locale',
    calendar: 'locale',
  };
  const currency = dataset.currency || 'USD';
  const numberingSystem = resolvedPrefs.digits === 'latin' ? 'latn' : undefined;

  const fmtMoney = (n: number | null | undefined): string =>
    n === null || n === undefined || !Number.isFinite(Number(n))
      ? ''
      : formatMoney(Number(n), currency, resolvedLocale, resolvedPrefs);

  const fmtNum = (n: number | null | undefined): string =>
    n === null || n === undefined || !Number.isFinite(Number(n))
      ? ''
      : formatNumber(Number(n), resolvedLocale, numberingSystem);

  const fmtRate = (n: number | null | undefined) =>
    n === null || n === undefined || !Number.isFinite(Number(n)) ? '-' : `${Number(n).toFixed(2)}%`;

  const summaryRowsHtml = dailySalesSummaryMetricRows(dataset.sales.summary)
    .map(({ metric, value }) => {
      const rawVal = value === null || value === undefined ? '' : String(value);
      const displayVal =
        typeof value === 'number'
          ? metric.endsWith('_count')
            ? fmtNum(value)
            : metric.endsWith('_percent')
              ? `${Number(value).toFixed(2)}%`
              : fmtMoney(value)
          : rawVal;
      const valueClass = typeof value === 'number' ? 'num' : 'mono';
      return `<tr data-section="summary" data-metric="${escapeHtml(metric)}" data-value="${escapeHtml(rawVal)}"><td class="mono">${escapeHtml(metric)}</td><td class="${valueClass}">${escapeHtml(displayVal)}</td></tr>`;
    })
    .join('\n');

  const refundReconciliationRows = [
    {
      scope: 'in_window_refunds_total',
      label: 'In-Period Refunds (Cover Total)',
      value: dataset.total_refunds,
    },
    {
      scope: 'in_window_refunds_on_included_bills',
      label: 'In-Period Refunds on Window Invoices',
      value: dataset.in_window_refunds_on_included_bills ?? 0,
    },
    {
      scope: 'in_window_refunds_on_prior_bills',
      label: 'In-Period Refunds on Prior-Period Invoices',
      value: dataset.in_window_refunds_on_prior_bills ?? 0,
    },
    {
      scope: 'post_window_refunds_on_included_bills',
      label: 'Outside-Period Refunds on Window Invoices',
      value: dataset.post_window_refunds_on_included_bills ?? 0,
    },
    {
      scope: 'lifetime_refunds_on_included_bills',
      label: 'Lifetime Refunds on Window Invoices',
      value: dataset.lifetime_refunds_on_included_bills ?? 0,
    },
  ]
    .map(
      (row) =>
        `<tr data-section="refund-reconciliation" data-scope="${escapeHtml(row.scope)}" data-value="${escapeHtml(row.value)}"><td>${escapeHtml(row.label)}</td><td class="num">${escapeHtml(fmtMoney(row.value))}</td></tr>`,
    )
    .join('\n');

  const priorBillRefundsHtml =
    Array.isArray(dataset.prior_bill_refunds) && dataset.prior_bill_refunds.length > 0
      ? `<h2>Prior-Period Invoices Refunded in Selected Period</h2>
        <table data-section="prior-bill-refunds">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Original Paid At</th>
              <th>Refunded At</th>
              <th>Method / Reason / Item</th>
              <th class="num">Refund Amount</th>
            </tr>
          </thead>
          <tbody>
            ${dataset.prior_bill_refunds
              .map((ref) => {
                const details: string[] = [ref.method];
                if (ref.reason) details.push(`Reason: ${ref.reason}`);
                if (ref.item_name) {
                  details.push(
                    `Item: ${ref.item_name}${ref.item_quantity != null ? ` (x${ref.item_quantity})` : ''}${ref.item_variant ? ` [${ref.item_variant}]` : ''}`,
                  );
                }
                return `<tr data-section="prior-bill-refund" data-refund-id="${escapeHtml(ref.id)}" data-bill-number="${escapeHtml(ref.bill_number)}" data-amount="${escapeHtml(ref.amount)}">
                  <td class="mono">${escapeHtml(ref.bill_number)}</td>
                  <td class="mono">${escapeHtml(ref.bill_paid_at_local)}</td>
                  <td class="mono">${escapeHtml(ref.created_at_local)}</td>
                  <td>${escapeHtml(details.join(' · '))}</td>
                  <td class="num">${escapeHtml(fmtMoney(ref.amount))}</td>
                </tr>`;
              })
              .join('\n')}
          </tbody>
        </table>`
      : '';

  const vatRateRowsHtml =
    dataset.vat_summary.length === 0
      ? '<tr data-empty="vat-summary"><td colspan="5" class="muted">No tax activity in this window.</td></tr>'
      : dataset.vat_summary
          .map(
            (
              row,
            ) => `<tr data-section="vat-summary" data-name="${escapeHtml(row.tax_name)}" data-rate="${escapeHtml(row.tax_rate ?? '')}" data-base="${escapeHtml(row.taxable_base ?? '')}" data-tax="${escapeHtml(row.tax_amount)}" data-gross="${escapeHtml(row.gross_amount ?? '')}">
            <td>${escapeHtml(row.tax_name)}</td>
            <td class="num">${escapeHtml(fmtRate(row.tax_rate))}</td>
            <td class="num">${escapeHtml(fmtMoney(row.taxable_base))}</td>
            <td class="num">${escapeHtml(fmtMoney(row.tax_amount))}</td>
            <td class="num">${escapeHtml(fmtMoney(row.gross_amount))}</td>
          </tr>`,
          )
          .join('\n');

  const dailyTaxRowsHtml =
    dataset.sales.taxes.length === 0
      ? '<tr data-empty="taxes"><td colspan="6" class="muted">No daily tax breakdown rows.</td></tr>'
      : dataset.sales.taxes
          .map(
            (
              row,
            ) => `<tr data-section="tax" data-date="${escapeHtml(row.business_date)}" data-name="${escapeHtml(row.tax_name)}" data-rate="${escapeHtml(row.tax_rate ?? '')}" data-base="${escapeHtml(row.taxable_base ?? '')}" data-tax="${escapeHtml(row.tax_amount)}" data-gross="${escapeHtml(row.gross_amount ?? '')}" data-shared-base="${row.shared_base ? 'true' : 'false'}" data-base-additive="${row.base_additive ? 'true' : 'false'}" data-incomplete-detail="${row.incomplete_detail ? 'true' : 'false'}">
            <td class="mono">${escapeHtml(row.business_date)}</td>
            <td>${escapeHtml(row.tax_name)}</td>
            <td class="num">${escapeHtml(fmtRate(row.tax_rate))}</td>
            <td class="num">${escapeHtml(fmtMoney(row.taxable_base))}</td>
            <td class="num">${escapeHtml(fmtMoney(row.tax_amount))}</td>
            <td class="num">${escapeHtml(fmtMoney(row.gross_amount))}</td>
          </tr>`,
          )
          .join('\n');

  const coverPageBreakClass =
    dataset.invoices.length > 0 ? 'cover-page has-invoices' : 'cover-page';

  const invoiceCardsHtml =
    dataset.invoices.length === 0
      ? '<div class="empty-invoices" data-empty="invoices">No issued invoices for the selected business period.</div>'
      : dataset.invoices
          .map((inv) => {
            const orderTypeDisplay = inv.table_number
              ? `${inv.order_type} (Table ${inv.table_number})`
              : inv.order_type;

            const customerParts: string[] = [];
            if (inv.customer_name) customerParts.push(inv.customer_name);
            if (inv.customer_phone) customerParts.push(inv.customer_phone);
            if (inv.customer_tax_id)
              customerParts.push(`${dataset.store.tax_id_label}: ${inv.customer_tax_id}`);
            const customerDisplay =
              customerParts.length > 0 ? customerParts.join(' · ') : 'Walk-in';

            const itemRowsHtml = inv.items
              .map((item) => {
                const details: string[] = [];
                if (item.variant_label) details.push(item.variant_label);
                if (item.addons_label) details.push(item.addons_label);
                const detailLine =
                  details.length > 0
                    ? `<div class="item-meta">${escapeHtml(details.join(' | '))}</div>`
                    : '';
                return `<tr class="invoice-item-row" data-item-subtotal="${escapeHtml(item.subtotal)}" data-item-total="${escapeHtml(item.total)}">
                  <td class="num">${escapeHtml(fmtNum(item.quantity))}</td>
                  <td>
                    <span class="item-name">${escapeHtml(item.product_name)}</span>
                    ${detailLine}
                  </td>
                  <td class="num">${escapeHtml(fmtMoney(item.unit_price))}</td>
                  <td class="num" data-col="item-subtotal">${escapeHtml(fmtMoney(item.subtotal))}</td>
                  <td class="num" data-col="item-total">${escapeHtml(fmtMoney(item.total))}</td>
                </tr>`;
              })
              .join('\n');

            const itemisedCharges = receiptChargeLines(inv.charges_breakdown);
            const itemisedIds = new Set(itemisedCharges.map((charge) => charge.id));
            const chargeLines: string[] = [];
            if (inv.service_charge > 0 && !itemisedIds.has('service_charge')) {
              chargeLines.push(
                `<div class="totals-line"><span>Service Charge</span><span class="mono">${escapeHtml(fmtMoney(inv.service_charge))}</span></div>`,
              );
            }
            if (inv.packaging_charge > 0 && !itemisedIds.has('packaging_charge')) {
              chargeLines.push(
                `<div class="totals-line"><span>Packaging Charge</span><span class="mono">${escapeHtml(fmtMoney(inv.packaging_charge))}</span></div>`,
              );
            }
            if (inv.delivery_charge > 0 && !itemisedIds.has('delivery_charge')) {
              chargeLines.push(
                `<div class="totals-line"><span>Delivery Charge</span><span class="mono">${escapeHtml(fmtMoney(inv.delivery_charge))}</span></div>`,
              );
            }
            for (const charge of itemisedCharges) {
              const label = (charge as any).label || charge.name || charge.id;
              chargeLines.push(
                `<div class="totals-line"><span>${escapeHtml(label)}</span><span class="mono">${escapeHtml(fmtMoney(charge.amount))}</span></div>`,
              );
            }
            const chargesHtml =
              chargeLines.length > 0 ? chargeLines.join('\n                  ') : '';

            const taxComponentLines =
              inv.tax_components.length > 0
                ? inv.tax_components
                    .map((comp) => {
                      const label =
                        comp.rate !== null
                          ? `${comp.title} (${Number(comp.rate).toFixed(2)}%)`
                          : comp.title;
                      return `<div class="totals-line tax-component-line"><span>${escapeHtml(label)}</span><span class="mono">${escapeHtml(fmtMoney(comp.amount))}</span></div>`;
                    })
                    .join('\n')
                : `<div class="totals-line tax-component-line"><span>Tax</span><span class="mono">${escapeHtml(fmtMoney(inv.tax_amount))}</span></div>`;

            const paymentLinesHtml =
              inv.payments.length > 0
                ? inv.payments
                    .map((pm) => {
                      const txSuffix = pm.transaction_id ? ` (Tx: ${pm.transaction_id})` : '';
                      return `<span class="payment-pill">${escapeHtml(pm.method)}: ${escapeHtml(fmtMoney(pm.amount))}${escapeHtml(txSuffix)}</span>`;
                    })
                    .join(' ')
                : `<span class="payment-pill">Paid: ${escapeHtml(fmtMoney(inv.paid_amount))}</span>`;

            const hasRefundBlock =
              inv.status === 'refunded' ||
              inv.status === 'partially_refunded' ||
              inv.refunds.length > 0;

            const inWindowRefTotal = inv.refund_in_window_total ?? inv.refund_total;
            const outOfWindowRefTotal = inv.refund_out_of_window_total ?? 0;

            const refundBlockHtml = hasRefundBlock
              ? `<div class="refund-box" data-section="invoice-refunds" data-lifetime-refunded="${escapeHtml(inv.refund_total)}" data-in-window-refunded="${escapeHtml(inWindowRefTotal)}" data-out-of-window-refunded="${escapeHtml(outOfWindowRefTotal)}">
                  <div class="refund-box-header">
                    <strong>Refund Details (${escapeHtml(inv.status_badge)})</strong>
                    <span class="mono">Lifetime Refunded: ${escapeHtml(fmtMoney(inv.refund_total))} · In Selected Period: ${escapeHtml(fmtMoney(inWindowRefTotal))}${outOfWindowRefTotal > 0 ? ` · Outside Period: ${escapeHtml(fmtMoney(outOfWindowRefTotal))}` : ''}</span>
                  </div>
                  ${
                    inv.refunds.length > 0
                      ? `<ul class="refund-list">
                          ${inv.refunds
                            .map((ref) => {
                              const itemDesc = ref.item_name
                                ? ` · Item: ${ref.item_name}${ref.item_quantity != null ? ` (x${ref.item_quantity})` : ''}${ref.item_variant ? ` [${ref.item_variant}]` : ''}`
                                : '';
                              const reasonDesc = ref.reason ? ` · Reason: ${ref.reason}` : '';
                              const scopeAttr =
                                ref.in_window !== false ? 'in-window' : 'out-of-window';
                              const scopeBadge =
                                ref.scope_label ||
                                (ref.in_window !== false ? 'In Period' : 'Outside Period');
                              return `<li class="refund-entry" data-refund-id="${escapeHtml(ref.id)}" data-refund-scope="${escapeHtml(scopeAttr)}">
                                <span class="mono">[${escapeHtml(scopeBadge)}] ${escapeHtml(ref.created_at_local)}</span> —
                                <strong>${escapeHtml(fmtMoney(ref.amount))}</strong>
                                (${escapeHtml(ref.method)})${escapeHtml(reasonDesc)}${escapeHtml(itemDesc)}
                              </li>`;
                            })
                            .join('\n')}
                        </ul>`
                      : ''
                  }
                </div>`
              : '';

            return `<article class="invoice-card" data-section="invoice" data-bill-number="${escapeHtml(inv.bill_number)}" data-order-number="${escapeHtml(inv.order_number)}" data-status="${escapeHtml(inv.status)}">
              <header class="invoice-header">
                <div class="invoice-store">
                  <div class="invoice-store-name">${escapeHtml(dataset.store.legal_name)}</div>
                  <div class="invoice-store-meta">
                    <span>${escapeHtml(dataset.store.tax_id_label)}: ${escapeHtml(dataset.store.tax_id || 'N/A')}</span>
                    ${dataset.store.address ? `<span> · ${escapeHtml(dataset.store.address)}</span>` : ''}
                  </div>
                </div>
                <div class="invoice-title-right">
                  <span class="status-badge status-${escapeHtml(inv.status)}" data-status-badge="${escapeHtml(inv.status_badge)}">${escapeHtml(inv.status_badge)}</span>
                  <div class="invoice-number mono">Invoice #${escapeHtml(inv.bill_number)}</div>
                </div>
              </header>

              <div class="invoice-meta-grid">
                <div><strong>Order:</strong> <span class="mono">${escapeHtml(inv.order_number)}</span> (${escapeHtml(orderTypeDisplay)})</div>
                <div><strong>Paid:</strong> <span class="mono">${escapeHtml(inv.paid_at_local)}</span> (Created: <span class="mono">${escapeHtml(inv.created_at_local)}</span>)</div>
                <div><strong>Staff:</strong> ${escapeHtml(inv.server_name || 'N/A')}</div>
                <div><strong>Customer:</strong> ${escapeHtml(customerDisplay)}</div>
              </div>

              <table class="invoice-items-table">
                <thead>
                  <tr>
                    <th class="num" style="width: 8%;">Qty</th>
                    <th style="width: 44%;">Item</th>
                    <th class="num" style="width: 16%;">Unit (${escapeHtml(currency)})</th>
                    <th class="num" style="width: 16%;">Subtotal (${escapeHtml(currency)})</th>
                    <th class="num" style="width: 16%;">Total (${escapeHtml(currency)})</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemRowsHtml}
                </tbody>
              </table>

              <div class="invoice-footer-grid">
                <div class="invoice-payments">
                  <div class="payments-label"><strong>Payments:</strong> ${paymentLinesHtml}</div>
                </div>
                <div class="invoice-totals">
                  <div class="totals-line"><span>Subtotal</span><span class="mono">${escapeHtml(fmtMoney(inv.subtotal))}</span></div>
                  ${inv.discount_amount > 0 ? `<div class="totals-line"><span>Discount</span><span class="mono">-${escapeHtml(fmtMoney(inv.discount_amount))}</span></div>` : ''}
                  ${chargesHtml}
                  ${taxComponentLines}
                  ${inv.tip_amount > 0 ? `<div class="totals-line"><span>Tip</span><span class="mono">${escapeHtml(fmtMoney(inv.tip_amount))}</span></div>` : ''}
                  ${inv.round_off !== 0 ? `<div class="totals-line"><span>Round-off</span><span class="mono">${escapeHtml(fmtMoney(inv.round_off))}</span></div>` : ''}
                  <div class="totals-line totals-grand"><span>Total (${escapeHtml(currency)})</span><span class="mono">${escapeHtml(fmtMoney(inv.total))}</span></div>
                </div>
              </div>

              ${refundBlockHtml}
            </article>`;
          })
          .join('\n');

  const html = `<!doctype html>
<html lang="${escapeHtml(resolvedLocale)}">
<head>
<meta charset="utf-8">
<title>Compiled Daily Invoices — ${escapeHtml(dataset.business_date)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ${REPORT_FONT_STACK};
    color: #0f172a;
    margin: 0;
    padding: 10px;
    font-size: 9.5px;
    line-height: 1.3;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .cover-page {
    padding: 2px 0 6px;
  }
  .cover-page.has-invoices {
    page-break-after: always;
    break-after: page;
  }
  .cover-header {
    border-bottom: 2px solid #0f172a;
    padding-bottom: 6px;
    margin-bottom: 8px;
  }
  .cover-header h1 {
    font-size: 15px;
    margin: 0 0 3px;
  }
  .cover-store-details {
    font-size: 10.5px;
    color: #1e293b;
    margin-bottom: 3px;
  }
  .cover-meta {
    font-size: 9.5px;
    color: #475569;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin: 8px 0 10px;
  }
  .kpi-card {
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    padding: 5px 7px;
    background: #f8fafc;
  }
  .kpi-label {
    font-size: 8.5px;
    text-transform: uppercase;
    color: #475569;
    letter-spacing: 0.03em;
  }
  .kpi-value {
    font-family: ${REPORT_MONO_STACK};
    font-size: 12px;
    font-weight: 700;
    color: #0f172a;
    margin-top: 2px;
  }
  h2 {
    font-size: 11px;
    margin: 8px 0 4px;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 2px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 6px;
    table-layout: fixed;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 2px 5px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  th {
    background: #f1f5f9;
    font-weight: 600;
  }
  td.num, th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: ${REPORT_MONO_STACK};
  }
  td.mono, .mono {
    font-family: ${REPORT_MONO_STACK};
  }
  td.muted {
    color: #64748b;
    font-style: italic;
  }
  .invoices-flow {
    display: block;
  }
  .appendix-section {
    page-break-before: always;
    break-before: page;
    padding-top: 4px;
  }
  .invoice-card {
    border: 1px solid #94a3b8;
    border-radius: 4px;
    padding: 7px 9px;
    margin-bottom: 8px;
    background: #ffffff;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .invoice-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 4px;
    margin-bottom: 4px;
  }
  .invoice-store-name {
    font-size: 11px;
    font-weight: 700;
  }
  .invoice-store-meta {
    font-size: 9px;
    color: #475569;
  }
  .invoice-title-right {
    text-align: right;
  }
  .invoice-number {
    font-size: 11px;
    font-weight: 700;
    margin-top: 2px;
  }
  .status-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    font-family: ${REPORT_MONO_STACK};
  }
  .status-paid {
    background: #dcfce7;
    color: #166534;
    border: 1px solid #86efac;
  }
  .status-partially_refunded {
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fcd34d;
  }
  .status-refunded {
    background: #fee2e2;
    color: #991b1b;
    border: 1px solid #fca5a5;
  }
  .invoice-meta-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2px 10px;
    font-size: 9px;
    margin-bottom: 5px;
    color: #334155;
  }
  .invoice-items-table {
    margin-bottom: 5px;
    font-size: 9px;
  }
  .invoice-items-table th, .invoice-items-table td {
    padding: 2px 4px;
  }
  .item-meta {
    font-size: 8px;
    color: #64748b;
  }
  .invoice-footer-grid {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    font-size: 9px;
  }
  .invoice-payments {
    flex: 1;
  }
  .payment-pill {
    display: inline-block;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    border-radius: 3px;
    padding: 1px 4px;
    margin-right: 4px;
    margin-bottom: 2px;
    font-family: ${REPORT_MONO_STACK};
  }
  .invoice-totals {
    width: 210px;
  }
  .totals-line {
    display: flex;
    justify-content: space-between;
    padding: 1px 0;
  }
  .totals-grand {
    border-top: 1px solid #0f172a;
    margin-top: 2px;
    padding-top: 2px;
    font-weight: 700;
    font-size: 10px;
  }
  .refund-box {
    margin-top: 5px;
    padding: 4px 6px;
    background: #fff1f2;
    border: 1px solid #fecdd3;
    border-radius: 3px;
    font-size: 9px;
    color: #881337;
  }
  .refund-box-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
  }
  .refund-list {
    margin: 0;
    padding-left: 14px;
  }
  .empty-invoices {
    padding: 12px;
    border: 1px dashed #cbd5e1;
    color: #64748b;
    text-align: center;
  }
</style>
</head>
<body>
  <section class="${coverPageBreakClass}" data-section="cover-page">
    <header class="cover-header">
      <h1>Daily Invoices &amp; Fiscal Summary Report</h1>
      <div class="cover-store-details">
        <strong>${escapeHtml(dataset.store.legal_name)}</strong>
        · <span>${escapeHtml(dataset.store.tax_id_label)}: ${escapeHtml(dataset.store.tax_id || 'N/A')}</span>
        ${dataset.store.address ? ` · <span>${escapeHtml(dataset.store.address)}</span>` : ''}
      </div>
      <div class="cover-meta">
        Business Date: <strong>${escapeHtml(dataset.business_date)}</strong>
        · Timezone: ${escapeHtml(dataset.timezone)}
        · Day Start: ${escapeHtml(dataset.business_day_start)}
        · Currency: ${escapeHtml(currency)}
      </div>
    </header>

    <div class="kpi-grid" data-section="cover-kpis">
      <div class="kpi-card" data-kpi="total_invoices_count" data-value="${escapeHtml(dataset.total_invoices_count)}">
        <div class="kpi-label">Total Invoices Count</div>
        <div class="kpi-value">${escapeHtml(fmtNum(dataset.total_invoices_count))}</div>
      </div>
      <div class="kpi-card" data-kpi="total_gross_sales" data-value="${escapeHtml(dataset.total_gross_sales)}">
        <div class="kpi-label">Total Gross Sales (${escapeHtml(currency)})</div>
        <div class="kpi-value">${escapeHtml(fmtMoney(dataset.total_gross_sales))}</div>
      </div>
      <div class="kpi-card" data-kpi="net_base" data-value="${escapeHtml(dataset.net_base)}">
        <div class="kpi-label">Net Base (${escapeHtml(currency)})</div>
        <div class="kpi-value">${escapeHtml(fmtMoney(dataset.net_base))}</div>
      </div>
      <div class="kpi-card" data-kpi="tax_collected" data-value="${escapeHtml(dataset.tax_collected)}">
        <div class="kpi-label">Tax Collected (${escapeHtml(currency)})</div>
        <div class="kpi-value">${escapeHtml(fmtMoney(dataset.tax_collected))}</div>
      </div>
      <div class="kpi-card" data-kpi="total_refunds" data-value="${escapeHtml(dataset.total_refunds)}">
        <div class="kpi-label">Total Refunds (In Period, ${escapeHtml(currency)})</div>
        <div class="kpi-value">${escapeHtml(fmtMoney(dataset.total_refunds))}</div>
      </div>
      <div class="kpi-card" data-kpi="net_revenue" data-value="${escapeHtml(dataset.net_revenue)}">
        <div class="kpi-label">Net Revenue (${escapeHtml(currency)})</div>
        <div class="kpi-value">${escapeHtml(fmtMoney(dataset.net_revenue))}</div>
      </div>
    </div>

    <h2>VAT / Tax Summary Table by Rate</h2>
    <table data-section="vat-summary">
      <thead>
        <tr>
          <th>Tax Name</th>
          <th class="num">Rate</th>
          <th class="num">Taxable Base (${escapeHtml(currency)})</th>
          <th class="num">Tax Amount (${escapeHtml(currency)})</th>
          <th class="num">Gross Amount (${escapeHtml(currency)})</th>
        </tr>
      </thead>
      <tbody>
        ${vatRateRowsHtml}
      </tbody>
    </table>

    <h2>Refund Scope Reconciliation</h2>
    <table data-section="refund-reconciliation">
      <thead><tr><th>Scope</th><th class="num">Amount (${escapeHtml(currency)})</th></tr></thead>
      <tbody>
        ${refundReconciliationRows}
      </tbody>
    </table>

    <h2>Summary Reconciliation Metrics</h2>
    <table data-section="summary">
      <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
      <tbody>
        ${summaryRowsHtml}
      </tbody>
    </table>
  </section>

  <section class="invoices-flow" data-section="invoices">
    <h2>Issued Invoices (${escapeHtml(fmtNum(dataset.invoices.length))})</h2>
    ${invoiceCardsHtml}
  </section>

  <section class="appendix-section" data-section="daily-tax-appendix">
    <h2>Daily Tax Breakdown Appendix</h2>
    <table data-section="taxes">
      <thead>
        <tr>
          <th>Date</th>
          <th>Tax Name</th>
          <th class="num">Rate</th>
          <th class="num">Taxable Base</th>
          <th class="num">Tax Amount</th>
          <th class="num">Gross Amount</th>
        </tr>
      </thead>
      <tbody>
        ${dailyTaxRowsHtml}
      </tbody>
    </table>
    ${priorBillRefundsHtml}
  </section>
</body>
</html>
`;

  if (Buffer.byteLength(html, 'utf8') > MAX_DAILY_SALES_HTML_BYTES) {
    throw new DailySalesExportValidationError(
      'Export exceeds maximum printable PDF size; please narrow the date range',
    );
  }
  return html;
}
