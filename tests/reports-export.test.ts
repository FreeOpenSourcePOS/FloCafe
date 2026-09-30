import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-export-'));
const menuChannels = new Set<string>();
let exposedApi: Record<string, any> | undefined;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, any>) => { exposedApi = api; } },
      ipcRenderer: {
        sendSync: () => undefined,
        invoke: () => Promise.resolve(),
        on: (channel: string) => { menuChannels.add(channel); },
        removeListener: (channel: string) => { menuChannels.delete(channel); },
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

require('../main/preload');
process.env.JWT_SECRET = 'test-secret-reports-export';

const { initTestDb, seedOwnerUser, createApp, startServer, closeDatabase } = require('./helpers/test-setup');
const { reportRoutes } = require('../main/routes/reports');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const request = require('supertest');
const ExcelJS = require('exceljs');

function parseBuffer(response: any, callback: (error: Error | null, body?: Buffer) => void): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function run(): Promise<void> {
  let server: any;
  try {
    assert.ok(exposedApi, 'preload exposes electronAPI');
    const unsubscribe = exposedApi!.onMenuAction(() => undefined);
    for (const channel of [
      'go-pos', 'go-dashboard', 'go-orders', 'go-kds', 'go-tables',
      'go-products', 'go-inventory', 'go-customers', 'go-staff',
    ]) {
      assert.ok(menuChannels.has(channel), `preload allows ${channel}`);
    }
    unsubscribe();

    const db = initTestDb();
    const owner = seedOwnerUser(db);
    db.prepare("UPDATE users SET name = '=Formula Staff' WHERE id = ?").run(owner.userId);

    const app = createApp({
      '/api/reports': reportRoutes,
      '/api/cash-closures': cashClosureRoutes,
    });
    ({ server } = await startServer(app));
    const http = request(server);
    const businessDate = '2026-09-25';
    const paidAt = new Date(`${businessDate}T12:00:00Z`).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, ?, 'takeaway', 'completed', 500, 500, ?, ?, ?)
    `).run('ORD-REPORT-EXPORT', owner.userId, paidAt, paidAt, paidAt);
    const orderId = Number((db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-REPORT-EXPORT') as any).id);
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, 500, 500, 500, 0, 'paid', ?, ?, ?, ?)
    `).run('B-REPORT-EXPORT', orderId, JSON.stringify([{ method: 'cash', amount: 500, timestamp: paidAt }]), paidAt, paidAt, paidAt);

    const auth = { Authorization: `Bearer ${owner.token}` };
    const xCsv = await http.get(`/api/reports/x-report/export?date=${businessDate}&format=csv`).set(auth);
    assert.equal(xCsv.status, 200, 'X report CSV returns 200');
    assert.match(xCsv.headers['content-type'], /text\/csv/);
    assert.ok(xCsv.headers['content-disposition'].includes(`x-report-${businessDate}.csv`));
    assert.ok(xCsv.text.includes('summary,Gross Sales,,,,500'));
    assert.ok(xCsv.text.includes("'=Formula Staff"), 'X report CSV neutralizes formula-like staff names');

    const xXlsx = await http.get(`/api/reports/x-report/export?date=${businessDate}&format=xlsx`).set(auth).buffer(true).parse(parseBuffer);
    assert.equal(xXlsx.status, 200, 'X report XLSX returns 200');
    assert.match(xXlsx.headers['content-type'], /spreadsheetml\.sheet/);
    const xWorkbook = new ExcelJS.Workbook();
    await xWorkbook.xlsx.load(xXlsx.body);
    assert.deepEqual(xWorkbook.worksheets.map((sheet: any) => sheet.name), ['Summary', 'Payments', 'Staff']);
    const xMetrics = new Map<string, unknown>();
    xWorkbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) xMetrics.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    assert.equal(xMetrics.get('Gross Sales'), 500);
    assert.equal(xMetrics.get('Bill Count'), 1);

    const unclosedZ = await http.get(`/api/reports/z-report/export?date=${businessDate}&format=csv`).set(auth);
    assert.equal(unclosedZ.status, 404, 'unclosed Z report returns 404');
    assert.equal(unclosedZ.body.error, 'Day not closed');

    const close = await http.post('/api/cash-closures').set(auth).send({
      business_date: businessDate,
      opening_float_cents: 10000,
      counted_cash_cents: 65000,
      notes: 'End of day',
    });
    assert.equal(close.status, 201, 'test day closes');
    assert.equal(close.body.zReport.expected_cash_cents, 60000);
    assert.equal(close.body.zReport.variance_cents, 5000);

    const zCsv = await http.get(`/api/reports/z-report/export?date=${businessDate}&format=csv`).set(auth);
    assert.equal(zCsv.status, 200, 'Z report CSV returns 200');
    assert.ok(zCsv.headers['content-disposition'].includes(`z-report-Z${close.body.zReport.z_number}-${businessDate}.csv`));
    assert.ok(zCsv.text.includes('Expected Cash in Drawer,,,,'), 'Z report CSV includes stored expected cash');
    assert.ok(zCsv.text.includes('Cash Variance'), 'Z report CSV includes cash variance');
    assert.ok(zCsv.text.includes('600'), 'Z report CSV includes expected cash in display units');
    assert.ok(zCsv.text.includes('50'), 'Z report CSV includes cash variance in display units');

    const zXlsx = await http.get(`/api/reports/z-report/export?date=${businessDate}&format=xlsx`).set(auth).buffer(true).parse(parseBuffer);
    assert.equal(zXlsx.status, 200, 'Z report XLSX returns 200');
    const zWorkbook = new ExcelJS.Workbook();
    await zWorkbook.xlsx.load(zXlsx.body);
    const zMetrics = new Map<string, unknown>();
    zWorkbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) zMetrics.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    assert.equal(zMetrics.get('Gross Sales'), 500);
    assert.equal(zMetrics.get('Expected Cash in Drawer'), 600);
    assert.equal(zMetrics.get('Counted Cash'), 650);
    assert.equal(zMetrics.get('Cash Variance'), 50);
    assert.equal(zMetrics.get('Closed By'), '=Formula Staff');

    console.log('reports-export tests passed');
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
