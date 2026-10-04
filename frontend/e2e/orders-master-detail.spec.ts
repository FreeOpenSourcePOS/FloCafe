import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, readOrdersLayout, setLanguage } from './helpers/test-auth';

/**
 * Orders master/detail split view (#639) — DEFAULT layout coverage.
 *
 * `orders_layout` defaults to 'split', so this spec deliberately pins nothing
 * and asserts that a tenant which never chose a layout gets the master/detail
 * screen. It is the counterpart to the card-grid specs that pin 'cards' through
 * the `readOrdersLayout` / `setOrdersLayout` helpers in helpers/test-auth.ts.
 *
 * WHY THE CARD-GRID SPECS PIN 'cards' — keep this paragraph if you touch them.
 * Those specs locate an order with `page.locator('div.bg-card.rounded-xl')`, the
 * OrderCard root class. Under the split layout that selector resolves to the
 * master-pane wrapper instead, so the OrderCard affordances they drive (Link
 * Customer, New Order, Print) are never in scope and each spec fails on a 30s
 * locator timeout. Measured on the #639 branch:
 *
 *   split (the default)        ->  8 failed, 1 passed  (2.9m)
 *   orders_layout pinned cards ->  9 passed             (13.5s)
 *
 * They therefore declare the mode they test rather than inheriting the default.
 * The pin is undone in `test.afterEach`, because the e2e server shares one
 * database with the whole suite.
 */

const PLACEHOLDER = 'Select an order on the left to view details.';

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
}

async function createTakeaway(page: import('@playwright/test').Page, note: string) {
  const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { access_token: token } = await loginResponse.json();
  const orderResponse = await page.request.post(`${BASE}/api/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      type: 'takeaway',
      special_instructions: note,
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(orderResponse.ok()).toBeTruthy();
  return (await orderResponse.json()).order as { id: number; order_number: string };
}

test.describe('orders master/detail is the default layout', () => {
  test('a tenant with no layout preference gets triage rows and a full detail pane', async ({ page }) => {
    const order = await createTakeaway(page, 'Split default detail check');
    await login(page);

    // The default itself, asserted at the source rather than inferred from the UI.
    expect(await readOrdersLayout(page)).toBe('split');

    await page.goto(`${BASE}/orders`);

    // Left pane: one compact triage row carrying order number, item count and
    // the bold total. OrderCard-only affordances are absent before a selection,
    // which is what makes this the split view and not the cards grid.
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await expect(masterRow).toContainText('1 item');
    await expect(masterRow).toContainText('฿64.20');
    await expect(masterRow.getByRole('button', { name: 'Link Customer' })).toHaveCount(0);

    // Right pane starts on a clean placeholder, per the #639 empty state.
    await expect(page.getByText(PLACEHOLDER)).toBeVisible();

    // Selecting a row moves the order into the detail pane with its items and
    // the actions the cards path exposes. Only the detail pane renders these, so
    // they double as the proof that the detail pane — not a card — took over.
    await masterRow.click();
    await expect(masterRow).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText(PLACEHOLDER)).toBeHidden();
    await expect(page.getByText('E2E Coffee')).toBeVisible();
    await expect(page.getByRole('button', { name: /Checkout|Take Payment/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Item' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link Customer' })).toBeVisible();
  });

  test('the detail pane carries applied charges and the pre-bill print action', async ({ page }) => {
    const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
    const chargeName = 'E2E Detail Fee';
    const originalCharges = await page.request.get(`${BASE}/api/settings/charges`, { headers });
    expect(originalCharges.ok()).toBeTruthy();
    const restoreCharges = (await originalCharges.json()).charges as unknown[];

    try {
      // An auto-applied charge is exactly what the detail pane has to account
      // for, otherwise staff cannot explain the total they are about to collect.
      const charges = await page.request.put(`${BASE}/api/settings/charges`, {
        headers,
        data: {
          charges: [{
            id: 'e2e_detail_charge',
            name: chargeName,
            type: 'fixed',
            value: 3,
            calculation_basis: 'gross',
            order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
            is_optional: false,
            is_default_active: true,
            is_active: true,
          }],
        },
      });
      expect(charges.ok()).toBeTruthy();

      // Dine-in and bill-less: the Print action has to generate the bill rather
      // than wait for checkout.
      const orderResponse = await page.request.post(`${BASE}/api/orders`, {
        headers,
        data: { type: 'dine_in', items: [{ product_id: 'e2e-product', quantity: 1 }] },
      });
      expect(orderResponse.status()).toBe(201);
      const order = (await orderResponse.json()).order as { id: number; order_number: string };

      await login(page);
      await page.goto(`${BASE}/orders`);

      const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
      await expect(masterRow).toBeVisible();
      await masterRow.click();

      await expect(page.getByText(chargeName, { exact: true })).toBeVisible();

      const printAction = page.getByTitle('Print');
      await expect(printAction).toBeVisible();
      await printAction.click();
      await expect(page.getByRole('heading', { name: 'Print Receipt' })).toBeVisible();
    } finally {
      const restored = await page.request.put(`${BASE}/api/settings/charges`, {
        headers,
        data: { charges: restoreCharges },
      });
      expect(restored.ok()).toBeTruthy();
    }
  });

  test('below the md breakpoint the detail pane takes over and back returns to the list', async ({ page }) => {
    const order = await createTakeaway(page, 'Split default responsive check');
    await login(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/orders`);

    // Single column: the list owns the screen and the detail pane is not offered.
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await expect(page.getByText(PLACEHOLDER)).toBeHidden();

    await masterRow.click();
    await expect(masterRow).toBeHidden();
    await expect(page.getByText('E2E Coffee')).toBeVisible();

    // Back navigation returns to the list and the placeholder comes back.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(masterRow).toBeVisible();
    await expect(page.getByText(PLACEHOLDER)).toBeHidden();
  });
});