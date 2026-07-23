import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { cloudSync, DEFAULT_CLOUD_SERVER_URL, normalizeCloudServerUrl } from '../services/cloud-sync';
import { googleDrive } from '../services/google-drive';
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
    tax_registered: s.tax_registered === 'true' || s.tax_registered === '1',
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
  };
}

// ── Specific routes (must come BEFORE /:key wildcard) ─────────────────────

router.get('/business', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(businessShape(s));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/business', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { business_name, timezone, currency, country, language,
      gstin, state_code, business_address, business_phone, instagram_handle,
      billing_type, tables_required, tax_registered,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_gstn } = req.body;

    const db = getDatabase();
    upsertSettings(db, {
      business_name, timezone, currency, country, language,
      gstin, state_code, business_address, business_phone, instagram_handle,
      billing_type, tables_required, tax_registered,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_gstn,
    });

    res.json(businessShape(getAllSettings(db)));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/tax', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(taxShape(s));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/tax', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { tax_registered, gstin, state_code, tax_scheme, country } = req.body;
    const db = getDatabase();
    upsertSettings(db, { tax_registered, gstin, state_code, tax_scheme, country });
    res.json(taxShape(getAllSettings(db)));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/loyalty', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
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
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Discount settings ──────────────────────────────────────────────────────

router.get('/discount', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      discount_max_percentage: parseFloat(s.discount_max_percentage || '25'),
      discount_max_amount: parseFloat(s.discount_max_amount || '0'),
      discount_mode: s.discount_mode || 'percentage',
      discount_requires_approval: s.discount_requires_approval === 'true' || s.discount_requires_approval === '1',
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
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
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── KDS settings (must come BEFORE /:key wildcard) ─────────────────────────

// The public `/api/kds/info` already exposes `kds_default_view`, but it lives
// on the KDS server (different origin) and isn't reachable from the
// dashboard's settings page. This is the dashboard-side mirror — read-only
// from the client's perspective; the PUT below is the only mutator.
router.get('/kds', (_req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      kds_default_view: s.kds_default_view === 'kanban' ? 'kanban' : 'tabs',
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/kds', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { kds_default_view } = req.body;
    if (kds_default_view !== undefined && !['tabs', 'kanban'].includes(kds_default_view)) {
      return res.status(400).json({ error: 'kds_default_view must be "tabs" or "kanban"' });
    }
    if (kds_default_view !== undefined) {
      upsertSettings(getDatabase(), { kds_default_view });
    }
    const s = getAllSettings(getDatabase());
    res.json({
      kds_default_view: s.kds_default_view === 'kanban' ? 'kanban' : 'tabs',
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Cloud Sync settings (must come BEFORE /:key wildcard) ──────────────────

router.get('/cloud', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    res.json(cloudSync.getStatus());
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
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
    console.error('[API] Cloud settings update failed:', error);
    res.status(400).json({ error: 'Invalid cloud settings' });
  }
});

router.post('/cloud/register', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    if (req.body?.cloud_server_url !== undefined) {
      upsertSettings(getDatabase(), {
        cloud_server_url: normalizeCloudServerUrl(req.body.cloud_server_url || DEFAULT_CLOUD_SERVER_URL),
      });
    }
    // Registration never sends an owner email to FloAdmin — the "email the
    // API key" promise this used to support isn't implemented on the
    // FloAdmin side (documented gap in specs/floadmin.md § POST /api/pos/
    // register), and owners never actually log into FloAdmin anyway, so
    // there's no reason to collect or transmit it here.
    const result = await cloudSync.register();
    res.json(result);
  } catch (error: any) {
    console.error('[API] Cloud registration failed:', error);
    res.status(502).json({ error: 'Cloud registration failed' });
  }
});

router.post('/cloud/test', requireRole('owner', 'manager'), async (_req: Request, res: Response) => {
  try {
    const result = await cloudSync.testConnection();
    res.json(result);
  } catch (error: any) {
    console.error('[API] Cloud test failed:', error);
    res.status(502).json({ error: 'Cloud test failed' });
  }
});

// ─── Google Drive backups (must come BEFORE /:key wildcard) ─────────────────
// See #129. Off by default — connect/disconnect/backup-now are the only
// actions that ever touch Google's API, and only owner can trigger them
// (mirrors how database.ts gates the raw backup/restore actions).

router.get('/google-drive', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    res.json(googleDrive.getStatus());
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/google-drive', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { frequency, retention_count } = req.body;
    res.json(googleDrive.updatePreferences({ frequency, retention_count }));
  } catch (error: any) {
    console.error('[API] Google Drive preferences update failed:', error);
    res.status(400).json({ error: 'Invalid Google Drive preferences' });
  }
});

router.post('/google-drive/connect', requireRole('owner'), async (_req: Request, res: Response) => {
  try {
    const status = await googleDrive.connect();
    res.json(status);
  } catch (error: any) {
    console.error('[API] Google Drive connection failed:', error);
    res.status(502).json({ error: 'Google Drive connection failed' });
  }
});

router.post('/google-drive/disconnect', requireRole('owner'), async (_req: Request, res: Response) => {
  try {
    const status = await googleDrive.disconnect();
    res.json(status);
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/google-drive/backup-now', requireRole('owner'), async (_req: Request, res: Response) => {
  try {
    const status = await googleDrive.backupNow();
    res.json(status);
  } catch (error: any) {
    console.error('[API] Google Drive backup failed:', error);
    res.status(502).json({ error: 'Google Drive backup failed' });
  }
});

// ── Generic key-value routes (wildcard — must be last) ─────────────────────

// Only non-sensitive keys may be updated via the wildcard route.
// Sensitive keys (cloud_*, gstin, etc.) must use their explicit routes above.
const ALLOWED_WILDCARD_KEYS = new Set([
  'business_name', 'timezone', 'currency', 'country',
  'state_code', 'business_address', 'business_phone',
  'billing_type', 'tables_required', 'tax_registered', 'bill_show_name', 'bill_show_address',
  'bill_show_phone', 'bill_show_gstn',
  'tax_scheme',
  'loyalty_enabled',
  'language',
  'kds_default_view',
  'printer_method', 'paper_size', 'bill_template',
  'telemetry_enabled',
  'kds_enabled', 'kot_printing_enabled',
]);

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({ settings: publicSettingsShape(s) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:key', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (req: Request, res: Response) => {
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
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
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

    // KDS turning off → invalidate any outstanding pairing tokens. Without
    // this, a token minted while KDS was on would still let a device pair
    // in after it's been switched off (issue #133).
    if (req.params.key === 'kds_enabled') {
      const wasEnabled = getAllSettings(db).kds_enabled !== 'false';
      const turningOff = boolFlag(value) === 'false';
      if (wasEnabled && turningOff) {
        db.prepare('DELETE FROM kds_pairing_tokens').run();
      }
    }

    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(req.params.key, value, now());

    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    res.json({ setting });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const settingsRoutes = router;
