import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage, getE2eToken } from './helpers/test-auth';

async function signInAsOwner(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders|dashboard|settings)/, { timeout: 20000 });
}

function verifyIsolatedRestore(exportPath: string): {
  success: boolean;
  error?: string;
  restoredCounts?: Record<string, number>;
} {
  const runnerScript = `
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-iso-test-'));
    const Module = require('module');
    const orig = Module._load;
    Module._load = function(req, parent, isMain) {
      if (req === 'electron') {
        return {
          app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (s) => Buffer.from(s),
            decryptString: (b) => b.toString(),
          },
        };
      }
      return orig.apply(this, arguments);
    };
    const { initDatabase, getDatabase, closeDatabase } = require('./dist/main/db');
    initDatabase(path.join(testDir, 'test.db'));
    const db = getDatabase();
    db.prepare('INSERT INTO users (id, name, email, password, role, is_active) VALUES (?, ?, ?, ?, ?, 1)').run(
      'e2e-owner',
      'Owner',
      'owner@flo.local',
      'hashedpass',
      'owner',
    );

    const express = require('express');
    const request = require('supertest');
    const { databaseRoutes } = require('./dist/main/routes/database');
    const { databaseToolsRoutes } = require('./dist/main/routes/database-tools');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use((req, res, next) => {
      req.user = { userId: 'e2e-owner', role: 'owner' };
      next();
    });
    app.use('/api/db', databaseRoutes);
    app.use('/api/db-tools', databaseToolsRoutes);

    async function verify() {
      await request(app).post('/api/db-tools/master-pin/reset').send({ pin: '1234', confirm_pin: '1234' });
      const raw = fs.readFileSync(${JSON.stringify(exportPath)}, 'utf8');
      const parsed = JSON.parse(raw);
      db.exec('DELETE FROM inventory_movements;');
      const importRes = await request(app)
        .post('/api/db/import')
        .send({ overwrite: true, master_pin: '1234', data: parsed });
      if (importRes.status !== 200) {
        process.stdout.write(
          '__RESULT__' +
            JSON.stringify({
              success: false,
              error: importRes.body?.error || 'Import failed with ' + importRes.status,
            }) +
            '__END_RESULT__\\n',
        );
        closeDatabase();
        fs.rmSync(testDir, { recursive: true, force: true });
        return;
      }
      const restoredCust = db.prepare('SELECT count(*) as c FROM customers').get().c;
      const restoredProd = db.prepare('SELECT count(*) as c FROM products').get().c;
      const restoredCat = db.prepare('SELECT count(*) as c FROM categories').get().c;
      process.stdout.write(
        '__RESULT__' +
          JSON.stringify({
            success: true,
            restoredCounts: {
              customers: restoredCust,
              products: restoredProd,
              categories: restoredCat,
            },
          }) +
          '__END_RESULT__\\n',
      );
      closeDatabase();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    verify();
  `;
  const result = spawnSync('node', ['tests/run-electron-node-test.cjs', '-e', runnerScript], {
    cwd: path.resolve(__dirname, '../../'),
    encoding: 'utf8',
  });
  const match = result.stdout.match(/__RESULT__(.*?)__END_RESULT__/);
  if (!match) {
    return {
      success: false,
      error: `Runner failed with status ${result.status}: ${result.stderr || result.stdout}`,
    };
  }
  return JSON.parse(match[1]);
}

test.describe('Database Settings JSON Export and Import', () => {
  test.beforeEach(async ({ page }) => {
    await setLanguage(page, 'en');
  });

  test('Database JSON export excludes FTS tables and virtual columns, and downloaded snapshot restores cleanly', async ({
    page,
  }, testInfo) => {
    await signInAsOwner(page);

    await page.goto(`${BASE}/settings?tab=data`);
    await page.waitForLoadState('networkidle');

    const exportButton = page.getByRole('button', { name: 'Export to JSON' });
    await expect(exportButton).toBeVisible({ timeout: 15000 });

    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;

    const tmpExportPath = path.join(os.tmpdir(), `flo-export-test-${Date.now()}.json`);
    await download.saveAs(tmpExportPath);

    await expect(page.getByText('Database exported successfully')).toBeVisible({ timeout: 10000 });

    const rawExport = fs.readFileSync(tmpExportPath, 'utf8');
    const exportData = JSON.parse(rawExport);

    expect(exportData.app).toBe('FloDesktop');
    expect(exportData.schema_version).toBeDefined();
    expect(exportData.data).toBeDefined();

    // Verify derived FTS tables and shadow tables are excluded from export
    const exportedTables = Object.keys(exportData.data);
    for (const tableName of exportedTables) {
      expect(tableName).not.toMatch(/_fts/);
    }
    expect(exportedTables).not.toContain('orders_search_fts');
    expect(exportedTables).not.toContain('customers_search_fts');
    expect(exportedTables).not.toContain('orders_search_fts_data');
    expect(exportedTables).not.toContain('customers_search_fts_data');

    // Verify virtual generated column phone_digits is excluded from export
    if (Array.isArray(exportData.data.customers)) {
      for (const cust of exportData.data.customers) {
        expect(cust).not.toHaveProperty('phone_digits');
      }
    }

    // Perform an isolated restore of the downloaded snapshot and compare restored rows
    const restoreResult = verifyIsolatedRestore(tmpExportPath);
    expect(restoreResult.success, restoreResult.error).toBe(true);
    if (restoreResult.restoredCounts) {
      expect(restoreResult.restoredCounts.categories).toBe(
        Array.isArray(exportData.data.categories) ? exportData.data.categories.length : 0,
      );
      expect(restoreResult.restoredCounts.products).toBe(
        Array.isArray(exportData.data.products) ? exportData.data.products.length : 0,
      );
      expect(restoreResult.restoredCounts.customers).toBe(
        Array.isArray(exportData.data.customers) ? exportData.data.customers.length : 0,
      );
    }

    const screenshotPath =
      process.env.FLO_VERIFICATION_SCREENSHOT_PATH ||
      testInfo.outputPath('database-export-import.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    expect(fs.existsSync(screenshotPath)).toBeTruthy();
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(1000);

    try {
      fs.unlinkSync(tmpExportPath);
    } catch {}
  });

  test('Database import accepts contaminated payloads and rebuilds FTS search indexes', async ({
    page,
  }) => {
    await signInAsOwner(page);

    const runId = Math.random().toString(36).substring(2, 8);
    const uniqueProductId = `prod-e2e-${runId}`;
    const uniqueCustomerId = `cust-e2e-${runId}`;
    const uniqueOrderId = Math.floor(800000 + Math.random() * 100000);
    const uniqueOrderNumber = `ORD-E2E-${runId}`;
    const uniqueCustomerName = `E2E Customer ${runId}`;
    const uniquePhone = `+1555019${Math.floor(1000 + Math.random() * 9000)}`;
    const fixtureTimestamp = '2020-01-01 00:00:00';

    const contaminatedPayload = {
      app: 'FloDesktop',
      schema_version: '116',
      data: {
        settings: [],
        categories: [],
        users: [],
        products: [
          {
            id: uniqueProductId,
            category_id: 'e2e-category',
            name: `E2E Product ${runId}`,
            price: 50,
            tax_type: 'none',
            track_inventory: 1,
            stock_quantity: 10,
            is_active: 1,
            sort_order: 1,
            created_at: fixtureTimestamp,
            updated_at: fixtureTimestamp,
          },
        ],
        inventory_movements: [
          {
            id: 1,
            product_id: uniqueProductId,
            variant_id: null,
            addon_id: null,
            movement_type: 'adjustment',
            quantity_delta: 10,
            stock_after: 10,
            created_at: fixtureTimestamp,
          },
        ],
        customers: [
          {
            id: uniqueCustomerId,
            name: uniqueCustomerName,
            phone: uniquePhone,
            phone_digits: '5550199999', // Virtual generated column that must be ignored
            created_at: fixtureTimestamp,
            updated_at: fixtureTimestamp,
          },
        ],
        orders: [
          {
            id: uniqueOrderId,
            order_number: uniqueOrderNumber,
            customer_id: uniqueCustomerId,
            type: 'takeaway',
            status: 'pending',
            subtotal: 50,
            total: 50,
            created_at: fixtureTimestamp,
            updated_at: fixtureTimestamp,
          },
        ],
        orders_search_fts_data: [{ id: 1, block: 'ignored shadow data' }],
        customers_search_fts_data: [{ id: 1, block: 'ignored shadow data' }],
      },
    };

    const tmpImportPath = path.join(os.tmpdir(), `flo-import-test-${runId}.json`);
    fs.writeFileSync(tmpImportPath, JSON.stringify(contaminatedPayload), 'utf8');

    try {
      await page.goto(`${BASE}/settings?tab=data`);
      await page.waitForLoadState('networkidle');

      const fileInput = page.locator('#import-file');
      await fileInput.setInputFiles(tmpImportPath);

      // Select merge import on confirmation prompt
      const cancelMergeBtn = page.getByRole('button', { name: 'Cancel' });
      await expect(cancelMergeBtn).toBeVisible({ timeout: 5000 });
      await cancelMergeBtn.click();

      await expect(page.getByText('Database imported successfully')).toBeVisible({
        timeout: 15000,
      });

      // Verify FTS search index rebuild via order search
      const token = await page.evaluate(() => localStorage.getItem('token'));
      const orderSearchRes = await page.request.get(
        `${BASE}/api/orders?search=${encodeURIComponent(uniqueOrderNumber)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(orderSearchRes.ok()).toBeTruthy();
      const orderSearchJson = await orderSearchRes.json();
      const orderFound = (orderSearchJson.orders || []).some(
        (o: { order_number: string }) => o.order_number === uniqueOrderNumber,
      );
      expect(orderFound).toBeTruthy();

      const customerSearchRes = await page.request.get(
        `${BASE}/api/orders?search=${encodeURIComponent(uniqueCustomerName)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(customerSearchRes.ok()).toBeTruthy();
      const customerSearchJson = await customerSearchRes.json();
      const customerOrderFound = (customerSearchJson.orders || []).some(
        (o: { order_number: string }) => o.order_number === uniqueOrderNumber,
      );
      expect(customerOrderFound).toBeTruthy();
    } finally {
      // Clean up test order and product to prevent state accumulation across retries and specs
      const authToken = getE2eToken();
      await page.request
        .patch(`${BASE}/api/orders/${uniqueOrderId}/status`, {
          headers: { Authorization: `Bearer ${authToken}` },
          data: { status: 'cancelled', reason: 'E2E cleanup' },
        })
        .catch(() => {});
      await page.request
        .delete(`${BASE}/api/products/${uniqueProductId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        .catch(() => {});

      try {
        fs.unlinkSync(tmpImportPath);
      } catch {}
    }
  });
});
