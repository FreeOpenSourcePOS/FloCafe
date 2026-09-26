/** Owner-only configurable authorization API coverage. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-authorization-api-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { authorizationRoutes } = require('../main/routes/authorization');
const { requireAnyPermission, requirePermission } = require('../main/services/authorization');
const { requireAuth } = require('../main/server');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, 'unused-test-hash', role, now(), now());
  return { 'x-test-user': id };
}

async function main(): Promise<void> {
  initDatabase();
  const db = getDatabase();
  const owner = seedUser(db, 'authorization-owner', 'owner');
  const manager = seedUser(db, 'authorization-manager', 'manager');
  const cashier = seedUser(db, 'authorization-cashier', 'cashier');
  const server = seedUser(db, 'authorization-server', 'server');
  const chef = seedUser(db, 'authorization-chef', 'chef');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const userId = req.header('x-test-user');
    if (userId) req.user = { userId };
    next();
  });
  app.use('/api/authorization', authorizationRoutes);
  app.get('/api/protected-report', requirePermission('reports.view'), (_req: any, res: any) => res.json({ ok: true }));
  // Mirrors the real tax preview gate in main/routes/index.ts.
  app.post('/api/tax/preview', requireAnyPermission('pos.use', 'orders.create', 'kitchen.use'), (_req: any, res: any) => res.json({ ok: true }));
  app.post('/api/bills/:id/markPrinted', requirePermission('bills.print'), (_req: any, res: any) => res.json({ ok: true }));
  app.post('/api/bills/:id/applyDiscount', requirePermission('bills.discount.apply'), (_req: any, res: any) => res.json({ ok: true }));

  assert.equal((await request(app).get('/api/authorization/catalog')).status, 401);
  assert.equal((await request(app).get('/api/authorization/catalog').set(manager)).status, 403);

  const catalog = await request(app).get('/api/authorization/catalog').set(owner);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.permissions.some((entry: any) => entry.id === 'reports.view'));
  assert.ok(catalog.body.permissions.some((entry: any) => entry.id === 'authorization.manage' && entry.configurable === false));

  const roles = await request(app).get('/api/authorization/roles').set(owner);
  assert.equal(roles.status, 200);
  const managerRole = roles.body.roles.find((entry: any) => entry.role === 'manager');
  assert.ok(managerRole.revision);
  assert.equal(managerRole.permissions.find((entry: any) => entry.permission_id === 'reports.view').allowed, true);

  const invalid = await request(app).put('/api/authorization/roles/manager').set(owner).send({
    revision: managerRole.revision,
    overrides: [{ permission_id: 'authorization.manage', effect: 'allow' }],
  });
  assert.equal(invalid.status, 400, 'protected permission override is rejected');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM role_permission_overrides WHERE role = 'manager'").get().count, 0);

  const updated = await request(app).put('/api/authorization/roles/manager').set(owner).send({
    revision: managerRole.revision,
    overrides: [{ permission_id: 'reports.view', effect: 'deny' }],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.role.permissions.find((entry: any) => entry.permission_id === 'reports.view').allowed, false);
  assert.equal((await request(app).get('/api/protected-report').set(manager)).status, 403, 'role deny applies on the next request');

  const conflict = await request(app).put('/api/authorization/roles/manager').set(owner).send({
    revision: managerRole.revision,
    overrides: [],
  });
  assert.equal(conflict.status, 409, 'stale role edit is rejected');
  assert.equal(conflict.body.code, 'revision_conflict');

  const user = await request(app).get('/api/authorization/users/authorization-cashier').set(owner);
  assert.equal(user.status, 200);
  assert.equal(user.body.permissions.find((entry: any) => entry.permission_id === 'reports.view').allowed, false);

  const userUpdated = await request(app).put('/api/authorization/users/authorization-cashier').set(owner).send({
    revision: user.body.revision,
    overrides: [{ permission_id: 'reports.view', effect: 'allow' }],
  });
  assert.equal(userUpdated.status, 200);
  assert.equal(userUpdated.body.permissions.find((entry: any) => entry.permission_id === 'reports.view').allowed, true);
  assert.equal(userUpdated.body.permissions.find((entry: any) => entry.permission_id === 'reports.view').source, 'user_override');
  assert.equal((await request(app).get('/api/protected-report').set({ 'x-test-user': 'authorization-cashier' })).status, 200, 'user allow applies on the next request');

  const staleReset = await request(app)
    .delete('/api/authorization/users/authorization-cashier/overrides')
    .set(owner)
    .send({ revision: user.body.revision });
  assert.equal(staleReset.status, 409, 'stale user reset is rejected');

  const reset = await request(app)
    .delete('/api/authorization/users/authorization-cashier/overrides')
    .set(owner)
    .send({ revision: userUpdated.body.revision });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.overrides.length, 0);
  assert.equal(reset.body.permissions.find((entry: any) => entry.permission_id === 'reports.view').allowed, false);
  assert.equal((await request(app).get('/api/protected-report').set({ 'x-test-user': 'authorization-cashier' })).status, 403, 'reset applies on the next request');

  const audit = await request(app).get('/api/authorization/audit').set(owner);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.audit.length >= 3);
  assert.ok(audit.body.audit.every((entry: any) => entry.actor_user_id === 'authorization-owner'));
  assert.ok(audit.body.audit.some((entry: any) => entry.target_type === 'role' && entry.target_id === 'manager'));
  assert.ok(audit.body.audit.some((entry: any) => entry.target_type === 'user' && entry.target_id === 'authorization-cashier'));

  // requireAnyPermission admits any one of its permissions, and the tax preview
  // gate it serves has to keep every role pricing a basket.
  assert.equal((await request(app).post('/api/tax/preview')).status, 401, 'no user means no basket pricing');
  for (const [role, header] of [['owner', owner], ['manager', manager], ['cashier', cashier], ['server', server], ['chef', chef]] as const) {
    assert.equal(
      (await request(app).post('/api/tax/preview').set(header)).status,
      200,
      `${role} can price a basket`,
    );
  }

  // markPrinted is gated on bills.print, not on the discount endpoint above it.
  assert.equal((await request(app).post('/api/bills/1/markPrinted').set(cashier)).status, 403, 'cashier cannot mark a bill printed');
  assert.equal((await request(app).post('/api/bills/1/markPrinted').set(server)).status, 403, 'server cannot mark a bill printed');
  assert.equal((await request(app).post('/api/bills/1/markPrinted').set(manager)).status, 200, 'manager can mark a bill printed');
  assert.equal((await request(app).post('/api/bills/1/markPrinted').set(owner)).status, 200, 'owner can mark a bill printed');
  assert.equal((await request(app).post('/api/bills/1/applyDiscount').set(manager)).status, 200, 'manager can still apply a bill discount');

  // Denying one of the three sale permissions must not close basket pricing
  // while the caller still holds either of the other two.
  db.prepare(`
    INSERT INTO role_permission_overrides
      (role, permission_id, effect, updated_by, created_at, updated_at)
    VALUES ('cashier', 'pos.use', 'deny', ?, ?, ?)
  `).run('authorization-owner', now(), now());
  assert.equal((await request(app).post('/api/tax/preview').set(cashier)).status, 200, 'a cashier denied pos.use still prices a basket through orders.create');
  db.prepare(`
    INSERT INTO user_permission_overrides
      (user_id, permission_id, effect, updated_by, created_at, updated_at)
    VALUES ('authorization-cashier', 'orders.create', 'deny', ?, ?, ?)
  `).run('authorization-owner', now(), now());
  assert.equal((await request(app).post('/api/tax/preview').set(cashier)).status, 403, 'a cashier denied both pos.use and orders.create loses basket pricing');

  // The real requireAuth exempted anything whose path started with '/api/auth',
  // which also matched '/api/authorization/*' because "authorization" starts
  // with "auth". That skipped token verification for the whole management API,
  // so prove a tokenless request is actually rejected through the production
  // middleware and not merely through the router's own permission gate.
  const jwt = require('jsonwebtoken');
  const expressRateLimit = require('express-rate-limit');
  const { getJWTSecret } = require('../main/routes/auth');
  const realApp = express();
  realApp.use(express.json());
  // Same order as main/server.ts: rate limit, then requireAuth, then routes.
  realApp.use('/api', expressRateLimit({ windowMs: 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));
  realApp.use(requireAuth);
  realApp.use('/api/authorization', authorizationRoutes);

  const tokenFor = (userId: string, role: string, secret = getJWTSecret()) =>
    `Bearer ${jwt.sign({ userId, email: `${userId}@test.local`, role }, secret, { expiresIn: '1h' })}`;

  assert.equal((await request(realApp).get('/api/authorization/catalog')).status, 401, 'no token cannot reach the authorization API');
  // 404 rather than 401 is the proof the exemption still holds: the request got
  // past requireAuth and all the way to routing, where nothing is mounted. No
  // route is registered here on purpose, so nothing shadows the 401.
  assert.equal((await request(realApp).get('/api/auth/login')).status, 404, 'the /api/auth exemption lets login reach routing so it can verify its own token');
  assert.equal((await request(realApp).get('/api/authorization/catalog').set('Authorization', 'Bearer not-a-jwt')).status, 401, 'a malformed token cannot reach the authorization API');
  assert.equal(
    (await request(realApp).get('/api/authorization/catalog').set('Authorization', tokenFor('authorization-owner', 'owner', 'a-different-secret'))).status,
    401,
    'a token signed with the wrong secret cannot reach the authorization API',
  );
  assert.equal(
    (await request(realApp).get('/api/authorization/catalog').set('Authorization', tokenFor('authorization-manager', 'manager'))).status,
    403,
    'a real manager token reaches the route and is refused by its own permission gate, not by the path exemption',
  );
  assert.equal(
    (await request(realApp).get('/api/authorization/catalog').set('Authorization', tokenFor('authorization-owner', 'owner'))).status,
    200,
    'an owner token reaches the catalog',
  );

  console.log('Authorization management API tests passed');
}

main()
  .finally(() => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
