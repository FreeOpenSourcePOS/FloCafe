import { request, test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, readOrdersLayout, setLanguage, setOrdersLayout } from './helpers/test-auth';
import { elementTop, expectPinned, innermostScrollableAncestor } from './helpers/layout';

/**
 * Orders master/detail split view (#639) — DEFAULT layout coverage.
 *
 * `orders_layout` defaults to 'split', so this spec deliberately pins nothing
 * and asserts that a tenant which never chose a layout gets the master/detail
 * screen. It is the counterpart to the card-grid specs that pin 'cards' through
 * the `readOrdersLayout` / `setOrdersLayout` helpers in helpers/test-auth.ts.
 *
 * WHY THE CARD-GRID SPECS PIN 'cards' — keep this paragraph if you touch them.
 * Those specs locate an order with `page.locator('div.bg-card.rounded-xl')`, the
 * OrderCard root class. Under the split layout that selector resolves to the
 * master-pane wrapper instead, so the OrderCard affordances they drive (Link
 * Customer, New Order, Print) are never in scope and each spec fails on a 30s
 * locator timeout. Measured on the #639 branch:
 *
 *   split (the default)        ->  8 failed, 1 passed  (2.9m)
 *   orders_layout pinned cards ->  9 passed             (13.5s)
 *
 * They therefore declare the mode they test rather than inheriting the default.
 * The pin is undone in `test.afterEach`, because the e2e server shares one
 * database with the whole suite.
 */

const PLACEHOLDER = 'Select an order on the left to view details.';

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
}

async function createTakeaway(page: import('@playwright/test').Page, note: string) {
  const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: E2E_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { access_token: token } = await loginResponse.json();
  const orderResponse = await page.request.post(`${BASE}/api/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      type: 'takeaway',
      special_instructions: note,
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(orderResponse.ok()).toBeTruthy();
  return (await orderResponse.json()).order as { id: number; order_number: string };
}

test.describe('orders master/detail is the default layout', () => {
  test('a tenant with no layout preference gets triage rows and a full detail pane', async ({ page }) => {
    const order = await createTakeaway(page, 'Split default detail check');
    await login(page);

    // The default itself, asserted at the source rather than inferred from the UI.
    expect(await readOrdersLayout(page)).toBe('split');

    await page.goto(`${BASE}/orders`);

    // Left pane: one compact triage row carrying order number, item count and
    // the bold total. OrderCard-only affordances are absent before a selection,
    // which is what makes this the split view and not the cards grid.
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await expect(masterRow).toContainText('1 item');
    await expect(masterRow).toContainText('฿64.20');
    await expect(masterRow.getByRole('button', { name: 'Link Customer' })).toHaveCount(0);

    // Right pane starts on a clean placeholder, per the #639 empty state.
    await expect(page.getByText(PLACEHOLDER)).toBeVisible();

    // Selecting a row moves the order into the detail pane with its items and
    // the actions the cards path exposes. Only the detail pane renders these, so
    // they double as the proof that the detail pane — not a card — took over.
    await masterRow.click();
    await expect(masterRow).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText(PLACEHOLDER)).toBeHidden();
    await expect(page.getByText('E2E Coffee')).toBeVisible();
    await expect(page.getByRole('button', { name: /Checkout|Take Payment/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Item' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link Customer' })).toBeVisible();
  });

  test('the detail pane carries applied charges and the pre-bill print action', async ({ page }) => {
    const headers = { Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` };
    const chargeName = 'E2E Detail Fee';
    const originalCharges = await page.request.get(`${BASE}/api/settings/charges`, { headers });
    expect(originalCharges.ok()).toBeTruthy();
    const restoreCharges = (await originalCharges.json()).charges as unknown[];

    try {
      // An auto-applied charge is exactly what the detail pane has to account
      // for, otherwise staff cannot explain the total they are about to collect.
      const charges = await page.request.put(`${BASE}/api/settings/charges`, {
        headers,
        data: {
          charges: [{
            id: 'e2e_detail_charge',
            name: chargeName,
            type: 'fixed',
            value: 3,
            calculation_basis: 'gross',
            order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
            is_optional: false,
            is_default_active: true,
            is_active: true,
          }],
        },
      });
      expect(charges.ok()).toBeTruthy();

      // Dine-in and bill-less: the Print action has to generate the bill rather
      // than wait for checkout.
      const orderResponse = await page.request.post(`${BASE}/api/orders`, {
        headers,
        data: { type: 'dine_in', items: [{ product_id: 'e2e-product', quantity: 1 }] },
      });
      expect(orderResponse.status()).toBe(201);
      const order = (await orderResponse.json()).order as { id: number; order_number: string };

      await login(page);
      await page.goto(`${BASE}/orders`);

      const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
      await expect(masterRow).toBeVisible();
      await masterRow.click();

      await expect(page.getByText(chargeName, { exact: true })).toBeVisible();

      const printAction = page.getByTitle('Print');
      await expect(printAction).toBeVisible();
      await printAction.click();
      await expect(page.getByRole('heading', { name: 'Print Receipt' })).toBeVisible();
    } finally {
      const restored = await page.request.put(`${BASE}/api/settings/charges`, {
        headers,
        data: { charges: restoreCharges },
      });
      expect(restored.ok()).toBeTruthy();
    }
  });

  test('below the md breakpoint the detail pane takes over and back returns to the list', async ({ page }) => {
    const order = await createTakeaway(page, 'Split default responsive check');
    await login(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/orders`);

    // Single column: the list owns the screen and the detail pane is not offered.
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await expect(page.getByText(PLACEHOLDER)).toBeHidden();

    await masterRow.click();
    await expect(masterRow).toBeHidden();
    await expect(page.getByText('E2E Coffee')).toBeVisible();

    // Back navigation returns to the list and the placeholder comes back.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(masterRow).toBeVisible();
    await expect(page.getByText(PLACEHOLDER)).toBeHidden();
  });
});

/**
 * The cards layout is the mode where the merchant report applies: its content
 * used to share the dashboard page scroll, so the title, status tabs, search
 * and filters left the screen as soon as an order list grew. These tests hold
 * the controls in place and prove the cards region owns the scroll.
 */
test.describe('orders cards layout keeps controls visible while order cards scroll', () => {
  let originalLayout: 'split' | 'cards' | null = null;

  test.afterEach(async ({ page }) => {
    if (!originalLayout) return;
    await setOrdersLayout(page, originalLayout);
    originalLayout = null;
  });

  /** A dozen takeaway orders overflow one desktop card panel; six overflow a phone. */
  async function createScrollFixtureOrders(page: Page, count: number): Promise<void> {
    const loginResponse = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: 'manager@flo.local', password: E2E_PASSWORD },
    });
    expect(loginResponse.ok(), 'fixture login succeeds').toBeTruthy();
    const { access_token: token } = await loginResponse.json();
    for (let index = 0; index < count; index += 1) {
      const response = await page.request.post(`${BASE}/api/orders`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          type: 'takeaway',
          special_instructions: `Card scroll fixture ${index}`,
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(response.ok(), `scroll fixture order ${index} is created`).toBeTruthy();
    }
  }

  async function expectControlsPinnedWhileCardsScroll(page: Page, label: string): Promise<void> {
    const title = page.getByRole('heading', { name: 'Orders' });
    const search = page.getByPlaceholder('Search by order number, name, or phone…');
    const statusTab = page.getByRole('button', { name: 'All', exact: true });
    await expect(title, `${label}: title renders`).toBeVisible();
    await expect(search, `${label}: search renders`).toBeVisible();
    await expect(statusTab, `${label}: status tabs render`).toBeVisible();

    const pinned = {
      title: await elementTop(title, `${label} Orders title`),
      search: await elementTop(search, `${label} search field`),
      tab: await elementTop(statusTab, `${label} status tab`),
    };

    const cards = page.locator('div.bg-card.rounded-xl');
    await expect(cards.first(), `${label}: order cards render`).toBeVisible();
    const lastCard = cards.last();

    const scroller = await innermostScrollableAncestor(lastCard);
    const scrolled = await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scrolled, `${label}: order cards scroll inside a bounded content region`).toBeGreaterThan(0);

    expectPinned(await elementTop(title, `${label} Orders title`), pinned.title, `${label} Orders title`);
    expectPinned(await elementTop(search, `${label} search field`), pinned.search, `${label} search field`);
    expectPinned(await elementTop(statusTab, `${label} status tab`), pinned.tab, `${label} status tab`);

    const viewport = page.viewportSize();
    expect(viewport, `${label}: viewport is set`).not.toBeNull();
    const lastBox = await lastCard.boundingBox();
    expect(lastBox, `${label}: last order card has bounds`).not.toBeNull();
    expect(lastBox!.y, `${label}: last order card is inside the viewport`).toBeGreaterThanOrEqual(-1);
    expect(
      lastBox!.y + lastBox!.height,
      `${label}: the last order card is reachable`,
    ).toBeLessThanOrEqual(viewport!.height + 1);

    // The filters remain usable after the scroll, and the pinned row stays put
    // while the filter refetches the list.
    await search.fill('scroll fixture');
    await expect(search, `${label}: search accepts input after scrolling`).toHaveValue('scroll fixture');
    await search.fill('');
    expectPinned(await elementTop(title, `${label} Orders title`), pinned.title, `${label} Orders title`);
  }

  test('desktop: the title, tabs, search and filters stay pinned while cards scroll', async ({ page }) => {
    await login(page);
    originalLayout = await readOrdersLayout(page);
    await setOrdersLayout(page, 'cards');
    await page.setViewportSize({ width: 1440, height: 900 });
    await createScrollFixtureOrders(page, 12);
    await page.goto(`${BASE}/orders`);
    await expectControlsPinnedWhileCardsScroll(page, 'desktop');
  });

  test('phone: the title, tabs, search and filters stay pinned while cards scroll', async ({ page }) => {
    await login(page);
    originalLayout = await readOrdersLayout(page);
    await setOrdersLayout(page, 'cards');
    await page.setViewportSize({ width: 390, height: 844 });
    await createScrollFixtureOrders(page, 8);
    await page.goto(`${BASE}/orders`);
    await expectControlsPinnedWhileCardsScroll(page, 'phone');
  });
});

/**
 * A held cart remembers the charge choices the cashier made. Resuming it from
 * the Orders screen runs the restore handler while the cart still holds another
 * order type, and a real type change clears those choices by design — so the
 * handler has to settle the target type before it installs the saved
 * selections. Loading first then switching un-waives the automatic fee and drops
 * the opted-in optional fee, changing the amount the cashier would collect.
 */
test.describe('a held cart resumed from another order type keeps its charge selections', () => {
  const AUTO_CHARGE = { id: 'e2e_resume_auto', name: 'E2E Resume Auto Fee' };
  const OPT_CHARGE = { id: 'e2e_resume_opt', name: 'E2E Resume Optional Fee' };
  let table: { id: string; number: string };
  let chargesBefore: unknown[] = [];
  let businessBefore: Record<string, unknown> = {};

  const headers = () => ({ Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}` });

  test.beforeAll(async () => {
    const api = await request.newContext();
    try {
      const chargesResponse = await api.get(`${BASE}/api/settings/charges`, { headers: headers() });
      expect(chargesResponse.ok(), 'the charge settings are readable').toBeTruthy();
      chargesBefore = (await chargesResponse.json()).charges as unknown[];
      const saved = await api.put(`${BASE}/api/settings/charges`, {
        headers: headers(),
        data: {
          charges: [
            {
              id: AUTO_CHARGE.id, name: AUTO_CHARGE.name, type: 'fixed', value: 3,
              calculation_basis: 'gross',
              order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
              is_optional: true, is_default_active: true, is_active: true,
            },
            {
              id: OPT_CHARGE.id, name: OPT_CHARGE.name, type: 'fixed', value: 5,
              calculation_basis: 'gross',
              order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
              is_optional: true, is_default_active: false, is_active: true,
            },
          ],
        },
      });
      expect(saved.ok(), 'the two fixture charges are saved').toBeTruthy();

      const businessResponse = await api.get(`${BASE}/api/settings/business`, { headers: headers() });
      expect(businessResponse.ok(), 'the business settings are readable').toBeTruthy();
      const business = await businessResponse.json();
      businessBefore = { billing_type: business.billing_type, tables_required: business.tables_required };
      const switched = await api.put(`${BASE}/api/settings/business`, {
        headers: headers(),
        data: { billing_type: 'postpaid', tables_required: true },
      });
      expect(switched.ok(), `holding needs postpaid table service (got ${switched.status()})`).toBeTruthy();

      const number = `Rsm${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const tableResponse = await api.post(`${BASE}/api/tables`, {
        headers: headers(),
        data: { number, name: number, capacity: 4, floor: 'Ground' },
      });
      expect(tableResponse.status(), 'the fixture table is created').toBe(201);
      table = { id: (await tableResponse.json()).table.id as string, number };
    } finally {
      await api.dispose();
    }
  });

  test.afterAll(async () => {
    const api = await request.newContext();
    try {
      await api.put(`${BASE}/api/settings/charges`, { headers: headers(), data: { charges: chargesBefore } });
      await api.put(`${BASE}/api/settings/business`, { headers: headers(), data: businessBefore });
      if (table) await api.post(`${BASE}/api/tables/${table.id}/deactivate`, { headers: headers() }).catch(() => undefined);
    } finally {
      await api.dispose();
    }
  });

  test('the waived automatic fee and the opted-in optional fee come back with the resumed cart', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/pos`);

    // Dine-in on the fixture table, with the fixture fees offered on the cart.
    await page.getByRole('button', { name: /Dine in/i }).first().click();
    await page.getByRole('button', { name: /Select Table/i }).first().click();
    const picker = page.locator('.fixed.inset-0').last();
    await expect(picker).toBeVisible();
    await picker.getByRole('button').filter({ hasText: new RegExp(table.number) }).first().click();

    await page.getByTestId('pos-product-card').filter({ hasText: 'E2E Coffee' }).first().click();
    const confirmAdd = page.getByRole('button', { name: /^Add to Cart/ });
    await confirmAdd.first().click();
    await expect(confirmAdd.first()).toBeHidden();

    // The cashier waives the automatic fee and opts in to the optional one.
    const chargeRows = page.getByTestId('cart-charges');
    await expect(chargeRows).toBeVisible();
    await chargeRows.getByRole('button', { name: 'Waive', exact: true }).click();
    await chargeRows.getByRole('button', { name: 'Add', exact: true }).click();
    const autoRow = chargeRows.locator(':scope > div').filter({ hasText: AUTO_CHARGE.name });
    const optRow = chargeRows.locator(':scope > div').filter({ hasText: OPT_CHARGE.name });
    await expect(autoRow.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
    await expect(optRow.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();

    // Park the cart on the held table, then start a fresh cart on another type.
    await page.getByRole('button', { name: 'Hold', exact: true }).click();
    await expect(page.getByText(`Order held for ${table.number}`)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Takeaway', exact: true }).click();

    // Resume from Orders over client-side navigation, so the in-memory
    // takeaway cart survives into the restore handler (a full page load would
    // rebuild the cart as dine-in and hide the ordering hazard).
    await page.getByRole('link', { name: 'Orders', exact: true }).first().click();
    await expect(page).toHaveURL(/\/orders/);
    await page.getByRole('button', { name: 'Held', exact: true }).first().click();
    const resume = page.getByRole('button', { name: /Resume in POS/i }).first();
    await expect(resume, 'the held order offers a resume action').toBeVisible({ timeout: 20_000 });
    await resume.click();
    await expect(page).toHaveURL(/\/pos/);

    // The saved choices are back: the type change must not have cleared them.
    const resumedCharges = page.getByTestId('cart-charges');
    await expect(resumedCharges).toBeVisible();
    await expect(
      resumedCharges.locator(':scope > div').filter({ hasText: AUTO_CHARGE.name }).getByRole('button', { name: 'Apply', exact: true }),
      'the waived automatic fee comes back waived',
    ).toBeVisible();
    await expect(
      resumedCharges.locator(':scope > div').filter({ hasText: OPT_CHARGE.name }).getByRole('button', { name: 'Remove', exact: true }),
      'the opted-in optional fee comes back applied',
    ).toBeVisible();

    // Placing the order proves the same choices reached the backend total.
    await page.getByRole('button', { name: 'Place Order', exact: true }).click();
    await expect(page.getByText(/Order #.* placed!/).first()).toBeVisible({ timeout: 15_000 });

    const listResponse = await page.request.get(`${BASE}/api/orders?table_id=${table.id}`, { headers: headers() });
    expect(listResponse.ok(), 'the placed order is readable').toBeTruthy();
    const orders = (await listResponse.json()).orders as { charges_breakdown: string | null }[];
    expect(orders, 'exactly one order was placed on the fixture table').toHaveLength(1);
    const applied = JSON.parse(orders[0].charges_breakdown || '[]') as { id: string; amount: number; waived: boolean }[];
    const auto = applied.find((charge) => charge.id === AUTO_CHARGE.id);
    const opt = applied.find((charge) => charge.id === OPT_CHARGE.id);
    expect(auto, 'the automatic fee is part of the order charges').toBeTruthy();
    expect(auto!.waived, 'the automatic fee stays waived on the placed order').toBe(true);
    expect(Number(auto!.amount), 'a waived fee contributes nothing').toBe(0);
    expect(opt, 'the optional fee is part of the order charges').toBeTruthy();
    expect(opt!.waived, 'the optional fee stays applied on the placed order').toBe(false);
    expect(Number(opt!.amount), 'the optional fee keeps its configured amount').toBe(5);
  });
});