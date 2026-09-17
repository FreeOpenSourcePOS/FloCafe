import { getDatabase, getSettingValue } from '../db';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  type TaxBreakdown,
} from './tax';
import { TERMINAL_ITEM_STATUSES, getTenantCurrency } from './refund';

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

export interface RecalculatedOrderTotals {
  activeItems: OrderItemRow[];
  subtotal: number;
  discountAmount: number;
  discountedSubtotal: number;
  taxAmount: number;
  exclusiveTax: number;
  taxRollup: ReturnType<typeof combineItemAndChargeTaxes>;
  preRoundTotal: number;
  roundOff: number;
  total: number;
  currency: string;
  country: string;
}

export function recalculateOrderTotals(
  db: Database,
  order: any,
  options?: { discountAmount?: number; scaleProportionally?: boolean },
): RecalculatedOrderTotals {
  const {
    activeItems,
    subtotal,
    totalTax,
    exclusiveTax,
    allTaxBreakdowns,
    allTaxSnapshots,
  } = calculateOrderTotals(db, order.id);

  const currency = getTenantCurrency(db);
  const decimals = getCurrencyFractionDigits(currency);
  const minorFactor = getCurrencyMinorUnitFactor(currency);

  let discountAmount = 0;
  if (options?.discountAmount !== undefined) {
    discountAmount = options.discountAmount;
  } else {
    const existingDiscountAmount = order.discount_amount || 0;
    discountAmount = existingDiscountAmount;
    if (existingDiscountAmount > 0 && order.subtotal > 0) {
      if (order.discount_type === 'percentage') {
        const pct = order.discount_value || 0;
        discountAmount = Number((subtotal * pct / 100).toFixed(decimals));
      } else if (options?.scaleProportionally) {
        discountAmount = Number((existingDiscountAmount * (subtotal / order.subtotal)).toFixed(decimals));
      }
    }
  }

  const discountedSubtotal = Math.max(0, subtotal - discountAmount);
  let newTaxAmount = totalTax;
  let newExclusiveTax = exclusiveTax;
  let taxRatio = 1;
  if (discountAmount > 0 && subtotal > 0) {
    taxRatio = discountedSubtotal / subtotal;
    newTaxAmount = Number((totalTax * taxRatio).toFixed(decimals));
    newExclusiveTax = Number((exclusiveTax * taxRatio).toFixed(decimals));
  }

  const tenantInfo = {
    country: getSettingValue('country') || 'IN',
    business_type: getSettingValue('business_type') || 'restaurant',
    state_code: getSettingValue('state_code') || '',
    currency,
    taxes_enabled: getSettingValue('taxes_enabled') === 'true',
  };

  const customer = order.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) as any
    : null;

  const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, order, customer);
  const taxRollup = combineItemAndChargeTaxes({
    itemTaxAmount: newTaxAmount,
    itemExclusiveTaxAmount: newExclusiveTax,
    itemBreakdowns: allTaxBreakdowns,
    itemSnapshots: allTaxSnapshots,
    itemTaxRatio: taxRatio,
    chargeTaxes,
    minorFactor,
  });

  const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
    + (order.delivery_charge || 0) + (order.packaging_charge || 0) + (order.service_charge || 0);
  const roundOff = 0;
  const total = Number(preRoundTotal.toFixed(decimals));

  return {
    activeItems,
    subtotal,
    discountAmount,
    discountedSubtotal,
    taxAmount: taxRollup.taxAmount,
    exclusiveTax: taxRollup.exclusiveTaxAmount,
    taxRollup,
    preRoundTotal,
    roundOff,
    total,
    currency,
    country: tenantInfo.country,
  };
}
