import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import {
  setLanguage,
  readOrdersLayout,
  setOrdersLayout,
  type E2EOrdersLayout,
} from './helpers/test-auth';

// #639 made the Orders screen default to the master/detail split view, so this
// spec pins the classic cards grid before driving OrderCard affordances. The
// evidence for why lives in frontend/e2e/orders-master-detail.spec.ts.
let ordersLayoutBefore: E2EOrdersLayout = 'split';

test.beforeEach(async ({ page }) => {
  ordersLayoutBefore = await readOrdersLayout(page);
  await setOrdersLayout(page, 'cards');
});

test.afterEach(async ({ page }) => {
  await setOrdersLayout(page, ordersLayoutBefore);
});

test('payment can retry without a manager PIN after kitchen delivery completes', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await setLanguage(page, 'en');

  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  const settingKeys = ['billing_type', 'kds_enabled', 'require_kitchen_delivered_before_settlement'];
  const originalSettings = new Map<string, string>();
  for (const key of settingKeys) {
    const response = await page.request.get(`${BASE}/api/settings/${key}`, { headers });
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    originalSettings.set(key, payload.setting.value);
  }

  const setSetting = async (key: string, value: string) => {
    const response = await page.request.put(`${BASE}/api/settings/${key}`, { headers, data: { value } });
    expect(response.ok(), `setting ${key}=${value} must save`).toBeTruthy();
  };

  try {
    await setSetting('billing_type', 'postpaid');
    await setSetting('kds_enabled', 'true');
    await setSetting('require_kitchen_delivered_before_settlement', 'true');

    const createdOrderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    expect(createdOrderResponse.status()).toBe(201);
    const { order } = await createdOrderResponse.json();
    const detailResponse = await page.request.get(`${BASE}/api/orders/${order.id}`, { headers });
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json();
    const itemId = detail.order.items[0].id;

    await page.goto(`${BASE}/orders`);
    await page.getByPlaceholder(/search/i).first().fill(order.order_number);
    await expect(page.getByText(`#${order.order_number}`)).toBeVisible();
    await page.getByRole('button', { name: 'Checkout', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();

    const payButton = page.getByRole('button', { name: /^Pay / });
    await expect(payButton).toBeEnabled();
    const isPaymentRequest = (response: { url(): string; request(): { method(): string } }) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname);
    };
    const blockedPaymentPromise = page.waitForResponse(isPaymentRequest);
    await payButton.click();
    const blockedPayment = await blockedPaymentPromise;
    expect(blockedPayment.status()).toBe(409);
    expect((await blockedPayment.json()).code).toBe('KITCHEN_ITEMS_UNDELIVERED');

    const managerPin = page.getByLabel('Manager PIN');
    await expect(managerPin).toBeVisible();
    await expect(managerPin).toHaveValue('');
    await expect(payButton).toBeEnabled();

    const servedResponse = await page.request.patch(`${BASE}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'served' },
    });
    expect(servedResponse.ok()).toBeTruthy();

    const settledPaymentPromise = page.waitForResponse(isPaymentRequest);
    await payButton.click();
    const settledPayment = await settledPaymentPromise;
    expect(settledPayment.status()).toBe(200);
    const paymentRequest = settledPayment.request().postDataJSON();
    expect(paymentRequest.override_pin).toBeUndefined();
    expect((await settledPayment.json()).bill.payment_status).toBe('paid');
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
    await expect(managerPin).toHaveCount(0);
  } finally {
    for (const [key, value] of originalSettings) {
      await setSetting(key, value);
    }
  }
});

test('zero-balance dine-in checkout can settle from the payment modal after kitchen delivery', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await setLanguage(page, 'en');

  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  const settingKeys = [
    'billing_type',
    'kds_enabled',
    'require_kitchen_delivered_before_settlement',
  ];
  const originalSettings = new Map<string, string>();
  for (const key of settingKeys) {
    const response = await page.request.get(`${BASE}/api/settings/${key}`, { headers });
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    originalSettings.set(key, payload.setting.value);
  }
  const discountSettingsResponse = await page.request.get(`${BASE}/api/settings/discount`, { headers });
  expect(discountSettingsResponse.ok()).toBeTruthy();
  const originalDiscountSettings = await discountSettingsResponse.json();

  let tableId: string | undefined;
  const tableNumber = `Kitchen zero ${Date.now()}`;
  const setSetting = async (key: string, value: string) => {
    const response = await page.request.put(`${BASE}/api/settings/${key}`, { headers, data: { value } });
    expect(response.ok(), `setting ${key}=${value} must save`).toBeTruthy();
  };
  const setDiscountSettings = async (settings: Record<string, unknown>) => {
    const response = await page.request.put(`${BASE}/api/settings/discount`, { headers, data: settings });
    expect(response.ok(), 'discount settings must save').toBeTruthy();
  };

  try {
    await setSetting('billing_type', 'postpaid');
    await setSetting('kds_enabled', 'true');
    await setSetting('require_kitchen_delivered_before_settlement', 'true');
    await setDiscountSettings({ ...originalDiscountSettings, discount_mode: 'both', discount_max_amount: 0 });

    const tableResponse = await page.request.post(`${BASE}/api/tables`, {
      headers,
      data: { number: tableNumber, capacity: 2 },
    });
    expect(tableResponse.status()).toBe(201);
    const { table } = await tableResponse.json();
    tableId = table.id;

    const createdOrderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tableId,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(createdOrderResponse.status()).toBe(201);
    const { order } = await createdOrderResponse.json();
    const detailResponse = await page.request.get(`${BASE}/api/orders/${order.id}`, { headers });
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json();
    const itemId = detail.order.items[0].id;

    const generatedBillResponse = await page.request.post(`${BASE}/api/bills/generate`, {
      headers,
      data: { order_id: order.id },
    });
    expect(generatedBillResponse.status()).toBe(201);

    const discountResponse = await page.request.patch(`${BASE}/api/orders/${order.id}/discount`, {
      headers,
      data: { discount_type: 'amount', discount_value: Number(detail.order.subtotal) },
    });
    expect(discountResponse.ok()).toBeTruthy();
    const currentBillResponse = await page.request.get(`${BASE}/api/bills/order/${order.id}`, { headers });
    expect(currentBillResponse.ok()).toBeTruthy();
    const { bill } = await currentBillResponse.json();
    expect(Number(bill.total)).toBe(0);
    expect(bill.payment_status).toBe('unpaid');

    await page.goto(`${BASE}/orders`);
    await page.getByPlaceholder(/search/i).first().fill(order.order_number);
    await expect(page.getByText(`#${order.order_number}`)).toBeVisible();
    await page.getByRole('button', { name: 'Checkout', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();

    const payButton = page.getByRole('button', { name: /^Pay / });
    await expect(payButton).toBeEnabled();
    const isZeroBalancePaymentRequest = (response: { url(): string; request(): { method(): string } }) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/payments?$/.test(url.pathname);
    };
    const blockedPaymentPromise = page.waitForResponse(isZeroBalancePaymentRequest);
    await payButton.click();
    const blockedPayment = await blockedPaymentPromise;
    expect(blockedPayment.status()).toBe(409);
    expect(new URL(blockedPayment.url()).pathname).toMatch(/\/payment$/);
    expect((await blockedPayment.json()).code).toBe('KITCHEN_ITEMS_UNDELIVERED');

    const managerPin = page.getByLabel('Manager PIN');
    await expect(managerPin).toBeVisible();
    await expect(managerPin).toHaveValue('');

    const servedResponse = await page.request.patch(`${BASE}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'served' },
    });
    expect(servedResponse.ok()).toBeTruthy();

    const settledPaymentPromise = page.waitForResponse(isZeroBalancePaymentRequest);
    await payButton.click();
    const settledPayment = await settledPaymentPromise;
    expect(settledPayment.status()).toBe(200);
    const paymentRequest = settledPayment.request().postDataJSON();
    expect(paymentRequest).toMatchObject({ method: 'cash', amount: null });
    expect(paymentRequest.override_pin).toBeUndefined();
    expect((await settledPayment.json()).bill.payment_status).toBe('paid');
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();

    const tablesResponse = await page.request.get(`${BASE}/api/tables`, { headers });
    expect(tablesResponse.ok()).toBeTruthy();
    const { tables } = await tablesResponse.json();
    expect(tables.find((candidate: { id: string }) => candidate.id === tableId)?.status).toBe('available');
  } finally {
    await setDiscountSettings(originalDiscountSettings);
    for (const [key, value] of originalSettings) {
      await setSetting(key, value);
    }
    if (tableId) {
      await page.request.patch(`${BASE}/api/tables/${tableId}/status`, {
        headers,
        data: { status: 'available' },
      });
      await page.request.post(`${BASE}/api/tables/${tableId}/deactivate`, { headers });
    }
  }
});
