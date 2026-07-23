import { Router, Request, Response } from 'express';
import { getDatabase, now, parseItemJson, attachEffectiveAddons } from '../db';
import { notifyKdsUpdate } from '../services/kds';

const router = Router();

// PATCH /api/order-items/:id/status — update a single item's kitchen status
// Only chef, manager, or owner can update item status
router.patch('/:id/status', (req: Request, res: Response) => {
  try {
    const role = (req as any).user?.role;
    if (!role || !['chef', 'manager', 'owner'].includes(role)) {
      return res.status(403).json({ error: 'Only chef, manager, or owner can update item status' });
    }

    const { status } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'served'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Valid status required: ${validStatuses.join(', ')}` });
    }

    const db = getDatabase();
    const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id) as any;
    if (!item) {
      return res.status(404).json({ error: 'Order item not found' });
    }

    db.prepare('UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), req.params.id);

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id) as any;
    const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(item.order_id).map(parseItemJson) as any[]);
    const tableRow = order.table_id
      ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any
      : null;
    const table = tableRow ? { ...tableRow, name: tableRow.number } : null;

    notifyKdsUpdate();

    res.json({ order: { ...order, items, table } });
  } catch (error: any) {
    console.error('[OrderItems] Status update error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const orderItemRoutes = router;
