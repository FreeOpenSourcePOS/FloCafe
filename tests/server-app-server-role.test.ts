/** Server App auth must be limited to service staff (server role). */
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
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl: string, pathName: string, token: string) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  console.log('Integration Test: Server App server-only auth');
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

  try {
    for (const role of ['owner', 'manager', 'cashier', 'chef']) {
      const response = await postJson(baseUrl, '/api/auth/login', {
        email: `${role}@server-app.test`,
        password: 'ServerPass123!',
      });
      assert.equal(response.status, 403, `${role} cannot log in to Server App`);
      assert.match(String(response.body.error), /Only service staff/i);
    }

    const serverLogin = await postJson(baseUrl, '/api/auth/login', {
      email: 'server@server-app.test',
      password: 'ServerPass123!',
    });
    assert.equal(serverLogin.status, 200, 'server can log in to Server App');
    assert.equal(serverLogin.body.user.role, 'server', 'Server App returns server role');
    assert.ok(serverLogin.body.access_token, 'Server App returns a token for server');

    const me = await getJson(baseUrl, '/api/auth/me', serverLogin.body.access_token);
    assert.equal(me.status, 200, 'server token remains valid on /api/auth/me');
    assert.equal(me.body.user.role, 'server', '/api/auth/me returns server role');
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
