import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

async function signInAsOwner(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders|dashboard|settings)/, { timeout: 20000 });
}

test.describe('Database Settings JSON Export and Import (#1272, #1273)', () => {
  test.beforeEach(async ({ page }) => {
    await setLanguage(page, 'en');
  });

  test('Database JSON export excludes FTS tables and virtual columns, and import round-trips successfully', async (
    { page },
    testInfo,
  ) => {
    await signInAsOwner(page);

    // Navigate to Database Settings tab
    await page.goto(`${BASE}/settings?tab=data`);
    await page.waitForLoadState('networkidle');

    // Verify Export section is visible
    const exportButton = page.getByRole('button', { name: 'Export to JSON' });
    await expect(exportButton).toBeVisible({ timeout: 15000 });

    // Step 1: Export JSON and inspect contents
    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;

    const tmpExportPath = path.join(os.tmpdir(), `flo-export-test-${Date.now()}.json`);
    await download.saveAs(tmpExportPath);

    // Expect success toast
    await expect(page.getByText('Database exported successfully')).toBeVisible({ timeout: 10000 });

    const rawExport = fs.readFileSync(tmpExportPath, 'utf8');
    const exportData = JSON.parse(rawExport);

    expect(exportData.app).toBe('FloDesktop');
    expect(exportData.schema_version).toBeDefined();
    expect(exportData.data).toBeDefined();

    // Verify derived FTS tables and shadow tables are excluded (#1273)
    const exportedTables = Object.keys(exportData.data);
    for (const tableName of exportedTables) {
      expect(tableName).not.toMatch(/_fts/);
    }
    expect(exportedTables).not.toContain('orders_search_fts');
    expect(exportedTables).not.toContain('customers_search_fts');
    expect(exportedTables).not.toContain('orders_search_fts_data');
    expect(exportedTables).not.toContain('customers_search_fts_data');

    // Verify virtual generated column phone_digits is excluded (#1273)
    if (Array.isArray(exportData.data.customers)) {
      for (const cust of exportData.data.customers) {
        expect(cust).not.toHaveProperty('phone_digits');
      }
    }

    // Step 2: Prepare import payload with a unique customer to verify search rebuild (#1273)
    // Include virtual column phone_digits and a shadow table to prove they are safely ignored on import
    const uniquePhone = `+1555019${Math.floor(1000 + Math.random() * 9000)}`;
    const newCustomer = {
      id: `cust-e2e-${Date.now()}`,
      name: 'E2E Recovery Customer',
      phone: uniquePhone,
      email: 'recovery-e2e@example.com',
      phone_digits: '5550199999', // Virtual generated column that must be ignored
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const importData = {
      app: 'FloDesktop',
      schema_version: exportData.schema_version,
      data: {
        settings: [],
        categories: [],
        products: [],
        users: [],
        customers: [newCustomer],
        inventory_movements: [
          {
            id: 1,
            product_id: 'e2e-product',
            variant_id: null,
            addon_id: null,
            movement_type: 'adjustment',
            quantity_delta: 999,
            stock_after: 999,
            created_at: new Date().toISOString(),
          },
        ],
        orders_search_fts_data: [{ id: 1, block: 'ignored shadow data' }], // FTS shadow table that must be ignored
      },
    };

    const tmpImportPath = path.join(os.tmpdir(), `flo-import-test-${Date.now()}.json`);
    fs.writeFileSync(tmpImportPath, JSON.stringify(importData), 'utf8');

    // Step 3: Trigger Import through the file input
    const fileInput = page.locator('#import-file');
    await fileInput.setInputFiles(tmpImportPath);

    // Confirmation dialog appears: choose Cancel to perform merge import (overwrite: false)
    const cancelMergeBtn = page.getByRole('button', { name: 'Cancel' });
    await expect(cancelMergeBtn).toBeVisible({ timeout: 5000 });
    await cancelMergeBtn.click();

    // Wait for success toast
    await expect(page.getByText('Database imported successfully')).toBeVisible({ timeout: 15000 });

    // Step 4: Verify search reconciliation
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const phoneDigits = uniquePhone.replace(/\D/g, '');
    const searchRes = await page.request.get(`${BASE}/api/customers?search=${phoneDigits}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(searchRes.ok()).toBeTruthy();
    const searchJson = await searchRes.json();
    const customersList = searchJson.data || searchJson.customers || [];
    const found = customersList.some(
      (c: { phone: string; name: string }) => c.name === 'E2E Recovery Customer',
    );
    expect(found).toBeTruthy();

    // Step 5: Save verification screenshot
    const screenshotPath =
      process.env.FLO_VERIFICATION_SCREENSHOT_PATH ||
      testInfo.outputPath('r1-r2-database-export-import.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    expect(fs.existsSync(screenshotPath)).toBeTruthy();
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(1000);

    // Cleanup temporary files
    try {
      fs.unlinkSync(tmpExportPath);
      fs.unlinkSync(tmpImportPath);
    } catch {}
  });
});
