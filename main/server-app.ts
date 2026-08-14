import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { closeServerResources, createShutdownCancellationError, getHttpRequestSignal, installHttpShutdownTracking, trackHttpRequestWork } from './shutdown';
import { databaseMaintenanceMiddleware, getDatabase, isServerAppEnabled } from './db';
import { getJWTSecret } from './routes/auth';
import { authRateLimit, corsOptions, isTokenRevoked, isTokenStale, rateLimit, revokeToken } from './middleware/security';
import { getServerPort } from './server';
import { getDefaultServerAppPort, getServerAppPort as getActiveServerAppPort, setServerAppPort } from './server-app-state';

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
};

function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

export function isServerAppRunning(): boolean {
  return serverApp !== null;
}

function getStaticDir(): string | null {
  const candidates = [
    path.join(__dirname, '../frontend/out'),
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

  return prefix + rest.substring(0, lastDotIndex).replace(/\./g, '/') + rest.substring(lastDotIndex);
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
    const user = db.prepare('SELECT id, email, role, tokens_valid_after FROM users WHERE id = ? AND is_active = 1').get(decoded.userId) as any;
    if (!user || isTokenStale(decoded.iat, user.tokens_valid_after)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (!['waiter', 'manager', 'owner'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied. Only service staff allowed.' });
    }

    (req as any).user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      iat: decoded.iat,
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

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.get('Idempotency-Key') ? { 'Idempotency-Key': req.get('Idempotency-Key')! } : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: getHttpRequestSignal(req),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (error: any) {
    if (getHttpRequestSignal(req)?.aborted) {
      if (!res.headersSent) res.status(503).end();
      else if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[Server App] Main API forward failed:', error);
    res.status(502).json({ error: 'Could not reach the local POS API' });
  }
}

export function startServerApp(): Promise<void> {
  stopPromise = null;
  stopping = false;
  return new Promise((resolve, reject) => {
    startReject = reject;
    const app: Express = express();

    app.use(cors(corsOptions));
    app.use(express.json());
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

    app.get('/api/server-app/info', (_req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      const rows = getDatabase().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const settings: Record<string, string> = {};
      for (const row of rows) settings[row.key] = row.value;
      res.json({
        language: settings.language || null,
        country: settings.country || null,
        kds_enabled: settings.kds_enabled !== 'false',
      });
    });

    app.post('/api/auth/login', authRateLimit(), (req: Request, res: Response) => {
      if (!isServerAppEnabled()) return res.status(404).json({ error: 'Not found' });
      try {
        const email = normalizeEmail(req.body?.email);
        const { password, remember_me } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const db = getDatabase();
        const bcrypt = require('bcryptjs');
        const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email) as any;
        let passwordMatches = false;
        if (user) {
          try {
            passwordMatches = bcrypt.compareSync(password, user.password);
          } catch {
            passwordMatches = false;
          }
        }
        if (!user || !passwordMatches) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (!['waiter', 'manager', 'owner'].includes(user.role)) {
          return res.status(403).json({ error: 'Access denied. Only service staff allowed.' });
        }

        const token = jwt.sign(
          { userId: user.id, email: user.email, role: user.role, jti: uuidv4() },
          getJWTSecret(),
          { expiresIn: remember_me ? '10d' : '24h' },
        );

        res.json({
          access_token: token,
          user: { id: user.id, name: user.name, email: user.email, role: user.role },
        });
      } catch (error: any) {
        console.error('[Server App] Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/auth/me', requireServerAppAuth, (req: Request, res: Response) => {
      const user = (req as any).user as ServerAppUser;
      const row = getDatabase().prepare('SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1').get(user.userId) as any;
      if (!row) return res.status(401).json({ error: 'Invalid token' });
      res.json({ user: row });
    });

    app.post('/api/auth/logout', requireServerAppAuth, (req: Request, res: Response) => {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) revokeToken(token);
      res.json({ success: true });
    });

    app.get('/api/categories', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/categories'));
    app.get('/api/products', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/products'));
    app.get('/api/tables', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/tables'));
    app.get('/api/orders', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/orders'));
    app.post('/api/orders', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/orders'));
    app.post('/api/orders/:id/items', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, `/orders/${encodeURIComponent(String(req.params.id))}/items`));
    app.get('/api/customers-search', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/customers-search'));
    app.get('/api/crm/lookup', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/crm/lookup'));
    app.post('/api/customers', requireServerAppAuth, (req, res) => forwardToMainApi(req, res, '/customers'));

    const staticDir = getStaticDir();
    if (staticDir) {
      console.log(`[Server App] Serving static files from: ${staticDir}`);
      if (process.platform === 'win32') {
        app.use((req: Request, _res: Response, next: NextFunction) => {
          if (req.path.includes('__next.')) {
            const rewritten = rewriteNextExportPath(req.path);
            if (rewritten !== req.path && fs.existsSync(path.join(staticDir, rewritten))) {
              req.url = rewritten;
            }
          }
          next();
        });
      }
      app.use(express.static(staticDir, { index: false }));
      app.get('/', (_req: Request, res: Response) => res.redirect('/server-standalone'));
      app.get('/*splat', (req: Request, res: Response) => {
        const staticRoot = path.resolve(staticDir);
        const routePath = path.resolve(staticRoot, `.${req.path}`, 'index.html');
        if (routePath.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(routePath)) {
          res.sendFile(routePath);
        } else {
          res.sendFile(path.join(staticDir, 'server-standalone', 'index.html'));
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

    let currentPort = SERVER_APP_PORT;
    let attempts = 0;
    const listeningServer = http.createServer(app);
    serverApp = listeningServer;
    installHttpShutdownTracking(listeningServer);

    const tryListen = () => {
      const attemptedPort = currentPort;
      const onListening = () => {
        if (stopping) {
          try { listeningServer.close(); } catch { return; }
          return;
        }
        startReject = null;
        listeningServer.off('error', onError);
        setServerAppPort(attemptedPort);
        console.log(`[Server App] HTTP server running on http://localhost:${getActiveServerAppPort()}`);
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException) => {
        if (stopping) return;
        listeningServer.off('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          attempts++;
          if (attempts >= 10) {
            const errorMsg = `[Server App] Failed to bind to any port after 10 attempts starting from ${SERVER_APP_PORT}`;
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
          }
          currentPort++;
          console.log(`[Server App] Port ${attemptedPort} in use, trying ${currentPort}`);
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

  stopPromise = closeServerResources(serverToClose, null, 'Server App')
    .then(() => {
      console.log('[Server App] HTTP server stopped');
    });
  return stopPromise;
}

export function getServerAppPort(): number {
  return getActiveServerAppPort();
}
