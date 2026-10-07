import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setOrdersLayout,
  setLanguage,
  type E2EOrdersLayout,
} from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { readSetting, writeSetting } from './helpers/kitchen-fixture';

/**
 * Equal-share payments end to end.
 *
 * Diners divide one authoritative check into equal shares without assigning
 * items: the cashier enters how many payers remain, notes the previewed share,
 * applies it to a tender, and pays. The shares are ordinary partial payments on
 * the same bill, so the ledger, the balance and the settlement rules stay the
 * backend's. Item-based splitting remains the route for separate checks.
 *
 * The suite shares one database and one server with every other spec, so the
 * fixtures it creates are unique per run and the tenant settings it pins are
 * restored.
 */

const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};

type Bill = {
  id: number;
  bill_number: string;
  split_group_id: string | null;
  split_label: string | null;
  payment_status: string;
  payment_details: string | { method: string; amount: number }[] | null;
  paid_amount: number | string;
  balance: number | string;
  total: number | string;
};

type DiscountSettings = {
  discount_mode: string;
  discount_requires_approval: boolean;
  discount_max_percentage: number;
  discount_max_amount: number;
};

type Fixture = {
  productId: string;
  productName: string;
  centProductId: string;
};

type PaymentAttempt = {
  status: number;
  body: { bill?: Bill };
  payments: { method: string; amount: number }[];
};

let splitSettingBefore = 'false';
let ordersLayoutBefore: E2EOrdersLayout = 'split';
const ordersLayoutToken = getE2eToken();

function minorAmount(value: number | string): number {
  return Number(value);
}

async function readSplitSetting(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${BASE}/api/settings/split_checks_enabled`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).setting?.value ?? 'false';
}

async function writeSplitSetting(request: APIRequestContext, value: string): Promise<void> {
  const response = await request.put(`${BASE}/api/settings/split_checks_enabled`, {
    headers: managerHeaders,
    data: { value },
    timeout: 5_000,
  });
  expect(response.ok()).toBeTruthy();
}

async function activeCategoryId(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${BASE}/api/categories`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  const categories = (await response.json()).categories as { id: string; is_active: boolean }[];
  const category = categories.find((candidate) => candidate.is_active);
  expect(category, 'an active category exists for the fixture products').toBeTruthy();
  return category!.id;
}

async function createProduct(
  request: APIRequestContext,
  categoryId: string,
  name: string,
  price: number,
): Promise<string> {
  const response = await request.post(`${BASE}/api/products`, {
    headers: managerHeaders,
    data: { name, category_id: categoryId, price, tax_category_id: null, tax_behavior: 'exempt' },
  });
  expect(response.status(), `the fixture product ${name} is created`).toBe(201);
  return (await response.json()).product.id as string;
}

/** A dine-in check whose total is exactly the product price times its quantity (the fixture carries no tax). */
async function createCheck(
  request: APIRequestContext,
  productId: string,
  note: string,
  guestCount = 3,
  options: { tableId?: string; quantity?: number } = {},
): Promise<{ id: number; order_number: string }> {
  const response = await request.post(`${BASE}/api/orders`, {
    headers: managerHeaders,
    data: {
      type: 'dine_in',
      guest_count: guestCount,
      special_instructions: note,
      items: [{ product_id: productId, quantity: options.quantity ?? 1 }],
      ...(options.tableId ? { table_id: options.tableId } : {}),
    },
  });
  expect(response.status(), 'the fixture order is created').toBe(201);
  return (await response.json()).order;
}

/**
 * A table for the POS caller, created on the same floor the floor-plan suite
 * works on and left unplaced. A table with no floor would add an unassigned
 * bucket ahead of every named floor and hide the placed tables of that suite.
 */
async function createPosTable(request: APIRequestContext, suffix: string): Promise<{ id: string; number: string }> {
  const letters = suffix.replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase() || 'XX';
  const number = `EQS-${letters}`;
  const response = await request.post(`${BASE}/api/tables`, {
    headers: managerHeaders,
    data: { number, name: number, capacity: 4, floor: 'Ground' },
  });
  expect(response.status(), 'the POS fixture table is created').toBe(201);
  return { id: (await response.json()).table.id as string, number };
}

async function readBills(request: APIRequestContext, orderId: number): Promise<Bill[]> {
  const response = await request.get(`${BASE}/api/bills?order_id=${orderId}`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).bills as Bill[];
}

async function readBill(request: APIRequestContext, billId: number): Promise<Bill> {
  const response = await request.get(`${BASE}/api/bills/${billId}`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).bill as Bill;
}

async function readOrder(request: APIRequestContext, orderId: number) {
  const response = await request.get(`${BASE}/api/orders/${orderId}`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).order as { status: string; items: { quantity: number }[] };
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
}

/** Opens the check from the Orders master/detail list and starts its checkout. */
async function openOrderCheckout(page: Page, orderNumber: string): Promise<void> {
  await page.goto(`${BASE}/orders`);
  const masterRow = page.getByRole('button').filter({ hasText: `#${orderNumber}` }).first();
  await expect(masterRow).toBeVisible();
  await masterRow.click();
  await page.getByRole('button', { name: /Checkout|Take Payment/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
}

function equalShareToggle(page: Page) {
  return page.getByRole('button', { name: 'Split payment equally' });
}

async function openEqualShare(page: Page): Promise<void> {
  await equalShareToggle(page).click();
  await expect(equalShareToggle(page)).toHaveAttribute('aria-expanded', 'true');
}

function payerCount(page: Page) {
  return page.getByLabel('Remaining payers');
}

async function setPayers(page: Page, value: string): Promise<void> {
  await payerCount(page).fill(value);
}

/** The previewed shares, largest first, with any currency symbol or grouping removed. */
async function shareAmounts(page: Page): Promise<string[]> {
  const rendered = await page.getByTestId(/^equal-share-share-/).allTextContents();
  return rendered.map((text) => {
    const amount = text.match(/\d[\d.,]*/);
    return amount ? amount[0].replace(/,/g, '') : text;
  });
}

/** The tender row of one payment method, including the badge below its input. */
function tenderRow(page: Page, method: string) {
  return page.getByTitle(method, { exact: true }).locator('..').locator('..');
}

async function tenderAmount(page: Page, method: string): Promise<string> {
  return tenderRow(page, method).getByRole('spinbutton').inputValue();
}

async function applyShareTo(page: Page, method: string): Promise<void> {
  await page.getByRole('button', { name: `Apply to ${method}` }).click();
}

/** The loyalty wallet row, which only exists for a customer with loyalty enabled. */
function walletRow(page: Page) {
  return page.getByRole('button', { name: 'Loyalty Wallet' }).locator('..');
}

/** Pays whatever is currently entered, answering the partial-payment confirmation. */
async function submitPayment(page: Page): Promise<PaymentAttempt> {
  const pending = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /^\/api\/bills\/[^/]+\/payments$/.test(new URL(response.url()).pathname)
  ));
  await page.getByRole('button', { name: /^Pay / }).click();
  const confirmButton = page.getByRole('button', { name: 'Pay', exact: true });
  if (await confirmButton.count()) await confirmButton.click();
  const response = await pending;
  return {
    status: response.status(),
    body: await response.json(),
    payments: (response.request().postDataJSON()?.payments ?? []) as { method: string; amount: number }[],
  };
}

function recordedPayments(bill: Bill): { method: string; amount: number }[] {
  const details = bill.payment_details;
  if (!details) return [];
  return typeof details === 'string' ? JSON.parse(details) : details;
}

function paymentRequestBodies(page: Page): unknown[] {
  const bodies: unknown[] = [];
  page.on('request', (browserRequest) => {
    if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(new URL(browserRequest.url()).pathname)) {
      bodies.push(browserRequest.postDataJSON());
    }
  });
  return bodies;
}

test.describe('equal share payments', () => {
  let fixture: Fixture;

  test.beforeAll(async ({ request }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const categoryId = await activeCategoryId(request);
    fixture = {
      productId: await createProduct(request, categoryId, `Equal share platter ${suffix}`, 100),
      productName: `Equal share platter ${suffix}`,
      centProductId: await createProduct(request, categoryId, `Equal share cent ${suffix}`, 0.01),
    };
  });

  test.afterAll(async ({ request }) => {
    // The suite shares a database; the fixture products are soft-deleted so no
    // later spec sees them in the catalog.
    await request.delete(`${BASE}/api/products/${fixture.productId}`, { headers: managerHeaders });
    await request.delete(`${BASE}/api/products/${fixture.centProductId}`, { headers: managerHeaders });
  });

  test.beforeEach(async ({ page, request }) => {
    splitSettingBefore = await readSplitSetting(request);
    ordersLayoutBefore = await readOrdersLayout(page, BASE, ordersLayoutToken);
    await writeSplitSetting(request, 'false');
    await setOrdersLayout(page, 'split', BASE, ordersLayoutToken);
  });

  test.afterEach(async ({ page, request }) => {
    const failures: unknown[] = [];
    try { await writeSplitSetting(request, splitSettingBefore); } catch (error) { failures.push(error); }
    try { await setOrdersLayout(page, ordersLayoutBefore, BASE, ordersLayoutToken); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  });

  test('three diners settle one check as 33.34, 33.33 and 33.33', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share three diners', 3);
    const printRequests: string[] = [];
    page.on('request', (browserRequest) => {
      if (new URL(browserRequest.url()).pathname.startsWith('/api/printers/print')) {
        printRequests.push(new URL(browserRequest.url()).pathname);
      }
    });

    await login(page);
    await openOrderCheckout(page, order.order_number);
    const [bill] = await readBills(request, order.id);
    expect(minorAmount(bill.balance), 'the fixture check balances at exactly 100.00').toBe(100);

    // The payer count starts from the order's guest count and previews every share.
    await openEqualShare(page);
    await expect(payerCount(page)).toHaveValue('3');
    expect(await shareAmounts(page)).toEqual(['33.34', '33.33', '33.33']);
    await expect(page.getByTestId('equal-share-total')).toContainText('100.00');
    await expect(
      page.getByText('Shares differ by one smallest currency unit; the total is unchanged.'),
      'an uneven split explains the one-unit difference',
    ).toBeVisible();

    // Applying a share only fills the tender the cashier chose.
    await applyShareTo(page, 'Cash');
    expect(await tenderAmount(page, 'Cash')).toBe('33.34');
    await expect(tenderRow(page, 'Cash')).toContainText('Equal share');
    // A share is the amount applied to the bill, not cash handed over: the
    // whole-bill change stays zero instead of a per-share refund being invented.
    await expect(
      page.getByText('Change Returned').locator('..').locator('..'),
      'a share never invents change of its own',
    ).toContainText('0.00');
    expect(await paymentRequestBodies(page)).toEqual([]);

    const first = await submitPayment(page);
    expect(first.status).toBe(200);
    expect(first.payments, 'the applied share is submitted as its own stored amount').toEqual([{ method: 'cash', amount: 33.34 }]);
    expect(minorAmount(first.body.bill!.balance)).toBe(66.66);
    expect(first.body.bill!.payment_status).toBe('partial');

    // The paid payer is done: the count advances only after the committed share.
    await expect(payerCount(page)).toHaveValue('2');
    expect(await shareAmounts(page)).toEqual(['33.33', '33.33']);
    await expect(tenderRow(page, 'Cash')).not.toContainText('Equal share');
    expect(await tenderAmount(page, 'Cash')).toBe('');

    await applyShareTo(page, 'Cash');
    const second = await submitPayment(page);
    expect(minorAmount(second.body.bill!.balance)).toBe(33.33);

    // One payer left: the shortcut stands down and the balance is collected normally.
    await expect(payerCount(page)).toHaveCount(0);
    await expect(
      page.getByText('One payer remains; collect the remaining balance as a normal payment.'),
    ).toBeVisible();
    await page.getByTitle('Cash', { exact: true }).click();
    expect(await tenderAmount(page, 'Cash')).toBe('33.33');
    const third = await submitPayment(page);
    expect(third.body.bill!.payment_status).toBe('paid');

    const settled = await readBill(request, bill.id);
    expect(recordedPayments(settled).map((payment) => payment.amount)).toEqual([33.34, 33.33, 33.33]);
    expect(recordedPayments(settled).every((payment) => payment.method === 'cash')).toBe(true);
    expect(minorAmount(settled.paid_amount)).toBe(100);
    expect(minorAmount(settled.balance)).toBe(0);

    // Equal shares are one bill's payments: no sibling checks, no fractional items, no printing.
    const bills = await readBills(request, order.id);
    expect(bills).toHaveLength(1);
    expect(bills[0].split_group_id).toBeNull();
    const completedOrder = await readOrder(request, order.id);
    expect(completedOrder.items).toHaveLength(1);
    expect(completedOrder.items.every((item) => Number.isInteger(Number(item.quantity)))).toBe(true);
    expect(completedOrder.status).toBe('completed');
    expect(printRequests).toEqual([]);
  });

  test('payer count stays fixed while an equal-share payment is pending', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share pending payment', 3);
    await login(page);
    await openOrderCheckout(page, order.order_number);
    await openEqualShare(page);
    await applyShareTo(page, 'Cash');
    await tenderRow(page, 'Cash').getByRole('spinbutton').focus();
    await expect(page.locator('[aria-label="Numeric keypad"]')).toBeVisible();

    let releaseRequest = () => {};
    let signalRequest = () => {};
    const intercepted = new Promise<void>((resolve) => { signalRequest = resolve; });
    await page.route('**/api/bills/*/payments', async (route) => {
      await new Promise<void>((resolve) => {
        releaseRequest = resolve;
        signalRequest();
      });
      await route.continue();
    });

    const pendingPayment = submitPayment(page);
    try {
      await intercepted;
      await expect(payerCount(page)).toBeDisabled();
      await expect(tenderRow(page, 'Cash').getByRole('spinbutton')).toBeDisabled();
      await expect(page.getByTitle('Cash', { exact: true })).toBeDisabled();
      await expect(page.locator('[aria-label="Numeric keypad"]')).toHaveCount(0);
    } finally {
      releaseRequest();
    }

    const payment = await pendingPayment;
    expect(payment.payments).toEqual([{ method: 'cash', amount: 33.34 }]);
    await expect(payerCount(page)).toHaveValue('2');
    await page.unroute('**/api/bills/*/payments');
  });

  test('the shortcut is independent of item splitting', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share splitting independent', 3, { quantity: 3 });
    const splitRequests: string[] = [];
    page.on('request', (browserRequest) => {
      if (browserRequest.method() === 'POST' && /\/split-check$/.test(new URL(browserRequest.url()).pathname)) {
        splitRequests.push(new URL(browserRequest.url()).pathname);
      }
    });

    await login(page);
    await openOrderCheckout(page, order.order_number);

    // Item splitting is off: the equal-share shortcut is still offered.
    await expect(page.getByRole('button', { name: 'Split check' })).toHaveCount(0);
    await openEqualShare(page);
    await expect(payerCount(page)).toHaveValue('3');

    await writeSplitSetting(request, 'true');
    await page.getByRole('button', { name: 'Close' }).click();
    await openOrderCheckout(page, order.order_number);

    // Both actions stand side by side; using one never triggers the other.
    await expect(page.getByRole('button', { name: 'Split check' })).toBeVisible();
    await expect(equalShareToggle(page)).toBeVisible();
    await openEqualShare(page);
    await expect(page.getByRole('button', { name: 'Apply to Cash' })).toBeVisible();
    await expect(page.getByText('Select at least one item for the leaving guest')).toHaveCount(0);
    expect(splitRequests).toEqual([]);

    const bills = await readBills(request, order.id);
    expect(bills).toHaveLength(1);
    expect(minorAmount(bills[0].paid_amount)).toBe(0);
  });

  test('impossible payer counts are refused before anything is applied', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share invalid counts');
    const centOrder = await createCheck(request, fixture.centProductId, 'Equal share tiny balance');

    await login(page);
    await openOrderCheckout(page, order.order_number);
    await openEqualShare(page);

    for (const invalid of ['', '1', '21', '2.5']) {
      await setPayers(page, invalid);
      await expect(
        page.getByText('Enter a whole number of 2 to 20 payers'),
        `payer count ${JSON.stringify(invalid)} is refused`,
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Apply to Cash' }),
        `no share is offered for payer count ${JSON.stringify(invalid)}`,
      ).toHaveCount(0);
    }
    expect(await paymentRequestBodies(page)).toEqual([]);

    // Twenty payers is the ceiling and still divides evenly.
    await setPayers(page, '20');
    expect(await shareAmounts(page)).toEqual(Array(20).fill('5.00'));

    // Closing the preview cancels it: nothing was applied and nothing is owed.
    await page.getByRole('button', { name: 'Close' }).click();
    await openOrderCheckout(page, order.order_number);
    expect(await tenderAmount(page, 'Cash')).toBe('');
    expect(await paymentRequestBodies(page)).toEqual([]);

    // A balance with fewer minor units than the minimum payer count cannot be divided.
    await page.getByRole('button', { name: 'Close' }).click();
    await openOrderCheckout(page, centOrder.order_number);
    await openEqualShare(page);
    await setPayers(page, '2');
    await expect(page.getByText('The balance is too small to divide between that many payers')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply to Cash' })).toHaveCount(0);
  });

  test('other tenders and a wallet amount block applying until they are cleared', async ({ page, request }) => {
    const customerResponse = await request.post(`${BASE}/api/customers`, {
      headers: managerHeaders,
      data: { name: 'Equal Share Diner', phone: `0812${Math.floor(Math.random() * 1e6).toString().padStart(6, '0')}` },
    });
    expect(customerResponse.status(), 'the fixture customer is created').toBe(201);
    const customerId = (await customerResponse.json()).customer.id as string;

    const orderResponse = await request.post(`${BASE}/api/orders`, {
      headers: managerHeaders,
      data: {
        type: 'dine_in',
        guest_count: 2,
        special_instructions: 'Equal share blocked tenders',
        customer_id: customerId,
        items: [{ product_id: fixture.productId, quantity: 1 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = await orderResponse.json().then((body) => body.order);

    // The wallet row is driven by the loyalty settings and the wallet balance.
    await page.route('**/api/settings/loyalty', (route) => route.fulfill({ json: { loyalty_enabled: true } }));
    await page.route('**/api/customers/*/wallet', (route) => route.fulfill({ json: { balance: 500 } }));

    await login(page);
    await openOrderCheckout(page, order.order_number);
    await openEqualShare(page);
    await setPayers(page, '2');
    await expect(page.getByText('Apply to Cash')).toBeVisible();

    // A wallet amount is money for this bill: applying a share would silently drop it.
    await page.getByRole('button', { name: 'Loyalty Wallet' }).click();
    expect(await walletRow(page).getByRole('spinbutton').inputValue()).not.toBe('');
    await expect(page.getByText('Clear the other amounts before applying a share')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply to Cash' })).toBeDisabled();
    expect(await tenderAmount(page, 'Cash')).toBe('');

    // Clearing it unblocks applying, and a second tender row starts a new conflict.
    await walletRow(page).getByRole('spinbutton').fill('');
    await expect(page.getByRole('button', { name: 'Apply to Cash' })).toBeEnabled();
    await applyShareTo(page, 'Cash');
    expect(await tenderAmount(page, 'Cash'), 'two payers split 100.00 evenly').toBe('50');
    await tenderRow(page, 'Card').getByRole('spinbutton').fill('5');
    await expect(page.getByText('Clear the other amounts before applying a share')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply to Cash' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply to Card' })).toBeDisabled();
    expect(await tenderAmount(page, 'Cash'), 'the applied share is never discarded on its own').toBe('50');

    await page.unroute('**/api/settings/loyalty');
    await page.unroute('**/api/customers/*/wallet');
  });

  test('an enabled custom payment method can take the share', async ({ page, request }) => {
    const methodName = `Equal Share Wallet ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created = await request.post(`${BASE}/api/payment-methods`, {
      headers: managerHeaders,
      data: { name: methodName },
    });
    expect(created.status(), 'the custom payment method is created').toBe(201);
    const methodId = (await created.json()).payment_method.id as number;
    const order = await createCheck(request, fixture.productId, 'Equal share custom method', 2);

    try {
      await login(page);
      await openOrderCheckout(page, order.order_number);
      await openEqualShare(page);
      await setPayers(page, '2');
      await applyShareTo(page, methodName);
      expect(await tenderAmount(page, methodName)).toBe('50');

      const share = await submitPayment(page);
      expect(share.payments).toEqual([{ method: 'custom', payment_method_id: methodId, amount: 50 }]);
      expect(minorAmount(share.body.bill!.balance)).toBe(50);
      const [bill] = await readBills(request, order.id);
      expect(recordedPayments(bill)).toHaveLength(1);
      expect(recordedPayments(bill)[0].amount).toBe(50);
    } finally {
      // A method with recorded payments cannot be deleted, so it is disabled.
      await request.put(`${BASE}/api/payment-methods/${methodId}`, {
        headers: managerHeaders,
        data: { is_active: false },
      });
    }
  });

  test('a changed balance invalidates the applied share, an edited one becomes a custom payment', async ({ page, request }) => {
    const settingsResponse = await request.get(`${BASE}/api/settings/discount`, { headers: managerHeaders });
    expect(settingsResponse.ok()).toBeTruthy();
    const settingsBefore = (await settingsResponse.json()) as DiscountSettings;
    const writeDiscount = (mode: string) => request.put(`${BASE}/api/settings/discount`, {
      headers: managerHeaders,
      data: { ...settingsBefore, discount_mode: mode, discount_requires_approval: false, discount_max_percentage: 100 },
    });

    const order = await createCheck(request, fixture.productId, 'Equal share balance change', 2);
    try {
      expect((await writeDiscount('percentage')).status()).toBe(200);
      await login(page);
      await openOrderCheckout(page, order.order_number);
      await openEqualShare(page);
      await setPayers(page, '2');
      await applyShareTo(page, 'Cash');
      expect(await tenderAmount(page, 'Cash')).toBe('50');
      await expect(tenderRow(page, 'Cash')).toContainText('Equal share');

      const discountValue = page.getByRole('spinbutton', { name: '0', exact: true });
      await page.getByRole('button', { name: 'Apply Discount' }).click();
      await discountValue.fill('10');
      await page.getByRole('button', { name: 'Apply Discount' }).last().click();
      await expect(page.getByText('Discount updated')).toBeVisible();

      // The balance moved, so the stale share is withdrawn and must be reapplied.
      await expect(page.getByText('The balance changed. Review and apply the share again.')).toBeVisible();
      expect(await tenderAmount(page, 'Cash')).toBe('');
      await expect(tenderRow(page, 'Cash')).not.toContainText('Equal share');
      await expect(page.getByRole('button', { name: /^Pay / })).toBeDisabled();

      await expect(equalShareToggle(page), 'the preview stays open for the reapplication').toHaveAttribute('aria-expanded', 'true');
      await applyShareTo(page, 'Cash');
      expect(await tenderAmount(page, 'Cash'), '90.00 over two payers').toBe('45');

      // An edited share is the cashier's own amount: it is no longer an equal share.
      await tenderRow(page, 'Cash').getByRole('spinbutton').fill('55');
      await expect(tenderRow(page, 'Cash')).not.toContainText('Equal share');

      // And a later balance change leaves that typed amount alone.
      await discountValue.fill('20');
      await page.getByRole('button', { name: 'Update Discount' }).click();
      await expect(page.getByText('Discount updated')).toBeVisible();
      expect(await tenderAmount(page, 'Cash'), 'a manually typed amount is preserved').toBe('55');
    } finally {
      await writeDiscount(settingsBefore.discount_mode);
    }
  });

  test('discount and payment balance changes cannot overlap', async ({ page, request }) => {
    const settingsResponse = await request.get(`${BASE}/api/settings/discount`, { headers: managerHeaders });
    expect(settingsResponse.ok()).toBeTruthy();
    const settingsBefore = (await settingsResponse.json()) as DiscountSettings;
    const writeDiscount = (mode: string) => request.put(`${BASE}/api/settings/discount`, {
      headers: managerHeaders,
      data: { ...settingsBefore, discount_mode: mode, discount_requires_approval: false, discount_max_percentage: 100 },
    });
    const order = await createCheck(request, fixture.productId, 'Equal share concurrent discount', 2);
    const discountPath = `/api/orders/${order.id}/discount`;
    let discountRequests = 0;

    try {
      expect((await writeDiscount('percentage')).status()).toBe(200);
      await login(page);
      await openOrderCheckout(page, order.order_number);
      await openEqualShare(page);
      await setPayers(page, '2');
      await applyShareTo(page, 'Cash');

      const discountValue = page.getByRole('spinbutton', { name: '0', exact: true });
      await page.getByRole('button', { name: 'Apply Discount' }).click();
      await discountValue.fill('10');
      page.on('request', (browserRequest) => {
        if (browserRequest.method() === 'PATCH' && new URL(browserRequest.url()).pathname === discountPath) discountRequests += 1;
      });

      let releaseDiscount = () => {};
      let signalDiscount = () => {};
      const discountIntercepted = new Promise<void>((resolve) => { signalDiscount = resolve; });
      await page.route(`**${discountPath}`, async (route) => {
        await new Promise<void>((resolve) => {
          releaseDiscount = resolve;
          signalDiscount();
        });
        await route.continue();
      });
      const pendingDiscount = page.getByRole('button', { name: 'Apply Discount' }).last().click();
      try {
        await discountIntercepted;
        await expect(page.getByRole('button', { name: /^Pay / })).toBeDisabled();
      } finally {
        releaseDiscount();
      }
      await pendingDiscount;
      await page.unroute(`**${discountPath}`);
      await expect(page.getByText('Discount updated')).toBeVisible();
      await expect(page.getByText('The balance changed. Review and apply the share again.')).toBeVisible();

      await applyShareTo(page, 'Cash');
      expect(await tenderAmount(page, 'Cash')).toBe('45');
      await discountValue.fill('20');

      let releasePayment = () => {};
      let signalPayment = () => {};
      const paymentIntercepted = new Promise<void>((resolve) => { signalPayment = resolve; });
      await page.route('**/api/bills/*/payments', async (route) => {
        await new Promise<void>((resolve) => {
          releasePayment = resolve;
          signalPayment();
        });
        await route.continue();
      });
      const pendingPayment = submitPayment(page);
      try {
        await paymentIntercepted;
        await expect(page.getByRole('button', { name: 'Update Discount' })).toBeDisabled();
      } finally {
        releasePayment();
      }

      const payment = await pendingPayment;
      expect(payment.payments).toEqual([{ method: 'cash', amount: 45 }]);
      expect(minorAmount(payment.body.bill!.balance)).toBe(45);
      expect(discountRequests).toBe(1);
    } finally {
      await writeDiscount(settingsBefore.discount_mode);
    }
  });

  test('an earlier partial payment leaves only the remaining balance to split', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share after partial payment', 3);
    await login(page);
    await openOrderCheckout(page, order.order_number);
    const [bill] = await readBills(request, order.id);

    // 40.00 collected up front, leaving 60.00 for the diners still at the table.
    await tenderRow(page, 'Cash').getByRole('spinbutton').fill('40');
    const upFront = await submitPayment(page);
    expect(minorAmount(upFront.body.bill!.balance)).toBe(60);
    // The collected tender entry stays on screen, so the cashier clears it.
    await tenderRow(page, 'Cash').getByRole('spinbutton').fill('');

    await openEqualShare(page);
    await setPayers(page, '2');
    expect(await shareAmounts(page)).toEqual(['30.00', '30.00']);
    await applyShareTo(page, 'Card');
    const firstShare = await submitPayment(page);
    expect(firstShare.payments).toEqual([{ method: 'card', amount: 30 }]);
    expect(minorAmount(firstShare.body.bill!.balance)).toBe(30);

    // The second payer was the last one, so the shortcut stands down.
    await expect(payerCount(page)).toHaveCount(0);
    await expect(page.getByText('One payer remains; collect the remaining balance as a normal payment.')).toBeVisible();

    // Closing and reopening re-reads the authoritative balance and asks again:
    // the payer count is session state, never a durable guest roster.
    await page.getByRole('button', { name: 'Close' }).click();
    await openOrderCheckout(page, order.order_number);
    await openEqualShare(page);
    await expect(payerCount(page), 'the count restarts from the order, not from the last session').toHaveValue('3');
    expect(await shareAmounts(page)).toEqual(['10.00', '10.00', '10.00']);
    expect(await tenderAmount(page, 'Card')).toBe('');

    const settled = await readBill(request, bill.id);
    expect(recordedPayments(settled).map((payment) => payment.amount)).toEqual([40, 30]);
    expect(minorAmount(settled.balance)).toBe(30);
  });

  test('an uncertain response keeps the request key and never advances the count', async ({ page, request }) => {
    test.setTimeout(60_000);
    const order = await createCheck(request, fixture.productId, 'Equal share uncertain response', 3);
    const keys: (string | undefined)[] = [];
    page.on('request', (browserRequest) => {
      if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(new URL(browserRequest.url()).pathname)) {
        keys.push(browserRequest.headers()['idempotency-key']);
      }
    });

    await login(page);
    await openOrderCheckout(page, order.order_number);
    const [bill] = await readBills(request, order.id);
    await openEqualShare(page);
    await setPayers(page, '3');
    await applyShareTo(page, 'Cash');

    // The connection drops after the request left the browser.
    await page.route('**/api/bills/*/payments', (route) => route.abort('failed'));
    await page.getByRole('button', { name: /^Pay / }).click();
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.getByText('Payment failed')).toBeVisible({ timeout: 15000 });

    // Nothing advanced: same amount, same count, same application.
    expect(await tenderAmount(page, 'Cash')).toBe('33.34');
    await expect(payerCount(page)).toHaveValue('3');
    await expect(tenderRow(page, 'Cash')).toContainText('Equal share');
    expect(keys).toHaveLength(1);

    await page.unroute('**/api/bills/*/payments');
    const retry = await submitPayment(page);
    expect(retry.status).toBe(200);
    expect(keys).toHaveLength(2);
    expect(keys[1], 'the retry of an uncertain request reuses its idempotency key').toBe(keys[0]);

    // Exactly one share reached the ledger, and only then did the count advance.
    const settled = await readBill(request, bill.id);
    expect(recordedPayments(settled).map((payment) => payment.amount)).toEqual([33.34]);
    expect(minorAmount(settled.balance)).toBe(66.66);
    await expect(payerCount(page)).toHaveValue('2');
  });

  test('the POS table checkout collects the same equal shares', async ({ page, request }) => {
    test.setTimeout(60_000);
    const table = await createPosTable(request, Math.random().toString(36).slice(2, 8));
    const order = await createCheck(request, fixture.productId, 'Equal share POS table', 2, { tableId: table.id });
    const printRequests: string[] = [];
    page.on('request', (browserRequest) => {
      if (new URL(browserRequest.url()).pathname.startsWith('/api/printers/print')) {
        printRequests.push(new URL(browserRequest.url()).pathname);
      }
    });

    // The POS table picker is offered when the tenant requires a table per check.
    const tablesRequiredBefore = await readSetting(request, 'tables_required');
    try {
      await writeSetting(request, 'tables_required', 'true');
      await login(page);
      await page.goto(`${BASE}/pos`);
      await page.getByRole('button', { name: 'Select table' }).click();
      await page.getByRole('button', { name: new RegExp(table.number) }).click();
      await expect(page.getByRole('heading', { name: table.number })).toBeVisible();
      await page.getByRole('button', { name: 'Checkout' }).click();
      await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();

      const [bill] = await readBills(request, order.id);
      expect(minorAmount(bill.balance)).toBe(100);
      await openEqualShare(page);
      await expect(payerCount(page)).toHaveValue('2');
      expect(await shareAmounts(page)).toEqual(['50.00', '50.00']);
      await applyShareTo(page, 'Cash');
      const first = await submitPayment(page);
      expect(minorAmount(first.body.bill!.balance)).toBe(50);

      // A partial payment settles nothing: the order stays open until the bill is paid.
      const midway = await readOrder(request, order.id);
      expect(midway.status).not.toBe('completed');
      const bills = await readBills(request, order.id);
      expect(bills).toHaveLength(1);
      expect(minorAmount(bills[0].paid_amount)).toBe(50);

      await page.getByTitle('Cash', { exact: true }).click();
      const second = await submitPayment(page);
      expect(second.body.bill!.payment_status).toBe('paid');
      expect((await readOrder(request, order.id)).status).toBe('completed');
    } finally {
      await writeSetting(request, 'tables_required', tablesRequiredBefore ?? 'false');
      await request.post(`${BASE}/api/tables/${table.id}/deactivate`, { headers: managerHeaders }).catch(() => {});
    }
    expect(printRequests).toEqual([]);
  });

  test('splitting off a guest never routes a payment to the old remainder', async ({ page, request }) => {
    await writeSplitSetting(request, 'true');
    const order = await createCheck(request, fixture.productId, 'Equal share remainder race', 3, { quantity: 3 });
    const paymentRequests: string[] = [];
    page.on('request', (browserRequest) => {
      if (browserRequest.method() === 'POST' && /\/payments$/.test(new URL(browserRequest.url()).pathname)) {
        paymentRequests.push(new URL(browserRequest.url()).pathname);
      }
    });

    await login(page);
    await openOrderCheckout(page, order.order_number);
    const [remainder] = await readBills(request, order.id);

    // The departing check's fetch and the list refresh are held open so the
    // window between the split and the next payment screen stays visible.
    await page.route('**/api/bills/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await page.route('**/api/orders?*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });

    await page.getByRole('button', { name: 'Split check' }).click();
    await page.getByRole('button', { name: 'Selected items' }).click();
    await page.getByRole('row').filter({ hasText: fixture.productName }).getByRole('spinbutton').fill('1');
    await page.getByRole('button', { name: 'Create checks' }).click();

    // The check that was just split must not be payable while the departing one loads.
    await expect(page.getByRole('heading', { name: 'Payment' })).toHaveCount(1);
    const payButton = page.getByRole('button', { name: /^Pay / }).first();
    if (await payButton.count()) {
      await payButton.dblclick({ force: true, timeout: 1500 }).catch(() => undefined);
    }
    expect(paymentRequests, 'no payment targets any check during the handoff').toEqual([]);

    await page.unroute('**/api/bills/*');
    await page.unroute('**/api/orders?*');
    await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();

    const afterSplit = await readBills(request, order.id);
    expect(afterSplit).toHaveLength(2);
    const untouchedRemainder = afterSplit.find((candidate) => candidate.id === remainder.id)!;
    expect(untouchedRemainder.payment_status).toBe('unpaid');
    expect(minorAmount(untouchedRemainder.paid_amount)).toBe(0);
    expect(paymentRequests).toEqual([]);
  });

  test('the equal-share controls stay reachable by keyboard on a narrow screen', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share keyboard reach', 3);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openOrderCheckout(page, order.order_number);

    await equalShareToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(equalShareToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(equalShareToggle(page)).toBeInViewport();

    await payerCount(page).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('3');
    await expect(payerCount(page)).toHaveValue('3');

    const applyButton = page.getByRole('button', { name: 'Apply to Cash' });
    await applyButton.focus();
    await expect(applyButton).toBeInViewport();
    await page.keyboard.press('Enter');
    expect(await tenderAmount(page, 'Cash')).toBe('33.34');
  });

  test('an abandoned preview changes nothing and the count is asked again on reopen', async ({ page, request }) => {
    const order = await createCheck(request, fixture.productId, 'Equal share abandoned preview', 3);
    const paymentBodies = paymentRequestBodies(page);

    await login(page);
    await openOrderCheckout(page, order.order_number);
    await openEqualShare(page);
    await setPayers(page, '4');
    expect(await shareAmounts(page)).toEqual(['25.00', '25.00', '25.00', '25.00']);
    await applyShareTo(page, 'Cash');
    expect(await tenderAmount(page, 'Cash')).toBe('25');

    // Applying a share only fills the entry, so closing the dialog without
    // paying records nothing at all.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toHaveCount(0);
    expect(paymentBodies).toEqual([]);
    const untouched = await readBills(request, order.id);
    expect(untouched).toHaveLength(1);
    expect(untouched[0].payment_status).toBe('unpaid');
    expect(minorAmount(untouched[0].paid_amount)).toBe(0);
    expect(minorAmount(untouched[0].balance)).toBe(100);

    // Reopening reads the authoritative balance and asks for the count again:
    // the preview, the applied share and the payer roster are session-only.
    await openOrderCheckout(page, order.order_number);
    await expect(equalShareToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(payerCount(page)).toHaveCount(0);
    await openEqualShare(page);
    await expect(payerCount(page)).toHaveValue('3');
    expect(await tenderAmount(page, 'Cash')).toBe('');
  });
});
