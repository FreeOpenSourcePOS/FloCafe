import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
  type Request,
} from '@playwright/test';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setOrdersLayout,
  setLanguage,
  type E2EOrdersLayout,
} from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * Checkout must stay usable when the tenant disables discounts (discount_mode
 * 'none'). `none` forbids every discount type, so a render-phase reconciliation
 * that normalizes an incompatible draft type to the mode default never becomes
 * satisfied: the default is forbidden too and the update reschedules itself on
 * every render until React aborts with "Too many re-renders". The merchant then
 * sees the generic recovery screen ("This screen hit a snag") before any printer
 * is contacted.
 *
 * These specs pin the tenant discount mode through the real settings API and
 * drive the real loading path (each payment surface fetches /settings/discount
 * when it mounts), then restore both the mode and the orders layout.
 */

const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};

type DiscountSettings = {
  discount_mode: string;
  discount_requires_approval: boolean;
  discount_max_percentage: number;
  discount_max_amount: number;
};

async function readDiscountSettings(request: APIRequestContext): Promise<DiscountSettings> {
  const response = await request.get(`${BASE}/api/settings/discount`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function writeDiscountSettings(
  request: APIRequestContext,
  settings: Partial<DiscountSettings>,
): Promise<void> {
  const response = await request.put(`${BASE}/api/settings/discount`, {
    headers: managerHeaders,
    data: settings,
  });
  expect(response.status()).toBe(200);
  const written = await response.json();
  expect(written.discount_mode).toBe(settings.discount_mode ?? written.discount_mode);
}

async function writeDiscountMode(
  request: APIRequestContext,
  mode: string,
  base: DiscountSettings,
): Promise<void> {
  await writeDiscountSettings(request, { ...base, discount_mode: mode });
}

async function readBusiness(request: APIRequestContext): Promise<Record<string, unknown>> {
  const response = await request.get(`${BASE}/api/settings/business`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function readCharges(request: APIRequestContext): Promise<unknown[]> {
  const response = await request.get(`${BASE}/api/settings/charges`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).charges;
}

async function writeCharges(request: APIRequestContext, charges: unknown[]): Promise<void> {
  const response = await request.put(`${BASE}/api/settings/charges`, {
    headers: managerHeaders,
    data: { charges },
  });
  expect(response.ok()).toBeTruthy();
}

async function createTakeawayOrder(request: APIRequestContext): Promise<{ id: number; order_number: string }> {
  const response = await request.post(`${BASE}/api/orders`, {
    headers: managerHeaders,
    data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).order;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
}

/** Orders opens the payment modal for this order; the caller owns the assertions. */
async function openCheckout(page: Page, orderNumber: string, waitForModalSettings = true): Promise<void> {
  const ordersSettingsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/settings/discount';
  });
  await page.goto(`${BASE}/orders`);
  expect((await ordersSettingsResponse).ok()).toBeTruthy();
  await page.getByPlaceholder(/search/i).first().fill(orderNumber);
  await expect(page.getByText(`#${orderNumber}`)).toBeVisible();
  const checkoutButton = page.getByRole('button', { name: 'Checkout', exact: true });
  if (waitForModalSettings) {
    const modalSettingsRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'GET' && url.pathname === '/api/settings/discount';
    });
    await checkoutButton.click();
    const modalSettingsResponse = await (await modalSettingsRequestPromise).response();
    expect(modalSettingsResponse?.ok()).toBeTruthy();
  } else {
    await checkoutButton.click();
  }
}

const recoveryScreen = (page: Page) => page.getByText('Something went wrong', { exact: true });
const discountToggle = (page: Page) => page.getByRole('button', { name: /^(Apply Discount|Discount:)/ });

/**
 * The recovery boundary auto-retries after 2s, so a render loop surfaces as a
 * repeating snag screen rather than a single error. Collect React's uncaught
 * errors and its own loop-abort messages (thrown during render, they never reach
 * `pageerror`) so a regression fails on the cause, not only on a missing button.
 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  // #185 / #301 are React's "Maximum update depth" / "Too many re-renders"; the
  // production export logs the minified code instead of the sentence.
  const record = (message: string) => {
    if (/Too many re-renders|Maximum update depth|Minified React error #(185|301)/.test(message)) {
      errors.push(message);
    }
  };
  page.on('pageerror', (error) => record(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') record(message.text());
  });
  return errors;
}

/**
 * The loop only starts once the settings read resolves, so give it a moment to
 * surface before asserting that it never happened.
 */
async function expectNoRenderLoop(pageErrors: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(pageErrors).toEqual([]);
}

type BillRecord = {
  payment_status: string;
  balance: number | string;
  discount_amount: number | string;
  paid_amount: number | string;
  total: number | string;
};

async function readBill(request: APIRequestContext, orderId: number): Promise<BillRecord> {
  const response = await request.get(`${BASE}/api/bills/order/${orderId}`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).bill;
}

/**
 * Settle the open Orders payment modal in cash. Its Pay label is the amount
 * routed to payment, so the expected string asserts what the modal charged.
 */
async function settleInCash(page: Page, expectedAmount: string): Promise<void> {
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  const payButton = page.getByRole('button', { name: /^Pay / });
  await expect(payButton).toBeEnabled();
  await expect(payButton).toContainText(expectedAmount);
  const paymentResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname);
  });
  await payButton.click();
  expect((await paymentResponse).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
}

/** The stored bill is the authority; wait for it to reflect the settlement. */
async function expectBillPaid(request: APIRequestContext, orderId: number): Promise<BillRecord> {
  await expect.poll(async () => (await readBill(request, orderId)).payment_status, { timeout: 5000 }).toBe('paid');
  return readBill(request, orderId);
}

let discountBefore: DiscountSettings;
// The card grid exposes OrderCard's Checkout button; the split default hides it
// behind a selection. See frontend/e2e/orders-master-detail.spec.ts for why the
// card-grid specs pin the layout and restore it.
let ordersLayoutBefore: E2EOrdersLayout = 'split';
const ordersLayoutOwnerToken = getE2eToken();

test.beforeEach(async ({ page, request }) => {
  discountBefore = await readDiscountSettings(request);
  ordersLayoutBefore = await readOrdersLayout(page, BASE, ordersLayoutOwnerToken);
  await setOrdersLayout(page, 'cards', BASE, ordersLayoutOwnerToken);
});

test.afterEach(async ({ page, request }) => {
  const failures: unknown[] = [];
  try { await writeDiscountMode(request, discountBefore.discount_mode, discountBefore); } catch (error) { failures.push(error); }
  try { await setOrdersLayout(page, ordersLayoutBefore, BASE, ordersLayoutOwnerToken); } catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
});

test('orders checkout with discounts disabled opens a payable screen instead of the recovery boundary', async ({ page, request }) => {
  await writeDiscountMode(request, 'none', discountBefore);
  const order = await createTakeawayOrder(request);
  const pageErrors = collectPageErrors(page);
  const printRequests: string[] = [];
  page.on('request', (browserRequest) => {
    if (new URL(browserRequest.url()).pathname.startsWith('/api/printers/print')) {
      printRequests.push(new URL(browserRequest.url()).pathname);
    }
  });

  await login(page);
  await expect(page.getByPlaceholder(/search/i).first()).toBeVisible();

  await openCheckout(page, order.order_number);

  // A render loop unmounts the modal before any control is usable.
  await expectNoRenderLoop(pageErrors);
  await expect(recoveryScreen(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  await expect(discountToggle(page)).toHaveCount(0);
  // Opening checkout must not reach for a printer: the crash precedes dispatch.
  expect(printRequests).toEqual([]);

  const due = Number((await readBill(request, order.id)).balance).toFixed(2);
  await settleInCash(page, due);
  const bill = await expectBillPaid(request, order.id);
  expect(Number(bill.balance)).toBe(0);
  expect(Number(bill.discount_amount)).toBe(0);
});

test('a late disabled-discount response drops an open checkout draft and still settles', async ({ page, request }) => {
  await writeDiscountMode(request, 'none', discountBefore);
  const order = await createTakeawayOrder(request);
  const pageErrors = collectPageErrors(page);
  const submittedDiscounts: string[] = [];
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (browserRequest.method() === 'PATCH' && /^\/api\/orders\/\d+\/discount$/.test(url.pathname)) {
      submittedDiscounts.push(url.pathname);
    }
  });

  // Hold the payment modal's settings read open so a draft exists while the
  // response is still in flight; the Orders page's own read passes through.
  let released: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { released = resolve; });
  const settingsReads: Request[] = [];
  await page.route('**/api/settings/discount', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    settingsReads.push(route.request());
    if (settingsReads.length > 1) await release;
    await route.continue();
  });

  await login(page);
  await openCheckout(page, order.order_number, false);
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await expect.poll(() => settingsReads.length).toBeGreaterThan(1);
  const settingsRequest = settingsReads[1];

  // While the delayed read is in flight the draft is open and editable.
  await page.getByRole('button', { name: 'Apply Discount', exact: true }).click();
  const draftInput = page.locator('input[type="number"][max="100"]');
  await draftInput.fill('10');
  await expect(draftInput).toHaveValue('10');

  released?.();
  const settingsResponse = await settingsRequest.response();
  expect(settingsResponse?.ok()).toBeTruthy();
  // The resolved mode is `none`, so the draft and its editor must disappear.
  await expect(discountToggle(page)).toHaveCount(0);
  await expect(page.getByText('Apply Discount', { exact: true })).toHaveCount(0);
  await expectNoRenderLoop(pageErrors);
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await expect(recoveryScreen(page)).toHaveCount(0);
  expect(submittedDiscounts).toEqual([]);

  // Payment still settles on the undiscounted authoritative total.
  await settleInCash(page, Number((await readBill(request, order.id)).balance).toFixed(2));
  const bill = await expectBillPaid(request, order.id);
  expect(Number(bill.discount_amount)).toBe(0);
});

test('a bill update while discounts stay disabled keeps the checkout payable', async ({ page, request }) => {
  const chargesBefore = await readCharges(request);
  const businessBefore = await readBusiness(request);
  let primaryFailure = false;

  try {
    await request.put(`${BASE}/api/settings/business`, {
      headers: managerHeaders,
      data: { ...businessBefore, billing_type: 'postpaid' },
    }).then((response) => expect(response.ok()).toBeTruthy());
    await writeCharges(request, [{
      id: 'e2e_disabled_charge',
      name: 'Disabled Mode Fee',
      type: 'fixed',
      value: 5,
      calculation_basis: 'gross',
      order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
      is_optional: true,
      is_default_active: true,
      is_active: true,
    }]);
    await writeDiscountMode(request, 'none', discountBefore);
    const order = await createTakeawayOrder(request);
    const pageErrors = collectPageErrors(page);

    await login(page);
    await openCheckout(page, order.order_number);
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();

    // Waiving a charge replaces the bill prop on the mounted modal while the
    // mode stays `none`: the same instance reconciles a new bill.
    const chargeRow = page.getByTestId('payment-charge-e2e_disabled_charge');
    await expect(chargeRow).toContainText('Disabled Mode Fee');
    const waiverResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PATCH' && /^\/api\/bills\/[^/]+\/charges$/.test(url.pathname);
    });
    await chargeRow.getByRole('button', { name: 'Waive', exact: true }).click();
    expect((await waiverResponse).ok()).toBeTruthy();
    await expect(chargeRow.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();

    await expectNoRenderLoop(pageErrors);
    await expect(recoveryScreen(page)).toHaveCount(0);
    await expect(discountToggle(page)).toHaveCount(0);

    await settleInCash(page, Number((await readBill(request, order.id)).balance).toFixed(2));
    const bill = await expectBillPaid(request, order.id);
    expect(Number(bill.balance)).toBe(0);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    const cleanupRequest = await playwrightRequest.newContext();
    try { await writeCharges(cleanupRequest, chargesBefore); } catch (error) { cleanupFailures.push(error); }
    try {
      const restored = await cleanupRequest.put(`${BASE}/api/settings/business`, {
        headers: managerHeaders,
        data: businessBefore,
      });
      expect(restored.ok()).toBeTruthy();
    } catch (error) { cleanupFailures.push(error); }
    try { await cleanupRequest.dispose(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      if (primaryFailure) console.error('Disabled-discount bill update cleanup failed:', cleanupFailures);
      else throw cleanupFailures[0];
    }
  }
});

test('an already discounted bill settles on its authoritative total when discounts are disabled', async ({ page, request }) => {
  // The discount is persisted while the type is allowed, then the tenant turns
  // discounts off: the stored bill must keep its discount and settle on it.
  await writeDiscountMode(request, 'both', discountBefore);
  const order = await createTakeawayOrder(request);
  const discounted = await request.patch(`${BASE}/api/orders/${order.id}/discount`, {
    headers: managerHeaders,
    data: { discount_type: 'percentage', discount_value: 10, discount_reason: 'E2E persisted discount' },
  });
  expect(discounted.ok()).toBeTruthy();
  await writeDiscountMode(request, 'none', discountBefore);

  await login(page);
  const pageErrors = collectPageErrors(page);
  await openCheckout(page, order.order_number);
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await expectNoRenderLoop(pageErrors);

  const bill = await readBill(request, order.id);
  expect(Number(bill.discount_amount)).toBeGreaterThan(0);

  // The mode hides the discount editor without touching the bill's own discount.
  await expect(discountToggle(page)).toHaveCount(0);
  // The modal charges the bill's own discounted total, not the pre-discount one.
  await settleInCash(page, Number(bill.balance).toFixed(2));

  const settledBill = await expectBillPaid(request, order.id);
  expect(Number(settledBill.discount_amount)).toBe(Number(bill.discount_amount));
  expect(Number(settledBill.paid_amount)).toBe(Number(settledBill.total));
});

test('enabled discount modes still expose only their allowed types', async ({ page, request }) => {
  const order = await createTakeawayOrder(request);
  await login(page);
  const pageErrors = collectPageErrors(page);

  const cases: Array<{ mode: string; shown: string[]; hidden: string[] }> = [
    { mode: 'percentage', shown: ['Percentage'], hidden: ['Flat Amount'] },
    { mode: 'flat', shown: ['Flat Amount'], hidden: ['Percentage'] },
    { mode: 'both', shown: ['Percentage', 'Flat Amount'], hidden: [] },
  ];

  for (const testCase of cases) {
    await writeDiscountMode(request, testCase.mode, discountBefore);
    await openCheckout(page, order.order_number);
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
    const toggle = page.getByRole('button', { name: /^(Apply Discount|Discount:)/ });
    await expect(toggle).toHaveCount(1);
    await toggle.click();
    for (const label of testCase.shown) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    for (const label of testCase.hidden) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
    await expect(recoveryScreen(page)).toHaveCount(0);
    await expectNoRenderLoop(pageErrors);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toHaveCount(0);
  }

  // A flat-only tenant can still apply a flat discount: the draft type converges
  // to the allowed type instead of looping.
  await writeDiscountMode(request, 'flat', discountBefore);
  await openCheckout(page, order.order_number);
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await page.getByRole('button', { name: /^Apply Discount$/ }).click();
  const amountInput = page.locator('input[type="number"]').first();
  await amountInput.fill('5');
  await page.getByPlaceholder('Reason (optional)').fill('E2E flat mode');
  const discountPatch = page.waitForRequest((browserRequest) =>
    browserRequest.method() === 'PATCH' && new URL(browserRequest.url()).pathname === `/api/orders/${order.id}/discount`,
  );
  // The open panel also labels its submit button "Apply Discount"; the panel's is last.
  await page.getByRole('button', { name: 'Apply Discount', exact: true }).last().click();
  expect((await discountPatch).postDataJSON().discount_type).toBe('amount');
  await expect(page.getByRole('button', { name: /^Discount: -/ })).toBeVisible();
  await expect(recoveryScreen(page)).toHaveCount(0);
});

test('prepaid checkout settles an undiscounted bill when discounts are disabled', async ({ page, request }) => {
  const businessBefore = await readBusiness(request);
  let primaryFailure = false;

  try {
    const prepaid = await request.put(`${BASE}/api/settings/business`, {
      headers: managerHeaders,
      data: { ...businessBefore, billing_type: 'prepaid' },
    });
    expect(prepaid.ok()).toBeTruthy();
    await writeDiscountMode(request, 'none', discountBefore);
    const pageErrors = collectPageErrors(page);
    let paymentRequests = 0;
    page.on('request', (browserRequest) => {
      if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(new URL(browserRequest.url()).pathname)) {
        paymentRequests += 1;
      }
    });

    await login(page);
    await page.goto(`${BASE}/pos`);
    await page.getByTestId('pos-product-card').click();
    await page.getByRole('button', { name: 'Add to Cart - ฿60.00' }).click();

    const settingsRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'GET' && url.pathname === '/api/settings/discount';
    });
    await page.getByRole('button', { name: 'Place Order' }).click();
    const settingsResponse = await (await settingsRequest).response();
    expect(settingsResponse?.ok()).toBeTruthy();

    await expectNoRenderLoop(pageErrors);
    // Undiscounted preview, no recovery boundary, no discount controls.
    await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeVisible();
    await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Apply Discount|Discount:)/ })).toHaveCount(0);

    const orderResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.pathname === '/api/orders';
    });
    const billResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.pathname === '/api/bills/generate';
    });
    const paymentResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname);
    });

    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();

    const orderPayload = await (await orderResponse).json();
    const billPayload = await (await billResponse).json();
    const paymentPayload = await (await paymentResponse).json();

    expect(orderPayload.order.discount_amount).toBe(0);
    expect(orderPayload.order.total).toBe(64.2);
    expect(billPayload.bill.discount_amount).toBe(0);
    expect(billPayload.bill.total).toBe(64.2);
    expect(paymentPayload.bill.paid_amount).toBe(64.2);
    expect(paymentPayload.bill.balance).toBe(0);
    expect(paymentPayload.bill.payment_status).toBe('paid');
    expect(paymentRequests).toBe(1);
    await expect(page.getByText(/paid!/)).toBeVisible();

    const storedOrder = await request.get(`${BASE}/api/orders/${orderPayload.order.id}`, { headers: managerHeaders });
    const order = (await storedOrder.json()).order;
    expect(order.status).toBe('completed');
    expect(Number(order.discount_amount)).toBe(0);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    const cleanupRequest = await playwrightRequest.newContext();
    try {
      const restored = await cleanupRequest.put(`${BASE}/api/settings/business`, {
        headers: managerHeaders,
        data: businessBefore,
      });
      expect(restored.ok()).toBeTruthy();
    } catch (error) { cleanupFailures.push(error); }
    try { await cleanupRequest.dispose(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      if (primaryFailure) console.error('Disabled-discount prepaid cleanup failed:', cleanupFailures);
      else throw cleanupFailures[0];
    }
  }
});
