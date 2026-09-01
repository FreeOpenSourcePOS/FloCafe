import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

test('Orders page creates a customer and links it to an active order', async ({ page }) => {
  const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { access_token: token } = await loginResponse.json();

  const orderResponse = await page.request.post(`${BASE}/api/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      type: 'takeaway',
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(orderResponse.ok()).toBeTruthy();
  const { order } = await orderResponse.json();

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  await page.goto(`${BASE}/orders`);
  const orderCard = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${order.order_number}` }).first();
  await expect(orderCard).toBeVisible();

  await orderCard.getByRole('button', { name: 'Link Customer' }).click();
  const attemptId = Date.now();
  const customerName = `Quick Customer ${attemptId}`;
  const customerPhone = `+66 82 234 ${String(attemptId).slice(-4)}`;
  const searchInput = orderCard.getByPlaceholder('Search by phone or name…');
  await searchInput.fill(customerName);

  const addCustomerButton = orderCard.getByRole('button', { name: new RegExp(`^Add Customer "${customerName}"$`) });
  await expect(addCustomerButton).toBeVisible({ timeout: 5000 });
  await addCustomerButton.click();

  const modal = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Add Customer' }) });
  await expect(modal).toBeVisible();
  await modal.locator('input[type="text"]').fill(customerName);
  await modal.locator('input[type="tel"]').fill(customerPhone);

  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'orders-quick-customer-create-modal.png'), fullPage: true });
  }

  const createdResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/customers';
  });
  const linkResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PATCH' && url.pathname === `/api/orders/${order.id}/customer`;
  });

  await modal.getByRole('button', { name: 'Save' }).click();
  const createdPayload = await (await createdResponse).json();
  const linkedPayload = await (await linkResponse).json();
  expect(createdPayload.customer.name).toBe(customerName);
  expect(createdPayload.customer.phone).toBe(`+6682234${String(attemptId).slice(-4)}`);
  expect(linkedPayload.order.customer_id).toBe(createdPayload.customer.id);

  await expect(orderCard).toContainText(customerName, { timeout: 10000 });
  await expect(orderCard.getByRole('button', { name: 'New Order' })).toBeVisible();

  const persistedResponse = await page.request.get(`${BASE}/api/orders/${order.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(persistedResponse.ok()).toBeTruthy();
  const persistedPayload = await persistedResponse.json();
  expect(persistedPayload.order.customer.id).toBe(createdPayload.customer.id);
  expect(persistedPayload.order.customer.name).toBe(customerName);

  if (EVIDENCE_DIR) {
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'orders-quick-customer-linked.png'), fullPage: true });
  }
});
