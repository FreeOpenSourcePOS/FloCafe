import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, getKdsStationCategoryIds, getUserKdsStationIds, hasUserKdsStationAssignments, isKdsStationItemAllowed, parseItemJson, attachEffectiveAddons, isKdsEnabled, isVoidedItemKdsVisible, KDS_VOIDED_ITEM_VISIBILITY_MS, projectKdsItem, projectKdsOrder } from './db';
import { setupKdsWebSocket, notifyKdsUpdate } from './services/kds';
import { getJWTSecret, parseCategoryIds } from './routes/auth';
import { rateLimit, authRateLimit, corsOptions, isTokenRevoked, isTokenStale, revokeToken } from './middleware/security';

let kdsServer: http.Server | null = null;
let kdsWss: WebSocketServer | null = null;
const KDS_PORT = parseInt(process.env.KDS_PORT || '3002', 10);
let activeKdsPort = KDS_PORT;

type KdsRequestUser = {
  userId: string;
  email?: string;
  role: string;
  categoryIds: string[];
  stationIds: string[];
  stationAssignmentsConfigured: boolean;
};

function categoryIdsForRole(role: string, categoryIds: string | null): string[] {
  return role === 'manager' || role === 'owner' ? [] : parseCategoryIds(categoryIds);
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
    // body-parser 2.x (bundled with Express 5) leaves req.body undefined
    // instead of {} when a request has no parseable body -- restore the
    // old default so route handlers can destructure req.body directly.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.body === undefined) req.body = {};
      next();
    });

    // ── Global API rate limiting ──────────────────────────────────────────
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 100 }));

    // ── KDS Auth Middleware ───────────────────────────────────────────────
    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const token = authHeader.split(' ')[1];
      if (isTokenRevoked(token)) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      try {
        const decoded = jwt.verify(token, getJWTSecret()) as any;
        const db = getDatabase();
        const user = db.prepare('SELECT id, email, role, category_ids, tokens_valid_after FROM users WHERE id = ? AND is_active = 1').get(decoded.userId) as any;
        if (!user || isTokenStale(decoded.iat, user.tokens_valid_after)) {
          return res.status(401).json({ error: 'Invalid token' });
        }
        if (!['chef', 'manager', 'owner'].includes(user.role)) {
          return res.status(403).json({ error: 'Access denied. Only kitchen staff allowed.' });
        }
        const stationIds = getUserKdsStationIds(db, user.id);
        const stationAssignmentsConfigured = hasUserKdsStationAssignments(db, user.id);
        if (!stationIds || stationAssignmentsConfigured === null) return res.status(401).json({ error: 'Invalid token' });
        if (stationAssignmentsConfigured && stationIds.length === 0) return res.status(403).json({ error: 'No active kitchen station is assigned to this user' });
        (req as any).user = {
          userId: user.id,
          email: user.email,
          role: user.role,
          categoryIds: categoryIdsForRole(user.role, user.category_ids),
          stationIds,
          stationAssignmentsConfigured,
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

        const stationIds = getUserKdsStationIds(db, user.id);
        const stationAssignmentsConfigured = hasUserKdsStationAssignments(db, user.id);
        if (!stationIds || stationAssignmentsConfigured === null) return res.status(500).json({ error: 'Could not load station permissions' });
        if (stationAssignmentsConfigured && stationIds.length === 0) {
          return res.status(403).json({ error: 'No active kitchen station is assigned to this user' });
        }

        const token = jwt.sign(
          { userId: user.id, email: user.email, role: user.role, jti: uuidv4() },
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
            category_ids: categoryIdsForRole(user.role, user.category_ids),
            station_ids: stationIds,
            station_assignments_configured: stationAssignmentsConfigured,
          },
        });
      } catch (error: any) {
        console.error("[API] Internal error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    app.post('/api/auth/logout', (req: Request, res: Response) => {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length);
        try {
          const decoded = jwt.verify(token, getJWTSecret()) as { exp?: number };
          revokeToken(token, typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined);
        } catch {
          // Logout remains idempotent without persisting arbitrary bearer data.
        }
      }
      res.json({ message: 'Logged out successfully' });
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
        const stationIds = ((req as any).user as KdsRequestUser).stationIds;
        const stationCategoryIds = getKdsStationCategoryIds(db, stationIds);
        if (!stationCategoryIds) return res.status(403).json({ error: 'Could not load station permissions' });
        const voidedCutoff = new Date(Date.now() - KDS_VOIDED_ITEM_VISIBILITY_MS).toISOString().replace('T', ' ').replace(/\..*$/, '');

        let query = `
          SELECT DISTINCT o.*, t.number as table_number, t.kitchen_station_id
          FROM orders o
          LEFT JOIN tables t ON o.table_id = t.id
          INNER JOIN order_items oi ON oi.order_id = o.id
          WHERE (oi.status IN ('pending', 'preparing', 'ready')
            OR (oi.status = 'voided' AND (oi.voided_at IS NULL OR oi.voided_at > ?)))
          AND o.status != 'cancelled'
          AND o.created_at >= datetime('now', '-24 hours')
        `;
        const orderParams: string[] = [voidedCutoff];
        if (stationIds.length > 0) {
          const stationPlaceholders = stationIds.map(() => '?').join(',');
          const categoryRoute = stationCategoryIds.length > 0
            ? ` OR EXISTS (SELECT 1 FROM order_items routed_oi JOIN products routed_p ON routed_p.id = routed_oi.product_id WHERE routed_oi.order_id = o.id AND o.table_id IS NULL AND routed_p.category_id IN (${stationCategoryIds.map(() => '?').join(',')}))`
            : '';
          query += ` AND (EXISTS (SELECT 1 FROM tables assigned_table WHERE assigned_table.id = o.table_id AND assigned_table.kitchen_station_id IN (${stationPlaceholders}))${categoryRoute})`;
          orderParams.push(...stationIds, ...stationCategoryIds);
        }
        query += ' ORDER BY o.created_at ASC';

        const orders = db.prepare(query).all(...orderParams);

        // Pre-fetch allowed product IDs once if category restrictions apply to eliminate N+1 queries
        let allowedProductIds: Set<string> | null = null;
        if (categoryIds.length > 0) {
          const productRows = db.prepare(`
            SELECT id FROM products WHERE category_id IN (${categoryIds.map(() => '?').join(',')})
          `).all(...categoryIds) as { id: string }[];
          allowedProductIds = new Set(productRows.map((p) => p.id));
        }

        const ordersWithItems = orders.map((order: any) => {
          const rawItems = db.prepare(`
            SELECT oi.*, p.category_id
            FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = ?
          `).all(order.id) as any[];
          // #150: hide the void reversal line (bill adjustment, not a kitchen
          // item) and age voided items off the board after their grace period.
          const visibleItems = rawItems.filter((i) => i.status !== 'void_adjustment'
            && !['completed', 'cancelled'].includes(i.status)
            && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
            && isKdsStationItemAllowed(stationIds, stationCategoryIds, order.kitchen_station_id, i.category_id));
          let items = attachEffectiveAddons(db, visibleItems.map(parseItemJson) as any[]);

          // Filter by category if provided
          if (allowedProductIds) {
            items = items.filter((item: any) => allowedProductIds!.has(item.product_id));
          }
          items = items.map((item: any) => projectKdsItem(item, categoryIds.length > 0));

          return {
            ...projectKdsOrder(order, categoryIds.length > 0),
            table: order.table_number ? { name: order.table_number } : null,
            items,
          };
        }).filter((order: any) => order.items.length > 0);

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

        // #150: locked once voided — see main/routes/order-items.ts for the same rule.
        if (item.status === 'voided') {
          return res.status(400).json({ error: 'This item has been voided and can no longer be updated' });
        }
        if (item.status === 'void_adjustment') {
          return res.status(400).json({ error: 'This bill adjustment cannot be updated from KDS' });
        }
        if (item.status === 'completed' || item.status === 'cancelled') {
          return res.status(400).json({ error: 'This terminal item cannot be updated from KDS' });
        }

        const categoryIds = ((req as any).user as KdsRequestUser).categoryIds;
        const stationIds = ((req as any).user as KdsRequestUser).stationIds;
        if (stationIds.length > 0) {
          const stationCategoryIds = getKdsStationCategoryIds(db, stationIds);
          const station = db.prepare(`
            SELECT t.kitchen_station_id
            FROM orders o LEFT JOIN tables t ON t.id = o.table_id
            WHERE o.id = ?
          `).get(item.order_id) as { kitchen_station_id: string | null } | undefined;
          if (!stationCategoryIds || !isKdsStationItemAllowed(stationIds, stationCategoryIds, station?.kitchen_station_id, item.category_id)) {
            return res.status(403).json({ error: 'Not authorized to update this station' });
          }
        }
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
      if (!isKdsEnabled()) {
        return res.status(403).json({ error: 'KDS is disabled for this business' });
      }
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
      app.get('/*splat', (req: Request, res: Response) => {
        // Try to serve the specific route first
        const staticRoot = path.resolve(staticDir);
        const routePath = path.resolve(staticRoot, `.${req.path}`, 'index.html');
        if (routePath.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(routePath)) {
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

    const onListening = () => {
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
          if (pathname !== '/kds') {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
          }

          if (!isKdsEnabled()) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }

          try {
            wss.handleUpgrade(request, socket, head, (ws) => {
              wss.emit('connection', ws, request);
            });
          } catch (error) {
            console.error('[KDS Server] WebSocket upgrade failed:', error);
            socket.destroy();
          }
        });

        console.log(`[KDS Server] WebSocket running on ws://localhost:${activeKdsPort}/kds`);
      }

      resolve();
    };

    kdsServer = app.listen(currentKdsPort, '0.0.0.0', onListening);

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
        kdsServer?.listen(currentKdsPort, '0.0.0.0', onListening);
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
