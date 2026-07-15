import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';

function parseCustomer(c: any): any {
  if (!c) return c;
  return {
    ...c,
    tag_counts: c.tag_counts ? (() => { try { return JSON.parse(c.tag_counts); } catch { return null; } })() : null,
  };
}

const router = Router();

function getWalletBalance(customerId: string | number | null): number {
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
router.delete('/admin/cleanup', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare("DELETE FROM customers WHERE id IS NULL").run();
    res.json({ message: `Deleted ${result.changes} customers with null IDs` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = `SELECT c.*,
      COALESCE((SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id), 0) as visits_count,
      COALESCE((SELECT SUM(total) FROM orders o WHERE o.customer_id = c.id), 0) as total_spent,
      MAX(0,
        COALESCE((SELECT SUM(ll.amount) FROM loyalty_ledger ll WHERE ll.customer_id = c.id AND ll.type = 'credit'), 0) -
        COALESCE((SELECT SUM(ll.amount) FROM loyalty_ledger ll WHERE ll.customer_id = c.id AND ll.type = 'debit'), 0)
      ) as wallet_balance
      FROM customers c WHERE c.is_active = 1`;
    const params: any[] = [];

    if (req.query.search) {
      const search = `%${req.query.search}%`;
      query += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)';
      params.push(search, search, search);
    }

    query += ' ORDER BY c.name';

    if (req.query.per_page) {
      query += ` LIMIT ${parseInt(req.query.per_page as string)}`;
    }

    const customers = db.prepare(query).all(...params);
    res.json({ data: customers });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/search', (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    if (!q || String(q).length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const db = getDatabase();
    const searchTerm = `%${q}%`;

    const customers = db.prepare(`
      SELECT * FROM customers
      WHERE is_active = 1 AND (phone LIKE ? OR name LIKE ? OR email LIKE ?)
      ORDER BY name LIMIT 20
    `).all(searchTerm, searchTerm, searchTerm);

    res.json({ customers: customers.map(parseCustomer) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customerRaw = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customerRaw) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = parseCustomer(customerRaw);

    const walletBalance = getWalletBalance(req.params.id);
    const loyaltyHistory = db.prepare(`
      SELECT * FROM loyalty_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(req.params.id);

    const recentOrders = db.prepare(`
      SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(req.params.id);

    res.json({ customer: { ...customer, walletBalance, loyaltyHistory, recentOrders } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/wallet', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customerId = req.params.id;
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
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const { phone, name, email, address, notes, country_code } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const db = getDatabase();

    if (phone) {
      const existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) as any;
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
            country_code ? String(country_code).trim() : '',
            address ? String(address).trim() : null,
            notes ? String(notes).trim() : null,
            now(),
            existing.id
          );
          const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
          return res.status(201).json({ customer });
        } else {
          return res.status(400).json({ message: 'Customer with this phone already exists' });
        }
      }
    }

    const id = 'cust-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    db.prepare(`
      INSERT INTO customers (id, phone, name, email, country_code, address, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      phone ? String(phone).trim() : null,
      String(name).trim(),
      email ? String(email).trim() : null,
      country_code ? String(country_code).trim() : null,
      address ? String(address).trim() : null,
      notes ? String(notes).trim() : null,
      now(),
      now()
    );

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    res.status(201).json({ customer });
  } catch (error: any) {
    console.error('[Customer POST error]', error);
    res.status(500).json({ message: 'Failed to create customer: ' + error.message });
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const {
      phone, name, email, address, notes, country_code
    } = req.body;
    const db = getDatabase();

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    db.prepare(`
      UPDATE customers SET
        phone = COALESCE(NULLIF(?, ''), phone),
        name = COALESCE(NULLIF(?, ''), name),
        email = COALESCE(NULLIF(?, ''), email),
        country_code = COALESCE(NULLIF(?, ''), country_code),
        address = COALESCE(NULLIF(?, ''), address),
        notes = COALESCE(NULLIF(?, ''), notes),
        updated_at = ?
      WHERE id = ?
    `).run(
      phone, name, email, country_code, address, notes, now(), req.params.id
    );

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    res.json({ customer: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id) as any;
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Never hard-delete — orders/bills/loyalty_ledger reference customer_id with
    // no FK, so removing the row would silently orphan historical records.
    db.prepare('UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    res.json({ message: 'Customer deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const customerRoutes = router;
