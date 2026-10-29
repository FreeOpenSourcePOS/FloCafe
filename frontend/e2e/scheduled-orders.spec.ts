import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

function futureBangkokWallClock(minutesAhead: number): string {
  const target = new Date(Date.now() + minutesAhead * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(target);
  const byType: Record<string, string> = {};
  for (const part of parts) byType[part.type] = part.value;
  const hour = byType.hour === '24' ? '00' : byType.hour;
  return `${byType.year}-${byType.month}-${byType.day}T${hour}:${byType.minute}`;
}

test('POS scheduled orders: Send to kitchen at, prepay without early release, audited reschedule, refund-before-cancel, and blocked retry', async ({
  page,
}) => {
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
  const runId = Math.random().toString(36).slice(2, 8);
  const createdOrderIds: number[] = [];
  let trackedProductId: string | null = null;

  try {
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    const cartShell = page.getByTestId('cart-shell');

    // 1. Order-type gating in POS: hidden on Dine in & Online, visible on Takeaway & Delivery
    await cartShell.getByRole('button', { name: 'Dine in', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toHaveCount(0);

    await cartShell.getByRole('button', { name: 'Online', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toHaveCount(0);

    await cartShell.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toBeVisible();
    await expect(cartShell.getByText('Send to kitchen at')).toBeVisible();

    await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toBeVisible();
    await expect(cartShell.getByText('Send to kitchen at')).toBeVisible();

    // Add E2E Coffee to cart
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    // Past time triggers inline error and disables Place Order
    const scheduleInput = cartShell.getByTestId('pos-send-to-kitchen-input');
    await scheduleInput.fill('2020-01-15T10:00');
    await expect(cartShell.getByTestId('pos-schedule-error')).toBeVisible();
    await expect(cartShell.getByRole('button', { name: 'Place Order' })).toBeDisabled();

    // Clear and use Schedule for later toggle, then set explicit future time
    await cartShell.getByTestId('pos-schedule-clear-btn').click();
    await cartShell.getByTestId('pos-schedule-suggest-btn').click();
    await expect(cartShell.getByTestId('pos-schedule-error')).toHaveCount(0);

    const initialFutureWall = futureBangkokWallClock(90);
    await scheduleInput.fill(initialFutureWall);
    await expect(cartShell.getByTestId('pos-schedule-error')).toHaveCount(0);

    // 2. Place prepaid scheduled takeaway order -> pay without early release!
    const createOrderPromise = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return res.request().method() === 'POST' && url.pathname === '/api/orders';
    });
    const paymentPromise = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        res.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname)
      );
    });

    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: /Confirm Payment/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await expect(page.getByRole('button', { name: /Confirm Payment/ })).toBeEnabled();
    await page.getByRole('button', { name: /Confirm Payment/ }).click();

    const createOrderRes = await createOrderPromise;
    expect(createOrderRes.status()).toBe(201);
    const paymentRes = await paymentPromise;
    expect(paymentRes.ok()).toBeTruthy();
    const createdOrderPayload = await createOrderRes.json();
    const prepaidOrderId = Number(createdOrderPayload.order.id);
    createdOrderIds.push(prepaidOrderId);

    // Verify backend state: paid bill, NOT released early, NOT completed, excluded from KDS
    await expect
      .poll(async () => {
        const res = await page.request.get(`${BASE}/api/orders/${prepaidOrderId}`, {
          headers: ownerHeaders,
        });
        const body = await res.json();
        return {
          releaseStatus: body.order?.release_status,
          status: body.order?.status,
          paymentStatus: body.order?.bill?.payment_status,
        };
      })
      .toEqual({
        releaseStatus: 'scheduled',
        status: 'pending',
        paymentStatus: 'paid',
      });

    const kdsRes = await page.request.get(`${BASE}/api/kds/orders`, { headers: ownerHeaders });
    const kdsBody = await kdsRes.json();
    expect(kdsBody.orders.some((o: { id: number }) => Number(o.id) === prepaidOrderId)).toBe(false);

    // 3. Open Scheduled Orders drawer: verify Paid badge, edit lock, audited Reschedule, and refund-before-cancel guard
    await page.getByTestId('pos-scheduled-orders-btn').click();
    const drawer = page.getByTestId('scheduled-orders-drawer');
    await expect(drawer).toBeVisible();

    const paidCard = drawer.getByTestId(`scheduled-order-card-${prepaidOrderId}`);
    await expect(paidCard).toBeVisible();
    await expect(paidCard.getByTestId(`scheduled-payment-badge-${prepaidOrderId}`)).toContainText(
      'Paid',
    );
    await expect(paidCard.getByTestId(`scheduled-edit-locked-${prepaidOrderId}`)).toBeVisible();
    await expect(paidCard.getByTestId(`scheduled-add-items-btn-${prepaidOrderId}`)).toHaveCount(0);

    // Reschedule timing-only change succeeds even after payment
    await paidCard.getByTestId(`scheduled-reschedule-btn-${prepaidOrderId}`).click();
    const updatedFutureWall = futureBangkokWallClock(150);
    await paidCard
      .getByTestId(`scheduled-reschedule-input-${prepaidOrderId}`)
      .fill(updatedFutureWall);
    const rescheduleRespPromise = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        res.request().method() === 'PATCH' &&
        url.pathname === `/api/orders/${prepaidOrderId}/schedule`
      );
    });
    await paidCard.getByTestId(`scheduled-reschedule-save-${prepaidOrderId}`).click();
    const rescheduleResp = await rescheduleRespPromise;
    expect(rescheduleResp.status()).toBe(200);

    // Cancel on paid scheduled order instructs staff to refund collected payment first
    await paidCard.getByTestId(`scheduled-cancel-btn-${prepaidOrderId}`).click();
    await expect(
      paidCard.getByTestId(`scheduled-refund-required-msg-${prepaidOrderId}`),
    ).toBeVisible();

    // 4. Blocked release -> Needs Attention -> Restock -> Retry release
    const createProdRes = await page.request.post(`${BASE}/api/products`, {
      headers: ownerHeaders,
      data: {
        category_id: 'e2e-category',
        name: `E2E Limited Pastry ${runId}`,
        price: 45,
        tax_type: 'none',
        track_inventory: true,
        stock_quantity: 0,
      },
    });
    expect(createProdRes.ok()).toBeTruthy();
    trackedProductId = String((await createProdRes.json()).product.id);

    const createBlockedCandidateRes = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        scheduled_for: futureBangkokWallClock(60),
        items: [{ product_id: trackedProductId, quantity: 2 }],
      },
    });
    expect(createBlockedCandidateRes.status()).toBe(201);
    const blockedOrderId = Number((await createBlockedCandidateRes.json()).order.id);
    createdOrderIds.push(blockedOrderId);

    // Refresh drawer by closing & reopening
    await drawer.locator('button[aria-label="Close"]').click();
    await page.getByTestId('pos-scheduled-orders-btn').click();
    await expect(page.getByTestId('scheduled-orders-drawer')).toBeVisible();

    const blockedCard = page
      .getByTestId('scheduled-orders-drawer')
      .getByTestId(`scheduled-order-card-${blockedOrderId}`);
    await expect(blockedCard).toBeVisible();

    // Attempt release with 0 stock -> holds order in blocked state and shows actionable reason
    await blockedCard.getByTestId(`scheduled-release-btn-${blockedOrderId}`).click();
    await expect(
      blockedCard.getByTestId(`scheduled-blocked-badge-${blockedOrderId}`),
    ).toBeVisible();
    await expect(
      blockedCard.getByTestId(`scheduled-blocked-reason-${blockedOrderId}`),
    ).toContainText(`E2E Limited Pastry ${runId}`);

    // Restock product (+5) and click Retry release
    const restockRes = await page.request.post(`${BASE}/api/products/${trackedProductId}/stock`, {
      headers: ownerHeaders,
      data: { action: 'increase', quantity: 5, reason: 'E2E restock before retry' },
    });
    expect(restockRes.ok()).toBeTruthy();

    await blockedCard.getByTestId(`scheduled-release-btn-${blockedOrderId}`).click();
    await expect(blockedCard).toHaveCount(0);

    // Released order now appears on KDS!
    const kdsAfterRetry = await page.request.get(`${BASE}/api/kds/orders`, {
      headers: ownerHeaders,
    });
    const kdsAfterBody = await kdsAfterRetry.json();
    expect(kdsAfterBody.orders.some((o: { id: number }) => Number(o.id) === blockedOrderId)).toBe(
      true,
    );

    const createDeliveryScheduledRes = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'delivery',
        delivery_address: '99 Sukhumvit Rd',
        expected_payment_method: 'cash',
        delivery_note: 'Gate code 1234',
        scheduled_for: futureBangkokWallClock(80),
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(createDeliveryScheduledRes.status()).toBe(201);
    const deliveryOrderId = Number((await createDeliveryScheduledRes.json()).order.id);
    createdOrderIds.push(deliveryOrderId);

    await page.evaluate(() => {
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {}, version: 5 };
      parsed.state = { ...(parsed.state || {}), customerMandatory: true };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    });
    try {
      await page.goto(`${BASE}/pos`);
      await expect(page.getByTestId('pos-product-grid')).toBeVisible();

      await page.getByTestId('pos-scheduled-orders-btn').click();
      const appendDrawer = page.getByTestId('scheduled-orders-drawer');
      await expect(appendDrawer).toBeVisible();
      await appendDrawer
        .getByTestId(`scheduled-order-card-${deliveryOrderId}`)
        .getByTestId(`scheduled-add-items-btn-${deliveryOrderId}`)
        .click();

      await expect(cartShell.getByTestId('cart-scheduled-existing-banner')).toBeVisible();
      await expect(cartShell.getByPlaceholder('Delivery address')).toHaveCount(0);
      await expect(cartShell.getByText('Expected payment')).toHaveCount(0);
      await expect(cartShell.getByPlaceholder('Delivery note for the courier')).toHaveCount(0);

      await page.getByTestId('pos-product-card').first().click();
      const appendRespPromise = page.waitForResponse((res) => {
        const url = new URL(res.url());
        return (
          res.request().method() === 'POST' &&
          url.pathname === `/api/orders/${deliveryOrderId}/items`
        );
      });
      await cartShell.getByRole('button', { name: 'Place Order' }).click();
      await expect(page.getByText('Select Customer', { exact: true })).toHaveCount(0);
      const appendResp = await appendRespPromise;
      expect(appendResp.status()).toBe(200);
      const appendedOrder = (await appendResp.json()).order;
      expect(appendedOrder.items).toHaveLength(2);
      expect(appendedOrder.delivery_address).toBe('99 Sukhumvit Rd');
    } finally {
      await page.evaluate(() => {
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {}, version: 5 };
        parsed.state = { ...(parsed.state || {}), customerMandatory: false };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      });
    }
  } finally {
    // Clean up created orders cleanly without triggering unpaid-completion errors
    for (const orderId of createdOrderIds) {
      const checkRes = await page.request
        .get(`${BASE}/api/orders/${orderId}`, { headers: ownerHeaders })
        .catch(() => null);
      const order = checkRes && checkRes.ok() ? (await checkRes.json()).order : null;
      if (!order || order.status === 'completed' || order.status === 'cancelled') continue;

      if (order.bill?.payment_status === 'paid') {
        if (order.release_status !== 'released') {
          await page.request
            .post(`${BASE}/api/orders/${orderId}/release`, { headers: ownerHeaders })
            .catch(() => {});
        }
        await page.request
          .patch(`${BASE}/api/orders/${orderId}/status`, {
            headers: ownerHeaders,
            data: { status: 'completed' },
          })
          .catch(() => {});
      } else {
        await page.request
          .patch(`${BASE}/api/orders/${orderId}/status`, {
            headers: ownerHeaders,
            data: { status: 'cancelled', reason: 'E2E cleanup' },
          })
          .catch(() => {});
      }
    }
    if (trackedProductId) {
      await page.request
        .delete(`${BASE}/api/products/${trackedProductId}`, { headers: ownerHeaders })
        .catch(() => {});
    }
  }
});
