/** Server App auth must be limited to front-line + management staff (server, manager, owner). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import jwt from 'jsonwebtoken';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-server-app-server-role-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
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
  return { status: response.status, body: await response.json() };
}

async function main() {
  console.log('Integration Test: Server App front-line + management auth');
  console.log('='.repeat(52));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { clearInMemoryRevokedTokens } = await import('../main/middleware/security');
  const { getJWTSecret } = await import('../main/security/jwt-secret');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startKdsServer, stopKdsServer, getKdsPort } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  const db = getDatabase();
  const passwordHash = bcrypt.hashSync('ServerPass123!', 10);

  for (const role of ['owner', 'manager', 'cashier', 'chef', 'server']) {
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      `server-app-${role}`,
      `Server App ${role}`,
      `${role}@server-app.test`,
      passwordHash,
      role,
      now(),
      now(),
    );
  }

  await startServer();
  await startKdsServer();
  await startServerApp();
  const mainBaseUrl = `http://127.0.0.1:${getServerPort()}`;
  const kdsBaseUrl = `http://127.0.0.1:${getKdsPort()}`;
  const baseUrl = `http://127.0.0.1:${getServerAppPort()}`;
  // This test bypasses the shared test harness (initDatabase() directly, not
  // initTestDb()), so it doesn't get the central seedTestRegionalDefaults()
  // choke point. Now that seedInstallDefaults() no longer writes a country
  // row, a plain UPDATE against a nonexistent row silently no-ops — upsert
  // instead so these settings always actually take effect.
  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);

  try {
    setSetting('country', '');
    const unconfiguredInfo = await getJson(baseUrl, '/api/server-app/info');
    assert.equal(
      unconfiguredInfo.status,
      409,
      'Server App refuses to format regional values before a country is configured',
    );
    assert.equal(unconfiguredInfo.body.error, 'regional_not_configured');

    setSetting('country', 'CO');
    setSetting('currency', 'COP');
    setSetting('currency_symbol', '$');
    const copInfo = await getJson(baseUrl, '/api/server-app/info');
    assert.equal(copInfo.status, 200);
    assert.deepEqual(
      {
        country: copInfo.body.country,
        currency: copInfo.body.currency,
        symbol: copInfo.body.currency_symbol,
        position: copInfo.body.currency_position,
        fractionDigits: copInfo.body.currency_fraction_digits,
      },
      {
        country: 'CO',
        currency: 'COP',
        symbol: '$',
        position: 'prefix',
        fractionDigits: 0,
      },
      'Server App exposes the COP regional values derived from current settings',
    );

    setSetting('country', 'KW');
    setSetting('currency', 'KWD');
    setSetting('currency_symbol', 'KWD');
    const kwdInfo = await getJson(baseUrl, '/api/server-app/info');
    assert.equal(kwdInfo.status, 200);
    assert.deepEqual(
      {
        country: kwdInfo.body.country,
        currency: kwdInfo.body.currency,
        symbol: kwdInfo.body.currency_symbol,
        position: kwdInfo.body.currency_position,
        fractionDigits: kwdInfo.body.currency_fraction_digits,
      },
      {
        country: 'KW',
        currency: 'KWD',
        symbol: 'د.ك.',
        position: 'suffix',
        fractionDigits: 3,
      },
      'Server App exposes the KWD regional values derived from current settings, from CLDR rather than a stored override',
    );

    for (const role of ['cashier', 'chef']) {
      const response = await postJson(baseUrl, '/api/auth/login', {
        email: `${role}@server-app.test`,
        password: 'ServerPass123!',
      });
      assert.equal(response.status, 403, `${role} cannot log in to Server App`);
      assert.match(String(response.body.error), /Only server, manager, or owner/i);
    }

    const roleTokens: Record<string, string> = {};
    for (const role of ['server', 'manager', 'owner']) {
      const login = await postJson(baseUrl, '/api/auth/login', {
        email: `${role}@server-app.test`,
        password: 'ServerPass123!',
      });
      assert.equal(login.status, 200, `${role} can log in to Server App`);
      assert.equal(login.body.user.role, role, `Server App returns ${role} role`);
      assert.ok(login.body.access_token, `Server App returns a token for ${role}`);
      roleTokens[role] = login.body.access_token;

      const me = await getJson(baseUrl, '/api/auth/me', login.body.access_token);
      assert.equal(me.status, 200, `${role} token remains valid on /api/auth/me`);
      assert.equal(me.body.user.role, role, `/api/auth/me returns ${role} role`);
    }

    const liveServerLogin = await postJson(baseUrl, '/api/auth/login', {
      email: 'server@server-app.test',
      password: 'ServerPass123!',
    });
    db.prepare(`INSERT INTO user_permission_overrides
      (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES ('server-app-server', 'server-app.use', 'deny', 'server-app-owner', ?, ?)`).run(
      now(),
      now(),
    );
    const deniedLiveSession = await getJson(
      baseUrl,
      '/api/auth/me',
      liveServerLogin.body.access_token,
    );
    assert.equal(
      deniedLiveSession.status,
      403,
      'Server App permission denial applies to an existing session immediately',
    );
    db.prepare("DELETE FROM user_permission_overrides WHERE user_id = 'server-app-server'").run();

    const missingLogout = await postJson(baseUrl, '/api/auth/logout', {});
    assert.equal(missingLogout.status, 401, 'Server App logout rejects missing token with 401');
    assert.equal(missingLogout.body.error, 'No token provided');

    const invalidToken = 'not-a-valid-jwt-token';
    const invalidLogout = await postJson(baseUrl, '/api/auth/logout', {}, invalidToken);
    assert.equal(invalidLogout.status, 401, 'Server App logout rejects invalid token with 401');
    assert.equal(invalidLogout.body.error, 'Invalid token');

    const expiredToken = jwt.sign(
      {
        userId: 'server-app-server',
        email: 'server@server-app.test',
        role: 'server',
        jti: 'expired-server-app-token',
      },
      getJWTSecret(),
      { expiresIn: '-10s' },
    );
    const expiredLogout = await postJson(baseUrl, '/api/auth/logout', {}, expiredToken);
    assert.equal(expiredLogout.status, 401, 'Server App logout rejects expired token with 401');
    assert.equal(expiredLogout.body.error, 'Invalid token');

    const preLogoutRevokedCount = (
      db.prepare('SELECT COUNT(*) AS count FROM revoked_tokens').get() as { count: number }
    ).count;
    assert.equal(
      preLogoutRevokedCount,
      0,
      'Rejected unauthenticated/invalid/expired logouts do not persist revocation rows',
    );

    const ownerKdsBeforeLogout = await getJson(kdsBaseUrl, '/api/auth/me', roleTokens.owner);
    assert.equal(
      ownerKdsBeforeLogout.status,
      200,
      'Owner Server App token is valid on KDS before logout',
    );

    for (const role of ['server', 'owner']) {
      const token = roleTokens[role];
      const decoded = jwt.verify(token, getJWTSecret()) as { exp?: number };
      assert.equal(typeof decoded.exp, 'number', `${role} JWT includes verified numeric exp`);

      const mainBeforeLogout = await getJson(mainBaseUrl, '/api/categories', token);
      assert.equal(
        mainBeforeLogout.status,
        200,
        `${role} token is valid on main API protected endpoint before logout`,
      );

      const logout = await postJson(baseUrl, '/api/auth/logout', {}, token);
      assert.equal(logout.status, 200, `${role} can log out from Server App`);
      assert.equal(logout.body.success, true, `Server App logout returns success for ${role}`);

      const tokenHash = createHash('sha256').update(token).digest('hex');
      const revokedRow = db
        .prepare('SELECT token_hash, expires_at FROM revoked_tokens WHERE token_hash = ?')
        .get(tokenHash) as { token_hash: string; expires_at: number } | undefined;
      assert.ok(
        revokedRow,
        `Server App logout writes durable SQLite revoked_tokens row for ${role}`,
      );
      assert.equal(
        revokedRow.expires_at,
        decoded.exp! * 1000,
        `Server App durable revocation expiry matches verified JWT exp * 1000 for ${role}`,
      );

      clearInMemoryRevokedTokens();

      const meAfterMemoryReset = await getJson(baseUrl, '/api/auth/me', token);
      assert.equal(
        meAfterMemoryReset.status,
        401,
        `Server App /api/auth/me remains 401 after clearing in-memory revocations for ${role}`,
      );

      const mainAuthMeAfterReset = await getJson(mainBaseUrl, '/api/auth/me', token);
      assert.equal(
        mainAuthMeAfterReset.status,
        401,
        `Main API /api/auth/me rejects Server App-revoked ${role} token after clearing in-memory revocations`,
      );

      const mainProtectedAfterReset = await getJson(mainBaseUrl, '/api/categories', token);
      assert.equal(
        mainProtectedAfterReset.status,
        401,
        `Main API requireAuth rejects Server App-revoked ${role} token after clearing in-memory revocations`,
      );

      const alreadyRevokedLogout = await postJson(baseUrl, '/api/auth/logout', {}, token);
      assert.equal(
        alreadyRevokedLogout.status,
        401,
        `Already-revoked ${role} token is rejected with 401 on subsequent Server App logout`,
      );

      const unrelatedLiveMe = await getJson(
        baseUrl,
        '/api/auth/me',
        liveServerLogin.body.access_token,
      );
      assert.equal(
        unrelatedLiveMe.status,
        200,
        `Unrelated live session remains usable after ${role} logout and memory reset`,
      );

      const unrelatedMainProtected = await getJson(
        mainBaseUrl,
        '/api/categories',
        liveServerLogin.body.access_token,
      );
      assert.equal(
        unrelatedMainProtected.status,
        200,
        `Unrelated live session remains usable on main API after ${role} logout and memory reset`,
      );
    }

    const ownerKdsAfterReset = await getJson(kdsBaseUrl, '/api/auth/me', roleTokens.owner);
    assert.equal(
      ownerKdsAfterReset.status,
      401,
      'KDS /api/auth/me rejects Server App-revoked owner token after clearing in-memory revocations',
    );
    const managerKdsLive = await getJson(kdsBaseUrl, '/api/auth/me', roleTokens.manager);
    assert.equal(
      managerKdsLive.status,
      200,
      'Unrevoked manager token with kitchen permission remains usable on KDS after memory reset',
    );

    // Protected forwarded routes must rate-limit LAN clients before auth or downstream work.
    const customerResponses = await Promise.all(
      Array.from({ length: 151 }, () => postJson(baseUrl, '/api/customers', {})),
    );
    assert.equal(
      customerResponses.filter(({ status }) => status === 401).length,
      150,
      'customer requests below the limit reach authentication',
    );
    assert.equal(
      customerResponses.filter(({ status }) => status === 429).length,
      1,
      'customer requests over the limit are throttled on localhost',
    );

    const printKotResponses = await Promise.all(
      Array.from({ length: 29 }, () => postJson(baseUrl, '/api/printers/print-kot', {})),
    );
    assert(
      printKotResponses.every(({ status }) => status === 401),
      'KOT requests below the shared print limit reach authentication',
    );
    const printBillBeforeLimit = await postJson(baseUrl, '/api/printers/print-bill', {});
    assert.equal(
      printBillBeforeLimit.status,
      401,
      'KOT and bill requests share the print limit before it is exceeded',
    );
    const printLimit = await postJson(baseUrl, '/api/printers/print-kot', {});
    assert.equal(
      printLimit.status,
      429,
      'print requests over the shared limit are throttled on localhost',
    );
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
