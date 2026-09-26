import { getDatabase } from '../db';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  type ChargeTaxContext,
  type Customer,
  type TaxBreakdown,
  type TaxRollup,
  type TenantInfo,
} from './tax';
import { TERMINAL_ITEM_STATUSES } from '../../shared/order-item-status';

type Database = ReturnType<typeof getDatabase>;
type OrderItemRow = {
  subtotal: number | null;
  tax_amount: number | null;
  tax_type: string | null;
  tax_breakdown: string | null;
  tax_snapshot: string | null;
};

export interface OrderTotals {
  subtotal: number;
  totalTax: number;
  exclusiveTax: number;
  allTaxBreakdowns: TaxBreakdown[][];
  allTaxSnapshots: (string | null)[];
  activeItems: OrderItemRow[];
}

export function calculateOrderTotals(db: Database, orderId: string | number): OrderTotals {
  const statusPlaceholders = TERMINAL_ITEM_STATUSES.map(() => '?').join(', ');
  const activeItems = db.prepare(`SELECT * FROM order_items WHERE order_id = ? AND (status IS NULL OR status NOT IN (${statusPlaceholders}))`)
    .all(orderId, ...TERMINAL_ITEM_STATUSES) as OrderItemRow[];
  let subtotal = 0;
  let totalTax = 0;
  let exclusiveTax = 0;
  const allTaxBreakdowns: TaxBreakdown[][] = [];
  const allTaxSnapshots: (string | null)[] = [];

  for (const item of activeItems) {
    subtotal += item.subtotal || 0;
    totalTax += item.tax_amount || 0;
    if (item.tax_type !== 'inclusive') {
      exclusiveTax += item.tax_amount || 0;
    }
    if (item.tax_breakdown) {
      try {
        const breakdown = JSON.parse(item.tax_breakdown);
        if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
      } catch { }
    }
    allTaxSnapshots.push(item.tax_snapshot || null);
  }

  return { subtotal, totalTax, exclusiveTax, allTaxBreakdowns, allTaxSnapshots, activeItems };
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
}

/**
 * Single home for the order-total recomputation that every order-item mutation
 * used to repeat: deduct the order-level discount from the subtotal, rescale
 * item tax to the discounted share, add charge tax, add the charges, round to
 * the currency. Every total, breakdown and snapshot written by a mutation comes
 * from here.
 */
export function recomputeOrderTotals(input: RecomputeOrderTotalsInput): RecomputedOrderTotals {
  const { tenantInfo, chargeContext, customer, totals, discountAmount, taxScaling } = input;
  const decimals = getCurrencyFractionDigits(tenantInfo.currency || '');
  const minorFactor = getCurrencyMinorUnitFactor(tenantInfo.currency || '');
  const subtotal = totals.subtotal;
  // The discount can never exceed the subtotal it is deducted from, so a
  // caller-supplied figure cannot drive the discounted share outside 0..1.
  const effectiveDiscount = Math.max(0, Math.min(discountAmount, subtotal));
  const discountedSubtotal = Math.max(0, subtotal - effectiveDiscount);

  let taxRatio = 1;
  let taxAmount = totals.totalTax;
  let exclusiveTaxAmount = totals.exclusiveTax;
  if (taxScaling === 'always' || (discountAmount > 0 && subtotal > 0)) {
    taxRatio = subtotal > 0 ? discountedSubtotal / subtotal : 1;
    taxAmount = Number((totals.totalTax * taxRatio).toFixed(decimals));
    exclusiveTaxAmount = Number((totals.exclusiveTax * taxRatio).toFixed(decimals));
  }

  const taxRollup = combineItemAndChargeTaxes({
    itemTaxAmount: taxAmount,
    itemExclusiveTaxAmount: exclusiveTaxAmount,
    itemBreakdowns: totals.allTaxBreakdowns,
    itemSnapshots: totals.allTaxSnapshots,
    itemTaxRatio: taxRatio,
    chargeTaxes: calculateConfiguredChargeTaxes(tenantInfo, chargeContext, customer),
    minorFactor,
  });

  const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
    + Number(chargeContext.delivery_charge || 0) + Number(chargeContext.packaging_charge || 0) + Number(chargeContext.service_charge || 0);
  return {
    subtotal,
    discountedSubtotal,
    taxRatio,
    taxAmount,
    exclusiveTaxAmount,
    taxRollup,
    total: Number(preRoundTotal.toFixed(decimals)),
    roundOff: 0,
  };
}
