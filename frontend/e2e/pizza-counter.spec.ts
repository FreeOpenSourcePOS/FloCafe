import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * A pizza counter as the `pizza` setup profile leaves it. The e2e store is not a pizza-profile
 * store and every spec shares its database, so this one writes the profile's counter settings
 * itself and puts back what was there when it ends.
 */

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });
const SETTINGS = `${BASE}/api/settings`;

const COUNTER: Record<string, string> = {
  tables_required: 'false',
  billing_type: 'prepaid',
  kds_enabled: 'false',
  scheduled_orders_enabled: 'true',
  kot_show_customer_contact: 'delivery',
  pos_order_types: 'takeaway,delivery',
};
const prior: Record<string, string> = {};
let timezone = 'UTC';
const placedOrderIds: number[] = [];

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
    timezone = business.timezone || 'UTC';
    prior.tables_required = String(business.tables_required);
    prior.billing_type = business.billing_type;
    prior.kot_show_customer_contact = String(business.kot_show_customer_contact);
    prior.pos_order_types = (business.pos_order_types as string[]).join(',');
    for (const key of ['kds_enabled', 'scheduled_orders_enabled']) {
      const read = await api.get(`${SETTINGS}/${key}`, { headers: ownerHeaders() });
      expect(read.ok(), `read ${key}`).toBeTruthy();
      prior[key] = (await read.json()).setting?.value === 'false' ? 'false' : 'true';
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
    // A paid order still waiting for its time would keep the scheduled queue on for later specs.
    for (const id of placedOrderIds) {
      const read = await api.get(`${BASE}/api/orders/${id}`, { headers: ownerHeaders() });
      const order = read.ok() ? (await read.json()).order : null;
      if (!order || ['completed', 'cancelled'].includes(order.status)) continue;
      if (order.release_status !== 'released') {
        const released = await api.post(`${BASE}/api/orders/${id}/release`, {
          headers: ownerHeaders(),
        });
        if (!released.ok()) failures.push(`release order ${id}: status ${released.status()}`);
      }
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

async function openPos(page: Page): Promise<void> {
  await setLanguage(page, 'en');
  await loginWithPassword(page, 'owner@flo.local');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-order-type-tabs')).toBeVisible();
}

/** `YYYY-MM-DDTHH:MM` on the store's clock, some minutes from now. */
function storeWallClock(minutesAhead: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(Date.now() + minutesAhead * 60_000));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

test('the order type switch offers Takeaway and Delivery, and starts on Takeaway', async ({
  page,
}) => {
  await openPos(page);
  const types = page.getByTestId('pos-order-type-tabs').getByRole('button');
  await expect(types).toHaveText(['Takeaway', 'Delivery']);
  await expect(types.nth(0)).toHaveAttribute('aria-pressed', 'true');

  await types.nth(1).click();
  await expect(types.nth(1)).toHaveAttribute('aria-pressed', 'true');
  // A new order starts on Takeaway again.
  await page.reload();
  await expect(types).toHaveText(['Takeaway', 'Delivery']);
  await expect(types.nth(0)).toHaveAttribute('aria-pressed', 'true');
});

test('the sidebar shows what a counter uses, without Tables, KDS and WhatsApp', async ({
  page,
}) => {
  // The e2e store starts with WhatsApp switched on, and switching it off would drop the number
  // other specs use. A pizza store never switched it on, so the status is answered as that.
  await page.route('**/api/whatsapp/status', (route) =>
    route.fulfill({ json: { enabled: false, state: 'disconnected', connectedPhone: null } }),
  );
  await openPos(page);
  await expect(page.getByRole('navigation', { name: 'Menu' }).getByRole('link')).toHaveText([
    'POS',
    'Dashboard',
    'Orders',
    'Products',
    'Pizza menu',
    'Inventory',
    'Expenses',
    'Customers',
    'Staff',
    'Settings',
  ]);
});

test('a pickup order placed for a later time shows that time in the scheduled queue', async ({
  page,
}) => {
  await openPos(page);
  const cart = page.getByTestId('cart-shell');
  await expect(
    page.getByTestId('pos-order-type-tabs').getByRole('button', { name: 'Takeaway' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('pos-product-card').first().click();
  await expect(page.getByTestId('cart-item')).toHaveCount(1);

  const at = storeWallClock(95);
  await cart.getByTestId('pos-order-details-summary').click();
  const details = page.getByTestId('pos-order-details-drawer');
  await details.getByTestId('pos-send-to-kitchen-input').fill(at);
  await expect(details.getByTestId('pos-schedule-error')).toHaveCount(0);
  await details.getByTestId('pos-order-details-done-btn').click();
  await expect(details).toHaveCount(0);

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/orders',
  );
  await cart.getByRole('button', { name: 'Place Order' }).click();
  const checkout = page.getByTestId('prepaid-checkout-modal');
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await checkout.getByRole('button', { name: 'Exact due' }).first().click();
  await checkout.getByRole('button', { name: /Confirm Payment/ }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const { order } = await response.json();
  placedOrderIds.push(Number(order.id));
  expect(order.type).toBe('takeaway');
  expect(order.release_status).toBe('scheduled');
  await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
  await expect(checkout).toBeHidden({ timeout: 15_000 });

  await page.mouse.move(0, 0);
  await expect(page.locator('.flo-toast-card')).toHaveCount(0, { timeout: 10_000 });
  await page.getByTestId('pos-scheduled-orders-btn').click();
  const card = page.getByTestId(`scheduled-order-card-${order.id}`);
  await expect(card).toBeVisible();
  // The hour as typed, on a 12 or a 24 hour clock.
  const [hour, minute] = at.slice(11).split(':');
  const hours = [Number(hour), Number(hour) % 12 || 12].map((value) => `0?${value}`).join('|');
  await expect(card).toContainText(new RegExp(`Send to kitchen at:\\s*.*\\b(${hours}):${minute}`));
});
