/**
 * Regression coverage for issue #145 staff-management authorization and PIN policy.
 * Run: npm run test:staff-authz
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-staff-authz-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { staffRoutes } = require('../main/routes/staff');
const { getJWTSecret } = require('../main/routes/auth');

function seedUser(db: any, id: string, role: string, pin = '1234') {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    id,
    email,
    bcrypt.hashSync('Testpass1', 10),
    role,
    pin ? bcrypt.hashSync(pin, 10) : null,
    now(),
    now(),
  );

  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  console.log('Staff Authorization Regression Tests (#145)');
  console.log('='.repeat(60));

  const db = initTestDb();
  const ownerAuth = seedUser(db, 'owner-145', 'owner');
  const managerAuth = seedUser(db, 'manager-145', 'manager');
  seedUser(db, 'manager-target-145', 'manager');
  seedUser(db, 'cashier-target-145', 'cashier', '');
  seedUser(db, 'waiter-target-145', 'waiter', '');
  seedUser(db, 'chef-target-145', 'chef', '');

  const app = createApp({ '/api/staff': staffRoutes });

  console.log('\n── Manager boundaries ─────────────────────────────────────────');
  let result = await request(app).put('/api/staff/owner-145').set(managerAuth).send({
    name: 'Compromised owner', password: 'ChangedPass1',
  });
  assertEqual(result.status, 403, 'manager cannot edit owner details or password');

  result = await request(app).put('/api/staff/manager-target-145').set(managerAuth).send({
    name: 'Compromised manager', password: 'ChangedPass1',
  });
  assertEqual(result.status, 403, 'manager cannot edit another manager details or password');

  for (const target of ['owner-145', 'manager-target-145']) {
    result = await request(app).post(`/api/staff/${target}/deactivate`).set(managerAuth);
    assertEqual(result.status, 403, `manager cannot deactivate ${target}`);

    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(target);
    result = await request(app).post(`/api/staff/${target}/reactivate`).set(managerAuth);
    assertEqual(result.status, 403, `manager cannot reactivate ${target}`);
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(target);
  }

  result = await request(app).put('/api/staff/cashier-target-145').set(managerAuth).send({ is_active: false });
  assertEqual(result.status, 400, 'PUT cannot change is_active');

  for (const role of ['owner', 'manager']) {
    result = await request(app).post('/api/staff').set(managerAuth).send({
      name: `Forbidden ${role}`, email: `forbidden-${role}@test.local`, password: 'StrongPass1', role,
    });
    assertEqual(result.status, 403, `manager cannot create ${role}`);
  }

  console.log('\n── Manager operational-staff access ───────────────────────────');
  const managerCreated: Record<string, string> = {};
  for (const role of ['cashier', 'waiter', 'chef']) {
    result = await request(app).post('/api/staff').set(managerAuth).send({
      name: `Managed ${role}`, email: `managed-${role}@test.local`, password: 'StrongPass1', role,
    });
    assertEqual(result.status, 201, `manager can create ${role}`);
    managerCreated[role] = result.body.staff?.id;
    assert(!('pin_hash' in result.body.staff), `create ${role} response does not expose pin_hash`);
  }

  for (const role of ['cashier', 'waiter', 'chef']) {
    result = await request(app).put(`/api/staff/${managerCreated[role]}`).set(managerAuth).send({
      name: `Updated ${role}`, role,
    });
    assertEqual(result.status, 200, `manager can edit ${role}`);
  }

  result = await request(app).post('/api/staff').set(managerAuth).send({
    name: 'Pinned cashier', email: 'pinned-cashier@test.local', password: 'StrongPass1', role: 'cashier', pin: '1234',
  });
  assertEqual(result.status, 400, 'operational roles reject a non-empty PIN');

  console.log('\n── PIN policy ─────────────────────────────────────────────────');
  for (const pin of ['abcd', '123', '1234567']) {
    result = await request(app).post('/api/staff').set(ownerAuth).send({
      name: `Bad PIN ${pin}`, email: `bad-pin-${pin}@test.local`, password: 'StrongPass1', role: 'manager', pin,
    });
    assertEqual(result.status, 400, `PIN ${pin} is rejected unless it is 4-6 numeric digits`);
  }

  result = await request(app).put('/api/staff/manager-target-145').set(ownerAuth).send({ role: 'waiter' });
  assertEqual(result.status, 200, 'owner can demote a manager to waiter');
  assertEqual(result.body.staff.has_pin, 0, 'demoting to an operational role clears has_pin');
  const demoted = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get('manager-target-145') as any;
  assertEqual(demoted.pin_hash, null, 'demoting to an operational role clears pin_hash');

  const originalPinHash = (db.prepare('SELECT pin_hash FROM users WHERE id = ?').get('manager-145') as any).pin_hash;
  result = await request(app).put('/api/staff/manager-145').set(ownerAuth).send({ name: 'Manager PIN preserved' });
  assertEqual(result.status, 200, 'owner can update a manager without supplying a PIN');
  assertEqual(result.body.staff.has_pin, 1, 'omitting PIN preserves has_pin');
  const preserved = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get('manager-145') as any;
  assertEqual(preserved.pin_hash, originalPinHash, 'omitting PIN preserves the PIN hash');

  result = await request(app).post('/api/staff/owner-145/deactivate').set(ownerAuth);
  assertEqual(result.status, 400, 'cannot deactivate the last active owner');

  console.log('\n── Owner full access ───────────────────────────────────────────');
  result = await request(app).post('/api/staff').set(ownerAuth).send({
    name: 'Owner-created manager', email: 'owner-created-manager@test.local', password: 'StrongPass1', role: 'manager', pin: '9876',
  });
  assertEqual(result.status, 201, 'owner can create a manager with a valid PIN');
  assertEqual(result.body.staff.has_pin, 1, 'staff responses expose has_pin for configured PINs');

  result = await request(app).post('/api/staff/cashier-target-145/deactivate').set(ownerAuth);
  assertEqual(result.status, 200, 'owner can deactivate operational staff');
  result = await request(app).post('/api/staff/cashier-target-145/reactivate').set(ownerAuth);
  assertEqual(result.status, 200, 'owner can reactivate operational staff');

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed`);
  if (results.failed > 0) {
    throw new Error(`${results.failed} staff authorization assertion(s) failed`);
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\nStaff authorization tests passed');
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
