import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

function overlaps(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

test('POS table picker stays clickable after removing a customer at 1280px', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${token}` };
  const businessResponse = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessResponse.ok()).toBeTruthy();
  const originalBusiness = await businessResponse.json();
  const attemptId = Date.now();
  const customerName = `Topbar Guest ${attemptId}`;
  const customerPhone = `+668${String(attemptId).slice(-8)}`;
  const tableName = `E2E-TOPBAR-${attemptId}`;
  let tableId: string | undefined;

  try {
    const businessUpdate = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, tables_required: true },
    });
    expect(businessUpdate.ok()).toBeTruthy();

    const tableResponse = await page.request.post(`${BASE}/api/tables`, {
      headers: authHeaders,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableResponse.ok()).toBeTruthy();
    tableId = (await tableResponse.json()).table.id;

    const customerResponse = await page.request.post(`${BASE}/api/customers`, {
      headers: authHeaders,
      data: { name: customerName, phone: customerPhone, country_code: '+66' },
    });
    expect(customerResponse.ok()).toBeTruthy();

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByRole('button', { name: 'Select Table', exact: true }).click();
    const tablePicker = page.locator('div.fixed.inset-0').filter({
      has: page.getByRole('heading', { name: 'Select Table', exact: true }),
    }).last();
    await tablePicker.getByRole('button', { name: new RegExp(tableName) }).click();

    const phoneInput = page.locator('input[type="tel"]').first();
    const searchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/customers-search'
        && url.searchParams.get('q') === customerPhone.replace(/\D/g, '');
    });
    await phoneInput.fill(customerPhone);
    expect((await searchResponse).ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByText(customerName, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    const tableButton = page.getByRole('button', { name: `Table: ${tableName}`, exact: true });
    await expect(tableButton).toBeVisible();

    const nameInput = page.getByPlaceholder('Name auto-fills');
    const phoneBox = await phoneInput.boundingBox();
    const nameBox = await nameInput.boundingBox();
    const tableBox = await tableButton.boundingBox();
    expect(phoneBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(tableBox).not.toBeNull();
    expect(overlaps(phoneBox!, tableBox!)).toBe(false);
    expect(overlaps(nameBox!, tableBox!)).toBe(false);

    await tableButton.click();
    await expect(page.getByRole('heading', { name: 'Select Table', exact: true })).toBeVisible();
  } finally {
    if (tableId) {
      await page.request.post(`${BASE}/api/tables/${tableId}/deactivate`, { headers: authHeaders });
    }
    await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: originalBusiness,
    });
  }
});
