import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import {
  getE2eToken,
  loginWithPassword,
  readOrdersLayout,
  setLanguage,
  setOrdersLayout,
  type E2EOrdersLayout,
} from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * The phone number box of a pizza delivery order. The e2e store is a Thai store, so a local number
 * is a Thai one; the made-up numbers all carry 555. Every spec shares the database, so this one
 * writes the pizza counter settings itself and puts back what was there when it ends. The API has
 * no route that deletes or deactivates a customer, so the made-up customers stay.
 */

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });
const SETTINGS = `${BASE}/api/settings`;
const COUNTER: Record<string, string> = {
  tables_required: 'false',
  billing_type: 'prepaid',
  kds_enabled: 'false',
  pos_order_types: 'takeaway,delivery',
  kot_show_customer_contact: 'delivery',
};
const prior: Record<string, string> = {};
const placedOrderIds: number[] = [];
let layoutBefore: E2EOrdersLayout = 'split';

const RUN = String(Date.now()).slice(-4);
/** A local number and the same number as the store keeps it. */
const number = (exchange: string) => ({
  local: `082 555 ${exchange}`,
  e164: `+6682555${exchange}`,
});
const NEW_NUMBER = number(RUN);
const KEYBOARD_NUMBER = number(String((Number(RUN) + 1) % 10000).padStart(4, '0'));
const ROBIN = {
  id: '',
  name: 'Robin Example',
  address: '12 Example Lane',
  ...number(String((Number(RUN) + 2) % 10000).padStart(4, '0')),
};
const PICKED = {
  id: '',
  name: 'Pick Example',
  ...number(String((Number(RUN) + 3) % 10000).padStart(4, '0')),
};
const NEEDED = "Add the customer's phone number for a delivery.";

async function writeSettings(values: Record<string, string>): Promise<string[]> {
  const api = await playwrightRequest.newContext();
  const failures: string[] = [];
  try {
    for (const [key, value] of Object.entries(values)) {
      const saved = await api.put(`${SETTINGS}/${key}`, {
        headers: ownerHeaders(),
        data: { value },
      });
      if (!saved.ok()) failures.push(`${key}: status ${saved.status()}`);
    }
  } finally {
    await api.dispose();
  }
  return failures;
}

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext();
  try {
    const business = await (
      await api.get(`${SETTINGS}/business`, { headers: ownerHeaders() })
    ).json();
    prior.tables_required = String(business.tables_required);
    prior.billing_type = business.billing_type;
    prior.kot_show_customer_contact = String(business.kot_show_customer_contact);
    prior.pos_order_types = (business.pos_order_types as string[]).join(',');
    const read = await api.get(`${SETTINGS}/kds_enabled`, { headers: ownerHeaders() });
    expect(read.ok(), 'read kds_enabled').toBeTruthy();
    prior.kds_enabled = (await read.json()).setting?.value === 'false' ? 'false' : 'true';
    for (const customer of [ROBIN, PICKED]) {
      const made = await api.post(`${BASE}/api/customers`, {
        headers: ownerHeaders(),
        data: {
          name: customer.name,
          phone: customer.e164,
          address: 'address' in customer ? customer.address : '',
        },
      });
      expect(made.status(), await made.text()).toBe(201);
      customer.id = (await made.json()).customer.id;
    }
  } finally {
    await api.dispose();
  }
  expect(await writeSettings(COUNTER), 'write the counter settings').toEqual([]);
});

test.afterAll(async () => {
  const api = await playwrightRequest.newContext();
  const failures: string[] = [];
  try {
    for (const id of placedOrderIds) {
      const done = await api.patch(`${BASE}/api/orders/${id}/status`, {
        headers: ownerHeaders(),
        data: { status: 'completed' },
      });
      if (!done.ok()) failures.push(`complete order ${id}: status ${done.status()}`);
    }
  } finally {
    await api.dispose();
  }
  failures.push(...(await writeSettings(prior)));
  expect(failures, 'put the store back as it was').toEqual([]);
});

/** Every page the browser printer opens, kept so a test can read what was printed. */
async function capturePrints(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const appWindow = window as Window & { __printed?: string[] };
    appWindow.__printed = [];
    window.open = (() => {
      const printDocument = document.implementation.createHTMLDocument('Print');
      return {
        document: printDocument,
        print: () =>
          appWindow.__printed!.push(
            printDocument.body.innerText || printDocument.body.textContent || '',
          ),
        close: () => {},
        focus: () => {},
      } as unknown as Window;
    }) as typeof window.open;
  });
}

const printed = (page: Page) =>
  page.evaluate(() => (window as Window & { __printed?: string[] }).__printed ?? []);

async function openPos(page: Page): Promise<void> {
  await setLanguage(page, 'en');
  await loginWithPassword(page, 'owner@flo.local');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-order-type-tabs')).toBeVisible();
}

const cart = (page: Page) => page.getByTestId('cart-shell');
const orderType = (page: Page, name: string) =>
  page.getByTestId('pos-order-type-tabs').getByRole('button', { name });
const phoneBox = (page: Page) => cart(page).getByLabel('Phone number');
const nameBox = (page: Page) => cart(page).getByLabel('Name', { exact: true });
const placeOrder = (page: Page) => cart(page).getByRole('button', { name: 'Place Order' });

async function addItem(page: Page): Promise<void> {
  await page.getByTestId('pos-product-card').first().click();
  await expect(page.getByTestId('cart-item')).toHaveCount(1);
}

/** Pays the open checkout in cash and returns the order the POS created. */
async function payInCash(page: Page, created: Promise<import('@playwright/test').Response>) {
  const checkout = page.getByTestId('prepaid-checkout-modal');
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await checkout.getByRole('button', { name: 'Exact due' }).first().click();
  await checkout.getByRole('button', { name: /Confirm Payment/ }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const { order } = await response.json();
  placedOrderIds.push(Number(order.id));
  await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
  await expect(checkout).toBeHidden({ timeout: 15_000 });
  return order as { id: number; order_number: string; customer_id: string | null };
}

const orderCreated = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/orders',
  );

async function readBack(page: Page, orderId: number) {
  const read = await page.request.get(`${BASE}/api/orders/${orderId}`, { headers: ownerHeaders() });
  expect(read.ok()).toBeTruthy();
  const { order } = await read.json();
  const customer = await page.request.get(`${BASE}/api/customers/${order.customer_id}`, {
    headers: ownerHeaders(),
  });
  expect(customer.ok(), 'the order has a customer').toBeTruthy();
  return { order, customer: (await customer.json()).customer };
}

test.describe.configure({ mode: 'serial' });

test('the phone box shows for Delivery and not for Takeaway', async ({ page }) => {
  await openPos(page);
  await expect(orderType(page, 'Takeaway')).toHaveAttribute('aria-pressed', 'true');
  await expect(phoneBox(page)).toHaveCount(0);

  await orderType(page, 'Delivery').click();
  await expect(phoneBox(page)).toBeVisible();
  await expect(phoneBox(page)).toHaveAttribute('inputmode', 'tel');
  await expect(nameBox(page)).toBeVisible();
  for (const control of [phoneBox(page), nameBox(page)]) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
  }

  await orderType(page, 'Takeaway').click();
  await expect(phoneBox(page)).toHaveCount(0);
});

test('Place Order without a phone number is stopped with the message and the focus in the box', async ({
  page,
}) => {
  let posted = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/orders')
      posted += 1;
  });
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await addItem(page);

  await placeOrder(page).click();
  await expect(cart(page).getByText(NEEDED)).toBeVisible();
  await expect(phoneBox(page)).toBeFocused();
  await expect(page.getByTestId('prepaid-checkout-modal')).toHaveCount(0);

  await phoneBox(page).fill('12345');
  await placeOrder(page).click();
  await expect(cart(page).getByText(NEEDED)).toBeVisible();
  await expect(phoneBox(page)).toBeFocused();
  await expect(page.getByTestId('prepaid-checkout-modal')).toHaveCount(0);
  expect(posted, 'nothing was sent').toBe(0);
});

let newOrder: { id: number; order_number: string };

test('a new number places the order with a new customer and its phone', async ({ page }) => {
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await addItem(page);
  await phoneBox(page).fill(NEW_NUMBER.local);
  await nameBox(page).fill('Sam Sample');

  const created = orderCreated(page);
  await placeOrder(page).click();
  newOrder = await payInCash(page, created);

  const { order, customer } = await readBack(page, newOrder.id);
  expect(order.type).toBe('delivery');
  expect(customer.phone).toBe(NEW_NUMBER.e164);
  expect(customer.name).toBe('Sam Sample');
});

test("the delivery slip's print data for that order carries the number", async ({ page }) => {
  layoutBefore = await readOrdersLayout(page);
  await setOrdersLayout(page, 'cards');
  try {
    await capturePrints(page);
    // Other specs leave saved printers in the shared store, and a saved printer sends the slip to
    // the server route instead of the browser; this page is told there are none.
    await page.route('**/api/printers', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { printers: [] } })
        : route.continue(),
    );
    await setLanguage(page, 'en');
    await loginWithPassword(page, 'owner@flo.local');
    await page.goto(`${BASE}/orders`);
    await page.getByRole('main').getByRole('button', { name: 'All', exact: true }).click();
    const card = page
      .locator('div.bg-card.rounded-xl')
      .filter({ hasText: `#${newOrder.order_number}` })
      .first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Delivery Slip' }).click();
    await expect
      .poll(async () => (await printed(page)).find((text) => text.includes('Sam Sample')) ?? '')
      .toContain(NEW_NUMBER.e164);
  } finally {
    await setOrdersLayout(page, layoutBefore);
  }
});

test('a known number attaches that customer and offers their address', async ({ page }) => {
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await addItem(page);
  await phoneBox(page).fill(ROBIN.local);
  await expect(cart(page).getByTestId('pizza-delivery-customer')).toHaveText(ROBIN.name);
  await expect(nameBox(page)).toHaveCount(0);
  await expect(cart(page).getByTestId('pos-order-details-summary')).toContainText(ROBIN.address);

  const created = orderCreated(page);
  await placeOrder(page).click();
  const order = await payInCash(page, created);
  const { customer } = await readBack(page, order.id);
  expect(customer.id).toBe(ROBIN.id);
});

test('a customer picked from the search shows in the box, and another number changes them', async ({
  page,
}) => {
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await page.getByTestId('pos-customer-search-input').first().fill(PICKED.e164);
  await page.getByRole('button').filter({ hasText: PICKED.name }).first().click();
  await expect(phoneBox(page)).toHaveValue(PICKED.e164);
  await expect(cart(page).getByTestId('pizza-delivery-customer')).toHaveText(PICKED.name);

  await phoneBox(page).fill(ROBIN.local);
  await expect(cart(page).getByTestId('pizza-delivery-customer')).toHaveText(ROBIN.name);
  await expect(page.getByTestId('pos-customer-select-btn').first()).toContainText(ROBIN.name);
});

test('keyboard only: the box is reached with Tab and the order is placed with Enter', async ({
  page,
}) => {
  await openPos(page);
  await addItem(page);
  await orderType(page, 'Delivery').focus();
  await page.keyboard.press('Enter');
  await expect(orderType(page, 'Delivery')).toHaveAttribute('aria-pressed', 'true');

  let reached = false;
  for (let i = 0; i < 8 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await phoneBox(page).evaluate((element) => element === document.activeElement);
  }
  expect(reached, 'Tab reaches the phone box from the order type switch').toBe(true);
  await page.keyboard.type(KEYBOARD_NUMBER.local);
  await page.keyboard.press('Tab');
  await expect(nameBox(page)).toBeFocused();
  await page.keyboard.type('Kim Keyboard');

  await placeOrder(page).focus();
  const created = orderCreated(page);
  await page.keyboard.press('Enter');
  const checkout = page.getByTestId('prepaid-checkout-modal');
  await expect(checkout).toBeVisible();
  const order = await payInCash(page, created);
  const { customer } = await readBack(page, order.id);
  expect(customer.phone).toBe(KEYBOARD_NUMBER.e164);
  expect(customer.name).toBe('Kim Keyboard');
});
