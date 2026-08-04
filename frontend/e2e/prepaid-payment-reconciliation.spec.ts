import { test, expect } from '@playwright/test';

test('prepaid checkout uses the authoritative decimal bill total and settles in full', async ({ page }) => {
  await page.goto('http://localhost:3001/auth/login');
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();

  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: 'Add to Cart - ฿60.00' }).click();
  await page.getByRole('button', { name: 'Place Order' }).click();

  await expect(page.getByRole('button', { name: 'Tax ฿4.20' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeVisible();
  await expect(page.getByText('Round off', { exact: true })).toHaveCount(0);

  const orderResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/orders';
  });
  const billResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/bills/generate';
  });
  const paymentResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname);
  });

  await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();

  const orderPayload = await (await orderResponse).json();
  const billPayload = await (await billResponse).json();
  const paymentPayload = await (await paymentResponse).json();

  expect(orderPayload.order.total).toBe(64.2);
  expect(orderPayload.order.round_off).toBe(0);
  expect(billPayload.bill.total).toBe(64.2);
  expect(billPayload.bill.round_off).toBe(0);
  expect(paymentPayload.bill.paid_amount).toBe(64.2);
  expect(paymentPayload.bill.balance).toBe(0);
  expect(paymentPayload.bill.payment_status).toBe('paid');
  await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toBeVisible();
});

test('prepaid checkout never reports success when the payment response is partial', async ({ page }) => {
  await page.goto('http://localhost:3001/auth/login');
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();

  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: 'Add to Cart - ฿60.00' }).click();
  await page.getByRole('button', { name: 'Place Order' }).click();
  await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeVisible();

  let paymentBatchRequests = 0;
  await page.route('**/api/bills/*/payments', async (route) => {
    paymentBatchRequests++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bill: {
          id: 999,
          payment_status: 'partial',
          balance: 0.2,
        },
      }),
    });
  });

  await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();

  await expect(page.getByText(/Payment incomplete/)).toBeVisible();
  expect(paymentBatchRequests).toBe(1);
  await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Place Order' })).toBeEnabled();
});
