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
const { printerRoutes } = require('../main/routes/printers');

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
  app.use('/api/printers', printerRoutes);

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

      const emptyCreate = await api(baseUrl, '/api/kitchen-stations', {
        method: 'POST', body: { name: 'Empty Printer', printer_id: '' }, headers: authHeader,
      });
      assertEqual(emptyCreate.status, 400, 'B: rejects an empty printer_id on create');

      const emptyUpdate = await api(baseUrl, `/api/kitchen-stations/${stationId!}`, {
        method: 'PUT', body: { printer_id: '' }, headers: authHeader,
      });
      assertEqual(emptyUpdate.status, 400, 'B: rejects an empty printer_id on update');

      const clearUpdate = await api(baseUrl, `/api/kitchen-stations/${stationId!}`, {
        method: 'PUT', body: { printer_id: null }, headers: authHeader,
      });
      assertEqual(clearUpdate.status, 200, 'B: allows explicit printer clearing');
      const restoreUpdate = await api(baseUrl, `/api/kitchen-stations/${stationId!}`, {
        method: 'PUT', body: { printer_id: 'pr-bar' }, headers: authHeader,
      });
      assertEqual(restoreUpdate.status, 200, 'B: allows restoring a valid printer assignment');
    }

    console.log('\n─── Scenario C: printer updates preserve omitted fields and protect defaults ───');
    {
      const create = await api(baseUrl, '/api/printers', {
        method: 'POST', body: { name: 'Receipt Printer', connection_type: 'network', ip_address: '192.168.1.71', port: 9200, is_default: true }, headers: authHeader,
      });
      assertEqual(create.status, 201, 'C: printer created');
      const printerId = create.data.printer.id;

      const invalidType = await api(baseUrl, `/api/printers/${printerId}`, {
        method: 'PUT', body: { connection_type: 'serial' }, headers: authHeader,
      });
      assertEqual(invalidType.status, 400, 'C: rejects invalid connection type on update');
      const invalidPort = await api(baseUrl, `/api/printers/${printerId}`, {
        method: 'PUT', body: { port: 0 }, headers: authHeader,
      });
      assertEqual(invalidPort.status, 400, 'C: rejects invalid port on update');

      const renamed = await api(baseUrl, `/api/printers/${printerId}`, {
        method: 'PUT', body: { name: 'Renamed Printer' }, headers: authHeader,
      });
      assertEqual(renamed.status, 200, 'C: partial update succeeds');
      assertEqual(renamed.data.printer.port, 9200, 'C: omitted port is preserved');
      assertEqual(renamed.data.printer.ip_address, '192.168.1.71', 'C: omitted IP is preserved');

      const second = await api(baseUrl, '/api/printers', {
        method: 'POST', body: { name: 'Second Printer', connection_type: 'usb' }, headers: authHeader,
      });
      assertEqual(second.status, 201, 'C: second printer created');
      const deleted = await api(baseUrl, `/api/printers/${printerId}`, { method: 'DELETE', headers: authHeader });
      assertEqual(deleted.status, 200, 'C: default printer deletion succeeds with a replacement');
      const printers = await api(baseUrl, '/api/printers', { headers: authHeader });
      assertEqual(printers.data.printers.filter((p: any) => p.is_default === 1).length, 1, 'C: replacement default is selected');
      const removeSeed = await api(baseUrl, '/api/printers/pr-bar', { method: 'DELETE', headers: authHeader });
      assertEqual(removeSeed.status, 200, 'C: non-default printer can be deleted');
      const soleDelete = await api(baseUrl, `/api/printers/${second.data.printer.id}`, { method: 'DELETE', headers: authHeader });
      assertEqual(soleDelete.status, 409, 'C: prevents deleting the only default printer');
    }

    console.log('\n─── Scenario D: assigning staff to a station ───');
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

    console.log('\n─── Scenario E: re-assigning replaces the previous set, not additive ───');
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

    console.log('\n─── Scenario F: assigning an unknown user_id is rejected ───');
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
