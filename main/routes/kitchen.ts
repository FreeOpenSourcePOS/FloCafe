import { Router, Request, Response } from 'express';
import { getDatabase, getKdsStationCategoryIds, getKdsStationRoutingScope, getUserKdsStationIds, hasUserKdsStationAssignments, isKdsStationItemAllowed, parseItemJson, attachEffectiveAddons, isVoidedItemKdsVisible, projectKdsItem, projectKdsOrder } from '../db';
import { requireRole, requireKdsEnabled } from '../middleware/security';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import { parseCategoryIds } from './auth';

const router = Router();

router.use(requireRole(...ROLE_ACCESS.kitchen));
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
    const categoryIds = hasRole(currentUser.role, ROLE_ACCESS.ownerManager)
      ? []
      : parseCategoryIds(currentUser.category_ids);
    const stationIds = getUserKdsStationIds(db, userId);
    const hasStationAssignments = hasUserKdsStationAssignments(db, userId);
    if (!stationIds || hasStationAssignments === null) return res.status(403).json({ error: 'User account is not active' });
    if (hasStationAssignments && stationIds.length === 0) return res.status(403).json({ error: 'No active kitchen station is assigned to this user' });
    const stationCategoryIds = getKdsStationCategoryIds(db, stationIds);
    if (!stationCategoryIds) return res.status(403).json({ error: 'Could not load station permissions' });
    const stationScope = getKdsStationRoutingScope(db, stationIds, categoryIds);
    if (!stationScope) return res.status(403).json({ error: 'Could not load station permissions' });
    const stationRoutingCategoryIds = stationScope.tablelessCategoryIds;
    const restrictedKdsPayload = (req as any).user?.role === 'chef' || categoryIds.length > 0 || stationIds.length > 0;
    let allowedProductIds: Set<string> | null = null;
    if (categoryIds.length > 0) {
      const productRows = db.prepare(`
        SELECT id FROM products WHERE category_id IN (${categoryIds.map(() => '?').join(',')})
      `).all(...categoryIds) as { id: string | number }[];
      allowedProductIds = new Set(productRows.map((product) => String(product.id)));
    }

    const stationFilter = stationIds.length > 0
      ? ` AND (EXISTS (SELECT 1 FROM tables assigned_table WHERE assigned_table.id = o.table_id AND assigned_table.kitchen_station_id IN (${stationIds.map(() => '?').join(',')}))
          ${stationRoutingCategoryIds.length > 0 ? `OR EXISTS (SELECT 1 FROM order_items routed_oi JOIN products routed_p ON routed_p.id = routed_oi.product_id WHERE routed_oi.order_id = o.id AND o.table_id IS NULL AND routed_p.category_id IN (${stationRoutingCategoryIds.map(() => '?').join(',')}))` : ''}
          ${stationScope.hasUnrestrictedStation ? 'OR o.table_id IS NULL' : ''})`
      : '';
    const orders = db.prepare(`
      SELECT o.*, t.kitchen_station_id
      FROM orders o LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.id IN (${ACTIVE_KITCHEN_ORDER_IDS_SQL})${stationFilter}
      ORDER BY o.created_at ASC
    `).all(...stationIds, ...stationRoutingCategoryIds) as any[];

    if (orders.length === 0) {
      return res.json({ orders: [], counts: {} });
    }

    const orderIds = orders.map((o) => o.id);
    const tableIds = Array.from(new Set(orders.map((o) => o.table_id).filter(Boolean)));

    // Batch query order items and tables (one IN() each instead of N+1
    // per order) and one addons pass across all items.
    const placeholders = orderIds.map(() => '?').join(',');
    const rawItems = db.prepare(`
      SELECT oi.*, p.category_id
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders}) ORDER BY oi.order_id, oi.id
    `).all(...orderIds) as any[];

    const ordersById = new Map(orders.map((order) => [order.id, order]));
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
        && !['completed', 'cancelled'].includes(i.status)
        && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
        && (!allowedProductIds || allowedProductIds.has(String(i.product_id)))
        && isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, ordersById.get(i.order_id)?.kitchen_station_id, i.category_id, ordersById.get(i.order_id)?.kitchen_station_id ? stationScope.categoryIdsByStation[String(ordersById.get(i.order_id)?.kitchen_station_id)] : undefined, stationScope.hasUnrestrictedStation)
    );
    const itemsWithAddons = attachEffectiveAddons(db, allVisibleItems.map(parseItemJson));
    const addonsByItemId = new Map(itemsWithAddons.map((it) => [it.id, it]));

    const ordersWithItems = orders.map((order) => {
      const orderRawItems = itemsByOrder[order.id] || [];
      const visibleItems = orderRawItems
        .filter((i) => i.status !== 'void_adjustment'
          && !['completed', 'cancelled'].includes(i.status)
          && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
          && (!allowedProductIds || allowedProductIds.has(String(i.product_id)))
          && isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, order.kitchen_station_id, i.category_id, order.kitchen_station_id ? stationScope.categoryIdsByStation[String(order.kitchen_station_id)] : undefined, stationScope.hasUnrestrictedStation))
        .map((i) => projectKdsItem(addonsByItemId.get(i.id) || i, restrictedKdsPayload));
      const tableRow = order.table_id ? tablesMap[order.table_id] || null : null;
      const table = tableRow && restrictedKdsPayload ? { name: tableRow.name } : tableRow;
      return {
        ...projectKdsOrder(order, restrictedKdsPayload),
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
