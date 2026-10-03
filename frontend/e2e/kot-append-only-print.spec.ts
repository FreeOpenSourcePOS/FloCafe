import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

/**
 * Regression coverage for a P2 review finding on the KOT append-only print
 * fix (PR #574): adding an item to an already-occupied table's order must
 * print only the newly appended item, not the whole ticket. The concern
 * raised was that the "existing order" the POS diffs against on load might
 * be missing its items (main/routes/tables.ts's active-order lookup never
 * hydrates items), which would make every existing item look "new" and
 * reprint the full KOT. In the current code the order used for that diff is
 * always re-fetched in full (with items) by TableCheckoutModal via
 * GET /orders/:id before either append path can run — this test pins that
 * down so a future change can't silently drop that hydration.
 *
 * The e2e backend is a single shared, serially-executed server (see
 * playwright.config.ts: workers: 1), and its default fixture is prepaid /
 * tables_required=false (tests/e2e-server.cjs) — the "add items to an
 * existing table order" flow only exists for postpaid dine-in orders, so
 * this test switches those two settings for its own duration and restores
 * them in `finally`.
 */
test('adding an item to an occupied table only prints the newly appended item on KOT', async ({ page }) => {
  test.setTimeout(60_000);

  const setupToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${setupToken}` };

  const businessRes = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessRes.ok()).toBeTruthy();
  const originalBusiness = await businessRes.json();

  const tableNumber = `E2E-KOT-${Date.now()}`;

  try {
    const putRes = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid', tables_required: true },
    });
    expect(putRes.ok()).toBeTruthy();

    // A configured non-WebUSB printer routes KOT prints through the network
    // POST /printers/print-kot path instead of the browser popup fallback,
    // so the outgoing item payload can be captured directly. It can't be
    // torn down afterward (the API refuses to delete a business's only
    // printer), but a configured printer never triggers a print on its own —
    // autoPrintKot is a fresh, per-browser localStorage flag that stays off
    // for every other spec's page — so leaving it in place is harmless.
    const printerRes = await page.request.post(`${BASE}/api/printers`, {
      headers: authHeaders,
      data: { name: 'E2E KOT Printer', connection_type: 'network', ip_address: '127.0.0.1', port: 9100 },
    });
    expect(printerRes.ok()).toBeTruthy();

    const tableRes = await page.request.post(`${BASE}/api/tables`, {
      headers: authHeaders,
      data: { number: tableNumber },
    });
    expect(tableRes.ok()).toBeTruthy();
    const table = (await tableRes.json()).table;

    // Seed the table's existing order the way a real dine-in order arrives:
    // one item already on the ticket before the cashier reopens this table.
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers: authHeaders,
      data: {
        table_id: table.id,
        type: 'dine_in',
        guest_count: 2,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(orderRes.ok()).toBeTruthy();
    const order = (await orderRes.json()).order;
    expect(order.items).toHaveLength(1);
    const originalItemId = order.items[0].id;

    // autoPrintKot is a per-browser (localStorage-persisted) setting, not a
    // backend one. Setting it via an init script (rather than page.evaluate
    // after the app has mounted) is required here: the live store re-persists
    // its in-memory state — still autoPrintKot:false — on the next unrelated
    // setter call (e.g. the settings-fetch effect calling setKotPrintingEnabled),
    // clobbering a same-tick localStorage write before any reload happens.
    // An init script instead runs before the app's own scripts on every
    // navigation, so the store hydrates with it from the start.
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { autoPrintKot: true }, version: 3 }));
    });

    let kotRequestBody: { orderId?: number; items?: Array<{ id: number }> } | null = null;
    await page.route('**/api/printers/print-kot', async (route) => {
      kotRequestBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ warnings: [] }) });
    });

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await page.waitForFunction(() => !!localStorage.getItem('token'));
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    // Add a second item to the cart, then send it to the already-occupied table.
    await page.getByTestId('pos-product-card').click();
    await page.getByRole('button', { name: /Add to Cart/ }).click();
    await page.getByRole('button', { name: 'Place Order' }).click();

    await expect(page.getByRole('heading', { name: 'Select Table' })).toBeVisible();
    await page.getByText(tableNumber, { exact: true }).click();

    await expect(page.getByRole('button', { name: /Add 1 item to order/i })).toBeVisible();
    const kotResponse = page.waitForResponse((response) =>
      response.url().includes('/api/printers/print-kot')
    );
    await page.getByRole('button', { name: /Add 1 item to order/i }).click();
    await kotResponse;

    await expect(page.getByText(/Items added to order/)).toBeVisible();

    expect(kotRequestBody, 'the append must trigger a KOT print').not.toBeNull();
    expect(kotRequestBody!.orderId).toBe(order.id);
    expect(kotRequestBody!.items).toHaveLength(1);
    expect(kotRequestBody!.items![0].id).not.toBe(originalItemId);
  } finally {
    await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: originalBusiness,
    });
  }
});

async function loginToPos(page: import('@playwright/test').Page, email = 'manager@flo.local') {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

async function openOccupiedTable(page: import('@playwright/test').Page, tableNumber: string) {
  await page.getByRole('button', { name: 'Select Table' }).click();
  await expect(page.getByRole('heading', { name: 'Select Table' })).toBeVisible();
  const tableCard = page.getByRole('button').filter({ hasText: tableNumber });
  await expect(tableCard).toHaveCount(1);
  await tableCard.click();
}

async function installBillPrintCapture(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const appWindow = window as Window & {
      __billPrintHtml?: string[];
      __billPrintOpenCount?: number;
      __billPrintCloseCount?: number;
    };
    appWindow.__billPrintHtml = [];
    appWindow.__billPrintOpenCount = 0;
    appWindow.__billPrintCloseCount = 0;
    window.open = (() => {
      appWindow.__billPrintOpenCount = (appWindow.__billPrintOpenCount ?? 0) + 1;
      const printDocument = document.implementation.createHTMLDocument('Bill');
      let closed = false;
      return {
        get closed() { return closed; },
        document: printDocument,
        print: () => appWindow.__billPrintHtml?.push(printDocument.body.innerHTML),
        close: () => {
          closed = true;
          appWindow.__billPrintCloseCount = (appWindow.__billPrintCloseCount ?? 0) + 1;
        },
      } as unknown as Window;
    }) as typeof window.open;
  });
}

async function prepareDineInSettings(page: import('@playwright/test').Page, headers: Record<string, string>, enableSplitting = false) {
  const businessResponse = await page.request.get(`${BASE}/api/settings/business`, { headers });
  expect(businessResponse.ok()).toBeTruthy();
  const business = await businessResponse.json();
  const splitSettingResponse = enableSplitting
    ? await page.request.get(`${BASE}/api/settings/split_checks_enabled`, { headers })
    : null;
  if (splitSettingResponse) expect(splitSettingResponse.ok()).toBeTruthy();
  const originalSplitChecks = splitSettingResponse ? (await splitSettingResponse.json()).setting?.value ?? 'false' : null;

  const updateBusiness = async (
    request: import('@playwright/test').APIRequestContext,
    settings: { billing_type: string; tables_required: boolean },
  ) => {
    const response = await request.put(`${BASE}/api/settings/business`, { headers, data: settings, timeout: 5_000 });
    expect(response.ok()).toBeTruthy();
  };
  const updateSplitSetting = async (request: import('@playwright/test').APIRequestContext, value: string) => {
    const response = await request.put(`${BASE}/api/settings/split_checks_enabled`, { headers, data: { value }, timeout: 5_000 });
    expect(response.ok()).toBeTruthy();
  };

  const restore = async (request: import('@playwright/test').APIRequestContext = page.request) => {
    if (enableSplitting) await updateSplitSetting(request, String(originalSplitChecks));
    await updateBusiness(request, {
      billing_type: business.billing_type,
      tables_required: Boolean(business.tables_required),
    });
  };

  try {
    await updateBusiness(page.request, { billing_type: 'postpaid', tables_required: true });
    if (enableSplitting) await updateSplitSetting(page.request, 'true');
  } catch (error) {
    try {
      await restore();
    } catch {
      // Keep the setup error as the test failure; the fixture database is discarded by the E2E server.
    }
    throw error;
  }
  return restore;
}

async function createDineInFixture(
  page: import('@playwright/test').Page,
  headers: Record<string, string>,
  itemCount = 1,
) {
  const tableNumber = `E2E-BILL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const tableResponse = await page.request.post(`${BASE}/api/tables`, {
    headers,
    data: { number: tableNumber },
  });
  expect(tableResponse.ok()).toBeTruthy();
  const table = (await tableResponse.json()).table as { id: string };
  try {
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        table_id: table.id,
        type: 'dine_in',
        guest_count: 2,
        items: Array.from({ length: itemCount }, () => ({ product_id: 'e2e-product', quantity: 1 })),
      },
    });
    expect(orderResponse.ok()).toBeTruthy();
    const order = (await orderResponse.json()).order as { id: number; order_number: string; items: Array<{ id: number }> };
    return { tableId: table.id, tableNumber, order };
  } catch (error) {
    await page.request.patch(`${BASE}/api/tables/${table.id}/status`, {
      headers,
      data: { status: 'available' },
      timeout: 5_000,
    }).catch(() => undefined);
    throw error;
  }
}

async function cleanupDineInFixture(
  request: import('@playwright/test').APIRequestContext,
  headers: Record<string, string>,
  fixture: { tableId: string; orderId?: number },
) {
  if (fixture.orderId) {
    const orderResponse = await request.patch(`${BASE}/api/orders/${fixture.orderId}/status`, {
      headers,
      data: { status: 'cancelled', reason: 'E2E fixture cleanup' },
      timeout: 5_000,
    });
    expect(orderResponse.ok()).toBeTruthy();
  }
  const tableResponse = await request.patch(`${BASE}/api/tables/${fixture.tableId}/status`, {
    headers,
    data: { status: 'available' },
    timeout: 5_000,
  });
  expect(tableResponse.ok()).toBeTruthy();
}

async function useBrowserBillPrint(page: import('@playwright/test').Page) {
  await installBillPrintCapture(page);
  await page.route('**/api/printers', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ printers: [] }) });
    } else {
      await route.continue();
    }
  });
}

test('dine-in bill print reserves its popup before refreshing the order and prints current items and totals', async ({ page }) => {
  const setupToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${setupToken}` };
  const businessRes = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessRes.ok()).toBeTruthy();
  const originalBusiness = await businessRes.json();
  const tableNumber = `E2E-BILL-${Date.now()}`;
  let tableId: string | undefined;
  let orderId: number | undefined;
  let testError: unknown;
  let releaseFreshOrderRead!: () => void;

  try {
    const putRes = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid', tables_required: true },
    });
    expect(putRes.ok()).toBeTruthy();

    const tableRes = await page.request.post(`${BASE}/api/tables`, {
      headers: authHeaders,
      data: { number: tableNumber },
    });
    expect(tableRes.ok()).toBeTruthy();
    const table = (await tableRes.json()).table;
    tableId = table.id;
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers: authHeaders,
      data: {
        table_id: table.id,
        type: 'dine_in',
        guest_count: 2,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(orderRes.ok()).toBeTruthy();
    const order = (await orderRes.json()).order;
    orderId = order.id;
    const billRes = await page.request.post(`${BASE}/api/bills/generate`, {
      headers: authHeaders,
      data: { order_id: order.id },
    });
    expect(billRes.ok()).toBeTruthy();
    const bill = (await billRes.json()).bill;

    await installBillPrintCapture(page);
    await page.route('**/api/printers', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ printers: [] }) });
      } else {
        await route.continue();
      }
    });
    await loginToPos(page);
    await openOccupiedTable(page, tableNumber);
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible();

    const appendRes = await page.request.post(`${BASE}/api/orders/${order.id}/items`, {
      headers: authHeaders,
      data: { items: [{ product_id: 'e2e-product', quantity: 1, special_instructions: 'Cross terminal addition' }] },
    });
    expect(appendRes.ok()).toBeTruthy();
    const discountRes = await page.request.patch(`${BASE}/api/orders/${order.id}/discount`, {
      headers: authHeaders,
      data: { discount_type: 'percentage', discount_value: 10 },
    });
    expect(discountRes.ok()).toBeTruthy();

    const freshOrderRes = await page.request.get(`${BASE}/api/orders/${order.id}`, { headers: authHeaders });
    expect(freshOrderRes.ok()).toBeTruthy();
    const freshOrder = (await freshOrderRes.json()).order;
    expect(freshOrder.items).toHaveLength(2);
    const freshBillRes = await page.request.get(`${BASE}/api/bills/${bill.id}`, { headers: authHeaders });
    expect(freshBillRes.ok()).toBeTruthy();
    const freshBill = (await freshBillRes.json()).bill;
    expect(Number(freshBill.total)).toBeGreaterThan(Number(bill.total));
    expect(Number(freshBill.discount_amount)).toBeGreaterThan(0);
    expect(freshBill.payment_status).toBe('unpaid');

    let signalFreshOrderRead!: () => void;
    const freshOrderReadIntercepted = new Promise<void>((resolve) => {
      signalFreshOrderRead = resolve;
    });
    const heldFreshOrderRead = new Promise<void>((resolve) => {
      releaseFreshOrderRead = resolve;
    });
    await page.route(`${BASE}/api/orders/${order.id}`, async (route) => {
      signalFreshOrderRead();
      await heldFreshOrderRead;
      await route.continue();
    }, { times: 1 });

    await page.getByRole('button', { name: /Print Bill/ }).click();
    await freshOrderReadIntercepted;
    expect(await page.evaluate(() => (window as Window & { __billPrintOpenCount?: number }).__billPrintOpenCount)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __billPrintCloseCount?: number }).__billPrintCloseCount)).toBe(0);
    releaseFreshOrderRead();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.length ?? 0
    ))).toBe(1);
    const html = await page.evaluate(() => (
      (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.[0] ?? ''
    ));
    const receipt = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      return {
        items: Array.from(doc.querySelectorAll('.items-table tbody tr')).map((row) => row.textContent || ''),
        total: doc.querySelector('.total-row')?.textContent || '',
      };
    }, html);
    const printedItems = receipt.items;
    expect(printedItems).toHaveLength(2);
    expect(printedItems.join(' ')).toContain('Cross terminal addition');
    expect(receipt.total).toContain(String(freshBill.total));

    const billAfterPrintRes = await page.request.get(`${BASE}/api/bills/${bill.id}`, { headers: authHeaders });
    expect(billAfterPrintRes.ok()).toBeTruthy();
    const billAfterPrint = (await billAfterPrintRes.json()).bill;
    expect(billAfterPrint.payment_status).toBe('unpaid');
    expect(Number(billAfterPrint.paid_amount)).toBe(0);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    releaseFreshOrderRead?.();
    let cleanupError: unknown;
    try {
      if (tableId) await cleanupDineInFixture(page.request, authHeaders, { orderId, tableId });
    } catch (error) {
      cleanupError = error;
    }
    try {
      const restoreResponse = await page.request.put(`${BASE}/api/settings/business`, {
        headers: authHeaders,
        data: {
          billing_type: originalBusiness.billing_type,
          tables_required: Boolean(originalBusiness.tables_required),
        },
      });
      expect(restoreResponse.ok()).toBeTruthy();
    } catch (error) {
      cleanupError ??= error;
    }
    if (testError === undefined && cleanupError) throw cleanupError;
  }
});

test('dine-in bill print closes its reserved popup when the order read or bill generation fails', async ({ page }) => {
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  let restoreSettings: (() => Promise<void>) | undefined;
  let createdFixture: Awaited<ReturnType<typeof createDineInFixture>> | undefined;
  let generateRequests = 0;
  let testError: unknown;
  const countGenerateRequest = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/bills/generate') generateRequests += 1;
  };

  try {
    restoreSettings = await prepareDineInSettings(page, headers);
    const fixture = await createDineInFixture(page, headers);
    createdFixture = fixture;
    await useBrowserBillPrint(page);
    await loginToPos(page);
    await openOccupiedTable(page, fixture.tableNumber);
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible();
    page.on('request', countGenerateRequest);
    await page.route(`${BASE}/api/orders/${fixture.order.id}`, (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'order temporarily unavailable' }),
    }), { times: 1 });

    const freshRead = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/orders/${fixture.order.id}`);
    await page.getByRole('button', { name: /Print Bill/ }).click();
    expect((await freshRead).status()).toBe(503);
    expect(await page.evaluate(() => (window as Window & { __billPrintOpenCount?: number }).__billPrintOpenCount)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as Window & { __billPrintCloseCount?: number }).__billPrintCloseCount)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.length)).toBe(0);
    expect(generateRequests).toBe(0);

    await page.route(`${BASE}/api/bills/generate`, (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'bill generation temporarily unavailable' }),
    }), { times: 1 });
    const generation = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bills/generate');
    await page.getByRole('button', { name: /Print Bill/ }).click();
    expect((await generation).status()).toBe(503);
    expect(await page.evaluate(() => (window as Window & { __billPrintOpenCount?: number }).__billPrintOpenCount)).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as Window & { __billPrintCloseCount?: number }).__billPrintCloseCount)).toBe(2);
    expect(await page.evaluate(() => (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.length)).toBe(0);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    page.off('request', countGenerateRequest);
    let cleanupError: unknown;
    try {
      if (createdFixture) await cleanupDineInFixture(page.request, headers, { tableId: createdFixture.tableId, orderId: createdFixture.order.id });
    } catch (error) {
      cleanupError = error;
    }
    try { await restoreSettings?.(); } catch (error) { cleanupError ??= error; }
    if (testError === undefined && cleanupError) throw cleanupError;
  }
});

test('dine-in parent bill printing stops when another terminal splits its check', async ({ page }) => {
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  let restoreSettings: (() => Promise<void>) | undefined;
  let createdFixture: Awaited<ReturnType<typeof createDineInFixture>> | undefined;
  let generateRequests = 0;
  let testError: unknown;
  const countGenerateRequest = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/bills/generate') generateRequests += 1;
  };

  try {
    restoreSettings = await prepareDineInSettings(page, headers, true);
    const fixture = await createDineInFixture(page, headers, 2);
    createdFixture = fixture;
    const billResponse = await page.request.post(`${BASE}/api/bills/generate`, {
      headers,
      data: { order_id: fixture.order.id },
    });
    expect(billResponse.ok()).toBeTruthy();
    const bill = (await billResponse.json()).bill;
    expect(fixture.order.items).toHaveLength(2);
    await useBrowserBillPrint(page);
    await loginToPos(page);
    await openOccupiedTable(page, fixture.tableNumber);
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible();
    page.on('request', countGenerateRequest);

    const splitResponse = await page.request.post(`${BASE}/api/bills/${bill.id}/split-check`, {
      headers,
      data: { checks: fixture.order.items.map((item, index) => ({
        label: `Guest ${index + 1}`,
        items: [{ order_item_id: item.id, quantity: 1 }],
      })) },
    });
    expect(splitResponse.status()).toBe(201);

    const refresh = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/orders/${fixture.order.id}`);
    await page.getByRole('button', { name: /Print Bill/ }).click();
    expect((await refresh).ok()).toBeTruthy();
    await expect(page.getByText('Guest 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Guest 2', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __billPrintOpenCount?: number }).__billPrintOpenCount)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as Window & { __billPrintCloseCount?: number }).__billPrintCloseCount)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.length)).toBe(0);
    expect(generateRequests).toBe(0);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    page.off('request', countGenerateRequest);
    let cleanupError: unknown;
    try {
      if (createdFixture) await cleanupDineInFixture(page.request, headers, { tableId: createdFixture.tableId, orderId: createdFixture.order.id });
    } catch (error) {
      cleanupError = error;
    }
    try { await restoreSettings?.(); } catch (error) { cleanupError ??= error; }
    if (testError === undefined && cleanupError) throw cleanupError;
  }
});

test('dine-in bill print does not print a split bill generated by another terminal during checkout', async ({ page }) => {
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  let restoreSettings: (() => Promise<void>) | undefined;
  let createdFixture: Awaited<ReturnType<typeof createDineInFixture>> | undefined;
  let generatedBillId: number | undefined;
  let splitGroupId: string | undefined;
  let pageGenerateRequests = 0;
  let testError: unknown;
  const countGenerateRequest = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/bills/generate') pageGenerateRequests += 1;
  };

  try {
    restoreSettings = await prepareDineInSettings(page, headers, true);
    const fixture = await createDineInFixture(page, headers, 2);
    createdFixture = fixture;
    await useBrowserBillPrint(page);
    await loginToPos(page);
    await openOccupiedTable(page, fixture.tableNumber);
    page.on('request', countGenerateRequest);
    let splitSetupError: unknown;
    let splitSetupFailed = false;
    await page.route(`${BASE}/api/bills/generate`, async (route) => {
      try {
        const otherTerminalBillResponse = await page.request.post(`${BASE}/api/bills/generate`, {
          headers,
          data: { order_id: fixture.order.id },
        });
        expect(otherTerminalBillResponse.ok()).toBeTruthy();
        const otherTerminalBill = (await otherTerminalBillResponse.json()).bill;
        generatedBillId = otherTerminalBill.id;
        const splitResponse = await page.request.post(`${BASE}/api/bills/${otherTerminalBill.id}/split-check`, {
          headers,
          data: { checks: fixture.order.items.map((item, index) => ({
            label: `Guest ${index + 1}`,
            items: [{ order_item_id: item.id, quantity: 1 }],
          })) },
        });
        expect(splitResponse.status()).toBe(201);
        const split = await splitResponse.json();
        splitGroupId = split.bills[0].split_group_id;
      } catch (error) {
        splitSetupFailed = true;
        splitSetupError = error;
      } finally {
        try {
          await route.continue();
        } catch (error) {
          if (!splitSetupFailed) {
            splitSetupFailed = true;
            splitSetupError = error;
          }
        }
      }
    }, { times: 1 });

    const generationResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bills/generate');
    await page.getByRole('button', { name: /Print Bill/ }).click();
    let returnedBill: { id: number; split_group_id: string };
    try {
      returnedBill = (await (await generationResponse).json()).bill;
    } catch (error) {
      if (splitSetupFailed) throw splitSetupError;
      throw error;
    }
    if (splitSetupFailed) throw splitSetupError;
    expect(returnedBill.id).toBe(generatedBillId);
    expect(returnedBill.split_group_id).toBe(splitGroupId);
    await expect(page.getByText('Guest 1', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __billPrintOpenCount?: number }).__billPrintOpenCount)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as Window & { __billPrintCloseCount?: number }).__billPrintCloseCount)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.length)).toBe(0);
    expect(pageGenerateRequests).toBe(1);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    page.off('request', countGenerateRequest);
    let cleanupError: unknown;
    try {
      if (createdFixture) await cleanupDineInFixture(page.request, headers, { tableId: createdFixture.tableId, orderId: createdFixture.order.id });
    } catch (error) {
      cleanupError = error;
    }
    try { await restoreSettings?.(); } catch (error) { cleanupError ??= error; }
    if (testError === undefined && cleanupError) throw cleanupError;
  }
});

test.describe('server POS bill print permissions', () => {
  type PermissionTestCleanup = {
    ownerHeaders: Record<string, string>;
    managerHeaders: Record<string, string>;
    restoreSettings?: Awaited<ReturnType<typeof prepareDineInSettings>>;
    fixture?: Awaited<ReturnType<typeof createDineInFixture>>;
    originalOverrides?: Array<{ permission_id: string; effect: string }>;
    permissionsMayHaveChanged: boolean;
  };
  let cleanup: PermissionTestCleanup | undefined;

  test.afterEach(async ({ request }) => {
    const pendingCleanup = cleanup;
    cleanup = undefined;
    if (!pendingCleanup) return;

    let cleanupError: unknown;
    const attempt = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    if (pendingCleanup.permissionsMayHaveChanged && pendingCleanup.originalOverrides) {
      await attempt(async () => {
        const latestUserResponse = await request.get(`${BASE}/api/authorization/users/e2e-server`, {
          headers: pendingCleanup.ownerHeaders,
          timeout: 5_000,
        });
        expect(latestUserResponse.ok()).toBeTruthy();
        const latestUser = await latestUserResponse.json();
        const restoredPermissions = await request.put(`${BASE}/api/authorization/users/e2e-server`, {
          headers: pendingCleanup.ownerHeaders,
          data: { revision: latestUser.revision, overrides: pendingCleanup.originalOverrides },
          timeout: 5_000,
        });
        expect(restoredPermissions.ok()).toBeTruthy();
      });
    }
    if (pendingCleanup.fixture) {
      await attempt(() => cleanupDineInFixture(request, pendingCleanup.managerHeaders, {
        tableId: pendingCleanup.fixture!.tableId,
        orderId: pendingCleanup.fixture!.order.id,
      }));
    }
    if (pendingCleanup.restoreSettings) {
      await attempt(() => pendingCleanup.restoreSettings!(request));
    }
    if (cleanupError) throw cleanupError;
  });

  test('server with POS access but without bill generation cannot start bill printing', async ({ page }) => {
    const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };
    const managerHeaders = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
    const serverHeaders = { Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}` };
    const pendingCleanup: PermissionTestCleanup = { ownerHeaders, managerHeaders, permissionsMayHaveChanged: false };
    cleanup = pendingCleanup;

    pendingCleanup.restoreSettings = await prepareDineInSettings(page, managerHeaders);
    const fixture = await createDineInFixture(page, managerHeaders);
    pendingCleanup.fixture = fixture;
    const userResponse = await page.request.get(`${BASE}/api/authorization/users/e2e-server`, { headers: ownerHeaders });
    expect(userResponse.ok()).toBeTruthy();
    const originalUser = await userResponse.json();
    pendingCleanup.originalOverrides = originalUser.overrides;
    const overrides = (originalUser.overrides as Array<{ permission_id: string; effect: string }>)
      .filter((override) => override.permission_id !== 'pos.use');
    overrides.push({ permission_id: 'pos.use', effect: 'allow' });

    pendingCleanup.permissionsMayHaveChanged = true;
    const permissionResponse = await page.request.put(`${BASE}/api/authorization/users/e2e-server`, {
      headers: ownerHeaders,
      data: { revision: originalUser.revision, overrides },
    });
    expect(permissionResponse.ok()).toBeTruthy();

    let whatsappStatusRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/whatsapp/status') whatsappStatusRequests += 1;
    });
    await page.goto(`${BASE}/auth/login`);
    await page.evaluate(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('tenant');
    });
    await loginToPos(page, 'server@flo.local');
    const browserPermissions = await page.evaluate(() => {
      const tenant = JSON.parse(localStorage.getItem('tenant') || 'null');
      return { role: tenant?.role, permissionIds: tenant?.permission_ids };
    });
    expect(browserPermissions.role).toBe('server');
    expect(browserPermissions.permissionIds).toContain('pos.use');
    expect(browserPermissions.permissionIds).toContain('tables.view');
    expect(browserPermissions.permissionIds).not.toContain('bills.generate');
    expect(browserPermissions.permissionIds).not.toContain('whatsapp.use');

    await openOccupiedTable(page, fixture.tableNumber);
    await expect(page.getByRole('heading', { name: fixture.tableNumber, exact: true })).toBeVisible();
    await expect(page.getByText(fixture.order.order_number)).toBeVisible();
    await expect(page.getByRole('button', { name: /Add Items/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Print Bill/ })).toHaveCount(0);
    expect(whatsappStatusRequests).toBe(0);
    expect((await page.request.post(`${BASE}/api/bills/generate`, {
      headers: serverHeaders,
      data: { order_id: fixture.order.id },
    })).status()).toBe(403);
  });
});

test('Orders keeps its bill print confirmation when the post-generation list refresh fails', async ({ page }) => {
  const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
  let restoreSettings: (() => Promise<void>) | undefined;
  let createdFixture: Awaited<ReturnType<typeof createDineInFixture>> | undefined;
  let testError: unknown;
  let generationSucceeded = false;
  let listRefreshFailed = false;

  try {
    restoreSettings = await prepareDineInSettings(page, headers);
    const fixture = await createDineInFixture(page, headers);
    createdFixture = fixture;
    await useBrowserBillPrint(page);
    await loginToPos(page);
    await page.goto(`${BASE}/orders`);
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();

    const orderCard = page.locator('div.bg-card').filter({ hasText: fixture.order.order_number });
    await expect(orderCard).toHaveCount(1);
    const printButton = orderCard.getByRole('button', { name: /Print Bill/ });
    await expect(printButton).toBeVisible();

    await page.route(`${BASE}/api/bills/generate`, async (route) => {
      const response = await route.fetch();
      generationSucceeded = response.ok();
      await route.fulfill({ response });
    });
    await page.route('**/api/orders*', async (route) => {
      const request = route.request();
      if (generationSucceeded
        && !listRefreshFailed
        && request.method() === 'GET'
        && new URL(request.url()).pathname === '/api/orders') {
        listRefreshFailed = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'order list temporarily unavailable' }),
        });
        return;
      }
      await route.continue();
    });

    const generation = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bills/generate');
    const listRefresh = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/orders');
    await printButton.click();
    const generationResponse = await generation;
    expect(generationResponse.ok()).toBeTruthy();
    const bill = (await generationResponse.json()).bill as { id: number; payment_status: string };
    expect((await listRefresh).status()).toBe(503);
    expect(listRefreshFailed).toBe(true);
    await expect(page.getByRole('heading', { name: 'Print Receipt' })).toBeVisible();

    const freshBillRead = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/bills/${bill.id}`);
    await page.getByRole('button', { name: 'Confirm Print' }).click();
    expect((await freshBillRead).ok()).toBeTruthy();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __billPrintHtml?: string[] }).__billPrintHtml?.length ?? 0
    ))).toBe(1);
    const finalBillResponse = await page.request.get(`${BASE}/api/bills/${bill.id}`, { headers });
    expect(finalBillResponse.ok()).toBeTruthy();
    expect((await finalBillResponse.json()).bill.payment_status).toBe('unpaid');
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (createdFixture) await cleanupDineInFixture(page.request, headers, { tableId: createdFixture.tableId, orderId: createdFixture.order.id });
    } catch (error) {
      cleanupError = error;
    }
    try { await restoreSettings?.(); } catch (error) { cleanupError ??= error; }
    if (testError === undefined && cleanupError) throw cleanupError;
  }
});
