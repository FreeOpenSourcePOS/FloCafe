const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => '/tmp', getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const { buildIdealSchemaDb } = require('../main/db');

const db = buildIdealSchemaDb();

try {
  // Test if migration 23 unique index is actually there
  const indexes = db.prepare("PRAGMA index_list('customers')").all();
  const hasUnique = indexes.some((i: any) => i.name === 'idx_customers_phone_digits_unique' && i.unique === 1);
  if (!hasUnique) throw new Error('idx_customers_phone_digits_unique not found');

  db.close();
  console.log('Migration tests passed');
  process.exit(0);
} catch (err: any) {
  try { db.close(); } catch {}
  console.error('FAILED:', err.message);
  process.exit(1);
}
