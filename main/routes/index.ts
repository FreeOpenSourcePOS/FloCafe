import { Express } from 'express';
import { authRoutes } from './auth';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import { categoryRoutes } from './categories';
import { productRoutes } from './products';
import { addonGroupRoutes } from './addon-groups';
import { orderRoutes } from './orders';
import { orderItemRoutes } from './order-items';
import { billRoutes, syncUnpaidBillsForOrder } from './bills';
import { tableRoutes } from './tables';
import { kitchenStationRoutes } from './kitchen-stations';
import { kitchenRoutes } from './kitchen';
import { customerRoutes, parseCustomer, getWalletBalance } from './customers';
import { staffRoutes } from './staff';
import { settingsRoutes } from './settings';
import { paymentMethodRoutes } from './payment-methods';
import { reportRoutes } from './reports';
import { kdsRoutes } from './kds';
import { kdsInfoRoutes } from './kds-info';
import { posInfoRoutes } from './pos-info';
import { serverAppInfoRoutes } from './server-app-info';
import { moreAppsRoutes } from './more-apps';
import { notifyKdsUpdate } from '../services/kds';
import { printerRoutes } from './printers';
import { databaseRoutes } from './database';
import { databaseToolsRoutes } from './database-tools';
import { menuCsvRoutes } from './menu-csv';
import { taxPackRoutes } from './tax-packs';
import { heldOrderRoutes } from './held-orders';
import { printTemplateRoutes } from './print-templates';
import { whatsappRoutes } from './whatsapp';
import { supportTicketRoutes } from './support-ticket';
import { getDatabase, now, parseItemJson, attachEffectiveAddons, withTxn, getSettingValue, getCachedPairingCode, setCachedPairingCode, verifyPin } from '../db';
import { checkPinRateLimit } from './orders';

const OWNER_MANAGER_ROLE_PLACEHOLDERS = ROLE_ACCESS.ownerManager.map(() => '?').join(', ');
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  getActiveCountryPack,
  invertTaxBreakdown,
  invertTaxSnapshot,
} from '../services/tax';
import { cloudSync } from '../services/cloud-sync';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';
import QRCode from 'qrcode';
import { asyncHandler } from '../middleware/async-handler';
import expressRateLimit from 'express-rate-limit';

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

const inlineCustomerLookupRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const inlineOrderWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

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
  app.use('/api/payment-methods', paymentMethodRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/kds', kdsRoutes);
  app.use('/api/kds-info', kdsInfoRoutes);
  app.use('/api/pos-info', posInfoRoutes);
  app.use('/api/server-app-info', serverAppInfoRoutes);
  app.use('/api/more-apps', moreAppsRoutes);
  app.use('/api/printers', printerRoutes);
  app.use('/api/db', databaseRoutes);
  app.use('/api/db-tools', databaseToolsRoutes);
  app.use('/api/menu-csv', menuCsvRoutes);
  app.use('/api/tax-packs', taxPackRoutes);
  app.use('/api/held-orders', heldOrderRoutes);
  app.use('/api/print-templates', printTemplateRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/support-ticket', supportTicketRoutes);

  // Tax preview
  app.post('/api/tax/preview', asyncHandler(async (req, res) => {
    const { calculateTaxPreview } = await import('../services/tax');
    calculateTaxPreview(req, res);
  }));

  // Categories available under the store's active country pack — powers the
  // product-page category selector. Read-only; pack activation/management
  // (installing/updating a pack) is a separate, later feature.
  app.get('/api/tax/categories', requireRole(...ROLE_ACCESS.ownerManager), asyncHandler(async (req, res) => {
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
  }));

  // Mobile pairing code — proxies FloAdmin (see cloud-sync.ts generatePairingCode).
  // Cache-first: repeat GETs (e.g. reopening Settings) must NOT generate a new
  // code or disconnect paired devices — only a stale/missing cache calls out.
  app.get('/api/mobile/pairing-code', requireRole(...ROLE_ACCESS.owner), asyncHandler(async (req, res) => {
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
  }));

  // Explicit rotate — disconnects every currently-paired RevFlo device.
  app.post('/api/mobile/rotate-code', requireRole(...ROLE_ACCESS.owner), asyncHandler(async (req, res) => {
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
  }));

  // Paired RevFlo devices for this store — Settings > Mobile App session list.
  app.get('/api/mobile/devices', requireRole(...ROLE_ACCESS.owner), asyncHandler(async (req, res) => {
    try {
      const devices = await cloudSync.listPairedDevices();
      res.json({ devices });
    } catch (error: any) {
      console.error('[API] FloAdmin request failed:', error);
      res.status(502).json({ error: 'Could not reach FloAdmin' });
    }
  }));

  // Legacy/flat customer search endpoint (frontend uses this)
  app.get('/api/customers-search', inlineCustomerLookupRateLimit, requireRole(...ROLE_ACCESS.sales), (req, res) => {
    try {
      const { q } = req.query;
      const rawSearch = String(q || '').trim();
      if (rawSearch.length < 2) {
        return res.json([]);
      }

      const db = getDatabase();
      const digitsSearch = stripPhoneDigits(rawSearch);
      const isPhoneLikeSearch = digitsSearch.length > 0 && !/\p{L}/u.test(rawSearch);
      const searchTerm = `%${rawSearch}%`;
      const phoneDigitsSearch = `REPLACE(phone_digits, '/', '')`;
      const query = isPhoneLikeSearch
        ? `
        SELECT * FROM customers
        WHERE is_active = 1 AND (${phoneDigitsSearch} LIKE ? OR name LIKE ? OR email LIKE ?)
        ORDER BY name LIMIT 20
      `
        : `
        SELECT * FROM customers
        WHERE is_active = 1 AND (name LIKE ? OR email LIKE ?)
        ORDER BY name LIMIT 20
      `;
      const params = isPhoneLikeSearch
        ? [`%${digitsSearch}%`, searchTerm, searchTerm]
        : [searchTerm, searchTerm];

      const customers = db.prepare(query).all(...params) as any[];

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
  app.get('/api/crm/lookup', inlineCustomerLookupRateLimit, requireRole(...ROLE_ACCESS.sales), (req, res) => {
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

  // Cancel or void an order item (frontend calls this)
  app.patch('/api/orders/:orderId/items/:itemId/cancel', inlineOrderWriteRateLimit, (req, res) => {
    try {
      const orderId = String(req.params.orderId);
      const itemId = String(req.params.itemId);
      const { override_pin } = req.body;

      // requireAuth (main/server.ts) already verified the token and attached
      // the user's current DB role to req.user — use that, not the JWT claim.
      const actorId = String((req as any).user?.userId || '');
      if (!actorId) return res.status(403).json({ error: 'Authentication required' });

      const db = getDatabase();
      // Keep these lookups only for the inexpensive not-found response. Every
      // authorization, policy, and mutation decision is repeated from the
      // transaction-local rows below so a concurrent writer cannot authorize
      // against this pre-transaction snapshot.
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
        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const currentItem = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
        if (!currentItem || !currentOrder) {
          throw Object.assign(new Error('Item or order not found'), { statusCode: 404 });
        }
        const actor = db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(actorId) as { role: string } | undefined;
        if (!actor) {
          throw Object.assign(new Error('Authentication required'), { statusCode: 403 });
        }
        const userRole = actor.role;
        if (userRole === 'server' && String(currentOrder.user_id) !== actorId) {
          throw Object.assign(new Error('Servers can only modify their own orders'), { statusCode: 403 });
        }

        // A repeated request against an already terminal item is an
        // intentional idempotent no-op. Check it before the parent terminal
        // policy so a retry cannot turn a harmless repeat into a new error.
        if (['cancelled', 'voided', 'void_adjustment'].includes(currentItem.status)) {
          if (!hasRole(userRole, ROLE_ACCESS.ownerManager)) {
            throw Object.assign(new Error('Only owner or manager can cancel this item'), { statusCode: 403 });
          }
          const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
          return {
            updatedOrder: currentOrder,
            items,
            orderCancelled: currentOrder.status === 'cancelled',
            eventType: null,
          };
        }

        if (db.prepare(`
          SELECT 1
          FROM bills
          WHERE order_id = ?
            AND (
              COALESCE(payment_status, 'unpaid') <> 'unpaid'
              OR COALESCE(paid_amount, 0) > 0
              OR (payment_details IS NOT NULL AND TRIM(payment_details) NOT IN ('', '[]', '{}', 'null'))
            )
          LIMIT 1
        `).get(orderId)) {
          throw Object.assign(new Error('Cannot cancel items on a paid or partially paid order'), { statusCode: 409 });
        }

        // Completed and cancelled orders are terminal. This guard must run
        // before any item, stock, order, table, or bill mutation.
        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(new Error('Cannot cancel items on completed or cancelled orders'), { statusCode: 400 });
        }

        // #150: an item the kitchen has already started on (preparing/ready)
        // can't be silently deleted like a pending one — the ingredients are
        // already consumed. Voiding it instead requires a manager PIN, mirrors
        // the whole-order-cancel override pattern, and leaves a negative bill
        // line so the removal stays visible on the bill.
        const isItemVoid = ['preparing', 'ready'].includes(currentItem.status);
        const isPrivilegedRole = hasRole(userRole, ROLE_ACCESS.ownerManager);
        const canUseOverride = hasRole(userRole, ROLE_ACCESS.cashierServer) && isItemVoid;
        if (!isPrivilegedRole && !canUseOverride) {
          throw Object.assign(new Error('Only owner or manager can cancel this item'), { statusCode: 403 });
        }
        if (isItemVoid) {
          if (!override_pin) {
            throw Object.assign(new Error('Manager PIN required to void an item already in progress'), { statusCode: 400 });
          }

          const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
          // Key is per-client/per-action, deliberately NOT per-item: a caller
          // must not get a fresh attempt window by rotating item identifiers
          // (GHSA-9jjq-2fmw-x3mw).
          const rateLimitKey = `pin:${clientIp}:item-void`;
          if (!checkPinRateLimit(rateLimitKey)) {
            throw Object.assign(new Error('Too many PIN attempts. Try again in 15 minutes.'), { statusCode: 429 });
          }

          const managerId = req.body.manager_id || req.body.user_id;
          let pinUser: any = null;
          if (managerId) {
            const candidate = db.prepare(`SELECT * FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS}) AND is_active = 1`).get(managerId, ...ROLE_ACCESS.ownerManager) as any;
            if (candidate && verifyPin(candidate.pin_hash, override_pin)) {
              pinUser = candidate;
            }
          }
          if (!pinUser) {
            const managers = db.prepare(`SELECT * FROM users WHERE pin_hash IS NOT NULL AND role IN (${OWNER_MANAGER_ROLE_PLACEHOLDERS}) AND is_active = 1`).all(...ROLE_ACCESS.ownerManager) as any[];
            for (const u of managers) {
              if (verifyPin(u.pin_hash, override_pin)) {
                pinUser = u;
                break;
              }
            }
          }
          if (!pinUser) {
            throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
          }
        }

        if (isItemVoid) {
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
            orderId, currentItem.product_id, `Void: ${currentItem.product_name}`, currentItem.product_sku,
            -currentItem.unit_price, currentItem.quantity, -currentItem.subtotal, -(currentItem.tax_amount || 0),
            invertTaxBreakdown(currentItem.tax_breakdown), invertTaxSnapshot(currentItem.tax_snapshot), currentItem.tax_type,
            -(currentItem.discount_amount || 0), -currentItem.total,
            currentItem.variant_selection, currentItem.modifier_selection, now(), now(),
          );
          // #150 Q1-Q4 decision: mark 'voided', not 'cancelled' — a distinct,
          // terminal status. Item stage-change endpoints reject any further
          // transition once status is 'voided', and inventory is
          // deliberately left alone: it was already deducted when the item
          // was added, and voiding an already-prepared item must not restock it.
          db.prepare("UPDATE order_items SET status = 'voided', voided_at = ?, updated_at = ? WHERE id = ?")
            .run(now(), now(), itemId);
        } else {
          // Cancel the item and restore the inventory quantity recorded when it was added.
          db.prepare("UPDATE order_items SET status = 'cancelled', updated_at = ? WHERE id = ?")
            .run(now(), itemId);

          const product = db.prepare('SELECT * FROM products WHERE id = ?').get(currentItem.product_id) as any;
          if (product && currentItem.inventory_deducted_quantity > 0) {
            db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ?')
              .run(currentItem.inventory_deducted_quantity, now(), product.id);
          }
        }

        // Recalculate order totals excluding cancelled, voided, and void_adjustment items
        const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment')")
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
        const tenantInfo = {
          country: getSettingValue('country') || 'IN',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const customer = currentOrder.customer_id
          ? db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any
          : null;
        const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
          ...currentOrder,
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
          + (currentOrder.delivery_charge || 0) + (currentOrder.packaging_charge || 0);
        const roundOff = 0;
        const total = Number(preRoundTotal.toFixed(2));

        // #132 FIX: cancelling the last active item leaves nothing to serve or
        // bill — treat it as the whole order being cancelled, the same way the
        // explicit order-level cancel (routes/orders.ts) does: free the table,
        // and stamp cancelled_at/cancellation_reason. (Item stock was already restored above).
        const orderCancelled = activeItems.length === 0 && currentOrder.status !== 'cancelled';

        if (orderCancelled) {
          db.prepare(`
            UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?,
              status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?
          `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), 'All items cancelled', now(), orderId);
          if (currentOrder.table_id) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?")
              .run(now(), currentOrder.table_id);
          }
        } else {
          db.prepare(`
            UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
          `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), orderId);
        }

        syncUnpaidBillsForOrder(db, orderId, {
          subtotal,
          taxAmount: taxRollup.taxAmount,
          taxBreakdown: JSON.stringify(taxRollup.breakdowns),
          taxSnapshot: taxRollup.snapshotJson,
          discountAmount: newDiscountAmount,
          deliveryCharge: order.delivery_charge || 0,
          packagingCharge: order.packaging_charge || 0,
          total,
        }, tenantInfo.country);

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
        return {
          updatedOrder,
          items,
          orderCancelled,
          eventType: orderCancelled ? 'order.cancelled' : (isItemVoid ? 'order.item_voided' : 'order.item_cancelled'),
        };
      });

      if (result.eventType) {
        cloudSync.recordOrderChanged(orderId, result.eventType);
        notifyKdsUpdate();
      }
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
      const actorId = String((req as any).user?.userId || '');
      if (!actorId) return res.status(403).json({ error: 'Authentication required' });

      const db = getDatabase();
      // Keep these lookups only for the inexpensive not-found response. The
      // transaction repeats all mutable state and policy checks authoritatively.
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
      if (!item) {
        return res.status(404).json({ error: 'Item not found in this order' });
      }

      // BUG #17 FIX: Wrap restore + total recalc in transaction
      const result = withTxn(() => {
        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const currentItem = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId) as any;
        if (!currentItem || !currentOrder) {
          throw Object.assign(new Error('Item or order not found'), { statusCode: 404 });
        }
        const actor = db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(actorId) as { role: string } | undefined;
        if (!actor || !hasRole(actor.role, ROLE_ACCESS.ownerManager)) {
          throw Object.assign(new Error('Only owner or manager can restore items'), { statusCode: 403 });
        }

        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(new Error('Cannot restore items on completed or cancelled orders'), { statusCode: 400 });
        }
        if (db.prepare("SELECT id FROM bills WHERE order_id = ? AND payment_status = 'paid'").get(orderId)) {
          throw Object.assign(new Error('Cannot restore items on a paid order'), { statusCode: 400 });
        }

        // Only cancelled items can be restored; ignore if already active or voided
        if (currentItem.status !== 'cancelled') {
          const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
          return { updatedOrder: currentOrder, items, changed: false };
        }

        // Re-deduct the inventory quantity originally consumed by the item
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(currentItem.product_id) as any;
        if (product && currentItem.inventory_deducted_quantity > 0) {
          if (product.stock_quantity < currentItem.inventory_deducted_quantity) {
            throw Object.assign(new Error(`Insufficient stock to restore item (Available: ${product.stock_quantity}, Required: ${currentItem.inventory_deducted_quantity})`), { statusCode: 400 });
          }
          db.prepare('UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = ? WHERE id = ?')
            .run(currentItem.inventory_deducted_quantity, now(), product.id);
        }

        // Restore - mark as pending
        db.prepare("UPDATE order_items SET status = 'pending', updated_at = ? WHERE id = ?")
          .run(now(), itemId);

        // Recalculate order totals
        const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment')")
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
        const tenantInfo = {
          country: getSettingValue('country') || 'IN',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const customer = currentOrder.customer_id
          ? db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any
          : null;
        const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
          ...currentOrder,
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
          + (currentOrder.delivery_charge || 0) + (currentOrder.packaging_charge || 0);
        const roundOff = 0;
        const total = Number(preRoundTotal.toFixed(2));

        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), orderId);

        syncUnpaidBillsForOrder(db, orderId, {
          subtotal,
          taxAmount: taxRollup.taxAmount,
          taxBreakdown: JSON.stringify(taxRollup.breakdowns),
          taxSnapshot: taxRollup.snapshotJson,
          discountAmount: newDiscountAmount,
          deliveryCharge: order.delivery_charge || 0,
          packagingCharge: order.packaging_charge || 0,
          total,
        }, tenantInfo.country);

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[]);
        return { updatedOrder, items, changed: true };
      });

      if (result.changed) {
        cloudSync.recordOrderChanged(orderId, 'order.item_restored');
        notifyKdsUpdate();
      }
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Restore item error:', error);
      console.error("[API] Internal error:", error);
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
    }
  });
}
