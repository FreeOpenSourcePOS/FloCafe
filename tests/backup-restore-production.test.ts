import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-production-restore-'));

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

import Database from 'better-sqlite3';
import {
  closeDatabase,
  createBackup,
  getCurrentSchemaVersion,
  getDatabase,
  initDatabase,
  restoreBackup,
} from '../main/db';

function assertNoRestoreAttachment(): void {
  const attached = getDatabase().prepare('PRAGMA database_list').all() as { name: string }[];
  assert.equal(attached.some((entry) => entry.name === '_restore_src'), false, 'restore source is detached');
}

function seedLinkedData(): void {
  const db = getDatabase();
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('restore-category', 'Restore Category');
  db.prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
    .run('restore-product', 'restore-category', 'Restore Product', 12.5);
  db.prepare(`
    INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, 'takeaway', 'pending', ?, ?, datetime('now'), datetime('now'))
  `).run('RESTORE-001', 12.5, 12.5);
  const order = db.prepare('SELECT id FROM orders WHERE order_number = ?').get('RESTORE-001') as { id: number };
  db.prepare(`
    INSERT INTO order_items
      (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'pending', datetime('now'), datetime('now'))
  `).run(order.id, 'restore-product', 'Restore Product', 12.5, 12.5, 12.5);
}

function clearLinkedData(): void {
  const db = getDatabase();
  db.exec('DELETE FROM order_items; DELETE FROM bills; DELETE FROM orders; DELETE FROM products; DELETE FROM categories;');
}

function copyAndStamp(sourcePath: string, destinationPath: string, schemaVersion: number): void {
  fs.copyFileSync(sourcePath, destinationPath);
  const backupDb = new Database(destinationPath);
  backupDb.pragma('foreign_keys = OFF');
  backupDb.prepare("UPDATE _flo_meta SET value = ? WHERE key = 'schema_version'").run(String(schemaVersion));
  backupDb.pragma(`user_version = ${schemaVersion}`);
  backupDb.close();
}

async function run() {
  console.log('Testing production database restore safety...');
  initDatabase();

  try {
    seedLinkedData();
    const db = getDatabase();
    db.prepare(`INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
      VALUES ('restore-station-current', 'Current Station', '[]', 1, datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES ('restore-station-chef', 'Station Chef', 'restore-station-chef@flo.local', 'test-hash', 'chef', 1, datetime('now'), datetime('now'))`).run();
    db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, datetime(\'now\'))')
      .run('restore-station-chef', 'restore-station-current');
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'false', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run();
    for (const [key, value] of [['jwt_secret', 'current-jwt'], ['cloud_api_key', 'current-cloud-key'], ['cloud_device_secret', 'current-device-secret'], ['telemetry_enabled', 'false'], ['diagnostics_consent', 'false']]) {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, value);
    }
    const currentVersion = getCurrentSchemaVersion();
    const { path: sameSchemaBackup } = await createBackup();

    const enabledKdsBackup = path.join(testDir, 'enabled-kds-backup.db');
    copyAndStamp(sameSchemaBackup, enabledKdsBackup, currentVersion);
    const enabledKdsDb = new Database(enabledKdsBackup);
    enabledKdsDb.pragma('foreign_keys = OFF');
    enabledKdsDb.prepare("UPDATE settings SET value = 'true' WHERE key = 'kds_enabled'").run();
    enabledKdsDb.prepare("UPDATE settings SET value = 'backup-jwt' WHERE key = 'jwt_secret'").run();
    enabledKdsDb.prepare("UPDATE settings SET value = 'backup-cloud-key' WHERE key = 'cloud_api_key'").run();
    enabledKdsDb.prepare("UPDATE settings SET value = 'backup-device-secret' WHERE key = 'cloud_device_secret'").run();
    enabledKdsDb.prepare("UPDATE settings SET value = 'true' WHERE key IN ('telemetry_enabled', 'diagnostics_consent')").run();
    enabledKdsDb.close();
    const enabledKdsRestore = restoreBackup(enabledKdsBackup, true);
    assert.equal(enabledKdsRestore.success, true, 'restore succeeds when backup enables KDS');
    assert.equal(
      (getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('kds_enabled') as { value: string }).value,
      'false',
      'direct restore preserves the current disabled KDS setting',
    );
    for (const [key, expected] of [['jwt_secret', 'current-jwt'], ['cloud_api_key', 'current-cloud-key'], ['cloud_device_secret', 'current-device-secret'], ['telemetry_enabled', 'false'], ['diagnostics_consent', 'false']]) {
      assert.equal((getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value, expected, `direct restore preserves current ${key}`);
    }

    const missingStationBackup = path.join(testDir, 'missing-current-station.db');
    copyAndStamp(sameSchemaBackup, missingStationBackup, currentVersion);
    const missingStationDb = new Database(missingStationBackup);
    missingStationDb.pragma('foreign_keys = OFF');
    missingStationDb.prepare('DELETE FROM station_users WHERE station_id = ?').run('restore-station-current');
    missingStationDb.prepare('DELETE FROM kitchen_stations WHERE id = ?').run('restore-station-current');
    missingStationDb.close();
    assert.throws(
      () => restoreBackup(missingStationBackup, true),
      /cannot preserve current (?:kitchen )?station/i,
      'restore rejects a backup that cannot preserve current station assignments',
    );
    assert.equal(
      (getDatabase().prepare('SELECT station_id FROM station_users WHERE user_id = ?').get('restore-station-chef') as { station_id: string }).station_id,
      'restore-station-current',
      'failed station-assignment restore leaves the current restriction intact',
    );

    const changedStationBackup = path.join(testDir, 'changed-station-security.db');
    copyAndStamp(sameSchemaBackup, changedStationBackup, currentVersion);
    const changedStationDb = new Database(changedStationBackup);
    changedStationDb.pragma('foreign_keys = OFF');
    changedStationDb.prepare('UPDATE kitchen_stations SET is_active = 0, category_ids = ? WHERE id = ?')
      .run('["different-category"]', 'restore-station-current');
    changedStationDb.close();
    const changedStationRestore = restoreBackup(changedStationBackup, true);
    assert.equal(changedStationRestore.success, true, 'restore preserves current station security configuration');
    const restoredStationSecurity = getDatabase().prepare('SELECT is_active, category_ids FROM kitchen_stations WHERE id = ?').get('restore-station-current') as { is_active: number; category_ids: string };
    assert.equal(restoredStationSecurity.is_active, 1, 'restore preserves the current station active state');
    assert.equal(restoredStationSecurity.category_ids, '[]', 'restore preserves the current station categories');

    const backupOnlyUserBackup = path.join(testDir, 'backup-only-user.db');
    copyAndStamp(sameSchemaBackup, backupOnlyUserBackup, currentVersion);
    const backupOnlyUserDb = new Database(backupOnlyUserBackup);
    backupOnlyUserDb.pragma('foreign_keys = OFF');
    backupOnlyUserDb.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES ('restore-backup-only-chef', 'Backup Only Chef', 'backup-only-chef@flo.local', 'test-hash', 'chef', 1, datetime('now'), datetime('now'))
    `).run();
    backupOnlyUserDb.close();
    const backupOnlyUserRestore = restoreBackup(backupOnlyUserBackup, true);
    assert.equal(backupOnlyUserRestore.success, true, 'restore succeeds with a backup-only user');
    assert.equal(
      (getDatabase().prepare('SELECT is_active FROM users WHERE id = ?').get('restore-backup-only-chef') as { is_active: number }).is_active,
      0,
      'backup-only users remain disabled after restore',
    );

    // Make the backup appear to be an older schema while retaining real linked data.
    const olderBackup = path.join(testDir, 'older-schema.db');
    copyAndStamp(sameSchemaBackup, olderBackup, currentVersion - 1);

    clearLinkedData();
    const restored = restoreBackup(olderBackup, false);
    assert.equal(restored.success, true, 'foreign-key-linked data-only restore succeeds');
    assert.equal(
      (getDatabase().prepare('SELECT name FROM products WHERE id = ?').get('restore-product') as { name: string }).name,
      'Restore Product',
      'child data is restored after parent data',
    );
    assert.equal(getDatabase().pragma('foreign_keys', { simple: true }), 1, 'foreign keys are re-enabled after restore');
    assert.equal(
      (getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('kds_enabled') as { value: string }).value,
      'false',
      'data-only restore preserves the current disabled KDS setting',
    );
    assertNoRestoreAttachment();

    // A failed restore must roll back and leave the connection reusable.
    const invalidBackup = path.join(testDir, 'invalid-fk-backup.db');
    copyAndStamp(sameSchemaBackup, invalidBackup, currentVersion - 1);
    const invalidDb = new Database(invalidBackup);
    invalidDb.pragma('foreign_keys = OFF');
    invalidDb.prepare('DELETE FROM categories WHERE id = ?').run('restore-category');
    invalidDb.close();

    const marker = 'keep-after-failed-restore';
    getDatabase().prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(marker, 'Keep Me');
    const failed = restoreBackup(invalidBackup, false);
    assert.equal(failed.success, false, 'invalid foreign-key source is rejected');
    assert.equal(
      (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get(marker) as { name: string }).name,
      'Keep Me',
      'failed restore leaves existing data unchanged',
    );
    assertNoRestoreAttachment();

    const retry = restoreBackup(olderBackup, false);
    assert.equal(retry.success, true, 'a valid restore succeeds after a failed restore');
    assertNoRestoreAttachment();

    // A same-version file that is missing current-schema tables must also be
    // rejected before it can replace the live database.
    const incompleteBackup = path.join(testDir, 'incomplete-schema.db');
    copyAndStamp(sameSchemaBackup, incompleteBackup, currentVersion);
    const incompleteDb = new Database(incompleteBackup);
    incompleteDb.pragma('foreign_keys = OFF');
    incompleteDb.exec('DROP TABLE categories');
    incompleteDb.close();
    const incomplete = restoreBackup(incompleteBackup, true);
    assert.equal(incomplete.success, false, 'direct restore rejects a same-version backup missing required tables');
    assert.equal(
      (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get('restore-category') as { name: string }).name,
      'Restore Category',
      'live data remains unchanged after incomplete-schema rejection',
    );

    // forceDirect must reject a newer backup before closing or replacing the live DB.
    const newerBackup = path.join(testDir, 'newer-schema.db');
    copyAndStamp(sameSchemaBackup, newerBackup, currentVersion + 1);
    const rejected = restoreBackup(newerBackup, true);
    assert.equal(rejected.success, false, 'forceDirect rejects a newer-schema backup');
    assert.equal(getCurrentSchemaVersion(), currentVersion, 'live schema remains current after rejection');
    assert.equal(
      (getDatabase().prepare('SELECT name FROM categories WHERE id = ?').get('restore-category') as { name: string }).name,
      'Restore Category',
      'live data remains unchanged after newer-schema rejection',
    );

    const direct = restoreBackup(sameSchemaBackup, true);
    assert.equal(direct.success, true, 'same-schema direct restore still succeeds');
    assertNoRestoreAttachment();

    console.log('✅ Production database restore tests passed');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
