import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test.use({ viewport: { width: 1280, height: 900 } });

const EMAIL = 'manager@flo.local';
const PASSWORD = 'E2ePass123!';
const EVIDENCE_DIR = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M5JDC8JR1FNBNPY5J72WTHHM';

async function saveEvidenceScreenshot(page: Page, filename: string): Promise<string> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const targetPath = path.join(EVIDENCE_DIR, filename);
  await page.screenshot({ path: targetPath, fullPage: false });
  return targetPath;
}

test('live validation: floorplan View Order navigation and OrdersPage ?table= query sync', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  const loginRes = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { access_token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${access_token}` };

  // Create 3 distinct tables on Ground floor:
  // - T101: placed on canvas, occupied with order101
  // - T102: unplaced in staging tray, occupied with order102
  // - T103: placed on canvas, available (unoccupied)
  const suffix = String(Date.now()).slice(-4);
  const t101Name = `T101_${suffix}`;
  const t102Name = `T102_${suffix}`;
  const t103Name = `T103_${suffix}`;

  const createTable = async (
    number: string,
    capacity: number,
    position_x: number | null,
    position_y: number | null,
  ) => {
    const res = await request.post(`${BASE}/api/tables`, {
      headers: auth,
      data: {
        number,
        capacity,
        floor: 'Ground',
        section: 'Main',
        position_x,
        position_y,
      },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).table as { id: string; number: string; name: string };
  };

  const t101 = await createTable(t101Name, 4, 25, 30);
  const t102 = await createTable(t102Name, 2, null, null);
  const t103 = await createTable(t103Name, 4, 65, 30);

  // Ensure T101 and T103 are placed on canvas and T102 is unplaced in tray
  const posRes = await request.patch(`${BASE}/api/tables/positions`, {
    headers: auth,
    data: {
      positions: [
        { id: t101.id, position_x: 25, position_y: 30 },
        { id: t102.id, position_x: null, position_y: null },
        { id: t103.id, position_x: 65, position_y: 30 },
      ],
    },
  });
  expect(posRes.ok()).toBeTruthy();

  const createOrderForTable = async (tableId: string) => {
    const res = await request.post(`${BASE}/api/orders`, {
      headers: auth,
      data: {
        table_id: tableId,
        type: 'dine_in',
        guest_count: 2,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).order as { id: string | number; order_number: string };
  };

  const order101 = await createOrderForTable(t101.id);
  const order102 = await createOrderForTable(t102.id);

  // Sign in via the real UI
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15_000 });

  // Helper to locate the Table filter <select> on /orders
  const getTableFilterSelect = () =>
    page.locator('select').filter({ has: page.locator('option', { hasText: 'All Tables' }) });

  // =========================================================================
  // SCENARIO 1: Placed occupied table on floorplan canvas -> View Order
  // =========================================================================
  await page.goto(`${BASE}/tables`);
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Floor plan' }).click();

  const groundTab = page
    .getByTestId('floorplan-floor-tabs')
    .getByRole('button', { name: 'Ground' });
  if (await groundTab.isVisible()) {
    await groundTab.click();
  }

  const chip101 = page.getByTestId(`floorplan-chip-${t101Name}`);
  await expect(chip101).toBeVisible();
  await expect(chip101).toContainText(`#${order101.order_number}`);
  await chip101.click();

  const dialog101 = page.getByRole('dialog', { name: t101Name });
  await expect(dialog101).toBeVisible();
  const viewOrderBtn101 = dialog101.getByRole('button', { name: 'View Order' });
  await expect(viewOrderBtn101).toBeVisible();

  await saveEvidenceScreenshot(page, '01-floorplan-placed-table-action-sheet.png');

  const ordersFetch101 = page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      res.url().includes('/api/orders') &&
      res.url().includes(`table_id=${encodeURIComponent(String(t101.id))}`),
  );
  await viewOrderBtn101.click();
  await ordersFetch101;

  await expect(page).toHaveURL(
    new RegExp(`/orders/?\\?table=${encodeURIComponent(String(t101.id))}$`),
  );
  const tableSelect = getTableFilterSelect();
  await expect(tableSelect).toBeVisible();
  await expect(tableSelect).toHaveValue(String(t101.id));

  await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
  await expect(page.getByText(`#${order102.order_number}`)).toHaveCount(0);

  await saveEvidenceScreenshot(page, '02-orders-filtered-by-placed-table.png');

  // =========================================================================
  // SCENARIO 2: Unplaced occupied table in floorplan tray -> View Order
  // =========================================================================
  await page.goto(`${BASE}/tables`);
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Floor plan' }).click();
  if (await groundTab.isVisible()) {
    await groundTab.click();
  }

  const tray102 = page.getByTestId(`floorplan-tray-${t102Name}`);
  await expect(tray102).toBeVisible();
  await tray102.click();

  const dialog102 = page.getByRole('dialog', { name: t102Name });
  await expect(dialog102).toBeVisible();
  const viewOrderBtn102 = dialog102.getByRole('button', { name: 'View Order' });
  await expect(viewOrderBtn102).toBeVisible();

  await saveEvidenceScreenshot(page, '03-floorplan-tray-table-action-sheet.png');

  const ordersFetch102 = page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      res.url().includes('/api/orders') &&
      res.url().includes(`table_id=${encodeURIComponent(String(t102.id))}`),
  );
  await viewOrderBtn102.click();
  await ordersFetch102;

  await expect(page).toHaveURL(
    new RegExp(`/orders/?\\?table=${encodeURIComponent(String(t102.id))}$`),
  );
  await expect(tableSelect).toHaveValue(String(t102.id));
  await expect(page.getByText(`#${order102.order_number}`).first()).toBeVisible();
  await expect(page.getByText(`#${order101.order_number}`)).toHaveCount(0);

  await saveEvidenceScreenshot(page, '04-orders-filtered-by-tray-table.png');

  // =========================================================================
  // SCENARIO 3 (Adversarial): Manual Table dropdown changes are preserved across
  // re-renders while ?table=<t102.id> remains unchanged in the URL
  // =========================================================================
  // 3a. Manually switch dropdown from T102 to T101 while URL stays /orders?table=<t102.id>
  await tableSelect.selectOption(String(t101.id));
  await expect(tableSelect).toHaveValue(String(t101.id));
  await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
  await expect(page.getByText(`#${order102.order_number}`)).toHaveCount(0);

  // Trigger re-renders (tab switches) while URL still has ?table=<t102.id>
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(tableSelect).toHaveValue(String(t101.id));
  await page.getByRole('button', { name: 'All Orders', exact: true }).click();
  await expect(tableSelect).toHaveValue(String(t101.id));
  await expect(page).toHaveURL(
    new RegExp(`/orders/?\\?table=${encodeURIComponent(String(t102.id))}$`),
  );

  // 3b. Manually reset dropdown to All Tables ('') while URL still has ?table=<t102.id>
  await tableSelect.selectOption('');
  await expect(tableSelect).toHaveValue('');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(tableSelect).toHaveValue('');
  await page.getByRole('button', { name: 'All Orders', exact: true }).click();
  await expect(tableSelect).toHaveValue('');
  await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
  await expect(page.getByText(`#${order102.order_number}`).first()).toBeVisible();

  await saveEvidenceScreenshot(page, '05-orders-manual-filter-override-preserved.png');

  // =========================================================================
  // SCENARIO 4 (Boundary): Navigating from /orders?table=<id> to /orders
  // (removing ?table=) resets filters.table to All Tables ('')
  // =========================================================================
  await tableSelect.selectOption(String(t101.id));
  await expect(tableSelect).toHaveValue(String(t101.id));
  await expect(page.getByText(`#${order102.order_number}`)).toHaveCount(0);

  // Click sidebar Orders link to navigate to /orders without ?table=
  await page.locator('a[href^="/orders"]').first().click();
  await expect(page).toHaveURL(new RegExp(`/orders/?$`));
  await expect(tableSelect).toHaveValue('');
  await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
  await expect(page.getByText(`#${order102.order_number}`).first()).toBeVisible();

  await saveEvidenceScreenshot(page, '06-orders-url-cleared-resets-all-tables.png');

  // =========================================================================
  // SCENARIO 5 (Adversarial / Guard): Clicking an available (unoccupied)
  // floorplan table does NOT offer a "View Order" action
  // =========================================================================
  await page.goto(`${BASE}/tables`);
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Floor plan' }).click();
  if (await groundTab.isVisible()) {
    await groundTab.click();
  }

  const chip103 = page.getByTestId(`floorplan-chip-${t103Name}`);
  await expect(chip103).toBeVisible();
  await chip103.click();

  const dialog103 = page.getByRole('dialog', { name: t103Name });
  await expect(dialog103).toBeVisible();
  await expect(dialog103.getByRole('button', { name: 'Reserve Table' })).toBeVisible();
  await expect(dialog103.getByRole('button', { name: 'View Order' })).toHaveCount(0);

  await saveEvidenceScreenshot(page, '07-floorplan-available-table-no-view-order.png');
});
