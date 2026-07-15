import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { cloudSync, DEFAULT_CLOUD_SERVER_URL, normalizeCloudServerUrl } from '../services/cloud-sync';
import { requireRole } from '../middleware/security';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function getAllSettings(db: ReturnType<typeof getDatabase>): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s: Record<string, string> = {};
  for (const row of rows) s[(row as any).key] = (row as any).value;
  return s;
}

function upsertSettings(db: ReturnType<typeof getDatabase>, entries: Record<string, any>): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, val] of Object.entries(entries)) {
    if (val !== undefined) stmt.run(key, val === null ? '' : String(val), now());
  }
}

const SENSITIVE_SETTING_KEYS = new Set([
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
]);

function maskSetting(key: string, value: string): string {
  if (!SENSITIVE_SETTING_KEYS.has(key)) return value;
  return value ? `****${value.slice(-4)}` : '';
}

function publicSettingsShape(settings: Record<string, string>): Record<string, string> {
  const publicSettings: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    publicSettings[key] = maskSetting(key, value);
  }
  return publicSettings;
}

function boolFlag(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) ? 'true' : 'false';
  }
  return value ? 'true' : 'false';
}

function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('****');
}

function businessShape(s: Record<string, string>) {
  return {
    business_name: s.business_name || '',
    timezone: s.timezone || 'Asia/Kolkata',
    currency: s.currency || 'INR',
    country: s.country || 'IN',
    language: s.language || 'en',
    gstin: s.gstin || '',
    state_code: s.state_code || '',
    business_address: s.business_address || '',
    business_phone: s.business_phone || '',
    instagram_handle: s.instagram_handle || '',
    billing_type: s.billing_type || 'postpaid',
    tables_required: s.tables_required !== 'false',
    bill_show_name: s.bill_show_name !== 'false',
    bill_show_address: s.bill_show_address !== 'false',
    bill_show_phone: s.bill_show_phone !== 'false',
    bill_show_gstn: s.bill_show_gstn === 'true',
  };
}

function taxShape(s: Record<string, string>) {
  return {
    tax_registered: s.tax_registered === 'true',
    gstin: s.gstin || '',
    state_code: s.state_code || '',
    tax_scheme: s.tax_scheme || 'regular',
    country: s.country || 'IN',
    loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
  };
}

// ── Specific routes (must come BEFORE /:key wildcard) ─────────────────────

router.get('/business', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(businessShape(s));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/business', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { business_name, timezone, currency, country, language,
      gstin, state_code, business_address, business_phone, instagram_handle,
      billing_type, tables_required,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_gstn } = req.body;

    const db = getDatabase();
    upsertSettings(db, {
      business_name, timezone, currency, country, language,
      gstin, state_code, business_address, business_phone, instagram_handle,
      billing_type, tables_required,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_gstn,
    });

    res.json(businessShape(getAllSettings(db)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tax', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(taxShape(s));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tax', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { tax_registered, gstin, state_code, tax_scheme, country } = req.body;
    const db = getDatabase();
    upsertSettings(db, { tax_registered, gstin, state_code, tax_scheme, country });
    res.json(taxShape(getAllSettings(db)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/loyalty', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/loyalty', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { loyalty_enabled } = req.body;
    const db = getDatabase();
    upsertSettings(db, { loyalty_enabled });
    const s = getAllSettings(db);
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Discount settings ──────────────────────────────────────────────────────

router.get('/discount', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      discount_max_percentage: parseFloat(s.discount_max_percentage || '25'),
      discount_max_amount: parseFloat(s.discount_max_amount || '0'),
      discount_mode: s.discount_mode || 'percentage',
      discount_requires_approval: s.discount_requires_approval === 'true' || s.discount_requires_approval === '1',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/discount', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const {
      discount_max_percentage,
      discount_max_amount,
      discount_mode,
      discount_requires_approval,
    } = req.body;

    // Validate inputs
    if (discount_max_percentage !== undefined) {
      const val = parseFloat(discount_max_percentage);
      if (isNaN(val) || val < 1 || val > 100) {
        return res.status(400).json({ error: 'discount_max_percentage must be a number between 1 and 100' });
      }
    }
    if (discount_max_amount !== undefined) {
      const val = parseFloat(discount_max_amount);
      if (isNaN(val) || val < 0 || val > 999999) {
        return res.status(400).json({ error: 'discount_max_amount must be a number between 0 and 999999' });
      }
    }
    if (discount_mode !== undefined && !['percentage', 'flat', 'both'].includes(discount_mode)) {
      return res.status(400).json({ error: 'discount_mode must be "percentage", "flat", or "both"' });
    }

    const db = getDatabase();
    upsertSettings(db, {
      discount_max_percentage,
      discount_max_amount,
      discount_mode,
      discount_requires_approval: discount_requires_approval === true || discount_requires_approval === 'true' ? 'true' : 'false',
    });
    const s = getAllSettings(db);
    res.json({
      discount_max_percentage: parseFloat(s.discount_max_percentage || '25'),
      discount_max_amount: parseFloat(s.discount_max_amount || '0'),
      discount_mode: s.discount_mode || 'percentage',
      discount_requires_approval: s.discount_requires_approval === 'true' || s.discount_requires_approval === '1',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Cloud Sync settings (must come BEFORE /:key wildcard) ──────────────────

router.get('/cloud', (req: Request, res: Response) => {
  try {
    res.json(cloudSync.getStatus());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/cloud', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const {
      cloud_server_url,
      cloud_api_key,
      cloud_store_id,
      cloud_sync_enabled,
      cloud_orders_enabled,
      cloud_reports_enabled,
      cloud_command_polling_enabled,
    } = req.body;
    const db = getDatabase();
    const updates: Record<string, string | undefined> = {
      cloud_store_id: cloud_store_id === undefined ? undefined : String(cloud_store_id || ''),
      cloud_sync_enabled: boolFlag(cloud_sync_enabled),
      cloud_orders_enabled: boolFlag(cloud_orders_enabled),
      cloud_reports_enabled: boolFlag(cloud_reports_enabled),
      cloud_command_polling_enabled: boolFlag(cloud_command_polling_enabled),
    };

    if (cloud_server_url !== undefined) {
      updates.cloud_server_url = normalizeCloudServerUrl(cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
    }
    if (cloud_api_key !== undefined && !isMaskedSecret(cloud_api_key)) {
      updates.cloud_api_key = String(cloud_api_key || '');
    }

    upsertSettings(db, updates);
    cloudSync.reload();
    res.json(cloudSync.getStatus());
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/cloud/register', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    if (req.body?.cloud_server_url !== undefined) {
      upsertSettings(getDatabase(), {
        cloud_server_url: normalizeCloudServerUrl(req.body.cloud_server_url || DEFAULT_CLOUD_SERVER_URL),
      });
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : undefined;
    const result = await cloudSync.register(email);
    res.json(result);
  } catch (error: any) {
    res.status(502).json({ error: error.message });
  }
});

router.post('/cloud/test', requireRole('owner', 'manager'), async (_req: Request, res: Response) => {
  try {
    const result = await cloudSync.testConnection();
    res.json(result);
  } catch (error: any) {
    res.status(502).json({ error: error.message });
  }
});

// ── Generic key-value routes (wildcard — must be last) ─────────────────────

// Only non-sensitive keys may be updated via the wildcard route.
// Sensitive keys (cloud_*, gstin, etc.) must use their explicit routes above.
const ALLOWED_WILDCARD_KEYS = new Set([
  'business_name', 'timezone', 'currency', 'country',
  'state_code', 'business_address', 'business_phone',
  'billing_type', 'tables_required', 'bill_show_name', 'bill_show_address',
  'bill_show_phone', 'bill_show_gstn',
  'tax_scheme',
  'loyalty_enabled',
  'printer_method', 'paper_size', 'bill_template',
]);

router.get('/', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({ settings: publicSettingsShape(s) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:key', (req: Request, res: Response) => {
  try {
    if (SENSITIVE_SETTING_KEYS.has(req.params.key)) {
      return res.status(403).json({ error: 'This setting is sensitive and cannot be read directly' });
    }
    const db = getDatabase();
    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ setting });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:key', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    if (!ALLOWED_WILDCARD_KEYS.has(req.params.key)) {
      return res.status(403).json({ error: 'This setting cannot be updated via wildcard route' });
    }
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    const db = getDatabase();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(req.params.key, value, now());

    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    res.json({ setting });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const settingsRoutes = router;
