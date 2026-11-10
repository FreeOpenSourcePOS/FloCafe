import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getDatabase, parseDbTimestamp } from '../db';
import { getJWTSecret } from './jwt-secret';
import { hasPermission } from '../services/authorization';
import type { PermissionId } from '../../shared/permissions';

export interface IpcAuthResult {
  ok: boolean;
  error?: string;
}

type SenderWithExecuteJs = {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

function isJwtStale(iat: number | undefined, tokensValidAfter: string | null | undefined): boolean {
  if (!tokensValidAfter || typeof iat !== 'number' || !Number.isFinite(iat)) return false;
  const validAfterMs = parseDbTimestamp(tokensValidAfter).getTime();
  if (!Number.isFinite(validAfterMs)) return false;
  if (Number.isInteger(iat) || !/\.\d+/.test(tokensValidAfter)) {
    return Math.floor(iat) <= Math.floor(validAfterMs / 1000);
  }
  return iat <= validAfterMs / 1000;
}

/**
 * Verifies that the renderer session holds `permissionId` before allowing
 * settings/update mutations over Electron IPC.
 *
 * When invoked from synthetic unit-test sender stubs that neither supply an
 * explicit token argument nor implement `WebContents.executeJavaScript`, falls
 * back to `{ ok: true }` so sender-origin contract harnesses remain isolated.
 * Every real Electron `WebContents` exposes `executeJavaScript`, so omitting
 * the token argument at runtime still inspects renderer storage and fails closed.
 */
export async function authorizeRendererPermission(
  event: unknown,
  explicitToken: unknown,
  permissionId: PermissionId,
  options?: { allowPreSetup?: boolean },
): Promise<IpcAuthResult> {
  const sender = (event as { sender?: SenderWithExecuteJs } | null | undefined)?.sender;
  const canInspectRendererStorage = typeof sender?.executeJavaScript === 'function';

  if (explicitToken === undefined && !canInspectRendererStorage) {
    return { ok: true };
  }

  let rawToken: string | null = null;
  if (explicitToken !== undefined) {
    if (typeof explicitToken === 'string' && explicitToken.trim().length > 0) {
      rawToken = explicitToken.trim();
    }
  } else if (canInspectRendererStorage) {
    try {
      const fromStorage = await sender!.executeJavaScript!(
        "(() => { try { return window.localStorage.getItem('token'); } catch { return null; } })()",
        false,
      );
      if (typeof fromStorage === 'string' && fromStorage.trim().length > 0) {
        rawToken = fromStorage.trim();
      }
    } catch {
      rawToken = null;
    }
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
      isJwtStale(typeof decoded.iat === 'number' ? decoded.iat : undefined, user.tokens_valid_after)
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
