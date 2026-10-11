import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setLanguage,
  setOrdersLayout,
  type E2EOrdersLayout,
} from './helpers/test-auth';

const MANAGER_TOKEN = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
let originalOrdersLayout: E2EOrdersLayout | null = null;

test.afterEach(async ({ page }) => {
  if (!originalOrdersLayout) return;
  await setOrdersLayout(page, originalOrdersLayout, BASE, MANAGER_TOKEN);
  originalOrdersLayout = null;
});

async function loginAndOpenPos(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

async function addOneProduct(page: Page): Promise<void> {
  await page.getByTestId('pos-product-card').click();
  const addToCart = page.getByRole('button', { name: /Add to Cart/ });
  if (await addToCart.count()) await addToCart.click();
}

async function setBillingType(
  page: Page,
  billingType: 'prepaid' | 'postpaid',
): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${BASE}/api/settings/business`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
  });
  expect(response.ok()).toBeTruthy();
  const original = await response.json();
  const updated = await page.request.put(`${BASE}/api/settings/business`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    data: { ...original, billing_type: billingType },
  });
  expect(updated.ok()).toBeTruthy();
  return original;
}

async function restoreBusiness(page: Page, original: Record<string, unknown>): Promise<void> {
  const response = await page.request.put(`${BASE}/api/settings/business`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    data: original,
  });
  expect(response.ok()).toBeTruthy();
}

test('a structured quantity rejection keeps its specific message without a duplicate client capture', async ({
  page,
}) => {
  const originalBusiness = await setBillingType(page, 'postpaid');
  try {
    await loginAndOpenPos(page);
    const captures: unknown[] = [];
    const operationPosts: string[] = [];
    const supportSubmissions: Array<Record<string, unknown>> = [];
    let firstSupportAttempt = true;
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/diagnostics/capture') captures.push(request.postDataJSON());
      if (path === '/api/diagnostics/event') operationPosts.push(path);
    });
    await page.route('**/api/support-ticket', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      supportSubmissions.push(payload);
      if (firstSupportAttempt) {
        firstSupportAttempt = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'temporary failure' }),
        });
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ client_ticket_id: payload.client_ticket_id }),
      });
    });
    let originalOperationId = '';
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const operationId = route.request().headers()['x-operation-id'];
      originalOperationId = operationId || '';
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Invalid order quantity',
          reason_code: 'order.quantity_invalid',
          operation: 'order.create',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          correlation_id: operationId,
        }),
      });
    });

    await addOneProduct(page);
    await page.getByRole('button', { name: 'Place Order' }).click();

    await expect(
      page
        .getByRole('main')
        .getByText('Order not created. Check the item quantity.', { exact: true }),
    ).toBeVisible();
    expect(
      captures,
      'the structured backend response is displayed without a second capture',
    ).toHaveLength(0);
    expect(
      operationPosts,
      'cashier UI does not post backend-owned errors as legacy diagnostics',
    ).toHaveLength(0);

    const getHelp = page.getByRole('button', { name: 'Get help', exact: true });
    await getHelp.click();
    await expect(
      page.getByText('Could not queue the support request', { exact: true }),
    ).toBeVisible();
    await getHelp.evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect
      .poll(() => supportSubmissions.length, {
        message: 'the inline help handler blocks rapid duplicate submits',
      })
      .toBe(2);
    expect(
      supportSubmissions[0].correlation_id,
      'help retains the original order operation reference',
    ).toBe(originalOperationId);
    expect(supportSubmissions[0].client_ticket_id).not.toBe(originalOperationId);
    expect(supportSubmissions[0].operation_failure).toEqual({
      capture_point: 'fc.backend.order.create.quantity_validation',
      operation_id: originalOperationId,
      outcome: 'not_applied',
    });
    expect(supportSubmissions[1]).toEqual(supportSubmissions[0]);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('a lost prepaid payment response replays the same saved request after bill recovery', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const originalBusiness = await setBillingType(page, 'prepaid');
  try {
    const paymentRequests: Array<{
      operationId: string | undefined;
      idempotencyKey: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    const captures: Array<Record<string, unknown>> = [];
    const recoveryBills: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/bills\/[^/]+\/payments$/.test(new URL(request.url()).pathname)
      ) {
        paymentRequests.push({
          operationId: request.headers()['x-operation-id'],
          idempotencyKey: request.headers()['idempotency-key'],
          body: request.postDataJSON() as Record<string, unknown>,
        });
      }
    });
    page.on('response', async (response) => {
      if (
        response.request().method() !== 'GET' ||
        !/\/api\/bills\/[^/]+$/.test(new URL(response.url()).pathname)
      )
        return;
      try {
        const body = await response.json();
        if (body?.bill) recoveryBills.push(body.bill as Record<string, unknown>);
      } catch {
        /* ignore unrelated/empty bill responses */
      }
    });
    await page.route('**/api/diagnostics/capture', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      captures.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ captured: true }),
      });
    });
    let loseReply = true;
    await page.route('**/api/bills/*/payments', async (route) => {
      if (route.request().method() !== 'POST' || !loseReply) {
        await route.continue();
        return;
      }
      loseReply = false;
      const response = await route.fetch();
      expect(
        response.ok(),
        'the payment reaches the backend before the response is lost',
      ).toBeTruthy();
      const committed = await response.json();
      const payments = committed?.bill?.payment_details;
      expect(
        Array.isArray(payments) ? payments : JSON.parse(String(payments || '[]')),
        'the real backend committed exactly one payment before the browser loses the response',
      ).toHaveLength(1);
      await route.abort('timedout');
    });

    await loginAndOpenPos(page);
    await addOneProduct(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: /^Tax / })).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await page.getByRole('button', { name: /Confirm Payment/ }).click();

    await expect(
      page
        .getByRole('main')
        .getByText('FloCafe could not confirm whether the order or payment was saved.', {
          exact: true,
        }),
    ).toBeVisible();
    expect(paymentRequests).toHaveLength(1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      capture_point: 'fc.frontend.pos.payment.create.transport',
      outcome: 'unknown',
      facts: { failure_class: 'timeout' },
    });
    expect(captures[0].operation_id).toBe(paymentRequests[0].operationId);

    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: /^Tax / })).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await page.getByRole('button', { name: /Confirm Payment/ }).click();
    await expect(page.getByText(/Order #.+ paid!/)).toBeVisible();
    expect(
      paymentRequests,
      'the committed payment is resolved by replaying the saved request',
    ).toHaveLength(2);
    expect(paymentRequests[1]).toEqual(paymentRequests[0]);
    await expect
      .poll(() => recoveryBills.length, {
        message: 'retry performs a real bill lookup before deciding',
      })
      .toBeGreaterThan(0);
    const recoveredPayments = recoveryBills[recoveryBills.length - 1].payment_details as unknown;
    expect(
      Array.isArray(recoveredPayments)
        ? recoveredPayments
        : JSON.parse(String(recoveredPayments || '[]')),
      'the recovered bill still records one payment',
    ).toHaveLength(1);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('prepaid checkout shows the approved payment rejection reason without duplicating backend capture', async ({
  page,
}) => {
  const originalBusiness = await setBillingType(page, 'prepaid');
  try {
    const paymentRequests: string[] = [];
    const captures: unknown[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /\/api\/bills\/[^/]+\/payments$/.test(path))
        paymentRequests.push(path);
      if (request.method() === 'POST' && path === '/api/diagnostics/capture')
        captures.push(request.postDataJSON());
    });
    await page.route('**/api/bills/*/payments', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Cannot accept payment on a refunded bill',
          reason_code: 'payment.invalid',
          operation: 'payment.create',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          correlation_id: route.request().headers()['x-operation-id'],
          display_code: 'bill_refunded',
        }),
      });
    });

    await loginAndOpenPos(page);
    await addOneProduct(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: /^Tax / })).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await page.getByRole('button', { name: /Confirm Payment/ }).click();

    await expect.poll(() => paymentRequests.length).toBe(1);
    await expect(
      page
        .getByRole('main')
        .getByText('This bill was refunded. No new payment can be added.', { exact: true }),
    ).toBeVisible();
    expect(
      paymentRequests,
      'the cashier receives the specific safe rejection without another charge attempt',
    ).toHaveLength(1);
    expect(
      captures,
      'backend-owned validation is not captured a second time by the UI',
    ).toHaveLength(0);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('an unrelated payment does not resolve another cashier’s pending payment attempt', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  originalOrdersLayout = await readOrdersLayout(page, BASE, MANAGER_TOKEN);
  await setOrdersLayout(page, 'split', BASE, MANAGER_TOKEN);
  const orderResponse = await request.post(`${BASE}/api/orders`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(orderResponse.status()).toBe(201);
  const { order } = await orderResponse.json();
  const billResponse = await request.post(`${BASE}/api/bills/generate`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    data: { order_id: order.id },
  });
  expect(billResponse.status()).toBe(201);
  const { bill } = await billResponse.json();
  expect(Number(bill.balance)).toBeGreaterThan(2);

  const paymentRequests: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string | undefined;
    operationId: string | undefined;
  }> = [];
  let loseFirstRequest = true;
  await page.route(`**/api/bills/${bill.id}/payments`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    paymentRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      idempotencyKey: route.request().headers()['idempotency-key'],
      operationId: route.request().headers()['x-operation-id'],
    });
    if (loseFirstRequest) {
      loseFirstRequest = false;
      await route.abort('timedout');
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/orders`);
  await page
    .getByPlaceholder(/search/i)
    .first()
    .fill(order.order_number);
  const orderRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
  await expect(orderRow).toBeVisible();
  await orderRow.click();
  await page.getByRole('button', { name: /Checkout|Take Payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await page.getByTitle('Cash', { exact: true }).click();
  const cashierCashAmount = page
    .getByTitle('Cash', { exact: true })
    .locator('..')
    .locator('..')
    .getByRole('spinbutton');
  await cashierCashAmount.fill('1');
  await page.getByRole('button', { name: /^Pay / }).click();
  await page
    .getByRole('dialog', { name: 'Confirm' })
    .getByRole('button', { name: 'Pay', exact: true })
    .click();
  await expect(
    page
      .getByRole('main')
      .getByText('FloCafe could not confirm whether the order or payment was saved.', {
        exact: false,
      }),
  ).toBeVisible();
  expect(paymentRequests).toHaveLength(1);

  const otherPayment = await request.post(`${BASE}/api/bills/${bill.id}/payments`, {
    headers: {
      Authorization: `Bearer ${MANAGER_TOKEN}`,
      'Idempotency-Key': 'e2e-concurrent-cashier-key-0001',
      'x-operation-id': 'f89d42b0-43e5-48ac-98e1-7fb1f735c0a1',
    },
    data: { payments: [{ method: 'cash', amount: 1 }], customer_id: bill.customer_id ?? null },
  });
  expect(otherPayment.ok()).toBeTruthy();
  const otherPaymentBill = (await otherPayment.json()).bill;
  const otherPaymentDetails = Array.isArray(otherPaymentBill.payment_details)
    ? otherPaymentBill.payment_details
    : JSON.parse(String(otherPaymentBill.payment_details || '[]'));
  expect(otherPaymentDetails).toHaveLength(1);

  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(
    page
      .getByRole('main')
      .getByText(
        'The current bill was refreshed, but this does not confirm whether this payment was recorded.',
        { exact: false },
      ),
  ).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByText('Retrying sends the same saved payment with the same request key.', {
        exact: false,
      }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send same payment' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send same payment' }).click();
  await expect(
    page
      .getByRole('main')
      .getByText(
        'The current bill was refreshed, but this does not confirm whether this payment was recorded.',
        { exact: false },
      ),
  ).toHaveCount(0);
  expect(paymentRequests).toHaveLength(2);
  expect(paymentRequests[1]).toEqual(paymentRequests[0]);

  const latestBillResponse = await request.get(`${BASE}/api/bills/${bill.id}`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
  });
  expect(latestBillResponse.ok()).toBeTruthy();
  const latestBill = (await latestBillResponse.json()).bill;
  const latestPaymentDetails = Array.isArray(latestBill.payment_details)
    ? latestBill.payment_details
    : JSON.parse(String(latestBill.payment_details || '[]'));
  expect(
    latestPaymentDetails,
    'the UI retries its saved key after the unrelated payment and both payments remain accounted for',
  ).toHaveLength(2);
});
