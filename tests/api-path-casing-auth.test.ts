/**
 * Regression coverage for the case-variant API path authentication bypass.
 *
 * Express 5 matches routes case-insensitively ("case sensitive routing" is off
 * by default and this app never enables it), so `GET /API/pos-info` reaches the
 * same handler as `GET /api/pos-info`. Both guards that decide whether a
 * request needs a credential used to classify the path with case-sensitive
 * string comparisons, so a case-variant spelling of a protected path skipped
 * `requireAuth` and the database-maintenance guard while still routing to the
 * protected handler behind them.
 *
 * These are request-level assertions against the real middleware, the real
 * router, and real HTTP paths. Asserting on the source text of the comparison
 * would still pass against a router that stopped matching case-insensitively.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/api-path-casing-auth.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-api-path-casing-'));
Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedOwnerUser,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { requireAuth } = require('../main/server');
const { posInfoRoutes } = require('../main/routes/pos-info');
const { databaseMaintenanceMiddleware, withDatabaseMaintenanceLock } = require('../main/db');

/** Case variants of a protected path. Every spelling must reach requireAuth. */
const PROTECTED_VARIANTS = [
  '/API/pos-info',
  '/Api/pos-info',
  '/aPi/pos-info',
  '/API/POS-INFO',
  '/api/POS-INFO',
];

/** Builds the production middleware chain: maintenance guard, then requireAuth. */
function buildProtectedApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', databaseMaintenanceMiddleware);
  app.use(requireAuth);
  app.get('/api/health', (_req: any, res: any) => res.json({ status: 'ok' }));
  app.use('/api/pos-info', posInfoRoutes);
  app.use((_req: any, res: any) => res.status(404).json({ error: 'Not found' }));
  return app;
}

async function testRequireAuth() {
  const app = buildProtectedApp();
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  console.log('\n─── requireAuth gates case variants of a protected path ───');
  const canonical = await request(app).get('/api/pos-info');
  assertEqualOrThrow(canonical.status, 401, 'lowercase /api/pos-info without a token is 401 (control)');

  for (const variant of PROTECTED_VARIANTS) {
    const res = await request(app).get(variant);
    assertEqualOrThrow(res.status, 401, `${variant} without a token is 401`);
    assertEqualOrThrow(res.body?.error, 'Authentication required', `${variant} is rejected by requireAuth`);
    assertOrThrow(
      res.body?.mdns_url === undefined && res.body?.ip_url === undefined,
      `${variant} discloses no network topology`,
    );
  }

  console.log('\n─── Intentionally public handlers stay public in any casing ───');
  // Routing is case-insensitive too, so a public path reached through a
  // case variant was already served; gating it now must not change that.
  for (const variant of ['/API/health', '/Api/health']) {
    const res = await request(app).get(variant);
    assertEqualOrThrow(res.status, 200, `${variant} remains reachable without a token`);
  }

  console.log('\n─── Case-variant clients that do authenticate still work ───');
  for (const variant of ['/api/pos-info', '/API/pos-info', '/aPi/pos-info']) {
    const res = await request(app).get(variant).set(authHeader);
    assertEqualOrThrow(res.status, 200, `${variant} with a valid token is 200`);
  }

  closeDatabase();
}

async function testDatabaseMaintenanceGuard() {
  const app = express();
  app.use(express.json());
  app.use('/api', databaseMaintenanceMiddleware);
  app.post('/api/db/import', (_req: any, res: any) => res.json({ imported: true }));
  app.use((_req: any, res: any) => res.status(404).json({ error: 'Not found' }));

  console.log('\n─── Maintenance window is honoured for case-variant paths ───');
  const before = await request(app).post('/api/db/import');
  assertEqualOrThrow(before.status, 200, 'lowercase /api/db/import runs outside a maintenance window');

  let releaseWindow: () => void = () => {};
  const windowOpen = new Promise<void>((resolve) => { releaseWindow = resolve; });
  const holding = withDatabaseMaintenanceLock(async () => { await windowOpen; });

  try {
    // Let the lock reach the "active" state before probing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const canonical = await request(app).post('/api/db/import');
    assertEqualOrThrow(canonical.status, 503, 'lowercase /api/db/import is 503 during a maintenance window');

    for (const variant of ['/API/db/import', '/Api/db/import', '/API/DB/IMPORT']) {
      const res = await request(app).post(variant);
      assertEqualOrThrow(res.status, 503, `${variant} is 503 during a maintenance window`);
    }
  } finally {
    releaseWindow();
    await holding.catch(() => { /* released normally */ });
  }

  const after = await request(app).post('/api/db/import');
  assertEqualOrThrow(after.status, 200, 'lowercase /api/db/import runs again once the maintenance window closes');
}

async function run() {
  console.log('API Path Casing Authentication Tests');
  console.log('='.repeat(60));

  try {
    await testRequireAuth();
    await testDatabaseMaintenanceGuard();
    console.log('\n✅ Case-variant API paths are gated identically to canonical ones.');
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { }
  }
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
