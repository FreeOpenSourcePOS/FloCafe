import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getCurrentSchemaVersion, getDatabase, getSettingValue, now } from '../db';
import { getJWTSecret } from '../security/jwt-secret';
import { seedSetupProfile } from '../setup/seed-data';
import { authorizeMasterPin, isMasterPinAvailable, setMasterPin } from '../services/master-pin';
import { authRateLimit, validatePassword, revokeToken, isTokenRevoked, isTokenStale, invalidateUserAuthCache } from '../middleware/security';
import { getCurrencySymbol, getCountryByCode, isValidTimeZone, resolveRegionalSnapshot, type RegionalSnapshot } from '../countries';
import { countryConfirmationPatch } from '../services/country-provenance';
import { cloudSync, DEFAULT_CLOUD_SERVER_URL, normalizeCloudServerUrl } from '../services/cloud-sync';
import { asyncHandler } from '../middleware/async-handler';
import { normalizeOptionalPhone } from '../lib/phone';
import { isSupportedCurrencyCode } from '../../shared/currencies';
import { effectivePermissionRevision, resolveEffectivePermissions } from '../services/authorization';

const router = Router();

const JWT_EXPIRES_IN = '24h';
const JWT_REMEMBER_EXPIRES_IN = '10d';
const JWT_REMEMBER_EXPIRES_IN_SECONDS = 10 * 24 * 60 * 60;

function expiresInFor(remember: boolean): SignOptions['expiresIn'] {
  return remember ? JWT_REMEMBER_EXPIRES_IN : JWT_EXPIRES_IN;
}

const INITIAL_ADMIN_ROLE = 'owner';
const VALID_BUSINESS_TYPES = new Set(['restaurant']);
const VALID_SETUP_PROFILES = new Set(['empty', 'express', 'demo']);
const VALID_SERVICE_MODELS = new Set(['qsr', 'finedine']);
const LOCAL_SETUP_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The secret itself now lives in main/security/jwt-secret.ts, which is the only
// module allowed to hold its cache. Re-exported here for one release so the
// ~45 test files that resolve the secret through this router do not become a
// mechanical 45-file diff; main/ importers already point at the security module.
export { getJWTSecret, clearJWTSecretCache } from '../security/jwt-secret';

// The demo/express fixture data likewise belongs to no router. Re-exported
// here for one release, on the same terms as the secret above.
export { seedSetupProfile, ENGLISH_IDENTICAL_SEED_LANGUAGES } from '../setup/seed-data';

/** Build synthetic tenant object from local settings for frontend routing. */
function buildLocalTenant(db: ReturnType<typeof getDatabase>, userId: string, userRole: string) {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));

  // Login must never fail on a missing/unresolvable regional snapshot
  // (unreachable for an authenticated, post-setup store per
  // docs/reference/product-invariants.md) — degrade to a neutral en-US-shaped format
  // rather than throw, and never silently claim India.
  let snapshot: RegionalSnapshot | null = null;
  try {
    snapshot = resolveRegionalSnapshot(s);
  } catch {
    snapshot = null;
  }

  return {
    id: 1,
    business_name: s.business_name || 'Store',
    slug: 'local',
    database_name: 'local',
    business_type: s.business_type || 'restaurant',
    country: snapshot?.country || '',
    currency: snapshot?.currency || '',
    currency_symbol: snapshot?.currencySymbol || '',
    currency_position: snapshot?.currencyPosition || 'prefix',
    currency_fraction_digits: snapshot?.currencyFractionDigits ?? 2,
    decimal_separator: snapshot?.decimalSeparator || '.',
    group_separator: snapshot?.groupSeparator ?? ',',
    timezone: snapshot?.timezone || s.timezone || '',
    business_day_start_time: s.business_day_start_time || '00:00',
    language: s.language || 'en',
    // Include print policies in tenant snapshot so renderer bootstraps them before first print.
    bill_language_policy: s.bill_language_policy || null,
    kot_language_policy: s.kot_language_policy || null,
    service_model: s.service_model || 'finedine',
    currency_display: snapshot?.preferences.currencyDisplay || s.currency_display || 'rial',
    number_digits: snapshot?.preferences.digits || s.number_digits || 'locale',
    calendar: snapshot?.preferences.calendar || s.calendar || 'locale',
    plan: 'desktop',
    status: 'active',
    role: userRole,  // user's role — AuthGuard uses this for routing
    permission_ids: [...(resolveEffectivePermissions(userId)?.permissionIds ?? [])],
    authorization_revision: effectivePermissionRevision(userId),
  };
}

function getUserCount(db: ReturnType<typeof getDatabase>): number {
  return (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
}

type PendingCurrencyReset = { country: string; currency: string; timezone: string };

function getPendingCurrencyReset(db: ReturnType<typeof getDatabase>): PendingCurrencyReset | null {
  try {
    const row = db.prepare("SELECT value FROM _flo_meta WHERE key = 'currency_reset_pending'").get() as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<PendingCurrencyReset>;
    if (typeof parsed.country !== 'string' || typeof parsed.currency !== 'string' || typeof parsed.timezone !== 'string') return null;
    return { country: parsed.country, currency: parsed.currency, timezone: parsed.timezone };
  } catch {
    return null;
  }
}

function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

export function parseCategoryIds(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Cap mailbox at RFC 5321 length (254 octets) before regex evaluation to avoid ReDoS.
export const MAX_EMAIL_LENGTH = 254;

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function upsertSettings(db: ReturnType<typeof getDatabase>, entries: Record<string, unknown>): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null) stmt.run(key, String(value), now());
  }
}

function isLocalSetupRequest(req: Request): boolean {
  const remoteAddress = req.socket.remoteAddress || req.ip || '';
  return LOCAL_SETUP_HOSTS.has(remoteAddress) || remoteAddress.startsWith('127.');
}

function requireLocalSetup(req: Request, res: Response): boolean {
  if (isLocalSetupRequest(req)) return true;
  res.status(403).json({ error: 'Initial setup must be completed on the POS computer.' });
  return false;
}

// ── Rate Limiting (In-Memory for local offline apps) ──────────────────────────
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const passwordChangeAttempts = new Map<string, { count: number; lockedUntil: number }>();
const PASSWORD_CHANGE_MAX_ATTEMPTS = 5;
const PASSWORD_CHANGE_LOCKOUT_MINUTES = 5;

function checkRateLimit(ip: string): { allowed: boolean; waitMinutes?: number } {
  const nowMs = Date.now();
  let record = loginAttempts.get(ip);

  if (record) {
    if (record.lockedUntil > nowMs) {
      const waitMinutes = Math.ceil((record.lockedUntil - nowMs) / 60000);
      return { allowed: false, waitMinutes };
    }
    // If lock expired, reset
    if (record.lockedUntil > 0 && record.lockedUntil <= nowMs) {
      record = { count: 0, lockedUntil: 0 };
      loginAttempts.set(ip, record);
    }
  }
  return { allowed: true };
}

function incrementFailedLogin(ip: string): number {
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60000;
  }
  loginAttempts.set(ip, record);
  return Math.max(0, MAX_ATTEMPTS - record.count);
}

function resetSuccessfulLogin(ip: string) {
  loginAttempts.delete(ip);
}

function checkPasswordChangeRateLimit(userId: string): { allowed: boolean; waitMinutes?: number } {
  const nowMs = Date.now();
  const record = passwordChangeAttempts.get(userId);
  if (record?.lockedUntil && record.lockedUntil > nowMs) {
    return { allowed: false, waitMinutes: Math.ceil((record.lockedUntil - nowMs) / 60000) };
  }
  if (record?.lockedUntil && record.lockedUntil <= nowMs) {
    passwordChangeAttempts.delete(userId);
  }
  return { allowed: true };
}

function incrementFailedPasswordChange(userId: string): number {
  const record = passwordChangeAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= PASSWORD_CHANGE_MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + PASSWORD_CHANGE_LOCKOUT_MINUTES * 60000;
  }
  passwordChangeAttempts.set(userId, record);
  return Math.max(0, PASSWORD_CHANGE_MAX_ATTEMPTS - record.count);
}

function resetPasswordChangeRateLimit(userId: string): void {
  passwordChangeAttempts.delete(userId);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', authRateLimit(), asyncHandler(async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${rateLimit.waitMinutes} minutes.` });
    }

    const email = normalizeEmail(req.body?.email);
    const { password, rememberMe } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as any;
    let passwordMatches = false;
    if (user) {
      try {
        passwordMatches = await bcrypt.compare(password, user.password);
      } catch {
        passwordMatches = false;
      }
    }

    if (!user || !passwordMatches) {
      const attemptsRemaining = incrementFailedLogin(ip);
      return res.status(401).json({
        error: 'Invalid credentials',
        attempts_remaining: attemptsRemaining,
        lockout_minutes: attemptsRemaining === 0 ? LOCKOUT_MINUTES : undefined,
      });
    }

    resetSuccessfulLogin(ip);

    const remember = !!rememberMe;
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, remember, jti: randomUUID() },
      getJWTSecret(),
      { expiresIn: expiresInFor(remember) }
    );

    const tenant = buildLocalTenant(db, user.id, user.role);

    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: remember ? JWT_REMEMBER_EXPIRES_IN_SECONDS : 86400,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        category_ids: parseCategoryIds(user.category_ids),
      },
      // Single tenant — frontend auto-selects when tenants.length === 1
      tenants: [tenant],
    });
  } catch (error: any) {
    console.error('[Auth] Login error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

// ── POST /api/auth/tenants/select ─────────────────────────────────────────────
// Frontend calls this after login (even when auto-selecting the single tenant).

router.post('/tenants/select', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    const db = getDatabase();
    const user = db.prepare('SELECT id, name, email, role, is_active, tokens_valid_after FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const tenant = buildLocalTenant(db, user.id, user.role);

    // Re-issue token with tenant context embedded (same payload — desktop is single-tenant)
    const remember = !!decoded.remember;
    const newToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, tenantId: 1, remember, jti: randomUUID() },
      getJWTSecret(),
      { expiresIn: expiresInFor(remember) }
    );

    res.json({
      access_token: newToken,
      token_type: 'bearer',
      tenant,
    });
  } catch (error: any) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    try {
      const decoded = jwt.verify(token, getJWTSecret()) as { exp?: number };
      revokeToken(token, typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined);
    } catch {
      // Logout is intentionally idempotent; invalid credentials are not
      // persisted as revocations and are still answered successfully.
    }
  }
  res.json({ message: 'Logged out successfully' });
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post('/refresh', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    // Without this, a token minted before a password/PIN change (#173) could
    // keep refreshing itself into new tokens forever, bypassing revocation entirely.
    const db = getDatabase();
    const user = db.prepare('SELECT is_active, tokens_valid_after FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user || user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const remember = !!decoded.remember;
    const newToken = jwt.sign(
      { userId: decoded.userId, email: decoded.email, role: decoded.role, tenantId: decoded.tenantId, remember, jti: randomUUID() },
      getJWTSecret(),
      { expiresIn: expiresInFor(remember) }
    );

    res.json({
      access_token: newToken,
      token_type: 'bearer',
      expires_in: remember ? JWT_REMEMBER_EXPIRES_IN_SECONDS : 86400,
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get('/me', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    const db = getDatabase();
    const user = db.prepare('SELECT id, name, email, role, is_active, tokens_valid_after FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const tenant = buildLocalTenant(db, user.id, user.role);

    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenants: [tenant],
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── POST /api/auth/password/change ────────────────────────────────────────────

router.post('/password/change', authRateLimit(), (req: Request, res: Response) => {
  try {
    const { current_password, password } = req.body || {};
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const passwordChangeRateLimit = checkPasswordChangeRateLimit(user.id);
    if (!passwordChangeRateLimit.allowed) {
      return res.status(429).json({
        error: `Too many password change attempts. Try again in ${passwordChangeRateLimit.waitMinutes} minutes.`,
      });
    }

    if (typeof current_password !== 'string' || !current_password) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (!bcrypt.compareSync(current_password, user.password)) {
      const attemptsRemaining = incrementFailedPasswordChange(user.id);
      return res.status(400).json({
        error: 'Current password is incorrect',
        attempts_remaining: attemptsRemaining,
        lockout_minutes: attemptsRemaining === 0 ? PASSWORD_CHANGE_LOCKOUT_MINUTES : undefined,
      });
    }
    resetPasswordChangeRateLimit(user.id);
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const changedAt = now();
    db.prepare('UPDATE users SET password = ?, tokens_valid_after = ?, updated_at = ? WHERE id = ?')
      .run(hashedPassword, changedAt, changedAt, decoded.userId);
    invalidateUserAuthCache(decoded.userId);

    res.json({ message: 'Password changed successfully' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/auth/recover-password ───────────────────────────────────────────
// Local password recovery for locked-out owner gated by Master PIN; requires no active JWT.

router.post('/recover-password', authRateLimit(), (req: Request, res: Response) => {
  try {
    if (!requireLocalSetup(req, res)) return;
    const db = getDatabase();

    // First-run setup is the only recovery path when there is no owner yet —
    // never let this endpoint substitute for /setup/initialize.
    if (getUserCount(db) === 0) {
      return res.status(409).json({ error: 'Setup has not been completed yet. Use first-run setup to create the owner account.' });
    }

    const email = normalizeEmail(req.body?.email);
    const { master_pin, new_password } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!new_password || !validatePassword(new_password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    // Rate-limit key is IP-scoped to prevent resetting attempt counters with varying emails.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const pinResult = authorizeMasterPin(master_pin, `auth:recover-password:${ip}`);
    if (!pinResult.ok) {
      return res.status(pinResult.status).json({ error: pinResult.error });
    }

    const activeOwnerCount = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND is_active = 1").get() as { count: number }).count;
    const user = activeOwnerCount === 0
      ? db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as any
      : db.prepare('SELECT * FROM users WHERE email = ? AND role = ? AND is_active = 1').get(email, INITIAL_ADMIN_ROLE) as any;
    if (!user) {
      return res.status(404).json({ error: 'No active owner account found with that email on this install' });
    }

    const hashedPassword = bcrypt.hashSync(new_password, 10);
    const changedAt = now();
    let restoredOwnerAccess = false;
    const updated = db.transaction(() => {
      const currentOwnerCount = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND is_active = 1").get() as { count: number }).count;
      if (currentOwnerCount > 0) {
        return db.prepare('UPDATE users SET password = ?, tokens_valid_after = ?, updated_at = ? WHERE id = ? AND role = ? AND is_active = 1')
          .run(hashedPassword, changedAt, changedAt, user.id, INITIAL_ADMIN_ROLE);
      }

      restoredOwnerAccess = true;
      return db.prepare(`
        UPDATE users SET password = ?, role = ?, tokens_valid_after = ?, updated_at = ?
        WHERE id = ? AND is_active = 1
          AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner' AND is_active = 1)
      `).run(hashedPassword, INITIAL_ADMIN_ROLE, changedAt, changedAt, user.id);
    })();
    if (updated.changes === 0) {
      return res.status(409).json({ error: 'Owner access changed during recovery. Try again.' });
    }
    invalidateUserAuthCache(user.id);

    // Record recovery timestamp and user ID in settings table for audit purposes.
    upsertSettings(db, {
      last_password_recovery_at: now(),
      last_password_recovery_user_id: String(user.id),
      ...(restoredOwnerAccess ? {
        last_owner_recovery_at: now(),
        last_owner_recovery_user_id: String(user.id),
      } : {}),
    });
    console.warn(`[Auth] Password recovery: ${restoredOwnerAccess ? 'owner access' : 'owner password'} was reset locally via Master PIN for user ${user.id}`);

    res.json({ message: restoredOwnerAccess
      ? 'Owner access restored. You can now log in with your new password.'
      : 'Password reset successfully. You can now log in with your new password.' });
  } catch (error: any) {
    console.error('[Auth] Password recovery error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/auth/setup/status ──────────────────────────────────────────────────
// Returns whether the app needs setup (no users exist yet)

router.get('/setup/status', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const userCount = getUserCount(db);
    const needsSetup = userCount === 0;
    const currencyReset = needsSetup ? getPendingCurrencyReset(db) : null;
    res.json({
      needsSetup,
      userCount,
      initialRole: INITIAL_ADMIN_ROLE,
      schemaVersion: getCurrentSchemaVersion(),
      masterPinAvailable: isMasterPinAvailable(),
      currencyReset,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/auth/setup/initialize ─────────────────────────────────────────────
// Creates the initial owner user. This endpoint is disabled after any user exists.

router.post('/setup/initialize', (req: Request, res: Response) => {
  try {
    if (!requireLocalSetup(req, res)) return;

    // Reject request if setup is already complete before running payload validation.
    const db = getDatabase();
    if (getUserCount(db) > 0) {
      return res.status(403).json({ error: 'Setup already complete. This endpoint is disabled.' });
    }
    const pendingCurrencyReset = getPendingCurrencyReset(db);

    const {
      name,
      password,
      business_type = 'restaurant',
      setup_profile = 'express',
      service_model = 'qsr',
      language,
      business_name,
      store_name,
      country,
      currency,
      currency_symbol,
      timezone,
      business_address,
      address,
      business_phone,
      phone,
      tax_registration_number,
      state_code,
      tax_registered,
      billing_type,
      terms_accepted,
      master_pin,
      owner_approval_pin,
      owner_approval_pin_confirmation,
      cloud_server_url,
      email_product_updates,
      email_marketing,
    } = req.body;
    const email = normalizeEmail(req.body.email);
    // Regional settings come from signup, never from a fallback — see
    // docs/reference/product-invariants.md. There is no default country.
    const resolvedCountry = typeof country === 'string' ? getCountryByCode(country) : undefined;
    if (!resolvedCountry) {
      return res.status(400).json({ error: 'A valid country is required' });
    }
    const displayName = String(name || '').trim();
    const normalizedBusinessType = String(business_type || 'restaurant').trim();
    const normalizedSetupProfile = String(setup_profile || 'express').trim().toLowerCase();
    const normalizedServiceModel = String(service_model || 'qsr').trim().toLowerCase();
    // Omitted currency derives from the country profile; an explicitly-invalid
    // one is rejected rather than silently replaced (resolveTenantCurrency's
    // read-time leniency is the wrong tool for validating a write).
    const normalizedCurrency = currency === undefined
      ? resolvedCountry.currency
      : typeof currency === 'string' ? currency.trim().toUpperCase() : currency;
    if (!isSupportedCurrencyCode(normalizedCurrency)) {
      return res.status(400).json({ error: 'Invalid currency' });
    }
    const resolvedTimezone = timezone === undefined ? resolvedCountry.timezone : timezone;
    if (!isValidTimeZone(resolvedTimezone)) {
      return res.status(400).json({ error: 'Invalid timezone' });
    }
    const storeName = String(store_name || business_name || '').trim();
    const resolvedStoreName = storeName || 'Store';
    const outletAddress = String(business_address || address || '').trim();
    const rawOutletPhone = String(business_phone || phone || '').trim();
    let outletPhone = '';
    if (rawOutletPhone) {
      const normPhone = normalizeOptionalPhone(rawOutletPhone, resolvedCountry.code);
      if (!normPhone.valid) {
        return res.status(400).json({ error: normPhone.error || 'Invalid business phone number' });
      }
      outletPhone = normPhone.e164 || '';
    }
    if (!displayName || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    if (terms_accepted !== true) {
      return res.status(400).json({ error: 'You must accept the Terms and Conditions, Privacy Policy, and No Warranty Disclaimer to continue.' });
    }

    const masterPinRequired = isMasterPinAvailable();
    if (masterPinRequired && !/^\d{4}$/.test(String(master_pin || ''))) {
      return res.status(400).json({ error: 'A 4-digit Master PIN is required to complete setup' });
    }

    const ownerApprovalPin = String(owner_approval_pin || '');
    if (!/^\d{4,6}$/.test(ownerApprovalPin)) {
      return res.status(400).json({ error: 'A 4-6 digit owner Approval PIN is required to complete setup' });
    }
    if (ownerApprovalPin !== String(owner_approval_pin_confirmation || '')) {
      return res.status(400).json({ error: 'Owner Approval PINs do not match' });
    }

    if (!VALID_BUSINESS_TYPES.has(normalizedBusinessType)) {
      return res.status(400).json({ error: 'FloCafe setup only supports restaurant businesses' });
    }

    if (!VALID_SETUP_PROFILES.has(normalizedSetupProfile)) {
      return res.status(400).json({ error: 'Invalid setup profile' });
    }

    if (!VALID_SERVICE_MODELS.has(normalizedServiceModel)) {
      return res.status(400).json({ error: 'Invalid service model' });
    }

    // New installs start with cloud coordination enabled.
    const cloudSyncEnabled = true;
    let normalizedCloudServerUrl: string | undefined;
    if (cloudSyncEnabled) {
      try {
        normalizedCloudServerUrl = normalizeCloudServerUrl(cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
      } catch {
        return res.status(400).json({ error: 'Cloud server URL must be a valid HTTPS URL' });
      }
    }

    let userId = '';
    const hashedPassword = bcrypt.hashSync(password, 10);
    const hashedApprovalPin = bcrypt.hashSync(ownerApprovalPin, 10);

    // Save Master PIN before committing user transaction so keyring errors leave setup retryable.
    if (masterPinRequired) {
      setMasterPin(String(master_pin));
    }

    db.transaction(() => {
      const userCount = getUserCount(db);
      if (userCount > 0) {
        throw new Error('Setup already complete. This endpoint is disabled.');
      }

      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        throw new Error('User with this email already exists');
      }

      userId = randomUUID();
      db.prepare(`
        INSERT INTO users (id, name, email, password, role, pin_hash, is_active, terms_accepted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, displayName, email, hashedPassword, INITIAL_ADMIN_ROLE, hashedApprovalPin, 1, now(), now(), now());

      upsertSettings(db, {
        business_name: resolvedStoreName,
        business_type: normalizedBusinessType,
        country: resolvedCountry.code,
        currency: normalizedCurrency,
        currency_symbol: currency_symbol || getCurrencySymbol(normalizedCurrency, resolvedCountry.locale),
        timezone: resolvedTimezone,
        language,
        business_address: outletAddress,
        business_phone: outletPhone,
        address: outletAddress,
        phone: outletPhone,
        email,
        tax_registration_number,
        state_code,
        tax_registered,
        billing_type: billing_type || (normalizedServiceModel === 'qsr' ? 'prepaid' : 'postpaid'),
        tables_required: normalizedServiceModel === 'finedine' ? 'true' : 'false',
        service_model: normalizedServiceModel,
        setup_profile: pendingCurrencyReset ? 'empty' : normalizedSetupProfile,
        onboarding_completed: 'true',
        // Confirm country if user explicitly selected it or differed from default.
        ...countryConfirmationPatch(resolvedCountry.code, getSettingValue('country'), req.body.country_selected),
        anonymous_data_consent: 'true',
        telemetry_enabled: 'true',
        telemetry_scope: 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics',
        split_checks_enabled: 'false',
        // '1'/'0', not 'true'/'false' — mirrors FloAdmin's own `stores` table and
        // matches how cloud-sync.ts reads this key everywhere else.
        cloud_sync_enabled: cloudSyncEnabled ? '1' : '0',
        cloud_server_url: normalizedCloudServerUrl || DEFAULT_CLOUD_SERVER_URL,
        email_product_updates: email_product_updates === true ? 'true' : 'false',
        email_marketing: email_marketing === true ? 'true' : 'false',
        cloud_services_disabled_by_user: 'false',
      });

      if (!pendingCurrencyReset) {
        seedSetupProfile(db, normalizedSetupProfile, normalizedServiceModel, language, resolvedCountry.code);
      }
      if (pendingCurrencyReset) {
        db.prepare("DELETE FROM _flo_meta WHERE key = 'currency_reset_pending'").run();
      }
    })();

    // Reload cloud sync and registration profile immediately after setup.
    try {
      cloudSync.reload();
    } catch (error) {
      console.warn('[Auth] Cloud settings reload deferred after setup:', error);
    }
    try {
      cloudSync.refreshRegistrationProfile();
    } catch (error) {
      console.warn('[Auth] Cloud registration profile refresh deferred after setup:', error);
    }

    const token = jwt.sign(
      { userId, email, role: INITIAL_ADMIN_ROLE, jti: randomUUID() },
      getJWTSecret(),
      { expiresIn: JWT_EXPIRES_IN }
    );

    const tenant = buildLocalTenant(db, userId, INITIAL_ADMIN_ROLE);

    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: 86400,
      user: { id: userId, name: displayName, email, role: INITIAL_ADMIN_ROLE },
      tenant,
      tenants: [tenant],
    });
  } catch (error: any) {
    console.error('[Auth] Setup error:', error);
    const message = error.message || 'Setup failed';
    const status = message.includes('already complete') ? 403
      : message.includes('already exists') ? 400
        : 500;
    res.status(status).json({ error: status === 500 ? 'Setup failed' : message });
  }
});

// ── POST /api/auth/setup/seed ───────────────────────────────────────────────────
// Legacy endpoint retained to direct callers to /api/auth/setup/initialize.

router.post('/setup/seed', (req: Request, res: Response) => {
  res.status(410).json({ error: 'Use /api/auth/setup/initialize with setup_profile and owner details.' });
});

export const authRoutes = router;
