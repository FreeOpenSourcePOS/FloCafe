import { Express } from 'express';
import { authRoutes } from './auth';
import { requireAnyPermission, requirePermission } from '../services/authorization';
import { categoryRoutes } from './categories';
import { productRoutes } from './products';
import { addonGroupRoutes } from './addon-groups';
import { orderRoutes } from './orders';
import { orderItemRoutes } from './order-items';
import { billRoutes } from './bills';
import { refundRoutes } from './refunds';
import { cashClosureRoutes } from './cash-closures';
import { cashSessionRoutes } from './cash-sessions';
import { inventoryRoutes } from './inventory';
import { supplyRoutes } from './supplies';
import { recipeRoutes } from './recipes';
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
import { printerRoutes } from './printers';
import { databaseRoutes } from './database';
import { databaseToolsRoutes } from './database-tools';
import { menuCsvRoutes } from './menu-csv';
import { taxPackRoutes } from './tax-packs';
import { heldOrderRoutes } from './held-orders';
import { printTemplateRoutes } from './print-templates';
import { whatsappRoutes } from './whatsapp';
import { supportTicketRoutes } from './support-ticket';
import { diagnosticsRoutes } from './diagnostics';
import { authorizationRoutes } from './authorization';
import { getDatabase, getSettingValue, getCachedPairingCode, setCachedPairingCode } from '../db';

import { getActiveCountryPack } from '../services/tax';
import { cloudSync } from '../services/cloud-sync';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';
import QRCode from 'qrcode';
import { asyncHandler } from '../middleware/async-handler';
import expressRateLimit from 'express-rate-limit';

// Distinguish unregistered store error from cloud connectivity failure.
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
  app.use('/api/refunds', refundRoutes);
  app.use('/api/cash-closures', cashClosureRoutes);
  app.use('/api/cash-sessions', cashSessionRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/supplies', supplyRoutes);
  app.use('/api/recipes', recipeRoutes);
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
  app.use('/api/diagnostics', diagnosticsRoutes);
  app.use('/api/authorization', authorizationRoutes);

  // Tax preview. Priced on every cart change in the prepaid checkout modal, so it
  // has to admit every role that can run a sale; `tax-packs.view-test` (owner and
  // manager) would 403 a cashier mid-checkout, and a 403 makes the API client
  // refresh the whole auth context. Any one of the three sale-facing permissions
  // resolves to the same role set the ungated endpoint had before this migration.
  app.post('/api/tax/preview', requireAnyPermission('pos.use', 'orders.create', 'kitchen.use'), asyncHandler(async (req, res) => {
    const { calculateTaxPreview } = await import('../services/tax');
    calculateTaxPreview(req, res);
  }));

  // Returns active tax categories for product configuration.
  app.get('/api/tax/categories', requirePermission('tax-packs.view-test'), asyncHandler(async (req, res) => {
    try {
      const { getActiveCountryPack, hasConfiguredTaxCategories, previewCategoryRate } = await import('../services/tax');
      const country = getSettingValue('country') || '';
      const businessType = getSettingValue('business_type') || 'restaurant';
      const pack = getActiveCountryPack(country);
      const configurationReady = hasConfiguredTaxCategories(pack, businessType);
      res.json({
        pack_id: pack.id,
        country: pack.country,
        // Categories available only when configuration is ready.
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

  // Returns cached mobile pairing code or generates fresh code if missing or expired.
  app.get('/api/mobile/pairing-code', requirePermission('mobile-access.manage'), asyncHandler(async (req, res) => {
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
  app.post('/api/mobile/rotate-code', requirePermission('mobile-access.manage'), asyncHandler(async (req, res) => {
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
  app.get('/api/mobile/devices', requirePermission('mobile-access.manage'), asyncHandler(async (req, res) => {
    try {
      const devices = await cloudSync.listPairedDevices();
      res.json({ devices });
    } catch (error: any) {
      console.error('[API] FloAdmin request failed:', error);
      res.status(502).json({ error: 'Could not reach FloAdmin' });
    }
  }));

  // Legacy/flat customer search endpoint (frontend uses this)
  app.get('/api/customers-search', inlineCustomerLookupRateLimit, requirePermission('customers.view'), (req, res) => {
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
  app.get('/api/crm/lookup', inlineCustomerLookupRateLimit, requirePermission('customers.view'), (req, res) => {
    try {
      const { phone, country_code } = req.query;
      if (!phone) {
        return res.status(400).json({ error: 'Phone number required' });
      }

      const db = getDatabase();
      const tenantCountry = getSettingValue('country') || '';
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
}
