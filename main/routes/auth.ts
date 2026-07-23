import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';
import { getCurrentSchemaVersion, getDatabase, now } from '../db';
import { authorizeMasterPin, isMasterPinAvailable, setMasterPin } from '../services/master-pin';
import { authRateLimit, validatePassword } from '../middleware/security';
import { getCurrencySymbol, getCountryByCode } from '../countries';
import { cloudSync, DEFAULT_CLOUD_SERVER_URL, normalizeCloudServerUrl } from '../services/cloud-sync';

const router = Router();

const JWT_EXPIRES_IN = '24h';
const JWT_REMEMBER_EXPIRES_IN = '10d';
const JWT_REMEMBER_EXPIRES_IN_SECONDS = 10 * 24 * 60 * 60;

function expiresInFor(remember: boolean): SignOptions['expiresIn'] {
  return remember ? JWT_REMEMBER_EXPIRES_IN : JWT_EXPIRES_IN;
}

function dialCodeFor(country: string | undefined): string {
  if (!country) return '+1';
  try { return `+${getCountryCallingCode(country.toUpperCase() as CountryCode)}`; }
  catch { return '+1'; }
}

const INITIAL_ADMIN_ROLE = 'owner';
const VALID_BUSINESS_TYPES = new Set(['restaurant']);
const VALID_SETUP_PROFILES = new Set(['empty', 'express', 'demo']);
const VALID_SERVICE_MODELS = new Set(['qsr', 'finedine']);
const LOCAL_SETUP_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Lazy-loaded JWT secret. On first access, reads from the settings table.
 * If no secret exists (first launch), generates a random 32-byte hex string
 * and persists it. This ensures every install gets a unique secret without
 * requiring manual configuration.
 */
let _jwtSecret: string | null = null;

export function getJWTSecret(): string {
  if (_jwtSecret) return _jwtSecret;

  // Environment variable always wins (for CI/testing)
  if (process.env.JWT_SECRET) {
    _jwtSecret = process.env.JWT_SECRET;
    return _jwtSecret;
  }

  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;

    if (row?.value) {
      _jwtSecret = row.value;
    } else {
      // First launch: generate and persist a random secret
      _jwtSecret = randomBytes(32).toString('hex');
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('jwt_secret', ?, ?)")
        .run(_jwtSecret, now());
      console.log('[Auth] Generated new JWT secret for this install');
    }
  } catch (err) {
    // Database not ready — refuse to operate with a static secret.
    // JWT operations will fail until the database is accessible.
    console.error('[Auth] Database not ready — JWT secret unavailable:', err);
    throw new Error('Database not ready — authentication unavailable');
  }

  return _jwtSecret;
}

/**
 * Build a synthetic "tenant" object from local settings.
 * FloDesktop is single-tenant — there is always exactly one "business".
 * The frontend expects this shape to determine routing (chef → KDS, others → POS).
 */
function buildLocalTenant(db: ReturnType<typeof getDatabase>, userRole: string) {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));

  return {
    id: 1,
    business_name: s.business_name || 'Store',
    slug: 'local',
    database_name: 'local',
    business_type: s.business_type || 'restaurant',
    country: s.country || 'IN',
    currency: s.currency || 'INR',
    currency_symbol: getCurrencySymbol(s.currency || 'INR', getCountryByCode(s.country)?.locale) || '₹',
    timezone: s.timezone || 'Asia/Kolkata',
    language: s.language || 'en',
    service_model: s.service_model || 'finedine',
    plan: 'desktop',
    status: 'active',
    role: userRole,  // user's role — AuthGuard uses this for routing
  };
}

function getUserCount(db: ReturnType<typeof getDatabase>): number {
  return (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
}

function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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


function insertCategory(db: ReturnType<typeof getDatabase>, id: string, name: string, color: string, icon: string, sortOrder: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO categories (id, name, color, icon, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, color, icon, sortOrder, now(), now());
}

function insertProduct(db: ReturnType<typeof getDatabase>, id: string, categoryId: string, name: string, price: number, sortOrder: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO products (id, category_id, name, price, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, categoryId, name, price, sortOrder, now(), now());
}

function insertTable(db: ReturnType<typeof getDatabase>, id: string, number: string, capacity: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO tables (id, number, capacity, status, created_at, updated_at)
    VALUES (?, ?, ?, 'available', ?, ?)
  `).run(id, number, capacity, now(), now());
}

function insertCustomer(db: ReturnType<typeof getDatabase>, id: string, name: string, phone: string, countryCode: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, phone, countryCode, now(), now());
}

function insertStaffUser(db: ReturnType<typeof getDatabase>, id: string, name: string, email: string, role: string, password: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, email, bcrypt.hashSync(password, 10), role, now(), now());
}

function seedExpressRestaurant(db: ReturnType<typeof getDatabase>, serviceModel: string): void {
  insertCategory(db, 'cat-express-food', 'Food', '#F97316', '🍽️', 1);
  insertCategory(db, 'cat-express-beverages', 'Beverages', '#0EA5E9', '🥤', 2);

  insertProduct(db, 'prod-express-meal', 'cat-express-food', 'Meal', 150, 1);
  insertProduct(db, 'prod-express-snack', 'cat-express-food', 'Snack', 80, 2);
  insertProduct(db, 'prod-express-tea', 'cat-express-beverages', 'Tea', 25, 1);
  insertProduct(db, 'prod-express-coffee', 'cat-express-beverages', 'Coffee', 40, 2);

  if (serviceModel === 'finedine') {
    insertTable(db, 'tbl-express-1', 'T1', 4);
    insertTable(db, 'tbl-express-2', 'T2', 4);
    insertTable(db, 'tbl-express-3', 'T3', 6);
  }
}

function seedDemoRestaurant(db: ReturnType<typeof getDatabase>, serviceModel: string, language?: string, country?: string): void {
  const isEs = language === 'es';
  const dialCode = dialCodeFor(country);

  const cats = isEs
    ? [
        ['cat-demo-starters', 'Entradas', '#FF6B6B', '🍟', 1],
        ['cat-demo-burger', 'Hamburguesas', '#4ECDC4', '🍔', 2],
        ['cat-demo-beverages', 'Bebidas', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Postres', '#96CEB4', '🍰', 4],
      ] as const
    : [
        ['cat-demo-starters', 'Starters', '#FF6B6B', '🍔', 1],
        ['cat-demo-main', 'Main Course', '#4ECDC4', '🍛', 2],
        ['cat-demo-beverages', 'Beverages', '#45B7D1', '🥤', 3],
        ['cat-demo-desserts', 'Desserts', '#96CEB4', '🍰', 4],
      ] as const;
  for (const [id, name, color, icon, sort] of cats) insertCategory(db, id, name, color, icon, sort);

  const products = isEs
    ? [
        ['prod-demo-empanadas', 'cat-demo-starters', 'Empanadas de Carne', 280, 1],
        ['prod-demo-papas', 'cat-demo-starters', 'Papas Fritas', 250, 2],
        ['prod-demo-hamburguesa-clasica', 'cat-demo-burger', 'Hamburguesa Clásica', 800, 1],
        ['prod-demo-doble', 'cat-demo-burger', 'Hamburguesa Doble', 1100, 2],
        ['prod-demo-bbq', 'cat-demo-burger', 'Hamburguesa BBQ', 1200, 3],
        ['prod-demo-gaseosa', 'cat-demo-beverages', 'Gaseosa Cola', 350, 1],
        ['prod-demo-agua', 'cat-demo-beverages', 'Agua Mineral', 200, 2],
        ['prod-demo-flan', 'cat-demo-desserts', 'Flan Casero', 400, 1],
      ] as const
    : [
        ['prod-demo-paneer-tikka', 'cat-demo-starters', 'Paneer Tikka', 250, 1],
        ['prod-demo-chicken-wings', 'cat-demo-starters', 'Chicken Wings', 280, 2],
        ['prod-demo-butter-chicken', 'cat-demo-main', 'Butter Chicken', 320, 1],
        ['prod-demo-dal-makhani', 'cat-demo-main', 'Dal Makhani', 220, 2],
        ['prod-demo-jeera-rice', 'cat-demo-main', 'Jeera Rice', 150, 3],
        ['prod-demo-cola', 'cat-demo-beverages', 'Cola', 60, 1],
        ['prod-demo-lemon-soda', 'cat-demo-beverages', 'Lemon Soda', 70, 2],
        ['prod-demo-gulab-jamun', 'cat-demo-desserts', 'Gulab Jamun', 80, 1],
      ] as const;
  for (const [id, categoryId, name, price, sort] of products) insertProduct(db, id, categoryId, name, price, sort);

  if (serviceModel === 'finedine') {
    const tableLabel = isEs ? 'M' : 'T';
    insertTable(db, 'tbl-demo-1', `${tableLabel}1`, 4);
    insertTable(db, 'tbl-demo-2', `${tableLabel}2`, 4);
    insertTable(db, 'tbl-demo-3', `${tableLabel}3`, 6);
    insertTable(db, 'tbl-demo-4', `${tableLabel}4`, 2);
  }

  if (isEs) {
    insertCustomer(db, 'cust-demo-1', 'Juan Pérez', '1145678901', dialCode);
    insertCustomer(db, 'cust-demo-2', 'María González', '1145678902', dialCode);
    insertCustomer(db, 'cust-demo-3', 'Carlos Rodríguez', '1145678903', dialCode);
  } else {
    insertCustomer(db, 'cust-demo-1', 'Aarav Sharma', '9876543210', dialCode);
    insertCustomer(db, 'cust-demo-2', 'Maya Iyer', '9876543211', dialCode);
    insertCustomer(db, 'cust-demo-3', 'Kabir Khan', '9876543212', dialCode);
  }

  const managerName = isEs ? 'Gerente Demo' : 'Demo Manager';
  const cashierName = isEs ? 'Cajero Demo' : 'Demo Cashier';
  const chefName = isEs ? 'Cocinero Demo' : 'Demo Chef';
  insertStaffUser(db, 'user-demo-manager', managerName, 'manager@flo.local', 'manager', 'demo12345');
  insertStaffUser(db, 'user-demo-cashier', cashierName, 'cashier@flo.local', 'cashier', 'demo12345');
  insertStaffUser(db, 'user-demo-chef', chefName, 'chef@flo.local', 'chef', 'demo12345');
}

export function seedSetupProfile(db: ReturnType<typeof getDatabase>, profile: string, serviceModel: string, language?: string, country?: string): void {
  if (profile === 'express') {
    seedExpressRestaurant(db, serviceModel);
  } else if (profile === 'demo') {
    seedDemoRestaurant(db, serviceModel, language, country);
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
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', authRateLimit(), (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${rateLimit.waitMinutes} minutes.` });
    }

    const { email, password, rememberMe } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as any;

    if (!user || !bcrypt.compareSync(password, user.password)) {
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
      { userId: user.id, email: user.email, role: user.role, remember },
      getJWTSecret(),
      { expiresIn: expiresInFor(remember) }
    );

    const tenant = buildLocalTenant(db, user.role);

    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: remember ? JWT_REMEMBER_EXPIRES_IN_SECONDS : 86400,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        category_ids: user.category_ids ? JSON.parse(user.category_ids) : [],
      },
      // Single tenant — frontend auto-selects when tenants.length === 1
      tenants: [tenant],
    });
  } catch (error: any) {
    console.error('[Auth] Login error:', error);
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/auth/tenants/select ─────────────────────────────────────────────
// Frontend calls this after login (even when auto-selecting the single tenant).

router.post('/tenants/select', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    const db = getDatabase();
    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tenant = buildLocalTenant(db, user.role);

    // Re-issue token with tenant context embedded (same payload — desktop is single-tenant)
    const remember = !!decoded.remember;
    const newToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, tenantId: 1, remember },
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

router.post('/logout', (_req: Request, res: Response) => {
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
    const decoded = jwt.verify(token, getJWTSecret()) as any;
    const remember = !!decoded.remember;
    const newToken = jwt.sign(
      { userId: decoded.userId, email: decoded.email, role: decoded.role, tenantId: decoded.tenantId, remember },
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
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    const db = getDatabase();
    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tenant = buildLocalTenant(db, user.role);

    res.json({
      user,
      tenants: [tenant],
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── POST /api/auth/password/change ────────────────────────────────────────────

router.post('/password/change', (req: Request, res: Response) => {
  try {
    const { current_password, password } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!bcrypt.compareSync(current_password, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?').run(hashedPassword, now(), decoded.userId);

    res.json({ message: 'Password changed successfully' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/auth/recover-password ───────────────────────────────────────────
// Local, unauthenticated-but-PIN-gated recovery for a locked-out owner (#127).
//
// Deliberately does NOT require a JWT/session — that's the whole point: the
// owner has no working credentials. Local proof of ownership is the Master
// PIN instead (see main/services/master-pin.ts). This endpoint only ever
// updates one existing owner's password column; it can never create,
// reinitialize, or wipe anything — that stays behind /api/db-tools/initialize
// (owner session + Master PIN + explicit confirmation phrase).
//
// No remote backdoor: nothing here lets a Flo cloud server or anyone without
// physical/local access to this machine set the password. See #128 for the
// signup-time copy explaining this to the owner, and the scope note in this
// PR for why the optional cloud/email identity-verification tier described in
// the issue is intentionally NOT implemented here (no cloud server exists in
// this repo to issue the short-lived signed grant safely).

router.post('/recover-password', authRateLimit(), (req: Request, res: Response) => {
  try {
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

    // Rate-limit key is IP-scoped only (not email-scoped) so an attacker can't
    // reset the Master PIN attempt counter simply by guessing a different
    // email address on each request.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const pinResult = authorizeMasterPin(master_pin, `auth:recover-password:${ip}`);
    if (!pinResult.ok) {
      return res.status(pinResult.status).json({ error: pinResult.error });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ? AND is_active = 1')
      .get(email, INITIAL_ADMIN_ROLE) as any;
    if (!user) {
      return res.status(404).json({ error: 'No active owner account found with that email on this install' });
    }

    const hashedPassword = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?').run(hashedPassword, now(), user.id);

    // Local audit trail — this codebase has no dedicated audit-events table,
    // so we follow its existing convention: a tagged console log (grep-able
    // in the app's log file) plus a timestamp/identity pair in `settings`,
    // the same generic key/value mechanism already used for e.g.
    // `telemetry_last_ping_at`.
    upsertSettings(db, {
      last_password_recovery_at: now(),
      last_password_recovery_email: email,
    });
    console.warn(`[Auth] Password recovery: owner password for ${email} was reset locally via Master PIN`);

    res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
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
    res.json({
      needsSetup,
      userCount,
      initialRole: INITIAL_ADMIN_ROLE,
      schemaVersion: getCurrentSchemaVersion(),
      masterPinAvailable: isMasterPinAvailable(),
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

    const {
      name,
      password,
      business_type = 'restaurant',
      setup_profile = 'express',
      service_model = 'qsr',
      language,
      business_name,
      store_name,
      country = 'IN',
      currency = 'INR',
      currency_symbol,
      timezone = 'Asia/Kolkata',
      business_address,
      address,
      business_phone,
      phone,
      gstin,
      state_code,
      tax_registered,
      billing_type,
      terms_accepted,
      anonymous_data_consent,
      master_pin,
      cloud_sync_enabled,
      cloud_server_url,
    } = req.body;
    const email = normalizeEmail(req.body.email);
    const displayName = String(name || '').trim();
    const normalizedBusinessType = String(business_type || 'restaurant').trim();
    const normalizedSetupProfile = String(setup_profile || 'express').trim().toLowerCase();
    const normalizedServiceModel = String(service_model || 'qsr').trim().toLowerCase();
    const normalizedCurrency = String(currency || 'INR').trim().toUpperCase();
    const storeName = String(store_name || business_name || '').trim();
    const resolvedStoreName = storeName || 'Store';
    const outletAddress = String(business_address || address || '').trim();
    const outletPhone = String(business_phone || phone || '').trim();
    const anonymousDataConsent = anonymous_data_consent === true;

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

    if (!VALID_BUSINESS_TYPES.has(normalizedBusinessType)) {
      return res.status(400).json({ error: 'FloCafe setup only supports restaurant businesses' });
    }

    if (!VALID_SETUP_PROFILES.has(normalizedSetupProfile)) {
      return res.status(400).json({ error: 'Invalid setup profile' });
    }

    if (!VALID_SERVICE_MODELS.has(normalizedServiceModel)) {
      return res.status(400).json({ error: 'Invalid service model' });
    }

    // Cloud services (#128): off by default, opt-in only. The URL is only
    // validated/stored when the owner actually enables sync — an invalid URL
    // in a disabled, unused field shouldn't block setup.
    const cloudSyncEnabled = cloud_sync_enabled === true;
    let normalizedCloudServerUrl: string | undefined;
    if (cloudSyncEnabled) {
      try {
        normalizedCloudServerUrl = normalizeCloudServerUrl(cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
      } catch {
        return res.status(400).json({ error: 'Cloud server URL must be a valid HTTPS URL' });
      }
    }

    const db = getDatabase();
    const beforeCount = getUserCount(db);
    if (beforeCount > 0) {
      return res.status(403).json({ error: 'Setup already complete. This endpoint is disabled.' });
    }

    let userId = '';
    const hashedPassword = bcrypt.hashSync(password, 10);

    db.transaction(() => {
      const userCount = getUserCount(db);
      if (userCount > 0) {
        throw new Error('Setup already complete. This endpoint is disabled.');
      }

      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        throw new Error('User with this email already exists');
      }

      userId = uuidv4();
      db.prepare(`
        INSERT INTO users (id, name, email, password, role, is_active, terms_accepted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, displayName, email, hashedPassword, INITIAL_ADMIN_ROLE, 1, now(), now(), now());

      upsertSettings(db, {
        business_name: resolvedStoreName,
        business_type: normalizedBusinessType,
        country,
        currency: normalizedCurrency,
        currency_symbol: currency_symbol || getCurrencySymbol(normalizedCurrency, getCountryByCode(country)?.locale),
        timezone,
        language,
        business_address: outletAddress,
        business_phone: outletPhone,
        address: outletAddress,
        phone: outletPhone,
        email,
        gstin,
        state_code,
        tax_registered,
        billing_type: billing_type || (normalizedServiceModel === 'qsr' ? 'prepaid' : 'postpaid'),
        tables_required: normalizedServiceModel === 'finedine' ? 'true' : 'false',
        service_model: normalizedServiceModel,
        setup_profile: normalizedSetupProfile,
        onboarding_completed: 'true',
        anonymous_data_consent: anonymousDataConsent ? 'true' : 'false',
        telemetry_enabled: anonymousDataConsent ? 'true' : 'false',
        telemetry_scope: 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics',
        cloud_sync_enabled: cloudSyncEnabled ? 'true' : 'false',
        cloud_server_url: normalizedCloudServerUrl || DEFAULT_CLOUD_SERVER_URL,
      });

      seedSetupProfile(db, normalizedSetupProfile, normalizedServiceModel, language, country);
    })();

    // Written to userData/, outside flo.db and outside this transaction — the
    // Master PIN is deliberately independent of the database it gates.
    if (masterPinRequired) {
      setMasterPin(String(master_pin));
    }

    // Pick up the cloud settings just written without requiring a restart —
    // mirrors PUT /api/settings/cloud's own reload() call.
    cloudSync.reload();

    const token = jwt.sign(
      { userId, email, role: INITIAL_ADMIN_ROLE },
      getJWTSecret(),
      { expiresIn: JWT_EXPIRES_IN }
    );

    const tenant = buildLocalTenant(db, INITIAL_ADMIN_ROLE);

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
// Legacy endpoint retained only to return a clear error. First-run setup must
// create the owner through /setup/initialize and pass the selected seed profile.

router.post('/setup/seed', (req: Request, res: Response) => {
  res.status(410).json({ error: 'Use /api/auth/setup/initialize with setup_profile and owner details.' });
});

export const authRoutes = router;
