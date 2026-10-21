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

let readonlyBackupProbes = 0;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  const loaded = originalLoad.apply(this, arguments as any);
  if (request === 'better-sqlite3') {
    return new Proxy(loaded, {
      construct(target, args, newTarget) {
        if (
          args[1] &&
          typeof args[1] === 'object' &&
          (args[1] as { readonly?: boolean }).readonly
        ) {
          readonlyBackupProbes += 1;
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
  return loaded;
};

process.env.JWT_SECRET = 'test-secret-for-db-tools-api';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { API_JSON_BODY_LIMIT } = require('../main/http-limits');
const {
  initDatabase,
  getDatabase,
  closeDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  now,
  validateInventoryLedgerDatabase,
  validateInventoryLedgerRows,
  getInventoryMovementRows,
  generateOrderNumber,
  generateBillNumber,
  repairSequences,
} = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { authRoutes } = require('../main/routes/auth');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { databaseRoutes } = require('../main/routes/database');
const { orderRoutes } = require('../main/routes/orders');
const { verifyMasterPin, isMasterPinSet, resetMasterPin } = require('../main/services/master-pin');
const {
  cancelHttpShutdownWork,
  closeHttpServer,
  installHttpShutdownTracking,
} = require('../main/shutdown');

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
    console.error(
      `  ✗ ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
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
const stalledDownloadStartedPromise = new Promise<void>((resolve) => {
  stalledDownloadStarted = resolve;
});
let stalledDownloadDestroyed = false;
app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
app.use((req: any, res: any, next: any) => {
  if (!req.path.startsWith('/api')) {
    next();
    return;
  }
  if (req.path.startsWith('/api/auth')) {
    next();
    return;
  }

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
app.use('/api/orders', orderRoutes);

const downloadServer = http.createServer(app);
installHttpShutdownTracking(downloadServer);

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, email: `${userId}@flo.local`, role }, getJWTSecret(), {
    expiresIn: '1h',
  });
}

async function runTests() {
  console.log('Database Tools API Tests (supertest)');
  console.log('='.repeat(50));

  // ── Test 1: setup/initialize requires a 4-digit master_pin when available ──
  console.log('\nTest 1: setup requires master_pin');
  {
    const missingPin = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Owner',
      email: 'owner@example.com',
      password: 'TestPass123',
      business_type: 'restaurant',
      setup_profile: 'empty',
      service_model: 'qsr',
      terms_accepted: true,
      country: 'US',
    });
    assert(
      missingPin.status === 400,
      `setup without master_pin returns 400 (got ${missingPin.status})`,
    );

    const ok = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Owner',
      email: 'owner@example.com',
      password: 'TestPass123',
      business_type: 'restaurant',
      setup_profile: 'empty',
      service_model: 'qsr',
      terms_accepted: true,
      country: 'US',
      master_pin: '1234',
      owner_approval_pin: '5678',
      owner_approval_pin_confirmation: '5678',
    });
    assert(
      ok.status === 200,
      `setup with valid master_pin succeeds (got ${ok.status}, ${JSON.stringify(ok.body)})`,
    );
    assert(isMasterPinSet(), 'master PIN is set on disk after setup');
    assert(verifyMasterPin('1234'), 'the PIN submitted during setup verifies afterward');
  }

  const ownerToken = tokenFor('owner-1', 'owner');
  const db = getDatabase();
  db.exec(
    `INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('owner-1', 'Imported Owner', 'hash', 'owner', 1)`,
  );
  db.exec(
    `INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('cashier-1', 'Cashier', 'hash', 'cashier', 1)`,
  );
  const cashierToken = tokenFor('cashier-1', 'cashier');

  console.log('\nTest 1a: database JSON transfer excludes device-local diagnostics');
  {
    const exported = await request(app)
      .get('/api/db/export')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(exported.status === 200, `database export succeeds (got ${exported.status})`);
    assert(
      !('diagnostics_hourly_aggregates' in exported.body.data),
      'hourly diagnostic aggregates are excluded from export',
    );
    assert(
      !('diagnostics_delivery_gaps' in exported.body.data),
      'diagnostic delivery gaps are excluded from export',
    );
    assert(
      exported.body.redacted_fields.includes('table:diagnostics_hourly_aggregates'),
      'excluded hourly aggregates are listed in redacted_fields',
    );
    assert(
      exported.body.redacted_fields.includes('table:diagnostics_delivery_gaps'),
      'excluded delivery gaps are listed in redacted_fields',
    );

    const timestamp = now();
    const aggregateKey = `database-transfer-probe-${timestamp}`;
    const deliveryGapCount = (
      db.prepare('SELECT COUNT(*) AS count FROM diagnostics_delivery_gaps').get() as {
        count: number;
      }
    ).count;
    const imported = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: {
            settings: [],
            categories: [],
            products: [],
            users: [],
            diagnostics_hourly_aggregates: [
              {
                aggregate_key: aggregateKey,
                capture_point: 'fc.test',
                reason_code: 'test.reason',
                classification: 'unexpected_failure',
                operation: 'test.operation',
                stage: 'test',
                outcome: 'unknown',
                window_start: timestamp,
                count: 1,
                first_occurred_at: timestamp,
                last_occurred_at: timestamp,
                app_version: 'test',
                app_build: 'test',
                platform: 'unknown',
                examples_json: '[]',
                facts_json: '{}',
                updated_at: timestamp,
              },
            ],
            diagnostics_delivery_gaps: [
              {
                reason_code: 'queue_eviction',
                count: 1,
                first_occurred_at: timestamp,
                last_occurred_at: timestamp,
                updated_at: timestamp,
              },
            ],
          },
        },
      });
    assert(imported.status === 200, `database import succeeds (got ${imported.status})`);
    assert(
      !db
        .prepare('SELECT 1 FROM diagnostics_hourly_aggregates WHERE aggregate_key = ?')
        .get(aggregateKey),
      'hourly diagnostic aggregates are ignored on import',
    );
    assert(
      (
        db.prepare('SELECT COUNT(*) AS count FROM diagnostics_delivery_gaps').get() as {
          count: number;
        }
      ).count === deliveryGapCount,
      'diagnostic delivery gaps are ignored on import',
    );
  }

  console.log(
    '\nTest 1b: POST /db-tools/master-pin/reset requires the existing PIN but allows first-time setup',
  );
  {
    const withoutCurrentPin = await request(app)
      .post('/api/db-tools/master-pin/reset')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: '5678', confirm_pin: '5678' });
    assert(
      withoutCurrentPin.status === 403,
      `reset with an existing PIN rejects a request without current proof (got ${withoutCurrentPin.status})`,
    );
    assert(
      verifyMasterPin('1234'),
      'a rejected reset without current proof leaves the existing PIN unchanged',
    );
    resetMasterPin('1234');

    const withWrongCurrentPin = await request(app)
      .post('/api/db-tools/master-pin/reset')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '0000', pin: '5678', confirm_pin: '5678' });
    assert(
      withWrongCurrentPin.status === 403,
      `reset with an existing PIN rejects incorrect current proof (got ${withWrongCurrentPin.status})`,
    );
    assert(
      verifyMasterPin('1234'),
      'a rejected reset with incorrect proof leaves the existing PIN unchanged',
    );
    resetMasterPin('1234');

    const withCurrentPin = await request(app)
      .post('/api/db-tools/master-pin/reset')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', pin: '5678', confirm_pin: '5678' });
    assert(
      withCurrentPin.status === 200,
      `reset with the correct current PIN succeeds (got ${withCurrentPin.status})`,
    );
    assert(verifyMasterPin('5678'), 'authorized reset stores the new PIN');
    assert(!verifyMasterPin('1234'), 'authorized reset invalidates the old PIN');
    resetMasterPin('1234');

    fs.unlinkSync(path.join(testDir, 'master-pin.enc'));
    assert(!isMasterPinSet(), 'the first-time setup control starts with no configured PIN');
    const firstTimeSetup = await request(app)
      .post('/api/db-tools/master-pin/reset')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: '5678', confirm_pin: '5678' });
    assert(
      firstTimeSetup.status === 200,
      `first-time PIN setup succeeds without existing-PIN proof (got ${firstTimeSetup.status})`,
    );
    assert(verifyMasterPin('5678'), 'first-time PIN setup stores the PIN');
    resetMasterPin('1234');
  }

  await new Promise<void>((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const stalledDownload = request(downloadServer)
    .get('/api/db/download')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('x-test-stall-download', '1')
    .send({ master_pin: '1234' });
  void stalledDownload.then(
    () => undefined,
    () => undefined,
  );
  await stalledDownloadStartedPromise;
  cancelHttpShutdownWork();
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    stalledDownloadDestroyed,
    'database download destroys its response when HTTP shutdown cancels the request',
  );
  await closeHttpServer(downloadServer, 'database download stream test', 100);

  const unresolvedUserImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [],
          users: [],
          orders: [{ id: 'order-with-missing-user', user_id: 'missing-user' }],
        },
      },
    });
  assert(
    unresolvedUserImport.status === 400,
    `imports with unresolved redacted user references are rejected (got ${unresolvedUserImport.status})`,
  );
  assert(
    unresolvedUserImport.body.error?.includes('user accounts'),
    'unresolved user import explains the required staff setup',
  );

  const redactedUserImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [],
          users: [
            { id: 'redacted-user-1', name: 'Imported Redacted User', role: 'server', is_active: 1 },
          ],
          orders: [{ id: 1001, order_number: 'ORD-REDACTED-USER-001', user_id: 'redacted-user-1' }],
        },
      },
    });
  assert(
    redactedUserImport.status === 200,
    `redacted exported users are restored as placeholders (got ${redactedUserImport.status}, ${JSON.stringify(redactedUserImport.body)})`,
  );
  assert(
    redactedUserImport.body.placeholderUsersCreated === 1,
    'import reports one placeholder user created',
  );
  const placeholderUser = db
    .prepare(
      "SELECT name, role, is_active, password, email FROM users WHERE id = 'redacted-user-1'",
    )
    .get() as
    | { name: string; role: string; is_active: number; password: string; email: string | null }
    | undefined;
  assert(
    placeholderUser?.name === 'Imported Redacted User',
    'placeholder user preserves display name',
  );
  assert(placeholderUser?.role === 'server', 'placeholder user preserves role');
  assert(placeholderUser?.is_active === 0, 'placeholder user is inactive');
  assert(placeholderUser?.email == null, 'placeholder user does not reserve the exported email');
  assert(
    placeholderUser?.password !== '[REDACTED]',
    'placeholder user does not use the redaction marker as a password',
  );

  // Redacted export fields must never become literal credentials on import.
  db.prepare(
    "INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('stale-import-category', 'Stale', 99)",
  ).run();
  const jwtSecretBefore = db
    .prepare("SELECT value FROM settings WHERE key = 'jwt_secret'")
    .get() as { value: string } | undefined;
  const redactedImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
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
  assert(
    redactedImport.status === 200,
    `redacted settings import returns 200 (got ${redactedImport.status}, ${JSON.stringify(redactedImport.body)})`,
  );
  assert(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM categories WHERE id = 'stale-import-category'")
        .get() as { count: number }
    ).count === 0,
    'overwrite import clears tables explicitly present as empty',
  );
  const jwtSecretAfter = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as
    | { value: string }
    | undefined;
  assert(
    (jwtSecretAfter?.value ?? null) === (jwtSecretBefore?.value ?? null),
    'redacted jwt_secret is preserved during import',
  );

  db.prepare('INSERT INTO products (id, name, price, stock_quantity) VALUES (?, ?, ?, ?)').run(
    'existing-stock-product',
    'Existing Stock Product',
    10,
    5,
  );
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
  `).run(
    'existing-stock-product',
    5,
    'existing-stock-product',
    'Opening count',
    'owner-1',
    5,
    now(),
  );
  const zeroResetImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'existing-stock-product',
              name: 'Existing Stock Product',
              price: 10,
              stock_quantity: 0,
            },
          ],
          inventory_movements: [],
          users: [],
        },
      },
    });
  assert(
    zeroResetImport.status === 400,
    `overwrite imports reject unaudited stock resets (got ${zeroResetImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT stock_quantity FROM products WHERE id = ?')
        .get('existing-stock-product') as { stock_quantity: number }
    ).stock_quantity,
    5,
    'rejected stock reset preserves the existing cache',
  );
  assertEqual(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?')
        .get('existing-stock-product') as { count: number }
    ).count,
    1,
    'rejected stock reset preserves movement history',
  );

  db.prepare('INSERT INTO products (id, name, price, stock_quantity) VALUES (?, ?, ?, ?)').run(
    'zero-stock-history-product',
    'Zero Stock History Product',
    10,
    0,
  );
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
  `).run(
    'zero-stock-history-product',
    1,
    'zero-stock-history-product',
    'Opening count',
    'owner-1',
    1,
    now(),
  );
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'sale', 'order_item', ?, ?, ?, ?, ?)
  `).run(
    'zero-stock-history-product',
    -1,
    'zero-stock-history-order-item',
    null,
    'owner-1',
    0,
    now(),
  );
  const historyDeletionImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'zero-stock-history-product',
              name: 'Zero Stock History Product',
              price: 10,
              stock_quantity: 0,
            },
          ],
          inventory_movements: [],
          users: [],
        },
      },
    });
  assert(
    historyDeletionImport.status === 400,
    `overwrite imports reject ledger history deletion (got ${historyDeletionImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?')
        .get('zero-stock-history-product') as { count: number }
    ).count,
    2,
    'rejected zero-stock replacement preserves all movement history',
  );
  const partialHistoryDeletionImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'zero-stock-history-product',
              name: 'Zero Stock History Product',
              price: 10,
              stock_quantity: 1,
            },
          ],
          inventory_movements: [
            {
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
            },
          ],
          users: [],
        },
      },
    });
  assert(
    partialHistoryDeletionImport.status === 400,
    `overwrite imports reject partial ledger history replacement (got ${partialHistoryDeletionImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT stock_quantity FROM products WHERE id = ?')
        .get('zero-stock-history-product') as { stock_quantity: number }
    ).stock_quantity,
    0,
    'rejected partial replacement preserves the stock cache',
  );
  const emptyHistoryDeletionImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
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
  assert(
    emptyHistoryDeletionImport.status === 400,
    `empty overwrite imports reject ledger history deletion (got ${emptyHistoryDeletionImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?')
        .get('zero-stock-history-product') as { count: number }
    ).count,
    2,
    'empty rejected replacement preserves all movement history',
  );
  const malformedProductsImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
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
  assert(
    malformedProductsImport.status === 400,
    `malformed products tables are rejected (got ${malformedProductsImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?')
        .get('zero-stock-history-product') as { count: number }
    ).count,
    2,
    'malformed products import preserves movement history',
  );
  db.prepare('DELETE FROM inventory_movements WHERE product_id IN (?, ?)').run(
    'existing-stock-product',
    'zero-stock-history-product',
  );
  db.prepare('DELETE FROM products WHERE id IN (?, ?)').run(
    'existing-stock-product',
    'zero-stock-history-product',
  );

  const legacyZeroStockImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion() - 1),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'legacy-zero-stock-product',
              name: 'Legacy Zero Stock Product',
              price: 10,
              stock_quantity: 0,
            },
          ],
          users: [],
        },
      },
    });
  assert(
    legacyZeroStockImport.status === 200,
    `legacy zero-stock imports without movement history are accepted (got ${legacyZeroStockImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT stock_quantity FROM products WHERE id = ?')
        .get('legacy-zero-stock-product') as { stock_quantity: number }
    ).stock_quantity,
    0,
    'legacy zero-stock import preserves the zero cache',
  );
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
  `).run(
    'legacy-zero-stock-product',
    1,
    'legacy-zero-stock-product',
    'Legacy opening',
    'owner-1',
    1,
    now(),
  );
  db.prepare(`
    INSERT INTO inventory_movements (
      product_id, quantity_delta, movement_type, reference_type, reference_id,
      reason, actor_user_id, stock_after, created_at
    ) VALUES (?, ?, 'sale', 'order_item', ?, ?, ?, ?, ?)
  `).run(
    'legacy-zero-stock-product',
    -1,
    'legacy-zero-stock-order-item',
    'Legacy sale',
    'owner-1',
    0,
    now(),
  );
  const legacyZeroHistoryImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion() - 1),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'legacy-zero-stock-product',
              name: 'Legacy Zero Stock Product',
              price: 10,
              stock_quantity: 0,
            },
          ],
          users: [],
        },
      },
    });
  assert(
    legacyZeroHistoryImport.status === 200,
    `legacy zero-stock import preserves omitted-table history (got ${legacyZeroHistoryImport.status})`,
  );
  assertEqual(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?')
        .get('legacy-zero-stock-product') as { count: number }
    ).count,
    2,
    'legacy zero-stock import preserves existing movement history',
  );
  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run(
    'legacy-zero-stock-product',
  );
  db.prepare('DELETE FROM products WHERE id = ?').run('legacy-zero-stock-product');

  const remappedProvenanceImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: false,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            { id: 'provenance-product', name: 'Provenance Product', price: 10, stock_quantity: 5 },
          ],
          inventory_movements: [
            {
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
            },
          ],
          users: [],
        },
      },
    });
  assert(
    remappedProvenanceImport.status === 200,
    `movement provenance is remapped during import (got ${remappedProvenanceImport.status})`,
  );
  const remappedMovement = db
    .prepare(`
    SELECT actor_user_id, imported_by_user_id, source_actor_user_id
    FROM inventory_movements WHERE product_id = ?
  `)
    .get('provenance-product') as {
    actor_user_id: string;
    imported_by_user_id: string;
    source_actor_user_id: string;
  };
  assertEqual(
    remappedMovement.actor_user_id,
    'owner-1',
    'imported movement actor is authenticated locally',
  );
  assertEqual(
    remappedMovement.imported_by_user_id,
    'owner-1',
    'imported_by_user_id is authenticated locally',
  );
  assertEqual(
    remappedMovement.source_actor_user_id,
    'source-actor',
    'source actor provenance is preserved',
  );
  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run('provenance-product');
  db.prepare('DELETE FROM products WHERE id = ?').run('provenance-product');

  const incompleteInventoryImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion() - 1),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'incomplete-inventory-product',
              name: 'Incomplete Inventory Product',
              price: 10,
              stock_quantity: 7,
            },
          ],
          users: [],
        },
      },
    });
  assert(
    incompleteInventoryImport.status === 400,
    `product imports without movement history are rejected (got ${incompleteInventoryImport.status})`,
  );
  assert(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'incomplete-inventory-product'")
        .get() as { count: number }
    ).count === 0,
    'rejected product import leaves product data unchanged',
  );

  const emptyInventoryImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'empty-inventory-product',
              name: 'Empty Inventory Product',
              price: 10,
              stock_quantity: 7,
            },
          ],
          inventory_movements: [],
          users: [],
        },
      },
    });
  assert(
    emptyInventoryImport.status === 400,
    `product imports with missing movement history are rejected (got ${emptyInventoryImport.status})`,
  );
  assert(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'empty-inventory-product'")
        .get() as { count: number }
    ).count === 0,
    'rejected inconsistent product import leaves product data unchanged',
  );

  const sourceCreatedAt = '2020-01-01 00:00:00';
  const validInventoryImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'merged-state-product',
              name: 'Merged State Product',
              price: 10,
              stock_quantity: 5,
            },
          ],
          inventory_movements: [
            {
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
            },
          ],
          users: [],
        },
      },
    });
  assert(
    validInventoryImport.status === 200,
    `a consistent product import succeeds (got ${validInventoryImport.status})`,
  );
  const importedMovement = db
    .prepare(`
    SELECT actor_user_id, imported_by_user_id, import_batch_id,
           reference_type, reference_id, reason, created_at,
           source_actor_user_id, source_reference_type, source_reference_id,
           source_reason, source_created_at
    FROM inventory_movements WHERE product_id = ?
  `)
    .get('merged-state-product') as any;
  assertEqual(
    importedMovement.actor_user_id,
    'owner-1',
    'imported movement is attributed to the authenticated importer',
  );
  assertEqual(
    importedMovement.imported_by_user_id,
    'owner-1',
    'imported movement records the immutable importer identity',
  );
  assert(
    typeof importedMovement.import_batch_id === 'string' &&
      importedMovement.import_batch_id.length > 0,
    'imported movement records a batch provenance id',
  );
  assertEqual(
    importedMovement.reference_type,
    'import',
    'imported movement uses an import reference type',
  );
  assert(
    typeof importedMovement.reference_id === 'string' && importedMovement.reference_id.length > 0,
    'imported movement references its import batch',
  );
  assertEqual(
    importedMovement.reason,
    'Imported inventory movement',
    'imported movement uses a local audit reason',
  );
  assert(
    importedMovement.created_at !== sourceCreatedAt,
    'imported movement uses local ingestion time',
  );
  assertEqual(
    importedMovement.source_actor_user_id,
    'source-user-not-authenticated',
    'imported actor is retained as source metadata',
  );
  assertEqual(
    importedMovement.source_reference_type,
    'opening_balance',
    'imported reference type is retained as source metadata',
  );
  assertEqual(
    importedMovement.source_reference_id,
    'merged-state-product',
    'imported reference id is retained as source metadata',
  );
  assertEqual(
    importedMovement.source_reason,
    'Opening count',
    'imported reason is retained as source metadata',
  );
  assertEqual(
    importedMovement.source_created_at,
    sourceCreatedAt,
    'imported timestamp is retained as source metadata',
  );

  const mergedStateImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [],
          inventory_movements: [
            {
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
            },
          ],
          users: [],
        },
      },
    });
  assert(
    mergedStateImport.status === 500,
    `imports that leave the merged stock cache stale are rejected (got ${mergedStateImport.status})`,
  );
  assertEqual(
    db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('merged-state-product')
      .stock_quantity,
    5,
    'rejected merged-state import leaves the stock cache unchanged',
  );
  assertEqual(
    db
      .prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ?')
      .get('merged-state-product').count,
    1,
    'rejected merged-state import leaves movement history unchanged',
  );

  // A variant pool must survive the JSON round trip: dropping variant_id from
  // the movement tuple would silently re-attribute the movement to the product
  // pool and break the store's own ledger pre-check.
  const variantMovementImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'variant-import-product',
              name: 'Variant Import Product',
              price: 10,
              stock_quantity: 0,
            },
          ],
          product_variants: [
            {
              id: 'variant-import-variant',
              product_id: 'variant-import-product',
              name: 'Large',
              price: 10,
              track_inventory: 1,
              stock_quantity: 4,
              is_active: 1,
            },
            {
              id: 'variant-import-portioned',
              product_id: 'variant-import-product',
              name: 'Extra Large',
              price: 15,
              stock_quantity: 0,
              recipe_multiplier: 2,
            },
          ],
          inventory_movements: [
            {
              id: 1,
              product_id: 'variant-import-product',
              variant_id: 'variant-import-variant',
              quantity_delta: 4,
              movement_type: 'adjustment',
              reference_type: 'opening_balance',
              reference_id: 'variant-import-variant',
              reason: 'Opening count',
              actor_user_id: 'source-user-not-authenticated',
              stock_after: 4,
              created_at: sourceCreatedAt,
            },
          ],
          users: [],
        },
      },
    });
  assert(
    variantMovementImport.status === 200,
    `an import carrying a variant movement succeeds (got ${variantMovementImport.status}, ${JSON.stringify(variantMovementImport.body)})`,
  );
  assertEqual(
    db
      .prepare('SELECT variant_id FROM inventory_movements WHERE product_id = ?')
      .get('variant-import-product').variant_id,
    'variant-import-variant',
    'an imported variant movement keeps its pool attribution',
  );
  assertEqual(
    db
      .prepare('SELECT recipe_multiplier FROM product_variants WHERE id = ?')
      .get('variant-import-variant').recipe_multiplier,
    1,
    'an older variant import without a recipe multiplier keeps the default portion',
  );
  assertEqual(
    db
      .prepare('SELECT recipe_multiplier FROM product_variants WHERE id = ?')
      .get('variant-import-portioned').recipe_multiplier,
    2,
    'a valid imported recipe multiplier is preserved',
  );
  assertEqual(
    validateInventoryLedgerDatabase(db),
    null,
    'the store validates against the ledger pre-check after a variant movement import',
  );
  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run('variant-import-product');
  db.prepare('DELETE FROM product_variants WHERE product_id = ?').run('variant-import-product');
  db.prepare('DELETE FROM products WHERE id = ?').run('variant-import-product');

  db.prepare('INSERT INTO products (id, name, price, stock_quantity) VALUES (?, ?, ?, ?)').run(
    'invalid-variant-import-product',
    'Invalid Variant Import Product',
    10,
    0,
  );
  const invalidRecipeMultiplierImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [],
          product_variants: [
            {
              id: 'invalid-variant-import-variant',
              product_id: 'invalid-variant-import-product',
              name: 'Invalid Portion',
              price: 10,
              recipe_multiplier: 'half',
            },
          ],
          users: [],
        },
      },
    });
  assertEqual(
    invalidRecipeMultiplierImport.status,
    400,
    'variant imports reject nonnumeric recipe multipliers',
  );
  assertEqual(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM product_variants WHERE id = ?')
        .get('invalid-variant-import-variant') as { count: number }
    ).count,
    0,
    'a rejected variant import does not persist the invalid multiplier',
  );
  db.prepare('DELETE FROM products WHERE id = ?').run('invalid-variant-import-product');

  db.prepare('DELETE FROM inventory_movements WHERE product_id = ?').run('merged-state-product');
  db.prepare('DELETE FROM products WHERE id = ?').run('merged-state-product');

  const partialBaselineImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'partial-baseline-product',
              name: 'Partial Baseline Product',
              price: 10,
              stock_quantity: 7,
            },
          ],
          inventory_movements: [
            {
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
            },
          ],
          users: [],
        },
      },
    });
  assert(
    partialBaselineImport.status === 400,
    `imports without an opening baseline are rejected (got ${partialBaselineImport.status})`,
  );

  const saleSignImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            { id: 'sale-sign-product', name: 'Sale Sign Product', price: 10, stock_quantity: 6 },
          ],
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
  assert(
    saleSignImport.status === 400,
    `sale movements with positive deltas are rejected (got ${saleSignImport.status})`,
  );

  const brokenInventoryChainImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [],
          categories: [],
          products: [
            {
              id: 'broken-chain-product',
              name: 'Broken Chain Product',
              price: 10,
              stock_quantity: 3,
            },
          ],
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
  assert(
    brokenInventoryChainImport.status === 400,
    `imports with broken movement chains are rejected (got ${brokenInventoryChainImport.status})`,
  );
  assert(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'broken-chain-product'")
        .get() as { count: number }
    ).count === 0,
    'rejected broken-chain import leaves product data unchanged',
  );

  const largeJsonImport = await request(app)
    .post('/api/db/import')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      master_pin: '1234',
      overwrite: true,
      data: {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [
            {
              key: 'json_large_import_probe',
              value: 'x'.repeat(2 * 1024 * 1024),
              updated_at: now(),
            },
          ],
          categories: [],
          products: [],
          inventory_movements: [],
          users: [],
        },
      },
    });
  assert(
    largeJsonImport.status === 200,
    `multi-megabyte JSON imports are accepted (got ${largeJsonImport.status}, ${JSON.stringify(largeJsonImport.body).slice(0, 200)})`,
  );

  // ── Test 2: health-check is owner-gated, not PIN-gated ──────────────────
  console.log('\nTest 2: GET /db-tools/health-check');
  {
    const forbidden = await request(app)
      .get('/api/db-tools/health-check')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(forbidden.status === 403, `non-owner is forbidden (got ${forbidden.status})`);

    const ok = await request(app)
      .get('/api/db-tools/health-check')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(ok.status === 200, `owner gets 200 (got ${ok.status})`);
    assert(Array.isArray(ok.body.findings), 'response has a findings array');
    assert(typeof ok.body.summary?.safeCount === 'number', 'response has a summary.safeCount');
  }

  // ── Test 3: POST /db/backup requires the master PIN ─────────────────────
  console.log('\nTest 3: POST /db/backup is master-PIN gated');
  {
    const noPin = await request(app)
      .post('/api/db/backup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    assert(noPin.status === 403, `backup without a PIN is rejected (got ${noPin.status})`);

    const wrongPin = await request(app)
      .post('/api/db/backup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '0000' });
    assert(
      wrongPin.status === 403,
      `backup with the wrong PIN is rejected (got ${wrongPin.status})`,
    );

    const ok = await request(app)
      .post('/api/db/backup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234' });
    assert(
      ok.status === 200,
      `backup with the correct PIN succeeds (got ${ok.status}, ${JSON.stringify(ok.body)})`,
    );
    const backupFiles = fs
      .readdirSync(path.join(testDir, 'backups'))
      .filter((f: string) => f.endsWith('.db'));
    assert(backupFiles.length > 0, 'a backup file was actually written to the backups directory');
  }

  // ── Test 3b: GET /db-tools/backups lists what was just created (#120) ───
  console.log('\nTest 3b: GET /db-tools/backups');
  {
    const forbidden = await request(app)
      .get('/api/db-tools/backups')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert(forbidden.status === 403, `non-owner is forbidden (got ${forbidden.status})`);

    const ok = await request(app)
      .get('/api/db-tools/backups')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(ok.status === 200, `owner gets 200 (got ${ok.status})`);
    assert(Array.isArray(ok.body.backups), 'response has a backups array');
    assert(ok.body.backups.length >= 1, 'the backup created in Test 3 is listed');

    const entry = ok.body.backups[0];
    assert(
      typeof entry.fileName === 'string' && entry.fileName.endsWith('.db'),
      'entry has a .db fileName',
    );
    assert(
      typeof entry.sizeBytes === 'number' && entry.sizeBytes > 0,
      'entry has a positive sizeBytes',
    );
    assert(!Number.isNaN(new Date(entry.createdAt).getTime()), 'entry has a parseable createdAt');
    assert(
      entry.kind === 'manual',
      'a backup created via POST /db/backup is classified as manual, not auto',
    );
  }

  // ── Test 3b2: POST /db-tools/apply-safe-fixes validates its payload ─────
  console.log('\nTest 3b2: POST /db-tools/apply-safe-fixes payload validation');
  {
    const nonArray = await request(app)
      .post('/api/db-tools/apply-safe-fixes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ findingIds: 'not-an-array' });
    assert(nonArray.status === 400, `non-array findingIds is rejected (got ${nonArray.status})`);
    assert(
      nonArray.body.error?.includes('findingIds'),
      'the error explains the findingIds shape requirement',
    );

    const nonStringElement = await request(app)
      .post('/api/db-tools/apply-safe-fixes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ findingIds: [123] });
    assert(
      nonStringElement.status === 400,
      `non-string findingIds element is rejected (got ${nonStringElement.status})`,
    );

    const emptyArray = await request(app)
      .post('/api/db-tools/apply-safe-fixes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ findingIds: [] });
    assert(
      emptyArray.status === 200,
      `empty findingIds array is accepted (got ${emptyArray.status})`,
    );
  }

  // ── Test 3b3: POST /db-tools/backups/:fileName/delete maps failures to accurate status codes ──
  console.log('\nTest 3b3: POST /db-tools/backups/:fileName/delete status codes');
  {
    const invalidName = await request(app)
      .post('/api/db-tools/backups/not-a-backup.txt/delete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234' });
    assert(
      invalidName.status === 400,
      `invalid backup name returns 400 (got ${invalidName.status})`,
    );

    const notFound = await request(app)
      .post('/api/db-tools/backups/flo-backup-missing-00000000.db/delete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234' });
    assert(notFound.status === 404, `missing backup returns 404 (got ${notFound.status})`);

    const list = await request(app)
      .get('/api/db-tools/backups')
      .set('Authorization', `Bearer ${ownerToken}`);
    const fileName = list.body.backups[0]?.fileName;
    assert(typeof fileName === 'string', 'a backup exists to delete');
    const okDelete = await request(app)
      .post(`/api/db-tools/backups/${encodeURIComponent(fileName)}/delete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234' });
    assert(
      okDelete.status === 200,
      `deleting an existing backup returns 200 (got ${okDelete.status})`,
    );
  }

  console.log('\nTest 3b4: GET /db-tools/backups cursor pagination');
  {
    const backupsDir = path.join(testDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    for (const existing of fs.readdirSync(backupsDir)) {
      if (existing.endsWith('.db')) fs.unlinkSync(path.join(backupsDir, existing));
    }

    const baseTimeMs = Date.parse('2026-03-01T12:00:00.000Z');
    const createdFiles: string[] = [];
    const liveDbPath = path.join(testDir, 'flo.db');
    for (let i = 1; i <= 16; i += 1) {
      const padded = String(i).padStart(2, '0');
      const kind = i % 2 === 0 ? 'manual' : 'auto';
      const name = `flo-backup-${kind}-2026-03-01T12-00-${padded}-000Z.db`;
      const fullPath = path.join(backupsDir, name);
      fs.copyFileSync(liveDbPath, fullPath);
      const mtimeSeconds =
        i === 11 || i === 12 ? new Date(baseTimeMs + 11 * 1000) : new Date(baseTimeMs + i * 1000);
      fs.utimesSync(fullPath, mtimeSeconds, mtimeSeconds);
      createdFiles.push(fullPath);
    }

    try {
      readonlyBackupProbes = 0;
      const page1 = await request(app)
        .get('/api/db-tools/backups?limit=5')
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(page1.status, 200, 'initial limit=5 page returns 200');
      assertEqual(page1.body.backups?.length, 5, 'initial page returns 5 newest local backups');
      assertEqual(page1.body.hasMore, true, 'initial page reports hasMore: true');
      assert(
        typeof page1.body.nextCursor === 'string' && page1.body.nextCursor.length > 0,
        'initial page returns a nextCursor',
      );
      assertEqual(
        readonlyBackupProbes,
        5,
        'initial limit=5 page probes schema version only for the 5 returned backups',
      );
      assertEqual(
        page1.body.backups[0]?.fileName,
        'flo-backup-manual-2026-03-01T12-00-16-000Z.db',
        'newest backup is first on page 1',
      );
      assertEqual(
        page1.body.backups[4]?.fileName,
        'flo-backup-manual-2026-03-01T12-00-12-000Z.db',
        'tie-broken higher fileName is 5th on page 1',
      );

      readonlyBackupProbes = 0;
      const page2 = await request(app)
        .get(`/api/db-tools/backups?limit=10&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(page2.status, 200, 'second limit=10 page returns 200');
      assertEqual(page2.body.backups?.length, 10, 'second page returns next 10 older backups');
      assertEqual(page2.body.hasMore, true, 'second page reports hasMore: true');
      assert(
        typeof page2.body.nextCursor === 'string' && page2.body.nextCursor.length > 0,
        'second page returns a nextCursor',
      );
      assertEqual(
        readonlyBackupProbes,
        10,
        'second limit=10 page probes schema version only for the 10 returned backups',
      );
      assertEqual(
        page2.body.backups[0]?.fileName,
        'flo-backup-auto-2026-03-01T12-00-11-000Z.db',
        'tie-broken lower fileName with identical timestamp starts page 2 without gap or duplicate',
      );

      const page3 = await request(app)
        .get(`/api/db-tools/backups?limit=10&cursor=${encodeURIComponent(page2.body.nextCursor)}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(page3.status, 200, 'final page returns 200');
      assertEqual(page3.body.backups?.length, 1, 'final page returns remaining 1 backup');
      assertEqual(page3.body.hasMore, false, 'final page reports hasMore: false');
      assertEqual(page3.body.nextCursor, null, 'final page reports nextCursor: null');

      const combinedNames = [
        ...(page1.body.backups || []),
        ...(page2.body.backups || []),
        ...(page3.body.backups || []),
      ].map((entry: { fileName: string }) => entry.fileName);
      assertEqual(combinedNames.length, 16, 'paginated walk visits all 16 backups');
      assertEqual(new Set(combinedNames).size, 16, 'paginated walk has zero duplicates');

      const unpaginated = await request(app)
        .get('/api/db-tools/backups')
        .set('Authorization', `Bearer ${ownerToken}`);
      assertEqual(unpaginated.status, 200, 'unpaginated request returns 200');
      assertEqual(
        unpaginated.body.backups?.length,
        16,
        'unpaginated request returns all 16 backups',
      );
      assertEqual(unpaginated.body.hasMore, false, 'unpaginated request reports hasMore: false');
      assertEqual(
        unpaginated.body.nextCursor,
        null,
        'unpaginated request reports nextCursor: null',
      );
      assertEqual(
        JSON.stringify(combinedNames),
        JSON.stringify(unpaginated.body.backups.map((b: { fileName: string }) => b.fileName)),
        'paginated order matches full newest-first order',
      );

      for (const badQuery of [
        'limit=0',
        'limit=-3',
        'limit=abc',
        'limit=1.5',
        'limit=5&cursor=not-valid-cursor',
        `limit=5&cursor=${Buffer.from('{}').toString('base64url')}`,
        `limit=5&cursor=${Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'flo-backup-manual-1.db' })).toString('base64url')}`,
      ]) {
        const badRes = await request(app)
          .get(`/api/db-tools/backups?${badQuery}`)
          .set('Authorization', `Bearer ${ownerToken}`);
        assertEqual(badRes.status, 400, `invalid query "${badQuery}" returns 400`);
      }
    } finally {
      for (const filePath of createdFiles) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
  }

  // ── Test 3c: schema-mismatch import requires the Master PIN (GHSA-xxv4-gm82-4639) ──
  console.log('\nTest 3c: POST /db/import destructive path is master-PIN gated');
  {
    const currentVersion = getCurrentSchemaVersion();
    const emptyPayload = { settings: [], categories: [], products: [], users: [] };
    const importWithoutPin = (payload: Record<string, unknown>) =>
      request(app)
        .post('/api/db/import')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ overwrite: false, data: payload });

    db.prepare(
      "INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('ghsa-sentinel', 'Sentinel', 999)",
    ).run();
    const sentinelCount = () =>
      (
        db.prepare("SELECT COUNT(*) AS c FROM categories WHERE id = 'ghsa-sentinel'").get() as {
          c: number;
        }
      ).c;

    // GET /api/db-tools/master-pin/status exposes live schemaVersion alongside availability
    const pinStatus = await request(app)
      .get('/api/db-tools/master-pin/status')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(pinStatus.status === 200, `master-pin status returns 200 (got ${pinStatus.status})`);
    assert(pinStatus.body.available === true, 'master-pin status reports available: true');
    assert(pinStatus.body.isSet === true, 'master-pin status reports isSet: true');
    assert(
      pinStatus.body.schemaVersion === currentVersion,
      `master-pin status includes live schemaVersion (got ${pinStatus.body.schemaVersion}, expected ${currentVersion})`,
    );

    // Mismatched (future) schema version, no PIN → rejected and DB unchanged.
    const futureNoPin = await importWithoutPin({
      schema_version: String(currentVersion + 1),
      data: emptyPayload,
    });
    assert(
      futureNoPin.status === 403,
      `future schema_version import without a PIN is rejected (got ${futureNoPin.status})`,
    );
    assert(sentinelCount() === 1, 'rejected schema-mismatch import leaves the database unchanged');

    // Mismatched schema version with wrong PIN → rejected and DB unchanged.
    const mismatchedWrongPin = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        master_pin: '0000',
        data: { schema_version: String(currentVersion + 1), data: emptyPayload },
      });
    assert(
      mismatchedWrongPin.status === 403,
      `mismatched schema_version with wrong PIN is rejected (got ${mismatchedWrongPin.status})`,
    );
    assert(
      sentinelCount() === 1,
      'rejected wrong-PIN schema-mismatch import leaves the database unchanged',
    );

    // Fresh install (schema version 0), no PIN → rejected.
    const freshZeroNoPin = await importWithoutPin({ schema_version: '0', data: emptyPayload });
    assert(
      freshZeroNoPin.status === 403,
      `fresh schema_version 0 import without a PIN is rejected (got ${freshZeroNoPin.status})`,
    );

    // Old (upgrade-path) schema version, no PIN → rejected.
    const oldNoPin = await importWithoutPin({
      schema_version: String(currentVersion - 1),
      data: emptyPayload,
    });
    assert(
      oldNoPin.status === 403,
      `old-schema (upgrade-path) import without a PIN is rejected (got ${oldNoPin.status})`,
    );

    // Malformed schema version, no PIN → treated as destructive and rejected.
    const malformedNoPin = await importWithoutPin({
      schema_version: 'not-a-version',
      data: emptyPayload,
    });
    assert(
      malformedNoPin.status === 403,
      `malformed schema_version import without a PIN is rejected (got ${malformedNoPin.status})`,
    );

    // Omitted schema version, no PIN → defaults to 0 (a mismatch) and is rejected.
    const omittedNoPin = await importWithoutPin({ data: emptyPayload });
    assert(
      omittedNoPin.status === 403,
      `omitted schema_version import without a PIN is rejected (got ${omittedNoPin.status})`,
    );

    // Mismatched schema version with the correct PIN → allowed.
    const mismatchedWithPin = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        master_pin: '1234',
        data: { schema_version: String(currentVersion + 1), data: emptyPayload },
      });
    assert(
      mismatchedWithPin.status === 200,
      `schema-mismatch import with the correct PIN succeeds (got ${mismatchedWithPin.status}, ${JSON.stringify(mismatchedWithPin.body)})`,
    );

    // Matching schema version, no overwrite, no PIN → non-destructive merge, allowed.
    const matchingNoPin = await importWithoutPin({
      schema_version: String(currentVersion),
      data: emptyPayload,
    });
    assert(
      matchingNoPin.status === 200,
      `matching-schema import without overwrite needs no PIN (got ${matchingNoPin.status})`,
    );

    // Matching schema version + explicit overwrite, no PIN → still rejected.
    const matchingOverwriteNoPin = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: true,
        data: { schema_version: String(currentVersion), data: emptyPayload },
      });
    assert(
      matchingOverwriteNoPin.status === 403,
      `matching-schema overwrite import without a PIN is still rejected (got ${matchingOverwriteNoPin.status})`,
    );
  }

  // ── Test 3d: sequence repair on partial import without sequences table ──
  console.log(
    '\nTest 3d: POST /db/import repairs sequences when importing orders/bills without sequences',
  );
  {
    const insertSetting = (key: string, value: string) =>
      db
        .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, value, now());
    insertSetting('country', 'IN');
    insertSetting('currency', 'INR');
    insertSetting('timezone', 'Asia/Kolkata');

    const initialOrderNum = generateOrderNumber();
    const initialBillNum = generateBillNumber();
    const ordResult = db
      .prepare('INSERT INTO orders (order_number, created_at) VALUES (?, ?)')
      .run(initialOrderNum, now());
    const initialOrderId = ordResult.lastInsertRowid;
    db.prepare(
      'INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, total, paid_amount, balance, created_at) VALUES (?, ?, 100, 0, 100, 100, 0, ?)',
    ).run(initialOrderId, initialBillNum, now());

    const orderDate = initialOrderNum.split('-')[1];
    const billDate = initialBillNum.split('-')[1];

    const partialImport = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: {
            settings: [],
            categories: [],
            products: [],
            users: [],
            orders: [
              { id: 102, order_number: `ORD-${orderDate}-0002`, created_at: now() },
              { id: 103, order_number: `ORD-${orderDate}-0003`, created_at: now() },
              { id: 104, order_number: `ORD-${orderDate}-0004`, created_at: now() },
              { id: 105, order_number: `ORD-${orderDate}-0005`, created_at: now() },
            ],
            bills: [
              {
                id: 102,
                order_id: 102,
                bill_number: `INV-${billDate}-0002`,
                subtotal: 10,
                tax_amount: 0,
                total: 10,
                paid_amount: 10,
                balance: 0,
                created_at: now(),
              },
              {
                id: 103,
                order_id: 103,
                bill_number: `INV-${billDate}-0003`,
                subtotal: 10,
                tax_amount: 0,
                total: 10,
                paid_amount: 10,
                balance: 0,
                created_at: now(),
              },
              {
                id: 104,
                order_id: 104,
                bill_number: `INV-${billDate}-0004`,
                subtotal: 10,
                tax_amount: 0,
                total: 10,
                paid_amount: 10,
                balance: 0,
                created_at: now(),
              },
              {
                id: 105,
                order_id: 105,
                bill_number: `INV-${billDate}-0005`,
                subtotal: 10,
                tax_amount: 0,
                total: 10,
                paid_amount: 10,
                balance: 0,
                created_at: now(),
              },
            ],
          },
        },
      });

    assert(partialImport.status === 200, `partial import succeeds (got ${partialImport.status})`);

    const orderSeq = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = ?")
      .get(orderDate) as { current_value: number } | undefined;
    assertEqual(orderSeq?.current_value, 5, 'orders sequence counter advanced to 5 after import');

    const billSeq = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'bills' AND date = ?")
      .get(billDate) as { current_value: number } | undefined;
    assertEqual(billSeq?.current_value, 5, 'bills sequence counter advanced to 5 after import');

    const nextOrderNum = generateOrderNumber();
    assertEqual(nextOrderNum, `ORD-${orderDate}-0006`, 'next generated order number is 0006');
    let orderInsertThrew = false;
    try {
      db.prepare('INSERT INTO orders (order_number, created_at) VALUES (?, ?)').run(
        nextOrderNum,
        now(),
      );
    } catch {
      orderInsertThrew = true;
    }
    assert(!orderInsertThrew, 'creating next order succeeds without UNIQUE constraint failure');

    const nextBillNum = generateBillNumber();
    assertEqual(nextBillNum, `INV-${billDate}-0006`, 'next generated bill number is 0006');
    let billInsertThrew = false;
    try {
      db.prepare(
        'INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, total, paid_amount, balance, created_at) VALUES (105, ?, 10, 0, 10, 10, 0, ?)',
      ).run(nextBillNum, now());
    } catch {
      billInsertThrew = true;
    }
    assert(!billInsertThrew, 'creating next bill succeeds without UNIQUE constraint failure');

    // Simulate reopen fast-path
    const bootRepair = repairSequences(false);
    assertEqual(bootRepair.repaired, false, 'reopen fast-path skips historical scan');

    const nextOrderNumAfterReopen = generateOrderNumber();
    assertEqual(
      nextOrderNumAfterReopen,
      `ORD-${orderDate}-0007`,
      'next order number after reopen is 0007',
    );
    let orderReopenThrew = false;
    try {
      db.prepare('INSERT INTO orders (order_number, created_at) VALUES (?, ?)').run(
        nextOrderNumAfterReopen,
        now(),
      );
    } catch {
      orderReopenThrew = true;
    }
    assert(!orderReopenThrew, 'creating order after reopen succeeds');
  }

  // ── Test 3e: imported order FTS search after partial import ──
  console.log(
    '\nTest 3e: POST /db/import rebuilds FTS search index for partial orders/customer import',
  );
  {
    const partialFtsImport = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: {
            settings: [],
            categories: [],
            products: [],
            users: [],
            customers: [
              {
                id: 'cust-partial-fts-1',
                name: 'Arthur Pendelton',
                phone: '+15559876543',
                created_at: now(),
                updated_at: now(),
              },
            ],
            orders: [
              {
                id: 8801,
                order_number: 'ORD-PARTIAL-FTS-8801',
                customer_id: 'cust-partial-fts-1',
                type: 'takeaway',
                status: 'pending',
                subtotal: 50,
                total: 50,
                created_at: now(),
                updated_at: now(),
              },
            ],
          },
        },
      });

    assert(
      partialFtsImport.status === 200,
      `partial FTS import succeeds (got ${partialFtsImport.status}, ${JSON.stringify(partialFtsImport.body)})`,
    );

    // Verify search by order number
    const searchByOrder = await request(app)
      .get('/api/orders?search=PARTIAL-FTS')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchByOrder.status === 200,
      `search by order number succeeds (got ${searchByOrder.status})`,
    );
    const foundByOrder = searchByOrder.body.orders?.some(
      (o: any) => o.order_number === 'ORD-PARTIAL-FTS-8801',
    );
    assert(foundByOrder, 'newly imported order is immediately searchable by order number');

    // Verify search by customer name
    const searchByName = await request(app)
      .get('/api/orders?search=Pendelton')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchByName.status === 200,
      `search by customer name succeeds (got ${searchByName.status})`,
    );
    const foundByName = searchByName.body.orders?.some(
      (o: any) => o.order_number === 'ORD-PARTIAL-FTS-8801',
    );
    assert(foundByName, 'newly imported order is immediately searchable by customer name');

    // Verify search by customer phone digits
    const searchByPhone = await request(app)
      .get('/api/orders?search=9876543')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchByPhone.status === 200,
      `search by customer phone succeeds (got ${searchByPhone.status})`,
    );
    const foundByPhone = searchByPhone.body.orders?.some(
      (o: any) => o.order_number === 'ORD-PARTIAL-FTS-8801',
    );
    assert(foundByPhone, 'newly imported order is immediately searchable by customer phone');
  }

  // ── Test 3f: JSON import preserving durable append order under backward clock ──
  console.log(
    '\nTest 3f: POST /api/db/import preserving durable append order under backward clock',
  );
  {
    db.exec(`
      DELETE FROM order_item_addons;
      DELETE FROM order_items;
      DELETE FROM payment_transaction_refs;
      DELETE FROM bills;
      DELETE FROM orders;
      DELETE FROM inventory_movements;
      DELETE FROM product_variants;
      DELETE FROM products;
      DELETE FROM addons;
      DELETE FROM addon_groups;
      DELETE FROM categories;
    `);

    const clockImportRes = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: true,
        master_pin: '1234',
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: {
            settings: [],
            users: [],
            categories: [{ id: 'cat-imp-clock', name: 'Import Clock Cat' }],
            products: [
              {
                id: 'prod-imp-clock-1',
                category_id: 'cat-imp-clock',
                name: 'Clock Prod 1',
                price: 10,
                track_inventory: 1,
                stock_quantity: 8,
              },
            ],
            product_variants: [
              {
                id: 'var-imp-clock-1',
                product_id: 'prod-imp-clock-1',
                name: 'Clock Var 1',
                price: 12,
                track_inventory: 1,
                stock_quantity: 15,
              },
            ],
            addon_groups: [
              {
                id: 'ag-imp-clock',
                name: 'Clock AG',
                min_selection: 0,
                max_selection: 5,
                is_active: 1,
              },
            ],
            addons: [
              {
                id: 'addon-imp-clock-1',
                addon_group_id: 'ag-imp-clock',
                name: 'Clock Addon 1',
                price: 2,
                track_inventory: 1,
                stock_quantity: 27,
              },
            ],
            inventory_movements: [
              {
                id: 1,
                product_id: 'prod-imp-clock-1',
                quantity_delta: 10,
                stock_after: 10,
                movement_type: 'adjustment',
                created_at: '2026-10-21T12:00:00.000Z',
              },
              {
                id: 2,
                product_id: 'prod-imp-clock-1',
                quantity_delta: -2,
                stock_after: 8,
                movement_type: 'sale',
                created_at: '2026-10-21T11:59:00.000Z',
              },
              {
                id: 3,
                product_id: 'prod-imp-clock-1',
                variant_id: 'var-imp-clock-1',
                quantity_delta: 20,
                stock_after: 20,
                movement_type: 'adjustment',
                created_at: '2026-10-21T12:00:00.000Z',
              },
              {
                id: 4,
                product_id: 'prod-imp-clock-1',
                variant_id: 'var-imp-clock-1',
                quantity_delta: -5,
                stock_after: 15,
                movement_type: 'sale',
                created_at: '2026-10-21T11:59:00.000Z',
              },
              {
                id: 5,
                addon_id: 'addon-imp-clock-1',
                quantity_delta: 30,
                stock_after: 30,
                movement_type: 'adjustment',
                created_at: '2026-10-21T12:00:00.000Z',
              },
              {
                id: 6,
                addon_id: 'addon-imp-clock-1',
                quantity_delta: -3,
                stock_after: 27,
                movement_type: 'sale',
                created_at: '2026-10-21T11:59:00.000Z',
              },
            ],
          },
        },
      });

    assert(
      clockImportRes.status === 200,
      `clock import succeeds (got ${clockImportRes.status}, ${JSON.stringify(clockImportRes.body)})`,
    );

    const ledgerCheck = validateInventoryLedgerDatabase(db);
    assertEqual(
      ledgerCheck,
      null,
      'validateInventoryLedgerDatabase passes after clock rollback import',
    );

    const importedMovements = getInventoryMovementRows(db);
    assert(importedMovements.length === 6, 'all 6 movements imported in durable order');
    assert(
      importedMovements[0].source_created_at === '2026-10-21T12:00:00.000Z',
      'movement 1 source_created_at preserved',
    );
    assert(
      importedMovements[1].source_created_at === '2026-10-21T11:59:00.000Z',
      'movement 2 source_created_at preserved',
    );
  }

  // ── Test 3g: Schema 115 GET /export excludes FTS tables and phone_digits, POST /import round-trips ──
  console.log(
    '\nTest 3g: Schema 115 GET /export excludes FTS tables and phone_digits, POST /import round-trips',
  );
  {
    // Ensure jwt_secret exists in settings
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('jwt_secret', 'live-secret-test-3g', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now());

    // Ensure populated customer and order exist before export
    db.prepare(`
      INSERT OR REPLACE INTO customers (id, name, phone, created_at, updated_at)
      VALUES ('cust-roundtrip-89', 'Minerva McGonagall', '+15552345678', ?, ?)
    `).run(now(), now());

    db.prepare(`
      INSERT OR REPLACE INTO orders (id, order_number, customer_id, type, status, subtotal, total, created_at, updated_at)
      VALUES (8901, 'ORD-ROUNDTRIP-8901', 'cust-roundtrip-89', 'takeaway', 'pending', 65, 65, ?, ?)
    `).run(now(), now());

    const exportRes = await request(app)
      .get('/api/db/export')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(exportRes.status === 200, `GET /api/db/export returns 200 (got ${exportRes.status})`);

    const exportedTables = Object.keys(exportRes.body.data);
    const ftsTables = exportedTables.filter((t) => t.includes('fts'));
    assertEqual(ftsTables.length, 0, 'GET /export excludes all derived FTS and shadow tables');
    assert(!exportedTables.includes('_flo_meta'), 'GET /export excludes _flo_meta');
    assert(
      exportedTables.every((t) => !t.startsWith('sqlite_')),
      'GET /export excludes sqlite internal tables',
    );

    const exportedCustomers = exportRes.body.data.customers || [];
    const hasPhoneDigits = exportedCustomers.some((c: any) => 'phone_digits' in c);
    assert(
      !hasPhoneDigits,
      'GET /export excludes virtual generated column phone_digits from customers',
    );

    const exportedSettings = exportRes.body.data.settings || [];
    const jwtRow = exportedSettings.find((s: any) => s.key === 'jwt_secret');
    assertEqual(jwtRow?.value, '[REDACTED]', 'GET /export redacts jwt_secret');

    // Wipe existing live data so overwrite: true round-trip can restore populated products + inventory_movements
    db.exec(`
      DELETE FROM order_item_addons;
      DELETE FROM order_items;
      DELETE FROM payment_transaction_refs;
      DELETE FROM bills;
      DELETE FROM orders;
      DELETE FROM inventory_movements;
      DELETE FROM product_variants;
      DELETE FROM products;
      DELETE FROM addons;
      DELETE FROM addon_groups;
      DELETE FROM customers;
      DELETE FROM categories;
    `);

    const roundtripImportRes = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: true,
        master_pin: '1234',
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: exportRes.body.data,
        },
      });

    assert(
      roundtripImportRes.status === 200,
      `roundtrip import succeeds with overwrite: true (got ${roundtripImportRes.status}, ${JSON.stringify(roundtripImportRes.body)})`,
    );

    const liveJwtRow = db
      .prepare("SELECT value FROM settings WHERE key = 'jwt_secret'")
      .get() as any;
    assert(
      liveJwtRow && liveJwtRow.value === 'live-secret-test-3g',
      'jwt_secret was preserved during import and not overwritten with [REDACTED]',
    );

    // Verify search finds the imported order by order number, customer name, and customer phone digits
    const searchOrder = await request(app)
      .get('/api/orders?search=ROUNDTRIP-8901')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(searchOrder.status === 200, 'search by order number succeeds');
    assert(
      searchOrder.body.orders?.some((o: any) => o.order_number === 'ORD-ROUNDTRIP-8901'),
      'imported order found by order number',
    );

    const searchName = await request(app)
      .get('/api/orders?search=McGonagall')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(searchName.status === 200, 'search by customer name succeeds');
    assert(
      searchName.body.orders?.some((o: any) => o.order_number === 'ORD-ROUNDTRIP-8901'),
      'imported order found by customer name',
    );

    const searchPhone = await request(app)
      .get('/api/orders?search=2345678')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(searchPhone.status === 200, 'search by phone digits succeeds');
    assert(
      searchPhone.body.orders?.some((o: any) => o.order_number === 'ORD-ROUNDTRIP-8901'),
      'imported order found by customer phone digits',
    );
  }

  // ── Test 3h: Contaminated schema 115 export with shadow tables and phone_digits ──
  console.log(
    '\nTest 3h: Contaminated schema 115 export with shadow tables and phone_digits',
  );
  {
    const baseExportRes = await request(app)
      .get('/api/db/export')
      .set('Authorization', `Bearer ${ownerToken}`);

    const shadowTablesData = {
      orders_search_fts: [
        { rowid: 1, order_number: 'ORD-CONTAM-8902', customer_name: 'Luna Lovegood' },
      ],
      orders_search_fts_data: [{ id: 1, block: Buffer.from('fts block data') }],
      orders_search_fts_idx: [{ pgno: 1 }],
      orders_search_fts_config: [{ k: 'version', v: '1' }],
      orders_search_fts_docsize: [{ id: 1, sz: 1 }],
      customers_search_fts: [{ rowid: 1, name: 'Luna Lovegood' }],
      customers_search_fts_data: [{ id: 1, block: Buffer.from('fts block data') }],
      customers_search_fts_idx: [{ pgno: 1 }],
      customers_search_fts_config: [{ k: 'version', v: '1' }],
      customers_search_fts_docsize: [{ id: 1, sz: 1 }],
    };

    // Subtest 1: overwrite: false
    const contamNoOverwritePayload = {
      settings: [],
      categories: [],
      products: [],
      users: [],
      customers: [
        {
          id: 'cust-contam-1',
          name: 'Luna Lovegood',
          phone: '+15553456789',
          phone_digits: '15553456789',
          created_at: now(),
          updated_at: now(),
        },
      ],
      orders: [
        {
          id: 8902,
          order_number: 'ORD-CONTAM-8902',
          customer_id: 'cust-contam-1',
          type: 'takeaway',
          status: 'pending',
          subtotal: 30,
          total: 30,
          created_at: now(),
          updated_at: now(),
        },
      ],
      ...shadowTablesData,
    };

    const contamNoOverwriteRes = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: contamNoOverwritePayload,
        },
      });

    assert(
      contamNoOverwriteRes.status === 200,
      `contaminated import succeeds with overwrite: false (got ${contamNoOverwriteRes.status}, ${JSON.stringify(contamNoOverwriteRes.body)})`,
    );

    const searchContam = await request(app)
      .get('/api/orders?search=CONTAM-8902')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchContam.body.orders?.some((o: any) => o.order_number === 'ORD-CONTAM-8902'),
      'contaminated import order is searchable after overwrite: false',
    );

    // Subtest 2: overwrite: true
    // Clear inventory movements from live db first so overwrite is permitted
    db.exec('DELETE FROM inventory_movements;');
    const contamOverwritePayload = {
      ...baseExportRes.body.data,
      customers: [
        ...(baseExportRes.body.data.customers || []),
        {
          id: 'cust-contam-1',
          name: 'Luna Lovegood',
          phone: '+15553456789',
          phone_digits: '15553456789',
          created_at: now(),
          updated_at: now(),
        },
      ],
      orders: [
        ...(baseExportRes.body.data.orders || []),
        {
          id: 8902,
          order_number: 'ORD-CONTAM-8902',
          customer_id: 'cust-contam-1',
          type: 'takeaway',
          status: 'pending',
          subtotal: 30,
          total: 30,
          created_at: now(),
          updated_at: now(),
        },
      ],
      ...shadowTablesData,
    };

    const contamOverwriteRes = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: true,
        master_pin: '1234',
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: contamOverwritePayload,
        },
      });

    assert(
      contamOverwriteRes.status === 200,
      `contaminated import succeeds with overwrite: true (got ${contamOverwriteRes.status}, ${JSON.stringify(contamOverwriteRes.body)})`,
    );

    const searchContamOver = await request(app)
      .get('/api/orders?search=Lovegood')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchContamOver.body.orders?.some((o: any) => o.order_number === 'ORD-CONTAM-8902'),
      'contaminated import order is searchable after overwrite: true',
    );
  }

  // ── Test 3i: Historical schema 114 export -> schema 115 import ──
  console.log(
    '\nTest 3i: Historical schema 114 export -> schema 115 import succeeds and rebuilds search',
  );
  {
    const baseExportRes = await request(app)
      .get('/api/db/export')
      .set('Authorization', `Bearer ${ownerToken}`);

    // Clear live db movements so schema mismatch import (treated like overwrite) is permitted
    db.exec('DELETE FROM inventory_movements;');

    const v114Payload = {
      ...baseExportRes.body.data,
      customers: [
        ...(baseExportRes.body.data.customers || []),
        {
          id: 'cust-v114-fts',
          name: 'Albus Dumbledore',
          phone: '+15554567890',
          created_at: now(),
          updated_at: now(),
        },
      ],
      orders: [
        ...(baseExportRes.body.data.orders || []),
        {
          id: 9915,
          order_number: 'ORD-V114-FTS-9915',
          customer_id: 'cust-v114-fts',
          type: 'takeaway',
          status: 'pending',
          subtotal: 99,
          total: 99,
          created_at: now(),
          updated_at: now(),
        },
      ],
    };

    const v114ImportRes = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        master_pin: '1234',
        data: {
          schema_version: '114',
          data: v114Payload,
        },
      });

    assert(
      v114ImportRes.status === 200,
      `v114 export import succeeds (got ${v114ImportRes.status}, ${JSON.stringify(v114ImportRes.body)})`,
    );

    const searchV114 = await request(app)
      .get('/api/orders?search=V114-FTS-9915')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchV114.body.orders?.some((o: any) => o.order_number === 'ORD-V114-FTS-9915'),
      'v114 imported order found by order number',
    );

    const searchV114Name = await request(app)
      .get('/api/orders?search=Dumbledore')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert(
      searchV114Name.body.orders?.some((o: any) => o.order_number === 'ORD-V114-FTS-9915'),
      'v114 imported order found by customer name',
    );
  }

  // ── Test 3j: Rollback sentinel preservation on import error ──
  console.log('\nTest 3j: Rollback sentinel preservation on import error');
  {
    // Clean up any residual category from prior runs
    db.prepare("DELETE FROM categories WHERE id = 'sentinel-new-rollback-cat'").run();

    const badPayload = {
      settings: [],
      users: [],
      // Two rows with duplicate primary key triggers mid-transaction constraint failure
      categories: [
        { id: 'sentinel-new-rollback-cat', name: 'New Rollback Category 1', sort_order: 10 },
        { id: 'sentinel-new-rollback-cat', name: 'Duplicate Should Fail', sort_order: 11 },
      ],
      products: [
        {
          id: 'prod-rollback-chain',
          name: 'Rollback Chain Prod',
          price: 10,
          track_inventory: 1,
          stock_quantity: 10,
        },
      ],
      inventory_movements: [
        {
          id: 99999,
          product_id: 'prod-rollback-chain',
          quantity_delta: 10,
          stock_after: 10,
          movement_type: 'adjustment',
          created_at: now(),
        },
      ],
    };

    const failImportRes = await request(app)
      .post('/api/db/import')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        overwrite: false,
        data: {
          schema_version: String(getCurrentSchemaVersion()),
          data: badPayload,
        },
      });

    assert(
      failImportRes.status >= 400,
      `mid-transaction failure is rejected (got ${failImportRes.status})`,
    );

    const insertedCat = db
      .prepare("SELECT name FROM categories WHERE id = 'sentinel-new-rollback-cat'")
      .get() as any;
    assert(
      insertedCat === undefined,
      'newly inserted category was rolled back after mid-transaction failure',
    );

    const integrity = db.pragma('integrity_check', { simple: true });
    assertEqual(integrity, 'ok', 'PRAGMA integrity_check passes after rollback');

    const fkCheck = db.pragma('foreign_key_check') as any[];
    assertEqual(fkCheck.length, 0, 'PRAGMA foreign_key_check is clean after rollback');
  }

  // ── Test 4: POST /db-tools/initialize ────────────────────────────────────
  console.log('\nTest 4: POST /db-tools/initialize');
  {
    const wrongPhrase = await request(app)
      .post('/api/db-tools/initialize')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', confirmation_phrase: 'nope' });
    assert(
      wrongPhrase.status === 400,
      `wrong confirmation phrase is rejected (got ${wrongPhrase.status})`,
    );

    const wrongPin = await request(app)
      .post('/api/db-tools/initialize')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '0000', confirmation_phrase: 'INITIALIZE' });
    assert(
      wrongPin.status === 403,
      `wrong PIN is rejected even with the right phrase (got ${wrongPin.status})`,
    );

    const ok = await request(app)
      .post('/api/db-tools/initialize')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });
    assert(
      ok.status === 200,
      `initialize succeeds with correct PIN + phrase (got ${ok.status}, ${JSON.stringify(ok.body)})`,
    );
    assert(!!ok.body.backupPath, 'response includes the forced pre-wipe backup path');

    const freshDb = getDatabase();
    const userCount = (freshDb.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    assert(userCount === 0, 'no users remain after initialize — back to first-run state');
    assert(
      getCurrentSchemaVersion() === MIGRATIONS[MIGRATIONS.length - 1].version,
      'the recreated database is at the latest schema version',
    );

    // The core "locked-out owner" guarantee: the Master PIN survives a full DB wipe
    // because it lives outside flo.db entirely.
    assert(isMasterPinSet(), 'master-pin.enc still exists after the database was wiped');
    assert(
      verifyMasterPin('1234'),
      'the same Master PIN still verifies after the database was wiped',
    );
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

runTests();
