import { randomBytes } from 'crypto';
import { getDatabase, now } from '../db';

/**
 * Owner of the installation's JWT signing secret and its single module-level
 * cache. Both the read path (`getJWTSecret`) and the invalidation path
 * (`clearJWTSecretCache`) must live in this one module: if the cache were
 * split, a database restore would clear one copy while token issuance reads
 * the other, and tokens minted before the restore would keep validating after
 * it. `tests/jwt-secret-cache-identity.test.ts` pins that identity.
 */

/** Lazy-loaded JWT secret stored in settings table, generated on first launch. */
let _jwtSecret: string | null = null;

export function clearJWTSecretCache(): void {
  _jwtSecret = null;
}

export function getJWTSecret(): string {
  if (_jwtSecret) return _jwtSecret;

  // Environment variable always wins (for CI/testing)
  if (process.env.JWT_SECRET) {
    _jwtSecret = process.env.JWT_SECRET;
    return _jwtSecret;
  }

  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;

    if (row?.value) {
      _jwtSecret = row.value;
    } else {
      // First launch: generate, persist, read back, and only then cache. The
      // cache is populated from what the database actually stored rather than
      // from the value that was offered to the write, so nothing that the
      // database can no longer confirm is ever handed out. A process that dies
      // between the write and the cache, or whose write or read-back fails,
      // leaves no cached secret behind - a secret that exists only in memory
      // signs tokens that no later process, the KDS server included, can
      // verify.
      const generated = randomBytes(32).toString('hex');
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('jwt_secret', ?, ?)")
        .run(generated, now());
      const stored = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;
      if (!stored?.value) throw new Error('JWT secret write did not persist');
      _jwtSecret = stored.value;
      console.log('[Auth] Generated new JWT secret for this install');
    }
  } catch (err) {
    // Database not ready — refuse to operate with a static secret.
    // JWT operations will fail until the database is accessible. The cache
    // stays empty so the next call retries instead of serving a value that
    // was never persisted.
    _jwtSecret = null;
    console.error('[Auth] Database not ready — JWT secret unavailable:', err);
    throw new Error('Database not ready — authentication unavailable');
  }

  return _jwtSecret;
}
