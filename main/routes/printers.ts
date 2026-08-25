import { Router, Request, Response } from 'express';
import { getDatabase, now, attachEffectiveAddons, isKotPrintingEnabled, parseItemJson } from '../db';
import { getOrderWithItems } from './bills';
import { v4 as uuidv4 } from 'uuid';
import { printViaNetwork, printViaUSB, buildTestPage, printReceiptDetailed, printKOTDetailed, detectConnectedPrinters, prepareReceipt, escPosToText } from '../printers/thermal';
import { BILL_LANGUAGE_POLICY_KEY, KOT_LANGUAGE_POLICY_KEY, parseStoredLanguagePolicy } from '../lib/print-language-settings';
import {
  resolveKotLanguage,
  resolveReceiptLanguages,
  type KotLanguagePolicy,
  type ReceiptLanguagePolicy,
} from '../../shared/print';
import { getSupportedPrinterProfiles, resolvePrinterProfile } from '../printers/profiles';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { getCountryByCode, getCurrencySymbol } from '../countries';
import { asyncHandler } from '../middleware/async-handler';
import { getHttpRequestSignal } from '../shutdown';

const router = Router();

// Printer name must contain only safe characters (no shell metacharacters)
const PRINTER_NAME_REGEX = /^[a-zA-Z0-9 _\-\.]+$/;
const CONNECTION_TYPES = ['network', 'usb', 'webusb'] as const;
const PRINTER_COLUMN_WIDTHS = ['cols-32', 'cols-36', 'cols-40', 'cols-42', 'cols-44', 'cols-48'] as const;

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validatePrinterFields(body: any, existing?: any): string | null {
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length === 0 || !PRINTER_NAME_REGEX.test(body.name))) {
    return 'name contains invalid characters. Only letters, numbers, spaces, hyphens, underscores, and dots are allowed.';
  }
  if (body.connection_type !== undefined && !CONNECTION_TYPES.includes(body.connection_type)) {
    return 'connection_type must be network | usb | webusb';
  }
  if (body.port !== undefined && !isValidPort(body.port)) {
    return 'port must be an integer between 1 and 65535';
  }
  if (body.is_default !== undefined && typeof body.is_default !== 'boolean') {
    return 'is_default must be a boolean';
  }
  if (body.cash_drawer_pulse_enabled !== undefined && typeof body.cash_drawer_pulse_enabled !== 'boolean') {
    return 'cash_drawer_pulse_enabled must be a boolean';
  }
  if (body.paper_width !== undefined && !PRINTER_COLUMN_WIDTHS.includes(body.paper_width)) {
    return 'paper_width must be cols-32, cols-36, cols-40, cols-42, cols-44, or cols-48';
  }

  const connectionType = body.connection_type !== undefined ? body.connection_type : existing?.connection_type;
  const ipAddress = body.ip_address !== undefined ? body.ip_address : existing?.ip_address;
  if (connectionType === 'network' && (typeof ipAddress !== 'string' || ipAddress.trim().length === 0)) {
    return 'ip_address is required for network printers';
  }
  return null;
}

function ensureDefaultPrinter(db: any): void {
  const defaultPrinter = db.prepare('SELECT id FROM printers WHERE is_default = 1 LIMIT 1').get();
  if (!defaultPrinter) {
    const replacement = db.prepare('SELECT id FROM printers ORDER BY created_at, name LIMIT 1').get() as any;
    if (replacement) db.prepare('UPDATE printers SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), replacement.id);
  }
}

function printerShape(printer: any) {
  if (!printer) return printer;
  const profile = resolvePrinterProfile(printer);
  return {
    id: printer.id,
    name: printer.name,
    connection_type: printer.connection_type,
    ip_address: printer.ip_address,
    port: printer.port,
    is_default: printer.is_default,
    cash_drawer_pulse_enabled: printer.cash_drawer_pulse_enabled,
    paper_width: printer.paper_width,
    created_at: printer.created_at,
    updated_at: printer.updated_at,
    profile_id: profile.id,
    profile_name: `${profile.make} ${profile.model}`,
  };
}

// Keep receipt and KOT callers on one item hydration contract. Database rows
// may still contain legacy JSON fields, while selected add-ons now live in the
// normalized order_item_addons table.
export function getEffectiveOrderItems(db: any, orderId: string): any[] {
  return attachEffectiveAddons(
    db,
    (db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[]).map(parseItemJson),
  );
}

// GET /api/printers — list all
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printers = db.prepare('SELECT * FROM printers ORDER BY is_default DESC, name').all().map(printerShape);
    res.json({ printers });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/printers/detect — detect connected USB/network printers
router.get('/detect', asyncHandler(async (req: Request, res: Response) => {
  try {
    const printers = await detectConnectedPrinters(getHttpRequestSignal(req));
    console.log('[Printer] Detected printers:', printers);
    res.json({ printers });
  } catch (error: any) {
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[Printer] Detection error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

// GET /api/printers/supported — list known printer profiles
router.get('/supported', (_req: Request, res: Response) => {
  res.json({ printers: getSupportedPrinterProfiles() });
});

// GET /api/printers/:id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id) as any;
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json({ printer: printerShape(printer) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/printers — create
router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const { name, connection_type, ip_address, port, paper_width, is_default, cash_drawer_pulse_enabled } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (typeof name !== 'string' || !PRINTER_NAME_REGEX.test(name)) {
      return res.status(400).json({ error: 'name contains invalid characters. Only letters, numbers, spaces, hyphens, underscores, and dots are allowed.' });
    }
    if (!connection_type) return res.status(400).json({ error: 'connection_type is required' });
    if (!CONNECTION_TYPES.includes(connection_type)) {
      return res.status(400).json({ error: 'connection_type must be network | usb | webusb' });
    }
    const fieldError = validatePrinterFields(req.body);
    if (fieldError) return res.status(400).json({ error: fieldError });
    if (port !== undefined && !isValidPort(port)) {
      return res.status(400).json({ error: 'port must be an integer between 1 and 65535' });
    }
    if (is_default !== undefined && typeof is_default !== 'boolean') {
      return res.status(400).json({ error: 'is_default must be a boolean' });
    }

    const db = getDatabase();
    const id = uuidv4();

    db.transaction(() => {
      const existingPrinters = db.prepare('SELECT COUNT(*) as count FROM printers').get() as any;
      const isFirstPrinter = existingPrinters?.count === 0;
      const shouldBeDefault = Boolean(is_default) || isFirstPrinter;
      if (shouldBeDefault) db.prepare('UPDATE printers SET is_default = 0').run();
      db.prepare(`
        INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, is_default, cash_drawer_pulse_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, name, connection_type,
        ip_address ?? null,
        port ?? 9100,
        paper_width ?? 'cols-42',
        shouldBeDefault ? 1 : 0,
        cash_drawer_pulse_enabled === true ? 1 : 0,
        now(), now()
      );
      ensureDefaultPrinter(db);
    })();

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
    res.status(201).json({ printer: printerShape(printer) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/printers/:id — update
router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Printer not found' });

    const { name, connection_type, ip_address, port, paper_width, is_default, cash_drawer_pulse_enabled } = req.body;

    const fieldError = validatePrinterFields(req.body, existing);
    if (fieldError) return res.status(400).json({ error: fieldError });

    db.transaction(() => {
      const updatedConnectionType = connection_type !== undefined ? connection_type : existing.connection_type;
      const updatedIpAddress = ip_address !== undefined ? ip_address : existing.ip_address;
      const becameDefault = is_default === true;
      db.prepare(`
        UPDATE printers SET
          name = ?, connection_type = ?, ip_address = ?, port = ?,
          paper_width = ?, is_default = ?, cash_drawer_pulse_enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        name !== undefined ? name : existing.name,
        updatedConnectionType,
        updatedIpAddress === undefined ? null : updatedIpAddress,
        port !== undefined ? port : existing.port,
        paper_width !== undefined ? paper_width : existing.paper_width,
        becameDefault ? 1 : (is_default === false ? 0 : existing.is_default),
        cash_drawer_pulse_enabled !== undefined ? (cash_drawer_pulse_enabled ? 1 : 0) : existing.cash_drawer_pulse_enabled,
        now(), req.params.id
      );
      if (becameDefault) db.prepare('UPDATE printers SET is_default = 0 WHERE id != ?').run(req.params.id);
      if (is_default === false && existing.is_default) {
        const replacement = db.prepare('SELECT id FROM printers WHERE id != ? ORDER BY created_at, name LIMIT 1').get(req.params.id) as any;
        if (!replacement) throw Object.assign(new Error('At least one printer must remain default'), { statusCode: 409 });
        db.prepare('UPDATE printers SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), replacement.id);
      }
      ensureDefaultPrinter(db);
    })();

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    res.json({ printer: printerShape(printer) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/printers/:id
router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id) as any;
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    db.transaction(() => {
      const count = (db.prepare('SELECT COUNT(*) as count FROM printers').get() as any).count;
      if (printer.is_default && count === 1) {
        throw Object.assign(new Error('Cannot delete the only default printer'), { statusCode: 409 });
      }
      db.prepare('DELETE FROM printers WHERE id = ?').run(req.params.id);
      if (printer.is_default) {
        const replacement = db.prepare('SELECT id FROM printers ORDER BY created_at, name LIMIT 1').get() as any;
        if (replacement) db.prepare('UPDATE printers SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), replacement.id);
      }
    })();
    res.json({ message: 'Printer deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/printers/:id/set-default
router.post('/:id/set-default', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    db.transaction(() => {
      db.prepare('UPDATE printers SET is_default = 0').run();
      db.prepare('UPDATE printers SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    })();

    res.json({ message: 'Default printer set' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/printers/:id/test — send a test print job
router.post('/:id/test', requireRole(...ROLE_ACCESS.ownerManager), asyncHandler(async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id) as any;
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const profile = resolvePrinterProfile(printer);
    const testData = buildTestPage(printer.paper_width || profile.defaultPaperWidth, profile.cutMode, tenantLanguage(db));
    let result: { ok: boolean; detail?: string } = { ok: false };

    switch (printer.connection_type) {
      case 'network':
        if (!printer.ip_address) return res.status(400).json({ error: 'No IP address configured' });
        result = await printViaNetwork(printer.ip_address, printer.port || 9100, testData, getHttpRequestSignal(req));
        break;
      case 'usb':
        result = await printViaUSB(testData, printer.name, getHttpRequestSignal(req));
        break;
      case 'webusb':
        // WebUSB is handled entirely in the browser; return the bytes for the frontend to send
        return res.json({ success: true, webusb: true, bytes: Array.from(testData) });
    }

    if (result.ok) {
      res.json({ success: true });
    } else {
      // Surface the actual reason (offline, paper out, name mismatch, driver
      // rejection, etc.) instead of a generic message — this is the button a
      // merchant reaches for while troubleshooting, so it should say why.
      res.status(502).json({ error: result.detail || 'Printer did not respond or print failed', detail: result.detail });
    }
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

// POST /api/printers/print-bill — print bill via backend (desktop app)
router.post('/print-bill', requireRole(...ROLE_ACCESS.ownerManagerCashier), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { billId, orderId, useUnicode = false, isReprint = false, preview = false } = req.body;
    // Renderer's global "Arabic/Persian shaping" setting (#437). Only an
    // explicit boolean overrides the printer profile's declared capability.
    const arabicShapingOverride = typeof req.body?.arabicShaping === 'boolean' ? req.body.arabicShaping : undefined;
    console.log('[Print Bill] Request received', { useUnicode, isReprint, preview });
    
    if (!billId && !orderId) {
      console.log('[Print Bill] Rejected: missing bill or order reference');
      return res.status(400).json({ error: 'billId or orderId is required' });
    }

    const db = getDatabase();
    let printer = db.prepare(
      `SELECT * FROM printers
       WHERE connection_type != 'webusb'
       ORDER BY is_default DESC, name
       LIMIT 1`,
    ).get() as { id?: unknown; name?: unknown; paper_width?: unknown } | undefined;
    console.log('[Print Bill] Resolved printer:', printer ? { id: printer.id, name: printer.name } : undefined);
    
    if (!printer && preview === true) {
      printer = { id: 0, name: 'Default 80mm Preview', paper_width: '80mm' };
    }

    if (!printer) {
      console.log('[Print Bill] Error: No default printer');
      return res.status(400).json({ error: 'No default printer configured. Add a printer in Settings.' });
    }

    // Get bill and order data
    let bill: any;
    if (billId) {
      bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    } else {
      bill = db.prepare('SELECT b.* FROM bills b WHERE b.order_id = ?').get(orderId);
    }

    if (!bill) {
      console.log('[Print Bill] Error: Bill not found');
      return res.status(404).json({ error: 'Bill not found' });
    }

    const order: any = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id);
    if (!order) {
      console.log('[Print Bill] Rejected: order not found');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Fetch order items
    order.items = getOrderWithItems(db, Number(bill.order_id), Number(bill.id))?.items || [];

    // Fetch table info
    if (order.table_id) {
      const table: any = db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id);
      if (table) {
        order.table = { name: table.number };
      }
    }

    // Fetch business settings for bill template
    const settingsRows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    // Customer + loyalty context, only relevant when the bill is tied to a customer
    let customer: any = null;
    let pointsEarned = 0;
    let pointsRedeemed = 0;
    let pointsBalance: number | null = null;
    if (bill.customer_id) {
      customer = db.prepare('SELECT name, phone, country_code FROM customers WHERE id = ?').get(bill.customer_id);

      const earned = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'`
      ).get(bill.id) as { total: number };
      pointsEarned = earned.total;

      const redeemed = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE bill_id = ? AND type = 'debit'`
      ).get(bill.id) as { total: number };
      pointsRedeemed = redeemed.total;

      if (settings.loyalty_enabled === 'true') {
        const credits = db.prepare(
          `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = ? AND type = 'credit' AND (expires_at IS NULL OR expires_at > datetime('now'))`
        ).get(bill.customer_id) as { total: number };
        const debits = db.prepare(
          `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = ? AND type = 'debit'`
        ).get(bill.customer_id) as { total: number };
        pointsBalance = Math.max(0, credits.total - debits.total);
      }
    }

    const business = {
      name: settings.business_name || '',
      address: settings.business_address || '',
      phone: settings.business_phone || '',
      taxRegistrationNumber: settings.tax_registration_number || '',
      currency_symbol: getCurrencySymbol(settings.currency || 'INR', getCountryByCode(settings.country || 'IN')?.locale) || settings.currency_symbol || '₹',
      country: settings.country || 'IN',
      instagram_handle: settings.instagram_handle || '',
      customer_name: customer?.name || '',
      customer_phone: customer?.phone
        ? (customer.country_code && !customer.phone.startsWith(customer.country_code)
           ? `${customer.country_code} ${customer.phone}`
           : customer.phone)
        : '',
      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      points_balance: pointsBalance,
      trim_decimals: settings.printer_trim_decimals === 'true',
      show_name: settings.bill_show_name !== 'false',
      show_address: settings.bill_show_address !== 'false',
      show_phone: settings.bill_show_phone !== 'false',
      show_tax_id: settings.bill_show_tax_id === 'true',
      show_tax_breakdown: settings.bill_show_tax_breakdown !== 'false',
      show_customer_name: settings.bill_show_customer_name !== 'false',
      show_customer_phone: settings.bill_show_customer_phone !== 'false',
      show_table_number: settings.bill_show_table_number !== 'false',
      footer_note: settings.bill_footer_message || '',
    };
    const billTemplate = settings.bill_template;
    // Receipt label languages (#443): the tenant's `bill_language_policy`
    // (kernel B) resolves against the tenant `language` setting through the
    // shared kernel; primary first, optional additional second.
    const receiptLanguages = resolveTenantReceiptLanguages(db);
    console.log('[Print Bill] Preparing receipt', { template: billTemplate || 'classic' });

    if (preview === true) {
      // Preview and production share one code path (#443): prepareReceipt →
      // formatReceipt renders through PrintDocument for classic + compact
      // (plugin templates keep their dedicated renderer). Merchant templates
      // (#447) resolve through the same document pipeline inside
      // formatReceipt, so previews need no special-casing here.
      const prepared = prepareReceipt(order, bill, business, billTemplate || 'classic', useUnicode, isReprint, arabicShapingOverride, receiptLanguages.primary, receiptLanguages.additional);
      return res.json({
        success: true,
        preview: true,
        columns: prepared.columns,
        printer: { id: prepared.printer.id, name: prepared.printer.name },
        text: escPosToText(prepared.data),
        escpos_base64: prepared.data.toString('base64'),
        warnings: prepared.warnings,
      });
    }

    // Use existing printReceipt function with template support
    console.log('[Print Bill] Calling printReceipt...');
    const result = await printReceiptDetailed(order, bill, business, billTemplate || 'classic', useUnicode, isReprint, getHttpRequestSignal(req), arabicShapingOverride, receiptLanguages.primary, receiptLanguages.additional);
    console.log('[Print Bill] Print completed', result);

    if (result.ok) {
      res.json({ success: true, warnings: result.warnings || [] });
    } else {
      res.status(502).json({ error: 'Print failed. Check printer connection and settings.', code: result.code, correlation_id: result.correlationId, stage: result.stage });
    }
  } catch (error: any) {
    console.error('[Print Bill] Error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

// Groups order items across active, fully-configured kitchen stations (has both
// a category allowlist and a linked printer). Items whose category isn't claimed
// by any station fall back to the default printer under the generic 'Kitchen'
// label — this is also what happens for the whole order when no station is
// configured at all, so stores not using stations see no behavior change.
export function routeItemsToStations(db: any, orderItems: any[]): { stationName: string; printer: any; items: any[] }[] {
  const rawStations = db.prepare(
    `SELECT * FROM kitchen_stations WHERE is_active = 1 AND printer_id IS NOT NULL AND category_ids IS NOT NULL AND category_ids != ''`
  ).all() as any[];

  const stations = rawStations
    .map((s) => {
      let categoryIds: string[] = [];
      try {
        categoryIds = JSON.parse(s.category_ids) || [];
      } catch {
        categoryIds = [];
      }
      const printer = db.prepare(
        `SELECT * FROM printers
         WHERE id = ? AND connection_type != 'webusb'`,
      ).get(s.printer_id);
      return { ...s, categoryIds, printer };
    })
    .filter((s) => s.categoryIds.length > 0 && s.printer);

  if (stations.length === 0) {
    return [{ stationName: 'Kitchen', printer: null, items: orderItems }];
  }

  const groups = new Map<string, { stationName: string; printer: any; items: any[] }>();
  const unrouted: any[] = [];

  for (const item of orderItems) {
    const product: any = item.product_id ? db.prepare('SELECT category_id FROM products WHERE id = ?').get(item.product_id) : null;
    const categoryId = product?.category_id;
    const matched = categoryId ? stations.find((s) => s.categoryIds.includes(categoryId)) : undefined;
    if (matched) {
      if (!groups.has(matched.id)) {
        groups.set(matched.id, { stationName: matched.name, printer: matched.printer, items: [] });
      }
      groups.get(matched.id)!.items.push(item);
    } else {
      unrouted.push(item);
    }
  }

  const result = Array.from(groups.values());
  if (unrouted.length > 0) {
    result.push({ stationName: 'Kitchen', printer: null, items: unrouted });
  }
  return result;
}

// POST /api/printers/print-kot — print KOT via backend (desktop app)
router.post('/print-kot', requireRole(...ROLE_ACCESS.ownerManagerCashier), asyncHandler(async (req: Request, res: Response) => {
  // Coarser than auto_print_kot — when this is off, no KOT print command
  // should ever be sent, automatic or manual (issue #133).
  if (!isKotPrintingEnabled()) {
    return res.status(403).json({ error: 'KOT printing is disabled for this business' });
  }
  try {
    const { orderId, stationName, items, useUnicode = false } = req.body;
    // Renderer's global "Arabic/Persian shaping" setting (#437). Only an
    // explicit boolean overrides the printer profile's declared capability.
    const arabicShapingOverride = typeof req.body?.arabicShaping === 'boolean' ? req.body.arabicShaping : undefined;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const db = getDatabase();
    const printer = db.prepare(
      `SELECT * FROM printers
       WHERE connection_type != 'webusb'
       ORDER BY is_default DESC, name
       LIMIT 1`,
    ).get();

    if (!printer) {
      return res.status(400).json({ error: 'No default printer configured. Add a printer in Settings.' });
    }

    const order: any = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const kotLanguage = resolveTenantKotLanguage(db);

    // Fetch order items from database
    const orderItems: any[] = getEffectiveOrderItems(db, orderId);

    // Fetch table info if available
    if (order.table_id) {
      const table: any = db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id);
      if (table) {
        order.table = { name: table.number };
      }
    }

    // An explicit stationName/items override (not used by the current frontend,
    // but kept for any external caller) always prints a single ticket, as before.
    // Otherwise, auto-route items to their configured kitchen stations.
    let success = true;
    const warnings: NonNullable<Awaited<ReturnType<typeof printKOTDetailed>>['warnings']> = [];
    let failure: Awaited<ReturnType<typeof printKOTDetailed>> | null = null;
    if (stationName || items) {
      const kotItems = items || orderItems;
      const station = stationName || 'Kitchen';
      const result = await printKOTDetailed(order, kotItems, station, useUnicode, undefined, getHttpRequestSignal(req), arabicShapingOverride, kotLanguage);
      success = result.ok;
      failure = result.ok ? null : result;
      warnings.push(...(result.warnings || []));
    } else {
      const groups = routeItemsToStations(db, orderItems).filter((g) => g.items.length > 0);
      for (const group of groups) {
        const result = await printKOTDetailed(order, group.items, group.stationName, useUnicode, group.printer || undefined, getHttpRequestSignal(req), arabicShapingOverride, kotLanguage);
        success = success && result.ok;
        warnings.push(...(result.warnings || []));
        if (!result.ok && !failure) failure = result;
      }
    }

    if (success) {
      res.json({ success: true, warnings });
    } else {
      res.status(502).json({ error: 'KOT print failed. Check printer connection.', code: failure?.code, correlation_id: failure?.correlationId, stage: failure?.stage });
    }
  } catch (error: any) {
    console.error('[Print KOT] Error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

export const printerRoutes = router;

/**
 * Tenant-configured language for print label selection (#440). Defaults to
 * 'en' when unset; unknown values fall back to English at render time.
 */
function tenantLanguage(db: ReturnType<typeof getDatabase>): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'language'").get() as { value?: string } | undefined;
    return row?.value || 'en';
  } catch {
    return 'en';
  }
}

function tenantSettingValue(db: ReturnType<typeof getDatabase>, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

/**
 * Receipt label languages for one print request (#443). The stored
 * `bill_language_policy` is resolved through the shared kernel against the
 * tenant `language` setting; malformed stored values fall back to the
 * inherit/none default (read-side parse never breaks printing).
 */
function resolveTenantReceiptLanguages(db: ReturnType<typeof getDatabase>): { primary: string; additional?: string } {
  const policy = parseStoredLanguagePolicy(
    BILL_LANGUAGE_POLICY_KEY,
    tenantSettingValue(db, BILL_LANGUAGE_POLICY_KEY),
  ) as ReceiptLanguagePolicy;
  const languages = resolveReceiptLanguages(policy, tenantLanguage(db));
  return languages.length > 1
    ? { primary: languages[0], additional: languages[1] }
    : { primary: languages[0] };
}

/**
 * Kitchen ticket label language (#443): `kot_language_policy` resolved
 * through the kernel, independently of the receipt language policy.
 */
function resolveTenantKotLanguage(db: ReturnType<typeof getDatabase>): string {
  const policy = parseStoredLanguagePolicy(
    KOT_LANGUAGE_POLICY_KEY,
    tenantSettingValue(db, KOT_LANGUAGE_POLICY_KEY),
  ) as KotLanguagePolicy;
  return resolveKotLanguage(policy, tenantLanguage(db));
}
