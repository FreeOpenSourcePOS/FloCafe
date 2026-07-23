/**
 * Integration Test: Issue #133 — Settings toggle for KDS vs. Printer/KOT workflow
 *
 * Covers:
 *  - kds_enabled / kot_printing_enabled default to 'true' on a fresh install
 *    (matches the pre-toggle always-on behavior).
 *  - Both are exposed via GET/PUT /api/settings/:key (ALLOWED_WILDCARD_KEYS).
 *  - kds_enabled = false:
 *      - GET /api/kds/orders, GET /api/kds/display, PATCH /api/kds/items/:id/status,
 *        GET /api/kitchen/orders, GET /api/kds-info all return 403 with a clear message.
 *      - GET/POST /api/kds/pairing return 404 (pretend the feature doesn't exist).
 *      - Turning kds_enabled off invalidates any outstanding kds_pairing_tokens.
 *      - Re-enabling restores normal (200) behavior.
 *  - kot_printing_enabled = false:
 *      - POST /api/printers/print-kot returns 403 with a clear message, regardless
 *        of whether the request would otherwise have been valid.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-133-kds-kot-toggles.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-133-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-issue-133';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb, createApp, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { settingsRoutes } = require('../main/routes/settings');
const { kdsRoutes } = require('../main/routes/kds');
const { kitchenRoutes } = require('../main/routes/kitchen');
const { kdsInfoRoutes } = require('../main/routes/kds-info');
const { printerRoutes } = require('../main/routes/printers');
const { getJWTSecret } = require('../main/routes/auth');

function seedUser(db: any, id: string, role: string, email: string) {
  db.prepare(`
    INSERT OR REPLACE INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, `${role} user`, email,
    bcrypt.hashSync('testpass123', 10),
    role,
    bcrypt.hashSync('1234', 10),
    now(), now(),
  );
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  console.log('Integration Test: Issue #133 — KDS / KOT printing toggles');
  console.log('='.repeat(60));

  const db = initTestDb();
  const ownerAuth = seedUser(db, 'issue133-owner', 'owner', 'issue133-owner@test.local');
  const chefAuth = seedUser(db, 'issue133-chef', 'chef', 'issue133-chef@test.local');

  const app = createApp({
    '/api/settings': settingsRoutes,
    '/api/kds': kdsRoutes,
    '/api/kitchen': kitchenRoutes,
    '/api/kds-info': kdsInfoRoutes,
    '/api/printers': printerRoutes,
  });

  try {
    // ── Defaults ──────────────────────────────────────────────────────────
    console.log('\n1. Defaults match pre-toggle always-on behavior');
    const kdsDefault = await request(app).get('/api/settings/kds_enabled').set(ownerAuth);
    assertEqual(kdsDefault.status, 200, 'GET /api/settings/kds_enabled succeeds');
    assertEqual(kdsDefault.body.setting?.value, 'true', 'kds_enabled defaults to "true"');

    const kotDefault = await request(app).get('/api/settings/kot_printing_enabled').set(ownerAuth);
    assertEqual(kotDefault.status, 200, 'GET /api/settings/kot_printing_enabled succeeds');
    assertEqual(kotDefault.body.setting?.value, 'true', 'kot_printing_enabled defaults to "true"');

    // ── Both features on: existing KDS endpoints work normally ─────────────
    console.log('\n2. KDS enabled — endpoints reachable');
    assertEqual((await request(app).get('/api/kds/orders').set(chefAuth)).status, 200, 'GET /api/kds/orders 200 when enabled');
    assertEqual((await request(app).get('/api/kds/display?station_id=none').set(chefAuth)).status, 404, 'GET /api/kds/display 404 for unknown station (not gated — reaches the handler)');
    assertEqual((await request(app).get('/api/kitchen/orders').set(chefAuth)).status, 200, 'GET /api/kitchen/orders 200 when enabled');
    assertEqual((await request(app).get('/api/kds-info').set(chefAuth)).status, 200, 'GET /api/kds-info 200 when enabled');
    assertEqual((await request(app).get('/api/kds/pairing').set(chefAuth)).status, 200, 'GET /api/kds/pairing 200 when enabled');

    // Seed an outstanding pairing token to verify it gets cleaned up below.
    const pairingRes = await request(app).post('/api/kds/pairing').set(ownerAuth).send({});
    assertEqual(pairingRes.status, 201, 'POST /api/kds/pairing 201 when enabled');
    const tokenCountBefore = db.prepare('SELECT COUNT(*) as c FROM kds_pairing_tokens').get().c;
    assert(tokenCountBefore > 0, 'a pairing token row exists before disabling KDS');

    // ── Disable KDS ──────────────────────────────────────────────────────
    console.log('\n3. kds_enabled = false — REST endpoints 403, pairing/websocket-style 404');
    const disableKds = await request(app).put('/api/settings/kds_enabled').set(ownerAuth).send({ value: 'false' });
    assertEqual(disableKds.status, 200, 'PUT /api/settings/kds_enabled false succeeds');

    const ordersRes = await request(app).get('/api/kds/orders').set(chefAuth);
    assertEqual(ordersRes.status, 403, 'GET /api/kds/orders 403 when KDS disabled');
    assertEqual(ordersRes.body.error, 'KDS is disabled for this business', 'GET /api/kds/orders has a clear error message');

    const displayRes = await request(app).get('/api/kds/display?station_id=none').set(chefAuth);
    assertEqual(displayRes.status, 403, 'GET /api/kds/display 403 when KDS disabled');

    const statusRes = await request(app).patch('/api/kds/items/1/status').set(chefAuth).send({ status: 'preparing' });
    assertEqual(statusRes.status, 403, 'PATCH /api/kds/items/:id/status 403 when KDS disabled');

    const kitchenRes = await request(app).get('/api/kitchen/orders').set(chefAuth);
    assertEqual(kitchenRes.status, 403, 'GET /api/kitchen/orders 403 when KDS disabled');
    assertEqual(kitchenRes.body.error, 'KDS is disabled for this business', 'GET /api/kitchen/orders has a clear error message');

    const kdsInfoRes = await request(app).get('/api/kds-info').set(chefAuth);
    assertEqual(kdsInfoRes.status, 403, 'GET /api/kds-info 403 when KDS disabled');

    const pairingGetRes = await request(app).get('/api/kds/pairing').set(chefAuth);
    assertEqual(pairingGetRes.status, 404, 'GET /api/kds/pairing 404 when KDS disabled (pretend it does not exist)');

    const pairingPostRes = await request(app).post('/api/kds/pairing').set(ownerAuth).send({});
    assertEqual(pairingPostRes.status, 404, 'POST /api/kds/pairing 404 when KDS disabled');

    // Also 404 for a role that would otherwise be rejected — disabled beats role check.
    const pairingWrongRoleRes = await request(app).get('/api/kds/pairing').set(ownerAuth);
    assertEqual(pairingWrongRoleRes.status, 404, 'GET /api/kds/pairing still 404 for an allowed role when KDS disabled');

    // ── Pairing token cleanup on disable ────────────────────────────────
    console.log('\n4. Disabling KDS invalidates outstanding pairing tokens');
    const tokenCountAfter = db.prepare('SELECT COUNT(*) as c FROM kds_pairing_tokens').get().c;
    assertEqual(tokenCountAfter, 0, 'kds_pairing_tokens is empty after disabling KDS');

    // ── Re-enable ────────────────────────────────────────────────────────
    console.log('\n5. Re-enabling KDS restores normal behavior');
    const enableKds = await request(app).put('/api/settings/kds_enabled').set(ownerAuth).send({ value: 'true' });
    assertEqual(enableKds.status, 200, 'PUT /api/settings/kds_enabled true succeeds');
    assertEqual((await request(app).get('/api/kds/orders').set(chefAuth)).status, 200, 'GET /api/kds/orders 200 again after re-enabling');
    assertEqual((await request(app).get('/api/kds/pairing').set(chefAuth)).status, 200, 'GET /api/kds/pairing 200 again after re-enabling');

    // ── KOT printing toggle ──────────────────────────────────────────────
    console.log('\n6. kot_printing_enabled = false blocks POST /api/printers/print-kot');
    const disableKot = await request(app).put('/api/settings/kot_printing_enabled').set(ownerAuth).send({ value: 'false' });
    assertEqual(disableKot.status, 200, 'PUT /api/settings/kot_printing_enabled false succeeds');

    const printKotRes = await request(app).post('/api/printers/print-kot').set(ownerAuth).send({ orderId: 999999 });
    assertEqual(printKotRes.status, 403, 'POST /api/printers/print-kot 403 when KOT printing disabled');
    assertEqual(printKotRes.body.error, 'KOT printing is disabled for this business', 'POST /api/printers/print-kot has a clear error message');

    const enableKot = await request(app).put('/api/settings/kot_printing_enabled').set(ownerAuth).send({ value: 'true' });
    assertEqual(enableKot.status, 200, 'PUT /api/settings/kot_printing_enabled true succeeds');
    // No default printer/order configured in this test DB, so re-enabled just
    // means the guard no longer short-circuits — the request now fails later
    // in the handler (no default printer configured) rather than at the gate.
    const printKotAfterRes = await request(app).post('/api/printers/print-kot').set(ownerAuth).send({ orderId: 999999 });
    assert(printKotAfterRes.status !== 403 || printKotAfterRes.body.error !== 'KOT printing is disabled for this business', 'POST /api/printers/print-kot no longer blocked by the KOT-disabled gate once re-enabled');

    // ── Summary ───────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    const results = getResults();
    console.log(`Results: ${results.passed}/${results.total} passed, ${results.failed} failed`);
    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
