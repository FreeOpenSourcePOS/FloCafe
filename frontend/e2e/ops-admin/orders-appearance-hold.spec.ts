import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, addToCart, ownerAuth } from './helpers';

/**
 * The Orders screen's own presentation and lifecycle controls: the appearance
 * switcher, and holding an order for a table and resuming it.
 *
 * The switcher is a tenant setting, so every pin here is undone afterwards -
 * the e2e database is shared with the rest of the suite.
 */

const RUN = Date.now().toString(36).slice(-4);

test.describe('operations admin - orders appearance and hold', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'owner');
  });

  test.afterEach(async ({ request }) => {
    // Whatever the scenario left selected, the tenant goes back to the default.
    await request.put(`${E2E_BASE_URL}/api/settings/orders_layout`, {
      headers: ownerAuth(),
      data: { value: 'split' },
    });
    // Holding needs postpaid billing and a required table; the e2e tenant ships
    // with prepaid billing and no table requirement.
    await request.put(`${E2E_BASE_URL}/api/settings/business`, {
      headers: ownerAuth(),
      data: { billing_type: 'prepaid', tables_required: false },
    });
  });

  test('the appearance switcher changes the Orders screen and the choice persists', async ({ page }) => {
    // Two orders so both layouts have something to render.
    const made: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
        headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` },
        data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
      });
      expect(res.status()).toBe(201);
      made.push(((await res.json()) as { order: { order_number: string } }).order.order_number);
    }

    // The control itself lives in Settings, on the Appearance tab.
    await page.goto(`${E2E_BASE_URL}/settings?tab=appearance`);
    const group = page.getByRole('radiogroup', { name: 'Orders Screen Layout' });
    await expect(group).toBeVisible({ timeout: 20_000 });

    const split = group.getByRole('radio', { name: /Master \/ Detail/i });
    const cards = group.getByRole('radio', { name: /Cards Grid/i });

    // Split is the default, and says so.
    await expect(split).toHaveAttribute('aria-checked', 'true');
    await expect(cards).toHaveAttribute('aria-checked', 'false');

    // Split view: a master list with a placeholder until an order is chosen.
    await page.goto(`${E2E_BASE_URL}/orders`);
    await expect(page.getByText(/Select an order on the left to view details/i)).toBeVisible({ timeout: 20_000 });

    // Switch to the card grid.
    await page.goto(`${E2E_BASE_URL}/settings?tab=appearance`);
    await group.getByRole('radio', { name: /Cards Grid/i }).click();
    await expect(cards).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });

    // The Orders screen follows, and no longer offers the split placeholder.
    // Cards are not buttons, so the orders are matched by their number.
    await page.goto(`${E2E_BASE_URL}/orders`);
    await expect(page.getByText(`#${made[0]}`, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Select an order on the left to view details/i)).toBeHidden();

    // The choice survives a reload, because it is a stored tenant setting.
    await page.reload();
    await expect(page.getByText(/Select an order on the left to view details/i)).toBeHidden();
    await page.goto(`${E2E_BASE_URL}/settings?tab=appearance`);
    await expect(group.getByRole('radio', { name: /Cards Grid/i })).toHaveAttribute('aria-checked', 'true');
  });

  test('switching back restores the master/detail layout', async ({ page }) => {
    await page.goto(`${E2E_BASE_URL}/settings?tab=appearance`);
    const group = page.getByRole('radiogroup', { name: 'Orders Screen Layout' });
    await expect(group).toBeVisible({ timeout: 20_000 });

    await group.getByRole('radio', { name: /Cards Grid/i }).click();
    await expect(group.getByRole('radio', { name: /Cards Grid/i })).toHaveAttribute('aria-checked', 'true');

    await group.getByRole('radio', { name: /Master \/ Detail/i }).click();
    await expect(group.getByRole('radio', { name: /Master \/ Detail/i })).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });

    await page.goto(`${E2E_BASE_URL}/orders`);
    await expect(page.getByText(/Select an order on the left to view details/i)).toBeVisible({ timeout: 20_000 });
  });

  test('an order held against a table is parked, and resuming returns the cart', async ({ page }) => {
    // Holding is a table-bound cart action: a dine-in order on a table, paid
    // after service rather than up front.
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const number = `Hold${RUN}`;
    const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number, capacity: 2, floor: `Hold${RUN}` },
    });
    expect(tableRes.status()).toBe(201);
    const table = ((await tableRes.json()) as { table: { id: string; number: string } }).table;

    // Open the order on this table, in a postpaid dine-in service. Holding is
    // only offered for that combination, so the tenant is switched to match.
    const switched = await page.request.put(`${E2E_BASE_URL}/api/settings/business`, {
      headers,
      data: { billing_type: 'postpaid', tables_required: true },
    });
    expect(switched.ok(), `postpaid table service must be settable (got ${switched.status()} ${await switched.text()})`).toBeTruthy();

    await page.goto(`${E2E_BASE_URL}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByRole('button', { name: /Dine in/i }).first().click();
    await page.waitForTimeout(600);

    const selectTable = page.getByRole('button', { name: /Select Table/i }).first();
    await expect(selectTable, 'table service must offer the table picker').toBeVisible({ timeout: 15_000 });
    await selectTable.click();

    const picker = page.locator('.fixed.inset-0').last();
    await expect(picker).toBeVisible();
    await picker.getByRole('button').filter({ hasText: new RegExp(number) }).first().click();
    await page.waitForTimeout(800);

    await addToCart(page, 'E2E Coffee', 2);

    const hold = page.getByRole('button', { name: /^Hold$/ });
    await expect(hold, 'holding must be offered for a dine-in order on a table').toBeVisible({ timeout: 15_000 });
    await hold.click();
    await page.waitForTimeout(2000);

    // Holding parks the cart: it is no longer in the till, and the table is held.
    const tables = (await (await page.request.get(`${E2E_BASE_URL}/api/tables`, { headers })).json()) as {
      tables: Array<{ id: string; status: string }>;
    };
    expect(tables.tables.find((t) => t.id === table.id)?.status, 'holding must mark the table held').toBe('held');

    // The Orders screen can see the parked order and offers to resume it.
    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button', { name: 'Held', exact: true }).first().click();
    await page.waitForTimeout(1200);

    const resume = page.getByRole('button', { name: /Resume in POS/i }).first();
    await expect(resume, 'a held order must offer a way back into the till').toBeVisible({ timeout: 20_000 });
    await resume.click();

    // Back in the till, with the parked items and the same table.
    await expect(page).toHaveURL(/\/pos/);
    await page.waitForTimeout(1500);
    await expect(page.getByText(/E2E Coffee/).first()).toBeVisible();
  });
});