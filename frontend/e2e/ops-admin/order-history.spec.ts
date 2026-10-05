import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, placeOrderAndPayCash, addToCart, ownerAuth, money, fmt } from './helpers';

/**
 * Order history: finding a sale that already happened.
 *
 * History is only useful if it finds the right sale and shows what was really
 * sold, so each scenario locates an order the same way an operator would (by
 * number, by customer, by filter) and then checks the opened order against the
 * stored record rather than against itself.
 */

const RUN = Date.now().toString(36).slice(-4);

/** Two settled sales and one still-open order, so the filters have something to separate. */
let settled: Array<{ order_number: string; total: number; subtotal: number; customer?: string }>;
let open: { order_number: string };
let customerName: string;

test.describe('operations admin - order history', () => {
  test.beforeAll(async ({ request }) => {
    // A customer to attach one sale to, so search-by-name and search-by-phone
    // have something real to find.
    const created = await request.post(`${E2E_BASE_URL}/api/customers`, {
      headers: ownerAuth(),
      data: { name: `Ops History ${RUN}`, phone: `+668${String(Date.now()).slice(-8)}` },
    });
    expect(created.status()).toBe(201);
    customerName = ((await created.json()) as { customer: { name: string } }).customer.name;

    settled = [];
    for (let i = 0; i < 2; i++) {
      const res = await request.post(`${E2E_BASE_URL}/api/orders`, {
        headers: ownerAuth(),
        data: {
          type: 'takeaway',
          items: [{ product_id: 'e2e-product', quantity: i + 1 }],
          ...(i === 0 ? {} : { customer_id: undefined }),
        },
      });
      expect(res.status()).toBe(201);
      const { order } = (await res.json()) as { order: { id: number; order_number: string; total: number; subtotal: number } };
      // Settle it the same way the POS does, so it lands in history as completed.
      const completed = await request.patch(`${E2E_BASE_URL}/api/orders/${order.id}/status`, {
        headers: ownerAuth(),
        data: { status: 'completed' },
      });
      expect(completed.ok()).toBeTruthy();
      settled.push(order);
    }

    // Attach the customer to the second sale for the by-name search.
    const withCustomer = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: ownerAuth(),
      data: { type: 'delivery', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    const { order: delivery } = (await withCustomer.json()) as { order: { id: number; order_number: string; total: number; subtotal: number } };
    const customers = (await (await request.get(`${E2E_BASE_URL}/api/customers`, { headers: ownerAuth() })).json()) as { data: Array<{ name: string; id: string }> };
    const attached = await request.patch(`${E2E_BASE_URL}/api/orders/${delivery.id}/customer`, {
      headers: ownerAuth(),
      data: { customer_id: customers.data.find((c) => c.name === customerName)!.id },
    });
    expect(attached.ok()).toBeTruthy();

    // Settle it too, so every entry in `settled` really is a settled sale and
    // the Completed filter is being asked a fair question.
    const completedDelivery = await request.patch(`${E2E_BASE_URL}/api/orders/${delivery.id}/status`, {
      headers: ownerAuth(),
      data: { status: 'completed' },
    });
    expect(completedDelivery.ok()).toBeTruthy();
    settled.push({ ...delivery, customer: customerName });

    const openRes = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: ownerAuth(),
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    open = ((await openRes.json()) as { order: { order_number: string } }).order;
  });

  test('searching by order number finds that sale and no other', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/orders`);

    // The list opens on the Active pill, which leaves settled sales out of the
    // search until the operator widens it.
    await page.getByRole('button', { name: 'All', exact: true }).first().click();

    const search = page.getByPlaceholder('Search by order number, name, or phone…');
    await expect(search).toBeVisible();
    await search.fill(settled[0].order_number);
    await page.waitForTimeout(1200);

    const rows = page.getByRole('button').filter({ hasText: /ORD-/ });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`#${settled[0].order_number}`);
  });

  test('searching by customer name finds the sale they made', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button', { name: 'All', exact: true }).first().click();

    const search = page.getByPlaceholder('Search by order number, name, or phone…');
    await search.fill(customerName);
    await page.waitForTimeout(1200);

    const rows = page.getByRole('button').filter({ hasText: /ORD-/ });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`#${settled[2].order_number}`);
  });

  test('a search that matches nothing says so instead of showing everything', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/orders`);

    const search = page.getByPlaceholder('Search by order number, name, or phone…');
    await search.fill('zzz-no-such-order-zzz');
    await page.waitForTimeout(1200);

    await expect(page.getByRole('button').filter({ hasText: /ORD-/ })).toHaveCount(0);
    await expect(page.getByText(/No orders found/i)).toBeVisible();
  });

  test('the completed filter shows settled sales and leaves open ones out', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/orders`);

    // "All" is the default and includes the order still awaiting payment.
    await expect(page.getByRole('button').filter({ hasText: `#${open.order_number}` }).first()).toBeVisible();

    // The Active pill and the status dropdown both apply, so the pill has to be
    // widened before the dropdown can mean "settled sales".
    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.locator('select').filter({ has: page.locator('option[value="completed"]') }).selectOption('completed');
    await page.waitForTimeout(1200);

    await expect(page.getByRole('button').filter({ hasText: `#${open.order_number}` })).toHaveCount(0);
    for (const sale of settled) {
      await expect(page.getByRole('button').filter({ hasText: `#${sale.order_number}` }).first()).toBeVisible();
    }
  });

  test('FINDING: the Active pill and the Completed dropdown contradict each other', async ({ page, request }) => {
    // The pill and the status dropdown are applied together, and "Active" counts
    // a completed order as inactive once its items are served. So leaving the
    // pill alone while asking for Completed hides precisely the settled sales
    // the operator is trying to find, with nothing on screen to explain it.
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const created = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    const { order } = (await created.json()) as { order: { id: number; order_number: string } };
    const completed = await request.patch(`${E2E_BASE_URL}/api/orders/${order.id}/status`, {
      headers,
      data: { status: 'completed' },
    });
    expect(completed.ok()).toBeTruthy();

    await page.goto(`${E2E_BASE_URL}/orders`);

    // Asked for Completed while the Active pill is still selected: not listed.
    await page.locator('select').filter({ has: page.locator('option[value="completed"]') }).selectOption('completed');
    await page.waitForTimeout(1200);
    await expect(page.getByRole('button').filter({ hasText: `#${order.order_number}` })).toHaveCount(0);

    // The very same order appears the moment the pill is widened.
    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.waitForTimeout(1200);
    await expect(page.getByRole('button').filter({ hasText: `#${order.order_number}` }).first()).toBeVisible();
  });

  test('FINDING: search only sees the orders already loaded, and older sales are unreachable', async ({ page, request }) => {
    // Filling past the page size is rate limited, so this scenario legitimately
    // takes longer than the default budget.
    test.setTimeout(240_000);
    // order history is only useful if a sale can be found after the fact. The
    // Orders screen fetches a single page (per_page: 50) and then filters that
    // page in the browser; GET /api/orders has no text-search parameter and the
    // screen offers no pagination or "load more". So any order beyond the
    // newest 50 cannot be found, and the screen says "No orders found" for an
    // order that genuinely exists.
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    // Push a known order out of the loaded window by creating more than a
    // page's worth after it, so this holds whatever else the database holds.
    const target = ((await (await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    })).json()) as { order: { order_number: string } }).order;

    // The order write route is rate limited, so a burst this size has to wait
    // its turn rather than fail the scenario on a 429.
    const FILLER = 50;
    for (let i = 0; i < FILLER; i++) {
      let res = await request.post(`${E2E_BASE_URL}/api/orders`, {
        headers,
        data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
      });
      for (let waited = 0; res.status() === 429 && waited < 90_000; waited += 5000) {
        await page.waitForTimeout(5000);
        res = await request.post(`${E2E_BASE_URL}/api/orders`, {
          headers,
          data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
        });
      }
      expect(res.ok(), `filler order ${i + 1}/${FILLER} must be created (got ${res.status()})`).toBeTruthy();
    }

    // The backend holds it, and its own listing can still reach it.
    const listed = await request.get(`${E2E_BASE_URL}/api/orders?per_page=200`, { headers });
    const { orders } = (await listed.json()) as { orders: Array<{ order_number: string }> };
    expect(orders.some((o) => o.order_number === target.order_number), 'the order must exist in the store').toBeTruthy();

    // The screen, however, cannot find it.
    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.getByPlaceholder('Search by order number, name, or phone…').fill(target.order_number);
    await page.waitForTimeout(2000);

    await expect(page.getByRole('button').filter({ hasText: `#${target.order_number}` })).toHaveCount(0);
    await expect(page.getByText(/No orders found/i)).toBeVisible();

    // And there is no control that would let the operator widen the window.
    await expect(page.getByRole('button').filter({ hasText: /Load more|Next page|Show more/i })).toHaveCount(0);
  });

  test('the type filter separates takeaway from delivery', async ({ page, request }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    // Provisioned here rather than reused from beforeAll, because the search
    // scenario above deliberately fills the list past its loaded page size and
    // would otherwise push these out of the window this screen fetches.
    const made = async (type: string) => ((await (await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type, items: [{ product_id: 'e2e-product', quantity: 1 }] },
    })).json()) as { order: { order_number: string } }).order;

    const delivery = await made('delivery');
    const takeaway = await made('takeaway');

    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button', { name: 'All', exact: true }).first().click();

    await page.locator('select').filter({ has: page.locator('option[value="delivery"]') }).selectOption('delivery');
    await page.waitForTimeout(1200);

    // The delivery order is listed and the takeaway one is not.
    await expect(page.getByRole('button').filter({ hasText: `#${delivery.order_number}` }).first()).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: `#${takeaway.order_number}` })).toHaveCount(0);

    // And everything still listed really is a delivery.
    const rows = page.getByRole('button').filter({ hasText: /ORD-/ });
    for (const row of await rows.all()) {
      await expect(row).toContainText('Delivery');
    }
  });

  test('a historical order opens showing exactly what was sold', async ({ page, request }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    // Provisioned here for the same reason as the type-filter scenario: the
    // search scenario fills the list past the window this screen fetches.
    const created = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 2 }] },
    });
    expect(created.status()).toBe(201);
    const sale = ((await created.json()) as { order: { id: number; order_number: string; subtotal: number; total: number } }).order;
    const completed = await request.patch(`${E2E_BASE_URL}/api/orders/${sale.id}/status`, {
      headers,
      data: { status: 'completed' },
    });
    expect(completed.ok()).toBeTruthy();

    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button', { name: 'All', exact: true }).first().click();

    await page.locator('select').filter({ has: page.locator('option[value="completed"]') }).selectOption('completed');
    await page.waitForTimeout(1000);

    // The two-quantity sale: 2 x 60.00 net, 7% tax on top.
    expect(sale.subtotal).toBe(120);
    await page.getByRole('button').filter({ hasText: `#${sale.order_number}` }).first().click();
    await expect(page.getByText(`#${sale.order_number}`).nth(1)).toBeVisible();

    const detail = await page.locator('body').innerText();
    expect(money(detail.match(/Subtotal\s*฿([\d,]+\.\d{2})/)?.[1] ?? '')).toBe(sale.subtotal);
    expect(money(detail.match(/Tax\s*฿([\d,]+\.\d{2})/)?.[1] ?? '')).toBeCloseTo(sale.total - sale.subtotal, 2);
    expect(money(detail.match(/Total\s*฿([\d,]+\.\d{2})/)?.[1] ?? '')).toBeCloseTo(sale.total, 2);

    // The line itself, and the gross of it.
    await expect(page.getByText(/E2E Coffee/).first()).toBeVisible();
    await expect(page.getByText(`฿${fmt(sale.total)}`).last()).toBeVisible();

    // A settled order is read-only: it offers no way to keep changing it.
    await expect(page.getByRole('button', { name: /^Checkout$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Add Item$/ })).toHaveCount(0);
  });

  test('a sale placed through the POS appears in history as completed', async ({ page }) => {
    // The end-to-end version of the above: pay at the till, find it in history.
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/pos`);
    await addToCart(page, 'E2E Coffee', 1);
    const orderNumber = await placeOrderAndPayCash(page);

    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.locator('select').filter({ has: page.locator('option[value="completed"]') }).selectOption('completed');
    await page.waitForTimeout(1200);

    const row = page.getByRole('button').filter({ hasText: `#${orderNumber}` }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Completed');
  });
});