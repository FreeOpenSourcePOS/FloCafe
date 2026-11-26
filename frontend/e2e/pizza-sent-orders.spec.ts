import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { clearPizzaMenu, loadSampleMenu, sampleMenu } from './helpers/pizza-menu';
import { E2E_PASSWORD, getE2eToken, loginWithPassword } from './helpers/test-auth';
import { E2E_BASE_URL as BASE, E2E_SERVER_APP_BASE_URL as SERVER_APP } from './helpers/urls';

/**
 * A pizza or a deal that has been sent: its lines in the POS, on the Orders
 * page and in the Server App, and changing it from the POS and the Orders page.
 * Every spec shares one database, so this one loads the sample menu itself,
 * never asserts "no menu" against the server, cancels every order it places,
 * deactivates the cashier and the tables it creates, and clears the menu when
 * it ends.
 */

const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };
const WARNING = 'RECIPE NOT PRINTED - CHECK ORDER';
const ADD_FROM_POS = 'Add a half and half or a deal from the POS';
const PRICE_RESET =
  'This line has its own price or a discount. Saving a change returns it to the menu price.';

const menu = sampleMenu();
const LARGE = (menu.sizes as { pizza: { id: string; price: number }[] }).pizza.find(
  (size) => size.id === 'large',
)!.price;
const COMBO = menu.categories
  .find((category) => category.id === 'deals')!
  .items.find((deal) => deal.id === 'large-combo')!;

const HALVES = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'garden', removed: ['Olives'] },
    { pizzaId: 'classic', removed: [] },
  ],
};
const COMBO_RECIPE = {
  kind: 'deal',
  v: 1,
  dealId: 'large-combo',
  pizzas: [{ kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 'garden', removed: [] } }],
  pops: { cola: 2 },
};
const HALVES_LINES = ['1ST: GARDEN', '  NO OLIVES', '2ND: CLASSIC PEPPERONI'];
/** What comes with the deal, from its description, wrapped at the width sent lines are shown at. */
const COMBO_INCLUDES = ['INCLUDES: 1 LARGE PIZZA,', '1 PASTA, 2 POPS,', '1 GARLIC TOAST'];
const COMBO_LINES = ['1) LARGE GARDEN', 'POP: 2 COLA', ...COMBO_INCLUDES];

/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;

interface SentItem {
  id: number;
  product_id: string;
  quantity: number;
  unit_price: number;
  status: string;
  modifier_selection: unknown;
}
interface Placed {
  id: number;
  order_number: string;
  total: number;
  tableId: string;
  tableNumber: string;
}

let api: APIRequestContext;
let business: { billing_type: string; tables_required: unknown };
const placed: Placed[] = [];
let cashierId: string | null = null;

test.beforeAll(async () => {
  api = await playwrightRequest.newContext();
  await loadSampleMenu(api);
  // The POS reopens an order from its table, which only a pay-later shop with tables has.
  const settings = await api.get(`${BASE}/api/settings/business`, { headers: ownerHeaders });
  expect(settings.ok()).toBeTruthy();
  business = await settings.json();
  const changed = await api.put(`${BASE}/api/settings/business`, {
    headers: ownerHeaders,
    data: { ...business, billing_type: 'postpaid', tables_required: true },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
});

test.afterAll(async () => {
  const failures: string[] = [];
  const step = async (name: string, send: () => Promise<{ ok(): boolean; status(): number }>) => {
    try {
      const answer = await send();
      if (!answer.ok()) failures.push(`${name}: status ${answer.status()}`);
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  };
  try {
    for (const order of placed) {
      await step(`cancel order ${order.id}`, () =>
        api.patch(`${BASE}/api/orders/${order.id}/status`, {
          headers: ownerHeaders,
          data: { status: 'cancelled', reason: 'E2E fixture cleanup' },
        }),
      );
      await step(`free table ${order.tableNumber}`, () =>
        api.patch(`${BASE}/api/tables/${order.tableId}/status`, {
          headers: ownerHeaders,
          data: { status: 'available' },
        }),
      );
      // The API has no route that deletes a table; a deactivated one is off every screen.
      await step(`deactivate table ${order.tableNumber}`, () =>
        api.post(`${BASE}/api/tables/${order.tableId}/deactivate`, { headers: ownerHeaders }),
      );
    }
    if (cashierId)
      await step('deactivate the cashier', () =>
        api.post(`${BASE}/api/staff/${cashierId}/deactivate`, { headers: ownerHeaders }),
      );
    // The fixture's own values, whatever another spec left behind before this one read them.
    await step('restore the business settings', () =>
      api.put(`${BASE}/api/settings/business`, {
        headers: ownerHeaders,
        data: { ...business, billing_type: 'prepaid', tables_required: false },
      }),
    );
    await clearPizzaMenu(api);
  } finally {
    await api.dispose();
  }
  expect(failures, 'cleaning up after the sent-orders spec').toEqual([]);
});

/** A table with one order on it: a large half and half with a removal, and a deal. */
async function placeOrder(): Promise<Placed> {
  const tableNumber = `PZ-${Date.now()}-${placed.length}`;
  const table = await api.post(`${BASE}/api/tables`, {
    headers: ownerHeaders,
    data: { number: tableNumber },
  });
  expect(table.ok(), await table.text()).toBeTruthy();
  const tableId = (await table.json()).table.id as string;
  const created = await api.post(`${BASE}/api/orders`, {
    headers: ownerHeaders,
    data: {
      table_id: tableId,
      type: 'dine_in',
      guest_count: 2,
      items: [
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: HALVES,
        },
        { product_id: 'dl-large-combo', quantity: 1, modifier_selection: COMBO_RECIPE },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { order } = await created.json();
  const entry = { id: order.id, order_number: order.order_number, total: 0, tableId, tableNumber };
  placed.push(entry);
  entry.total = (await readOrder(entry.id)).total;
  return entry;
}

async function readOrder(id: number): Promise<{ total: number; items: SentItem[] }> {
  const read = await api.get(`${BASE}/api/orders/${id}`, { headers: ownerHeaders });
  expect(read.ok(), await read.text()).toBeTruthy();
  const { order } = await read.json();
  return {
    total: Number(order.total),
    items: (order.items as SentItem[]).filter(
      (item) => !['cancelled', 'voided', 'void_adjustment'].includes(item.status),
    ),
  };
}

const recipeOf = (item: SentItem) =>
  typeof item.modifier_selection === 'string'
    ? JSON.parse(item.modifier_selection)
    : item.modifier_selection;
const itemOf = (items: SentItem[], productId: string) =>
  items.find((item) => item.product_id === productId)!;

async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, name), animations: 'disabled' });
}

/** Signs in at 1180 × 820. English is set as the owner, because a cashier may not write settings. */
async function signIn(page: Page, email = 'owner@flo.local'): Promise<void> {
  await page.setViewportSize({ width: 1180, height: 820 });
  const language = await api.put(`${BASE}/api/settings/language`, {
    headers: ownerHeaders,
    data: { value: 'en' },
  });
  expect(language.ok()).toBeTruthy();
  await loginWithPassword(page, email);
  await page.evaluate(() =>
    localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'en' } })),
  );
}

/** The POS with the order of that table reopened to add items. */
async function reopenInPos(page: Page, order: Placed): Promise<Locator> {
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  await page.getByRole('button', { name: /Select Table|Table: / }).click();
  await page.getByRole('button').filter({ hasText: order.tableNumber }).click();
  await page.getByRole('button', { name: 'Add Items', exact: true }).click();
  const cart = page.getByTestId('cart-items-scroll');
  await expect(cart.getByText('Already ordered')).toBeVisible();
  return cart;
}

/** The Orders page with that order open in the detail pane. */
async function openInOrders(page: Page, order: Placed): Promise<Locator> {
  await page.goto(`${BASE}/orders`);
  await page
    .getByRole('button')
    .filter({ hasText: `#${order.order_number}` })
    .click();
  const panel = page.getByTestId('orders-detail-panel');
  await expect(panel).toBeVisible();
  return panel;
}

const sentLines = (scope: Locator): Locator => scope.getByTestId('sent-pizza-line');
const detailsOf = (line: Locator): Locator => line.getByTestId('sent-pizza-detail');
const tooSmall = (scope: Locator) =>
  scope.getByRole('button', { name: /^Change (pizza|deal)$/ }).evaluateAll((controls) =>
    controls
      .map((control) => control.getBoundingClientRect())
      .filter((box) => box.width < 48 || box.height < 48)
      .map((box) => `${box.width}x${box.height}`),
  );

test.describe('a sent pizza and a sent deal', () => {
  test('show their lines under "Already ordered" in the POS', async ({ page }) => {
    const order = await placeOrder();
    await signIn(page);
    const cart = await reopenInPos(page, order);
    await expect(sentLines(cart)).toHaveCount(2);
    await expect(detailsOf(sentLines(cart).nth(0))).toHaveText(HALVES_LINES);
    await expect(detailsOf(sentLines(cart).nth(1))).toHaveText(COMBO_LINES);
    await expect(page.getByTestId('sent-pizza-warning')).toHaveCount(0);
    await expect(
      sentLines(cart).nth(0).getByRole('button', { name: 'Change pizza' }),
    ).toBeVisible();
    await expect(sentLines(cart).nth(1).getByRole('button', { name: 'Change deal' })).toBeVisible();
    expect(await tooSmall(cart)).toEqual([]);
    await shot(page, 'pos-sent-lines.png');
  });

  test('show the same lines on the Orders page', async ({ page }) => {
    const order = await placeOrder();
    await signIn(page);
    const panel = await openInOrders(page, order);
    await expect(sentLines(panel)).toHaveCount(2);
    await expect(detailsOf(sentLines(panel).nth(0))).toHaveText(HALVES_LINES);
    await expect(detailsOf(sentLines(panel).nth(1))).toHaveText(COMBO_LINES);
    expect(await tooSmall(panel)).toEqual([]);
    await shot(page, 'orders-sent-lines.png');
  });

  test('a sent half and half is changed from the POS at the same price', async ({ page }) => {
    const order = await placeOrder();
    await signIn(page);
    const cart = await reopenInPos(page, order);
    await sentLines(cart).first().getByRole('button', { name: 'Change pizza' }).click();
    const sheet = page.getByRole('dialog', { name: 'Pizza' });
    const first = sheet.getByRole('group', { name: '1st half' });
    await expect(first.getByRole('button', { name: 'NO Olives', exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Onions', exact: true }).click();
    await sheet.getByRole('button', { name: /^Save/ }).click();
    await expect(sheet).toBeHidden();

    const changed = sentLines(cart).filter({ hasText: '1ST: GARDEN' });
    await expect(detailsOf(changed)).toHaveText([
      '1ST: GARDEN',
      '  NO OLIVES, NO ONIONS',
      '2ND: CLASSIC PEPPERONI',
    ]);
    await expect(sentLines(cart)).toHaveCount(2);
    await expect(changed.getByRole('button', { name: 'Change pizza' })).toBeFocused();

    const stored = await readOrder(order.id);
    expect(stored.items).toHaveLength(2);
    const item = itemOf(stored.items, 'pz-half-and-half');
    expect(recipeOf(item)).toEqual({
      ...HALVES,
      halves: [{ pizzaId: 'garden', removed: ['Olives', 'Onions'] }, HALVES.halves[1]],
    });
    expect(Number(item.unit_price)).toBe(LARGE);
    expect(item.quantity).toBe(1);
    expect(stored.total).toBe(order.total);
  });

  test('a sent deal is changed from the POS at the same price', async ({ page }) => {
    const order = await placeOrder();
    await signIn(page);
    const cart = await reopenInPos(page, order);
    await sentLines(cart).nth(1).getByRole('button', { name: 'Change deal' }).click();
    const dialog = page.getByRole('dialog', { name: COMBO.name as string });
    // The chosen pizza shows alone; Change lists the menu's pizzas again.
    await dialog.getByRole('tabpanel').getByRole('button', { name: 'Change' }).click();
    await dialog.getByRole('tabpanel').getByRole('button', { name: 'Island' }).click();
    await dialog.getByRole('button', { name: /^Save/ }).click();
    await expect(dialog).toBeHidden();

    const changed = sentLines(cart).filter({ hasText: 'POP: 2 COLA' });
    await expect(detailsOf(changed)).toHaveText([
      '1) LARGE ISLAND',
      'POP: 2 COLA',
      ...COMBO_INCLUDES,
    ]);
    await expect(sentLines(cart)).toHaveCount(2);

    const stored = await readOrder(order.id);
    expect(stored.items).toHaveLength(2);
    const item = itemOf(stored.items, 'dl-large-combo');
    expect(recipeOf(item)).toEqual({
      ...COMBO_RECIPE,
      pizzas: [{ ...COMBO_RECIPE.pizzas[0], whole: { pizzaId: 'island', removed: [] } }],
    });
    expect(Number(item.unit_price)).toBe(COMBO.price);
    expect(stored.total).toBe(order.total);
  });

  test('a sent pizza is changed from the Orders page too', async ({ page }) => {
    const order = await placeOrder();
    await signIn(page);
    const panel = await openInOrders(page, order);
    await sentLines(panel).first().getByRole('button', { name: 'Change pizza' }).click();
    const sheet = page.getByRole('dialog', { name: 'Pizza' });
    await sheet.getByRole('button', { name: 'Well done' }).click();
    await sheet.getByRole('button', { name: /^Save/ }).click();
    await expect(sheet).toBeHidden();
    await expect(detailsOf(sentLines(panel).filter({ hasText: '1ST: GARDEN' }))).toHaveText([
      ...HALVES_LINES,
      'WELL DONE',
    ]);
    const item = itemOf((await readOrder(order.id)).items, 'pz-half-and-half');
    expect(recipeOf(item)).toEqual({ ...HALVES, cook: 'well-done' });
  });

  test('a refusal from the server is shown in its own words', async ({ page }) => {
    const order = await placeOrder();
    await signIn(page);
    const cart = await reopenInPos(page, order);
    await page.route(`**/api/orders/${order.id}/items/*/edit`, (route) =>
      route.fulfill({ status: 400, json: { error: 'The kitchen says no' } }),
    );
    await sentLines(cart).first().getByRole('button', { name: 'Change pizza' }).click();
    const sheet = page.getByRole('dialog', { name: 'Pizza' });
    await sheet.getByRole('button', { name: 'Well done' }).click();
    await sheet.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText('The kitchen says no')).toBeVisible();
    // The pizza is not thrown away: the sheet stays open on it.
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(detailsOf(sentLines(cart).first())).toHaveText(HALVES_LINES);
  });

  test('a line with an edit that has no answer yet has no change button', async ({ page }) => {
    const order = await placeOrder();
    const [halfAndHalf] = (await readOrder(order.id)).items;
    await signIn(page);
    await page.evaluate(
      ({ orderId, itemId }) => {
        const tenantId = JSON.parse(localStorage.getItem('tenant')!).id;
        localStorage.setItem(
          `flo.orders.item-edit.attempt.v1:${tenantId}:e2e-owner:${orderId}:${itemId}`,
          JSON.stringify({
            mode: 'quantity',
            path: `/orders/${orderId}/items/${itemId}/edit`,
            orderId,
            itemId,
            actorId: 'e2e-owner',
            tenantId,
            idempotencyKey: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            body: { expected_edit_version: 0, quantity: 2 },
          }),
        );
      },
      { orderId: order.id, itemId: halfAndHalf.id },
    );
    const panel = await openInOrders(page, order);
    await expect(detailsOf(sentLines(panel).first())).toHaveText(HALVES_LINES);
    await expect(
      sentLines(panel).nth(1).getByRole('button', { name: 'Change deal' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change pizza' })).toHaveCount(0);
  });

  test('a line with its own price warns that saving returns it to the menu price', async ({
    page,
  }) => {
    const order = await placeOrder();
    const [halfAndHalf] = (await readOrder(order.id)).items;
    const priced = await api.patch(`${BASE}/api/orders/${order.id}/items/${halfAndHalf.id}/price`, {
      headers: ownerHeaders,
      data: { price: 20, reason: 'Regular' },
    });
    expect(priced.ok(), await priced.text()).toBeTruthy();
    await signIn(page);
    const panel = await openInOrders(page, order);
    await sentLines(panel).first().getByRole('button', { name: 'Change pizza' }).click();
    await expect(page.getByText(PRICE_RESET)).toBeVisible();
    const sheet = page.getByRole('dialog', { name: 'Pizza' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    // The deal has no price of its own, so it opens without the warning.
    await sentLines(panel).nth(1).getByRole('button', { name: 'Change deal' }).click();
    await expect(page.getByRole('dialog', { name: COMBO.name as string })).toBeVisible();
    await expect(page.getByText(PRICE_RESET)).toHaveCount(1);
  });

  test('the Orders page edit window changes quantity and size and keeps the recipe', async ({
    page,
  }) => {
    const order = await placeOrder();
    await signIn(page);
    const panel = await openInOrders(page, order);
    const bodies: Record<string, unknown>[] = [];
    await page.route(`**/api/orders/${order.id}/items/*/edit`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.continue();
    });

    // The quantity of the half and half.
    await panel.getByTitle('Edit item').first().click();
    await page.locator('input[type="number"]').fill('2');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('input[type="number"]')).toBeHidden();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toEqual({ expected_edit_version: expect.any(Number), quantity: 2 });
    let item = itemOf((await readOrder(order.id)).items, 'pz-half-and-half');
    expect(item.quantity).toBe(2);
    expect(recipeOf(item)).toEqual(HALVES);

    // Its size, through "Replace item": the window sends no recipe, so the stored one stays.
    await expect(detailsOf(sentLines(panel).filter({ hasText: '1ST: GARDEN' }))).toHaveText(
      HALVES_LINES,
    );
    await panel
      .locator('div.text-sm')
      .filter({ hasText: 'Half & Half' })
      .getByTitle('Edit item')
      .click();
    await page.getByRole('button', { name: 'Replace item' }).click();
    await page.getByPlaceholder('Search products').fill('Half & Half');
    await page.getByRole('button', { name: /^Half & Half/ }).click();
    await page.getByRole('radio', { name: /^Medium/ }).click();
    await page.getByRole('button', { name: /^Save changes/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => bodies.length).toBe(2);
    const replacement = bodies[1].replacement as Record<string, unknown>;
    expect(replacement.variant_id).toBe('pz-half-and-half-medium');
    expect('modifier_selection' in replacement).toBe(false);
    await expect(page.getByPlaceholder('Search products')).toBeHidden();
    item = itemOf((await readOrder(order.id)).items, 'pz-half-and-half');
    expect(recipeOf(item)).toEqual({ ...HALVES, sizeId: 'medium' });
  });

  test('"Add Item" on the Orders page sends a half and half and a deal to the POS', async ({
    page,
  }) => {
    const order = await placeOrder();
    await signIn(page);
    const panel = await openInOrders(page, order);
    await panel.getByRole('button', { name: 'Add Item', exact: true }).click();
    const search = page.getByPlaceholder('Search menu items…');
    const product = (name: string) =>
      page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) });

    await search.fill('Half & Half');
    await product('Half & Half').click();
    await expect(page.getByText(ADD_FROM_POS).first()).toBeVisible();
    await search.fill(COMBO.name as string);
    await product(COMBO.name as string).click();
    await expect(page.getByText(ADD_FROM_POS)).not.toHaveCount(0);
    await expect(page.getByText('Selected Items')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Add to Cart/ })).toHaveCount(0);

    // A drink is added as before.
    await search.fill('Cola');
    await product('Cola').click();
    await page.getByRole('radio', { name: /^Can/ }).click();
    await page.getByRole('button', { name: /^Add to Cart/ }).click();
    await expect(page.getByText('Selected Items')).toBeVisible();
    await page.getByRole('button', { name: 'Add 1 Item(s)' }).click();
    await expect(search).toBeHidden();
    const stored = await readOrder(order.id);
    expect(stored.items.map((item) => item.product_id).sort()).toEqual([
      'dl-large-combo',
      'dr-cola',
      'pz-half-and-half',
    ]);
  });

  test('without the menu in the browser a sent pizza shows the warning words', async ({ page }) => {
    const order = await placeOrder();
    await page.route('**/api/pizza/catalog', (route) =>
      route.fulfill({ status: 404, json: { error: 'No menu has been loaded' } }),
    );
    await signIn(page);
    const panel = await openInOrders(page, order);
    await expect(sentLines(panel)).toHaveCount(2);
    for (const line of await sentLines(panel).all()) {
      await expect(line.getByTestId('sent-pizza-warning')).toHaveText(WARNING);
      await expect(line.locator('svg')).toBeVisible();
    }
    await expect(page.getByTestId('sent-pizza-detail')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Change (pizza|deal)$/ })).toHaveCount(0);
  });

  test('a cashier without the right to edit a sent line is refused', async ({ page }) => {
    const order = await placeOrder();
    const email = `sent-orders-cashier-${Date.now()}@flo.local`;
    const account = await api.post(`${BASE}/api/staff`, {
      headers: ownerHeaders,
      data: { name: 'Sent Orders Cashier', email, password: E2E_PASSWORD, role: 'cashier' },
    });
    expect(account.status(), await account.text()).toBe(201);
    const cashier = (await account.json()).staff as { id: string };
    cashierId = cashier.id;

    await signIn(page, email);
    const panel = await openInOrders(page, order);
    await expect(detailsOf(sentLines(panel).first())).toHaveText(HALVES_LINES);
    await expect(page.getByRole('button', { name: /^Change (pizza|deal)$/ })).toHaveCount(0);
    await expect(panel.getByTitle('Edit item')).toHaveCount(0);

    const [item] = (await readOrder(order.id)).items;
    const refused = await api.patch(`${BASE}/api/orders/${order.id}/items/${item.id}/edit`, {
      headers: {
        Authorization: `Bearer ${getE2eToken(cashier.id, email, 'cashier')}`,
        'Idempotency-Key': `sent-orders-${Date.now()}`,
      },
      data: {
        expected_edit_version: 0,
        replacement: {
          product_id: item.product_id,
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: { ...HALVES, cook: 'well-done' },
        },
      },
    });
    expect(refused.status()).toBe(403);
    expect(recipeOf(itemOf((await readOrder(order.id)).items, 'pz-half-and-half'))).toEqual(HALVES);
  });

  test('the Server App shows the lines and sends a half and half to the POS', async ({ page }) => {
    const order = await placeOrder();
    await page.goto(`${SERVER_APP}/server-standalone`);
    await page.evaluate(
      (token) => {
        localStorage.setItem('flocafe:server-app-token', token);
        localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'en' } }));
      },
      getE2eToken('e2e-server', 'server@flo.local', 'server'),
    );
    await page.reload();
    await page.getByRole('button', { name: new RegExp(order.tableNumber) }).click();

    // Its server forwards the menu, so the lines are written out as in the POS.
    const ticket = page.locator('body');
    await expect(detailsOf(sentLines(ticket).nth(0))).toHaveText(HALVES_LINES);
    await expect(detailsOf(sentLines(ticket).nth(1))).toHaveText(COMBO_LINES);
    await expect(page.getByTestId('sent-pizza-warning')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Change (pizza|deal)$/ })).toHaveCount(0);

    const grid = page.getByTestId('pos-product-grid');
    await grid.getByPlaceholder('Search menu').fill('Half & Half');
    await grid.getByTestId('pos-product-card').filter({ hasText: 'Half & Half' }).click();
    await expect(page.getByText(ADD_FROM_POS).first()).toBeVisible();
    await grid.getByPlaceholder('Search menu').fill(COMBO.name as string);
    await grid
      .getByTestId('pos-product-card')
      .filter({ hasText: COMBO.name as string })
      .click();
    await expect(page.getByRole('button', { name: /^Add to Cart/ })).toHaveCount(0);
    await expect(page.getByText('Tap menu items to add them here.').first()).toBeVisible();
  });
});
