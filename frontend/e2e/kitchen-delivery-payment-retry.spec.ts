import { test, expect } from '@playwright/test';
import { setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

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
