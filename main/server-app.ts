import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import expressRateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import {
  closeServerResources,
  createShutdownCancellationError,
  getHttpRequestSignal,
  installHttpShutdownTracking,
  trackHttpRequestWork,
} from './shutdown';
import {
  DatabaseAdmissionReservation,
  createDatabaseMaintenanceHandoff,
  databaseMaintenanceMiddleware,
  getDatabase,
  isServerAppEnabled,
  isServerBillPrintingEnabled,
  recordAuthAudit,
  revokeDatabaseMaintenanceHandoff,
  verifyPinAsync,
} from './db';
import { getJWTSecret } from './security/jwt-secret';
import { asyncHandler } from './middleware/async-handler';
import { handlePasswordChange, handlePinChange } from './routes/auth';
import {
  authRateLimit,
  loginAuthRateLimit,
  checkLoginRateLimit,
  incrementFailedLogin,
  resetSuccessfulLogin,
  FAILED_LOGIN_LOCKOUT_MINUTES,
  normalizeIpForPinRateLimit,
  withPinVerificationLock,
  staticRouteRateLimit,
  corsOptions,
  isTokenRevoked,
  isTokenStale,
  nextTokenIatSeconds,
  rateLimit,
  revokeToken,
} from './middleware/security';
import { getServerPort } from './server';
import {
  getDefaultServerAppPort,
  getServerAppPort as getActiveServerAppPort,
  setServerAppPort,
} from './server-app-state';
import { API_JSON_BODY_LIMIT } from './http-limits';
import { buildCspHeader } from './csp';
import { readPosSortSettings } from './lib/pos-sort';
import { resolveContainedPath } from './lib/path-containment';
import { RegionalNotConfiguredError, resolveRegionalSnapshot } from './countries';
import {
  effectivePermissionRevision,
  hasPermission,
  resolveEffectivePermissions,
} from './services/authorization';

let serverApp: http.Server | null = null;
let stopPromise: Promise<void> | null = null;
let startReject: ((error: Error) => void) | null = null;
let stopping = false;
const SERVER_APP_PORT = getDefaultServerAppPort();

type ServerAppUser = {
  userId: string;
  email?: string;
  role: string;
  iat?: number;
  exp?: number;
};

function normalizeEmail(email: unknown): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function isServerAppRunning(): boolean {
  return serverApp !== null;
}

function getStaticDir(): string | null {
  const candidates = [
    path.join(__dirname, '../../frontend/out'),
    path.join(process.resourcesPath || '', 'frontend-out'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

function rewriteNextExportPath(reqPath: string): string {
  const nextIndex = reqPath.indexOf('__next.');
  if (nextIndex === -1) return reqPath;

  const prefix = reqPath.substring(0, nextIndex + '__next.'.length);
  const rest = reqPath.substring(nextIndex + '__next.'.length);
  const lastDotIndex = rest.lastIndexOf('.');
  if (lastDotIndex === -1) return reqPath;

  return (
    prefix + rest.substring(0, lastDotIndex).replace(/\./g, '/') + rest.substring(lastDotIndex)
  );
}

function requireServerAppAuth(req: Request, res: Response, next: NextFunction) {
  if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  if (isTokenRevoked(token)) return res.status(401).json({ error: 'Invalid token' });

  try {
    const decoded = jwt.verify(token, getJWTSecret()) as any;
    const db = getDatabase();
    const user = db
      .prepare(
        'SELECT id, email, role, tokens_valid_after FROM users WHERE id = ? AND is_active = 1',
      )
      .get(decoded.userId) as any;
    if (!user || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (!hasPermission(user.id, 'server-app.use')) {
      return res.status(403).json({
        error: 'Access denied. Only server, manager, or owner accounts allowed.',
        code: 'permission_denied',
      });
    }

    (req as any).user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      iat: decoded.iat,
      exp: decoded.exp,
    } satisfies ServerAppUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function forwardToMainApi(req: Request, res: Response, targetPath: string) {
  return trackHttpRequestWork(req, forwardToMainApiImpl(req, res, targetPath));
}

async function forwardToMainApiImpl(req: Request, res: Response, targetPath: string) {
  const target = new URL(`/api${targetPath}`, `http://127.0.0.1:${getServerPort()}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => target.searchParams.append(key, String(entry)));
    } else if (value !== undefined) {
      target.searchParams.set(key, String(value));
    }
  }

  const reservation = (req as any).databaseAdmissionReservation as
    | DatabaseAdmissionReservation
    | undefined;
  const handoffToken = reservation ? createDatabaseMaintenanceHandoff(reservation) : undefined;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.get('Idempotency-Key') ? { 'Idempotency-Key': req.get('Idempotency-Key')! } : {}),
        ...(handoffToken ? { 'x-flo-maintenance-handoff': handoffToken } : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: getHttpRequestSignal(req),
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(buffer);
  } catch (error: any) {
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[Server App] Main API forward failed:', error);
    res.status(502).json({ error: 'Could not reach the local POS API' });
  } finally {
    if (handoffToken) {
      revokeDatabaseMaintenanceHandoff(handoffToken);
    }
  }
}

export function startServerApp(): Promise<void> {
  stopPromise = null;
  stopping = false;
  return new Promise((resolve, reject) => {
    startReject = reject;
    const app: Express = express();

    app.use(cors(corsOptions));
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', buildCspHeader(req));
      next();
    });
    app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
    app.use((error: any, _req: Request, res: Response, next: NextFunction) => {
      if (error?.type === 'entity.too.large') {
        res.status(413).json({
          error: `Request body is too large. JSON imports are limited to ${API_JSON_BODY_LIMIT}; use Backup/Restore for full database migration.`,
        });
        return;
      }
      next(error);
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.body === undefined) req.body = {};
      next();
    });
    app.use(databaseMaintenanceMiddleware);
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 150 }));

    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'Flo Server App',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      });
    });

    const serverAppApiRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
    });

    app.get('/api/server-app/info', serverAppApiRateLimit, (_req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      const rows = getDatabase().prepare('SELECT key, value FROM settings').all() as {
        key: string;
        value: string;
      }[];
      const settings: Record<string, string> = {};
      for (const row of rows) settings[row.key] = row.value;
      let snapshot;
      try {
        snapshot = resolveRegionalSnapshot(settings);
      } catch (error) {
        if (error instanceof RegionalNotConfiguredError)
          return res.status(409).json({ error: 'regional_not_configured' });
        throw error;
      }
      res.json({
        language: settings.language || null,
        country: snapshot.country,
        currency: snapshot.currency,
        currency_symbol: snapshot.currencySymbol,
        currency_position: snapshot.currencyPosition,
        currency_fraction_digits: snapshot.currencyFractionDigits,
        kds_enabled: settings.kds_enabled !== 'false',
        ...readPosSortSettings(settings),
      });
    });

    app.post('/api/auth/login', loginAuthRateLimit(), (req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      try {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const loginLimiter = checkLoginRateLimit(ip);
        if (!loginLimiter.allowed) {
          return res.status(429).json({
            error: `Too many failed attempts. Try again in ${loginLimiter.waitMinutes} minutes.`,
          });
        }

        const email = normalizeEmail(req.body?.email);
        const { password, remember_me } = req.body;
        if (!email || !password)
          return res.status(400).json({ error: 'Email and password required' });

        const db = getDatabase();
        const bcrypt = require('bcryptjs');
        const user = db
          .prepare('SELECT * FROM users WHERE email = ? AND is_active = 1')
          .get(email) as any;
        let passwordMatches = false;
        if (user) {
          try {
            passwordMatches = bcrypt.compareSync(password, user.password);
          } catch {
            passwordMatches = false;
          }
        }
        if (!user || !passwordMatches) {
          const attemptsRemaining = incrementFailedLogin(ip);
          return res.status(401).json({
            error: 'Invalid credentials',
            attempts_remaining: attemptsRemaining,
            lockout_minutes: attemptsRemaining === 0 ? FAILED_LOGIN_LOCKOUT_MINUTES : undefined,
          });
        }

        if (!hasPermission(user.id, 'server-app.use')) {
          return res.status(403).json({
            error: 'Access denied. Only server, manager, or owner accounts allowed.',
            code: 'permission_denied',
          });
        }

        resetSuccessfulLogin(ip);

        const token = jwt.sign(
          {
            userId: user.id,
            email: user.email,
            role: user.role,
            jti: randomUUID(),
            iat: nextTokenIatSeconds(),
            exp: Math.floor(Date.now() / 1000) + (remember_me ? 10 * 24 * 60 * 60 : 86400),
          },
          getJWTSecret(),
        );

        res.json({
          access_token: token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            has_pin: Boolean(user.pin_hash),
            permission_ids: [...(resolveEffectivePermissions(user.id)?.permissionIds ?? [])],
            authorization_revision: effectivePermissionRevision(user.id),
          },
        });
      } catch (error: any) {
        console.error('[Server App] Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/auth/pin-users', authRateLimit({ max: 600 }), (_req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      try {
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

        const eligible = rows.filter((row) => hasPermission(row.id, 'server-app.use'));

        res.json({
          users: eligible.map((row) => ({
            id: String(row.id),
            name: String(row.name),
            role: String(row.role),
          })),
        });
      } catch (error: unknown) {
        console.error('[Server App] PIN users error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.post(
      '/api/auth/pin-login',
      authRateLimit({
        max: 600,
        skipSuccessfulRequests: true,
        onRateLimited: (req: Request) => {
          const ip = req.ip || req.socket.remoteAddress || 'unknown';
          const rawUserId = req.body?.user_id;
          const userId =
            typeof rawUserId === 'string' && rawUserId.trim() ? rawUserId.trim() : null;
          recordAuthAudit(getDatabase(), {
            userId,
            eventType: 'pin_login',
            outcome: 'rate_limited',
            ipAddress: ip,
            details: { reason: 'endpoint_rate_limited', service: 'server-app' },
          });
        },
      }),
      async (req: Request, res: Response) => {
        if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
        try {
          const ip = req.ip || req.socket.remoteAddress || 'unknown';
          const { user_id, pin, remember_me, rememberMe } = req.body || {};
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
                service: 'server-app',
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

          const canonicalIp = normalizeIpForPinRateLimit(ip);
          const pinRateKey = `${canonicalIp}:pin:${userId}`;
          const pinLockKey = `pin-user:${userId}`;
          type VerifiedServerAppUser = {
            id: string;
            name: string;
            email: string;
            role: string;
            is_active: number;
            pin_hash: string | null;
          };
          type ServerAppPinLoginOutcome =
            | { status: 429; body: Record<string, unknown> }
            | { status: 401; body: Record<string, unknown> }
            | { status: 403; body: Record<string, unknown> }
            | { status: 200; user: VerifiedServerAppUser };

          const verificationResult = await withPinVerificationLock<ServerAppPinLoginOutcome>(
            pinLockKey,
            async () => {
              const ipRateLimit = checkLoginRateLimit(pinRateKey);
              if (!ipRateLimit.allowed) {
                const waitMinutes = ipRateLimit.waitMinutes || 0;
                recordAuthAudit(db, {
                  userId,
                  eventType: 'pin_login',
                  outcome: 'rate_limited',
                  ipAddress: ip,
                  details: { service: 'server-app', wait_minutes: waitMinutes },
                });
                return {
                  status: 429,
                  body: {
                    error: `Too many failed attempts. Try again in ${waitMinutes} minutes.`,
                  },
                };
              }

              if (!/^\d{4,6}$/.test(rawPin)) {
                const attemptsRemaining = incrementFailedLogin(pinRateKey);
                recordAuthAudit(db, {
                  userId,
                  eventType: 'pin_login',
                  outcome: 'failure',
                  ipAddress: ip,
                  details: {
                    service: 'server-app',
                    reason: 'invalid_pin_format',
                    attempts_remaining: attemptsRemaining,
                  },
                });
                return {
                  status: 401,
                  body: {
                    error: 'Invalid credentials',
                    attempts_remaining: attemptsRemaining,
                    lockout_minutes:
                      attemptsRemaining === 0 ? FAILED_LOGIN_LOCKOUT_MINUTES : undefined,
                  },
                };
              }

              const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
                | VerifiedServerAppUser
                | undefined;
              let pinMatches = false;
              if (user && user.is_active === 1 && user.pin_hash) {
                try {
                  pinMatches = await verifyPinAsync(user.pin_hash, rawPin);
                } catch {
                  pinMatches = false;
                }
              }

              if (!user || user.is_active !== 1 || !user.pin_hash || !pinMatches) {
                const attemptsRemaining = incrementFailedLogin(pinRateKey);
                recordAuthAudit(db, {
                  userId,
                  eventType: 'pin_login',
                  outcome: 'failure',
                  ipAddress: ip,
                  details: {
                    service: 'server-app',
                    reason: !user
                      ? 'user_not_found'
                      : user.is_active !== 1
                        ? 'user_inactive'
                        : !user.pin_hash
                          ? 'pin_not_set'
                          : 'invalid_pin',
                    attempts_remaining: attemptsRemaining,
                  },
                });
                return {
                  status: 401,
                  body: {
                    error: 'Invalid credentials',
                    attempts_remaining: attemptsRemaining,
                    lockout_minutes:
                      attemptsRemaining === 0 ? FAILED_LOGIN_LOCKOUT_MINUTES : undefined,
                  },
                };
              }

              if (!hasPermission(user.id, 'server-app.use')) {
                recordAuthAudit(db, {
                  userId: user.id,
                  eventType: 'pin_login',
                  outcome: 'failure',
                  ipAddress: ip,
                  details: { service: 'server-app', reason: 'permission_denied' },
                });
                return {
                  status: 403,
                  body: {
                    error: 'Access denied. Only server, manager, or owner accounts allowed.',
                    code: 'permission_denied',
                  },
                };
              }

              resetSuccessfulLogin(pinRateKey);
              recordAuthAudit(db, {
                userId: user.id,
                eventType: 'pin_login',
                outcome: 'success',
                ipAddress: ip,
                details: { service: 'server-app', role: user.role },
              });
              return { status: 200, user };
            },
          );

          if (verificationResult.status !== 200) {
            return res.status(verificationResult.status).json(verificationResult.body);
          }

          const { user } = verificationResult;
          const remember = !!(remember_me ?? rememberMe);
          const token = jwt.sign(
            {
              userId: user.id,
              email: user.email,
              role: user.role,
              jti: randomUUID(),
              iat: nextTokenIatSeconds(),
              exp: Math.floor(Date.now() / 1000) + (remember ? 10 * 24 * 60 * 60 : 86400),
            },
            getJWTSecret(),
          );

          res.json({
            access_token: token,
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              has_pin: Boolean(user.pin_hash),
              permission_ids: [...(resolveEffectivePermissions(user.id)?.permissionIds ?? [])],
              authorization_revision: effectivePermissionRevision(user.id),
            },
          });
        } catch (error: unknown) {
          console.error('[Server App] PIN login error:', error);
          res.status(500).json({ error: 'Internal server error' });
        }
      },
    );

    app.get(
      '/api/auth/me',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req: Request, res: Response) => {
        const user = (req as any).user as ServerAppUser;
        const row = getDatabase()
          .prepare(
            'SELECT id, name, email, role, pin_hash FROM users WHERE id = ? AND is_active = 1',
          )
          .get(user.userId) as any;
        if (!row) return res.status(401).json({ error: 'Invalid token' });
        res.json({
          user: {
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role,
            has_pin: Boolean(row.pin_hash),
            permission_ids: [...(resolveEffectivePermissions(row.id)?.permissionIds ?? [])],
            authorization_revision: effectivePermissionRevision(row.id),
          },
        });
      },
    );

    app.post(
      '/api/auth/password/change',
      authRateLimit(),
      requireServerAppAuth,
      asyncHandler(handlePasswordChange),
    );

    app.post(
      '/api/auth/pin/change',
      authRateLimit(),
      requireServerAppAuth,
      asyncHandler(handlePinChange),
    );

    app.post(
      '/api/auth/logout',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req: Request, res: Response) => {
        const token = req.headers.authorization?.split(' ')[1];
        const user = (req as Request & { user: ServerAppUser }).user;
        if (token) revokeToken(token, typeof user.exp === 'number' ? user.exp * 1000 : undefined);
        res.json({ success: true });
      },
    );

    app.get(
      '/api/settings/auto_lock_minutes',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) => forwardToMainApi(req, res, '/settings/auto_lock_minutes'),
    );
    app.get('/api/categories', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/categories'),
    );
    app.get('/api/products', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/products'),
    );
    app.get('/api/products/:id/image', serverAppApiRateLimit, (req, res) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      return forwardToMainApi(
        req,
        res,
        `/products/${encodeURIComponent(String(req.params.id))}/image`,
      );
    });
    app.get('/api/tables', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/tables'),
    );
    app.post(
      '/api/tables/:id/move-order',
      serverAppApiRateLimit,
      requireServerAppAuth,
      (req, res) =>
        forwardToMainApi(
          req,
          res,
          `/tables/${encodeURIComponent(String(req.params.id))}/move-order`,
        ),
    );
    app.get('/api/orders', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/orders'),
    );
    app.post('/api/orders', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/orders'),
    );
    app.post('/api/orders/:id/items', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, `/orders/${encodeURIComponent(String(req.params.id))}/items`),
    );
    app.get('/api/customers-search', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/customers-search'),
    );
    app.get('/api/crm/lookup', serverAppApiRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/crm/lookup'),
    );
    const customerWriteRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 150,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.post('/api/customers', customerWriteRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/customers'),
    );
    const printForwardRateLimit = expressRateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.post('/api/printers/print-kot', printForwardRateLimit, requireServerAppAuth, (req, res) =>
      forwardToMainApi(req, res, '/printers/print-kot'),
    );
    app.post(
      '/api/printers/print-bill',
      printForwardRateLimit,
      requireServerAppAuth,
      (req, res) => {
        if (!isServerBillPrintingEnabled()) {
          return res.status(403).json({
            error:
              'Bill printing is disabled for the Server Companion App. An owner or manager can enable it in Settings.',
            code: 'BILL_PRINTING_DISABLED',
          });
        }
        return forwardToMainApi(req, res, '/printers/print-bill');
      },
    );

    const staticDir = getStaticDir();
    if (staticDir) {
      console.log(`[Server App] Serving static files from: ${staticDir}`);
      if (process.platform === 'win32') {
        app.use(staticRouteRateLimit(), (req: Request, _res: Response, next: NextFunction) => {
          if (req.path.includes('__next.')) {
            const rewritten = rewriteNextExportPath(req.path);
            if (rewritten !== req.path) {
              const fullPath = resolveContainedPath(staticDir, rewritten);
              if (fullPath && fs.existsSync(fullPath)) {
                req.url = rewritten;
              }
            }
          }
          next();
        });
      }
      app.use(express.static(staticDir, { dotfiles: 'allow', index: false }));
      app.get('/', (_req: Request, res: Response) => res.redirect('/server-standalone'));
      app.get('/*splat', staticRouteRateLimit(), (req: Request, res: Response) => {
        const routePath = resolveContainedPath(staticDir, `.${req.path}`, 'index.html');
        if (routePath && fs.existsSync(routePath)) {
          res.sendFile(routePath, { dotfiles: 'allow' });
        } else {
          res.sendFile(path.join(staticDir, 'server-standalone', 'index.html'), {
            dotfiles: 'allow',
          });
        }
      });
    } else {
      console.warn('[Server App] Static build not found. Run `npm run build:frontend` first.');
      app.get('/', (_req: Request, res: Response) => {
        res.send(`
          <html><body style="font-family:sans-serif;padding:2rem">
            <h2>Flo Server App - Build not found</h2>
            <p>Run <code>npm run build:frontend</code> then restart the app.</p>
          </body></html>
        `);
      });
    }

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Server App] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const baseServerAppPort = parseInt(process.env.SERVER_APP_PORT || String(SERVER_APP_PORT), 10);
    let currentPort = baseServerAppPort;
    let attempts = 0;
    const listeningServer = http.createServer(app);
    serverApp = listeningServer;
    installHttpShutdownTracking(listeningServer);

    const tryListen = () => {
      const attemptedPort = currentPort;
      const onListening = () => {
        if (stopping) {
          try {
            listeningServer.close();
          } catch {
            return;
          }
          return;
        }
        startReject = null;
        listeningServer.off('error', onError);
        setServerAppPort(attemptedPort);
        console.log(
          `[Server App] HTTP server running on http://localhost:${getActiveServerAppPort()}`,
        );
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException) => {
        if (stopping) return;
        listeningServer.off('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          attempts++;
          if (attempts >= 10) {
            const errorMsg = `[Server App] Failed to bind to any port after 10 attempts starting from ${baseServerAppPort}`;
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
          }
          currentPort++;
          console.log(
            `[Server App] Port ${attemptedPort} in use (${err.code}), trying ${currentPort}`,
          );
          tryListen();
          return;
        }
        reject(err);
      };

      listeningServer.once('listening', onListening);
      listeningServer.once('error', onError);
      listeningServer.listen(attemptedPort, '0.0.0.0');
    };

    tryListen();
  });
}

export function stopServerApp(): Promise<void> {
  if (stopPromise) return stopPromise;

  stopping = true;
  const rejectStart = startReject;
  startReject = null;
  rejectStart?.(createShutdownCancellationError('Server App'));
  const serverToClose = serverApp;
  // Mark the server unavailable immediately while active requests drain.
  serverApp = null;

  stopPromise = closeServerResources(serverToClose, null, 'Server App').then(() => {
    console.log('[Server App] HTTP server stopped');
  });
  return stopPromise;
}

export function getServerAppPort(): number {
  return getActiveServerAppPort();
}
