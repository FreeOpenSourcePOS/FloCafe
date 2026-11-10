import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getDatabase } from '../db';
import { isTokenStale } from '../middleware/security';
import { getJWTSecret } from './jwt-secret';
import { hasPermission } from '../services/authorization';
import type { PermissionId } from '../../shared/permissions';

export interface IpcAuthResult {
  ok: boolean;
  error?: string;
}

export async function authorizeRendererPermission(
  _event: unknown,
  explicitToken: unknown,
  permissionId: PermissionId,
  options?: { allowPreSetup?: boolean },
): Promise<IpcAuthResult> {
  let rawToken: string | null = null;
  if (typeof explicitToken === 'string' && explicitToken.trim().length > 0) {
    rawToken = explicitToken.trim();
  }

  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    return { ok: false, error: 'Authentication required' };
  }

  let hasUsers = true;
  try {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM users').get() as
      | { count: number }
      | undefined;
    hasUsers = (countRow?.count ?? 0) > 0;
  } catch {
    return { ok: false, error: 'Authentication required' };
  }

  if (!rawToken) {
    if (!hasUsers && options?.allowPreSetup) {
      return { ok: true };
    }
    return { ok: false, error: 'Authentication required' };
  }

  let decoded: { userId?: unknown; iat?: unknown };
  try {
    decoded = jwt.verify(rawToken, getJWTSecret(), { algorithms: ['HS256'] }) as {
      userId?: unknown;
      iat?: unknown;
    };
  } catch {
    return { ok: false, error: 'Authentication required' };
  }

  if (!decoded || typeof decoded.userId !== 'string' || !decoded.userId) {
    return { ok: false, error: 'Authentication required' };
  }

  try {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const revoked = db
      .prepare('SELECT 1 AS revoked FROM revoked_tokens WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, Date.now()) as { revoked: number } | undefined;
    if (revoked?.revoked === 1) {
      return { ok: false, error: 'Authentication required' };
    }

    const user = db
      .prepare('SELECT is_active, tokens_valid_after FROM users WHERE id = ?')
      .get(decoded.userId) as { is_active: number; tokens_valid_after: string | null } | undefined;
    if (!user || user.is_active !== 1) {
      return { ok: false, error: 'Authentication required' };
    }
    if (
      isTokenStale(
        typeof decoded.iat === 'number' ? decoded.iat : undefined,
        user.tokens_valid_after,
      )
    ) {
      return { ok: false, error: 'Authentication required' };
    }

    if (!hasPermission(decoded.userId, permissionId)) {
      return { ok: false, error: 'Insufficient permissions' };
    }
  } catch {
    return { ok: false, error: 'Authentication required' };
  }

  return { ok: true };
}
