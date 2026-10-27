/**
 * Order and invoice numbering settings tests.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-numbering-settings.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-numbering-settings-'));
Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getName: () => 'flo-test',
        getVersion: () => '0.0.0-test',
      },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: class {},
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  closeDatabase,
  assertEqual,
  getResults,
  seedOwnerUser,
} = require('./helpers/test-setup');

async function main() {
  console.log('Test: Order and invoice numbering settings');
  console.log('='.repeat(50));

  const db = initTestDb();
  // requirePermission() resolves effective permissions from a real users row
  // keyed by req.user.userId — seed an active owner so settings checks pass.
  const owner = seedOwnerUser(db);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId: owner.userId, role: 'owner', name: 'Test Owner' };
    next();
  });
  const { settingsRoutes } = require('../main/routes/settings');
  app.use('/api/settings', settingsRoutes);

  try {
    console.log('\n1. GET /settings/order-numbering returns invoice defaults');
    const defaults = await request(app).get('/api/settings/order-numbering');
    assertEqual(defaults.status, 200, 'returns 200');
    assertEqual(defaults.body.invoice_number_prefix, 'INV', 'default invoice prefix is INV');
    assertEqual(
      defaults.body.invoice_number_include_period,
      true,
      'default invoice period is included',
    );
    assertEqual(
      defaults.body.invoice_number_reset_period,
      'daily',
      'default invoice reset is daily',
    );
    assertEqual(
      defaults.body.invoice_financial_year_start_month,
      4,
      'default FY start month is April',
    );
    assertEqual(defaults.body.invoice_financial_year_start_day, 1, 'default FY start day is 1');

    console.log('\n2. PUT /settings/order-numbering persists invoice numbering');
    const updated = await request(app).put('/api/settings/order-numbering').send({
      invoice_number_prefix: 'BILL',
      invoice_number_include_period: false,
      invoice_number_reset_period: 'financial_year',
      invoice_financial_year_start_month: 7,
      invoice_financial_year_start_day: 15,
    });
    assertEqual(updated.status, 200, 'returns 200');
    assertEqual(updated.body.invoice_number_prefix, 'BILL', 'invoice prefix updates');
    assertEqual(
      updated.body.invoice_number_include_period,
      true,
      'a resetting series always keeps its period',
    );
    assertEqual(
      updated.body.invoice_number_reset_period,
      'financial_year',
      'invoice reset period updates',
    );
    assertEqual(updated.body.invoice_financial_year_start_month, 7, 'FY month updates');
    assertEqual(updated.body.invoice_financial_year_start_day, 15, 'FY day updates');

    console.log('\n2b. Contradictory include flags are normalized and persisted');
    const dailyNoPeriod = await request(app).put('/api/settings/order-numbering').send({
      invoice_number_include_period: false,
      invoice_number_reset_period: 'daily',
      order_number_include_date: false,
      order_number_reset_daily: true,
    });
    assertEqual(
      dailyNoPeriod.body.invoice_number_include_period,
      true,
      'daily invoice series keeps its period',
    );
    assertEqual(
      dailyNoPeriod.body.order_number_include_date,
      true,
      'daily order series keeps its date',
    );
    const storedFlags = db
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('invoice_number_include_period', 'order_number_include_date')",
      )
      .all() as any[];
    assertEqual(
      storedFlags.every((r: any) => r.value === 'true'),
      true,
      'effective flags are stored, not the contradictory off',
    );

    const neverNoPeriod = await request(app).put('/api/settings/order-numbering').send({
      invoice_number_include_period: false,
      invoice_number_reset_period: 'never',
      order_number_include_date: false,
      order_number_reset_daily: false,
    });
    assertEqual(
      neverNoPeriod.body.invoice_number_include_period,
      false,
      'non-resetting invoice series may omit the period',
    );
    assertEqual(
      neverNoPeriod.body.order_number_include_date,
      false,
      'non-resetting order series may omit the date',
    );

    db.prepare(
      "UPDATE settings SET value = 'false' WHERE key IN ('invoice_number_include_period', 'order_number_include_date')",
    ).run();
    db.prepare(
      "UPDATE settings SET value = 'daily' WHERE key = 'invoice_number_reset_period'",
    ).run();
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'order_number_reset_daily'").run();
    const legacy = await request(app).get('/api/settings/order-numbering');
    assertEqual(
      legacy.body.invoice_number_include_period,
      true,
      'GET reports the effective period for legacy stored values',
    );
    assertEqual(
      legacy.body.order_number_include_date,
      true,
      'GET reports the effective date for legacy stored values',
    );

    console.log('\n3. PUT /settings/order-numbering rejects invalid invoice values');
    const badPrefix = await request(app)
      .put('/api/settings/order-numbering')
      .send({ invoice_number_prefix: 'TOO LONG PREFIX' });
    assertEqual(badPrefix.status, 400, 'rejects invalid invoice prefix');
    const dashPrefix = await request(app)
      .put('/api/settings/order-numbering')
      .send({ invoice_number_prefix: 'FAC-' });
    assertEqual(dashPrefix.status, 400, 'rejects invoice prefix containing a dash');
    const underscorePrefix = await request(app)
      .put('/api/settings/order-numbering')
      .send({ order_number_prefix: 'ORD_' });
    assertEqual(underscorePrefix.status, 400, 'rejects order prefix containing an underscore');
    const badPeriod = await request(app)
      .put('/api/settings/order-numbering')
      .send({ invoice_number_reset_period: 'quarterly' });
    assertEqual(badPeriod.status, 400, 'rejects invalid reset period');
    const badMonth = await request(app)
      .put('/api/settings/order-numbering')
      .send({ invoice_financial_year_start_month: 13 });
    assertEqual(badMonth.status, 400, 'rejects invalid FY month');
    const badDay = await request(app)
      .put('/api/settings/order-numbering')
      .send({ invoice_financial_year_start_day: 0 });
    assertEqual(badDay.status, 400, 'rejects invalid FY day');

    console.log('\n' + '='.repeat(50));
    const results = getResults();
    console.log(`Results: ${results.passed}/${results.total} passed, ${results.failed} failed`);
    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
