import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now } from '../db';
import { cloudSync, DEFAULT_CLOUD_SERVER_URL, normalizeCloudServerUrl } from '../services/cloud-sync';
import { googleDrive } from '../services/google-drive';
import { requireRole } from '../middleware/security';
import { requireMasterPin } from '../middleware/master-pin';
import { resolveTaxIdFormat, validateTaxRegistrationNumber } from '../services/tax';
import { sendEvent } from '../services/telemetry';
import { getCountryByCode, getCurrencySymbol, isValidTimeZone, type CountryLocaleOptions } from '../countries';
import { getHttpRequestSignal, trackHttpRequestWork } from '../shutdown';
import { asyncHandler } from '../middleware/async-handler';
import { normalizeOptionalPhone } from '../lib/phone';
import { CORE_BILL_TEMPLATES, isAvailableBillTemplate, listInstalledPrintTemplates } from '../services/print-templates';
import {
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  LANGUAGE_POLICY_SETTING_KEYS,
  defaultLanguagePolicySettingJson,
  validateLanguagePolicySetting,
} from '../lib/print-language-settings';

const router = Router();
const settingsReadRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const configuredSettingsWriteLimit = Number.parseInt(process.env.FLO_SETTINGS_WRITE_RATE_LIMIT_MAX || '', 10);
const settingsWriteRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: Number.isFinite(configuredSettingsWriteLimit) && configuredSettingsWriteLimit > 0
    ? configuredSettingsWriteLimit
    : 60,
  standardHeaders: true,
  legacyHeaders: false,
});

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
  db.transaction(() => {
    for (const [key, val] of Object.entries(entries)) {
      if (val !== undefined) stmt.run(key, val === null ? '' : String(val), now());
    }
  })();
}

function validBusinessLocation(timezone: unknown, currency: unknown, country: unknown): boolean {
  if (timezone !== undefined && !isValidTimeZone(timezone)) return false;
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) return false;
  if (country !== undefined && (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))) return false;
  return true;
}

const SENSITIVE_SETTING_KEYS = new Set([
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
  'cloud_deletion_status_token',
  'cloud_last_error',
]);

const OPTIONAL_SETTING_DEFAULTS: Record<string, string> = {
  bill_template: 'classic',
  bill_footer_message: '',
  printer_trim_decimals: 'false',
  split_checks_enabled: 'false',
  // Print language policies (#441) — inherit store language, no second
  // language. Defaults preserve pre-policy behavior for existing tenants.
  [BILL_LANGUAGE_POLICY_KEY]: defaultLanguagePolicySettingJson(),
  [KOT_LANGUAGE_POLICY_KEY]: defaultLanguagePolicySettingJson(),
  // Iran locale display preferences (Batch G, Refs #241) — display-only.
  currency_display: 'rial',
  number_digits: 'locale',
  calendar: 'locale',
};

function maskSetting(key: string, value: string): string {
  if (key === 'cloud_last_error') return value ? 'Cloud service request failed' : '';
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

// Country-scoped locale display preferences (#390). A region without declared
// localeOptions supports only the neutral default for each group: canonical
// currency unit (rial), locale digits, and locale calendar.
const NEUTRAL_LOCALE_PREFERENCES = {
  currency_display: 'rial',
  number_digits: 'locale',
  calendar: 'locale',
} as const;

type LocalePreferenceKey = keyof typeof NEUTRAL_LOCALE_PREFERENCES;

const LOCALE_OPTION_FIELDS: Record<LocalePreferenceKey, keyof CountryLocaleOptions> = {
  currency_display: 'currencyDisplay',
  number_digits: 'digits',
  calendar: 'calendar',
};

function isLocalePreferenceKey(key: string): key is LocalePreferenceKey {
  return key === 'currency_display' || key === 'number_digits' || key === 'calendar';
}

function isLocalePreferenceSupported(key: LocalePreferenceKey, value: string, countryCode: string): boolean {
  if (value === NEUTRAL_LOCALE_PREFERENCES[key]) return true;
  const options = getCountryByCode(countryCode)?.localeOptions?.[LOCALE_OPTION_FIELDS[key]];
  return Array.isArray(options) && (options as readonly string[]).includes(value);
}

function resolveStoredLocalePreference(key: LocalePreferenceKey, stored: string | undefined, countryCode: string): string {
  if (stored && isLocalePreferenceSupported(key, stored, countryCode)) return stored;
  return NEUTRAL_LOCALE_PREFERENCES[key];
}

// cloud_sync_enabled/cloud_orders_enabled/cloud_reports_enabled/cloud_command_polling_enabled
// mirror FloAdmin's own `stores` table and are read elsewhere (cloud-sync.ts) as a strict
// '1' check, not boolFlag()'s 'true'/'false' — keep this route's writes on that convention.
function bool01Flag(value: unknown): string | undefined {
  const flag = boolFlag(value);
  return flag === undefined ? undefined : flag === 'true' ? '1' : '0';
}

function deriveCurrencySymbol(currency: string, country: string): string {
  return getCurrencySymbol(currency || 'INR', getCountryByCode(country || 'IN')?.locale) || currency || 'INR';
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
    tax_registration_number: s.tax_registration_number || '',
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
    bill_show_tax_id: s.bill_show_tax_id === 'true',
    bill_show_tax_breakdown: s.bill_show_tax_breakdown !== 'false',
    bill_show_customer_name: s.bill_show_customer_name !== 'false',
    bill_show_customer_phone: s.bill_show_customer_phone !== 'false',
    bill_show_table_number: s.bill_show_table_number !== 'false',
    currency_display: resolveStoredLocalePreference('currency_display', s.currency_display, s.country || 'IN'),
    number_digits: resolveStoredLocalePreference('number_digits', s.number_digits, s.country || 'IN'),
    calendar: resolveStoredLocalePreference('calendar', s.calendar, s.country || 'IN'),
    // Informational only — the active country pack's format if it declares
    // one, else the static main/countries.ts fallback, else null. Never
    // blocks the save; the UI uses this to show a non-blocking warning.
    tax_id_format: resolveTaxIdFormat(s.country || 'IN'),
  };
}

function taxShape(s: Record<string, string>) {
  return {
    tax_registered: s.tax_registered === 'true',
    tax_registration_number: s.tax_registration_number || '',
    state_code: s.state_code || '',
    tax_scheme: s.tax_scheme || 'regular',
    country: s.country || 'IN',
    tax_id_format: resolveTaxIdFormat(s.country || 'IN'),
  };
}

// ── Specific routes (must come BEFORE /:key wildcard) ─────────────────────

router.get('/business', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
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
      tax_registration_number, state_code, business_address, business_phone, instagram_handle,
      billing_type, tables_required, tax_registered,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_tax_id,
      bill_show_tax_breakdown, bill_show_customer_name, bill_show_customer_phone, bill_show_table_number,
      currency_display, number_digits, calendar } = req.body;

    if (!validBusinessLocation(timezone, currency, country)) {
      return res.status(400).json({ error: 'Invalid timezone, currency, or country' });
    }

    const db = getDatabase();
    const currentSettings = getAllSettings(db);
    const effectiveCountry = country || currentSettings.country || 'IN';
    const effectiveCurrency = currency || currentSettings.currency || 'INR';

    // Validate explicitly supplied locale preferences against the effective
    // country's declared options, and normalize stale legacy values (e.g. a
    // Toman/Persian preference left behind by an IR -> US transition).
    const localeUpdates: Record<string, string> = {};
    for (const { key, submitted } of [
      { key: 'currency_display', submitted: currency_display },
      { key: 'number_digits', submitted: number_digits },
      { key: 'calendar', submitted: calendar },
    ] as Array<{ key: LocalePreferenceKey; submitted: unknown }>) {
      if (submitted !== undefined) {
        if (typeof submitted !== 'string' || !isLocalePreferenceSupported(key, submitted, effectiveCountry)) {
          return res.status(400).json({ error: `Invalid ${key} for country ${effectiveCountry}` });
        }
        localeUpdates[key] = submitted;
      } else {
        localeUpdates[key] = resolveStoredLocalePreference(key, currentSettings[key], effectiveCountry);
      }
    }

    if (tax_registration_number) {
      const { valid, format } = validateTaxRegistrationNumber(effectiveCountry, tax_registration_number);
      if (!valid && format) {
        return res.status(400).json({
          error: `Tax ID does not match the expected ${effectiveCountry} format: ${format.description}`,
          tax_id_format: format,
        });
      }
    }

    let normalizedPhone: string | undefined = undefined;
    if (business_phone !== undefined) {
      const phoneRes = normalizeOptionalPhone(business_phone, effectiveCountry);
      if (!phoneRes.valid) {
        return res.status(400).json({ error: phoneRes.error || 'Invalid business phone number' });
      }
      normalizedPhone = phoneRes.e164 || '';
    }

    upsertSettings(db, {
      business_name, timezone, currency, country, language,
      currency_symbol: (currency !== undefined || country !== undefined)
        ? deriveCurrencySymbol(effectiveCurrency, effectiveCountry)
        : undefined,
      tax_registration_number, state_code, business_address,
      business_phone: normalizedPhone !== undefined ? normalizedPhone : undefined,
      instagram_handle,
      billing_type, tables_required, tax_registered,
      bill_show_name, bill_show_address, bill_show_phone, bill_show_tax_id,
      bill_show_tax_breakdown, bill_show_customer_name, bill_show_customer_phone, bill_show_table_number,
      ...localeUpdates,
    });
    cloudSync.refreshRegistrationProfile();

    res.json(businessShape(getAllSettings(db)));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/tax', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
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
    const { tax_registered, tax_registration_number, state_code, tax_scheme, country } = req.body;

    if (!validBusinessLocation(undefined, undefined, country)) {
      return res.status(400).json({ error: 'Invalid country' });
    }

    const db = getDatabase();
    const currentSettings = getAllSettings(db);
    const effectiveCountry = country || currentSettings.country || 'IN';
    if (tax_registration_number) {
      const { valid, format } = validateTaxRegistrationNumber(effectiveCountry, tax_registration_number);
      if (!valid && format) {
        return res.status(400).json({
          error: `Tax ID does not match the expected ${effectiveCountry} format: ${format.description}`,
          tax_id_format: format,
        });
      }
    }
    upsertSettings(db, {
      tax_registered,
      tax_registration_number,
      state_code,
      tax_scheme,
      country,
      currency_symbol: country !== undefined
        ? deriveCurrencySymbol(currentSettings.currency || 'INR', country || currentSettings.country || 'IN')
        : undefined,
    });
    cloudSync.refreshRegistrationProfile();
    res.json(taxShape(getAllSettings(db)));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/loyalty', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
      global_cashback_percent: parseFloat(s.global_cashback_percent || '0'),
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/loyalty', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { loyalty_enabled, global_cashback_percent } = req.body;

    let finalGlobalCb: number | undefined = undefined;
    if (global_cashback_percent !== undefined) {
      if (typeof global_cashback_percent !== 'number' || !Number.isFinite(global_cashback_percent) || global_cashback_percent < 0 || global_cashback_percent > 100) {
        return res.status(400).json({ error: 'Global cashback percent must be a number between 0 and 100' });
      }
      finalGlobalCb = global_cashback_percent;
    }

    const db = getDatabase();
    upsertSettings(db, {
      loyalty_enabled,
      ...(finalGlobalCb !== undefined && { global_cashback_percent: String(finalGlobalCb) })
    });
    const s = getAllSettings(db);
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
      global_cashback_percent: parseFloat(s.global_cashback_percent || '0'),
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Discount settings ──────────────────────────────────────────────────────

router.get('/discount', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
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

// ─── Order numbering settings (must come BEFORE /:key wildcard) ─────────────

function orderNumberingShape(s: Record<string, string>) {
  return {
    order_number_prefix: s.order_number_prefix ?? 'ORD',
    order_number_include_date: s.order_number_include_date !== 'false',
    order_number_reset_daily: s.order_number_reset_daily !== 'false',
    invoice_number_prefix: s.invoice_number_prefix ?? 'INV',
    invoice_number_include_period: s.invoice_number_include_period !== 'false',
    invoice_number_reset_period: ['never', 'daily', 'monthly', 'financial_year'].includes(s.invoice_number_reset_period)
      ? s.invoice_number_reset_period
      : 'daily',
    invoice_financial_year_start_month: parseBoundedInt(s.invoice_financial_year_start_month, 1, 12, 4),
    invoice_financial_year_start_day: parseBoundedInt(s.invoice_financial_year_start_day, 1, 31, 1),
  };
}

const ORDER_NUMBER_PREFIX_PATTERN = /^[A-Za-z0-9_-]{0,12}$/;
const INVOICE_RESET_PERIODS = new Set(['never', 'daily', 'monthly', 'financial_year']);

function parseBoundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

router.get('/order-numbering', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(orderNumberingShape(s));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/order-numbering', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const {
      order_number_prefix,
      order_number_include_date,
      order_number_reset_daily,
      invoice_number_prefix,
      invoice_number_include_period,
      invoice_number_reset_period,
      invoice_financial_year_start_month,
      invoice_financial_year_start_day,
    } = req.body;

    if (order_number_prefix !== undefined && !ORDER_NUMBER_PREFIX_PATTERN.test(order_number_prefix)) {
      return res.status(400).json({ error: 'order_number_prefix must be up to 12 characters (letters, numbers, - or _)' });
    }
    if (invoice_number_prefix !== undefined && !ORDER_NUMBER_PREFIX_PATTERN.test(invoice_number_prefix)) {
      return res.status(400).json({ error: 'invoice_number_prefix must be up to 12 characters (letters, numbers, - or _)' });
    }
    if (invoice_number_reset_period !== undefined && !INVOICE_RESET_PERIODS.has(invoice_number_reset_period)) {
      return res.status(400).json({ error: 'invoice_number_reset_period must be one of never, daily, monthly, financial_year' });
    }
    if (invoice_financial_year_start_month !== undefined && parseBoundedInt(invoice_financial_year_start_month, 1, 12, NaN) !== Number(invoice_financial_year_start_month)) {
      return res.status(400).json({ error: 'invoice_financial_year_start_month must be a whole number between 1 and 12' });
    }
    if (invoice_financial_year_start_day !== undefined && parseBoundedInt(invoice_financial_year_start_day, 1, 31, NaN) !== Number(invoice_financial_year_start_day)) {
      return res.status(400).json({ error: 'invoice_financial_year_start_day must be a whole number between 1 and 31' });
    }

    const db = getDatabase();
    upsertSettings(db, {
      order_number_prefix,
      order_number_include_date: boolFlag(order_number_include_date),
      order_number_reset_daily: boolFlag(order_number_reset_daily),
      invoice_number_prefix,
      invoice_number_include_period: boolFlag(invoice_number_include_period),
      invoice_number_reset_period,
      invoice_financial_year_start_month,
      invoice_financial_year_start_day,
    });
    res.json(orderNumberingShape(getAllSettings(db)));
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

function publicDeletionRequest(request: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!request) return null;
  const safe: Record<string, unknown> = {};
  const requestId = request.request_id ?? request.id;
  if (typeof requestId === 'string' && requestId) safe.id = requestId;
  if (typeof request.status === 'string') safe.status = request.status;
  if (typeof request.requested_at === 'string') safe.requested_at = request.requested_at;
  if (typeof request.reviewed_at === 'string' || request.reviewed_at === null) safe.reviewed_at = request.reviewed_at;
  if (typeof request.decision_note === 'string') safe.decision_note = request.decision_note;
  return safe;
}

function publicEmailPreferences(data: Record<string, unknown>): Record<string, unknown> {
  return {
    email: typeof data.email === 'string' ? data.email : null,
    verified: data.verified === true,
    verified_at: typeof data.verified_at === 'string' || data.verified_at === null ? data.verified_at : null,
    verification_sent_at: typeof data.verification_sent_at === 'string' || data.verification_sent_at === null ? data.verification_sent_at : null,
    product_updates: data.product_updates === true,
    marketing: data.marketing === true,
  };
}

const CLOUD_ACCOUNT_UNAVAILABLE_ERROR = 'Cloud account services are unavailable while Cloud services are stopped or unregistered';

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
      cloud_sync_enabled: bool01Flag(cloud_sync_enabled),
      cloud_orders_enabled: bool01Flag(cloud_orders_enabled),
      cloud_reports_enabled: bool01Flag(cloud_reports_enabled),
      cloud_command_polling_enabled: bool01Flag(cloud_command_polling_enabled),
    };

    if (cloud_server_url !== undefined) {
      updates.cloud_server_url = normalizeCloudServerUrl(cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
    }
    if (cloud_api_key !== undefined && !isMaskedSecret(cloud_api_key)) {
      updates.cloud_api_key = String(cloud_api_key || '');
    }
    const enablingCloud = [cloud_sync_enabled, cloud_orders_enabled, cloud_reports_enabled, cloud_command_polling_enabled]
      .some((value) => bool01Flag(value) === '1');
    const resumingStoppedCloud = cloudSync.getStatus().cloud_services_disabled_by_user && enablingCloud;
    if (resumingStoppedCloud) {
      // Stop All disables every cloud feature. Re-enabling the Cloud Services
      // control is a resume action, not just a sync preference change.
      updates.cloud_sync_enabled = '1';
      updates.cloud_orders_enabled = '1';
      updates.cloud_reports_enabled = '1';
      updates.cloud_command_polling_enabled = '1';
    }
    if (enablingCloud) updates.cloud_services_disabled_by_user = 'false';
    if (enablingCloud && cloudSync.getStatus().cloud_deletion_blocked) {
      return res.status(409).json({ error: 'Cloud deletion is unresolved; retry or cancel it before re-enabling cloud services.' });
    }

    upsertSettings(db, updates);
    cloudSync.reload();
    cloudSync.refreshRegistrationProfile();
    res.json(cloudSync.getStatus());
  } catch (error: any) {
    console.error('[API] Cloud settings update failed:', error);
    res.status(400).json({ error: 'Invalid cloud settings' });
  }
});

router.post('/cloud/register', requireRole('owner', 'manager'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const deletionRequest = await cloudSync.getDeletionRequestStatus({
      allowRemote: cloudSync.isCloudAccountAvailable(),
      signal: getHttpRequestSignal(req),
    });
    if (deletionRequest?.status === 'pending') {
      return res.status(409).json({ error: 'A cloud deletion request is pending review. Cancel it before re-enabling cloud services.' });
    }
    if (cloudSync.getStatus().cloud_services_disabled_by_user) {
      return res.status(409).json({ error: CLOUD_ACCOUNT_UNAVAILABLE_ERROR });
    }
    if (req.body?.cloud_server_url !== undefined) {
      upsertSettings(getDatabase(), {
        cloud_server_url: normalizeCloudServerUrl(req.body.cloud_server_url || DEFAULT_CLOUD_SERVER_URL),
      });
    }
    if (cloudSync.getStatus().cloud_deletion_blocked) {
      return res.status(409).json({ error: 'Cloud deletion is unresolved; retry or cancel it before re-enabling cloud services.' });
    }
    // Registration sends contact metadata for FloAdmin support; it does not
    // create a cloud owner account or grant authentication access.
    await cloudSync.register(getHttpRequestSignal(req));
    upsertSettings(getDatabase(), {
      cloud_sync_enabled: '1', cloud_reports_enabled: '1', cloud_command_polling_enabled: '1',
      cloud_services_disabled_by_user: 'false',
    });
    cloudSync.reload();
    res.json(cloudSync.getStatus());
  } catch (error: any) {
    console.error('[API] Cloud registration failed:', error);
    res.status(502).json({ error: 'Cloud registration failed' });
  }
}));

router.post('/cloud/test', requireRole('owner', 'manager'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await cloudSync.testConnection(getHttpRequestSignal(req));
    res.json(result);
  } catch (error: any) {
    console.error('[API] Cloud test failed:', error);
    res.status(502).json({ error: 'Cloud test failed' });
  }
}));

router.get('/cloud/account', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const cloudAccountAvailable = cloudSync.isCloudAccountAvailable();
    const signal = getHttpRequestSignal(req);
    const deletionRequest = await cloudSync.getDeletionRequestStatus({ allowRemote: cloudAccountAvailable, signal });
    const safeDeletionRequest = publicDeletionRequest(deletionRequest);
    if (deletionRequest?.status === 'approved' || !cloudSync.isCloudAccountAvailable()) {
      return res.json({
        email: null,
        verified: false,
        verified_at: null,
        verification_sent_at: null,
        product_updates: false,
        marketing: false,
        cloud_account_available: false,
        deletion_request: safeDeletionRequest,
      });
    }
    res.json({
      ...publicEmailPreferences(await cloudSync.getEmailPreferences(signal)),
      cloud_account_available: true,
      deletion_request: safeDeletionRequest,
    });
  } catch {
    res.status(502).json({ error: 'Could not load cloud account status' });
  }
}));

router.put('/cloud/account/preferences', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  if (!cloudSync.isCloudAccountAvailable()) {
    return res.status(409).json({ error: CLOUD_ACCOUNT_UNAVAILABLE_ERROR });
  }
  try {
    res.json(publicEmailPreferences(await cloudSync.updateEmailPreferences({
      product_updates: req.body?.product_updates,
      marketing: req.body?.marketing,
    }, getHttpRequestSignal(req))));
  } catch {
    res.status(502).json({ error: 'Could not update email preferences' });
  }
}));

router.post('/cloud/account/verification', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  if (!cloudSync.isCloudAccountAvailable()) {
    return res.status(409).json({ error: CLOUD_ACCOUNT_UNAVAILABLE_ERROR });
  }
  try {
    res.json(publicEmailPreferences(await cloudSync.requestEmailVerification({ source: 'settings' }, getHttpRequestSignal(req))));
  } catch {
    res.status(502).json({ error: 'Could not send verification email' });
  }
}));

router.get('/cloud/delete-data/status', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const deletionRequest = await cloudSync.getDeletionRequestStatus({ allowRemote: true, signal: getHttpRequestSignal(req) });
    res.json({
      cloud_account_available: cloudSync.isCloudAccountAvailable(),
      deletion_request: publicDeletionRequest(deletionRequest),
    });
  } catch {
    res.status(502).json({ error: 'Could not refresh cloud deletion status' });
  }
}));

router.post('/cloud/stop-all', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  res.json(await cloudSync.stopAllCloudServices(getHttpRequestSignal(req)));
}));

router.post('/cloud/delete-data', requireRole('owner'), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  if (req.body?.confirmation !== 'DELETE CLOUD DATA') {
    return res.status(400).json({ error: 'Type DELETE CLOUD DATA to confirm' });
  }
  try {
    res.json(await cloudSync.deleteCloudData(getHttpRequestSignal(req)));
  } catch {
    res.status(502).json({ error: 'Cloud data deletion failed' });
  }
}));

router.post('/cloud/delete-data/cancel', requireRole('owner'), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  try {
    res.json(await cloudSync.cancelDeletionRequest(getHttpRequestSignal(req)));
  } catch {
    res.status(502).json({ error: 'Could not cancel deletion request' });
  }
}));

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

router.post('/google-drive/connect', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const status = await trackHttpRequestWork(req, googleDrive.connect(getHttpRequestSignal(req)));
    res.json(status);
  } catch (error: any) {
    console.error('[API] Google Drive connection failed:', error);
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    res.status(502).json({ error: 'Google Drive connection failed' });
  }
}));

router.post('/google-drive/disconnect', requireRole('owner'), asyncHandler(async (_req: Request, res: Response) => {
  try {
    const status = await googleDrive.disconnect();
    res.json(status);
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

router.post('/google-drive/backup-now', requireRole('owner'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const status = await trackHttpRequestWork(req, googleDrive.backupNow(getHttpRequestSignal(req)));
    res.json(status);
  } catch (error: any) {
    console.error('[API] Google Drive backup failed:', error);
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    res.status(502).json({ error: 'Google Drive backup failed' });
  }
}));

// ── Generic key-value routes (wildcard — must be last) ─────────────────────

// Only non-sensitive keys may be updated via the wildcard route.
// Sensitive keys (cloud_*, tax_registration_number, etc.) must use their explicit routes above.
const ALLOWED_WILDCARD_KEYS = new Set([
  'business_name', 'timezone', 'currency', 'country',
  'state_code', 'business_address', 'business_phone',
  'billing_type', 'tables_required', 'tax_registered', 'bill_show_name', 'bill_show_address',
  'bill_show_phone', 'bill_show_tax_id', 'bill_show_tax_breakdown', 'bill_show_customer_name',
  'bill_show_customer_phone', 'bill_show_table_number',
  'tax_scheme',
  'taxes_enabled',
  'loyalty_enabled',
  'language',
  'kds_default_view',
  'printer_method', 'paper_size', 'bill_template', 'bill_footer_message', 'printer_trim_decimals',
  'telemetry_enabled',
  'diagnostics_consent',
  'kds_enabled', 'server_app_enabled', 'kot_printing_enabled',
  'split_checks_enabled',
  BILL_LANGUAGE_POLICY_KEY, KOT_LANGUAGE_POLICY_KEY,
  'currency_display', 'number_digits', 'calendar',
]);

function isAllowedWildcardKey(key: string): boolean {
  return ALLOWED_WILDCARD_KEYS.has(key) || /^tax_plugin_request:[A-Z]{2}$/.test(key);
}

router.get('/', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({ settings: publicSettingsShape(s) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/bill-templates', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  try {
    const plugins = listInstalledPrintTemplates().map((template) => {
      let storedWidths: string[] = [];
      try {
        const parsed = JSON.parse(template.paper_widths_json);
        storedWidths = Array.isArray(parsed) ? parsed.filter((width) => typeof width === 'string') : [];
      } catch { /* Ignore malformed rows; install validation owns the contract. */ }
      const paperColumns = storedWidths
        .map((width) => /^cols-(\d+)$/.exec(width)?.[1])
        .filter((width): width is string => !!width)
        .map((width) => Number(width));
      return {
        id: template.template_id,
        displayName: template.display_name,
        country: template.country,
        jurisdiction: template.jurisdiction,
        paperColumns,
        status: template.status,
        packId: template.pack_id,
        packVersionId: template.pack_version_id,
      };
    });
    res.json({ core: [...CORE_BILL_TEMPLATES], plugins });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:key', settingsReadRateLimit, requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
  try {
    if (SENSITIVE_SETTING_KEYS.has(req.params.key as string)) {
      return res.status(403).json({ error: 'This setting is sensitive and cannot be read directly' });
    }
    const key = String(req.params.key);
    const db = getDatabase();
    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    if (!setting) {
      const defaultValue = OPTIONAL_SETTING_DEFAULTS[key];
      if (defaultValue !== undefined) {
        return res.json({ setting: { key, value: defaultValue, updated_at: null } });
      }
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ setting });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:key', settingsWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    if (!isAllowedWildcardKey(req.params.key as string)) {
      return res.status(403).json({ error: 'This setting cannot be updated via wildcard route' });
    }
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    if (req.params.key === 'bill_template' && !isAvailableBillTemplate(String(value))) {
      return res.status(400).json({ error: 'Unsupported bill template' });
    }
    let valueToPersist: unknown = value;
    if (typeof req.params.key === 'string' && LANGUAGE_POLICY_SETTING_KEYS.has(req.params.key)) {
      const validation = validateLanguagePolicySetting(req.params.key, value);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
      }
      valueToPersist = validation.stored;
    }
    const db = getDatabase();
    const wildcardKey = String(req.params.key);
    if (isLocalePreferenceKey(wildcardKey)) {
      const countryCode = getAllSettings(db).country || 'IN';
      if (typeof value !== 'string' || !isLocalePreferenceSupported(wildcardKey, value, countryCode)) {
        return res.status(400).json({ error: `Invalid ${wildcardKey} for country ${countryCode}` });
      }
    }

    if (req.params.key === 'business_phone') {
      const effectiveCountry = getAllSettings(db).country || 'IN';
      const phoneRes = normalizeOptionalPhone(value, effectiveCountry);
      if (!phoneRes.valid) {
        return res.status(400).json({ error: phoneRes.error || 'Invalid business phone number' });
      }
      valueToPersist = phoneRes.e164 || '';
    }

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
    `).run(req.params.key, valueToPersist as string, now());

    // Keep the legacy setting as a compatibility mirror. The canonical runtime
    // switch is telemetry_enabled; this route is the only user-facing writer,
    // so both stay aligned whenever the owner changes the toggle.
    if (req.params.key === 'telemetry_enabled') {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(value, now());
    }

    // Tell FloAdmin the merchant's current choice so stores.diagnostics_consent
    // matches in both directions, not just inferred from "an event arrived."
    // Best-effort — never blocks the setting save on cloud reachability.
    if (req.params.key === 'diagnostics_consent') {
      void cloudSync.setDiagnosticsConsent(boolFlag(value) === 'true');
    }
    if (req.params.key === 'split_checks_enabled' && boolFlag(value) === 'true') {
      void sendEvent('feature_used', { feature: 'split_checks', action: 'enabled' });
    }

    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    res.json({ setting });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const settingsRoutes = router;
