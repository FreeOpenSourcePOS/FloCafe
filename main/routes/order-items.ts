import { Router, Request, Response } from 'express';
import { getDatabase, getKdsStationCategoryIds, getKdsStationRoutingCategoryIds, getUserKdsStationIds, hasUserKdsStationAssignments, isKdsStationItemAllowed, now, parseItemJson, attachEffectiveAddons, isVoidedItemKdsVisible, projectKdsItem, projectKdsOrder, withTxn } from '../db';
import { notifyKdsUpdate } from '../services/kds';
import { parseCategoryIds } from './auth';
import { requireKdsEnabled } from '../middleware/security';

const router = Router();

interface OrderItemRow {
  id: number | string;
  order_id: number | string;
  status: string;
  category_id?: string | null;
}

// PATCH /api/order-items/:id/status — update a single item's kitchen status
router.patch('/:id/status', requireKdsEnabled, (req: Request, res: Response) => {
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
      ? db.prepare('SELECT role, category_ids FROM users WHERE id = ? AND is_active = 1').get(userId) as { role: string; category_ids: string | null } | undefined
      : undefined;
    if (!currentUser) return res.status(403).json({ error: 'User account is not active' });
    const categoryIds = currentUser.role === 'manager' || currentUser.role === 'owner'
      ? []
      : parseCategoryIds(currentUser.category_ids);
    const stationIds = getUserKdsStationIds(db, userId);
    const hasStationAssignments = hasUserKdsStationAssignments(db, userId);
    if (!stationIds || hasStationAssignments === null) return res.status(403).json({ error: 'User account is not active' });
    if (hasStationAssignments && stationIds.length === 0) return res.status(403).json({ error: 'No active kitchen station is assigned to this user' });
    const stationCategoryIds = getKdsStationCategoryIds(db, stationIds);
    if (!stationCategoryIds) return res.status(403).json({ error: 'Could not load station permissions' });
    const stationRoutingCategoryIds = getKdsStationRoutingCategoryIds(db, stationIds, categoryIds);
    if (!stationRoutingCategoryIds) return res.status(403).json({ error: 'Could not load station permissions' });
    const restrictedKdsPayload = currentUser.role === 'chef' || categoryIds.length > 0 || stationIds.length > 0;

    const orderData = withTxn(() => {
      const item = db.prepare(`
        SELECT oi.*, p.category_id
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.id = ?
      `).get(itemId) as OrderItemRow | undefined;
      if (!item) {
        return null;
      }

      if (item.status === 'voided') {
        throw new Error('VOIDED_ITEM');
      }
      if (item.status === 'void_adjustment') {
        throw new Error('IMMUTABLE_KDS_ITEM');
      }
      if (item.status === 'completed' || item.status === 'cancelled') {
        throw new Error('TERMINAL_KDS_ITEM');
      }

      if (categoryIds.length > 0 && (!item.category_id || !categoryIds.includes(String(item.category_id)))) {
        throw new Error('CATEGORY_FORBIDDEN');
      }
      let orderStationId: string | null | undefined;
      if (stationIds.length > 0) {
        const station = db.prepare(`
          SELECT t.kitchen_station_id
          FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.id = ?
        `).get(item.order_id) as { kitchen_station_id: string | null } | undefined;
        orderStationId = station?.kitchen_station_id;
        if (!isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, orderStationId, item.category_id)) {
          throw new Error('STATION_FORBIDDEN');
        }
      }

      db.prepare('UPDATE order_items SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now(), itemId);

      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id) as any;
      if (!order) return null;

      const rawItems = db.prepare(`
        SELECT oi.*, p.category_id
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
      `).all(item.order_id) as any[];
      const visibleItems = rawItems
        .filter((row) => !['completed', 'cancelled', 'void_adjustment'].includes(row.status))
        .filter((row) => row.status !== 'voided' || isVoidedItemKdsVisible(row.voided_at))
        .filter((row) => categoryIds.length === 0 || (row.category_id && categoryIds.includes(String(row.category_id))))
        .filter((row) => stationIds.length === 0 || isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, orderStationId, row.category_id));
      const items = attachEffectiveAddons(db, visibleItems.map(parseItemJson))
        .map((row) => projectKdsItem(row, restrictedKdsPayload));
      const tableRow = order.table_id
        ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any
        : null;
      const table = tableRow
        ? (restrictedKdsPayload ? { name: tableRow.number } : { ...tableRow, name: tableRow.number })
        : null;

      return {
        ...projectKdsOrder(order, restrictedKdsPayload),
        items,
        table,
      };
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
    if (error.message === 'CATEGORY_FORBIDDEN' || error.message === 'STATION_FORBIDDEN') {
      return res.status(403).json({ error: 'Not authorized to update this item' });
    }
    if (error.message === 'IMMUTABLE_KDS_ITEM') {
      return res.status(400).json({ error: 'This bill adjustment cannot be updated from KDS' });
    }
    if (error.message === 'TERMINAL_KDS_ITEM') {
      return res.status(400).json({ error: 'This terminal item cannot be updated from KDS' });
    }
    console.error('[OrderItems] Status update error:', error);
    res.status(500).json({ error: "Could not update order item status" });
  }
});

export const orderItemRoutes = router;
