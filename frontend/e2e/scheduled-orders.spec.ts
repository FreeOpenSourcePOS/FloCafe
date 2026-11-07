import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

const DEFAULT_LOCAL_EVIDENCE =
  '/Users/gurkiratkhaira/.no-mistakes/evidence/01M64J866EWP5Q41XVW3W8J3Q9';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  (fs.existsSync(path.dirname(DEFAULT_LOCAL_EVIDENCE))
    ? DEFAULT_LOCAL_EVIDENCE
    : path.join(os.tmpdir(), 'no-mistakes-evidence', '01M64J866EWP5Q41XVW3W8J3Q9'));

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  try {
    if (!fs.existsSync(EVIDENCE_DIR)) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    }
    await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: true });
  } catch (err) {
    console.warn(`Could not save screenshot ${filename}:`, err);
  }
}

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
  await page.clock.install();
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
  const runId = Math.random().toString(36).slice(2, 8);
  const createdOrderIds: number[] = [];
  let trackedProductId: string | null = null;
  let managerId: string | null = null;
  let extraApproverId: string | null = null;
  const priorScheduledSettingRes = await page.request.get(
    `${BASE}/api/settings/scheduled_orders_enabled`,
    { headers: ownerHeaders },
  );
  expect(priorScheduledSettingRes.ok(), 'read prior scheduled_orders_enabled').toBeTruthy();
  const priorScheduledSettingBody = await priorScheduledSettingRes.json();
  const priorScheduledOrdersEnabled =
    priorScheduledSettingBody?.setting?.value === 'true' ? 'true' : 'false';

  try {
    const disableRes = await page.request.put(`${BASE}/api/settings/scheduled_orders_enabled`, {
      headers: ownerHeaders,
      data: { value: 'false' },
    });
    expect(disableRes.ok(), 'set scheduled_orders_enabled to false for setup').toBeTruthy();

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    const cartShell = page.getByTestId('cart-shell');

    // 0. When scheduled_orders_enabled is false (default), scheduled order controls are hidden
    await expect(page.getByTestId('pos-scheduled-orders-btn')).toHaveCount(0);
    await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toHaveCount(0);
    await cartShell.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toHaveCount(0);
    await expect(cartShell.getByTestId('pos-order-details-summary')).toBeVisible();
    await captureScreenshot(page, '00a-pos-scheduled-orders-disabled-clean-cart.png');

    // Enable scheduled_orders_enabled via Settings -> POS toggle and verify POS reflects it
    await page.goto(`${BASE}/settings`);
    await page.getByRole('button', { name: /POS/i }).first().click();
    const scheduledToggle = page.getByTestId('setting-scheduled-orders-enabled');
    await expect(scheduledToggle).toBeVisible();
    await expect(scheduledToggle).toHaveAttribute('aria-checked', 'false');
    const putTogglePromise = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        res.request().method() === 'PUT' &&
        url.pathname === '/api/settings/scheduled_orders_enabled'
      );
    });
    await scheduledToggle.click();
    const putToggleRes = await putTogglePromise;
    expect(putToggleRes.ok()).toBeTruthy();
    await expect(scheduledToggle).toHaveAttribute('aria-checked', 'true');
    await captureScreenshot(page, '00b-settings-pos-scheduled-orders-toggle.png');

    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await expect(page.getByTestId('pos-scheduled-orders-btn')).toBeVisible();

    // 1. Order-type gating in POS: hidden on Dine in & Online, visible on Takeaway & Delivery
    await cartShell.getByRole('button', { name: 'Dine in', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toHaveCount(0);

    await cartShell.getByRole('button', { name: 'Online', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toHaveCount(0);

    await cartShell.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toBeVisible();
    await expect(cartShell.getByText('Send to kitchen at')).toBeVisible();

    // Short screen (1024x600) Delivery compact layout check: cart items scroll area >= 300px
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    const shortDeliveryCartBox = await page.getByTestId('cart-items-scroll').boundingBox();
    expect(shortDeliveryCartBox).not.toBeNull();
    expect(shortDeliveryCartBox!.height).toBeGreaterThanOrEqual(300);
    await captureScreenshot(page, '00c-pos-short-screen-1024x600-delivery-cart.png');
    await page.setViewportSize({ width: 1280, height: 720 });

    await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await expect(cartShell.getByTestId('pos-schedule-section')).toBeVisible();
    await expect(cartShell.getByText('Send to kitchen at')).toBeVisible();

    // Past time triggers inline error and disables Place Order
    await cartShell.getByTestId('pos-order-details-summary').click();
    const detailsDrawer = page.getByTestId('pos-order-details-drawer');
    await expect(detailsDrawer).toBeVisible();

    const scheduleInput = detailsDrawer.getByTestId('pos-send-to-kitchen-input');
    await scheduleInput.fill('2020-01-15T10:00');
    await expect(detailsDrawer.getByTestId('pos-schedule-error')).toBeVisible();
    await detailsDrawer.getByTestId('pos-order-details-done-btn').click();
    await expect(detailsDrawer).toHaveCount(0);
    await expect(cartShell.getByTestId('pos-schedule-error')).toBeVisible();
    await expect(cartShell.getByRole('button', { name: 'Place Order' })).toBeDisabled();

    // Reopen drawer, clear, and use Schedule for later toggle, then set explicit future time
    await cartShell.getByTestId('pos-order-details-summary').click();
    await expect(detailsDrawer).toBeVisible();
    await detailsDrawer.getByTestId('pos-schedule-clear-btn').click();
    await detailsDrawer.getByTestId('pos-schedule-suggest-btn').click();
    await expect(detailsDrawer.getByTestId('pos-schedule-error')).toHaveCount(0);

    const initialFutureWall = futureBangkokWallClock(90);
    await scheduleInput.fill(initialFutureWall);
    await expect(detailsDrawer.getByTestId('pos-schedule-error')).toHaveCount(0);
    await captureScreenshot(page, '01a-pos-order-details-drawer-open.png');
    await detailsDrawer.getByTestId('pos-order-details-done-btn').click();
    await expect(detailsDrawer).toHaveCount(0);
    await captureScreenshot(page, '01-pos-send-to-kitchen-at.png');

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
    await captureScreenshot(page, '02-scheduled-drawer-paid-edit-locked.png');

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

    const managerRes = await page.request.post(`${BASE}/api/staff`, {
      headers: ownerHeaders,
      data: {
        name: 'Scheduled refund manager',
        email: `scheduled-refund-${runId}@flo.local`,
        password: 'Password123!',
        role: 'manager',
        pin: '2468',
      },
    });
    expect(managerRes.ok()).toBeTruthy();
    managerId = (await managerRes.json()).staff.id;
    const extraApproverRes = await page.request.post(`${BASE}/api/staff`, {
      headers: ownerHeaders,
      data: {
        name: 'Scheduled test manager',
        email: `scheduled-manager-${runId}@flo.local`,
        password: 'Password123!',
        role: 'manager',
        pin: '1357',
      },
    });
    expect(extraApproverRes.ok()).toBeTruthy();
    extraApproverId = (await extraApproverRes.json()).staff.id;

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
        approver_id: managerId,
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
        approver_id: managerId,
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

    const refundedReleaseResponse = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        res.request().method() === 'POST' &&
        url.pathname === `/api/orders/${prepaidOrderId}/release`
      );
    });
    await paidCard.getByTestId(`scheduled-release-btn-${prepaidOrderId}`).click();
    expect((await refundedReleaseResponse).status()).toBe(409);
    await expect(paidCard.getByTestId(`scheduled-blocked-reason-${prepaidOrderId}`)).toContainText(
      'Refunded',
    );
    await expect(paidCard.getByTestId(`scheduled-blocked-reason-${prepaidOrderId}`)).toContainText(
      'Cancel Order',
    );

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
    await captureScreenshot(page, '03-scheduled-drawer-blocked-shortage.png');

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
      await expect(page.getByTestId('pos-scheduled-blocked-badge')).toHaveText('2');

      await page.getByTestId('pos-scheduled-orders-btn').click();
      const appendDrawer = page.getByTestId('scheduled-orders-drawer');
      await expect(appendDrawer).toBeVisible();
      await appendDrawer
        .getByTestId(`scheduled-order-card-${deliveryOrderId}`)
        .getByTestId(`scheduled-add-items-btn-${deliveryOrderId}`)
        .click();

      await expect(cartShell.getByTestId('cart-scheduled-existing-banner')).toBeVisible();
      await expect(cartShell.getByTestId('pos-order-details-summary')).toHaveCount(0);
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
    await captureScreenshot(page, '04-orders-released-partially-paid.png');

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
      await cancelOverlay.locator('#cancelApproverSelect').selectOption(managerId!);
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

    let releaseStaleApprovers!: () => void;
    let markStaleApproversStarted!: () => void;
    const staleApproversGate = new Promise<void>((resolve) => {
      releaseStaleApprovers = resolve;
    });
    const staleApproversStarted = new Promise<void>((resolve) => {
      markStaleApproversStarted = resolve;
    });
    await page.route(
      '**/api/staff/approvers',
      async (route) => {
        markStaleApproversStarted();
        await staleApproversGate;
        await route.continue();
      },
      { times: 1 },
    );
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    await staleApproversStarted;
    const staleApproverOverlay = page.locator('.fixed.inset-0.z-50').last();
    await staleApproverOverlay.getByRole('button', { name: 'Cancel', exact: true }).click();
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    const freshApproverOverlay = page.locator('.fixed.inset-0.z-50').last();
    await expect(freshApproverOverlay.locator('#refundApprover')).toBeVisible();
    await freshApproverOverlay.locator('#refundApprover').selectOption(managerId!);
    await freshApproverOverlay.locator('#refundPin').fill('2468');
    const staleApproversResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/staff/approvers',
    );
    releaseStaleApprovers();
    await staleApproversResponse;
    await expect(freshApproverOverlay.locator('#refundApprover')).toHaveValue(managerId!);
    await expect(freshApproverOverlay.locator('#refundPin')).toHaveValue('2468');
    await freshApproverOverlay.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.route(
      '**/api/staff/approvers',
      (route) => route.fulfill({ status: 503, json: {} }),
      { times: 1 },
    );
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    const failedApproverOverlay = page.locator('.fixed.inset-0.z-50').last();
    await expect(
      failedApproverOverlay.getByText('Could not load refund approvers. Try again.'),
    ).toBeVisible();
    await expect(failedApproverOverlay.locator('#refundPin')).toBeDisabled();
    await expect(
      failedApproverOverlay.getByRole('button', { name: /Issue refund/i }),
    ).toBeDisabled();
    await failedApproverOverlay.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.route(
      '**/api/staff/approvers',
      (route) => route.fulfill({ json: { approvers: [] } }),
      { times: 1 },
    );
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    const emptyApproverOverlay = page.locator('.fixed.inset-0.z-50').last();
    await expect(
      emptyApproverOverlay.getByText(
        'Refund approval is not configured. Set an Approval PIN in Staff before issuing refunds.',
      ),
    ).toBeVisible();
    await expect(emptyApproverOverlay.locator('#refundPin')).toBeDisabled();
    await expect(
      emptyApproverOverlay.getByRole('button', { name: /Issue refund/i }),
    ).toBeDisabled();
    await emptyApproverOverlay.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Partial refund via /orders Refund modal -> Partially Refunded badge, Checkout suppressed, Refund still exposed
    let releaseApprovers!: () => void;
    const approversGate = new Promise<void>((resolve) => {
      releaseApprovers = resolve;
    });
    await page.route(
      '**/api/staff/approvers',
      async (route) => {
        await approversGate;
        const response = await route.fetch();
        const body = await response.json();
        body.approvers = body.approvers.filter(
          (member: { role: string }) => member.role !== 'owner',
        );
        body.approvers.push({
          id: 'refund-test-owner',
          name: 'Refund test owner',
          role: 'owner',
          is_active: 1,
          has_pin: true,
        });
        await route.fulfill({ response, json: body });
      },
      { times: 1 },
    );
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(page.locator('#refundPin')).toBeDisabled();
    releaseApprovers();
    const refundOverlay1 = page.locator('.fixed.inset-0.z-50').last();
    await expect(refundOverlay1).toBeVisible();
    await refundOverlay1.locator('#refundAmount').fill('5');
    await expect(refundOverlay1.locator('#refundApprover')).toBeVisible();
    await refundOverlay1.locator('#refundApprover').selectOption(managerId!);
    await refundOverlay1.locator('#refundPin').fill('2468');
    await page.clock.fastForward(30000);
    await expect(refundOverlay1.locator('#refundApprover')).toHaveValue(managerId!);
    await expect(refundOverlay1.locator('#refundPin')).toHaveValue('2468');
    const earlyRefundTime = await page.evaluate(() => Date.now());
    await refundOverlay1.locator('#refundApprover').selectOption('refund-test-owner');
    await refundOverlay1.locator('#refundPin').fill('1357');
    await page.clock.fastForward(61 * 60 * 1000);
    await expect(refundOverlay1.getByText('Refund test owner')).toBeVisible();
    await expect(refundOverlay1.locator('#refundPin')).toHaveValue('1357');
    await page.clock.setSystemTime(earlyRefundTime);
    await page.clock.fastForward(30000);
    await refundOverlay1.locator('#refundApprover').selectOption(managerId!);
    await refundOverlay1.locator('#refundPin').fill('2468');
    await page.clock.fastForward(61 * 60 * 1000);
    await expect(refundOverlay1.getByText('Refund test owner')).toBeVisible();
    await expect(refundOverlay1.locator('#refundPin')).toHaveValue('');
    await page.clock.setSystemTime(earlyRefundTime);
    await page.clock.fastForward(30000);
    await refundOverlay1.locator('#refundApprover').selectOption(managerId!);
    await refundOverlay1.locator('#refundPin').fill('2468');
    await refundOverlay1.locator('#refundApprover').selectOption(extraApproverId!);
    await expect(refundOverlay1.locator('#refundPin')).toHaveValue('');
    await refundOverlay1.locator('#refundApprover').selectOption(managerId!);
    await refundOverlay1.locator('#refundPin').fill('2468');
    await expect(refundOverlay1.getByRole('button', { name: /Issue refund/i })).toBeEnabled();
    await refundOverlay1.getByRole('button', { name: /Issue refund/i }).click();
    await expect(page.getByText(/Refund issued/i).first()).toBeVisible();

    await expect(detailPanel.getByText('Partially Refunded', { exact: true })).toBeVisible();
    await expect(detailPanel.getByRole('button', { name: 'Take Payment' })).toHaveCount(0);
    await expect(detailPanel.getByRole('button', { name: 'Checkout' })).toHaveCount(0);
    await expect(detailPanel.getByRole('button', { name: 'Refund', exact: true })).toBeVisible();
    await captureScreenshot(page, '05-orders-released-partially-refunded.png');

    // Remaining refund via /orders Refund modal -> Refunded badge, Refund hidden, cancel now succeeds
    await detailPanel.getByRole('button', { name: 'Refund', exact: true }).click();
    const refundOverlay2 = page.locator('.fixed.inset-0.z-50').last();
    await expect(refundOverlay2).toBeVisible();
    await expect(refundOverlay2.locator('#refundApprover')).toBeVisible();
    await refundOverlay2.locator('#refundApprover').selectOption(managerId!);
    await refundOverlay2.locator('#refundPin').fill('2468');
    await expect(refundOverlay2.getByRole('button', { name: /Issue refund/i })).toBeEnabled();
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
      await finalCancelOverlay.locator('#cancelApproverSelect').selectOption(managerId!);
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
    const fixtureApprovers = [extraApproverId, managerId].filter((id): id is string => id !== null);
    const deactivateResults = await Promise.all(
      fixtureApprovers.map((id) =>
        page.request.post(`${BASE}/api/staff/${id}/deactivate`, { headers: ownerHeaders }),
      ),
    );
    for (const response of deactivateResults) {
      expect(response.ok(), 'deactivate disposable refund approver').toBeTruthy();
    }
    const restoreSettingRes = await page.request.put(
      `${BASE}/api/settings/scheduled_orders_enabled`,
      {
        headers: ownerHeaders,
        data: { value: priorScheduledOrdersEnabled },
      },
    );
    expect(restoreSettingRes.ok(), 'restore prior scheduled_orders_enabled').toBeTruthy();
  }
});

test('POS scheduled orders: unresolved order attempts preserve payload and idempotency key when scheduling settings fail or toggle', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
  const createdOrderIds: number[] = [];

  const priorBusinessRes = await page.request.get(`${BASE}/api/settings/business`, {
    headers: ownerHeaders,
  });
  expect(priorBusinessRes.ok()).toBeTruthy();
  const priorBusiness = (await priorBusinessRes.json()) as Record<string, unknown>;

  const priorScheduledSettingRes = await page.request.get(
    `${BASE}/api/settings/scheduled_orders_enabled`,
    { headers: ownerHeaders },
  );
  expect(priorScheduledSettingRes.ok()).toBeTruthy();
  const priorScheduledSettingBody = await priorScheduledSettingRes.json();
  const priorScheduledOrdersEnabled =
    priorScheduledSettingBody?.setting?.value === 'true' ? 'true' : 'false';

  const submittedOrders: Array<{
    idempotencyKey: string | undefined;
    body: { scheduled_for?: string };
  }> = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    if (new URL(req.url()).pathname !== '/api/orders') return;
    submittedOrders.push({
      idempotencyKey: req.headers()['idempotency-key'],
      body: (req.postDataJSON() || {}) as { scheduled_for?: string },
    });
  });

  try {
    const postpaidRes = await page.request.put(`${BASE}/api/settings/business`, {
      headers: ownerHeaders,
      data: { ...priorBusiness, billing_type: 'postpaid' },
    });
    expect(postpaidRes.ok()).toBeTruthy();

    const enableRes = await page.request.put(`${BASE}/api/settings/scheduled_orders_enabled`, {
      headers: ownerHeaders,
      data: { value: 'true' },
    });
    expect(enableRes.ok()).toBeTruthy();

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    const cartShell = page.getByTestId('cart-shell');

    // Scenario A: Scheduled order commits on backend (201) while response is lost,
    // followed by one failed scheduling-setting read and recovery -> retry replays original order (200)
    await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    await cartShell.getByTestId('pos-order-details-summary').click();
    const detailsDrawer = page.getByTestId('pos-order-details-drawer');
    await expect(detailsDrawer).toBeVisible();
    const firstScheduleWall = futureBangkokWallClock(95);
    await detailsDrawer.getByTestId('pos-send-to-kitchen-input').fill(firstScheduleWall);
    await detailsDrawer.getByTestId('pos-order-details-done-btn').click();
    await expect(detailsDrawer).toHaveCount(0);

    let firstCommittedOrderId = 0;
    let abortFirstOrderPost = true;
    let abortSecondOrderPost = false;
    let secondCommittedOrderId = 0;
    let abortWithoutCommitOrderPost = false;
    await page.route('**/api/orders', async (route) => {
      if (
        route.request().method() !== 'POST' ||
        new URL(route.request().url()).pathname !== '/api/orders'
      ) {
        await route.continue();
        return;
      }
      if (abortFirstOrderPost) {
        abortFirstOrderPost = false;
        const realRes = await route.fetch();
        expect(realRes.status()).toBe(201);
        const body = await realRes.json();
        firstCommittedOrderId = Number(body.order.id);
        createdOrderIds.push(firstCommittedOrderId);
        await route.abort('connectionreset');
        return;
      }
      if (abortSecondOrderPost) {
        abortSecondOrderPost = false;
        const realRes = await route.fetch();
        expect(realRes.status()).toBe(201);
        const body = await realRes.json();
        secondCommittedOrderId = Number(body.order.id);
        createdOrderIds.push(secondCommittedOrderId);
        await route.abort('connectionreset');
        return;
      }
      if (abortWithoutCommitOrderPost) {
        abortWithoutCommitOrderPost = false;
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });

    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('status').last()).toContainText(
      'FloCafe could not confirm whether the order or payment was saved.',
    );
    expect(submittedOrders).toHaveLength(1);
    expect(submittedOrders[0].idempotencyKey).toBeTruthy();
    expect(submittedOrders[0].body.scheduled_for).toBe(firstScheduleWall);

    const navMenu = page.getByRole('navigation', { name: 'Menu' });

    // Trigger one failed scheduling-setting read when POS remounts
    let failNextScheduledSettingRead = true;
    await page.route('**/api/settings/scheduled_orders_enabled', async (route) => {
      if (route.request().method() === 'GET' && failNextScheduledSettingRead) {
        failNextScheduledSettingRead = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary settings read failure' }),
        });
        return;
      }
      await route.continue();
    });

    await navMenu.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL('**/orders/**');
    const failedSettingRead = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        new URL(res.url()).pathname === '/api/settings/scheduled_orders_enabled' &&
        res.status() === 503,
    );
    await navMenu.getByRole('link', { name: 'POS', exact: true }).click();
    await failedSettingRead;
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    // Now let the scheduling-setting read recover (returns true)
    await navMenu.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL('**/orders/**');
    const recoveredSettingRead = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        new URL(res.url()).pathname === '/api/settings/scheduled_orders_enabled' &&
        res.status() === 200,
    );
    await navMenu.getByRole('link', { name: 'POS', exact: true }).click();
    await recoveredSettingRead;
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await expect(page.getByTestId('pos-scheduled-orders-btn')).toBeVisible();

    const firstReplayResPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders',
    );
    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    const firstReplayRes = await firstReplayResPromise;
    expect(firstReplayRes.status()).toBe(200);
    const firstReplayBody = await firstReplayRes.json();
    expect(Number(firstReplayBody.order.id)).toBe(firstCommittedOrderId);
    expect(submittedOrders).toHaveLength(2);
    expect(submittedOrders[1].idempotencyKey).toBe(submittedOrders[0].idempotencyKey);
    expect(submittedOrders[1].body.scheduled_for).toBe(firstScheduleWall);
    await expect(page.getByTestId('cart-item')).toHaveCount(0);

    // Scenario B: Scheduled order commits on backend (201) while response is lost,
    // followed by disabling then re-enabling scheduling -> retry replays original order (200)
    await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    await cartShell.getByTestId('pos-order-details-summary').click();
    await expect(detailsDrawer).toBeVisible();
    const secondScheduleWall = futureBangkokWallClock(115);
    await detailsDrawer.getByTestId('pos-send-to-kitchen-input').fill(secondScheduleWall);
    await detailsDrawer.getByTestId('pos-order-details-done-btn').click();
    await expect(detailsDrawer).toHaveCount(0);

    abortSecondOrderPost = true;
    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('status').last()).toContainText(
      'FloCafe could not confirm whether the order or payment was saved.',
    );
    expect(submittedOrders).toHaveLength(3);
    expect(submittedOrders[2].idempotencyKey).toBeTruthy();
    expect(submittedOrders[2].body.scheduled_for).toBe(secondScheduleWall);

    // Disable scheduling and remount POS
    const disableToggleRes = await page.request.put(
      `${BASE}/api/settings/scheduled_orders_enabled`,
      {
        headers: ownerHeaders,
        data: { value: 'false' },
      },
    );
    expect(disableToggleRes.ok()).toBeTruthy();
    await navMenu.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL('**/orders/**');
    const disabledRead = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        new URL(res.url()).pathname === '/api/settings/scheduled_orders_enabled' &&
        res.status() === 200,
    );
    await navMenu.getByRole('link', { name: 'POS', exact: true }).click();
    await disabledRead;
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    // Re-enable scheduling and remount POS
    const reenableToggleRes = await page.request.put(
      `${BASE}/api/settings/scheduled_orders_enabled`,
      {
        headers: ownerHeaders,
        data: { value: 'true' },
      },
    );
    expect(reenableToggleRes.ok()).toBeTruthy();
    await navMenu.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL('**/orders/**');
    const reenabledRead = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        new URL(res.url()).pathname === '/api/settings/scheduled_orders_enabled' &&
        res.status() === 200,
    );
    await navMenu.getByRole('link', { name: 'POS', exact: true }).click();
    await reenabledRead;
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    const secondReplayResPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders',
    );
    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    const secondReplayRes = await secondReplayResPromise;
    expect(secondReplayRes.status()).toBe(200);
    const secondReplayBody = await secondReplayRes.json();
    expect(Number(secondReplayBody.order.id)).toBe(secondCommittedOrderId);
    expect(submittedOrders).toHaveLength(4);
    expect(submittedOrders[3].idempotencyKey).toBe(submittedOrders[2].idempotencyKey);
    expect(submittedOrders[3].body.scheduled_for).toBe(secondScheduleWall);
    await expect(page.getByTestId('cart-item')).toHaveCount(0);

    // Scenario C: Uncommitted scheduled order attempt whose retry receives a definitive
    // schedule rejection (409 SCHEDULED_ORDERS_DISABLED, outcome: not_applied) retires the
    // saved attempt so the cashier can place an unscheduled order with a fresh idempotency key.
    await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    await cartShell.getByTestId('pos-order-details-summary').click();
    await expect(detailsDrawer).toBeVisible();
    const thirdScheduleWall = futureBangkokWallClock(135);
    await detailsDrawer.getByTestId('pos-send-to-kitchen-input').fill(thirdScheduleWall);
    await detailsDrawer.getByTestId('pos-order-details-done-btn').click();
    await expect(detailsDrawer).toHaveCount(0);

    abortWithoutCommitOrderPost = true;
    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('status').last()).toContainText(
      'FloCafe could not confirm whether the order or payment was saved.',
    );
    expect(submittedOrders).toHaveLength(5);
    expect(submittedOrders[4].idempotencyKey).toBeTruthy();
    expect(submittedOrders[4].body.scheduled_for).toBe(thirdScheduleWall);

    const disableForRejectRes = await page.request.put(
      `${BASE}/api/settings/scheduled_orders_enabled`,
      {
        headers: ownerHeaders,
        data: { value: 'false' },
      },
    );
    expect(disableForRejectRes.ok()).toBeTruthy();
    await navMenu.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL('**/orders/**');
    const disabledForRejectRead = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        new URL(res.url()).pathname === '/api/settings/scheduled_orders_enabled' &&
        res.status() === 200,
    );
    await navMenu.getByRole('link', { name: 'POS', exact: true }).click();
    await disabledForRejectRead;
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    const rejectedRetryResPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders',
    );
    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    const rejectedRetryRes = await rejectedRetryResPromise;
    expect(rejectedRetryRes.status()).toBe(409);
    const rejectedRetryBody = await rejectedRetryRes.json();
    expect(rejectedRetryBody.code).toBe('SCHEDULED_ORDERS_DISABLED');
    expect(rejectedRetryBody.outcome).toBe('not_applied');
    expect(submittedOrders).toHaveLength(6);
    expect(submittedOrders[5].idempotencyKey).toBe(submittedOrders[4].idempotencyKey);
    expect(submittedOrders[5].body.scheduled_for).toBe(thirdScheduleWall);
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    const freshImmediateResPromise = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders',
    );
    await cartShell.getByRole('button', { name: 'Place Order' }).click();
    const freshImmediateRes = await freshImmediateResPromise;
    expect(freshImmediateRes.status()).toBe(201);
    const freshImmediateBody = await freshImmediateRes.json();
    createdOrderIds.push(Number(freshImmediateBody.order.id));
    expect(submittedOrders).toHaveLength(7);
    expect(submittedOrders[6].idempotencyKey).toBeTruthy();
    expect(submittedOrders[6].idempotencyKey).not.toBe(submittedOrders[4].idempotencyKey);
    expect(submittedOrders[6].body.scheduled_for).toBeUndefined();
    await expect(page.getByTestId('cart-item')).toHaveCount(0);
  } finally {
    for (const orderId of createdOrderIds) {
      await page.request
        .patch(`${BASE}/api/orders/${orderId}/status`, {
          headers: ownerHeaders,
          data: { status: 'cancelled', reason: 'E2E cleanup' },
        })
        .catch(() => {});
    }
    const [restoreBusinessOutcome, restoreSettingOutcome] = await Promise.allSettled([
      page.request.put(`${BASE}/api/settings/business`, {
        headers: ownerHeaders,
        data: priorBusiness,
      }),
      page.request.put(`${BASE}/api/settings/scheduled_orders_enabled`, {
        headers: ownerHeaders,
        data: { value: priorScheduledOrdersEnabled },
      }),
    ]);
    expect(
      restoreBusinessOutcome.status === 'fulfilled' && restoreBusinessOutcome.value.ok(),
      'restore prior business settings',
    ).toBeTruthy();
    expect(
      restoreSettingOutcome.status === 'fulfilled' && restoreSettingOutcome.value.ok(),
      'restore prior scheduled_orders_enabled',
    ).toBeTruthy();
  }
});
