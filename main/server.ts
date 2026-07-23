import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import { registerRoutes } from './routes';
import { getJWTSecret } from './routes/auth';
import { getDbHealth, isKdsEnabled } from './db';
import { setupKdsWebSocket } from './services/kds';
import { rateLimit, corsOptions, getUserAuthStatus } from './middleware/security';
import { initFromDb as initWhatsAppFromDb } from './services/whatsapp';

let server: http.Server | null = null;
let app: Express;
let wss: WebSocketServer;

const PORT = parseInt(process.env.PORT || '3001', 10);

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
    const decoded = jwt.verify(authHeader.split(' ')[1], getJWTSecret()) as any;

    // Reject tokens for users deactivated (or deleted) since the token was
    // issued, instead of trusting the JWT's signature/expiry alone (vuln-0001).
    const status = getUserAuthStatus(decoded.userId);
    if (!status || !status.isActive) {
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

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    app = express();

    app.use(cors(corsOptions));
    app.use(express.json());

    // ── Global API rate limiting ───────────────────────────────────────
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 100 }));

    // ── Content Security Policy ────────────────────────────────────────
    // Blocks eval() and remote code. 'unsafe-inline' is required for
    // Next.js RSC hydration scripts and Tailwind-generated style tags.
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' http://localhost:* ws://localhost:*; " +
        "frame-ancestors 'none'"
      );
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
        version: '1.0.0',
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
        app.use((req: Request, res: Response, next: NextFunction) => {
          if (req.path.includes('__next.')) {
            const originalPath = req.path;
            const rewritten = rewriteNextExportPath(originalPath);
            if (rewritten !== originalPath) {
              const fullPath = path.join(frontendDir, rewritten);
              if (fs.existsSync(fullPath)) {
                req.url = rewritten;
              }
            }
          }
          next();
        });
      }

      app.use(express.static(frontendDir));

      // SPA fallback: any unknown path returns index.html so Next.js
      // client-side routing works. Exclude /api (API routes) and /kds.
      app.get(/^(?!\/api|\/kds).*$/, (_req: Request, res: Response) => {
        res.sendFile(path.join(frontendDir, 'index.html'));
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
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[Server] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    let currentPort = PORT;
    let attempts = 0;

    server = app.listen(currentPort, '0.0.0.0', () => {
      console.log(`[Server] HTTP server running on http://localhost:${currentPort}`);

      if (server) {
        // noServer + a manual 'upgrade' handler (rather than passing `server`
        // straight to WebSocketServer) so a disabled KDS can 404 the upgrade
        // instead of completing it — checked fresh on every request since
        // kds_enabled can change at runtime without a restart (issue #133).
        wss = new WebSocketServer({ noServer: true });
        setupKdsWebSocket(wss);

        server.on('upgrade', (request, socket, head) => {
          const pathname = (request.url || '').split('?')[0];
          if (pathname !== '/kds') return;

          if (!isKdsEnabled()) {
            // Pretend the endpoint doesn't exist rather than confirming it's
            // just disabled — less to probe from a stale/misconfigured KDS
            // device on the LAN (issue #133).
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }

          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        });

        console.log(`[Server] KDS WebSocket running on ws://localhost:${currentPort}/kds`);
      }

      // main/index.ts (Electron) also calls this; dev-server and pm2 boot
      // through here instead and would otherwise start with module defaults.
      initWhatsAppFromDb();

      resolve();
    });

    server?.on('error', (err: NodeJS.ErrnoException) => {
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
        server?.listen(currentPort, '0.0.0.0');
      } else {
        reject(err);
      }
    });
  });
}

export function stopServer(): void {
  if (wss) wss.close();
  if (server) server.close();
  console.log('[Server] HTTP server stopped');
}

/** Returns the first non-loopback IPv4 address on the machine. */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

/** Returns all non-loopback IPv4 addresses on the machine. */
export function getAllLocalIPs(): string[] {
  const ips: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if ((alias.family === 'IPv4' || (alias.family as string | number) === 4) && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }
  return ips.length > 0 ? ips : ['127.0.0.1'];
}
