import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('Orders page browser printing shows unpaid collection and settled payment details', async ({ page }) => {
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${token}` };
  const createDeliveryOrder = async (note: string) => {
    const response = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'delivery',
        special_instructions: note,
        delivery_address: '42 Delivery Lane',
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).order as { id: number; order_number: string; total: number };
  };

  const unpaidOrder = await createDeliveryOrder('Unpaid delivery note');
  const paidOrder = await createDeliveryOrder('Paid delivery note');
  const partialOrder = await createDeliveryOrder('Partial delivery note');
  const blockedOrder = await createDeliveryOrder('Blocked delivery note');
  const generateBill = async (orderId: number) => {
    const response = await page.request.post(`${BASE}/api/bills/generate`, {
      headers,
      data: { order_id: orderId },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).bill as { id: number; total: number };
  };
  const paidBill = await generateBill(paidOrder.id);
  const partialBill = await generateBill(partialOrder.id);

  await page.addInitScript(() => {
    const appWindow = window as Window & {
      __deliverySlipPrintHtml?: string;
      __deliverySlipPrintCount?: number;
      __deliverySlipPrintOpenCount?: number;
      __deliverySlipPrintCloseCount?: number;
      __deliverySlipPrintBlocked?: boolean;
    };
    appWindow.__deliverySlipPrintHtml = '';
    appWindow.__deliverySlipPrintCount = 0;
    appWindow.__deliverySlipPrintOpenCount = 0;
    appWindow.__deliverySlipPrintCloseCount = 0;
    window.open = (() => {
      appWindow.__deliverySlipPrintOpenCount = (appWindow.__deliverySlipPrintOpenCount ?? 0) + 1;
      if (appWindow.__deliverySlipPrintBlocked) return null;
      const printDocument = document.implementation.createHTMLDocument('Delivery slip');
      return {
        document: printDocument,
        print: () => {
          appWindow.__deliverySlipPrintHtml = printDocument.body.innerHTML;
          appWindow.__deliverySlipPrintCount = (appWindow.__deliverySlipPrintCount ?? 0) + 1;
        },
        close: () => {
          appWindow.__deliverySlipPrintCloseCount = (appWindow.__deliverySlipPrintCloseCount ?? 0) + 1;
        },
      } as unknown as Window;
    }) as typeof window.open;
  });

  let ordersSnapshot: { status: number; body: string } | undefined;
  await page.route('**/api/orders*', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/api/orders') {
      await route.continue();
      return;
    }
    if (ordersSnapshot) {
      await route.fulfill({ status: ordersSnapshot.status, contentType: 'application/json', body: ordersSnapshot.body });
      return;
    }
    const response = await route.fetch();
    ordersSnapshot = { status: response.status(), body: await response.text() };
    await route.fulfill({ response, body: ordersSnapshot.body });
  });

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.goto(`${BASE}/orders`);

  const blockedCard = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${blockedOrder.order_number}` }).first();
  await expect(blockedCard).toBeVisible();
  expect(ordersSnapshot?.body).toContain(paidOrder.order_number);
  const initialOrders = JSON.parse(ordersSnapshot?.body ?? '{}').orders as Array<{
    id: number;
    bill?: { payment_status?: string } | null;
  }>;
  expect(initialOrders.find((order) => order.id === paidOrder.id)?.bill?.payment_status).toBe('unpaid');

  const paymentResponse = await page.request.post(`${BASE}/api/bills/${paidBill.id}/payments`, {
    headers,
    data: { payments: [{ method: 'card', amount: paidBill.total }] },
  });
  expect(paymentResponse.ok()).toBeTruthy();
  expect((await paymentResponse.json()).bill.payment_status).toBe('paid');
  const partialAmount = Math.round(partialBill.total * 100 / 2) / 100;
  const partialPaymentResponse = await page.request.post(`${BASE}/api/bills/${partialBill.id}/payments`, {
    headers,
    data: { payments: [{ method: 'cash', amount: partialAmount }] },
  });
  expect(partialPaymentResponse.ok()).toBeTruthy();
  const partiallyPaidBill = (await partialPaymentResponse.json()).bill as { balance: number };
  expect(partiallyPaidBill.balance).toBeGreaterThan(0);

  const printOrder = async (orderId: number, orderNumber: string, expectedNote: string) => {
    const orderCard = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${orderNumber}` }).first();
    const paymentResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === `/api/printers/delivery-slip-payment/${orderId}`;
    });
    await expect(orderCard).toBeVisible();
    await orderCard.getByRole('button', { name: 'Delivery Slip' }).click();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __deliverySlipPrintHtml?: string }).__deliverySlipPrintHtml ?? ''
    ))).toContain(expectedNote);
    const html = await page.evaluate(() => (
      (window as Window & { __deliverySlipPrintHtml?: string }).__deliverySlipPrintHtml ?? ''
    ));
    const freshPaymentResponse = await paymentResponse;
    expect(freshPaymentResponse.ok()).toBeTruthy();
    return { html, payment: (await freshPaymentResponse.json()).payment };
  };

  const unpaid = await printOrder(unpaidOrder.id, unpaidOrder.order_number, 'Unpaid delivery note');
  expect(unpaid.html).toMatch(/TO COLLECT: [^<]+\(Cash on Delivery\)/);
  expect(unpaid.payment.status).toBe('unpaid');

  let releaseDelayedPayment!: () => void;
  let signalDelayedPayment!: () => void;
  const delayedPaymentReached = new Promise<void>((resolve) => { signalDelayedPayment = resolve; });
  await page.route(`${BASE}/api/printers/delivery-slip-payment/${paidOrder.id}`, async (route) => {
    signalDelayedPayment();
    await new Promise<void>((resolve) => { releaseDelayedPayment = resolve; });
    await route.continue();
  }, { times: 1 });
  const popupCountBeforePaidPrint = await page.evaluate(() => (
    (window as Window & { __deliverySlipPrintOpenCount?: number }).__deliverySlipPrintOpenCount ?? 0
  ));
  const paidPrint = printOrder(paidOrder.id, paidOrder.order_number, 'Paid delivery note');
  await delayedPaymentReached;
  expect(await page.evaluate(() => (
    (window as Window & { __deliverySlipPrintOpenCount?: number }).__deliverySlipPrintOpenCount ?? 0
  ))).toBe(popupCountBeforePaidPrint + 1);
  releaseDelayedPayment();
  const paid = await paidPrint;
  expect(paid.html).toContain('PAID: Card (Total:');
  expect(paid.html).toContain(`Amount Due: ${paid.payment.formattedAmountDue}`);
  expect(paid.html).not.toContain('TO COLLECT:');
  expect(paid.payment.status).toBe('paid');

  const partial = await printOrder(partialOrder.id, partialOrder.order_number, 'Partial delivery note');
  expect(partial.payment.amount).toBe(partiallyPaidBill.balance);
  expect(partial.html).toContain(`TO COLLECT: ${partial.payment.formattedAmount} (Cash on Delivery)`);

  const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };
  const serverHeaders = { Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}` };
  const serverUserResponse = await page.request.get(`${BASE}/api/authorization/users/e2e-server`, { headers: ownerHeaders });
  expect(serverUserResponse.ok()).toBeTruthy();
  const serverUser = await serverUserResponse.json();
  const restrictedPermissions = await page.request.put(`${BASE}/api/authorization/users/e2e-server`, {
    headers: ownerHeaders,
    data: {
      revision: serverUser.revision,
      overrides: [
        { permission_id: 'orders.read', effect: 'deny' },
        { permission_id: 'bills.read', effect: 'deny' },
      ],
    },
  });
  expect(restrictedPermissions.ok()).toBeTruthy();
  try {
    expect((await page.request.get(`${BASE}/api/orders/${paidOrder.id}`, { headers: serverHeaders })).status()).toBe(403);
    expect((await page.request.get(`${BASE}/api/bills/${paidBill.id}`, { headers: serverHeaders })).status()).toBe(403);
    const paymentSnapshot = await page.request.get(`${BASE}/api/printers/delivery-slip-payment/${paidOrder.id}`, { headers: serverHeaders });
    expect(paymentSnapshot.ok()).toBeTruthy();
    expect((await paymentSnapshot.json()).payment.status).toBe('paid');
  } finally {
    const latestUserResponse = await page.request.get(`${BASE}/api/authorization/users/e2e-server`, { headers: ownerHeaders });
    const latestUser = await latestUserResponse.json();
    const restoredPermissions = await page.request.put(`${BASE}/api/authorization/users/e2e-server`, {
      headers: ownerHeaders,
      data: { revision: latestUser.revision, overrides: serverUser.overrides },
    });
    expect(restoredPermissions.ok()).toBeTruthy();
  }

  const printCountBeforeFailure = await page.evaluate(() => (
    (window as Window & { __deliverySlipPrintCount?: number }).__deliverySlipPrintCount ?? 0
  ));
  const closeCountBeforeFailure = await page.evaluate(() => (
    (window as Window & { __deliverySlipPrintCloseCount?: number }).__deliverySlipPrintCloseCount ?? 0
  ));
  await page.route(`${BASE}/api/printers/delivery-slip-payment/${blockedOrder.id}`, (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'fresh payment unavailable' }),
  }), { times: 1 });
  const failedPaymentResponse = page.waitForResponse((response) => new URL(response.url()).pathname
    === `/api/printers/delivery-slip-payment/${blockedOrder.id}`);
  await blockedCard.getByRole('button', { name: 'Delivery Slip' }).click();
  expect((await failedPaymentResponse).status()).toBe(500);
  await expect(page.locator('.react-hot-toast, [role="status"]').first()).toBeVisible();
  expect(await page.evaluate(() => (
    (window as Window & { __deliverySlipPrintCount?: number }).__deliverySlipPrintCount ?? 0
  ))).toBe(printCountBeforeFailure);
  expect(await page.evaluate(() => (
    (window as Window & { __deliverySlipPrintCloseCount?: number }).__deliverySlipPrintCloseCount ?? 0
  ))).toBe(closeCountBeforeFailure + 1);

  let blockedPaymentRequests = 0;
  const blockedRequestListener = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname === `/api/printers/delivery-slip-payment/${unpaidOrder.id}`) blockedPaymentRequests += 1;
  };
  page.on('request', blockedRequestListener);
  await page.evaluate(() => {
    (window as Window & { __deliverySlipPrintBlocked?: boolean }).__deliverySlipPrintBlocked = true;
  });
  const unpaidCard = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${unpaidOrder.order_number}` }).first();
  await unpaidCard.getByRole('button', { name: 'Delivery Slip' }).click();
  await expect(page.getByText('Please allow popups to print')).toBeVisible();
  expect(blockedPaymentRequests).toBe(0);
  page.off('request', blockedRequestListener);
});
