import {
  test,
  expect,
  request as playwrightRequest,
  type Locator,
  type Page,
} from '@playwright/test';
import { clearPizzaMenu, loadSampleMenu, sampleMenu } from './helpers/pizza-menu';
import { getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * The price guard on the POS, against the made-up sample menu: a till that has
 * not caught up with a price change is refused, told, re-priced with every
 * line kept, and places the order again at the new price. Every spec shares one
 * database, so this one loads the menu itself, puts back the price it changes,
 * pays what it places and clears the menu when it ends.
 */

const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };
const MESSAGE = 'Prices have changed. Check the order and place it again.';

const sizes = (menu = sampleMenu()) =>
  (menu.sizes as { pizza: { id: string; price: number }[] }).pizza;
const LARGE = sizes().find((size) => size.id === 'large')!.price;
const MEDIUM = sizes().find((size) => size.id === 'medium')!.price;
const DEARER = LARGE + 1.5;
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '\\.'));

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext();
  await loadSampleMenu(api);
  await api.dispose();
});

test.afterAll(async () => {
  const api = await playwrightRequest.newContext();
  try {
    await clearPizzaMenu(api);
  } finally {
    await api.dispose();
  }
});

async function openPos(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1180, height: 820 });
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
  await page.getByRole('button', { name: 'Takeaway' }).click();
}

const tile = (page: Page, name: string): Locator =>
  page.getByTestId('pizza-tile').filter({ has: page.getByRole('heading', { name, exact: true }) });
const cartLines = (page: Page): Locator => page.getByTestId('cart-item');
const isOrderCreate = (method: string, url: string) =>
  method === 'POST' && new URL(url).pathname === '/api/orders';

/** A large Garden and a medium Classic Pepperoni, one tap each. */
async function buildCart(page: Page): Promise<void> {
  await tile(page, 'Garden').getByRole('button', { name: /Large/ }).click();
  await tile(page, 'Classic Pepperoni')
    .getByRole('button', { name: /Medium/ })
    .click();
  await expect(cartLines(page)).toHaveCount(2);
  await expect(page.getByTestId('cart-footer')).toContainText(money(LARGE + MEDIUM));
}

/** Opens the checkout window and confirms a cash payment; answers the order request's response. */
async function confirmCash(page: Page) {
  const created = page.waitForResponse((response) =>
    isOrderCreate(response.request().method(), response.url()),
  );
  await page.locator('body').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('F4');
  const checkout = page.getByTestId('prepaid-checkout-modal');
  await expect(checkout.getByText(/Total Due/i)).toBeVisible();
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await checkout.getByRole('button', { name: /Confirm Payment/ }).click();
  return { checkout, response: await created };
}

/** The order the confirmed payment made, read back once the checkout window is done. */
async function paidOrder(page: Page, checkout: Locator, orderId: number) {
  await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
  await expect(checkout).toBeHidden({ timeout: 15_000 });
  const read = await page.request.get(`${BASE}/api/orders/${orderId}`, { headers: ownerHeaders });
  expect(read.ok()).toBeTruthy();
  const { order } = await read.json();
  expect(order.status, 'the order this spec placed is paid and closed').not.toBe('pending');
  return order;
}

const newestOrderId = async (page: Page): Promise<number> => {
  const read = await page.request.get(`${BASE}/api/orders`, { headers: ownerHeaders });
  expect(read.ok()).toBeTruthy();
  const { orders } = await read.json();
  return Math.max(0, ...orders.map((order: { id: number }) => Number(order.id)));
};

test('nothing changed: the order goes through, with the amount the cart showed', async ({
  page,
}) => {
  await openPos(page);
  await buildCart(page);
  const { checkout, response } = await confirmCash(page);
  expect(response.status(), await response.text()).toBe(201);
  expect(response.request().postDataJSON().expected_subtotal).toBe(LARGE + MEDIUM);
  const order = await paidOrder(page, checkout, (await response.json()).order.id);
  expect(order.subtotal).toBe(LARGE + MEDIUM);
  await expect(cartLines(page)).toHaveCount(0);
  await expect(page.getByText(MESSAGE)).toHaveCount(0);
});

test('a price changed on another device: refused, told, re-priced, and placed again', async ({
  page,
}) => {
  await openPos(page);
  // The till stays on the menu and the products it loaded until the server refuses its order.
  let stale = true;
  const kept = new Map<string, { status: number; body: Buffer; headers: Record<string, string> }>();
  const holdBack = async (route: import('@playwright/test').Route) => {
    const url = route.request().url();
    if (!stale || !kept.has(url)) {
      const response = await route.fetch();
      if (stale)
        kept.set(url, {
          status: response.status(),
          body: await response.body(),
          headers: response.headers(),
        });
      return route.fulfill({ response });
    }
    return route.fulfill(kept.get(url)!);
  };
  await page.route('**/api/pizza/catalog', holdBack);
  await page.route('**/api/products?active=1', holdBack);
  await page.route('**/api/categories?active=1', holdBack);
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch();
    if (response.status() === 409) stale = false;
    return route.fulfill({ response });
  });
  // The first answers are the ones the till holds.
  await page.reload();
  await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
  await page.getByRole('button', { name: 'Takeaway' }).click();
  await buildCart(page);

  const dearer = sampleMenu();
  sizes(dearer).find((size) => size.id === 'large')!.price = DEARER;
  try {
    await loadSampleMenu(page.request, dearer);
    const before = await newestOrderId(page);

    const refusal = await confirmCash(page);
    expect(refusal.response.status(), 'the order is refused').toBe(409);
    expect((await refusal.response.json()).code).toBe('PRICES_CHANGED');
    expect(refusal.response.request().postDataJSON().expected_subtotal).toBe(LARGE + MEDIUM);
    await expect(page.getByText(MESSAGE), 'the cashier is told').toBeVisible();
    await expect(refusal.checkout, 'the checkout window closes on the old total').toBeHidden();
    expect(await newestOrderId(page), 'no order exists').toBe(before);

    await expect(cartLines(page), 'every line is kept').toHaveCount(2);
    await expect(cartLines(page).nth(0)).toContainText('Garden');
    await expect(cartLines(page).nth(0), 'the large pizza shows its new price').toContainText(
      money(DEARER),
    );
    await expect(cartLines(page).nth(1)).toContainText('Classic Pepperoni');
    await expect(cartLines(page).nth(1)).toContainText(money(MEDIUM));
    await expect(page.getByTestId('cart-footer'), 'and the cart its new total').toContainText(
      money(DEARER + MEDIUM),
    );
    await expect(page.getByTestId('pizza-line-off-sale')).toHaveCount(0);

    const again = await confirmCash(page);
    expect(again.response.status(), await again.response.text()).toBe(201);
    expect(again.response.request().postDataJSON().expected_subtotal).toBe(DEARER + MEDIUM);
    const created = (await again.response.json()).order;
    expect(created.id).toBeGreaterThan(before);
    const order = await paidOrder(page, again.checkout, created.id);
    expect(order.subtotal, 'placed at the new price').toBe(DEARER + MEDIUM);
    expect(order.items.map((item: { unit_price: number }) => item.unit_price)).toEqual([
      DEARER,
      MEDIUM,
    ]);
  } finally {
    await loadSampleMenu(page.request);
  }
});

/** Switches the shop to pay later for one test; answers what puts the settings back. */
async function payLater(page: Page, tablesRequired: boolean): Promise<() => Promise<void>> {
  const read = await page.request.get(`${BASE}/api/settings/business`, { headers: ownerHeaders });
  expect(read.ok()).toBeTruthy();
  const business = await read.json();
  const put = (data: object) =>
    page.request.put(`${BASE}/api/settings/business`, { headers: ownerHeaders, data });
  const changed = await put({
    ...business,
    billing_type: 'postpaid',
    tables_required: tablesRequired,
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  return async () => {
    const restored = await put(business);
    expect(restored.ok(), await restored.text()).toBeTruthy();
  };
}

const cancelOrder = async (page: Page, id: number) => {
  const cancelled = await page.request.patch(`${BASE}/api/orders/${id}/status`, {
    headers: ownerHeaders,
    data: { status: 'cancelled', reason: 'E2E price guard cleanup' },
  });
  expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
};

const ordersSince = async (page: Page, id: number) => {
  const read = await page.request.get(`${BASE}/api/orders`, { headers: ownerHeaders });
  expect(read.ok()).toBeTruthy();
  const { orders } = await read.json();
  return orders.filter((order: { id: number }) => Number(order.id) > id);
};

test('an append lost on its way is refused after a price change and a reload; its lines come back', async ({
  page,
}) => {
  const restoreSettings = await payLater(page, true);
  const tableNumber = `PG-${Date.now()}`;
  const table = await page.request.post(`${BASE}/api/tables`, {
    headers: ownerHeaders,
    data: { number: tableNumber },
  });
  expect(table.ok(), await table.text()).toBeTruthy();
  const tableId = (await table.json()).table.id as string;
  const created = await page.request.post(`${BASE}/api/orders`, {
    headers: ownerHeaders,
    data: {
      table_id: tableId,
      type: 'dine_in',
      items: [{ product_id: 'pz-garden', variant_id: 'pz-garden-medium', quantity: 1 }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const order = (await created.json()).order;
  try {
    await page.setViewportSize({ width: 1180, height: 820 });
    await loginWithPassword(page, 'owner@flo.local');
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
    await page.getByRole('button', { name: /Select Table|Table: / }).click();
    await page.getByRole('button').filter({ hasText: tableNumber }).click();
    await page.getByRole('button', { name: 'Add Items', exact: true }).click();
    await expect(page.getByTestId('cart-items-scroll').getByText('Already ordered')).toBeVisible();
    await tile(page, 'Garden').getByRole('button', { name: /Large/ }).click();
    await expect(cartLines(page)).toHaveCount(1);

    // The add-items request never reaches the server.
    const appendPath = `/api/orders/${order.id}/items`;
    const dropped = page.waitForEvent(
      'requestfailed',
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === appendPath,
    );
    await page.route(`**${appendPath}`, (route) =>
      route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback(),
    );
    await page.getByRole('button', { name: 'Place Order' }).click();
    expect((await dropped).postDataJSON().expected_subtotal).toBe(LARGE);
    await page.unroute(`**${appendPath}`);

    const dearer = sampleMenu();
    sizes(dearer).find((size) => size.id === 'large')!.price = DEARER;
    await loadSampleMenu(page.request, dearer);

    const replayed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === appendPath,
    );
    await page.reload();
    const replay = await replayed;
    expect(replay.status(), 'the replay is refused').toBe(409);
    expect(replay.request().postDataJSON().expected_subtotal, 'with the quote first sent').toBe(
      LARGE,
    );
    await expect(page.getByText(MESSAGE), 'the cashier is told').toBeVisible();
    await expect(cartLines(page), 'the line is back in the cart').toHaveCount(1);
    await expect(cartLines(page).nth(0)).toContainText('Garden');
    await expect(cartLines(page).nth(0), 'at the new price').toContainText(money(DEARER));
    await expect(
      page.getByTestId('cart-items-scroll').getByText('Already ordered'),
      'still adding to the order',
    ).toBeVisible();
    const read = await page.request.get(`${BASE}/api/orders/${order.id}`, {
      headers: ownerHeaders,
    });
    const items = (await read.json()).order.items as unknown[];
    expect(items, 'nothing was added to the order').toHaveLength(1);
  } finally {
    await loadSampleMenu(page.request);
    await cancelOrder(page, order.id);
    await page.request.patch(`${BASE}/api/tables/${tableId}/status`, {
      headers: ownerHeaders,
      data: { status: 'available' },
    });
    await page.request.post(`${BASE}/api/tables/${tableId}/deactivate`, {
      headers: ownerHeaders,
    });
    await restoreSettings();
  }
});

test('an order placed whose answer was lost is not placed twice after a price change', async ({
  page,
}) => {
  const restoreSettings = await payLater(page, false);
  const before = await newestOrderId(page);
  try {
    await openPos(page);
    await buildCart(page);
    // The order is written, but its answer never reaches the till.
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fetch();
      return route.abort('connectionreset');
    });
    const lost = page.waitForRequest((request) => isOrderCreate(request.method(), request.url()));
    await page.getByRole('button', { name: 'Place Order' }).click();
    const first = await lost;
    await expect.poll(() => ordersSince(page, before)).toHaveLength(1);
    await page.unroute('**/api/orders');

    const dearer = sampleMenu();
    sizes(dearer).find((size) => size.id === 'large')!.price = DEARER;
    await loadSampleMenu(page.request, dearer);
    await page.reload();
    await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
    await page.getByRole('button', { name: 'Takeaway' }).click();
    await tile(page, 'Garden').getByRole('button', { name: /Large/ }).click();
    await tile(page, 'Classic Pepperoni')
      .getByRole('button', { name: /Medium/ })
      .click();
    await expect(page.getByTestId('cart-footer'), 'the cart shows the new price').toContainText(
      money(DEARER + MEDIUM),
    );

    const again = page.waitForResponse((response) =>
      isOrderCreate(response.request().method(), response.url()),
    );
    await page.getByRole('button', { name: 'Place Order' }).click();
    const retry = await again;
    expect(retry.status(), await retry.text()).toBe(200);
    expect(retry.request().headers()['idempotency-key'], 'under the first key').toBe(
      first.headers()['idempotency-key'],
    );
    expect(retry.request().postDataJSON(), 'with the request first sent').toEqual(
      first.postDataJSON(),
    );
    await expect(page.getByText(/Order #.+ placed!/)).toBeVisible();
    const orders = await ordersSince(page, before);
    expect(orders, 'exactly one order exists').toHaveLength(1);
    expect(orders[0].subtotal, 'at the price the cart showed when it was placed').toBe(
      LARGE + MEDIUM,
    );
  } finally {
    await loadSampleMenu(page.request);
    for (const order of await ordersSince(page, before)) await cancelOrder(page, order.id);
    await restoreSettings();
  }
});
