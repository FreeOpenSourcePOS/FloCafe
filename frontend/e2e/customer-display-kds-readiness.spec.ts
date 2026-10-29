import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL as KDS_BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { captureSettings, restoreSettings, writeSetting } from './helpers/kitchen-fixture';

const CUSTOMER_DISPLAY_DEFAULTS = {
  statuses: ['pending', 'preparing', 'ready'],
  refresh_seconds: 3,
  show_updated: true,
};

const FAST_POLL_CONFIG = {
  statuses: ['pending', 'preparing', 'ready'],
  refresh_seconds: 2,
  show_updated: true,
};

const PICKUP_CATEGORY_NAME = 'Pickup KDS 1401';
const PRODUCT_ESPRESSO = 'Pickup Espresso 1401';
const PRODUCT_CROISSANT = 'Pickup Croissant 1401';
const TRACKED_SETTINGS = [
  'billing_type',
  'kds_enabled',
  'require_kitchen_delivered_before_settlement',
];

function ownerHeaders() {
  return { Authorization: `Bearer ${getE2eToken()}` };
}

async function ensurePickupCatalog(
  request: APIRequestContext,
): Promise<{ espressoId: string; croissantId: string }> {
  const headers = ownerHeaders();
  const catRes = await request.get(`${BASE}/api/categories`, { headers });
  expect(catRes.ok()).toBeTruthy();
  const catBody = (await catRes.json()) as { categories?: Array<{ id: string; name: string }> };
  let category = (catBody.categories ?? []).find((c) => c.name === PICKUP_CATEGORY_NAME);
  if (!category) {
    const createdCat = await request.post(`${BASE}/api/categories`, {
      headers,
      data: { name: PICKUP_CATEGORY_NAME, sort_order: 910, is_active: true },
    });
    expect(createdCat.ok()).toBeTruthy();
    category = ((await createdCat.json()) as { category: { id: string; name: string } }).category;
  }

  const prodRes = await request.get(`${BASE}/api/products`, { headers });
  expect(prodRes.ok()).toBeTruthy();
  const prodBody = (await prodRes.json()) as { products?: Array<{ id: string; name: string }> };
  const existingProducts = prodBody.products ?? [];

  const ensureSimpleProduct = async (name: string, price: number): Promise<string> => {
    const found = existingProducts.find((p) => p.name === name);
    if (found) return found.id;
    const createdProd = await request.post(`${BASE}/api/products`, {
      headers,
      data: {
        name,
        category_id: category!.id,
        price,
        is_active: true,
      },
    });
    expect(createdProd.ok(), `creating ${name} must succeed`).toBeTruthy();
    return ((await createdProd.json()) as { product: { id: string } }).product.id;
  };

  const espressoId = await ensureSimpleProduct(PRODUCT_ESPRESSO, 10);
  const croissantId = await ensureSimpleProduct(PRODUCT_CROISSANT, 12);
  return { espressoId, croissantId };
}

async function loginAsOwner(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
  await setLanguage(page, 'en');
}

async function openKdsInTabsView(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${KDS_BASE}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible({
    timeout: 30_000,
  });
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill(E2E_PASSWORD);
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible({ timeout: 30_000 });
  const tabsButton = page.getByRole('button', { name: 'Tabs', exact: true });
  await tabsButton.click();
  await expect(tabsButton).toHaveAttribute('aria-pressed', 'true');
}

async function advanceKdsItemOnce(
  kdsPage: Page,
  fromTabLabel: 'Waiting' | 'Preparing' | 'Ready',
  orderNumber: string,
  productName: string,
  markAsButtonName: 'Mark as Preparing' | 'Mark as Ready' | 'Mark as Delivered',
): Promise<void> {
  await kdsPage
    .getByRole('button', { name: new RegExp(`^${fromTabLabel}\\b`) })
    .first()
    .click();
  const orderCard = kdsPage
    .locator('div.bg-card')
    .filter({ hasText: `#${orderNumber}` })
    .first();
  await expect(orderCard).toBeVisible({ timeout: 15_000 });
  await orderCard
    .getByRole('button', { name: new RegExp(productName) })
    .first()
    .click();
  const modal = kdsPage.getByRole('dialog');
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await modal.getByRole('button', { name: markAsButtonName, exact: true }).click();
  await expect(modal).toHaveCount(0, { timeout: 10_000 });
}

async function revokeAllDisplayTokens(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${BASE}/api/settings/customer-display/tokens`, {
    headers: ownerHeaders(),
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { tokens?: Array<{ id: string }> };
  for (const token of body.tokens ?? []) {
    await request.delete(`${BASE}/api/settings/customer-display/tokens/${token.id}`, {
      headers: ownerHeaders(),
    });
  }
}

test.describe('Customer display KDS readiness across postpaid and prepaid takeaway orders', () => {
  let settingsSnapshot: Map<string, string | undefined>;
  let catalog: { espressoId: string; croissantId: string };
  const cleanupOrderIds: number[] = [];

  test.beforeAll(async ({ request }) => {
    settingsSnapshot = await captureSettings(request, TRACKED_SETTINGS);
    catalog = await ensurePickupCatalog(request);
  });

  test.beforeEach(async ({ request }) => {
    await revokeAllDisplayTokens(request);
    await writeSetting(request, 'kds_enabled', 'true');
    await writeSetting(request, 'require_kitchen_delivered_before_settlement', 'false');
    const savedDisplay = await request.put(`${BASE}/api/settings/customer-display`, {
      headers: ownerHeaders(),
      data: FAST_POLL_CONFIG,
    });
    expect(savedDisplay.ok()).toBeTruthy();
  });

  test.afterEach(async ({ request }) => {
    while (cleanupOrderIds.length > 0) {
      const id = cleanupOrderIds.pop()!;
      const orderRes = await request
        .get(`${BASE}/api/orders/${id}`, { headers: ownerHeaders() })
        .catch(() => null);
      if (orderRes?.ok()) {
        const { order } = (await orderRes.json()) as {
          order?: { items?: Array<{ id: number; status: string }> };
        };
        for (const item of order?.items ?? []) {
          if (['pending', 'preparing', 'ready'].includes(item.status)) {
            await request
              .patch(`${BASE}/api/order-items/${item.id}/status`, {
                headers: ownerHeaders(),
                data: { status: 'served' },
              })
              .catch(() => {});
          }
        }
      }
    }
    await revokeAllDisplayTokens(request);
    await request
      .put(`${BASE}/api/settings/customer-display`, {
        headers: ownerHeaders(),
        data: CUSTOMER_DISPLAY_DEFAULTS,
      })
      .catch(() => {});
    await restoreSettings(request, settingsSnapshot);
  });

  test('postpaid takeaway order reconciles Preparing -> Ready for pickup -> append/cancel/restore -> auto-clear on Delivered across signed-in and paired boards without reload', async ({
    page,
    context,
    browser,
    request,
  }) => {
    await writeSetting(request, 'billing_type', 'postpaid');
    await loginAsOwner(page);

    const tokenRes = await request.post(`${BASE}/api/settings/customer-display/tokens`, {
      headers: ownerHeaders(),
      data: { label: 'Postpaid Pickup Board' },
    });
    expect(tokenRes.status()).toBe(201);
    const { token: pairedToken } = (await tokenRes.json()) as { token: string };

    const staffDisplayPage = await context.newPage();
    await staffDisplayPage.setViewportSize({ width: 1920, height: 1080 });
    await staffDisplayPage.goto(`${BASE}/customer-display`);
    await expect(staffDisplayPage.getByTestId('customer-display-preparing-scroll')).toBeVisible({
      timeout: 30_000,
    });

    const pairedContext = await browser.newContext();
    const kdsContext = await browser.newContext();
    try {
      const pairedDisplayPage = await pairedContext.newPage();
      await pairedDisplayPage.setViewportSize({ width: 1920, height: 1080 });
      await pairedDisplayPage.goto(`${BASE}/customer-display/#token=${pairedToken}`);
      await expect(pairedDisplayPage.getByTestId('customer-display-preparing-scroll')).toBeVisible({
        timeout: 30_000,
      });

      const kdsPage = await kdsContext.newPage();
      await openKdsInTabsView(kdsPage);

      // Place real 2-item postpaid Takeaway order in POS
      await page.goto(`${BASE}/pos`);
      await page.getByRole('button', { name: 'Takeaway', exact: true }).click();
      await page.getByRole('button', { name: PICKUP_CATEGORY_NAME, exact: true }).click();
      await page.getByTestId('pos-product-card').filter({ hasText: PRODUCT_ESPRESSO }).click();
      await page.getByTestId('pos-product-card').filter({ hasText: PRODUCT_CROISSANT }).click();

      const createdOrderPromise = page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders',
      );
      await page.getByRole('button', { name: 'Place Order', exact: true }).click();
      const createdPayload = (await (await createdOrderPromise).json()) as {
        order: { id: number; order_number: string };
      };
      const orderId = createdPayload.order.id;
      const orderNumber = createdPayload.order.order_number;
      cleanupOrderIds.push(orderId);

      // Both signed-in and paired boards show the new takeaway order in Preparing without reload
      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          orderNumber,
        );
      }

      // 1-of-2 items ready: Espresso Waiting -> Preparing -> Ready; Croissant remains Waiting
      await advanceKdsItemOnce(
        kdsPage,
        'Waiting',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Preparing',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Preparing',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Ready',
      );

      const partialOrderRes = await request.get(`${BASE}/api/orders/${orderId}`, {
        headers: ownerHeaders(),
      });
      expect(((await partialOrderRes.json()) as { order: { status: string } }).order.status).toBe(
        'preparing',
      );
      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).toContainText(
          orderNumber,
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          orderNumber,
        );
      }

      // 2-of-2 items ready: Croissant Waiting -> Preparing -> Ready -> moves to Ready for pickup without reload
      await advanceKdsItemOnce(
        kdsPage,
        'Waiting',
        orderNumber,
        PRODUCT_CROISSANT,
        'Mark as Preparing',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Preparing',
        orderNumber,
        PRODUCT_CROISSANT,
        'Mark as Ready',
      );

      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-ready-scroll')).toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-preparing-scroll')).not.toContainText(
          orderNumber,
        );
      }

      // Appending an unfinished item demotes Ready for pickup back to Preparing on both boards
      const appendRes = await request.post(`${BASE}/api/orders/${orderId}/items`, {
        headers: ownerHeaders(),
        data: { items: [{ product_id: catalog.espressoId, quantity: 1 }] },
      });
      expect(appendRes.ok()).toBeTruthy();
      const appendedBody = (await appendRes.json()) as {
        order: { status: string; items: Array<{ id: number; status: string }> };
      };
      expect(appendedBody.order.status).toBe('preparing');
      const appendedPendingItem = appendedBody.order.items.find((i) => i.status === 'pending')!;

      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          orderNumber,
        );
      }

      // Cancelling the pending blocker promotes back to Ready for pickup; restoring it demotes back to Preparing
      const cancelBlocker = await request.patch(
        `${BASE}/api/orders/${orderId}/items/${appendedPendingItem.id}/cancel`,
        {
          headers: ownerHeaders(),
          data: { reason: 'customer changed mind' },
        },
      );
      expect(cancelBlocker.ok()).toBeTruthy();
      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-ready-scroll')).toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
      }

      const restoreBlocker = await request.patch(
        `${BASE}/api/orders/${orderId}/items/${appendedPendingItem.id}/restore`,
        {
          headers: ownerHeaders(),
          data: {},
        },
      );
      expect(restoreBlocker.ok()).toBeTruthy();
      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          orderNumber,
        );
      }

      // Ready the restored item on KDS, then mark all 3 items Delivered -> order clears off both boards automatically
      await advanceKdsItemOnce(
        kdsPage,
        'Waiting',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Preparing',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Preparing',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Ready',
      );
      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-ready-scroll')).toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
      }

      await advanceKdsItemOnce(
        kdsPage,
        'Ready',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Delivered',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Ready',
        orderNumber,
        PRODUCT_CROISSANT,
        'Mark as Delivered',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Ready',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Delivered',
      );

      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).not.toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          orderNumber,
          { timeout: 15_000 },
        );
      }
    } finally {
      await staffDisplayPage.close().catch(() => {});
      await pairedContext.close().catch(() => {});
      await kdsContext.close().catch(() => {});
    }
  });

  test('prepaid upfront-paid takeaway order projects Preparing -> Ready for pickup -> auto-clear on Delivered across signed-in and paired boards while orders.status stays completed', async ({
    page,
    context,
    browser,
    request,
  }) => {
    await writeSetting(request, 'billing_type', 'prepaid');
    await loginAsOwner(page);

    const tokenRes = await request.post(`${BASE}/api/settings/customer-display/tokens`, {
      headers: ownerHeaders(),
      data: { label: 'Prepaid Pickup Board' },
    });
    expect(tokenRes.status()).toBe(201);
    const { token: pairedToken } = (await tokenRes.json()) as { token: string };

    const staffDisplayPage = await context.newPage();
    await staffDisplayPage.setViewportSize({ width: 1920, height: 1080 });
    await staffDisplayPage.goto(`${BASE}/customer-display`);
    await expect(staffDisplayPage.getByTestId('customer-display-preparing-scroll')).toBeVisible({
      timeout: 30_000,
    });

    const pairedContext = await browser.newContext();
    const kdsContext = await browser.newContext();
    try {
      const pairedDisplayPage = await pairedContext.newPage();
      await pairedDisplayPage.setViewportSize({ width: 1920, height: 1080 });
      await pairedDisplayPage.goto(`${BASE}/customer-display/#token=${pairedToken}`);
      await expect(pairedDisplayPage.getByTestId('customer-display-preparing-scroll')).toBeVisible({
        timeout: 30_000,
      });

      const kdsPage = await kdsContext.newPage();
      await openKdsInTabsView(kdsPage);

      // Place and pay upfront for a 2-item Takeaway order in POS
      await page.goto(`${BASE}/pos`);
      await page.getByRole('button', { name: 'Takeaway', exact: true }).click();
      await page.getByRole('button', { name: PICKUP_CATEGORY_NAME, exact: true }).click();
      await page.getByTestId('pos-product-card').filter({ hasText: PRODUCT_ESPRESSO }).click();
      await page.getByTestId('pos-product-card').filter({ hasText: PRODUCT_CROISSANT }).click();
      await page.getByRole('button', { name: 'Place Order', exact: true }).click();

      const confirmPayButton = page.getByRole('button', { name: /^Confirm Payment · / });
      await expect(confirmPayButton).toBeVisible({ timeout: 15_000 });

      const orderResPromise = page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders',
      );
      const billResPromise = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          new URL(res.url()).pathname === '/api/bills/generate',
      );
      const paymentResPromise = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          /^\/api\/bills\/[^/]+\/payments$/.test(new URL(res.url()).pathname),
      );

      await page.getByRole('button', { name: 'Cash', exact: true }).click();
      await confirmPayButton.click();

      const orderBody = (await (await orderResPromise).json()) as {
        order: { id: number; order_number: string };
      };
      const billBody = (await (await billResPromise).json()) as {
        bill: { bill_number: string };
      };
      await paymentResPromise;

      const orderId = orderBody.order.id;
      const orderNumber = orderBody.order.order_number;
      const displayNumber = billBody.bill.bill_number;
      cleanupOrderIds.push(orderId);

      const checkCompletedStatus = async () => {
        const storedRes = await request.get(`${BASE}/api/orders/${orderId}`, {
          headers: ownerHeaders(),
        });
        expect(storedRes.ok()).toBeTruthy();
        const stored = (await storedRes.json()) as { order: { status: string } };
        expect(stored.order.status).toBe('completed');
      };
      await checkCompletedStatus();

      // Both boards display the paid order's bill number in Preparing while unserved items remain
      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).toContainText(
          displayNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          displayNumber,
        );
      }

      // 1-of-2 ready keeps prepaid order in Preparing and keeps orders.status = 'completed'
      await advanceKdsItemOnce(
        kdsPage,
        'Waiting',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Preparing',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Preparing',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Ready',
      );
      await checkCompletedStatus();

      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).toContainText(
          displayNumber,
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          displayNumber,
        );
      }

      // 2-of-2 ready moves prepaid order to Ready for pickup without reload while orders.status stays 'completed'
      await advanceKdsItemOnce(
        kdsPage,
        'Waiting',
        orderNumber,
        PRODUCT_CROISSANT,
        'Mark as Preparing',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Preparing',
        orderNumber,
        PRODUCT_CROISSANT,
        'Mark as Ready',
      );
      await checkCompletedStatus();

      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-ready-scroll')).toContainText(
          displayNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-preparing-scroll')).not.toContainText(
          displayNumber,
        );
      }

      // Marking both items Delivered automatically omits the completed order from both boards
      await advanceKdsItemOnce(
        kdsPage,
        'Ready',
        orderNumber,
        PRODUCT_ESPRESSO,
        'Mark as Delivered',
      );
      await advanceKdsItemOnce(
        kdsPage,
        'Ready',
        orderNumber,
        PRODUCT_CROISSANT,
        'Mark as Delivered',
      );
      await checkCompletedStatus();

      for (const board of [staffDisplayPage, pairedDisplayPage]) {
        await expect(board.getByTestId('customer-display-preparing-scroll')).not.toContainText(
          displayNumber,
          { timeout: 15_000 },
        );
        await expect(board.getByTestId('customer-display-ready-scroll')).not.toContainText(
          displayNumber,
          { timeout: 15_000 },
        );
      }
    } finally {
      await staffDisplayPage.close().catch(() => {});
      await pairedContext.close().catch(() => {});
      await kdsContext.close().catch(() => {});
    }
  });
});
