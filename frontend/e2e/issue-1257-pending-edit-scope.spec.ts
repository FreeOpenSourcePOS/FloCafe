import { test, expect } from '@playwright/test';
import * as path from 'path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import {
  E2E_PASSWORD,
  getE2eToken,
  setLanguage,
  setOrdersLayout,
} from './helpers/test-auth';

const EVIDENCE_DIR = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M5EFWPN741SST2BQG4N1GTBE';

async function loginAsOwner(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
}

async function createTakeawayOrder(page: import('@playwright/test').Page, note: string) {
  const ownerHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  };
  const res = await page.request.post(`${BASE}/api/orders`, {
    headers: ownerHeaders,
    data: {
      type: 'takeaway',
      special_instructions: note,
      items: [{ product_id: 'e2e-product', quantity: 2 }],
    },
  });
  expect(res.status()).toBe(201);
  const data = await res.json();
  return data.order as {
    id: number;
    order_number: string;
    items: { id: number; product_name: string; quantity: number }[];
  };
}

async function seedOwnerItemEdit(
  page: import('@playwright/test').Page,
  order: { id: number; items: { id: number }[] },
) {
  await page.evaluate(
    ({ orderId, itemId }) => {
      const tenant = JSON.parse(localStorage.getItem('tenant') || '{"id":1}');
      const tenantId = tenant.id;
      const key = `flo.orders.item-edit.attempt.v1:${tenantId}:e2e-owner:${orderId}:${itemId}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          mode: 'quantity',
          path: `/orders/${orderId}/items/${itemId}/edit`,
          orderId,
          itemId,
          actorId: 'e2e-owner',
          tenantId,
          idempotencyKey: 'attempt-' + Math.random().toString(36).slice(2),
          createdAt: new Date().toISOString(),
          body: { expected_edit_version: 0, quantity: 4 },
        }),
      );
    },
    { orderId: order.id, itemId: order.items[0].id },
  );
}

test.describe('Issue #1257 / N5: Scope pending-edit recovery notices, refresh errors, and in-flight handlers to selected order', () => {
  test.beforeEach(async ({ page }) => {
    await setOrdersLayout(page, 'split');
  });

  test.afterEach(async ({ page }) => {
    await setOrdersLayout(page, 'split');
  });

  test('Scenario 1: Pending edit notices and refresh errors on Order A are never displayed when switching to Order B', async ({
    page,
  }) => {
    const orderA = await createTakeawayOrder(page, 'Order A with pending edit errors');
    const orderB = await createTakeawayOrder(page, 'Order B clean order');

    await loginAsOwner(page);
    await seedOwnerItemEdit(page, orderA);

    await page.goto(`${BASE}/orders`);

    const masterRowA = page.getByRole('button').filter({ hasText: `#${orderA.order_number}` });
    const masterRowB = page.getByRole('button').filter({ hasText: `#${orderB.order_number}` });
    await expect(masterRowA).toBeVisible();
    await expect(masterRowB).toBeVisible();

    // Select Order A - pending edit banner and resolve button are visible
    await masterRowA.click();
    const resolveBtnA = page.getByRole('button', { name: 'Resolve pending edit' }).first();
    await expect(resolveBtnA).toBeVisible({ timeout: 15000 });

    // Mock 409 conflict when clicking Resolve on Order A, and fail the GET order refresh
    await page.route(`**/api/orders/${orderA.id}/items/*/edit`, (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'edit version conflict' }),
      });
    });

    await page.route(`**/api/orders/${orderA.id}`, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
      }
      return route.continue();
    });

    await resolveBtnA.click();

    // Verify rejection notice and refresh error are visible on Order A
    const rejectionNoticeA = page.getByTestId('pending-item-edit-rejection');
    await expect(rejectionNoticeA).toBeVisible({ timeout: 15000 });
    await expect(rejectionNoticeA).toContainText('edit version conflict');

    const refreshWarningA = page.getByTestId('pending-item-edit-refresh-failed');
    await expect(refreshWarningA).toBeVisible();
    await expect(refreshWarningA).toHaveText(/Failed to load order/);

    // Capture screenshot 1: Order A showing error notices
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-1-order-a-with-notices.png'),
    });

    // Now switch to Order B!
    await masterRowB.click();

    // Observable result: Order B must NOT display Order A's rejection notice or refresh error
    const rejectionNoticeB = page.getByTestId('pending-item-edit-rejection');
    await expect(rejectionNoticeB).toBeHidden();
    const refreshWarningB = page.getByTestId('pending-item-edit-refresh-failed');
    await expect(refreshWarningB).toBeHidden();
    const retryBtnB = page.getByTestId('retry-refresh-button');
    await expect(retryBtnB).toBeHidden();
    await expect(page.getByTestId('pending-order-item-edits')).toBeHidden();

    // Capture screenshot 2: Order B cleanly isolated without any notices
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-1-order-b-isolated-clean.png'),
    });
  });

  test('Scenario 2: In-flight edit resolution or refresh on Order A settling late does not contaminate Order B', async ({
    page,
  }) => {
    const orderA = await createTakeawayOrder(page, 'Order A with in-flight resolution');
    const orderB = await createTakeawayOrder(page, 'Order B clean order for race check');

    await loginAsOwner(page);
    await seedOwnerItemEdit(page, orderA);

    await page.goto(`${BASE}/orders`);

    const masterRowA = page.getByRole('button').filter({ hasText: `#${orderA.order_number}` });
    const masterRowB = page.getByRole('button').filter({ hasText: `#${orderB.order_number}` });
    await expect(masterRowA).toBeVisible();
    await expect(masterRowB).toBeVisible();

    await masterRowA.click();

    const resolveBtn = page.getByRole('button', { name: 'Resolve pending edit' }).first();
    await expect(resolveBtn).toBeVisible({ timeout: 15000 });

    // Intercept PATCH for Order A and hold it until unblocked
    let resolvePatch!: () => void;
    const patchGate = new Promise<void>((r) => {
      resolvePatch = r;
    });
    let patchStarted = false;

    await page.route(`**/api/orders/${orderA.id}/items/*/edit`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patchStarted = true;
      await patchGate;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'late 409 conflict from order A' }),
      });
    });

    // Track GET requests to verify Order A refresh is not triggered while on Order B
    let orderARefreshesWhileOnB = 0;
    let onOrderB = false;
    await page.route(`**/api/orders/${orderA.id}`, (route) => {
      if (onOrderB && route.request().method() === 'GET') {
        orderARefreshesWhileOnB += 1;
      }
      return route.continue();
    });

    // Click Resolve on Order A
    await resolveBtn.click();
    await expect.poll(() => patchStarted).toBe(true);

    // While Order A's resolve is in-flight, immediately switch to Order B!
    await masterRowB.click();
    onOrderB = true;

    // Ensure Order B has mounted
    await page.waitForTimeout(100);

    // Now let Order A's late 409 response settle
    resolvePatch();

    // Allow time for any late asynchronous handlers / microtasks to settle
    await page.waitForTimeout(500);

    // Observable result: Order B has no rejection notice, no refresh warning, no pending edit banners
    await expect(page.getByTestId('pending-item-edit-rejection')).toBeHidden();
    await expect(page.getByTestId('pending-item-edit-refresh-failed')).toBeHidden();
    await expect(page.getByTestId('pending-order-item-edits')).toBeHidden();
    expect(orderARefreshesWhileOnB).toBe(0);

    // Capture screenshot 3: Order B clean after late resolution of Order A
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-2-order-b-after-late-settling-resolution.png'),
    });
  });

  test('Scenario 3: LocalStorage pending attempt scope isolation prevents cross-order recovery offer', async ({
    page,
  }) => {
    const orderA = await createTakeawayOrder(page, 'Order A with pending edit in storage');
    const orderB = await createTakeawayOrder(page, 'Order B with no pending edits');

    await loginAsOwner(page);
    await seedOwnerItemEdit(page, orderA);

    await page.goto(`${BASE}/orders`);

    const masterRowA = page.getByRole('button').filter({ hasText: `#${orderA.order_number}` });
    const masterRowB = page.getByRole('button').filter({ hasText: `#${orderB.order_number}` });
    await expect(masterRowA).toBeVisible();
    await expect(masterRowB).toBeVisible();

    // Select Order B first
    await masterRowB.click();

    // Observable result: Order B does NOT offer "Resolve pending edit" and has no pending edits banner
    await expect(page.getByRole('button', { name: 'Resolve pending edit' })).toHaveCount(0);
    await expect(page.getByTestId('pending-order-item-edits')).toBeHidden();

    // Capture screenshot 4: Order B showing no pending edit offers despite Order A attempt in storage
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-3-order-b-no-attempt-offer.png'),
    });

    // Select Order A
    await masterRowA.click();

    // Observable result: Order A DOES display the pending edit offer
    await expect(page.getByTestId('pending-order-item-edits')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Resolve pending edit' }).first()).toBeVisible();

    // Capture screenshot 5: Order A showing its pending edit offer
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-3-order-a-displays-own-attempt.png'),
    });
  });
});
