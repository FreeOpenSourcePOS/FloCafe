import { Router, Request, Response } from 'express';
import { getDatabase, getKdsStationCategoryIds, getKdsStationRoutingScope, getUserKdsStationIds, hasUserKdsStationAssignments, isKdsStationItemAllowed, now, parseItemJson, attachEffectiveAddons, isVoidedItemKdsVisible, projectKdsItem, projectKdsOrder, withTxn } from '../db';
import { notifyKdsUpdate } from '../services/kds';
import { parseCategoryIds } from './auth';
import { requireKdsEnabled, isTokenRevoked, isTokenStale } from '../middleware/security';

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

    const { status, expected_status: expectedStatus } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'served'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Valid status required: ${validStatuses.join(', ')}` });
    }
    if (expectedStatus !== undefined && !validStatuses.includes(expectedStatus)) {
      return res.status(400).json({ error: `Invalid expected status. Use: ${validStatuses.join(', ')}` });
    }

    const db = getDatabase();
    const userId = (req as any).user?.userId;
    const currentUser = userId
      ? db.prepare('SELECT role, category_ids FROM users WHERE id = ? AND is_active = 1').get(userId) as { role: string; category_ids: string | null } | undefined
      : undefined;
    if (!currentUser) return res.status(403).json({ error: 'User account is not active' });
    let categoryIds = currentUser.role === 'manager' || currentUser.role === 'owner'
      ? []
      : parseCategoryIds(currentUser.category_ids);
    const loadedStationIds = getUserKdsStationIds(db, userId);
    const hasStationAssignments = hasUserKdsStationAssignments(db, userId);
    if (!loadedStationIds || hasStationAssignments === null) return res.status(403).json({ error: 'User account is not active' });
    if (hasStationAssignments && loadedStationIds.length === 0) return res.status(403).json({ error: 'No active kitchen station is assigned to this user' });
    let stationIds: string[] = loadedStationIds;
    let stationCategoryIds = getKdsStationCategoryIds(db, stationIds)!;
    if (!stationCategoryIds) return res.status(403).json({ error: 'Could not load station permissions' });
    let stationScope = getKdsStationRoutingScope(db, stationIds, categoryIds)!;
    if (!stationScope) return res.status(403).json({ error: 'Could not load station permissions' });
    let stationRoutingCategoryIds = stationScope!.tablelessCategoryIds;
    let restrictedKdsPayload = currentUser.role === 'chef' || categoryIds.length > 0 || stationIds.length > 0;

    const orderData = withTxn(() => {
      const liveUser = db.prepare('SELECT role, category_ids, tokens_valid_after FROM users WHERE id = ? AND is_active = 1').get(userId) as { role: string; category_ids: string | null; tokens_valid_after: string | null } | undefined;
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      if (!liveUser || isTokenRevoked(token) || isTokenStale((req as any).user?.iat, liveUser.tokens_valid_after) || !['chef', 'manager', 'owner'].includes(liveUser.role)) throw new Error('USER_FORBIDDEN');
      categoryIds = liveUser.role === 'manager' || liveUser.role === 'owner' ? [] : parseCategoryIds(liveUser.category_ids);
      const liveStationIds = getUserKdsStationIds(db, userId);
      const liveAssignments = hasUserKdsStationAssignments(db, userId);
      if (!liveStationIds || liveAssignments === null) throw new Error('USER_FORBIDDEN');
      if (liveAssignments && liveStationIds.length === 0) throw new Error('STATION_FORBIDDEN');
      const liveStationCategoryIds = getKdsStationCategoryIds(db, liveStationIds);
      const liveStationScope = getKdsStationRoutingScope(db, liveStationIds, categoryIds);
      if (!liveStationCategoryIds || !liveStationScope) throw new Error('PERMISSIONS_UNAVAILABLE');
      stationIds = liveStationIds;
      stationCategoryIds = liveStationCategoryIds;
      stationScope = liveStationScope;
      stationRoutingCategoryIds = liveStationScope.tablelessCategoryIds;
      restrictedKdsPayload = liveUser.role === 'chef' || categoryIds.length > 0 || stationIds.length > 0;
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
        if (!isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, orderStationId, item.category_id, orderStationId ? stationScope.categoryIdsByStation[String(orderStationId)] : undefined)) {
          throw new Error('STATION_FORBIDDEN');
        }
      }

      const updateResult = expectedStatus === undefined
        ? db.prepare("UPDATE order_items SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('voided', 'void_adjustment', 'completed', 'cancelled')").run(status, now(), itemId)
        : db.prepare('UPDATE order_items SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(status, now(), itemId, expectedStatus);
      if (updateResult.changes !== 1) throw new Error('STATUS_CONFLICT');

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
        .filter((row) => stationIds.length === 0 || isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, orderStationId, row.category_id, orderStationId ? stationScope.categoryIdsByStation[String(orderStationId)] : undefined));
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
    if (error.message === 'USER_FORBIDDEN' || error.message === 'PERMISSIONS_UNAVAILABLE') {
      return res.status(403).json({ error: 'Could not load current station permissions' });
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
    if (error.message === 'STATUS_CONFLICT') {
      return res.status(409).json({ error: 'Item status changed; refresh and try again' });
    }
    console.error('[OrderItems] Status update error:', error);
    res.status(500).json({ error: "Could not update order item status" });
  }
});

export const orderItemRoutes = router;
