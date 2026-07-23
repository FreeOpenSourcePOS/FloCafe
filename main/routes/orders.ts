import { Router, Request, Response } from 'express';
import { getDatabase, generateOrderNumber, now, parseItemJson, parseRowJson, withTxn, verifyPin, getSettingValue, insertOrderItemAddons, attachEffectiveAddons } from '../db';
import { calculateItemTax } from '../services/tax';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { cloudSync } from '../services/cloud-sync';
import { validateOrderNotes, validateItemNotes } from './orders-validation';
import { requireRole } from '../middleware/security';

const router = Router();

// Rate limiting for PIN validation (simple in-memory)
const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkPinRateLimit(key: string): boolean {
  const now = Date.now();
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

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const db = getDatabase();
    let query = 'SELECT * FROM orders WHERE 1=1';
    const params: any[] = [];

    if (req.query.status) {
      const statuses = (req.query.status as string).split(',');
      if (statuses.length === 1) {
        query += ' AND status = ?';
        params.push(statuses[0]);
      } else {
        query += ` AND status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (req.query.type) {
      query += ' AND type = ?';
      params.push(req.query.type);
    }
    if (req.query.today && req.query.today !== '0' && req.query.today !== 'false') {
      query += " AND date(created_at) = date('now')";
    }
    if (req.query.table_id) {
      query += ' AND table_id = ?';
      params.push(req.query.table_id);
    }

    if (user.role === 'waiter') {
      query += ' AND user_id = ?';
      params.push(user.userId);
    }

    query += ' ORDER BY created_at DESC';

    if (req.query.per_page) {
      const perPage = Math.min(Math.max(parseInt(req.query.per_page as string) || 50, 1), 500);
      query += ` LIMIT ${perPage}`;
    }

    const orders = db.prepare(query).all(...params).map(parseRowJson);

    // Load related data
    const ordersWithRelations = orders.map((order: any) => {
      const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id).map(parseItemJson) as any[]);
      const tableRow = order.table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any : null;
      const table = tableRow ? { ...tableRow, name: tableRow.number } : null;
      const customer = order.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) : null;
      const bill = parseRowJson(db.prepare('SELECT * FROM bills WHERE order_id = ?').get(order.id) as any);
      return { ...order, items, table, customer, bill };
    });

    res.json({ orders: ordersWithRelations });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const db = getDatabase();
    const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (user.role === 'waiter' && (order as any).user_id !== user.userId) {
      return res.status(403).json({ error: 'Waiters can only view their own orders' });
    }

    const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);
    const tableRow = (order as any).table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get((order as any).table_id) as any : null;
    const table = tableRow ? { ...tableRow, name: tableRow.number } : null;
    const customer = (order as any).customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get((order as any).customer_id) : null;
    const bill = parseRowJson(db.prepare('SELECT * FROM bills WHERE order_id = ?').get(req.params.id));

    res.json({ order: { ...order, items, table, customer, bill } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const { table_id, customer_id, type, guest_count, special_instructions, packaging_charge, delivery_charge, items } = req.body;
    // Always the authenticated caller, never client-supplied — trusting a
    // client-sent user_id would let staff spoof order attribution, and the
    // frontend has in fact never sent one, so every order got user_id=NULL.
    // That silently broke waiters' own order visibility (GET /orders scopes
    // waiters to `user_id = <their id>`, which NULL can never match) and any
    // per-staff sales attribution.
    const authenticatedUserId = (req as any).user.userId;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    if (!type || !['dine_in', 'takeaway', 'delivery', 'online'].includes(type)) {
      return res.status(400).json({ error: 'Valid type is required (dine_in, takeaway, delivery, online)' });
    }

    const db = getDatabase();

    try {
      validateOrderNotes(db, special_instructions);
      for (const item of items) {
        validateItemNotes(db, item.special_instructions);
      }
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    const { order, orderItems } = withTxn(() => {
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
      };

      const orderResult = db.prepare(`
        INSERT INTO orders (order_number, table_id, customer_id, user_id, type, guest_count, special_instructions,
          packaging_charge, delivery_charge, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(orderNumber, table_id || null, customer_id || null, authenticatedUserId, type, guest_count || null,
        special_instructions || null, packaging_charge || 0, delivery_charge || 0, now(), now());

      const orderId = orderResult.lastInsertRowid;

      let subtotal = 0;
      let totalTax = 0;
      let exclusiveTax = 0;
      const allTaxBreakdowns: any[] = [];

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity,
          subtotal, tax_amount, tax_breakdown, tax_type, discount_amount, total, variant_selection,
          modifier_selection, special_instructions, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
        if (!quantity || quantity <= 0 || !Number.isFinite(quantity)) {
          throw new Error(`Invalid quantity for ${product.name}: must be a positive number`);
        }
        if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
          throw new Error(`Invalid price for ${product.name}: must be a non-negative number`);
        }

        let itemSubtotal = unitPrice * quantity;
        if (item.addons) {
          for (const addon of item.addons) {
            itemSubtotal += (addon.price || 0) * quantity;
          }
        }
        itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

        const customer = customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id) as any : null;
        const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);

        totalTax += taxResult.tax_amount;
        if (taxResult.tax_type !== 'inclusive') {
          exclusiveTax += taxResult.tax_amount;
        }
        if (taxResult.tax_breakdown) {
          allTaxBreakdowns.push(taxResult.tax_breakdown);
        }

        const itemTotal = itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
        subtotal += itemSubtotal;

        const itemCreatedAt = now();
        const insertItemResult = insertItem.run(
          orderId, product.id, product.name, product.sku, unitPrice, quantity,
          itemSubtotal, taxResult.tax_amount, JSON.stringify(taxResult.tax_breakdown),
          product.tax_type, itemDiscount, itemTotal,
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

      const preRoundTotal = subtotal + exclusiveTax + (delivery_charge || 0) + (packaging_charge || 0);
      const total = Math.round(preRoundTotal);
      const roundOff = total - preRoundTotal;

      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, total = ?,
          round_off = ?, updated_at = ? WHERE id = ?
      `).run(subtotal, totalTax, JSON.stringify(allTaxBreakdowns), total, roundOff, now(), orderId);

      if (table_id && type === 'dine_in') {
        db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ?").run(now(), table_id);
      }

      const order = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)) as any;
      const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
      return { order, orderItems };
    });

    notifyKdsUpdate();
    notifyOrderUpdated();
    cloudSync.recordOrderChanged(order.id, 'order.created');

    if (customer_id) {
      try {
        syncCustomerTagCounts(db, customer_id, items);
      } catch (err) {
        console.error('[Orders] Tag sync failed:', err);
      }
    }

    res.status(201).json({ order: Object.assign({}, order, { items: orderItems }) });
  } catch (error: any) {
    console.error('[Orders] Create error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/items', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (['completed', 'cancelled'].includes((order as any).status)) {
      return res.status(400).json({ error: 'Cannot add items to a completed or cancelled order' });
    }

    const { items, special_instructions } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    try {
      for (const item of items) {
        validateItemNotes(db, item.special_instructions);
      }
      if (special_instructions !== undefined) {
        validateOrderNotes(db, special_instructions);
      }
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
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
    };

    const customer = (order as any).customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get((order as any).customer_id) as any : null;

    const { updatedOrder, updatedItems } = withTxn(() => {
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity,
          subtotal, tax_amount, tax_breakdown, tax_type, discount_amount, total, variant_selection,
          modifier_selection, special_instructions, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
        if (!quantity || quantity <= 0 || !Number.isFinite(quantity)) {
          throw new Error(`Invalid quantity for ${product.name}: must be a positive number`);
        }
        if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
          throw new Error(`Invalid price for ${product.name}: must be a non-negative number`);
        }

        let itemSubtotal = unitPrice * quantity;
        if (item.addons) {
          for (const addon of item.addons) {
            itemSubtotal += (addon.price || 0) * quantity;
          }
        }
        itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

        const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);
        const itemTotal = itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);

        const itemCreatedAt = now();
        const insertItemResult = insertItem.run(
          req.params.id, product.id, product.name, product.sku, unitPrice, quantity,
          itemSubtotal, taxResult.tax_amount, JSON.stringify(taxResult.tax_breakdown),
          product.tax_type, itemDiscount, itemTotal,
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
      }

      // BUG #12 FIX: Preserve order-level discount (scale percentage proportionally)
      const existingDiscountAmount = (order as any).discount_amount || 0;
      let newDiscountAmount = existingDiscountAmount;
      if (existingDiscountAmount > 0 && (order as any).subtotal > 0) {
        if ((order as any).discount_type === 'percentage') {
          const pct = (order as any).discount_value || 0;
          newDiscountAmount = Math.round(subtotal * pct / 100 * 100) / 100;
        }
        // amount type: keep same value
      }

      const discountedSubtotal = Math.max(0, subtotal - newDiscountAmount);
      let newTaxAmount = totalTax;
      let newExclusiveTax = exclusiveTax;
      if (newDiscountAmount > 0 && subtotal > 0) {
        const taxRatio = discountedSubtotal / subtotal;
        newTaxAmount = Math.round(totalTax * taxRatio * 100) / 100;
        newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
      }

      const preRoundTotal = discountedSubtotal + newExclusiveTax + ((order as any).delivery_charge || 0) + ((order as any).packaging_charge || 0);
      const total = Math.round(preRoundTotal);
      const roundOff = total - preRoundTotal;

      // Update order totals and optionally update order-level notes
      if (special_instructions !== undefined) {
        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, discount_amount = ?, total = ?, round_off = ?, special_instructions = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, newTaxAmount, JSON.stringify(allTaxBreakdowns), newDiscountAmount, total, roundOff, special_instructions || null, now(), req.params.id);
      } else {
        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, newTaxAmount, JSON.stringify(allTaxBreakdowns), newDiscountAmount, total, roundOff, now(), req.params.id);
      }

      // BUG #4 FIX: Sync bill if it exists (add-items didn't update the bill)
      const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(req.params.id) as any;
      if (existingBill) {
        const newBillBalance = Math.max(0, total - (existingBill.paid_amount || 0));
        db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
          .run(total, newBillBalance, newTaxAmount, newDiscountAmount, roundOff, now(), existingBill.id);
      }

      const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
      const updatedItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);
      return { updatedOrder, updatedItems };
    });

    cloudSync.recordOrderChanged(req.params.id, 'order.updated');
    notifyOrderUpdated();

    res.json({ order: Object.assign({}, updatedOrder, { items: updatedItems }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/:id/status', requireRole('owner', 'manager', 'chef', 'waiter'), (req: Request, res: Response) => {
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
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Override validation: cancelling an order in preparing+ status requires manager PIN
    const statusOrder = ['pending', 'preparing', 'ready', 'served', 'completed'];
    const currentStatusIndex = statusOrder.indexOf((order as any).status);
    const requiresOverride = currentStatusIndex > 0 && status === 'cancelled';

    if (requiresOverride) {
      if (!override_pin) {
        return res.status(400).json({ error: 'Manager PIN required to cancel order in progress' });
      }

      // Rate limit PIN attempts per IP
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimitKey = `pin:${clientIp}:${req.params.id}`;
      if (!checkPinRateLimit(rateLimitKey)) {
        return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
      }

      // Validate PIN against owner/manager accounts only
      const user = db.prepare("SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN ('owner', 'manager')")
        .all()
        .find((u: any) => verifyPin(u.pin_hash, override_pin));

      if (!user) {
        return res.status(403).json({ error: 'Invalid manager PIN' });
      }
    }

    const nowStr = now();

    const { updatedOrder, orderItems, table } = withTxn(() => {
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
          if ((order as any).table_id) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(nowStr, (order as any).table_id);
          }
          break;

        case 'cancelled': {
          const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id) as any[];
          for (const item of items) {
            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as any;
            if (product && product.track_inventory) {
              db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ?')
                .run(item.quantity, nowStr, product.id);
            }
          }
          db.prepare('UPDATE orders SET status = ?, cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?')
            .run(status, nowStr, reason, nowStr, req.params.id);
          // Only free table if explicitly requested (default: true for backward compatibility)
          if ((order as any).table_id && free_table !== false) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(nowStr, (order as any).table_id);
          }
          break;
        }
      }

      const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
      const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);
      const tableRow2 = updatedOrder.table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get(updatedOrder.table_id) as any : null;
      const table = tableRow2 ? { ...tableRow2, name: tableRow2.number } : null;
      return { updatedOrder, orderItems, table };
    });

    cloudSync.recordOrderChanged(req.params.id, `order.${status}`);
    notifyKdsUpdate();
    notifyOrderUpdated();

    res.json({ order: Object.assign({}, updatedOrder, { items: orderItems, table }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/:id/customer', requireRole('owner', 'manager'), (req: Request, res: Response) => {
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
    db.prepare('UPDATE orders SET customer_id = ?, updated_at = ? WHERE id = ?')
      .run(customer_id || null, nowStr, req.params.id);

    // Sync bill if it exists
    const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(req.params.id) as any;
    if (existingBill) {
      db.prepare('UPDATE bills SET customer_id = ?, updated_at = ? WHERE id = ?')
        .run(customer_id || null, nowStr, existingBill.id);
    }

    // Return updated order with customer relation
    const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
    const customer = updatedOrder.customer_id
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(updatedOrder.customer_id)
      : null;

    cloudSync.recordOrderChanged(req.params.id, 'order.updated');
    notifyOrderUpdated();

    res.json({ order: { ...updatedOrder, customer } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/:id/convert-to-takeaway', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.type !== 'dine_in') {
      return res.status(400).json({ error: 'Only dine-in orders can be converted to takeaway' });
    }
    if (['completed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot convert a completed or cancelled order' });
    }

    const nowStr = now();
    const tableId = order.table_id;

    withTxn(() => {
      db.prepare("UPDATE orders SET type = 'takeaway', table_id = NULL, updated_at = ? WHERE id = ?")
        .run(nowStr, req.params.id);
      if (tableId) {
        db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
          .run(nowStr, tableId);
      }
    });

    const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
    const orderItems = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id).map(parseItemJson) as any[]);

    cloudSync.recordOrderChanged(req.params.id, 'order.type_changed');
    notifyKdsUpdate();
    notifyOrderUpdated();

    res.json({ order: Object.assign({}, updatedOrder, { items: orderItems, table: null }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/:id/discount', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Cannot apply discount to completed or cancelled orders
    if (['completed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot apply discount to a completed or cancelled order' });
    }

    const { discount_type, discount_value, discount_reason } = req.body;

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
        const { override_pin } = req.body;
        if (!override_pin) {
          return res.status(403).json({ error: 'Manager PIN required for discounts', requiresApproval: true });
        }
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateLimitKey = `pin:${clientIp}:discount`;
        if (!checkPinRateLimit(rateLimitKey)) {
          return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
        }
        const user = db.prepare("SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN ('owner', 'manager')")
          .all()
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

    // BUG #6 FIX: Wrap discount + tax + bill sync in a transaction
    const result = withTxn(() => {
      // Calculate discount amount
      let discountAmount = 0;
      if (discount_value > 0) {
        if (discount_type === 'percentage') {
          discountAmount = (order.subtotal * discount_value) / 100;
        } else {
          discountAmount = Math.min(discount_value, order.subtotal);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
      }

      // Always recalculate tax from item-level data (not by scaling the already-discounted
      // order.tax_amount from the DB), otherwise repeated discount updates compound the
      // reduction each time this endpoint is called.
      const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'").all(req.params.id) as any[];
      let freshTax = 0;
      let exclusiveTax = 0;
      for (const item of activeItems) {
        freshTax += item.tax_amount || 0;
        if (item.tax_type !== 'inclusive') {
          exclusiveTax += item.tax_amount || 0;
        }
      }
      let newTaxAmount = freshTax;
      let newExclusiveTax = exclusiveTax;
      if (discountAmount > 0 && order.subtotal > 0) {
        const discountedSubtotal = Math.max(0, order.subtotal - discountAmount);
        const taxRatio = discountedSubtotal / order.subtotal;
        newTaxAmount = Math.round(freshTax * taxRatio * 100) / 100;
        newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
      }

      const discountedSubtotal = Math.max(0, order.subtotal - discountAmount);
      const preRoundTotal = discountedSubtotal + newExclusiveTax + (order.packaging_charge || 0) + (order.delivery_charge || 0);
      const newTotal = Math.round(preRoundTotal);
      const roundOff = newTotal - preRoundTotal;

      db.prepare(`
        UPDATE orders SET discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
        discountAmount,
        discount_value > 0 ? discount_type : null,
        discount_value > 0 ? discount_value : null,
        discount_value > 0 ? (discount_reason || null) : null,
        newTaxAmount, newTotal, roundOff, now(), req.params.id
      );

      // Sync discount to bill if it exists and is unpaid
      const existingBill = db.prepare('SELECT * FROM bills WHERE order_id = ? AND payment_status != ?')
        .get(req.params.id, 'paid') as any;
      if (existingBill) {
        const newBillBalance = Math.max(0, newTotal - (existingBill.paid_amount || 0));
        db.prepare(`
          UPDATE bills SET discount_amount = ?, discount_type = ?, discount_value = ?,
            discount_reason = ?, tax_amount = ?, total = ?, balance = ?, round_off = ?, updated_at = ?
          WHERE id = ?
        `).run(
          discountAmount,
          discount_value > 0 ? discount_type : null,
          discount_value > 0 ? discount_value : null,
          discount_value > 0 ? (discount_reason || null) : null,
          newTaxAmount, newTotal, newBillBalance, roundOff, now(), existingBill.id
        );
      }

      const updatedOrder = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) as any;
      return updatedOrder;
    });

    notifyOrderUpdated();
    res.json({ order: result });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch('/:id/items/:itemId/discount', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
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
      const user = db.prepare("SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN ('owner', 'manager')")
        .all()
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
    const addonRows = db.prepare('SELECT price FROM order_item_addons WHERE order_item_id = ?').all(item.id) as { price: number }[];
    const addonTotal = addonRows.reduce((sum, addon) => sum + (addon.price || 0) * item.quantity, 0);
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
    const settings = db.prepare("SELECT * FROM settings WHERE key IN ('country', 'business_type', 'state_code')").all() as any[];
    const settingsMap = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));
    const tenantInfo = {
      country: settingsMap.country || 'IN',
      business_type: settingsMap.business_type || 'restaurant',
      state_code: settingsMap.state_code || '',
    };
    const taxResult = calculateItemTax(tenantInfo, product, newSubtotal, customer);
    const newTaxAmount = taxResult.tax_amount;
    const newTaxBreakdown = taxResult.tax_breakdown;

    const newTotal = newSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : newTaxAmount);

    // Update item with recalculated tax
    db.prepare(`
      UPDATE order_items SET discount_amount = ?,
        subtotal = ?, tax_amount = ?, tax_breakdown = ?, total = ?, updated_at = ? WHERE id = ?
    `).run(discountAmount, newSubtotal, newTaxAmount, JSON.stringify(newTaxBreakdown), newTotal, now(), req.params.itemId);

    // Update order totals (preserve existing order-level discount)
    const allItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id) as any[];
    let orderSubtotal = 0;
    let orderTax = 0;
    let exclusiveOrderTax = 0;
    for (const i of allItems) {
      orderSubtotal += i.subtotal;
      orderTax += i.tax_amount;
      if (i.tax_type !== 'inclusive') {
        exclusiveOrderTax += i.tax_amount;
      }
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
    if (newOrderDiscount > 0 && orderSubtotal > 0) {
      const taxRatio = discountedSubtotal / orderSubtotal;
      newOrderTax = Math.round(orderTax * taxRatio * 100) / 100;
      newExclusiveOrderTax = Math.round(exclusiveOrderTax * taxRatio * 100) / 100;
    }

    const preRoundTotal = discountedSubtotal + newExclusiveOrderTax + (order.packaging_charge || 0) + (order.delivery_charge || 0);
    const orderTotal = Math.round(preRoundTotal);
    const roundOff = orderTotal - preRoundTotal;

    db.prepare(`
      UPDATE orders SET subtotal = ?, tax_amount = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
    `).run(orderSubtotal, newOrderTax, newOrderDiscount, orderTotal, roundOff, now(), req.params.id);

    // BUG #15 FIX: Sync item-level discount to bill
    const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(req.params.id) as any;
    if (existingBill) {
      const newBillBalance = Math.max(0, orderTotal - (existingBill.paid_amount || 0));
      db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
        .run(orderTotal, newBillBalance, newOrderTax, newOrderDiscount, roundOff, now(), existingBill.id);
    }

    const updatedItem = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.itemId) as any;

    res.json({ item: updatedItem });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const orderRoutes = router;
