import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from '../helpers/urls';
import {
  captureSettings,
  ensureUatFixture,
  loginToken,
  orderItem,
  restoreSettings,
  UatFixture,
} from '../helpers/kitchen-fixture';

/**
 * Kitchen-delivery-before-billing gate.
 *
 * The gate is supposed to refuse settlement while kitchen lines are still
 * pending/preparing/ready, and to stand down completely when KDS is off. Both
 * halves are asserted against the real payments API; the UI is only used to
 * read what the kitchen display does when the board is switched off.
 *
 * Settings are snapshotted once and restored in `afterEach` rather than in a
 * `finally`: a test that dies on timeout takes its browser with it, and a
 * `finally` block that cannot reach the API leaves the shared database with KDS
 * switched off for every later spec.
 */

const GATE_SETTINGS = ['billing_type', 'kds_enabled', 'require_kitchen_delivered_before_settlement'];

let settingsBefore: Map<string, string | undefined>;

test.describe('kitchen delivery before billing', () => {
  let fixture: UatFixture;

  test.beforeAll(async ({ request }) => {
    fixture = await ensureUatFixture(request);
    settingsBefore = await captureSettings(request, GATE_SETTINGS);
  });

  test.afterEach(async ({ request }) => {
    await restoreSettings(request, settingsBefore);
  });

  async function applyGate(
    request: import('@playwright/test').APIRequestContext,
    kdsEnabled: 'true' | 'false',
  ): Promise<{ headers: Record<string, string>; token: string }> {
    const token = await loginToken(request, 'owner@flo.local');
    const headers = { Authorization: `Bearer ${token}` };
    for (const [key, value] of [
      ['billing_type', 'postpaid'],
      ['kds_enabled', kdsEnabled],
      ['require_kitchen_delivered_before_settlement', 'true'],
    ] as const) {
      const saved = await request.put(`${E2E_BASE_URL}/api/settings/${key}`, { headers, data: { value } });
      expect(saved.ok(), `the gate needs ${key}=${value} (got ${await saved.text()})`).toBeTruthy();
    }
    return { headers, token };
  }

  test('billing is refused while a kitchen line is still unserved, and allowed once served', async ({ request }) => {
    const { headers } = await applyGate(request, 'true');

    const created = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        table_id: fixture.tableId,
        type: 'dine_in',
        items: [orderItem(fixture.productId, { variantId: fixture.variants.Small.id })],
      },
    });
    expect(created.status(), `creating a gate order must succeed: ${await created.text()}`).toBe(201);
    const order = (await created.json()).order;

    const generated = await request.post(`${E2E_BASE_URL}/api/bills/generate`, {
      headers,
      data: { order_id: order.id },
    });
    expect(generated.status(), `generating a bill must succeed: ${await generated.text()}`).toBe(201);
    const bill = (await generated.json()).bill;
    expect(Number(bill.total)).toBeGreaterThan(0);

    // The gate must refuse, and must say why.
    const blocked = await request.post(`${E2E_BASE_URL}/api/bills/${bill.id}/payment`, {
      headers,
      // /payment takes a single payment line as the body (not a payments array).
      data: { method: 'cash', amount: Number(bill.total) },
    });
    expect(blocked.status(), `paying an unserved order must be refused, body: ${await blocked.text()}`).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.code).toBe('KITCHEN_ITEMS_UNDELIVERED');
    expect(Number(blockedBody.undeliveredCount)).toBeGreaterThan(0);
    expect(Array.isArray(blockedBody.undeliveredItems)).toBeTruthy();

    // Serve the line, then the same payment must go through - proving the
    // refusal above was the gate and not a permanently broken endpoint.
    const detail = await request.get(`${E2E_BASE_URL}/api/orders/${order.id}`, { headers });
    const itemId = (await detail.json()).order.items[0].id;
    const served = await request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'served' },
    });
    expect(served.ok(), `serving the kitchen line must succeed: ${await served.text()}`).toBeTruthy();

    const paid = await request.post(`${E2E_BASE_URL}/api/bills/${bill.id}/payment`, {
      headers,
      // /payment takes a single payment line as the body (not a payments array).
      data: { method: 'cash', amount: Number(bill.total) },
    });
    expect(paid.ok(), `paying a served order must succeed: ${await paid.text()}`).toBeTruthy();
    expect((await paid.json()).bill.payment_status).toBe('paid');
  });

  test('the gate stands down entirely when KDS is disabled', async ({ request }) => {
    // Identical gate configuration, except KDS is off. With no kitchen display
    // there is nothing to wait for, so settlement must not block.
    const { headers } = await applyGate(request, 'false');

    const created = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        table_id: fixture.tableId,
        type: 'dine_in',
        items: [orderItem(fixture.productId, { variantId: fixture.variants.Large.id })],
      },
    });
    expect(created.status(), `creating an order must succeed: ${await created.text()}`).toBe(201);
    const order = (await created.json()).order;

    const detail = await request.get(`${E2E_BASE_URL}/api/orders/${order.id}`, { headers });
    const item = (await detail.json()).order.items[0];
    expect(item.status, 'the line must still be unserved').not.toBe('served');

    const generated = await request.post(`${E2E_BASE_URL}/api/bills/generate`, {
      headers,
      data: { order_id: order.id },
    });
    expect(generated.status(), `generating a bill must succeed: ${await generated.text()}`).toBe(201);
    const bill = (await generated.json()).bill;

    const paid = await request.post(`${E2E_BASE_URL}/api/bills/${bill.id}/payment`, {
      headers,
      // /payment takes a single payment line as the body (not a payments array).
      data: { method: 'cash', amount: Number(bill.total) },
    });
    expect(paid.ok(), `with KDS off an unserved order must still settle: ${await paid.text()}`).toBeTruthy();
  });

  test('the KDS board itself stands down when KDS is disabled', async ({ page, request }) => {
    await applyGate(request, 'false');

    await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // With the display switched off there is no board to work: it must say so
    // rather than present an empty, permanently-unchanging kitchen.
    await expect(page.getByRole('heading', { name: /Kitchen Display is disabled/i })).toBeVisible();
    await expect(page.getByTestId('kds-workspace')).toHaveCount(0);
    await expect(page.getByTestId('kds-login-form')).toHaveCount(0);
  });
});