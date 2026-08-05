import { Router, Request, Response } from 'express';
import { getDatabase, getUserKdsStationIds, now, attachEffectiveAddons, isVoidedItemKdsVisible, KDS_VOIDED_ITEM_VISIBILITY_MS, projectKdsItem, projectKdsOrder, projectKdsStation, withTxn } from '../db';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { requireRole, requireKdsEnabled, requireKdsEnabledOr404 } from '../middleware/security';
import { parseCategoryIds } from './auth';
import { notifyKdsUpdate } from '../services/kds';

const router = Router();

function getKdsUserStationIds(db: ReturnType<typeof getDatabase>, req: Request): string[] | null {
  const userId = (req as any).user?.userId;
  return userId ? getUserKdsStationIds(db, userId) : null;
}

function getKdsUserCategoryIds(db: ReturnType<typeof getDatabase>, req: Request): string[] | null {
  const userId = (req as any).user?.userId;
  if (!userId) return null;
  const user = db.prepare('SELECT role, category_ids, is_active FROM users WHERE id = ?').get(userId) as {
    role: string;
    category_ids: string | null;
    is_active: number;
  } | undefined;
  if (!user?.is_active || !['chef', 'manager', 'owner'].includes(user.role)) return null;
  return user.role === 'manager' || user.role === 'owner' ? [] : parseCategoryIds(user.category_ids);
}

// KDS disabled → 404 the pairing surface, checked before the role gate below
// so a request from an authenticated-but-wrong-role user doesn't leak that
// the route exists either (issue #133).
router.use('/pairing', requireKdsEnabledOr404);

router.use(requireRole('chef', 'manager', 'owner'));

router.get('/orders', requireKdsEnabled, (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userCategoryIds = getKdsUserCategoryIds(db, req);
    const userStationIds = getKdsUserStationIds(db, req);
    if (!userCategoryIds || !userStationIds) return res.status(403).json({ error: 'User account is not active' });
    const stationId = req.query.station_id as string;
    if (stationId && userStationIds.length > 0 && !userStationIds.includes(stationId)) {
      return res.status(403).json({ error: 'You are not assigned to this kitchen station' });
    }
    let allowedProductIds: Set<string> | null = null;
    if (userCategoryIds.length > 0) {
      const productRows = db.prepare(`
        SELECT id FROM products WHERE category_id IN (${userCategoryIds.map(() => '?').join(',')})
      `).all(...userCategoryIds) as { id: string | number }[];
      allowedProductIds = new Set(productRows.map((product) => String(product.id)));
    }
    // A prepaid order is marked 'completed' the moment its bill is fully
    // paid, which can happen before the kitchen has prepared anything — so
    // a completed order still belongs here if it has items the kitchen
    // hasn't served yet. #208: rewrite the OR EXISTS scan as a CTE-anchored
    // subquery that hits idx_orders_status + idx_order_items_order instead
    // of scanning all orders with a correlated subquery.
    let query = `
      WITH active_ids AS (
        SELECT id FROM orders WHERE status IN ('pending','preparing','ready','served')
        UNION
        SELECT o.id FROM orders o
        JOIN order_items oi ON oi.order_id = o.id AND oi.status NOT IN ('served','cancelled')
        WHERE o.status NOT IN ('pending','preparing','ready','served','cancelled')
      )
      SELECT o.*, t.number as table_name, t.floor, t.section
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE o.id IN active_ids
    `;
    const params: any[] = [];

    if (userStationIds.length > 0) {
      query += ` AND t.kitchen_station_id IN (${userStationIds.map(() => '?').join(',')})`;
      params.push(...userStationIds);
    }
    if (stationId) {
      query += ` AND t.kitchen_station_id = ?`;
      params.push(stationId);
    }

    query += ' ORDER BY o.created_at ASC';

    const orders = db.prepare(query).all(...params);

    // One batched items query (with product/category joins) plus one addons
    // pass, instead of N+1 per order — the KDS board polls this constantly.
    const orderIds = (orders as any[]).map((o) => o.id);
    const itemsByOrder: Record<string, any[]> = {};
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const rawItems = db.prepare(`
        SELECT oi.*, p.category_id, c.name as category_name
        FROM order_items oi
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE oi.order_id IN (${placeholders})
        ORDER BY oi.order_id, oi.created_at ASC
      `).all(...orderIds) as any[];
      for (const item of rawItems) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }
    }

    const allVisibleItems = (orders as any[])
      .flatMap((o) => itemsByOrder[o.id] || [])
      .filter((i) => i.status !== 'void_adjustment'
        && !['completed', 'cancelled'].includes(i.status)
        && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
        && (!allowedProductIds || allowedProductIds.has(String(i.product_id))));
    const itemsWithAddons = attachEffectiveAddons(db, allVisibleItems);
    const addonsByItemId = new Map(itemsWithAddons.map((it) => [it.id, it]));

    const ordersWithItems = (orders as any[]).map((order) => {
      // #150: hide the void reversal line (bill adjustment, not a kitchen
      // item) and age voided items off the board after their grace period.
      const visibleItems = (itemsByOrder[order.id] || [])
        .filter((i) => i.status !== 'void_adjustment'
          && !['completed', 'cancelled'].includes(i.status)
          && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
          && (!allowedProductIds || allowedProductIds.has(String(i.product_id))))
        .map((i) => projectKdsItem(addonsByItemId.get(i.id) || i, userCategoryIds.length > 0));

      return {
        ...projectKdsOrder(order, userCategoryIds.length > 0),
        items: visibleItems,
        table: order.table_name ? { name: order.table_name } : null,
      };
    }).filter((order) => order.items.length > 0);

    res.json({ orders: ordersWithItems });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/pairing', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userCategoryIds = getKdsUserCategoryIds(db, req);
    const userStationIds = getKdsUserStationIds(db, req);
    if (!userCategoryIds || !userStationIds) return res.status(403).json({ error: 'User account is not active' });
    const stations = (db.prepare('SELECT * FROM kitchen_stations WHERE is_active = 1 ORDER BY sort_order, name').all() as any[])
      .filter((station) => {
        if (userStationIds.length > 0 && !userStationIds.includes(String(station.id))) return false;
        if (userCategoryIds.length === 0 || !station.category_ids) return true;
        const stationCategories = parseCategoryIds(station.category_ids);
        return stationCategories.length === 0 || stationCategories.some((categoryId) => userCategoryIds.includes(categoryId));
      })
      .map((station) => projectKdsStation(station, userCategoryIds.length > 0));

    res.json({ stations });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/pairing', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { station_id } = req.body;

    const db = getDatabase();

    if (station_id) {
      const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(station_id);
      if (!station) {
        return res.status(404).json({ error: 'Kitchen station not found' });
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    // Space form, same as every other DB timestamp (v45 normalized the
    // column) — a consumer comparing expires_at against a space-form now
    // would see ISO-Z tokens sort after it and treat them as never expired.
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').replace(/\..*$/, '');
    const tokenId = randomUUID();

    const result = db.prepare(`
      INSERT INTO kds_pairing_tokens (id, token, station_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenId, token, station_id || null, expiresAt, now());

    const pairingUrl = `flo://kds/pair?token=${token}`;
    const webUrl = `/kds/pair?token=${token}`;

    res.status(201).json({
      pairingToken: {
        id: result.lastInsertRowid,
        token,
        station_id,
        expires_at: expiresAt,
        pairing_url: pairingUrl,
        web_url: webUrl,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/display', requireKdsEnabled, (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userCategoryIds = getKdsUserCategoryIds(db, req);
    const userStationIds = getKdsUserStationIds(db, req);
    if (!userCategoryIds || !userStationIds) return res.status(403).json({ error: 'User account is not active' });
    const stationId = req.query.station_id as string;

    if (!stationId) {
      return res.status(400).json({ error: 'station_id is required' });
    }

    const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(stationId);
    if (!station) {
      return res.status(404).json({ error: 'Kitchen station not found' });
    }
    if (userStationIds.length > 0 && !userStationIds.includes(stationId)) {
      return res.status(403).json({ error: 'You are not assigned to this kitchen station' });
    }

    let stationCategoryIds: string[] = [];
    try {
      const stationData = station as any;
      if (stationData.category_ids) {
        stationCategoryIds = parseCategoryIds(stationData.category_ids);
      }
    } catch (e) {
      stationCategoryIds = [];
    }
    if (
      userCategoryIds.length > 0 &&
      stationCategoryIds.length > 0 &&
      !stationCategoryIds.some((categoryId) => userCategoryIds.includes(categoryId))
    ) {
      return res.status(403).json({ error: 'You are not assigned to this kitchen station' });
    }
    const categoryIds = userCategoryIds.length > 0
      ? (stationCategoryIds.length > 0
        ? stationCategoryIds.filter((categoryId) => userCategoryIds.includes(categoryId))
        : userCategoryIds)
      : stationCategoryIds;

    // #150: 'void_adjustment' is a bill-only reversal line, never a kitchen
    // item — excluded outright. A voided item itself stays visible, struck
    // through, until voided_at ages past the same grace period every other
    // KDS surface uses (main/db.ts's isVoidedItemKdsVisible). The cutoff is
    // emitted in the DB's space form — an ISO-Z bound would sort after every
    // space-form row of the same day and hide voided items immediately.
    const voidedCutoff = new Date(Date.now() - KDS_VOIDED_ITEM_VISIBILITY_MS).toISOString().replace('T', ' ').replace(/\..*$/, '');
    let itemsQuery = `
      SELECT oi.*, o.id as order_id, o.order_number, o.type, o.status as order_status,
        o.table_id, t.number as table_name, o.special_instructions as order_notes,
        o.created_at as order_time
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE oi.status NOT IN ('completed', 'cancelled', 'served', 'void_adjustment')
        AND (oi.status != 'voided' OR oi.voided_at IS NULL OR oi.voided_at > ?)
        AND o.status != 'cancelled'
    `;

    const params: any[] = [voidedCutoff];

    if (categoryIds.length > 0) {
      itemsQuery += ` AND EXISTS (SELECT 1 FROM products p WHERE p.id = oi.product_id AND p.category_id IN (${categoryIds.map(() => '?').join(',')}))`;
      params.push(...categoryIds);
    }

    itemsQuery += ' ORDER BY oi.created_at ASC';

    const items = attachEffectiveAddons(db, db.prepare(itemsQuery).all(...params) as any[])
      .map((item) => projectKdsItem(item, userCategoryIds.length > 0));

    const groupedByOrder: Record<number, any> = {};
    for (const item of items) {
      const orderId = (item as any).order_id;
      if (!groupedByOrder[orderId]) {
        groupedByOrder[orderId] = {
          order_id: orderId,
          order_number: (item as any).order_number,
          table_id: (item as any).table_id,
          table_name: (item as any).table_name,
          table: (item as any).table_name ? { name: (item as any).table_name } : null,
          type: (item as any).type,
          order_status: (item as any).order_status,
          order_notes: (item as any).order_notes,
          order_time: (item as any).order_time,
          items: [],
        };
      }
      groupedByOrder[orderId].items.push(item);
    }

    res.json({
      station: projectKdsStation(station, userCategoryIds.length > 0),
      orders: Object.values(groupedByOrder),
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/items/:id/status', requireKdsEnabled, (req: Request, res: Response) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['pending', 'preparing', 'ready', 'served'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
    }

    const db = getDatabase();
    const userCategoryIds = getKdsUserCategoryIds(db, req);
    const userStationIds = getKdsUserStationIds(db, req);
    if (!userCategoryIds || !userStationIds) return res.status(403).json({ error: 'User account is not active' });

    const updatedItem = withTxn(() => {
      const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id) as any;
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

      if (userCategoryIds.length > 0) {
        const product = db.prepare('SELECT category_id FROM products WHERE id = ?').get(item.product_id) as { category_id: string | null } | undefined;
        if (!product || !userCategoryIds.includes(String(product.category_id || ''))) {
          throw new Error('CATEGORY_FORBIDDEN');
        }
      }
      if (userStationIds.length > 0) {
        const station = db.prepare(`
          SELECT t.kitchen_station_id
          FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.id = ?
        `).get(item.order_id) as { kitchen_station_id: string | null } | undefined;
        if (!station?.kitchen_station_id || !userStationIds.includes(String(station.kitchen_station_id))) {
          throw new Error('STATION_FORBIDDEN');
        }
      }

      db.prepare(`
        UPDATE order_items SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(status, now(), req.params.id);

      return db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id);
    });

    if (!updatedItem) {
      return res.status(404).json({ error: 'Order item not found' });
    }

    notifyKdsUpdate();
    res.json({ item: projectKdsItem(updatedItem, userCategoryIds.length > 0) });
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
    console.error("[API] KDS item status update error:", error);
    res.status(500).json({ error: "Could not update item status" });
  }
});

export const kdsRoutes = router;
