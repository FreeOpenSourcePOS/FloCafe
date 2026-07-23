import { Router, Request, Response } from 'express';
import { getDatabase, parseItemJson, attachEffectiveAddons } from '../db';
import { requireRole, requireKdsEnabled } from '../middleware/security';

const router = Router();

router.use(requireRole('chef', 'manager', 'owner'));
router.use(requireKdsEnabled);

// GET /api/kitchen/orders — returns active orders with items for KDS display
router.get('/orders', (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    // A prepaid order is marked 'completed' the moment its bill is fully
    // paid, which can happen before the kitchen has prepared anything — so
    // a completed order still belongs here if it has items the kitchen
    // hasn't served yet (see main/services/kds.ts's activeOrdersCondition
    // for the WebSocket-side equivalent of this same rule).
    const orders = db.prepare(`
      SELECT o.*
      FROM orders o
      WHERE o.status != 'cancelled'
        AND (
          o.status != 'completed'
          OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.status NOT IN ('served', 'cancelled'))
        )
      ORDER BY o.created_at ASC
    `).all();

    const ordersWithItems = orders.map((order: any) => {
      const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id).map(parseItemJson) as any[]);
      const tableRow = order.table_id
        ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any
        : null;
      // Normalize: frontend expects table.name, schema column is `number`
      const table = tableRow ? { ...tableRow, name: tableRow.number } : null;
      return { ...order, items, table };
    });

    const counts = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM order_items
      WHERE order_id IN (
        SELECT id FROM orders o WHERE o.status != 'cancelled'
          AND (
            o.status != 'completed'
            OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.status NOT IN ('served', 'cancelled'))
          )
      )
      GROUP BY status
    `).all() as { status: string; count: number }[];

    const countMap: Record<string, number> = {};
    counts.forEach((c) => { countMap[c.status] = c.count; });

    res.json({ orders: ordersWithItems, counts: countMap });
  } catch (error: any) {
    console.error('[Kitchen] Orders fetch error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const kitchenRoutes = router;
