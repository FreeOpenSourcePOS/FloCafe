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

  test('freezes draft controls, pre-opened customizer, and table switching during a delayed send without blocking on printing', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableAName = `Freeze A ${Date.now()}`;
    const tableBName = `Freeze B ${Date.now()}`;
    const [tableARes, tableBRes] = await Promise.all([
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableAName, capacity: 2 },
      }),
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableBName, capacity: 2 },
      }),
    ]);
    expect(tableARes.ok()).toBeTruthy();
    expect(tableBRes.ok()).toBeTruthy();
    const { table: tableA } = await tableARes.json();
    const { table: tableB } = await tableBRes.json();

    await openServerApp(page, serverToken);
    await page.getByRole('button', { name: new RegExp(tableAName) }).click();

    const grid = page.getByTestId('pos-product-grid');
    const search = grid.getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    const notesInput = page.getByPlaceholder('Order notes (optional)').first();
    await notesInput.fill('Initial note');

    // Open the customizer before Send is clicked so its callback is live when Send starts.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(page.getByPlaceholder('e.g., no onions, extra spicy...')).toBeVisible();
    await page.getByRole('button', { name: '3', exact: true }).click();

    let markOrderPostInFlight!: () => void;
    const orderPostInFlight = new Promise<void>((resolve) => {
      markOrderPostInFlight = resolve;
    });
    let releaseOrderPost!: () => void;
    const orderPostGate = new Promise<void>((resolve) => {
      releaseOrderPost = resolve;
    });

    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      markOrderPostInFlight();
      await orderPostGate;
      await route.continue();
    });

    const kotPrintPayloads: Array<{
      orderId: number;
      items: Array<{ id: number; quantity: number }>;
    }> = [];
    let releaseKotPrint!: () => void;
    const kotPrintGate = new Promise<void>((resolve) => {
      releaseKotPrint = resolve;
    });
    let firstKotGateUsed = false;
    await page.route('**/api/printers/print-kot', async (route) => {
      kotPrintPayloads.push(route.request().postDataJSON());
      if (!firstKotGateUsed) {
        firstKotGateUsed = true;
        await kotPrintGate;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    // Trigger Send while the pre-opened customizer modal is still mounted.
    const sendButton = page.getByRole('button', { name: 'Send to kitchen' }).first();
    await sendButton.dispatchEvent('click');
    await orderPostInFlight;

    await expect(page.getByRole('button', { name: 'Sending...' }).first()).toBeDisabled();

    // Submitting the pre-opened customizer while Send is in flight must not mutate the draft.
    await page.getByRole('button', { name: /Save changes/ }).click();

    const productCard = grid.getByTestId('pos-product-card').first();
    const removeButton = page.getByRole('button', { name: 'Remove item' }).first();
    const editButton = page.getByRole('button', { name: 'Edit', exact: true }).first();
    const tableBButton = page.getByRole('button', { name: new RegExp(tableBName) });
    const refreshButton = page.locator('header').getByRole('button', { name: 'Refresh' });
    const phoneInput = page.getByPlaceholder('Phone').first();
    const nameInput = page.getByPlaceholder('Customer name').first();

    await expect(productCard).toBeDisabled();
    await expect(removeButton).toBeDisabled();
    await expect(editButton).toBeDisabled();
    await expect(tableBButton).toBeDisabled();
    await expect(refreshButton).toBeDisabled();
    await expect(phoneInput).toBeDisabled();
    await expect(nameInput).toBeDisabled();
    await expect(notesInput).toBeDisabled();

    // Bypassing disabled UI via synthetic clicks or search Enter must also be blocked by the in-flight ref.
    await productCard.dispatchEvent('click');
    await removeButton.dispatchEvent('click');
    await editButton.dispatchEvent('click');
    await tableBButton.dispatchEvent('click');
    await refreshButton.dispatchEvent('click');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    await expect(page.locator('header')).toContainText(tableAName);
    await expect(notesInput).toHaveValue('Initial note');

    // Release the order POST while print-kot is still blocked; Send must complete without waiting on printing.
    releaseOrderPost();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    await expect(page.getByText('Tap menu items to add them here.').first()).toBeVisible();
    await expect(page.getByText('1 x E2E Coffee').first()).toBeVisible();
    releaseKotPrint();

    // Now that the first send finished and unlocked the UI, adding and sending a second item must succeed.
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Add to order' }).first().click();
    await expect(page.locator('main').getByText('1 x E2E Coffee')).toHaveCount(2);
    await expect.poll(() => kotPrintPayloads.length).toBe(2);
    expect(kotPrintPayloads[0]?.items).toHaveLength(1);
    expect(kotPrintPayloads[1]?.items).toHaveLength(1);
    expect(kotPrintPayloads[1]?.items[0]?.id).not.toBe(kotPrintPayloads[0]?.items[0]?.id);

    const [ordersARes, ordersBRes] = await Promise.all([
      page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableA.id, type: 'dine_in', per_page: 5 },
      }),
      page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableB.id, type: 'dine_in', per_page: 5 },
      }),
    ]);
    const { orders: ordersA } = await ordersARes.json();
    const { orders: ordersB } = await ordersBRes.json();
    const totalCoffeeQty = (ordersA[0]?.items || [])
      .filter((item: { product_name: string }) => item.product_name === 'E2E Coffee')
      .reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);
    expect(totalCoffeeQty).toBe(2);
    expect(ordersB).toHaveLength(0);
  });

  test('double Send in the same tick creates only one order mutation', async ({ page }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableName = `DoubleSend ${Date.now()}`;
    const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableRes.ok()).toBeTruthy();
    const { table } = await tableRes.json();

    await openServerApp(page, serverToken);
    await page.getByRole('button', { name: new RegExp(tableName) }).click();

    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    let postCalls = 0;
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() === 'POST') {
        postCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await route.continue();
    });

    const sendButton = page.getByRole('button', { name: 'Send to kitchen' }).first();
    await sendButton.evaluate((btn: HTMLButtonElement) => {
      btn.click();
      btn.click();
    });

    await expect(page.getByText('Order sent').first()).toBeVisible();
    expect(postCalls).toBe(1);

    const ordersRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: table.id, type: 'dine_in', per_page: 5 },
    });
    const { orders } = await ordersRes.json();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.items).toHaveLength(1);
    expect(orders[0]?.items[0]?.quantity).toBe(1);
  });

  test('retains draft and idempotency retry key after a failed send, and ignores stale table order responses', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableAName = `Retry A ${Date.now()}`;
    const tableBName = `Retry B ${Date.now()}`;
    const [tableARes, tableBRes] = await Promise.all([
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableAName, capacity: 2 },
      }),
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableBName, capacity: 2 },
      }),
    ]);
    expect(tableARes.ok()).toBeTruthy();
    expect(tableBRes.ok()).toBeTruthy();
    const { table: tableA } = await tableARes.json();
    const { table: tableB } = await tableBRes.json();

    await openServerApp(page, serverToken);
    await page.getByRole('button', { name: new RegExp(tableAName) }).click();

    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('2*E2E Coffee');
    await search.press('Enter');

    const notesInput = page.getByPlaceholder('Order notes (optional)').first();
    await notesInput.fill('Retry note');

    const idempotencyKeys: string[] = [];
    const postPaths: string[] = [];
    let simulateLostCommitResponse = true;
    await page.route('**/api/orders*', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      postPaths.push(url.pathname);
      const key = route.request().headers()['idempotency-key'] || '';
      idempotencyKeys.push(key);
      if (simulateLostCommitResponse) {
        simulateLostCommitResponse = false;
        const committed = await route.fetch();
        expect(committed.ok()).toBeTruthy();
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary failure after commit' }),
        });
        return;
      }
      await route.continue();
    });

    // First send commits on backend, but response is lost: draft and notes must remain intact.
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByRole('button', { name: 'Send to kitchen' }).first()).toBeEnabled();
    await expect(notesInput).toHaveValue('Retry note');
    await expect(page.getByRole('button', { name: 'Remove item' }).first()).toBeEnabled();

    // Switch away to Table B and back to Table A so the newly created order loads while the draft remains.
    const reloadTableAOrder = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`),
    );
    await page.getByRole('button', { name: new RegExp(tableBName) }).click();
    await page.getByRole('button', { name: new RegExp(tableAName) }).click();
    await reloadTableAOrder;
    await expect(page.getByText('2 x E2E Coffee').first()).toBeVisible();

    // Retrying the unmodified draft must replay the original POST /api/orders with the same key instead of appending a second time.
    await page.getByRole('button', { name: 'Add to order' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    expect(postPaths).toEqual(['/api/orders', '/api/orders']);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBeTruthy();
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);

    const ordersAAfterRetryRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: tableA.id, type: 'dine_in', per_page: 5 },
    });
    const { orders: ordersAAfterRetry } = await ordersAAfterRetryRes.json();
    expect(ordersAAfterRetry).toHaveLength(1);
    expect(ordersAAfterRetry[0]?.items).toHaveLength(1);
    expect(ordersAAfterRetry[0]?.items[0]?.quantity).toBe(2);

    // Delay a subsequent GET /api/orders for Table A, wait for interception before switching back to Table B,
    // and wait for its released response to finish before asserting Table A's order does not render on Table B.
    let markTableAOrderGetIntercepted!: () => void;
    const tableAOrderGetIntercepted = new Promise<void>((resolve) => {
      markTableAOrderGetIntercepted = resolve;
    });
    let releaseTableAOrderGet!: () => void;
    const tableAOrderGetGate = new Promise<void>((resolve) => {
      releaseTableAOrderGet = resolve;
    });
    let failNextTableALookup = false;
    let delayedOnce = false;
    await page.route('**/api/orders?*', async (route) => {
      const url = route.request().url();
      if (failNextTableALookup && url.includes(`table_id=${tableA.id}`)) {
        failNextTableALookup = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Lookup failed' }),
        });
        return;
      }
      if (!delayedOnce && url.includes(`table_id=${tableA.id}`)) {
        delayedOnce = true;
        markTableAOrderGetIntercepted();
        await tableAOrderGetGate;
      }
      await route.continue();
    });

    const firstTableBOrderGet = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableB.id}`),
    );
    await page.getByRole('button', { name: new RegExp(tableBName) }).click();
    await firstTableBOrderGet;

    const delayedTableAOrderGet = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`),
    );
    await page.getByRole('button', { name: new RegExp(tableAName) }).click();
    await tableAOrderGetIntercepted;

    const secondTableBOrderGet = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableB.id}`),
    );
    await page.getByRole('button', { name: new RegExp(tableBName) }).click();
    await secondTableBOrderGet;

    releaseTableAOrderGet();
    const staleTableAResponse = await delayedTableAOrderGet;
    expect(staleTableAResponse.ok()).toBeTruthy();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    await expect(page.locator('header')).toContainText(tableBName);
    await expect(page.getByText('2 x E2E Coffee')).toHaveCount(0);

    // Prepare a new draft on Table B, then return to occupied Table A while its lookup fails:
    // Send must remain blocked until Table A's lookup succeeds so it cannot create a separate order.
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await expect(page.getByRole('button', { name: 'Send to kitchen' }).first()).toBeEnabled();

    failNextTableALookup = true;
    const failedTableALookup = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`),
    );
    await page.getByRole('button', { name: new RegExp(tableAName) }).click();
    await failedTableALookup;

    const sendOnTableAButton = page.getByRole('button', { name: 'Send to kitchen' }).first();
    await expect(sendOnTableAButton).toBeDisabled();
    await sendOnTableAButton.dispatchEvent('click');
    expect(postPaths).toHaveLength(2);

    // Refreshing recovers Table A's order lookup and switches the action to append ("Add to order").
    const recoveredTableALookup = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`) &&
        res.ok(),
    );
    await page.locator('header').getByRole('button', { name: 'Refresh' }).click();
    await recoveredTableALookup;
    await expect(page.getByRole('button', { name: 'Add to order' }).first()).toBeEnabled();

    const ordersBRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: tableB.id, type: 'dine_in', per_page: 5 },
    });
    const { orders: ordersB } = await ordersBRes.json();
    expect(ordersB).toHaveLength(0);
  });
});
