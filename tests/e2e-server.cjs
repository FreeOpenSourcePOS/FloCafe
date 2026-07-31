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
const crypto = require('crypto');
const { initDatabase, getDatabase, closeDatabase, now } = require('../dist/db');
const { startServer, stopServer } = require('../dist/server');
const { startKdsServer, stopKdsServer } = require('../dist/kds-server');

function seedUser(id, email, role) {
  getDatabase().prepare(
    'INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(id, `E2E ${role}`, email, bcrypt.hashSync('E2ePass123!', 10), role, now(), now());
}

// After commit 3a75876 ("publish country packs separately"), only the generic
// pack auto-installs on first-run; country packs come from the signed catalog
// after an owner opt-in. The e2e fixture seeds country=TH but never goes
// through that owner action, so it has no active TH pack and the checkout
// throws "no tax rules apply". Mirror the production owner-install action by
// registering the TH pack directly. This is the same SQL helper that the
// unit/integration tests use, just inlined here because e2e-server runs from
// compiled dist/ and cannot import the .ts test helpers.
function installTaxPackFixture(pack) {
  const db = getDatabase();
  const installedAt = now();
  const versionId = `${pack.id}@${pack.version}`;
  const packJson = JSON.stringify(pack);
  const digest = crypto.createHash('sha256').update(packJson).digest('hex');

  db.transaction(() => {
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
      packJson, digest,
      pack.effectiveFrom, pack.effectiveTo || null, pack.minFloVersion, pack.publishedAt,
      installedAt,
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
  })();
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
  installTaxPackFixture(require('../main/tax-packs/th.json'));
  await startServer();
  await startKdsServer();
  console.log('[E2E] Main and KDS servers ready');
})().catch((error) => {
  console.error(error);
  stop(1);
});

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
