/**
 * Database maintenance allowlist cannot drift from the routes that exist.
 *
 * main/db.ts holds five hardcoded "<METHOD> /api/..." strings so the handlers
 * that take the maintenance lock are not counted in activeDatabaseRequests.
 * A route renamed out of that list is no longer excluded, so its own request
 * keeps the drain waiting on itself until MAINTENANCE_DRAIN_TIMEOUT_MS - a
 * self-deadlock, not an authorization gap. This test fails the moment a
 * string stops matching a registered route, or when a handler leaves the
 * allowlist while staying registered.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/database-maintenance-allowlist.test.ts
 */

import * as assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flo-db-maint-allowlist-'));
Module._load = function (request_: string, parent: unknown, isMain: boolean) {
  if (request_ === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { registerRoutes } = require('../main/routes/index');

// The handlers that take the database maintenance lock. Declared here
// independently of the allowlist so deleting an entry from
// DATABASE_MAINTENANCE_ROUTES while leaving the handler registered fails the
// test. Deriving the expectation from the set under test would make such a
// deletion pass by probing only whatever survived.
const EXPECTED_MAINTENANCE_HANDLERS = [
  'POST /api/db/import',
  'POST /api/db/backup',
  'GET /api/db/download',
  'POST /api/db-tools/initialize',
  'POST /api/db-tools/currency-reset',
];

function readAllowlistedRoutes(): string[] {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'db.ts'), 'utf8');
  const block = source.match(/DATABASE_MAINTENANCE_ROUTES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'DATABASE_MAINTENANCE_ROUTES is still a Set literal in main/db.ts');
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

async function run() {
  const allowlisted = readAllowlistedRoutes();
  assert.ok(allowlisted.length > 0, 'the maintenance allowlist is not empty');
  assert.deepEqual(
    [...allowlisted].sort(),
    [...EXPECTED_MAINTENANCE_HANDLERS].sort(),
    'the maintenance allowlist still holds exactly the five handlers that take the lock',
  );

  const app = express();
  app.use(express.json());
  registerRoutes(app);

  assert.equal(
    (await request(app).post('/api/db/definitely-not-a-route').send({})).status,
    404,
    'an unregistered route still reports 404, so the probe below discriminates',
  );

  for (const entry of allowlisted) {
    const [method, routePath] = entry.split(' ');
    const response = await request(app)[method.toLowerCase()](routePath).send({});
    assert.notEqual(
      response.status,
      404,
      `${entry} is allowlisted for maintenance but no route is registered for it`,
    );
  }

  console.log(`Maintenance allowlist verified: ${allowlisted.length} routes still registered.`);
}

// process.exitCode rather than process.exit: an immediate exit would skip the
// cleanup below and leak a temp directory on every run.
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
