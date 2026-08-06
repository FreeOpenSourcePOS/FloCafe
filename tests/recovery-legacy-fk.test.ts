import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-recovery-legacy-fk-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { closeDatabase, getDatabase, getDbPath, getForeignKeyViolationKeys, initDatabase } from '../main/db';

function journalPath(name: string): string {
  return path.join(testDir, 'backups', `${name}.json`);
}

function recoveryPath(name: string): string {
  return path.join(testDir, 'backups', `${name}.db`);
}

async function run() {
  try {
    initDatabase();
    const dbPath = getDbPath();
    const db = getDatabase();
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
      .run('legacy-orphan-product', 'missing-legacy-category', 'Legacy Orphan', 1);
    const baselineForeignKeyViolations = [...getForeignKeyViolationKeys(db)];
    db.pragma('wal_checkpoint(TRUNCATE)');
    closeDatabase();

    // A committed journal must be finalized from the healthy live replacement
    // even when its old recovery snapshot is missing. Legacy FK violations are
    // intentionally preserved and must not brick startup recovery.
    fs.writeFileSync(journalPath('flo-restore-recovery-committed-legacy'), JSON.stringify({
      phase: 'committed',
      recoveryPath: recoveryPath('flo-restore-recovery-committed-legacy'),
      dbPath,
      baselineForeignKeyViolations,
    }));
    initDatabase();
    assert.equal(
      (getDatabase().prepare('SELECT name FROM products WHERE id = ?').get('legacy-orphan-product') as { name: string }).name,
      'Legacy Orphan',
      'committed recovery preserves a legacy FK violation while finalizing a missing snapshot journal',
    );
    closeDatabase();

    // A prepared interruption must also recover a legacy-dirty snapshot rather
    // than rejecting it solely because PRAGMA foreign_key_check is non-empty.
    const preparedName = 'flo-restore-recovery-prepared-legacy';
    fs.copyFileSync(dbPath, recoveryPath(preparedName));
    fs.writeFileSync(journalPath(preparedName), JSON.stringify({
      phase: 'prepared',
      recoveryPath: recoveryPath(preparedName),
      dbPath,
      baselineForeignKeyViolations,
    }));
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.unlinkSync(filePath); } catch { }
    }
    initDatabase();
    assert.equal(
      (getDatabase().prepare('SELECT name FROM products WHERE id = ?').get('legacy-orphan-product') as { name: string }).name,
      'Legacy Orphan',
      'prepared recovery restores a legacy FK-dirty snapshot',
    );
    console.log('✅ Legacy FK recovery tests passed');
  } finally {
    try { closeDatabase(); } catch { }
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
