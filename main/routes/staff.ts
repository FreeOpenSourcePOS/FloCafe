/**
 * /api/staff  — alias for /api/users, kept for frontend compatibility.
 * All user records live in the `users` table.
 * Roles: owner | manager | cashier | waiter | chef
 * The chef role is used by KDS displays.
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, now } from '../db';
import { requireRole, validatePassword, authRateLimit, invalidateUserAuthCache } from '../middleware/security';

const router = Router();

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT id, name, email, role, is_active, created_at, updated_at FROM users WHERE 1=1';
    const params: any[] = [];

    if (req.query.role) {
      query += ' AND role = ?';
      params.push(req.query.role);
    }
    if (req.query.active === 'true') {
      query += ' AND is_active = 1';
    }
    if (req.query.active === 'false') {
      query += ' AND is_active = 0';
    }

    query += ' ORDER BY role, name';

    const staff = db.prepare(query).all(...params);
    res.json({ staff });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Get one ───────────────────────────────────────────────────────────────────

router.get('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare(
      'SELECT id, name, email, role, is_active, created_at, updated_at FROM users WHERE id = ?'
    ).get(req.params.id) as any;

    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const performance = db.prepare(`
      SELECT COUNT(*) as orders_served, COALESCE(SUM(total), 0) as total_sales
      FROM orders
      WHERE user_id = ? AND date(created_at) = date('now')
    `).get(req.params.id);

    res.json({ staff: { ...member, performance } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/', requireRole('owner', 'manager'), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, password, role, pin } = req.body;

    if (!name || !password || !role) {
      return res.status(400).json({ error: 'name, password, and role are required' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    const validRoles = ['owner', 'manager', 'cashier', 'waiter', 'chef'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    // Only owners can create other owner accounts (privilege escalation guard)
    if (role === 'owner' && (req as any).user.role !== 'owner') {
      return res.status(403).json({ error: 'Only owners can create owner accounts' });
    }

    const db = getDatabase();

    if (email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);

    const hashedPin = pin ? bcrypt.hashSync(String(pin), 10) : null;

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, email || null, hashedPassword, role, hashedPin, now(), now());

    const member = db.prepare(
      'SELECT id, name, email, role, is_active, created_at, updated_at FROM users WHERE id = ?'
    ).get(id);

    res.status(201).json({ staff: member });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', requireRole('owner', 'manager'), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, password, role, pin, is_active } = req.body;
    const db = getDatabase();

    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    if (role) {
      const validRoles = ['owner', 'manager', 'cashier', 'waiter', 'chef'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      }
      // Only owners can assign or change roles
      if ((req as any).user.role !== 'owner') {
        return res.status(403).json({ error: 'Only owners can change roles' });
      }
    }

    if (email && email !== member.email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.params.id);
      if (existing) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    if (password && !validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    const hashedPassword = password ? bcrypt.hashSync(password, 10) : member.password;
    const hashedPin = pin !== undefined
      ? (pin ? bcrypt.hashSync(String(pin), 10) : null)
      : member.pin_hash;

    db.prepare(`
      UPDATE users SET
        name       = COALESCE(?, name),
        email      = COALESCE(?, email),
        password   = ?,
        role       = COALESCE(?, role),
        pin_hash   = ?,
        is_active  = COALESCE(?, is_active),
        updated_at = ?
      WHERE id = ?
    `).run(
      name || null, email || null, hashedPassword,
      role || null, hashedPin,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      now(), req.params.id
    );
    invalidateUserAuthCache(req.params.id);

    const updated = db.prepare(
      'SELECT id, name, email, role, is_active, created_at, updated_at FROM users WHERE id = ?'
    ).get(req.params.id);

    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Activate / Deactivate ─────────────────────────────────────────────────────
// Staff are never hard-deleted — orders.user_id and print_logs.user_id reference
// them, and losing the row would orphan historical order/print records.
// Deactivating is the only removal path.

router.post('/:id/deactivate', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 0) return res.status(400).json({ error: 'Already deactivated' });

    // Prevent deactivating the last owner
    if (member.role === 'owner') {
      const ownerCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ? AND is_active = 1').get('owner') as any).c;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot deactivate the last owner account' });
      }
    }

    db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    invalidateUserAuthCache(req.params.id);
    const updated = db.prepare(
      'SELECT id, name, email, role, is_active, created_at, updated_at FROM users WHERE id = ?'
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/reactivate', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 1) return res.status(400).json({ error: 'Already active' });

    db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    invalidateUserAuthCache(req.params.id);
    const updated = db.prepare(
      'SELECT id, name, email, role, is_active, created_at, updated_at FROM users WHERE id = ?'
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const staffRoutes = router;
