/**
 * /api/staff  — alias for /api/users, kept for frontend compatibility.
 * All user records live in the `users` table.
 * Roles: owner | manager | cashier | server | chef
 * The chef role is used by KDS displays.
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, now } from '../db';
import { requireRole, validatePassword, authRateLimit, invalidateUserAuthCache } from '../middleware/security';
import { ROLE_ACCESS, ROLE_KEYS, hasRole } from '../../shared/role-permissions';

const router = Router();

const OPERATIONAL_ROLES: readonly string[] = ['cashier', 'server', 'chef'];
const VALID_ROLES: readonly string[] = ROLE_KEYS;
const STAFF_SELECT_FIELDS = 'id, name, email, role, (pin_hash IS NOT NULL) AS has_pin, is_active, created_at, updated_at';

function canModifyTargetStaff(requesterRole: string, targetRole: string): boolean {
  if (requesterRole === 'owner') return true;
  if (requesterRole === 'manager') return !hasRole(targetRole, ROLE_ACCESS.ownerManager);
  return false;
}

function isOperationalRole(role: string): boolean {
  return OPERATIONAL_ROLES.includes(role);
}

function hasNonEmptyPin(pin: unknown): boolean {
  return pin !== undefined && pin !== null && String(pin).length > 0;
}

function isValidPin(pin: unknown): boolean {
  return /^\d{4,6}$/.test(String(pin));
}

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE 1=1`;
    const params: any[] = [];

    if (req.query.role) {
      if (typeof req.query.role !== 'string' || !VALID_ROLES.includes(req.query.role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
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

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
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

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, password, role, pin } = req.body;

    if (!name || !password || !role) {
      return res.status(400).json({ error: 'name, password, and role are required' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const requesterRole = (req as any).user.role;
    if (requesterRole === 'manager' && !isOperationalRole(role)) {
      return res.status(403).json({ error: 'Managers can only create operational staff accounts (cashier, server, chef)' });
    }

    if (isOperationalRole(role) && hasNonEmptyPin(pin)) {
      return res.status(400).json({ error: 'PINs are only permitted for owner and manager roles' });
    }
    if (hasNonEmptyPin(pin) && !isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be between 4 and 6 numeric digits' });
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

    const hashedPin = hasNonEmptyPin(pin) ? bcrypt.hashSync(String(pin), 10) : null;

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, email || null, hashedPassword, role, hashedPin, now(), now());

    const member = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(id);

    res.status(201).json({ staff: member });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, password, role, pin, is_active } = req.body;
    const db = getDatabase();

    if (is_active !== undefined) {
      return res.status(400).json({ error: 'Use /deactivate or /reactivate endpoints to change account status' });
    }

    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const requesterRole = (req as any).user.role;
    if (!canModifyTargetStaff(requesterRole, member.role)) {
      return res.status(403).json({ error: 'Managers cannot modify owner or manager accounts' });
    }

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      if (role !== member.role && requesterRole !== 'owner') {
        return res.status(403).json({ error: 'Only owners can change roles' });
      }
    }

    const targetRole = role ?? member.role;
    if (isOperationalRole(targetRole) && hasNonEmptyPin(pin)) {
      return res.status(400).json({ error: 'PINs are only permitted for owner and manager roles' });
    }
    if (hasNonEmptyPin(pin) && !isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be between 4 and 6 numeric digits' });
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
    const hashedPin = isOperationalRole(targetRole)
      ? null
      : pin !== undefined
        ? (hasNonEmptyPin(pin) ? bcrypt.hashSync(String(pin), 10) : null)
        : member.pin_hash;

    // Revoke this user's outstanding sessions only when a credential actually
    // changed (not on a bare name/email/role edit) — matches auth.ts's
    // password/change and recover-password (#173).
    const credentialsChanged = hashedPassword !== member.password || hashedPin !== member.pin_hash;
    const tokensValidAfter = credentialsChanged ? now() : member.tokens_valid_after;

    const demotesActiveOwner = member.role === 'owner' && member.is_active === 1 && targetRole !== 'owner';
    const result = db.prepare(`
      UPDATE users SET
        name       = COALESCE(?, name),
        email      = COALESCE(?, email),
        password   = ?,
        role       = COALESCE(?, role),
        pin_hash   = ?,
        tokens_valid_after = ?,
        updated_at = ?
      WHERE id = ?
        AND (
          ? = 0
          OR (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) > 1
        )
    `).run(
      name || null, email || null, hashedPassword,
      role || null, hashedPin, tokensValidAfter,
      now(), req.params.id, demotesActiveOwner ? 1 : 0,
    );
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Cannot change the role of the last active owner. Create or promote another active owner first.' });
    }
    invalidateUserAuthCache(req.params.id as string);

    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
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

router.post('/:id/deactivate', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 0) return res.status(400).json({ error: 'Already deactivated' });

    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot deactivate or reactivate owner or manager accounts' });
    }

    const changedAt = now();
    const result = db.prepare(`
      UPDATE users SET is_active = 0, tokens_valid_after = ?, updated_at = ?
      WHERE id = ? AND is_active = 1
        AND (role != 'owner' OR (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) > 1)
    `).run(changedAt, changedAt, req.params.id);
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Cannot deactivate the last owner account' });
    }
    invalidateUserAuthCache(req.params.id as string);
    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/reactivate', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 1) return res.status(400).json({ error: 'Already active' });

    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot deactivate or reactivate owner or manager accounts' });
    }

    db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    invalidateUserAuthCache(req.params.id as string);
    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const staffRoutes = router;
