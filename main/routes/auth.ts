import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import {
  getCurrentSchemaVersion,
  getDatabase,
  getSettingValue,
  getUserKdsStationIds,
  hasUserKdsStationAssignments,
  isKdsEnabled,
  nextTokenIatSeconds,
  nextTokensValidAfterTimestamp,
  now,
  recordAuthAudit,
  verifyPinAsync,
} from '../db';
import { getJWTSecret } from '../security/jwt-secret';
import { seedSetupProfile } from '../setup/seed-data';
import { authorizeMasterPin, isMasterPinAvailable, setMasterPin } from '../services/master-pin';
import {
  authRateLimit,
  loginAuthRateLimit,
  checkLoginRateLimit,
  incrementFailedLogin,
  resetSuccessfulLogin,
  FAILED_LOGIN_LOCKOUT_MINUTES,
  normalizeIpForPinRateLimit,
  normalizeIpForRateLimit,
  withPinVerificationLock,
  validatePassword,
  revokeToken,
  isTokenRevoked,
  isTokenStale,
  invalidateUserAuthCache,
} from '../middleware/security';
import {
  getCurrencySymbol,
  getCountryByCode,
  isValidTimeZone,
  resolveRegionalSnapshot,
  type RegionalSnapshot,
} from '../countries';
import { countryConfirmationPatch } from '../services/country-provenance';
import {
  cloudSync,
  CloudRequestError,
  DEFAULT_CLOUD_SERVER_URL,
  normalizeCloudServerUrl,
} from '../services/cloud-sync';
import { asyncHandler } from '../middleware/async-handler';
import { handleRestoreFromPickedFile } from './database';
import { getHttpRequestSignal } from '../shutdown';
import { PASSWORD_POLICY_MESSAGE } from '../../shared/password-policy';
import { normalizeOptionalPhone } from '../lib/phone';
import { isSupportedCurrencyCode } from '../../shared/currencies';
import {
  effectivePermissionRevision,
  hasActiveAdministrator,
  hasPermission,
  resolveEffectivePermissions,
} from '../services/authorization';
import { serializeOperationFailure } from '../lib/operation-failure';
import { capturePostHogUsage, syncPostHogIdentity } from '../services/posthog';
import {
  PRODUCT_ANALYTICS_LEVEL_SETTING,
  parseProductAnalyticsLevel,
} from '../services/posthog-identity';

const router = Router();

const JWT_EXPIRES_IN_SECONDS = 24 * 60 * 60;
const JWT_REMEMBER_EXPIRES_IN_SECONDS = 10 * 24 * 60 * 60;

function expiresInSecondsFor(remember: boolean): number {
  return remember ? JWT_REMEMBER_EXPIRES_IN_SECONDS : JWT_EXPIRES_IN_SECONDS;
}

function tokenExpSeconds(remember = false): number {
  return Math.floor(Date.now() / 1000) + expiresInSecondsFor(remember);
}

export function signFreshSessionToken(
  user: { id: string; email: string; role: string },
  decoded: Record<string, unknown> = {},
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const iatSeconds = typeof decoded.iat === 'number' ? decoded.iat : nowSeconds;
  const expSeconds = typeof decoded.exp === 'number' ? decoded.exp : 0;
  const isLongLived =
    Boolean(decoded.remember) ||
    expSeconds - iatSeconds > JWT_EXPIRES_IN_SECONDS + 60 ||
    expSeconds - nowSeconds > JWT_EXPIRES_IN_SECONDS + 60;
  const remember = isLongLived;
  const payload: Record<string, unknown> = {
    userId: user.id,
    email: user.email,
    role: user.role,
    ...(decoded.tenantId !== undefined ? { tenantId: decoded.tenantId } : {}),
    ...(decoded.remember !== undefined || isLongLived ? { remember } : {}),
    ...(decoded.scope !== undefined ? { scope: decoded.scope } : {}),
    ...(decoded.aud !== undefined ? { aud: decoded.aud } : {}),
    jti: randomUUID(),
    iat: nextTokenIatSeconds(),
    exp: tokenExpSeconds(remember),
  };
  return jwt.sign(payload, getJWTSecret());
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
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const s: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));

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
    role: userRole, // user's role — AuthGuard uses this for routing
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
    const row = db
      .prepare("SELECT value FROM _flo_meta WHERE key = 'currency_reset_pending'")
      .get() as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<PendingCurrencyReset>;
    if (
      typeof parsed.country !== 'string' ||
      typeof parsed.currency !== 'string' ||
      typeof parsed.timezone !== 'string'
    )
      return null;
    return { country: parsed.country, currency: parsed.currency, timezone: parsed.timezone };
  } catch {
    return null;
  }
}

export function normalizeEmail(email: unknown): string {
  return String(email || '')
    .trim()
    .toLowerCase();
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

function upsertSettings(
  db: ReturnType<typeof getDatabase>,
  entries: Record<string, unknown>,
): void {
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
const passwordChangeAttempts = new Map<string, { count: number; lockedUntil: number }>();
const PASSWORD_CHANGE_MAX_ATTEMPTS = 5;
const PASSWORD_CHANGE_LOCKOUT_MINUTES = 5;

const pinChangeAttempts = new Map<string, { count: number; lockedUntil: number }>();
const PIN_CHANGE_MAX_ATTEMPTS = 5;
const PIN_CHANGE_LOCKOUT_MINUTES = 5;

function checkUserAttemptRateLimit(
  attemptsMap: Map<string, { count: number; lockedUntil: number }>,
  userId: string,
): { allowed: boolean; waitMinutes?: number } {
  const nowMs = Date.now();
  const record = attemptsMap.get(userId);
  if (record?.lockedUntil && record.lockedUntil > nowMs) {
    return { allowed: false, waitMinutes: Math.ceil((record.lockedUntil - nowMs) / 60000) };
  }
  if (record?.lockedUntil && record.lockedUntil <= nowMs) {
    attemptsMap.delete(userId);
  }
  return { allowed: true };
}

function incrementUserAttemptFailure(
  attemptsMap: Map<string, { count: number; lockedUntil: number }>,
  userId: string,
  maxAttempts: number,
  lockoutMinutes: number,
): number {
  const record = attemptsMap.get(userId) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= maxAttempts) {
    record.lockedUntil = Date.now() + lockoutMinutes * 60000;
  }
  attemptsMap.set(userId, record);
  return Math.max(0, maxAttempts - record.count);
}

function checkPasswordChangeRateLimit(userId: string): { allowed: boolean; waitMinutes?: number } {
  return checkUserAttemptRateLimit(passwordChangeAttempts, userId);
}

function incrementFailedPasswordChange(userId: string): number {
  return incrementUserAttemptFailure(
    passwordChangeAttempts,
    userId,
    PASSWORD_CHANGE_MAX_ATTEMPTS,
    PASSWORD_CHANGE_LOCKOUT_MINUTES,
  );
}

function resetPasswordChangeRateLimit(userId: string): void {
  passwordChangeAttempts.delete(userId);
}

function checkPinChangeRateLimit(userId: string): { allowed: boolean; waitMinutes?: number } {
  return checkUserAttemptRateLimit(pinChangeAttempts, userId);
}

function incrementFailedPinChange(userId: string): number {
  return incrementUserAttemptFailure(
    pinChangeAttempts,
    userId,
    PIN_CHANGE_MAX_ATTEMPTS,
    PIN_CHANGE_LOCKOUT_MINUTES,
  );
}

function resetPinChangeRateLimit(userId: string): void {
  pinChangeAttempts.delete(userId);
}

export function resetCredentialChangeRateLimitsForTests(): void {
  passwordChangeAttempts.clear();
  pinChangeAttempts.clear();
}
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post(
  '/login',
  loginAuthRateLimit(),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = checkLoginRateLimit(ip);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          error: `Too many failed attempts. Try again in ${rateLimit.waitMinutes} minutes.`,
        });
      }

      const email = normalizeEmail(req.body?.email);
      const { password, rememberMe } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      const db = getDatabase();
      const user = db
        .prepare('SELECT * FROM users WHERE email = ? AND is_active = 1')
        .get(email) as any;
      let passwordMatches = false;
      if (user) {
        try {
          passwordMatches = await bcrypt.compare(password, user.password);
        } catch {
          passwordMatches = false;
        }
      }

      const currentUser =
        user && passwordMatches
          ? (db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(user.id) as any)
          : undefined;
      if (!user || !passwordMatches || !currentUser || currentUser.password !== user.password) {
        const attemptsRemaining = incrementFailedLogin(ip);
        return res.status(401).json({
          error: 'Invalid credentials',
          attempts_remaining: attemptsRemaining,
          lockout_minutes: attemptsRemaining === 0 ? FAILED_LOGIN_LOCKOUT_MINUTES : undefined,
        });
      }

      resetSuccessfulLogin(ip);

      const remember = !!rememberMe;
      const token = jwt.sign(
        {
          userId: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
          remember,
          jti: randomUUID(),
          iat: nextTokenIatSeconds(),
          exp: tokenExpSeconds(remember),
        },
        getJWTSecret(),
      );

      const tenant = buildLocalTenant(db, currentUser.id, currentUser.role);

      res.json({
        access_token: token,
        token_type: 'bearer',
        expires_in: expiresInSecondsFor(remember),
        user: {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
          role: currentUser.role,
          has_pin: Boolean(currentUser.pin_hash),
          category_ids: parseCategoryIds(currentUser.category_ids),
        },
        // Single tenant — frontend auto-selects when tenants.length === 1
        tenants: [tenant],
      });
    } catch (error: any) {
      res.locals.postHogError = error;
      console.error('[Auth] Login error:', error);
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }),
);

// ── GET /api/auth/pin-users ───────────────────────────────────────────────────
// Public quick-switch user picker directory: active users with a PIN configured.

router.get('/pin-users', authRateLimit({ max: 600 }), (req: Request, res: Response) => {
  try {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : '';
    if (scope === 'kds' && !isKdsEnabled()) {
      return res.json({ users: [] });
    }
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT id, name, role
         FROM users
         WHERE is_active = 1 AND pin_hash IS NOT NULL
         ORDER BY CASE role
           WHEN 'owner' THEN 1
           WHEN 'manager' THEN 2
           WHEN 'cashier' THEN 3
           WHEN 'server' THEN 4
           WHEN 'chef' THEN 5
           ELSE 6
         END, name COLLATE NOCASE ASC`,
      )
      .all() as Array<{ id: string; name: string; role: string }>;

    const filteredRows =
      scope === 'kds'
        ? rows.filter((row) => {
            if (!hasPermission(row.id, 'kitchen.use')) return false;
            const stationIds = getUserKdsStationIds(db, row.id);
            const stationAssignmentsConfigured = hasUserKdsStationAssignments(db, row.id);
            if (!stationIds || stationAssignmentsConfigured === null) return false;
            if (stationAssignmentsConfigured && stationIds.length === 0) return false;
            return true;
          })
        : rows;

    res.json({
      users: filteredRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        role: String(row.role),
      })),
    });
  } catch (error: unknown) {
    res.locals.postHogError = error;
    console.error('[Auth] PIN users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/pin-login ──────────────────────────────────────────────────
// Quick user switch via PIN for a specifically selected user_id.

export type PinAuthUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: number;
  pin_hash: string | null;
  category_ids: string | null;
};

export type PinSurfaceAuthorizeResult<TExtra> =
  | { ok: true; extra: TExtra }
  | { ok: false; status: 403 | 500; body: Record<string, unknown> };

function buildInvalidPinCredentialsResult(
  db: ReturnType<typeof getDatabase>,
  opts: {
    userId: string;
    ip: string;
    pinRateKey: string;
    service?: 'kds' | 'server-app';
    reason: string;
  },
): { status: 401; body: Record<string, unknown> } {
  const attemptsRemaining = incrementFailedLogin(opts.pinRateKey);
  recordAuthAudit(db, {
    userId: opts.userId,
    eventType: 'pin_login',
    outcome: 'failure',
    ipAddress: opts.ip,
    details: {
      ...(opts.service ? { service: opts.service } : {}),
      reason: opts.reason,
      attempts_remaining: attemptsRemaining,
    },
  });
  return {
    status: 401,
    body: {
      error: 'Invalid credentials',
      attempts_remaining: attemptsRemaining,
      lockout_minutes: attemptsRemaining === 0 ? FAILED_LOGIN_LOCKOUT_MINUTES : undefined,
    },
  };
}

/**
 * Verifies a user's PIN under the per-user lock and synchronously revalidates the
 * stored credential hash, active status, and surface authorization at issuance so
 * an in-flight PIN reset or permission revocation cannot mint a stale token.
 */
export async function authenticatePinLogin<TExtra = undefined>(opts: {
  db: ReturnType<typeof getDatabase>;
  userId: string;
  rawPin: string;
  ip: string;
  remember: boolean;
  service?: 'kds' | 'server-app';
  authorizeUser?: (
    db: ReturnType<typeof getDatabase>,
    user: PinAuthUserRow,
  ) => PinSurfaceAuthorizeResult<TExtra>;
}): Promise<
  | { status: 401 | 403 | 429 | 500; body: Record<string, unknown> }
  | { status: 200; token: string; user: PinAuthUserRow; extra: TExtra }
> {
  const canonicalIp = normalizeIpForPinRateLimit(opts.ip);
  const pinRateKey = `${canonicalIp}:pin:${opts.userId}`;
  const pinLockKey = `pin-user:${opts.userId}`;

  type VerificationOutcome =
    | { status: 401 | 403 | 429 | 500; body: Record<string, unknown> }
    | { status: 200; verifiedPinHash: string };

  const verificationResult = await withPinVerificationLock<VerificationOutcome>(
    pinLockKey,
    async () => {
      const ipRateLimit = checkLoginRateLimit(pinRateKey);
      if (!ipRateLimit.allowed) {
        const waitMinutes = ipRateLimit.waitMinutes || 0;
        recordAuthAudit(opts.db, {
          userId: opts.userId,
          eventType: 'pin_login',
          outcome: 'rate_limited',
          ipAddress: opts.ip,
          details: {
            ...(opts.service ? { service: opts.service } : {}),
            wait_minutes: waitMinutes,
          },
        });
        return {
          status: 429,
          body: {
            error: `Too many failed attempts. Try again in ${waitMinutes} minutes.`,
          },
        };
      }

      if (!/^\d{4,6}$/.test(opts.rawPin)) {
        return buildInvalidPinCredentialsResult(opts.db, {
          userId: opts.userId,
          ip: opts.ip,
          pinRateKey,
          service: opts.service,
          reason: 'invalid_pin_format',
        });
      }

      const initialUser = opts.db.prepare('SELECT * FROM users WHERE id = ?').get(opts.userId) as
        | PinAuthUserRow
        | undefined;
      const verifiedPinHash = initialUser?.pin_hash ?? null;
      let pinMatches = false;
      if (initialUser && initialUser.is_active === 1 && verifiedPinHash) {
        try {
          pinMatches = await verifyPinAsync(verifiedPinHash, opts.rawPin);
        } catch {
          pinMatches = false;
        }
      }

      const currentUser = opts.db.prepare('SELECT * FROM users WHERE id = ?').get(opts.userId) as
        | PinAuthUserRow
        | undefined;
      if (
        !currentUser ||
        currentUser.is_active !== 1 ||
        !currentUser.pin_hash ||
        !verifiedPinHash ||
        currentUser.pin_hash !== verifiedPinHash ||
        !pinMatches
      ) {
        const reason = !currentUser
          ? 'user_not_found'
          : currentUser.is_active !== 1
            ? 'user_inactive'
            : !currentUser.pin_hash
              ? 'pin_not_set'
              : !pinMatches
                ? 'invalid_pin'
                : 'pin_changed';
        return buildInvalidPinCredentialsResult(opts.db, {
          userId: opts.userId,
          ip: opts.ip,
          pinRateKey,
          service: opts.service,
          reason,
        });
      }

      if (opts.authorizeUser) {
        const authz = opts.authorizeUser(opts.db, currentUser);
        if (!authz.ok) {
          return { status: authz.status, body: authz.body };
        }
      }

      return { status: 200, verifiedPinHash };
    },
  );

  if (verificationResult.status !== 200) {
    return verificationResult;
  }

  // Revalidate synchronously against live SQLite state right at token issuance
  // with zero intervening awaits between the check and jwt.sign.
  const issuedUser = opts.db.prepare('SELECT * FROM users WHERE id = ?').get(opts.userId) as
    | PinAuthUserRow
    | undefined;
  if (
    !issuedUser ||
    issuedUser.is_active !== 1 ||
    !issuedUser.pin_hash ||
    issuedUser.pin_hash !== verificationResult.verifiedPinHash
  ) {
    const reason = !issuedUser
      ? 'user_not_found'
      : issuedUser.is_active !== 1
        ? 'user_inactive'
        : !issuedUser.pin_hash
          ? 'pin_not_set'
          : 'pin_changed';
    return buildInvalidPinCredentialsResult(opts.db, {
      userId: opts.userId,
      ip: opts.ip,
      pinRateKey,
      service: opts.service,
      reason,
    });
  }

  let extra = undefined as TExtra;
  if (opts.authorizeUser) {
    const authz = opts.authorizeUser(opts.db, issuedUser);
    if (!authz.ok) {
      return { status: authz.status, body: authz.body };
    }
    extra = authz.extra;
  }

  resetSuccessfulLogin(pinRateKey);
  recordAuthAudit(opts.db, {
    userId: issuedUser.id,
    eventType: 'pin_login',
    outcome: 'success',
    ipAddress: opts.ip,
    details: {
      ...(opts.service ? { service: opts.service } : {}),
      role: issuedUser.role,
    },
  });

  const token = jwt.sign(
    {
      userId: issuedUser.id,
      email: issuedUser.email,
      role: issuedUser.role,
      remember: opts.remember,
      jti: randomUUID(),
      iat: nextTokenIatSeconds(),
      exp: tokenExpSeconds(opts.remember),
    },
    getJWTSecret(),
  );

  return { status: 200, token, user: issuedUser, extra };
}

router.post(
  '/pin-login',
  authRateLimit({
    max: 600,
    skipSuccessfulRequests: true,
    onRateLimited: (req: Request) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rawUserId = req.body?.user_id;
      const userId = typeof rawUserId === 'string' && rawUserId.trim() ? rawUserId.trim() : null;
      recordAuthAudit(getDatabase(), {
        userId,
        eventType: 'pin_login',
        outcome: 'rate_limited',
        ipAddress: ip,
        details: { reason: 'endpoint_rate_limited' },
      });
    },
  }),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const { user_id, pin, rememberMe } = req.body || {};
      const userId = typeof user_id === 'string' ? user_id.trim() : '';
      const rawPin = typeof pin === 'string' || typeof pin === 'number' ? String(pin) : '';

      const db = getDatabase();
      if (!userId || !rawPin) {
        recordAuthAudit(db, {
          userId: userId || null,
          eventType: 'pin_login',
          outcome: 'failure',
          ipAddress: ip,
          details: {
            reason:
              !userId && !rawPin
                ? 'missing_credentials'
                : !userId
                  ? 'missing_user_id'
                  : 'missing_pin',
          },
        });
        return res.status(400).json({ error: 'user_id and pin are required' });
      }

      const remember = !!rememberMe;
      const result = await authenticatePinLogin({
        db,
        userId,
        rawPin,
        ip,
        remember,
      });

      if (result.status !== 200) {
        return res.status(result.status).json(result.body);
      }

      const { token, user } = result;
      const tenant = buildLocalTenant(db, user.id, user.role);

      res.json({
        access_token: token,
        token_type: 'bearer',
        expires_in: expiresInSecondsFor(remember),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          has_pin: Boolean(user.pin_hash),
          category_ids: parseCategoryIds(user.category_ids),
        },
        tenant,
        tenants: [tenant],
      });
    } catch (error: unknown) {
      res.locals.postHogError = error;
      console.error('[Auth] PIN login error:', error);
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }),
);

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
    const user = db
      .prepare(
        'SELECT id, name, email, role, is_active, tokens_valid_after FROM users WHERE id = ?',
      )
      .get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const tenant = buildLocalTenant(db, user.id, user.role);

    // Re-issue token with tenant context embedded (same payload — desktop is single-tenant)
    const remember = !!decoded.remember;
    const newToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        tenantId: 1,
        remember,
        jti: randomUUID(),
        iat: nextTokenIatSeconds(),
        exp: tokenExpSeconds(remember),
      },
      getJWTSecret(),
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
    const user = db
      .prepare('SELECT role, is_active, tokens_valid_after FROM users WHERE id = ?')
      .get(decoded.userId) as any;
    if (!user || user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const remember = !!decoded.remember;
    const newToken = jwt.sign(
      {
        userId: decoded.userId,
        email: decoded.email,
        role: user.role,
        tenantId: decoded.tenantId,
        remember,
        jti: randomUUID(),
        iat: nextTokenIatSeconds(),
        exp: tokenExpSeconds(remember),
      },
      getJWTSecret(),
    );

    res.json({
      access_token: newToken,
      token_type: 'bearer',
      expires_in: expiresInSecondsFor(remember),
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
    const user = db
      .prepare(
        'SELECT id, name, email, role, pin_hash, is_active, tokens_valid_after FROM users WHERE id = ?',
      )
      .get(decoded.userId) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const tenant = buildLocalTenant(db, user.id, user.role);

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        has_pin: Boolean(user.pin_hash),
      },
      tenants: [tenant],
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── POST /api/auth/password/change ────────────────────────────────────────────

function isSessionLiveAtCommit(
  db: ReturnType<typeof getDatabase>,
  token: string,
  decoded: { userId?: unknown; iat?: unknown; exp?: unknown },
): boolean {
  if (isTokenRevoked(token)) return false;
  if (typeof decoded.exp === 'number' && decoded.exp <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const latestUser = db
    .prepare('SELECT is_active, tokens_valid_after FROM users WHERE id = ?')
    .get(decoded.userId) as { is_active: number; tokens_valid_after: string | null } | undefined;
  return Boolean(
    latestUser &&
    latestUser.is_active === 1 &&
    !isTokenStale(
      typeof decoded.iat === 'number' ? decoded.iat : undefined,
      latestUser.tokens_valid_after,
    ),
  );
}

export async function handlePasswordChange(req: Request, res: Response): Promise<void> {
  try {
    const { current_password, password } = req.body || {};
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    let decoded: any;
    try {
      decoded = jwt.verify(token, getJWTSecret());
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const db = getDatabase();
    const initialUser = db
      .prepare('SELECT id, is_active, tokens_valid_after FROM users WHERE id = ?')
      .get(decoded.userId) as any;
    if (!initialUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (initialUser.is_active !== 1 || isTokenStale(decoded.iat, initialUser.tokens_valid_after)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    type PasswordChangeOutcome = { status: number; body: Record<string, unknown> };
    const outcome = await withPinVerificationLock<PasswordChangeOutcome>(
      `password-change:${initialUser.id}`,
      async () => {
        if (!isSessionLiveAtCommit(db, token, decoded)) {
          return { status: 401, body: { error: 'Invalid token' } };
        }
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(initialUser.id) as any;
        if (!user) {
          return { status: 404, body: { error: 'User not found' } };
        }
        if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
          return { status: 401, body: { error: 'Invalid token' } };
        }

        const passwordChangeRateLimit = checkPasswordChangeRateLimit(user.id);
        if (!passwordChangeRateLimit.allowed) {
          return {
            status: 429,
            body: {
              error: `Too many password change attempts. Try again in ${passwordChangeRateLimit.waitMinutes} minutes.`,
            },
          };
        }

        if (typeof current_password !== 'string' || !current_password) {
          return { status: 400, body: { error: 'Current password is required' } };
        }
        if (typeof password !== 'string' || !password) {
          return { status: 400, body: { error: 'Password is required' } };
        }
        const passwordMatches = await bcrypt.compare(current_password, user.password);
        if (!passwordMatches) {
          const attemptsRemaining = incrementFailedPasswordChange(user.id);
          return {
            status: 400,
            body: {
              error: 'Current password is incorrect',
              attempts_remaining: attemptsRemaining,
              lockout_minutes:
                attemptsRemaining === 0 ? PASSWORD_CHANGE_LOCKOUT_MINUTES : undefined,
            },
          };
        }
        resetPasswordChangeRateLimit(user.id);
        if (!validatePassword(password)) {
          return {
            status: 400,
            body: {
              error: PASSWORD_POLICY_MESSAGE,
            },
          };
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const changedAt = now();
        const tokensValidAfter = nextTokensValidAfterTimestamp();
        const commitOutcome = db.transaction((): 'ok' | 'invalid_token' | 'conflict' => {
          if (!isSessionLiveAtCommit(db, token, decoded)) {
            return 'invalid_token';
          }
          const updateResult = db
            .prepare(
              'UPDATE users SET password = ?, tokens_valid_after = ?, updated_at = ? WHERE id = ? AND tokens_valid_after IS ? AND password = ?',
            )
            .run(
              hashedPassword,
              tokensValidAfter,
              changedAt,
              user.id,
              user.tokens_valid_after ?? null,
              user.password,
            );
          if (updateResult.changes === 0) {
            return isSessionLiveAtCommit(db, token, decoded) ? 'conflict' : 'invalid_token';
          }
          return 'ok';
        })();

        if (commitOutcome === 'invalid_token') {
          return { status: 401, body: { error: 'Invalid token' } };
        }
        if (commitOutcome === 'conflict') {
          return { status: 409, body: { error: 'Credentials were modified concurrently' } };
        }
        invalidateUserAuthCache(user.id);

        const committedUser =
          (db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(user.id) as
            | { id: string; email: string; role: string }
            | undefined) ?? user;
        const freshToken = signFreshSessionToken(committedUser, decoded);
        return {
          status: 200,
          body: { message: 'Password changed successfully', token: freshToken },
        };
      },
    );

    res.status(outcome.status).json(outcome.body);
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/password/change', authRateLimit(), asyncHandler(handlePasswordChange));

// ── POST /api/auth/pin/change ─────────────────────────────────────────────────

export async function handlePinChange(req: Request, res: Response): Promise<void> {
  try {
    const { current_pin, current_password, pin } = req.body || {};
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    let decoded: any;
    try {
      decoded = jwt.verify(token, getJWTSecret());
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const db = getDatabase();
    const initialUser = db
      .prepare('SELECT id, is_active, tokens_valid_after FROM users WHERE id = ?')
      .get(decoded.userId) as any;
    if (!initialUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (initialUser.is_active !== 1 || isTokenStale(decoded.iat, initialUser.tokens_valid_after)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    type PinChangeOutcome = { status: number; body: Record<string, unknown> };
    const outcome = await withPinVerificationLock<PinChangeOutcome>(
      `pin-change:${initialUser.id}`,
      async () => {
        if (!isSessionLiveAtCommit(db, token, decoded)) {
          return { status: 401, body: { error: 'Invalid token' } };
        }
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(initialUser.id) as any;
        if (!user) {
          return { status: 404, body: { error: 'User not found' } };
        }
        if (user.is_active !== 1 || isTokenStale(decoded.iat, user.tokens_valid_after)) {
          return { status: 401, body: { error: 'Invalid token' } };
        }

        const pinChangeRateLimit = checkPinChangeRateLimit(user.id);
        if (!pinChangeRateLimit.allowed) {
          return {
            status: 429,
            body: {
              error: `Too many PIN change attempts. Try again in ${pinChangeRateLimit.waitMinutes} minutes.`,
            },
          };
        }

        const rawPin = typeof pin === 'string' || typeof pin === 'number' ? String(pin) : '';
        if (user.pin_hash) {
          if (typeof current_pin !== 'string' || !current_pin) {
            return { status: 400, body: { error: 'Current PIN is required' } };
          }
          if (!rawPin) {
            return { status: 400, body: { error: 'PIN is required' } };
          }
          let pinMatches = false;
          if (current_pin.length <= 64) {
            try {
              pinMatches = await verifyPinAsync(user.pin_hash, current_pin);
            } catch {
              pinMatches = false;
            }
          }
          if (!pinMatches) {
            const attemptsRemaining = incrementFailedPinChange(user.id);
            return {
              status: 400,
              body: {
                error: 'Current PIN is incorrect',
                attempts_remaining: attemptsRemaining,
                lockout_minutes: attemptsRemaining === 0 ? PIN_CHANGE_LOCKOUT_MINUTES : undefined,
              },
            };
          }
        } else {
          if (typeof current_password !== 'string' || !current_password) {
            return { status: 400, body: { error: 'Current password is required to set a PIN' } };
          }
          if (!rawPin) {
            return { status: 400, body: { error: 'PIN is required' } };
          }
          let passwordMatches = false;
          try {
            passwordMatches = await bcrypt.compare(current_password, user.password);
          } catch {
            passwordMatches = false;
          }
          if (!passwordMatches) {
            const attemptsRemaining = incrementFailedPinChange(user.id);
            return {
              status: 400,
              body: {
                error: 'Current password is incorrect',
                attempts_remaining: attemptsRemaining,
                lockout_minutes: attemptsRemaining === 0 ? PIN_CHANGE_LOCKOUT_MINUTES : undefined,
              },
            };
          }
        }

        resetPinChangeRateLimit(user.id);

        if (!/^\d{4,6}$/.test(rawPin)) {
          return {
            status: 400,
            body: { error: 'PIN must be between 4 and 6 numeric digits' },
          };
        }

        const hashedPin = await bcrypt.hash(rawPin, 10);
        const changedAt = now();
        const tokensValidAfter = nextTokensValidAfterTimestamp();
        const commitOutcome = db.transaction((): 'ok' | 'invalid_token' | 'conflict' => {
          if (!isSessionLiveAtCommit(db, token, decoded)) {
            return 'invalid_token';
          }
          const updateResult = db
            .prepare(
              'UPDATE users SET pin_hash = ?, tokens_valid_after = ?, updated_at = ? WHERE id = ? AND tokens_valid_after IS ? AND pin_hash IS ?',
            )
            .run(
              hashedPin,
              tokensValidAfter,
              changedAt,
              user.id,
              user.tokens_valid_after ?? null,
              user.pin_hash ?? null,
            );
          if (updateResult.changes === 0) {
            return isSessionLiveAtCommit(db, token, decoded) ? 'conflict' : 'invalid_token';
          }
          return 'ok';
        })();

        if (commitOutcome === 'invalid_token') {
          return { status: 401, body: { error: 'Invalid token' } };
        }
        if (commitOutcome === 'conflict') {
          return { status: 409, body: { error: 'Credentials were modified concurrently' } };
        }
        invalidateUserAuthCache(user.id);

        const committedUser =
          (db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(user.id) as
            | { id: string; email: string; role: string }
            | undefined) ?? user;
        const freshToken = signFreshSessionToken(committedUser, decoded);
        return {
          status: 200,
          body: {
            message: 'PIN changed successfully',
            has_pin: true,
            token: freshToken,
          },
        };
      },
    );

    res.status(outcome.status).json(outcome.body);
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/pin/change', authRateLimit(), asyncHandler(handlePinChange));

/** Writes the recovered password and audit trail; shared by Master PIN and cloud email recovery. */
function applyOwnerRecovery(
  db: ReturnType<typeof getDatabase>,
  user: { id: string },
  newPassword: string,
  via: string,
): { ok: true; restoredOwnerAccess: boolean } | { ok: false } {
  const hashedPassword = bcrypt.hashSync(newPassword, 10);
  const changedAt = now();
  const tokensValidAfter = nextTokensValidAfterTimestamp();
  let restoredOwnerAccess = false;
  const updated = db.transaction(() => {
    // Re-checked in the transaction, so a concurrent write cannot turn a
    // plain reset into a promotion.
    if (via === 'FloAdmin email approval' || hasActiveAdministrator()) {
      return db
        .prepare(
          'UPDATE users SET password = ?, tokens_valid_after = ?, updated_at = ? WHERE id = ? AND role = ? AND is_active = 1',
        )
        .run(hashedPassword, tokensValidAfter, changedAt, user.id, INITIAL_ADMIN_ROLE);
    }

    restoredOwnerAccess = true;
    return db
      .prepare(`
        UPDATE users SET password = ?, role = ?, tokens_valid_after = ?, updated_at = ?
        WHERE id = ? AND is_active = 1
      `)
      .run(hashedPassword, INITIAL_ADMIN_ROLE, tokensValidAfter, changedAt, user.id);
  })();
  if (updated.changes === 0) {
    const failure = serializeOperationFailure({
      capture_point: 'fc.backend.auth.recovery.owner_state_changed',
      outcome: 'not_applied',
    });
    try {
      if (failure) cloudSync.captureOperationFailure(failure);
    } catch {
      // Diagnostics cannot change the recovery conflict response.
    }
    return { ok: false };
  }
  invalidateUserAuthCache(user.id);

  upsertSettings(db, {
    last_password_recovery_at: now(),
    last_password_recovery_user_id: String(user.id),
    ...(restoredOwnerAccess
      ? {
          last_owner_recovery_at: now(),
          last_owner_recovery_user_id: String(user.id),
        }
      : {}),
  });
  console.warn(
    `[Auth] Password recovery: ${restoredOwnerAccess ? 'owner access' : 'owner password'} was reset locally via ${via} for user ${user.id}`,
  );
  return { ok: true, restoredOwnerAccess };
}

// ── POST /api/auth/recover-password ───────────────────────────────────────────
// Local password recovery for locked-out owner gated by Master PIN; requires no active JWT.

router.post('/recover-password', authRateLimit(), (req: Request, res: Response) => {
  try {
    if (!requireLocalSetup(req, res)) return;
    const db = getDatabase();

    // First-run setup is the only recovery path when there is no owner yet —
    // never let this endpoint substitute for /setup/initialize.
    if (getUserCount(db) === 0) {
      return res.status(409).json({
        error: 'Setup has not been completed yet. Use first-run setup to create the owner account.',
      });
    }

    const email = normalizeEmail(req.body?.email);
    const { master_pin, new_password } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!new_password || !validatePassword(new_password)) {
      return res.status(400).json({
        error: PASSWORD_POLICY_MESSAGE,
      });
    }

    // Rate-limit key is IP-scoped to prevent resetting attempt counters with varying emails.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const pinResult = authorizeMasterPin(master_pin, `master-pin:${normalizeIpForRateLimit(ip)}`);
    if (!pinResult.ok) {
      return res.status(pinResult.status).json({ error: pinResult.error });
    }

    // Owners alone can hold the protected permissions, so a store whose active
    // owners are all denied the configurable administrative capabilities strands.
    const stranded = !hasActiveAdministrator();
    const user = stranded
      ? (db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as any)
      : (db
          .prepare('SELECT * FROM users WHERE email = ? AND role = ? AND is_active = 1')
          .get(email, INITIAL_ADMIN_ROLE) as any);
    if (!user) {
      return res.status(404).json({
        error: stranded
          ? 'No active account found with that email on this install'
          : 'No active owner account found with that email on this install',
      });
    }

    const recovery = applyOwnerRecovery(db, user, new_password, 'Master PIN');
    if (!recovery.ok) {
      return res.status(409).json({ error: 'Owner access changed during recovery. Try again.' });
    }
    const { restoredOwnerAccess } = recovery;

    res.json({
      message: restoredOwnerAccess
        ? 'Owner access restored. You can now log in with your new password.'
        : 'Password reset successfully. You can now log in with your new password.',
    });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[Auth] Password recovery error:', error);
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Cloud email recovery (FloAdmin) ───────────────────────────────────────────
// The owner approves a reset from the email FloAdmin sends; the new password is
// chosen and stored here and never leaves this device.

const RESET_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function cloudRecoveryPrecheck(req: Request, res: Response): boolean {
  if (!requireLocalSetup(req, res)) return false;
  if (getUserCount(getDatabase()) === 0) {
    res.status(409).json({
      error: 'Setup has not been completed yet. Use first-run setup to create the owner account.',
    });
    return false;
  }
  if (!cloudSync.isEmailRecoveryAvailable()) {
    res.status(409).json({ error: 'Email recovery is not available on this install.' });
    return false;
  }
  return true;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return local && domain ? `${local[0]}***@${domain}` : '';
}

function sendCloudRecoveryFailure(res: Response, error: unknown) {
  if (error instanceof CloudRequestError) {
    if (error.status === 429) {
      return res.status(429).json({ error: 'Too many reset requests. Try again later.' });
    }
    if (error.status === 409) {
      return res.status(409).json({ error: 'Email recovery is not available on this install.' });
    }
    if (error.status === 404) {
      return res.status(404).json({ error: 'Reset request not found.' });
    }
  }
  console.error('[Auth] Cloud password recovery error:', error);
  return res.status(502).json({ error: 'Could not reach FloAdmin.' });
}

router.post(
  '/recover-password/cloud/request',
  authRateLimit(),
  asyncHandler(async (req: Request, res: Response) => {
    if (!cloudRecoveryPrecheck(req, res)) return;
    const email = cloudSync.getRegisteredOwnerEmail();
    const owner = getDatabase()
      .prepare('SELECT id FROM users WHERE lower(email) = ? AND role = ? AND is_active = 1')
      .get(email, INITIAL_ADMIN_ROLE);
    if (!owner) {
      return res.status(409).json({ error: 'Email recovery is not available on this install.' });
    }
    try {
      const signal = getHttpRequestSignal(req);
      // An unverified owner email gets the verification email first; the reset follows once verified.
      if (!(await cloudSync.ensureOwnerEmailVerification(signal))) {
        return res.status(202).json({
          step: 'verify_email',
          email_hint: maskEmail(email),
        });
      }
      const data = await cloudSync.requestPasswordReset(signal);
      res.status(202).json({
        step: 'reset',
        reset_id: String(data.reset_id || ''),
        expires_at: typeof data.expires_at === 'string' ? data.expires_at : null,
        email_hint: typeof data.email_hint === 'string' ? data.email_hint : null,
      });
    } catch (error) {
      sendCloudRecoveryFailure(res, error);
    }
  }),
);

router.get(
  '/recover-password/cloud/verification',
  authRateLimit({ max: 600 }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!cloudRecoveryPrecheck(req, res)) return;
    try {
      res.json({ verified: await cloudSync.isOwnerEmailVerified(getHttpRequestSignal(req)) });
    } catch (error) {
      sendCloudRecoveryFailure(res, error);
    }
  }),
);

router.get(
  '/recover-password/cloud/status',
  authRateLimit({ max: 600 }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!cloudRecoveryPrecheck(req, res)) return;
    const resetId = String(req.query.reset_id || '');
    if (!RESET_ID_PATTERN.test(resetId)) {
      return res.status(400).json({ error: 'A valid reset_id is required' });
    }
    try {
      const data = await cloudSync.getPasswordResetStatus(resetId, getHttpRequestSignal(req));
      res.json({ status: String(data.status || 'pending') });
    } catch (error) {
      sendCloudRecoveryFailure(res, error);
    }
  }),
);

router.post(
  '/recover-password/cloud/complete',
  authRateLimit(),
  asyncHandler(async (req: Request, res: Response) => {
    if (!cloudRecoveryPrecheck(req, res)) return;
    const db = getDatabase();
    const resetId = String(req.body?.reset_id || '');
    const newPassword = req.body?.new_password;
    if (!RESET_ID_PATTERN.test(resetId)) {
      return res.status(400).json({ error: 'A valid reset_id is required' });
    }
    if (!newPassword || !validatePassword(newPassword)) {
      return res.status(400).json({
        error: PASSWORD_POLICY_MESSAGE,
      });
    }

    // Resolve the account before consuming the single-use grant.
    const email = cloudSync.getRegisteredOwnerEmail();
    const user = db
      .prepare('SELECT * FROM users WHERE lower(email) = ? AND role = ? AND is_active = 1')
      .get(email, INITIAL_ADMIN_ROLE) as any;
    if (!user) {
      return res
        .status(404)
        .json({ error: 'No active owner account matches the registered email.' });
    }

    try {
      await cloudSync.redeemPasswordReset(resetId, getHttpRequestSignal(req));
    } catch (error) {
      if (error instanceof CloudRequestError && error.status === 409) {
        return res.status(409).json({ error: 'This reset has not been approved or has expired.' });
      }
      return sendCloudRecoveryFailure(res, error);
    }

    const recovery = applyOwnerRecovery(db, user, newPassword, 'FloAdmin email approval');
    if (!recovery.ok) {
      return res.status(409).json({
        error:
          'Owner access changed during recovery. This reset approval was used and cannot be reused. Request a new password reset.',
      });
    }
    res.json({
      message: recovery.restoredOwnerAccess
        ? 'Owner access restored. You can now log in with your new password.'
        : 'Password reset successfully. You can now log in with your new password.',
    });
  }),
);

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
      cloudRecoveryAvailable: cloudSync.isEmailRecoveryAvailable(),
      currencyReset,
    });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/setup/restore ────────────────────────────────────────────────
// A brand-new install has no accounts to authorise against and nothing to lose,
// so the POS computer may restore a backup before the first sign-in.

router.post(
  '/setup/restore',
  authRateLimit(),
  asyncHandler(async (req: Request, res: Response) => {
    if (!requireLocalSetup(req, res)) return;
    if (getUserCount(getDatabase()) > 0) {
      return res.status(403).json({ error: 'Sign in to restore a backup on an existing install.' });
    }
    return handleRestoreFromPickedFile(req, res);
  }),
);

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
      instagram_handle,
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
      product_analytics_level,
    } = req.body;
    // Without a choice the store shares anonymously and the owner is asked after setup.
    const analyticsLevel = parseProductAnalyticsLevel(product_analytics_level);
    const telemetryChoice = analyticsLevel === 'off' ? 'false' : 'true';
    const email = normalizeEmail(req.body.email);
    // Regional settings come from signup, never from a fallback — see
    // docs/reference/product-invariants.md. There is no default country.
    const resolvedCountry = typeof country === 'string' ? getCountryByCode(country) : undefined;
    if (!resolvedCountry) {
      return res.status(400).json({ error: 'A valid country is required' });
    }
    const displayName = String(name || '').trim();
    const normalizedBusinessType = String(business_type || 'restaurant').trim();
    const normalizedSetupProfile = String(setup_profile || 'express')
      .trim()
      .toLowerCase();
    const normalizedServiceModel = String(service_model || 'qsr')
      .trim()
      .toLowerCase();
    // Omitted currency derives from the country profile; an explicitly-invalid
    // one is rejected rather than silently replaced (resolveTenantCurrency's
    // read-time leniency is the wrong tool for validating a write).
    const normalizedCurrency =
      currency === undefined
        ? resolvedCountry.currency
        : typeof currency === 'string'
          ? currency.trim().toUpperCase()
          : currency;
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
      return res.status(400).json({
        error: PASSWORD_POLICY_MESSAGE,
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    if (terms_accepted !== true) {
      return res.status(400).json({
        error:
          'You must accept the Terms and Conditions, Privacy Policy, and No Warranty Disclaimer to continue.',
      });
    }

    const masterPinRequired = isMasterPinAvailable();
    if (masterPinRequired && !/^\d{4}$/.test(String(master_pin || ''))) {
      return res.status(400).json({ error: 'A 4-digit Master PIN is required to complete setup' });
    }

    const ownerApprovalPin = String(owner_approval_pin || '');
    if (!/^\d{4,6}$/.test(ownerApprovalPin)) {
      return res
        .status(400)
        .json({ error: 'A 4-6 digit owner Approval PIN is required to complete setup' });
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
        normalizedCloudServerUrl = normalizeCloudServerUrl(
          cloud_server_url || DEFAULT_CLOUD_SERVER_URL,
        );
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
      `).run(
        userId,
        displayName,
        email,
        hashedPassword,
        INITIAL_ADMIN_ROLE,
        hashedApprovalPin,
        1,
        now(),
        now(),
        now(),
      );

      upsertSettings(db, {
        business_name: resolvedStoreName,
        business_type: normalizedBusinessType,
        country: resolvedCountry.code,
        currency: normalizedCurrency,
        currency_symbol:
          currency_symbol || getCurrencySymbol(normalizedCurrency, resolvedCountry.locale),
        timezone: resolvedTimezone,
        language,
        business_address: outletAddress,
        business_phone: outletPhone,
        address: outletAddress,
        phone: outletPhone,
        instagram_handle: String(instagram_handle || '')
          .trim()
          .slice(0, 100),
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
        ...countryConfirmationPatch(
          resolvedCountry.code,
          getSettingValue('country'),
          req.body.country_selected,
        ),
        anonymous_data_consent: telemetryChoice,
        telemetry_enabled: telemetryChoice,
        ...(analyticsLevel ? { [PRODUCT_ANALYTICS_LEVEL_SETTING]: analyticsLevel } : {}),
        telemetry_scope:
          'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics',
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
        seedSetupProfile(
          db,
          normalizedSetupProfile,
          normalizedServiceModel,
          language,
          resolvedCountry.code,
        );
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
    syncPostHogIdentity();
    capturePostHogUsage('setup_completed', {
      setup_profile: normalizedSetupProfile,
      service_model: normalizedServiceModel,
      business_type,
    });

    const token = jwt.sign(
      {
        userId,
        email,
        role: INITIAL_ADMIN_ROLE,
        jti: randomUUID(),
        iat: nextTokenIatSeconds(),
        exp: tokenExpSeconds(false),
      },
      getJWTSecret(),
    );

    const tenant = buildLocalTenant(db, userId, INITIAL_ADMIN_ROLE);

    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: JWT_EXPIRES_IN_SECONDS,
      user: { id: userId, name: displayName, email, role: INITIAL_ADMIN_ROLE, has_pin: true },
      tenant,
      tenants: [tenant],
    });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[Auth] Setup error:', error);
    const message = error.message || 'Setup failed';
    const status = message.includes('already complete')
      ? 403
      : message.includes('already exists')
        ? 400
        : 500;
    res.status(status).json({ error: status === 500 ? 'Setup failed' : message });
  }
});

// ── POST /api/auth/setup/seed ───────────────────────────────────────────────────
// Legacy endpoint retained to direct callers to /api/auth/setup/initialize.

router.post('/setup/seed', (req: Request, res: Response) => {
  res
    .status(410)
    .json({ error: 'Use /api/auth/setup/initialize with setup_profile and owner details.' });
});

export const authRoutes = router;
