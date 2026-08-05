import { Router, Request, Response } from 'express';
import { getDatabase, parseItemJson, attachEffectiveAddons, isVoidedItemKdsVisible, projectKdsOrder } from '../db';
import { requireRole, requireKdsEnabled } from '../middleware/security';
import { parseCategoryIds } from './auth';

const router = Router();

router.use(requireRole('chef', 'manager', 'owner'));
router.use(requireKdsEnabled);

// Active kitchen orders — the old `OR EXISTS` form forced the planner to
// SCAN orders and run a correlated subquery per row. The UNION form lets
// each branch hit an index: status-in check uses `idx_orders_status`, and
// the live-items branch uses `idx_order_items_order`. #208
const ACTIVE_KITCHEN_ORDER_IDS_SQL = `
  SELECT id FROM orders WHERE status IN ('pending','preparing','ready','served')
  UNION
  SELECT o.id FROM orders o
  JOIN order_items oi ON oi.order_id = o.id AND oi.status NOT IN ('served','cancelled')
  WHERE o.status NOT IN ('pending','preparing','ready','served','cancelled')
`;

// GET /api/kitchen/orders — returns active orders with items for KDS display
router.get('/orders', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userId = (req as any).user?.userId;
    const currentUser = userId
      ? db.prepare('SELECT role, category_ids FROM users WHERE id = ? AND is_active = 1').get(userId) as { role: string; category_ids: string | null } | undefined
      : undefined;
    if (!currentUser) return res.status(403).json({ error: 'User account is not active' });
    const categoryIds = currentUser.role === 'manager' || currentUser.role === 'owner'
      ? []
      : parseCategoryIds(currentUser.category_ids);
    let allowedProductIds: Set<string> | null = null;
    if (categoryIds.length > 0) {
      const productRows = db.prepare(`
        SELECT id FROM products WHERE category_id IN (${categoryIds.map(() => '?').join(',')})
      `).all(...categoryIds) as { id: string | number }[];
      allowedProductIds = new Set(productRows.map((product) => String(product.id)));
    }

    const orders = db.prepare(`
      SELECT o.*
      FROM orders o
      WHERE o.id IN (${ACTIVE_KITCHEN_ORDER_IDS_SQL})
      ORDER BY o.created_at ASC
    `).all() as any[];

    if (orders.length === 0) {
      return res.json({ orders: [], counts: {} });
    }

    const orderIds = orders.map((o) => o.id);
    const tableIds = Array.from(new Set(orders.map((o) => o.table_id).filter(Boolean)));

    // Batch query order items and tables (one IN() each instead of N+1
    // per order) and one addons pass across all items.
    const placeholders = orderIds.map(() => '?').join(',');
    const rawItems = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, id`).all(...orderIds) as any[];

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

    // Resolve addons for every visible item in one batched call.
    const allVisibleItems = rawItems.filter(
      (i) => i.status !== 'void_adjustment'
        && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
        && (!allowedProductIds || allowedProductIds.has(String(i.product_id)))
    );
    const itemsWithAddons = attachEffectiveAddons(db, allVisibleItems.map(parseItemJson));
    const addonsByItemId = new Map(itemsWithAddons.map((it) => [it.id, it]));

    const ordersWithItems = orders.map((order) => {
      const orderRawItems = itemsByOrder[order.id] || [];
      const visibleItems = orderRawItems
        .filter((i) => i.status !== 'void_adjustment'
          && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
          && (!allowedProductIds || allowedProductIds.has(String(i.product_id))))
        .map((i) => addonsByItemId.get(i.id) || i);
      const table = order.table_id ? tablesMap[order.table_id] || null : null;
      return {
        ...projectKdsOrder(order, categoryIds.length > 0),
        items: visibleItems,
        table,
      };
    }).filter((order) => order.items.length > 0);

    // Counts are derived from the items we already fetched for these exact
    // active orders — no need to re-run the UNION and re-query order_items.
    const countMap: Record<string, any> = {};
    for (const item of allVisibleItems) {
      countMap[item.status] = (countMap[item.status] || 0) + 1;
    }

    res.json({ orders: ordersWithItems, counts: countMap });
  } catch (error: any) {
    console.error('[Kitchen] Orders fetch error:', error);
    res.status(500).json({ error: "Could not fetch kitchen orders" });
  }
});

export const kitchenRoutes = router;
