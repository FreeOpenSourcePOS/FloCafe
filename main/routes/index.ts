import { Express } from 'express';
import { randomBytes } from 'crypto';
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
import { customerRoutes } from './customers';
import { staffRoutes } from './staff';
import { settingsRoutes } from './settings';
import { reportRoutes } from './reports';
import { kdsRoutes } from './kds';
import { kdsInfoRoutes } from './kds-info';
import { moreAppsRoutes } from './more-apps';
import { printerRoutes } from './printers';
import { databaseRoutes } from './database';
import { databaseToolsRoutes } from './database-tools';
import { menuCsvRoutes } from './menu-csv';
import { heldOrderRoutes } from './held-orders';
import { getDatabase, now, parseItemJson, withTxn } from '../db';
import { cloudSync } from '../services/cloud-sync';

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

  // Tax preview
  app.post('/api/tax/preview', async (req, res) => {
    const { calculateTaxPreview } = await import('../services/tax');
    calculateTaxPreview(req, res);
  });

  // Mobile pairing code — cryptographically random, owner-only
  app.get('/api/mobile/pairing-code', requireRole('owner'), (req, res) => {
    const pairingCode = randomBytes(4).toString('hex'); // 8-char random code
    res.json({
      pairing_code: pairingCode,
      rotated_at: new Date().toISOString(),
    });
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
      `).all(searchTerm, searchTerm, searchTerm);

      res.json(customers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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
      const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);

      if (customer) {
        res.json({ found: true, customer });
      } else {
        res.json({ found: false, customer: null });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Soft-delete order item (frontend calls this)
  app.patch('/api/orders/:orderId/items/:itemId/cancel', (req, res) => {
    try {
      const { orderId, itemId } = req.params;

      // Verify JWT token and check role
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const jwt = require('jsonwebtoken');
      const { getJWTSecret } = require('./auth');
      const decoded = jwt.verify(authHeader.split(' ')[1], getJWTSecret()) as { role?: string };
      const userRole = decoded.role;
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
        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson);
        return { updatedOrder, items };
      });

      cloudSync.recordOrderChanged(orderId, 'order.item_cancelled');
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Cancel item error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Restore cancelled order item (frontend calls this)
  app.patch('/api/orders/:orderId/items/:itemId/restore', (req, res) => {
    try {
      const { orderId, itemId } = req.params;

      // Verify JWT token and check role
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const jwt = require('jsonwebtoken');
      const { getJWTSecret } = require('./auth');
      const decoded = jwt.verify(authHeader.split(' ')[1], getJWTSecret()) as { role?: string };
      const userRole = decoded.role;
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
        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson);
        return { updatedOrder, items };
      });

      cloudSync.recordOrderChanged(orderId, 'order.item_restored');
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Restore item error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
