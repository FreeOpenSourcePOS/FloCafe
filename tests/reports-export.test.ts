import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-export-'));
const menuChannels = new Set<string>();
let exposedApi: Record<string, any> | undefined;

let lastLoadedHtmlPath = '';
let lastLoadedHtmlContent = '';

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

function unescapeHtml(value: string): string {
  return value.replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    class FakePrintWindow {
      webContents = {
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
        session: {
          webRequest: { onBeforeRequest: () => undefined },
        },
        printToPDF: async (opts?: Record<string, unknown>) =>
          Buffer.from(
            `%PDF-1.4\n%FloCafe test PDF pageSize=${String(opts?.pageSize ?? '')} preferCSSPageSize=${String(opts?.preferCSSPageSize ?? '')}\n${lastLoadedHtmlContent}\n%%EOF\n`,
          ),
      };
      async loadFile(filePath: string) {
        lastLoadedHtmlPath = filePath;
        assert.ok(fs.existsSync(filePath), 'staging HTML file exists during loadFile');
        lastLoadedHtmlContent = fs.readFileSync(filePath, 'utf8');
      }
      isDestroyed() {
        return false;
      }
      destroy() {}
    }
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      BrowserWindow: FakePrintWindow,
      contextBridge: {
        exposeInMainWorld: (_name: string, api: Record<string, any>) => {
          exposedApi = api;
        },
      },
      ipcRenderer: {
        sendSync: () => undefined,
        invoke: () => Promise.resolve(),
        on: (channel: string) => {
          menuChannels.add(channel);
        },
        removeListener: (channel: string) => {
          menuChannels.delete(channel);
        },
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

require('../main/preload');
process.env.JWT_SECRET = 'test-secret-reports-export';

const {
  initTestDb,
  seedOwnerUser,
  createApp,
  startServer,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const jwt = require('jsonwebtoken');
const { reportRoutes } = require('../main/routes/reports');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const { renderHtmlToPdfBuffer } = require('../main/services/html-to-pdf');
const request = require('supertest');
const ExcelJS = require('exceljs');

function parseHtmlSummaryMetrics(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<tr\s+data-section="summary"\s+data-metric="([^"]*)"\s+data-value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    map.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  return map;
}

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
      'go-pos',
      'go-dashboard',
      'go-orders',
      'go-kds',
      'go-tables',
      'go-products',
      'go-inventory',
      'go-customers',
      'go-staff',
    ]) {
      assert.ok(menuChannels.has(channel), `preload allows ${channel}`);
    }
    unsubscribe();

    const db = initTestDb();
    const owner = seedOwnerUser(db);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cashier-reports-export',
      'Cashier User',
      'cashier-export@flocafe.local',
      'hash',
      'cashier',
      1,
      now(),
      now(),
    );
    const cashier = {
      token: jwt.sign(
        {
          userId: 'cashier-reports-export',
          email: 'cashier-export@flocafe.local',
          role: 'cashier',
        },
        getJWTSecret(),
        { expiresIn: '1h' },
      ),
    };
    db.prepare("UPDATE users SET name = '=Formula Staff' WHERE id = ?").run(owner.userId);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_name', 'كافيه النور · 東京カフェ <script>alert(1)</script>', CURRENT_TIMESTAMP)",
    ).run();

    const app = createApp({
      '/api/reports': reportRoutes,
      '/api/cash-closures': cashClosureRoutes,
    });
    ({ server } = await startServer(app));
    const http = request(server);
    const businessDate = '2026-09-25';
    const paidAt = new Date(`${businessDate}T12:00:00Z`)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
      VALUES (?, ?, 'takeaway', 'completed', 450, 50, 500, ?, ?, ?)
    `).run('ORD-REPORT-EXPORT', owner.userId, paidAt, paidAt, paidAt);
    const orderId = Number(
      (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('ORD-REPORT-EXPORT') as any)
        .id,
    );
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, tax_breakdown, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, 450, 50, ?, 500, 500, 0, 'paid', ?, ?, ?, ?)
    `).run(
      'B-REPORT-EXPORT',
      orderId,
      JSON.stringify([{ title: 'VAT <Standard>', rate: 10, amount: 50 }]),
      JSON.stringify([{ method: 'cash', amount: 500, timestamp: paidAt }]),
      paidAt,
      paidAt,
      paidAt,
    );

    const auth = { Authorization: `Bearer ${owner.token}` };
    const cashierAuth = { Authorization: `Bearer ${cashier.token}` };

    const forbiddenXHtml = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=html`)
      .set(cashierAuth);
    assert.equal(
      forbiddenXHtml.status,
      403,
      'unauthorized cashier gets 403 on X report HTML export',
    );
    const forbiddenZHtml = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=html`)
      .set(cashierAuth);
    assert.equal(
      forbiddenZHtml.status,
      403,
      'unauthorized cashier gets 403 on Z report HTML export',
    );
    const badXFormat = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=pdf`)
      .set(auth);
    assert.equal(badXFormat.status, 400, 'invalid format=pdf on X report returns 400');

    const xCsv = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=csv`)
      .set(auth);
    assert.equal(xCsv.status, 200, 'X report CSV returns 200');
    assert.match(xCsv.headers['content-type'], /text\/csv/);
    assert.ok(xCsv.headers['content-disposition'].includes(`x-report-${businessDate}.csv`));
    assert.ok(xCsv.text.includes('summary,Gross Sales,,,,500'));
    assert.ok(
      xCsv.text.includes("'=Formula Staff"),
      'X report CSV neutralizes formula-like staff names',
    );

    const xXlsx = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse(parseBuffer);
    assert.equal(xXlsx.status, 200, 'X report XLSX returns 200');
    assert.match(xXlsx.headers['content-type'], /spreadsheetml\.sheet/);
    const xWorkbook = new ExcelJS.Workbook();
    await xWorkbook.xlsx.load(xXlsx.body);
    assert.deepEqual(
      xWorkbook.worksheets.map((sheet: any) => sheet.name),
      ['Summary', 'Payments', 'Staff'],
    );
    const xMetrics = new Map<string, unknown>();
    xWorkbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) xMetrics.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    assert.equal(xMetrics.get('Gross Sales'), 500);
    assert.equal(xMetrics.get('Bill Count'), 1);

    const xHtml = await http
      .get(`/api/reports/x-report/export?date=${businessDate}&format=html`)
      .set(auth);
    assert.equal(xHtml.status, 200, 'X report HTML returns 200');
    assert.match(xHtml.headers['content-type'], /text\/html/);
    assert.ok(xHtml.headers['content-disposition'].includes(`x-report-${businessDate}.html`));
    assert.ok(
      xHtml.text.startsWith('<!doctype html>'),
      'X report HTML is a complete HTML5 document',
    );
    assert.ok(
      xHtml.text.includes('@page { size: A4 portrait; margin: 12mm; }'),
      'X report HTML includes A4 print page rule',
    );
    assert.ok(
      xHtml.text.includes('كافيه النور · 東京カフェ &lt;script&gt;alert(1)&lt;/script&gt;'),
      'X report HTML renders non-Latin store name and escapes HTML',
    );
    assert.ok(
      !xHtml.text.includes('<script>alert(1)</script>'),
      'X report HTML never injects raw script tags',
    );
    assert.ok(
      xHtml.text.includes('VAT &lt;Standard&gt;'),
      'X report HTML includes escaped tax component title',
    );
    const xHtmlMetrics = parseHtmlSummaryMetrics(xHtml.text);
    for (const [metric, xlsxVal] of xMetrics.entries()) {
      assert.equal(
        xHtmlMetrics.get(metric),
        xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
        `X report HTML metric ${metric} matches XLSX`,
      );
    }

    const unclosedZ = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=csv`)
      .set(auth);
    assert.equal(unclosedZ.status, 404, 'unclosed Z report returns 404');
    assert.equal(unclosedZ.body.error, 'Day not closed');
    const unclosedZHtml = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=html`)
      .set(auth);
    assert.equal(unclosedZHtml.status, 404, 'unclosed Z report HTML returns 404');
    assert.equal(unclosedZHtml.body.error, 'Day not closed');

    const close = await http.post('/api/cash-closures').set(auth).send({
      business_date: businessDate,
      opening_float_cents: 10000,
      counted_cash_cents: 65000,
      notes: 'End of day <b>check</b>',
    });
    assert.equal(close.status, 201, 'test day closes');
    assert.equal(close.body.zReport.expected_cash_cents, 60000);
    assert.equal(close.body.zReport.variance_cents, 5000);

    const zCsv = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=csv`)
      .set(auth);
    assert.equal(zCsv.status, 200, 'Z report CSV returns 200');
    assert.ok(
      zCsv.headers['content-disposition'].includes(
        `z-report-Z${close.body.zReport.z_number}-${businessDate}.csv`,
      ),
    );
    assert.ok(
      zCsv.text.includes('summary,Expected Cash in Drawer,,,,600\n'),
      'Z report CSV includes expected cash in display units',
    );
    assert.ok(
      zCsv.text.includes('summary,Cash Variance,,,,50\n'),
      'Z report CSV includes cash variance in display units',
    );

    const zXlsx = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse(parseBuffer);
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

    const zHtml = await http
      .get(`/api/reports/z-report/export?date=${businessDate}&format=html`)
      .set(auth);
    assert.equal(zHtml.status, 200, 'Z report HTML returns 200');
    assert.match(zHtml.headers['content-type'], /text\/html/);
    assert.ok(
      zHtml.headers['content-disposition'].includes(
        `z-report-Z${close.body.zReport.z_number}-${businessDate}.html`,
      ),
    );
    assert.ok(
      zHtml.text.includes('End of day &lt;b&gt;check&lt;/b&gt;'),
      'Z report HTML escapes notes',
    );
    assert.ok(
      zHtml.text.includes('VAT &lt;Standard&gt;'),
      'Z report HTML includes tax breakdown from snapshot',
    );
    const zHtmlMetrics = parseHtmlSummaryMetrics(zHtml.text);
    for (const [metric, xlsxVal] of zMetrics.entries()) {
      assert.equal(
        zHtmlMetrics.get(metric),
        xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
        `Z report HTML metric ${metric} matches XLSX`,
      );
    }

    const xPdfBuffer = await renderHtmlToPdfBuffer({
      html: xHtml.text,
      pageSize: 'A4',
    });
    const xPdfText = xPdfBuffer.toString('utf8');
    assert.ok(xPdfText.startsWith('%PDF-1.4'), 'X report renderHtmlToPdfBuffer returns PDF bytes');
    assert.ok(
      xPdfText.includes('pageSize=A4 preferCSSPageSize=true'),
      'X report PDF render passes pageSize and preferCSSPageSize=true',
    );
    const xPdfMetrics = parseHtmlSummaryMetrics(xPdfText);
    for (const [metric, xlsxVal] of xMetrics.entries()) {
      assert.equal(
        xPdfMetrics.get(metric),
        xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
        `X report PDF metric ${metric} matches XLSX`,
      );
    }
    assert.ok(
      lastLoadedHtmlPath.length > 0 && !fs.existsSync(lastLoadedHtmlPath),
      'X report staging HTML file is cleaned up after PDF render',
    );

    const pdfBuffer = await renderHtmlToPdfBuffer({
      html: zHtml.text,
      pageSize: 'A4',
    });
    const zPdfText = pdfBuffer.toString('utf8');
    assert.ok(zPdfText.startsWith('%PDF-1.4'), 'renderHtmlToPdfBuffer returns PDF bytes');
    assert.ok(
      zPdfText.includes('pageSize=A4 preferCSSPageSize=true'),
      'Z report PDF render passes pageSize and preferCSSPageSize=true',
    );
    assert.ok(
      zPdfText.includes(`Z Report #${close.body.zReport.z_number} — ${businessDate}`),
      'Z report PDF contains Z report header',
    );
    const zPdfMetrics = parseHtmlSummaryMetrics(zPdfText);
    for (const [metric, xlsxVal] of zMetrics.entries()) {
      assert.equal(
        zPdfMetrics.get(metric),
        xlsxVal === null || xlsxVal === undefined ? '' : String(xlsxVal),
        `Z report PDF metric ${metric} matches XLSX`,
      );
    }
    assert.ok(
      lastLoadedHtmlPath.length > 0 && !fs.existsSync(lastLoadedHtmlPath),
      'staging HTML file is cleaned up after PDF render',
    );

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
