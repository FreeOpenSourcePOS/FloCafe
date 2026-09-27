/**
 * Diagnostics screen API: the data the in-app screen renders, and the exact
 * text the copy-for-support bundle contains.
 *
 * Guards the two boundaries the screen exists to keep apart:
 *   - the bundle is the shared system-diagnostics builder plus the recent
 *     failures, and it never carries the raw log tail (the operator adds that
 *     deliberately, after seeing it, on the screen);
 *   - reading the screen never transmits anything.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/diagnostics-screen.test.ts
 */
const Module = require('module');
const crypto = require('crypto');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostics-screen-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.11.0' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, api, assertOrThrow, assertEqualOrThrow, getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { cloudSync } = require('../main/services/cloud-sync');

const settle = async (predicate: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

async function main() {
  console.log('Diagnostics Screen API Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('business_name', 'Screen Test Cafe', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(now());

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  console.log('\n1. A real failure is captured locally and shown by the recent-failures endpoint');
  db.prepare('DELETE FROM local_diagnostics').run();
  const captured = await (async () => {
    cloudSync.reportDiagnostic({
      event_id: '0f2c1d9e-1111-4a4a-9a4a-111111111111',
      event_code: 'server.internal_error',
      severity: 'error',
      metadata: { route: '/api/orders', method: 'POST', status: 500 },
      occurred_at: new Date().toISOString(),
    }, new Error('no such table: orders'));
    return settle(() => (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number }).count >= 1);
  })();
  assertOrThrow(captured, 'the failure reached the local log');

  const recent = await api(baseUrl, '/api/diagnostics/recent', { headers: owner.authHeader });
  assertEqualOrThrow(recent.status, 200, 'the recent-failures endpoint answers 200');
  assertEqualOrThrow(recent.data.failures.length, 1, 'the operator sees exactly the captured failure');
  const failure = recent.data.failures[0];
  assertEqualOrThrow(failure.signature, 'Error: no such table: orders', 'the failure shows the derived signature, not the constant phrase');
  assertEqualOrThrow(failure.summary, 'An unexpected problem occurred: no such table: orders.', 'the failure shows a plain-language summary');
  assertEqualOrThrow(failure.event_code, 'server.internal_error', 'the failure shows which part of the app failed');
  assertEqualOrThrow(failure.metadata.route, '/api/orders', 'approved metadata is shown');
  assertOrThrow(!JSON.stringify(failure).includes('Screen Test Cafe'), 'the failure row carries no business data');

  console.log('\n2. The copy-for-support bundle is the shared builder plus the recent failures');
  const bundleRes = await api(baseUrl, '/api/diagnostics/support-bundle', { headers: owner.authHeader });
  assertEqualOrThrow(bundleRes.status, 200, 'the bundle endpoint answers 200');
  const bundle = bundleRes.data.bundle;
  assertEqualOrThrow(bundle.system.app_version, require('../package.json').version, 'the bundle carries the application version');
  // Floor, not a pin: this change's own migration moves the number over time.
  assertOrThrow(Number(bundle.system.schema_version) >= 95, 'the bundle carries the current schema version');
  assertEqualOrThrow(bundle.system.platform, process.platform, 'the bundle carries the platform');
  assertEqualOrThrow(bundle.system.arch, process.arch, 'the bundle carries the architecture');
  assertEqualOrThrow(bundle.system.restaurant_name, 'Screen Test Cafe', 'the bundle carries the business profile of the signed-in operator');
  assertEqualOrThrow(bundle.recent_failures.length, 1, 'the bundle carries the recent failures');
  assertEqualOrThrow(bundle.recent_failures[0].signature, 'Error: no such table: orders', 'the bundle quotes the derived signature');
  const bundleText = JSON.stringify(bundle);
  assertOrThrow(!/log_tail|LogTail|main\.log/.test(bundleText), 'the bundle never carries the raw log tail by default');

  console.log('\n3. The pre-login rule is unchanged: an unauthenticated caller gets nothing');
  const unauthRecent = await fetch(`${baseUrl}/api/diagnostics/recent`);
  assertEqualOrThrow(unauthRecent.status, 401, 'an unauthenticated caller cannot read the failure log');
  const unauthBundle = await fetch(`${baseUrl}/api/diagnostics/support-bundle`);
  assertEqualOrThrow(unauthBundle.status, 401, 'an unauthenticated caller cannot read the support bundle');

  console.log('\n4. Nothing on the screen transmits anything');
  const outboxBefore = (getDatabase().prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as { count: number }).count;
  await api(baseUrl, '/api/diagnostics/recent', { headers: owner.authHeader });
  await api(baseUrl, '/api/diagnostics/support-bundle', { headers: owner.authHeader });
  const outboxAfter = (getDatabase().prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as { count: number }).count;
  assertEqualOrThrow(outboxAfter, outboxBefore, 'reading the screen queues nothing for transmission');
  assertEqualOrThrow(
    (getDatabase().prepare("SELECT value FROM settings WHERE key = 'diagnostics_transmission_enabled'").get() as { value: string }).value,
    'false',
    'the transmission setting is still off after the operator used the screen',
  );

  console.log('\n5. Only a settings-permission holder may erase the failure history');
  const { getJWTSecret } = require('../main/routes/auth');
  const jwt = require('jsonwebtoken');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run('srv-diag-001', 'Diag Server', 'server@diag.local', 'unused', 'server', now(), now());
  const serverAuth = {
    Authorization: `Bearer ${jwt.sign({ userId: 'srv-diag-001', email: 'server@diag.local', role: 'server' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };

  cloudSync.reportDiagnostic({ event_id: crypto.randomUUID(), event_code: 'server.internal_error', severity: 'error', occurred_at: new Date().toISOString() }, new Error('no such table: orders'));
  await settle(() => (getDatabase().prepare('SELECT COUNT(*) AS c FROM local_diagnostics').get() as { c: number }).c >= 1);
  const beforeRefused = (getDatabase().prepare('SELECT COUNT(*) AS c FROM local_diagnostics').get() as { c: number }).c;
  const serverCanRead = await api(baseUrl, '/api/diagnostics/recent', { headers: serverAuth });
  assertEqualOrThrow(serverCanRead.status, 200, 'a server with the support permission can still read failures');
  const serverClear = await api(baseUrl, '/api/diagnostics/recent', { method: 'DELETE', headers: serverAuth });
  assertEqualOrThrow(serverClear.status, 403, 'a server without the settings permission cannot clear failures');
  assertEqualOrThrow(
    (getDatabase().prepare('SELECT COUNT(*) AS c FROM local_diagnostics').get() as { c: number }).c,
    beforeRefused,
    'the refused clear destroyed nothing',
  );
  const ownerClear = await api(baseUrl, '/api/diagnostics/recent', { method: 'DELETE', headers: owner.authHeader });
  assertEqualOrThrow(ownerClear.status, 200, 'the owner can clear failures');
  assertEqualOrThrow(
    (getDatabase().prepare('SELECT COUNT(*) AS c FROM local_diagnostics').get() as { c: number }).c,
    0,
    'the owner clear emptied the log',
  );
  assertEqualOrThrow(
    (getDatabase().prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as { count: number }).count,
    outboxBefore,
    'clearing the local log never touches the outbox',
  );

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  server.close();
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
