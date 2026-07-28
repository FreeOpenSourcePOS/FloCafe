import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { randomUUID } from 'crypto';

const router = Router();

const TABLE_STATUS_HELD = 'held';
const TABLE_STATUS_AVAILABLE = 'available';

interface HeldOrderRow {
  id: string;
  table_id: string;
  items: string;
  customer_id: string | null;
  guest_count: number;
  order_notes: string | null;
  created_at: string;
  updated_at: string;
}

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM held_orders ORDER BY updated_at DESC').all() as HeldOrderRow[];
    const orders = rows.map((row) => ({
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
    console.error("[API] Held orders fetch error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const { tableId, items, customerId, guestCount, orderNotes } = req.body;
    if (!tableId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'tableId and non-empty items array are required' });
    }

    const db = getDatabase();
    
    withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId) as { id: string } | undefined;
      
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

      db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ?').run(TABLE_STATUS_HELD, now(), tableId);
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] Hold order error:", error);
    res.status(500).json({ error: "Could not hold order" });
  }
});

router.delete('/:tableId', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const tableId = req.params.tableId;
    const db = getDatabase();
    
    let deleted = false;
    withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId);
      if (existing) {
        db.prepare('DELETE FROM held_orders WHERE table_id = ?').run(tableId);
        db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(TABLE_STATUS_AVAILABLE, now(), tableId, TABLE_STATUS_HELD);
        deleted = true;
      }
    });

    if (!deleted) {
      return res.status(404).json({ error: 'No held order found for table' });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] Delete held order error:", error);
    res.status(500).json({ error: "Could not delete held order" });
  }
});

export const heldOrderRoutes = router;
