/**
 * Integration Test: Floor management (Issue #646)
 *
 * Tests that:
 * A) PATCH /api/tables/floors/:name renames every table on that floor
 * B) PATCH to an existing floor merges the source into the target in one UPDATE
 * C) DELETE /api/tables/floors/:name moves all tables on that floor to NULL
 *    (the Unassigned bucket) — tables themselves are preserved
 * D) Both endpoints reject empty / missing new names with 400
 * E) Both endpoints require owner/manager role (cashier is denied)
 * F) URL-encoded floor names (with %20, etc.) work end-to-end
 *
 * Regression test for Issue #646: edit/manage floors in table settings.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-646-floor-management.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-floors-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedManagerUser,
  api, assert, assertEqual, assertGreaterThan,
  closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJWTSecret } = require('../main/routes/auth');
const { tableRoutes } = require('../main/routes/tables');

async function main() {
  console.log('Integration Test: Floor management (Issue #646)');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { authHeader: managerAuth } = seedManagerUser(db);

  // Inline cashier seed — no test-setup helper exists for it, and we only need it
  // to assert that the owner/manager-only floor endpoints reject the cashier role.
  const cashierId = 'cash-test-001';
  const cashierHash = bcrypt.hashSync('testpass123', 10);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(cashierId, 'Test Cashier', 'cashier@test.local', cashierHash, 'cashier', null, 1, now(), now());
  const cashierToken = jwt.sign(
    { userId: cashierId, email: 'cashier@test.local', role: 'cashier' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const cashierAuth = { Authorization: `Bearer ${cashierToken}` };

  const app = createApp({
    '/api/tables': tableRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Seed: three tables on "Ground", two on "First", one unassigned.
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Seed: tables across multiple floors ───');

    const seedRows: Array<[string, string, string | null]> = [
      ['tbl-g-1', 'G1', 'Ground'],
      ['tbl-g-2', 'G2', 'Ground'],
      ['tbl-g-3', 'G3', 'Ground'],
      ['tbl-f-1', 'F1', 'First'],
      ['tbl-f-2', 'F2', 'First'],
      ['tbl-u-1', 'U1', null],
    ];
    const insert = db.prepare(
      `INSERT INTO tables (id, number, capacity, floor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, number, floor] of seedRows) {
      insert.run(id, number, 4, floor, now(), now());
    }
    console.log(`   ✓ Seeded ${seedRows.length} tables across three buckets`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario A: Rename floor "Ground" → "Main"
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario A: PATCH /api/tables/floors/Ground renames every row ───');

    const renameRes = await api(baseUrl, '/api/tables/floors/Ground', {
      method: 'PATCH',
      headers: ownerAuth,
      body: JSON.stringify({ newName: 'Main' }),
    });

    assertEqual(renameRes.status, 200, 'PATCH /floors/Ground returns 200');
    assertEqual(renameRes.data.floor, 'Main', 'Response echoes new floor name');
    assertEqual(renameRes.data.previousFloor, 'Ground', 'Response echoes previous name');
    assertEqual(renameRes.data.affected, 3, 'affected count equals tables on Ground');

    const afterRename = db.prepare(
      `SELECT id, floor FROM tables WHERE id IN ('tbl-g-1', 'tbl-g-2', 'tbl-g-3', 'tbl-f-1', 'tbl-f-2', 'tbl-u-1') ORDER BY id`,
    ).all() as Array<{ id: string; floor: string | null }>;
    const groundFloor = afterRename.filter((r) => r.floor === 'Ground');
    const mainFloor = afterRename.filter((r) => r.floor === 'Main');
    const firstFloor = afterRename.filter((r) => r.floor === 'First');
    assertEqual(groundFloor.length, 0, 'No tables left on "Ground" after rename');
    assertEqual(mainFloor.length, 3, 'All three Ground tables now on "Main"');
    assertEqual(firstFloor.length, 2, '"First" tables untouched');
    console.log(`   ✓ Ground (0) → Main (3); First (2), Unassigned (1) unchanged`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario B: Rename "Main" → "First" merges into the existing target
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B: Rename to an existing floor merges them ───');

    const mergeRes = await api(baseUrl, '/api/tables/floors/Main', {
      method: 'PATCH',
      headers: ownerAuth,
      body: JSON.stringify({ newName: 'First' }),
    });

    assertEqual(mergeRes.status, 200, 'Merge rename returns 200');
    assertEqual(mergeRes.data.affected, 3, 'affected count is 3 (Main tables moved)');

    const afterMerge = db.prepare(
      `SELECT COUNT(*) AS n FROM tables WHERE floor = 'First'`,
    ).get() as { n: number };
    assertEqual(afterMerge.n, 5, 'First now holds all 5 tables (2 original + 3 merged)');

    const mainLeft = db.prepare(
      `SELECT COUNT(*) AS n FROM tables WHERE floor = 'Main'`,
    ).get() as { n: number };
    assertEqual(mainLeft.n, 0, 'No tables left on "Main" after merge');
    console.log(`   ✓ Main (3 tables) merged into First (now 5)`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario C: DELETE floor "First" → all 5 tables move to Unassigned
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario C: DELETE /api/tables/floors/First unassigns every table ───');

    const deleteRes = await api(baseUrl, '/api/tables/floors/First', {
      method: 'DELETE',
      headers: ownerAuth,
    });

    assertEqual(deleteRes.status, 200, 'DELETE /floors/First returns 200');
    assertEqual(deleteRes.data.removedFloor, 'First', 'Response echoes removed floor');
    assertEqual(deleteRes.data.affected, 5, 'affected count is 5');
    assertEqual(deleteRes.data.floor, null, 'Response confirms new floor is null');

    const afterDelete = db.prepare(
      `SELECT COUNT(*) AS n FROM tables WHERE floor IS NULL`,
    ).get() as { n: number };
    assertEqual(afterDelete.n, 6, 'All 6 tables now unassigned (5 + the original unassigned)');

    const stillFirst = db.prepare(
      `SELECT COUNT(*) AS n FROM tables WHERE floor = 'First'`,
    ).get() as { n: number };
    assertEqual(stillFirst.n, 0, 'No tables left on "First"');
    console.log(`   ✓ All 5 tables on First moved to Unassigned; tables preserved`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario D: 400 on empty / missing newName
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario D: empty / missing newName is rejected ───');

    const missingName = await api(baseUrl, '/api/tables/floors/Ground', {
      method: 'PATCH',
      headers: ownerAuth,
      body: JSON.stringify({}),
    });
    assertEqual(missingName.status, 400, 'Missing newName returns 400');
    assertEqual(missingName.data.code, 'FLOOR_NAME_REQUIRED', 'Error code is FLOOR_NAME_REQUIRED');

    const blankName = await api(baseUrl, '/api/tables/floors/Ground', {
      method: 'PATCH',
      headers: ownerAuth,
      body: JSON.stringify({ newName: '   ' }),
    });
    assertEqual(blankName.status, 400, 'Whitespace newName returns 400');
    console.log(`   ✓ Validation rejects empty / whitespace newName`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario E: RBAC — cashier denied, manager allowed
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario E: RBAC enforced ───');

    const cashierPatch = await api(baseUrl, '/api/tables/floors/Ground', {
      method: 'PATCH',
      headers: cashierAuth,
      body: JSON.stringify({ newName: 'X' }),
    });
    assertEqual(cashierPatch.status, 403, 'Cashier PATCH is denied');

    const cashierDelete = await api(baseUrl, '/api/tables/floors/Ground', {
      method: 'DELETE',
      headers: cashierAuth,
    });
    assertEqual(cashierDelete.status, 403, 'Cashier DELETE is denied');

    // 'Ground' has zero rows by this point (Scenario A renamed them all), so a
    // rename here would return 200 with affected: 0 and prove nothing. Seed a
    // manager-scoped floor so the allowed-request assertion covers a real move.
    db.prepare(
      `INSERT INTO tables (id, number, capacity, floor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('tbl-mgr-1', 'M1', 4, 'Ground', now(), now());

    const managerRename = await api(baseUrl, '/api/tables/floors/Ground', {
      method: 'PATCH',
      headers: managerAuth,
      body: JSON.stringify({ newName: 'Patio' }),
    });
    assertEqual(managerRename.status, 200, 'Manager PATCH is allowed');
    assertEqual(managerRename.data.affected, 1, 'Manager rename moved the seeded table');
    const mgrPersisted = db.prepare(
      `SELECT floor FROM tables WHERE id = 'tbl-mgr-1'`,
    ).get() as { floor: string };
    assertEqual(mgrPersisted.floor, 'Patio', 'Persisted row landed on "Patio"');
    console.log(`   ✓ Cashier denied (403), Manager allowed (200, affected 1, persisted)`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario F: URL-encoded floor names round-trip
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario F: URL-encoded floor names ───');

    // Use a name that actually requires encoding. `encodeURIComponent('Mezzanine')`
    // is a no-op, so the prior shape of this test passed even when decoding was
    // broken. "Mezzanine Level" round-trips through `%20` and exercises the
    // Express path-decoder that feeds `req.params.name`.
    const encodedFloor = 'Mezzanine Level';
    const encodedFloorEscaped = encodeURIComponent(encodedFloor);
    assert(encodedFloorEscaped.includes('%20'), `Encoded form contains %20: ${encodedFloorEscaped}`);

    db.prepare(
      `INSERT INTO tables (id, number, capacity, floor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('tbl-sp-1', 'S1', 4, encodedFloor, now(), now());
    db.prepare(
      `INSERT INTO tables (id, number, capacity, floor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('tbl-sp-2', 'S2', 4, encodedFloor, now(), now());

    const encodedRename = await api(baseUrl, `/api/tables/floors/${encodedFloorEscaped}`, {
      method: 'PATCH',
      headers: ownerAuth,
      body: JSON.stringify({ newName: 'Mezz' }),
    });
    assertEqual(encodedRename.status, 200, 'URL-encoded rename works');
    assertEqual(encodedRename.data.previousFloor, encodedFloor, 'Server saw the decoded floor name');
    assertEqual(encodedRename.data.affected, 2, 'Both Mezzanine tables renamed');

    const stillThere = db.prepare(
      `SELECT COUNT(*) AS n FROM tables WHERE floor = 'Mezz'`,
    ).get() as { n: number };
    assertEqual(stillThere.n, 2, 'Tables land on "Mezz"');
    console.log(`   ✓ "Mezzanine Level" → "Mezz" via ${encodedFloorEscaped}`);

    console.log('\n✅ All floor management scenarios passed');
  } catch (error: any) {
    console.error('\n✗ Test failed:', error?.message || error);
    if (error?.stack) console.error(error.stack);
    process.exitCode = 1;
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main();