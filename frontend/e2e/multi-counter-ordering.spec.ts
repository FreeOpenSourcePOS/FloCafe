import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('Multi-counter ordering flow (create here, pay there) (#361)', async ({ page, request }) => {
  test.setTimeout(120_000);
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = {
    Authorization: `Bearer ${ownerToken}`,
    'Content-Type': 'application/json',
  };

  // 1. Enable multi_counter_enabled and configure counters via API
  const settingRes = await request.put(`${BASE}/api/settings/multi_counter_enabled`, {
    headers: ownerHeaders,
    data: { value: 'true' },
  });
  expect(settingRes.ok()).toBeTruthy();

  // Create an ordering counter and a payment counter
  const runId = Math.random().toString(36).slice(2, 6);
  const orderingCounterRes = await request.post(`${BASE}/api/counters`, {
    headers: ownerHeaders,
    data: {
      name: `Order Counter ${runId}`,
      role: 'ordering',
      sort_order: 1,
    },
  });
  expect(orderingCounterRes.ok()).toBeTruthy();
  const orderingCounter = (await orderingCounterRes.json()).counter;

  const paymentCounterRes = await request.post(`${BASE}/api/counters`, {
    headers: ownerHeaders,
    data: {
      name: `Pay Counter ${runId}`,
      role: 'payment',
      sort_order: 2,
    },
  });
  expect(paymentCounterRes.ok()).toBeTruthy();
  const paymentCounter = (await paymentCounterRes.json()).counter;

  try {
    // 2. Log in as owner and navigate to POS
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    // 3. Counter selection in Topbar
    const counterSelect = page.getByTestId('pos-counter-selector-btn');
    await expect(counterSelect).toBeVisible();

    // Select Ordering counter
    await counterSelect.click();
    await page.getByTestId(`pos-counter-option-${orderingCounter.id}`).click();

    // Add item to cart
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    const cartShell = page.getByTestId('cart-shell');

    // On ordering counter, "Send to payment" is the primary checkout action
    const sendToPaymentBtn = cartShell.getByTestId('pos-send-to-payment-btn');
    await expect(sendToPaymentBtn).toBeVisible();

    // Click "Send to payment"
    await sendToPaymentBtn.click();

    // Ticket confirmation modal should pop up
    const ticketModal = page.getByTestId('payment-ticket-confirmation-modal');
    await expect(ticketModal).toBeVisible();

    const ticketNumberEl = page.getByTestId('payment-ticket-number');
    await expect(ticketNumberEl).toBeVisible();
    const rawNumberText = (await ticketNumberEl.textContent())?.trim();
    // rawNumberText is e.g. "#ORD-001" or "#1"
    const orderNumber = rawNumberText?.replace(/^#/, '').trim();
    expect(orderNumber).toBeTruthy();

    // QR code image should be rendered
    const qrImage = page.getByTestId('payment-ticket-qr');
    await expect(qrImage).toBeVisible();

    // Print ticket button should be present
    const printTicketBtn = page.getByTestId('print-payment-ticket-btn');
    await expect(printTicketBtn).toBeVisible();

    // Click Done to close modal
    await page.getByTestId('payment-ticket-done-btn').click();
    await expect(ticketModal).toHaveCount(0);

    // Cart is now cleared
    await expect(page.getByTestId('cart-item')).toHaveCount(0);

    // 4. Switch to Payment counter
    await counterSelect.click();
    await page.getByTestId(`pos-counter-option-${paymentCounter.id}`).click();

    // Selecting payment counter opens the shared waiting queue automatically
    const queueDrawer = page.getByTestId('payment-queue-drawer');
    await expect(queueDrawer).toBeVisible();

    // Topbar queue button with badge should also be visible
    const queueBtn = page.getByTestId('pos-payment-queue-btn');
    await expect(queueBtn).toBeVisible();

    // Closing the queue drawer reveals payment-counter CTA in CartPanel
    const closeDrawerBtn = page.getByTestId('close-queue-drawer-btn');
    await closeDrawerBtn.click();
    await expect(queueDrawer).toHaveCount(0);

    const openQueueCartBtn = cartShell.getByTestId('pos-open-payment-queue-btn');
    await expect(openQueueCartBtn).toBeVisible();
    await openQueueCartBtn.click();
    await expect(queueDrawer).toBeVisible();

    // The created ticket should be visible in the queue
    const ticketRow = page.getByTestId(`queue-ticket-${orderNumber}`);
    await expect(ticketRow).toBeVisible();

    // Search filter in queue drawer
    const searchInput = page.getByTestId('payment-queue-search');
    await searchInput.fill(orderNumber!);
    await expect(ticketRow).toBeVisible();

    // Click Pay on the ticket
    const payBtn = ticketRow.getByTestId('queue-pay-btn');
    await payBtn.click();

    // PaymentModal opens
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible();
    await page.getByTitle('Cash', { exact: true }).click();
    await page.getByRole('button', { name: /^Pay [^A-Za-z]/ }).click();

    const confirmButton = page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Pay', exact: true });
    if (await confirmButton.count()) {
      await confirmButton.click();
    }

    const doneButton = page.getByRole('button', { name: 'Done' });
    await expect(doneButton).toBeVisible({ timeout: 10_000 });
    await doneButton.click();

    // PaymentModal should close once settled
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0, { timeout: 10_000 });

    // Verify close queue drawer button works
    const closeDrawerBtn = page.getByTestId('close-queue-drawer-btn');
    if (await closeDrawerBtn.isVisible()) {
      await closeDrawerBtn.click();
      await expect(queueDrawer).toHaveCount(0);
    }
  } finally {
    // Cleanup counters
    if (orderingCounter?.id) {
      await request.delete(`${BASE}/api/counters/${orderingCounter.id}`, {
        headers: ownerHeaders,
      });
    }
    if (paymentCounter?.id) {
      await request.delete(`${BASE}/api/counters/${paymentCounter.id}`, {
        headers: ownerHeaders,
      });
    }
  }
});
