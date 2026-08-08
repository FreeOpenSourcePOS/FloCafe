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
import { posInfoRoutes } from './pos-info';
import { moreAppsRoutes } from './more-apps';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { printerRoutes } from './printers';
import { databaseRoutes } from './database';
import { databaseToolsRoutes } from './database-tools';
import { menuCsvRoutes } from './menu-csv';
import { taxPackRoutes } from './tax-packs';
import { heldOrderRoutes } from './held-orders';
import { whatsappRoutes } from './whatsapp';
import { supportTicketRoutes } from './support-ticket';
import { getDatabase, now, parseItemJson, attachEffectiveAddons, withTxn, getSettingValue, getCachedPairingCode, setCachedPairingCode, verifyPin } from '../db';
import { checkPinRateLimit } from './orders';
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  getActiveCountryPack,
  invertTaxBreakdown,
  invertTaxSnapshot,
} from '../services/tax';
import { applyPayableRounding } from '../services/tax-engine';
import { cloudSync } from '../services/cloud-sync';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';
import QRCode from 'qrcode';

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
  app.use('/api/pos-info', posInfoRoutes);
  app.use('/api/more-apps', moreAppsRoutes);
  app.use('/api/printers', printerRoutes);
  app.use('/api/db', databaseRoutes);
  app.use('/api/db-tools', databaseToolsRoutes);
  app.use('/api/menu-csv', menuCsvRoutes);
  app.use('/api/tax-packs', taxPackRoutes);
  app.use('/api/held-orders', heldOrderRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/support-ticket', supportTicketRoutes);

  // Tax preview
  app.post('/api/tax/preview', async (req, res) => {
    const { calculateTaxPreview } = await import('../services/tax');
    calculateTaxPreview(req, res);
  });

  // Categories available under the store's active country pack — powers the
  // product-page category selector. Read-only; pack activation/management
  // (installing/updating a pack) is a separate, later feature.
  app.get('/api/tax/categories', requireRole('owner', 'manager'), async (req, res) => {
    try {
      const { getActiveCountryPack, hasConfiguredTaxCategories, previewCategoryRate } = await import('../services/tax');
      const country = getSettingValue('country') || 'IN';
      const businessType = getSettingValue('business_type') || 'restaurant';
      const pack = getActiveCountryPack(country);
      const configurationReady = hasConfiguredTaxCategories(pack, businessType);
      res.json({
        pack_id: pack.id,
        country: pack.country,
        // The bundled generic pack deliberately has no rules. Exposing its
        // placeholder categories as assignable would migrate a product from
        // legacy tax to a zero-tax engine path.
        categories: configurationReady
          ? pack.categories.map((category) => {
            const preview = previewCategoryRate(pack, businessType, category.id);
            return {
              id: category.id,
              label: category.label,
              rate_percent: preview?.percent ?? null,
              rate_label: preview?.label ?? null,
            };
          })
          : [],
        default_category_id: configurationReady ? pack.defaultCategories.product : null,
        configuration_ready: configurationReady,
        unclassified_category_id: pack.unclassifiedCategoryId,
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Mobile pairing code — proxies FloAdmin (see cloud-sync.ts generatePairingCode).
  // Cache-first: repeat GETs (e.g. reopening Settings) must NOT generate a new
  // code or disconnect paired devices — only a stale/missing cache calls out.
  app.get('/api/mobile/pairing-code', requireRole('owner'), async (req, res) => {
    try {
      const cached = getCachedPairingCode();
      if (cached) {
        return res.json({
          pairing_code: cached.code,
          expires_at: cached.expiresAt,
          qr_data_url: await QRCode.toDataURL(cached.code, { errorCorrectionLevel: 'M', width: 256 }),
        });
      }
      const { code, expires_at } = await cloudSync.generatePairingCode(false);
      setCachedPairingCode(code, expires_at);
      res.json({
        pairing_code: code,
        expires_at,
        qr_data_url: await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', width: 256 }),
      });
    } catch (error: any) {
      res.status(mobilePairingErrorStatus(error)).json({ error: mobilePairingErrorMessage(error) });
    }
  });

  // Explicit rotate — disconnects every currently-paired RevFlo device.
  app.post('/api/mobile/rotate-code', requireRole('owner'), async (req, res) => {
    try {
      const { code, expires_at } = await cloudSync.generatePairingCode(true);
      setCachedPairingCode(code, expires_at);
      res.json({
        pairing_code: code,
        expires_at,
        qr_data_url: await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', width: 256 }),
      });
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
      const { override_pin } = req.body;

      // requireAuth (main/server.ts) already verified the token and attached
      // the user's current DB role to req.user — use that, not the JWT claim.
      const userRole = (req as any).user?.role;
      if (!userRole) return res.status(403).json({ error: 'Authentication required' });

      const db = getDatabase();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (userRole === 'waiter' && String(order.user_id) !== String((req as any).user.userId)) {
        return res.status(403).json({ error: 'Waiters can only modify their own orders' });
      }

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
      if (!item) {
        return res.status(404).json({ error: 'Item not found in this order' });
      }

      // #150: an item the kitchen has already started on (preparing/ready)
      // can't be silently deleted like a pending one — the ingredients are
      // already consumed. Voiding it instead requires a manager PIN, mirrors
      // the whole-order-cancel override pattern below (routes/orders.ts
      // ~L580-609), and leaves a negative bill line so the removal stays
      // visible on the bill rather than the item just vanishing.
      const isInProgressVoid = ['preparing', 'ready'].includes(item.status);
      const isPrivilegedRole = ['owner', 'manager'].includes(userRole);
      const canUseOverride = ['cashier', 'waiter'].includes(userRole) && isInProgressVoid;
      if (!isPrivilegedRole && !canUseOverride) {
        return res.status(403).json({ error: 'Only owner or manager can cancel this item' });
      }
      if (isInProgressVoid) {
        if (!override_pin) {
          return res.status(400).json({ error: 'Manager PIN required to void an item already in progress' });
        }

        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateLimitKey = `pin:${clientIp}:item-void:${itemId}`;
        if (!checkPinRateLimit(rateLimitKey)) {
          return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
        }

        const managerId = req.body.manager_id || req.body.user_id;
        let pinUser: any = null;
        if (managerId) {
          const candidate = db.prepare("SELECT * FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN ('owner', 'manager') AND is_active = 1").get(managerId) as any;
          if (candidate && verifyPin(candidate.pin_hash, override_pin)) {
            pinUser = candidate;
          }
        }
        if (!pinUser) {
          const managers = db.prepare("SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN ('owner', 'manager') AND is_active = 1").all() as any[];
          for (const u of managers) {
            if (verifyPin(u.pin_hash, override_pin)) {
              pinUser = u;
              break;
            }
          }
        }
        if (!pinUser) {
          return res.status(403).json({ error: 'Invalid manager PIN' });
        }
      }

      // BUG #17 FIX: Wrap cancel + total recalc in transaction
      const result = withTxn(() => {
        if (isInProgressVoid) {
          // Leave the original line alone (it's a true record of what was
          // ordered and prepared) and add a mirrored negative line instead of
          // deleting anything — the bill total nets to the refund/comp
          // automatically via the recalc below, same as a plain cancel would,
          // but both lines stay on the bill permanently.
          db.prepare(`
            INSERT INTO order_items (
              order_id, product_id, product_name, product_sku, unit_price, quantity,
              subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total,
              variant_selection, modifier_selection, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'void_adjustment', ?, ?)
          `).run(
            orderId, item.product_id, `Void: ${item.product_name}`, item.product_sku,
            -item.unit_price, item.quantity, -item.subtotal, -(item.tax_amount || 0),
            invertTaxBreakdown(item.tax_breakdown), invertTaxSnapshot(item.tax_snapshot), item.tax_type,
            -(item.discount_amount || 0), -item.total,
            item.variant_selection, item.modifier_selection, now(), now(),
          );
          // #150 Q1-Q4 decision: mark 'voided', not 'cancelled' — a distinct,
          // terminal status. Item stage-change endpoints (routes/kds.ts,
          // routes/order-items.ts, kds-server.ts) reject any further
          // transition once status is 'voided', and inventory is
          // deliberately left alone: it was already deducted when the item
          // was added, and voiding an already-prepared item must not restock it.
          db.prepare("UPDATE order_items SET status = 'voided', voided_at = ?, updated_at = ? WHERE id = ?")
            .run(now(), now(), itemId);
        } else {
          // Soft delete - mark as cancelled
          db.prepare("UPDATE order_items SET status = 'cancelled', updated_at = ? WHERE id = ?")
            .run(now(), itemId);
        }

        // Recalculate order totals excluding cancelled items
        const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'")
          .all(orderId) as any[];
        let subtotal = 0;
        let totalTax = 0;
        let exclusiveTax = 0;
        const allTaxBreakdowns: any[] = [];
        const allTaxSnapshots: (string | null)[] = [];
        for (const i of activeItems) {
          subtotal += i.subtotal || 0;
          totalTax += i.tax_amount || 0;
          if (i.tax_type !== 'inclusive') {
            exclusiveTax += i.tax_amount || 0;
          }
          if (i.tax_breakdown) {
            try {
              const breakdown = JSON.parse(i.tax_breakdown);
              if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
            } catch { }
          }
          allTaxSnapshots.push(i.tax_snapshot || null);
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
        let taxRatio = 1;
        if (newDiscountAmount > 0 && subtotal > 0) {
          taxRatio = discountedSubtotal / subtotal;
          newTaxAmount = Math.round(totalTax * taxRatio * 100) / 100;
          newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
        }
        const tenantInfo = {
          country: getSettingValue('country') || 'IN',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const customer = order.customer_id
          ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) as any
          : null;
        const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
          ...order,
          service_charge: 0,
        }, customer);
        const taxRollup = combineItemAndChargeTaxes({
          itemTaxAmount: newTaxAmount,
          itemExclusiveTaxAmount: newExclusiveTax,
          itemBreakdowns: allTaxBreakdowns,
          itemSnapshots: allTaxSnapshots,
          itemTaxRatio: taxRatio,
          chargeTaxes,
        });

        // BUG #5 FIX: Correct round-off formula; BUG #24 FIX: include delivery_charge (was missing, causing total mismatch with bill generation)
        const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
          + (order.delivery_charge || 0) + (order.packaging_charge || 0);
        const roundOff = 0;
        const total = Number(preRoundTotal.toFixed(2));

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
            UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?,
              status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?
          `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), 'All items cancelled', now(), orderId);
          if (order.table_id) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(now(), order.table_id);
          }
        } else {
          db.prepare(`
            UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
          `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), orderId);
        }

        // Sync bill if it exists
        const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(orderId) as any;
        if (existingBill) {
          const pack = getActiveCountryPack(tenantInfo.country);
          const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(total, pack);
          const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
          db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
            .run(billTotal, newBillBalance, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, billRoundOff, now(), existingBill.id);
        }

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
        return { updatedOrder, items, orderCancelled };
      });

      cloudSync.recordOrderChanged(
        orderId,
        result.orderCancelled ? 'order.cancelled' : (isInProgressVoid ? 'order.item_voided' : 'order.item_cancelled'),
      );
      notifyKdsUpdate();
      notifyOrderUpdated();
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Cancel item error:', error);
      console.error("[API] Internal error:", error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
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
        const allTaxBreakdowns: any[] = [];
        const allTaxSnapshots: (string | null)[] = [];
        for (const i of activeItems) {
          subtotal += i.subtotal || 0;
          totalTax += i.tax_amount || 0;
          if (i.tax_type !== 'inclusive') {
            exclusiveTax += i.tax_amount || 0;
          }
          if (i.tax_breakdown) {
            try {
              const breakdown = JSON.parse(i.tax_breakdown);
              if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
            } catch { }
          }
          allTaxSnapshots.push(i.tax_snapshot || null);
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
        let taxRatio = 1;
        if (newDiscountAmount > 0 && subtotal > 0) {
          taxRatio = discountedSubtotal / subtotal;
          newTaxAmount = Math.round(totalTax * taxRatio * 100) / 100;
          newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
        }
        const tenantInfo = {
          country: getSettingValue('country') || 'IN',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const customer = order.customer_id
          ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) as any
          : null;
        const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
          ...order,
          service_charge: 0,
        }, customer);
        const taxRollup = combineItemAndChargeTaxes({
          itemTaxAmount: newTaxAmount,
          itemExclusiveTaxAmount: newExclusiveTax,
          itemBreakdowns: allTaxBreakdowns,
          itemSnapshots: allTaxSnapshots,
          itemTaxRatio: taxRatio,
          chargeTaxes,
        });

        // BUG #5 FIX: Correct round-off formula; BUG #24 FIX: include delivery_charge (was missing, causing total mismatch with bill generation)
        const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
          + (order.delivery_charge || 0) + (order.packaging_charge || 0);
        const roundOff = 0;
        const total = Number(preRoundTotal.toFixed(2));

        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), orderId);

        // Sync bill if it exists
        const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(orderId) as any;
        if (existingBill) {
          const pack = getActiveCountryPack(tenantInfo.country);
          const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(total, pack);
          const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
          db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
            .run(billTotal, newBillBalance, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, billRoundOff, now(), existingBill.id);
        }

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
        return { updatedOrder, items };
      });

      cloudSync.recordOrderChanged(orderId, 'order.item_restored');
      notifyKdsUpdate();
      notifyOrderUpdated();
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Restore item error:', error);
      console.error("[API] Internal error:", error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
    }
  });
}
