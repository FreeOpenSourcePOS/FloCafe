import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getDatabase, now, verifyPin } from '../db';
import { requirePermission } from '../services/authorization';
import {
  AdministrationUnreachableError,
  SelfPrivilegeChangeError,
  assertActorKeepsOwnAdministration,
  assertAdministrationReachable,
  readUserPermissionOverrides,
  resolveEffectivePermissions,
  resolveRolePermissions,
  rolePermissionRevision,
  userPermissionRevision,
  type AdministrationCandidate,
} from '../services/authorization';
import {
  PERMISSION_DEFINITIONS,
  isPermissionId,
  type PermissionEffect,
  type PermissionId,
} from '../../shared/permissions';
import { isRole, ROLE_KEYS, type Role } from '../../shared/role-permissions';

const router = Router();
const MAX_OVERRIDES = PERMISSION_DEFINITIONS.length;

type OverrideInput = { permission_id?: unknown; effect?: unknown };

function actorId(req: Request): string {
  return String((req as Request & { user?: { userId?: string } }).user?.userId || '');
}

/**
 * Evaluates both post-write guards against `candidate` and reports whether the
 * response has already been sent, in the order that helps the caller. The store
 * first: no factor rescues a write that would strand it, so that refusal stays a
 * 400 naming the remedy. The actor second: a self-lockout is recoverable by
 * proving who you are, so it is a 428 naming the factor. The factor is the staff
 * PIN that already authorises privileged writes everywhere else in this
 * repository, sent as `override_pin` and checked with the shared verifyPin.
 * Both run before the write, so a refusal stores nothing.
 */
function preflightOverrides(req: Request, res: Response, candidate: AdministrationCandidate): boolean {
  try {
    assertAdministrationReachable(getDatabase(), candidate);
  } catch (error) {
    if (!(error instanceof AdministrationUnreachableError)) throw error;
    res.status(400).json({ error: error.message, code: 'administration_unreachable' });
    return true;
  }

  const actor = actorId(req);
  try {
    assertActorKeepsOwnAdministration(actor, candidate);
    return false;
  } catch (error) {
    if (!(error instanceof SelfPrivilegeChangeError)) throw error;
    const pinHash = (getDatabase().prepare('SELECT pin_hash FROM users WHERE id = ?').get(actor) as { pin_hash: string | null } | undefined)?.pin_hash;
    if (verifyPin(pinHash, req.body?.override_pin)) return false;
    res.status(428).json({ error: error.message, code: 'self_privilege_change_requires_factor', requires: 'pin' });
    return true;
  }
}

function parseOverrides(value: unknown): Map<PermissionId, PermissionEffect> | null {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES) return null;
  const parsed = new Map<PermissionId, PermissionEffect>();
  for (const entry of value as OverrideInput[]) {
    if (!entry || typeof entry !== 'object' || !isPermissionId(entry.permission_id)) return null;
    if (entry.effect !== 'allow' && entry.effect !== 'deny') return null;
    const definition = PERMISSION_DEFINITIONS.find(({ id }) => id === entry.permission_id);
    if (!definition?.configurable || parsed.has(entry.permission_id)) return null;
    parsed.set(entry.permission_id, entry.effect);
  }
  return parsed;
}

function serializeOverrides(overrides: Map<PermissionId, PermissionEffect>) {
  return [...overrides.entries()]
    .filter(([permissionId]) => PERMISSION_DEFINITIONS.find(({ id }) => id === permissionId)?.configurable)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([permissionId, effect]) => ({ permission_id: permissionId, effect }));
}

function rolePayload(role: Role) {
  const resolved = resolveRolePermissions(role);
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT permission_id, effect FROM role_permission_overrides WHERE role = ? ORDER BY permission_id',
  ).all(role) as Array<{ permission_id: string; effect: PermissionEffect }>;
  return {
    role,
    revision: rolePermissionRevision(role),
    overrides: rows.filter(({ permission_id }) => isPermissionId(permission_id)
      && PERMISSION_DEFINITIONS.find(({ id }) => id === permission_id)?.configurable),
    permissions: PERMISSION_DEFINITIONS.map((definition) => ({
      permission_id: definition.id,
      allowed: resolved.decisions[definition.id].allowed,
      source: resolved.decisions[definition.id].source,
    })),
  };
}

function userPayload(userId: string) {
  const db = getDatabase();
  const user = db.prepare('SELECT id, name, email, role, is_active FROM users WHERE id = ?').get(userId) as
    | { id: string; name: string; email: string | null; role: string; is_active: number }
    | undefined;
  if (!user || !isRole(user.role)) return null;
  const resolved = resolveEffectivePermissions(userId);
  const overrides = readUserPermissionOverrides(userId);
  return {
    user,
    revision: userPermissionRevision(userId),
    overrides: serializeOverrides(overrides),
    permissions: PERMISSION_DEFINITIONS.map((definition) => ({
      permission_id: definition.id,
      allowed: resolved?.decisions[definition.id].allowed ?? false,
      source: resolved?.decisions[definition.id].source ?? 'shipped_default',
    })),
  };
}

function writeAudit(
  actorUserId: string,
  batchId: string,
  targetType: 'role' | 'user',
  targetId: string,
  permissionId: PermissionId,
  previousEffect: PermissionEffect | null,
  nextEffect: PermissionEffect | null,
): void {
  getDatabase().prepare(`
    INSERT INTO authorization_audit_log (
      batch_id, actor_user_id, target_type, target_id, permission_id,
      previous_effect, next_effect, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(batchId, actorUserId, targetType, targetId, permissionId, previousEffect, nextEffect, now());
}

router.use(requirePermission('authorization.manage'));

router.get('/catalog', (_req: Request, res: Response) => {
  res.json({ permissions: PERMISSION_DEFINITIONS, roles: ROLE_KEYS });
});

router.get('/roles', (_req: Request, res: Response) => {
  res.json({ roles: ROLE_KEYS.map((role) => rolePayload(role)) });
});

router.put('/roles/:role', (req: Request, res: Response) => {
  const role = String(req.params.role);
  if (!isRole(role)) return res.status(400).json({ error: 'Invalid role', code: 'invalid_role' });
  const overrides = parseOverrides(req.body?.overrides);
  if (!overrides) return res.status(400).json({ error: 'Invalid permission overrides', code: 'invalid_permission_overrides' });
  if (typeof req.body?.revision !== 'string') return res.status(400).json({ error: 'revision is required', code: 'revision_required' });
  if (req.body.revision !== rolePermissionRevision(role)) {
    return res.status(409).json({ error: 'Permissions changed in another session', code: 'revision_conflict', role: rolePayload(role) });
  }

  const db = getDatabase();
  const actor = actorId(req);
  const batchId = randomUUID();
  if (preflightOverrides(req, res, { kind: 'role_overrides', role, overrides })) return;
  db.transaction(() => {
    const previous = new Map<PermissionId, PermissionEffect>();
    const rows = db.prepare('SELECT permission_id, effect FROM role_permission_overrides WHERE role = ?').all(role) as Array<{ permission_id: string; effect: PermissionEffect }>;
    for (const row of rows) if (isPermissionId(row.permission_id)) previous.set(row.permission_id, row.effect);
    db.prepare('DELETE FROM role_permission_overrides WHERE role = ?').run(role);
    const insert = db.prepare(`
      INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [permissionId, effect] of overrides) insert.run(role, permissionId, effect, actor, now(), now());
    const changed = new Set<PermissionId>([...previous.keys(), ...overrides.keys()]);
    for (const permissionId of changed) {
      const before = previous.get(permissionId) ?? null;
      const after = overrides.get(permissionId) ?? null;
      if (before !== after) writeAudit(actor, batchId, 'role', role, permissionId, before, after);
    }
  })();
  res.json({ role: rolePayload(role) });
});

router.get('/users', (_req: Request, res: Response) => {
  const users = getDatabase().prepare(`
    SELECT id, name, email, role, (pin_hash IS NOT NULL) AS has_pin, is_active, created_at, updated_at
    FROM users ORDER BY role, name
  `).all();
  res.json({ users });
});

router.get('/users/:userId', (req: Request, res: Response) => {
  const payload = userPayload(String(req.params.userId));
  if (!payload) return res.status(404).json({ error: 'Staff member not found', code: 'staff_not_found' });
  res.json(payload);
});

router.put('/users/:userId', (req: Request, res: Response) => {
  const userId = String(req.params.userId);
  if (!userPayload(userId)) return res.status(404).json({ error: 'Staff member not found', code: 'staff_not_found' });
  const overrides = parseOverrides(req.body?.overrides);
  if (!overrides) return res.status(400).json({ error: 'Invalid permission overrides', code: 'invalid_permission_overrides' });
  if (typeof req.body?.revision !== 'string') return res.status(400).json({ error: 'revision is required', code: 'revision_required' });
  if (req.body.revision !== userPermissionRevision(userId)) {
    return res.status(409).json({ error: 'Permissions changed in another session', code: 'revision_conflict', user: userPayload(userId) });
  }

  const db = getDatabase();
  const actor = actorId(req);
  const batchId = randomUUID();
  if (preflightOverrides(req, res, { kind: 'user_overrides', userId, overrides })) return;
  db.transaction(() => {
    const previous = readUserPermissionOverrides(userId);
    db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [permissionId, effect] of overrides) insert.run(userId, permissionId, effect, actor, now(), now());
    const changed = new Set<PermissionId>([...previous.keys(), ...overrides.keys()]);
    for (const permissionId of changed) {
      const before = previous.get(permissionId) ?? null;
      const after = overrides.get(permissionId) ?? null;
      if (before !== after) writeAudit(actor, batchId, 'user', userId, permissionId, before, after);
    }
  })();
  res.json(userPayload(userId));
});

router.delete('/users/:userId/overrides', (req: Request, res: Response) => {
  const userId = String(req.params.userId);
  const payload = userPayload(userId);
  if (!payload) return res.status(404).json({ error: 'Staff member not found', code: 'staff_not_found' });
  if (typeof req.body?.revision !== 'string') return res.status(400).json({ error: 'revision is required', code: 'revision_required' });
  if (req.body.revision !== payload.revision) {
    return res.status(409).json({ error: 'Permissions changed in another session', code: 'revision_conflict', user: payload });
  }
  const actor = actorId(req);
  const db = getDatabase();
  const batchId = randomUUID();
  if (preflightOverrides(req, res, { kind: 'user_overrides', userId, overrides: new Map() })) return;
  db.transaction(() => {
    const previous = readUserPermissionOverrides(userId);
    db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(userId);
    for (const [permissionId, effect] of previous) writeAudit(actor, batchId, 'user', userId, permissionId, effect, null);
  })();
  res.json(userPayload(userId));
});

router.get('/audit', (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));
  const beforeId = Number.parseInt(String(req.query.before_id || ''), 10);
  const rows = Number.isInteger(beforeId) && beforeId > 0
    ? getDatabase().prepare(`
        SELECT audit.*, users.name AS actor_name
        FROM authorization_audit_log audit
        LEFT JOIN users ON users.id = audit.actor_user_id
        WHERE audit.id < ? ORDER BY audit.id DESC LIMIT ?
      `).all(beforeId, limit)
    : getDatabase().prepare(`
        SELECT audit.*, users.name AS actor_name
        FROM authorization_audit_log audit
        LEFT JOIN users ON users.id = audit.actor_user_id
        ORDER BY audit.id DESC LIMIT ?
      `).all(limit);
  res.json({ audit: rows });
});

export const authorizationRoutes = router;
