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
  for (const [key, value] of [
    ['country', 'TH'],
    ['currency', 'THB'],
    ['billing_type', 'prepaid'],
    ['business_type', 'restaurant'],
    ['tables_required', 'false'],
    // Tax defaults off (migration 40) until explicitly enabled — this fixture's
    // product carries a real tax_category_id expecting real VAT, so it must
    // turn taxes on itself rather than rely on a global default. No
    // country_packs row is seeded either; getActiveCountryPack's bundled-JSON
    // fallback (main/services/tax.ts) is the documented behavior for exactly
    // this case and supplies Thailand's standard 7% VAT category.
    ['taxes_enabled', 'true'],
  ]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, createdAt);
  }
  db.prepare(
    'INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
  ).run('e2e-category', 'E2E Menu', 1, createdAt, createdAt);
  db.prepare(
    `INSERT INTO products (
       id, category_id, name, price, tax_type, tax_category_id, tax_behavior,
       cb_percent, track_inventory, stock_quantity, is_active, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    'e2e-product', 'e2e-category', 'E2E Coffee', 60, 'none', 'standard', 'exclusive',
    0, 0, 999, 1, createdAt, createdAt,
  );
}

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  let cleanupFailed = false;
  try { stopServer(); } catch (error) {
    cleanupFailed = true;
    console.error('[E2E] Main server cleanup failed:', error);
  }
  try { stopKdsServer(); } catch (error) {
    cleanupFailed = true;
    console.error('[E2E] KDS server cleanup failed:', error);
  }
  try { closeDatabase(); } catch (error) {
    cleanupFailed = true;
    console.error('[E2E] Database cleanup failed:', error);
  }
  Module._load = originalLoad;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (error) {
    cleanupFailed = true;
    console.error('[E2E] Fixture cleanup failed:', error);
  }
  process.exit(cleanupFailed ? 1 : exitCode);
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
