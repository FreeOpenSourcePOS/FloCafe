/* Test-only dual-server bootstrap for Playwright. Keeps fixture data out of dev-server.js. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-'));
process.env.JWT_SECRET = 'e2e-test-secret';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'e2e' } };
  }
  return originalLoad.apply(this, arguments);
};

const bcrypt = require('bcryptjs');
const { initDatabase, getDatabase, closeDatabase, now } = require('../dist/db');
const { startServer, stopServer } = require('../dist/server');
const { startKdsServer, stopKdsServer } = require('../dist/kds-server');

function seedUser(id, email, role) {
  getDatabase().prepare(
    'INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(id, `E2E ${role}`, email, bcrypt.hashSync('E2ePass123!', 10), role, now(), now());
}

function seedPosFixture() {
  const db = getDatabase();
  const createdAt = now();
  db.prepare(
    'INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
  ).run('e2e-category', 'E2E Menu', 1, createdAt, createdAt);
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, tax_type, cb_percent, track_inventory, stock_quantity, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run('e2e-product', 'e2e-category', 'E2E Coffee', 100, 'gst', 0, 0, 999, 1, createdAt, createdAt);
}

async function stop(exitCode = 0) {
  stopServer();
  stopKdsServer();
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(exitCode);
}

(async () => {
  initDatabase();
  seedUser('e2e-manager', 'manager@flo.local', 'manager');
  seedPosFixture();
  await startServer();
  await startKdsServer();
  console.log('[E2E] Main and KDS servers ready');
})().catch((error) => {
  console.error(error);
  stop(1);
});

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
