/**
 * Tests for F4 (#1242): Operational staff approver directory endpoint (/api/staff/approvers).
 * Verifies that operational staff members (cashier, server, etc.) without staff.view
 * can read active approvers with PINs via a minimal-projection endpoint, while
 * keeping GET /api/staff protected.
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-f4-staff-approvers-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { staffRoutes } = require('../main/routes/staff');
const { getJWTSecret } = require('../main/routes/auth');

function makeAuthHeader(user: { id: string; email: string; role: string }) {
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, getJWTSecret(), {
    expiresIn: '1h',
  });
  return { Authorization: `Bearer ${token}` };
}

async function run() {
  console.log('Testing Staff Approvers Directory (F4 / #1242)...');

  const db = initTestDb();

  const { authHeader: ownerAuth } = seedOwnerUser(db);

  const passwordHash = bcrypt.hashSync('testpass123', 10);
  const pinHashA = bcrypt.hashSync('1111', 10);
  const pinHashB = bcrypt.hashSync('2222', 10);

  // Seed test users
  const mgrA = {
    id: 'mgr-a-pin',
    name: 'Alice Manager',
    role: 'manager',
    email: 'alice@test.local',
  };
  const mgrB = { id: 'mgr-b-pin', name: 'Bob Manager', role: 'manager', email: 'bob@test.local' };
  const mgrNoPin = {
    id: 'mgr-no-pin',
    name: 'Charlie NoPin',
    role: 'manager',
    email: 'charlie@test.local',
  };
  const mgrInactive = {
    id: 'mgr-inactive',
    name: 'Diana Inactive',
    role: 'manager',
    email: 'diana@test.local',
  };
  const cashier = {
    id: 'cashier-1',
    name: 'Evan Cashier',
    role: 'cashier',
    email: 'evan@test.local',
  };
  const serverUser = {
    id: 'server-1',
    name: 'Fiona Server',
    role: 'server',
    email: 'fiona@test.local',
  };
  const chef = { id: 'chef-1', name: 'George Chef', role: 'chef', email: 'george@test.local' };

  // Mgr A: active, manager, has PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(mgrA.id, mgrA.name, mgrA.email, passwordHash, mgrA.role, pinHashA, now(), now());

  // Mgr B: active, manager, has PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(mgrB.id, mgrB.name, mgrB.email, passwordHash, mgrB.role, pinHashB, now(), now());

  // Mgr NoPin: active, manager, NO PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(mgrNoPin.id, mgrNoPin.name, mgrNoPin.email, passwordHash, mgrNoPin.role, now(), now());

  // Mgr Inactive: inactive, manager, has PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    mgrInactive.id,
    mgrInactive.name,
    mgrInactive.email,
    passwordHash,
    mgrInactive.role,
    pinHashA,
    now(),
    now(),
  );

  // Cashier: active, cashier
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(cashier.id, cashier.name, cashier.email, passwordHash, cashier.role, now(), now());

  // Server: active, server
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(
    serverUser.id,
    serverUser.name,
    serverUser.email,
    passwordHash,
    serverUser.role,
    now(),
    now(),
  );

  // Chef: active, chef with PIN
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(chef.id, chef.name, chef.email, passwordHash, chef.role, pinHashA, now(), now());

  const app = createApp({
    '/api/staff': staffRoutes,
  });

  const { baseUrl, server } = await startServer(app);

  const cashierAuth = makeAuthHeader(cashier);
  const serverAuth = makeAuthHeader(serverUser);

  try {
    // ── 1. Cashier cannot access full staff directory (/api/staff) ──
    console.log('\n── Subtest 1: Cashier without staff.view is denied on GET /api/staff ──');
    {
      const res = await api(baseUrl, '/api/staff?active=true', {
        method: 'GET',
        headers: cashierAuth,
      });
      assertEqualOrThrow(res.status, 403, 'GET /api/staff returns 403 for cashier');
      assertEqualOrThrow(res.data?.code, 'permission_denied', 'permission_denied code returned');
    }

    // ── 2. Cashier can access minimal approvers list (/api/staff/approvers) ──
    console.log('\n── Subtest 2: Cashier can access GET /api/staff/approvers ──');
    {
      const res = await api(baseUrl, '/api/staff/approvers', {
        method: 'GET',
        headers: cashierAuth,
      });
      assertEqualOrThrow(res.status, 200, 'GET /api/staff/approvers returns 200 for cashier');

      const approvers = res.data?.approvers;
      assertOrThrow(Array.isArray(approvers), 'Response has approvers array');
      // Also confirm backward/forward compatible staff key
      assertOrThrow(Array.isArray(res.data?.staff), 'Response has staff alias array');

      // Must include only active owners and managers with configured PINs
      const approverIds = approvers.map((a: any) => a.id);
      assertOrThrow(approverIds.includes(mgrA.id), 'Includes active Manager A with PIN');
      assertOrThrow(approverIds.includes(mgrB.id), 'Includes active Manager B with PIN');
      assertOrThrow(!approverIds.includes(mgrNoPin.id), 'Excludes Manager without PIN');
      assertOrThrow(!approverIds.includes(mgrInactive.id), 'Excludes inactive Manager');
      assertOrThrow(!approverIds.includes(cashier.id), 'Excludes Cashier');
      assertOrThrow(!approverIds.includes(serverUser.id), 'Excludes Server');
      assertOrThrow(!approverIds.includes(chef.id), 'Excludes Chef');

      // Verify minimal projection: only id, name, role, is_active, has_pin
      const first = approvers[0];
      const keys = Object.keys(first).sort();
      const expectedKeys = ['has_pin', 'id', 'is_active', 'name', 'role'].sort();
      assertEqualOrThrow(
        JSON.stringify(keys),
        JSON.stringify(expectedKeys),
        'Approver object contains only {id, name, role, is_active, has_pin}',
      );
      assertOrThrow(first.has_pin === 1, 'has_pin is 1');
      assertOrThrow(first.pin_hash === undefined, 'pin_hash is strictly omitted');
      assertOrThrow(first.email === undefined, 'email is strictly omitted');
      assertOrThrow(first.password === undefined, 'password is strictly omitted');
    }

    // ── 3. Server can access /api/staff/approvers ──
    console.log('\n── Subtest 3: Server role can access GET /api/staff/approvers ──');
    {
      const res = await api(baseUrl, '/api/staff/approvers', {
        method: 'GET',
        headers: serverAuth,
      });
      assertEqualOrThrow(res.status, 200, 'GET /api/staff/approvers returns 200 for server');
    }

    // ── 4. Unauthenticated request to /api/staff/approvers returns 401 ──
    console.log('\n── Subtest 4: Unauthenticated request returns 401 ──');
    {
      const res = await api(baseUrl, '/api/staff/approvers', {
        method: 'GET',
      });
      assertEqualOrThrow(res.status, 401, 'Unauthenticated request returns 401');
    }

    console.log('✓ All staff approvers directory tests passed!');
  } finally {
    server.close();
    closeDatabase(db);
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
