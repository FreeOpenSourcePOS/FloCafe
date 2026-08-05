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
    const currentVersion = getCurrentSchemaVersion();
    const { path: sameSchemaBackup } = await createBackup();

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
