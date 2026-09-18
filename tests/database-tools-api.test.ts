/**
 * Database Tools API Tests (supertest)
 *
 * Exercises /api/db-tools/* and the PIN-gated parts of /api/db/* against the
 * real Express route handlers.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/database-tools-api.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-db-tools-api-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-for-db-tools-api';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { API_JSON_BODY_LIMIT } = require('../main/http-limits');
const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion, MIGRATIONS, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { authRoutes } = require('../main/routes/auth');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { databaseRoutes } = require('../main/routes/database');
const { verifyMasterPin, isMasterPinSet } = require('../main/services/master-pin');
const { cancelHttpShutdownWork, closeHttpServer, installHttpShutdownTracking } = require('../main/shutdown');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

try {
  initDatabase();
} catch (error: any) {
  if (isNativeAbiMismatch(error)) {
    console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
    process.exit(77);
  }
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
}

const app = express();
let stalledDownloadStarted!: () => void;
const stalledDownloadStartedPromise = new Promise<void>((resolve) => { stalledDownloadStarted = resolve; });
let stalledDownloadDestroyed = false;
app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
app.use((req: any, res: any, next: any) => {
  if (!req.path.startsWith('/api')) { next(); return; }
  if (req.path.startsWith('/api/auth')) { next(); return; }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});
app.use((req: any, res: any, next: any) => {
  if (req.path === '/api/db/download' && req.headers['x-test-stall-download'] === '1') {
    const destroy = res.destroy.bind(res);
    res.destroy = (...args: any[]) => {
      stalledDownloadDestroyed = true;
      return destroy(...args);
    };
    res.download = (_filePath: string, _filename: string, _callback: (error?: Error) => void) => {
      stalledDownloadStarted();
    };
  }
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/db-tools', databaseToolsRoutes);
app.use('/api/db', databaseRoutes);

const downloadServer = http.createServer(app);
installHttpShutdownTracking(downloadServer);

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, email: `${userId}@flo.local`, role }, getJWTSecret(), { expiresIn: '1h' });
}

async function runTests() {
  console.log('Database Tools API Tests (supertest)');
  console.log('='.repeat(50));

  // ── Test 1: setup/initialize requires a 4-digit master_pin when available ──
  console.log('\nTest 1: setup requires master_pin');
  {
    const missingPin = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Owner', email: 'owner@example.com', password: 'TestPass123',
      business_type: 'restaurant', setup_profile: 'empty', service_model: 'qsr',
      terms_accepted: true,
    });
    assert(missingPin.status === 400, `setup without master_pin returns 400 (got ${missingPin.status})`);

    const ok = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Owner', email: 'owner@example.com', password: 'TestPass123',
      business_type: 'restaurant', setup_profile: 'empty', service_model: 'qsr',
      terms_accepted: true, master_pin: '1234', owner_approval_pin: '5678', owner_approval_pin_confirmation: '5678',
    });
    assert(ok.status === 200, `setup with valid master_pin succeeds (got ${ok.status}, ${JSON.stringify(ok.body)})`);
    assert(isMasterPinSet(), 'master PIN is set on disk after setup');
    assert(verifyMasterPin('1234'), 'the PIN submitted during setup verifies afterward');
  }

  const ownerToken = tokenFor('owner-1', 'owner');
  const db = getDatabase();
  db.exec(`INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('owner-1', 'Imported Owner', 'hash', 'owner', 1)`);
  db.exec(`INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('cashier-1', 'Cashier', 'hash', 'cashier', 1)`);
  const cashierToken = tokenFor('cashier-1', 'cashier');

  await new Promise<void>((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const stalledDownload = request(downloadServer)
    .get('/api/db/download')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('x-test-stall-download', '1')
    .send({ master_pin: '1234' });
  void stalledDownload.then(() => undefined, () => undefined);
  await stalledDownloadStartedPromise;
  cancelHttpShutdownWork();
  await new Promise((resolve) => setImmediate(resolve));
  assert(stalledDownloadDestroyed, 'database download destroys its response when HTTP shutdown cancels the request');
  await closeHttpServer(downloadServer, 'database download stream test', 100);

  const unresolvedUserImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [], categories: [], products: [], users: [],
        orders: [{ id: 'order-with-missing-user', user_id: 'missing-user' }],
      },
    },
  });
  assert(unresolvedUserImport.status === 400, `imports with unresolved redacted user references are rejected (got ${unresolvedUserImport.status})`);
  assert(unresolvedUserImport.body.error?.includes('user accounts'), 'unresolved user import explains the required staff setup');

  const redactedUserImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [],
        users: [{ id: 'redacted-user-1', name: 'Imported Redacted User', role: 'server', is_active: 1 }],
        orders: [{ id: 1001, order_number: 'ORD-REDACTED-USER-001', user_id: 'redacted-user-1' }],
      },
    },
  });
  assert(redactedUserImport.status === 200, `redacted exported users are restored as placeholders (got ${redactedUserImport.status}, ${JSON.stringify(redactedUserImport.body)})`);
  assert(redactedUserImport.body.placeholderUsersCreated === 1, 'import reports one placeholder user created');
  const placeholderUser = db.prepare("SELECT name, role, is_active, password, email FROM users WHERE id = 'redacted-user-1'").get() as { name: string; role: string; is_active: number; password: string; email: string | null } | undefined;
  assert(placeholderUser?.name === 'Imported Redacted User', 'placeholder user preserves display name');
  assert(placeholderUser?.role === 'server', 'placeholder user preserves role');
  assert(placeholderUser?.is_active === 0, 'placeholder user is inactive');
  assert(placeholderUser?.email == null, 'placeholder user does not reserve the exported email');
  assert(placeholderUser?.password !== '[REDACTED]', 'placeholder user does not use the redaction marker as a password');

  // Redacted export fields must never become literal credentials on import.
  db.prepare("INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('stale-import-category', 'Stale', 99)").run();
  const jwtSecretBefore = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;
  const redactedImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [{ key: 'jwt_secret', value: '[REDACTED]', updated_at: now() }],
        categories: [],
        products: [],
        users: [],
      },
    },
  });
  assert(redactedImport.status === 200, `redacted settings import returns 200 (got ${redactedImport.status}, ${JSON.stringify(redactedImport.body)})`);
  assert((db.prepare("SELECT COUNT(*) AS count FROM categories WHERE id = 'stale-import-category'").get() as { count: number }).count === 0, 'overwrite import clears tables explicitly present as empty');
  const jwtSecretAfter = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;
  assert(
    (jwtSecretAfter?.value ?? null) === (jwtSecretBefore?.value ?? null),
    'redacted jwt_secret is preserved during import',
  );

  db.prepare('INSERT INTO products (id, name, price, stock_quantity) VALUES (?, ?, ?, ?)')
    .run('existing-stock-product', 'Existing Stock Product', 10, 5);
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
  `).run('existing-stock-product', 5, 'existing-stock-product', 'Opening count', 'owner-1', 5, now());
  const zeroResetImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'existing-stock-product', name: 'Existing Stock Product', price: 10, stock_quantity: 0 }],
        inventory_movements: [],
        users: [],
      },
    },
  });
  assert(zeroResetImport.status === 400, `overwrite imports reject unaudited stock resets (got ${zeroResetImport.status})`);
  assertEqual(
    (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('existing-stock-product') as { stock_quantity: number }).stock_quantity,
    5,
    'rejected stock reset preserves the existing cache',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get('existing-stock-product') as { count: number }).count,
    1,
    'rejected stock reset preserves movement history',
  );

  db.prepare('INSERT INTO products (id, name, price, stock_quantity) VALUES (?, ?, ?, ?)')
    .run('zero-stock-history-product', 'Zero Stock History Product', 10, 0);
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
  `).run('zero-stock-history-product', 1, 'zero-stock-history-product', 'Opening count', 'owner-1', 1, now());
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'sale', 'order_item', ?, ?, ?, ?, ?)
  `).run('zero-stock-history-product', -1, 'zero-stock-history-order-item', null, 'owner-1', 0, now());
  const historyDeletionImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'zero-stock-history-product', name: 'Zero Stock History Product', price: 10, stock_quantity: 0 }],
        inventory_movements: [],
        users: [],
      },
    },
  });
  assert(historyDeletionImport.status === 400, `overwrite imports reject ledger history deletion (got ${historyDeletionImport.status})`);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get('zero-stock-history-product') as { count: number }).count,
    2,
    'rejected zero-stock replacement preserves all movement history',
  );
  const partialHistoryDeletionImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'zero-stock-history-product', name: 'Zero Stock History Product', price: 10, stock_quantity: 1 }],
        inventory_movements: [{
          id: 1,
          product_id: 'zero-stock-history-product',
          quantity_delta: 1,
          movement_type: 'adjustment',
          reference_type: 'opening_balance',
          reference_id: 'zero-stock-history-product',
          reason: 'Opening count',
          actor_user_id: 'owner-1',
          stock_after: 1,
          created_at: now(),
        }],
        users: [],
      },
    },
  });
  assert(partialHistoryDeletionImport.status === 400, `overwrite imports reject partial ledger history replacement (got ${partialHistoryDeletionImport.status})`);
  assertEqual(
    (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('zero-stock-history-product') as { stock_quantity: number }).stock_quantity,
    0,
    'rejected partial replacement preserves the stock cache',
  );
  const emptyHistoryDeletionImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [],
        inventory_movements: [],
        users: [],
      },
    },
  });
  assert(emptyHistoryDeletionImport.status === 400, `empty overwrite imports reject ledger history deletion (got ${emptyHistoryDeletionImport.status})`);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get('zero-stock-history-product') as { count: number }).count,
    2,
    'empty rejected replacement preserves all movement history',
  );
  const malformedProductsImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: {},
        inventory_movements: [],
        users: [],
      },
    },
  });
  assert(malformedProductsImport.status === 400, `malformed products tables are rejected (got ${malformedProductsImport.status})`);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get('zero-stock-history-product') as { count: number }).count,
    2,
    'malformed products import preserves movement history',
  );
  db.prepare('DELETE FROM inventory_movements WHERE product_id IN (?, ?)').run('existing-stock-product', 'zero-stock-history-product');
  db.prepare('DELETE FROM products WHERE id IN (?, ?)').run('existing-stock-product', 'zero-stock-history-product');

  const legacyZeroStockImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion() - 1),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'legacy-zero-stock-product', name: 'Legacy Zero Stock Product', price: 10, stock_quantity: 0 }],
        users: [],
      },
    },
  });
  assert(legacyZeroStockImport.status === 200, `legacy zero-stock imports without movement history are accepted (got ${legacyZeroStockImport.status})`);
  assertEqual(
    (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('legacy-zero-stock-product') as { stock_quantity: number }).stock_quantity,
    0,
    'legacy zero-stock import preserves the zero cache',
  );
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
  `).run('legacy-zero-stock-product', 1, 'legacy-zero-stock-product', 'Legacy opening', 'owner-1', 1, now());
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'sale', 'order_item', ?, ?, ?, ?, ?)
  `).run('legacy-zero-stock-product', -1, 'legacy-zero-stock-order-item', 'Legacy sale', 'owner-1', 0, now());
  const legacyZeroHistoryImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion() - 1),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'legacy-zero-stock-product', name: 'Legacy Zero Stock Product', price: 10, stock_quantity: 0 }],
        users: [],
      },
    },
  });
  assert(legacyZeroHistoryImport.status === 200, `legacy zero-stock import preserves omitted-table history (got ${legacyZeroHistoryImport.status})`);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get('legacy-zero-stock-product') as { count: number }).count,
    2,
    'legacy zero-stock import preserves existing movement history',
  );
  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run('legacy-zero-stock-product');
  db.prepare('DELETE FROM products WHERE id = ?').run('legacy-zero-stock-product');

  const remappedProvenanceImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: false,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'provenance-product', name: 'Provenance Product', price: 10, stock_quantity: 5 }],
        inventory_movements: [{
          id: 1,
          product_id: 'provenance-product',
          quantity_delta: 5,
          movement_type: 'adjustment',
          reference_type: 'opening_balance',
          reference_id: 'provenance-product',
          reason: 'Opening count',
          actor_user_id: 'source-actor',
          imported_by_user_id: 'source-importer',
          stock_after: 5,
          created_at: now(),
        }],
        users: [],
      },
    },
  });
  assert(remappedProvenanceImport.status === 200, `movement provenance is remapped during import (got ${remappedProvenanceImport.status})`);
  const remappedMovement = db.prepare(`
    SELECT actor_user_id, imported_by_user_id, source_actor_user_id
    FROM inventory_movements WHERE product_id = ?
  `).get('provenance-product') as { actor_user_id: string; imported_by_user_id: string; source_actor_user_id: string };
  assertEqual(remappedMovement.actor_user_id, 'owner-1', 'imported movement actor is authenticated locally');
  assertEqual(remappedMovement.imported_by_user_id, 'owner-1', 'imported_by_user_id is authenticated locally');
  assertEqual(remappedMovement.source_actor_user_id, 'source-actor', 'source actor provenance is preserved');
  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run('provenance-product');
  db.prepare('DELETE FROM products WHERE id = ?').run('provenance-product');

  const incompleteInventoryImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion() - 1),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'incomplete-inventory-product', name: 'Incomplete Inventory Product', price: 10, stock_quantity: 7 }],
        users: [],
      },
    },
  });
  assert(incompleteInventoryImport.status === 400, `product imports without movement history are rejected (got ${incompleteInventoryImport.status})`);
  assert(
    (db.prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'incomplete-inventory-product'").get() as { count: number }).count === 0,
    'rejected product import leaves product data unchanged',
  );

  const emptyInventoryImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'empty-inventory-product', name: 'Empty Inventory Product', price: 10, stock_quantity: 7 }],
        inventory_movements: [],
        users: [],
      },
    },
  });
  assert(emptyInventoryImport.status === 400, `product imports with missing movement history are rejected (got ${emptyInventoryImport.status})`);
  assert(
    (db.prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'empty-inventory-product'").get() as { count: number }).count === 0,
    'rejected inconsistent product import leaves product data unchanged',
  );

  const sourceCreatedAt = '2020-01-01 00:00:00';
  const validInventoryImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'merged-state-product', name: 'Merged State Product', price: 10, stock_quantity: 5 }],
        inventory_movements: [{
          id: 1,
          product_id: 'merged-state-product',
          quantity_delta: 5,
          movement_type: 'adjustment',
          reference_type: 'opening_balance',
          reference_id: 'merged-state-product',
          reason: 'Opening count',
          actor_user_id: 'source-user-not-authenticated',
          stock_after: 5,
          created_at: sourceCreatedAt,
        }],
        users: [],
      },
    },
  });
  assert(validInventoryImport.status === 200, `a consistent product import succeeds (got ${validInventoryImport.status})`);
  const importedMovement = db.prepare(`
    SELECT actor_user_id, imported_by_user_id, import_batch_id,
           reference_type, reference_id, reason, created_at,
           source_actor_user_id, source_reference_type, source_reference_id,
           source_reason, source_created_at
    FROM inventory_movements WHERE product_id = ?
  `).get('merged-state-product') as any;
  assertEqual(importedMovement.actor_user_id, 'owner-1', 'imported movement is attributed to the authenticated importer');
  assertEqual(importedMovement.imported_by_user_id, 'owner-1', 'imported movement records the immutable importer identity');
  assert(typeof importedMovement.import_batch_id === 'string' && importedMovement.import_batch_id.length > 0, 'imported movement records a batch provenance id');
  assertEqual(importedMovement.reference_type, 'import', 'imported movement uses an import reference type');
  assert(typeof importedMovement.reference_id === 'string' && importedMovement.reference_id.length > 0, 'imported movement references its import batch');
  assertEqual(importedMovement.reason, 'Imported inventory movement', 'imported movement uses a local audit reason');
  assert(importedMovement.created_at !== sourceCreatedAt, 'imported movement uses local ingestion time');
  assertEqual(importedMovement.source_actor_user_id, 'source-user-not-authenticated', 'imported actor is retained as source metadata');
  assertEqual(importedMovement.source_reference_type, 'opening_balance', 'imported reference type is retained as source metadata');
  assertEqual(importedMovement.source_reference_id, 'merged-state-product', 'imported reference id is retained as source metadata');
  assertEqual(importedMovement.source_reason, 'Opening count', 'imported reason is retained as source metadata');
  assertEqual(importedMovement.source_created_at, sourceCreatedAt, 'imported timestamp is retained as source metadata');

  const mergedStateImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [],
        inventory_movements: [{
          id: 2,
          product_id: 'merged-state-product',
          quantity_delta: 2,
          movement_type: 'adjustment',
          reference_type: 'manual_adjustment',
          reference_id: 'merged-state-product-2',
          reason: 'Correction',
          actor_user_id: 'owner-1',
          stock_after: 7,
          created_at: now(),
        }],
        users: [],
      },
    },
  });
  assert(mergedStateImport.status === 500, `imports that leave the merged stock cache stale are rejected (got ${mergedStateImport.status})`);
  assertEqual(
    db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('merged-state-product').stock_quantity,
    5,
    'rejected merged-state import leaves the stock cache unchanged',
  );
  assertEqual(
    db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?').get('merged-state-product').count,
    1,
    'rejected merged-state import leaves movement history unchanged',
  );

  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run('merged-state-product');
  db.prepare('DELETE FROM products WHERE id = ?').run('merged-state-product');

  const partialBaselineImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'partial-baseline-product', name: 'Partial Baseline Product', price: 10, stock_quantity: 7 }],
        inventory_movements: [{
          id: 1,
          product_id: 'partial-baseline-product',
          quantity_delta: 2,
          movement_type: 'adjustment',
          reference_type: 'manual_adjustment',
          reference_id: 'partial-baseline-product',
          reason: 'Partial import',
          actor_user_id: 'owner-1',
          stock_after: 7,
          created_at: now(),
        }],
        users: [],
      },
    },
  });
  assert(partialBaselineImport.status === 400, `imports without an opening baseline are rejected (got ${partialBaselineImport.status})`);

  const saleSignImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'sale-sign-product', name: 'Sale Sign Product', price: 10, stock_quantity: 6 }],
        inventory_movements: [
          {
            id: 1,
            product_id: 'sale-sign-product',
            quantity_delta: 5,
            movement_type: 'adjustment',
            reference_type: 'opening_balance',
            reference_id: 'sale-sign-product',
            reason: 'Opening count',
            actor_user_id: 'owner-1',
            stock_after: 5,
            created_at: now(),
          },
          {
            id: 2,
            product_id: 'sale-sign-product',
            quantity_delta: 1,
            movement_type: 'sale',
            reference_type: 'order_item',
            reference_id: 'sale-sign-order-item',
            reason: null,
            actor_user_id: 'owner-1',
            stock_after: 6,
            created_at: now(),
          },
        ],
        users: [],
      },
    },
  });
  assert(saleSignImport.status === 400, `sale movements with positive deltas are rejected (got ${saleSignImport.status})`);

  const brokenInventoryChainImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [{ id: 'broken-chain-product', name: 'Broken Chain Product', price: 10, stock_quantity: 3 }],
        inventory_movements: [
          {
            id: 1,
            product_id: 'broken-chain-product',
            quantity_delta: 3,
            movement_type: 'adjustment',
            reference_type: 'opening_balance',
            reference_id: 'broken-chain-product',
            reason: 'Opening count',
            actor_user_id: 'owner-1',
            stock_after: 3,
            created_at: now(),
          },
          {
            id: 2,
            product_id: 'broken-chain-product',
            quantity_delta: 2,
            movement_type: 'adjustment',
            reference_type: 'manual_adjustment',
            reference_id: 'broken-chain-product-2',
            reason: 'Correction',
            actor_user_id: 'owner-1',
            stock_after: 3,
            created_at: now(),
          },
        ],
        users: [],
      },
    },
  });
  assert(brokenInventoryChainImport.status === 400, `imports with broken movement chains are rejected (got ${brokenInventoryChainImport.status})`);
  assert(
    (db.prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'broken-chain-product'").get() as { count: number }).count === 0,
    'rejected broken-chain import leaves product data unchanged',
  );

  const largeJsonImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [{ key: 'json_large_import_probe', value: 'x'.repeat(2 * 1024 * 1024), updated_at: now() }],
        categories: [],
        products: [],
        inventory_movements: [],
        users: [],
      },
    },
  });
  assert(largeJsonImport.status === 200, `multi-megabyte JSON imports are accepted (got ${largeJsonImport.status}, ${JSON.stringify(largeJsonImport.body).slice(0, 200)})`);

  // ── Test 2: health-check is owner-gated, not PIN-gated ──────────────────
  console.log('\nTest 2: GET /db-tools/health-check');
  {
    const forbidden = await request(app).get('/api/db-tools/health-check').set('Authorization', `Bearer ${cashierToken}`);
    assert(forbidden.status === 403, `non-owner is forbidden (got ${forbidden.status})`);

    const ok = await request(app).get('/api/db-tools/health-check').set('Authorization', `Bearer ${ownerToken}`);
    assert(ok.status === 200, `owner gets 200 (got ${ok.status})`);
    assert(Array.isArray(ok.body.findings), 'response has a findings array');
    assert(typeof ok.body.summary?.safeCount === 'number', 'response has a summary.safeCount');
  }

  // ── Test 3: POST /db/backup requires the master PIN ─────────────────────
  console.log('\nTest 3: POST /db/backup is master-PIN gated');
  {
    const noPin = await request(app).post('/api/db/backup').set('Authorization', `Bearer ${ownerToken}`).send({});
    assert(noPin.status === 403, `backup without a PIN is rejected (got ${noPin.status})`);

    const wrongPin = await request(app).post('/api/db/backup').set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '0000' });
    assert(wrongPin.status === 403, `backup with the wrong PIN is rejected (got ${wrongPin.status})`);

    const ok = await request(app).post('/api/db/backup').set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '1234' });
    assert(ok.status === 200, `backup with the correct PIN succeeds (got ${ok.status}, ${JSON.stringify(ok.body)})`);
    const backupFiles = fs.readdirSync(path.join(testDir, 'backups')).filter((f: string) => f.endsWith('.db'));
    assert(backupFiles.length > 0, 'a backup file was actually written to the backups directory');
  }

  // ── Test 3b: GET /db-tools/backups lists what was just created (#120) ───
  console.log('\nTest 3b: GET /db-tools/backups');
  {
    const forbidden = await request(app).get('/api/db-tools/backups').set('Authorization', `Bearer ${cashierToken}`);
    assert(forbidden.status === 403, `non-owner is forbidden (got ${forbidden.status})`);

    const ok = await request(app).get('/api/db-tools/backups').set('Authorization', `Bearer ${ownerToken}`);
    assert(ok.status === 200, `owner gets 200 (got ${ok.status})`);
    assert(Array.isArray(ok.body.backups), 'response has a backups array');
    assert(ok.body.backups.length >= 1, 'the backup created in Test 3 is listed');

    const entry = ok.body.backups[0];
    assert(typeof entry.fileName === 'string' && entry.fileName.endsWith('.db'), 'entry has a .db fileName');
    assert(typeof entry.sizeBytes === 'number' && entry.sizeBytes > 0, 'entry has a positive sizeBytes');
    assert(!Number.isNaN(new Date(entry.createdAt).getTime()), 'entry has a parseable createdAt');
    assert(entry.kind === 'manual', 'a backup created via POST /db/backup is classified as manual, not auto');
  }

  // ── Test 3b2: POST /db-tools/apply-safe-fixes validates its payload ─────
  console.log('\nTest 3b2: POST /db-tools/apply-safe-fixes payload validation');
  {
    const nonArray = await request(app).post('/api/db-tools/apply-safe-fixes').set('Authorization', `Bearer ${ownerToken}`)
      .send({ findingIds: 'not-an-array' });
    assert(nonArray.status === 400, `non-array findingIds is rejected (got ${nonArray.status})`);
    assert(nonArray.body.error?.includes('findingIds'), 'the error explains the findingIds shape requirement');

    const nonStringElement = await request(app).post('/api/db-tools/apply-safe-fixes').set('Authorization', `Bearer ${ownerToken}`)
      .send({ findingIds: [123] });
    assert(nonStringElement.status === 400, `non-string findingIds element is rejected (got ${nonStringElement.status})`);

    const emptyArray = await request(app).post('/api/db-tools/apply-safe-fixes').set('Authorization', `Bearer ${ownerToken}`)
      .send({ findingIds: [] });
    assert(emptyArray.status === 200, `empty findingIds array is accepted (got ${emptyArray.status})`);
  }

  // ── Test 3b3: POST /db-tools/backups/:fileName/delete maps failures to accurate status codes ──
  console.log('\nTest 3b3: POST /db-tools/backups/:fileName/delete status codes');
  {
    const invalidName = await request(app).post('/api/db-tools/backups/not-a-backup.txt/delete')
      .set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '1234' });
    assert(invalidName.status === 400, `invalid backup name returns 400 (got ${invalidName.status})`);

    const notFound = await request(app).post('/api/db-tools/backups/flo-backup-missing-00000000.db/delete')
      .set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '1234' });
    assert(notFound.status === 404, `missing backup returns 404 (got ${notFound.status})`);

    const list = await request(app).get('/api/db-tools/backups').set('Authorization', `Bearer ${ownerToken}`);
    const fileName = list.body.backups[0]?.fileName;
    assert(typeof fileName === 'string', 'a backup exists to delete');
    const okDelete = await request(app).post(`/api/db-tools/backups/${encodeURIComponent(fileName)}/delete`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '1234' });
    assert(okDelete.status === 200, `deleting an existing backup returns 200 (got ${okDelete.status})`);
  }

  // ── Test 3c: schema-mismatch import requires the Master PIN (GHSA-xxv4-gm82-4639) ──
  console.log('\nTest 3c: POST /db/import destructive path is master-PIN gated');
  {
    const currentVersion = getCurrentSchemaVersion();
    const emptyPayload = { settings: [], categories: [], products: [], users: [] };
    const importWithoutPin = (payload: Record<string, unknown>) =>
      request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({ overwrite: false, data: payload });

    db.prepare("INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('ghsa-sentinel', 'Sentinel', 999)").run();
    const sentinelCount = () => (db.prepare("SELECT COUNT(*) AS c FROM categories WHERE id = 'ghsa-sentinel'").get() as { c: number }).c;

    // GET /api/db-tools/master-pin/status exposes live schemaVersion alongside availability
    const pinStatus = await request(app).get('/api/db-tools/master-pin/status').set('Authorization', `Bearer ${ownerToken}`);
    assert(pinStatus.status === 200, `master-pin status returns 200 (got ${pinStatus.status})`);
    assert(pinStatus.body.available === true, 'master-pin status reports available: true');
    assert(pinStatus.body.isSet === true, 'master-pin status reports isSet: true');
    assert(pinStatus.body.schemaVersion === currentVersion, `master-pin status includes live schemaVersion (got ${pinStatus.body.schemaVersion}, expected ${currentVersion})`);

    // Mismatched (future) schema version, no PIN → rejected and DB unchanged.
    const futureNoPin = await importWithoutPin({ schema_version: String(currentVersion + 1), data: emptyPayload });
    assert(futureNoPin.status === 403, `future schema_version import without a PIN is rejected (got ${futureNoPin.status})`);
    assert(sentinelCount() === 1, 'rejected schema-mismatch import leaves the database unchanged');

    // Mismatched schema version with wrong PIN → rejected and DB unchanged.
    const mismatchedWrongPin = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
      overwrite: false,
      master_pin: '0000',
      data: { schema_version: String(currentVersion + 1), data: emptyPayload },
    });
    assert(mismatchedWrongPin.status === 403, `mismatched schema_version with wrong PIN is rejected (got ${mismatchedWrongPin.status})`);
    assert(sentinelCount() === 1, 'rejected wrong-PIN schema-mismatch import leaves the database unchanged');

    // Fresh install (schema version 0), no PIN → rejected.
    const freshZeroNoPin = await importWithoutPin({ schema_version: '0', data: emptyPayload });
    assert(freshZeroNoPin.status === 403, `fresh schema_version 0 import without a PIN is rejected (got ${freshZeroNoPin.status})`);

    // Old (upgrade-path) schema version, no PIN → rejected.
    const oldNoPin = await importWithoutPin({ schema_version: String(currentVersion - 1), data: emptyPayload });
    assert(oldNoPin.status === 403, `old-schema (upgrade-path) import without a PIN is rejected (got ${oldNoPin.status})`);

    // Malformed schema version, no PIN → treated as destructive and rejected.
    const malformedNoPin = await importWithoutPin({ schema_version: 'not-a-version', data: emptyPayload });
    assert(malformedNoPin.status === 403, `malformed schema_version import without a PIN is rejected (got ${malformedNoPin.status})`);

    // Omitted schema version, no PIN → defaults to 0 (a mismatch) and is rejected.
    const omittedNoPin = await importWithoutPin({ data: emptyPayload });
    assert(omittedNoPin.status === 403, `omitted schema_version import without a PIN is rejected (got ${omittedNoPin.status})`);

    // Mismatched schema version with the correct PIN → allowed.
    const mismatchedWithPin = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
      overwrite: false,
      master_pin: '1234',
      data: { schema_version: String(currentVersion + 1), data: emptyPayload },
    });
    assert(mismatchedWithPin.status === 200, `schema-mismatch import with the correct PIN succeeds (got ${mismatchedWithPin.status}, ${JSON.stringify(mismatchedWithPin.body)})`);

    // Matching schema version, no overwrite, no PIN → non-destructive merge, allowed.
    const matchingNoPin = await importWithoutPin({ schema_version: String(currentVersion), data: emptyPayload });
    assert(matchingNoPin.status === 200, `matching-schema import without overwrite needs no PIN (got ${matchingNoPin.status})`);

    // Matching schema version + explicit overwrite, no PIN → still rejected.
    const matchingOverwriteNoPin = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
      overwrite: true,
      data: { schema_version: String(currentVersion), data: emptyPayload },
    });
    assert(matchingOverwriteNoPin.status === 403, `matching-schema overwrite import without a PIN is still rejected (got ${matchingOverwriteNoPin.status})`);
  }

  // ── Test 4: POST /db-tools/initialize ────────────────────────────────────
  console.log('\nTest 4: POST /db-tools/initialize');
  {
    const wrongPhrase = await request(app).post('/api/db-tools/initialize').set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', confirmation_phrase: 'nope' });
    assert(wrongPhrase.status === 400, `wrong confirmation phrase is rejected (got ${wrongPhrase.status})`);

    const wrongPin = await request(app).post('/api/db-tools/initialize').set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '0000', confirmation_phrase: 'INITIALIZE' });
    assert(wrongPin.status === 403, `wrong PIN is rejected even with the right phrase (got ${wrongPin.status})`);

    const ok = await request(app).post('/api/db-tools/initialize').set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });
    assert(ok.status === 200, `initialize succeeds with correct PIN + phrase (got ${ok.status}, ${JSON.stringify(ok.body)})`);
    assert(!!ok.body.backupPath, 'response includes the forced pre-wipe backup path');

    const freshDb = getDatabase();
    const userCount = (freshDb.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    assert(userCount === 0, 'no users remain after initialize — back to first-run state');
    assert(getCurrentSchemaVersion() === MIGRATIONS[MIGRATIONS.length - 1].version, 'the recreated database is at the latest schema version');

    // The core "locked-out owner" guarantee: the Master PIN survives a full DB wipe
    // because it lives outside flo.db entirely.
    assert(isMasterPinSet(), 'master-pin.enc still exists after the database was wiped');
    assert(verifyMasterPin('1234'), 'the same Master PIN still verifies after the database was wiped');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

runTests();
