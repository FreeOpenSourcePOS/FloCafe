/**
 * Offline mode: owner-only switch that closes every optional outbound connection.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/offline-mode.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-offline-mode-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-offline-mode';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { productRoutes } = require('../main/routes/products');
const { isOfflineMode, assertOnlineAllowed } = require('../main/services/offline-mode');
const { isTelemetrySuppressed } = require('../main/services/telemetry');
const { postHogEnvironment } = require('../main/services/posthog-config');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Offline mode');
  console.log('='.repeat(60));
  resetCounters();
  delete process.env.FLO_MATRIX_OFFLINE;
  const db = initTestDb();
  const ownerAuth = seedUser(db, 'owner-om', 'owner');
  const managerAuth = seedUser(db, 'mgr-om', 'manager');

  const app = createApp({ '/api/settings': settingsRoutes, '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    assertEqualOrThrow(isOfflineMode(), false, 'online by default');
    assertEqualOrThrow(
      (await api(baseUrl, '/api/settings/offline-mode', { headers: managerAuth })).data
        .offline_mode,
      false,
      'the state is readable by settings viewers',
    );

    const refused = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: true },
      headers: managerAuth,
    });
    assertEqualOrThrow(refused.status, 403, 'a manager cannot switch Offline mode');
    assertEqualOrThrow(isOfflineMode(), false, 'a refused change leaves the mode unchanged');

    const invalid = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: 'yes' },
      headers: ownerAuth,
    });
    assertEqualOrThrow(invalid.status, 400, 'a non-boolean value is rejected');

    const on = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: true },
      headers: ownerAuth,
    });
    assertEqualOrThrow(on.status, 200, 'the owner switches Offline mode on');
    assertEqualOrThrow(on.data.offline_mode, true, 'the response reports the new state');
    assertEqualOrThrow(isOfflineMode(), true, 'the service reads the persisted setting');

    console.log('\n--- Gated connections ---');
    let blocked = '';
    try {
      assertOnlineAllowed('Cloud sync');
    } catch (error: any) {
      blocked = error.code;
    }
    assertEqualOrThrow(blocked, 'offline_mode', 'network guards throw while Offline mode is on');
    assertEqualOrThrow(isTelemetrySuppressed(), true, 'telemetry is suppressed');
    assertEqualOrThrow(postHogEnvironment(), null, 'product analytics never connects');
    const imageImport = await api(baseUrl, '/api/products/fetch-url', {
      method: 'POST',
      body: { url: 'https://example.com/a.png' },
      headers: ownerAuth,
    });
    assertEqualOrThrow(imageImport.status, 503, 'web image import is refused');

    const off = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: false },
      headers: ownerAuth,
    });
    assertEqualOrThrow(off.data.offline_mode, false, 'the owner switches it back off');
    assertEqualOrThrow(isOfflineMode(), false, 'connections are allowed again');
    assertOrThrow(
      (
        await api(baseUrl, '/api/products/fetch-url', {
          method: 'POST',
          body: { url: 'http://insecure.example/a.png' },
          headers: ownerAuth,
        })
      ).status === 400,
      'image import is reachable again',
    );
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
