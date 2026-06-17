import { Router, Request, Response } from 'express';
import { getDatabase, generateBillNumber, now, withTxn } from '../db';
import { notifyKdsUpdate } from '../services/kds';

const router = Router();

router.get('/', (req: Request, res: Response) => {
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
      query += ` LIMIT ${parseInt(req.query.per_page as string)}`;
    }

    const bills = db.prepare(query).all(...params);
    res.json({ bills });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get((bill as any).order_id);
    const customer = (bill as any).customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get((bill as any).customer_id) : null;

    res.json({ bill: { ...bill, order, customer } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', (req: Request, res: Response) => {
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

    const existingBill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(order_id);
    if (existingBill) {
      // Return existing bill instead of error
      return res.json({ bill: existingBill });
    }

    const billNumber = generateBillNumber();
    const subtotal = order.subtotal || 0;
    const taxAmount = order.tax_amount || 0;
    const discountAmount = order.discount_amount || 0;
    const deliveryCharge = order.delivery_charge || 0;
    const packagingCharge = order.packaging_charge || 0;
    const roundOff = order.round_off || 0;
    const total = order.total || 0;

    const result = db.prepare(`
      INSERT INTO bills (bill_number, order_id, customer_id, subtotal, tax_amount, tax_breakdown,
        discount_amount, discount_type, discount_value, discount_reason,
        delivery_charge, packaging_charge, round_off, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?)
    `).run(
      billNumber, order_id, order.customer_id, subtotal, taxAmount, order.tax_breakdown,
      discountAmount, order.discount_type, order.discount_value, order.discount_reason,
      deliveryCharge, packagingCharge, roundOff, total, 0, total, now(), now()
    );

    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ bill });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/payment', (req: Request, res: Response) => {
  try {
    const { method, amount, transaction_id, notes, customer_id: bodyCustomerId } = req.body;

    if (!method) {
      return res.status(400).json({ error: 'Payment method is required' });
    }

    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id) as any;
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (bill.payment_status === 'paid') {
      return res.status(400).json({ error: 'Bill is already paid' });
    }

    const paidAmount = parseFloat(amount) || bill.total;

    // Pre-validate wallet balance OUTSIDE the txn so we can return a clean 400 without a rollback.
    if (method === 'wallet') {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(bill.customer_id) as any;
      if (!customer) {
        return res.status(400).json({ error: 'Customer not found for wallet payment' });
      }
      const credits = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
        WHERE customer_id = ? AND type = 'credit' AND (expires_at IS NULL OR expires_at > datetime('now'))
      `).get(bill.customer_id) as { total: number };
      const debits = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
        WHERE customer_id = ? AND type = 'debit'
      `).get(bill.customer_id) as { total: number };
      const walletBalance = Math.max(0, credits.total - debits.total);
      if (walletBalance < paidAmount) {
        return res.status(400).json({ error: 'Insufficient wallet balance', balance: walletBalance });
      }
    }

    const newPaidAmount = bill.paid_amount + paidAmount;
    const newBalance = Math.max(0, bill.total - newPaidAmount);
    const paymentStatus = newBalance <= 0.01 ? 'paid' : 'partial';

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

    // Pre-compute per-item cashback (only when this payment will fully settle the bill)
    let loyaltyCashbackToCredit = 0;
    let loyaltyExpiresAt: string | null = null;
    if (paymentStatus === 'paid' && effectiveCustomerId) {
      const loyaltySetting = (db.prepare(
        `SELECT value FROM settings WHERE key = 'loyalty_enabled'`
      ).get() as any)?.value;
      if (loyaltySetting === 'true') {
        const expiryRow = (db.prepare(
          `SELECT value FROM settings WHERE key = 'loyalty_expiry_days'`
        ).get() as any)?.value;
        const expiryDays = parseInt(expiryRow || '365');
        const expires = new Date();
        expires.setDate(expires.getDate() + expiryDays);
        loyaltyExpiresAt = expires.toISOString().slice(0, 19).replace('T', ' ');

        const items = db.prepare(`
          SELECT oi.subtotal, p.cb_percent
          FROM order_items oi
          JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ? AND p.cb_percent > 0
        `).all(bill.order_id) as { subtotal: number; cb_percent: number }[];
        for (const item of items) {
          loyaltyCashbackToCredit += Math.floor(item.subtotal * item.cb_percent / 100);
        }
      }
    }

    // Update bill's customer_id if it was missing and one was provided
    if (!bill.customer_id && effectiveCustomerId) {
      db.prepare('UPDATE bills SET customer_id = ?, updated_at = ? WHERE id = ?')
        .run(effectiveCustomerId, now(), req.params.id);
      bill.customer_id = effectiveCustomerId;
    }

    const result = withTxn(() => {
      let walletDebited = false;

      if (method === 'wallet') {
        db.prepare(`
          INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
          VALUES (?, ?, 'debit', ?, ?, ?, ?)
        `).run(bill.customer_id, bill.id, paidAmount, `Payment for bill ${bill.bill_number}`, now(), now());
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
        if (loyaltyCashbackToCredit > 0 && effectiveCustomerId) {
          const alreadyCredited = db.prepare(
            `SELECT id FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'`
          ).get(bill.id);
          if (!alreadyCredited) {
            db.prepare(`
              INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, expires_at, created_at, updated_at)
              VALUES (?, ?, 'credit', ?, ?, ?, ?, ?)
            `).run(
              effectiveCustomerId, bill.id, loyaltyCashbackToCredit,
              `Cashback on bill ${bill.bill_number}`,
              loyaltyExpiresAt, now(), now()
            );
          }
        }
      }

      const updatedBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
      return { bill: updatedBill, walletDebited, loyaltyPointsEarned: loyaltyCashbackToCredit };
    });

    if (paymentStatus === 'paid') notifyKdsUpdate();

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/applyDiscount', (req: Request, res: Response) => {
  try {
    const { type, value, reason } = req.body;

    if (!type || !['percentage', 'fixed'].includes(type)) {
      return res.status(400).json({ error: 'Valid discount type is required (percentage, fixed)' });
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

    let discountAmount = 0;
    if (type === 'percentage') {
      discountAmount = (bill.subtotal * parseFloat(value)) / 100;
    } else {
      discountAmount = parseFloat(value);
    }

    const newTotal = Math.max(0, bill.subtotal + bill.tax_amount + bill.delivery_charge + bill.packaging_charge - discountAmount + bill.round_off);
    const newBalance = newTotal - bill.paid_amount;

    const updatedBill = withTxn(() => {
      db.prepare(`
        UPDATE bills SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, total = ?, balance = ?, updated_at = ?
        WHERE id = ?
      `).run(discountAmount, type, value, reason || null, newTotal, newBalance, now(), req.params.id);

      db.prepare(`
        UPDATE orders SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, total = ?, updated_at = ?
        WHERE id = ?
      `).run(discountAmount, type, value, reason || null, newTotal, now(), bill.order_id);

      return db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    });

    res.json({ bill: updatedBill });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/markPrinted', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    db.prepare('UPDATE bills SET printed_at = ?, updated_at = ? WHERE id = ?')
      .run(now(), now(), req.params.id);

    const updatedBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    res.json({ bill: updatedBill });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const billRoutes = router;
