import fs from 'fs';
import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

const DEFAULT_LOCAL_EVIDENCE =
  '/Users/gurkiratkhaira/.no-mistakes/evidence/01M64ZVACDJJ8WG82NMYQVDPS5';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  (fs.existsSync(DEFAULT_LOCAL_EVIDENCE)
    ? DEFAULT_LOCAL_EVIDENCE
    : path.join('/tmp', 'no-mistakes-evidence', '01M64ZVACDJJ8WG82NMYQVDPS5'));

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

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Owner configures multi-counter mode and manages named counters
    // -------------------------------------------------------------------------
    await test.step('Scenario 1: Owner configures multi-counter mode and manages named counters in settings', async () => {
      // Enable multi_counter_enabled
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

      // Primary checkout button should be "Send to payment"
      const sendToPaymentBtn = cartShell.getByTestId('pos-send-to-payment-btn');
      await expect(sendToPaymentBtn).toBeVisible();

      await captureScreenshot(page, '02-pos-ordering-counter-view.png');

      // Click "Send to payment"
      await sendToPaymentBtn.click();

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
      createdOrderId = ticketData.order.id;

      // Verify order is NOT released to KDS prematurely
      const kdsRes = await request.get(`${BASE}/api/kds/orders`, { headers: ownerHeaders });
      const kdsBody = await kdsRes.json();
      expect(kdsBody.orders?.some((o: { id: number }) => o.id === createdOrderId)).toBeFalsy();
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
  } finally {
    // Teardown: clean up counters, table, product, and restore multi_counter_enabled setting
    if (orderingCounter.id) {
      await request
        .delete(`${BASE}/api/counters/${orderingCounter.id}`, { headers: ownerHeaders })
        .catch(() => {});
    }
    if (paymentCounter.id) {
      await request
        .delete(`${BASE}/api/counters/${paymentCounter.id}`, { headers: ownerHeaders })
        .catch(() => {});
    }
    if (combinedCounter.id) {
      await request
        .delete(`${BASE}/api/counters/${combinedCounter.id}`, { headers: ownerHeaders })
        .catch(() => {});
    }
    if (dineInOrderId > 0) {
      await request
        .patch(`${BASE}/api/orders/${dineInOrderId}/status`, {
          headers: ownerHeaders,
          data: { status: 'completed' },
        })
        .catch(() => {});
    }
    if (createdTable.id > 0) {
      await request
        .post(`${BASE}/api/tables/${createdTable.id}/deactivate`, { headers: ownerHeaders })
        .catch(() => {});
    }
    if (limitedProduct.id) {
      await request
        .delete(`${BASE}/api/products/${limitedProduct.id}`, { headers: ownerHeaders })
        .catch(() => {});
    }
    await request
      .put(`${BASE}/api/settings/multi_counter_enabled`, {
        headers: ownerHeaders,
        data: { value: 'false' },
      })
      .catch(() => {});
  }
});
