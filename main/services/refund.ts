/** Bill-level cash-back and item-level refund processing for paid bills. */
import {
  getDatabase, getSettingValue, now, parseDbTimestamp, verifyPin,
  dayBoundsInTimezone, localDateInTimezone, tenantBusinessDayStartTime, recordOrderAudit,
} from '../db';
import { invertTaxBreakdown, invertTaxSnapshot } from './tax';
import { getOpenSession, NO_CASH_SESSION_ID, requireOpenSessionForCashTender } from './shift-session-gate';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { getCurrencyMinorUnitFactor, resolveRegionalSnapshot, resolveTenantCurrency } from '../countries';

type Database = ReturnType<typeof getDatabase>;

// Kept in sync with the 1:1 rate in main/routes/bills.ts — loyalty points equal currency units.
const LOYALTY_REDEMPTION_RATE = 1;
// Items already served/completed become refundable once an order is past the short window below.
const REFUND_ITEM_ELIGIBLE_STATUSES = ['preparing', 'ready', 'served', 'completed'];
const REFUND_WINDOW_MS = 60 * 60 * 1000;

export function getTenantCurrency(db?: Database): string {
  const explicit = db ? (db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as any)?.value : getSettingValue('currency');
  const country = db ? (db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any)?.value : getSettingValue('country');
  return resolveTenantCurrency(explicit, country || '');
}

export interface RefundRequest {
  billId: string | number;
  orderItemId?: number | null;
  amountCents?: number;
  method?: string;
  reason?: string | null;
  shiftId?: string | null;
  overridePin: string;
  approverId?: string | null;
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

/** Returns the refundable balance for a bill in integer minor units. */
export function getRefundableBalance(db: Database, billId: string | number, currency?: string): {
  paidCents: number;
  refundedCents: number;
  refundableCents: number;
} {
  const effectiveCurrency = currency || getTenantCurrency(db);
  const minorFactor = getCurrencyMinorUnitFactor(effectiveCurrency);
  const bill = db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(billId) as { paid_amount: number } | undefined;
  const paidCents = Math.round(Number(bill?.paid_amount || 0) * minorFactor);
  const refundedRow = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE bill_id = ?').get(billId) as { total: number };
  const refundedCents = Number(refundedRow.total || 0);
  return { paidCents, refundedCents, refundableCents: paidCents - refundedCents };
}

/** `ownerOnly` narrows the approving PIN to owner accounts — used once a refund falls outside the short in-progress window. */
function resolveRefundApprover(db: Database, overridePin: string, approverId: string | null | undefined, ownerOnly: boolean): { id: string } | null {
  const allowedRoles = ownerOnly ? ROLE_ACCESS.owner : ROLE_ACCESS.ownerManager;
  const placeholders = allowedRoles.map(() => '?').join(', ');
  if (!approverId) return null;
  const candidate = db.prepare(`SELECT * FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN (${placeholders}) AND is_active = 1`).get(approverId, ...allowedRoles) as any;
  return candidate && verifyPin(candidate.pin_hash, overridePin) ? candidate : null;
}

/** Validates, authorizes, and persists a refund inside an active transaction. */
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

  requireOpenSessionForCashTender(db, [{ method: req.method }]);

  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.billId) as any;
  if (!bill) throw httpError('Bill not found', 404);
  const order = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(bill.order_id) as { created_at: string } | undefined;
  if (!order) throw httpError('Order not found', 404);
  const orderCreatedAt = parseDbTimestamp(order.created_at).getTime();
  if (!Number.isFinite(orderCreatedAt)) throw httpError('Order creation time is invalid', 500);
  const nowMs = Date.now();
  // Past the short window, an owner-only PIN is required for the rest of the business day (docs/reference/product-invariants.md).
  let lateRefund = false;
  if (nowMs - orderCreatedAt > REFUND_WINDOW_MS) {
    // Resolves through the country profile when the stored timezone is
    // missing or invalid, matching resolveRegionalSnapshot's own contract,
    // instead of letting localDateInTimezone()/dayBoundsInTimezone() silently
    // fall back to UTC — at a tenant offset from UTC, that can wrongly accept
    // or reject a late refund relative to the tenant's actual business-day
    // end. Throws RegionalNotConfiguredError (409) only when the country
    // itself is unresolvable.
    const timezone = resolveRegionalSnapshot({
      country: getSettingValue('country') ?? undefined,
      currency: getSettingValue('currency') ?? undefined,
      timezone: getSettingValue('timezone') ?? undefined,
    }).timezone;
    const startTime = tenantBusinessDayStartTime(db);
    const orderBusinessDate = localDateInTimezone(new Date(orderCreatedAt), timezone, startTime);
    const [, businessDayEnd] = dayBoundsInTimezone(orderBusinessDate, timezone, startTime);
    if (nowMs >= parseDbTimestamp(businessDayEnd).getTime()) {
      throw httpError('Refund window has expired. Completed orders can only be refunded within the same business day.', 409);
    }
    lateRefund = true;
  }

  const currency = getTenantCurrency(db);
  const minorFactor = getCurrencyMinorUnitFactor(currency);

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
    const itemAmountCents = Math.round(Number(item.total) * minorFactor);
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
  const isStoreCreditRefund = req.method === 'wallet';
  if (isStoreCreditRefund) {
    const loyaltyEnabled = ['true', '1'].includes(getSettingValue('loyalty_enabled') || '');
    if (!loyaltyEnabled) throw httpError('Store credit is not enabled', 400);
    if (!bill.customer_id) throw httpError('Customer association is required for a store-credit refund', 400);
  }

  const { paidCents, refundedCents, refundableCents } = getRefundableBalance(db, req.billId, currency);
  if (refundableCents <= 0) throw httpError('Bill has nothing left to refund', 400);
  if (amountCents > refundableCents) throw httpError('Refund amount exceeds the refundable balance', 400);

  if (!req.overridePin) {
    throw httpError(lateRefund ? 'Owner PIN required to process a refund on a completed order' : 'Manager PIN required to process a refund', 400);
  }
  const rateLimitKey = `pin:${req.clientIp}:refund`;
  if (!req.checkPinRateLimit(rateLimitKey)) {
    throw httpError('Too many PIN attempts. Try again in 15 minutes.', 429);
  }
  const approver = resolveRefundApprover(db, req.overridePin, req.approverId, lateRefund);
  if (!approver) throw httpError(lateRefund ? 'Invalid owner PIN' : 'Invalid manager PIN', 403);

  const timestamp = now();

  if (item) {
    // Insert negative void_adjustment row to reverse item cost while preserving audit trail.
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

  const cashSessionId = getOpenSession(db)?.id ?? NO_CASH_SESSION_ID;
  const insertResult = db.prepare(`
    INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at, cash_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.billId, req.orderItemId ?? null, amountCents, req.method, req.reason ?? null, req.shiftId ?? null, approver.id, req.createdByUserId, timestamp, cashSessionId);

  const newRefundedCents = refundedCents + amountCents;
  const paymentStatus = newRefundedCents >= paidCents ? 'refunded' : 'partially_refunded';
  db.prepare('UPDATE bills SET payment_status = ?, updated_at = ? WHERE id = ?').run(paymentStatus, timestamp, req.billId);

  if (isStoreCreditRefund) {
    // A plain 'credit' row — wallet-funded spend is already excluded from the cashback base.
    const creditAmount = (amountCents / minorFactor) * LOYALTY_REDEMPTION_RATE;
    db.prepare(`
      INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
      VALUES (?, ?, 'credit', ?, ?, ?, ?)
    `).run(bill.customer_id, req.billId, creditAmount, `Refund credit for bill ${bill.bill_number}`, timestamp, timestamp);
  }

  recordOrderAudit(db, {
    orderId: bill.order_id,
    orderItemId: req.orderItemId ?? null,
    actorUserId: req.createdByUserId,
    action: 'refund_issued',
    details: {
      refundId: insertResult.lastInsertRowid,
      billId: req.billId,
      amountCents,
      method: req.method,
      lateRefund,
      approvedBy: approver.id,
      reason: req.reason ?? null,
    },
  });

  const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(insertResult.lastInsertRowid);
  const freshBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.billId);
  const result: RefundResult = { refund, bill: freshBill };

  if (req.idempotencyKey && req.requestHash) {
    db.prepare('INSERT INTO refund_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.createdByUserId, req.idempotencyKey, String(req.billId), req.requestHash, JSON.stringify(result), timestamp);
  }

  return result;
}
