import { getDatabase } from '../db';
import type { TaxBreakdown } from './tax';
import { TERMINAL_ITEM_STATUSES } from './refund';

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
