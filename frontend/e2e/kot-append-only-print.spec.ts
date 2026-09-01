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
