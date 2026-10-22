import Decimal from 'decimal.js';
import { getDatabase, now } from '../db';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  type ChargeTaxContext,
  type ChargeTaxSummary,
  type Customer,
  type TaxBreakdown,
  type TaxRollup,
  type TenantInfo,
} from './tax';
import { canonical, roundPlaces } from './tax-engine';
import type { RoundingMethod } from '../tax-packs/types';
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
    chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, effectiveChargeContext, customer);

    interface SnapshotComponent {
      ruleId: string;
      amount: string;
      roundingRemainder?: string;
      rate?: string;
      amountPer?: string;
      label?: string;
    }

    interface SnapshotLine {
      lineId: string;
      grossAmount?: string;
      taxAmount?: string;
      taxableBase?: string;
      components: SnapshotComponent[];
      categoryId?: string;
      taxBehavior?: string;
    }

    interface SnapshotData {
      packId?: string;
      packVersion?: string;
      currency?: string;
      taxRounding?: {
        scope: string;
        method: RoundingMethod;
        decimalPlaces: number;
        remainderAllocation?: string;
      };
      lines?: SnapshotLine[];
    }

    interface GroupComponentEntry {
      comp: SnapshotComponent;
      raw: Decimal;
      rounded: Decimal;
      remainder: Decimal;
      line: SnapshotLine;
      item?: OrderItemRow;
      chargeIndex?: number;
    }

    interface DocumentGroup {
      taxRounding: {
        scope: string;
        method: RoundingMethod;
        decimalPlaces: number;
        remainderAllocation?: string;
      };
      currency?: string;
      components: GroupComponentEntry[];
      affectedItems: Set<OrderItemRow>;
      affectedChargeIndices: Set<number>;
    }

    const groups = new Map<string, DocumentGroup>();
    const itemSnapshots = new Map<OrderItemRow, SnapshotData>();
    const chargeSnapshots = new Map<number, SnapshotData>();

    if (totals.activeItems && totals.activeItems.length > 0) {
      totals.activeItems.forEach((item, idx) => {
        if (!item.tax_snapshot) return;
        let snap: SnapshotData | null = null;
        try {
          snap =
            typeof item.tax_snapshot === 'string'
              ? JSON.parse(item.tax_snapshot)
              : item.tax_snapshot;
        } catch {
          return;
        }
        if (
          snap?.taxRounding?.scope !== 'document' ||
          !Array.isArray(snap.lines) ||
          snap.lines.length === 0
        ) {
          return;
        }

        itemSnapshots.set(item, snap);
        const line = snap.lines[0];
        const lineId = `line-${String(idx + 1).padStart(4, '0')}:${item.id}`;
        line.lineId = lineId;

        const taxRoundingKey = JSON.stringify(snap.taxRounding);
        const groupKey = `${snap.packId}\0${taxRoundingKey}`;

        let group = groups.get(groupKey);
        if (!group) {
          group = {
            taxRounding: snap.taxRounding,
            currency: snap.currency,
            components: [],
            affectedItems: new Set(),
            affectedChargeIndices: new Set(),
          };
          groups.set(groupKey, group);
        }

        group.affectedItems.add(item);
        for (const comp of line.components || []) {
          const raw = new Decimal(comp.amount).plus(comp.roundingRemainder || '0');
          group.components.push({
            comp,
            raw,
            rounded: new Decimal(0),
            remainder: new Decimal(0),
            line,
            item,
          });
        }
      });
    }

    if (chargeTaxes.snapshotJson && chargeTaxes.snapshotJson.length > 0) {
      chargeTaxes.snapshotJson.forEach((snapJson, cIdx) => {
        let snap: SnapshotData | null = null;
        try {
          snap = JSON.parse(snapJson);
        } catch {
          return;
        }
        if (
          snap?.taxRounding?.scope !== 'document' ||
          !Array.isArray(snap.lines) ||
          snap.lines.length === 0
        ) {
          return;
        }

        chargeSnapshots.set(cIdx, snap);
        const line = snap.lines[0];
        const taxRoundingKey = JSON.stringify(snap.taxRounding);
        const groupKey = `${snap.packId}\0${taxRoundingKey}`;

        let group = groups.get(groupKey);
        if (!group) {
          group = {
            taxRounding: snap.taxRounding,
            currency: snap.currency,
            components: [],
            affectedItems: new Set(),
            affectedChargeIndices: new Set(),
          };
          groups.set(groupKey, group);
        }

        group.affectedChargeIndices.add(cIdx);
        for (const comp of line.components || []) {
          const raw = new Decimal(comp.amount).plus(comp.roundingRemainder || '0');
          group.components.push({
            comp,
            raw,
            rounded: new Decimal(0),
            remainder: new Decimal(0),
            line,
            chargeIndex: cIdx,
          });
        }
      });
    }

    for (const group of groups.values()) {
      const places = getCurrencyFractionDigits(tenantInfo.currency || group.currency || '');
      const quantum = new Decimal(10).pow(-places);
      const sumRaw = group.components.reduce((sum, c) => sum.plus(c.raw), new Decimal(0));
      const target = roundPlaces(sumRaw, places, group.taxRounding.method);

      for (const entry of group.components) {
        entry.rounded = entry.raw.toDecimalPlaces(places, Decimal.ROUND_FLOOR);
        entry.remainder = entry.raw.minus(entry.rounded);
      }

      const sumRounded = group.components.reduce((sum, c) => sum.plus(c.rounded), new Decimal(0));
      let units = target.minus(sumRounded).div(quantum).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

      const ordered = [...group.components].sort((left, right) => {
        const remainderOrder = right.remainder.comparedTo(left.remainder);
        if (remainderOrder !== 0) return remainderOrder;
        const ruleOrder = left.comp.ruleId.localeCompare(right.comp.ruleId);
        if (ruleOrder !== 0) return ruleOrder;
        return left.line.lineId.localeCompare(right.line.lineId);
      });

      let uIndex = 0;
      while (units.gt(0) && ordered.length > 0) {
        const entry = ordered[uIndex % ordered.length];
        entry.rounded = entry.rounded.plus(quantum);
        units = units.minus('1');
        uIndex += 1;
      }

      for (const entry of group.components) {
        entry.comp.amount = entry.rounded.toFixed(places);
        entry.comp.roundingRemainder = canonical(entry.raw.minus(entry.rounded));
      }

      for (const item of group.affectedItems) {
        const snap = itemSnapshots.get(item);
        if (!snap || !Array.isArray(snap.lines) || snap.lines.length === 0) continue;
        const line = snap.lines[0];
        const lineTax = (line.components || []).reduce(
          (sum: Decimal, c) => sum.plus(new Decimal(c.amount)),
          new Decimal(0),
        );
        line.taxAmount = lineTax.toFixed(places);
        const itemSub = Number(item.subtotal || 0);

        const lineTaxNum = lineTax.toNumber();
        const breakdown = (line.components || []).map((c) => ({
          title: c.label || '',
          rate: Number(c.rate || 0),
          amount: Number(c.amount),
        }));
        const newSnapshotJson = JSON.stringify(snap);
        const newBreakdownJson = JSON.stringify(breakdown);
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
      }

      for (const cIdx of group.affectedChargeIndices) {
        const snap = chargeSnapshots.get(cIdx);
        if (!snap || !Array.isArray(snap.lines) || snap.lines.length === 0) continue;
        const line = snap.lines[0];
        const lineTax = (line.components || []).reduce(
          (sum: Decimal, c) => sum.plus(new Decimal(c.amount)),
          new Decimal(0),
        );
        line.taxAmount = lineTax.toFixed(places);
        chargeTaxes.snapshotJson[cIdx] = JSON.stringify(snap);
        chargeTaxes.breakdowns[cIdx] = (line.components || []).map((c) => ({
          title: c.label || '',
          rate: Number(c.rate || 0),
          amount: Number(c.amount),
        }));
      }
    }

    if (chargeTaxes.snapshotJson && chargeTaxes.snapshotJson.length > 0) {
      let chargeTaxAmount = new Decimal(0);
      let chargeExclusiveTaxAmount = new Decimal(0);
      for (const snapStr of chargeTaxes.snapshotJson) {
        try {
          const cSnap = JSON.parse(snapStr);
          for (const cLine of cSnap.lines || []) {
            const lTax = new Decimal(cLine.taxAmount || '0');
            chargeTaxAmount = chargeTaxAmount.plus(lTax);
            if (cLine.taxBehavior !== 'inclusive') {
              chargeExclusiveTaxAmount = chargeExclusiveTaxAmount.plus(lTax);
            }
          }
        } catch {}
      }
      chargeTaxes.taxAmount = chargeTaxAmount.toNumber();
      chargeTaxes.exclusiveTaxAmount = chargeExclusiveTaxAmount.toNumber();
    }
  }

  if (totals.activeItems && totals.activeItems.length > 0) {
    let freshTotalTax = 0;
    let freshExclusiveTax = 0;
    const freshTaxBreakdowns: TaxBreakdown[][] = [];
    const freshTaxSnapshots: (string | null)[] = [];

    for (const item of totals.activeItems) {
      freshTotalTax += item.tax_amount || 0;
      if (item.tax_type !== 'inclusive') {
        freshExclusiveTax += item.tax_amount || 0;
      }
      if (item.tax_breakdown) {
        try {
          const b = JSON.parse(item.tax_breakdown);
          if (Array.isArray(b) && b.length > 0) freshTaxBreakdowns.push(b);
        } catch {}
      }
      freshTaxSnapshots.push(item.tax_snapshot || null);
    }
    baseTotalTax = freshTotalTax;
    baseExclusiveTax = freshExclusiveTax;
    baseTaxBreakdowns = freshTaxBreakdowns;
    baseTaxSnapshots = freshTaxSnapshots;
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
