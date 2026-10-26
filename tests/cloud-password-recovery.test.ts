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

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initDatabase,
  getDatabase,
  closeDatabase,
  createBackup,
  restoreBackup,
  captureRestoreProtectedSettings,
  mergeRestoreProtectedSettings,
} = require('../main/db');
const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { staffRoutes } = require('../main/routes/staff');
const {
  cloudSync,
  CloudRequestError,
  CloudSyncService,
  DEFAULT_CLOUD_SERVER_URL,
} = require('../main/services/cloud-sync');
const { createApp, assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

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

const app = createApp({
  '/api/auth': authRoutes,
  '/api/settings': settingsRoutes,
  '/api/staff': staffRoutes,
});

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

  // ── F1(a): Trust check vs in-memory server_url divergence ─────────────────
  realCloudSync.reload();
  realCloudSync.stop();
  upsertSetting.run('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);
  assertEqualOrThrow(
    realCloudSync.isTrustedRecoveryServerUrl(),
    false,
    'isTrustedRecoveryServerUrl rejects when in-memory server_url is untrusted despite SQLite default URL',
  );
  assertEqualOrThrow(
    realCloudSync.isEmailRecoveryAvailable(),
    false,
    'isEmailRecoveryAvailable is false when in-memory server_url is untrusted',
  );

  let dispatchedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    dispatchedUrls.push(String(input));
    return new Response(JSON.stringify({ verified: true, reset_id: RESET_ID, status: 'pending' }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    let staleMemRequestErr: unknown = null;
    try {
      await realCloudSync.requestPasswordReset();
    } catch (err) {
      staleMemRequestErr = err;
    }
    assertOrThrow(
      staleMemRequestErr instanceof CloudRequestError && staleMemRequestErr.status === 403,
      'requestPasswordReset rejects when in-memory server_url is untrusted',
    );
    assertEqualOrThrow(
      dispatchedUrls.length,
      0,
      'no network call is dispatched when in-memory server_url is untrusted',
    );

    let staleMemVerifyErr: unknown = null;
    try {
      await realCloudSync.isOwnerEmailVerified();
    } catch (err) {
      staleMemVerifyErr = err;
    }
    assertOrThrow(
      staleMemVerifyErr instanceof CloudRequestError && staleMemVerifyErr.status === 403,
      'isOwnerEmailVerified rejects when in-memory server_url is untrusted',
    );

    realCloudSync.reload();
    realCloudSync.stop();
    await realCloudSync.requestPasswordReset();
    assertEqualOrThrow(dispatchedUrls.length, 1, 'trusted recovery request dispatches one fetch');
    assertOrThrow(
      dispatchedUrls[0].startsWith(DEFAULT_CLOUD_SERVER_URL),
      `trusted recovery request dispatches to DEFAULT_CLOUD_SERVER_URL (got ${dispatchedUrls[0]})`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── F1(b): POST /api/settings/cloud/register early-return before SQLite write ─
  const ownerToken = jwt.sign(
    { userId: 'owner-1', email: 'owner@example.com', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  upsertSetting.run('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);
  upsertSetting.run('cloud_deletion_status', 'failed');
  upsertSetting.run('cloud_services_disabled_by_user', 'false');

  res = await request(app)
    .post('/api/settings/cloud/register')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ cloud_server_url: 'https://custom-blocked.example.com' });
  assertEqualOrThrow(
    res.status,
    409,
    'POST /api/settings/cloud/register returns 409 when cloud_deletion_blocked is true',
  );
  const storedUrlAfterBlockedRegister = (
    db.prepare("SELECT value FROM settings WHERE key = 'cloud_server_url'").get() as
      | { value: string }
      | undefined
  )?.value;
  assertEqualOrThrow(
    storedUrlAfterBlockedRegister,
    DEFAULT_CLOUD_SERVER_URL,
    'blocked cloud register does not write cloud_server_url to SQLite before early return',
  );
  upsertSetting.run('cloud_deletion_status', '');

  // ── F1(c): Manager cannot overwrite cloud credentials or server URL ───────
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('manager-1', 'Manager', 'manager@example.com', ?, 'manager', 1, datetime('now'), datetime('now'))`,
  ).run(bcrypt.hashSync('ManagerPass123', 10));
  const managerToken = jwt.sign(
    { userId: 'manager-1', email: 'manager@example.com', role: 'manager' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );

  upsertSetting.run('cloud_api_key', 'owner-api-key');
  upsertSetting.run('cloud_store_id', 'owner-store-id');
  upsertSetting.run('cloud_server_url', 'https://custom-owner.example.com');

  res = await request(app)
    .put('/api/settings/cloud')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ cloud_api_key: 'attacker-api-key' });
  assertEqualOrThrow(res.status, 403, 'manager cannot overwrite cloud_api_key via PUT /cloud');

  res = await request(app)
    .put('/api/settings/cloud')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ cloud_store_id: 'attacker-store-id' });
  assertEqualOrThrow(res.status, 403, 'manager cannot overwrite cloud_store_id via PUT /cloud');

  res = await request(app)
    .put('/api/settings/cloud')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ cloud_server_url: DEFAULT_CLOUD_SERVER_URL });
  assertEqualOrThrow(
    res.status,
    403,
    'manager cannot reset cloud_server_url to DEFAULT_CLOUD_SERVER_URL via PUT /cloud',
  );

  res = await request(app)
    .post('/api/settings/cloud/register')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ cloud_server_url: DEFAULT_CLOUD_SERVER_URL });
  assertEqualOrThrow(
    res.status,
    403,
    'manager cannot set cloud_server_url via POST /cloud/register',
  );

  assertEqualOrThrow(
    (
      db.prepare("SELECT value FROM settings WHERE key = 'cloud_api_key'").get() as {
        value: string;
      }
    ).value,
    'owner-api-key',
    'cloud_api_key remains unchanged after rejected manager requests',
  );
  assertEqualOrThrow(
    (
      db.prepare("SELECT value FROM settings WHERE key = 'cloud_store_id'").get() as {
        value: string;
      }
    ).value,
    'owner-store-id',
    'cloud_store_id remains unchanged after rejected manager requests',
  );
  assertEqualOrThrow(
    (
      db.prepare("SELECT value FROM settings WHERE key = 'cloud_server_url'").get() as {
        value: string;
      }
    ).value,
    'https://custom-owner.example.com',
    'cloud_server_url remains unchanged after rejected manager requests',
  );

  res = await request(app)
    .put('/api/settings/cloud')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ cloud_sync_enabled: true, cloud_orders_enabled: true });
  assertEqualOrThrow(
    res.status,
    200,
    'manager with cloud.manage can still toggle cloud sync/orders flags',
  );

  res = await request(app)
    .put('/api/settings/cloud')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      cloud_server_url: DEFAULT_CLOUD_SERVER_URL,
      cloud_api_key: 'owner-api-key',
      cloud_store_id: 'owner-store-id',
    });
  assertEqualOrThrow(
    res.status,
    200,
    'owner can update cloud_server_url, cloud_api_key, and cloud_store_id',
  );
  cloudSync.stop();
  realCloudSync.reload();
  realCloudSync.stop();

  // ── F2(a): Staff email update keeps settings.email in sync ────────────────
  res = await request(app)
    .put('/api/staff/owner-1')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: 'new-owner@example.com' });
  assertEqualOrThrow(res.status, 200, 'owner email update via PUT /api/staff/:id succeeds');
  assertEqualOrThrow(
    realCloudSync.getRegisteredOwnerEmail(),
    'new-owner@example.com',
    'PUT /api/staff/:id syncs settings.email when active owner email changes',
  );
  assertEqualOrThrow(
    realCloudSync.isEmailRecoveryAvailable(),
    true,
    'email recovery remains available after owner email update',
  );

  // ── F2(b): Backup restore & protected settings preserve/resync owner email ─
  db.prepare("UPDATE settings SET value = 'stale@backup.example.com' WHERE key = 'email'").run();
  const staleBackup = await createBackup(path.join(testDir, 'stale-email-backup.db'));
  // Restore live state to new-owner@example.com, then restore staleBackup.path
  upsertSetting.run('email', 'new-owner@example.com');
  const preservedSettings = captureRestoreProtectedSettings(db);
  upsertSetting.run('email', 'stale@backup.example.com');
  mergeRestoreProtectedSettings(db, preservedSettings);
  assertEqualOrThrow(
    realCloudSync.getRegisteredOwnerEmail(),
    'new-owner@example.com',
    'captureRestoreProtectedSettings and mergeRestoreProtectedSettings preserve settings.email',
  );

  const restoreRes = restoreBackup(staleBackup.path);
  assertEqualOrThrow(restoreRes.success, true, 'restoreBackup succeeds');
  assertEqualOrThrow(
    realCloudSync.getRegisteredOwnerEmail(),
    'new-owner@example.com',
    'restoreBackup preserves active owner email in settings.email over stale backup email',
  );
  fs.rmSync(staleBackup.path, { force: true });

  // ── F2(c): Recovery precheck & stranded store non-owner escalation guard ──
  const postRestoreDb = getDatabase();
  postRestoreDb
    .prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES ('cashier-1', 'Cashier', 'cashier@example.com', ?, 'cashier', 1, datetime('now'), datetime('now'))`,
    )
    .run(bcrypt.hashSync('CashierPass123', 10));

  postRestoreDb
    .prepare("UPDATE settings SET value = 'cashier@example.com' WHERE key = 'email'")
    .run();
  assertEqualOrThrow(
    realCloudSync.isEmailRecoveryAvailable(),
    false,
    'isEmailRecoveryAvailable is false when settings.email matches only a non-owner account',
  );

  registeredEmail = 'cashier@example.com';
  res = await request(app).post(`${cloud}/request`).send({});
  assertEqualOrThrow(
    res.status,
    409,
    'POST /recover-password/cloud/request rejects when registered email does not match an active owner',
  );

  // Strand the store by denying administrative permissions on owner-1.
  for (const permissionId of ['settings.manage', 'staff.operational.manage']) {
    postRestoreDb
      .prepare(
        `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
         VALUES ('owner-1', ?, 'deny', 'owner-1', datetime('now'), datetime('now'))`,
      )
      .run(permissionId);
  }
  const callsBeforeStranded = redeemCalls;
  res = await request(app)
    .post(`${cloud}/complete`)
    .send({ reset_id: RESET_ID, new_password: 'EscalatedPassword123' });
  assertEqualOrThrow(
    res.status,
    404,
    'POST /recover-password/cloud/complete refuses to match a non-owner even when the store is stranded',
  );
  assertEqualOrThrow(
    redeemCalls,
    callsBeforeStranded,
    'stranded non-owner complete attempt does not consume the reset grant',
  );
  const cashierRole = (
    postRestoreDb.prepare("SELECT role FROM users WHERE id = 'cashier-1'").get() as { role: string }
  ).role;
  assertEqualOrThrow(
    cashierRole,
    'cashier',
    'cashier-1 is not promoted to owner on a stranded store via stale cloud email',
  );

  // ── F3: Superseded password-reset polling response race guard ───────────────
  const originalResolveFilename = Module._resolveFilename;
  const prevLoad = Module._load;
  const rootDir = process.cwd();

  let currentStateIdx = 0;
  let currentRefIdx = 0;
  let currentEffectIdx = 0;
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effectSlots: Array<{ deps?: unknown[]; cleanup?: unknown }> = [];
  const pendingEffects: Array<() => void> = [];

  const reactHooks = {
    useState: (initial: unknown) => {
      const idx = currentStateIdx++;
      if (idx >= states.length) {
        states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
      }
      const setState = (next: unknown) => {
        states[idx] =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[idx]) : next;
      };
      return [states[idx], setState];
    },
    useRef: (initial: unknown) => {
      const idx = currentRefIdx++;
      if (idx >= refs.length) {
        refs.push({ current: initial });
      }
      return refs[idx];
    },
    useEffect: (effect: () => unknown, deps?: unknown[]) => {
      const idx = currentEffectIdx++;
      const prev = effectSlots[idx];
      const depsChanged =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (depsChanged) {
        pendingEffects.push(() => {
          if (prev && typeof prev.cleanup === 'function') {
            prev.cleanup();
          }
          const cleanup = effect();
          effectSlots[idx] = { deps, cleanup };
        });
      }
    },
  };

  let currentRecoverApi: {
    get: (url: string, config?: any) => Promise<any>;
    post: (url: string, data?: any, config?: any) => Promise<any>;
  } = {
    get: async () => ({ data: {} }),
    post: async () => ({ data: {} }),
  };

  Module._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
  ) {
    if (request.startsWith('@/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(rootDir, 'frontend/src', request.slice(2)),
        parent,
        isMain,
        options,
      );
    }
    if (request.startsWith('@shared/')) {
      return originalResolveFilename.call(
        this,
        path.resolve(rootDir, 'shared', request.slice('@shared/'.length)),
        parent,
        isMain,
        options,
      );
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'react') return reactHooks;
    if (request === 'react/jsx-runtime') {
      return {
        jsx: (type: any, props: any) => ({ type, props }),
        jsxs: (type: any, props: any) => ({ type, props }),
        Fragment: 'Fragment',
      };
    }
    if (request === 'next/navigation') {
      return { useRouter: () => ({ push: () => {} }) };
    }
    if (request === 'use-intl') {
      return { useTranslations: () => (k: string) => k };
    }
    if (request === 'react-hot-toast') {
      return {
        default: { success: () => {}, error: () => {} },
        success: () => {},
        error: () => {},
      };
    }
    if (request === 'lucide-react') {
      return new Proxy({}, { get: () => () => null });
    }
    if (request.includes('/components/ui/')) {
      return new Proxy({}, { get: () => (props: any) => ({ type: 'UI', props }) });
    }
    if (request === '@/lib/api' || request.endsWith('/lib/api')) {
      return {
        __esModule: true,
        default: {
          get: (url: string, config?: any) => currentRecoverApi.get(url, config),
          post: (url: string, data?: any, config?: any) =>
            currentRecoverApi.post(url, data, config),
        },
      };
    }
    return prevLoad.call(this, request, parent, isMain);
  };

  let activeIntervalCallback: (() => Promise<void>) | null = null;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = function (fn: any) {
    activeIntervalCallback = fn;
    return 9999 as any;
  } as any;

  globalThis.clearInterval = function () {
    activeIntervalCallback = null;
  } as any;

  try {
    const RecoverPage = require(path.join(rootDir, 'frontend/src/app/auth/recover/page')).default;

    const renderPage = () => {
      currentStateIdx = 0;
      currentRefIdx = 0;
      currentEffectIdx = 0;
      const tree = RecoverPage();
      while (pendingEffects.length > 0) {
        const effect = pendingEffects.shift()!;
        effect();
      }
      return tree;
    };

    const findAllButtons = (node: any, acc: any[] = []): any[] => {
      if (!node) return acc;
      if (Array.isArray(node)) {
        for (const c of node) findAllButtons(c, acc);
        return acc;
      }
      if (typeof node === 'object') {
        if (typeof node.props?.onClick === 'function') acc.push(node);
        findAllButtons(node.props?.children, acc);
      }
      return acc;
    };

    // Initial mount and setup
    currentRecoverApi = {
      get: async (url: string) => {
        if (url === '/auth/setup/status') {
          return { data: { masterPinAvailable: false, cloudRecoveryAvailable: true } };
        }
        return { data: {} };
      },
      post: async () => ({ data: {} }),
    };

    renderPage();
    await new Promise((r) => setTimeout(r, 10));
    renderPage();

    assertEqualOrThrow(states[10], 'email', 'recovery method initializes to email');
    assertEqualOrThrow(states[11], 'idle', 'emailStep initializes to idle');

    let resolvePollA: (val: any) => void;
    const pollAPromise = new Promise((resolve) => {
      resolvePollA = resolve;
    });

    let pollCount = 0;
    currentRecoverApi = {
      get: async (url: string) => {
        if (url === '/auth/recover-password/cloud/status') {
          pollCount++;
          if (pollCount === 1) {
            return pollAPromise;
          }
          return { data: { status: 'approved' } };
        }
        return { data: {} };
      },
      post: async (url: string) => {
        if (url === '/auth/recover-password/cloud/request') {
          if (states[12] === '') {
            return {
              data: { step: 'reset', reset_id: 'reset-A', email_hint: 'o***@example.com' },
            };
          }
          return {
            data: { step: 'reset', reset_id: 'reset-B', email_hint: 'o***@example.com' },
          };
        }
        return { data: {} };
      },
    };

    // 1. Initial send for reset A
    const tree1 = renderPage();
    const sendBtn = findAllButtons(tree1).find((b) => b.props?.children === 'recoverEmailSend');
    assertOrThrow(Boolean(sendBtn), 'send button found for email recovery');

    await sendBtn.props.onClick();
    renderPage();

    assertEqualOrThrow(states[11], 'waiting', 'requestEmailReset transitions emailStep to waiting');
    assertEqualOrThrow(states[12], 'reset-A', 'requestEmailReset sets resetId to reset-A');
    assertOrThrow(Boolean(activeIntervalCallback), 'status polling timer registered for reset-A');

    // 2. Interval fires for reset-A status poll, setting pollInFlight
    const pollTickPromiseA = activeIntervalCallback!();
    const pollInFlightRef = refs[1] as { current: boolean };
    const pollGenerationRef = refs[3] as { current: number } | undefined;
    assertEqualOrThrow(
      pollInFlightRef.current,
      true,
      'pollInFlight is true while status poll A is pending',
    );
    const generationBeforeResend = pollGenerationRef?.current ?? 0;

    // 3. User resends while status poll A is in-flight, creating reset-B
    const tree2 = renderPage();
    const resendBtn = findAllButtons(tree2).find((b) => b.props?.children === 'recoverEmailResend');
    assertOrThrow(Boolean(resendBtn), 'resend button found while waiting');

    await resendBtn.props.onClick();
    renderPage();

    assertEqualOrThrow(states[11], 'waiting', 'emailStep remains waiting for reset-B');
    assertEqualOrThrow(states[12], 'reset-B', 'resend updates resetId to reset-B');
    assertOrThrow(
      typeof pollGenerationRef?.current === 'number' &&
        pollGenerationRef.current > generationBeforeResend,
      'stopPolling increments pollGeneration on resend',
    );
    assertEqualOrThrow(pollInFlightRef.current, false, 'stopPolling resets pollInFlight on resend');

    // 4. Stale poll A resolves with approved for old reset-A
    resolvePollA!({ data: { status: 'approved' } });
    await pollTickPromiseA;
    renderPage();

    assertEqualOrThrow(
      states[11],
      'waiting',
      'superseded poll A does not transition emailStep to approved for reset-B',
    );
    assertEqualOrThrow(
      states[12],
      'reset-B',
      'resetId remains reset-B after superseded poll A resolves',
    );
    assertEqualOrThrow(
      pollInFlightRef.current,
      false,
      'superseded poll A does not clobber pollInFlight',
    );

    // 5. Subsequent poll for reset-B proceeds and transitions cleanly
    assertOrThrow(Boolean(activeIntervalCallback), 'interval timer active for reset-B');
    await activeIntervalCallback!();
    renderPage();

    assertEqualOrThrow(states[11], 'approved', 'reset B poll transitions emailStep to approved');
    assertEqualOrThrow(states[12], 'reset-B', 'resetId matches approved reset B');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Module._resolveFilename = originalResolveFilename;
    Module._load = prevLoad;
  }
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
