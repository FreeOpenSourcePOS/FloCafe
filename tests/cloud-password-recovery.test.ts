/**
 * Cloud email password recovery (FloAdmin-approved reset, password set locally)
 *
 * Drives /api/auth/recover-password/cloud/* against the real route handlers with the
 * FloAdmin client stubbed, so no network is touched.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cloud-password-recovery.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-recovery-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};
const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cloud-recovery';
process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');
const {
  cloudSync,
  CloudRequestError,
  CloudSyncService,
  DEFAULT_CLOUD_SERVER_URL,
} = require('../main/services/cloud-sync');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

try {
  initDatabase();
} catch (error: any) {
  if (isNativeAbiMismatch(error)) {
    console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
    process.exit(77);
  }
  throw error;
}

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

const RESET_ID = 'reset-1234-abcd';
const ORIGINAL = 'OriginalPass123';
const NEW_PASSWORD = 'BrandNewPass123';

let available = true;
let ownerVerified = true;
let verificationSends = 0;
let registeredEmail = 'owner@example.com';
let remoteStatus = 'pending';
let redeemCalls = 0;
let redeemError: unknown = null;
let requestError: unknown = null;

Object.assign(cloudSync, {
  isEmailRecoveryAvailable: () => available,
  isOwnerEmailVerified: async () => ownerVerified,
  ensureOwnerEmailVerification: async () => {
    if (ownerVerified) return true;
    verificationSends++;
    return false;
  },
  getRegisteredOwnerEmail: () => registeredEmail,
  requestPasswordReset: async () => {
    if (requestError) throw requestError;
    return {
      reset_id: RESET_ID,
      expires_at: '2099-01-01T00:00:00Z',
      email_hint: 'o***@example.com',
    };
  },
  getPasswordResetStatus: async () => ({ status: remoteStatus }),
  redeemPasswordReset: async () => {
    redeemCalls++;
    if (redeemError) throw redeemError;
    return { status: 'consumed' };
  },
});

async function login(password: string) {
  return request(app).post('/api/auth/login').send({ email: 'owner@example.com', password });
}

async function main() {
  const db = getDatabase();
  const cloud = '/api/auth/recover-password/cloud';

  let res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(res.status, 409, 'request is blocked before setup creates an owner');

  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('owner-1', 'Owner', 'owner@example.com', ?, 'owner', 1, datetime('now'), datetime('now'))`,
  ).run(bcrypt.hashSync(ORIGINAL, 10));

  res = await request(app).get('/api/auth/setup/status');
  assertEqualOrThrow(
    res.body.cloudRecoveryAvailable,
    true,
    'setup status advertises cloud recovery',
  );

  available = false;
  res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(
    res.status,
    409,
    'request is blocked when cloud email recovery is unavailable',
  );
  res = await request(app).get('/api/auth/setup/status');
  assertEqualOrThrow(res.body.cloudRecoveryAvailable, false, 'setup status hides cloud recovery');
  available = true;

  ownerVerified = false;
  res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(res.status, 202, 'unverified email still gets a 202');
  assertEqualOrThrow(
    res.body.step,
    'verify_email',
    'unverified email starts with the verification step',
  );
  assertEqualOrThrow(
    res.body.email_hint,
    'o***@example.com',
    'verification step masks the owner email',
  );
  assertEqualOrThrow(verificationSends, 1, 'the verification email is sent first');
  res = await request(app).get(`${cloud}/verification`);
  assertEqualOrThrow(res.body.verified, false, 'verification poll reports unverified');
  ownerVerified = true;
  res = await request(app).get(`${cloud}/verification`);
  assertEqualOrThrow(res.body.verified, true, 'verification poll reports verified');

  res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(res.status, 202, 'request succeeds');
  assertEqualOrThrow(res.body.step, 'reset', 'verified email goes straight to the reset step');
  assertEqualOrThrow(verificationSends, 1, 'a verified email sends no further verification email');
  assertEqualOrThrow(res.body.reset_id, RESET_ID, 'request returns the reset id');
  assertEqualOrThrow(res.body.email_hint, 'o***@example.com', 'request returns the masked email');

  requestError = new CloudRequestError('rate_limited', 429);
  res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(res.status, 429, 'FloAdmin rate limit is surfaced');
  requestError = new TypeError('fetch failed');
  res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(res.status, 502, 'unreachable FloAdmin maps to 502');
  requestError = null;

  res = await request(app).get(`${cloud}/status`).query({ reset_id: 'bad id!' });
  assertEqualOrThrow(res.status, 400, 'status rejects a malformed reset id');
  res = await request(app).get(`${cloud}/status`).query({ reset_id: RESET_ID });
  assertEqualOrThrow(res.body.status, 'pending', 'status reflects pending');
  remoteStatus = 'approved';
  res = await request(app).get(`${cloud}/status`).query({ reset_id: RESET_ID });
  assertEqualOrThrow(res.body.status, 'approved', 'status reflects approved');

  res = await request(app)
    .post(`${cloud}/complete`)
    .send({ reset_id: RESET_ID, new_password: 'abc' });
  assertEqualOrThrow(res.status, 400, 'weak password is rejected');
  assertEqualOrThrow(redeemCalls, 0, 'a weak password never consumes the grant');

  registeredEmail = 'someone-else@example.com';
  res = await request(app)
    .post(`${cloud}/complete`)
    .send({ reset_id: RESET_ID, new_password: NEW_PASSWORD });
  assertEqualOrThrow(res.status, 404, 'no matching owner is a 404');
  assertEqualOrThrow(redeemCalls, 0, 'a missing owner never consumes the grant');
  registeredEmail = 'owner@example.com';

  redeemError = new CloudRequestError('approved first', 409);
  res = await request(app)
    .post(`${cloud}/complete`)
    .send({ reset_id: RESET_ID, new_password: NEW_PASSWORD });
  assertEqualOrThrow(res.status, 409, 'unapproved reset is rejected');
  assertEqualOrThrow(
    (await login(ORIGINAL)).status,
    200,
    'password is unchanged when redeem is refused',
  );

  redeemError = new TypeError('fetch failed');
  res = await request(app)
    .post(`${cloud}/complete`)
    .send({ reset_id: RESET_ID, new_password: NEW_PASSWORD });
  assertEqualOrThrow(res.status, 502, 'redeem network failure maps to 502');
  assertEqualOrThrow(
    (await login(ORIGINAL)).status,
    200,
    'password is unchanged when FloAdmin is unreachable',
  );
  redeemError = null;

  res = await request(app)
    .post(`${cloud}/complete`)
    .send({ reset_id: RESET_ID, new_password: NEW_PASSWORD });
  assertEqualOrThrow(res.status, 200, 'approved reset sets the new password');
  assertEqualOrThrow((await login(ORIGINAL)).status, 401, 'old password stops working');
  assertEqualOrThrow((await login(NEW_PASSWORD)).status, 200, 'new password works');
  const settings = db
    .prepare("SELECT value FROM settings WHERE key = 'last_password_recovery_user_id'")
    .get() as { value: string } | undefined;
  assertOrThrow(settings?.value === 'owner-1', 'recovery is recorded in the audit settings');

  const users = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  assertEqualOrThrow(users, 1, 'recovery does not add or remove users');

  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsertSetting.run('cloud_registration_status', 'registered');
  upsertSetting.run('cloud_api_key', 'test-api-key');
  upsertSetting.run('cloud_services_disabled_by_user', 'false');
  upsertSetting.run('cloud_deletion_status', '');
  upsertSetting.run('email', 'owner@example.com');
  upsertSetting.run('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);

  const realCloudSync = new CloudSyncService();
  assertEqualOrThrow(
    realCloudSync.isTrustedRecoveryServerUrl(),
    true,
    'DEFAULT_CLOUD_SERVER_URL is trusted for password recovery',
  );
  assertEqualOrThrow(
    realCloudSync.isEmailRecoveryAvailable(),
    true,
    'email recovery is available with DEFAULT_CLOUD_SERVER_URL',
  );

  upsertSetting.run('cloud_server_url', 'https://evil.example.com/');
  assertEqualOrThrow(
    realCloudSync.isTrustedRecoveryServerUrl(),
    false,
    'custom cloud_server_url is untrusted for password recovery',
  );
  assertEqualOrThrow(
    realCloudSync.isEmailRecoveryAvailable(),
    false,
    'email recovery is unavailable when cloud_server_url points to a custom server',
  );

  let rejectedRequest: unknown = null;
  try {
    await realCloudSync.requestPasswordReset();
  } catch (err) {
    rejectedRequest = err;
  }
  assertOrThrow(
    rejectedRequest instanceof CloudRequestError && rejectedRequest.status === 403,
    'requestPasswordReset rejects with 403 CloudRequestError on untrusted server URL',
  );

  let rejectedRedeem: unknown = null;
  try {
    await realCloudSync.redeemPasswordReset(RESET_ID);
  } catch (err) {
    rejectedRedeem = err;
  }
  assertOrThrow(
    rejectedRedeem instanceof CloudRequestError && rejectedRedeem.status === 403,
    'redeemPasswordReset rejects with 403 CloudRequestError on untrusted server URL',
  );
}

main()
  .then(() => {
    console.log('cloud-password-recovery: all assertions passed');
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    try {
      closeDatabase();
    } catch {
      // Cleanup only.
    }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(1);
  });
