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
Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (value: string) => Buffer.from('enc:' + Buffer.from(value).toString('base64')),
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
  (getDatabase().prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined)?.value;

try {
  initDatabase();
  getDatabase().prepare("DELETE FROM settings WHERE key = 'jwt_secret'").run();
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();

  const first = getJWTSecret();
  assertOrThrow(/^[0-9a-f]{64}$/.test(first), 'a first launch mints a 32-byte hex secret');
  assertEqualOrThrow(storedValue(), JWT_SECRET_SAFE_STORAGE_MARKER, 'SQLite holds only the marker');
  assertOrThrow(fs.existsSync(secretFile), 'the encrypted secret file is written');
  assertOrThrow(!fs.readFileSync(secretFile).toString().includes(first), 'the file does not contain the plaintext secret');
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), first, 'the secret is stable across restarts');

  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  const regenerated = getJWTSecret();
  assertOrThrow(regenerated !== first && /^[0-9a-f]{64}$/.test(regenerated), 'an unreadable secure secret is replaced');
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), regenerated, 'the replacement persists');

  const legacy = 'ab'.repeat(32);
  getDatabase().prepare("UPDATE settings SET value = ? WHERE key = 'jwt_secret'").run(legacy);
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), legacy, 'an upgraded install keeps its existing secret');
  assertEqualOrThrow(storedValue(), JWT_SECRET_SAFE_STORAGE_MARKER, 'the plaintext secret is removed from SQLite');
  clearJWTSecretCache();
  assertEqualOrThrow(getJWTSecret(), legacy, 'the migrated secret reads back from secure storage');

  encryptionAvailable = false;
  getDatabase().prepare("DELETE FROM settings WHERE key = 'jwt_secret'").run();
  fs.rmSync(secretFile, { force: true });
  clearJWTSecretCache();
  const fallback = getJWTSecret();
  assertEqualOrThrow(storedValue(), fallback, 'without OS encryption the secret falls back to SQLite');
  assertOrThrow(!fs.existsSync(secretFile), 'no secure file is written without OS encryption');

  console.log('jwt-secret-safe-storage tests passed');
} finally {
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}
