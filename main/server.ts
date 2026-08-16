import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import * as http from 'http';
import { closeServerResources, createShutdownCancellationError, installHttpShutdownTracking } from './shutdown';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import { registerRoutes } from './routes';
import { getJWTSecret } from './routes/auth';
import { databaseMaintenanceMiddleware, getDbHealth, isDatabaseMaintenanceActive, isKdsEnabled } from './db';
import { setupKdsWebSocket } from './services/kds';
import { rateLimit, staticRouteRateLimit, corsOptions, getUserAuthStatus, isTokenRevoked, isTokenStale } from './middleware/security';
import { initFromDb as initWhatsAppFromDb } from './services/whatsapp';
import { API_JSON_BODY_LIMIT } from './http-limits';
import { buildCspHeader } from './csp';
import { resolveContainedPath } from './lib/path-containment';

let server: http.Server | null = null;
let app: Express;
let wss: WebSocketServer | null = null;
let stopPromise: Promise<void> | null = null;
let startReject: ((error: Error) => void) | null = null;
let stopping = false;

const PORT = parseInt(process.env.PORT || '3001', 10);
let activePort = PORT;

/**
 * JWT verification middleware. Skips health check and auth routes (those
 * verify tokens individually). Protects all resource routes from unauthenticated
 * LAN access.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Only protect API routes — static files and SPA fallback must pass through
  if (!req.path.startsWith('/api')) { next(); return; }
  // Health check — unauthenticated
  if (req.path === '/api/health') { next(); return; }
  // Auth routes handle their own token verification
  if (req.path.startsWith('/api/auth')) { next(); return; }
  // Allow unauthenticated GET requests for product images (so <img> tags work)
  if (req.path.startsWith('/api/products/') && req.path.endsWith('/image') && req.method === 'GET') { next(); return; }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const token = authHeader.split(' ')[1];
    if (isTokenRevoked(token)) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    const decoded = jwt.verify(token, getJWTSecret()) as any;

    // Reject tokens for users deactivated (or deleted) since the token was
    // issued, instead of trusting the JWT's signature/expiry alone (vuln-0001).
    const freshKdsAuth = req.path.startsWith('/api/kds')
      || req.path.startsWith('/api/kitchen')
      || req.path.startsWith('/api/order-items');
    const status = getUserAuthStatus(decoded.userId, { fresh: freshKdsAuth });
    if (!status || !status.isActive) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Reject tokens issued before the user's password/PIN was last changed (#173).
    if (isTokenStale(decoded.iat, status.tokensValidAfter)) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Use the DB's current role rather than the JWT's role claim, so a role
    // change takes effect without waiting for the token to expire.
    (req as any).user = { ...decoded, role: status.role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function isServerRunning(): boolean {
  return server !== null;
}

export function getServerPort(): number {
  return activePort;
}

/**
 * Locate the Next.js static export directory.
 *
 * Dev build  → <repo-root>/frontend/out
 * Packaged   → <resourcesPath>/frontend-out   (see electron-builder extraResources)
 */
function getFrontendDir(): string | null {
  const candidates = [
    // Development / unpackaged: relative to dist/
    path.join(__dirname, '../frontend/out'),
    // Packaged: electron-builder copies it to resources/frontend-out
    path.join(process.resourcesPath || '', 'frontend-out'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Helper to rewrite dotted Next.js static segment file requests to nested paths on Windows.
 * E.g., /products/__next.!KGRhc2hib2FyZCk.products.__PAGE__.txt -> /products/__next.!KGRhc2hib2FyZCk/products/__PAGE__.txt
 */
function rewriteNextExportPath(reqPath: string): string {
  const nextIndex = reqPath.indexOf('__next.');
  if (nextIndex === -1) return reqPath;

  const prefix = reqPath.substring(0, nextIndex + '__next.'.length);
  const rest = reqPath.substring(nextIndex + '__next.'.length);

  const lastDotIndex = rest.lastIndexOf('.');
  if (lastDotIndex === -1) return reqPath;

  const namePart = rest.substring(0, lastDotIndex);
  const extPart = rest.substring(lastDotIndex);

  const rewrittenName = namePart.replace(/\./g, '/');
  return prefix + rewrittenName + extPart;
}

/** Resolve a clean application route to its own Next.js static-export page. */
export function resolveStaticPage(frontendDir: string, reqPath: string): string {
  const route = reqPath.replace(/^\/+|\/+$/g, '');
  if (!route) return path.join(frontendDir, 'index.html');
  // Static app routes contain only path-safe segments. Unknown or suspicious
  // paths fall back to the root page without ever escaping frontendDir.
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(route)) {
    return path.join(frontendDir, 'index.html');
  }
  const candidate = resolveContainedPath(frontendDir, route, 'index.html');
  if (!candidate) return path.join(frontendDir, 'index.html');
  return fs.existsSync(candidate) ? candidate : path.join(frontendDir, 'index.html');
}

export function startServer(): Promise<void> {
  stopPromise = null;
  stopping = false;
  return new Promise((resolve, reject) => {
    startReject = reject;
    app = express();

    app.use(cors(corsOptions));
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
    // body-parser 2.x (bundled with Express 5) leaves req.body undefined
    // instead of {} when a request has no parseable body -- restore the
    // old default so route handlers can destructure req.body directly.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.body === undefined) req.body = {};
      next();
    });
    app.use(databaseMaintenanceMiddleware);

    // ── Global API rate limiting ───────────────────────────────────────
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 100 }));

    // ── Content Security Policy ────────────────────────────────────────
    // Blocks eval() and remote code. 'unsafe-inline' is required for
    // Next.js RSC hydration scripts and Tailwind-generated style tags.
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', buildCspHeader(req));
      next();
    });

    // ── Auth middleware (skips /api/health and /api/auth) ─────────────
    app.use(requireAuth);

    // ── API health check ───────────────────────────────────────────────
    app.get('/api/health', (_req: Request, res: Response) => {
      const db = getDbHealth();
      res.status(db.ok ? 200 : 503).json({
        status: db.ok ? 'ok' : 'error',
        db: db.ok ? 'ok' : db.error,
        service: 'Flo Local API',
        version: process.env.npm_package_version || '2.4.7',
        timestamp: new Date().toISOString(),
      });
    });

    // ── All API routes ─────────────────────────────────────────────────
    registerRoutes(app);

    // ── Serve Next.js static export ────────────────────────────────────
    // Must come AFTER API routes so /api/* is not caught by the SPA fallback.
    const frontendDir = getFrontendDir();
    if (frontendDir) {
      console.log(`[Server] Serving frontend from: ${frontendDir}`);

      // Middleware to patch Windows-specific Next.js static export path nesting.
      // On Windows, the Next.js static export uses dotted segments (e.g.
      // __next.!KGRhc2hib2FyZCk.products.__PAGE__.txt) instead of nested
      // directories. This rewrite is only needed when the app runs on Windows.
      if (process.platform === 'win32') {
        app.use(staticRouteRateLimit(), (req: Request, res: Response, next: NextFunction) => {
          if (req.path.includes('__next.')) {
            const originalPath = req.path;
            const rewritten = rewriteNextExportPath(originalPath);
            if (rewritten !== originalPath) {
              const fullPath = resolveContainedPath(frontendDir, rewritten);
              if (fullPath && fs.existsSync(fullPath)) {
                req.url = rewritten;
              }
            }
          }
          next();
        });
      }

      app.use(express.static(frontendDir, { dotfiles: 'allow', index: false }));

      // Serve each Next.js static route's own index. Returning the root export
      // for /whatsapp (or any direct link/refresh) runs app/page.tsx and sends
      // the user to Dashboard instead of the requested page.
      app.get(/^(?!\/api|\/kds).*$/, staticRouteRateLimit(), (req: Request, res: Response) => {
        res.sendFile(resolveStaticPage(frontendDir, req.path), { dotfiles: 'allow' });
      });
    } else {
      console.warn('[Server] Frontend build not found. Run `npm run build:frontend` first.');
      app.get('/', (_req: Request, res: Response) => {
        res.send(`
          <html><body style="font-family:sans-serif;padding:2rem">
            <h2>Flo – Frontend not built</h2>
            <p>Run <code>npm run build:frontend</code> then restart the app.</p>
          </body></html>
        `);
      });
    }

    // ── Global error handler ───────────────────────────────────────────
    app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
      if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON request body' });
      }
      const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500
        ? err.status
        : 500;
      if (status >= 500) console.error('[Server] Error:', err);
      res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err.message || 'Client error') });
    });

    let currentPort = PORT;
    let attempts = 0;

    let listeningServer: http.Server;
    const onListening = () => {
      if (stopping) {
        try { listeningServer.close(); } catch { return; }
        return;
      }
      startReject = null;
      const address = listeningServer.address();
      activePort = address && typeof address !== 'string' ? address.port : currentPort;
      console.log(`[Server] HTTP server running on http://localhost:${activePort}`);

      if (listeningServer) {
        // noServer + a manual 'upgrade' handler (rather than passing `server`
        // straight to WebSocketServer) so a disabled KDS can 404 the upgrade
        // instead of completing it — checked fresh on every request since
        // kds_enabled can change at runtime without a restart (issue #133).
        const websocketServer = new WebSocketServer({ noServer: true });
        wss = websocketServer;
        setupKdsWebSocket(websocketServer);

        listeningServer.on('upgrade', (request, socket, head) => {
          const pathname = (request.url || '').split('?')[0];
          if (pathname !== '/kds') {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
          }

          if (isDatabaseMaintenanceActive()) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
          }

          if (!isKdsEnabled()) {
            // Pretend the endpoint doesn't exist rather than confirming it's
            // just disabled — less to probe from a stale/misconfigured KDS
            // device on the LAN (issue #133).
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }

          try {
            websocketServer.handleUpgrade(request, socket, head, (ws) => {
              websocketServer.emit('connection', ws, request);
            });
          } catch (error) {
            console.error('[Server] KDS WebSocket upgrade failed:', error);
            socket.destroy();
          }
        });

        console.log(`[Server] KDS WebSocket running on ws://localhost:${activePort}/kds`);
      }

      // main/index.ts (Electron) also calls this; dev-server and pm2 boot
      // through here instead and would otherwise start with module defaults.
      try {
        initWhatsAppFromDb();
      } catch (error) {
        console.error('[Server] WhatsApp startup initialization failed:', error);
      }

      resolve();
    };
    listeningServer = app.listen(currentPort, '0.0.0.0', onListening);
    server = listeningServer;
    installHttpShutdownTracking(listeningServer);

    listeningServer.on('error', (err: NodeJS.ErrnoException) => {
      if (stopping) return;
      if (err.code === 'EADDRINUSE') {
        attempts++;
        if (attempts >= 10) {
          const errorMsg = `[Server] Failed to bind to any port after 10 attempts starting from ${PORT}`;
          console.error(errorMsg);
          reject(new Error(errorMsg));
          return;
        }
        currentPort++;
        console.log(`[Server] Port ${currentPort - 1} in use, trying ${currentPort}`);
        listeningServer.listen(currentPort, '0.0.0.0');
      } else {
        reject(err);
      }
    });
  });
}

export function stopServer(): Promise<void> {
  if (stopPromise) return stopPromise;

  stopping = true;
  const rejectStart = startReject;
  startReject = null;
  rejectStart?.(createShutdownCancellationError('Main server'));
  const serverToClose = server;
  const wssToClose = wss;
  // Mark resources unavailable immediately. Repeated callers share the same
  // promise while the captured resources finish draining.
  server = null;
  wss = null;

  stopPromise = closeServerResources(serverToClose, wssToClose, 'Main server')
    .then(() => {
      console.log('[Server] HTTP/WebSocket server stopped');
    });
  return stopPromise;
}

/** Helper to check if an IPv4 address is active and valid (excludes loopback & 169.254.x.x link-local APIPA). */
function isValidLocalIPv4(alias: os.NetworkInterfaceInfo): boolean {
  const isIPv4 = alias.family === 'IPv4' || (alias.family as string | number) === 4;
  if (!isIPv4 || alias.internal) return false;
  const ip = alias.address;
  if (ip.startsWith('169.254.') || ip.startsWith('127.') || ip === '0.0.0.0') {
    return false;
  }
  return true;
}

/** Returns the first valid non-loopback IPv4 address on the machine. */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if (isValidLocalIPv4(alias)) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

/** Returns all valid non-loopback IPv4 addresses on the machine. */
export function getAllLocalIPs(): string[] {
  const ips: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if (isValidLocalIPv4(alias)) {
        ips.push(alias.address);
      }
    }
  }
  return ips.length > 0 ? ips : ['127.0.0.1'];
}
