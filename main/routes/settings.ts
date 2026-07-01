import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';

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
    if (val !== undefined) stmt.run(key, String(val), now());
  }
}

function businessShape(s: Record<string, string>) {
  return {
    business_name: s.business_name || '',
    timezone: s.timezone || 'Asia/Kolkata',
    currency: s.currency || 'INR',
    country: s.country || 'IN',
    gstin: s.gstin || '',
    state_code: s.state_code || '',
    business_address: s.business_address || '',
    business_phone: s.business_phone || '',
    billing_type: s.billing_type || 'postpaid',
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
    loyalty_enabled: s.loyalty_enabled === 'true',
    loyalty_expiry_days: parseInt(s.loyalty_expiry_days || '365'),
    loyalty_points_per_rs: parseFloat(s.loyalty_points_per_rs || '1'),
    loyalty_redeem_value: parseFloat(s.loyalty_redeem_value || '0.25'),
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

router.put('/business', (req: Request, res: Response) => {
  try {
    const { business_name, timezone, currency, country, gstin, state_code,
      business_address, business_phone, billing_type,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_gstn } = req.body;

    const db = getDatabase();
    upsertSettings(db, {
      business_name, timezone, currency, country, gstin, state_code,
      business_address, business_phone, billing_type,
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

router.put('/tax', (req: Request, res: Response) => {
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
      loyalty_enabled: s.loyalty_enabled === 'true',
      loyalty_expiry_days: parseInt(s.loyalty_expiry_days || '365'),
      loyalty_points_per_rs: parseFloat(s.loyalty_points_per_rs || '1'),
      loyalty_redeem_value: parseFloat(s.loyalty_redeem_value || '0.25'),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/loyalty', (req: Request, res: Response) => {
  try {
    const { loyalty_enabled, loyalty_expiry_days, loyalty_points_per_rs, loyalty_redeem_value } = req.body;
    const db = getDatabase();
    upsertSettings(db, { loyalty_enabled, loyalty_expiry_days, loyalty_points_per_rs, loyalty_redeem_value });
    const s = getAllSettings(db);
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true',
      loyalty_expiry_days: parseInt(s.loyalty_expiry_days || '365'),
      loyalty_points_per_rs: parseFloat(s.loyalty_points_per_rs || '1'),
      loyalty_redeem_value: parseFloat(s.loyalty_redeem_value || '0.25'),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── Generic key-value routes ───────────────────────────────────────────────

const SENSITIVE_KEYS = ['cloud_api_key', 'jwt_secret', 'pin', 'password', 'token', 'secret', 'key'];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.some(sensitive => key.toLowerCase().includes(sensitive));
}

router.get('/', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());

    // Remove sensitive keys from the dump
    for (const key of Object.keys(s)) {
      if (isSensitiveKey(key)) {
        delete s[key];
      }
    }

    res.json({ settings: s });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:key', (req: Request, res: Response) => {
  try {
    const key = req.params.key;

    if (isSensitiveKey(key)) {
      return res.status(403).json({ error: 'Access denied to sensitive setting' });
    }

    const db = getDatabase();
    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ setting });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:key', (req: Request, res: Response) => {
  try {
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

// ─── Cloud Sync settings ────────────────────────────────────────────────────

router.get('/cloud', (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      cloud_api_key: s.cloud_api_key || null,
      cloud_store_id: s.cloud_store_id || null,
      cloud_sync_enabled: s.cloud_sync_enabled === '1',
      cloud_orders_enabled: s.cloud_orders_enabled === '1',
      cloud_last_sync: s.cloud_last_sync || null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/cloud', (req: Request, res: Response) => {
  try {
    const { cloud_api_key, cloud_store_id, cloud_sync_enabled, cloud_orders_enabled } = req.body;
    const db = getDatabase();
    upsertSettings(db, {
      cloud_api_key: cloud_api_key || null,
      cloud_store_id: cloud_store_id || null,
      cloud_sync_enabled: cloud_sync_enabled ? '1' : '0',
      cloud_orders_enabled: cloud_orders_enabled ? '1' : '0',
    });
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const settingsRoutes = router;
