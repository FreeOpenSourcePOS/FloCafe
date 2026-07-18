import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phone-migration-test-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: mockApp,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s, 'utf8'),
        decryptString: (b: Buffer) => b.toString('utf8'),
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

// Initialize the database in the temporary directory
const { initDatabase, getDatabase, closeDatabase, migrations } = require('../main/db');
initDatabase(); // This runs all migrations up to the latest (including v24)
const db = getDatabase();

try {
  // Clear any default customers
  db.prepare('DELETE FROM customers').run();

  // Insert raw problematic numbers manually using the schema directly
  // We simulate a DB state right before v24 runs.
  db.prepare(`
    INSERT INTO customers (id, phone, name, country_code, created_at, updated_at) VALUES 
    ('c1', '+91 5555555555', 'Test 1', '+91', 0, 0),
    ('c2', '+91 34342', 'Test 2', '+91', 0, 0),
    ('c3', '+6491570159', 'Test 3', '+64', 0, 0),
    ('c4', '+919384398374', 'Test 4', '+91', 0, 0)
  `).run();

  const { MIGRATIONS } = require('../main/db');
  const v24 = MIGRATIONS.find((m: any) => m.version === 24);
  
  if (!v24) throw new Error('Migration v24 not found');
  v24.up();

  // Check the results
  const customers = db.prepare('SELECT * FROM customers ORDER BY id ASC').all();
  
  // c1: +91 5555555555 -> valid Indian number format (10 digits) -> E.164 is +915555555555
  assert.strictEqual(customers[0].phone, '+915555555555');
  assert.strictEqual(customers[0].country_code, '+91');

  // c2: +91 34342 -> invalid number -> stays as is
  assert.strictEqual(customers[1].phone, '+91 34342'); 

  // c3: +6491570159 -> valid NZ number -> E.164 is +6491570159
  assert.strictEqual(customers[2].phone, '+6491570159');
  assert.strictEqual(customers[2].country_code, '+64');

  // c4: +919384398374 -> valid Indian number -> E.164 is +919384398374
  assert.strictEqual(customers[3].phone, '+919384398374');
  assert.strictEqual(customers[3].country_code, '+91');

  console.log('Migration tests passed for problematic numbers');
  
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(0);
} catch (err: any) {
  try { db.close(); } catch {}
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error('FAILED:', err.stack);
  process.exit(1);
}
