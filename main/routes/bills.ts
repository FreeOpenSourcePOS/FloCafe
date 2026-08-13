import { createHash, randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import {
  attachEffectiveAddons,
  utcDayBounds,
  generateBillNumber,
  getDatabase,
  getSettingValue,
  now,
  parseItemJson,
  parseRowJson,
  utcTodayDate,
  verifyPin,
  withTxn,
} from '../db';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { printReceipt } from '../services/receipt';
import { requireRole } from '../middleware/security';
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  getActiveCountryPack,
} from '../services/tax';
import { applyPayableRounding } from '../services/tax-engine';
import { sendEvent } from '../services/telemetry';

const router = Router();

function getOrderWithItems(db: ReturnType<typeof getDatabase>, orderId: number, billId?: number): any {
  const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  if (!order) return order;
  const allocations = billId === undefined ? [] : db.prepare('SELECT order_item_id, quantity FROM bill_items WHERE bill_id = ?').all(billId) as any[];
  const allocated = new Map(allocations.map((row) => [Number(row.order_item_id), Number(row.quantity)]));
  const itemRows = (db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[])
    .filter((item) => allocations.length === 0 || allocated.has(Number(item.id)))
    .map((item) => {
      const quantity = allocated.get(Number(item.id));
      if (quantity === undefined || quantity === Number(item.quantity)) return item;
      const ratio = quantity / Number(item.quantity);
      return { ...item, quantity, subtotal: Number((Number(item.subtotal) * ratio).toFixed(2)), tax_amount: Number((Number(item.tax_amount || 0) * ratio).toFixed(2)), total: Number((Number(item.total) * ratio).toFixed(2)) };
    });
  return {
    ...order,
    items: attachEffectiveAddons(db, itemRows.map(parseItemJson)),
  };
}

// Fixed conversion rate for redeeming loyalty wallet points as payment (points per 1 currency unit).
const LOYALTY_REDEMPTION_RATE = 100;

// Rate limiting for PIN validation (simple in-memory)
const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkPinRateLimit(key: string): boolean {
  const nowMs = Date.now();
  if (pinAttempts.size > 500) {
    for (const [k, v] of pinAttempts.entries()) {
      if (nowMs > v.resetAt) pinAttempts.delete(k);
    }
  }
  const entry = pinAttempts.get(key);
  if (!entry || nowMs > entry.resetAt) {
    pinAttempts.set(key, { count: 1, resetAt: nowMs + PIN_WINDOW_MS });
    return true;
  }
  if (entry.count >= PIN_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

function parsePaginationInteger(value: unknown, defaultValue: number): number | null {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (Array.isArray(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

router.get('/', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM bills WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as count FROM bills WHERE 1=1';
    const params: any[] = [];

    if (req.query.status) {
      query += ' AND payment_status = ?';
      countQuery += ' AND payment_status = ?';
      params.push(req.query.status);
    }
    if (req.query.order_id) {
      query += ' AND order_id = ?';
      countQuery += ' AND order_id = ?';
      params.push(req.query.order_id);
    }
    if (req.query.customer_id) {
      query += ' AND customer_id = ?';
      countQuery += ' AND customer_id = ?';
      params.push(req.query.customer_id);
    }
    if (req.query.today === 'true') {
      // #208: UTC-day range hits `idx_bills_created_at` instead of date() on every row.
      const [s, e] = utcDayBounds(utcTodayDate());
      query += ' AND created_at >= ? AND created_at < ?';
      countQuery += ' AND created_at >= ? AND created_at < ?';
      params.push(s, e);
    }

    // #208: default page size of 50 and a hard cap even when clients omit
    // per_page — the previous "unbounded" default could return every bill
    // ever when a caller left the param off.
    const requestedLimit = parsePaginationInteger(req.query.per_page ?? req.query.limit, 50);
    if (requestedLimit === null || requestedLimit < 1) {
      return res.status(400).json({ error: 'per_page must be a positive integer' });
    }
    const limit = Math.min(requestedLimit, 500);
    const offset = parsePaginationInteger(req.query.offset, 0);
    if (offset === null || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    const pageParams = [...params, limit, offset];

    const bills = db.prepare(query).all(...pageParams).map(parseRowJson);
    const total = Number((db.prepare(countQuery).get(...params) as any)?.count || 0);
    res.json({
      bills,
      pagination: {
        limit,
        per_page: limit,
        offset,
        total,
        next_offset: offset + bills.length < total ? offset + bills.length : null,
        has_more: offset + bills.length < total,
      },
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const bill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id));
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const order = getOrderWithItems(db, (bill as any).order_id, Number((bill as any).id));
    const customer = (bill as any).customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get((bill as any).customer_id) : null;

    res.json({ bill: { ...bill, order, customer } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get bill by order ID
router.get('/order/:orderId', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const bill = parseRowJson(db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.orderId));
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found for this order' });
    }

    const order = getOrderWithItems(db, (bill as any).order_id, Number((bill as any).id));
    const customer = (bill as any).customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get((bill as any).customer_id) : null;

    res.json({ bill: { ...bill, order, customer } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/generate', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const result = withTxn(() => {
      const existingBill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(order_id) as any;
      if (existingBill) {
        if (existingBill.split_group_id) return { bill: parseRowJson(existingBill), isNew: false };
        // Re-sync bill totals from the order in case discount/adjustments were applied
        // after the bill was first generated (e.g. discount applied → then checkout clicked).
        // Only sync if the bill is still unpaid (partial or full payments must not be changed).
        const orderSubtotal      = order.subtotal        || 0;
        const orderTaxAmount     = order.tax_amount      || 0;
        const orderDiscountAmt   = order.discount_amount || 0;
        const orderDelivery      = order.delivery_charge || 0;
        const orderPackaging     = order.packaging_charge|| 0;
        const orderTotal         = order.total           || 0;

        const pack = getActiveCountryPack(getSettingValue('country') || 'IN');
        const { total: roundedOrderTotal, adjustment: orderRoundOff } = applyPayableRounding(orderTotal, pack);

        const totalsChanged =
          existingBill.payment_status !== 'paid' && (
            existingBill.discount_amount !== orderDiscountAmt ||
            existingBill.subtotal        !== orderSubtotal    ||
            existingBill.total           !== roundedOrderTotal
          );

        if (totalsChanged) {
          const newBalance = Math.max(0, roundedOrderTotal - (existingBill.paid_amount || 0));
          db.prepare(`
            UPDATE bills
            SET subtotal       = ?,
                tax_amount     = ?,
                tax_breakdown  = ?,
                tax_snapshot   = ?,
                discount_amount= ?,
                discount_type  = ?,
                discount_value = ?,
                discount_reason= ?,
                delivery_charge= ?,
                packaging_charge= ?,
                round_off      = ?,
                total          = ?,
                balance        = ?,
                updated_at     = ?
            WHERE id = ?
          `).run(
            orderSubtotal, orderTaxAmount, order.tax_breakdown, order.tax_snapshot,
            orderDiscountAmt, order.discount_type, order.discount_value, order.discount_reason,
            orderDelivery, orderPackaging, orderRoundOff,
            roundedOrderTotal, newBalance, now(),
            existingBill.id
          );

          const updated = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(existingBill.id));
          return { bill: updated, isNew: false };
        }

        return { bill: parseRowJson(existingBill), isNew: false };
      }

      // Generate bill number inside transaction to prevent race conditions
      const billNumber = generateBillNumber();
      const subtotal = order.subtotal || 0;
      const taxAmount = order.tax_amount || 0;
      const discountAmount = order.discount_amount || 0;
      const deliveryCharge = order.delivery_charge || 0;
      const packagingCharge = order.packaging_charge || 0;
      const pack = getActiveCountryPack(getSettingValue('country') || 'IN');
      const { total, adjustment: roundOff } = applyPayableRounding(order.total || 0, pack);

      const runResult = db.prepare(`
        INSERT INTO bills (bill_number, order_id, customer_id, subtotal, tax_amount, tax_breakdown, tax_snapshot,
          discount_amount, discount_type, discount_value, discount_reason,
          delivery_charge, packaging_charge, round_off, total, paid_amount, balance, payment_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?)
      `).run(
        billNumber, order_id, order.customer_id, subtotal, taxAmount, order.tax_breakdown, order.tax_snapshot,
        discountAmount, order.discount_type, order.discount_value, order.discount_reason,
        deliveryCharge, packagingCharge, roundOff, total, 0, total, now(), now()
      );

      const newBill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(runResult.lastInsertRowid));
      return { bill: newBill, isNew: true };
    });

    notifyOrderUpdated();
    res.status(result.isNew ? 201 : 200).json({ bill: result.bill });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

function allocateMinorUnits(sourceMinor: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const effectiveWeights = totalWeight === 0 ? Array(n).fill(1) : weights;
  const effectiveTotalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);

  const base: number[] = new Array(n);
  const remainders: { index: number; remainder: number }[] = new Array(n);
  let used = 0;

  for (let i = 0; i < n; i++) {
    const exact = (sourceMinor * effectiveWeights[i]) / effectiveTotalWeight;
    const b = Math.floor(exact);
    base[i] = b;
    used += b;
    remainders[i] = { index: i, remainder: exact - b };
  }

  let left = sourceMinor - used;
  remainders.sort((a, b) => {
    if (Math.abs(b.remainder - a.remainder) > 1e-9) {
      return b.remainder - a.remainder;
    }
    return a.index - b.index;
  });

  for (let i = 0; i < left; i++) {
    base[remainders[i].index] += 1;
  }

  return base;
}

// Tax snapshots may contain signed evidence for a historical adjustment. Keep
// allocateMinorUnits' non-negative contract unchanged and allocate the
// magnitude with the same largest-remainder ordering before restoring the sign.
function allocateSignedMinorUnits(sourceMinor: number, weights: number[]): number[] {
  const sign = sourceMinor < 0 ? -1 : 1;
  return allocateMinorUnits(Math.abs(sourceMinor), weights).map((minor) => minor * sign);
}

const SPLIT_TAX_SNAPSHOT_VERSION = 'minor-unit-v1';

function parseTaxSnapshot(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function snapshotMinorAmount(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function formatSnapshotMinorAmount(original: unknown, minor: number): string | number {
  const amount = minor / 100;
  return typeof original === 'string' ? amount.toFixed(2) : amount;
}

/**
 * Persist a child-specific copy of every tax snapshot. Snapshot amounts are
 * tax evidence, so allocate each component in integer minor units with the
 * same non-negative largest-remainder allocator used for bill totals.
 */
interface SnapshotTaxAllocation {
  original: unknown;
  allocations: number[];
  exclusive: boolean;
}

interface TaxSnapshotAllocationResult {
  snapshots: (string | null)[];
  taxMinors: number[] | null;
  exclusiveTaxMinors: number[] | null;
}

function reconcileSnapshotAllocations(
  entries: SnapshotTaxAllocation[],
  targets: number[],
): void {
  if (entries.length === 0 || targets.length === 0) return;
  const sums = targets.map((_, index) => entries.reduce(
    (sum, entry) => sum + entry.allocations[index],
    0,
  ));
  const deltas = targets.map((target, index) => target - sums[index]);

  while (true) {
    const deficitIndex = deltas.findIndex((delta) => delta > 0);
    const excessIndex = deltas.findIndex((delta) => delta < 0);
    if (deficitIndex === -1 || excessIndex === -1) return;

    const positiveEntry = entries.find((entry) => entry.allocations[excessIndex] > 0);
    if (positiveEntry) {
      positiveEntry.allocations[excessIndex] -= 1;
      positiveEntry.allocations[deficitIndex] += 1;
    } else {
      const negativeEntry = entries.find((entry) => entry.allocations[deficitIndex] < 0);
      if (!negativeEntry) return;
      negativeEntry.allocations[deficitIndex] += 1;
      negativeEntry.allocations[excessIndex] -= 1;
    }

    deltas[excessIndex] += 1;
    deltas[deficitIndex] -= 1;
  }
}

function allocateTaxSnapshotsWithTax(
  sourceRaw: unknown,
  weights: number[],
  snapshotWeights?: Array<number[] | null>,
  snapshotExclusions?: boolean[],
): TaxSnapshotAllocationResult {
  const parsed = parseTaxSnapshot(sourceRaw);
  const sourceText = typeof sourceRaw === 'string'
    ? sourceRaw
    : parsed === null || parsed === undefined ? null : JSON.stringify(parsed);
  const snapshots = Array.isArray(parsed) ? parsed : [parsed];
  const hasTaxSnapshots = snapshots.some((snapshot) => (
    snapshot && typeof snapshot === 'object' && Array.isArray((snapshot as any).lines)
  ));
  if (!hasTaxSnapshots) {
    return { snapshots: new Array(weights.length).fill(sourceText), taxMinors: null, exclusiveTaxMinors: null };
  }

  const sourceSnapshots = Array.isArray(parsed) ? parsed : [parsed];
  const entryByKey = new Map<string, SnapshotTaxAllocation>();
  const snapshotTaxMinors = new Array(weights.length).fill(0);
  const exclusiveTaxMinors = new Array(weights.length).fill(0);

  sourceSnapshots.forEach((sourceSnapshot: any, snapshotIndex: number) => {
    if (!sourceSnapshot || typeof sourceSnapshot !== 'object' || !Array.isArray(sourceSnapshot.lines)) return;
    if (snapshotExclusions?.[snapshotIndex]) return;
    const candidateWeights = snapshotWeights?.[snapshotIndex];
    const localWeights = Array.isArray(candidateWeights)
      && candidateWeights.length === weights.length
      ? candidateWeights
      : weights;
    const snapshotEntries: SnapshotTaxAllocation[] = [];

    sourceSnapshot.lines.forEach((sourceLine: any, lineIndex: number) => {
      if (!sourceLine || typeof sourceLine !== 'object') return;
      if (Array.isArray(sourceLine.components)) {
        const exclusive = sourceLine.taxBehavior !== 'inclusive' && sourceLine.taxBehavior !== 'exempt';
        sourceLine.components.forEach((sourceComponent: any, componentIndex: number) => {
          if (!sourceComponent || typeof sourceComponent !== 'object') return;
          const sourceMinor = snapshotMinorAmount(sourceComponent.amount);
          if (sourceMinor === null) return;
          const entry: SnapshotTaxAllocation = {
            original: sourceComponent.amount,
            allocations: allocateSignedMinorUnits(sourceMinor, localWeights),
            exclusive,
          };
          snapshotEntries.push(entry);
          entryByKey.set(`${snapshotIndex}:${lineIndex}:${componentIndex}`, entry);
        });
      } else {
        const sourceMinor = snapshotMinorAmount(sourceLine.taxAmount);
        if (sourceMinor !== null) {
          const entry: SnapshotTaxAllocation = {
            original: sourceLine.taxAmount,
            allocations: allocateSignedMinorUnits(sourceMinor, localWeights),
            exclusive: sourceLine.taxBehavior !== 'inclusive' && sourceLine.taxBehavior !== 'exempt',
          };
          snapshotEntries.push(entry);
          entryByKey.set(`${snapshotIndex}:${lineIndex}:taxAmount`, entry);
        }
      }
    });

    if (snapshotEntries.length > 0) {
      const snapshotTotal = snapshotEntries.reduce(
        (sum, entry) => sum + snapshotMinorAmount(entry.original)!,
        0,
      );
      reconcileSnapshotAllocations(
        snapshotEntries,
        allocateSignedMinorUnits(snapshotTotal, localWeights),
      );
      for (let childIndex = 0; childIndex < weights.length; childIndex += 1) {
        snapshotTaxMinors[childIndex] += snapshotEntries.reduce(
          (sum, entry) => sum + entry.allocations[childIndex],
          0,
        );
        exclusiveTaxMinors[childIndex] += snapshotEntries.reduce(
          (sum, entry) => sum + (entry.exclusive ? entry.allocations[childIndex] : 0),
          0,
        );
      }
    }
  });

  const childSnapshots = weights.map((_, childIndex) => {
    const childResult = JSON.parse(JSON.stringify(parsed));
    const childResultSnapshots = Array.isArray(childResult) ? childResult : [childResult];
    sourceSnapshots.forEach((sourceSnapshot: any, snapshotIndex: number) => {
      if (snapshotExclusions?.[snapshotIndex]) {
        childResultSnapshots[snapshotIndex] = null;
        return;
      }
      const childSnapshot = childResultSnapshots[snapshotIndex];
      if (!sourceSnapshot || !childSnapshot || !Array.isArray(sourceSnapshot.lines)) return;
      childSnapshot.splitAllocation = SPLIT_TAX_SNAPSHOT_VERSION;
      const candidateWeights = snapshotWeights?.[snapshotIndex];
      const localWeights = Array.isArray(candidateWeights)
        && candidateWeights.length === weights.length
        ? candidateWeights
        : weights;
      sourceSnapshot.lines.forEach((sourceLine: any, lineIndex: number) => {
        const line = childSnapshot.lines?.[lineIndex];
        if (!sourceLine || !line || typeof line !== 'object') return;
        for (const field of ['grossAmount', 'taxableBase'] as const) {
          const sourceMinor = snapshotMinorAmount(sourceLine[field]);
          if (sourceMinor !== null) {
            line[field] = formatSnapshotMinorAmount(
              sourceLine[field],
              allocateSignedMinorUnits(sourceMinor, localWeights)[childIndex],
            );
          }
        }
      });
    });
    sourceSnapshots.forEach((sourceSnapshot: any, snapshotIndex: number) => {
      if (!sourceSnapshot || typeof sourceSnapshot !== 'object' || !Array.isArray(sourceSnapshot.lines)) return;
      const resultSnapshot = childResultSnapshots[snapshotIndex];
      sourceSnapshot.lines.forEach((sourceLine: any, lineIndex: number) => {
        const resultLine = resultSnapshot?.lines?.[lineIndex];
        if (!sourceLine || !resultLine || typeof resultLine !== 'object') return;
        if (Array.isArray(sourceLine.components)) {
          let componentTotal = 0;
          let allComponentsAllocated = true;
          sourceLine.components.forEach((sourceComponent: any, componentIndex: number) => {
            const resultComponent = resultLine.components?.[componentIndex];
            const entry = entryByKey.get(`${snapshotIndex}:${lineIndex}:${componentIndex}`);
            if (!resultComponent || !entry) {
              allComponentsAllocated = false;
              return;
            }
            resultComponent.amount = formatSnapshotMinorAmount(entry.original, entry.allocations[childIndex]);
            componentTotal += entry.allocations[childIndex];
          });
          if (allComponentsAllocated) {
            resultLine.taxAmount = formatSnapshotMinorAmount(sourceLine.taxAmount, componentTotal);
          }
        } else {
          const entry = entryByKey.get(`${snapshotIndex}:${lineIndex}:taxAmount`);
          if (entry) resultLine.taxAmount = formatSnapshotMinorAmount(entry.original, entry.allocations[childIndex]);
        }
      });
    });
    return JSON.stringify(childResult);
  });

  return { snapshots: childSnapshots, taxMinors: snapshotTaxMinors, exclusiveTaxMinors };
}

export function allocateTaxSnapshots(
  sourceRaw: unknown,
  weights: number[],
  snapshotWeights?: Array<number[] | null>,
): (string | null)[] {
  return allocateTaxSnapshotsWithTax(sourceRaw, weights, snapshotWeights).snapshots;
}

function composeSplitTotals(
  allocations: Record<string, number[]>,
  exclusiveTaxMinors: number[],
): number[] {
  return allocations.subtotal.map((subtotal, index) => Number((
    subtotal
    - allocations.discountAmount[index]
    + exclusiveTaxMinors[index] / 100
    + allocations.deliveryCharge[index]
    + allocations.packagingCharge[index]
    + allocations.roundOff[index]
  ).toFixed(2)));
}

function allocateTaxBreakdown(
  sourceBreakdownRaw: any,
  checkTaxMinors: number[],
  weights: number[],
): (string | null)[] {
  const numChecks = weights.length;
  const parsed = typeof sourceBreakdownRaw === 'string'
    ? (() => { try { return JSON.parse(sourceBreakdownRaw); } catch { return null; } })()
    : sourceBreakdownRaw;

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return new Array(numChecks).fill(typeof sourceBreakdownRaw === 'string' ? sourceBreakdownRaw : JSON.stringify(sourceBreakdownRaw || null));
  }

  const isNested = Array.isArray(parsed[0]);

  interface TaxCompRef {
    outerIndex?: number;
    innerIndex: number;
    component: any;
    minorAmount: number;
  }

  const components: TaxCompRef[] = [];

  if (isNested) {
    parsed.forEach((outer: any, outerIndex: number) => {
      if (Array.isArray(outer)) {
        outer.forEach((comp: any, innerIndex: number) => {
          if (comp && typeof comp === 'object') {
            components.push({
              outerIndex,
              innerIndex,
              component: comp,
              minorAmount: Math.round(Number(comp.amount || 0) * 100),
            });
          }
        });
      }
    });
  } else {
    parsed.forEach((comp: any, innerIndex: number) => {
      if (comp && typeof comp === 'object') {
        components.push({
          innerIndex,
          component: comp,
          minorAmount: Math.round(Number(comp.amount || 0) * 100),
        });
      }
    });
  }

  if (components.length === 0) {
    return new Array(numChecks).fill(typeof sourceBreakdownRaw === 'string' ? sourceBreakdownRaw : JSON.stringify(sourceBreakdownRaw || null));
  }

  const compAllocations: number[][] = components.map((comp) => allocateMinorUnits(comp.minorAmount, weights));

  const checkCompSums = new Array(numChecks).fill(0);
  for (let m = 0; m < components.length; m++) {
    for (let k = 0; k < numChecks; k++) {
      checkCompSums[k] += compAllocations[m][k];
    }
  }

  const deltas = checkTaxMinors.map((target, k) => target - checkCompSums[k]);

  while (true) {
    const deficitIdx = deltas.findIndex((d) => d > 0);
    const excessIdx = deltas.findIndex((d) => d < 0);

    if (deficitIdx === -1 || excessIdx === -1) break;

    let transferredCompIdx = -1;
    for (let m = 0; m < components.length; m++) {
      if (compAllocations[m][excessIdx] > 0) {
        transferredCompIdx = m;
        break;
      }
    }

    if (transferredCompIdx === -1) break;

    compAllocations[transferredCompIdx][excessIdx] -= 1;
    compAllocations[transferredCompIdx][deficitIdx] += 1;

    deltas[excessIdx] += 1;
    deltas[deficitIdx] -= 1;
  }

  const result: (string | null)[] = [];

  for (let k = 0; k < numChecks; k++) {
    if (isNested) {
      const clonedNested = parsed.map((outer: any[], outerIdx: number) => {
        if (!Array.isArray(outer)) return outer;
        return outer.map((comp: any, innerIdx: number) => {
          const compIdx = components.findIndex((c) => c.outerIndex === outerIdx && c.innerIndex === innerIdx);
          const minor = compIdx !== -1 ? compAllocations[compIdx][k] : Math.round(Number(comp?.amount || 0) * 100);
          return {
            ...comp,
            amount: minor / 100,
          };
        });
      });
      result.push(JSON.stringify(clonedNested));
    } else {
      const clonedFlat = parsed.map((comp: any, innerIdx: number) => {
        const compIdx = components.findIndex((c) => c.innerIndex === innerIdx);
        const minor = compIdx !== -1 ? compAllocations[compIdx][k] : Math.round(Number(comp?.amount || 0) * 100);
        return {
          ...comp,
          amount: minor / 100,
        };
      });
      result.push(JSON.stringify(clonedFlat));
    }
  }

  return result;
}

interface OrderBillSyncValues {
  subtotal: number;
  taxAmount: number;
  taxBreakdown: string | null;
  taxSnapshot: string | null;
  discountAmount: number;
  deliveryCharge: number;
  packagingCharge: number;
  total: number;
}

function hasSnapshotLines(raw: unknown): boolean {
  const parsed = parseTaxSnapshot(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).some((snapshot) => (
    snapshot && typeof snapshot === 'object' && Array.isArray((snapshot as any).lines)
  ));
}

function hasSplitAllocatedSnapshot(raw: unknown): boolean {
  const parsed = parseTaxSnapshot(raw);
  if (Array.isArray(parsed)) return parsed.some(hasSplitAllocatedSnapshot);
  if (!parsed || typeof parsed !== 'object') return false;
  return (parsed as any).splitAllocation === SPLIT_TAX_SNAPSHOT_VERSION
    && Array.isArray((parsed as any).lines);
}

function getSplitBillAllocationWeights(
  db: ReturnType<typeof getDatabase>,
  orderId: number | string,
  bills: any[],
): { weights: number[]; snapshotWeights: Array<number[] | null>; snapshotExclusions: boolean[] } {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId) as any[];
  const billIds = bills.map((bill) => Number(bill.id));
  const billItems = billIds.length === 0
    ? []
    : db.prepare(`SELECT bill_id, order_item_id, quantity FROM bill_items WHERE bill_id IN (${billIds.map(() => '?').join(',')})`).all(...billIds) as any[];
  const quantities = new Map<number, Map<number, number>>();
  for (const row of billItems) {
    const byItem = quantities.get(Number(row.bill_id)) || new Map<number, number>();
    byItem.set(Number(row.order_item_id), Number(row.quantity));
    quantities.set(Number(row.bill_id), byItem);
  }

  const weights = bills.map((bill) => {
    const byItem = quantities.get(Number(bill.id)) || new Map<number, number>();
    return items
      .filter((item) => !['cancelled', 'voided', 'void_adjustment'].includes(item.status))
      .reduce((sum, item) => {
        const quantity = byItem.get(Number(item.id)) || 0;
        if (quantity <= 0 || Number(item.quantity) <= 0) return sum;
        return sum + Number(item.total || item.subtotal || 0) * quantity / Number(item.quantity);
      }, 0);
  });

  const snapshotItems = items
    .filter((item) => item.status !== 'cancelled' && hasSnapshotLines(item.tax_snapshot))
  const snapshotWeights = snapshotItems.map((item) => {
    if (['voided', 'void_adjustment'].includes(item.status)) return null;
    const itemWeights = bills.map((bill) => (
      quantities.get(Number(bill.id))?.get(Number(item.id)) || 0
    ));
    return itemWeights.some((weight) => weight > 0) ? itemWeights : weights;
  });
  const snapshotExclusions = snapshotItems.map((item) => ['voided', 'void_adjustment'].includes(item.status));

  return { weights, snapshotWeights, snapshotExclusions };
}

export function syncUnpaidBillsForOrder(
  db: ReturnType<typeof getDatabase>,
  orderId: number | string,
  source: OrderBillSyncValues,
  country: string,
): void {
  const bills = db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY id').all(orderId) as any[];
  const unpaidBills = bills.filter((bill) => bill.payment_status !== 'paid');
  if (unpaidBills.length === 0) return;

  const pack = getActiveCountryPack(country);
  const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(source.total, pack);
  const splitBills = bills.some((bill) => bill.split_group_id);

  if (!splitBills) {
    const update = db.prepare(`
      UPDATE bills SET subtotal = ?, total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?,
        discount_amount = ?, delivery_charge = ?, packaging_charge = ?, round_off = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const bill of unpaidBills) {
      update.run(
        source.subtotal, billTotal, Math.max(0, billTotal - Number(bill.paid_amount || 0)), source.taxAmount,
        source.taxBreakdown, source.taxSnapshot, source.discountAmount, source.deliveryCharge,
        source.packagingCharge, billRoundOff, now(), bill.id,
      );
    }
    return;
  }

  const { weights, snapshotWeights, snapshotExclusions } = getSplitBillAllocationWeights(db, orderId, bills);
  const fields = {
    subtotal: Math.round(source.subtotal * 100),
    taxAmount: Math.round(source.taxAmount * 100),
    discountAmount: Math.round(source.discountAmount * 100),
    deliveryCharge: Math.round(source.deliveryCharge * 100),
    packagingCharge: Math.round(source.packagingCharge * 100),
    roundOff: Math.round(billRoundOff * 100),
    total: Math.round(billTotal * 100),
  };
  const allocations = Object.fromEntries(Object.entries(fields).map(([field, value]) => [
    field,
    allocateMinorUnits(value, weights).map((minor) => minor / 100),
  ])) as Record<keyof typeof fields, number[]>;
  const allocatedTaxMinors = allocations.taxAmount.map((amount) => Math.round(amount * 100));
  const snapshotAllocation = allocateTaxSnapshotsWithTax(source.taxSnapshot, weights, snapshotWeights, snapshotExclusions);
  const sourceTaxMinor = Math.round(Number(source.taxAmount || 0) * 100);
  const snapshotTaxMinors = snapshotAllocation.taxMinors;
  const snapshotTaxMatches = snapshotTaxMinors !== null
    && snapshotTaxMinors.reduce((sum, minor) => sum + minor, 0) === sourceTaxMinor;
  const taxMinors = snapshotTaxMatches ? snapshotTaxMinors : allocatedTaxMinors;
  if (snapshotTaxMatches) {
    allocations.taxAmount = taxMinors.map((minor) => minor / 100);
    if (snapshotAllocation.exclusiveTaxMinors) {
      allocations.total = composeSplitTotals(allocations, snapshotAllocation.exclusiveTaxMinors);
    }
  }
  const breakdowns = allocateTaxBreakdown(source.taxBreakdown, taxMinors, weights);
  const snapshots = snapshotAllocation.snapshots;
  const update = db.prepare(`
    UPDATE bills SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?,
      delivery_charge = ?, packaging_charge = ?, round_off = ?, total = ?, balance = ?, updated_at = ?
    WHERE id = ?
  `);

  bills.forEach((bill, index) => {
    if (bill.payment_status === 'paid') return;
    const total = allocations.total[index];
    update.run(
      allocations.subtotal[index], allocations.taxAmount[index], breakdowns[index], snapshots[index],
      allocations.discountAmount[index], allocations.deliveryCharge[index], allocations.packagingCharge[index],
      allocations.roundOff[index], total, Math.max(0, total - Number(bill.paid_amount || 0)), now(), bill.id,
    );
  });
}

// Divide one unpaid dine-in bill into independently payable guest checks.
// The kitchen order and inventory rows remain singular; bill_items stores only
// the whole-unit quantity allocated to each resulting check.
router.post('/:id/split-check', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    if (getSettingValue('split_checks_enabled') !== 'true') return res.status(403).json({ error: 'Split checks are not enabled' });
    const checks = req.body?.checks;
    if (!Array.isArray(checks) || checks.length < 2 || checks.length > 20) return res.status(400).json({ error: 'Create between 2 and 20 guest checks' });

    const result = withTxn(() => {
      const txnSource = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id) as any;
      if (!txnSource) throw Object.assign(new Error('Bill not found'), { statusCode: 404 });
      const txnOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(txnSource.order_id) as any;
      if (txnOrder?.type !== 'dine_in') throw Object.assign(new Error('Only dine-in checks can be split'), { statusCode: 400 });
      if (txnSource.payment_status !== 'unpaid' || Number(txnSource.paid_amount || 0) !== 0 || txnSource.payment_details) {
        throw Object.assign(new Error('A check can only be split before any payment is recorded'), { statusCode: 409 });
      }
      if (txnSource.split_group_id || Number((db.prepare('SELECT COUNT(*) AS n FROM bills WHERE order_id = ?').get(txnSource.order_id) as any).n) > 1) {
        throw Object.assign(new Error('This check has already been split'), { statusCode: 409 });
      }
      const txnActiveItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment') ORDER BY id").all(txnSource.order_id) as any[];
      const txnItemById = new Map(txnActiveItems.map((item) => [Number(item.id), item]));
      const txnAssigned = new Map<number, number>();

      const txnNormalized = checks.map((check: any, index: number) => {
        const label = String(check?.label || `Guest ${index + 1}`).trim().slice(0, 40) || `Guest ${index + 1}`;
        if (!Array.isArray(check?.items) || check.items.length === 0) throw Object.assign(new Error(`${label} must contain at least one item`), { statusCode: 400 });
        const seenItems = new Set<number>();
        const items = check.items.map((entry: any) => {
          const itemId = Number(entry?.order_item_id);
          const quantity = Number(entry?.quantity);
          const item = txnItemById.get(itemId);
          if (!item || !Number.isSafeInteger(quantity) || quantity < 1) throw Object.assign(new Error(`Invalid item allocation in ${label}`), { statusCode: 400 });
          if (seenItems.has(itemId)) throw Object.assign(new Error(`${label} contains the same item more than once`), { statusCode: 400 });
          seenItems.add(itemId);
          txnAssigned.set(itemId, (txnAssigned.get(itemId) || 0) + quantity);
          return { item, quantity };
        });
        return { label, items };
      });

      for (const item of txnActiveItems) {
        if ((txnAssigned.get(Number(item.id)) || 0) !== Number(item.quantity)) {
          throw Object.assign(new Error(`Allocate all ${item.quantity} × ${item.product_name}`), { statusCode: 400 });
        }
      }

      const groupId = randomUUID();
      const weights = txnNormalized.map((check: { items: { item: any; quantity: number }[] }) =>
        check.items.reduce((sum: number, entry: { item: any; quantity: number }) => sum + Number(entry.item.total || entry.item.subtotal || 0) * entry.quantity / Number(entry.item.quantity), 0)
      );

      const fields = ['subtotal', 'tax_amount', 'discount_amount', 'delivery_charge', 'packaging_charge', 'round_off', 'total'] as const;
      const allocations: Record<string, number[]> = {};
      for (const field of fields) {
        const totalMinor = Math.round(Number(txnSource[field] || 0) * 100);
        const allocatedMinors = allocateMinorUnits(totalMinor, weights);
        allocations[field] = allocatedMinors.map((minor) => minor / 100);
      }

      const checkTaxMinors = allocations.tax_amount.map((amt) => Math.round(amt * 100));
      const txnSnapshotItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY id").all(txnSource.order_id) as any[];
      const snapshotItems = txnSnapshotItems.filter((item) => hasSnapshotLines(item.tax_snapshot));
      const snapshotWeights = snapshotItems.map((item) => {
        if (['voided', 'void_adjustment'].includes(item.status)) return null;
        return txnNormalized.map((check: { items: { item: any; quantity: number }[] }) => (
          check.items.find((entry) => Number(entry.item.id) === Number(item.id))?.quantity || 0
        ));
      });
      const snapshotExclusions = snapshotItems.map((item) => ['voided', 'void_adjustment'].includes(item.status));
      const snapshotAllocation = allocateTaxSnapshotsWithTax(txnSource.tax_snapshot, weights, snapshotWeights, snapshotExclusions);
      const sourceTaxMinor = Math.round(Number(txnSource.tax_amount || 0) * 100);
      const snapshotTaxMinors = snapshotAllocation.taxMinors;
      const snapshotTaxMatches = snapshotTaxMinors !== null
        && snapshotTaxMinors.reduce((sum, minor) => sum + minor, 0) === sourceTaxMinor;
      const resolvedTaxMinors = snapshotTaxMatches ? snapshotTaxMinors : checkTaxMinors;
      if (snapshotTaxMatches) {
        allocations.tax_amount = resolvedTaxMinors.map((minor) => minor / 100);
        if (snapshotAllocation.exclusiveTaxMinors) {
          allocations.total = composeSplitTotals(allocations, snapshotAllocation.exclusiveTaxMinors);
        }
      }
      const resolvedTaxBreakdowns = allocateTaxBreakdown(txnSource.tax_breakdown, resolvedTaxMinors, weights);
      const checkTaxSnapshots = snapshotAllocation.snapshots;

      const billIds: number[] = [];
      txnNormalized.forEach((check, index) => {
        let billId: number;
        const splitBk = resolvedTaxBreakdowns[index];
        const splitSnapshot = checkTaxSnapshots[index];
        if (index === 0) {
          db.prepare(`UPDATE bills SET split_group_id = ?, split_label = ?, subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, delivery_charge = ?, packaging_charge = ?, round_off = ?, total = ?, balance = ?, updated_at = ? WHERE id = ?`)
            .run(groupId, check.label, allocations.subtotal[index], allocations.tax_amount[index], splitBk, splitSnapshot, allocations.discount_amount[index], allocations.delivery_charge[index], allocations.packaging_charge[index], allocations.round_off[index], allocations.total[index], allocations.total[index], now(), txnSource.id);
          billId = Number(txnSource.id);
        } else {
          const inserted = db.prepare(`INSERT INTO bills (bill_number, order_id, customer_id, subtotal, tax_amount, tax_breakdown, tax_snapshot, discount_amount, discount_type, discount_value, discount_reason, delivery_charge, packaging_charge, round_off, total, paid_amount, balance, payment_status, split_group_id, split_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'unpaid', ?, ?, ?, ?)`)
            .run(generateBillNumber(), txnSource.order_id, txnSource.customer_id, allocations.subtotal[index], allocations.tax_amount[index], splitBk, splitSnapshot, allocations.discount_amount[index], txnSource.discount_type, txnSource.discount_value, txnSource.discount_reason, allocations.delivery_charge[index], allocations.packaging_charge[index], allocations.round_off[index], allocations.total[index], allocations.total[index], groupId, check.label, now(), now());
          billId = Number(inserted.lastInsertRowid);
        }
        billIds.push(billId);
        const insertItem = db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, ?)');
        for (const entry of check.items) insertItem.run(billId, entry.item.id, entry.quantity);
      });
      return billIds.map((id) => parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(id)));
    });
    void sendEvent('feature_used', { feature: 'split_checks', action: 'created', check_count: result.length });
    notifyOrderUpdated();
    res.status(201).json({ bills: result });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to split check' });
  }
});

interface PaymentInput {
  method: string;
  payment_method_id?: number;
  amount?: number | string | null;
  transaction_id?: string;
  notes?: string;
}

// A payment request is prepared and fully validated before any ledger or bill
// writes. Both endpoints use this one atomic path.
const PAYMENT_METHODS = new Set(['cash', 'card', 'wallet']);
const MAX_PAYMENT_LINES = 100;
const MAX_PAYMENT_METADATA_BYTES = 8192;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function canonicalizePaymentRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizePaymentRequest).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalizePaymentRequest((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function paymentRequestHash(billId: string, payments: unknown, customerId: unknown): string {
  return createHash('sha256')
    .update(canonicalizePaymentRequest({ billId, payments, customer_id: customerId }))
    .digest('hex');
}

function paymentIdempotencyKey(req: Request): string | null {
  const supplied = req.get('Idempotency-Key')?.trim();
  if (!supplied) return null;
  if (supplied.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(supplied)) {
    throw Object.assign(new Error('Idempotency-Key is invalid or too long'), { statusCode: 400 });
  }
  return supplied;
}

function paymentAmountCents(value: unknown, label = 'Payment amount'): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw Object.assign(new Error(`${label} must be a finite number greater than zero`), { statusCode: 400 });
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new Error(`${label} must be a finite number greater than zero with at most 2 decimal places`), { statusCode: 400 });
  }
  const parsed = Number(text);
  const cents = Math.round(parsed * 100);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(cents)) {
    throw Object.assign(new Error(`${label} must be a finite number greater than zero`), { statusCode: 400 });
  }
  return cents;
}

interface PreparedPayment {
  payment: PaymentInput;
  amountCents: number;
  tenderedCents?: number;
  changeCents?: number;
  amountOmitted?: boolean;
}

function validatePaymentFields(payment: PaymentInput, index: number): void {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
    throw Object.assign(new Error(`Unsupported payment method at line ${index + 1}`), { statusCode: 400 });
  }
  if (!payment.method) throw Object.assign(new Error('Payment method is required'), { statusCode: 400 });
  if (typeof payment.method !== 'string' || payment.method.length > 60) throw Object.assign(new Error(`Unsupported payment method at line ${index + 1}`), { statusCode: 400 });
  if (payment.method === 'custom' && !Number.isSafeInteger(Number(payment.payment_method_id))) {
    throw Object.assign(new Error(`Custom payment method is required at line ${index + 1}`), { statusCode: 400 });
  }
  if (JSON.stringify(payment).length > MAX_PAYMENT_METADATA_BYTES) {
    throw Object.assign(new Error(`Payment metadata at line ${index + 1} is too large`), { statusCode: 400 });
  }
  for (const [field, maxLength] of [['transaction_id', 256], ['notes', 1024] ] as const) {
    const value = payment[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > maxLength || (field === 'transaction_id' && value.trim() === ''))) {
      throw Object.assign(new Error(`${field} is invalid or too long`), { statusCode: 400 });
    }
  }
  if (payment.amount !== undefined && payment.amount !== null) paymentAmountCents(payment.amount);
}

function paymentTransactionKey(payment: unknown): string | null {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return null;
  const candidate = payment as PaymentInput;
  const methodKey = candidate.payment_method_id === undefined ? candidate.method : `custom:${candidate.payment_method_id}`;
  return typeof methodKey === 'string' && typeof candidate.transaction_id === 'string'
    ? JSON.stringify([methodKey, candidate.transaction_id])
    : null;
}

function transactionPaymentMatches(existing: any, candidate: PaymentInput): boolean {
  if (!existing) return false;
  if (existing.method !== candidate.method || existing.transaction_id !== candidate.transaction_id) return false;
  if ((existing.notes ?? null) !== (candidate.notes ?? null)) return false;
  const candidateOmitted = candidate.amount === undefined || candidate.amount === null;
  if (existing.amount_omitted !== undefined && Boolean(existing.amount_omitted) !== candidateOmitted) return false;
  if (candidateOmitted) return true;
  const requestedCents = paymentAmountCents(candidate.amount);
  const storedRequested = existing.requested_amount
    ?? (existing.method === 'cash' && existing.tendered_amount !== undefined ? existing.tendered_amount : existing.amount);
  return typeof storedRequested === 'number' && Math.round(storedRequested * 100) === requestedCents;
}

function preparePaymentBatch(
  db: ReturnType<typeof getDatabase>,
  billId: string,
  payments: PaymentInput[],
  bodyCustomerId?: string | number,
  allowOmittedAmount = false,
): { bill: any; prepared: PreparedPayment[]; existingPayments: any[]; effectiveCustomerId: string | null; idempotentReplay?: boolean } {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
  if (!bill) throw Object.assign(new Error('Bill not found'), { statusCode: 404 });
  if (!Array.isArray(payments) || payments.length === 0) throw Object.assign(new Error('payments must be a non-empty array'), { statusCode: 400 });
  if (payments.length > MAX_PAYMENT_LINES) throw Object.assign(new Error(`A maximum of ${MAX_PAYMENT_LINES} payment lines is allowed`), { statusCode: 400 });
  let existingPayments: any[] = [];
  if (bill.payment_details) {
    try {
      const parsed = JSON.parse(bill.payment_details);
      existingPayments = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Preserve settlement compatibility with legacy malformed JSON. The new
      // line is still appended in a recoverable JSON array below.
      existingPayments = [];
    }
  }
  payments.forEach(validatePaymentFields);
  const resolvedPayments = payments.map((payment, index) => {
    if (PAYMENT_METHODS.has(payment.method)) return payment;
    const configured = payment.method === 'custom'
      ? db.prepare('SELECT id, name FROM payment_methods WHERE id = ? AND is_active = 1').get(payment.payment_method_id) as any
      : db.prepare('SELECT id, name FROM payment_methods WHERE lower(name) = lower(?) AND is_active = 1').get(payment.method) as any;
    if (!configured) throw Object.assign(new Error(`Unsupported or inactive custom payment method at line ${index + 1}`), { statusCode: 400 });
    return { ...payment, method: configured.name, payment_method_id: Number(configured.id) };
  });
  const requestedCustomerId = bodyCustomerId === undefined || bodyCustomerId === null || bodyCustomerId === ''
    ? null
    : String(bodyCustomerId);
  const order = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(bill.order_id) as { customer_id?: string | number | null } | undefined;
  const associatedCustomerId = bill.customer_id || order?.customer_id || null;
  if (requestedCustomerId && associatedCustomerId && String(associatedCustomerId) !== requestedCustomerId) {
    throw Object.assign(new Error('Payment customer does not match the bill customer'), { statusCode: 400 });
  }
  const usesWallet = resolvedPayments.some((payment) => payment.method === 'wallet');
  if (usesWallet && !associatedCustomerId) {
    throw Object.assign(new Error('Wallet payment requires a customer associated with the bill'), { statusCode: 400 });
  }
  const effectiveCustomerId = associatedCustomerId ? String(associatedCustomerId) : requestedCustomerId;
  if (effectiveCustomerId && !db.prepare('SELECT id FROM customers WHERE id = ?').get(effectiveCustomerId)) {
    throw Object.assign(new Error('Customer not found'), { statusCode: 400 });
  }
  const existingTransactionKeys = new Set(existingPayments.map(paymentTransactionKey).filter(Boolean));
  const existingTransactionPayments = new Map<string, any>();
  for (const existing of existingPayments) {
    const transactionKey = paymentTransactionKey(existing);
    if (transactionKey) existingTransactionPayments.set(transactionKey, existing);
  }
  for (const payment of resolvedPayments) {
    const transactionKey = paymentTransactionKey(payment);
    if (!transactionKey) continue;
    const candidate = payment as PaymentInput;
    const methodKey = candidate.payment_method_id === undefined ? candidate.method : `custom:${candidate.payment_method_id}`;
    const reference = db.prepare('SELECT bill_id FROM payment_transaction_refs WHERE method = ? AND transaction_id = ?').get(methodKey, candidate.transaction_id) as { bill_id: string } | undefined;
    if (reference && String(reference.bill_id) !== String(billId)) {
      throw Object.assign(new Error('Payment transaction_id has already been used for another bill'), { statusCode: 409 });
    }
    if (reference) existingTransactionKeys.add(transactionKey);
  }
  const requestTransactionKeys = resolvedPayments.map(paymentTransactionKey);
  const transactionMethods = new Map<string, string>();
  for (const payment of resolvedPayments) {
    if (typeof payment.transaction_id !== 'string' || payment.transaction_id.trim() === '') continue;
    const methodKey = payment.payment_method_id === undefined ? payment.method : `custom:${payment.payment_method_id}`;
    const previousMethod = transactionMethods.get(payment.transaction_id);
    if (previousMethod && previousMethod !== methodKey) {
      throw Object.assign(new Error('A transaction_id cannot be reused across payment methods in one batch'), { statusCode: 400 });
    }
    transactionMethods.set(payment.transaction_id, methodKey);
  }
  const replay = requestTransactionKeys.every((key, index) => (
    key !== null
    && existingTransactionKeys.has(key)
    && transactionPaymentMatches(existingTransactionPayments.get(key), resolvedPayments[index])
  ));
  if (replay) {
    return { bill, prepared: [], existingPayments, effectiveCustomerId, idempotentReplay: true };
  }
  const seenTransactionKeys = new Set<string>();
  for (const key of requestTransactionKeys) {
    if (key && (seenTransactionKeys.has(key) || existingTransactionKeys.has(key))) {
      throw Object.assign(new Error('Payment transaction_id has already been used for this bill'), { statusCode: 409 });
    }
    if (key) seenTransactionKeys.add(key);
  }
  if (bill.payment_status === 'paid') throw Object.assign(new Error('Bill is already paid'), { statusCode: 400 });
  const remainingCents = Math.max(0, Math.round((Number(bill.total) - Number(bill.paid_amount || 0)) * 100));
  if (remainingCents <= 0) throw Object.assign(new Error('Bill is already fully paid'), { statusCode: 400 });
  const raw = resolvedPayments.map((payment) => {
    // Preserve omitted/null compatibility for the legacy single-line contracts.
    // Multi-line batches must state every amount explicitly so allocation is
    // deterministic before any write.
    const supportsOmittedAmount = allowOmittedAmount || payments.length === 1;
    const amountValue = supportsOmittedAmount && payment.amount === null ? undefined : payment.amount;
    const amount = amountValue === undefined
      ? (supportsOmittedAmount ? remainingCents : undefined)
      : paymentAmountCents(amountValue);
    if (amount === undefined) throw Object.assign(new Error('Payment amount is required for split payments'), { statusCode: 400 });
    const normalizedPayment: PaymentInput = {
      method: String(payment.method),
      ...(payment.payment_method_id !== undefined ? { payment_method_id: payment.payment_method_id } : {}),
    };
    if (payment.transaction_id !== undefined) normalizedPayment.transaction_id = payment.transaction_id;
    if (payment.notes !== undefined) normalizedPayment.notes = payment.notes;
    return {
      payment: normalizedPayment,
      method: normalizedPayment.method,
      requestedCents: amount,
      amountOmitted: amountValue === undefined,
    };
  });
  const nonCashCents = raw.filter((line) => line.method !== 'cash').reduce((sum, line) => sum + line.requestedCents, 0);
  if (nonCashCents > remainingCents) throw Object.assign(new Error('Non-cash payment exceeds the bill balance'), { statusCode: 400 });
  const cashRequiredCents = remainingCents - nonCashCents;
  // Partial payments remain supported. Cash is allocated up to the amount
  // needed after non-cash lines; a short tender simply leaves a partial bill.
  let cashLeft = cashRequiredCents;
  const prepared: PreparedPayment[] = raw.map((line) => {
    if (line.method !== 'cash') return { payment: line.payment, amountCents: line.requestedCents, amountOmitted: line.amountOmitted };
    const applied = Math.min(line.requestedCents, cashLeft);
    cashLeft -= applied;
    if (applied === 0 && line.payment.transaction_id) {
      throw Object.assign(new Error('A zero-applied cash line cannot carry a transaction_id'), { statusCode: 400 });
    }
    return { payment: line.payment, amountCents: applied, tenderedCents: line.requestedCents, changeCents: line.requestedCents - applied, amountOmitted: line.amountOmitted };
  }).filter((line) => line.amountCents > 0);

  if (prepared.some((line) => line.payment.method === 'wallet')) {
    if (!effectiveCustomerId) throw Object.assign(new Error('Customer association is required for wallet payment'), { statusCode: 400 });
    const credits = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = ? AND type = 'credit' AND (expires_at IS NULL OR expires_at > datetime('now'))`).get(effectiveCustomerId) as { total: number };
    const debits = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = ? AND type = 'debit'`).get(effectiveCustomerId) as { total: number };
    const walletPoints = Math.max(0, Number(credits.total) - Number(debits.total));
    const pointsRequired = prepared.filter((line) => line.payment.method === 'wallet').reduce((sum, line) => sum + line.amountCents, 0);
    if (walletPoints < pointsRequired) throw Object.assign(new Error(`Insufficient wallet balance. Available: ${Math.floor(walletPoints / LOYALTY_REDEMPTION_RATE)} (${walletPoints} points), Required: ${pointsRequired / 100}`), { statusCode: 400 });
  }
  return { bill, prepared, existingPayments, effectiveCustomerId };
}

function calculateCashback(db: ReturnType<typeof getDatabase>, bill: any, customerId: string | null): number {
  if (!customerId) return 0;
  const enabled = (db.prepare(`SELECT value FROM settings WHERE key = 'loyalty_enabled'`).get() as any)?.value;
  if (enabled !== 'true' && enabled !== '1') return 0;
  const globalRate = parseFloat((db.prepare(`SELECT value FROM settings WHERE key = 'global_cashback_percent'`).get() as any)?.value || '0');
  const order = db.prepare('SELECT subtotal, discount_amount FROM orders WHERE id = ?').get(bill.order_id) as any;
  const items = db.prepare(`SELECT oi.subtotal, p.cb_percent FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.status != 'cancelled'`).all(bill.order_id) as { subtotal: number; cb_percent: number | null }[];
  const fullOrderCashback = items.reduce((sum, item) => {
    const discountShare = order?.discount_amount > 0 && order?.subtotal > 0 ? order.discount_amount * item.subtotal / order.subtotal : 0;
    const rate = item.cb_percent !== null ? item.cb_percent : globalRate;
    return sum + (rate > 0 ? Math.floor(Math.max(0, item.subtotal - discountShare) * rate / 100) * LOYALTY_REDEMPTION_RATE : 0);
  }, 0);
  const splitRatio = Number(order?.subtotal || 0) > 0 && bill.split_group_id
    ? Math.min(1, Number(bill.subtotal || 0) / Number(order.subtotal))
    : 1;
  return Math.floor(fullOrderCashback * splitRatio);
}

function applyPaymentBatch(
  db: ReturnType<typeof getDatabase>,
  billId: string,
  payments: PaymentInput[],
  bodyCustomerId?: string | number,
  allowOmittedAmount = false,
  idempotencyKey?: string | null,
  requestHash?: string,
  idempotencyUserId?: string,
): { bill: any; walletDebited: boolean; loyaltyPointsEarned: number } {
  if (idempotencyKey && idempotencyUserId) {
    // `legacy` is an append-only compatibility owner for pre-user-scoped
    // records whose original user cannot be recovered. It is only reachable
    // with the exact bill and request hash; new records are always user-bound.
    const prior = db.prepare(`
      SELECT bill_id, request_hash, response_json
      FROM payment_idempotency
      WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
      ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(idempotencyUserId, idempotencyKey, idempotencyUserId) as { bill_id: string; request_hash: string; response_json: string } | undefined;
    if (prior) {
      if (String(prior.bill_id) !== String(billId) || prior.request_hash !== requestHash) {
        throw Object.assign(new Error('Idempotency-Key was already used for a different payment request'), { statusCode: 409 });
      }
      try {
        return JSON.parse(prior.response_json);
      } catch {
        throw Object.assign(new Error('Stored payment response is invalid'), { statusCode: 500 });
      }
    }
  }
  const { bill, prepared, existingPayments, effectiveCustomerId, idempotentReplay } = preparePaymentBatch(
    db, billId, payments, bodyCustomerId, allowOmittedAmount,
  );
  if (idempotentReplay) {
    return { bill: parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(billId)), walletDebited: false, loyaltyPointsEarned: 0 };
  }
  const totalAppliedCents = prepared.reduce((sum, line) => sum + line.amountCents, 0);
  const oldPaidCents = Math.round(Number(bill.paid_amount || 0) * 100);
  const totalCents = Math.round(Number(bill.total || 0) * 100);
  const newPaidCents = oldPaidCents + totalAppliedCents;
  const newBalanceCents = Math.max(0, totalCents - newPaidCents);
  const paymentStatus = newBalanceCents === 0 ? 'paid' : 'partial';
  const newPayments = prepared.map((line) => ({
    ...line.payment,
    amount: line.amountCents / 100,
    requested_amount: (line.tenderedCents || line.amountCents) / 100,
    amount_omitted: Boolean(line.amountOmitted),
    ...(line.payment.method === 'cash' ? { tendered_amount: (line.tenderedCents || 0) / 100, change_amount: (line.changeCents || 0) / 100 } : {}),
    timestamp: now(),
  }));
  let walletDebited = false;
  for (const line of prepared) {
    if (line.payment.method !== 'wallet' || line.amountCents <= 0) continue;
    db.prepare(`INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at) VALUES (?, ?, 'debit', ?, ?, ?, ?)`).run(effectiveCustomerId, bill.id, line.amountCents, `Payment for bill ${bill.bill_number}`, now(), now());
    walletDebited = true;
  }
  const allPayments = existingPayments.concat(newPayments);
  const changedAt = now();
  const insertTransactionRef = db.prepare('INSERT INTO payment_transaction_refs (method, transaction_id, bill_id, created_at) VALUES (?, ?, ?, ?)');
  for (const line of prepared) {
    if (line.payment.transaction_id) {
      const methodKey = line.payment.payment_method_id === undefined ? line.payment.method : `custom:${line.payment.payment_method_id}`;
      insertTransactionRef.run(methodKey, line.payment.transaction_id, billId, changedAt);
    }
  }
  if (!bill.customer_id && effectiveCustomerId) db.prepare('UPDATE bills SET customer_id = ?, updated_at = ? WHERE id = ?').run(effectiveCustomerId, changedAt, billId);
  db.prepare(`UPDATE bills SET paid_amount = ?, balance = ?, payment_status = ?, payment_details = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END, updated_at = ? WHERE id = ?`).run(newPaidCents / 100, newBalanceCents / 100, paymentStatus, JSON.stringify(allPayments), paymentStatus, paymentStatus === 'paid' ? changedAt : null, changedAt, billId);
  let loyaltyPointsEarned = 0;
  if (paymentStatus === 'paid') {
    const unpaidSibling = db.prepare(`SELECT 1 FROM bills WHERE order_id = ? AND id != ? AND payment_status != 'paid' LIMIT 1`).get(bill.order_id, bill.id);
    const orderFullyPaid = !unpaidSibling;
    if (orderFullyPaid) {
      db.prepare("UPDATE orders SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(changedAt, changedAt, bill.order_id);
      const order = db.prepare('SELECT table_id FROM orders WHERE id = ?').get(bill.order_id) as any;
      if (order?.table_id) db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?").run(changedAt, order.table_id);
    }
    const cashback = calculateCashback(db, bill, effectiveCustomerId);
    const alreadyCredited = db.prepare(`SELECT id FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'`).get(bill.id);
    if (cashback > 0 && !alreadyCredited) {
      const walletCents = allPayments.filter((p: any) => p.method === 'wallet').reduce((sum: number, p: any) => sum + Math.round(Number(p.amount || 0) * 100), 0);
      const finalCashback = Math.floor(cashback * (1 - Math.min(1, walletCents / Math.max(1, totalCents))));
      if (finalCashback > 0) {
        db.prepare(`INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at) VALUES (?, ?, 'credit', ?, ?, ?, ?)`).run(effectiveCustomerId, bill.id, finalCashback, `Cashback on bill ${bill.bill_number}`, changedAt, changedAt);
        loyaltyPointsEarned = finalCashback;
      }
    }
  }
  const result = { bill: parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(billId)), walletDebited, loyaltyPointsEarned };
  if (idempotencyKey && requestHash && idempotencyUserId) {
    db.prepare('INSERT INTO payment_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(idempotencyUserId, idempotencyKey, billId, requestHash, JSON.stringify(result), changedAt);
  }
  return result;
}

router.post('/:id/payment', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const payment = req.body;
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
      return res.status(400).json({ error: 'Payment body must be an object' });
    }
    const db = getDatabase();
    const requestHash = paymentRequestHash(req.params.id as string, [payment], payment.customer_id);
    const result = withTxn(() => applyPaymentBatch(
      db, req.params.id as string, [payment], payment.customer_id, true,
      paymentIdempotencyKey(req), requestHash, String((req as any).user.userId),
    ));

    const billStatus = (result.bill as any)?.payment_status;
    if (billStatus === 'paid') notifyKdsUpdate();
    else notifyOrderUpdated();

    res.json(result);
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    console.error('[API] Bill payment failed:', error);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Bill payment failed' : error.message });
  }
});

// POST /:id/payments — atomic split-payment batch endpoint (#177). Applies every
// payment line in the array within a single transaction, so a failure partway
// through (insufficient wallet balance, an invalid amount, etc.) rolls back every
// line already applied instead of leaving the bill partially paid.
router.post('/:id/payments', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Payment batch body must be an object' });
    }
    const { payments, customer_id: bodyCustomerId } = body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'payments must be a non-empty array' });
    }

    const db = getDatabase();
    const requestHash = paymentRequestHash(req.params.id as string, payments, bodyCustomerId);
    const result = withTxn(() => applyPaymentBatch(
      db, req.params.id as string, payments, bodyCustomerId, false,
      paymentIdempotencyKey(req), requestHash, String((req as any).user.userId),
    ));

    const billStatus = (result.bill as any)?.payment_status;
    if (billStatus === 'paid') notifyKdsUpdate();
    else notifyOrderUpdated();

    res.json(result);
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    console.error('[API] Batch bill payment failed:', error);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Bill payment failed' : error.message });
  }
});

router.post('/:id/applyDiscount', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { type, value, reason } = req.body;

    if (!type || !['percentage', 'amount'].includes(type)) {
      return res.status(400).json({ error: 'Valid discount type is required (percentage, amount)' });
    }

    if (value === undefined || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: 'Valid discount value is required' });
    }

    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id) as any;
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (bill.payment_status === 'paid') {
      return res.status(400).json({ error: 'Cannot apply discount to a paid bill' });
    }
    if (bill.split_group_id) {
      return res.status(409).json({ error: 'Apply discounts before splitting a bill' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if approval is required
    const requiresApproval = getSettingValue('discount_requires_approval') === 'true';
    if (requiresApproval && value > 0) {
      const { override_pin } = req.body;
      if (!override_pin) {
        return res.status(403).json({ error: 'Manager PIN required for discounts', requiresApproval: true });
      }
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimitKey = `pin:${clientIp}:bill-discount`;
      if (!checkPinRateLimit(rateLimitKey)) {
        return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
      }
      const managerId = req.body.manager_id || req.body.user_id;
      let user: any = null;
      if (managerId) {
        const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN ('owner', 'manager') AND is_active = 1").get(managerId) as any;
        if (candidate && verifyPin(candidate.pin_hash, override_pin)) {
          user = candidate;
        }
      }
      if (!user) {
        const managers = db.prepare("SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN ('owner', 'manager') AND is_active = 1").all() as any[];
        for (const u of managers) {
          if (verifyPin(u.pin_hash, override_pin)) {
            user = u;
            break;
          }
        }
      }
      if (!user) {
        return res.status(403).json({ error: 'Invalid manager PIN' });
      }
    }

    // Check discount mode
    const discountMode = getSettingValue('discount_mode') || 'percentage';
    if (discountMode === 'flat' && type === 'percentage') {
      return res.status(400).json({ error: 'Percentage discounts are disabled' });
    }
    if (discountMode === 'percentage' && type === 'amount') {
      return res.status(400).json({ error: 'Flat amount discounts are disabled' });
    }

    // Check against limits from settings (0 = no limit)
    if (type === 'percentage') {
      const maxPercentage = parseFloat(getSettingValue('discount_max_percentage') || '25');
      if (maxPercentage > 0 && value > maxPercentage) {
        return res.status(400).json({ error: `discount value exceeds maximum percentage of ${maxPercentage}` });
      }
    } else {
      const maxAmount = parseFloat(getSettingValue('discount_max_amount') || '0');
      if (maxAmount > 0 && value > maxAmount) {
        return res.status(400).json({ error: `discount value exceeds maximum amount of ${maxAmount}` });
      }
    }

    let discountAmount = 0;
    if (type === 'percentage') {
      discountAmount = (bill.subtotal * Number(value)) / 100;
    } else {
      discountAmount = Number(value);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;

    // Always derive the undiscounted tax basis from active item rows. Using
    // bill.tax_amount here compounds the previous discount whenever a manager
    // edits 10% to 20%. Keep inclusive tax out of the payable total.
    const activeItems = db.prepare(
      "SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'"
    ).all(bill.order_id) as any[];
    let itemTaxAmount = 0;
    let itemExclusiveTax = 0;
    const itemBreakdowns: any[][] = [];
    const itemSnapshots: (string | null)[] = [];
    for (const item of activeItems) {
      const taxAmount = item.tax_amount || 0;
      itemTaxAmount += taxAmount;
      if (item.tax_type !== 'inclusive') itemExclusiveTax += taxAmount;
      if (item.tax_breakdown) {
        try {
          const breakdown = JSON.parse(item.tax_breakdown);
          if (Array.isArray(breakdown)) itemBreakdowns.push(breakdown);
        } catch { }
      }
      itemSnapshots.push(item.tax_snapshot || null);
    }

    const discountedSubtotal = Math.max(0, bill.subtotal - discountAmount);
    const taxRatio = bill.subtotal > 0 ? discountedSubtotal / bill.subtotal : 1;
    const newTaxAmount = Math.round(itemTaxAmount * taxRatio * 100) / 100;
    const newExclusiveTax = Math.round(itemExclusiveTax * taxRatio * 100) / 100;
    const tenantInfo = {
      country: getSettingValue('country') || 'IN',
      business_type: getSettingValue('business_type') || 'restaurant',
      state_code: getSettingValue('state_code') || '',
      taxes_enabled: getSettingValue('taxes_enabled') === 'true',
    };
    const customer = bill.customer_id
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(bill.customer_id) as any
      : null;
    const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
      ...order,
      packaging_charge: bill.packaging_charge || 0,
      delivery_charge: bill.delivery_charge || 0,
      service_charge: bill.service_charge || 0,
    }, customer);
    const taxRollup = combineItemAndChargeTaxes({
      itemTaxAmount: newTaxAmount,
      itemExclusiveTaxAmount: newExclusiveTax,
      itemBreakdowns,
      itemSnapshots,
      itemTaxRatio: taxRatio,
      chargeTaxes,
    });
    const taxBreakdownJson = JSON.stringify(taxRollup.breakdowns);

    const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
      + (bill.delivery_charge || 0) + (bill.packaging_charge || 0) + (bill.service_charge || 0);
    const exactTotal = Number(preRoundTotal.toFixed(2));
    const pack = getActiveCountryPack(tenantInfo.country);
    const { total: newTotal, adjustment: newRoundOff } = applyPayableRounding(exactTotal, pack);
    const newBalance = Math.max(0, newTotal - (bill.paid_amount || 0));

    const updatedBill = withTxn(() => {
      db.prepare(`
        UPDATE bills SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?,
          total = ?, round_off = ?, balance = ?, updated_at = ?
        WHERE id = ?
      `).run(
        discountAmount, type, value, reason || null, taxRollup.taxAmount, taxBreakdownJson,
        taxRollup.snapshotJson, newTotal, newRoundOff, newBalance, now(), req.params.id,
      );

      // orders.total stays the exact, unrounded amount — only the bill (the
      // settlement boundary) holds the pack-rounded payable total (#170).
      db.prepare(`
        UPDATE orders SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?,
          total = ?, round_off = ?, updated_at = ?
        WHERE id = ?
      `).run(
        discountAmount, type, value, reason || null, taxRollup.taxAmount, taxBreakdownJson,
        taxRollup.snapshotJson, exactTotal, 0, now(), bill.order_id,
      );

      return parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id));
    });

    notifyOrderUpdated();
    res.json({ bill: updatedBill });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    console.error('[API] Bill discount failed:', error);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : error.message });
  }
});

router.post('/:id/markPrinted', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    db.prepare('UPDATE bills SET printed_at = ?, updated_at = ? WHERE id = ?')
      .run(now(), now(), req.params.id);

    const updatedBill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id));
    res.json({ bill: updatedBill });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/bills/:id/print - Print or reprint bill
router.post('/:id/print', requireRole('owner', 'manager', 'cashier'), async (req: Request, res: Response) => {
  try {
    const { print_type } = req.body;

    if (!print_type || !['receipt', 'reprint'].includes(print_type)) {
      return res.status(400).json({ error: 'print_type must be receipt or reprint' });
    }

    // User ID is set by the requireAuth middleware after JWT verification
    const userId = (req as any).user?.userId || (req as any).user?.id || 'unknown';

    const result = await printReceipt(parseInt(req.params.id as string), userId, print_type);
    res.json(result);
  } catch (error: any) {
    // Return 404 for "Bill not found", 500 for other errors
    const statusCode = error.message?.includes('Bill not found') ? 404 : 500;
    console.error('[API] Receipt printing failed:', error);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Receipt printing failed' : 'Bill not found' });
  }
});

// GET /api/bills/:id/print-history - Get print history for bill
router.get('/:id/print-history', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const prints = db.prepare(`
      SELECT pl.*, u.name as user_name
      FROM print_logs pl
      LEFT JOIN users u ON pl.user_id = u.id
      WHERE pl.bill_id = ?
      ORDER BY pl.printed_at DESC
    `).all(req.params.id);

    res.json({ prints });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const billRoutes = router;
