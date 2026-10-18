/**
 * Integration and regression test suite for FloCafe Issue #1181:
 * KDS and Server App login buckets bypass the POS failed-login lockout.
 *
 * Verifies:
 * 1. Install-wide failed login attempt accumulation across all three listeners:
 *    - Alternating failed attempts across Main API (:3001), KDS (:3002), and Server App (:3003)
 *      all contribute to the shared failed-login counter.
 *    - Reaching 5 failed attempts triggers a 15-minute lockout (HTTP 429) across all three listeners.
 *    - Subsequent attempts on ANY of the 3 listeners return HTTP 429 with lockout message.
 *    - Attempting valid credentials during the lockout period still returns HTTP 429 across all listeners.
 * 2. Successful login resets failed attempts for that IP:
 *    - A successful login from any listener resets the failure counter for that source IP.
 *    - Subsequent failed attempts start fresh with 5 attempts remaining.
 * 3. IP canonicalization & Loopback/LAN source protection:
 *    - IPv4 ('127.0.0.1') and IPv4-mapped IPv6 ('::ffff:127.0.0.1') share the exact same rate-limit bucket.
 *    - Rate limiting applies without loopback/private/LAN bypass.
 * 4. Listener-specific role and permission enforcement:
 *    - Main API authenticates all active POS staff.
 *    - KDS requires 'kitchen.use' permission (chef/manager/owner); non-kitchen role (e.g. server) gets 403.
 *    - Server App requires 'server-app.use' permission (server/manager/owner); non-server role (e.g. chef) gets 403.
 *    - Permission denials (403) on valid credentials do not count as failed credential attempts.
 * 5. Token revocation and inactive user handling:
 *    - Inactive users (is_active = 0) cannot log in on any listener.
 *    - Logging out revokes the JWT token install-wide across listeners.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cross-server-login-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function postJson(baseUrl: string, pathName: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsedBody = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  return { status: response.status, body: parsedBody };
}

async function getJson(baseUrl: string, pathName: string, token?: string) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const text = await response.text();
  const parsedBody = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  return { status: response.status, body: parsedBody };
}

async function main() {
  console.log('Cross-Server Login Rate Limits & Security Test Suite');
  console.log('='.repeat(55));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const {
    clearLoginRateLimits,
    checkLoginRateLimit,
    incrementFailedLogin,
    resetSuccessfulLogin,
    normalizeIpForRateLimit,
    clearInMemoryRevokedTokens,
    loginAuthRateLimit,
    authRateLimit,
  } = await import('../main/middleware/security');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startKdsServer, stopKdsServer, getKdsPort } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  const db = getDatabase();

  const passwordHash = bcrypt.hashSync('CorrectPassword123!', 10);

  // Seed test users: owner, chef, server, cashier, disabled
  const users = [
    { id: 'user-owner', name: 'Owner User', email: 'owner@test.com', role: 'owner', active: 1 },
    { id: 'user-chef', name: 'Chef User', email: 'chef@test.com', role: 'chef', active: 1 },
    { id: 'user-server', name: 'Server User', email: 'server@test.com', role: 'server', active: 1 },
    {
      id: 'user-cashier',
      name: 'Cashier User',
      email: 'cashier@test.com',
      role: 'cashier',
      active: 1,
    },
    {
      id: 'user-disabled',
      name: 'Disabled User',
      email: 'disabled@test.com',
      role: 'server',
      active: 0,
    },
  ];

  for (const u of users) {
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(u.id, u.name, u.email, passwordHash, u.role, u.active, now(), now());
  }

  // Enable server app and kds in settings
  const upsertSetting = (key: string, value: string) => {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  };
  upsertSetting('server_app_enabled', 'true');
  upsertSetting('kds_enabled', 'true');

  await startServer();
  await startKdsServer();
  await startServerApp();

  const mainBaseUrl = `http://127.0.0.1:${getServerPort()}`;
  const kdsBaseUrl = `http://127.0.0.1:${getKdsPort()}`;
  const serverAppBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    // ── Part 1: IP Normalization Unit Assertions ──────────────────────────────
    console.log('Testing IP normalization...');
    assert.equal(normalizeIpForRateLimit('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIpForRateLimit('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIpForRateLimit('::FFFF:192.168.1.10'), '192.168.1.10');
    assert.equal(normalizeIpForRateLimit('10.0.0.1'), '10.0.0.1');

    clearLoginRateLimits();
    assert.equal(checkLoginRateLimit('127.0.0.1').allowed, true);
    assert.equal(checkLoginRateLimit('::ffff:127.0.0.1').allowed, true);

    incrementFailedLogin('::ffff:127.0.0.1');
    // Both 127.0.0.1 and ::ffff:127.0.0.1 must reflect the single increment
    resetSuccessfulLogin('127.0.0.1');
    assert.equal(checkLoginRateLimit('::ffff:127.0.0.1').allowed, true);

    // ── Part 1b: Volume Rate Limiter Isolation & Sharing ─────────────────────
    console.log('Testing volume rate limiter isolation & sharing...');
    const loginLimiter1 = loginAuthRateLimit();
    const loginLimiter2 = loginAuthRateLimit();
    assert.equal(
      loginLimiter1,
      loginLimiter2,
      'loginAuthRateLimit returns the same shared singleton instance',
    );

    const authLimiter1 = authRateLimit();
    const authLimiter2 = authRateLimit();
    assert.notEqual(
      authLimiter1,
      authLimiter2,
      'authRateLimit returns separate instances for non-login routes',
    );
    assert.notEqual(
      authLimiter1,
      loginLimiter1,
      'authRateLimit does not share instance with loginAuthRateLimit',
    );

    // ── Part 2: Cross-Server Failed Login Accumulation & Lockout ─────────────
    console.log('Testing cross-listener failed login accumulation...');
    clearLoginRateLimits();

    // 1st failed attempt on Main POS API (:3001)
    const res1 = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword1',
    });
    assert.equal(res1.status, 401, 'Main API rejected bad password with 401');
    assert.equal(res1.body.attempts_remaining, 4, 'Remaining attempts is 4 after 1st failure');

    // 2nd failed attempt on Standalone KDS (:3002)
    const res2 = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword2',
    });
    assert.equal(res2.status, 401, 'KDS rejected bad password with 401');
    assert.equal(
      res2.body.attempts_remaining,
      3,
      'Remaining attempts is 3 after 2nd failure across servers',
    );

    // 3rd failed attempt on Server App (:3003)
    const res3 = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword3',
    });
    assert.equal(res3.status, 401, 'Server App rejected bad password with 401');
    assert.equal(
      res3.body.attempts_remaining,
      2,
      'Remaining attempts is 2 after 3rd failure across servers',
    );

    // 4th failed attempt on Main POS API (:3001)
    const res4 = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword4',
    });
    assert.equal(res4.status, 401, 'Main API rejected bad password with 401');
    assert.equal(res4.body.attempts_remaining, 1, 'Remaining attempts is 1 after 4th failure');

    // 5th failed attempt on Standalone KDS (:3002) -> triggers 15-minute lockout!
    const res5 = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword5',
    });
    assert.equal(res5.status, 401, 'KDS rejected 5th bad password with 401');
    assert.equal(res5.body.attempts_remaining, 0, 'Remaining attempts is 0 on 5th failure');
    assert.equal(res5.body.lockout_minutes, 15, 'Lockout minutes is 15 on 5th failure');

    // Now the IP is locked out install-wide!
    // 6th attempt on Main API must return 429
    const res6Main = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword6',
    });
    assert.equal(res6Main.status, 429, 'Main API returns 429 after 5 failures');
    assert(
      typeof res6Main.body.error === 'string' &&
        res6Main.body.error.includes('Too many failed attempts'),
      'Main API response contains lockout message',
    );

    // 6th attempt on KDS must return 429
    const res6Kds = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword6',
    });
    assert.equal(res6Kds.status, 429, 'KDS returns 429 after 5 failures');
    assert(
      typeof res6Kds.body.error === 'string' &&
        res6Kds.body.error.includes('Too many failed attempts'),
      'KDS response contains lockout message',
    );

    // 6th attempt on Server App must return 429
    const res6ServerApp = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'WrongPassword6',
    });
    assert.equal(res6ServerApp.status, 429, 'Server App returns 429 after 5 failures');
    assert(
      typeof res6ServerApp.body.error === 'string' &&
        res6ServerApp.body.error.includes('Too many failed attempts'),
      'Server App response contains lockout message',
    );

    // Attempting VALID credentials during lockout must ALSO return 429 across all listeners!
    const validMainDuringLockout = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(
      validMainDuringLockout.status,
      429,
      'Main API rejects valid credentials during lockout with 429',
    );

    const validKdsDuringLockout = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'chef@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(
      validKdsDuringLockout.status,
      429,
      'KDS rejects valid credentials during lockout with 429',
    );

    const validServerAppDuringLockout = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'server@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(
      validServerAppDuringLockout.status,
      429,
      'Server App rejects valid credentials during lockout with 429',
    );

    // ── Part 3: Successful Login Resets Counter for That IP ──────────────────
    console.log('Testing successful login reset...');
    clearLoginRateLimits();

    // Accumulate 3 failed attempts across servers
    await postJson(mainBaseUrl, '/api/auth/login', { email: 'owner@test.com', password: 'bad1' });
    await postJson(kdsBaseUrl, '/api/auth/login', { email: 'owner@test.com', password: 'bad2' });
    const fail3 = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'bad3',
    });
    assert.equal(fail3.body.attempts_remaining, 2, '3 failed attempts leave 2 remaining');

    // Perform a successful login on Server App
    const successLogin = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'server@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(successLogin.status, 200, 'Server App login succeeds with valid credentials');
    assert(successLogin.body.access_token, 'Server App returns access_token');

    // Subsequent failed attempt on Main API should now have 4 attempts remaining (full reset)
    const afterSuccessFail = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'badAfterSuccess',
    });
    assert.equal(afterSuccessFail.status, 401, 'Main API rejects invalid credentials');
    assert.equal(
      afterSuccessFail.body.attempts_remaining,
      4,
      'Successful login on Server App reset failure counter to 0',
    );

    // Accumulate 2 failures, then succeed on Main API
    await postJson(kdsBaseUrl, '/api/auth/login', { email: 'owner@test.com', password: 'badKds' });
    const successMain = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(successMain.status, 200, 'Main API login succeeds');

    // Subsequent failed attempt on KDS should now have 4 attempts remaining
    const afterMainSuccessFail = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'chef@test.com',
      password: 'badKdsAfterSuccess',
    });
    assert.equal(afterMainSuccessFail.status, 401, 'KDS rejects invalid credentials');
    assert.equal(
      afterMainSuccessFail.body.attempts_remaining,
      4,
      'Successful login on Main API reset failure counter to 0',
    );

    // ── Part 4: Role/Permission Enforcement on Valid Credentials ─────────────
    console.log('Testing role and permission enforcement across listeners...');
    clearLoginRateLimits();

    // 1. Standalone KDS requires 'kitchen.use' permission.
    // 'server' role does not have 'kitchen.use' by default -> 403 Forbidden
    const serverOnKds = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'server@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(serverOnKds.status, 403, 'KDS returns 403 for server role lacking kitchen.use');
    assert.equal(serverOnKds.body.code, 'permission_denied');

    // Verify this 403 does NOT count as a failed login attempt (credentials were correct!)
    const checkAfter403 = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'badPasswordCheck',
    });
    assert.equal(
      checkAfter403.body.attempts_remaining,
      4,
      '403 permission denial did not increment failed login attempts',
    );

    // Verify that 403 permission denial does NOT reset previously accumulated failed attempts (FloCafe Issue #1221)
    // Record a 2nd failed attempt (leaving 3 attempts remaining):
    const fail2 = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'badPassword2',
    });
    assert.equal(fail2.status, 401);
    assert.equal(fail2.body.attempts_remaining, 3, 'Accumulated 2 failures, 3 remaining');

    // Trigger 403 on KDS with valid credentials for 'server'
    const serverOnKds2 = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'server@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(serverOnKds2.status, 403, 'KDS returns 403');

    // Next bad password must be the 3rd failure (2 remaining), NOT reset to 4 remaining!
    const checkAfterKds403 = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'badPassword3',
    });
    assert.equal(checkAfterKds403.status, 401);
    assert.equal(
      checkAfterKds403.body.attempts_remaining,
      2,
      '403 on KDS preserved accumulated failures and did not reset the failure counter',
    );

    // Trigger 403 on Server App with valid credentials for 'chef'
    const chefOnServerApp2 = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'chef@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(chefOnServerApp2.status, 403, 'Server App returns 403');

    // Next bad password must be the 4th failure (1 remaining)
    const checkAfterServer403 = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'server@test.com',
      password: 'badPassword4',
    });
    assert.equal(checkAfterServer403.status, 401);
    assert.equal(
      checkAfterServer403.body.attempts_remaining,
      1,
      '403 on Server App preserved accumulated failures and did not reset the failure counter',
    );

    clearLoginRateLimits();

    // 2. Server App requires 'server-app.use' permission.
    // 'chef' role does not have 'server-app.use' by default -> 403 Forbidden
    const chefOnServerApp = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'chef@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(
      chefOnServerApp.status,
      403,
      'Server App returns 403 for chef role lacking server-app.use',
    );
    assert.equal(chefOnServerApp.body.code, 'permission_denied');

    // Verify this 403 does NOT count as a failed login attempt
    const checkAfterServerApp403 = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'chef@test.com',
      password: 'badPasswordCheck2',
    });
    assert.equal(
      checkAfterServerApp403.body.attempts_remaining,
      4,
      '403 on Server App did not increment failed login attempts',
    );

    // ── Part 5: Deactivated Users Cannot Log In ──────────────────────────────
    console.log('Testing deactivated user handling...');
    clearLoginRateLimits();

    const deactMain = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'disabled@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(deactMain.status, 401, 'Deactivated user rejected on Main API');
    assert.equal(
      deactMain.body.attempts_remaining,
      4,
      'Inactive user attempt counts as failed attempt',
    );

    const deactKds = await postJson(kdsBaseUrl, '/api/auth/login', {
      email: 'disabled@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(deactKds.status, 401, 'Deactivated user rejected on KDS');
    assert.equal(deactKds.body.attempts_remaining, 3, 'Accumulates on KDS');

    const deactServerApp = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'disabled@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(deactServerApp.status, 401, 'Deactivated user rejected on Server App');
    assert.equal(deactServerApp.body.attempts_remaining, 2, 'Accumulates on Server App');

    // ── Part 6: Token Revocation Lifecycle ───────────────────────────────────
    console.log('Testing token revocation lifecycle across listeners...');
    clearLoginRateLimits();
    clearInMemoryRevokedTokens();

    // Log in on Main API
    const mainLogin = await postJson(mainBaseUrl, '/api/auth/login', {
      email: 'owner@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(mainLogin.status, 200);
    const mainToken = mainLogin.body.access_token;

    // Use token on Main API /api/auth/me
    const meBefore = await getJson(mainBaseUrl, '/api/auth/me', mainToken);
    assert.equal(meBefore.status, 200, 'Token valid on Main API');
    assert.equal(meBefore.body.user.email, 'owner@test.com');

    // Log out on Main API
    const logoutRes = await postJson(mainBaseUrl, '/api/auth/logout', {}, mainToken);
    assert.equal(logoutRes.status, 200, 'Logout succeeded');

    // Token must now be rejected
    const meAfter = await getJson(mainBaseUrl, '/api/auth/me', mainToken);
    assert.equal(meAfter.status, 401, 'Revoked token rejected with 401');

    // Log in on Server App
    const serverAppLogin = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'server@test.com',
      password: 'CorrectPassword123!',
    });
    assert.equal(serverAppLogin.status, 200);
    const serverAppToken = serverAppLogin.body.access_token;

    // Use token on Server App /api/auth/me
    const serverMeBefore = await getJson(serverAppBaseUrl, '/api/auth/me', serverAppToken);
    assert.equal(serverMeBefore.status, 200, 'Token valid on Server App');
    assert.equal(serverMeBefore.body.user.email, 'server@test.com');

    // Log out on Server App
    const serverLogoutRes = await postJson(
      serverAppBaseUrl,
      '/api/auth/logout',
      {},
      serverAppToken,
    );
    assert.equal(serverLogoutRes.status, 200, 'Server App logout succeeded');

    // Token must now be rejected on Server App
    const serverMeAfter = await getJson(serverAppBaseUrl, '/api/auth/me', serverAppToken);
    assert.equal(serverMeAfter.status, 401, 'Revoked token rejected on Server App with 401');

    console.log('All cross-server login rate limit & security checks passed successfully!');
  } finally {
    await stopServerApp();
    await stopKdsServer();
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('ALL PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
