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

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { initDatabase, getDatabase, closeDatabase, beginDatabaseShutdown, waitForDatabaseRequests, now } = require('../dist/db');
const { createExitCodeAwareShutdown, waitForHttpShutdownWork, isShutdownTimeout } = require('../dist/shutdown');
const { startServer, stopServer } = require('../dist/server');
const { shutdown: shutdownWhatsApp, requestShutdown: requestWhatsAppShutdown } = require('../dist/services/whatsapp');
const { startStandaloneServers } = require('../dist/standalone-startup');
const flatRatePackData = require('./fixtures/synthetic-flat-rate-pack.json');
// Country/currency stay TH/THB (this fixture's configured business country)
// so getActiveCountryPack('TH') actually resolves this pack.
const testTaxPack = { ...flatRatePackData, id: 'test-th-pack', country: 'TH', currency: 'THB', publisher: 'FreeOpenSourcePOS' };

// BUNDLED_COUNTRY_PACKS (main/tax-packs/bundled.ts) only ships the generic
// pack — real country packs (e.g. Thailand, India) are separately-published
// "official" packs that must be explicitly installed and activated, same as
// production's real activation route (main/routes/tax-packs.ts) and the Node
// test suite's installAndActivateTestTaxPack (tests/helpers/test-setup.ts).
// Without this, getActiveCountryPack('TH') matches the generic pack's '*'
// wildcard row before ever falling back to bundled data, and this fixture's
// 'standard' category resolves to nothing — checkout fails with "no tax
// rules apply to category standard for business type restaurant" instead of
// computing tax.
function installAndActivateTaxPack(db, pack) {
  const installedAt = now();
  const versionId = `${pack.id}@${pack.version}`;
  const packJson = JSON.stringify(pack);
  const digest = crypto.createHash('sha256').update(packJson).digest('hex');

  db.prepare(`
    INSERT INTO country_packs (
      id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      publisher = excluded.publisher,
      country = excluded.country,
      jurisdiction = excluded.jurisdiction,
      active_version_id = excluded.active_version_id,
      status = 'active',
      updated_at = excluded.updated_at
  `).run(pack.id, pack.publisher, pack.country, pack.jurisdiction, versionId, installedAt, installedAt);

  db.prepare(`
    INSERT OR REPLACE INTO country_pack_versions (
      id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
      effective_from, effective_to, min_flo_version, published_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
  `).run(
    versionId, pack.id, pack.version, pack.schemaVersion,
    JSON.stringify({
      id: pack.id, publisher: pack.publisher, country: pack.country,
      jurisdiction: pack.jurisdiction, version: pack.version, publishedAt: pack.publishedAt,
    }),
    packJson, digest, pack.effectiveFrom, pack.effectiveTo || null, pack.minFloVersion,
    pack.publishedAt, installedAt,
  );

  const insertCategory = db.prepare(`
    INSERT OR REPLACE INTO tax_categories (
      id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const category of pack.categories) {
    insertCategory.run(
      `${versionId}:category:${category.id}`, versionId, category.id, category.label,
      category.defaultBehavior || null, JSON.stringify(category), installedAt,
    );
  }

  const insertRule = db.prepare(`
    INSERT OR REPLACE INTO tax_rules (
      id, pack_version_id, rule_id, label, calculation_type, rate, amount,
      applies_per, base_rule_ids, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of pack.rules) {
    insertRule.run(
      `${versionId}:rule:${rule.id}`, versionId, rule.id, rule.label, rule.type,
      rule.rate || null, rule.amount || null, rule.appliesPer || null,
      JSON.stringify(rule.baseRuleIds || []), JSON.stringify(rule), installedAt,
    );
  }
}
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
    // product carries a real tax_category_id expecting real tax, so it must
    // turn taxes on itself rather than rely on a global default.
    ['taxes_enabled', 'true'],
  ]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, createdAt);
  }
  installAndActivateTaxPack(db, testTaxPack);
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

let exitRequested = false;
let shutdownRequested = false;
const requestStop = createExitCodeAwareShutdown(async () => {
  let cleanupFailed = false;
  let databaseBlocked = false;
  try { await stopServer(); } catch (error) {
    cleanupFailed = true;
    databaseBlocked = true;
    console.error('[E2E] Main server cleanup failed:', error);
    if (isShutdownTimeout(error)) throw error;
  }
  try { await stopKdsServer(); } catch (error) {
    cleanupFailed = true;
    databaseBlocked = true;
    console.error('[E2E] KDS server cleanup failed:', error);
    if (isShutdownTimeout(error)) throw error;
  }
  try { await shutdownWhatsApp(); } catch (error) {
    cleanupFailed = true;
    databaseBlocked = true;
    console.error('[E2E] WhatsApp cleanup failed:', error);
    if (isShutdownTimeout(error)) throw error;
  }
  try { await waitForHttpShutdownWork(); } catch (error) {
    cleanupFailed = true;
    databaseBlocked = true;
    console.error('[E2E] HTTP handler cleanup failed:', error);
    if (isShutdownTimeout(error)) throw error;
  }
  try { beginDatabaseShutdown(); await waitForDatabaseRequests(); } catch (error) {
    cleanupFailed = true;
    databaseBlocked = true;
    console.error('[E2E] Database request drain failed:', error);
    if (isShutdownTimeout(error)) throw error;
  }
  if (!databaseBlocked) {
    try { closeDatabase(); } catch (error) {
      cleanupFailed = true;
      console.error('[E2E] Database cleanup failed:', error);
    }
  }
  Module._load = originalLoad;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (error) {
    cleanupFailed = true;
    console.error('[E2E] Fixture cleanup failed:', error);
  }
  return cleanupFailed ? 1 : 0;
}, {
  onShutdownRequested: requestWhatsAppShutdown,
  onFatalTimeout: () => process.exit(1),
});

async function stop(exitCode = 0) {
  shutdownRequested = true;
  const finalExitCode = await requestStop(exitCode);
  if (!exitRequested) {
    exitRequested = true;
    process.exit(finalExitCode);
  }
}

(async () => {
  await startStandaloneServers({
    initializeDatabase: initDatabase,
    prepare: () => {
      seedUser('e2e-manager', 'manager@flo.local', 'manager');
      seedPosFixture();
    },
    startServer,
    startKdsServer,
    isShutdownRequested: () => shutdownRequested,
  });
  console.log('[E2E] Main and KDS servers ready');
})().catch((error) => {
  console.error(error);
  stop(1);
});

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
