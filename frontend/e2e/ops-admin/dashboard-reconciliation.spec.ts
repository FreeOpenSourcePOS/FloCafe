import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, addToCart, placeOrderAndPayCash, money, setApprovalPin } from './helpers';

/**
 * Dashboard reconciliation.
 *
 * A dashboard that disagrees with the ledger is the worst defect in this
 * programme: staff make shift, cash and closing decisions from these numbers.
 *
 * The e2e database is shared and long-lived, so every assertion here is made as
 * a *delta* against a baseline read immediately beforehand. That way the check
 * is about what this scenario transacted, not about how much history happens to
 * have accumulated, and it stays meaningful no matter what else has run.
 */

type Summary = {
  summary: {
    orders: { count: number; total: number };
    bills: { count: number; total: number; collected: number };
    ordersByStatus: Array<{ status: string; count: number }>;
  };
};

type Financial = {
  financialSummary: {
    grossCollected: number;
    refunded: number;
    netCollected: number;
    billCount: number;
    averageOrderValue: number;
  };
};

async function readLedgers(page: import('@playwright/test').Page): Promise<{ summary: Summary['summary']; money: Financial['financialSummary'] }> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const headers = { Authorization: `Bearer ${token}` };
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const summary = (await (await page.request.get(`${E2E_BASE_URL}/api/reports/summary?date=${date}`, { headers })).json()) as Summary;
  const financial = (await (await page.request.get(
    `${E2E_BASE_URL}/api/reports/financial-summary?start_date=${date}&end_date=${date}`,
    { headers },
  )).json()) as Financial;

  return { summary: summary.summary, money: financial.financialSummary };
}

async function readRunningOrders(page: import('@playwright/test').Page): Promise<number> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const response = await page.request.get(`${E2E_BASE_URL}/api/reports/daily-stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), 'the running-orders report must be available').toBeTruthy();
  return ((await response.json()) as { runningOrders: number }).runningOrders;
}

/** The headline figures the dashboard renders, read off the screen itself. */
async function readDashboard(page: import('@playwright/test').Page): Promise<Record<string, number>> {
  // The dashboard fetches several reports before it paints, so wait for the
  // first headline rather than reading a half-rendered screen.
  await page.getByText("Today's Sales").waitFor({ state: 'visible', timeout: 30_000 });

  const text = await page.locator('body').innerText();
  const after = (label: string) => {
    const at = text.indexOf(label);
    if (at < 0) throw new Error(`the dashboard did not render "${label}"`);
    return money(text.slice(at + label.length, at + label.length + 40).match(/฿([\d,]+\.\d{2})/)?.[1] ?? '');
  };
  const countAfter = (label: string) => {
    const at = text.indexOf(label);
    if (at < 0) throw new Error(`the dashboard did not render "${label}"`);
    return Number(text.slice(at + label.length, at + label.length + 20).match(/\d+/)?.[0] ?? 'NaN');
  };
  return {
    todaysSales: after("Today's Sales"),
    avgOrderValue: after('Avg Order Value'),
    runningOrders: countAfter('Running Orders'),
  };
}

const OWNER_APPROVAL_PIN = '1234';

test.describe('@ci-tier2 operations admin - dashboard reconciliation', () => {
  test.beforeAll(async ({ request }) => {
    // Refunds are gated on a Staff Approval PIN, and no seeded account has one.
    // Without this the refund scenario below would silently verify nothing.
    await setApprovalPin({ request }, 'e2e-owner', OWNER_APPROVAL_PIN);
  });

  test.afterAll(async ({ request }) => {
    await setApprovalPin({ request }, 'e2e-owner', null);
  });

  test.beforeEach(async ({ page }) => {
    await login(page, 'owner');
  });

  test('today\'s sales move by exactly what a real sale collects', async ({ page }) => {
    const before = await readLedgers(page);

    await page.goto(`${E2E_BASE_URL}/pos`);
    await addToCart(page, 'E2E Coffee', 1);
    const orderNumber = await placeOrderAndPayCash(page);
    expect(orderNumber, 'the scenario must have taken a real payment').toBeTruthy();

    const after = await readLedgers(page);

    // The one sale moved the day's collections by its own total, nothing else.
    const collected = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` },
    });
    const { orders } = (await collected.json()) as { orders: Array<{ order_number: string; total: number; status: string }> };
    const sold = orders.find((o) => o.order_number === orderNumber);
    expect(sold?.status).toBe('completed');

    expect(after.summary.bills.collected - before.summary.bills.collected).toBeCloseTo(sold!.total, 2);
    expect(after.money.grossCollected - before.money.grossCollected).toBeCloseTo(sold!.total, 2);
    expect(after.money.billCount - before.money.billCount).toBe(1);

    // And the screen a manager reads agrees with the ledger, to the cent.
    await page.goto(`${E2E_BASE_URL}/dashboard`);
    await expect(page.getByText("Today's Sales")).toBeVisible({ timeout: 20_000 });
    const shown = await readDashboard(page);

    expect(shown.todaysSales, "the dashboard's Today's Sales must equal the cash the ledger holds").toBeCloseTo(after.summary.bills.collected, 2);
    expect(shown.avgOrderValue, 'the dashboard average must be net collections over bills').toBeCloseTo(after.money.averageOrderValue, 2);
    expect(shown.avgOrderValue).toBeCloseTo(after.money.netCollected / after.money.billCount, 2);
  });

  test('a cancelled sale never reaches today\'s sales', async ({ page }) => {
    const headers = { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` };
    const before = await readLedgers(page);

    // An order opened and cancelled without ever being paid must not be counted
    // as money taken.
    const created = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 2 }] },
    });
    expect(created.status()).toBe(201);
    const { order } = (await created.json()) as { order: { id: number; order_number: string } };

    const cancelled = await page.request.patch(`${E2E_BASE_URL}/api/orders/${order.id}/status`, {
      headers,
      data: { status: 'cancelled' },
    });
    expect(cancelled.ok(), `cancelling must succeed (got ${cancelled.status()})`).toBeTruthy();

    const after = await readLedgers(page);
    expect(after.summary.bills.collected, 'a cancelled order must not add to collections').toBeCloseTo(before.summary.bills.collected, 2);
    expect(after.money.grossCollected).toBeCloseTo(before.money.grossCollected, 2);
    expect(after.summary.orders.count, 'the order itself is still counted as an order').toBe(before.summary.orders.count + 1);

    const cancelledCount = after.summary.ordersByStatus.find((s) => s.status === 'cancelled')?.count ?? 0;
    expect(cancelledCount).toBeGreaterThan(0);
  });

  test('refunding a sale takes the money back out of today\'s sales', async ({ page }) => {
    // A refund is the one path that removes collected money, so the dashboard
    // has to follow it or a day's takings would overstate what is in the drawer.
    await page.goto(`${E2E_BASE_URL}/pos`);
    await addToCart(page, 'E2E Coffee', 1);
    const orderNumber = await placeOrderAndPayCash(page);

    const afterSale = await readLedgers(page);
    const headers = { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` };
    const { orders } = (await (await page.request.get(`${E2E_BASE_URL}/api/orders`, { headers })).json()) as {
      orders: Array<{ id: number; order_number: string; total: number }>;
    };
    const sold = orders.find((o) => o.order_number === orderNumber)!;
    expect(sold.total, 'the scenario must have collected a known amount').toBeGreaterThan(0);

    // Refund it in full against its bill, the way the Orders screen does.
    const { bill } = (await (await page.request.get(`${E2E_BASE_URL}/api/bills/order/${sold.id}`, { headers })).json()) as {
      bill: { id: number };
    };
    const refund = await page.request.post(`${E2E_BASE_URL}/api/refunds`, {
      headers,
      data: {
        bill_id: bill.id,
        amount: sold.total,
        method: 'cash',
        approver_id: 'e2e-owner',
        override_pin: OWNER_APPROVAL_PIN,
      },
    });
    // Asserted rather than tolerated: a refund that silently fails here would
    // leave this scenario proving nothing about the dashboard at all.
    expect(refund.status(), `the refund must settle so the dashboard effect can be measured (got ${refund.status()} ${await refund.text()})`).toBe(201);

    const afterRefund = await readLedgers(page);
    expect(afterRefund.summary.bills.collected, 'a refunded sale must leave the collections figure').toBeCloseTo(afterSale.summary.bills.collected - sold.total, 2);
    expect(afterRefund.money.refunded).toBeCloseTo(afterSale.money.refunded + sold.total, 2);

    await page.goto(`${E2E_BASE_URL}/dashboard`);
    const shown = await readDashboard(page);
    expect(shown.todaysSales).toBeCloseTo(afterRefund.summary.bills.collected, 2);
    expect(shown.todaysSales).toBeCloseTo(afterSale.summary.bills.collected - sold.total, 2);
  });

  test('running orders counts exactly the orders still open', async ({ page }) => {
    const runningOrders = await readRunningOrders(page);

    await page.goto(`${E2E_BASE_URL}/dashboard`);
    await expect(page.getByText('Running Orders')).toBeVisible({ timeout: 20_000 });
    const shown = await readDashboard(page);

    expect(shown.runningOrders, 'the live order count must match the reports API').toBe(runningOrders);
  });

  test('today\'s sales exclude orders that were never paid for', async ({ page }) => {
    // Open a handful of orders and leave them unpaid. The day's takings must not
    // move, which is the difference between "sold" and "paid".
    const headers = { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` };
    const before = await readLedgers(page);

    for (let i = 0; i < 3; i++) {
      const res = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
        headers,
        data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
      });
      expect(res.status()).toBe(201);
    }

    const after = await readLedgers(page);
    expect(after.summary.bills.collected, 'unpaid orders must not be counted as takings').toBeCloseTo(before.summary.bills.collected, 2);
    expect(after.summary.orders.count).toBe(before.summary.orders.count + 3);

    // The screen must still show the same money, only more running orders.
    await page.goto(`${E2E_BASE_URL}/dashboard`);
    const shown = await readDashboard(page);
    expect(shown.todaysSales).toBeCloseTo(after.summary.bills.collected, 2);
    expect(shown.runningOrders).toBe(await readRunningOrders(page));
  });
});