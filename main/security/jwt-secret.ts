import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabase, now } from '../db';

/** Settings value standing in for the secret once it lives in OS-backed storage. */
export const JWT_SECRET_SAFE_STORAGE_MARKER = 'safe-storage:v1';
const JWT_SECRET_FILE = 'jwt-secret.enc';

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Electron's safeStorage and userData path, or null outside Electron or without OS encryption. */
function getSecureStore(): { storage: SafeStorageLike; filePath: string } | null {
  try {
    const { app, safeStorage } = require('electron') as {
      app?: { isPackaged?: boolean; getPath(name: string): string };
      safeStorage?: SafeStorageLike;
    };
    if (!app?.isPackaged || !safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    return { storage: safeStorage, filePath: path.join(app.getPath('userData'), JWT_SECRET_FILE) };
  } catch {
    return null;
  }
}

function readSecureSecret(store: { storage: SafeStorageLike; filePath: string }): string | null {
  try {
    const value = store.storage.decryptString(fs.readFileSync(store.filePath));
    return value || null;
  } catch {
    return null;
  }
}

function writeSecureSecret(
  store: { storage: SafeStorageLike; filePath: string },
  secret: string,
): boolean {
  try {
    fs.writeFileSync(store.filePath, store.storage.encryptString(secret), { mode: 0o600 });
    return readSecureSecret(store) === secret;
  } catch {
    return false;
  }
}

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
    const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as
      | { value: string }
      | undefined;
    const store = getSecureStore();

    if (row?.value === JWT_SECRET_SAFE_STORAGE_MARKER && store) {
      const secure = readSecureSecret(store);
      if (secure) {
        _jwtSecret = secure;
      } else {
        // The OS keychain no longer yields the secret: issue a new one, which
        // signs out existing sessions but keeps authentication available.
        const regenerated = randomBytes(32).toString('hex');
        if (!writeSecureSecret(store, regenerated))
          throw new Error('JWT secret write did not persist');
        _jwtSecret = regenerated;
        console.warn('[Auth] Secure JWT secret was unreadable; generated a new one');
      }
    } else if (row?.value === JWT_SECRET_SAFE_STORAGE_MARKER) {
      throw new Error(
        'JWT secret is held in OS secure storage, which is unavailable in this process',
      );
    } else if (row?.value) {
      _jwtSecret = row.value;
      // Upgrade: move the plaintext secret out of SQLite once secure storage verifies the round trip.
      if (store && writeSecureSecret(store, row.value)) {
        db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'jwt_secret'").run(
          JWT_SECRET_SAFE_STORAGE_MARKER,
          now(),
        );
        console.log('[Auth] Moved JWT secret to OS-backed secure storage');
      }
    } else {
      // First launch: generate, persist, read back, and only then cache. The
      // cache is populated from what the store actually returned rather than
      // from the value that was offered to the write, so nothing that storage
      // can no longer confirm is ever handed out. A process that dies
      // between the write and the cache, or whose write or read-back fails,
      // leaves no cached secret behind - a secret that exists only in memory
      // signs tokens that no later process, the KDS server included, can
      // verify.
      const generated = randomBytes(32).toString('hex');
      if (store && writeSecureSecret(store, generated)) {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('jwt_secret', ?, ?)",
        ).run(JWT_SECRET_SAFE_STORAGE_MARKER, now());
        const readBack = readSecureSecret(store);
        if (!readBack) throw new Error('JWT secret write did not persist');
        _jwtSecret = readBack;
      } else {
        db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('jwt_secret', ?, ?)").run(
          generated,
          now(),
        );
        const stored = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as
          | { value: string }
          | undefined;
        if (!stored?.value) throw new Error('JWT secret write did not persist');
        _jwtSecret = stored.value;
      }
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
