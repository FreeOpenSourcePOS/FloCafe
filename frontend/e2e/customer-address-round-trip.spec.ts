import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import {
  E2E_PASSWORD,
  readOrdersLayout,
  setOrdersLayout,
  type E2EOrdersLayout,
} from './helpers/test-auth';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

const ADDRESS = 'Flat 4B, 123A-Anecacuilco 04330, Colonia Naucalpan';

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

/**
 * #920: the backend accepted and persisted `customers.address` all along, but no
 * input ever wrote it, so the delivery slip's customer-address fallback could
 * never fire and the reporter retyped the address on every order.
 *
 * The defect is the missing write, so this drives the modal rather than the API.
 */
test('A customer address typed once is saved, reloaded into the editor, and reaches the delivery slip', async ({
  page,
}) => {
  const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { access_token: token } = await loginResponse.json();
  const auth = { Authorization: `Bearer ${token}` };

  const orderResponse = await page.request.post(`${BASE}/api/orders`, {
    headers: auth,
    data: { type: 'delivery', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(orderResponse.ok()).toBeTruthy();
  const { order } = await orderResponse.json();

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  await page.goto(`${BASE}/orders`);
  const orderCard = page
    .locator('div.bg-card.rounded-xl')
    .filter({ hasText: `#${order.order_number}` })
    .first();
  await expect(orderCard).toBeVisible();

  const attemptId = Date.now();
  const customerName = `Address Customer ${attemptId}`;
  const customerPhone = `+66 82 555 ${String(attemptId).slice(-4)}`;

  await orderCard.getByRole('button', { name: 'Link Customer' }).click();
  const searchInput = orderCard.getByPlaceholder('Search by phone or name…');
  await searchInput.fill(customerName);
  const addButton = orderCard.getByRole('button', {
    name: new RegExp(`^Add Customer "${customerName}"$`),
  });
  await expect(addButton).toBeVisible({ timeout: 5000 });
  await addButton.click();

  const modal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Add Customer' }) });
  await expect(modal).toBeVisible();
  // The name field is the first textbox; the address is labelled, so it is reached
  // by name rather than by position. `input[type="text"]` now matches both.
  await modal.getByRole('textbox').first().fill(customerName);
  await modal.locator('input[type="tel"]').fill(customerPhone);
  await modal.getByLabel('Customer address').fill(ADDRESS);

  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'customer-address-create.png'),
      fullPage: true,
    });
  }

  const createdResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/customers';
  });
  await modal.getByRole('button', { name: 'Save' }).click();
  const created = (await (await createdResponse).json()).customer;
  expect(created.address).toBe(ADDRESS);

  // The column is written, so a later read returns it. This is the assertion the
  // old code could not have passed: nothing ever sent the field.
  const readBack = await page.request.get(`${BASE}/api/customers/${created.id}`, { headers: auth });
  expect(readBack.ok()).toBeTruthy();
  expect((await readBack.json()).customer.address).toBe(ADDRESS);

  // The editor reloads it, so a merchant does not retype it on the next visit.
  // Reached through the POS customer strip, the same control the reporter used.
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible({ timeout: 20000 });
  const posCustomerInput = page.getByTestId('pos-customer-search-input').first();
  await posCustomerInput.fill(customerPhone);
  await page.getByRole('button').filter({ hasText: customerName }).first().click();
  await expect(page.getByText(customerName, { exact: true })).toBeVisible();

  const customerChip = page.locator('button[title="Edit Customer"]').first();
  await expect(customerChip).toBeVisible({ timeout: 10000 });
  await customerChip.click();
  const editModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Edit Customer' }) });
  await expect(editModal).toBeVisible();
  await expect(editModal.getByLabel('Customer address')).toHaveValue(ADDRESS);
  if (EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'customer-address-edit.png'),
      fullPage: true,
    });
  }

  // An over-long address is refused by the tenant setting, and the refusal has to
  // be visible. A bare generic toast would pass the happy path and still lose the
  // address silently, which is the failure #920 describes.
  const overLong = 'A'.repeat(400);
  await editModal.getByLabel('Customer address').fill(overLong);
  const putResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PUT' && url.pathname === `/api/customers/${created.id}`;
  });
  await editModal.getByRole('button', { name: 'Save' }).click();
  const put = await putResponse;
  expect(put.status()).toBe(400);
  const body = await put.json();
  expect(String(body.error || body.message || '')).toMatch(/address/i);
  // The merchant has to SEE the refusal. The response body proves the server said
  // it; this proves the editor surfaced it rather than swallowing it into a
  // generic "could not update" toast, which is the half of the fix that was
  // previously untested.
  await expect(page.getByText(/address/i).first()).toBeVisible({ timeout: 5000 });
  // The editor stays open with the text intact rather than discarding the edit.
  await expect(editModal).toBeVisible();
  await expect(editModal.getByLabel('Customer address')).toHaveValue(overLong);

  // The original address is still what is stored: the refusal wrote nothing.
  const afterRefusal = await page.request.get(`${BASE}/api/customers/${created.id}`, {
    headers: auth,
  });
  expect((await afterRefusal.json()).customer.address).toBe(ADDRESS);

  // The slip falls back to the standing customer address, which is the whole point:
  // this order has no per-delivery address recorded.
  const slipOrder = await page.request.get(`${BASE}/api/orders/${order.id}`, { headers: auth });
  const slipPayload = await slipOrder.json();
  expect(slipPayload.order.delivery_address ?? '').toBe('');
  expect(slipPayload.order.customer.address).toBe(ADDRESS);
});

test('Customers page modal creates, edits, clears, preserves unchanged legacy address, validates changed address, resets state, and scrolls on short viewports', async ({
  page,
}, testInfo) => {
  const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { access_token: token } = await loginResponse.json();
  const auth = { Authorization: `Bearer ${token}` };

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  await page.goto(`${BASE}/customers`);
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Customer' }).click();
  const addModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Add Customer' }) });
  await expect(addModal).toBeVisible();

  const addressInput = addModal.getByLabel('Customer address');
  const notesInput = addModal.getByLabel('Notes (optional)');
  await expect(addressInput).toHaveValue('');
  await expect(notesInput).toHaveValue('');

  const suffix = String(Date.now()).slice(-4);
  const customerName = `Modal Customer ${suffix}`;
  const customerPhone = `+66 83 777 ${suffix}`;
  const initialAddress = '221B Baker St, London';
  const initialNotes = 'Ring bell twice';

  await addModal.getByPlaceholder('Name').fill(customerName);
  await addModal.locator('input[type="tel"]').fill(customerPhone);
  await addressInput.fill(initialAddress);
  await notesInput.fill(initialNotes);

  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/customers';
  });
  let listRefreshPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/customers';
  });
  await addModal.getByRole('button', { name: 'Add Customer' }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()).customer;
  expect(created.address).toBe(initialAddress);
  expect(created.notes).toBe(initialNotes);
  await expect(addModal).toBeHidden();
  await listRefreshPromise;

  const row = page.locator('tbody tr').filter({ hasText: customerName }).first();
  await expect(row).toBeVisible();
  await row.locator('td').nth(6).locator('button').click();

  const editModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Edit Customer' }) });
  await expect(editModal).toBeVisible();
  await expect(editModal.getByLabel('Customer address')).toHaveValue(initialAddress);
  await expect(editModal.getByLabel('Notes (optional)')).toHaveValue(initialNotes);

  const updatedAddress = '42 Wallaby Way, Sydney';
  const updatedNotes = 'Leave at reception';
  await editModal.getByLabel('Customer address').fill(updatedAddress);
  await editModal.getByLabel('Notes (optional)').fill(updatedNotes);

  let putResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PUT' && url.pathname === `/api/customers/${created.id}`;
  });
  listRefreshPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/customers';
  });
  await editModal.getByRole('button', { name: 'Update' }).click();
  let putResponse = await putResponsePromise;
  expect(putResponse.status()).toBe(200);
  let updated = (await putResponse.json()).customer;
  expect(updated.address).toBe(updatedAddress);
  expect(updated.notes).toBe(updatedNotes);
  await expect(editModal).toBeHidden();
  await listRefreshPromise;

  await row.locator('td').nth(6).locator('button').click();
  await expect(editModal).toBeVisible();
  await expect(editModal.getByLabel('Customer address')).toHaveValue(updatedAddress);
  await expect(editModal.getByLabel('Notes (optional)')).toHaveValue(updatedNotes);

  await editModal.getByLabel('Customer address').fill('');
  await editModal.getByLabel('Notes (optional)').fill('');
  putResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PUT' && url.pathname === `/api/customers/${created.id}`;
  });
  listRefreshPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/customers';
  });
  await editModal.getByRole('button', { name: 'Update' }).click();
  putResponse = await putResponsePromise;
  expect(putResponse.status()).toBe(200);
  updated = (await putResponse.json()).customer;
  expect(updated.address).toBeNull();
  expect(updated.notes).toBeNull();
  await expect(editModal).toBeHidden();
  await listRefreshPromise;

  const legacyLongAddress = 'L'.repeat(350);
  await page.route('**/api/customers*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const json = await response.json();
    if (Array.isArray(json?.data)) {
      json.data = json.data.map((item: { id: string | number; address?: string | null }) =>
        item.id === created.id ? { ...item, address: legacyLongAddress } : item,
      );
    }
    await route.fulfill({ response, json });
  });

  await page.reload();
  const reloadedRow = page.locator('tbody tr').filter({ hasText: customerName }).first();
  await expect(reloadedRow).toBeVisible();
  await reloadedRow.locator('td').nth(6).locator('button').click();
  await expect(editModal).toBeVisible();
  await expect(editModal.getByLabel('Customer address')).toHaveValue(legacyLongAddress);

  const renamedCustomer = `${customerName} Updated`;
  await editModal.getByPlaceholder('Name').fill(renamedCustomer);
  putResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PUT' && url.pathname === `/api/customers/${created.id}`;
  });
  listRefreshPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/customers';
  });
  await editModal.getByRole('button', { name: 'Update' }).click();
  putResponse = await putResponsePromise;
  expect(putResponse.status()).toBe(200);
  expect('address' in putResponse.request().postDataJSON()).toBe(false);
  await expect(editModal).toBeHidden();
  await listRefreshPromise;
  await page.unroute('**/api/customers*');

  const renamedRow = page.locator('tbody tr').filter({ hasText: renamedCustomer }).first();
  await expect(renamedRow).toBeVisible();
  await renamedRow.locator('td').nth(6).locator('button').click();
  await expect(editModal).toBeVisible();

  const overLimitAddress = 'A'.repeat(350);
  await editModal.getByLabel('Customer address').fill(overLimitAddress);
  putResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PUT' && url.pathname === `/api/customers/${created.id}`;
  });
  await editModal.getByRole('button', { name: 'Update' }).click();
  putResponse = await putResponsePromise;
  expect(putResponse.status()).toBe(400);
  await expect(page.getByText(/address/i).first()).toBeVisible({ timeout: 5000 });
  await expect(editModal).toBeVisible();

  await editModal.locator('button').first().click();
  await expect(editModal).toBeHidden();

  await page.getByRole('button', { name: 'Add Customer' }).click();
  await expect(addModal).toBeVisible();
  await expect(addModal.getByPlaceholder('Name')).toHaveValue('');
  await expect(addModal.locator('input[type="tel"]')).toHaveValue('');
  await expect(addModal.locator('input[type="email"]')).toHaveValue('');
  await expect(addModal.getByLabel('Customer address')).toHaveValue('');
  await expect(addModal.getByLabel('Notes (optional)')).toHaveValue('');

  await page.setViewportSize({ width: 667, height: 320 });
  const modalCard = addModal.locator('div.bg-card');
  const cardBox = await modalCard.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.height).toBeLessThanOrEqual(320);

  const submitButton = addModal.getByRole('button', { name: 'Add Customer' });
  await submitButton.scrollIntoViewIfNeeded();
  await expect(submitButton).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('customers-modal-landscape.png') });

  const afterVerify = await page.request.get(`${BASE}/api/customers/${created.id}`, {
    headers: auth,
  });
  expect(afterVerify.ok()).toBeTruthy();
  expect((await afterVerify.json()).customer.name).toBe(renamedCustomer);
});
