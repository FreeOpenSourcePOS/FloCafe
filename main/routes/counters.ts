import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getDatabase, now } from '../db';
import { requireAnyPermission, requirePermission } from '../services/authorization';

const router = Router();

function parseInteger(value: unknown, defaultValue = 0): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : defaultValue;
}

export interface CounterRow {
  id: string;
  name: string;
  role: 'ordering' | 'payment' | 'combined';
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const ALLOWED_ROLES = new Set(['ordering', 'payment', 'combined']);

function normalizeCounterName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  return trimmed;
}

function normalizeCounterRole(raw: unknown): 'ordering' | 'payment' | 'combined' | null {
  if (typeof raw !== 'string') return null;
  const role = raw.trim().toLowerCase();
  return ALLOWED_ROLES.has(role) ? (role as 'ordering' | 'payment' | 'combined') : null;
}

function normalizeIsActive(raw: unknown, defaultValue = 1): number {
  if (raw === undefined || raw === null) return defaultValue;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 1;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 0;
  return defaultValue;
}

function isOwner(req: Request): boolean {
  const user = (req as Request & { user?: { role?: string } }).user;
  return user?.role === 'owner';
}

// GET /api/counters — List counters
router.get(
  '/',
  requireAnyPermission(
    'pos.use',
    'orders.read',
    'orders.create',
    'payments.take',
    'settings.view',
    'settings.manage',
  ),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const includeInactive = req.query.include_inactive === 'true' || req.query.all === 'true';

      const counters = includeInactive
        ? (db.prepare('SELECT * FROM counters ORDER BY sort_order ASC, name ASC').all() as CounterRow[])
        : (db.prepare('SELECT * FROM counters WHERE is_active = 1 ORDER BY sort_order ASC, name ASC').all() as CounterRow[]);

      res.json({ counters });
    } catch (error: unknown) {
      console.error('[Counters] Error listing counters:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/counters/:id — Get a single counter
router.get(
  '/:id',
  requireAnyPermission(
    'pos.use',
    'orders.read',
    'orders.create',
    'payments.take',
    'settings.view',
    'settings.manage',
  ),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const counter = db.prepare('SELECT * FROM counters WHERE id = ?').get(req.params.id) as CounterRow | undefined;
      if (!counter) {
        return res.status(404).json({ error: 'Counter not found' });
      }
      res.json({ counter });
    } catch (error: unknown) {
      console.error('[Counters] Error fetching counter:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/counters — Create counter (owner only)
router.post(
  '/',
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      if (!isOwner(req)) {
        return res.status(403).json({ error: 'Only the store owner can modify counter configuration' });
      }

      const name = normalizeCounterName(req.body?.name);
      if (!name) {
        return res.status(400).json({ error: 'Counter name is required (1-100 characters)' });
      }

      const role = normalizeCounterRole(req.body?.role);
      if (!role) {
        return res.status(400).json({ error: 'Counter role must be ordering, payment, or combined' });
      }

      const isActive = normalizeIsActive(req.body?.is_active, 1);
      const sortOrder = parseInteger(req.body?.sort_order, 0);

      const db = getDatabase();
      const id = `cnt_${randomUUID()}`;
      const nowStr = now();

      db.prepare(`
        INSERT INTO counters (id, name, role, is_active, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, role, isActive, sortOrder, nowStr, nowStr);

      const created = db.prepare('SELECT * FROM counters WHERE id = ?').get(id) as CounterRow;
      res.status(201).json({ counter: created });
    } catch (error: unknown) {
      console.error('[Counters] Error creating counter:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PUT /api/counters/:id — Update counter (owner only)
router.put(
  '/:id',
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      if (!isOwner(req)) {
        return res.status(403).json({ error: 'Only the store owner can modify counter configuration' });
      }

      const db = getDatabase();
      const existing = db.prepare('SELECT * FROM counters WHERE id = ?').get(req.params.id) as CounterRow | undefined;
      if (!existing) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      let name = existing.name;
      if (req.body?.name !== undefined) {
        const normalized = normalizeCounterName(req.body.name);
        if (!normalized) {
          return res.status(400).json({ error: 'Counter name must be 1-100 characters' });
        }
        name = normalized;
      }

      let role = existing.role;
      if (req.body?.role !== undefined) {
        const normalized = normalizeCounterRole(req.body.role);
        if (!normalized) {
          return res.status(400).json({ error: 'Counter role must be ordering, payment, or combined' });
        }
        role = normalized;
      }

      const isActive = req.body?.is_active !== undefined ? normalizeIsActive(req.body.is_active, existing.is_active) : existing.is_active;
      const sortOrder = req.body?.sort_order !== undefined ? parseInteger(req.body.sort_order, existing.sort_order) : existing.sort_order;
      const nowStr = now();

      db.prepare(`
        UPDATE counters
        SET name = ?, role = ?, is_active = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `).run(name, role, isActive, sortOrder, nowStr, existing.id);

      const updated = db.prepare('SELECT * FROM counters WHERE id = ?').get(existing.id) as CounterRow;
      res.json({ counter: updated });
    } catch (error: unknown) {
      console.error('[Counters] Error updating counter:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// DELETE /api/counters/:id — Delete counter (owner only)
router.delete(
  '/:id',
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      if (!isOwner(req)) {
        return res.status(403).json({ error: 'Only the store owner can modify counter configuration' });
      }

      const db = getDatabase();
      const existing = db.prepare('SELECT id FROM counters WHERE id = ?').get(req.params.id) as { id: string } | undefined;
      if (!existing) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      db.prepare('DELETE FROM counters WHERE id = ?').run(existing.id);
      res.json({ success: true });
    } catch (error: unknown) {
      console.error('[Counters] Error deleting counter:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export const counterRoutes = router;
