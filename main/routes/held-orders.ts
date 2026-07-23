import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { randomUUID } from 'crypto';

const router = Router();

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM held_orders ORDER BY updated_at DESC').all();
    const orders = rows.map((row: any) => ({
      id: row.id,
      tableId: row.table_id,
      items: JSON.parse(row.items),
      customerId: row.customer_id,
      guestCount: row.guest_count,
      orderNotes: row.order_notes,
      heldAt: row.created_at,
    }));
    res.json({ orders });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const { tableId, items, customerId, guestCount, orderNotes } = req.body;
    if (!tableId || !items) {
      return res.status(400).json({ error: 'tableId and items are required' });
    }

    const db = getDatabase();
    
    withTxn(() => {
      // Check if a held order already exists for this table
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId) as any;
      
      if (existing) {
        db.prepare(`
          UPDATE held_orders
          SET items = ?, customer_id = ?, guest_count = ?, order_notes = ?, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(items), customerId || null, guestCount || 1, orderNotes || '', now(), existing.id);
      } else {
        const id = `ho-${randomUUID().slice(0, 8)}`;
        db.prepare(`
          INSERT INTO held_orders (id, table_id, items, customer_id, guest_count, order_notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, tableId, JSON.stringify(items), customerId || null, guestCount || 1, orderNotes || '', now(), now());
      }

      // Update table status to held
      db.prepare("UPDATE tables SET status = 'held', updated_at = ? WHERE id = ?").run(now(), tableId);
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:tableId', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const tableId = req.params.tableId;
    const db = getDatabase();
    
    withTxn(() => {
      db.prepare('DELETE FROM held_orders WHERE table_id = ?').run(tableId);
      db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ? AND status = 'held'").run(now(), tableId);
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const heldOrderRoutes = router;
