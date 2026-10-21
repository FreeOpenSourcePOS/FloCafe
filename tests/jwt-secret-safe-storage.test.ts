/**
 * The JWT signing secret lives in OS-backed storage when available: new installs never write it to SQLite,
 * upgraded installs move it out of SQLite, and installs without OS encryption keep the SQLite fallback.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/jwt-secret-safe-storage.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-jwt-safe-storage-'));
let encryptionAvailable = true;
let isPackaged = true;
Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: {
        get isPackaged() {
          return isPackaged;
        },
        getPath: () => testDir,
        getVersion: () => 'test',
      },
      safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (value: string) =>
          Buffer.from('enc:' + Buffer.from(value).toString('base64')),
        decryptString: (value: Buffer) => {
          const text = value.toString();
          if (!text.startsWith('enc:')) throw new Error('not decryptable');
          return Buffer.from(text.slice(4), 'base64').toString();
        },
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

delete process.env.JWT_SECRET;
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const {
  getJWTSecret,
  clearJWTSecretCache,
  JWT_SECRET_SAFE_STORAGE_MARKER,
} = require('../main/security/jwt-secret');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const secretFile = path.join(testDir, 'jwt-secret.enc');
const storedValue = () =>
  (
    getDatabase().prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as
      | { value: string }
      | undefined
  )?.value;

try {
  initDatabase();
  getDatabase().prepare("DELETE FROM settings WHERE key = 'jwt_secret'").run();
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();

  const first = getJWTSecret();
  assertOrThrow(/^[0-9a-f]{64}$/.test(first), 'a first launch mints a 32-byte hex secret');
  assertEqualOrThrow(storedValue(), JWT_SECRET_SAFE_STORAGE_MARKER, 'SQLite holds only the marker');
  assertOrThrow(fs.existsSync(secretFile), 'the encrypted secret file is written');
  assertOrThrow(
    !fs.readFileSync(secretFile).toString().includes(first),
    'the file does not contain the plaintext secret',
  );
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), first, 'the secret is stable across restarts');

  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  const regenerated = getJWTSecret();
  assertOrThrow(
    regenerated !== first && /^[0-9a-f]{64}$/.test(regenerated),
    'an unreadable secure secret is replaced',
  );
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), regenerated, 'the replacement persists');

  const legacy = 'ab'.repeat(32);
  getDatabase().prepare("UPDATE settings SET value = ? WHERE key = 'jwt_secret'").run(legacy);
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), legacy, 'an upgraded install keeps its existing secret');
  assertEqualOrThrow(
    storedValue(),
    JWT_SECRET_SAFE_STORAGE_MARKER,
    'the plaintext secret is removed from SQLite',
  );
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), legacy, 'the migrated secret reads back from secure storage');

  encryptionAvailable = false;
  getDatabase().prepare("DELETE FROM settings WHERE key = 'jwt_secret'").run();
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  const fallback = getJWTSecret();
  assertEqualOrThrow(
    storedValue(),
    fallback,
    'without OS encryption the secret falls back to SQLite',
  );
  assertOrThrow(!fs.existsSync(secretFile), 'no secure file is written without OS encryption');

  isPackaged = false;
  encryptionAvailable = true;
  getDatabase().prepare("DELETE FROM settings WHERE key = 'jwt_secret'").run();
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  const unpackagedFirst = getJWTSecret();
  assertOrThrow(/^[0-9a-f]{64}$/.test(unpackagedFirst), 'unpackaged launch mints a hex secret');
  assertEqualOrThrow(
    storedValue(),
    unpackagedFirst,
    'unpackaged mode stores the plaintext secret in SQLite',
  );
  assertOrThrow(!fs.existsSync(secretFile), 'unpackaged mode does not write an encrypted file');

  encryptionAvailable = false;
  clearJWTSecretCache();
  assertEqualOrThrow(
    getJWTSecret(),
    unpackagedFirst,
    'dev-server mode reads back the secret created during unpackaged development',
  );

  const unpackagedExisting = 'cd'.repeat(32);
  getDatabase()
    .prepare("UPDATE settings SET value = ? WHERE key = 'jwt_secret'")
    .run(unpackagedExisting);
  fs.rmSync(secretFile, { force: true });
  isPackaged = false;
  encryptionAvailable = true;
  clearJWTSecretCache();
  assertEqualOrThrow(
    getJWTSecret(),
    unpackagedExisting,
    'reading existing plaintext secret in unpackaged mode preserves it',
  );
  assertEqualOrThrow(
    storedValue(),
    unpackagedExisting,
    'unpackaged mode does not migrate SQLite secret to marker',
  );
  assertOrThrow(
    !fs.existsSync(secretFile),
    'unpackaged mode does not write encrypted file on read',
  );

  encryptionAvailable = false;
  clearJWTSecretCache();
  assertEqualOrThrow(
    getJWTSecret(),
    unpackagedExisting,
    'dev-server mode continues to read the unmigrated secret cleanly',
  );

  const devMigratedSecret = 'ef'.repeat(32);
  getDatabase()
    .prepare("UPDATE settings SET value = ? WHERE key = 'jwt_secret'")
    .run(JWT_SECRET_SAFE_STORAGE_MARKER);
  fs.writeFileSync(
    secretFile,
    Buffer.from('enc:' + Buffer.from(devMigratedSecret).toString('base64')),
  );
  isPackaged = false;
  encryptionAvailable = true;
  clearJWTSecretCache();
  assertEqualOrThrow(
    getJWTSecret(),
    devMigratedSecret,
    'unpackaged mode recovers exact secret from existing jwt-secret.enc',
  );
  assertEqualOrThrow(
    storedValue(),
    devMigratedSecret,
    'recovered secret is written back to SQLite settings',
  );
  assertOrThrow(
    !fs.existsSync(secretFile),
    'development jwt-secret.enc file is removed after recovery',
  );

  encryptionAvailable = false;
  clearJWTSecretCache();
  assertEqualOrThrow(
    getJWTSecret(),
    devMigratedSecret,
    'dev-server mode reads recovered plaintext secret',
  );

  getDatabase()
    .prepare("UPDATE settings SET value = ? WHERE key = 'jwt_secret'")
    .run(JWT_SECRET_SAFE_STORAGE_MARKER);
  fs.rmSync(secretFile, { force: true });
  isPackaged = false;
  encryptionAvailable = true;
  clearJWTSecretCache();
  const recoveredNew = getJWTSecret();
  assertOrThrow(/^[0-9a-f]{64}$/.test(recoveredNew), 'regenerated recovered secret is hex string');
  assertEqualOrThrow(
    storedValue(),
    recoveredNew,
    'regenerated secret is stored in SQLite settings',
  );
  assertOrThrow(!fs.existsSync(secretFile), 'no enc file left after regeneration');

  getDatabase()
    .prepare("UPDATE settings SET value = ? WHERE key = 'jwt_secret'")
    .run(JWT_SECRET_SAFE_STORAGE_MARKER);
  encryptionAvailable = false;
  clearJWTSecretCache();
  let threwExpected = false;
  try {
    getJWTSecret();
  } catch (err: any) {
    threwExpected = true;
    assertOrThrow(
      err.message.includes('authentication unavailable'),
      'throws authentication unavailable when safe-storage cannot be accessed',
    );
  }
  assertOrThrow(
    threwExpected,
    'getJWTSecret throws when safe-storage:v1 exists but encryption is unavailable',
  );

  console.log('jwt-secret-safe-storage tests passed');
} finally {
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}
