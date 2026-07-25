import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getDatabase, parseItemJson, attachEffectiveAddons, isKdsEnabled } from './db';
import { setupKdsWebSocket, notifyKdsUpdate } from './services/kds';
import { getJWTSecret } from './routes/auth';
import { rateLimit, authRateLimit, corsOptions } from './middleware/security';

let kdsServer: http.Server | null = null;
let kdsWss: WebSocketServer | null = null;
const KDS_PORT = parseInt(process.env.KDS_PORT || '3002', 10);
let activeKdsPort = KDS_PORT;

type KdsRequestUser = {
  userId: string;
  email?: string;
  role: string;
  categoryIds: string[];
};

function parseCategoryIds(value: unknown): string[] {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function isKdsServerRunning(): boolean {
  return kdsServer !== null;
}

/**
 * Locate the static export directory.
 */
function getStaticDir(): string | null {
  const candidates = [
    path.join(__dirname, '../frontend/out'),
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

export function startKdsServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const app: Express = express();

    app.use(cors(corsOptions));
    app.use(express.json());

    // ── Global API rate limiting ──────────────────────────────────────────
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 100 }));

    // ── KDS Auth Middleware ───────────────────────────────────────────────
    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, getJWTSecret()) as any;
        const db = getDatabase();
        const user = db.prepare('SELECT id, email, role, category_ids FROM users WHERE id = ? AND is_active = 1').get(decoded.userId) as any;
        if (!user) {
          return res.status(401).json({ error: 'Invalid token' });
        }
        if (!['chef', 'manager', 'owner'].includes(user.role)) {
          return res.status(403).json({ error: 'Access denied. Only kitchen staff allowed.' });
        }
        (req as any).user = {
          userId: user.id,
          email: user.email,
          role: user.role,
          categoryIds: parseCategoryIds(user.category_ids),
        } satisfies KdsRequestUser;
        next();
      } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    };

    // ── KDS API endpoints (same database, minimal routes) ─────────────

    // Health check
    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'Flo KDS Server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      });
    });

    // Public tenant metadata — language + KDS defaults.
    // No auth: the standalone KDS needs this on first paint, before login,
    // and lives on a different origin than the main API.
    app.get('/api/kds/info', (_req: Request, res: Response) => {
      // Disabled KDS → pretend the endpoint doesn't exist rather than
      // confirming it's just off; this is the first thing a standalone KDS
      // device fetches, pre-login, so it's the least info a stale/
      // misconfigured device on the LAN should get (issue #133).
      if (!isKdsEnabled()) {
        return res.status(404).json({ error: 'Not found' });
      }
      try {
        const db = getDatabase();
        const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
        const s: Record<string, string> = {};
        for (const row of rows) s[row.key] = row.value;
        res.json({
          language: s.language || null,
          country: s.country || null,
          kds_default_view: s.kds_default_view === 'kanban' ? 'kanban' : 'tabs',
        });
      } catch (error: any) {
        console.error("[API] Internal error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // KDS Auth - verify user has chef/manager/owner role
    app.post('/api/auth/login', authRateLimit(), (req: Request, res: Response) => {
      try {
        const { email, password } = req.body;
        if (!email || !password) {
          return res.status(400).json({ error: 'Email and password required' });
        }

        const db = getDatabase();
        const bcrypt = require('bcryptjs');

        const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as any;
        if (!user || !bcrypt.compareSync(password, user.password)) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Only allow chef, manager, owner roles
        if (!['chef', 'manager', 'owner'].includes(user.role)) {
          return res.status(403).json({ error: 'Access denied. Only kitchen staff allowed.' });
        }

        const token = jwt.sign(
          { userId: user.id, email: user.email, role: user.role },
          getJWTSecret(),
          { expiresIn: '24h' }
        );

        res.json({
          access_token: token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            category_ids: user.category_ids ? JSON.parse(user.category_ids) : [],
          },
        });
      } catch (error: any) {
        console.error("[API] Internal error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // Current user info — lets the frontend restore a session from a saved
    // token on page load/reload instead of forcing a fresh login every time.
    app.get('/api/auth/me', requireAuth, (req: Request, res: Response) => {
      try {
        const authedUser = (req as any).user as KdsRequestUser;
        const db = getDatabase();
        const row = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(authedUser.userId) as any;
        if (!row) {
          return res.status(404).json({ error: 'User not found' });
        }
        res.json({ user: row });
      } catch (error: any) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get orders for KDS (pending, preparing, ready)
    app.get('/api/kds/orders', requireAuth, (req: Request, res: Response) => {
      if (!isKdsEnabled()) {
        return res.status(403).json({ error: 'KDS is disabled for this business' });
      }
      try {
        const db = getDatabase();
        const categoryIds = ((req as any).user as KdsRequestUser).categoryIds;

        let query = `
          SELECT DISTINCT o.*, t.number as table_number
          FROM orders o
          LEFT JOIN tables t ON o.table_id = t.id
          INNER JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.status IN ('pending', 'preparing', 'ready')
          AND o.created_at >= datetime('now', '-24 hours')
          ORDER BY o.created_at ASC
        `;

        const orders = db.prepare(query).all();

        const ordersWithItems = orders.map((order: any) => {
          let items = attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id).map(parseItemJson) as any[]);

          // Filter by category if provided
          if (categoryIds.length > 0) {
            const productIds = db.prepare(`
              SELECT id FROM products WHERE category_id IN (${categoryIds.map(() => '?').join(',')})
            `).all(...categoryIds).map((p: any) => p.id);

            items = items.filter((item: any) => productIds.includes(item.product_id));
          }

          return {
            ...order,
            table: order.table_number ? { name: order.table_number } : null,
            items,
          };
        });

        res.json({ orders: ordersWithItems });
      } catch (error: any) {
        console.error("[API] Internal error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // Update order item status
    app.patch('/api/kds/items/:id/status', requireAuth, (req: Request, res: Response) => {
      if (!isKdsEnabled()) {
        return res.status(403).json({ error: 'KDS is disabled for this business' });
      }
      try {
        const { status } = req.body;
        const validStatuses = ['pending', 'preparing', 'ready', 'served'];

        if (!status || !validStatuses.includes(status)) {
          return res.status(400).json({ error: `Valid status required: ${validStatuses.join(', ')}` });
        }

        const db = getDatabase();
        const item = db.prepare(`
          SELECT oi.*, p.category_id
          FROM order_items oi
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.id = ?
        `).get(req.params.id) as any;
        if (!item) {
          return res.status(404).json({ error: 'Order item not found' });
        }
        const categoryIds = ((req as any).user as KdsRequestUser).categoryIds;
        if (categoryIds.length > 0 && !categoryIds.includes(String(item.category_id))) {
          return res.status(403).json({ error: 'Not authorized to update this item' });
        }

        db.prepare("UPDATE order_items SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(status, req.params.id);

        notifyKdsUpdate();

        res.json({ success: true });
      } catch (error: any) {
        console.error('[KDS Server] PATCH item status error:', error);
        console.error("[API] Internal error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // Get categories for filtering
    app.get('/api/categories', requireAuth, (_req: Request, res: Response) => {
      try {
        const db = getDatabase();
        const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
        res.json({ categories });
      } catch (error: any) {
        console.error("[API] Internal error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // ── Serve static files ────────────────────────────────────────────
    const staticDir = getStaticDir();
    if (staticDir) {
      console.log(`[KDS Server] Serving static files from: ${staticDir}`);

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
              const fullPath = path.join(staticDir, rewritten);
              if (fs.existsSync(fullPath)) {
                req.url = rewritten;
              }
            }
          }
          next();
        });
      }

      app.use(express.static(staticDir, { index: false }));

      // Redirect root to standalone KDS
      app.get('/', (_req: Request, res: Response) => {
        res.redirect('/kds-standalone');
      });

      // SPA fallback - serve the standalone KDS for any unmatched routes
      app.get('*', (req: Request, res: Response) => {
        // Try to serve the specific route first
        const routePath = path.join(staticDir, req.path, 'index.html');
        if (fs.existsSync(routePath)) {
          res.sendFile(routePath);
        } else {
          res.sendFile(path.join(staticDir, 'kds-standalone', 'index.html'));
        }
      });
    } else {
      console.warn('[KDS Server] Static build not found. Run `npm run build:frontend` first.');
      app.get('/', (_req: Request, res: Response) => {
        res.send(`
          <html><body style="font-family:sans-serif;padding:2rem">
            <h2>Flo KDS – Build not found</h2>
            <p>Run <code>npm run build:frontend</code> then restart the app.</p>
          </body></html>
        `);
      });
    }

    // ── Error handler ────────────────────────────────────────────────
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[KDS Server] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    let currentKdsPort = KDS_PORT;
    let attempts = 0;

    kdsServer = app.listen(currentKdsPort, '0.0.0.0', () => {
      activeKdsPort = currentKdsPort;
      console.log(`[KDS Server] HTTP server running on http://localhost:${activeKdsPort}`);

      if (kdsServer) {
        // noServer + a manual 'upgrade' handler so a disabled KDS can 404 the
        // upgrade instead of completing it — see main/server.ts for the same
        // pattern on the primary API server (issue #133).
        const wss = new WebSocketServer({ noServer: true });
        kdsWss = wss;
        setupKdsWebSocket(wss);

        kdsServer.on('upgrade', (request, socket, head) => {
          const pathname = (request.url || '').split('?')[0];
          if (pathname !== '/kds') return;

          if (!isKdsEnabled()) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }

          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        });

        console.log(`[KDS Server] WebSocket running on ws://localhost:${activeKdsPort}/kds`);
      }

      resolve();
    });

    kdsServer?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        attempts++;
        if (attempts >= 10) {
          const errorMsg = `[KDS Server] Failed to bind to any port after 10 attempts starting from ${KDS_PORT}`;
          console.error(errorMsg);
          reject(new Error(errorMsg));
          return;
        }
        currentKdsPort++;
        console.log(`[KDS Server] Port ${currentKdsPort - 1} in use, trying ${currentKdsPort}`);
        kdsServer?.listen(currentKdsPort, '0.0.0.0');
      } else {
        reject(err);
      }
    });
  });
}

export function stopKdsServer(): void {
  if (kdsWss) {
    for (const client of kdsWss.clients) client.terminate();
    kdsWss.close();
    kdsWss = null;
  }
  if (kdsServer) {
    kdsServer.close();
    kdsServer = null;
    console.log('[KDS Server] HTTP server stopped');
  }
}

export function getKdsPort(): number {
  return activeKdsPort;
}
