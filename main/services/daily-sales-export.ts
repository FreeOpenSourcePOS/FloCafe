import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import {
  dayBoundsInTimezone,
  getDatabase,
  parseDbTimestamp,
  getSettingValue,
  tenantBusinessDayStartTime,
} from '../db';
import {
  getCurrencyFractionDigits,
  getCurrencyMinorUnitFactor,
  resolveRegionalSnapshot,
} from '../countries';
import { isExcludedFromBillReceipt } from '../../shared/order-item-status';
import { getTenantCurrency } from './refund';
import { roundCurrencyCost } from './supplies';
import { computeDiscountTaxRatio } from './tax';
import { getOrdersWithItemsForBills } from '../routes/bills';
import { paymentMethodBreakdown } from '../routes/cash-closures';

export const DAILY_SALES_EXPORT_MAX_RANGE_DAYS = 93;

export const DAILY_SALES_TAX_INCOMPLETE_WARNING =
  'Incomplete historical tax detail: rate or taxable base was not stored; tax_amount is included in reconciliation.';

export const DAILY_SALES_SUMMARY_TAX_WARNING =
  'Incomplete historical tax detail: one or more historical records lacked rate or taxable base breakdown; stored tax amounts are included in tax_total.';

export class DailySalesExportValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DailySalesExportValidationError';
  }
}

export type DailySalesCostStatus = 'known' | 'partial' | 'unknown';

export type DailySalesExportItemRow = {
  product_id: string;
  product_name: string;
  product_sku: string | null;
  quantity: number;
  gross_item_sales: number;
  item_discounts: number;
  net_item_sales: number;
  tax_amount: number;
  ingredient_cost: number | null;
  profit: number | null;
  margin_percent: number | null;
  cost_status: DailySalesCostStatus;
};

export type DailySalesExportPaymentRow = {
  method: string;
  total: number;
};

export type DailySalesExportPaymentLineRow = {
  bill_number: string;
  order_number: string;
  payment_time: string;
  method: string;
  amount: number;
  transaction_id: string;
};

export type DailySalesExportDayRow = {
  business_date: string;
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
  known_cost_net_item_sales: number;
  ingredient_cost_total: number | null;
  gross_profit_total: number | null;
  gross_margin_percent: number | null;
  cost_coverage_status: DailySalesCostStatus;
};

export type DailySalesExportTaxRow = {
  business_date: string;
  tax_name: string;
  tax_rate: number | null;
  taxable_base: number | null;
  tax_amount: number;
  gross_amount: number | null;
  shared_base: boolean;
  base_additive: boolean;
  incomplete_detail: boolean;
  warning: string;
};

export type DailySalesExportSummary = {
  business_date: string;
  from_date: string;
  to_date: string;
  day_count: number;
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
  known_cost_net_item_sales: number;
  ingredient_cost_total: number | null;
  gross_profit_total: number | null;
  gross_margin_percent: number | null;
  cost_coverage_status: DailySalesCostStatus;
  tax_detail_complete: boolean;
  tax_detail_warning: string | null;
  payment_methods: DailySalesExportPaymentRow[];
};

export type DailySalesExportDataset = {
  summary: DailySalesExportSummary;
  daily: DailySalesExportDayRow[];
  taxes: DailySalesExportTaxRow[];
  items: DailySalesExportItemRow[];
  payments: DailySalesExportPaymentLineRow[];
};

export type DailySalesExportQueryInput =
  | string
  | {
      date?: unknown;
      from?: unknown;
      to?: unknown;
      defaultDate?: string;
    };

export type ResolvedDailySalesExportRange = {
  fromDate: string;
  toDate: string;
  dates: string[];
  isSingleDay: boolean;
};

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const SPLIT_TAX_SNAPSHOT_VERSION = 'minor-unit-v1';

export function parseValidBusinessDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!BUSINESS_DATE_RE.test(trimmed)) return null;
  const [yearStr, monthStr, dayStr] = trimmed.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(utc.getTime()) ||
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return utc;
}

export function resolveDailySalesExportRange(
  input: DailySalesExportQueryInput,
  fallbackDate?: string,
): ResolvedDailySalesExportRange {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const parsed = parseValidBusinessDate(trimmed);
    if (!parsed) {
      throw new DailySalesExportValidationError(
        'Invalid date; expected a valid YYYY-MM-DD calendar date',
      );
    }
    return {
      fromDate: trimmed,
      toDate: trimmed,
      dates: [trimmed],
      isSingleDay: true,
    };
  }

  const hasDateParam = input.date !== undefined;
  const hasFromParam = input.from !== undefined;
  const hasToParam = input.to !== undefined;

  if (hasDateParam && (hasFromParam || hasToParam)) {
    throw new DailySalesExportValidationError(
      'Specify either date or from/to date range, not both',
    );
  }

  if (hasFromParam || hasToParam) {
    if (
      typeof input.from !== 'string' ||
      typeof input.to !== 'string' ||
      !input.from.trim() ||
      !input.to.trim()
    ) {
      throw new DailySalesExportValidationError(
        'Both from and to dates (YYYY-MM-DD) are required for a range export',
      );
    }
    const fromDate = input.from.trim();
    const toDate = input.to.trim();
    const fromUtc = parseValidBusinessDate(fromDate);
    const toUtc = parseValidBusinessDate(toDate);
    if (!fromUtc || !toUtc) {
      throw new DailySalesExportValidationError(
        'Invalid from or to date; expected valid YYYY-MM-DD calendar dates',
      );
    }
    if (toUtc.getTime() < fromUtc.getTime()) {
      throw new DailySalesExportValidationError(
        'Invalid date range: to date must be on or after from date',
      );
    }
    const dayCount = Math.round((toUtc.getTime() - fromUtc.getTime()) / DAY_MS) + 1;
    if (dayCount > DAILY_SALES_EXPORT_MAX_RANGE_DAYS) {
      throw new DailySalesExportValidationError(
        `Date range exceeds maximum of ${DAILY_SALES_EXPORT_MAX_RANGE_DAYS} days (requested ${dayCount} days)`,
      );
    }
    const dates: string[] = [];
    for (let i = 0; i < dayCount; i += 1) {
      dates.push(new Date(fromUtc.getTime() + i * DAY_MS).toISOString().slice(0, 10));
    }
    return {
      fromDate,
      toDate,
      dates,
      isSingleDay: fromDate === toDate,
    };
  }

  const rawDate =
    input.date === undefined
      ? (input.defaultDate ?? fallbackDate ?? '')
      : typeof input.date === 'string'
        ? input.date.trim()
        : '';
  const dateUtc = parseValidBusinessDate(rawDate);
  if (!dateUtc) {
    throw new DailySalesExportValidationError(
      'Invalid date; expected a valid YYYY-MM-DD calendar date',
    );
  }
  return {
    fromDate: rawDate,
    toDate: rawDate,
    dates: [rawDate],
    isSingleDay: true,
  };
}

export function resolveExportTimezone(): string {
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

type RawItemAggregateRow = {
  product_id: string;
  product_name: string;
  product_sku: string | null;
  quantity: number;
  gross_item_sales: number;
  item_discounts: number;
  net_item_sales: number;
  tax_amount: number;
  known_cost_quantity: number;
  unknown_cost_quantity: number;
  known_cost_net_item_sales: number;
  known_ingredient_cost: number;
};

type HistoricalTaxEntry = {
  title: string;
  rate: string | null;
  taxableBase: Decimal | null;
  amount: Decimal;
  sharedBase: boolean;
  incompleteDetail: boolean;
};

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decimalOrNull(value: unknown): Decimal | null {
  if (value instanceof Decimal) return value.isFinite() ? value : null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function hasSplitAllocatedSnapshot(value: unknown): boolean {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) return parsed.some(hasSplitAllocatedSnapshot);
  if (!parsed || typeof parsed !== 'object') return false;
  const snapshot = parsed as Record<string, unknown>;
  return snapshot.splitAllocation === SPLIT_TAX_SNAPSHOT_VERSION && Array.isArray(snapshot.lines);
}

function getTaxDiscountRatioDecimal(subtotal: unknown, discountAmount: unknown): Decimal {
  const base = Number(subtotal || 0);
  if (!Number.isFinite(base) || base <= 0) return new Decimal(1);
  const baseDec = new Decimal((subtotal || 0) as number | string);
  const rawDiscount = Number(discountAmount || 0);
  const discountDec = Decimal.max(
    0,
    Decimal.min(
      new Decimal(Number.isFinite(rawDiscount) ? ((discountAmount || 0) as number | string) : 0),
      baseDec,
    ),
  );
  return computeDiscountTaxRatio(baseDec.minus(discountDec), baseDec);
}

function extractSnapshotEntries(
  value: unknown,
  options: { onlyChargeSnapshots?: boolean; filterZeroSplitLines?: boolean } = {},
): { present: boolean; entries: HistoricalTaxEntry[] } {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => extractSnapshotEntries(entry, options));
    return {
      present: results.some((r) => r.present),
      entries: results.flatMap((r) => r.entries),
    };
  }
  if (!parsed || typeof parsed !== 'object') return { present: false, entries: [] };

  const snapshot = parsed as Record<string, unknown>;
  const rawLines = Array.isArray(snapshot.lines)
    ? snapshot.lines
    : Array.isArray(snapshot.components)
      ? [snapshot]
      : null;
  if (!rawLines) return { present: false, entries: [] };
  if (options.onlyChargeSnapshots && typeof snapshot.chargeKind !== 'string') {
    return { present: false, entries: [] };
  }

  const entries: HistoricalTaxEntry[] = [];
  for (const rawLine of rawLines) {
    if (!rawLine || typeof rawLine !== 'object') continue;
    const line = rawLine as Record<string, unknown>;
    const lineBase = decimalOrNull(line.taxableBase ?? line.taxable_base);
    const rawComponents = Array.isArray(line.components) ? line.components : null;

    if (!rawComponents || rawComponents.length === 0) {
      const lineTax = decimalOrNull(line.taxAmount ?? line.tax_amount);
      if (lineTax && !lineTax.isZero()) {
        entries.push({
          title: 'Unknown',
          rate: null,
          taxableBase: lineBase,
          amount: lineTax,
          sharedBase: false,
          incompleteDetail: true,
        });
      }
      continue;
    }

    const parsedComponents: Array<{
      ruleId: string | null;
      title: string;
      rate: Decimal | null;
      amount: Decimal;
      baseRuleIds: string[];
    }> = [];

    for (const rawComp of rawComponents) {
      if (!rawComp || typeof rawComp !== 'object') continue;
      const comp = rawComp as Record<string, unknown>;
      const amount = decimalOrNull(comp.amount);
      if (!amount) continue;
      if (options.filterZeroSplitLines && amount.isZero()) continue;
      const rate = decimalOrNull(comp.rate);
      const baseRuleIds = Array.isArray(comp.baseRuleIds)
        ? comp.baseRuleIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      parsedComponents.push({
        ruleId: typeof comp.ruleId === 'string' ? comp.ruleId : null,
        title: String(comp.label || comp.title || comp.name || comp.ruleId || 'Tax'),
        rate,
        amount,
        baseRuleIds,
      });
    }

    if (parsedComponents.length === 0) continue;
    if (
      (lineBase === null || lineBase.isZero()) &&
      parsedComponents.every((c) => c.amount.isZero())
    ) {
      continue;
    }

    const amountByRuleId = new Map<string, Decimal>();
    for (const comp of parsedComponents) {
      if (comp.ruleId) {
        amountByRuleId.set(
          comp.ruleId,
          (amountByRuleId.get(comp.ruleId) || new Decimal(0)).plus(comp.amount),
        );
      }
    }

    const isMultiComponentLine = parsedComponents.length > 1;
    for (const comp of parsedComponents) {
      let compBase: Decimal | null = lineBase;
      if (compBase !== null && comp.baseRuleIds.length > 0) {
        for (const baseRuleId of comp.baseRuleIds) {
          compBase = compBase.plus(amountByRuleId.get(baseRuleId) || 0);
        }
      }
      const sharedBase = isMultiComponentLine || comp.baseRuleIds.length > 0;
      const incompleteDetail = comp.rate === null || compBase === null;
      entries.push({
        title: comp.title,
        rate: comp.rate === null ? null : comp.rate.toString(),
        taxableBase: incompleteDetail ? (compBase ?? null) : compBase,
        amount: comp.amount,
        sharedBase,
        incompleteDetail,
      });
    }
  }

  return { present: true, entries };
}

function flattenLegacyBreakdownRaw(value: unknown): Array<{
  title: string;
  rate: Decimal | null;
  amount: Decimal;
  explicitBase: Decimal | null;
}> {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  const items: Array<{
    title: string;
    rate: Decimal | null;
    amount: Decimal;
    explicitBase: Decimal | null;
  }> = [];
  for (const entry of parsed) {
    if (Array.isArray(entry)) {
      items.push(...flattenLegacyBreakdownRaw(entry));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const amount = decimalOrNull(raw.amount);
    if (!amount || amount.isZero()) continue;
    const rate = decimalOrNull(raw.rate);
    const explicitBase = decimalOrNull(raw.taxable_base ?? raw.taxableBase);
    items.push({
      title: String(raw.title || raw.name || raw.label || 'Tax'),
      rate,
      amount,
      explicitBase,
    });
  }
  return items;
}

function extractItemLegacyEntries(
  item: Record<string, unknown>,
  taxDiscountRatioDec: Decimal,
): HistoricalTaxEntry[] {
  const breakdown = flattenLegacyBreakdownRaw(item.tax_breakdown);
  if (breakdown.length === 0) return [];

  const subtotalDec = decimalOrNull(item.subtotal);
  const itemTaxDec = decimalOrNull(item.tax_amount) ?? new Decimal(0);
  const derivedItemBase =
    subtotalDec !== null && !subtotalDec.isZero()
      ? item.tax_type === 'inclusive'
        ? subtotalDec.mul(taxDiscountRatioDec).minus(itemTaxDec)
        : subtotalDec.mul(taxDiscountRatioDec)
      : null;

  const sharedBase = breakdown.length > 1;
  return breakdown.map((comp) => {
    const rateStr = comp.rate === null ? null : comp.rate.toString();
    const base = comp.explicitBase ?? (comp.rate !== null ? derivedItemBase : null);
    const incompleteDetail = rateStr === null || base === null;
    return {
      title: comp.title,
      rate: rateStr,
      taxableBase: base,
      amount: comp.amount,
      sharedBase: sharedBase && base !== null,
      incompleteDetail,
    };
  });
}

const MINOR_UNIT_ROUNDING_TOLERANCE = new Decimal('0.05');

function shouldExtractDocumentResiduals(
  coveredEntries: HistoricalTaxEntry[],
  targetValue: Decimal,
): boolean {
  if (targetValue.isZero()) return false;
  const representedSum = coveredEntries.reduce((sum, e) => sum.plus(e.amount), new Decimal(0));
  const diff = targetValue.minus(representedSum);
  if (
    coveredEntries.length > 0 &&
    !representedSum.isZero() &&
    diff.abs().lte(MINOR_UNIT_ROUNDING_TOLERANCE)
  ) {
    return false;
  }
  return targetValue.isNegative() ? representedSum.gt(targetValue) : representedSum.lt(targetValue);
}

function extractDocumentLegacyResidualEntries(
  documentBreakdown: unknown,
  coveredEntries: HistoricalTaxEntry[],
): HistoricalTaxEntry[] {
  const remainingByKey = new Map<string, Decimal>();
  for (const entry of coveredEntries) {
    const key = `${entry.title}\u0000${entry.rate ?? ''}`;
    remainingByKey.set(key, (remainingByKey.get(key) || new Decimal(0)).plus(entry.amount));
  }
  const rawDocBreakdown = flattenLegacyBreakdownRaw(documentBreakdown);
  const sharedDocBase =
    rawDocBreakdown.length > 1 && rawDocBreakdown.every((c) => c.explicitBase !== null);
  const residuals: HistoricalTaxEntry[] = [];
  for (const comp of rawDocBreakdown) {
    const rateStr = comp.rate === null ? null : comp.rate.toString();
    const key = `${comp.title}\u0000${rateStr ?? ''}`;
    const covered = remainingByKey.get(key) || new Decimal(0);
    const sameSign =
      covered.isZero() || comp.amount.isZero() || covered.isPositive() === comp.amount.isPositive();
    const consumed = sameSign
      ? Decimal.min(covered.abs(), comp.amount.abs()).mul(comp.amount.isNegative() ? -1 : 1)
      : new Decimal(0);
    const residual = comp.amount.minus(consumed);
    remainingByKey.set(key, covered.minus(consumed));
    if (residual.isZero()) continue;
    if (
      !covered.isZero() &&
      comp.explicitBase === null &&
      residual.abs().lte(MINOR_UNIT_ROUNDING_TOLERANCE)
    ) {
      continue;
    }
    const base = comp.explicitBase;
    const incompleteDetail = rateStr === null || base === null;
    residuals.push({
      title: comp.title,
      rate: rateStr,
      taxableBase: base,
      amount: residual,
      sharedBase: sharedDocBase,
      incompleteDetail,
    });
  }
  return residuals;
}

function reconcileBillTaxEntries(
  entries: HistoricalTaxEntry[],
  targetValue: Decimal | null,
): HistoricalTaxEntry[] {
  if (!targetValue) return entries;
  if (entries.length === 0) {
    if (targetValue.isZero()) return [];
    return [
      {
        title: 'Unknown',
        rate: null,
        taxableBase: null,
        amount: targetValue,
        sharedBase: false,
        incompleteDetail: true,
      },
    ];
  }

  const currentTotal = entries.reduce((sum, e) => sum.plus(e.amount), new Decimal(0));
  const diff = targetValue.minus(currentTotal);
  if (diff.isZero()) return entries;
  if (currentTotal.isZero()) {
    return targetValue.isZero()
      ? entries
      : [
          {
            title: 'Unknown',
            rate: null,
            taxableBase: null,
            amount: targetValue,
            sharedBase: false,
            incompleteDetail: true,
          },
        ];
  }

  // Minor-unit rounding remainder from order-level discount or split allocation:
  // adjust the last component so component amounts sum to the exact bill tax total.
  if (diff.abs().lte(MINOR_UNIT_ROUNDING_TOLERANCE)) {
    const cloned = entries.map((entry) => ({ ...entry }));
    let targetIndex = cloned.length - 1;
    for (let i = cloned.length - 1; i >= 0; i -= 1) {
      if (!cloned[i].incompleteDetail) {
        targetIndex = i;
        break;
      }
    }
    cloned[targetIndex].amount = cloned[targetIndex].amount.plus(diff);
    return cloned;
  }

  // Larger unattributed gap on the bill: keep known component bases/amounts intact and
  // record the unattributed tax amount as an incomplete-detail row for reconciliation.
  return [
    ...entries,
    {
      title: 'Unknown',
      rate: null,
      taxableBase: null,
      amount: diff,
      sharedBase: false,
      incompleteDetail: true,
    },
  ];
}

function resolveBillHistoricalTaxEntries(
  bill: {
    id: number;
    tax_amount?: number | null;
    tax_snapshot?: unknown;
    tax_breakdown?: unknown;
  },
  order:
    | {
        subtotal?: number | null;
        discount_amount?: number | null;
        items?: Array<Record<string, unknown>>;
      }
    | undefined,
): HistoricalTaxEntry[] {
  const activeItems = (order?.items || []).filter(
    (item) => !isExcludedFromBillReceipt(item.status),
  );
  const taxDiscountRatioDec = getTaxDiscountRatioDecimal(order?.subtotal, order?.discount_amount);

  const billTaxDec = decimalOrNull(bill.tax_amount);
  const activeItemsTaxSum = activeItems.reduce(
    (sum, item) => sum.plus(decimalOrNull(item.tax_amount) ?? 0),
    new Decimal(0),
  );
  const billHasOwnEvidence =
    Boolean(bill.tax_snapshot && String(bill.tax_snapshot).trim()) ||
    Boolean(bill.tax_breakdown && String(bill.tax_breakdown).trim());
  const effectiveTargetTax =
    billTaxDec !== null &&
    (!billTaxDec.isZero() || billHasOwnEvidence || activeItemsTaxSum.isZero())
      ? billTaxDec
      : activeItemsTaxSum;

  if (hasSplitAllocatedSnapshot(bill.tax_snapshot)) {
    const hasItemSnapshot = activeItems.some(
      (item) => extractSnapshotEntries(item.tax_snapshot).present,
    );
    const splitSnapshot = extractSnapshotEntries(bill.tax_snapshot, {
      filterZeroSplitLines: !hasItemSnapshot,
    });
    if (splitSnapshot.present) {
      const legacyItems = activeItems.flatMap((item) => {
        const snap = extractSnapshotEntries(item.tax_snapshot);
        if (snap.present) return [];
        const legacy = extractItemLegacyEntries(item, taxDiscountRatioDec);
        if (legacy.length > 0) return legacy;
        const itemTax = decimalOrNull(item.tax_amount);
        if (itemTax && !itemTax.isZero()) {
          return [
            {
              title: 'Unknown',
              rate: null,
              taxableBase: null,
              amount: itemTax,
              sharedBase: false,
              incompleteDetail: true,
            },
          ];
        }
        return [];
      });
      const combined = [...splitSnapshot.entries, ...legacyItems];
      const docResiduals = shouldExtractDocumentResiduals(combined, effectiveTargetTax)
        ? extractDocumentLegacyResidualEntries(bill.tax_breakdown, combined)
        : [];
      return reconcileBillTaxEntries([...combined, ...docResiduals], effectiveTargetTax);
    }
  }

  if (activeItems.length > 0) {
    const itemEntries: HistoricalTaxEntry[] = [];
    let hasSnapshotEvidence = false;
    let hasLegacyBreakdownEvidence = false;

    for (const item of activeItems) {
      const snap = extractSnapshotEntries(item.tax_snapshot);
      if (snap.present) {
        hasSnapshotEvidence = true;
        itemEntries.push(...snap.entries);
        continue;
      }
      const legacy = extractItemLegacyEntries(item, taxDiscountRatioDec);
      if (legacy.length > 0) {
        hasLegacyBreakdownEvidence = true;
        itemEntries.push(...legacy);
        continue;
      }
      const itemTax = decimalOrNull(item.tax_amount);
      if (itemTax && !itemTax.isZero()) {
        itemEntries.push({
          title: 'Unknown',
          rate: null,
          taxableBase: null,
          amount: itemTax,
          sharedBase: false,
          incompleteDetail: true,
        });
      }
    }

    if (hasSnapshotEvidence || hasLegacyBreakdownEvidence) {
      const chargeSnapshot = extractSnapshotEntries(bill.tax_snapshot, {
        onlyChargeSnapshots: true,
      });
      const chargeEntries = chargeSnapshot.present ? chargeSnapshot.entries : [];
      const coveredEntries = [...itemEntries, ...chargeEntries];
      const docResiduals = shouldExtractDocumentResiduals(coveredEntries, effectiveTargetTax)
        ? extractDocumentLegacyResidualEntries(bill.tax_breakdown, coveredEntries)
        : [];
      const nonItemTotal = [...chargeEntries, ...docResiduals].reduce(
        (sum, e) => sum.plus(e.amount),
        new Decimal(0),
      );
      const itemTarget = effectiveTargetTax.minus(nonItemTotal);
      const itemSum = itemEntries.reduce((sum, e) => sum.plus(e.amount), new Decimal(0));
      const itemDiff = itemTarget.minus(itemSum);
      const adjustedItems =
        !itemSum.isZero() && !itemDiff.isZero() && itemDiff.abs().lte(MINOR_UNIT_ROUNDING_TOLERANCE)
          ? reconcileBillTaxEntries(itemEntries, itemTarget)
          : itemEntries;
      return reconcileBillTaxEntries(
        [...adjustedItems, ...chargeEntries, ...docResiduals],
        effectiveTargetTax,
      );
    }
  }

  const docSnapshot = extractSnapshotEntries(bill.tax_snapshot);
  if (docSnapshot.present) {
    const docResiduals = shouldExtractDocumentResiduals(docSnapshot.entries, effectiveTargetTax)
      ? extractDocumentLegacyResidualEntries(bill.tax_breakdown, docSnapshot.entries)
      : [];
    return reconcileBillTaxEntries([...docSnapshot.entries, ...docResiduals], effectiveTargetTax);
  }

  const docLegacy = extractDocumentLegacyResidualEntries(bill.tax_breakdown, []);
  return reconcileBillTaxEntries(docLegacy, effectiveTargetTax);
}

function aggregateDailyTaxRows(
  businessDate: string,
  entries: HistoricalTaxEntry[],
): DailySalesExportTaxRow[] {
  const merged = new Map<
    string,
    {
      title: string;
      rate: string | null;
      taxableBase: Decimal | null;
      amount: Decimal;
      sharedBase: boolean;
      incompleteDetail: boolean;
    }
  >();

  for (const entry of entries) {
    const normalizedRate =
      entry.rate === null ? null : new Decimal(entry.rate).toNumber().toString();
    const incomplete =
      entry.incompleteDetail || normalizedRate === null || entry.taxableBase === null;
    const key = `${entry.title}\u0000${normalizedRate ?? ''}\u0000${incomplete ? '1' : '0'}`;
    const existing = merged.get(key);
    if (existing) {
      existing.amount = existing.amount.plus(entry.amount);
      if (existing.taxableBase !== null && entry.taxableBase !== null && !incomplete) {
        existing.taxableBase = existing.taxableBase.plus(entry.taxableBase);
      } else {
        existing.taxableBase = null;
      }
      existing.sharedBase = existing.sharedBase || entry.sharedBase;
      existing.incompleteDetail = existing.incompleteDetail || incomplete;
    } else {
      merged.set(key, {
        title: entry.title,
        rate: normalizedRate,
        taxableBase: incomplete ? null : entry.taxableBase,
        amount: entry.amount,
        sharedBase: entry.sharedBase,
        incompleteDetail: incomplete,
      });
    }
  }

  return Array.from(merged.values())
    .filter(
      (group) =>
        !group.amount.isZero() || (group.taxableBase !== null && !group.taxableBase.isZero()),
    )
    .map((group) => {
      const taxAmount = group.amount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
      const taxableBase =
        group.incompleteDetail || group.taxableBase === null
          ? null
          : group.taxableBase.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
      const grossAmount =
        taxableBase === null
          ? null
          : group
              .taxableBase!.plus(group.amount)
              .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
              .toNumber();
      const taxRate = group.rate === null ? null : new Decimal(group.rate).toNumber();
      const sharedBase = Boolean(group.sharedBase && taxableBase !== null);
      const baseAdditive = !group.incompleteDetail && taxableBase !== null && !sharedBase;
      return {
        business_date: businessDate,
        tax_name: group.title,
        tax_rate: taxRate,
        taxable_base: taxableBase,
        tax_amount: taxAmount,
        gross_amount: grossAmount,
        shared_base: sharedBase,
        base_additive: baseAdditive,
        incomplete_detail: group.incompleteDetail,
        warning: group.incompleteDetail ? DAILY_SALES_TAX_INCOMPLETE_WARNING : '',
      };
    });
}

function finalizeItemRows(
  rawRows: RawItemAggregateRow[],
  fractionDigits: number,
): DailySalesExportItemRow[] {
  return rawRows.map((row) => {
    const knownQty = Number(row.known_cost_quantity || 0);
    const unknownQty = Number(row.unknown_cost_quantity || 0);
    const costStatus: DailySalesCostStatus =
      knownQty > 0 ? (unknownQty === 0 ? 'known' : 'partial') : 'unknown';
    let ingredientCost: number | null = null;
    let profit: number | null = null;
    let marginPercent: number | null = null;
    if (knownQty > 0) {
      ingredientCost = roundCurrencyCost(Number(row.known_ingredient_cost || 0), fractionDigits);
      const knownRev = roundCurrencyCost(
        Number(row.known_cost_net_item_sales || 0),
        fractionDigits,
      );
      profit = roundCurrencyCost(new Decimal(knownRev).minus(ingredientCost), fractionDigits);
      marginPercent =
        knownRev > 0
          ? new Decimal(profit)
              .div(knownRev)
              .mul(100)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
              .toNumber()
          : null;
    }
    return {
      product_id: String(row.product_id),
      product_name: String(row.product_name),
      product_sku: row.product_sku == null ? null : String(row.product_sku),
      quantity: Number(row.quantity || 0),
      gross_item_sales: Number(row.gross_item_sales || 0),
      item_discounts: Number(row.item_discounts || 0),
      net_item_sales: Number(row.net_item_sales || 0),
      tax_amount: Number(row.tax_amount || 0),
      ingredient_cost: ingredientCost,
      profit,
      margin_percent: marginPercent,
      cost_status: costStatus,
    };
  });
}

function computeProfitabilityMetrics(
  rawRows: RawItemAggregateRow[],
  fractionDigits: number,
): {
  known_cost_net_item_sales: number;
  ingredient_cost_total: number | null;
  gross_profit_total: number | null;
  gross_margin_percent: number | null;
  cost_coverage_status: DailySalesCostStatus;
} {
  const totalKnownQty = rawRows.reduce((sum, row) => sum + Number(row.known_cost_quantity || 0), 0);
  const totalUnknownQty = rawRows.reduce(
    (sum, row) => sum + Number(row.unknown_cost_quantity || 0),
    0,
  );
  const costCoverageStatus: DailySalesCostStatus =
    totalKnownQty > 0 ? (totalUnknownQty === 0 ? 'known' : 'partial') : 'unknown';
  const knownCostNetItemSales = roundCurrencyCost(
    rawRows.reduce(
      (sum, row) => sum.plus(Number(row.known_cost_net_item_sales || 0)),
      new Decimal(0),
    ),
    fractionDigits,
  );
  const ingredientCostTotal =
    totalKnownQty > 0
      ? roundCurrencyCost(
          rawRows.reduce(
            (sum, row) => sum.plus(Number(row.known_ingredient_cost || 0)),
            new Decimal(0),
          ),
          fractionDigits,
        )
      : null;
  const grossProfitTotal =
    ingredientCostTotal !== null
      ? roundCurrencyCost(
          new Decimal(knownCostNetItemSales).minus(ingredientCostTotal),
          fractionDigits,
        )
      : null;
  const grossMarginPercent =
    grossProfitTotal !== null && knownCostNetItemSales > 0
      ? new Decimal(grossProfitTotal)
          .div(knownCostNetItemSales)
          .mul(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toNumber()
      : null;

  return {
    known_cost_net_item_sales: knownCostNetItemSales,
    ingredient_cost_total: ingredientCostTotal,
    gross_profit_total: grossProfitTotal,
    gross_margin_percent: grossMarginPercent,
    cost_coverage_status: costCoverageStatus,
  };
}

/**
 * Normalized daily-sales export dataset for a single tenant business date or
 * an inclusive `[from, to]` business-date range (up to 93 days).
 *
 * Summary cash rules (approved contract):
 * - gross_collected / counts / charges / order-level discount: bills paid in window (`paid_at`)
 * - refunds_issued: refunds issued in window (`created_at`) - NOT attributed to the original pay day
 * - payment_method rows use paymentMethodBreakdown(paidOnly, refunds-by-created_at, keyByPaidAt)
 *   so Σ payment totals = net_collected
 *
 * Payments: every ledger line of the bills paid in window, so Σ amount = gross_collected.
 *
 * Items: products on paid bills (split via bill_items), excluding void/cancel/adjustment
 * rows so item refunds do not double-count against refunds_issued. Refunded originals stay
 * (they were collected); cash reversal lives only in Summary.refunds_issued.
 *
 * Taxes: per-tax-rate / component breakdown per business day reconstructed strictly from
 * stored historical bill/order/item tax snapshots and breakdowns (never current product tax
 * settings). Shared multi-component bases are marked non-additive (`shared_base=true`,
 * `base_additive=false`). Historical records without rate/base detail keep blank rate/base
 * and preserve stored tax_amount in reconciliation with an explicit warning.
 */
export function buildDailySalesExportDataset(
  input: DailySalesExportQueryInput,
  db: Database = getDatabase(),
): DailySalesExportDataset {
  const range = resolveDailySalesExportRange(input);
  const timezone = resolveExportTimezone();
  const businessDayStart = tenantBusinessDayStartTime(db);
  const currency = getTenantCurrency(db);
  const minorFactor = getCurrencyMinorUnitFactor(currency);
  const fractionDigits = getCurrencyFractionDigits(currency);

  const billAggStmt = db.prepare(`
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
  `);

  const refundAggStmt = db.prepare(`
    SELECT COALESCE(SUM(CAST(amount_cents AS REAL)) / ?, 0) AS refunds_issued
    FROM refunds
    WHERE created_at >= ? AND created_at < ?
  `);

  const billsStmt = db.prepare(`
    SELECT b.*
    FROM bills b
    WHERE b.paid_at >= ? AND b.paid_at < ?
    ORDER BY b.paid_at, b.id
  `);

  const itemsStmt = db.prepare(`
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
          END) AS tax_amount,
      SUM(CASE WHEN oi.ingredient_cost_known = 1 AND oi.ingredient_cost IS NOT NULL
               THEN (CASE WHEN b.split_group_id IS NULL OR b.split_group_id = '' THEN oi.quantity ELSE bi.quantity END)
               ELSE 0
          END) AS known_cost_quantity,
      SUM(CASE WHEN oi.ingredient_cost_known = 1 AND oi.ingredient_cost IS NOT NULL
               THEN 0
               ELSE (CASE WHEN b.split_group_id IS NULL OR b.split_group_id = '' THEN oi.quantity ELSE bi.quantity END)
          END) AS unknown_cost_quantity,
      SUM(CASE WHEN oi.ingredient_cost_known = 1 AND oi.ingredient_cost IS NOT NULL
               THEN (CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
                          THEN (oi.subtotal - CASE WHEN oi.tax_type = 'inclusive' THEN COALESCE(oi.tax_amount, 0) ELSE 0 END)
                          ELSE (oi.subtotal - CASE WHEN oi.tax_type = 'inclusive' THEN COALESCE(oi.tax_amount, 0) ELSE 0 END) * bi.quantity / NULLIF(oi.quantity, 0)
                     END)
               ELSE 0
          END) AS known_cost_net_item_sales,
      SUM(CASE WHEN oi.ingredient_cost_known = 1 AND oi.ingredient_cost IS NOT NULL
               THEN (CASE WHEN b.split_group_id IS NULL OR b.split_group_id = ''
                          THEN oi.ingredient_cost
                          ELSE oi.ingredient_cost * bi.quantity / NULLIF(oi.quantity, 0)
                     END)
               ELSE 0
          END) AS known_ingredient_cost
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
    WHERE b.paid_at >= ? AND b.paid_at < ?
      AND (oi.status IS NULL OR oi.status NOT IN ('cancelled', 'voided', 'void_adjustment'))
      AND (b.split_group_id IS NULL OR b.split_group_id = '' OR bi.bill_id IS NOT NULL)
    GROUP BY oi.product_id, oi.product_name, oi.product_sku
    ORDER BY net_item_sales DESC, product_name ASC
  `);

  const paymentLinesStmt = db.prepare(`
    SELECT
      b.bill_number AS bill_number,
      o.order_number AS order_number,
      COALESCE(NULLIF(json_extract(je.value, '$.timestamp'), ''), b.paid_at) AS payment_time,
      COALESCE(pm.name, NULLIF(json_extract(je.value, '$.method'), ''), 'unknown') AS method,
      json_extract(je.value, '$.amount') AS amount,
      json_extract(je.value, '$.transaction_id') AS transaction_id
    FROM bills b
    LEFT JOIN orders o ON o.id = b.order_id
    JOIN json_each(CASE
      WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
        THEN b.payment_details
      WHEN json_valid(b.payment_details)
        THEN json_array(b.payment_details)
      ELSE '[]'
    END) je
    LEFT JOIN payment_methods pm
      ON pm.id = CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER)
    WHERE b.paid_at >= ? AND b.paid_at < ?
      AND json_type(je.value) = 'object'
    ORDER BY payment_time, b.id, je.key
  `);

  const daily: DailySalesExportDayRow[] = [];
  const taxes: DailySalesExportTaxRow[] = [];
  const payments: DailySalesExportPaymentLineRow[] = [];
  const periodItemMap = new Map<
    string,
    {
      product_id: string;
      product_name: string;
      product_sku: string | null;
      quantity: Decimal;
      gross_item_sales: Decimal;
      item_discounts: Decimal;
      net_item_sales: Decimal;
      tax_amount: Decimal;
      known_cost_quantity: Decimal;
      unknown_cost_quantity: Decimal;
      known_cost_net_item_sales: Decimal;
      known_ingredient_cost: Decimal;
    }
  >();
  const paymentMethodTotals = new Map<string, Decimal>();

  let totalOrderCount = 0;
  let totalPaidBillCount = 0;
  let totalGrossCollected = new Decimal(0);
  let totalRefundsIssued = new Decimal(0);
  let totalTax = new Decimal(0);
  let totalDiscount = new Decimal(0);
  let totalServiceCharge = new Decimal(0);
  let totalPackagingCharge = new Decimal(0);
  let totalDeliveryCharge = new Decimal(0);

  type PaidBillTaxRow = {
    id: number;
    tax_amount?: number | null;
    tax_snapshot?: unknown;
    tax_breakdown?: unknown;
  };

  for (const businessDate of range.dates) {
    const [start, end] = dayBoundsInTimezone(businessDate, timezone, businessDayStart);

    const billRow = billAggStmt.get(start, end) as {
      paid_bill_count: number;
      order_count: number;
      gross_collected: number;
      order_discount_total: number;
      service_charge_total: number;
      packaging_charge_total: number;
      delivery_charge_total: number;
    };

    const refundRow = refundAggStmt.get(minorFactor, start, end) as { refunds_issued: number };

    const bills = billsStmt.all(start, end) as PaidBillTaxRow[];
    const orders = getOrdersWithItemsForBills(db, bills);
    const dayTaxEntries: HistoricalTaxEntry[] = [];
    for (const bill of bills) {
      dayTaxEntries.push(
        ...resolveBillHistoricalTaxEntries(
          bill,
          orders.get(Number(bill.id)) as
            | {
                subtotal?: number | null;
                discount_amount?: number | null;
                items?: Array<Record<string, unknown>>;
              }
            | undefined,
        ),
      );
    }
    const dayTaxRows = aggregateDailyTaxRows(businessDate, dayTaxEntries);
    taxes.push(...dayTaxRows);
    const dayTaxTotalDec = dayTaxRows.reduce(
      (sum, row) => sum.plus(row.tax_amount),
      new Decimal(0),
    );
    const dayTaxTotal = dayTaxTotalDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();

    const dayRawItems = itemsStmt.all(start, end) as RawItemAggregateRow[];
    for (const row of dayRawItems) {
      const key = `${row.product_id}\u0000${row.product_name}\u0000${row.product_sku ?? ''}`;
      const existing = periodItemMap.get(key);
      if (existing) {
        existing.quantity = existing.quantity.plus(Number(row.quantity || 0));
        existing.gross_item_sales = existing.gross_item_sales.plus(
          Number(row.gross_item_sales || 0),
        );
        existing.item_discounts = existing.item_discounts.plus(Number(row.item_discounts || 0));
        existing.net_item_sales = existing.net_item_sales.plus(Number(row.net_item_sales || 0));
        existing.tax_amount = existing.tax_amount.plus(Number(row.tax_amount || 0));
        existing.known_cost_quantity = existing.known_cost_quantity.plus(
          Number(row.known_cost_quantity || 0),
        );
        existing.unknown_cost_quantity = existing.unknown_cost_quantity.plus(
          Number(row.unknown_cost_quantity || 0),
        );
        existing.known_cost_net_item_sales = existing.known_cost_net_item_sales.plus(
          Number(row.known_cost_net_item_sales || 0),
        );
        existing.known_ingredient_cost = existing.known_ingredient_cost.plus(
          Number(row.known_ingredient_cost || 0),
        );
      } else {
        periodItemMap.set(key, {
          product_id: String(row.product_id),
          product_name: String(row.product_name),
          product_sku: row.product_sku == null ? null : String(row.product_sku),
          quantity: new Decimal(Number(row.quantity || 0)),
          gross_item_sales: new Decimal(Number(row.gross_item_sales || 0)),
          item_discounts: new Decimal(Number(row.item_discounts || 0)),
          net_item_sales: new Decimal(Number(row.net_item_sales || 0)),
          tax_amount: new Decimal(Number(row.tax_amount || 0)),
          known_cost_quantity: new Decimal(Number(row.known_cost_quantity || 0)),
          unknown_cost_quantity: new Decimal(Number(row.unknown_cost_quantity || 0)),
          known_cost_net_item_sales: new Decimal(Number(row.known_cost_net_item_sales || 0)),
          known_ingredient_cost: new Decimal(Number(row.known_ingredient_cost || 0)),
        });
      }
    }

    const dayProfitability = computeProfitabilityMetrics(dayRawItems, fractionDigits);
    const dayItemDiscountsDec = dayRawItems.reduce(
      (sum, row) => sum.plus(Number(row.item_discounts || 0)),
      new Decimal(0),
    );
    const dayGrossDec = new Decimal(Number(billRow.gross_collected || 0));
    const dayRefundsDec = new Decimal(Number(refundRow.refunds_issued || 0));
    const dayNetDec = dayGrossDec.minus(dayRefundsDec);
    const dayDiscountDec = new Decimal(Number(billRow.order_discount_total || 0)).plus(
      dayItemDiscountsDec,
    );
    const dayServiceChargeDec = new Decimal(Number(billRow.service_charge_total || 0));
    const dayPackagingChargeDec = new Decimal(Number(billRow.packaging_charge_total || 0));
    const dayDeliveryChargeDec = new Decimal(Number(billRow.delivery_charge_total || 0));
    const dayOrderCount = Number(billRow.order_count || 0);
    const dayPaidBillCount = Number(billRow.paid_bill_count || 0);

    daily.push({
      business_date: businessDate,
      order_count: dayOrderCount,
      paid_bill_count: dayPaidBillCount,
      gross_collected: dayGrossDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      refunds_issued: dayRefundsDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      net_collected: dayNetDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      tax_total: dayTaxTotal,
      discount_total: dayDiscountDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      service_charge_total: dayServiceChargeDec
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      packaging_charge_total: dayPackagingChargeDec
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      delivery_charge_total: dayDeliveryChargeDec
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      known_cost_net_item_sales: dayProfitability.known_cost_net_item_sales,
      ingredient_cost_total: dayProfitability.ingredient_cost_total,
      gross_profit_total: dayProfitability.gross_profit_total,
      gross_margin_percent: dayProfitability.gross_margin_percent,
      cost_coverage_status: dayProfitability.cost_coverage_status,
    });

    totalOrderCount += dayOrderCount;
    totalPaidBillCount += dayPaidBillCount;
    totalGrossCollected = totalGrossCollected.plus(dayGrossDec);
    totalRefundsIssued = totalRefundsIssued.plus(dayRefundsDec);
    totalTax = totalTax.plus(dayTaxTotalDec);
    totalDiscount = totalDiscount.plus(dayDiscountDec);
    totalServiceCharge = totalServiceCharge.plus(dayServiceChargeDec);
    totalPackagingCharge = totalPackagingCharge.plus(dayPackagingChargeDec);
    totalDeliveryCharge = totalDeliveryCharge.plus(dayDeliveryChargeDec);

    const dayPaymentMethods = paymentMethodBreakdown(db, {
      startDate: businessDate,
      endDate: businessDate,
      paidOnly: true,
      attributeRefundsToBillDate: false,
      keyByPaidAt: true,
    });
    for (const row of dayPaymentMethods) {
      const method = String(row.method || 'unknown');
      paymentMethodTotals.set(
        method,
        (paymentMethodTotals.get(method) || new Decimal(0)).plus(Number(row.total || 0)),
      );
    }

    const paymentLineRows = paymentLinesStmt.all(start, end) as Array<{
      bill_number: string | null;
      order_number: string | null;
      payment_time: string | null;
      method: string;
      amount: unknown;
      transaction_id: unknown;
    }>;
    for (const row of paymentLineRows) {
      payments.push({
        bill_number: row.bill_number == null ? '' : String(row.bill_number),
        order_number: row.order_number == null ? '' : String(row.order_number),
        payment_time: row.payment_time ? storeLocalTimestamp(row.payment_time, timezone) : '',
        method: String(row.method),
        amount: typeof row.amount === 'number' ? row.amount : 0,
        transaction_id: typeof row.transaction_id === 'string' ? row.transaction_id : '',
      });
    }
  }

  const periodRawItems: RawItemAggregateRow[] = Array.from(periodItemMap.values())
    .map((item) => ({
      product_id: item.product_id,
      product_name: item.product_name,
      product_sku: item.product_sku,
      quantity: item.quantity.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      gross_item_sales: item.gross_item_sales.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      item_discounts: item.item_discounts.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      net_item_sales: item.net_item_sales.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      tax_amount: item.tax_amount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      known_cost_quantity: item.known_cost_quantity
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      unknown_cost_quantity: item.unknown_cost_quantity
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      known_cost_net_item_sales: item.known_cost_net_item_sales.toNumber(),
      known_ingredient_cost: item.known_ingredient_cost.toNumber(),
    }))
    .sort((a, b) => {
      if (b.net_item_sales !== a.net_item_sales) return b.net_item_sales - a.net_item_sales;
      return a.product_name.localeCompare(b.product_name);
    });

  const items = finalizeItemRows(periodRawItems, fractionDigits);
  const periodProfitability = computeProfitabilityMetrics(periodRawItems, fractionDigits);
  const paymentMethods: DailySalesExportPaymentRow[] = Array.from(paymentMethodTotals.entries())
    .map(([method, totalDec]) => ({
      method,
      total: totalDec.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
    }))
    .sort((a, b) => b.total - a.total);

  const hasIncompleteTaxDetail = taxes.some((row) => row.incomplete_detail);

  const grossCollected = totalGrossCollected.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
  const refundsIssued = totalRefundsIssued.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber();
  const netCollected = totalGrossCollected
    .minus(totalRefundsIssued)
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
    .toNumber();

  return {
    summary: {
      business_date: range.isSingleDay ? range.fromDate : `${range.fromDate}..${range.toDate}`,
      from_date: range.fromDate,
      to_date: range.toDate,
      day_count: range.dates.length,
      timezone,
      business_day_start: businessDayStart,
      currency,
      order_count: totalOrderCount,
      paid_bill_count: totalPaidBillCount,
      gross_collected: grossCollected,
      refunds_issued: refundsIssued,
      net_collected: netCollected,
      tax_total: totalTax.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      discount_total: totalDiscount.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      service_charge_total: totalServiceCharge.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber(),
      packaging_charge_total: totalPackagingCharge
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      delivery_charge_total: totalDeliveryCharge
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toNumber(),
      known_cost_net_item_sales: periodProfitability.known_cost_net_item_sales,
      ingredient_cost_total: periodProfitability.ingredient_cost_total,
      gross_profit_total: periodProfitability.gross_profit_total,
      gross_margin_percent: periodProfitability.gross_margin_percent,
      cost_coverage_status: periodProfitability.cost_coverage_status,
      tax_detail_complete: !hasIncompleteTaxDetail,
      tax_detail_warning: hasIncompleteTaxDetail ? DAILY_SALES_SUMMARY_TAX_WARNING : null,
      payment_methods: paymentMethods,
    },
    daily,
    taxes,
    items,
    payments,
  };
}

/** Flat metric/value rows for the Summary sheet / summary CSV (stable field order). */
export function dailySalesSummaryMetricRows(
  summary: DailySalesExportSummary,
): Array<{ metric: string; value: string | number }> {
  const rows: Array<{ metric: string; value: string | number }> = [
    { metric: 'business_date', value: summary.business_date },
    { metric: 'from_date', value: summary.from_date },
    { metric: 'to_date', value: summary.to_date },
    { metric: 'day_count', value: summary.day_count },
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
    { metric: 'known_cost_net_item_sales', value: summary.known_cost_net_item_sales },
    { metric: 'ingredient_cost_total', value: summary.ingredient_cost_total ?? '' },
    { metric: 'gross_profit_total', value: summary.gross_profit_total ?? '' },
    { metric: 'gross_margin_percent', value: summary.gross_margin_percent ?? '' },
    { metric: 'cost_coverage_status', value: summary.cost_coverage_status },
    { metric: 'tax_detail_complete', value: summary.tax_detail_complete ? 'true' : 'false' },
    { metric: 'tax_detail_warning', value: summary.tax_detail_warning ?? '' },
  ];
  for (const payment of summary.payment_methods) {
    rows.push({
      metric: `payment_${dailySalesPaymentMetricKey(payment.method)}`,
      value: payment.total,
    });
  }
  return rows;
}

export const DAILY_SALES_DAILY_COLUMNS = [
  'business_date',
  'order_count',
  'paid_bill_count',
  'gross_collected',
  'refunds_issued',
  'net_collected',
  'tax_total',
  'discount_total',
  'service_charge_total',
  'packaging_charge_total',
  'delivery_charge_total',
  'known_cost_net_item_sales',
  'ingredient_cost_total',
  'gross_profit_total',
  'gross_margin_percent',
  'cost_coverage_status',
] as const;

export const DAILY_SALES_TAX_COLUMNS = [
  'business_date',
  'tax_name',
  'tax_rate',
  'taxable_base',
  'tax_amount',
  'gross_amount',
  'shared_base',
  'base_additive',
  'incomplete_detail',
  'warning',
] as const;

export const DAILY_SALES_ITEM_COLUMNS = [
  'product_id',
  'product_name',
  'product_sku',
  'quantity',
  'gross_item_sales',
  'item_discounts',
  'net_item_sales',
  'tax_amount',
  'ingredient_cost',
  'profit',
  'margin_percent',
  'cost_status',
] as const;

export const DAILY_SALES_PAYMENT_COLUMNS = [
  'bill_number',
  'order_number',
  'payment_time',
  'method',
  'amount',
  'transaction_id',
] as const;
