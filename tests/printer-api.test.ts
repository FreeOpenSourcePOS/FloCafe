/**
 * Printer API Tests (supertest)
 *
 * Exercises /api/printers and /api/kitchen-stations against the real Express
 * route handlers: default-printer invariant, update validation, omitted-vs-
 * explicit field handling, and printer identifier validation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/printer-api.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-api-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { printerRoutes } = require('../main/routes/printers');
const { kitchenStationRoutes } = require('../main/routes/kitchen-stations');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
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
  throw error;
}

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.user = { userId: 'owner-1', email: 'owner@flo.local', role: 'owner' };
  next();
});
app.use('/api/printers', printerRoutes);
app.use('/api/kitchen-stations', kitchenStationRoutes);

const db = getDatabase();

function defaultCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM printers WHERE is_default = 1').get() as { c: number }).c;
}

function defaultId(): string | undefined {
  const row = db.prepare('SELECT id FROM printers WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined;
  return row?.id;
}

async function runTests() {
  console.log('Printer API Tests (supertest)');
  console.log('='.repeat(50));

  // ── Test 1: first printer becomes the default automatically ────────────
  console.log('\nTest 1: first printer becomes default');
  {
    const res = await request(app).post('/api/printers').send({ name: 'Kitchen Printer', connection_type: 'usb' });
    assert(res.status === 201, `creating the first printer returns 201 (got ${res.status})`);
    assert(res.body.printer?.is_default === 1, 'the first printer is automatically the default');
    assert(defaultCount() === 1, 'exactly one default printer exists');
  }

  // ── Test 2: creating a second default clears the previous default ───────
  console.log('\nTest 2: a second default replaces the first');
  {
    const res = await request(app).post('/api/printers').send({ name: 'Receipt Printer', connection_type: 'usb', is_default: true });
    assert(res.status === 201, `creating a second printer returns 201 (got ${res.status})`);
    assert(res.body.printer?.is_default === 1, 'the explicitly-default printer is default');
    assert(defaultCount() === 1, 'exactly one default printer remains after a new default is created');
  }

  // ── Test 2b: concurrent default changes leave exactly one default ───────
  console.log('\nTest 2b: concurrent default changes leave exactly one default');
  {
    const ids = (db.prepare('SELECT id FROM printers ORDER BY name').all() as { id: string }[]).map((r) => r.id);
    await Promise.all(ids.map((id) =>
      request(app).post(`/api/printers/${id}/set-default`).then((r: any) => r.status),
    ));
    assert(defaultCount() === 1, 'concurrent set-default requests leave exactly one default');
  }

  // ── Test 3: PUT rejects invalid connection types and ports ──────────────
  console.log('\nTest 3: PUT validates connection_type and port');
  {
    const printerId = defaultId();
    const badType = await request(app).put(`/api/printers/${printerId}`).send({ connection_type: 'bluetooth' });
    assert(badType.status === 400, `invalid connection_type returns 400 (got ${badType.status})`);

    for (const badPort of [0, 65536, -1, 1.5, '9100']) {
      const res = await request(app).put(`/api/printers/${printerId}`).send({ port: badPort });
      assert(res.status === 400, `invalid port ${JSON.stringify(badPort)} returns 400 (got ${res.status})`);
    }

    const badDefault = await request(app).put(`/api/printers/${printerId}`).send({ is_default: 'yes' });
    assert(badDefault.status === 400, `non-boolean is_default returns 400 (got ${badDefault.status})`);
  }

  // ── Test 4: PUT keeps omitted fields, applies explicit values ───────────
  console.log('\nTest 4: PUT distinguishes omitted from explicit fields');
  {
    const printerId = defaultId();
    const before = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId) as any;
    const res = await request(app).put(`/api/printers/${printerId}`).send({ name: 'Renamed Printer' });
    assert(res.status === 200, `updating only the name returns 200 (got ${res.status})`);
    const after = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId) as any;
    assert(after.name === 'Renamed Printer', 'the explicit name is applied');
    assert(after.connection_type === before.connection_type, 'omitted connection_type keeps the existing value');
    assert(after.port === before.port, 'omitted port keeps the existing value');

    const clearIp = await request(app).put(`/api/printers/${printerId}`).send({ ip_address: null });
    assert(clearIp.status === 200, `explicit null ip_address is accepted (got ${clearIp.status})`);
    const afterClear = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId) as any;
    assert(afterClear.ip_address === null, 'explicit null ip_address clears the stored value');
  }

  // ── Test 5: unsetting the default picks a replacement ───────────────────
  console.log('\nTest 5: unsetting the default picks a replacement');
  {
    const currentDefault = defaultId();
    const res = await request(app).put(`/api/printers/${currentDefault}`).send({ is_default: false });
    assert(res.status === 200, `unsetting the default returns 200 (got ${res.status})`);
    assert(defaultCount() === 1, 'a replacement default is chosen');
    assert(defaultId() !== currentDefault, 'the replacement is a different printer');
  }

  // ── Test 6: deleting the default picks a replacement; deleting the only default is refused ──
  console.log('\nTest 6: deleting the default printer');
  {
    const currentDefault = defaultId();
    const res = await request(app).delete(`/api/printers/${currentDefault}`);
    assert(res.status === 200, `deleting the default with others returns 200 (got ${res.status})`);
    assert(defaultCount() === 1, 'a replacement default is chosen after deletion');

    // Reduce to a single printer and confirm it cannot be deleted.
    const all = db.prepare('SELECT id FROM printers').all() as { id: string }[];
    for (const printer of all.slice(1)) {
      await request(app).delete(`/api/printers/${printer.id}`);
    }
    const onlyDefault = defaultId();
    assert(onlyDefault !== undefined, 'one printer remains and is default');
    const refused = await request(app).delete(`/api/printers/${onlyDefault}`);
    assert(refused.status === 409, `deleting the only default printer is refused (got ${refused.status})`);
  }

  // ── Test 7: kitchen stations validate printer identifiers ───────────────
  console.log('\nTest 7: kitchen stations validate printer identifiers');
  {
    const printerId = defaultId();
    const emptyCreate = await request(app).post('/api/kitchen-stations').send({ name: 'Grill', printer_id: '' });
    assert(emptyCreate.status === 400, `create with empty printer_id returns 400 (got ${emptyCreate.status})`);

    const missingCreate = await request(app).post('/api/kitchen-stations').send({ name: 'Grill', printer_id: 'missing-printer' });
    assert(missingCreate.status === 400, `create with unknown printer_id returns 400 (got ${missingCreate.status})`);

    const okCreate = await request(app).post('/api/kitchen-stations').send({ name: 'Grill', printer_id: printerId });
    assert(okCreate.status === 201, `create with a valid printer_id returns 201 (got ${okCreate.status})`);
    const stationId = okCreate.body.kitchenStation.id;

    const emptyUpdate = await request(app).put(`/api/kitchen-stations/${stationId}`).send({ printer_id: '' });
    assert(emptyUpdate.status === 400, `update with empty printer_id returns 400 (got ${emptyUpdate.status})`);

    const clearUpdate = await request(app).put(`/api/kitchen-stations/${stationId}`).send({ printer_id: null });
    assert(clearUpdate.status === 200, `update with explicit null printer_id clears the assignment (got ${clearUpdate.status})`);
    const cleared = db.prepare('SELECT printer_id FROM kitchen_stations WHERE id = ?').get(stationId) as any;
    assert(cleared?.printer_id === null, 'the cleared station has a null printer_id');
  }

  // ── Test 8: print-bill preview fallback when no printer exists ──────────
  console.log('\nTest 8: print-bill preview fallback when 0 printers exist');
  {
    // Clear all printers directly to simulate zero-printer installation state
    db.prepare('DELETE FROM printers').run();

    // Create a dummy order, order item, and bill
    const orderRes = db.prepare(
      `INSERT INTO orders (order_number, status, type, subtotal, total, created_at, updated_at)
       VALUES ('ORD-PREVIEW-1', 'completed', 'dine_in', 100, 100, datetime('now'), datetime('now'))`
    ).run();
    const orderId = Number(orderRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
       VALUES (?, 'prod-preview-1', 'Espresso', 100, 1, 100, 100, datetime('now'), datetime('now'))`
    ).run(orderId);

    const billRes = db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
       VALUES ('BILL-PREVIEW-1', ?, 100, 100, 100, 'paid', datetime('now'), datetime('now'))`
    ).run(orderId);
    const billId = Number(billRes.lastInsertRowid);

    // Preview request should succeed with fallback 80mm preview format
    const previewRes = await request(app).post('/api/printers/print-bill').send({ billId, preview: true });
    assert(previewRes.status === 200, `preview generation with 0 printers succeeds (got ${previewRes.status})`);
    assert(previewRes.body.columns === 42 || previewRes.body.columns === 48, `preview generation returns valid 80mm columns (got ${previewRes.body.columns})`);
    assert(typeof previewRes.body.text === 'string' && previewRes.body.text.length > 0, 'preview contains formatted receipt text');

    // Real hardware print request without preview should still reject with 400
    const realPrintRes = await request(app).post('/api/printers/print-bill').send({ billId, preview: false });
    assert(realPrintRes.status === 400, `direct hardware print with 0 printers fails with 400 (got ${realPrintRes.status})`);
    assert(realPrintRes.body.error === 'No default printer configured. Add a printer in Settings.', 'proper error message returned');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch((error: Error) => {
  console.error(error);
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
