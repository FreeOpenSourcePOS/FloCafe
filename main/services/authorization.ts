import type { Request, RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { getDatabase } from '../db';
import {
  PERMISSION_DEFINITIONS,
  isPermissionId,
  permissionDefaultAllows,
  type PermissionEffect,
  type PermissionId,
} from '../../shared/permissions';
import { isRole, type Role } from '../../shared/role-permissions';

export type PermissionSource =
  | 'shipped_default'
  | 'role_override'
  | 'user_override'
  | 'protected_rule';

export type PermissionDecision = {
  allowed: boolean;
  source: PermissionSource;
};

export type EffectivePermissionSet = {
  userId: string;
  role: Role;
  permissionIds: ReadonlySet<PermissionId>;
  decisions: Readonly<Record<PermissionId, PermissionDecision>>;
};

type EffectRow = { permission_id: string; effect: PermissionEffect };

export type PermissionOverride = {
  permissionId: PermissionId;
  effect: PermissionEffect;
};

export type RolePermissionSet = {
  role: Role;
  permissionIds: ReadonlySet<PermissionId>;
  decisions: Readonly<Record<PermissionId, PermissionDecision>>;
};

function effectAllows(effect: PermissionEffect): boolean {
  return effect === 'allow';
}

function protectedDecision(permissionId: PermissionId, role: Role): PermissionDecision | null {
  if (permissionId === 'authorization.manage' || permissionId === 'staff.privileged.manage') {
    return { allowed: role === 'owner', source: 'protected_rule' };
  }
  return null;
}

function readRoleOverrides(role: Role): Map<PermissionId, PermissionEffect> {
  const rows = getDatabase().prepare(
    'SELECT permission_id, effect FROM role_permission_overrides WHERE role = ?',
  ).all(role) as EffectRow[];
  const overrides = new Map<PermissionId, PermissionEffect>();
  for (const row of rows) {
    if (isPermissionId(row.permission_id)) overrides.set(row.permission_id, row.effect);
  }
  return overrides;
}

export function readUserPermissionOverrides(userId: string): Map<PermissionId, PermissionEffect> {
  const rows = getDatabase().prepare(
    'SELECT permission_id, effect FROM user_permission_overrides WHERE user_id = ?',
  ).all(userId) as EffectRow[];
  const overrides = new Map<PermissionId, PermissionEffect>();
  for (const row of rows) {
    if (isPermissionId(row.permission_id)) overrides.set(row.permission_id, row.effect);
  }
  return overrides;
}

export function resolveRolePermissions(role: Role): RolePermissionSet {
  const roleOverrides = readRoleOverrides(role);
  const permissionIds = new Set<PermissionId>();
  const decisions = {} as Record<PermissionId, PermissionDecision>;
  for (const definition of PERMISSION_DEFINITIONS) {
    const protectedResult = protectedDecision(definition.id, role);
    const effect = roleOverrides.get(definition.id);
    const decision = protectedResult
      ?? (effect
        ? { allowed: effectAllows(effect), source: 'role_override' as const }
        : { allowed: permissionDefaultAllows(definition.id, role), source: 'shipped_default' as const });
    decisions[definition.id] = decision;
    if (decision.allowed) permissionIds.add(definition.id);
  }
  return { role, permissionIds, decisions };
}

function overrideRevision(scope: string, overrides: Map<PermissionId, PermissionEffect>): string {
  const serialized = [...overrides.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([permissionId, effect]) => `${permissionId}:${effect}`)
    .join('|');
  return createHash('sha256').update(`${scope}|${serialized}`).digest('hex');
}

export function rolePermissionRevision(role: Role): string {
  return overrideRevision(`role:${role}`, readRoleOverrides(role));
}

export function userPermissionRevision(userId: string): string {
  return overrideRevision(`user:${userId}`, readUserPermissionOverrides(userId));
}

export function effectivePermissionRevision(userId: string): string {
  const resolved = resolveEffectivePermissions(userId);
  if (!resolved) return overrideRevision(`inactive:${userId}`, new Map());
  return createHash('sha256')
    .update(`${resolved.role}|${rolePermissionRevision(resolved.role)}|${userPermissionRevision(userId)}`)
    .digest('hex');
}

/** Resolves current database state; JWT role/permission claims are never authoritative. */
export function resolveEffectivePermissions(userId: string): EffectivePermissionSet | null {
  if (!userId) return null;

  const db = getDatabase();
  const user = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(userId) as
    | { id: string; role: string; is_active: number }
    | undefined;
  if (!user || user.is_active !== 1 || !isRole(user.role)) return null;

  const rolePermissions = resolveRolePermissions(user.role);
  const userOverrides = readUserPermissionOverrides(userId);

  const permissionIds = new Set<PermissionId>();
  const decisions = {} as Record<PermissionId, PermissionDecision>;
  for (const definition of PERMISSION_DEFINITIONS) {
    const permissionId = definition.id;
    const protectedResult = protectedDecision(permissionId, user.role);
    let decision: PermissionDecision;
    if (protectedResult) {
      decision = protectedResult;
    } else if (userOverrides.has(permissionId)) {
      decision = { allowed: effectAllows(userOverrides.get(permissionId)!), source: 'user_override' };
    } else {
      decision = rolePermissions.decisions[permissionId];
    }
    decisions[permissionId] = decision;
    if (decision.allowed) permissionIds.add(permissionId);
  }

  return { userId: user.id, role: user.role, permissionIds, decisions };
}

export function hasPermission(userId: string, permissionId: PermissionId): boolean {
  return resolveEffectivePermissions(userId)?.permissionIds.has(permissionId) === true;
}

/** Permission middleware for migration away from requireRole. */
export function requirePermission(permissionId: PermissionId): RequestHandler {
  return (req, res, next) => {
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    if (!userId) return res.status(401).json({ error: 'Authentication required', code: 'authentication_required' });
    if (!hasPermission(userId, permissionId)) {
      return res.status(403).json({ error: 'Insufficient permissions', code: 'permission_denied', permission: permissionId });
    }
    next();
  };
}

export function requireAnyPermission(...permissionIds: PermissionId[]): RequestHandler {
  return (req, res, next) => {
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    if (!userId) return res.status(401).json({ error: 'Authentication required', code: 'authentication_required' });
    const effective = resolveEffectivePermissions(userId);
    if (!effective || !permissionIds.some((permissionId) => effective.permissionIds.has(permissionId))) {
      return res.status(403).json({ error: 'Insufficient permissions', code: 'permission_denied' });
    }
    next();
  };
}
