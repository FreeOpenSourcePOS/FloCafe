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
  test.setTimeout(120_000);
  const evidenceDir = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M64J866EWP5Q41XVW3W8J3Q9';
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
  const runId = Math.random().toString(36).slice(2, 8);
  const createdOrderIds: number[] = [];
  let trackedProductId: string | null = null;
  let managerPinSet = false;

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
    await page.screenshot({ path: `${evidenceDir}/01-pos-send-to-kitchen-at.png`, fullPage: true });

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
    await expect(paidCard.getByTestId(`scheduled-pay-btn-${prepaidOrderId}`)).toHaveCount(0);
    await expect(paidCard.getByTestId(`scheduled-edit-locked-${prepaidOrderId}`)).toBeVisible();
    await expect(paidCard.getByTestId(`scheduled-add-items-btn-${prepaidOrderId}`)).toHaveCount(0);
    await page.screenshot({
      path: `${evidenceDir}/02-scheduled-drawer-paid-edit-locked.png`,
      fullPage: true,
    });

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

    const setPinRes = await page.request.put(`${BASE}/api/staff/e2e-manager`, {
      headers: ownerHeaders,
      data: { pin: '2468' },
    });
    expect(setPinRes.ok()).toBeTruthy();
    managerPinSet = true;

    const billRes = await page.request.get(`${BASE}/api/bills/order/${prepaidOrderId}`, {
      headers: ownerHeaders,
    });
    expect(billRes.ok()).toBeTruthy();
    const prepaidBill = (await billRes.json()).bill as { id: number; total: number };

    const partialRefundRes = await page.request.post(`${BASE}/api/refunds`, {
      headers: ownerHeaders,
      data: {
        bill_id: prepaidBill.id,
        amount: 10,
        method: 'cash',
        approver_id: 'e2e-manager',
        override_pin: '2468',
      },
    });
    expect(partialRefundRes.status()).toBe(201);

    await drawer.locator('button[aria-label="Close"]').click();
    await page.getByTestId('pos-scheduled-orders-btn').click();
    await expect(drawer).toBeVisible();
    await expect(paidCard.getByTestId(`scheduled-payment-badge-${prepaidOrderId}`)).toContainText(
      'Partially Refunded',
    );
    await expect(paidCard.getByTestId(`scheduled-pay-btn-${prepaidOrderId}`)).toHaveCount(0);
    await expect(paidCard.getByTestId(`scheduled-refund-btn-${prepaidOrderId}`)).toBeVisible();

    const remainingRefund = Number((Number(prepaidBill.total) - 10).toFixed(2));
    const fullRefundRes = await page.request.post(`${BASE}/api/refunds`, {
      headers: ownerHeaders,
      data: {
        bill_id: prepaidBill.id,
        amount: remainingRefund,
        method: 'cash',
        approver_id: 'e2e-manager',
        override_pin: '2468',
      },
    });
    expect(fullRefundRes.status()).toBe(201);

    await drawer.locator('button[aria-label="Close"]').click();
    await page.getByTestId('pos-scheduled-orders-btn').click();
    await expect(drawer).toBeVisible();
    await expect(paidCard.getByTestId(`scheduled-payment-badge-${prepaidOrderId}`)).toContainText(
      'Refund issued',
    );
    await expect(paidCard.getByTestId(`scheduled-pay-btn-${prepaidOrderId}`)).toHaveCount(0);
    await expect(paidCard.getByTestId(`scheduled-refund-btn-${prepaidOrderId}`)).toHaveCount(0);

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
    await page.screenshot({
      path: `${evidenceDir}/03-scheduled-drawer-blocked-shortage.png`,
      fullPage: true,
    });

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
      await expect(page.getByTestId('pos-scheduled-count-badge')).toHaveText('2');

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

    // 5. Released scheduled order on /orders: Refund exposed on partial/partially_refunded,
    //    edit controls locked after payment, REFUND_REQUIRED_BEFORE_CANCEL surfaced, and cancel after full refund
    const releasedSchedCreate = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        scheduled_for: futureBangkokWallClock(75),
        items: [{ product_id: 'e2e-product', quantity: 2 }],
      },
    });
    expect(releasedSchedCreate.status()).toBe(201);
    const releasedSchedOrder = (await releasedSchedCreate.json()).order as {
      id: number;
      order_number: string;
    };
    const releasedSchedId = Number(releasedSchedOrder.id);
    createdOrderIds.push(releasedSchedId);

    const releasedBillGen = await page.request.post(`${BASE}/api/bills/generate`, {
      headers: ownerHeaders,
      data: { order_id: releasedSchedId },
    });
    expect(releasedBillGen.status()).toBe(201);
    const releasedBill = (await releasedBillGen.json()).bill as { id: number };

    const releasedPartialPay = await page.request.post(
      `${BASE}/api/bills/${releasedBill.id}/payment`,
      {
        headers: ownerHeaders,
        data: { method: 'cash', amount: 20 },
      },
    );
    expect(releasedPartialPay.ok()).toBeTruthy();

    const relRes = await page.request.post(`${BASE}/api/orders/${releasedSchedId}/release`, {
      headers: ownerHeaders,
    });
    expect(relRes.status()).toBe(200);

    await page.goto(`${BASE}/orders`);
    const masterRow = page
      .getByRole('button')
      .filter({ hasText: `#${releasedSchedOrder.order_number}` })
      .first();
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const detailPanel = page.getByTestId('orders-detail-panel');
    await expect(detailPanel.getByText('Partially Paid', { exact: true })).toBeVisible();
    await expect(detailPanel.getByRole('button', { name: 'Take Payment' })).toBeVisible();
    await expect(detailPanel.getByRole('button', { name: 'Refund', exact: true })).toBeVisible();
    await expect(detailPanel.getByRole('button', { name: 'Add Item' })).toHaveCount(0);
    await expect(detailPanel.getByRole('button', { name: 'Link Customer' })).toHaveCount(0);
    await page.screenshot({
      path: `${evidenceDir}/04-orders-released-partially-paid.png`,
      fullPage: true,
    });

    await detailPanel
      .locator('button[aria-haspopup="menu"]')
      .filter({ has: page.locator('svg.lucide-ellipsis') })
      .click();
    await page.getByRole('menuitem', { name: /^Cancel$/ }).click();

    const cancelOverlay = page.locator('.fixed.inset-0.z-50').last();
    await expect(cancelOverlay).toBeVisible();
    await expect(
      cancelOverlay.getByText('Refund collected payment before cancelling this scheduled order.'),
    ).toBeVisible();
    if (await cancelOverlay.locator('#cancelApproverSelect').count()) {
      await cancelOverlay.locator('#cancelApproverSelect').selectOption('e2e-manager');
    }
    await cancelOverlay.locator('#overridePin').fill('2468');
    const blockedCancelRespPromise = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        res.request().method() === 'PATCH' &&
        url.pathname === `/api/orders/${releasedSchedId}/status`
      );
    });
    await cancelOverlay.getByRole('button', { name: 'Confirm Cancel', exact: true }).click();
    const blockedCancelResp = await blockedCancelRespPromise;
    expect(blockedCancelResp.status()).toBe(409);
    await expect(
      page.getByText('Refund collected payment before cancelling this scheduled order.').first(),
    ).toBeVisible();
    await cancelOverlay.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Partial refund via /orders Refund modal -> Partially Refunded badge, Checkout suppressed, Refund still exposed
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    const refundOverlay1 = page.locator('.fixed.inset-0.z-50').last();
    await expect(refundOverlay1).toBeVisible();
    await refundOverlay1.locator('#refundAmount').fill('5');
    await expect(async () => {
      if (await refundOverlay1.locator('#refundApprover').count()) {
        await refundOverlay1.locator('#refundApprover').selectOption('e2e-manager');
      }
      await refundOverlay1.locator('#refundPin').fill('2468');
      await expect(refundOverlay1.getByRole('button', { name: /Issue refund/i })).toBeEnabled({
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await refundOverlay1.getByRole('button', { name: /Issue refund/i }).click();
    await expect(page.getByText(/Refund issued/i).first()).toBeVisible();

    await expect(detailPanel.getByText('Partially Refunded', { exact: true })).toBeVisible();
    await expect(detailPanel.getByRole('button', { name: 'Take Payment' })).toHaveCount(0);
    await expect(detailPanel.getByRole('button', { name: 'Checkout' })).toHaveCount(0);
    await expect(detailPanel.getByRole('button', { name: 'Refund', exact: true })).toBeVisible();
    await page.screenshot({
      path: `${evidenceDir}/05-orders-released-partially-refunded.png`,
      fullPage: true,
    });

    // Remaining refund via /orders Refund modal -> Refunded badge, Refund hidden, cancel now succeeds
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    const refundOverlay2 = page.locator('.fixed.inset-0.z-50').last();
    await expect(refundOverlay2).toBeVisible();
    await expect(async () => {
      if (await refundOverlay2.locator('#refundApprover').count()) {
        await refundOverlay2.locator('#refundApprover').selectOption('e2e-manager');
      }
      await refundOverlay2.locator('#refundPin').fill('2468');
      await expect(refundOverlay2.getByRole('button', { name: /Issue refund/i })).toBeEnabled({
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await refundOverlay2.getByRole('button', { name: /Issue refund/i }).click();
    await expect(page.getByText(/Refund issued/i).first()).toBeVisible();

    await expect(detailPanel.getByText('Refunded', { exact: true })).toBeVisible();
    await expect(detailPanel.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
    await expect(detailPanel.getByRole('button', { name: 'Checkout' })).toHaveCount(0);

    await detailPanel
      .locator('button[aria-haspopup="menu"]')
      .filter({ has: page.locator('svg.lucide-ellipsis') })
      .click();
    await page.getByRole('menuitem', { name: /^Cancel$/ }).click();
    const finalCancelOverlay = page.locator('.fixed.inset-0.z-50').last();
    await expect(finalCancelOverlay).toBeVisible();
    if (await finalCancelOverlay.locator('#cancelApproverSelect').count()) {
      await finalCancelOverlay.locator('#cancelApproverSelect').selectOption('e2e-manager');
    }
    if (await finalCancelOverlay.locator('#overridePin').count()) {
      await finalCancelOverlay.locator('#overridePin').fill('2468');
    }
    await finalCancelOverlay.getByRole('button', { name: 'Confirm Cancel', exact: true }).click();
    await expect(page.getByText(/Order cancelled successfully/i).first()).toBeVisible();
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
    if (managerPinSet) {
      await page.request
        .put(`${BASE}/api/staff/e2e-manager`, {
          headers: ownerHeaders,
          data: { pin: null },
        })
        .catch(() => {});
    }
  }
});
