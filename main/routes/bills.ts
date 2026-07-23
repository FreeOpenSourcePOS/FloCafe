import { Router, Request, Response } from 'express';
import { getDatabase, generateBillNumber, now, withTxn, getSettingValue, parseRowJson, verifyPin } from '../db';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { printReceipt } from '../services/receipt';
import { requireRole } from '../middleware/security';

const router = Router();

// Fixed conversion rate for redeeming loyalty wallet points as payment (points per 1 currency unit).
const LOYALTY_REDEMPTION_RATE = 100;

// Rate limiting for PIN validation (simple in-memory)
const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkPinRateLimit(key: string): boolean {
  const nowMs = Date.now();
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
      query += " AND date(created_at) = date('now')";
    }

    query += ' ORDER BY created_at DESC';

    if (req.query.per_page) {
      const perPage = Math.min(Math.max(parseInt(req.query.per_page as string) || 50, 1), 500);
      query += ` LIMIT ${perPage}`;
    }

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

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get((bill as any).order_id);
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

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get((bill as any).order_id);
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
      const orderRoundOff      = order.round_off       || 0;
      const orderTotal         = order.total           || 0;

      const totalsChanged =
        existingBill.payment_status !== 'paid' && (
          existingBill.discount_amount !== orderDiscountAmt ||
          existingBill.subtotal        !== orderSubtotal    ||
          existingBill.total           !== orderTotal
        );

      if (totalsChanged) {
        const newBalance = Math.max(0, orderTotal - (existingBill.paid_amount || 0));
        db.prepare(`
          UPDATE bills
          SET subtotal       = ?,
              tax_amount     = ?,
              tax_breakdown  = ?,
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
          orderSubtotal, orderTaxAmount, order.tax_breakdown,
          orderDiscountAmt, order.discount_type, order.discount_value, order.discount_reason,
          orderDelivery, orderPackaging, orderRoundOff,
          orderTotal, newBalance, now(),
          existingBill.id
        );

        const updatedBill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(existingBill.id));
        return res.json({ bill: updatedBill });
      }

      return res.json({ bill: parseRowJson(existingBill) });
    }

    const result = withTxn(() => {
      // Generate bill number inside transaction to prevent race conditions
      const billNumber = generateBillNumber();
      const subtotal = order.subtotal || 0;
      const taxAmount = order.tax_amount || 0;
      const discountAmount = order.discount_amount || 0;
      const deliveryCharge = order.delivery_charge || 0;
      const packagingCharge = order.packaging_charge || 0;
      const roundOff = order.round_off || 0;
      const total = order.total || 0;

      return db.prepare(`
        INSERT INTO bills (bill_number, order_id, customer_id, subtotal, tax_amount, tax_breakdown,
          discount_amount, discount_type, discount_value, discount_reason,
          delivery_charge, packaging_charge, round_off, total, paid_amount, balance, payment_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?)
      `).run(
        billNumber, order_id, order.customer_id, subtotal, taxAmount, order.tax_breakdown,
        discountAmount, order.discount_type, order.discount_value, order.discount_reason,
        deliveryCharge, packagingCharge, roundOff, total, 0, total, now(), now()
      );
    });

    const bill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(result.lastInsertRowid));
    notifyOrderUpdated();
    res.status(201).json({ bill });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/payment', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const { method, amount, transaction_id, notes, customer_id: bodyCustomerId } = req.body;

    if (!method) {
      return res.status(400).json({ error: 'Payment method is required' });
    }

    const db = getDatabase();

    // BUG #2 FIX: Entire payment logic inside transaction to prevent race conditions
    const result = withTxn(() => {
      // Re-read bill inside transaction — gets current state even under concurrent access
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id) as any;
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
          // BUG #20 FIX: Calculate cashback on discounted subtotal (proportional)
          const order = db.prepare('SELECT subtotal, discount_amount FROM orders WHERE id = ?').get(bill.order_id) as any;
          const orderDiscount = order?.discount_amount || 0;
          const orderSubtotal = order?.subtotal || 0;

          const items = db.prepare(`
            SELECT oi.subtotal, p.cb_percent
            FROM order_items oi
            JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = ? AND oi.status != 'cancelled'
          `).all(bill.order_id) as { subtotal: number; cb_percent: number }[];
          for (const item of items) {
            let effectiveSubtotal = item.subtotal;
            // Apply proportional discount to each item's subtotal
            if (orderDiscount > 0 && orderSubtotal > 0) {
              const itemDiscountShare = orderDiscount * (item.subtotal / orderSubtotal);
              effectiveSubtotal = Math.max(0, item.subtotal - itemDiscountShare);
            }
            // Points earned come solely from each item's own cashback percentage
            if (item.cb_percent > 0) {
              loyaltyCashbackToCredit += Math.floor(effectiveSubtotal * item.cb_percent / 100) * 100; // Multiply by LOYALTY_REDEMPTION_RATE (100) to store as points instead of raw currency
            }
          }
        }
      }

      // BUG #8 FIX: Default to remaining balance (not full total)
      const remainingBalance = Math.max(0, bill.total - bill.paid_amount);

      // BUG #1 + #7 FIX: Validate amount is a finite positive number
      let paidAmount: number;
      if (amount !== undefined && amount !== null) {
        const parsed = parseFloat(amount);
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
          .run(effectiveCustomerId, now(), req.params.id);
        bill.customer_id = effectiveCustomerId;
      }

      let walletDebited = false;
      let walletCurrencyAmount = 0; // Track wallet amount in currency for cashback reduction
      let actualLoyaltyPointsEarned = 0; // Track actual cashback credited

      if (method === 'wallet') {
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
        walletCurrencyAmount = paidAmount; // Track for cashback reduction
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
        now(), req.params.id
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

      const updatedBill = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id));
      return { bill: updatedBill, walletDebited, loyaltyPointsEarned: actualLoyaltyPointsEarned };
    });

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

router.post('/:id/applyDiscount', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { type, value, reason } = req.body;

    if (!type || !['percentage', 'amount'].includes(type)) {
      return res.status(400).json({ error: 'Valid discount type is required (percentage, amount)' });
    }

    if (value === undefined || value < 0) {
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
      const user = db.prepare("SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN ('owner', 'manager')")
        .all()
        .find((u: any) => verifyPin(u.pin_hash, override_pin));
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
      discountAmount = (bill.subtotal * parseFloat(value)) / 100;
    } else {
      discountAmount = parseFloat(value);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;

    // Recalculate tax on discounted subtotal (India GST is on post-discount value)
    const discountedSubtotal = Math.max(0, bill.subtotal - discountAmount);
    let newTaxAmount = bill.tax_amount || 0;
    if (discountAmount > 0 && bill.subtotal > 0) {
      const taxRatio = discountedSubtotal / bill.subtotal;
      newTaxAmount = Math.round((bill.tax_amount || 0) * taxRatio * 100) / 100;
    }

    const preRoundTotal = discountedSubtotal + newTaxAmount + (bill.delivery_charge || 0) + (bill.packaging_charge || 0);
    const newTotal = Math.round(preRoundTotal);
    const newRoundOff = newTotal - preRoundTotal;
    const newBalance = Math.max(0, newTotal - (bill.paid_amount || 0));

    const updatedBill = withTxn(() => {
      db.prepare(`
        UPDATE bills SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, total = ?, round_off = ?, balance = ?, updated_at = ?
        WHERE id = ?
      `).run(discountAmount, type, value, reason || null, newTaxAmount, newTotal, newRoundOff, newBalance, now(), req.params.id);

      db.prepare(`
        UPDATE orders SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, total = ?, round_off = ?, updated_at = ?
        WHERE id = ?
      `).run(discountAmount, type, value, reason || null, newTaxAmount, newTotal, newRoundOff, now(), bill.order_id);

      return parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id));
    });

    notifyOrderUpdated();
    res.json({ bill: updatedBill });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
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

    const result = await printReceipt(parseInt(req.params.id), userId, print_type);
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
