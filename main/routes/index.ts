import { Express } from 'express';
import { authRoutes } from './auth';
import { requireRole } from '../middleware/security';
import { categoryRoutes } from './categories';
import { productRoutes } from './products';
import { addonGroupRoutes } from './addon-groups';
import { orderRoutes } from './orders';
import { orderItemRoutes } from './order-items';
import { billRoutes } from './bills';
import { tableRoutes } from './tables';
import { kitchenStationRoutes } from './kitchen-stations';
import { kitchenRoutes } from './kitchen';
import { customerRoutes, parseCustomer, getWalletBalance } from './customers';
import { staffRoutes } from './staff';
import { settingsRoutes } from './settings';
import { reportRoutes } from './reports';
import { kdsRoutes } from './kds';
import { kdsInfoRoutes } from './kds-info';
import { moreAppsRoutes } from './more-apps';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { printerRoutes } from './printers';
import { databaseRoutes } from './database';
import { databaseToolsRoutes } from './database-tools';
import { menuCsvRoutes } from './menu-csv';
import { heldOrderRoutes } from './held-orders';
import { whatsappRoutes } from './whatsapp';
import { getDatabase, now, parseItemJson, attachEffectiveAddons, withTxn, getSettingValue, getCachedPairingCode, setCachedPairingCode } from '../db';
import { cloudSync } from '../services/cloud-sync';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';

// "Cloud POS is not registered" (thrown synchronously by cloud-sync.ts's
// signedFetch, no network call even attempted) means this store was never
// claimed in FloAdmin — a distinct, actionable state from a genuine
// connectivity failure reaching FloAdmin, and the two need different status
// codes/messages so the frontend (and anyone reading server logs) doesn't
// mistake "not claimed yet" for "FloAdmin is down".
function isUnregisteredCloudError(error: any): boolean {
  return typeof error?.message === 'string' && error.message.includes('is not registered');
}

function mobilePairingErrorStatus(error: any): number {
  return isUnregisteredCloudError(error) ? 409 : 502;
}

function mobilePairingErrorMessage(error: any): string {
  if (isUnregisteredCloudError(error)) {
    return 'This POS hasn’t been claimed in FloAdmin yet. Complete registration in FloAdmin, then try generating a pairing code again.';
  }
  return error?.message || 'Could not reach FloAdmin';
}

export function registerRoutes(app: Express): void {
  // Auth routes
  app.use('/api/auth', authRoutes);

  // Resource routes
  app.use('/api/categories', categoryRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/addon-groups', addonGroupRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/order-items', orderItemRoutes);
  app.use('/api/kitchen', kitchenRoutes);
  app.use('/api/bills', billRoutes);
  app.use('/api/tables', tableRoutes);
  app.use('/api/kitchen-stations', kitchenStationRoutes);
  app.use('/api/customers', customerRoutes);
  app.use('/api/staff', staffRoutes);   // users with POS roles
  app.use('/api/users', staffRoutes);   // same router, dual-mounted
  app.use('/api/settings', settingsRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/kds', kdsRoutes);
  app.use('/api/kds-info', kdsInfoRoutes);
  app.use('/api/more-apps', moreAppsRoutes);
  app.use('/api/printers', printerRoutes);
  app.use('/api/db', databaseRoutes);
  app.use('/api/db-tools', databaseToolsRoutes);
  app.use('/api/menu-csv', menuCsvRoutes);
  app.use('/api/held-orders', heldOrderRoutes);
  app.use('/api/whatsapp', whatsappRoutes);

  // Tax preview
  app.post('/api/tax/preview', async (req, res) => {
    const { calculateTaxPreview } = await import('../services/tax');
    calculateTaxPreview(req, res);
  });

  // Mobile pairing code — proxies FloAdmin (see cloud-sync.ts generatePairingCode).
  // Cache-first: repeat GETs (e.g. reopening Settings) must NOT generate a new
  // code or disconnect paired devices — only a stale/missing cache calls out.
  app.get('/api/mobile/pairing-code', requireRole('owner'), async (req, res) => {
    try {
      const cached = getCachedPairingCode();
      if (cached) {
        return res.json({ pairing_code: cached.code, expires_at: cached.expiresAt });
      }
      const { code, expires_at } = await cloudSync.generatePairingCode(false);
      setCachedPairingCode(code, expires_at);
      res.json({ pairing_code: code, expires_at });
    } catch (error: any) {
      res.status(mobilePairingErrorStatus(error)).json({ error: mobilePairingErrorMessage(error) });
    }
  });

  // Explicit rotate — disconnects every currently-paired RevFlo device.
  app.post('/api/mobile/rotate-code', requireRole('owner'), async (req, res) => {
    try {
      const { code, expires_at } = await cloudSync.generatePairingCode(true);
      setCachedPairingCode(code, expires_at);
      res.json({ pairing_code: code, expires_at });
    } catch (error: any) {
      res.status(mobilePairingErrorStatus(error)).json({ error: mobilePairingErrorMessage(error) });
    }
  });

  // Paired RevFlo devices for this store — Settings > Mobile App session list.
  app.get('/api/mobile/devices', requireRole('owner'), async (req, res) => {
    try {
      const devices = await cloudSync.listPairedDevices();
      res.json({ devices });
    } catch (error: any) {
      console.error('[API] FloAdmin request failed:', error);
      res.status(502).json({ error: 'Could not reach FloAdmin' });
    }
  });

  // Legacy/flat customer search endpoint (frontend uses this)
  app.get('/api/customers-search', requireRole('owner', 'manager', 'cashier', 'waiter'), (req, res) => {
    try {
      const { q } = req.query;
      if (!q || String(q).length < 2) {
        return res.json([]);
      }

      const db = getDatabase();
      const searchTerm = `%${q}%`;

      const customers = db.prepare(`
        SELECT * FROM customers
        WHERE is_active = 1 AND (phone_digits LIKE ? OR name LIKE ? OR email LIKE ?)
        ORDER BY name LIMIT 20
      `).all(searchTerm, searchTerm, searchTerm) as any[];

      const results = customers.map((c) => ({
        ...parseCustomer(c),
        wallet_balance: getWalletBalance(c.id),
      }));

      res.json(results);
    } catch (error: any) {
      console.error("[API] Internal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // CRM lookup endpoint (frontend uses this)
  app.get('/api/crm/lookup', requireRole('owner', 'manager', 'cashier', 'waiter'), (req, res) => {
    try {
      const { phone, country_code } = req.query;
      if (!phone) {
        return res.status(400).json({ error: 'Phone number required' });
      }

      const db = getDatabase();
      const tenantCountry = getSettingValue('country') || 'IN';
      const parsed = parsePhoneE164(String(phone).trim(), tenantCountry);
      const lookupPhone = parsed ? parsed.e164 : String(phone).trim();
      const phoneDigits = stripPhoneDigits(lookupPhone);

      const customer = db.prepare('SELECT * FROM customers WHERE phone_digits = ?').get(phoneDigits);

      if (customer) {
        res.json({ found: true, customer });
      } else {
        res.json({ found: false, customer: null });
      }
    } catch (error: any) {
      console.error("[API] Internal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Soft-delete order item (frontend calls this)
  app.patch('/api/orders/:orderId/items/:itemId/cancel', (req, res) => {
    try {
      const { orderId, itemId } = req.params;

      // requireAuth (main/server.ts) already verified the token and attached
      // the user's current DB role to req.user — use that, not the JWT claim.
      const userRole = (req as any).user?.role;
      if (!userRole || !['owner', 'manager'].includes(userRole)) {
        return res.status(403).json({ error: 'Only owner or manager can cancel items' });
      }

      const db = getDatabase();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
      if (!item) {
        return res.status(404).json({ error: 'Item not found in this order' });
      }

      // BUG #17 FIX: Wrap cancel + total recalc in transaction
      const result = withTxn(() => {
        // Soft delete - mark as cancelled
        db.prepare("UPDATE order_items SET status = 'cancelled', updated_at = ? WHERE id = ?")
          .run(now(), itemId);

        // Recalculate order totals excluding cancelled items
        const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'")
          .all(orderId) as any[];
        let subtotal = 0;
        let totalTax = 0;
        let exclusiveTax = 0;
        for (const i of activeItems) {
          subtotal += i.subtotal || 0;
          totalTax += i.tax_amount || 0;
          if (i.tax_type !== 'inclusive') {
            exclusiveTax += i.tax_amount || 0;
          }
        }

        // BUG #13 FIX: Preserve order-level discount (scale percentage proportionally)
        const existingDiscountAmount = order.discount_amount || 0;
        let newDiscountAmount = existingDiscountAmount;
        if (existingDiscountAmount > 0 && order.subtotal > 0) {
          if (order.discount_type === 'percentage') {
            const pct = order.discount_value || 0;
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

        // BUG #5 FIX: Correct round-off formula; BUG #24 FIX: include delivery_charge (was missing, causing total mismatch with bill generation)
        const preRoundTotal = discountedSubtotal + newExclusiveTax + (order.delivery_charge || 0) + (order.packaging_charge || 0);
        const roundOff = Math.round(preRoundTotal) - preRoundTotal;
        const total = Math.round(preRoundTotal);

        // #132 FIX: cancelling the last active item leaves nothing to serve or
        // bill — treat it as the whole order being cancelled, the same way the
        // explicit order-level cancel (routes/orders.ts) does: free the table,
        // restore tracked inventory, and stamp cancelled_at/cancellation_reason.
        // Without this the order silently stayed "active" with zero items,
        // cluttering the Active list and permanently holding its table.
        const orderCancelled = activeItems.length === 0 && order.status !== 'cancelled';

        if (orderCancelled) {
          const allItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[];
          for (const i of allItems) {
            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(i.product_id) as any;
            if (product?.track_inventory) {
              db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ?')
                .run(i.quantity, now(), product.id);
            }
          }
          db.prepare(`
            UPDATE orders SET subtotal = ?, tax_amount = ?, discount_amount = ?, total = ?, round_off = ?,
              status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?
          `).run(subtotal, newTaxAmount, newDiscountAmount, total, roundOff, now(), 'All items cancelled', now(), orderId);
          if (order.table_id) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(now(), order.table_id);
          }
        } else {
          db.prepare(`
            UPDATE orders SET subtotal = ?, tax_amount = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
          `).run(subtotal, newTaxAmount, newDiscountAmount, total, roundOff, now(), orderId);
        }

        // Sync bill if it exists
        const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(orderId) as any;
        if (existingBill) {
          const newBillBalance = Math.max(0, total - (existingBill.paid_amount || 0));
          db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
            .run(total, newBillBalance, newTaxAmount, newDiscountAmount, roundOff, now(), existingBill.id);
        }

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
        return { updatedOrder, items, orderCancelled };
      });

      cloudSync.recordOrderChanged(orderId, result.orderCancelled ? 'order.cancelled' : 'order.item_cancelled');
      if (result.orderCancelled) {
        notifyKdsUpdate();
        notifyOrderUpdated();
      }
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Cancel item error:', error);
      console.error("[API] Internal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Restore cancelled order item (frontend calls this)
  app.patch('/api/orders/:orderId/items/:itemId/restore', (req, res) => {
    try {
      const { orderId, itemId } = req.params;

      // requireAuth (main/server.ts) already verified the token and attached
      // the user's current DB role to req.user — use that, not the JWT claim.
      const userRole = (req as any).user?.role;
      if (!userRole || !['owner', 'manager'].includes(userRole)) {
        return res.status(403).json({ error: 'Only owner or manager can restore items' });
      }

      const db = getDatabase();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
      if (!item) {
        return res.status(404).json({ error: 'Item not found in this order' });
      }

      if (['completed', 'cancelled'].includes(order.status)) {
        return res.status(400).json({ error: 'Cannot restore items on completed or cancelled orders' });
      }
      const paidBill = db.prepare("SELECT id FROM bills WHERE order_id = ? AND payment_status = 'paid'").get(orderId);
      if (paidBill) {
        return res.status(400).json({ error: 'Cannot restore items on a paid order' });
      }

      // BUG #17 FIX: Wrap restore + total recalc in transaction
      const result = withTxn(() => {
        // Restore - mark as pending
        db.prepare("UPDATE order_items SET status = 'pending', updated_at = ? WHERE id = ?")
          .run(now(), itemId);

        // Recalculate order totals
        const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'")
          .all(orderId) as any[];
        let subtotal = 0;
        let totalTax = 0;
        let exclusiveTax = 0;
        for (const i of activeItems) {
          subtotal += i.subtotal || 0;
          totalTax += i.tax_amount || 0;
          if (i.tax_type !== 'inclusive') {
            exclusiveTax += i.tax_amount || 0;
          }
        }

        // BUG #13 FIX: Preserve order-level discount (scale percentage proportionally)
        const existingDiscountAmount = order.discount_amount || 0;
        let newDiscountAmount = existingDiscountAmount;
        if (existingDiscountAmount > 0 && order.subtotal > 0) {
          if (order.discount_type === 'percentage') {
            const pct = order.discount_value || 0;
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

        // BUG #5 FIX: Correct round-off formula; BUG #24 FIX: include delivery_charge (was missing, causing total mismatch with bill generation)
        const preRoundTotal = discountedSubtotal + newExclusiveTax + (order.delivery_charge || 0) + (order.packaging_charge || 0);
        const roundOff = Math.round(preRoundTotal) - preRoundTotal;
        const total = Math.round(preRoundTotal);

        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, newTaxAmount, newDiscountAmount, total, roundOff, now(), orderId);

        // Sync bill if it exists
        const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(orderId) as any;
        if (existingBill) {
          const newBillBalance = Math.max(0, total - (existingBill.paid_amount || 0));
          db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
            .run(total, newBillBalance, newTaxAmount, newDiscountAmount, roundOff, now(), existingBill.id);
        }

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
        return { updatedOrder, items };
      });

      cloudSync.recordOrderChanged(orderId, 'order.item_restored');
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Restore item error:', error);
      console.error("[API] Internal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
