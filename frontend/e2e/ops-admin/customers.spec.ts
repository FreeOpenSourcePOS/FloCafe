import { randomInt } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, ownerAuth, fetchCustomers } from './helpers';

/** Tests customer phone normalization, duplicate handling, editing, and search. */

const RUN = Date.now().toString(36);
const randomPhoneSuffix = () => randomInt(0, 100_000_000).toString().padStart(8, '0');
const uniquePhone = (prefix = '+668') => `${prefix}${randomPhoneSuffix()}`;
const E164 = uniquePhone();
const LOCAL = `0${E164.slice(3)}`;

type Customer = { id: string; name: string; phone: string | null };

function addCustomerModal(page: import('@playwright/test').Page) {
  return page.locator('.fixed.inset-0 form');
}

async function createViaApi(request: import('@playwright/test').APIRequestContext, name: string, phone: string): Promise<Customer> {
  const res = await request.post(`${E2E_BASE_URL}/api/customers`, {
    headers: ownerAuth(),
    data: { name, phone },
  });
  expect(res.status(), `creating ${name} must succeed (got ${res.status()} ${await res.text()})`).toBe(201);
  const { customer } = (await res.json()) as { customer: Customer };
  return customer;
}

test.describe('@ci-tier2 operations admin - customers', () => {
  test('a local-format phone is normalised to E.164 on the way in and on screen', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/customers`);
    await expect(page.locator('table')).toBeVisible();

    await page.getByRole('button', { name: 'Add Customer' }).first().click();
    const modal = addCustomerModal(page);
    await expect(modal).toBeVisible();

    const name = `Ops Normalise ${RUN}`;
    await modal.locator('input[type="text"]').first().fill(name);
    await modal.locator('input[type="tel"]').fill(LOCAL);
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    // The list shows the canonical form, not what was typed.
    const row = page.locator('tr').filter({ hasText: name });
    await expect(row).toContainText(E164);
    await expect(row).not.toContainText(LOCAL);

    // And so does the store.
    const stored = (await fetchCustomers(page)).find((c) => c.name === name);
    expect(stored?.phone, 'the stored phone must be canonical E.164').toBe(E164);
  });

  test('the same number typed differently is one customer, not two', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const phone = uniquePhone();
    const original = await createViaApi(page.request, `Ops Unify ${RUN}`, phone);

    // Same digits, different formatting and a different leading convention.
    for (const variant of [`0${phone.slice(3)}`, `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5)}`]) {
      const again = await page.request.post(`${E2E_BASE_URL}/api/customers`, {
        headers,
        data: { name: `Ops Unify Variant ${RUN}`, phone: variant },
      });
      expect(again.status(), `"${variant}" must resolve to the existing customer, not create a second one`).toBe(409);
      expect((await again.json()).message).toMatch(/already exists/i);
    }

    // Exactly one record carries that number.
    const matching = (await fetchCustomers(page)).filter((c) => (c.phone ?? '').replace(/\D/g, '').endsWith(phone.replace(/\D/g, '').slice(-8)));
    expect(matching.length, 'a duplicated phone must never produce two customers').toBe(1);
    expect(matching[0].id).toBe(original.id);
  });

  test('the create form refuses a duplicate number and leaves the list alone', async ({ page }) => {
    await login(page, 'owner');
    const phone = uniquePhone();
    const original = await createViaApi(page.request, `Ops Dup Form ${RUN}`, phone);

    await page.goto(`${E2E_BASE_URL}/customers`);
    await page.getByRole('button', { name: 'Add Customer' }).first().click();
    const modal = addCustomerModal(page);
    await expect(modal).toBeVisible();

    const dupeName = `Ops Dup Form Attempt ${RUN}`;
    await modal.locator('input[type="text"]').first().fill(dupeName);
    await modal.locator('input[type="tel"]').fill(`0${phone.slice(3)}`);
    await modal.locator('button[type="submit"]').click();

    // The operator is told, and the dialog stays open rather than silently
    // discarding the attempt.
    await expect(page.locator('.react-hot-toast, [role="status"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(modal).toBeVisible();
    await page.locator('.fixed.inset-0 button:has(svg.lucide-x), .fixed.inset-0 button').first().click();

    // The duplicate name never reached the list.
    await expect(page.locator('tr').filter({ hasText: dupeName })).toHaveCount(0);
    await expect(page.locator('tr').filter({ hasText: original.name })).toHaveCount(1);
  });

  test('editing a customer onto another customer\'s number is refused', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const stamp = randomPhoneSuffix();
    const firstPhone = `+668${stamp}`;
    const secondPhone = `+669${stamp}`;
    const first = await createViaApi(page.request, `Ops Move From ${RUN}`, firstPhone);
    const second = await createViaApi(page.request, `Ops Move To ${RUN}`, secondPhone);

    const clash = await page.request.put(`${E2E_BASE_URL}/api/customers/${second.id}`, {
      headers,
      data: { phone: `0${firstPhone.slice(3)}` },
    });
    expect(clash.status(), 'moving onto a taken number must be refused').toBe(409);

    // Both records still hold their own number.
    const customers = await fetchCustomers(page);
    expect(customers.find((c) => c.id === first.id)?.phone).toBe(firstPhone);
    expect(customers.find((c) => c.id === second.id)?.phone).toBe(secondPhone);
  });

  test('an edit in the form is saved and shown back', async ({ page }) => {
    await login(page, 'owner');
    const phone = uniquePhone();
    const customer = await createViaApi(page.request, `Ops Edit ${RUN}`, phone);

    await page.goto(`${E2E_BASE_URL}/customers`);
    const row = page.locator('tr').filter({ hasText: customer.name });
    await expect(row).toBeVisible();
    await row.locator('button').first().click();

    const modal = addCustomerModal(page);
    await expect(modal).toBeVisible();
    const renamed = `${customer.name} Renamed`;
    await modal.locator('input[type="text"]').first().fill(renamed);
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    await expect(page.locator('tr').filter({ hasText: renamed })).toHaveCount(1);

    // A renamed customer keeps the number it was matched on.
    const stored = (await fetchCustomers(page)).find((c) => c.id === customer.id);
    expect(stored).toMatchObject({ name: renamed, phone });
  });

  test('search finds a customer by a fragment of their number', async ({ page }) => {
    await login(page, 'owner');
    const phone = uniquePhone();
    const customer = await createViaApi(page.request, `Ops Search ${RUN}`, phone);

    await page.goto(`${E2E_BASE_URL}/customers`);
    const search = page.getByPlaceholder('Search by name, phone, or email…');
    await expect(search).toBeVisible();

    // A middle fragment, which only matches if the stored digits are searched.
    await search.fill(phone.slice(4, 9));
    await page.waitForTimeout(1200);

    await expect(page.locator('tr').filter({ hasText: customer.name })).toHaveCount(1);
    await expect(page.getByText(phone, { exact: true })).toBeVisible();
  });

  test('the owner-only phone repair reports no unmergeable conflicts among these records', async ({ page }) => {
    // repair-phones counts duplicates it refuses to rewrite. The unique index on
    // phone_digits means this should be zero for anything created through the API.
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const res = await page.request.post(`${E2E_BASE_URL}/api/customers/admin/repair-phones`, { headers });
    expect(res.ok(), `phone repair must run (got ${res.status()})`).toBeTruthy();
    const report = (await res.json()) as { totalScanned: number; normalizedCount: number; unparseableCount: number; conflictedCount: number };
    expect(report.conflictedCount, 'API-created customers must not leave conflicting phone records').toBe(0);
  });
});
