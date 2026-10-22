import Decimal from 'decimal.js';
import { getDatabase, now } from '../db';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import {
  allocateDocumentTaxRounding,
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  computeDiscountTaxRatio,
  rollupOrderTaxes,
  type ChargeTaxContext,
  type ChargeTaxSummary,
  type Customer,
  type TaxBreakdown,
  type TaxRollup,
  type TenantInfo,
} from './tax';
import { isTerminalItemStatus } from '../../shared/order-item-status';
import {
  ChargeValidationError,
  toStandardChargeColumns,
  type AppliedCharge,
} from '../../shared/charges';

type Database = ReturnType<typeof getDatabase>;
type OrderItemRow = {
  id?: number | string;
  order_id?: number | string;
  product_id?: number | string | null;
  product_name?: string | null;
  unit_price?: number | string | null;
  quantity?: number | null;
  subtotal: number | null;
  tax_amount: number | null;
  tax_type: string | null;
  tax_breakdown: string | null;
  tax_snapshot: string | null;
  total?: number | null;
  status?: string | null;
};

export interface OrderTotals {
  subtotal: number;
  totalTax: number;
  exclusiveTax: number;
  allTaxBreakdowns: TaxBreakdown[][];
  allTaxSnapshots: (string | null)[];
  activeItems: OrderItemRow[];
  db?: Database;
}

export function calculateOrderTotals(db: Database, orderId: string | number): OrderTotals {
  const allItems = db
    .prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid ASC`)
    .all(orderId) as OrderItemRow[];
  const activeItems = allItems.filter(
    (item) =>
      item.status === null || item.status === undefined || !isTerminalItemStatus(item.status),
  );

  let subtotalDec = new Decimal(0);
  let totalTaxDec = new Decimal(0);
  let exclusiveTaxDec = new Decimal(0);
  const allTaxBreakdowns: TaxBreakdown[][] = [];
  const allTaxSnapshots: (string | null)[] = [];

  for (const item of activeItems) {
    subtotalDec = subtotalDec.plus(item.subtotal || 0);
    totalTaxDec = totalTaxDec.plus(item.tax_amount || 0);
    if (item.tax_type !== 'inclusive') {
      exclusiveTaxDec = exclusiveTaxDec.plus(item.tax_amount || 0);
    }
    if (item.tax_breakdown) {
      try {
        const breakdown = JSON.parse(item.tax_breakdown);
        if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
      } catch {}
    }
    allTaxSnapshots.push(item.tax_snapshot || null);
  }

  return {
    subtotal: subtotalDec.toNumber(),
    totalTax: totalTaxDec.toNumber(),
    exclusiveTax: exclusiveTaxDec.toNumber(),
    allTaxBreakdowns,
    allTaxSnapshots,
    activeItems,
    db,
  };
}

export type RecomputeOrderTotalsInput = {
  tenantInfo: TenantInfo;
  /** Row the packaging/delivery/service charges are read from, for charge tax and the total. */
  chargeContext: ChargeTaxContext;
  customer: Customer | null;
  /**
   * Fresh per-item sums from `calculateOrderTotals`. Its `subtotal` is the only
   * basis the discount and the rescaling are computed from: the tax being
   * rescaled is a sum over these same items, so a basis describing any other set
   * of items produces a ratio that is not defensible.
   */
  totals: OrderTotals;
  /** Effective order-level discount, already resolved by the caller. */
  discountAmount: number;
  /**
   * `when-discounted` rescale and round item tax only when a discount applies;
   * `always` rescale and round it regardless. The order sites use the former and
   * the bill discount site the latter, which is why the flag exists.
   */
  taxScaling: 'when-discounted' | 'always';
  /**
   * Charges the unified engine resolved for this order. When present, the
   * standard ids are projected onto the dedicated charge columns instead of the
   * row's own amounts, and non-standard charges are added to the total so
   * nothing is dropped from what the customer owes.
   */
  appliedCharges?: AppliedCharge[] | null;
  /** Standard columns resolved from current definitions and retained snapshots. */
  chargeColumnOverrides?: { service_charge?: number; packaging_charge?: number };
};

export interface RecomputedOrderTotals {
  /** The subtotal the discount was deducted from: always the fresh item sum. */
  subtotal: number;
  discountedSubtotal: number;
  taxRatio: number;
  /** Item tax after the discount share is applied. */
  taxAmount: number;
  exclusiveTaxAmount: number;
  taxRollup: TaxRollup;
  /** Exact total, before any payable (settlement) rounding. */
  total: number;
  roundOff: 0;
  /** Charges the engine applied; null when the merchant configured none. */
  appliedCharges: AppliedCharge[] | null;
  /** Charge amounts projected onto the dedicated columns. */
  chargeColumns: { service_charge: number; packaging_charge: number } | null;
}

/** Recomputes document taxes, discounts, charges, and totals for order mutations. */
export function recomputeOrderTotals(input: RecomputeOrderTotalsInput): RecomputedOrderTotals {
  const { tenantInfo, chargeContext, customer, totals, discountAmount, taxScaling } = input;
  const decimals = getCurrencyFractionDigits(tenantInfo.currency || '');
  const minorFactor = getCurrencyMinorUnitFactor(tenantInfo.currency || '');

  // Engine charges own the standard columns only for ids the merchant actually
  // configured; a manually entered service charge survives when there is no
  // engine charge behind that id.
  const hasAppliedCharges = Array.isArray(input.appliedCharges);
  const appliedCharges = hasAppliedCharges ? (input.appliedCharges as AppliedCharge[]) : [];
  const chargeColumns = hasAppliedCharges
    ? toStandardChargeColumns(appliedCharges, decimals)
    : null;
  const engineOwns = (id: string) => appliedCharges.some((charge) => charge.id === id);
  // Only non-standard charges are added here: the standard ids are already
  // summed through effectiveChargeContext, so adding them again would double count.
  const otherCharges = chargeColumns ? chargeColumns.other_charges : 0;
  const effectiveChargeContext: ChargeTaxContext = {
    ...chargeContext,
    packaging_charge:
      input.chargeColumnOverrides?.packaging_charge ??
      (engineOwns('packaging_charge')
        ? chargeColumns!.packaging_charge
        : chargeContext.packaging_charge),
    service_charge:
      input.chargeColumnOverrides?.service_charge ??
      (engineOwns('service_charge') ? chargeColumns!.service_charge : chargeContext.service_charge),
  };
  const subtotal = totals.subtotal;
  const subtotalDec = new Decimal(subtotal);
  // The discount can never exceed the subtotal it is deducted from, so a
  // caller-supplied figure cannot drive the discounted share outside 0..1.
  const effectiveDiscountDec = Decimal.max(
    0,
    Decimal.min(new Decimal(discountAmount || 0), subtotalDec),
  );
  const discountedSubtotalDec = Decimal.max(0, subtotalDec.minus(effectiveDiscountDec));
  const discountedSubtotal = discountedSubtotalDec.toNumber();

  let chargeTaxes: ChargeTaxSummary = {
    taxAmount: 0,
    exclusiveTaxAmount: 0,
    breakdowns: [],
    snapshotJson: [],
  };

  if (tenantInfo.taxes_enabled) {
    chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, effectiveChargeContext, customer);
    const activeItems = totals.activeItems || [];
    const undiscountedAlloc = allocateDocumentTaxRounding({
      items: activeItems.map((item, idx) => ({
        snapshot: item.tax_snapshot,
        lineIdOverride: `line-${String(idx + 1).padStart(4, '0')}:${item.id}`,
      })),
      chargeTaxes,
      currency: tenantInfo.currency || '',
    });
    chargeTaxes = undiscountedAlloc.chargeTaxes;

    activeItems.forEach((item, idx) => {
      const out = undiscountedAlloc.itemOutputs[idx];
      if (!out?.handled) return;
      const itemSub = Number(item.subtotal || 0);
      const lineTaxNum = out.taxAmount;
      const newSnapshotJson = out.snapshotJson!;
      const newBreakdownJson = JSON.stringify(out.breakdown);
      const newItemTotal = Number(
        (itemSub + (item.tax_type === 'inclusive' ? 0 : lineTaxNum)).toFixed(decimals),
      );

      if (
        item.tax_amount !== lineTaxNum ||
        item.total !== newItemTotal ||
        item.tax_snapshot !== newSnapshotJson ||
        item.tax_breakdown !== newBreakdownJson
      ) {
        if (totals.db && item.id) {
          totals.db
            .prepare(
              `UPDATE order_items
               SET tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, tax_type = ?, total = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              lineTaxNum,
              newBreakdownJson,
              newSnapshotJson,
              item.tax_type,
              newItemTotal,
              now(),
              item.id,
            );
        }
        item.tax_amount = lineTaxNum;
        item.tax_breakdown = newBreakdownJson;
        item.tax_snapshot = newSnapshotJson;
        item.total = newItemTotal;
      }
    });
  }

  const applyDiscountScaling =
    taxScaling === 'always' || (effectiveDiscountDec.gt(0) && subtotalDec.gt(0));
  const taxRatioDec =
    applyDiscountScaling && subtotalDec.gt(0)
      ? computeDiscountTaxRatio(discountedSubtotalDec, subtotalDec)
      : new Decimal(1);
  const taxRatio = taxRatioDec.toNumber();

  let taxAmount: number;
  let exclusiveTaxAmount: number;
  let taxRollup: TaxRollup;

  if (totals.activeItems && totals.activeItems.length > 0) {
    const rolled = rollupOrderTaxes({
      items: totals.activeItems.map((item, idx) => {
        let parsedBreakdown: TaxBreakdown[] | null = null;
        if (item.tax_breakdown) {
          try {
            const b = JSON.parse(item.tax_breakdown);
            if (Array.isArray(b) && b.length > 0) parsedBreakdown = b;
          } catch {}
        }
        return {
          taxAmount: item.tax_amount || 0,
          taxType: item.tax_type,
          breakdown: parsedBreakdown,
          snapshot: item.tax_snapshot || null,
          lineIdOverride: `line-${String(idx + 1).padStart(4, '0')}:${item.id}`,
        };
      }),
      chargeTaxes,
      currency: tenantInfo.currency || '',
      decimals,
      minorFactor,
      itemTaxRatio: taxRatioDec,
      taxesEnabled: tenantInfo.taxes_enabled,
    });
    taxAmount = rolled.itemTaxAmount;
    exclusiveTaxAmount = rolled.itemExclusiveTaxAmount;
    taxRollup = rolled.taxRollup;
  } else {
    taxAmount = applyDiscountScaling
      ? new Decimal(totals.totalTax)
          .mul(taxRatioDec)
          .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
          .toNumber()
      : totals.totalTax;
    exclusiveTaxAmount = applyDiscountScaling
      ? new Decimal(totals.exclusiveTax)
          .mul(taxRatioDec)
          .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
          .toNumber()
      : totals.exclusiveTax;
    taxRollup = combineItemAndChargeTaxes({
      itemTaxAmount: taxAmount,
      itemExclusiveTaxAmount: exclusiveTaxAmount,
      itemBreakdowns: totals.allTaxBreakdowns,
      itemSnapshots: totals.allTaxSnapshots,
      itemTaxRatio: taxRatioDec,
      chargeTaxes,
      minorFactor,
    });
  }

  const preRoundTotal = discountedSubtotalDec
    .plus(taxRollup.exclusiveTaxAmount)
    .plus(effectiveChargeContext.delivery_charge || 0)
    .plus(effectiveChargeContext.packaging_charge || 0)
    .plus(effectiveChargeContext.service_charge || 0)
    .plus(otherCharges);
  const total = preRoundTotal.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(Math.round(total * minorFactor))) {
    throw new ChargeValidationError('Order total exceeds the supported currency precision');
  }
  return {
    subtotal,
    discountedSubtotal,
    taxRatio,
    taxAmount,
    exclusiveTaxAmount,
    taxRollup,
    total,
    roundOff: 0,
    appliedCharges: hasAppliedCharges ? appliedCharges : null,
    chargeColumns: chargeColumns
      ? {
          service_charge: chargeColumns.service_charge,
          packaging_charge: chargeColumns.packaging_charge,
        }
      : null,
  };
}
