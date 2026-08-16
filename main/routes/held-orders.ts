import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { randomUUID } from 'crypto';
import { validateItemNotes, validateOrderNotes } from './orders-validation';

const router = Router();

const TABLE_STATUS_HELD = 'held';
const TABLE_STATUS_AVAILABLE = 'available';

interface HeldOrderRow {
  id: string;
  table_id: string;
  items: string;
  customer_id: string | null;
  guest_count: number;
  order_notes: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_HELD_ORDER_ITEMS = 100;
const MAX_IDENTIFIER_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIdentifier(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_IDENTIFIER_LENGTH)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function validateHeldOrderItem(item: unknown, db: any): void {
  if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error('Each held-order item must have a valid id');
  }
  if (!isRecord(item.product) || !isValidIdentifier(item.product.id)) {
    throw new Error('Each held-order item must have a valid product');
  }
  if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
    throw new Error('Each held-order item must have a positive integer quantity');
  }
  if (!Array.isArray(item.addons) || item.addons.some((addon: unknown) => !isRecord(addon) || !isValidIdentifier(addon.id))) {
    throw new Error('Held-order item addons must be an array of valid addons');
  }
  if (item.special_instructions !== undefined && typeof item.special_instructions !== 'string') {
    throw new Error('Item special instructions must be a string');
  }
  validateItemNotes(db, item.special_instructions);
}

function validateHeldOrderInput(body: any, db: any): {
  tableId: string;
  items: unknown[];
  customerId: string | number | null;
  guestCount: number;
  orderNotes: string;
} {
  if (!isRecord(body)) {
    throw new Error('Request body must be an object');
  }
  const { tableId, items, customerId, guestCount, orderNotes } = body;
  if (typeof tableId !== 'string' || tableId.trim().length === 0 || tableId.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error('tableId must be a non-empty string');
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_HELD_ORDER_ITEMS) {
    throw new Error(`items must contain between 1 and ${MAX_HELD_ORDER_ITEMS} items`);
  }
  items.forEach((item) => validateHeldOrderItem(item, db));
  if (customerId !== undefined && customerId !== null && !isValidIdentifier(customerId)) {
    throw new Error('customerId must be a valid identifier');
  }
  if (guestCount !== undefined && (!Number.isSafeInteger(guestCount) || guestCount <= 0)) {
    throw new Error('guestCount must be a positive integer');
  }
  if (orderNotes !== undefined && orderNotes !== null && typeof orderNotes !== 'string') {
    throw new Error('orderNotes must be a string');
  }
  validateOrderNotes(db, orderNotes);
  return {
    tableId,
    items,
    customerId: customerId ?? null,
    guestCount: guestCount ?? 1,
    orderNotes: orderNotes ?? '',
  };
}

function parseStoredHeldOrder(row: HeldOrderRow): Record<string, unknown> | null {
  try {
    const items = JSON.parse(row.items);
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_HELD_ORDER_ITEMS || items.some((item) => !isRecord(item))) {
      return null;
    }
    return {
      id: row.id,
      tableId: row.table_id,
      items,
      customerId: row.customer_id,
      guestCount: Number.isSafeInteger(row.guest_count) && row.guest_count > 0 ? row.guest_count : 1,
      orderNotes: row.order_notes || '',
      heldAt: row.created_at,
    };
  } catch {
    return null;
  }
}

router.get('/', requireRole('owner', 'manager', 'cashier', 'server'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM held_orders ORDER BY updated_at DESC').all() as HeldOrderRow[];
    const orders: Record<string, unknown>[] = [];
    let skippedCount = 0;
    for (const row of rows) {
      const order = parseStoredHeldOrder(row);
      if (order) orders.push(order);
      else {
        skippedCount++;
        console.warn(`[API] Skipping malformed held order ${row.id}`);
      }
    }
    res.json({ orders, skippedCount });
  } catch (error: any) {
    console.error("[API] Held orders fetch error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager', 'cashier', 'server'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let input;
    try {
      input = validateHeldOrderInput(req.body, db);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    const { tableId, items, customerId, guestCount, orderNotes } = input;
    let heldOrderId = '';
    
    withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId) as { id: string } | undefined;
      heldOrderId = `ho-${randomUUID().slice(0, 8)}`;
      
      if (existing) {
        db.prepare(`
          UPDATE held_orders
          SET id = ?, items = ?, customer_id = ?, guest_count = ?, order_notes = ?, updated_at = ?
          WHERE id = ?
        `).run(heldOrderId, JSON.stringify(items), customerId || null, guestCount || 1, orderNotes || '', now(), existing.id);
      } else {
        db.prepare(`
          INSERT INTO held_orders (id, table_id, items, customer_id, guest_count, order_notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(heldOrderId, tableId, JSON.stringify(items), customerId || null, guestCount || 1, orderNotes || '', now(), now());
      }

      db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ?').run(TABLE_STATUS_HELD, now(), tableId);
    });

    // Returning the current row identity lets a client prove that its cached
    // snapshot is still the row it is consuming. Replacing a held order gets
    // a new identity, so an older terminal receives deleted:false instead of
    // deleting the replacement.
    res.json({ success: true, id: heldOrderId });
  } catch (error: any) {
    console.error("[API] Hold order error:", error);
    res.status(500).json({ error: "Could not hold order" });
  }
});

router.delete('/:tableId', requireRole('owner', 'manager', 'cashier', 'server'), (req: Request, res: Response) => {
  try {
    const tableId = req.params.tableId;
    const expectedHeldOrderId = typeof req.query.heldOrderId === 'string' && req.query.heldOrderId.length > 0
      ? req.query.heldOrderId
      : null;

    if (!expectedHeldOrderId) {
      return res.json({ success: true, deleted: false });
    }

    const db = getDatabase();
    
    let deleted = false;
    withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId) as { id: string } | undefined;
      if (existing && existing.id === expectedHeldOrderId) {
        db.prepare('DELETE FROM held_orders WHERE table_id = ?').run(tableId);
        db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(TABLE_STATUS_AVAILABLE, now(), tableId, TABLE_STATUS_HELD);
        deleted = true;
      }
    });

    // Deletion is intentionally idempotent. A held order may have been resumed
    // or deleted by another terminal between the UI's last refresh and this
    // request; that is already the desired end state, not an application error.
    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error("[API] Delete held order error:", error);
    res.status(500).json({ error: "Could not delete held order" });
  }
});

export const heldOrderRoutes = router;
