import { test, expect, request as playwrightRequest, type APIRequestContext, type Page, type Request, type Route } from '@playwright/test';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setOrdersLayout,
  setLanguage,
  type E2EOrdersLayout,
} from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const managerHeaders = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
const paymentModalCharges = [
  {
    id: 'service_charge',
    name: 'Payment Service Fee',
    type: 'fixed',
    value: 5,
    calculation_basis: 'gross',
    order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
    is_optional: true,
    is_default_active: true,
    is_active: true,
  },
  {
    id: 'payment_addon',
    name: 'Payment Add-on Fee',
    type: 'fixed',
    value: 7,
    calculation_basis: 'gross',
    order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
    is_optional: false,
    is_default_active: false,
    is_active: true,
  },
  {
    id: 'payment_required',
    name: 'Payment Required Fee',
    type: 'fixed',
    value: 2,
    calculation_basis: 'gross',
    order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
    is_optional: false,
    is_default_active: true,
    is_active: true,
  },
];

async function readCharges(request: APIRequestContext): Promise<unknown[]> {
  const response = await request.get(`${BASE}/api/settings/charges`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).charges;
}

async function writeCharges(request: APIRequestContext, charges: unknown[]): Promise<void> {
  const response = await request.put(`${BASE}/api/settings/charges`, { headers: managerHeaders, data: { charges } });
  expect(response.ok()).toBeTruthy();
}

async function readBusiness(request: APIRequestContext): Promise<Record<string, unknown>> {
  const response = await request.get(`${BASE}/api/settings/business`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

// #639 made the Orders screen default to the master/detail split view, so this
// spec pins the classic cards grid before driving OrderCard affordances. The
// evidence for why lives in frontend/e2e/orders-master-detail.spec.ts.
let ordersLayoutBefore: E2EOrdersLayout = 'split';
// This spec drives restricted roles, so pin and restore with the E2E owner
// token instead of whatever token the page happens to hold.
const ordersLayoutOwnerToken = getE2eToken();

test.beforeEach(async ({ page }) => {
  ordersLayoutBefore = await readOrdersLayout(page, BASE, ordersLayoutOwnerToken);
  await setOrdersLayout(page, 'cards', BASE, ordersLayoutOwnerToken);
});

test.afterEach(async ({ page }) => {
  await setOrdersLayout(page, ordersLayoutBefore, BASE, ordersLayoutOwnerToken);
});

test('prepaid checkout uses the authoritative decimal bill total and settles in full', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);

  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: 'Add to Cart - ฿60.00' }).click();
  await page.getByRole('button', { name: 'Place Order' }).click();

  await expect(page.getByRole('button', { name: 'Tax ฿4.20' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeVisible();
  await expect(page.getByText('Round off', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeEnabled();

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

  await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();

  const orderPayload = await (await orderResponse).json();
  const billPayload = await (await billResponse).json();
  const paymentPayload = await (await paymentResponse).json();

  expect(orderPayload.order.total).toBe(64.2);
  expect(orderPayload.order.round_off).toBe(0);
  expect(billPayload.bill.total).toBe(64.2);
  expect(billPayload.bill.round_off).toBe(0);
  expect(paymentPayload.bill.paid_amount).toBe(64.2);
  expect(paymentPayload.bill.balance).toBe(0);
  expect(paymentPayload.bill.payment_status).toBe('paid');
  await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toBeVisible();
});

test('prepaid checkout never reports success when the payment response is partial', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);

  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: 'Add to Cart - ฿60.00' }).click();
  await page.getByRole('button', { name: 'Place Order' }).click();
  await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeVisible();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeEnabled();

  let paymentBatchRequests = 0;
  await page.route('**/api/bills/*/payments', async (route) => {
    paymentBatchRequests++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bill: {
          id: 999,
          payment_status: 'partial',
          balance: 0.2,
        },
      }),
    });
  });

  await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();

  await expect(page.getByText(/Payment incomplete/)).toBeVisible();
  expect(paymentBatchRequests).toBe(1);
  await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Place Order' })).toBeEnabled();
});

test('prepaid checkout fee choices use fresh quotes and fail closed when a quote fails', async ({ page, request }) => {
  const originalCharges = await readCharges(request);
  const originalBusiness = await readBusiness(request);
  const cleanupRequest = await playwrightRequest.newContext();
  let primaryFailure = false;
  const configuredCharges = [
    {
      id: 'service_charge',
      name: 'Checkout Service Fee',
      type: 'fixed',
      value: 5,
      calculation_basis: 'gross',
      order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
      is_optional: true,
      is_default_active: true,
      is_active: true,
    },
    {
      id: 'checkout_addon',
      name: 'Checkout Add-on Fee',
      type: 'fixed',
      value: 7,
      calculation_basis: 'gross',
      order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
      is_optional: false,
      is_default_active: false,
      is_active: true,
    },
    {
      id: 'checkout_required',
      name: 'Checkout Required Fee',
      type: 'fixed',
      value: 2,
      calculation_basis: 'gross',
      order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
      is_optional: false,
      is_default_active: true,
      is_active: true,
    },
  ];

  try {
    const businessResponse = await request.put(`${BASE}/api/settings/business`, {
      headers: managerHeaders,
      data: { ...originalBusiness, billing_type: 'prepaid' },
    });
    expect(businessResponse.ok()).toBeTruthy();
    await writeCharges(request, configuredCharges);
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await page.getByTestId('pos-product-card').click();
    await page.getByRole('button', { name: 'Add to Cart - ฿60.00' }).click();
    await page.getByRole('button', { name: 'Place Order' }).click();

    const summary = page.getByTestId('prepaid-checkout-summary');
    const serviceRow = page.getByTestId('prepaid-charge-service_charge');
    const requiredRow = page.getByTestId('prepaid-charge-checkout_required');
    const addonRow = page.getByTestId('prepaid-charge-checkout_addon');
    await expect(serviceRow).toContainText('Checkout Service Fee');
    await expect(requiredRow).toContainText('Checkout Required Fee');
    await expect(serviceRow.getByRole('button', { name: 'Waive', exact: true })).toBeVisible();
    await expect(requiredRow.getByRole('button')).toHaveCount(0);
    await expect(addonRow.getByRole('button', { name: 'Add', exact: true })).toBeVisible();

    const waivedPreview = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/tax/preview') return false;
      return response.request().postDataJSON().waived_charge_ids?.includes('service_charge') === true;
    });
    await serviceRow.getByRole('button', { name: 'Waive', exact: true }).click();
    const waivedResponse = await waivedPreview;
    expect(waivedResponse.ok()).toBeTruthy();
    const waivedSummary = (await waivedResponse.json()).summary;
    expect(waivedSummary.charges_breakdown.find((charge: { id: string }) => charge.id === 'service_charge').waived).toBe(true);
    expect(waivedSummary.charges_breakdown.find((charge: { id: string }) => charge.id === 'checkout_required').amount).toBe(2);
    await expect(serviceRow.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();

    const addedPreview = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/tax/preview') return false;
      return response.request().postDataJSON().opted_in_charge_ids?.includes('checkout_addon') === true;
    });
    await addonRow.getByRole('button', { name: 'Add', exact: true }).click();
    const addedResponse = await addedPreview;
    expect(addedResponse.ok()).toBeTruthy();
    const addedSummary = (await addedResponse.json()).summary;
    expect(addedSummary.charges_breakdown.find((charge: { id: string }) => charge.id === 'checkout_addon').amount).toBe(7);
    await expect(page.getByTestId('prepaid-charge-checkout_addon').getByRole('button', { name: 'Remove', exact: true })).toBeVisible();

    let submittedOrders = 0;
    let submittedPayments = 0;
    page.on('request', (browserRequest) => {
      if (browserRequest.method() !== 'POST') return;
      const path = new URL(browserRequest.url()).pathname;
      if (path === '/api/orders') submittedOrders += 1;
      if (/^\/api\/bills\/[^/]+\/payments$/.test(path)) submittedPayments += 1;
    });
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await page.route('**/api/tax/preview', async (route) => {
      const body = route.request().postDataJSON();
      if (!body.waived_charge_ids?.includes('service_charge') && body.opted_in_charge_ids?.includes('checkout_addon')) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'quote unavailable' }) });
      } else {
        await route.continue();
      }
    });
    const failedPreview = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/tax/preview'
      && !response.request().postDataJSON().waived_charge_ids?.includes('service_charge')
      && response.request().postDataJSON().opted_in_charge_ids?.includes('checkout_addon') === true,
    );
    await serviceRow.getByRole('button', { name: 'Apply', exact: true }).click();
    expect((await failedPreview).status()).toBe(503);
    const confirm = page.getByRole('button', { name: /Confirm Payment/ });
    await expect(confirm).toBeDisabled();
    expect(submittedOrders).toBe(0);
    expect(submittedPayments).toBe(0);
    await expect(summary).toHaveCount(0);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try { await writeCharges(cleanupRequest, originalCharges); } catch (error) { cleanupFailures.push(error); }
    try {
      const restoredBusiness = await cleanupRequest.put(`${BASE}/api/settings/business`, {
        headers: managerHeaders,
        data: originalBusiness,
      });
      expect(restoredBusiness.ok()).toBeTruthy();
    } catch (error) { cleanupFailures.push(error); }
    try { await cleanupRequest.dispose(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      if (primaryFailure) console.error('Prepaid checkout cleanup failed after the test error:', cleanupFailures);
      else throw cleanupFailures[0];
    }
  }
});

test('payment modal updates applied fees', async ({ page, request }) => {
  const originalCharges = await readCharges(request);
  const originalBusiness = await readBusiness(request);
  const cleanupRequest = await playwrightRequest.newContext();
  let primaryFailure = false;

  try {
    await request.put(`${BASE}/api/settings/business`, {
      headers: managerHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid' },
    }).then((response) => expect(response.ok()).toBeTruthy());
    await writeCharges(request, paymentModalCharges);

    const orderResponse = await request.post(`${BASE}/api/orders`, {
      headers: managerHeaders,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    expect(orderResponse.status()).toBe(201);
    const { order } = await orderResponse.json();
    const billResponse = await request.post(`${BASE}/api/bills/generate`, {
      headers: managerHeaders,
      data: { order_id: order.id },
    });
    expect(billResponse.status()).toBe(201);
    const { bill } = await billResponse.json();

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/orders`);
    await page.getByPlaceholder(/search/i).first().fill(order.order_number);
    await expect(page.getByText(`#${order.order_number}`)).toBeVisible();
    await page.getByRole('button', { name: 'Checkout', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();

    const serviceRow = page.getByTestId('payment-charge-service_charge');
    const addonRow = page.getByTestId('payment-charge-payment_addon');
    const requiredRow = page.getByTestId('payment-charge-payment_required');
    await expect(serviceRow.getByRole('button', { name: 'Waive', exact: true })).toBeVisible();
    await expect(requiredRow.getByRole('button')).toHaveCount(0);
    await expect(addonRow.getByRole('button', { name: 'Add', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    const chargeRoute = `**/api/bills/${bill.id}/charges`;
    let rejectNextUpdate = true;
    const rejectUpdate = async (route: Route) => {
      if (rejectNextUpdate && route.request().method() === 'PATCH') {
        rejectNextUpdate = false;
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'split check' }) });
        return;
      }
      await route.continue();
    };
    await page.route(chargeRoute, rejectUpdate);
    const rejectedUpdate = page.waitForResponse((response) =>
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/bills/${bill.id}/charges`,
    );
    await serviceRow.getByRole('button', { name: 'Waive', exact: true }).click();
    expect((await rejectedUpdate).status()).toBe(409);
    await expect(page.getByRole('button', { name: /^Pay / })).toBeEnabled();
    await page.unroute(chargeRoute, rejectUpdate);

    let detailBillReads = 0;
    await page.route(`**/api/bills/${bill.id}`, async (route) => {
      if (route.request().method() === 'GET') {
        detailBillReads += 1;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected bill refresh' }) });
        return;
      }
      await route.continue();
    });
    const waiverResponse = page.waitForResponse((response) =>
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/bills/${bill.id}/charges`,
    );
    await serviceRow.getByRole('button', { name: 'Waive', exact: true }).click();
    const updatedBill = (await waiverResponse).json().then((data) => data.bill);
    const patchedBill = await updatedBill;
    expect(Number(patchedBill.total)).toBeLessThan(Number(bill.total));
    await expect(serviceRow.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
    await expect(serviceRow).toContainText('0.00');
    expect(detailBillReads).toBe(0);

    const addResponse = page.waitForResponse((response) =>
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/bills/${bill.id}/charges`,
    );
    await addonRow.getByRole('button', { name: 'Add', exact: true }).click();
    const addedBill = (await addResponse).json().then((data) => data.bill);
    expect(Number((await addedBill).total)).toBeGreaterThan(Number(patchedBill.total));
    await expect(page.getByTestId('payment-charge-payment_addon').getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    expect(detailBillReads).toBe(0);

    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    let uncertainPatchStatus: number | undefined;
    let committedBillTotal: number | undefined;
    const losePatchResponse = async (route: Route) => {
      if (route.request().method() === 'PATCH') {
        const committed = await route.fetch();
        uncertainPatchStatus = committed.status();
        committedBillTotal = Number((await committed.json()).bill.total);
        await route.abort('failed');
        return;
      }
      await route.continue();
    };
    let paymentRequestsAfterUncertainUpdate = 0;
    page.on('request', (browserRequest) => {
      if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(new URL(browserRequest.url()).pathname)) {
        paymentRequestsAfterUncertainUpdate += 1;
      }
    });
    await page.route(chargeRoute, losePatchResponse);
    const lostPatchRequest = page.waitForEvent('requestfailed', (browserRequest) =>
      browserRequest.method() === 'PATCH'
      && new URL(browserRequest.url()).pathname === `/api/bills/${bill.id}/charges`,
    );
    await serviceRow.getByRole('button', { name: 'Apply', exact: true }).click();
    await lostPatchRequest;
    expect(uncertainPatchStatus).toBe(200);
    expect(committedBillTotal).toBeGreaterThan(Number((await addedBill).total));
    await expect(page.getByRole('button', { name: /^Pay / })).toBeDisabled();
    expect(paymentRequestsAfterUncertainUpdate).toBe(0);
    await page.unroute(chargeRoute, losePatchResponse);

  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try { await writeCharges(cleanupRequest, originalCharges); } catch (error) { cleanupFailures.push(error); }
    try {
      const restoredBusiness = await cleanupRequest.put(`${BASE}/api/settings/business`, {
        headers: managerHeaders,
        data: originalBusiness,
      });
      expect(restoredBusiness.ok()).toBeTruthy();
    } catch (error) { cleanupFailures.push(error); }
    try { await cleanupRequest.dispose(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      if (primaryFailure) console.error('Payment modal cleanup failed after the test error:', cleanupFailures);
      else throw cleanupFailures[0];
    }
  }
});

test('payment modal hides charge controls without bill discount permission', async ({ request, browser }) => {
  test.setTimeout(60_000);
  const originalCharges = await readCharges(request);
  const originalBusiness = await readBusiness(request);
  const cleanupRequest = await playwrightRequest.newContext();
  const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };
  let originalServerOverrides: Array<{ permission_id: string; effect: string }> | undefined;
  let serverPermissionsChanged = false;
  let serverContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let serverPage: Page | undefined;
  let orderNumber: string | undefined;
  const testStartedAt = Date.now();
  const requestStartedAt = new WeakMap<Request, number>();
  let restrictedSettingsReads = 0;
  const apiEvents: Array<{ label: string; method: string; status: number | 'network_error'; elapsedMs: number }> = [];
  const stages: Array<{ stage: string; phase: 'start' | 'complete'; elapsedMs: number }> = [];
  const appendApiEvent = (event: (typeof apiEvents)[number]) => {
    apiEvents.push(event);
    if (apiEvents.length > 40) apiEvents.shift();
  };
  const markStage = (stage: string, phase: 'start' | 'complete') => {
    stages.push({ stage, phase, elapsedMs: Date.now() - testStartedAt });
  };
  const safeApiLabel = (browserRequest: Request): string | null => {
    let url: URL;
    try { url = new URL(browserRequest.url()); } catch { return null; }
    if (url.origin !== new URL(BASE).origin) return null;
    const path = url.pathname;
    if (path === '/api/bills/generate' && browserRequest.method() === 'POST') return 'bill-generate';
    if ((/^\/api\/bills\/[^/]+$/.test(path) || /^\/api\/bills\/order\/[^/]+$/.test(path))
      && browserRequest.method() === 'GET') return 'bill-load';
    if (path === '/api/tax/preview') return 'tax-preview';
    if (path === '/api/settings/charges' && browserRequest.method() === 'GET') return 'charges-load';
    return null;
  };
  let primaryFailure = false;

  try {
    const businessResponse = await request.put(`${BASE}/api/settings/business`, {
      headers: managerHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid' },
    });
    expect(businessResponse.ok()).toBeTruthy();
    await writeCharges(request, paymentModalCharges);

    const orderResponse = await request.post(`${BASE}/api/orders`, {
      headers: managerHeaders,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    expect(orderResponse.status()).toBe(201);
    const { order } = await orderResponse.json();
    orderNumber = order.order_number;
    const billResponse = await request.post(`${BASE}/api/bills/generate`, {
      headers: managerHeaders,
      data: { order_id: order.id },
    });
    expect(billResponse.status()).toBe(201);
    const { bill } = await billResponse.json();
    const addOptionalCharge = await request.patch(`${BASE}/api/bills/${bill.id}/charges`, {
      headers: managerHeaders,
      data: { charge_id: 'payment_addon', applied: true },
    });
    expect(addOptionalCharge.status()).toBe(200);
    const appliedBill = await addOptionalCharge.json();
    expect(JSON.parse(appliedBill.bill.charges_breakdown).some((charge: { id: string }) => charge.id === 'payment_addon')).toBe(true);

    const userResponse = await request.get(`${BASE}/api/authorization/users/e2e-server`, { headers: ownerHeaders });
    expect(userResponse.ok()).toBeTruthy();
    const originalUser = await userResponse.json();
    originalServerOverrides = originalUser.overrides;
    const feePermissionIds = new Set(['bills.read', 'bills.generate', 'bills.discount.apply', 'orders.create', 'settings.view']);
    const overrides = (originalServerOverrides || []).filter((override) => !feePermissionIds.has(override.permission_id));
    overrides.push(
      { permission_id: 'bills.read', effect: 'allow' },
      { permission_id: 'bills.generate', effect: 'allow' },
      { permission_id: 'orders.create', effect: 'allow' },
      { permission_id: 'bills.discount.apply', effect: 'deny' },
      { permission_id: 'settings.view', effect: 'deny' },
    );
    const permissionResponse = await request.put(`${BASE}/api/authorization/users/e2e-server`, {
      headers: ownerHeaders,
      data: { revision: originalUser.revision, overrides },
    });
    expect(permissionResponse.ok()).toBeTruthy();
    serverPermissionsChanged = true;

    serverContext = await browser.newContext();
    serverPage = await serverContext.newPage();
    // Exercise slow authentication so Orders navigation cannot interrupt sign-in.
    await serverPage.route('**/api/auth/login', async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.fulfill({ response });
    });
    serverPage.on('request', (browserRequest) => {
      const pathname = new URL(browserRequest.url()).pathname;
      if (pathname === '/api/settings/business' || pathname === '/api/settings/kds_enabled') restrictedSettingsReads++;
      if (safeApiLabel(browserRequest)) requestStartedAt.set(browserRequest, Date.now());
    });
    serverPage.on('response', (response) => {
      const browserRequest = response.request();
      const startedAt = requestStartedAt.get(browserRequest);
      const label = safeApiLabel(browserRequest);
      if (startedAt !== undefined && label) {
        appendApiEvent({ label, method: browserRequest.method(), status: response.status(), elapsedMs: Date.now() - startedAt });
      }
    });
    serverPage.on('requestfailed', (browserRequest) => {
      const startedAt = requestStartedAt.get(browserRequest);
      const label = safeApiLabel(browserRequest);
      if (startedAt !== undefined && label) {
        appendApiEvent({ label, method: browserRequest.method(), status: 'network_error', elapsedMs: Date.now() - startedAt });
      }
    });

    await test.step('staff signs in and finds the created order', async () => {
      markStage('staff_login_order_search', 'start');
      await serverPage!.goto(`${BASE}/auth/login`);
      await setLanguage(serverPage!, 'en');
      const serverEmail = serverPage!.locator('#email');
      await expect(serverEmail).toBeVisible({ timeout: 5000 });
      await serverEmail.fill('server@flo.local');
      await serverPage!.locator('#password').fill(E2E_PASSWORD);
      await serverPage!.locator('button[type="submit"]').click();
      await serverPage!.waitForURL((url) => url.pathname !== '/auth/login' && url.pathname !== '/auth/login/');
      await serverPage!.goto(`${BASE}/orders`);
      await serverPage!.getByPlaceholder(/search/i).first().fill(order.order_number);
      await expect(serverPage!.getByText(`#${order.order_number}`)).toBeVisible();
      markStage('staff_login_order_search', 'complete');
    });
    const staffOrderCard = serverPage.locator('div.bg-card.rounded-xl.border.flex.flex-col')
      .filter({ hasText: `#${order.order_number}` });
    await expect(staffOrderCard).toHaveCount(1);
    await expect(staffOrderCard.getByText('Payment Add-on Fee', { exact: true })).toHaveCount(1);
    await expect(staffOrderCard.getByText('Payment Required Fee', { exact: true })).toHaveCount(1);
    await expect(staffOrderCard.getByText('Service Charge', { exact: true })).toHaveCount(1);
    await test.step('staff checks out the created order and sees payment', async () => {
      const [billGenerateResponse] = await Promise.all([
        serverPage!.waitForResponse(
          (response) => {
            try {
              const url = new URL(response.url());
              return url.pathname === '/api/bills/generate' && response.request().method() === 'POST';
            } catch {
              return false;
            }
          },
          { timeout: 10000 },
        ),
        staffOrderCard.getByRole('button', { name: 'Checkout', exact: true }).click(),
      ]);
      expect(billGenerateResponse.ok()).toBeTruthy();
      markStage('staff_checkout_click', 'complete');
      markStage('payment_heading_visible', 'start');
      await expect(serverPage!.getByRole('heading', { name: 'Payment' })).toBeVisible({ timeout: 10000 });
      markStage('payment_heading_visible', 'complete');
      // Orders reads each setting once; Sidebar must not repeat denied reads after auth refresh.
      expect(restrictedSettingsReads).toBeLessThanOrEqual(2);
    });
    await test.step('staff sees charge details without mutation controls', async () => {
      markStage('staff_readonly_charge_assertions', 'start');
      const readOnlyCharges = serverPage!.getByTestId('payment-charges');
      await expect(readOnlyCharges.getByText('Payment Service Fee')).toBeVisible();
      await expect(readOnlyCharges.getByText('Payment Add-on Fee')).toBeVisible();
      await expect(readOnlyCharges.getByRole('button')).toHaveCount(0);
      markStage('staff_readonly_charge_assertions', 'complete');
    });

    const limitedHeaders = { Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}` };
    const feeDefinitions = await serverPage.request.get(`${BASE}/api/settings/charges`, { headers: limitedHeaders });
    expect(feeDefinitions.status()).toBe(200);
    expect((await feeDefinitions.json()).charges.map((charge: { id: string }) => charge.id)).toContain('payment_required');
    const settingsDenied = await serverPage.request.get(`${BASE}/api/settings/business`, { headers: limitedHeaders });
    expect(settingsDenied.status()).toBe(403);
    const forbiddenUpdate = await serverPage.request.patch(`${BASE}/api/bills/${bill.id}/charges`, {
      headers: limitedHeaders,
      data: { charge_id: 'service_charge', waived: true },
    });
    expect(forbiddenUpdate.status()).toBe(403);
  } catch (error) {
    primaryFailure = true;
    if (serverPage) {
      try {
        const orderCard = orderNumber
          ? serverPage.locator('div.bg-card.rounded-xl.border.flex.flex-col').filter({ hasText: `#${orderNumber}` })
          : null;
        const diagnostics = {
          elapsedMs: Date.now() - testStartedAt,
          orderCardCount: orderCard ? await orderCard.count() : 0,
          checkoutButtonCount: orderCard ? await orderCard.getByRole('button', { name: 'Checkout', exact: true }).count() : 0,
          paymentHeadingVisible: await serverPage.getByRole('heading', { name: 'Payment' }).isVisible().catch(() => false),
          dialogCount: await serverPage.getByRole('dialog').count(),
          stages,
          apiEvents,
        };
        console.error('STAFF_CHECKOUT_DIAGNOSTICS', JSON.stringify(diagnostics));
      } catch {
        // Keep diagnostic collection from masking the original browser failure.
      }
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try { await serverContext?.close(); } catch (error) { cleanupFailures.push(error); }
    if (serverPermissionsChanged && originalServerOverrides) {
      try {
        const latestResponse = await cleanupRequest.get(`${BASE}/api/authorization/users/e2e-server`, { headers: ownerHeaders });
        expect(latestResponse.ok()).toBeTruthy();
        const latestUser = await latestResponse.json();
        const restored = await cleanupRequest.put(`${BASE}/api/authorization/users/e2e-server`, {
          headers: ownerHeaders,
          data: { revision: latestUser.revision, overrides: originalServerOverrides },
        });
        expect(restored.ok()).toBeTruthy();
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await writeCharges(cleanupRequest, originalCharges); } catch (error) { cleanupFailures.push(error); }
    try {
      const restoredBusiness = await cleanupRequest.put(`${BASE}/api/settings/business`, {
        headers: managerHeaders,
        data: originalBusiness,
      });
      expect(restoredBusiness.ok()).toBeTruthy();
    } catch (error) { cleanupFailures.push(error); }
    try { await cleanupRequest.dispose(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      if (primaryFailure) console.error('Staff payment modal cleanup failed after the test error:', cleanupFailures);
      else throw cleanupFailures[0];
    }
  }
});
