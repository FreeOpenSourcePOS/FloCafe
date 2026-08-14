import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDatabase, now, getSettingValue } from '../db';
import { requireRole } from '../middleware/security';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';

export function parseCustomer(c: any): any {
  if (!c) return c;
  return {
    ...c,
    tag_counts: c.tag_counts ? (() => { try { return JSON.parse(c.tag_counts); } catch { return null; } })() : null,
  };
}

const router = Router();

export function getWalletBalance(customerId: string | number | null): number {
  if (!customerId) return 0;
  const db = getDatabase();
  const credits = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
    WHERE customer_id = ? AND type = 'credit'
  `).get(customerId) as { total: number };

  const debits = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
    WHERE customer_id = ? AND type = 'debit'
  `).get(customerId) as { total: number };

  return Math.max(0, credits.total - debits.total);
}

// Cleanup endpoint: delete all customers with null IDs - must be before /:id
router.delete('/admin/cleanup', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare("DELETE FROM customers WHERE id IS NULL").run();
    res.json({ message: `Deleted ${result.changes} customers with null IDs` });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/admin/repair-phones', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const tenantCountry = getSettingValue('country') || 'IN';
    const customers = db.prepare(`
      SELECT id, phone, country_code
      FROM customers
      WHERE is_active = 1
      AND phone IS NOT NULL AND phone != ''
      AND phone != '+' || phone_digits
    `).all() as Array<{ id: string; phone: string; country_code: string | null }>;

    let normalizedCount = 0;
    let unparseableCount = 0;
    let conflictedCount = 0;

    for (const c of customers) {
      const parsed = parsePhoneE164(c.phone, tenantCountry);
      if (parsed) {
        const phoneDigits = stripPhoneDigits(parsed.e164);
        const conflict = db.prepare('SELECT id FROM customers WHERE phone_digits = ? AND id != ?').get(phoneDigits, c.id) as any;
        if (conflict) {
          conflictedCount++;
        } else {
          db.prepare('UPDATE customers SET phone = ?, country_code = ?, updated_at = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, now(), c.id);
          normalizedCount++;
        }
      } else {
        unparseableCount++;
      }
    }

    res.json({
      totalScanned: customers.length,
      normalizedCount,
      unparseableCount,
      conflictedCount,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/alerts', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare(`
      SELECT COUNT(*) as count 
      FROM customers 
      WHERE is_active = 1 
      AND phone IS NOT NULL AND phone != '' 
      AND phone != '+' || phone_digits
    `).get() as { count: number };
    
    res.json({ invalidPhonesCount: result.count });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    // #208: the previous version ran 4 correlated subqueries per customer
    // (visits, spent, wallet credits, wallet debits, last visit) and never
    // hit any index for `WHERE o.customer_id = c.id`. The equivalent join
    // uses the new `idx_orders_customer` and groups once. Aggregates across
    // customers sit in three CTEs so each scans its index once.
    let query = `
      WITH order_stats AS (
        SELECT customer_id,
          COUNT(*) AS visits_count,
          COALESCE(SUM(total), 0) AS total_spent,
          MAX(created_at) AS last_visit_at
        FROM orders
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id
      ),
      ledger_credits AS (
        SELECT customer_id, COALESCE(SUM(amount), 0) AS credits
        FROM loyalty_ledger
        WHERE type = 'credit'
        GROUP BY customer_id
      ),
      ledger_debits AS (
        SELECT customer_id, COALESCE(SUM(amount), 0) AS debits
        FROM loyalty_ledger
        WHERE type = 'debit'
        GROUP BY customer_id
      )
      SELECT c.*,
        COALESCE(os.visits_count, 0) as visits_count,
        COALESCE(os.total_spent, 0) as total_spent,
        MAX(0, COALESCE(lc.credits, 0) - COALESCE(ld.debits, 0)) as wallet_balance,
        os.last_visit_at
      FROM customers c
      LEFT JOIN order_stats os ON os.customer_id = c.id
      LEFT JOIN ledger_credits lc ON lc.customer_id = c.id
      LEFT JOIN ledger_debits ld ON ld.customer_id = c.id
      WHERE c.is_active = 1
    `;
    const params: any[] = [];

    if (req.query.search) {
      const search = `%${req.query.search}%`;
      query += ' AND (c.name LIKE ? OR c.phone_digits LIKE ? OR c.email LIKE ?)';
      params.push(search, search, search);
    }

    if (req.query.filter === 'invalid_phones') {
      query += " AND c.phone IS NOT NULL AND c.phone != '' AND c.phone != '+' || c.phone_digits";
    }

    const sortField = (req.query.sort as string) || 'name';
    const sortOrder = (req.query.order as string) === 'desc' ? 'DESC' : 'ASC';
    
    const allowedSortFields: Record<string, string> = {
      name: 'c.name COLLATE NOCASE',
      phone: 'c.phone_digits',
      visits: 'visits_count',
      spent: 'total_spent',
      loyalty: 'wallet_balance',
      last_visit: 'last_visit_at'
    };

    const orderBy = allowedSortFields[sortField] || 'c.name COLLATE NOCASE';
    query += ` ORDER BY ${orderBy} ${sortOrder}`;

    if (req.query.per_page !== undefined) {
      const rawPerPage = String(req.query.per_page).trim();
      if (!/^\d+$/.test(rawPerPage)) {
        return res.status(400).json({ error: 'Invalid per_page parameter. Must be a positive integer.' });
      }
      const parsed = parseInt(rawPerPage, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'Invalid per_page parameter. Must be a positive integer.' });
      }
      const limit = Math.min(parsed, 500);
      query += ` LIMIT ${limit}`;
    } else {
      // #208: unbounded default meant every customers list response fanned
      // the full backend on each search keystroke. Cap at 200 as a sensible
      // first-page default; clients that need more can page (cursor support
      // is a follow-up).
      query += ` LIMIT 200`;
    }

    const customers = db.prepare(query).all(...params);
    res.json({ data: customers });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customerRaw = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customerRaw) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = parseCustomer(customerRaw);

    const walletBalance = getWalletBalance(req.params.id as string);
    const loyaltyHistory = db.prepare(`
      SELECT * FROM loyalty_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(req.params.id);

    const recentOrders = db.prepare(`
      SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(req.params.id);

    res.json({ customer: { ...customer, walletBalance, loyaltyHistory, recentOrders } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id/wallet', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customerId = req.params.id as string;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const balance = getWalletBalance(customerId);
    const transactions = db.prepare(`
      SELECT * FROM loyalty_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(customerId);

    res.json({ balance, transactions });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const { phone, name, email, address, notes, country_code } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const db = getDatabase();

    let finalPhone = phone ? String(phone).trim() : null;
    let finalCountryCode = country_code ? String(country_code).trim() : null;

    if (finalPhone) {
      const tenantCountry = getSettingValue('country') || 'IN';
      const parsed = parsePhoneE164(finalPhone, tenantCountry);
      if (!parsed) {
        return res.status(400).json({ message: 'Phone number is not valid. Use international format (e.g. +919876543210).' });
      }
      finalPhone = parsed.e164;
      finalCountryCode = parsed.countryCode;

      const phoneDigits = stripPhoneDigits(finalPhone);
      const existing = db.prepare('SELECT * FROM customers WHERE phone_digits = ?').get(phoneDigits) as any;
      if (existing) {
        if (existing.is_active === 0) {
          db.prepare(`
            UPDATE customers SET
              name = ?,
              email = ?,
              country_code = COALESCE(NULLIF(?, ''), country_code),
              address = ?,
              notes = ?,
              is_active = 1,
              updated_at = ?
            WHERE id = ?
          `).run(
            String(name).trim(),
            email ? String(email).trim() : null,
            finalCountryCode,
            address ? String(address).trim() : null,
            notes ? String(notes).trim() : null,
            now(),
            existing.id
          );
          const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
          return res.status(201).json({ customer });
        } else {
          return res.status(409).json({ message: 'Customer with this phone already exists' });
        }
      }
    }

    const id = `cust-${randomUUID()}`;
    const timestamp = now();
    db.prepare(`
      INSERT INTO customers (id, phone, name, email, country_code, address, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      finalPhone,
      String(name).trim(),
      email ? String(email).trim() : null,
      finalCountryCode,
      address ? String(address).trim() : null,
      notes ? String(notes).trim() : null,
      timestamp,
      timestamp
    );

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    res.status(201).json({ customer });
  } catch (error: any) {
    console.error('[Customer POST error]', error);
    res.status(500).json({ message: 'Failed to create customer' });
  }
});

router.put('/:id', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const {
      phone, name, email, address, notes, country_code
    } = req.body;
    const db = getDatabase();

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id) as any;
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    let finalPhone: string | null = customer.phone;
    let finalCountryCode: string | null = customer.country_code;

    if (phone !== undefined) {
      if (phone === null || String(phone).trim() === '') {
        finalPhone = null;
        finalCountryCode = null;
      } else {
        const tenantCountry = getSettingValue('country') || 'IN';
        const parsed = parsePhoneE164(String(phone).trim(), tenantCountry);
        if (!parsed) {
          return res.status(400).json({ error: 'Phone number is not valid. Use international format (e.g. +919876543210).' });
        }
        finalPhone = parsed.e164;
        finalCountryCode = parsed.countryCode;

        const phoneDigits = stripPhoneDigits(finalPhone);
        const existing = db.prepare('SELECT id FROM customers WHERE phone_digits = ? AND id != ?').get(phoneDigits, req.params.id) as any;
        if (existing) {
          return res.status(409).json({ error: 'Customer with this phone already exists' });
        }
      }
    } else if (country_code !== undefined) {
      finalCountryCode = country_code ? String(country_code).trim() : null;
    }

    let finalName = customer.name;
    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'Name is required' });
      }
      finalName = trimmedName;
    }

    const finalEmail = email !== undefined ? (email ? String(email).trim() : null) : customer.email;
    const finalAddress = address !== undefined ? (address ? String(address).trim() : null) : customer.address;
    const finalNotes = notes !== undefined ? (notes ? String(notes).trim() : null) : customer.notes;

    db.prepare(`
      UPDATE customers SET
        phone = ?,
        name = ?,
        email = ?,
        country_code = ?,
        address = ?,
        notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      finalPhone, finalName, finalEmail, finalCountryCode, finalAddress, finalNotes, now(), req.params.id
    );

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    res.json({ customer: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Customers are never deletable — not even soft-deleted — by design: every
// row is permanently referenced by orders/bills/loyalty_ledger with no FK,
// and losing a customer's history/loyalty standing is worse than a stale
// record. There is intentionally no DELETE /:id route.

export const customerRoutes = router;
