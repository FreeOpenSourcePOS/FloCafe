import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { printViaNetwork, printViaUSB, buildTestPage, printReceipt, printKOT, detectConnectedPrinters } from '../printers/thermal';
import { getSupportedPrinterProfiles, resolvePrinterProfile } from '../printers/profiles';
import { requireRole } from '../middleware/security';

const router = Router();

// Printer name must contain only safe characters (no shell metacharacters)
const PRINTER_NAME_REGEX = /^[a-zA-Z0-9 _\-\.]+$/;

function printerShape(printer: any) {
  if (!printer) return printer;
  const profile = resolvePrinterProfile(printer);
  return {
    ...printer,
    profile_id: profile.id,
    profile_name: `${profile.make} ${profile.model}`,
  };
}

// GET /api/printers — list all
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printers = db.prepare('SELECT * FROM printers ORDER BY is_default DESC, name').all().map(printerShape);
    res.json({ printers });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/printers/detect — detect connected USB/network printers
router.get('/detect', async (_req: Request, res: Response) => {
  try {
    const printers = await detectConnectedPrinters();
    console.log('[Printer] Detected printers:', printers);
    res.json({ printers });
  } catch (error: any) {
    console.error('[Printer] Detection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/printers/supported — list known printer profiles
router.get('/supported', (_req: Request, res: Response) => {
  res.json({ printers: getSupportedPrinterProfiles() });
});

// GET /api/printers/:id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json({ printer: printerShape(printer) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/printers — create
router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, connection_type, ip_address, port, usb_device_path, paper_width, is_default } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!PRINTER_NAME_REGEX.test(name)) {
      return res.status(400).json({ error: 'name contains invalid characters. Only letters, numbers, spaces, hyphens, underscores, and dots are allowed.' });
    }
    if (!connection_type) return res.status(400).json({ error: 'connection_type is required' });
    if (!['network', 'usb', 'webusb'].includes(connection_type)) {
      return res.status(400).json({ error: 'connection_type must be network | usb | webusb' });
    }
    if (connection_type === 'network' && !ip_address) {
      return res.status(400).json({ error: 'ip_address is required for network printers' });
    }

    const db = getDatabase();
    const id = uuidv4();

    // Check if this is the first printer - auto-set as default
    const existingPrinters = db.prepare('SELECT COUNT(*) as count FROM printers').get() as any;
    const isFirstPrinter = existingPrinters?.count === 0;
    
    // If new printer should be default, or it's the first printer, clear existing default first
    if (is_default || isFirstPrinter) {
      db.prepare('UPDATE printers SET is_default = 0').run();
    }

    db.prepare(`
      INSERT INTO printers (id, name, connection_type, ip_address, port, usb_device_path, paper_width, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, connection_type,
      ip_address || null,
      port || 9100,
      usb_device_path || null,
      paper_width || '80mm',
      (is_default || isFirstPrinter) ? 1 : 0,
      now(), now()
    );

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
    res.status(201).json({ printer: printerShape(printer) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/printers/:id — update
router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Printer not found' });

    const { name, connection_type, ip_address, port, usb_device_path, paper_width, is_default } = req.body;

    if (name && !PRINTER_NAME_REGEX.test(name)) {
      return res.status(400).json({ error: 'name contains invalid characters. Only letters, numbers, spaces, hyphens, underscores, and dots are allowed.' });
    }

    if (is_default) {
      db.prepare('UPDATE printers SET is_default = 0').run();
    }

    db.prepare(`
      UPDATE printers SET
        name = COALESCE(?, name),
        connection_type = COALESCE(?, connection_type),
        ip_address = ?,
        port = COALESCE(?, port),
        usb_device_path = ?,
        paper_width = COALESCE(?, paper_width),
        is_default = COALESCE(?, is_default),
        updated_at = ?
      WHERE id = ?
    `).run(
      name || null,
      connection_type || null,
      ip_address !== undefined ? (ip_address || null) : existing.ip_address,
      port || null,
      usb_device_path !== undefined ? (usb_device_path || null) : existing.usb_device_path,
      paper_width || null,
      is_default !== undefined ? (is_default ? 1 : 0) : null,
      now(), req.params.id
    );

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    res.json({ printer: printerShape(printer) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/printers/:id
router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    db.prepare('DELETE FROM printers WHERE id = ?').run(req.params.id);
    res.json({ message: 'Printer deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/printers/:id/set-default
router.post('/:id/set-default', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    db.prepare('UPDATE printers SET is_default = 0').run();
    db.prepare('UPDATE printers SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), req.params.id);

    res.json({ message: 'Default printer set' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/printers/:id/test — send a test print job
router.post('/:id/test', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id) as any;
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const profile = resolvePrinterProfile(printer);
    const testData = buildTestPage(printer.paper_width || profile.defaultPaperWidth, profile.cutMode);
    let success = false;

    switch (printer.connection_type) {
      case 'network':
        if (!printer.ip_address) return res.status(400).json({ error: 'No IP address configured' });
        success = await printViaNetwork(printer.ip_address, printer.port || 9100, testData);
        break;
      case 'usb':
        success = await printViaUSB(testData, printer.name);
        break;
      case 'webusb':
        // WebUSB is handled entirely in the browser; return the bytes for the frontend to send
        return res.json({ success: true, webusb: true, bytes: Array.from(testData) });
    }

    if (success) {
      res.json({ success: true });
    } else {
      res.status(502).json({ error: 'Printer did not respond or print failed' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/printers/print-bill — print bill via backend (desktop app)
router.post('/print-bill', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { billId, orderId, useUnicode = false, isReprint = false } = req.body;
    console.log('[Print Bill] Request:', { billId, orderId, useUnicode, isReprint });
    
    if (!billId && !orderId) {
      console.log('[Print Bill] Error: No billId or orderId provided');
      return res.status(400).json({ error: 'billId or orderId is required' });
    }

    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE is_default = 1').get();
    console.log('[Print Bill] Default printer:', printer);
    
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
    console.log('[Print Bill] Bill:', bill.bill_number, 'Total:', bill.total);

    const order: any = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id);
    if (!order) {
      console.log('[Print Bill] Error: Order not found');
      return res.status(404).json({ error: 'Order not found' });
    }
    console.log('[Print Bill] Order:', order.order_number);

    // Fetch order items
    const items: any[] = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(bill.order_id);
    order.items = items;
    console.log('[Print Bill] Items count:', items.length);

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
      name: settings.business_name || 'Store',
      address: settings.business_address || '',
      phone: settings.business_phone || '',
      gstin: settings.gstin || '',
      currency_symbol: settings.currency_symbol || '₹',
      instagram_handle: settings.instagram_handle || '',
      customer_name: customer?.name || '',
      customer_phone: customer?.phone ? `${customer.country_code || '+91'} ${customer.phone}` : '',
      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      points_balance: pointsBalance,
    };
    const billTemplate = settings.bill_template;
    console.log('[Print Bill] Business:', business.name, 'Template:', billTemplate || 'classic');

    // Use existing printReceipt function with template support
    console.log('[Print Bill] Calling printReceipt...');
    const success = await printReceipt(order, bill, business, billTemplate || 'classic', useUnicode, isReprint);
    console.log('[Print Bill] Print result:', success);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(502).json({ error: 'Print failed. Check printer connection and settings.' });
    }
  } catch (error: any) {
    console.error('[Print Bill] Error:', error);
    console.error('[Print Bill] Error stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/printers/print-kot — print KOT via backend (desktop app)
router.post('/print-kot', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { orderId, stationName, items, useUnicode = false } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE is_default = 1').get();
    
    if (!printer) {
      return res.status(400).json({ error: 'No default printer configured. Add a printer in Settings.' });
    }

    const order: any = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Fetch order items from database
    const orderItems: any[] = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    
    // Fetch table info if available
    let tableName: string | undefined;
    if (order.table_id) {
      const table: any = db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id);
      if (table) {
        order.table = { name: table.number };
      }
    }

    // Use existing printKOT function
    const kotItems = items || orderItems;
    const station = stationName || 'Kitchen';
    const success = await printKOT(order, kotItems, station, useUnicode);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(502).json({ error: 'KOT print failed. Check printer connection.' });
    }
  } catch (error: any) {
    console.error('[Print KOT] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export const printerRoutes = router;
