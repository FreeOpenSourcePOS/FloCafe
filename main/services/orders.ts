import { getDatabase, now } from '../db';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import {
  calculateDocumentTaxes,
  combineItemAndChargeTaxes,
  type ChargeTaxContext,
  type ChargeTaxSummary,
  type Customer,
  type Product,
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
  chargeTaxes?: ChargeTaxSummary;
  itemsForCalculation?: Array<{ lineId: string; product: Product; taxableAmount: number }>;
  db?: Database;
}

export function calculateOrderTotals(
  db: Database,
  orderId: string | number,
  _callerChargeContext?: ChargeTaxContext | null,
): OrderTotals {
  const allItems = db
    .prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid ASC`)
    .all(orderId) as OrderItemRow[];
  const activeItems = allItems.filter(
    (item) =>
      item.status === null || item.status === undefined || !isTerminalItemStatus(item.status),
  );

  const itemsForCalculation: Array<{ lineId: string; product: Product; taxableAmount: number }> =
    activeItems.map((item, idx) => {
      let snapshotLine: {
        categoryId?: string;
        taxBehavior?: Product['tax_behavior'];
        product_category_id?: string;
        product_category?: string;
      } | null = null;
      if (item.tax_snapshot) {
        try {
          const parsed =
            typeof item.tax_snapshot === 'string'
              ? JSON.parse(item.tax_snapshot)
              : item.tax_snapshot;
          if (Array.isArray(parsed?.lines) && parsed.lines.length > 0) {
            snapshotLine = parsed.lines[0];
          }
        } catch {}
      }

      const product = item.product_id
        ? (db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as
            | Product
            | undefined)
        : null;

      const hasExistingSnapshot = Boolean(item.tax_snapshot);
      const productForTax: Product = {
        id: undefined, // Do not consult current overrides for existing lines
        tax_type: hasExistingSnapshot ? (item.tax_type || product?.tax_type || 'none') : 'none',
        tax_rate: product?.tax_rate || 0,
        tax_category_id: hasExistingSnapshot ? (snapshotLine?.categoryId || undefined) : undefined,
        tax_behavior: hasExistingSnapshot
          ? (snapshotLine?.taxBehavior ?? product?.tax_behavior ?? 'country_default')
          : 'country_default',
      };

      return {
        lineId: `line-${String(idx + 1).padStart(4, '0')}:${item.id}`,
        product: productForTax,
        taxableAmount: item.subtotal || 0,
      };
    });

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
      } catch {}
    }
    allTaxSnapshots.push(item.tax_snapshot || null);
  }

  return {
    subtotal,
    totalTax,
    exclusiveTax,
    allTaxBreakdowns,
    allTaxSnapshots,
    activeItems,
    itemsForCalculation,
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
  // The discount can never exceed the subtotal it is deducted from, so a
  // caller-supplied figure cannot drive the discounted share outside 0..1.
  const effectiveDiscount = Math.max(0, Math.min(discountAmount, subtotal));
  const discountedSubtotal = Math.max(0, subtotal - effectiveDiscount);

  let chargeTaxes: ChargeTaxSummary = {
    taxAmount: 0,
    exclusiveTaxAmount: 0,
    breakdowns: [],
    snapshotJson: [],
  };
  let baseTotalTax = totals.totalTax;
  let baseExclusiveTax = totals.exclusiveTax;
  let baseTaxBreakdowns = totals.allTaxBreakdowns;
  let baseTaxSnapshots = totals.allTaxSnapshots;

  if (tenantInfo.taxes_enabled) {
    const hasItems = Boolean(totals.itemsForCalculation && totals.itemsForCalculation.length > 0);
    const hasCharges =
      Number(effectiveChargeContext.packaging_charge || 0) > 0 ||
      Number(effectiveChargeContext.service_charge || 0) > 0 ||
      Number(effectiveChargeContext.delivery_charge || 0) > 0;

    if (hasItems || hasCharges) {
      const { itemResults: taxResults, chargeTaxes: docChargeTaxes } = calculateDocumentTaxes(
        tenantInfo,
        {
          items: totals.itemsForCalculation || [],
          chargeContext: effectiveChargeContext,
          customer,
        },
      );
      chargeTaxes = docChargeTaxes;

      if (hasItems && totals.activeItems) {
        if (totals.db) {
          const updateItemStmt = totals.db.prepare(`
            UPDATE order_items
            SET tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, tax_type = ?, total = ?, updated_at = ?
            WHERE id = ?
          `);
          for (let idx = 0; idx < totals.activeItems.length; idx++) {
            const item = totals.activeItems[idx];
            if (!item.tax_snapshot) continue;
            const taxResult = taxResults[idx];
            if (!taxResult) continue;
            const newSnapshotJson = taxResult.tax_snapshot
              ? JSON.stringify(taxResult.tax_snapshot)
              : null;
            const newBreakdownJson = JSON.stringify(taxResult.tax_breakdown);
            const sub = item.subtotal || 0;
            const newItemTotal = Number(
              (sub + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount)).toFixed(
                decimals,
              ),
            );
            if (
              item.tax_amount !== taxResult.tax_amount ||
              item.tax_type !== taxResult.tax_type ||
              item.total !== newItemTotal ||
              item.tax_snapshot !== newSnapshotJson ||
              item.tax_breakdown !== newBreakdownJson
            ) {
              updateItemStmt.run(
                taxResult.tax_amount,
                newBreakdownJson,
                newSnapshotJson,
                taxResult.tax_type,
                newItemTotal,
                now(),
                item.id,
              );
              item.tax_amount = taxResult.tax_amount;
              item.tax_breakdown = newBreakdownJson;
              item.tax_snapshot = newSnapshotJson;
              item.tax_type = taxResult.tax_type;
              item.total = newItemTotal;
            }
          }
        }

        let freshTotalTax = 0;
        let freshExclusiveTax = 0;
        const freshTaxBreakdowns: TaxBreakdown[][] = [];
        const freshTaxSnapshots: (string | null)[] = [];

        for (let idx = 0; idx < totals.activeItems.length; idx++) {
          const item = totals.activeItems[idx];
          const taxResult = taxResults[idx];
          if (item.tax_snapshot && taxResult) {
            freshTotalTax += taxResult.tax_amount || 0;
            if (taxResult.tax_type !== 'inclusive') {
              freshExclusiveTax += taxResult.tax_amount || 0;
            }
            if (taxResult.tax_breakdown && taxResult.tax_breakdown.length > 0) {
              freshTaxBreakdowns.push(taxResult.tax_breakdown);
            }
            freshTaxSnapshots.push(
              taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null,
            );
          } else {
            freshTotalTax += item.tax_amount || 0;
            if (item.tax_type !== 'inclusive') {
              freshExclusiveTax += item.tax_amount || 0;
            }
            if (item.tax_breakdown) {
              try {
                const b = JSON.parse(item.tax_breakdown);
                if (Array.isArray(b)) freshTaxBreakdowns.push(b);
              } catch {}
            }
            freshTaxSnapshots.push(item.tax_snapshot || null);
          }
        }
        baseTotalTax = freshTotalTax;
        baseExclusiveTax = freshExclusiveTax;
        baseTaxBreakdowns = freshTaxBreakdowns;
        baseTaxSnapshots = freshTaxSnapshots;
      }
    }
  }

  let taxRatio = 1;
  let taxAmount = baseTotalTax;
  let exclusiveTaxAmount = baseExclusiveTax;
  if (taxScaling === 'always' || (discountAmount > 0 && subtotal > 0)) {
    taxRatio = subtotal > 0 ? discountedSubtotal / subtotal : 1;
    taxAmount = Number((baseTotalTax * taxRatio).toFixed(decimals));
    exclusiveTaxAmount = Number((baseExclusiveTax * taxRatio).toFixed(decimals));
  }

  const taxRollup = combineItemAndChargeTaxes({
    itemTaxAmount: taxAmount,
    itemExclusiveTaxAmount: exclusiveTaxAmount,
    itemBreakdowns: baseTaxBreakdowns,
    itemSnapshots: baseTaxSnapshots,
    itemTaxRatio: taxRatio,
    chargeTaxes,
    minorFactor,
  });

  const preRoundTotal =
    discountedSubtotal +
    taxRollup.exclusiveTaxAmount +
    Number(effectiveChargeContext.delivery_charge || 0) +
    Number(effectiveChargeContext.packaging_charge || 0) +
    Number(effectiveChargeContext.service_charge || 0) +
    otherCharges;
  const total = Number(preRoundTotal.toFixed(decimals));
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
