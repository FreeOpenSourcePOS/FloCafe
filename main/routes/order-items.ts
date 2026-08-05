import { Router, Request, Response } from 'express';
import { getDatabase, now, parseItemJson, attachEffectiveAddons, withTxn } from '../db';
import { notifyKdsUpdate } from '../services/kds';
import { parseCategoryIds } from './auth';

const router = Router();

interface OrderItemRow {
  id: number | string;
  order_id: number | string;
  status: string;
}

// PATCH /api/order-items/:id/status — update a single item's kitchen status
router.patch('/:id/status', (req: Request, res: Response) => {
  try {
    const role = (req as any).user?.role;
    if (!role || !['chef', 'manager', 'owner'].includes(role)) {
      return res.status(403).json({ error: 'Only chef, manager, or owner can update item status' });
    }

    const itemId = req.params.id;
    if (!itemId) {
      return res.status(400).json({ error: 'Order item ID is required' });
    }

    const { status } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'served'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Valid status required: ${validStatuses.join(', ')}` });
    }

    const db = getDatabase();
    const userId = (req as any).user?.userId;
    const currentUser = userId
      ? db.prepare('SELECT category_ids FROM users WHERE id = ? AND is_active = 1').get(userId) as { category_ids: string | null } | undefined
      : undefined;
    if (!currentUser) return res.status(403).json({ error: 'User account is not active' });
    const categoryIds = parseCategoryIds(currentUser.category_ids);

    const orderData = withTxn(() => {
      const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as OrderItemRow | undefined;
      if (!item) {
        return null;
      }

      if (item.status === 'voided') {
        throw new Error('VOIDED_ITEM');
      }

      if (categoryIds.length > 0) {
        const product = db.prepare('SELECT category_id FROM products WHERE id = (SELECT product_id FROM order_items WHERE id = ?)').get(itemId) as { category_id: string | null } | undefined;
        if (!product || !categoryIds.includes(product.category_id || '')) {
          throw new Error('CATEGORY_FORBIDDEN');
        }
      }

      db.prepare('UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now(), itemId);

      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id) as any;
      if (!order) return null;

      const rawItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(item.order_id) as any[];
      const items = attachEffectiveAddons(db, rawItems.map(parseItemJson));
      const tableRow = order.table_id
        ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any
        : null;
      const table = tableRow ? { ...tableRow, name: tableRow.number } : null;

      return { ...order, items, table };
    });

    if (orderData === null) {
      return res.status(404).json({ error: 'Order item not found' });
    }

    notifyKdsUpdate();

    res.json({ order: orderData });
  } catch (error: any) {
    if (error.message === 'VOIDED_ITEM') {
      return res.status(400).json({ error: 'This item has been voided and can no longer be updated' });
    }
    if (error.message === 'CATEGORY_FORBIDDEN') {
      return res.status(403).json({ error: 'Not authorized to update this item' });
    }
    console.error('[OrderItems] Status update error:', error);
    res.status(500).json({ error: "Could not update order item status" });
  }
});

export const orderItemRoutes = router;
