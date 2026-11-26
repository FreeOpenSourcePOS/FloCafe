/**
 * The Server App forwards the pizza menu from the main API, so its browser can
 * write out what is on a sent pizza or deal.
 *
 * Run: npm run test:pizza-server-app-catalog
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-server-app-catalog-'));

Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function main() {
  process.env.PORT = String(await freePort());
  process.env.KDS_PORT = String(await freePort());
  process.env.SERVER_APP_PORT = String(await freePort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');
  const { importMenu } = await import('../main/pizza/menu-import');
  const { parseMenuFile } = await import('../shared/pizza/menu');
  const sample = require('./fixtures/pizza-sample-menu.json');

  initDatabase();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('pizza-server', 'Pizza Server', 'server@pizza.test', ?, 'server', 1, ?, ?)
  `).run(bcrypt.hashSync('ServerPass123!', 10), now(), now());
  for (const [key, value] of [
    ['country', 'CA'],
    ['currency', 'CAD'],
  ])
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);

  await startServer();
  await startServerApp();
  const baseUrl = `http://127.0.0.1:${getServerAppPort()}`;
  const catalog = (token?: string) =>
    fetch(`${baseUrl}/api/pizza/catalog`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'server@pizza.test', password: 'ServerPass123!' }),
    });
    assert.equal(login.status, 200, 'a server signs in to the Server App');
    const token = (await login.json()).access_token as string;

    assert.equal((await catalog()).status, 401, 'the menu needs a Server App sign-in');

    const none = await catalog(token);
    assert.equal(none.status, 404, 'no menu loaded: the main API says so');
    assert.match(String(none.headers.get('content-type')), /json/, 'as JSON, not the app page');

    importMenu(db, parseMenuFile(sample));
    const loaded = await catalog(token);
    assert.equal(loaded.status, 200, 'the loaded menu is forwarded');
    const body = await loaded.json();
    assert.deepEqual(
      body.pizzas.map((pizza: { id: string }) => pizza.id),
      sample.categories[0].items.map((pizza: { id: string }) => pizza.id),
      'with the pizzas of the sample menu',
    );
    assert.ok(body.deals.length > 0, 'and its deals');
    console.log('pizza-server-app-catalog: 4 of 4 checks passed.');
  } finally {
    await stopServerApp();
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
