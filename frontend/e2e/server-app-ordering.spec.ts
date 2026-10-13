import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

async function openServerApp(page: Page, serverToken: string): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, tok]) => {
      localStorage.setItem(key, tok);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, serverToken],
  );
  await page.reload();
}

test.describe('Server App tableside ordering', () => {
  test('sends the order note with the ticket from the shared POS product grid', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };
    await page.request.put(`${E2E_BASE_URL}/api/settings/language`, {
      headers,
      data: { value: 'en' },
    });

    const tableName = `Notes ${Date.now()}`;
    const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableRes.ok()).toBeTruthy();
    const { table } = await tableRes.json();

    await openServerApp(page, serverToken);
    await page.getByRole('button', { name: new RegExp(tableName) }).click();

    const grid = page.getByTestId('pos-product-grid');
    await expect(grid.getByPlaceholder('Search menu')).toBeVisible();
    const search = grid.getByPlaceholder('Search menu');
    await search.fill('2*E2E Coffee');
    await search.press('Enter');

    const note = 'Window seat, birthday';
    await page.getByPlaceholder('Order notes (optional)').first().fill(note);
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const ordersRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: table.id, type: 'dine_in', per_page: 1 },
    });
    expect(ordersRes.ok()).toBeTruthy();
    const { orders } = await ordersRes.json();
    expect(orders[0]?.special_instructions).toBe(note);
    expect(
      orders[0]?.items?.some(
        (item: { product_name: string; quantity: number }) =>
          item.product_name === 'E2E Coffee' && item.quantity === 2,
      ),
    ).toBeTruthy();
  });

  test('explains that tables are required when none are set up', async ({ page }) => {
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    await page.route('**/api/tables?*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"tables":[]}' }),
    );

    await openServerApp(page, serverToken);

    await expect(page.getByRole('heading', { name: 'No tables set up' })).toBeVisible();
    await expect(page.getByTestId('pos-product-grid')).toHaveCount(0);
  });

  test('fits mobile viewports without horizontal overflow', async ({ page }) => {
    const serverToken = getE2eToken(
      'e2e-server',
      `server-${Date.now()}-${Math.random()}@flo.local`,
      'server',
    );
    const viewports = [320, 375, 390, 430, 768];

    for (const width of viewports) {
      await page.setViewportSize({ width, height: 800 });
      await openServerApp(page, serverToken);
      await expect(page.getByTestId('pos-product-grid')).toBeVisible();

      const header = page.locator('header');
      const refreshButton = header.getByRole('button', { name: 'Refresh' });
      const logoutButton = header.getByRole('button', { name: 'Logout' });
      await expect(refreshButton).toBeVisible();
      await expect(logoutButton).toBeVisible();
      await expect(header.getByRole('button')).toHaveCount(2);

      for (const button of [refreshButton, logoutButton]) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasOverflow).toBeFalsy();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const header = page.locator('header');
    const refreshTables = page.waitForResponse(
      (res) => res.url().includes('/api/tables') && res.ok(),
    );
    await header.getByRole('button', { name: 'Refresh' }).click();
    await refreshTables;

    await header.getByRole('button', { name: 'Logout' }).click();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });
});
