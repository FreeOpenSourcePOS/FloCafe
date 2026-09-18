/** Server App auth must be limited to front-line + management staff (server, manager, owner). */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

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
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
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

  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  const db = getDatabase();
  const passwordHash = bcrypt.hashSync('ServerPass123!', 10);

  for (const role of ['owner', 'manager', 'cashier', 'chef', 'server']) {
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(`server-app-${role}`, `Server App ${role}`, `${role}@server-app.test`, passwordHash, role, now(), now());
  }

  await startServerApp();
  const baseUrl = `http://127.0.0.1:${getServerAppPort()}`;
  const setSetting = (key: string, value: string) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  try {
    setSetting('country', '');
    const unconfiguredInfo = await getJson(baseUrl, '/api/server-app/info');
    assert.equal(unconfiguredInfo.status, 409, 'Server App refuses to format regional values before a country is configured');
    assert.equal(unconfiguredInfo.body.error, 'regional_not_configured');

    setSetting('country', 'CO');
    setSetting('currency', 'COP');
    const copInfo = await getJson(baseUrl, '/api/server-app/info');
    assert.equal(copInfo.status, 200);
    assert.deepEqual({
      country: copInfo.body.country,
      currency: copInfo.body.currency,
      symbol: copInfo.body.currency_symbol,
      position: copInfo.body.currency_position,
      fractionDigits: copInfo.body.currency_fraction_digits,
    }, {
      country: 'CO',
      currency: 'COP',
      symbol: '$',
      position: 'prefix',
      fractionDigits: 0,
    }, 'Server App exposes the COP regional values derived from current settings');

    setSetting('country', 'KW');
    setSetting('currency', 'KWD');
    const kwdInfo = await getJson(baseUrl, '/api/server-app/info');
    assert.equal(kwdInfo.status, 200);
    assert.deepEqual({
      country: kwdInfo.body.country,
      currency: kwdInfo.body.currency,
      symbol: kwdInfo.body.currency_symbol,
      position: kwdInfo.body.currency_position,
      fractionDigits: kwdInfo.body.currency_fraction_digits,
    }, {
      country: 'KW',
      currency: 'KWD',
      symbol: 'د.ك.',
      position: 'suffix',
      fractionDigits: 3,
    }, 'Server App exposes the KWD regional values derived from current settings, from CLDR rather than a stored override');

    for (const role of ['cashier', 'chef']) {
      const response = await postJson(baseUrl, '/api/auth/login', {
        email: `${role}@server-app.test`,
        password: 'ServerPass123!',
      });
      assert.equal(response.status, 403, `${role} cannot log in to Server App`);
      assert.match(String(response.body.error), /Only server, manager, or owner/i);
    }

    for (const role of ['server', 'manager', 'owner']) {
      const login = await postJson(baseUrl, '/api/auth/login', {
        email: `${role}@server-app.test`,
        password: 'ServerPass123!',
      });
      assert.equal(login.status, 200, `${role} can log in to Server App`);
      assert.equal(login.body.user.role, role, `Server App returns ${role} role`);
      assert.ok(login.body.access_token, `Server App returns a token for ${role}`);

      const me = await getJson(baseUrl, '/api/auth/me', login.body.access_token);
      assert.equal(me.status, 200, `${role} token remains valid on /api/auth/me`);
      assert.equal(me.body.user.role, role, `/api/auth/me returns ${role} role`);
    }

    // Protected forwarded routes must rate-limit LAN clients before auth or downstream work.
    const customerResponses = await Promise.all(
      Array.from({ length: 151 }, () => postJson(baseUrl, '/api/customers', {})),
    );
    assert.equal(customerResponses.filter(({ status }) => status === 401).length, 150, 'customer requests below the limit reach authentication');
    assert.equal(customerResponses.filter(({ status }) => status === 429).length, 1, 'customer requests over the limit are throttled on localhost');

    const printKotResponses = await Promise.all(
      Array.from({ length: 29 }, () => postJson(baseUrl, '/api/printers/print-kot', {})),
    );
    assert(printKotResponses.every(({ status }) => status === 401), 'KOT requests below the shared print limit reach authentication');
    const printBillBeforeLimit = await postJson(baseUrl, '/api/printers/print-bill', {});
    assert.equal(printBillBeforeLimit.status, 401, 'KOT and bill requests share the print limit before it is exceeded');
    const printLimit = await postJson(baseUrl, '/api/printers/print-kot', {});
    assert.equal(printLimit.status, 429, 'print requests over the shared limit are throttled on localhost');
  } finally {
    await stopServerApp();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('ALL PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
