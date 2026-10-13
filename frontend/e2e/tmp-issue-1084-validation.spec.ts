import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

const EVIDENCE_DIR = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M4VGZA4NATH6B7021QQ5QYGN';

test('Issue #1084 live validation on /customers create and edit modal', async ({ page }) => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // Authenticate as manager
  const loginRes = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { access_token: token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${token}` };

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  // Navigate to /customers
  await page.goto(`${BASE}/customers`);
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();

  // Scenario 1: Open Add Customer modal, verify address & notes fields, create customer
  await page.getByRole('button', { name: 'Add Customer' }).click();
  const addModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Add Customer' }) });
  await expect(addModal).toBeVisible();

  const addressInput = addModal.locator('input[name="address"]');
  const notesTextarea = addModal.locator('textarea[name="notes"]');
  await expect(addressInput).toBeVisible();
  await expect(notesTextarea).toBeVisible();
  await expect(addressInput).toHaveAttribute('aria-label', 'Customer address');
  await expect(addressInput).toHaveAttribute('placeholder', 'Customer address (optional)');
  await expect(addressInput).toHaveAttribute('maxlength', '300');
  await expect(addressInput).toHaveValue('');

  await expect(notesTextarea).toHaveAttribute('aria-label', 'Notes (optional)');
  await expect(notesTextarea).toHaveAttribute('placeholder', 'Notes (optional)');
  await expect(notesTextarea).toHaveAttribute('maxlength', '500');
  await expect(notesTextarea).toHaveValue('');

  // Adversarial check: verify maxLength clamping when typing >300 into address and >500 into notes
  await addressInput.fill('');
  await addressInput.pressSequentially('X'.repeat(350));
  const clampedAddressVal = await addressInput.inputValue();
  expect(clampedAddressVal.length).toBe(300);

  await notesTextarea.fill('');
  await notesTextarea.pressSequentially('Y'.repeat(550));
  const clampedNotesVal = await notesTextarea.inputValue();
  expect(clampedNotesVal.length).toBe(500);

  const suffix = String(Date.now()).slice(-4);
  const customerName = `Ada Lovelace ${suffix}`;
  const customerPhone = `+66 81 234 ${suffix}`;
  const customerEmail = `ada.${suffix}@example.com`;
  const initialAddress = '221B Baker St, London';
  const initialNotes = 'Ring bell twice; leave at reception';

  await addModal.getByPlaceholder('Name').fill(customerName);
  await addModal.locator('input[type="tel"]').fill(customerPhone);
  await addModal.locator('input[type="email"]').fill(customerEmail);
  await addressInput.fill(initialAddress);
  await notesTextarea.fill(initialNotes);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'customers-modal-create.png'),
    fullPage: true,
  });

  const postPromise = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return res.request().method() === 'POST' && url.pathname === '/api/customers';
  });
  const listAfterCreatePromise = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return res.request().method() === 'GET' && url.pathname === '/api/customers';
  });
  await addModal.getByRole('button', { name: 'Add Customer' }).click();
  const postRes = await postPromise;
  expect(postRes.status()).toBe(201);
  const postRequestBody = postRes.request().postDataJSON();
  const createdCustomer = (await postRes.json()).customer;
  expect(postRequestBody.address).toBe(initialAddress);
  expect(postRequestBody.notes).toBe(initialNotes);
  expect(createdCustomer.address).toBe(initialAddress);
  expect(createdCustomer.notes).toBe(initialNotes);

  await expect(addModal).toBeHidden();
  await listAfterCreatePromise;

  // Verify persisted via GET /api/customers/:id
  const getAfterCreate = await page.request.get(`${BASE}/api/customers/${createdCustomer.id}`, {
    headers: auth,
  });
  expect(getAfterCreate.ok()).toBeTruthy();
  const afterCreateRecord = (await getAfterCreate.json()).customer;
  expect(afterCreateRecord.address).toBe(initialAddress);
  expect(afterCreateRecord.notes).toBe(initialNotes);

  // Scenario 2: Open Edit Customer modal from the /customers table row, verify hydration, update both fields
  const customerRow = page.locator('tbody tr').filter({ hasText: customerName }).first();
  await expect(customerRow).toBeVisible();
  await customerRow.locator('td').nth(6).locator('button').click();

  const editModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Edit Customer' }) });
  await expect(editModal).toBeVisible();

  const editAddressInput = editModal.locator('input[name="address"]');
  const editNotesTextarea = editModal.locator('textarea[name="notes"]');
  await expect(editAddressInput).toHaveValue(initialAddress);
  await expect(editNotesTextarea).toHaveValue(initialNotes);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'customers-modal-edit-hydrated.png'),
    fullPage: true,
  });

  const updatedAddress = '42 Wallaby Way, Sydney';
  const updatedNotes = 'Allergic to peanuts; VIP guest';
  await editAddressInput.fill(updatedAddress);
  await editNotesTextarea.fill(updatedNotes);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'customers-modal-edit-updated.png'),
    fullPage: true,
  });

  const putPromise = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return (
      res.request().method() === 'PUT' && url.pathname === `/api/customers/${createdCustomer.id}`
    );
  });
  const listAfterUpdatePromise = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return res.request().method() === 'GET' && url.pathname === '/api/customers';
  });
  await editModal.getByRole('button', { name: 'Update' }).click();
  const putRes = await putPromise;
  expect(putRes.status()).toBe(200);
  const putRequestBody = putRes.request().postDataJSON();
  const updatedCustomer = (await putRes.json()).customer;
  expect(putRequestBody.address).toBe(updatedAddress);
  expect(putRequestBody.notes).toBe(updatedNotes);
  expect(updatedCustomer.address).toBe(updatedAddress);
  expect(updatedCustomer.notes).toBe(updatedNotes);

  await expect(editModal).toBeHidden();
  await listAfterUpdatePromise;

  // Verify persisted via GET /api/customers/:id
  const getAfterUpdate = await page.request.get(`${BASE}/api/customers/${createdCustomer.id}`, {
    headers: auth,
  });
  expect(getAfterUpdate.ok()).toBeTruthy();
  const afterUpdateRecord = (await getAfterUpdate.json()).customer;
  expect(afterUpdateRecord.address).toBe(updatedAddress);
  expect(afterUpdateRecord.notes).toBe(updatedNotes);

  // Reopen edit modal to confirm updated hydration in UI
  await customerRow.locator('td').nth(6).locator('button').click();
  await expect(editModal).toBeVisible();
  await expect(editAddressInput).toHaveValue(updatedAddress);
  await expect(editNotesTextarea).toHaveValue(updatedNotes);

  // Adversarial check: remove HTML maxLength attribute in DOM to test backend 300-char guard
  const overLongAddress = 'Z'.repeat(400);
  await editAddressInput.evaluate((el) => el.removeAttribute('maxlength'));
  await editAddressInput.fill(overLongAddress);
  await expect(editAddressInput).toHaveValue(overLongAddress);
  const badPutPromise = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return (
      res.request().method() === 'PUT' && url.pathname === `/api/customers/${createdCustomer.id}`
    );
  });
  await editModal.getByRole('button', { name: 'Update' }).click();
  const badPutRes = await badPutPromise;
  expect(badPutRes.status()).toBe(400);
  const badPutBody = await badPutRes.json();
  expect(String(badPutBody.error || '')).toMatch(/address/i);
  // Modal stays open and DB keeps updatedAddress
  await expect(editModal).toBeVisible();
  const getAfterBadPut = await page.request.get(`${BASE}/api/customers/${createdCustomer.id}`, {
    headers: auth,
  });
  expect((await getAfterBadPut.json()).customer.address).toBe(updatedAddress);

  // Close edit modal
  await editModal.locator('button').first().click();
  await expect(editModal).toBeHidden();

  // Scenario 3: Reopen Add Customer modal after editing and confirm address and notes reset to empty
  await page.getByRole('button', { name: 'Add Customer' }).click();
  await expect(addModal).toBeVisible();
  await expect(addressInput).toHaveValue('');
  await expect(notesTextarea).toHaveValue('');

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'customers-modal-reset-after-edit.png'),
    fullPage: true,
  });

  // Save JSON evidence
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'customers-modal-bounds-and-api-evidence.json'),
    JSON.stringify(
      {
        createdCustomerId: createdCustomer.id,
        createRequestPayload: postRequestBody,
        createResponseCustomer: {
          id: createdCustomer.id,
          name: createdCustomer.name,
          phone: createdCustomer.phone,
          email: createdCustomer.email,
          address: createdCustomer.address,
          notes: createdCustomer.notes,
        },
        updateRequestPayload: putRequestBody,
        updateResponseCustomer: {
          id: updatedCustomer.id,
          name: updatedCustomer.name,
          phone: updatedCustomer.phone,
          email: updatedCustomer.email,
          address: updatedCustomer.address,
          notes: updatedCustomer.notes,
        },
        boundsVerification: {
          typedAddressLength: 350,
          clampedAddressLength: clampedAddressVal.length,
          typedNotesLength: 550,
          clampedNotesLength: clampedNotesVal.length,
          overLongBackendPutStatus: badPutRes.status(),
          overLongBackendPutError: badPutBody.error,
          persistedAddressAfterRejectedPut: updatedAddress,
        },
        resetAfterEditVerification: {
          addressValueOnReopenedAddModal: await addressInput.inputValue(),
          notesValueOnReopenedAddModal: await notesTextarea.inputValue(),
        },
      },
      null,
      2,
    ),
  );
});
