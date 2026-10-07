import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setOrdersLayout,
  setLanguage,
  type E2EOrdersLayout,
} from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { FIXTURE_PRODUCT_NAME, ensureUatFixture, orderItem } from './helpers/kitchen-fixture';

/**
 * Repeatable guest checkout on one dine-in table.
 *
 * The cashier picks the items the leaving guest is paying for; every other
 * quantity stays on an unpaid check that can be divided again when the next
 * guest leaves. The paid checks keep their own totals and are never offered for
 * selection again, so a three-guest table settles as three separate payments and
 * the order only completes once the last check is paid.
 *
 * Split checks are opt-in per tenant, so each spec pins `split_checks_enabled`
 * through the real settings API and restores it in `afterEach` (the suite shares
 * one database and one server).
 */

const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};

type GuestBill = {
  id: number;
  split_label: string | null;
  split_group_id: string | null;
  payment_status: string;
  balance: number | string;
  paid_amount: number | string;
  discount_amount: number | string | null;
  total: number | string;
};

let splitSettingBefore = 'false';
let ordersLayoutBefore: E2EOrdersLayout = 'split';
const ordersLayoutToken = getE2eToken();

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

/** Three guests share three units of the same product, so a fair split is 1/1/1. */
async function createThreeGuestTable(request: APIRequestContext, note: string): Promise<{ id: number; order_number: string }> {
  const response = await request.post(`${BASE}/api/orders`, {
    headers: managerHeaders,
    data: {
      type: 'dine_in',
      guest_count: 3,
      special_instructions: note,
      items: [{ product_id: 'e2e-product', quantity: 3 }],
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).order;
}

async function readOrderBills(request: APIRequestContext, orderId: number): Promise<GuestBill[]> {
  const response = await request.get(`${BASE}/api/bills?order_id=${orderId}`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).bills as GuestBill[];
}

async function login(page: Page, email = 'manager@flo.local', syncLanguage = true): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  if (syncLanguage) await setLanguage(page, 'en');
}

/** Opens the order in the detail pane (split layout) and starts its checkout. */
async function openOrderCheckout(page: Page, orderNumber: string): Promise<void> {
  await page.goto(`${BASE}/orders`);
  const masterRow = page.getByRole('button').filter({ hasText: `#${orderNumber}` });
  await expect(masterRow).toBeVisible();
  await masterRow.click();
  await page.getByRole('button', { name: /Checkout|Take Payment/ }).click();
}

/** The unpaid check's Pay action in the detail pane drives the next guest. */
async function payUnpaidCheck(page: Page, orderNumber: string, index?: number): Promise<void> {
  await page.goto(`${BASE}/orders`);
  const masterRow = page.getByRole('button').filter({ hasText: `#${orderNumber}` });
  await expect(masterRow).toBeVisible();
  await masterRow.click();
  const payButtons = page.getByRole('button', { name: 'Pay', exact: true });
  await (index === undefined ? payButtons : payButtons.nth(index)).click();
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
}

/** Enters a whole quantity on one editor row and confirms it stuck. */
async function setRowQuantity(row: Locator, quantity: number): Promise<void> {
  const input = row.getByRole('spinbutton');
  await input.fill(String(quantity));
  await expect(input).toHaveValue(String(quantity));
}

/** Selects a whole quantity for the leaving guest in the selected-items editor. */
async function selectGuestQuantity(page: Page, itemName: string, quantity: number): Promise<void> {
  await setRowQuantity(page.getByRole('row').filter({ hasText: itemName }), quantity);
}

/** Reads one bill's authoritative projection, including its own item lines. */
async function readBillDetail(request: APIRequestContext, billId: number): Promise<{ bill: GuestBill & { order: { items: { id: number; quantity: number; product_name: string }[] } } }> {
  const response = await request.get(`${BASE}/api/bills/${billId}`, { headers: managerHeaders });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function submitGuestSplit(page: Page): Promise<void> {
  const splitResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && /^\/api\/bills\/[^/]+\/split-check$/.test(url.pathname);
  });
  await page.getByRole('button', { name: 'Create checks' }).click();
  expect((await splitResponse).status()).toBe(201);
}

/** The amount the modal routed to payment, as the currency label renders it. */
function amountLabel(value: number): string {
  return value.toFixed(2);
}

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

async function finishPayment(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Done' }).click();
}

test.beforeEach(async ({ page, request }) => {
  splitSettingBefore = await readSplitSetting(request);
  ordersLayoutBefore = await readOrdersLayout(page, BASE, ordersLayoutToken);
  await writeSplitSetting(request, 'true');
});

test.afterEach(async ({ page, request }) => {
  const failures: unknown[] = [];
  try { await writeSplitSetting(request, splitSettingBefore); } catch (error) { failures.push(error); }
  try { await setOrdersLayout(page, ordersLayoutBefore, BASE, ordersLayoutToken); } catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
});

test('three guests leave in sequence, each paying only their own selected items', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout three diners');
  const printRequests: string[] = [];
  page.on('request', (browserRequest) => {
    if (new URL(browserRequest.url()).pathname.startsWith('/api/printers/print')) {
      printRequests.push(new URL(browserRequest.url()).pathname);
    }
  });

  // Three equal units, so each guest carries a third of the check.
  const orderResponse = await request.get(`${BASE}/api/orders/${order.id}`, { headers: managerHeaders });
  expect(orderResponse.ok()).toBeTruthy();
  const orderTotal = Number((await orderResponse.json()).order.total);
  const perGuest = Number((orderTotal / 3).toFixed(2));

  await login(page);

  // Guest 1 pays one unit and leaves the other two on the unpaid remainder.
  await openOrderCheckout(page, order.order_number);
  await expect(page.getByRole('button', { name: 'Split check' })).toBeVisible();
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  const billsBeforeFirstSplit = await readOrderBills(request, order.id);
  await submitGuestSplit(page);

  // The split hands the leaving guest straight to the ordinary payment screen.
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  const [guestOne] = (await readOrderBills(request, order.id))
    .filter((bill) => !billsBeforeFirstSplit.some((before) => before.id === bill.id));
  expect(Number(guestOne.total)).toBe(perGuest);
  await settleInCash(page, amountLabel(Number(guestOne.balance)));
  await finishPayment(page);

  const afterFirstGuest = await readOrderBills(request, order.id);
  expect(afterFirstGuest).toHaveLength(2);
  const paidBills = afterFirstGuest.filter((bill) => bill.payment_status === 'paid');
  const unpaidBills = afterFirstGuest.filter((bill) => bill.payment_status === 'unpaid');
  expect(paidBills).toHaveLength(1);
  expect(Number(paidBills[0].total)).toBe(perGuest);
  expect(unpaidBills).toHaveLength(1);
  expect(Number(unpaidBills[0].total)).toBe(Number((perGuest * 2).toFixed(2)));
  // A split is not a charge: nothing was paid on the remainder and nothing printed.
  expect(Number(unpaidBills[0].paid_amount)).toBe(0);
  expect(printRequests).toEqual([]);

  // Guest 2 divides the untouched unpaid remainder and pays one unit.
  await payUnpaidCheck(page, order.order_number);
  await expect(page.getByRole('button', { name: 'Split check' })).toBeVisible();
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  await submitGuestSplit(page);
  const guestTwo = (await readOrderBills(request, order.id))
    .find((bill) => !afterFirstGuest.some((before) => before.id === bill.id));
  expect(Number(guestTwo?.total)).toBe(perGuest);
  await settleInCash(page, amountLabel(Number(guestTwo?.balance)));
  await finishPayment(page);

  const afterSecondGuest = await readOrderBills(request, order.id);
  expect(afterSecondGuest.filter((bill) => bill.payment_status === 'paid')).toHaveLength(2);
  const lastRemainder = afterSecondGuest.filter((bill) => bill.payment_status === 'unpaid');
  expect(lastRemainder).toHaveLength(1);
  expect(Number(lastRemainder[0].total)).toBe(perGuest);
  expect(Number(lastRemainder[0].paid_amount)).toBe(0);

  // Guest 3 pays the last check as it stands, with no split left to make.
  await payUnpaidCheck(page, order.order_number);
  await settleInCash(page, amountLabel(Number(lastRemainder[0].balance)));
  await finishPayment(page);

  const settled = await readOrderBills(request, order.id);
  expect(settled).toHaveLength(3);
  expect(settled.every((bill) => bill.payment_status === 'paid')).toBe(true);
  expect(settled.every((bill) => Number(bill.paid_amount) === perGuest)).toBe(true);
  expect(Number(settled.reduce((sum, bill) => sum + Number(bill.paid_amount), 0).toFixed(2))).toBe(Number(orderTotal.toFixed(2)));
  expect(settled.reduce((sum, bill) => sum + Number(bill.balance), 0)).toBe(0);
  expect(new Set(settled.map((bill) => bill.split_group_id)).size).toBe(1);

  const completedOrder = await request.get(`${BASE}/api/orders/${order.id}`, { headers: managerHeaders });
  expect(completedOrder.ok()).toBeTruthy();
  expect((await completedOrder.json()).order.status).toBe('completed');
  expect(printRequests).toEqual([]);
});

test('an empty selection blocks submission and explains why', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout empty selection');
  const splitRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/split-check$/.test(url.pathname)) {
      splitRequests.push(url.pathname);
    }
  });

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();

  await expect(page.getByText('Select at least one item for the leaving guest')).toBeVisible();
  const submit = page.getByRole('button', { name: 'Create checks' });
  await expect(submit).toBeDisabled();
  await submit.click({ force: true });
  await expect(page.getByRole('button', { name: 'Selected items' })).toBeVisible();
  expect(splitRequests).toEqual([]);

  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(1);
  expect(bills[0].payment_status).toBe('unpaid');
});

test('selecting every remaining item returns to paying the check as it is', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout full selection');
  const splitRequests: string[] = [];
  const paymentRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/split-check$/.test(url.pathname)) splitRequests.push(url.pathname);
    if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname)) paymentRequests.push(url.pathname);
  });

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();

  await selectGuestQuantity(page, 'E2E Coffee', 3);
  await expect(page.getByText('Everything is selected, so there is nothing left to split')).toBeVisible();
  await page.getByRole('button', { name: 'Pay this check' }).click();

  // The editor closes onto the untouched check; nothing was split or charged.
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  expect(splitRequests).toEqual([]);
  expect(paymentRequests).toEqual([]);
  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(1);
  expect(Number(bills[0].paid_amount)).toBe(0);
});

test('cancelling the guest payment screen keeps the split unpaid', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout cancelled payment');
  const paymentRequests: string[] = [];
  page.on('request', (browserRequest) => {
    if (browserRequest.method() === 'POST' && /\/payments$/.test(new URL(browserRequest.url()).pathname)) {
      paymentRequests.push(new URL(browserRequest.url()).pathname);
    }
  });

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  await submitGuestSplit(page);

  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toHaveCount(0);

  // The same check is still unpaid and payable when the cashier comes back.
  await payUnpaidCheck(page, order.order_number, 0);
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(2);
  expect(bills.every((bill) => bill.payment_status === 'unpaid')).toBe(true);
  expect(bills.every((bill) => Number(bill.paid_amount) === 0)).toBe(true);
  expect(paymentRequests).toEqual([]);
});

test('the quantity editor accepts only whole quantities inside the check', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout quantity bounds');

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();

  const row = page.getByRole('row').filter({ hasText: 'E2E Coffee' });
  const input = row.getByRole('spinbutton');
  await input.fill('2.5');
  await expect(input).toHaveValue('2');
  await input.fill('9');
  await expect(input).toHaveValue('3');
  await input.fill('-1');
  await expect(input).toHaveValue('0');
  await expect(page.getByText('Select at least one item for the leaving guest')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create checks' })).toBeDisabled();

  // The stepper stops at the quantity this check actually owns.
  await row.getByRole('button').nth(1).click();
  await row.getByRole('button').nth(1).click();
  await row.getByRole('button').nth(1).click();
  await expect(input).toHaveValue('3');
  await expect(page.getByText('Everything is selected, so there is nothing left to split')).toBeVisible();

  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(1);
});

test('a double click still creates exactly one split', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout double click');
  const splitRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/split-check$/.test(url.pathname)) splitRequests.push(url.pathname);
  });

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  await selectGuestQuantity(page, 'E2E Coffee', 1);

  // Both clicks are dispatched without Playwright's actionability wait, so the
  // in-flight guard - not the test harness - is what keeps this to one request.
  const submit = page.getByRole('button', { name: 'Create checks' });
  await Promise.allSettled([
    submit.click({ force: true }),
    submit.click({ force: true, timeout: 3_000 }),
  ]);
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  expect(splitRequests).toHaveLength(1);
  expect(await readOrderBills(request, order.id)).toHaveLength(2);
});

test('a check settled elsewhere is reported instead of retried', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout stale source');
  const splitRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (browserRequest.method() === 'POST' && /^\/api\/bills\/[^/]+\/split-check$/.test(url.pathname)) splitRequests.push(url.pathname);
  });

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  await selectGuestQuantity(page, 'E2E Coffee', 1);

  // Another terminal settles the whole check while this editor is still open.
  const [sourceBill] = await readOrderBills(request, order.id);
  const settled = await request.post(`${BASE}/api/bills/${sourceBill.id}/payments`, {
    headers: managerHeaders,
    data: { payments: [{ method: 'cash', amount: sourceBill.balance }] },
  });
  expect(settled.ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Create checks' }).click();
  await expect(page.getByText('Could not split the check')).toBeVisible();
  // One rejected attempt: the mutation is never repeated automatically, and the
  // editor refreshes the state the till actually holds.
  expect(splitRequests).toHaveLength(1);
  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(1);
  expect(bills[0].payment_status).toBe('paid');
});

test('a paid check is never offered again for selection', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout paid sibling');

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  const [sourceBill] = await readOrderBills(request, order.id);
  const perGuest = Number((Number(sourceBill.total) / 3).toFixed(2));
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  await submitGuestSplit(page);
  await settleInCash(page, amountLabel(perGuest));
  await finishPayment(page);

  // The unpaid remainder owns two units: the paid unit is neither listed nor
  // reachable by typing a larger quantity than the check holds.
  await payUnpaidCheck(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  const rows = page.getByRole('row').filter({ hasText: 'E2E Coffee' });
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole('cell').nth(1)).toHaveText('2');
  await expect(rows.getByRole('cell').nth(3)).toHaveText('2');
  await rows.getByRole('spinbutton').fill('3');
  await expect(rows.getByRole('spinbutton')).toHaveValue('2');
  await expect(page.getByText('Everything is selected, so there is nothing left to split')).toBeVisible();

  await setRowQuantity(rows, 1);
  await submitGuestSplit(page);
  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(3);
  expect(bills.filter((bill) => bill.payment_status === 'paid')).toHaveLength(1);
  const unpaid = bills.filter((bill) => bill.payment_status === 'unpaid');
  expect(unpaid).toHaveLength(2);
  expect(unpaid.every((bill) => Number(bill.total) === perGuest)).toBe(true);
});

test('a persisted discount stays prorated across the split', async ({ page, request }) => {
  const order = await createThreeGuestTable(request, 'Selected guest checkout persisted discount');
  const discounted = await request.patch(`${BASE}/api/orders/${order.id}/discount`, {
    headers: managerHeaders,
    data: { discount_type: 'percentage', discount_value: 10, discount_reason: 'E2E guest checkout discount' },
  });
  expect(discounted.ok(), `applying the discount must succeed (got ${discounted.status()})`).toBeTruthy();
  const detail = await request.get(`${BASE}/api/orders/${order.id}`, { headers: managerHeaders });
  const orderTotal = Number((await detail.json()).order.total);

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  const [sourceBill] = await readOrderBills(request, order.id);
  expect(Number(sourceBill.discount_amount)).toBeGreaterThan(0);
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  await submitGuestSplit(page);

  // Both checks carry their share of the stored discount, and together they
  // still add up to the discounted order the till was showing.
  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(2);
  const guestBill = bills.find((bill) => bill.id !== sourceBill.id)!;
  const remainder = bills.find((bill) => bill.id === sourceBill.id)!;
  expect(Number(guestBill.discount_amount)).toBeGreaterThan(0);
  expect(Number(remainder.discount_amount)).toBeGreaterThan(0);
  expect(Number((Number(guestBill.total) + Number(remainder.total)).toFixed(2))).toBe(Number(orderTotal.toFixed(2)));

  await settleInCash(page, amountLabel(Number(guestBill.balance)));
  await finishPayment(page);

  const settledBills = await readOrderBills(request, order.id);
  expect(settledBills.filter((bill) => bill.payment_status === 'paid')).toHaveLength(1);
  const leftOver = settledBills.find((bill) => bill.payment_status === 'unpaid')!;
  expect(Number(leftOver.paid_amount)).toBe(0);
  expect(Number((Number(leftOver.balance) + Number(guestBill.balance)).toFixed(2))).toBe(Number(orderTotal.toFixed(2)));
});

test('a cashier checks guests out while a server is refused the split', async ({ page, request }) => {
  const cashierEmail = 'e2e-cashier@flo.local';
  const usersResponse = await request.get(`${BASE}/api/users`, { headers: managerHeaders });
  expect(usersResponse.ok()).toBeTruthy();
  const staff = ((await usersResponse.json()).staff ?? []) as { email: string }[];
  if (!staff.some((member) => member.email === cashierEmail)) {
    const created = await request.post(`${BASE}/api/users`, {
      headers: managerHeaders,
      data: { name: 'E2E Cashier', email: cashierEmail, password: E2E_PASSWORD, role: 'cashier', is_active: true },
    });
    expect(created.ok(), `creating the cashier must succeed (got ${created.status()})`).toBeTruthy();
  }

  const order = await createThreeGuestTable(request, 'Selected guest checkout cashier role');

  // The tenant language is a settings write, so it is pinned before the cashier
  // session - a cashier may bill guests but not change tenant configuration.
  await setLanguage(page, 'en');
  await login(page, cashierEmail, false);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  const [sourceBill] = await readOrderBills(request, order.id);
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  await submitGuestSplit(page);
  await settleInCash(page, amountLabel(Number(sourceBill.total) / 3));
  await finishPayment(page);

  const afterCashier = await readOrderBills(request, order.id);
  expect(afterCashier.filter((bill) => bill.payment_status === 'paid')).toHaveLength(1);
  const leftOver = afterCashier.find((bill) => bill.payment_status === 'unpaid')!;

  // A server holds no `bills.generate`, so the backend refuses to divide the
  // remaining check and leaves its items alone.
  const detail = await readBillDetail(request, leftOver.id);
  const serverHeaders = { Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}` };
  const denied = await request.post(`${BASE}/api/bills/${leftOver.id}/split-check`, {
    headers: serverHeaders,
    data: { checks: [{ label: 'Remainder', items: detail.bill.order.items.map((item) => ({ order_item_id: item.id, quantity: 1 })) }] },
  });
  expect(denied.status()).toBe(403);
  expect(await readOrderBills(request, order.id)).toHaveLength(2);
});

test('distinct variant and add-on lines are divided as separate items', async ({ page, request }) => {
  const fixture = await ensureUatFixture(request);
  const created = await request.post(`${BASE}/api/orders`, {
    headers: managerHeaders,
    data: {
      type: 'dine_in',
      guest_count: 2,
      special_instructions: 'Selected guest checkout variant lines',
      items: [
        orderItem(fixture.productId, { variantId: fixture.variants.Large.id }),
        orderItem(fixture.productId, { variantId: fixture.variants.Small.id, addons: [fixture.addons['Oat Milk']] }),
      ],
    },
  });
  expect(created.status()).toBe(201);
  const order = (await created.json()).order;

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  const [sourceBill] = await readOrderBills(request, order.id);

  // One product, two priced lines: the editor keeps them apart instead of
  // merging their quantities.
  const rows = page.getByRole('row').filter({ hasText: FIXTURE_PRODUCT_NAME });
  await expect(rows).toHaveCount(2);
  expect(await rows.nth(0).innerText()).not.toBe(await rows.nth(1).innerText());

  await setRowQuantity(rows.nth(1), 1);
  await submitGuestSplit(page);

  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(2);
  const guestBill = bills.find((bill) => bill.id !== sourceBill.id)!;
  const remainder = bills.find((bill) => bill.id === sourceBill.id)!;
  const guestDetail = await readBillDetail(request, guestBill.id);
  const remainderDetail = await readBillDetail(request, remainder.id);
  expect(guestDetail.bill.order.items).toHaveLength(1);
  expect(Number(guestDetail.bill.order.items[0].quantity)).toBe(1);
  expect(remainderDetail.bill.order.items).toHaveLength(1);
  expect(guestDetail.bill.order.items[0].product_name).toBe(remainderDetail.bill.order.items[0].product_name);
  expect(Number(guestBill.total)).not.toBe(Number(remainder.total));
  expect(Number(guestBill.paid_amount)).toBe(0);
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
});

test('the selected-items editor stays hidden when split checks are disabled', async ({ page, request }) => {
  await writeSplitSetting(request, 'false');
  const order = await createThreeGuestTable(request, 'Selected guest checkout feature off');

  await login(page);
  await openOrderCheckout(page, order.order_number);
  await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Split check' })).toHaveCount(0);
});

test('the card grid drives the same selected-items guest checkout', async ({ page, request }) => {
  await setOrdersLayout(page, 'cards', BASE, ordersLayoutToken);
  const order = await createThreeGuestTable(request, 'Selected guest checkout cards layout');

  await login(page);
  await page.goto(`${BASE}/orders`);
  await page.getByPlaceholder(/search/i).first().fill(order.order_number);
  const card = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${order.order_number}` });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Checkout|Take Payment/ }).click();
  await page.getByRole('button', { name: 'Split check' }).click();
  await page.getByRole('button', { name: 'Selected items' }).click();
  await selectGuestQuantity(page, 'E2E Coffee', 1);
  const [sourceBill] = await readOrderBills(request, order.id);
  await submitGuestSplit(page);
  await settleInCash(page, amountLabel(Number(sourceBill.total) / 3));
  await finishPayment(page);

  const bills = await readOrderBills(request, order.id);
  expect(bills).toHaveLength(2);
  expect(bills.filter((bill) => bill.payment_status === 'paid')).toHaveLength(1);
});
