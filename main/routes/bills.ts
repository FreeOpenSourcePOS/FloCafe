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

const router = Router();

function getOrderWithItems(db: ReturnType<typeof getDatabase>, orderId: number): any {
  const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  if (!order) return order;
  const itemRows = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[];
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

router.get('/', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM bills WHERE 1=1';
    const params: any[] = [];

    if (req.query.status) {
      query += ' AND payment_status = ?';
      params.push(req.query.status);
    }
    if (req.query.order_id) {
      query += ' AND order_id = ?';
      params.push(req.query.order_id);
    }
    if (req.query.customer_id) {
      query += ' AND customer_id = ?';
      params.push(req.query.customer_id);
    }
    if (req.query.today === 'true') {
      // #208: UTC-day range hits `idx_bills_created_at` instead of date() on every row.
      const [s, e] = utcDayBounds(utcTodayDate());
      query += ' AND created_at >= ? AND created_at < ?';
      params.push(s, e);
    }

    query += ' ORDER BY created_at DESC';

    // #208: default page size of 50 and a hard cap even when clients omit
    // per_page — the previous "unbounded" default could return every bill
    // ever when a caller left the param off.
    const requestedPerPage = req.query.per_page ? parseInt(req.query.per_page as string, 10) : NaN;
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(Math.max(requestedPerPage, 1), 500)
      : 50;
    query += ' LIMIT ?';
    params.push(perPage);

    const bills = db.prepare(query).all(...params).map(parseRowJson);
    res.json({ bills });
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

    const order = getOrderWithItems(db, (bill as any).order_id);
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

    const order = getOrderWithItems(db, (bill as any).order_id);
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

interface PaymentInput {
  method: string;
  amount?: number | string;
  transaction_id?: string;
  notes?: string;
}

// Applies one payment line to a bill: validates it, debits wallet points if needed,
// updates paid_amount/balance/payment_status, and — once the bill is fully paid —
// completes the order, frees the table, and credits loyalty cashback.
//
// Must always be called from inside a withTxn() block. It re-reads the bill fresh
// on every call (rather than accepting it as a parameter), so that calling this
// repeatedly inside a single transaction for a multi-line split payment (#177) has
// each line see the balance left by the previous one, and a validation failure on
// any line throws — rolling back every payment applied so far in that transaction,
// not just the failing one.
function applyPayment(
  db: ReturnType<typeof getDatabase>,
  billId: string,
  payment: PaymentInput,
  bodyCustomerId?: string | number,
): { bill: any; walletDebited: boolean; loyaltyPointsEarned: number } {
  const { method, amount, transaction_id, notes } = payment;

  if (!method) {
    throw Object.assign(new Error('Payment method is required'), { statusCode: 400 });
  }

  // Re-read bill inside transaction — gets current state even under concurrent access
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
  if (!bill) {
    throw Object.assign(new Error('Bill not found'), { statusCode: 404 });
  }

  if (bill.payment_status === 'paid') {
    throw Object.assign(new Error('Bill is already paid'), { statusCode: 400 });
  }

  // Compute cashback eligibility inside the transaction so it reads the
  // same consistent snapshot the payment itself commits against —
  // computing this outside withTxn left a TOCTOU gap where concurrent
  // discount/order changes could produce stale cashback (vuln-0006).
  let loyaltyCashbackToCredit = 0;
  {
    const effectiveCustomerIdForCashback = bill.customer_id || (bodyCustomerId ? String(bodyCustomerId) : null);
    const loyaltySetting = (db.prepare(
      `SELECT value FROM settings WHERE key = 'loyalty_enabled'`
    ).get() as any)?.value;
    if ((loyaltySetting === 'true' || loyaltySetting === '1') && effectiveCustomerIdForCashback) {
      const globalCbSetting = (db.prepare(
        `SELECT value FROM settings WHERE key = 'global_cashback_percent'`
      ).get() as any)?.value;
      const globalCbRate = parseFloat(globalCbSetting || '0');

      // BUG #20 FIX: Calculate cashback on discounted subtotal (proportional)
      const order = db.prepare('SELECT subtotal, discount_amount FROM orders WHERE id = ?').get(bill.order_id) as any;
      const orderDiscount = order?.discount_amount || 0;
      const orderSubtotal = order?.subtotal || 0;

      const items = db.prepare(`
        SELECT oi.subtotal, p.cb_percent
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.status != 'cancelled'
      `).all(bill.order_id) as { subtotal: number; cb_percent: number | null }[];
      for (const item of items) {
        let effectiveSubtotal = item.subtotal;
        // Apply proportional discount to each item's subtotal
        if (orderDiscount > 0 && orderSubtotal > 0) {
          const itemDiscountShare = orderDiscount * (item.subtotal / orderSubtotal);
          effectiveSubtotal = Math.max(0, item.subtotal - itemDiscountShare);
        }
        // Tri-state: NULL inherits the global rate, 0 explicitly earns nothing,
        // a positive value is the item's own custom rate (loyalty overhaul, #81).
        const effectiveCbRate = item.cb_percent !== null ? item.cb_percent : globalCbRate;
        if (effectiveCbRate > 0) {
          loyaltyCashbackToCredit += Math.floor(effectiveSubtotal * effectiveCbRate / 100) * 100; // Multiply by LOYALTY_REDEMPTION_RATE (100) to store as points instead of raw currency
        }
      }
    }
  }

  // BUG #8 FIX: Default to remaining balance (not full total)
  const remainingBalance = Math.max(0, bill.total - bill.paid_amount);

  // BUG #1 + #7 FIX: Validate amount is a finite positive number
  let paidAmount: number;
  if (amount !== undefined && amount !== null) {
    const parsed = parseFloat(String(amount));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw Object.assign(new Error('Payment amount must be a finite number greater than zero'), { statusCode: 400 });
    }
    // BUG #9 FIX: Cap at remaining balance (prevents overpayment)
    paidAmount = Math.min(parsed, remainingBalance);
  } else {
    // No amount specified — pay the remaining balance
    paidAmount = remainingBalance;
  }

  if (paidAmount <= 0) {
    throw Object.assign(new Error('Bill is already fully paid'), { statusCode: 400 });
  }

  const newPaidAmount = bill.paid_amount + paidAmount;
  const newBalance = Math.max(0, bill.total - newPaidAmount);
  const paymentStatus = newBalance <= 0.01 ? 'paid' : 'partial';

  // BUG #10 FIX: Handle malformed payment_details gracefully
  const existingPayments: any[] = (() => {
    if (!bill.payment_details) return [];
    try {
      const parsed = JSON.parse(bill.payment_details);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  })();
  existingPayments.push({ method, amount: paidAmount, transaction_id, notes, timestamp: now() });

  const effectiveCustomerId = bill.customer_id || (bodyCustomerId ? String(bodyCustomerId) : null);

  // Update bill's customer_id if it was missing and one was provided
  if (!bill.customer_id && effectiveCustomerId) {
    db.prepare('UPDATE bills SET customer_id = ?, updated_at = ? WHERE id = ?')
      .run(effectiveCustomerId, now(), billId);
    bill.customer_id = effectiveCustomerId;
  }

  let walletDebited = false;
  let actualLoyaltyPointsEarned = 0; // Track actual cashback credited

  if (method === 'wallet') {
    if (!bill.customer_id) {
      throw Object.assign(new Error('Customer association is required for wallet payment'), { statusCode: 400 });
    }
    // Convert currency amount to points using redemption rate
    // e.g., if redemption_rate=100 and customer pays ₹50, debit 5000 points
    const pointsToDebit = Math.ceil(paidAmount * LOYALTY_REDEMPTION_RATE);

    // Check wallet balance INSIDE transaction to prevent double-spend
    const credits = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
      WHERE customer_id = ? AND type = 'credit' AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(bill.customer_id) as { total: number };
    const debits = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
      WHERE customer_id = ? AND type = 'debit'
    `).get(bill.customer_id) as { total: number };
    const walletBalance = Math.max(0, credits.total - debits.total);
    if (walletBalance < pointsToDebit) {
      const availableCurrency = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
      throw Object.assign(new Error(`Insufficient wallet balance. Available: ${availableCurrency} (${walletBalance} points), Required: ${paidAmount}`), { statusCode: 400 });
    }

    db.prepare(`
      INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
      VALUES (?, ?, 'debit', ?, ?, ?, ?)
    `).run(bill.customer_id, bill.id, pointsToDebit, `Payment for bill ${bill.bill_number}`, now(), now());
    walletDebited = true;
  }

  db.prepare(`
    UPDATE bills SET paid_amount = ?, balance = ?, payment_status = ?,
      payment_details = ?,
      paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END,
      updated_at = ?
    WHERE id = ?
  `).run(
    newPaidAmount, newBalance, paymentStatus,
    JSON.stringify(existingPayments),
    paymentStatus, paymentStatus === 'paid' ? now() : null,
    now(), billId
  );

  if (paymentStatus === 'paid') {
    db.prepare("UPDATE orders SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), bill.order_id);

    const order = db.prepare('SELECT table_id FROM orders WHERE id = ?').get(bill.order_id) as any;
    if (order && order.table_id) {
      db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
        .run(now(), order.table_id);
    }

    // Credit per-item cashback (idempotent — skip if already credited for this bill)
    // Reduce cashback proportionally for wallet-paid portion (no cashback on points spent)
    if (loyaltyCashbackToCredit > 0 && effectiveCustomerId) {
      const alreadyCredited = db.prepare(
        `SELECT id FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'`
      ).get(bill.id);
      if (!alreadyCredited) {
        let finalCashback = loyaltyCashbackToCredit;
        // Calculate total wallet amount from ALL payments (current + prior)
        // This handles split payments where wallet was used in an earlier call
        const totalWalletPaid = existingPayments
          .filter((p: any) => p.method === 'wallet')
          .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
        if (totalWalletPaid > 0 && bill.total > 0) {
          const walletProportion = Math.min(1, totalWalletPaid / bill.total);
          finalCashback = Math.floor(loyaltyCashbackToCredit * (1 - walletProportion));
        }
        if (finalCashback > 0) {
          db.prepare(`
            INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
            VALUES (?, ?, 'credit', ?, ?, ?, ?)
          `).run(
            effectiveCustomerId, bill.id, finalCashback,
            `Cashback on bill ${bill.bill_number}`,
            now(), now()
          );
          actualLoyaltyPointsEarned = finalCashback;
        }
      }
    }
  }

  const updatedBill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(billId));
  return { bill: updatedBill, walletDebited, loyaltyPointsEarned: actualLoyaltyPointsEarned };
}

router.post('/:id/payment', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = withTxn(() => applyPayment(db, req.params.id as string, req.body, req.body.customer_id));

    const billStatus = (result.bill as any)?.payment_status;
    if (billStatus === 'paid') notifyKdsUpdate();
    notifyOrderUpdated();

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
    const { payments, customer_id: bodyCustomerId } = req.body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'payments must be a non-empty array' });
    }

    const db = getDatabase();
    const result = withTxn(() => {
      let last: { bill: any; walletDebited: boolean; loyaltyPointsEarned: number } | null = null;
      let anyWalletDebited = false;
      let totalLoyaltyPointsEarned = 0;
      for (const payment of payments) {
        last = applyPayment(db, req.params.id as string, payment, bodyCustomerId);
        anyWalletDebited = anyWalletDebited || last.walletDebited;
        totalLoyaltyPointsEarned += last.loyaltyPointsEarned;
      }
      return { bill: last!.bill, walletDebited: anyWalletDebited, loyaltyPointsEarned: totalLoyaltyPointsEarned };
    });

    const billStatus = (result.bill as any)?.payment_status;
    if (billStatus === 'paid') notifyKdsUpdate();
    notifyOrderUpdated();

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
