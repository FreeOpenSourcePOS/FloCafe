import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getDatabase, parseItemJson } from './db';
import { setupKdsWebSocket } from './services/kds';
import { getJWTSecret } from './routes/auth';
import { rateLimit } from './middleware/security';

let kdsServer: http.Server | null = null;
const KDS_PORT = parseInt(process.env.KDS_PORT || '3002', 10);
let activeKdsPort = KDS_PORT;

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

    app.use(cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (/^https?:\/\/localhost(:[0-9]+)?$/.test(origin) ||
          /^https?:\/\/(127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(origin)) {
          return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
      }
    }));
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
        const decoded = jwt.verify(token, getJWTSecret());
        (req as any).user = decoded;
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

    // KDS Auth - verify user has chef/manager/owner role
    app.post('/api/auth/login', (req: Request, res: Response) => {
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
        res.status(500).json({ error: error.message });
      }
    });

    // Get orders for KDS (pending, preparing, ready)
    app.get('/api/kds/orders', requireAuth, (req: Request, res: Response) => {
      try {
        const db = getDatabase();
        const categoryIds = req.query.category_ids ? String(req.query.category_ids).split(',') : null;

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
          let items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id).map(parseItemJson);

          // Filter by category if provided
          if (categoryIds && categoryIds.length > 0 && categoryIds[0] !== '') {
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
        res.status(500).json({ error: error.message });
      }
    });

    // Update order item status
    app.patch('/api/kds/items/:id/status', requireAuth, (req: Request, res: Response) => {
      try {
        const { status } = req.body;
        const validStatuses = ['pending', 'preparing', 'ready', 'served'];

        if (!status || !validStatuses.includes(status)) {
          return res.status(400).json({ error: `Valid status required: ${validStatuses.join(', ')}` });
        }

        const db = getDatabase();
        const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id) as any;
        if (!item) {
          return res.status(404).json({ error: 'Order item not found' });
        }

        db.prepare("UPDATE order_items SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(status, req.params.id);

        res.json({ success: true });
      } catch (error: any) {
        console.error('[KDS Server] PATCH item status error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Get categories for filtering
    app.get('/api/categories', requireAuth, (_req: Request, res: Response) => {
      try {
        const db = getDatabase();
        const categories = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
        res.json({ categories });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
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
      res.status(500).json({ error: err.message || 'Internal server error' });
    });

    let currentKdsPort = KDS_PORT;
    let attempts = 0;

    kdsServer = app.listen(currentKdsPort, '0.0.0.0', () => {
      activeKdsPort = currentKdsPort;
      console.log(`[KDS Server] HTTP server running on http://localhost:${activeKdsPort}`);

      if (kdsServer) {
        const wss = new WebSocketServer({ server: kdsServer, path: '/kds' });
        setupKdsWebSocket(wss);
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
  if (kdsServer) {
    kdsServer.close();
    kdsServer = null;
    console.log('[KDS Server] HTTP server stopped');
  }
}

export function getKdsPort(): number {
  return activeKdsPort;
}
