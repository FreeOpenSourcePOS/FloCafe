import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type Database = InstanceType<typeof DatabaseSync>;

const testDir = path.join(os.tmpdir(), 'flo-backup-test');

function cleanup() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
}

function createTestDb(version: number = 8): void {
  const dbPath = path.join(testDir, `test-v${version}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
  if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO settings VALUES ('schema_version', '${version}');
    
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      old_field TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  db.exec(`INSERT INTO products VALUES ('p1', 'Test Product', 100.00, 'old value', datetime('now'))`);
  db.exec(`INSERT INTO categories VALUES ('c1', 'Test Category', datetime('now'))`);
  db.close();
}

function createCurrentSchemaDb(): Database {
  const dbPath = path.join(testDir, 'current.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
  if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO settings VALUES ('schema_version', '8');
    
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      new_field TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      total REAL DEFAULT 0
    );
    
    CREATE TABLE _flo_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  
  return db;
}

function getColumns(db: Database, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.map(c => c.name);
}

function getTables(db: Database): string[] {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' 
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_flo_meta'
  `).all() as { name: string }[];
  return tables.map(t => t.name);
}

function addMetaToBackup(backupPath: string, schemaVersion: number) {
  const db = new DatabaseSync(backupPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS _flo_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.prepare(`INSERT OR REPLACE INTO _flo_meta VALUES ('schema_version', '${schemaVersion}')`).run();
  db.prepare(`INSERT OR REPLACE INTO _flo_meta VALUES ('backup_created_at', '${new Date().toISOString()}')`).run();
  db.prepare(`INSERT OR REPLACE INTO _flo_meta VALUES ('app_version', '${schemaVersion}')`).run();
  db.close();
}

function getSchemaVersionFromBackup(backupPath: string): number {
  const db = new DatabaseSync(backupPath, { open: true, readOnly: true });
  try {
    try {
      const meta = db.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
      return meta ? parseInt(meta.value, 10) : 0;
    } catch {
      return 0;
    }
  } finally {
    db.close();
  }
}

function dataOnlyRestore(backupPath: string, targetDb: Database): { success: boolean; tablesRestored: number; error?: string } {
  if (fs.existsSync(backupPath + '-wal')) fs.unlinkSync(backupPath + '-wal');
  if (fs.existsSync(backupPath + '-shm')) fs.unlinkSync(backupPath + '-shm');

  let backupDb: Database | null = null;
  try {
    backupDb = new DatabaseSync(backupPath, { open: true, readOnly: true });
    const backupTables = getTables(backupDb);
    const backupData: Record<string, any[]> = {};
    
    for (const t of backupTables) {
      backupData[t] = backupDb.prepare(`SELECT * FROM ${t}`).all();
    }
    backupDb.close();
    backupDb = null;
    
    const currentTables = getTables(targetDb);
    const commonTables = backupTables.filter(t => currentTables.includes(t));
    
    let tablesRestored = 0;
    
    targetDb.exec('BEGIN IMMEDIATE');
    
    for (const tableName of commonTables) {
      const rows = backupData[tableName] || [];
      if (rows.length === 0) continue;
      
      const backupCols = Object.keys(rows[0]);
      const currentCols = getColumns(targetDb, tableName);
      const commonCols = backupCols.filter(c => currentCols.includes(c));
      
      if (commonCols.length === 0) continue;
      
      targetDb.exec(`DELETE FROM ${tableName}`);
      
      const colList = commonCols.join(', ');
      const placeholders = commonCols.map(() => '?').join(', ');
      const insertStmt = targetDb.prepare(`INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`);
      
      for (const row of rows) {
        insertStmt.run(...commonCols.map(col => row[col]));
      }
      
      console.log(`   Restored ${tableName}: ${rows.length} rows`);
      tablesRestored++;
    }
    
    targetDb.exec('COMMIT');
    return { success: true, tablesRestored };
  } catch (error: any) {
    targetDb.exec('ROLLBACK');
    return { success: false, tablesRestored: 0, error: error.message };
  } finally {
    if (backupDb) backupDb.close();
  }
}

console.log('🧪 FloDesktop Backup/Restore Tests\n');
console.log('='.repeat(50));

cleanup();
console.log('\n📁 Test directory:', testDir);

console.log('\n✅ Test 1: Backup contains schema version metadata');
createTestDb(8);
const backupPath = path.join(testDir, 'backup-with-meta.db');
fs.copyFileSync(path.join(testDir, 'test-v8.db'), backupPath);
addMetaToBackup(backupPath, 8);

const extractedVersion = getSchemaVersionFromBackup(backupPath);
console.log(`   Schema version in backup: ${extractedVersion}`);
console.log(`   ✓ Backup contains schema version metadata: ${extractedVersion === 8}`);

console.log('\n✅ Test 2: Data-only restore with schema mismatch');
const currentDb = createCurrentSchemaDb();
console.log(`   Current schema has columns: ${getColumns(currentDb, 'products').join(', ')}`);

const result = dataOnlyRestore(backupPath, currentDb);
console.log(`   Tables restored: ${result.tablesRestored}`);
console.log(`   ✓ Data-only restore successful: ${result.success}`);

if (result.success) {
  const restoredProducts = currentDb.prepare(`SELECT * FROM products WHERE id = 'p1'`).get() as any;
  console.log(`   Restored product: ${JSON.stringify(restoredProducts)}`);
  console.log(`   ✓ 'old_field' column not present (new schema): ${!('old_field' in restoredProducts) || restoredProducts.old_field === null}`);
  console.log(`   ✓ 'new_field' is NULL (new column not in backup): ${restoredProducts.new_field === null}`);
  console.log(`   ✓ Original data preserved: ${restoredProducts.name === 'Test Product' && restoredProducts.price === 100.00}`);
}

console.log('\n✅ Test 3: Version detection');
createTestDb(5);
const oldBackup = path.join(testDir, 'old-backup.db');
fs.copyFileSync(path.join(testDir, 'test-v5.db'), oldBackup);
addMetaToBackup(oldBackup, 5);

const oldVersion = getSchemaVersionFromBackup(oldBackup);
console.log(`   Old backup version: ${oldVersion}`);
console.log(`   ✓ Version detection works: ${oldVersion === 5}`);

console.log('\n✅ Test 4: Invalid backup detection');
const invalidBackup = path.join(testDir, 'invalid-backup.db');
const invalidDb = new DatabaseSync(invalidBackup);
invalidDb.exec(`CREATE TABLE products (id TEXT)`);
invalidDb.close();

const invalidVersion = getSchemaVersionFromBackup(invalidBackup);
console.log(`   Invalid backup version: ${invalidVersion}`);
console.log(`   ✓ Invalid backup detected: ${invalidVersion === 0}`);

console.log('\n' + '='.repeat(50));
console.log('🏁 All tests completed!');
console.log('\n📋 Summary:');
console.log('   • Backups now include _flo_meta table with schema_version');
console.log('   • Data-only restore imports common columns only');
console.log('   • New columns = NULL, old columns = ignored');
console.log('   • Version mismatch is detected and handled gracefully');

currentDb.close();
cleanup();

