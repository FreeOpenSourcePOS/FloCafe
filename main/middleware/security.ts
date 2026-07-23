import { Request, Response, NextFunction } from 'express';
import { getDatabase, isKdsEnabled } from '../db';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  /** When false, private/LAN IPs are NOT exempt — use for auth endpoints. Default: true. */
  bypassPrivateIp?: boolean;
}

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_MAX = 100;

/**
 * Simple in-memory rate limiter for the local Express API.
 * Uses IP address as the key. Designed for a single-tenant desktop app.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX;
  const message = options.message ?? 'Too many requests, please try again later.';

  const requests = new Map<string, RateLimitRecord>();

  return (req: Request, res: Response, next: NextFunction) => {
    let ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    // Normalize IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
    const normalizedIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;

    // Bypass rate limit for local / private / Tailscale IPs (general API traffic).
    // Auth endpoints opt out of this bypass via bypassPrivateIp: false so that
    // LAN-based brute-force against /api/auth/login is still throttled.
    const bypassPrivateIp = options.bypassPrivateIp !== false;
    if (bypassPrivateIp && isAllowedPrivateIp(normalizedIp)) {
      return next();
    }

    let record = requests.get(ip);
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + windowMs };
      requests.set(ip, record);
    }

    record.count += 1;

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - record.count)));
    res.setHeader('RateLimit-Reset', new Date(record.resetAt).toISOString());

    if (record.count > max) {
      return res.status(429).json({ error: message });
    }

    if (options.skipSuccessfulRequests) {
      const originalSend = res.send.bind(res);
      res.send = (body: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          record!.count = Math.max(0, record!.count - 1);
        }
        return originalSend(body);
      };
    }

    next();
  };
}

/**
 * Stricter rate limiter for authentication endpoints.
 * Private/LAN IPs are NOT exempt — LAN-based brute-force is a real threat
 * for a POS system. (vuln-0003)
 */
export function authRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: 'Too many authentication attempts. Please try again later.',
    bypassPrivateIp: false,
  });
}

interface UserAuthCacheEntry {
  isActive: boolean;
  role: string;
  expiresAt: number;
}

// Bounds how long a deactivated/role-changed user's existing JWT keeps working
// after the DB is updated (vuln-0001). Kept short so requireAuth doesn't need
// a DB hit on every single request.
const USER_AUTH_CACHE_TTL_MS = 30 * 1000;

const userAuthCache = new Map<string, UserAuthCacheEntry>();

/**
 * Looks up (and caches) whether a JWT's subject is still an active user, and
 * their current role. requireAuth uses this to reject tokens for deactivated
 * users instead of trusting the JWT's signature/expiry alone.
 */
export function getUserAuthStatus(userId: string): { isActive: boolean; role: string } | null {
  const now = Date.now();
  const cached = userAuthCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return { isActive: cached.isActive, role: cached.role };
  }

  const db = getDatabase();
  const user = db.prepare('SELECT is_active, role FROM users WHERE id = ?').get(userId) as
    | { is_active: number; role: string }
    | undefined;

  if (!user) {
    userAuthCache.delete(userId);
    return null;
  }

  const entry: UserAuthCacheEntry = {
    isActive: user.is_active === 1,
    role: user.role,
    expiresAt: now + USER_AUTH_CACHE_TTL_MS,
  };
  userAuthCache.set(userId, entry);
  return { isActive: entry.isActive, role: entry.role };
}

/**
 * Forces the next requireAuth check for this user to re-read the DB instead
 * of serving a stale cache entry. Call after deactivate/reactivate/role changes.
 */
export function invalidateUserAuthCache(userId: string): void {
  userAuthCache.delete(userId);
}

/**
 * Role-based authorization middleware.
 * Must be used after requireAuth.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: () => void) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Gates authenticated KDS REST endpoints behind the `kds_enabled` setting
 * (issue #133). These are only reachable by an already-authenticated
 * kitchen-staff/manager/owner session, so a clear, explicit error is fine —
 * there's no LAN-probing concern here the way there is for the pairing
 * endpoints and WebSocket upgrade (see requireKdsEnabledOr404).
 */
export function requireKdsEnabled(req: Request, res: Response, next: () => void) {
  if (!isKdsEnabled()) {
    return res.status(403).json({ error: 'KDS is disabled for this business' });
  }
  next();
}

/**
 * Gates KDS pairing/discovery surface behind the `kds_enabled` setting,
 * returning 404 instead of 403 (issue #133). A stale or misconfigured KDS
 * device on the LAN should get no confirmation the feature even exists once
 * it's been turned off.
 */
export function requireKdsEnabledOr404(req: Request, res: Response, next: () => void) {
  if (!isKdsEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

import { URL } from 'url';
import * as net from 'net';

/**
 * Checks if the given IP address is a private, local, or Tailscale IP.
 */
export function isAllowedPrivateIp(ip: string): boolean {
  if (!net.isIP(ip)) return false; 
  if (ip === '::1') return true;

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;

  // Localhost (127.0.0.0/8)
  if (a === 127) return true;
  // Private Class A (10.0.0.0/8)
  if (a === 10) return true;
  // Private Class B (172.16.0.0/12)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private Class C (192.168.0.0/16)
  if (a === 192 && b === 168) return true;
  
  // Tailscale CGNAT (100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Checks if an IP address is disallowed as an outbound fetch target for the
 * SSRF-guarded image proxy (vuln-0003): loopback, private ranges, link-local
 * (includes the 169.254.169.254 cloud metadata address), CGNAT, multicast,
 * and other reserved ranges. This is a broader blocklist than
 * isAllowedPrivateIp, which is a LAN-convenience allowlist for rate
 * limiting/CORS and intentionally does not cover link-local/metadata.
 * Best-effort — covers the realistic SSRF targets, not every obscure
 * IPv6 transition/compat range.
 */
export function isBlockedSsrfTarget(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 - "this network"
    if (a === 10) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 168) return true; // private
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
    if (a >= 224) return true; // multicast (224-239) + reserved (240-255)
    return false;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
    if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(normalized)) return true; // unique local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4 address
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedSsrfTarget(mapped[1]);
    return false;
  }
  return true; // unparseable — fail closed
}

export const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);

    try {
      const parsedOrigin = new URL(origin);
      const hostname = parsedOrigin.hostname;

      if (hostname === 'localhost' || hostname.endsWith('.local') || isAllowedPrivateIp(hostname)) {
        return callback(null, true);
      }
      
      callback(new Error('Not allowed by CORS'));
    } catch (err) {
      callback(new Error('Invalid origin format'));
    }
  }
};

/**
 * Validates password complexity (vuln-0006).
 * Requires: >= 8 characters, at least 1 uppercase, 1 lowercase, 1 digit.
 */
export function validatePassword(password: string): boolean {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}
