import { Router, Request, Response } from 'express';
import { getDatabase, parseItemJson, attachEffectiveAddons, isVoidedItemKdsVisible } from '../db';
import { requireRole, requireKdsEnabled } from '../middleware/security';

const router = Router();

router.use(requireRole('chef', 'manager', 'owner'));
router.use(requireKdsEnabled);

const ACTIVE_KITCHEN_ORDERS_CONDITION = `
  status != 'cancelled'
  AND (
    status != 'completed'
    OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = orders.id AND oi.status NOT IN ('served', 'cancelled'))
  )
`;

// GET /api/kitchen/orders — returns active orders with items for KDS display
router.get('/orders', (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    const orders = db.prepare(`
      SELECT *
      FROM orders
      WHERE ${ACTIVE_KITCHEN_ORDERS_CONDITION}
      ORDER BY created_at ASC
    `).all() as any[];

    if (orders.length === 0) {
      return res.json({ orders: [], counts: {} });
    }

    const orderIds = orders.map((o) => o.id);
    const tableIds = Array.from(new Set(orders.map((o) => o.table_id).filter(Boolean)));

    // Batch query order items and tables
    const placeholders = orderIds.map(() => '?').join(',');
    const rawItems = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`).all(...orderIds) as any[];

    const itemsByOrder: Record<string, any[]> = {};
    for (const item of rawItems) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    const tablesMap: Record<string, any> = {};
    if (tableIds.length > 0) {
      const tablePlaceholders = tableIds.map(() => '?').join(',');
      const tableRows = db.prepare(`SELECT * FROM tables WHERE id IN (${tablePlaceholders})`).all(...tableIds) as any[];
      for (const t of tableRows) {
        tablesMap[t.id] = { ...t, name: t.number };
      }
    }

    const ordersWithItems = orders.map((order) => {
      const orderRawItems = itemsByOrder[order.id] || [];
      const visibleItems = orderRawItems.filter(
        (i) => i.status !== 'void_adjustment' && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
      );
      const items = attachEffectiveAddons(db, visibleItems.map(parseItemJson));
      const table = order.table_id ? tablesMap[order.table_id] || null : null;
      return { ...order, items, table };
    });

    const counts = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM order_items
      WHERE order_id IN (SELECT id FROM orders WHERE ${ACTIVE_KITCHEN_ORDERS_CONDITION})
      GROUP BY status
    `).all() as { status: string; count: number }[];

    const countMap: Record<string, number> = {};
    counts.forEach((c) => { countMap[c.status] = c.count; });

    res.json({ orders: ordersWithItems, counts: countMap });
  } catch (error: any) {
    console.error('[Kitchen] Orders fetch error:', error);
    res.status(500).json({ error: "Could not fetch kitchen orders" });
  }
});

export const kitchenRoutes = router;
