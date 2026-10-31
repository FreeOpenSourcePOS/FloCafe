import fs from 'fs';
import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test.use({ timezoneId: 'UTC' });

const DEFAULT_LOCAL_EVIDENCE =
  '/Users/gurkiratkhaira/.no-mistakes/evidence/01M64ZVACDJJ8WG82NMYQVDPS5';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  (fs.existsSync(DEFAULT_LOCAL_EVIDENCE)
    ? DEFAULT_LOCAL_EVIDENCE
    : path.join('/tmp', 'no-mistakes-evidence', '01M64ZVACDJJ8WG82NMYQVDPS5'));

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
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;
  const hour = values.hour === '24' ? '00' : values.hour;
  return `${values.year}-${values.month}-${values.day}T${hour}:${values.minute}`;
}

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

test('Multi-counter ordering flow: Owner config, create & pay, queue, table occupancy, release gates, and stock retry (#361)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = {
    Authorization: `Bearer ${ownerToken}`,
    'Content-Type': 'application/json',
  };

  const runId = Math.random().toString(36).slice(2, 6);
  let orderingCounter: { id: string; name?: string; role?: string } = { id: '' };
  let paymentCounter: { id: string; name?: string; role?: string } = { id: '' };
  let combinedCounter: { id: string; name?: string; role?: string } = { id: '' };
  let createdTable: { id: number; name?: string } = { id: 0 };
  let dineInOrderId: number = 0;
  let limitedProduct: { id: string; name?: string } = { id: '' };
  const createdOrderIds = new Set<number>();
  let previousBillingType: string | undefined;
  let previousTablesRequired: boolean | undefined;
  let previousMultiCounterEnabled: string | undefined;
  let previousTimezone: string | undefined;
  const cleanupErrors: string[] = [];
  let primaryTestError: unknown;
  let hasPrimaryTestError = false;
  const attemptCleanup = async (label: string, cleanup: () => Promise<void>) => {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Owner configures multi-counter mode and manages named counters
    // -------------------------------------------------------------------------
    await test.step('Scenario 1: Owner configures multi-counter mode and manages named counters in settings', async () => {
      const previousSettingRes = await request.get(`${BASE}/api/settings/multi_counter_enabled`, {
        headers: ownerHeaders,
      });
      expect(previousSettingRes.ok(), 'read prior multi-counter setting').toBeTruthy();
      previousMultiCounterEnabled = (await previousSettingRes.json()).setting?.value;
      const previousTimezoneRes = await request.get(`${BASE}/api/settings/timezone`, {
        headers: ownerHeaders,
      });
      expect(previousTimezoneRes.ok(), 'read prior store timezone').toBeTruthy();
      previousTimezone = (await previousTimezoneRes.json()).setting?.value;
      const timezoneRes = await request.put(`${BASE}/api/settings/timezone`, {
        headers: ownerHeaders,
        data: { value: 'Asia/Bangkok' },
      });
      expect(timezoneRes.ok(), 'set store timezone for queue display check').toBeTruthy();

      // Enable multi_counter_enabled
      const businessRes = await request.get(`${BASE}/api/settings/business`, {
        headers: ownerHeaders,
      });
      expect(businessRes.ok(), 'read prior business settings').toBeTruthy();
      const businessSettings = await businessRes.json();
      previousBillingType = businessSettings.billing_type;
      previousTablesRequired = businessSettings.tables_required;
      if (previousBillingType !== 'prepaid') {
        const prepaidRes = await request.put(`${BASE}/api/settings/business`, {
          headers: ownerHeaders,
          data: { billing_type: 'prepaid', tables_required: previousTablesRequired },
        });
        expect(prepaidRes.ok(), 'set prepaid billing for multi-counter test').toBeTruthy();
      }

      const settingRes = await request.put(`${BASE}/api/settings/multi_counter_enabled`, {
        headers: ownerHeaders,
        data: { value: 'true' },
      });
      expect(settingRes.ok()).toBeTruthy();

      // Create ordering counter
      const ordRes = await request.post(`${BASE}/api/counters`, {
        headers: ownerHeaders,
        data: {
          name: `Ordering Counter ${runId}`,
          role: 'ordering',
          sort_order: 1,
        },
      });
      expect(ordRes.ok()).toBeTruthy();
      orderingCounter = (await ordRes.json()).counter;

      // Create payment counter
      const payRes = await request.post(`${BASE}/api/counters`, {
        headers: ownerHeaders,
        data: {
          name: `Cashier Counter ${runId}`,
          role: 'payment',
          sort_order: 2,
        },
      });
      expect(payRes.ok()).toBeTruthy();
      paymentCounter = (await payRes.json()).counter;

      // Create combined counter
      const combRes = await request.post(`${BASE}/api/counters`, {
        headers: ownerHeaders,
        data: {
          name: `Express Counter ${runId}`,
          role: 'combined',
          sort_order: 3,
        },
      });
      expect(combRes.ok()).toBeTruthy();
      combinedCounter = (await combRes.json()).counter;

      // Login as owner
      await page.goto(`${BASE}/auth/login`);
      await page.locator('#email').fill('owner@flo.local');
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
      await setLanguage(page, 'en');

      // Navigate to Settings > Counters tab
      await page.goto(`${BASE}/settings?tab=counters`);
      await expect(page.getByText('Multi-Counter Ordering')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(`Ordering Counter ${runId}`)).toBeVisible();
      await expect(page.getByText(`Cashier Counter ${runId}`)).toBeVisible();
      await expect(page.getByText(`Express Counter ${runId}`)).toBeVisible();

      await captureScreenshot(page, '01-settings-counters-management.png');
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Ordering counter creates takeaway order and sends to payment
    // -------------------------------------------------------------------------
    let createdOrderNumber: string = '';
    let createdOrderId: number = 0;

    await test.step('Scenario 2: Ordering counter builds takeaway order and sends to payment generating ticket and QR code', async () => {
      await page.goto(`${BASE}/pos`);
      await expect(page.getByTestId('pos-product-grid')).toBeVisible();

      // Counter selector in Topbar
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await expect(counterSelect).toBeVisible();

      // Select Ordering counter
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();

      // Add item to cart
      await page.getByTestId('pos-product-card').first().click();
      await expect(page.getByTestId('cart-item')).toHaveCount(1);

      const cartShell = page.getByTestId('cart-shell');

      for (const type of ['Delivery', 'Online']) {
        await cartShell.getByRole('button', { name: type, exact: true }).click();
        await expect(cartShell.getByTestId('pos-send-to-payment-btn')).toHaveCount(0);
        await expect(cartShell.getByRole('button', { name: 'Place Order' })).toBeVisible();
      }
      await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();

      // Primary checkout button should be "Send to payment"
      const sendToPaymentBtn = cartShell.getByTestId('pos-send-to-payment-btn');
      await expect(sendToPaymentBtn).toBeVisible();
      await page.route(
        '**/api/orders',
        async (route) => {
          expect(route.request().postDataJSON().dispatch_policy).toBe('on_payment');
          await route.fulfill({
            status: 409,
            json: { code: 'MULTI_COUNTER_DISABLED', error: 'Multi-counter ordering is disabled.' },
          });
        },
        { times: 1 },
      );
      await sendToPaymentBtn.click();
      await expect(
        page.getByText('Multi-counter ordering disabled', { exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId('cart-item')).toHaveCount(1);
      await expect(sendToPaymentBtn).toBeEnabled();

      await captureScreenshot(page, '02-pos-ordering-counter-view.png');

      const orderCreationResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && url.pathname === '/api/orders';
      });
      // Click "Send to payment"
      await sendToPaymentBtn.click();
      const createdOrderResponse = await orderCreationResponse;
      expect(createdOrderResponse.ok(), 'ordering counter creates a payment ticket').toBeTruthy();
      const createdOrderPayload = await createdOrderResponse.json();
      createdOrderId = Number(createdOrderPayload.order.id);
      createdOrderIds.add(createdOrderId);

      // Payment ticket confirmation modal displays
      const ticketModal = page.getByTestId('payment-ticket-confirmation-modal');
      await expect(ticketModal).toBeVisible();

      const ticketNumberEl = page.getByTestId('payment-ticket-number');
      await expect(ticketNumberEl).toBeVisible();
      const rawText = (await ticketNumberEl.textContent())?.trim();
      createdOrderNumber = rawText?.replace(/^#/, '').trim() || '';
      expect(createdOrderNumber).toBeTruthy();

      // QR code image is rendered with ticket payload
      const qrImage = page.getByTestId('payment-ticket-qr');
      await expect(qrImage).toBeVisible();

      // Print ticket button is present
      const printBtn = page.getByTestId('print-payment-ticket-btn');
      await expect(printBtn).toBeVisible();

      await captureScreenshot(page, '03-payment-ticket-confirmation-modal.png');

      // Close modal
      await page.getByTestId('payment-ticket-done-btn').click();
      await expect(ticketModal).toHaveCount(0);

      // Cart is cleared
      await expect(page.getByTestId('cart-item')).toHaveCount(0);

      // Verify backend state: dispatch_policy is on_payment, stage is awaiting_payment, release deferred
      const lookupRes = await request.get(
        `${BASE}/api/orders/by-ticket/${encodeURIComponent(createdOrderNumber)}`,
        {
          headers: ownerHeaders,
        },
      );
      expect(lookupRes.ok()).toBeTruthy();
      const ticketData = await lookupRes.json();
      expect(ticketData.order.dispatch_policy).toBe('on_payment');
      expect(ticketData.order.checkout_stage).toBe('awaiting_payment');
      expect(ticketData.order.release_status).toBe('scheduled');
      expect(ticketData.order.id).toBe(createdOrderId);

      // Verify order is NOT released to KDS prematurely
      const kdsRes = await request.get(`${BASE}/api/kds/orders`, { headers: ownerHeaders });
      const kdsBody = await kdsRes.json();
      expect(kdsBody.orders?.some((o: { id: number }) => o.id === createdOrderId)).toBeFalsy();
    });

    await test.step('Ordering and combined counters use normal checkout for delivery and online', async () => {
      const cartShell = page.getByTestId('cart-shell');
      for (const { type, action } of [
        { type: 'Delivery', action: 'click' },
        { type: 'Online', action: 'F4' },
        { type: 'Delivery', action: 'Space' },
      ]) {
        await cartShell.getByRole('button', { name: type, exact: true }).click();
        await page.getByTestId('pos-product-card').first().click();
        if (type === 'Delivery') {
          await cartShell.getByPlaceholder('Delivery address').fill('123 Test Street');
        } else {
          await cartShell.getByPlaceholder('Platform (e.g. Swiggy, Zomato)').fill('Test platform');
        }
        await expect(cartShell.getByTestId('pos-send-to-payment-btn')).toHaveCount(0);
        const placeOrder = cartShell.getByRole('button', { name: 'Place Order' });
        await expect(placeOrder).toBeEnabled();
        if (action === 'click') {
          await placeOrder.click();
        } else {
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.keyboard.press(action);
        }
        await expect(page.getByRole('button', { name: /Confirm Payment/ })).toBeVisible();
        const createResponse = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/orders',
        );
        await page.getByRole('button', { name: 'Cash', exact: true }).click();
        await page.getByRole('button', { name: /Confirm Payment/ }).click();
        const createdResponse = await createResponse;
        expect(createdResponse.status()).toBe(201);
        const createdOrder = (await createdResponse.json()).order;
        createdOrderIds.add(Number(createdOrder.id));
        expect(createdOrder.type).toBe(type.toLowerCase());
        expect(createdOrder.dispatch_policy).toBe('immediate');
        await expect(page.getByTestId('cart-item')).toHaveCount(0);
      }
      await page.getByTestId('pos-counter-selector-btn').click();
      await page.getByTestId(`pos-counter-option-${combinedCounter.id}`).click();
      for (const type of ['Delivery', 'Online']) {
        await cartShell.getByRole('button', { name: type, exact: true }).click();
        await expect(cartShell.getByTestId('pos-send-to-payment-btn')).toHaveCount(0);
        await expect(cartShell.getByRole('button', { name: 'Place Order' })).toBeVisible();
      }
      await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Payment counter auto-opens queue and settles payment to release
    // -------------------------------------------------------------------------
    await test.step('Scenario 3: Payment counter automatically opens shared waiting queue and settles payment to release order', async () => {
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${paymentCounter.id}`).click();

      // Payment counter automatically opens the shared waiting queue drawer
      const queueDrawer = page.getByTestId('payment-queue-drawer');
      await expect(queueDrawer).toBeVisible({ timeout: 10_000 });

      // Ticket is visible in queue
      const ticketRow = page.getByTestId(`queue-ticket-${createdOrderNumber}`);
      await expect(ticketRow).toBeVisible();
      const createdOrderRes = await request.get(`${BASE}/api/orders/${createdOrderId}`, {
        headers: ownerHeaders,
      });
      expect(createdOrderRes.ok()).toBeTruthy();
      const createdAt = (await createdOrderRes.json()).order.created_at as string;
      const utcCreatedAt = createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
      const expectedTicketTime = new Intl.DateTimeFormat('en', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Bangkok',
      }).format(new Date(utcCreatedAt));
      await expect(ticketRow.getByText(expectedTicketTime, { exact: true })).toBeVisible();

      await captureScreenshot(page, '04-payment-queue-drawer-auto-opened.png');

      // Click Pay on the ticket
      const payBtn = ticketRow.getByTestId('queue-pay-btn');
      await payBtn.click();

      // PaymentModal opens
      await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible();
      await captureScreenshot(page, '05-payment-modal-settlement.png');

      // Tender cash
      await page.getByTitle('Cash', { exact: true }).click();
      await page.getByRole('button', { name: /^Pay [^A-Za-z]/ }).click();

      const confirmButton = page
        .getByRole('dialog', { name: 'Confirm' })
        .getByRole('button', { name: 'Pay', exact: true });
      if (await confirmButton.count()) {
        await confirmButton.click();
      }

      const doneButton = page.getByRole('button', { name: 'Done' });
      await expect(doneButton).toBeVisible({ timeout: 10_000 });
      await doneButton.click();

      // PaymentModal closes
      await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0, {
        timeout: 10_000,
      });

      // Verify order backend state: checkout_stage: paid, release_status: released
      const orderRes = await request.get(`${BASE}/api/orders/${createdOrderId}`, {
        headers: ownerHeaders,
      });
      const orderData = await orderRes.json();
      expect(orderData.order.checkout_stage).toBe('paid');
      expect(orderData.order.release_status).toBe('released');
      expect(orderData.order.status).toBe('pending'); // Kitchen work is pending, NOT completed!

      // Queue drawer is cleared of this ticket
      await expect(page.getByTestId(`queue-ticket-${createdOrderNumber}`)).toHaveCount(0);

      // Close queue drawer if open
      const closeDrawerBtn = page.getByTestId('close-queue-drawer-btn');
      if (await closeDrawerBtn.isVisible()) {
        await closeDrawerBtn.click();
        await expect(queueDrawer).toHaveCount(0);
      }

      await captureScreenshot(page, '06-queue-cleared-after-payment.png');
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Combined counter retains normal checkout and offers Send to payment
    // -------------------------------------------------------------------------
    await test.step('Scenario 4: Combined counter retains normal checkout while offering explicit Send to payment', async () => {
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${combinedCounter.id}`).click();

      // Add item to cart
      await page.getByTestId('pos-product-card').first().click();
      await expect(page.getByTestId('cart-item')).toHaveCount(1);

      const cartShell = page.getByTestId('cart-shell');

      // Both "Send to payment" and "Place Order" must be visible and available
      await expect(cartShell.getByTestId('pos-send-to-payment-btn')).toBeVisible();
      await expect(cartShell.getByRole('button', { name: 'Place Order' })).toBeVisible();

      await captureScreenshot(page, '07-pos-combined-counter-view.png');

      // Remove item to clean cart
      await cartShell.locator('button[aria-label="Remove"]').first().click();
      await expect(page.getByTestId('cart-item')).toHaveCount(0);
    });

    await test.step('A lost send response cannot be submitted through normal checkout', async () => {
      const postpaidRes = await request.put(`${BASE}/api/settings/business`, {
        headers: ownerHeaders,
        data: { billing_type: 'postpaid', tables_required: previousTablesRequired },
      });
      expect(postpaidRes.ok(), 'use postpaid checkout for retry test').toBeTruthy();

      await page.goto(`${BASE}/pos`);
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${combinedCounter.id}`).click();
      await page.getByTestId('pos-product-card').first().click();

      const orderPosts: string[] = [];
      let resolveFirstAborted!: () => void;
      const firstAborted = new Promise<void>((resolve) => {
        resolveFirstAborted = resolve;
      });
      await page.route('**/api/orders', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || url.pathname !== '/api/orders') {
          await route.continue();
          return;
        }
        orderPosts.push(route.request().headers()['idempotency-key'] || '');
        const response = await route.fetch();
        const payload = await response.json();
        expect(response.status()).toBe(201);
        createdOrderIds.add(Number(payload.order.id));
        if (orderPosts.length === 1) {
          await route.abort();
          resolveFirstAborted();
        } else {
          await route.fulfill({ response });
        }
      });

      await page.getByTestId('pos-send-to-payment-btn').click();
      await firstAborted;
      await expect(page.getByTestId('cart-item')).toHaveCount(1);

      await page.getByRole('button', { name: 'Place Order' }).click();
      await expect(
        page.getByText('FloCafe could not confirm whether the order or payment was saved.').last(),
      ).toBeVisible();
      expect(orderPosts, 'changing checkout mode does not submit a second order').toHaveLength(1);

      await page.unroute('**/api/orders');
      await page.getByTestId('cart-shell').locator('button[aria-label="Remove"]').first().click();
      await expect(page.getByTestId('cart-item')).toHaveCount(0);
      await page.evaluate(() => {
        localStorage.removeItem('flo.postpaid.order.attempt.user.e2e-owner');
        sessionStorage.removeItem('flo.postpaid.order.attempt.user.e2e-owner');
      });

      const restoreBusinessRes = await request.put(`${BASE}/api/settings/business`, {
        headers: ownerHeaders,
        data: { billing_type: 'prepaid', tables_required: previousTablesRequired },
      });
      expect(restoreBusinessRes.ok(), 'restore prepaid billing after retry test').toBeTruthy();
    });

    await test.step('A committed send response after reauthentication clears only its submitted cart', async () => {
      await page.goto(`${BASE}/pos`);
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await page.getByTestId('pos-product-card').first().click();

      let releaseResponse!: () => void;
      let resolveCaptured!: (order: { id: number }) => void;
      let resolveDelivered!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const capturedOrder = new Promise<{ id: number }>((resolve) => {
        resolveCaptured = resolve;
      });
      const responseDelivered = new Promise<void>((resolve) => {
        resolveDelivered = resolve;
      });
      await page.route('**/api/orders', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || url.pathname !== '/api/orders') {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const payload = await response.json();
        expect(response.status()).toBe(201);
        const order = { id: Number(payload.order.id) };
        createdOrderIds.add(order.id);
        resolveCaptured(order);
        await responseGate;
        await route.fulfill({ response });
        resolveDelivered();
      });

      await page.getByTestId('pos-send-to-payment-btn').click();
      const committedOrder = await capturedOrder;
      await page.getByTestId('pos-lock-button').click();
      await page.waitForURL('**/auth/login**', { timeout: 20_000 });
      await page.locator('#email').fill('owner@flo.local');
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL('**/pos/**', { timeout: 20_000 });
      await setLanguage(page, 'en');
      await expect(page.getByTestId('cart-item')).toHaveCount(1);

      releaseResponse();
      await responseDelivered;
      await expect(page.getByTestId('cart-item')).toHaveCount(0);
      const attemptKey = 'flo.postpaid.order.attempt.user.e2e-owner';
      const persistedAttempt = await page.evaluate((key) => {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
      }, attemptKey);
      expect(persistedAttempt?.order?.id).toBe(committedOrder.id);
      await page.evaluate((key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }, attemptKey);
      await page.unroute('**/api/orders');
    });

    await test.step('A delayed send response cannot replace a newer same-user attempt after lock and reauthentication', async () => {
      await page.goto(`${BASE}/pos`);
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await page.getByTestId('pos-product-card').first().click();

      type CapturedOrder = {
        id: number;
        idempotencyKey: string | undefined;
        deliver: () => void;
      };
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let resolveFirstCaptured!: (order: CapturedOrder) => void;
      let resolveSecondCaptured!: (order: CapturedOrder) => void;
      let resolveFirstDelivered!: () => void;
      let resolveSecondDelivered!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const firstCaptured = new Promise<CapturedOrder>((resolve) => {
        resolveFirstCaptured = resolve;
      });
      const secondCaptured = new Promise<CapturedOrder>((resolve) => {
        resolveSecondCaptured = resolve;
      });
      const firstDelivered = new Promise<void>((resolve) => {
        resolveFirstDelivered = resolve;
      });
      const secondDelivered = new Promise<void>((resolve) => {
        resolveSecondDelivered = resolve;
      });
      let captureCount = 0;

      await page.route('**/api/orders', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || url.pathname !== '/api/orders') {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const payload = await response.json();
        expect(response.status()).toBe(201);
        const index = captureCount++;
        const capture: CapturedOrder = {
          id: Number(payload.order.id),
          idempotencyKey: route.request().headers()['idempotency-key'],
          deliver: index === 0 ? releaseFirst : releaseSecond,
        };
        createdOrderIds.add(capture.id);
        if (index === 0) resolveFirstCaptured(capture);
        else if (index === 1) resolveSecondCaptured(capture);
        await (index === 0 ? firstGate : secondGate);
        await route.fulfill({ response });
        if (index === 0) resolveFirstDelivered();
        else if (index === 1) resolveSecondDelivered();
      });

      await page.getByTestId('pos-send-to-payment-btn').click();
      const firstOrder = await firstCaptured;
      expect(firstOrder.idempotencyKey).toBeTruthy();

      await page.getByTestId('pos-lock-button').click();
      await page.waitForURL('**/auth/login**', { timeout: 20_000 });
      await page.locator('#email').fill('owner@flo.local');
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL('**/pos/**', { timeout: 20_000 });
      await setLanguage(page, 'en');
      await expect(page.getByTestId('cart-item')).toHaveCount(1);

      const reauthenticatedCounterSelect = page.getByTestId('pos-counter-selector-btn');
      await reauthenticatedCounterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await page.getByTestId('pos-product-card').first().click();
      await page.getByTestId('pos-send-to-payment-btn').click();
      const secondOrder = await secondCaptured;
      expect(secondOrder.idempotencyKey).toBeTruthy();
      expect(secondOrder.idempotencyKey).not.toBe(firstOrder.idempotencyKey);

      const attemptKey = 'flo.postpaid.order.attempt.user.e2e-owner';
      const persistedAttempt = await page.evaluate((key) => {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
      }, attemptKey);
      expect(persistedAttempt?.idempotencyKey).toBe(secondOrder.idempotencyKey);

      firstOrder.deliver();
      await firstDelivered;
      await expect(page.getByTestId('payment-ticket-confirmation-modal')).toHaveCount(0);
      await expect(page.getByTestId('cart-item')).toHaveCount(1);
      const stillPendingAttempt = await page.evaluate((key) => {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
      }, attemptKey);
      expect(stillPendingAttempt?.idempotencyKey).toBe(secondOrder.idempotencyKey);

      secondOrder.deliver();
      await secondDelivered;
      await expect(page.getByTestId('payment-ticket-confirmation-modal')).toBeVisible();
      await expect(page.getByTestId('cart-item')).toHaveCount(0);
      await page.unroute('**/api/orders');
    });

    await test.step('Send to payment stops before the request when both retry stores reject writes', async () => {
      await page.goto(`${BASE}/pos`);
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await page.evaluate(() => {
        const storageWindow = window as typeof window & {
          __originalStorageSetItem?: typeof Storage.prototype.setItem;
        };
        const original = Storage.prototype.setItem;
        storageWindow.__originalStorageSetItem = original;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith('flo.postpaid.order.attempt.')) {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          }
          return original.call(this, key, value);
        };
      });
      const orderPosts: string[] = [];
      const onOrderRequest = (request: import('@playwright/test').Request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/orders') {
          orderPosts.push(request.url());
        }
      };
      page.on('request', onOrderRequest);
      await page.getByTestId('pos-product-card').first().click();
      await page.getByTestId('pos-send-to-payment-btn').click();
      await expect(page.getByRole('status')).toContainText(
        'Order not saved because this device is blocking local storage.',
      );
      await expect(page.getByTestId('cart-item')).toHaveCount(1);
      expect(orderPosts, 'storage failure prevents an unretryable order request').toHaveLength(0);
      page.off('request', onOrderRequest);
      await page.evaluate(() => {
        const storageWindow = window as typeof window & {
          __originalStorageSetItem?: typeof Storage.prototype.setItem;
        };
        if (storageWindow.__originalStorageSetItem) {
          Storage.prototype.setItem = storageWindow.__originalStorageSetItem;
          delete storageWindow.__originalStorageSetItem;
        }
      });
      await page.getByTestId('cart-shell').locator('button[aria-label="Remove"]').first().click();
      await expect(page.getByTestId('cart-item')).toHaveCount(0);
    });

    await test.step('A successful ticket with unreadable retry state opens the payment queue', async () => {
      await page.goto(`${BASE}/pos`);
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await setLanguage(page, 'en');

      const attemptKey = 'flo.postpaid.order.attempt.user.e2e-owner';
      let orderNumber = '';
      await page.route('**/api/orders', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || url.pathname !== '/api/orders') {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const payload = await response.json();
        expect(response.status()).toBe(201);
        createdOrderIds.add(Number(payload.order.id));
        orderNumber = String(payload.order.order_number);
        await page.evaluate((key) => {
          const storageWindow = window as typeof window & {
            __originalStorageGetItem?: typeof Storage.prototype.getItem;
          };
          const original = Storage.prototype.getItem;
          storageWindow.__originalStorageGetItem = original;
          Storage.prototype.getItem = function (candidate: string) {
            if (candidate === key) {
              throw new DOMException('The order retry state cannot be read.', 'SecurityError');
            }
            return original.call(this, candidate);
          };
        }, attemptKey);
        await route.fulfill({ response });
      });

      try {
        await page.getByTestId('pos-product-card').first().click();
        await page.getByTestId('pos-send-to-payment-btn').click();
        await expect(page.getByTestId('payment-queue-drawer')).toBeVisible();
        await expect(page.getByTestId(`queue-ticket-${orderNumber}`)).toBeVisible();
        await expect(page.getByTestId('payment-ticket-confirmation-modal')).toHaveCount(0);
        await expect(page.getByTestId('cart-item')).toHaveCount(1);
        await expect(
          page.getByText('Open Orders to confirm the sale. Do not create it again.'),
        ).toBeVisible();
      } finally {
        await page.evaluate(() => {
          const storageWindow = window as typeof window & {
            __originalStorageGetItem?: typeof Storage.prototype.getItem;
          };
          if (storageWindow.__originalStorageGetItem) {
            Storage.prototype.getItem = storageWindow.__originalStorageGetItem;
            delete storageWindow.__originalStorageGetItem;
          }
        });
        await page.unroute('**/api/orders');
      }

      await page.getByTestId('close-queue-drawer-btn').click();
      await page.getByTestId('cart-shell').locator('button[aria-label="Remove"]').first().click();
      await expect(page.getByTestId('cart-item')).toHaveCount(0);
      await page.evaluate((key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }, attemptKey);
    });

    await test.step('A confirmed ticket with failed retry cleanup is not replayed as a new ticket', async () => {
      await page.goto(`${BASE}/pos`);
      const counterSelect = page.getByTestId('pos-counter-selector-btn');
      await counterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await page.evaluate(() => {
        const storageWindow = window as typeof window & {
          __originalStorageSetItem?: typeof Storage.prototype.setItem;
          __originalStorageRemoveItem?: typeof Storage.prototype.removeItem;
        };
        const originalSetItem = Storage.prototype.setItem;
        const originalRemoveItem = Storage.prototype.removeItem;
        storageWindow.__originalStorageSetItem = originalSetItem;
        storageWindow.__originalStorageRemoveItem = originalRemoveItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith('flo.postpaid.order.attempt.') && value.includes('"completed":true')) {
            throw new DOMException(
              'The completion marker could not be stored.',
              'QuotaExceededError',
            );
          }
          return originalSetItem.call(this, key, value);
        };
        Storage.prototype.removeItem = function (key: string) {
          if (key.startsWith('flo.postpaid.order.attempt.')) {
            throw new DOMException('The order attempt could not be removed.', 'QuotaExceededError');
          }
          return originalRemoveItem.call(this, key);
        };
      });

      const orderPosts: string[] = [];
      await page.route('**/api/orders', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || url.pathname !== '/api/orders') {
          await route.continue();
          return;
        }
        orderPosts.push(route.request().headers()['idempotency-key'] || '');
        const response = await route.fetch();
        const payload = await response.json();
        expect(response.status()).toBe(201);
        createdOrderIds.add(Number(payload.order.id));
        await route.fulfill({ response });
      });

      await page.getByTestId('pos-product-card').first().click();
      await page.getByTestId('pos-send-to-payment-btn').click();
      await expect(page.getByTestId('payment-ticket-confirmation-modal')).toBeVisible();
      const attemptKey = 'flo.postpaid.order.attempt.user.e2e-owner';
      const persistedAttempt = await page.evaluate((key) => {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
      }, attemptKey);
      expect(persistedAttempt?.order?.id).toBeTruthy();
      expect(orderPosts).toHaveLength(1);

      await page.evaluate(() => {
        const storageWindow = window as typeof window & {
          __originalStorageSetItem?: typeof Storage.prototype.setItem;
          __originalStorageRemoveItem?: typeof Storage.prototype.removeItem;
        };
        if (storageWindow.__originalStorageSetItem) {
          Storage.prototype.setItem = storageWindow.__originalStorageSetItem;
          delete storageWindow.__originalStorageSetItem;
        }
        if (storageWindow.__originalStorageRemoveItem) {
          Storage.prototype.removeItem = storageWindow.__originalStorageRemoveItem;
          delete storageWindow.__originalStorageRemoveItem;
        }
      });
      await page.goto(`${BASE}/pos`);
      const reloadedCounterSelect = page.getByTestId('pos-counter-selector-btn');
      await reloadedCounterSelect.click();
      await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();
      await page.getByTestId('pos-product-card').first().click();
      await page.getByTestId('pos-send-to-payment-btn').click();
      await expect(
        page
          .getByText(
            'The sale is complete, but this device could not clear local retry or held-order state.',
          )
          .last(),
      ).toBeVisible();
      expect(orderPosts, 'a confirmed attempt is never submitted a second time').toHaveLength(1);

      await page.unroute('**/api/orders');
      await page.getByTestId('cart-shell').locator('button[aria-label="Remove"]').first().click();
      await page.evaluate((key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }, attemptKey);
    });

    await test.step('Existing scheduled orders append on ordering and combined counters', async () => {
      const scheduledFor = futureBangkokWallClock(60);
      const createAppendTarget = async () => {
        const response = await request.post(`${BASE}/api/orders`, {
          headers: ownerHeaders,
          data: {
            type: 'takeaway',
            dispatch_policy: 'on_payment',
            scheduled_for: scheduledFor,
            items: [{ product_id: 'e2e-product', quantity: 1 }],
          },
        });
        const responseBody = await response.json();
        expect(response.status(), JSON.stringify(responseBody)).toBe(201);
        const order = responseBody.order;
        createdOrderIds.add(Number(order.id));
        return order;
      };

      const appendWithCounter = async (counterId: string, useKeyboard: boolean) => {
        const order = await createAppendTarget();
        await page.goto(`${BASE}/pos`);
        const counterSelect = page.getByTestId('pos-counter-selector-btn');
        await counterSelect.click();
        await page.getByTestId(`pos-counter-option-${counterId}`).click();
        await page.getByTestId('pos-scheduled-orders-btn').click();
        const drawer = page.getByTestId('scheduled-orders-drawer');
        await expect(drawer).toBeVisible();
        await drawer
          .getByTestId(`scheduled-order-card-${order.id}`)
          .getByTestId(`scheduled-add-items-btn-${order.id}`)
          .click();
        await page.getByTestId('pos-product-card').first().click();
        const appendResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === 'POST' &&
            url.pathname === `/api/orders/${order.id}/items`
          );
        });
        await expect(page.getByTestId('pos-append-existing-order-btn')).toBeVisible();
        if (useKeyboard) {
          await page.locator('body').click({ position: { x: 8, y: 8 } });
          await page.keyboard.press('Space');
        } else {
          await page.getByTestId('pos-append-existing-order-btn').click();
        }
        const response = await appendResponse;
        expect(response.status()).toBe(200);
        const appendedOrder = (await response.json()).order;
        expect(Number(appendedOrder.id)).toBe(Number(order.id));
        expect(appendedOrder.order_number).toBe(order.order_number);
        expect(appendedOrder.dispatch_policy).toBe('on_payment');
        expect(new Date(appendedOrder.scheduled_for).toISOString()).toBe(
          new Date(order.scheduled_for).toISOString(),
        );
        expect(appendedOrder.items).toHaveLength(2);
      };

      await appendWithCounter(orderingCounter.id, false);
      await appendWithCounter(combinedCounter.id, true);
    });

    // -------------------------------------------------------------------------
    // Scenario 5: Dine-in table occupancy preserved through prepayment lifecycle
    // -------------------------------------------------------------------------
    await test.step('Scenario 5: Dine-in table occupancy is preserved through multi-counter prepayment', async () => {
      // Create a dine-in table
      const tableRes = await request.post(`${BASE}/api/tables`, {
        headers: ownerHeaders,
        data: {
          number: `MC-${runId}`,
          capacity: 4,
        },
      });
      expect(tableRes.ok()).toBeTruthy();
      createdTable = (await tableRes.json()).table;

      // Create dine-in on_payment order
      const dineInOrderRes = await request.post(`${BASE}/api/orders`, {
        headers: ownerHeaders,
        data: {
          type: 'dine_in',
          table_id: createdTable.id,
          dispatch_policy: 'on_payment',
          items: [{ product_id: 'e2e-product', quantity: 2 }],
        },
      });
      expect(dineInOrderRes.ok()).toBeTruthy();
      const dineInOrder = (await dineInOrderRes.json()).order;
      dineInOrderId = dineInOrder.id;
      createdOrderIds.add(Number(dineInOrderId));

      // Table is occupied
      const tableAfterOrderRes = await request.get(`${BASE}/api/tables/${createdTable.id}`, {
        headers: ownerHeaders,
      });
      const tableAfterOrder = (await tableAfterOrderRes.json()).table;
      expect(tableAfterOrder.status).toBe('occupied');

      // Fetch bill and pay in full
      const billRes = await request.get(`${BASE}/api/bills/order/${dineInOrder.id}`, {
        headers: ownerHeaders,
      });
      expect(billRes.ok()).toBeTruthy();
      const dineInBill = (await billRes.json()).bill;

      const payDineInRes = await request.post(`${BASE}/api/bills/${dineInBill.id}/payment`, {
        headers: ownerHeaders,
        data: {
          method: 'cash',
          amount: Number(dineInBill.total),
        },
      });
      expect(payDineInRes.ok()).toBeTruthy();

      // Order is released, checkout_stage is paid
      const orderAfterPayRes = await request.get(`${BASE}/api/orders/${dineInOrder.id}`, {
        headers: ownerHeaders,
      });
      const orderAfterPay = (await orderAfterPayRes.json()).order;
      expect(orderAfterPay.checkout_stage).toBe('paid');
      expect(orderAfterPay.release_status).toBe('released');
      expect(orderAfterPay.status).toBe('pending'); // Kitchen still working!

      // Invariant: Table remains OCCUPIED after prepayment settlement!
      const tableAfterPayRes = await request.get(`${BASE}/api/tables/${createdTable.id}`, {
        headers: ownerHeaders,
      });
      const tableAfterPay = (await tableAfterPayRes.json()).table;
      expect(tableAfterPay.status).toBe('occupied');

      const servedRes = await request.patch(
        `${BASE}/api/order-items/${dineInOrder.items[0].id}/status`,
        { headers: ownerHeaders, data: { status: 'served' } },
      );
      expect(servedRes.ok(), 'serve the settled dine-in order item').toBeTruthy();
      const orderAfterServedRes = await request.get(`${BASE}/api/orders/${dineInOrder.id}`, {
        headers: ownerHeaders,
      });
      expect(orderAfterServedRes.ok()).toBeTruthy();
      expect((await orderAfterServedRes.json()).order.status).toBe('served');
      const tableAfterServedRes = await request.get(`${BASE}/api/tables/${createdTable.id}`, {
        headers: ownerHeaders,
      });
      expect(tableAfterServedRes.ok()).toBeTruthy();
      expect((await tableAfterServedRes.json()).table.status).toBe('occupied');
    });

    // -------------------------------------------------------------------------
    // Scenario 6: Adversarial release gates and prepayment edit-lock enforcement
    // -------------------------------------------------------------------------
    await test.step('Scenario 6: Adversarial release gates block unpaid orders and edit lock prevents modifying paid orders', async () => {
      // 1. Delivery order with dispatch_policy: on_payment rejected
      const deliveryRes = await request.post(`${BASE}/api/orders`, {
        headers: ownerHeaders,
        data: {
          type: 'delivery',
          dispatch_policy: 'on_payment',
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(deliveryRes.status()).toBe(400);

      // 2. Manual release of unpaid on_payment order rejected 409
      const advOrderRes = await request.post(`${BASE}/api/orders`, {
        headers: ownerHeaders,
        data: {
          type: 'takeaway',
          dispatch_policy: 'on_payment',
          items: [{ product_id: 'e2e-product', quantity: 2 }],
        },
      });
      expect(advOrderRes.ok()).toBeTruthy();
      const advOrder = (await advOrderRes.json()).order;
      createdOrderIds.add(Number(advOrder.id));

      const manualReleaseRes = await request.post(`${BASE}/api/orders/${advOrder.id}/release`, {
        headers: ownerHeaders,
      });
      expect(manualReleaseRes.status()).toBe(409);
      const releaseErr = await manualReleaseRes.json();
      expect(releaseErr.code).toBe('ORDER_NOT_PAID');

      // 3. Record partial payment on the bill
      const billRes = await request.get(`${BASE}/api/bills/order/${advOrder.id}`, {
        headers: ownerHeaders,
      });
      const advBill = (await billRes.json()).bill;

      const partialPayRes = await request.post(`${BASE}/api/bills/${advBill.id}/payment`, {
        headers: ownerHeaders,
        data: {
          method: 'cash',
          amount: Math.floor(Number(advBill.total) / 2),
        },
      });
      expect(partialPayRes.ok()).toBeTruthy();

      // 4. Edits to items rejected with 409 SCHEDULED_ORDER_PAID once payment recorded
      const editItemRes = await request.post(`${BASE}/api/orders/${advOrder.id}/items`, {
        headers: ownerHeaders,
        data: {
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(editItemRes.status()).toBe(409);
      const editErr = await editItemRes.json();
      expect(editErr.code).toBe('SCHEDULED_ORDER_PAID');

      // 5. Discount edit rejected with 409 SCHEDULED_ORDER_PAID
      const discountRes = await request.patch(`${BASE}/api/orders/${advOrder.id}/discount`, {
        headers: ownerHeaders,
        data: {
          discount_type: 'flat',
          discount_value: 10,
          discount_reason: 'Test discount',
        },
      });
      expect(discountRes.status()).toBe(409);
      const discountErr = await discountRes.json();
      expect(discountErr.code).toBe('SCHEDULED_ORDER_PAID');
    });

    // -------------------------------------------------------------------------
    // Scenario 7: Adversarial stock shortfall leaves paid-but-blocked ticket with retry
    // -------------------------------------------------------------------------
    await test.step('Scenario 7: Stock shortfall during prepayment creates paid-but-blocked ticket with explicit retry', async () => {
      // 1. Create product with tracked inventory, stock = 1
      const prodRes = await request.post(`${BASE}/api/products`, {
        headers: ownerHeaders,
        data: {
          category_id: 'e2e-category',
          name: `Limited Pie ${runId}`,
          price: 150,
          track_inventory: 1,
          stock_quantity: 1,
        },
      });
      expect(prodRes.ok()).toBeTruthy();
      limitedProduct = (await prodRes.json()).product;

      // 2. Create on_payment order for 1 unit
      const stockOrderRes = await request.post(`${BASE}/api/orders`, {
        headers: ownerHeaders,
        data: {
          type: 'takeaway',
          dispatch_policy: 'on_payment',
          items: [{ product_id: limitedProduct.id, quantity: 1 }],
        },
      });
      expect(stockOrderRes.ok()).toBeTruthy();
      const stockOrder = (await stockOrderRes.json()).order;
      createdOrderIds.add(Number(stockOrder.id));

      // 3. Stock depleted to 0 before customer pays
      const adjustRes = await request.post(`${BASE}/api/products/${limitedProduct.id}/stock`, {
        headers: ownerHeaders,
        data: {
          action: 'set',
          quantity: 0,
          reason: 'Depleted by parallel purchase',
        },
      });
      expect(adjustRes.ok()).toBeTruthy();

      // 4. Customer tenders payment in full
      const billRes = await request.get(`${BASE}/api/bills/order/${stockOrder.id}`, {
        headers: ownerHeaders,
      });
      const stockBill = (await billRes.json()).bill;

      const payRes = await request.post(`${BASE}/api/bills/${stockBill.id}/payment`, {
        headers: ownerHeaders,
        data: {
          method: 'cash',
          amount: Number(stockBill.total),
        },
      });
      expect(payRes.ok()).toBeTruthy();

      // 5. Payment is ACCEPTED, but release is BLOCKED
      const verifyOrderRes = await request.get(`${BASE}/api/orders/${stockOrder.id}`, {
        headers: ownerHeaders,
      });
      const blockedOrder = (await verifyOrderRes.json()).order;
      expect(blockedOrder.checkout_stage).toBe('paid');
      expect(blockedOrder.release_status).toBe('blocked');
      expect(blockedOrder.release_blocked_reason).toContain('Insufficient stock');

      // 6. View in UI: Topbar shows blocked badge, drawer shows Paid but Blocked section
      await page.goto(`${BASE}/pos`);
      const queueBtn = page.getByTestId('pos-payment-queue-btn');
      await expect(queueBtn).toBeVisible();
      await queueBtn.click();

      const queueDrawer = page.getByTestId('payment-queue-drawer');
      await expect(queueDrawer).toBeVisible();

      // Blocked section and badge are visible
      await expect(page.getByTestId('payment-queue-section-blocked')).toBeVisible();
      await expect(
        page.getByTestId(`payment-queue-blocked-badge-${blockedOrder.id}`),
      ).toBeVisible();

      await captureScreenshot(page, '08-paid-but-blocked-queue-view.png');

      const queuePattern = '**/api/orders/awaiting-payment*';
      const releasePattern = `**/api/orders/${blockedOrder.id}/release`;
      await page.route(queuePattern, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.orders = body.orders.map((order: { id: number; release_blocked_reason?: string }) =>
          order.id === blockedOrder.id ? { ...order, release_blocked_reason: 'refunded' } : order,
        );
        await route.fulfill({ response, json: body });
      });
      await page.route(releasePattern, async (route) => {
        await route.fulfill({ status: 409, json: { code: 'RELEASE_BLOCKED', error: 'refunded' } });
      });
      await page.reload();
      await queueBtn.click();
      await expect(
        page.getByTestId(`payment-queue-blocked-reason-${blockedOrder.id}`),
      ).toContainText('Refunded. Cancel Order.');
      await page.getByTestId(`retry-release-btn-${blockedOrder.id}`).click();
      await expect(page.getByText('Refunded. Cancel Order.', { exact: true })).toHaveCount(2);
      await page.unroute(queuePattern);
      await page.unroute(releasePattern);
      await page.getByTestId('close-queue-drawer-btn').click();
      await queueBtn.click();
      await expect(
        page.getByTestId(`payment-queue-blocked-reason-${blockedOrder.id}`),
      ).toContainText('Insufficient stock');

      // 7. Manual retry fails while stock is still 0
      const retryFailRes = await request.post(`${BASE}/api/orders/${blockedOrder.id}/release`, {
        headers: ownerHeaders,
      });
      expect(retryFailRes.status()).toBe(409);
      const retryFailErr = await retryFailRes.json();
      expect(retryFailErr.code).toBe('RELEASE_BLOCKED');

      // 8. Restock product to 5 units
      const restockRes = await request.post(`${BASE}/api/products/${limitedProduct.id}/stock`, {
        headers: ownerHeaders,
        data: {
          action: 'set',
          quantity: 5,
          reason: 'Emergency restock',
        },
      });
      expect(restockRes.ok()).toBeTruthy();

      // 9. Retry release button in queue drawer succeeds!
      const retryBtn = page.getByTestId(`retry-release-btn-${blockedOrder.id}`);
      await expect(retryBtn).toBeVisible();
      await retryBtn.click();

      // Order transitions to released!
      await expect(page.getByTestId(`payment-queue-blocked-badge-${blockedOrder.id}`)).toHaveCount(
        0,
        {
          timeout: 10_000,
        },
      );

      const releasedOrderRes = await request.get(`${BASE}/api/orders/${blockedOrder.id}`, {
        headers: ownerHeaders,
      });
      const releasedOrder = (await releasedOrderRes.json()).order;
      expect(releasedOrder.release_status).toBe('released');

      // Close drawer
      const closeDrawerBtn = page.getByTestId('close-queue-drawer-btn');
      if (await closeDrawerBtn.isVisible()) {
        await closeDrawerBtn.click();
      }
    });
  } catch (error) {
    primaryTestError = error;
    hasPrimaryTestError = true;
  } finally {
    for (const orderId of createdOrderIds) {
      await attemptCleanup(`clean up order ${orderId}`, async () => {
        const orderRes = await request.get(`${BASE}/api/orders/${orderId}`, {
          headers: ownerHeaders,
        });
        expect(orderRes.ok(), `read order ${orderId} during cleanup`).toBeTruthy();
        let order = (await orderRes.json()).order;
        if (order.status === 'completed' || order.status === 'cancelled') return;

        const billsRes = await request.get(`${BASE}/api/bills/order/${orderId}`, {
          headers: ownerHeaders,
        });
        expect(billsRes.ok(), `read bills for order ${orderId} during cleanup`).toBeTruthy();
        const billsBody = await billsRes.json();
        const bills = billsBody.bills || (billsBody.bill ? [billsBody.bill] : []);
        expect(bills.length, `order ${orderId} has cleanup bills`).toBeGreaterThan(0);

        let hasCollectedPayment = false;
        for (const billSummary of bills) {
          const billRes = await request.get(`${BASE}/api/bills/${billSummary.id}`, {
            headers: ownerHeaders,
          });
          expect(billRes.ok(), `read bill ${billSummary.id} during cleanup`).toBeTruthy();
          const bill = (await billRes.json()).bill;
          if (Number(bill.paid_amount) > 0 || bill.payment_status === 'paid') {
            hasCollectedPayment = true;
          }
        }

        if (!hasCollectedPayment) {
          const cancelRes = await request.patch(`${BASE}/api/orders/${orderId}/status`, {
            headers: ownerHeaders,
            data: { status: 'cancelled' },
          });
          expect(cancelRes.ok(), `cancel unpaid order ${orderId} during cleanup`).toBeTruthy();
          return;
        }

        for (const billSummary of bills) {
          const billRes = await request.get(`${BASE}/api/bills/${billSummary.id}`, {
            headers: ownerHeaders,
          });
          expect(billRes.ok(), `re-read bill ${billSummary.id} during cleanup`).toBeTruthy();
          const bill = (await billRes.json()).bill;
          if (Number(bill.balance) > 0) {
            const payRes = await request.post(`${BASE}/api/bills/${bill.id}/payment`, {
              headers: ownerHeaders,
              data: { method: 'cash', amount: Number(bill.balance) },
            });
            expect(payRes.ok(), `settle bill ${bill.id} during cleanup`).toBeTruthy();
          }
        }

        const refreshedOrderRes = await request.get(`${BASE}/api/orders/${orderId}`, {
          headers: ownerHeaders,
        });
        expect(refreshedOrderRes.ok()).toBeTruthy();
        order = (await refreshedOrderRes.json()).order;
        if (order.release_status === 'blocked') {
          expect(limitedProduct.id, 'blocked order has a tracked inventory fixture').toBeTruthy();
          const restockRes = await request.post(`${BASE}/api/products/${limitedProduct.id}/stock`, {
            headers: ownerHeaders,
            data: {
              action: 'set',
              quantity: 5,
              reason: 'Restore blocked order stock during cleanup',
            },
          });
          expect(restockRes.ok(), 'restore blocked order stock during cleanup').toBeTruthy();
        }
        if (order.checkout_stage === 'paid' && order.release_status !== 'released') {
          const releaseRes = await request.post(`${BASE}/api/orders/${orderId}/release`, {
            headers: ownerHeaders,
          });
          expect(releaseRes.ok(), `release paid order ${orderId} during cleanup`).toBeTruthy();
        }

        const releasedOrderRes = await request.get(`${BASE}/api/orders/${orderId}`, {
          headers: ownerHeaders,
        });
        expect(releasedOrderRes.ok()).toBeTruthy();
        order = (await releasedOrderRes.json()).order;
        for (const item of order.items || []) {
          if (['served', 'completed', 'cancelled'].includes(item.status)) continue;
          const servedRes = await request.patch(`${BASE}/api/order-items/${item.id}/status`, {
            headers: ownerHeaders,
            data: { status: 'served' },
          });
          expect(servedRes.ok(), `serve order item ${item.id} during cleanup`).toBeTruthy();
        }
        const completeRes = await request.patch(`${BASE}/api/orders/${orderId}/status`, {
          headers: ownerHeaders,
          data: { status: 'completed' },
        });
        expect(completeRes.ok(), `complete order ${orderId} during cleanup`).toBeTruthy();
      });
    }

    if (orderingCounter.id) {
      await attemptCleanup('delete ordering counter', async () => {
        const result = await request.delete(`${BASE}/api/counters/${orderingCounter.id}`, {
          headers: ownerHeaders,
        });
        expect(result.ok(), 'delete ordering counter during cleanup').toBeTruthy();
      });
    }
    if (paymentCounter.id) {
      await attemptCleanup('delete payment counter', async () => {
        const result = await request.delete(`${BASE}/api/counters/${paymentCounter.id}`, {
          headers: ownerHeaders,
        });
        expect(result.ok(), 'delete payment counter during cleanup').toBeTruthy();
      });
    }
    if (combinedCounter.id) {
      await attemptCleanup('delete combined counter', async () => {
        const result = await request.delete(`${BASE}/api/counters/${combinedCounter.id}`, {
          headers: ownerHeaders,
        });
        expect(result.ok(), 'delete combined counter during cleanup').toBeTruthy();
      });
    }
    if (createdTable.id > 0) {
      await attemptCleanup('deactivate test table', async () => {
        const result = await request.post(`${BASE}/api/tables/${createdTable.id}/deactivate`, {
          headers: ownerHeaders,
        });
        expect(result.ok(), 'deactivate table during cleanup').toBeTruthy();
      });
    }
    if (limitedProduct.id) {
      await attemptCleanup('delete limited product', async () => {
        const result = await request.delete(`${BASE}/api/products/${limitedProduct.id}`, {
          headers: ownerHeaders,
        });
        expect(result.ok(), 'delete limited product during cleanup').toBeTruthy();
      });
    }
    if (previousMultiCounterEnabled !== undefined) {
      await attemptCleanup('restore prior multi-counter setting', async () => {
        const result = await request.put(`${BASE}/api/settings/multi_counter_enabled`, {
          headers: ownerHeaders,
          data: { value: previousMultiCounterEnabled },
        });
        expect(result.ok(), 'restore prior multi-counter setting').toBeTruthy();
      });
    }
    if (previousTimezone !== undefined) {
      await attemptCleanup('restore prior store timezone', async () => {
        const result = await request.put(`${BASE}/api/settings/timezone`, {
          headers: ownerHeaders,
          data: { value: previousTimezone },
        });
        expect(result.ok(), 'restore prior store timezone').toBeTruthy();
      });
    }
    if (previousBillingType !== undefined && previousTablesRequired !== undefined) {
      await attemptCleanup('restore prior billing settings', async () => {
        const result = await request.put(`${BASE}/api/settings/business`, {
          headers: ownerHeaders,
          data: {
            billing_type: previousBillingType,
            tables_required: previousTablesRequired,
          },
        });
        expect(result.ok(), 'restore prior billing settings').toBeTruthy();
      });
    }
  }

  if (hasPrimaryTestError) {
    if (cleanupErrors.length > 0) {
      console.error('Test fixture cleanup also failed:', cleanupErrors);
    }
    throw primaryTestError;
  }
  expect(cleanupErrors, 'all multi-counter test fixtures and settings are restored').toEqual([]);
});

test('payment queue keeps loaded pages during automatic refresh', async ({ page, request }) => {
  await page.clock.install();
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const headers = { Authorization: `Bearer ${ownerToken}` };
  const previousRes = await request.get(`${BASE}/api/settings/multi_counter_enabled`, { headers });
  const previousValue = (await previousRes.json()).setting.value;
  try {
    const enabled = await request.put(`${BASE}/api/settings/multi_counter_enabled`, {
      headers,
      data: { value: 'true' },
    });
    expect(enabled.ok()).toBeTruthy();
    await page.route('**/api/orders/awaiting-payment*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      const ids = cursor ? [51] : Array.from({ length: 50 }, (_, index) => index + 1);
      await route.fulfill({
        json: {
          orders: ids.map((id) => ({
            id,
            order_number: `QUEUE-${id}`,
            type: 'takeaway',
            checkout_stage: 'awaiting_payment',
            release_status: 'scheduled',
            ticket_balance: 100,
            ticket_paid_amount: 0,
            created_at: '2026-01-01 12:00:00',
          })),
          next_cursor: cursor ? null : 'next',
          has_more: !cursor,
          awaiting_count: 51,
          blocked_count: 0,
        },
      });
    });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**');
    await setLanguage(page, 'en');
    await page.getByTestId('pos-payment-queue-btn').click();
    await expect(page.getByTestId('queue-ticket-QUEUE-50')).toBeVisible();
    await page.getByTestId('payment-queue-load-more').click();
    await expect(page.getByTestId('queue-ticket-QUEUE-51')).toBeVisible();
    await page.clock.fastForward(11000);
    await page.clock.runFor(100);
    await expect(page.getByTestId('queue-ticket-QUEUE-51')).toBeVisible();
  } finally {
    const restored = await request.put(`${BASE}/api/settings/multi_counter_enabled`, {
      headers,
      data: { value: previousValue },
    });
    expect(restored.ok()).toBeTruthy();
  }
});
