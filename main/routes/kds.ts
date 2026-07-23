import { Router, Request, Response } from 'express';
import { getDatabase, now, attachEffectiveAddons } from '../db';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { requireRole, requireKdsEnabled, requireKdsEnabledOr404 } from '../middleware/security';

const router = Router();

// KDS disabled → 404 the pairing surface, checked before the role gate below
// so a request from an authenticated-but-wrong-role user doesn't leak that
// the route exists either (issue #133).
router.use('/pairing', requireKdsEnabledOr404);

router.use(requireRole('chef', 'manager', 'owner'));

router.get('/orders', requireKdsEnabled, (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const stationId = req.query.station_id as string;

    let query = `
      SELECT o.*, t.number as table_name, t.floor, t.section
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE o.status NOT IN ('completed', 'cancelled')
    `;
    const params: any[] = [];

    if (stationId) {
      query += ` AND t.kitchen_station_id = ?`;
      params.push(stationId);
    }

    query += ' ORDER BY o.created_at ASC';

    const orders = db.prepare(query).all(...params);

    const ordersWithItems = orders.map((order: any) => {
      const items = attachEffectiveAddons(db, db.prepare(`
        SELECT oi.*, p.category_id, c.name as category_name
        FROM order_items oi
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE oi.order_id = ?
        ORDER BY oi.created_at ASC
      `).all(order.id) as any[]);

      return { ...order, items };
    });

    res.json({ orders: ordersWithItems });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/pairing', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const stations = db.prepare('SELECT * FROM kitchen_stations WHERE is_active = 1 ORDER BY sort_order, name').all();

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
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
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
    const stationId = req.query.station_id as string;

    if (!stationId) {
      return res.status(400).json({ error: 'station_id is required' });
    }

    const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(stationId);
    if (!station) {
      return res.status(404).json({ error: 'Kitchen station not found' });
    }

    let categoryIds: number[] = [];
    try {
      const stationData = station as any;
      if (stationData.category_ids) {
        categoryIds = JSON.parse(stationData.category_ids);
      }
    } catch (e) {
      categoryIds = [];
    }

    let itemsQuery = `
      SELECT oi.*, o.id as order_id, o.order_number, o.type, o.status as order_status,
        o.table_id, t.number as table_name, o.special_instructions as order_notes,
        o.created_at as order_time
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE oi.status NOT IN ('completed', 'cancelled', 'served')
        AND o.status NOT IN ('completed', 'cancelled')
    `;

    const params: any[] = [];

    if (categoryIds.length > 0) {
      itemsQuery += ` AND EXISTS (SELECT 1 FROM products p WHERE p.id = oi.product_id AND p.category_id IN (${categoryIds.map(() => '?').join(',')}))`;
      params.push(...categoryIds);
    }

    itemsQuery += ' ORDER BY oi.created_at ASC';

    const items = attachEffectiveAddons(db, db.prepare(itemsQuery).all(...params) as any[]);

    const groupedByOrder: Record<number, any> = {};
    for (const item of items) {
      const orderId = (item as any).order_id;
      if (!groupedByOrder[orderId]) {
        groupedByOrder[orderId] = {
          order_id: orderId,
          order_number: (item as any).order_number,
          table_id: (item as any).table_id,
          table_name: (item as any).table_name,
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
      station,
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

    const validStatuses = ['pending', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
    }

    const db = getDatabase();
    const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Order item not found' });
    }

    const nowStr = now();

    db.prepare(`
      UPDATE order_items SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, nowStr, req.params.id);

    const updatedItem = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id);
    res.json({ item: updatedItem });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const kdsRoutes = router;
