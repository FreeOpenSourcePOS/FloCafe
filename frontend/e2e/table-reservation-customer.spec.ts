import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('reserved customer is searchable, shown after reload, and linked to the dine-in order', async ({ page }) => {
  test.setTimeout(90_000);
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${token}` };
  const businessResponse = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessResponse.ok()).toBeTruthy();
  const originalBusiness = await businessResponse.json();

  const attemptId = Date.now();
  const customerName = `Reservation Guest ${attemptId}`;
  const customerPhone = `+668${String(attemptId).slice(-8)}`;
  const tableName = `E2E-RES-${attemptId}`;
  let tableId: string | undefined;
  let orderId: number | undefined;

  try {
    const businessUpdate = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid', tables_required: true },
    });
    expect(businessUpdate.ok()).toBeTruthy();

    const customerResponse = await page.request.post(`${BASE}/api/customers`, {
      headers: authHeaders,
      data: { name: customerName, phone: customerPhone, country_code: '+66' },
    });
    expect(customerResponse.ok()).toBeTruthy();
    const { customer } = await customerResponse.json();

    const tableResponse = await page.request.post(`${BASE}/api/tables`, {
      headers: authHeaders,
      data: { number: tableName, capacity: 4 },
    });
    expect(tableResponse.ok()).toBeTruthy();
    tableId = (await tableResponse.json()).table.id;

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/tables`);
    const tableCard = page.locator('div.bg-card.rounded-xl.border').filter({ hasText: tableName }).first();
    await expect(tableCard).toBeVisible();
    await tableCard.getByRole('button', { name: 'Reserve' }).click();

    const reserveModal = page.locator('div.fixed.inset-0').filter({
      has: page.getByRole('heading', { name: new RegExp(tableName) }),
    }).last();
    const customerSearch = reserveModal.getByPlaceholder('Search by phone or name...');
    await customerSearch.fill(customerName);
    const searchResult = reserveModal.getByRole('button').filter({ hasText: customerName }).first();
    await expect(searchResult).toBeVisible({ timeout: 5_000 });
    const phoneSearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/customers-search'
        && url.searchParams.get('q') === customerPhone;
    });
    await customerSearch.fill(customerPhone);
    const phoneSearchResults = await (await phoneSearchResponse).json();
    expect(Array.isArray(phoneSearchResults)).toBeTruthy();
    expect(phoneSearchResults.some((result: { id: string }) => result.id === customer.id)).toBeTruthy();
    await expect(searchResult).toBeVisible({ timeout: 5_000 });
    await searchResult.click();

    const reserveResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PATCH' && url.pathname === `/api/tables/${tableId}/status`;
    });
    await reserveModal.getByRole('button', { name: 'Reserve Table' }).click();
    expect((await reserveResponse).ok()).toBeTruthy();
    await expect(tableCard).toContainText(customerName);
    await expect(tableCard).toContainText(customerPhone);

    await page.reload();
    const reloadedTableCard = page.locator('div.bg-card.rounded-xl.border').filter({ hasText: tableName }).first();
    await expect(reloadedTableCard).toContainText(customerName);
    await expect(reloadedTableCard).toContainText(customerPhone);

    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.getByTestId('pos-product-card').filter({ hasText: 'E2E Coffee' }).first().click();
    await page.getByRole('button', { name: /Add to Cart/ }).click();
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('heading', { name: 'Select Table' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(tableName) }).click();

    const orderResponse = page.waitForResponse((response) => {
      return response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/orders';
    });
    await page.getByRole('button', { name: 'Place Order' }).click();
    const orderPayload = await (await orderResponse).json();
    orderId = orderPayload.order.id;
    expect(orderPayload.order.customer_id).toBe(customer.id);

    await page.goto(`${BASE}/orders`);
    const orderCard = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${orderPayload.order.order_number}` }).first();
    await expect(orderCard).toContainText(customerName);
    await expect(orderCard.getByRole('button', { name: 'Link Customer' })).toHaveCount(0);
  } finally {
    if (orderId) {
      await page.request.patch(`${BASE}/api/orders/${orderId}/status`, {
        headers: authHeaders,
        data: { status: 'completed' },
      });
    }
    if (tableId) {
      await page.request.patch(`${BASE}/api/tables/${tableId}/status`, {
        headers: authHeaders,
        data: { status: 'available' },
      });
    }
    await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: originalBusiness,
    });
  }
});

test('table selection preserves explicit customers and replaces or clears inherited reservation customers', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${token}` };
  const businessResponse = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessResponse.ok()).toBeTruthy();
  const originalBusiness = await businessResponse.json();
  const attemptId = Date.now();
  const reservationCustomer = {
    name: `Reservation Guest ${attemptId}`,
    phone: `+668${String(attemptId).slice(-8)}`,
  };
  const replacementCustomer = {
    name: `Replacement Guest ${attemptId}`,
    phone: `+668${String(attemptId + 1).slice(-8)}`,
  };
  const explicitCustomer = {
    name: `Explicit Guest ${attemptId}`,
    phone: `+668${String(attemptId + 2).slice(-8)}`,
  };
  const tableNames = [`E2E-RES-A-${attemptId}`, `E2E-RES-B-${attemptId}`, `E2E-RES-FREE-${attemptId}`];
  const tableIds: string[] = [];

  try {
    const businessUpdate = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, tables_required: true },
    });
    expect(businessUpdate.ok()).toBeTruthy();

    const customers: Array<{ id: string }> = [];
    for (const customer of [reservationCustomer, replacementCustomer, explicitCustomer]) {
      const response = await page.request.post(`${BASE}/api/customers`, {
        headers: authHeaders,
        data: { ...customer, country_code: '+66' },
      });
      expect(response.ok()).toBeTruthy();
      customers.push((await response.json()).customer);
    }

    for (const number of tableNames) {
      const response = await page.request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number, capacity: 4 },
      });
      expect(response.ok()).toBeTruthy();
      tableIds.push((await response.json()).table.id);
    }
    for (const [tableId, customer] of [[tableIds[0], customers[0]], [tableIds[1], customers[1]]] as const) {
      const response = await page.request.patch(`${BASE}/api/tables/${tableId}/status`, {
        headers: authHeaders,
        data: { status: 'reserved', reservation_customer_id: customer.id },
      });
      expect(response.ok()).toBeTruthy();
    }

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    const tablesResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/tables'
        && url.searchParams.get('active') === '1';
    });
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    const tablesResponse = await tablesResponsePromise;
    expect(tablesResponse.ok()).toBeTruthy();
    const loadedTables = (await tablesResponse.json()).tables as Array<{
      id: string;
      status: string;
      reservation_customer_id: string | null;
    }>;
    expect(loadedTables.find((table) => table.id === tableIds[0])).toMatchObject({
      status: 'reserved',
      reservation_customer_id: customers[0].id,
    });
    await setLanguage(page, 'en');

    const phoneInput = page.locator('input[type="tel"]');
    const explicitSearch = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/customers-search'
        && url.searchParams.get('q') === explicitCustomer.phone.replace(/\D/g, '');
    });
    await phoneInput.fill(explicitCustomer.phone);
    const explicitSearchResults = await (await explicitSearch).json();
    expect(explicitSearchResults.some((customer: { id: string }) => customer.id === customers[2].id)).toBeTruthy();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByText(explicitCustomer.name, { exact: true })).toBeVisible();

    const selectTable = async (name: string, currentTableName?: string) => {
      if (currentTableName) {
        await page.getByRole('button', { name: `Table: ${currentTableName}`, exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Select Table' }).click();
      }
      const picker = page.locator('div.fixed.inset-0').filter({
        has: page.getByRole('heading', { name: 'Select Table' }),
      }).last();
      await picker.getByRole('button', { name: new RegExp(name) }).click();
    };

    await selectTable(tableNames[0]);
    await expect(page.getByText(explicitCustomer.name, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Remove' }).click();
    await selectTable(tableNames[0], tableNames[0]);
    await expect(page.getByText(reservationCustomer.name, { exact: true })).toBeVisible();

    await selectTable(tableNames[1], tableNames[0]);
    await expect(page.getByText(replacementCustomer.name, { exact: true })).toBeVisible();

    await selectTable(tableNames[2], tableNames[1]);
    await expect(phoneInput).toBeVisible();
    await expect(phoneInput).toHaveValue('');
    await expect(page.getByText(replacementCustomer.name, { exact: true })).toHaveCount(0);
  } finally {
    for (const tableId of tableIds) {
      await page.request.patch(`${BASE}/api/tables/${tableId}/status`, {
        headers: authHeaders,
        data: { status: 'available' },
      });
      await page.request.post(`${BASE}/api/tables/${tableId}/deactivate`, { headers: authHeaders });
    }
    await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: originalBusiness,
    });
  }
});
