/**
 * Integration Test: Issue #134 — Kitchen station CRUD, printer link, user assignment
 *
 * Covers the Settings-facing API for the station-routing feature:
 *  - POST /api/kitchen-stations actually assigns a usable id (was a pre-existing
 *    bug — the handler never set the TEXT PRIMARY KEY, so created stations had
 *    a NULL id and GET-after-create silently returned nothing useful)
 *  - printer_id can be set on create/update and must reference a real printer
 *  - PUT /api/kitchen-stations/:id/users replaces the staff assigned to a station
 *  - GET /api/kitchen-stations/:id returns the linked printer + assigned users
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-134-station-management.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-134-mgmt-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-134-mgmt';

const {
  initTestDb, startServer, seedOwnerUser, seedCategory,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');
const { kitchenStationRoutes } = require('../main/routes/kitchen-stations');

async function main() {
  console.log('Integration Test: Issue #134 — Station management API');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-bev', 'Beverages');

  db.prepare(`INSERT INTO printers (id, name, connection_type, ip_address, port) VALUES ('pr-bar', 'Bar Printer', 'network', '192.168.1.70', 9100)`).run();
  db.prepare(`INSERT INTO users (id, name, email, password, role) VALUES ('u-bar-staff', 'Bar Staff', 'bar@test.com', 'x', 'cashier')`).run();

  const express = require('express');
  const app = express();
  app.use(express.json());
  const jwt = require('jsonwebtoken');
  const { getJWTSecret } = require('../main/routes/auth');
  app.use((req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      req.user = jwt.verify(h.split(' ')[1], getJWTSecret());
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/kitchen-stations', kitchenStationRoutes);

  const { baseUrl, server } = await startServer(app);

  try {
    let stationId: string;

    console.log('\n─── Scenario A: creating a station assigns a real id ───');
    {
      const res = await api(baseUrl, '/api/kitchen-stations', {
        method: 'POST',
        body: { name: 'Bar', category_ids: ['cat-bev'], printer_id: 'pr-bar' },
        headers: authHeader,
      });
      assertEqual(res.status, 201, 'A: station created');
      assert(!!res.data.kitchenStation.id, 'A: created station has a non-null id');
      assertEqual(res.data.kitchenStation.printer_id, 'pr-bar', 'A: printer_id persisted on create');
      stationId = res.data.kitchenStation.id;

      const getRes = await api(baseUrl, `/api/kitchen-stations/${stationId}`, { headers: authHeader });
      assertEqual(getRes.status, 200, 'A: created station is fetchable by its id');
      assertEqual(getRes.data.kitchenStation.printer.id, 'pr-bar', 'A: fetched station includes the linked printer object');
    }

    console.log('\n─── Scenario B: printer_id must reference a real printer ───');
    {
      const res = await api(baseUrl, '/api/kitchen-stations', {
        method: 'POST',
        body: { name: 'Ghost Station', printer_id: 'does-not-exist' },
        headers: authHeader,
      });
      assertEqual(res.status, 400, 'B: rejects an unknown printer_id');
    }

    console.log('\n─── Scenario C: assigning staff to a station ───');
    {
      const res = await api(baseUrl, `/api/kitchen-stations/${stationId!}/users`, {
        method: 'PUT',
        body: { user_ids: ['u-bar-staff'] },
        headers: authHeader,
      });
      assertEqual(res.status, 200, 'C: user assignment succeeds');
      assertEqual(res.data.users.length, 1, 'C: one user assigned');
      assertEqual(res.data.users[0].id, 'u-bar-staff', 'C: correct user assigned');

      const getRes = await api(baseUrl, `/api/kitchen-stations/${stationId!}`, { headers: authHeader });
      assertEqual(getRes.data.kitchenStation.users.length, 1, 'C: GET station reflects the assigned user');
    }

    console.log('\n─── Scenario D: re-assigning replaces the previous set, not additive ───');
    {
      db.prepare(`INSERT INTO users (id, name, email, password, role) VALUES ('u-bar-staff-2', 'Bar Staff 2', 'bar2@test.com', 'x', 'cashier')`).run();
      const res = await api(baseUrl, `/api/kitchen-stations/${stationId!}/users`, {
        method: 'PUT',
        body: { user_ids: ['u-bar-staff-2'] },
        headers: authHeader,
      });
      assertEqual(res.status, 200, 'D: re-assignment succeeds');
      assertEqual(res.data.users.length, 1, 'D: exactly one user after replace');
      assertEqual(res.data.users[0].id, 'u-bar-staff-2', 'D: the new user replaced the old one, not appended');
    }

    console.log('\n─── Scenario E: assigning an unknown user_id is rejected ───');
    {
      const res = await api(baseUrl, `/api/kitchen-stations/${stationId!}/users`, {
        method: 'PUT',
        body: { user_ids: ['nonexistent-user'] },
        headers: authHeader,
      });
      assertEqual(res.status, 400, 'E: rejects an unknown user_id');
    }

  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
