/**
 * Refund processing (#278): bill-level cash-back and item-level "already
 * prepared, must be pulled off a paid bill" refunds.
 *
 * Item-level refunds mirror the existing in-progress item-void mechanism
 * (main/routes/index.ts, PATCH /api/orders/:orderId/items/:itemId/cancel)
 * but for a bill that already has payment on it, which that endpoint always
 * blocks. Inventory is deliberately not restored — it was already consumed
 * when the item was prepared, same rule as the existing void path.
 */
import { getDatabase, now, parseDbTimestamp, verifyPin } from '../db';
import { invertTaxBreakdown, invertTaxSnapshot } from './tax';
import { ROLE_ACCESS } from '../../shared/role-permissions';

type Database = ReturnType<typeof getDatabase>;

const OWNER_MANAGER_ROLE_PLACEHOLDERS = ROLE_ACCESS.ownerManager.map(() => '?').join(', ');
const REFUND_ITEM_ELIGIBLE_STATUSES = ['preparing', 'ready'];
const REFUND_WINDOW_MS = 60 * 60 * 1000;
// Kept in sync with the ['cancelled', 'voided', 'void_adjustment'] exclusion
// list used throughout main/routes/bills.ts, main/routes/index.ts, and
// main/routes/orders.ts — 'refunded' is the new terminal item status this
// feature introduces and must be excluded everywhere those are.
export const TERMINAL_ITEM_STATUSES = ['cancelled', 'voided', 'void_adjustment', 'refunded'];

export interface RefundRequest {
  billId: string | number;
  orderItemId?: number | null;
  amountCents?: number;
  method?: string;
  reason?: string | null;
  shiftId?: string | null;
  overridePin: string;
  managerId?: string | null;
  createdByUserId: string;
  clientIp: string;
  checkPinRateLimit: (key: string) => boolean;
  idempotencyKey?: string | null;
  requestHash?: string;
}

export interface RefundResult {
  refund: any;
  bill: any;
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function getRefundableBalance(db: Database, billId: string | number): {
  paidCents: number;
  refundedCents: number;
  refundableCents: number;
} {
  const bill = db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(billId) as { paid_amount: number } | undefined;
  const paidCents = Math.round(Number(bill?.paid_amount || 0) * 100);
  const refundedRow = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE bill_id = ?').get(billId) as { total: number };
  const refundedCents = Number(refundedRow.total || 0);
  return { paidCents, refundedCents, refundableCents: paidCents - refundedCents };
}

function resolveRefundApprover(db: Database, overridePin: string, managerId?: string | null): { id: string } | null {
  if (managerId) {
    const candidate = db.prepare(`SELECT * FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS}) AND is_active = 1`).get(managerId, ...ROLE_ACCESS.ownerManager) as any;
    if (candidate && verifyPin(candidate.pin_hash, overridePin)) return candidate;
  }
  const managers = db.prepare(`SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS}) AND is_active = 1`).all(...ROLE_ACCESS.ownerManager) as any[];
  for (const user of managers) {
    if (verifyPin(user.pin_hash, overridePin)) return user;
  }
  return null;
}

/**
 * Validates, authorizes, and persists a refund. Must be called from inside
 * the caller's withTxn — mirrors applyPaymentBatch's caller contract, where
 * the whole function (idempotency lookup included) runs inside one
 * transaction (main/routes/bills.ts).
 */
export function createRefund(db: Database, req: RefundRequest): RefundResult {
  if (req.idempotencyKey) {
    const prior = db.prepare(`
      SELECT bill_id, request_hash, response_json
      FROM refund_idempotency
      WHERE user_id = ? AND idempotency_key = ?
    `).get(req.createdByUserId, req.idempotencyKey) as { bill_id: string; request_hash: string; response_json: string } | undefined;
    if (prior) {
      if (String(prior.bill_id) !== String(req.billId) || prior.request_hash !== req.requestHash) {
        throw httpError('Idempotency-Key was already used for a different refund request', 409);
      }
      try {
        return JSON.parse(prior.response_json);
      } catch {
        throw httpError('Stored refund response is invalid', 500);
      }
    }
  }

  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.billId) as any;
  if (!bill) throw httpError('Bill not found', 404);
  const order = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(bill.order_id) as { created_at: string } | undefined;
  if (!order) throw httpError('Order not found', 404);
  const orderCreatedAt = parseDbTimestamp(order.created_at).getTime();
  if (!Number.isFinite(orderCreatedAt) || Date.now() - orderCreatedAt > REFUND_WINDOW_MS) {
    throw httpError('Refund window has expired. Refunds are allowed within 1 hour of order creation.', 409);
  }

  let amountCents = req.amountCents;
  let item: any = null;
  if (req.orderItemId != null) {
    item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.orderItemId) as any;
    if (!item) throw httpError('Order item not found', 404);
    if (String(item.order_id) !== String(bill.order_id)) {
      throw httpError("Item does not belong to this bill's order", 400);
    }
    if (bill.split_group_id) {
      const allocation = db.prepare(`
        SELECT quantity FROM bill_items WHERE bill_id = ? AND order_item_id = ?
      `).get(bill.id, item.id) as { quantity: number } | undefined;
      if (!allocation) {
        throw httpError('Item is not allocated to this split bill', 400);
      }
      if (Number(allocation.quantity) !== Number(item.quantity)) {
        throw httpError('Partially allocated split items cannot be refunded as a whole item', 409);
      }
    }
    if (!REFUND_ITEM_ELIGIBLE_STATUSES.includes(item.status)) {
      throw httpError('Item is not eligible for refund', 409);
    }
    const itemAmountCents = Math.round(Number(item.total) * 100);
    if (amountCents !== undefined && amountCents !== itemAmountCents) {
      throw httpError("Refund amount does not match the item's refundable total", 400);
    }
    amountCents = itemAmountCents;
  }

  if (amountCents === undefined || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw httpError('Refund amount is required', 400);
  }
  if (!req.method || typeof req.method !== 'string' || req.method.length > 60) {
    throw httpError('Refund method is required', 400);
  }

  const { paidCents, refundedCents, refundableCents } = getRefundableBalance(db, req.billId);
  if (refundableCents <= 0) throw httpError('Bill has nothing left to refund', 400);
  if (amountCents > refundableCents) throw httpError('Refund amount exceeds the refundable balance', 400);

  if (!req.overridePin) {
    throw httpError('Manager PIN required to process a refund', 400);
  }
  const rateLimitKey = `pin:${req.clientIp}:refund`;
  if (!req.checkPinRateLimit(rateLimitKey)) {
    throw httpError('Too many PIN attempts. Try again in 15 minutes.', 429);
  }
  const approver = resolveRefundApprover(db, req.overridePin, req.managerId);
  if (!approver) throw httpError('Invalid manager PIN', 403);

  const timestamp = now();

  if (item) {
    // Mirrors the existing void_adjustment mirrored-negative-row mechanism
    // (main/routes/index.ts) verbatim, except the original item transitions
    // to 'refunded' (not 'voided') so refund and void stay distinguishable
    // in reporting, and inventory is never touched either way.
    const adjustmentResult = db.prepare(`
      INSERT INTO order_items (
        order_id, product_id, product_name, product_sku, unit_price, quantity,
        subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total,
        variant_selection, modifier_selection, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'void_adjustment', ?, ?)
    `).run(
      item.order_id, item.product_id, `Refund: ${item.product_name}`, item.product_sku,
      -item.unit_price, item.quantity, -item.subtotal, -(item.tax_amount || 0),
      invertTaxBreakdown(item.tax_breakdown), invertTaxSnapshot(item.tax_snapshot), item.tax_type,
      -(item.discount_amount || 0), -item.total,
      item.variant_selection, item.modifier_selection, timestamp, timestamp,
    );
    if (bill.split_group_id) {
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, ?)')
        .run(bill.id, adjustmentResult.lastInsertRowid, item.quantity);
    }
    db.prepare("UPDATE order_items SET status = 'refunded', voided_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, item.id);
  }

  const insertResult = db.prepare(`
    INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.billId, req.orderItemId ?? null, amountCents, req.method, req.reason ?? null, req.shiftId ?? null, approver.id, req.createdByUserId, timestamp);

  const newRefundedCents = refundedCents + amountCents;
  const paymentStatus = newRefundedCents >= paidCents ? 'refunded' : 'partially_refunded';
  db.prepare('UPDATE bills SET payment_status = ?, updated_at = ? WHERE id = ?').run(paymentStatus, timestamp, req.billId);

  const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(insertResult.lastInsertRowid);
  const freshBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.billId);
  const result: RefundResult = { refund, bill: freshBill };

  if (req.idempotencyKey && req.requestHash) {
    db.prepare('INSERT INTO refund_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.createdByUserId, req.idempotencyKey, String(req.billId), req.requestHash, JSON.stringify(result), timestamp);
  }

  return result;
}
