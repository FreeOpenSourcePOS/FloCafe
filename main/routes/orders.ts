import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import { getDatabase, generateOrderNumber, now, parseItemJson, parseRowJson, withTxn, verifyPin, getSettingValue, insertOrderItemAddons, attachEffectiveAddons, utcDayBounds, utcTodayDate } from '../db';
import {
  calculateConfiguredChargeTaxes,
  calculateItemTax,
  combineItemAndChargeTaxes,
  getActiveCountryPack,
  getConfiguredChargeTaxCategories,
  normalizeChargeAmount,
} from '../services/tax';
import { applyPayableRounding } from '../services/tax-engine';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { cloudSync } from '../services/cloud-sync';
import { validateOrderNotes, validateItemNotes, validateProductQuantity } from './orders-validation';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import expressRateLimit from 'express-rate-limit';

const router = Router();
const orderReadRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const orderWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const MAX_ORDER_IDEMPOTENCY_KEY_LENGTH = 128;
const OWNER_MANAGER_ROLE_PLACEHOLDERS = ROLE_ACCESS.ownerManager.map(() => '?').join(', ');

function orderIdempotencyKey(req: Request): string | null {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) return null;
  const supplied = raw.trim();
  if (!supplied) return null;
  if (supplied.length > MAX_ORDER_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(supplied)) {
    throw Object.assign(new Error('Idempotency-Key is invalid or too long'), { statusCode: 400 });
  }
  return supplied;
}

function getStoredOrderReplay(
  db: ReturnType<typeof getDatabase>,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
): unknown | null {
  const prior = db.prepare(`
    SELECT request_hash, response_json
    FROM order_idempotency
    WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
    ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(userId, idempotencyKey, userId) as { request_hash: string; response_json: string } | undefined;
  if (!prior) return null;
  if (prior.request_hash !== requestHash) {
    throw Object.assign(new Error('Idempotency-Key was already used for a different order request'), { statusCode: 409 });
  }
  try {
    return JSON.parse(prior.response_json);
  } catch {
    throw Object.assign(new Error('Stored order response is invalid'), { statusCode: 500 });
  }
}

// Rate limiting for PIN validation (simple in-memory)
const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function checkPinRateLimit(key: string): boolean {
  const now = Date.now();
  // Bound the in-memory table. Sweep expired entries once it grows past a
  // threshold so abandoned keys cannot accumulate without limit
  // (GHSA-9jjq-2fmw-x3mw). The keys are per-client/per-action, so the map is
  // naturally small, but this keeps a long-running process from drifting.
  if (pinAttempts.size > 500) {
    for (const [k, v] of pinAttempts.entries()) {
      if (now > v.resetAt) pinAttempts.delete(k);
    }
  }
  const entry = pinAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    pinAttempts.set(key, { count: 1, resetAt: now + PIN_WINDOW_MS });
    return true;
  }
  if (entry.count >= PIN_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

function syncCustomerTagCounts(db: any, customerId: string, items: { product_id: string; quantity: number }[]) {
  const row = db.prepare('SELECT tag_counts FROM customers WHERE id = ?').get(customerId) as any;
  if (!row) return;
  let counts: Record<string, number> = {};
  try { counts = row.tag_counts ? JSON.parse(row.tag_counts) : {}; } catch { counts = {}; }
  for (const item of items) {
    const product = db.prepare('SELECT tags FROM products WHERE id = ?').get(item.product_id) as any;
    if (!product?.tags) continue;
    let tags: string[] = [];
    try { tags = JSON.parse(product.tags); } catch { continue; }
    for (const tag of tags) {
      if (tag && typeof tag === 'string') counts[tag] = (counts[tag] || 0) + (item.quantity || 1);
    }
  }
  db.prepare('UPDATE customers SET tag_counts = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(counts), now(), customerId);
}

/**
 * Resolves and validates a submitted order item's add-ons against the catalog
 * (GHSA-jmxx-39wh-4cjx). Client-supplied name/price are never trusted: every
 * add-on must resolve by ID to an active catalog add-on whose group is linked
 * to the product (via addon_group_product). Returns the canonical add-on list
 * (catalog id/name/price + client quantity) used for both subtotal and the
 * order_item_addons snapshot.
 */
function resolveItemAddons(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  addons: any[] | null | undefined,
): { id: string; name: string; price: number; quantity: number }[] {
  if (!addons || !Array.isArray(addons) || addons.length === 0) return [];

  const linkedGroupIds = new Set(
    (db.prepare('SELECT addon_group_id FROM addon_group_product WHERE product_id = ?').all(productId) as { addon_group_id: string }[])
      .map((row) => row.addon_group_id),
  );

  const resolved: { id: string; name: string; price: number; quantity: number }[] = [];
  const groupSelections = new Map<string, { totalQty: number; hasMultiQty: boolean }>();

  for (const addon of addons) {
    if (!addon) continue;
    if (!addon.id || typeof addon.id !== 'string') {
      throw new Error('Each add-on must reference a valid catalog add-on ID');
    }
    const catalog = db.prepare('SELECT * FROM addons WHERE id = ?').get(addon.id) as
      | { id: string; addon_group_id: string; name: string; price: number; is_active: number }
      | undefined;
    if (!catalog) {
      throw new Error(`Add-on "${addon.id}" was not found`);
    }
    if (catalog.is_active !== 1) {
      throw new Error(`Add-on "${catalog.name}" is not available`);
    }
    if (!linkedGroupIds.has(catalog.addon_group_id)) {
      throw new Error(`Add-on "${catalog.name}" is not available for this product`);
    }

    const quantity = addon.quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid add-on quantity for "${catalog.name}": must be a positive integer`);
    }

    resolved.push({ id: catalog.id, name: catalog.name, price: Number(catalog.price) || 0, quantity });

    const qty = Math.max(1, Math.floor(quantity));
    const current = groupSelections.get(catalog.addon_group_id) || { totalQty: 0, hasMultiQty: false };
    groupSelections.set(catalog.addon_group_id, {
      totalQty: current.totalQty + qty,
      hasMultiQty: current.hasMultiQty || qty > 1,
    });
  }

  for (const [groupId, selection] of groupSelections.entries()) {
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ? AND is_active = 1').get(groupId) as any;
    if (!group) continue;

    if (!group.allow_multiple_quantities && selection.hasMultiQty) {
      throw new Error(`Add-on group "${group.name}" does not allow multiple quantities`);
    }

    if (group.max_selection !== null && group.max_selection !== undefined && selection.totalQty > group.max_selection) {
      throw new Error(`Total add-on quantity for group "${group.name}" exceeds maximum allowed (${group.max_selection})`);
    }

    if (group.min_selection && selection.totalQty < group.min_selection) {
      throw new Error(`Selection for group "${group.name}" requires at least ${group.min_selection} item(s)`);
    }
  }

  return resolved;
}

router.get('/', orderReadRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const db = getDatabase();
    const wheres: string[] = [];
    const params: any[] = [];

    if (req.query.status) {
      const statuses = (req.query.status as string).split(',');
      if (statuses.length === 1) {
        wheres.push('status = ?');
        params.push(statuses[0]);
      } else {
        wheres.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (req.query.type) {
      wheres.push('type = ?');
      params.push(req.query.type);
    }
    // #208: `today` is the UTC day, as a range filter (was UTC date() that
    // wrapped the column and blocked `idx_orders_created_at`). `start_date` /
    // `end_date` add a range filter so the UI can actually load older pages
    // — combined with the cursor, this is what gives us real pagination
    // instead of "latest 50 forever".
    if (req.query.today && req.query.today !== '0' && req.query.today !== 'false') {
      const [s, e] = utcDayBounds(utcTodayDate());
      wheres.push('created_at >= ? AND created_at < ?');
      params.push(s, e);
    } else {
      const startDate = typeof req.query.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.start_date) ? req.query.start_date : null;
      const endDate = typeof req.query.end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.end_date) ? req.query.end_date : null;
      if (startDate) {
        wheres.push('created_at >= ?');
        params.push(utcDayBounds(startDate)[0]);
      }
      if (endDate) {
        wheres.push('created_at < ?');
        params.push(utcDayBounds(endDate)[1]);
      }
    }
    if (req.query.table_id) {
      wheres.push('table_id = ?');
      params.push(req.query.table_id);
    }
    if (user.role === 'server') {
      wheres.push('user_id = ?');
      params.push(user.userId);
    }
    // Cursor pagination: `before` / `after` are ORDER BY keys (created_at),
    // composed with `id` to break ties when many orders share a second.
    if (typeof req.query.before_id === 'string' && /^\d+$/.test(req.query.before_id)) {
      const oid = parseInt(req.query.before_id, 10);
      const ref = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(oid) as { created_at: string } | undefined;
      if (ref) {
        wheres.push('(created_at, id) < (?, ?)');
        params.push(ref.created_at, oid);
      }
    }

    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    // #208: cap page size even when clients omit per_page (the original
    // "unbounded" default made GET /orders on the tables page load the entire
    // active-order history with the N+1 below).
    const requestedPerPage = req.query.per_page ? parseInt(req.query.per_page as string, 10) : NaN;
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 500)
      : 50;
    const perPagePlusOne = perPage + 1;

    const orders = db.prepare(`
      SELECT * FROM orders
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, perPagePlusOne) as any[];

    const hasMore = orders.length > perPage;
    const pageOrders = hasMore ? orders.slice(0, perPage) : orders;
    const nextCursor = hasMore ? pageOrders[pageOrders.length - 1].id : null;

    // #208: replace the per-order N+1 (5 queries × N) with one IN() per
    // relation, then assemble. Measured ~300+ queries per poll → ~6.
    const ordersWithRelations = batchHydrateOrders(db, pageOrders);

    res.json({
      orders: ordersWithRelations,
      ...(nextCursor !== null && { nextCursor }),
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Batch the relations (items+addons, table, customer, bill+loyalty) for a
 * page of orders into 5 IN() queries instead of N per-order prepared calls.
 * Used by GET /orders and kept here so the orders route owns its own data
 * shape. #208
 */
function batchHydrateOrders(db: ReturnType<typeof getDatabase>, orders: any[]) {
  if (orders.length === 0) return [];
  // Normalize JSON text columns (tax_breakdown/tax_snapshot on orders and
  // items) so the list endpoint matches GET /orders/:id. parseRowJson is
  // idempotent, so the /:id path passing an already-parsed row is fine.
  const parsedOrders = orders.map(parseRowJson);
  const ids = parsedOrders.map((o) => o.id);
  const tableIds = Array.from(new Set(parsedOrders.map((o: any) => o.table_id).filter(Boolean)));
  const customerIds = Array.from(new Set(parsedOrders.map((o: any) => o.customer_id).filter(Boolean)));

  const orderIdsCsv = `(${ids.map(() => '?').join(',')})`;
  const itemsRows = db.prepare(`SELECT * FROM order_items WHERE order_id IN ${orderIdsCsv} ORDER BY order_id, id`).all(...ids).map(parseItemJson);
  // #208: a single call to attachEffectiveAddons batches all addons across
  // all items into one IN() query against order_item_addons. Re-group the
  // result back by order_id for the per-order payload below.
  const itemsWithAddons = attachEffectiveAddons(db, itemsRows as any[]);
  const itemsByOrder = new Map<number, any[]>();
  for (const it of itemsWithAddons) {
    const list = itemsByOrder.get(it.order_id) || [];
    list.push(it);
    itemsByOrder.set(it.order_id, list);
  }

  const tablesById = new Map<string, any>();
  if (tableIds.length > 0) {
    const ph = tableIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM tables WHERE id IN (${ph})`).all(...tableIds) as any[];
    for (const t of rows) tablesById.set(t.id, t);
  }
  const customersById = new Map<string, any>();
  if (customerIds.length > 0) {
    const ph = customerIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM customers WHERE id IN (${ph})`).all(...customerIds);
    for (const c of rows as any[]) customersById.set(c.id, parseRowJson(c));
  }
  const billsByOrderId = new Map<number, any[]>();
  const billsById = new Map<number, any>();
  const billRows = db.prepare(`SELECT * FROM bills WHERE order_id IN ${orderIdsCsv}`).all(...ids) as any[];
  for (const b of billRows) {
    const parsed = parseRowJson(b);
    const siblings = billsByOrderId.get(parsed.order_id) || [];
    siblings.push(parsed);
    billsByOrderId.set(parsed.order_id, siblings);
    billsById.set(parsed.id, parsed);
  }
  const ledgerByBillId = new Map<number, number>();
  if (billsById.size > 0) {
    const billIds = Array.from(billsById.keys());
    const ph = billIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT bill_id, COALESCE(SUM(amount),0) as total FROM loyalty_ledger WHERE bill_id IN (${ph}) AND type = 'credit' GROUP BY bill_id`).all(...billIds) as { bill_id: number; total: number }[];
    for (const r of rows) ledgerByBillId.set(r.bill_id, r.total);
  }

  return parsedOrders.map((order) => {
    const itemList = itemsByOrder.get(order.id) || [];
    const tableRow = order.table_id ? tablesById.get(order.table_id) : null;
    const table = tableRow ? { ...tableRow, name: tableRow.number } : null;
    const customer = order.customer_id ? customersById.get(order.customer_id) : null;
    const bills = billsByOrderId.get(order.id) || [];
    for (const billRow of bills) {
      if (billRow.customer_id) billRow.points_earned = ledgerByBillId.get(billRow.id) || 0;
    }
    const bill = bills.find((row) => row.payment_status !== 'paid') || bills[0] || null;
    return { ...order, items: itemList, table, customer, bill, bills };
  });
}

router.get('/:id', orderReadRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const db = getDatabase();
    const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (user.role === 'server' && (order as any).user_id !== user.userId) {
      return res.status(403).json({ error: 'Servers can only view their own orders' });
    }

    // #208: collapse the per-order N+1 (5 queries: items/addons/table/customer/bill/loyalty)
    // into the same batchHydrateOrders used by the list endpoint. Previously
    // 6 prepared calls per single detail click.
    const [hydrated] = batchHydrateOrders(db, [order]);
    res.json({ order: hydrated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', orderWriteRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const { table_id, customer_id, type, guest_count, special_instructions, packaging_charge, delivery_charge, service_charge, items, online_platform, external_order_id } = body;
    // Settings supplies only service-charge tax treatment. The explicit amount
    // is accepted once here, validated, and then carried by the order/bill;
    // missing means zero until a product decision defines an automatic policy.
    const idempotencyKey = orderIdempotencyKey(req);
    const idempotencyUserId = String((req as any).user.userId);
    const requestHash = idempotencyKey
      ? createHash('sha256').update(JSON.stringify(body)).digest('hex')
      : null;
    // Always the authenticated caller, never client-supplied — trusting a
    // client-sent user_id would let staff spoof order attribution, and the
    // frontend has in fact never sent one, so every order got user_id=NULL.
    // That silently broke servers' own order visibility (GET /orders scopes
    // servers to `user_id = <their id>`, which NULL can never match) and any
    // per-staff sales attribution.
    const authenticatedUserId = (req as any).user.userId;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    if (!type || !['dine_in', 'takeaway', 'delivery', 'online'].includes(type)) {
      return res.status(400).json({ error: 'Valid type is required (dine_in, takeaway, delivery, online)' });
    }
    if (guest_count !== undefined && guest_count !== null && (!Number.isSafeInteger(guest_count) || guest_count < 1 || guest_count > 99)) {
      return res.status(400).json({ error: 'guest_count must be a whole number between 1 and 99' });
    }

    let pkgCharge: number;
    let delCharge: number;
    let serviceCharge: number;
    try {
      pkgCharge = normalizeChargeAmount(packaging_charge, 'packaging');
      delCharge = normalizeChargeAmount(delivery_charge, 'delivery');
      serviceCharge = normalizeChargeAmount(service_charge, 'service_charge');
    } catch (error: unknown) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 400;
      const message = error instanceof Error ? error.message : 'Invalid charge amount';
      return res.status(statusCode).json({ error: message });
    }

    if (online_platform !== undefined && online_platform !== null && typeof online_platform !== 'string') {
      return res.status(400).json({ error: 'online_platform must be a string' });
    }
    if (external_order_id !== undefined && external_order_id !== null && typeof external_order_id !== 'string') {
      return res.status(400).json({ error: 'external_order_id must be a string' });
    }
    const onlinePlatform = typeof online_platform === 'string' ? online_platform.trim().slice(0, 100) : null;
    const externalOrderId = typeof external_order_id === 'string' ? external_order_id.trim().slice(0, 100) : null;

    const db = getDatabase();

    try {
      validateOrderNotes(db, special_instructions);
      for (const item of items) {
        validateItemNotes(db, item.special_instructions);
        item.addons = resolveItemAddons(db, item.product_id, item.addons);
      }
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    const result = withTxn(() => {
      if (idempotencyKey) {
        // Preserve exact replay for pre-user-scoped records whose creator is
        // unavailable. New records never use the `legacy` compatibility owner.
        const prior = db.prepare(`
          SELECT request_hash, response_json
          FROM order_idempotency
          WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
          ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
          LIMIT 1
        `).get(idempotencyUserId, idempotencyKey, idempotencyUserId) as { request_hash: string; response_json: string } | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw Object.assign(new Error('Idempotency-Key was already used for a different order request'), { statusCode: 409 });
          }
          try {
            const response = JSON.parse(prior.response_json);
            return { order: response.order, orderItems: response.order?.items || [], idempotentReplay: true };
          } catch {
            throw Object.assign(new Error('Stored order response is invalid'), { statusCode: 500 });
          }
        }
      }
      // Generate order number inside transaction to prevent race conditions
      const orderNumber = generateOrderNumber();

      // Get settings for tax calculation
      const settings: Record<string, string> = {};
      db.prepare('SELECT key, value FROM settings').all().forEach((row: any) => {
        settings[row.key] = row.value;
      });

      const tenantInfo = {
        country: settings.country || 'IN',
        business_type: settings.business_type || 'restaurant',
        state_code: settings.state_code || '',
        taxes_enabled: settings.taxes_enabled === 'true',
      };
      const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
      const chargeContext = {
        packaging_charge: pkgCharge,
        delivery_charge: delCharge,
        service_charge: serviceCharge,
        packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
        delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
        service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
      };

      const orderResult = db.prepare(`
        INSERT INTO orders (order_number, table_id, customer_id, user_id, type, guest_count, special_instructions,
          packaging_charge, delivery_charge, packaging_tax_category_id, delivery_tax_category_id,
          service_charge, service_charge_tax_category_id, online_platform, external_order_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(orderNumber, table_id || null, customer_id || null, authenticatedUserId, type, guest_count || null,
        special_instructions || null, pkgCharge, delCharge,
        chargeContext.packaging_tax_category_id, chargeContext.delivery_tax_category_id,
        serviceCharge, chargeContext.service_charge_tax_category_id,
        onlinePlatform || null, externalOrderId || null, now(), now());

      const orderId = orderResult.lastInsertRowid;

      let subtotal = 0;
      let totalTax = 0;
      let exclusiveTax = 0;
      const allTaxBreakdowns: any[] = [];
      const allTaxSnapshots: (string | null)[] = [];
      const customer = customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id) as any : null;

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity, inventory_deducted_quantity,
          subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total, variant_selection,
          modifier_selection, special_instructions, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as any;
        if (!product) {
          throw new Error(`Product ${item.product_id} not found`);
        }

        if (product.track_inventory && product.stock_quantity < item.quantity) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }

        const unitPrice = parseFloat(product.price);
        const quantity = item.quantity;
        // item.discount_amount is intentionally ignored here — discounts are only
        // applied through the dedicated PATCH discount endpoints, which enforce
        // discount_mode/max_percentage/max_amount/approval (vuln-0002).
        const itemDiscount = 0;

        // Validate quantity and price
        validateProductQuantity(product, quantity);
        if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
          throw new Error(`Invalid price for ${product.name}: must be a non-negative number`);
        }

        let itemSubtotal = unitPrice * quantity;
        if (item.addons && Array.isArray(item.addons)) {
          for (const addon of item.addons) {
            if (!addon) continue;
            if (addon.quantity !== undefined) {
              if (typeof addon.quantity !== 'number' || !Number.isInteger(addon.quantity) || addon.quantity <= 0) {
                throw new Error(`Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`);
              }
            }
            const addonQty = addon.quantity || 1;
            itemSubtotal += (addon.price || 0) * addonQty * quantity;
          }
        }
        itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

        const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);

        totalTax += taxResult.tax_amount;
        if (taxResult.tax_type !== 'inclusive') {
          exclusiveTax += taxResult.tax_amount;
        }
        if (taxResult.tax_breakdown) {
          allTaxBreakdowns.push(taxResult.tax_breakdown);
        }
        const itemTaxSnapshotJson = taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null;
        allTaxSnapshots.push(itemTaxSnapshotJson);

        const itemTotal = itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
        subtotal += itemSubtotal;

        const itemCreatedAt = now();
        const insertItemResult = insertItem.run(
          orderId, product.id, product.name, product.sku, unitPrice, quantity, product.track_inventory ? quantity : 0,
          itemSubtotal, taxResult.tax_amount, JSON.stringify(taxResult.tax_breakdown), itemTaxSnapshotJson,
          taxResult.tax_type, itemDiscount, itemTotal,
          JSON.stringify(item.variant_selection || null),
          JSON.stringify(item.modifier_selection || null),
          item.special_instructions || null, itemCreatedAt, itemCreatedAt
        );
        insertOrderItemAddons(db, insertItemResult.lastInsertRowid, item.addons, itemCreatedAt);

        if (product.track_inventory) {
          db.prepare('UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = ? WHERE id = ?')
            .run(quantity, now(), product.id);
        }
      }

      const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, chargeContext, customer);
      const taxRollup = combineItemAndChargeTaxes({
        itemTaxAmount: totalTax,
        itemExclusiveTaxAmount: exclusiveTax,
        itemBreakdowns: allTaxBreakdowns,
        itemSnapshots: allTaxSnapshots,
        itemTaxRatio: 1,
        chargeTaxes,
      });
      const preRoundTotal = subtotal + taxRollup.exclusiveTaxAmount
        + delCharge + pkgCharge + serviceCharge;
      const total = Number(preRoundTotal.toFixed(2));
      const roundOff = 0;

      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?,
          round_off = ?, updated_at = ? WHERE id = ?
      `).run(
        subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns),
        taxRollup.snapshotJson, total, roundOff, now(), orderId,
      );

      if (table_id && type === 'dine_in') {
        db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ?").run(now(), table_id);
      }

      const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)) as any;
      const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
      const response = { order: Object.assign({}, order, { items: orderItems }) };
      if (idempotencyKey && requestHash) {
        db.prepare('INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(idempotencyUserId, idempotencyKey, requestHash, JSON.stringify(response), now());
      }
      return { order, orderItems, idempotentReplay: false };
    });

    if (!result.idempotentReplay) {
      notifyKdsUpdate();
      cloudSync.recordOrderChanged(result.order.id, 'order.created');

      if (customer_id) {
        try {
          syncCustomerTagCounts(db, customer_id, items);
        } catch (err) {
          console.error('[Orders] Tag sync failed:', err);
        }
      }
    }

    res.status(result.idempotentReplay ? 200 : 201).json({ order: Object.assign({}, result.order, { items: result.orderItems }) });
  } catch (error: any) {
    console.error('[Orders] Create error:', error);
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.post('/:id/items', orderWriteRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const body = req.body || {};
    const { items, special_instructions } = body;
    const idempotencyKey = orderIdempotencyKey(req);
    const idempotencyUserId = String((req as any).user.userId);
    const requestHash = idempotencyKey
      ? createHash('sha256').update(JSON.stringify({ order_id: req.params.id, items, special_instructions })).digest('hex')
      : null;

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const authUser = (req as any).user;
    if (authUser?.role === 'server' && order.user_id !== authUser.userId) {
      return res.status(403).json({ error: 'Servers can only modify their own orders' });
    }

    // Replay before any mutable-order guard. A response-loss retry must return
    // the committed result even if the order was split or its validation state
    // changed after the original append.
    if (idempotencyKey && requestHash) {
      const replayResponse = getStoredOrderReplay(db, idempotencyUserId, idempotencyKey, requestHash);
      if (replayResponse) return res.json(replayResponse);
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Get settings
    const settings: Record<string, string> = {};
    db.prepare('SELECT key, value FROM settings').all().forEach((row: any) => {
      settings[row.key] = row.value;
    });

    const tenantInfo = {
      country: settings.country || 'IN',
      business_type: settings.business_type || 'restaurant',
      state_code: settings.state_code || '',
      taxes_enabled: settings.taxes_enabled === 'true',
    };

    const result = withTxn(() => {
      // Re-fetch and re-validate under the transaction lock: another request (e.g. a
      // cashier completing/cancelling the order) can race the checks above, which run
      // before this lock is acquired (#175).
      const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!currentOrder) {
        throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      }
      if (authUser?.role === 'server' && currentOrder.user_id !== authUser.userId) {
        throw Object.assign(new Error('Servers can only modify their own orders'), { statusCode: 403 });
      }

      // Re-check idempotency under the transaction lock in case the early
      // lookup raced the first request. This must remain before mutable-order
      // guards so a committed append always has a replay path.
      if (idempotencyKey && requestHash) {
        const replayResponse = getStoredOrderReplay(db, idempotencyUserId, idempotencyKey, requestHash);
        if (replayResponse) return { replayResponse };
      }

      if (db.prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1').get(req.params.id)) {
        throw Object.assign(new Error('Items cannot be changed after a check has been split'), { statusCode: 409 });
      }
      if (['completed', 'cancelled'].includes(currentOrder.status)) {
        throw Object.assign(new Error('Cannot add items to a completed or cancelled order'), { statusCode: 400 });
      }

      try {
        for (const item of items) {
          validateItemNotes(db, item.special_instructions);
          item.addons = resolveItemAddons(db, item.product_id, item.addons);
        }
        if (special_instructions !== undefined) {
          validateOrderNotes(db, special_instructions);
        }
      } catch (err: unknown) {
        throw Object.assign(new Error(err instanceof Error ? err.message : 'Invalid order item'), { statusCode: 400 });
      }

      const customer = currentOrder.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any : null;

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity, inventory_deducted_quantity,
          subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total, variant_selection,
          modifier_selection, special_instructions, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as any;
        if (!product) {
          throw new Error(`Product ${item.product_id} not found`);
        }
        if (product.track_inventory && product.stock_quantity < item.quantity) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }

        const unitPrice = parseFloat(product.price);
        const quantity = item.quantity;
        // item.discount_amount is intentionally ignored here — discounts are only
        // applied through the dedicated PATCH discount endpoints, which enforce
        // discount_mode/max_percentage/max_amount/approval (vuln-0002).
        const itemDiscount = 0;

        // Validate quantity and price
        validateProductQuantity(product, quantity);
        if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
          throw new Error(`Invalid price for ${product.name}: must be a non-negative number`);
        }

        let itemSubtotal = unitPrice * quantity;
        if (item.addons && Array.isArray(item.addons)) {
          for (const addon of item.addons) {
            if (!addon) continue;
            if (addon.quantity !== undefined) {
              if (typeof addon.quantity !== 'number' || !Number.isInteger(addon.quantity) || addon.quantity <= 0) {
                throw new Error(`Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`);
              }
            }
            const addonQty = addon.quantity || 1;
            itemSubtotal += (addon.price || 0) * addonQty * quantity;
          }
        }
        itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

        const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);
        const itemTotal = itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
        const itemTaxSnapshotJson = taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null;

        const itemCreatedAt = now();
        const insertItemResult = insertItem.run(
          req.params.id, product.id, product.name, product.sku, unitPrice, quantity, product.track_inventory ? quantity : 0,
          itemSubtotal, taxResult.tax_amount, JSON.stringify(taxResult.tax_breakdown), itemTaxSnapshotJson,
          taxResult.tax_type, itemDiscount, itemTotal,
          JSON.stringify(item.variant_selection || null),
          JSON.stringify(item.modifier_selection || null),
          item.special_instructions || null, itemCreatedAt, itemCreatedAt
        );
        insertOrderItemAddons(db, insertItemResult.lastInsertRowid, item.addons, itemCreatedAt);

        if (product.track_inventory) {
          db.prepare('UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = ? WHERE id = ?')
            .run(quantity, now(), product.id);
        }
      }

      // BUG #3 FIX: Filter out cancelled items from total recalculation
      const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'").all(req.params.id) as any[];
      let subtotal = 0;
      let totalTax = 0;
      let exclusiveTax = 0;
      const allTaxBreakdowns: any[] = [];
      const allTaxSnapshots: (string | null)[] = [];
      for (const item of activeItems) {
        subtotal += item.subtotal;
        totalTax += item.tax_amount;
        if (item.tax_type !== 'inclusive') {
          exclusiveTax += item.tax_amount;
        }
        if (item.tax_breakdown) {
          try {
            const breakdown = JSON.parse(item.tax_breakdown);
            if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
          } catch { }
        }
        allTaxSnapshots.push(item.tax_snapshot || null);
      }

      // BUG #12 FIX: Preserve order-level discount (scale percentage proportionally)
      const existingDiscountAmount = currentOrder.discount_amount || 0;
      let newDiscountAmount = existingDiscountAmount;
      if (existingDiscountAmount > 0 && currentOrder.subtotal > 0) {
        if (currentOrder.discount_type === 'percentage') {
          const pct = currentOrder.discount_value || 0;
          newDiscountAmount = Math.round(subtotal * pct / 100 * 100) / 100;
        }
        // amount type: keep same value
      }

      const discountedSubtotal = Math.max(0, subtotal - newDiscountAmount);
      let newTaxAmount = totalTax;
      let newExclusiveTax = exclusiveTax;
      let taxRatio = 1;
      if (newDiscountAmount > 0 && subtotal > 0) {
        taxRatio = discountedSubtotal / subtotal;
        newTaxAmount = Math.round(totalTax * taxRatio * 100) / 100;
        newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
      }

      const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, currentOrder, customer);
      const taxRollup = combineItemAndChargeTaxes({
        itemTaxAmount: newTaxAmount,
        itemExclusiveTaxAmount: newExclusiveTax,
        itemBreakdowns: allTaxBreakdowns,
        itemSnapshots: allTaxSnapshots,
        itemTaxRatio: taxRatio,
        chargeTaxes,
      });
      const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
        + (currentOrder.delivery_charge || 0) + (currentOrder.packaging_charge || 0) + (currentOrder.service_charge || 0);
      const total = Number(preRoundTotal.toFixed(2));
      const roundOff = 0;

      // Update order totals and optionally update order-level notes
      if (special_instructions !== undefined) {
        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, special_instructions = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, special_instructions || null, now(), req.params.id);
      } else {
        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), req.params.id);
      }

      // BUG #4 FIX: Sync bill if it exists (add-items didn't update the bill)
      const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(req.params.id) as any;
      if (existingBill) {
        const pack = getActiveCountryPack(tenantInfo.country);
        const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(total, pack);
        const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
        db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, service_charge = ?, round_off = ?, updated_at = ? WHERE id = ?`)
          .run(billTotal, newBillBalance, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, currentOrder.service_charge || 0, billRoundOff, now(), existingBill.id);
      }

      const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
      const updatedItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);
      const response = { order: Object.assign({}, updatedOrder, { items: updatedItems }) };
      if (idempotencyKey && requestHash) {
        db.prepare('INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(idempotencyUserId, idempotencyKey, requestHash, JSON.stringify(response), now());
      }
      return { updatedOrder, updatedItems, replayResponse: null };
    });

    if (result.replayResponse) return res.json(result.replayResponse);
    cloudSync.recordOrderChanged(req.params.id as string, 'order.updated');
    notifyKdsUpdate();

    res.json({ order: Object.assign({}, result.updatedOrder, { items: result.updatedItems }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.patch('/:id/status', orderWriteRateLimit, requireRole(...ROLE_ACCESS.orderStatus), (req: Request, res: Response) => {
  try {
    const { status, reason, override_pin, free_table } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['preparing', 'ready', 'served', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
    }

    // reason is optional for cancellation

    const db = getDatabase();
    // Keep the pre-transaction lookup limited to not-found reporting. All
    // order/item-dependent authorization and policy decisions are repeated
    // from currentOrder inside the authoritative transaction below.
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const nowStr = now();

    const { updatedOrder, orderItems, table, changed } = withTxn(() => {
      const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!currentOrder) {
        throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      }

      const authUser = (req as any).user;
      const currentUser = authUser?.userId
        ? db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(authUser.userId) as { role: string; is_active: number } | undefined
        : undefined;
      if (!currentUser || currentUser.is_active !== 1 || !hasRole(currentUser.role, ROLE_ACCESS.orderStatus)) {
        throw Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
      }
      if (currentUser.role === 'server' && String(currentOrder.user_id) !== String(authUser.userId)) {
        throw Object.assign(new Error('Servers can only modify their own orders'), { statusCode: 403 });
      }

      if (currentOrder.status === status) {
        // Idempotent same-state request for order
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);
        const tableRow = currentOrder.table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get(currentOrder.table_id) as any : null;
        const tableObj = tableRow ? { ...tableRow, name: tableRow.number } : null;
        return { updatedOrder: parseRowJson(currentOrder), orderItems: items, table: tableObj, changed: false };
      }

      const VALID_TRANSITIONS: Record<string, string[]> = {
        pending: ['preparing', 'ready', 'served', 'completed', 'cancelled'],
        preparing: ['ready', 'served', 'completed', 'cancelled'],
        ready: ['served', 'completed', 'cancelled'],
        served: ['completed', 'cancelled'],
        completed: [],
        cancelled: [],
      };

      const allowedTargets = VALID_TRANSITIONS[currentOrder.status] || [];
      if (!allowedTargets.includes(status)) {
        throw Object.assign(new Error(`Cannot transition order status from '${currentOrder.status}' to '${status}'`), { statusCode: 400 });
      }

      // Cancellation authorization is based on the same transaction-local
      // order and item snapshot that will be mutated below.
      const hasItemsInProgress = db.prepare(`
        SELECT 1 FROM order_items
        WHERE order_id = ? AND status IN ('preparing', 'ready', 'served', 'completed')
        LIMIT 1
      `).get(req.params.id) !== undefined;
      const statusOrder = ['pending', 'preparing', 'ready', 'served', 'completed'];
      const currentStatusIndex = statusOrder.indexOf(currentOrder.status);
      const requiresOverride = (currentStatusIndex > 0 || hasItemsInProgress) && status === 'cancelled';

      if (requiresOverride) {
        if (!override_pin) {
          throw Object.assign(new Error('Manager PIN required to cancel order in progress'), { statusCode: 400 });
        }

        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        // Key is per-client/per-action, deliberately NOT per-order: a caller
        // must not get a fresh attempt window by rotating order identifiers
        // (GHSA-9jjq-2fmw-x3mw).
        const rateLimitKey = `pin:${clientIp}:order-cancel`;
        if (!checkPinRateLimit(rateLimitKey)) {
          throw Object.assign(new Error('Too many PIN attempts. Try again in 15 minutes.'), { statusCode: 429 });
        }

        const user = db.prepare(`SELECT * FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS})`)
          .all(...ROLE_ACCESS.ownerManager)
          .find((u: any) => verifyPin(u.pin_hash, override_pin));

        if (!user) {
          throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
        }
      }

      switch (status) {
        case 'preparing':
          db.prepare('UPDATE orders SET status = ?, cooking_started_at = ?, updated_at = ? WHERE id = ?')
            .run(status, nowStr, nowStr, req.params.id);
          break;

        case 'ready':
          db.prepare('UPDATE orders SET status = ?, ready_at = ?, updated_at = ? WHERE id = ?')
            .run(status, nowStr, nowStr, req.params.id);
          break;

        case 'served':
          db.prepare('UPDATE orders SET status = ?, served_at = ?, updated_at = ? WHERE id = ?')
            .run(status, nowStr, nowStr, req.params.id);
          break;

        case 'completed':
          db.prepare('UPDATE orders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
            .run(status, nowStr, nowStr, req.params.id);
          db.prepare(`
            UPDATE order_items SET status = 'served', updated_at = ?
            WHERE order_id = ? AND status IN ('pending', 'preparing', 'ready')
          `).run(nowStr, req.params.id);
          if (currentOrder.table_id) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(nowStr, currentOrder.table_id);
          }
          break;

        case 'cancelled': {
          // Select only items eligible for restocking (exclude already cancelled, voided, or accounting adjustments)
          const eligibleItems = db.prepare(`
            SELECT * FROM order_items
            WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
          `).all(req.params.id) as any[];

          for (const item of eligibleItems) {
            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as any;
            if (product && item.inventory_deducted_quantity > 0) {
              db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ?')
                .run(item.inventory_deducted_quantity, nowStr, product.id);
            }
          }

          db.prepare(`
            UPDATE order_items SET status = 'cancelled', updated_at = ?
            WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
          `).run(nowStr, req.params.id);

          db.prepare('UPDATE orders SET status = ?, cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?')
            .run(status, nowStr, reason, nowStr, req.params.id);
          // Only free table if explicitly requested (default: true for backward compatibility)
          if (currentOrder.table_id && free_table !== false) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(nowStr, currentOrder.table_id);
          }
          break;
        }
      }

      const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
      const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);
      const tableRow2 = updatedOrder.table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get(updatedOrder.table_id) as any : null;
      const table = tableRow2 ? { ...tableRow2, name: tableRow2.number } : null;
      return { updatedOrder, orderItems, table, changed: true };
    });

    if (changed) {
      cloudSync.recordOrderChanged(req.params.id as string, `order.${status}`);
      notifyKdsUpdate();
    }

    res.json({ order: Object.assign({}, updatedOrder, { items: orderItems, table }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.patch('/:id/customer', orderWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { customer_id } = req.body;

    // Validate customer exists if providing one
    if (customer_id) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }
    }

    const nowStr = now();
    const updatedOrder = withTxn(() => {
      db.prepare('UPDATE orders SET customer_id = ?, updated_at = ? WHERE id = ?')
        .run(customer_id || null, nowStr, req.params.id);

      // Keep every unpaid guest check attached to the same customer.
      db.prepare("UPDATE bills SET customer_id = ?, updated_at = ? WHERE order_id = ? AND payment_status != 'paid'")
        .run(customer_id || null, nowStr, req.params.id);

      return parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
    });

    const customer = updatedOrder.customer_id
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(updatedOrder.customer_id)
      : null;

    cloudSync.recordOrderChanged(req.params.id as string, 'order.updated');
    notifyOrderUpdated();

    res.json({ order: { ...updatedOrder, customer } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/:id/convert-to-takeaway', orderWriteRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const nowStr = now();

    withTxn(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!order) {
        throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      }
      if (order.type !== 'dine_in') {
        throw Object.assign(new Error('Only dine-in orders can be converted to takeaway'), { statusCode: 400 });
      }
      if (['completed', 'cancelled'].includes(order.status)) {
        throw Object.assign(new Error('Cannot convert a completed or cancelled order'), { statusCode: 400 });
      }
      if (db.prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1').get(req.params.id)) {
        throw Object.assign(new Error('A split dine-in check cannot be converted to takeaway'), { statusCode: 409 });
      }

      db.prepare("UPDATE orders SET type = 'takeaway', table_id = NULL, updated_at = ? WHERE id = ?")
        .run(nowStr, req.params.id);

      if (order.table_id) {
        db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
          .run(nowStr, order.table_id);
      }
      return order.table_id;
    });

    const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
    const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);

    cloudSync.recordOrderChanged(req.params.id as string, 'order.type_changed');
    notifyKdsUpdate();

    res.json({ order: Object.assign({}, updatedOrder, { items: orderItems, table: null }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.patch('/:id/discount', orderWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (db.prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1').get(req.params.id)) {
      return res.status(409).json({ error: 'Discounts cannot be changed after a check has been split' });
    }

    // Cannot apply discount to completed or cancelled orders
    if (['completed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot apply discount to a completed or cancelled order' });
    }

    const { discount_type, discount_value, discount_reason } = req.body || {};

    // Validate discount_type
    if (discount_value !== 0 && (!discount_type || !['percentage', 'amount'].includes(discount_type))) {
      return res.status(400).json({ error: 'discount_type must be "percentage" or "amount"' });
    }

    // Validate discount_value is a non-negative finite number
    if (discount_value === undefined || discount_value === null || typeof discount_value !== 'number' || discount_value < 0 || !Number.isFinite(discount_value)) {
      return res.status(400).json({ error: 'discount_value must be a non-negative number' });
    }

    // Check if approval is required
    if (discount_value > 0) {
      const requiresApproval = getSettingValue('discount_requires_approval') === 'true';
      if (requiresApproval) {
        const { override_pin } = req.body || {};
        if (!override_pin) {
          return res.status(403).json({ error: 'Manager PIN required for discounts', requiresApproval: true });
        }
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateLimitKey = `pin:${clientIp}:discount`;
        if (!checkPinRateLimit(rateLimitKey)) {
          return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
        }
        const user = db.prepare(`SELECT * FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS})`)
          .all(...ROLE_ACCESS.ownerManager)
          .find((u: any) => verifyPin(u.pin_hash, override_pin));
        if (!user) {
          return res.status(403).json({ error: 'Invalid manager PIN' });
        }
      }
    }

    // Check discount mode
    if (discount_value > 0) {
      const discountMode = getSettingValue('discount_mode') || 'percentage';
      if (discountMode === 'flat' && discount_type === 'percentage') {
        return res.status(400).json({ error: 'Percentage discounts are disabled' });
      }
      if (discountMode === 'percentage' && discount_type === 'amount') {
        return res.status(400).json({ error: 'Flat amount discounts are disabled' });
      }
    }

    // Check against limits from settings (0 = no limit)
    if (discount_value > 0) {
      if (discount_type === 'percentage') {
        const maxPercentage = parseFloat(getSettingValue('discount_max_percentage') || '25');
        if (maxPercentage > 0 && discount_value > maxPercentage) {
          return res.status(400).json({ error: `discount_value exceeds maximum percentage of ${maxPercentage}` });
        }
      } else if (discount_type === 'amount') {
        const maxAmount = parseFloat(getSettingValue('discount_max_amount') || '0');
        if (maxAmount > 0 && discount_value > maxAmount) {
          return res.status(400).json({ error: `discount_value exceeds maximum amount of ${maxAmount}` });
        }
      }
    }
    const tenantInfo = {
      country: getSettingValue('country') || 'IN',
      business_type: getSettingValue('business_type') || 'restaurant',
      state_code: getSettingValue('state_code') || '',
      taxes_enabled: getSettingValue('taxes_enabled') === 'true',
    };
    // BUG #6 FIX: Wrap discount + tax + bill sync in a transaction
    const result = withTxn(() => {
      // Re-fetch and re-validate under the transaction lock: another request (e.g. a
      // concurrent item add/void, or the order being completed/cancelled) can race the
      // checks above and change status/subtotal before this lock is acquired (#175).
      const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!currentOrder) {
        throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      }
      if (['completed', 'cancelled'].includes(currentOrder.status)) {
        throw Object.assign(new Error('Cannot apply discount to a completed or cancelled order'), { statusCode: 400 });
      }

      const customer = currentOrder.customer_id
        ? db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any
        : null;

      // Calculate discount amount
      let discountAmount = 0;
      if (discount_value > 0) {
        if (discount_type === 'percentage') {
          discountAmount = (currentOrder.subtotal * discount_value) / 100;
        } else {
          discountAmount = Math.min(discount_value, currentOrder.subtotal);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
      }

      // Always recalculate tax from item-level data (not by scaling the already-discounted
      // order.tax_amount from the DB), otherwise repeated discount updates compound the
      // reduction each time this endpoint is called.
      const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'").all(req.params.id) as any[];
      let freshTax = 0;
      let exclusiveTax = 0;
      const allTaxBreakdowns: any[] = [];
      const allTaxSnapshots: (string | null)[] = [];
      for (const item of activeItems) {
        freshTax += item.tax_amount || 0;
        if (item.tax_type !== 'inclusive') {
          exclusiveTax += item.tax_amount || 0;
        }
        if (item.tax_breakdown) {
          try {
            const breakdown = JSON.parse(item.tax_breakdown);
            if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
          } catch { }
        }
        allTaxSnapshots.push(item.tax_snapshot || null);
      }
      let newTaxAmount = freshTax;
      let newExclusiveTax = exclusiveTax;
      let taxRatio = 1;
      if (discountAmount > 0 && currentOrder.subtotal > 0) {
        const discountedSubtotal = Math.max(0, currentOrder.subtotal - discountAmount);
        taxRatio = discountedSubtotal / currentOrder.subtotal;
        newTaxAmount = Math.round(freshTax * taxRatio * 100) / 100;
        newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
      }

      const discountedSubtotal = Math.max(0, currentOrder.subtotal - discountAmount);
      const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, currentOrder, customer);
      const taxRollup = combineItemAndChargeTaxes({
        itemTaxAmount: newTaxAmount,
        itemExclusiveTaxAmount: newExclusiveTax,
        itemBreakdowns: allTaxBreakdowns,
        itemSnapshots: allTaxSnapshots,
        itemTaxRatio: taxRatio,
        chargeTaxes,
      });
      const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
        + (currentOrder.packaging_charge || 0) + (currentOrder.delivery_charge || 0) + (currentOrder.service_charge || 0);
      const newTotal = Number(preRoundTotal.toFixed(2));
      const roundOff = 0;

      db.prepare(`
        UPDATE orders SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
        discountAmount,
        discount_value > 0 ? discount_type : null,
        discount_value > 0 ? discount_value : null,
        discount_value > 0 ? (discount_reason || null) : null,
        taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newTotal, roundOff, now(), req.params.id
      );

      // Sync discount to bill if it exists and is unpaid
      const existingBill = db.prepare('SELECT * FROM bills WHERE order_id = ? AND payment_status != ?')
        .get(req.params.id, 'paid') as any;
      if (existingBill) {
        const pack = getActiveCountryPack(tenantInfo.country);
        const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(newTotal, pack);
        const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
        db.prepare(`
          UPDATE bills SET discount_amount = ?, discount_type = ?, discount_value = ?,
            discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?, balance = ?, service_charge = ?, round_off = ?, updated_at = ?
          WHERE id = ?
        `).run(
          discountAmount,
          discount_value > 0 ? discount_type : null,
          discount_value > 0 ? discount_value : null,
          discount_value > 0 ? (discount_reason || null) : null,
          taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, billTotal, newBillBalance, currentOrder.service_charge || 0, billRoundOff, now(), existingBill.id
        );
      }

      const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
      return updatedOrder;
    });

    notifyOrderUpdated();
    res.json({ order: result });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.patch('/:id/items/:itemId/discount', orderWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (db.prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1').get(req.params.id)) {
      return res.status(409).json({ error: 'Discounts cannot be changed after a check has been split' });
    }

    // Cannot apply discount to completed or cancelled orders
    if (['completed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot apply discount to a completed or cancelled order' });
    }

    const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(req.params.itemId, req.params.id) as any;
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const { discount_type, discount_value } = req.body;

    // Validate discount_type
    if (!discount_type || !['percentage', 'amount'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type must be "percentage" or "amount"' });
    }

    // Validate discount_value is a positive number
    if (discount_value === undefined || discount_value === null || typeof discount_value !== 'number' || discount_value <= 0) {
      return res.status(400).json({ error: 'discount_value must be a positive number' });
    }

    // Check if approval is required
    const requiresApproval = getSettingValue('discount_requires_approval') === 'true';
    if (requiresApproval) {
      const { override_pin } = req.body;
      if (!override_pin) {
        return res.status(403).json({ error: 'Manager PIN required for discounts', requiresApproval: true });
      }
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimitKey = `pin:${clientIp}:item-discount`;
      if (!checkPinRateLimit(rateLimitKey)) {
        return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
      }
      const user = db.prepare(`SELECT * FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS})`)
        .all(...ROLE_ACCESS.ownerManager)
        .find((u: any) => verifyPin(u.pin_hash, override_pin));
      if (!user) {
        return res.status(403).json({ error: 'Invalid manager PIN' });
      }
    }

    // Check discount mode
    const discountMode = getSettingValue('discount_mode') || 'percentage';
    if (discountMode === 'flat' && discount_type === 'percentage') {
      return res.status(400).json({ error: 'Percentage discounts are disabled' });
    }
    if (discountMode === 'percentage' && discount_type === 'amount') {
      return res.status(400).json({ error: 'Flat amount discounts are disabled' });
    }

    // BUG #14 FIX: Check item-level discount against max settings (0 = no limit)
    if (discount_type === 'percentage') {
      const maxPercentage = parseFloat(getSettingValue('discount_max_percentage') || '25');
      if (maxPercentage > 0 && discount_value > maxPercentage) {
        return res.status(400).json({ error: `discount_value exceeds maximum percentage of ${maxPercentage}` });
      }
    } else if (discount_type === 'amount') {
      const maxAmount = parseFloat(getSettingValue('discount_max_amount') || '0');
      if (maxAmount > 0 && discount_value > maxAmount) {
        return res.status(400).json({ error: `discount_value exceeds maximum amount of ${maxAmount}` });
      }
    }

    // Calculate item discount amount (include addon prices)
    const addonRows = db.prepare('SELECT price, quantity FROM order_item_addons WHERE order_item_id = ?').all(item.id) as { price: number; quantity?: number }[];
    const addonTotal = addonRows.reduce((sum, addon) => sum + (addon.price || 0) * (addon.quantity || 1) * item.quantity, 0);
    const itemBaseTotal = item.unit_price * item.quantity + addonTotal;

    let discountAmount: number;
    if (discount_type === 'percentage') {
      discountAmount = (itemBaseTotal * discount_value) / 100;
    } else {
      discountAmount = Math.min(discount_value, itemBaseTotal);
    }
    discountAmount = Math.round(discountAmount * 100) / 100;

    // Recalculate item subtotal after discount
    const newSubtotal = Math.max(0, itemBaseTotal - discountAmount);

    // Recalculate tax on discounted subtotal
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as any;
    const customer = order.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) as any : null;
    const settings = db.prepare("SELECT * FROM settings WHERE key IN ('country', 'business_type', 'state_code', 'taxes_enabled')").all() as any[];
    const settingsMap = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));
    const tenantInfo = {
      country: settingsMap.country || 'IN',
      business_type: settingsMap.business_type || 'restaurant',
      state_code: settingsMap.state_code || '',
      taxes_enabled: settingsMap.taxes_enabled === 'true',
    };
    const taxResult = calculateItemTax(tenantInfo, product, newSubtotal, customer);
    const newTaxAmount = taxResult.tax_amount;
    const newTaxBreakdown = taxResult.tax_breakdown;
    const newTaxSnapshotJson = taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null;

    const newTotal = newSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : newTaxAmount);

    const updatedItem = withTxn(() => {
      // Update item with recalculated tax
      db.prepare(`
        UPDATE order_items SET discount_amount = ?,
          subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, tax_type = ?,
          total = ?, updated_at = ? WHERE id = ?
      `).run(
        discountAmount, newSubtotal, newTaxAmount, JSON.stringify(newTaxBreakdown),
        newTaxSnapshotJson, taxResult.tax_type, newTotal, now(), req.params.itemId,
      );

      // Update order totals (preserve existing order-level discount)
      // Note: status != 'cancelled' — a cancelled item's tax must not re-enter
      // the order total here, same filter every other recompute site in this
      // file already uses (BUG #3 FIX above, index.ts cancel/restore below).
      const allItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'").all(req.params.id) as any[];
      let orderSubtotal = 0;
      let orderTax = 0;
      let exclusiveOrderTax = 0;
      const allTaxBreakdowns: any[] = [];
      const allTaxSnapshots: (string | null)[] = [];
      for (const i of allItems) {
        orderSubtotal += i.subtotal;
        orderTax += i.tax_amount;
        if (i.tax_type !== 'inclusive') {
          exclusiveOrderTax += i.tax_amount;
        }
        if (i.tax_breakdown) {
          try {
            const breakdown = JSON.parse(i.tax_breakdown);
            if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
          } catch { }
        }
        allTaxSnapshots.push(i.tax_snapshot || null);
      }

      // Recalculate order-level discount proportionally on new subtotal
      const existingDiscountAmount = order.discount_amount || 0;
      let newOrderDiscount = existingDiscountAmount;
      if (existingDiscountAmount > 0 && order.subtotal > 0) {
        // Scale discount proportionally to new subtotal
        newOrderDiscount = Math.round(existingDiscountAmount * (orderSubtotal / order.subtotal) * 100) / 100;
      }

      // Recalculate tax on discounted subtotal
      const discountedSubtotal = Math.max(0, orderSubtotal - newOrderDiscount);
      let newOrderTax = orderTax;
      let newExclusiveOrderTax = exclusiveOrderTax;
      let taxRatio = 1;
      if (newOrderDiscount > 0 && orderSubtotal > 0) {
        taxRatio = discountedSubtotal / orderSubtotal;
        newOrderTax = Math.round(orderTax * taxRatio * 100) / 100;
        newExclusiveOrderTax = Math.round(exclusiveOrderTax * taxRatio * 100) / 100;
      }

      const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, order, customer);
      const taxRollup = combineItemAndChargeTaxes({
        itemTaxAmount: newOrderTax,
        itemExclusiveTaxAmount: newExclusiveOrderTax,
        itemBreakdowns: allTaxBreakdowns,
        itemSnapshots: allTaxSnapshots,
        itemTaxRatio: taxRatio,
        chargeTaxes,
      });
      const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
        + (order.packaging_charge || 0) + (order.delivery_charge || 0) + (order.service_charge || 0);
      const orderTotal = Number(preRoundTotal.toFixed(2));
      const roundOff = 0;

      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(orderSubtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newOrderDiscount, orderTotal, roundOff, now(), req.params.id);

      // BUG #15 FIX: Sync item-level discount to bill
      const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(req.params.id) as any;
      if (existingBill) {
        const pack = getActiveCountryPack(tenantInfo.country);
        const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(orderTotal, pack);
        const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
        db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, service_charge = ?, round_off = ?, updated_at = ? WHERE id = ?`)
          .run(billTotal, newBillBalance, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newOrderDiscount, order.service_charge || 0, billRoundOff, now(), existingBill.id);
      }

      return db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.itemId) as any;
    });

    res.json({ item: updatedItem });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

export const orderRoutes = router;
