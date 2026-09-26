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
type EffectRoleRow = EffectRow & { role: string };
type EffectUserRow = EffectRow & { user_id: string };

type Database = ReturnType<typeof getDatabase>;

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

/**
 * The administrative surface an install must never lose: the permission editor,
 * owner/manager account control, the gate on every staff mutation, and store
 * configuration. Losing all four strands the store.
 */
export const ADMINISTRATIVE_PERMISSION_IDS = [
  'authorization.manage',
  'staff.privileged.manage',
  'staff.operational.manage',
  'settings.manage',
] as const satisfies readonly PermissionId[];

export class AdministrationUnreachableError extends Error {
  constructor() {
    // Names the invariant and the action that resolves it, and blames the store
    // rather than the actor: most of the time the actor is not who is locked out.
    super(
      'This change would leave no account able to manage staff, permissions, or store settings. '
      + 'Grant another active owner these permissions first.',
    );
    this.name = 'AdministrationUnreachableError';
  }
}

export class SelfPrivilegeChangeError extends Error {
  constructor() {
    super(
      'This change would remove your own access to staff, permissions, or store settings. '
      + 'Confirm your owner PIN to apply it.',
    );
    this.name = 'SelfPrivilegeChangeError';
  }
}

/** The one post-write state a permission-changing write may propose. */
export type AdministrationCandidate =
  | { kind: 'role_overrides'; role: Role; overrides: ReadonlyMap<PermissionId, PermissionEffect> }
  | { kind: 'user_overrides'; userId: string; overrides: ReadonlyMap<PermissionId, PermissionEffect> }
  | { kind: 'user_state'; userId: string; role: Role; isActive: boolean };

export function reachesAdministration(permissionIds: ReadonlySet<PermissionId>): boolean {
  return ADMINISTRATIVE_PERMISSION_IDS.every((permissionId) => permissionIds.has(permissionId));
}

const NO_OVERRIDES: ReadonlyMap<PermissionId, PermissionEffect> = new Map();

/** Mirrors resolveEffectivePermissions for a single permission id. */
function effectiveAllows(
  permissionId: PermissionId,
  role: Role,
  userOverrides: ReadonlyMap<PermissionId, PermissionEffect>,
  roleOverrides: ReadonlyMap<PermissionId, PermissionEffect>,
): boolean {
  const protectedResult = protectedDecision(permissionId, role);
  if (protectedResult) return protectedResult.allowed;
  const effect = userOverrides.get(permissionId) ?? roleOverrides.get(permissionId);
  return effect ? effectAllows(effect) : permissionDefaultAllows(permissionId, role);
}

/**
 * Guards a write that could leave the store unadministrable. Evaluated against
 * the post-write state, so `candidate` describes the overrides or the account
 * the caller is about to store, never what is already on disk.
 */
export function assertAdministrationReachable(
  db: Database,
  candidate: AdministrationCandidate,
): void {
  const roleOverridesByRole = new Map<Role, Map<PermissionId, PermissionEffect>>();
  for (const row of db.prepare('SELECT role, permission_id, effect FROM role_permission_overrides').all() as EffectRoleRow[]) {
    if (!isRole(row.role) || !isPermissionId(row.permission_id)) continue;
    const overrides = roleOverridesByRole.get(row.role) ?? new Map<PermissionId, PermissionEffect>();
    overrides.set(row.permission_id, row.effect);
    roleOverridesByRole.set(row.role, overrides);
  }

  const userOverridesByUser = new Map<string, Map<PermissionId, PermissionEffect>>();
  for (const row of db.prepare('SELECT user_id, permission_id, effect FROM user_permission_overrides').all() as EffectUserRow[]) {
    if (!isPermissionId(row.permission_id)) continue;
    const overrides = userOverridesByUser.get(row.user_id) ?? new Map<PermissionId, PermissionEffect>();
    overrides.set(row.permission_id, row.effect);
    userOverridesByUser.set(row.user_id, overrides);
  }

  const users = db.prepare('SELECT id, role, is_active FROM users').all() as Array<{
    id: string;
    role: string;
    is_active: number;
  }>;

  for (const user of users) {
    const restated = candidate.kind === 'user_state' && candidate.userId === user.id ? candidate : null;
    const role = restated ? restated.role : user.role;
    const isActive = restated ? restated.isActive : user.is_active === 1;
    if (!isActive || !isRole(role)) continue;

    const roleOverrides = candidate.kind === 'role_overrides' && candidate.role === role
      ? candidate.overrides
      : roleOverridesByRole.get(role) ?? NO_OVERRIDES;
    const userOverrides = candidate.kind === 'user_overrides' && candidate.userId === user.id
      ? candidate.overrides
      : userOverridesByUser.get(user.id) ?? NO_OVERRIDES;

    const administrative = new Set<PermissionId>(
      ADMINISTRATIVE_PERMISSION_IDS.filter((permissionId) =>
        effectiveAllows(permissionId, role, userOverrides, roleOverrides)),
    );
    if (reachesAdministration(administrative)) return;
  }

  throw new AdministrationUnreachableError();
}

/**
 * Guards a write that would take an administrative capability away from the
 * actor making it. Same four capabilities and the same post-write evaluation
 * assertAdministrationReachable performs, scoped to one account: the store may
 * survive the actor's self-lockout, but the actor still has to prove who they
 * are before removing their own way back in.
 */
export function assertActorKeepsOwnAdministration(
  actorUserId: string,
  candidate: AdministrationCandidate,
): void {
  const actor = resolveEffectivePermissions(actorUserId);
  if (!actor) return;

  const roleOverrides = candidate.kind === 'role_overrides' && candidate.role === actor.role
    ? candidate.overrides
    : readRoleOverrides(actor.role);
  const userOverrides = candidate.kind === 'user_overrides' && candidate.userId === actorUserId
    ? candidate.overrides
    : readUserPermissionOverrides(actorUserId);

  const losesOwnAccess = ADMINISTRATIVE_PERMISSION_IDS.some((permissionId) =>
    actor.permissionIds.has(permissionId)
    && !effectiveAllows(permissionId, actor.role, userOverrides, roleOverrides));
  if (losesOwnAccess) throw new SelfPrivilegeChangeError();
}
