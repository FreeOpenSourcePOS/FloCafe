import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDatabase, now, parseItemJson, withTxn } from '../db';
import { notifyKdsUpdate } from '../services/kds';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'flo-local-secret-change-in-production';

/** Decode the Bearer token and return the role, or null if missing/invalid. */
function getRoleFromToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as { role?: string };
    return decoded.role ?? null;
  } catch {
    return null;
  }
}

// PATCH /api/order-items/:id/status — update a single item's kitchen status
router.patch('/:id/status', (req: Request, res: Response) => {
  try {
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
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(item.order_id).map(parseItemJson);
    const tableRow = order.table_id
      ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any
      : null;
    const table = tableRow ? { ...tableRow, name: tableRow.number } : null;

    notifyKdsUpdate();

    res.json({ order: { ...order, items, table } });
  } catch (error: any) {
    console.error('[OrderItems] Status update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Soft-delete item - set status to 'cancelled' (not actual DELETE)
router.patch('/:orderId/items/:itemId/cancel', (req: Request, res: Response) => {
  try {
    const { orderId, itemId } = req.params;
    const userRole = getRoleFromToken(req);

    if (!userRole || !['owner', 'manager'].includes(userRole.toLowerCase())) {
      return res.status(403).json({ error: 'Only owner or manager can cancel items' });
    }

    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
    if (!item) {
      return res.status(404).json({ error: 'Item not found in this order' });
    }

    const { updatedOrder, items } = withTxn(() => {
      db.prepare("UPDATE order_items SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now(), itemId);

      const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'")
        .all(orderId) as any[];
      let subtotal = 0;
      let totalTax = 0;
      for (const i of activeItems) {
        subtotal += i.subtotal || 0;
        totalTax += i.tax_amount || 0;
      }
      const preRoundTotal = subtotal + totalTax + ((order as any).packaging_charge || 0);
      const roundOff = Math.round(preRoundTotal) - preRoundTotal;
      const total = Math.round(preRoundTotal) + roundOff;

      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(subtotal, totalTax, total, roundOff, now(), orderId);

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson);
      return { updatedOrder, items };
    });

    res.json({ order: { ...updatedOrder, items } });
  } catch (error: any) {
    console.error('[OrderItems] Cancel error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore cancelled item
router.patch('/:orderId/items/:itemId/restore', (req: Request, res: Response) => {
  try {
    const { orderId, itemId } = req.params;
    const userRole = getRoleFromToken(req);

    if (!userRole || !['owner', 'manager'].includes(userRole.toLowerCase())) {
      return res.status(403).json({ error: 'Only owner or manager can restore items' });
    }

    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
    if (!item) {
      return res.status(404).json({ error: 'Item not found in this order' });
    }

    const { updatedOrder, items } = withTxn(() => {
      db.prepare("UPDATE order_items SET status = 'pending', updated_at = ? WHERE id = ?")
        .run(now(), itemId);

      const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'")
        .all(orderId) as any[];
      let subtotal = 0;
      let totalTax = 0;
      for (const i of activeItems) {
        subtotal += i.subtotal || 0;
        totalTax += i.tax_amount || 0;
      }
      const preRoundTotal = subtotal + totalTax + ((order as any).packaging_charge || 0);
      const roundOff = Math.round(preRoundTotal) - preRoundTotal;
      const total = Math.round(preRoundTotal) + roundOff;

      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(subtotal, totalTax, total, roundOff, now(), orderId);

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson);
      return { updatedOrder, items };
    });

    res.json({ order: { ...updatedOrder, items } });
  } catch (error: any) {
    console.error('[OrderItems] Restore error:', error);
    res.status(500).json({ error: error.message });
  }
});

export const orderItemRoutes = router;
