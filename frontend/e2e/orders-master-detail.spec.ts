import { request, test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setLanguage,
  setOrdersLayout,
} from './helpers/test-auth';
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
  test('a tenant with no layout preference gets triage rows and a full detail pane', async ({
    page,
  }) => {
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
    const detailPane = page
      .getByRole('button', { name: /Checkout|Take Payment/ })
      .locator('xpath=ancestor::div[contains(@class, "md:flex-1")]');
    const paneBounds = await detailPane.boundingBox();
    const panelBounds = await page.getByTestId('orders-detail-panel').boundingBox();
    expect(paneBounds).not.toBeNull();
    expect(panelBounds).not.toBeNull();
    expect(Math.abs(panelBounds!.x - paneBounds!.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(panelBounds!.x + panelBounds!.width - (paneBounds!.x + paneBounds!.width)),
    ).toBeLessThanOrEqual(1);
  });

  test('keeps a selected order open when a live update removes it from the current view', async ({
    page,
  }) => {
    const order = await createTakeaway(page, 'Live filter selection check');
    await login(page);
    await page.goto(`${BASE}/orders`);
    await page.getByRole('button', { name: 'Unpaid' }).click();

    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();
    await expect(page.getByText('E2E Coffee')).toBeVisible();

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
    const cancelled = await page.request.patch(`${BASE}/api/orders/${order.id}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { status: 'cancelled' },
    });
    expect(cancelled.ok()).toBeTruthy();

    await expect(page.getByText('This order is no longer in the current list.')).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByTestId('orders-detail-panel').getByText(`#${order.order_number}`),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Active' }).click();
    await expect(page.getByText(PLACEHOLDER)).toBeVisible();
    await expect(page.getByText('E2E Coffee')).toBeHidden();

    await page.getByRole('button', { name: 'All' }).click();
    const cancelledOrder = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(cancelledOrder).toBeVisible();
    await cancelledOrder.click();
    await expect(
      page.getByTestId('orders-detail-panel').getByText(`#${order.order_number}`),
    ).toBeVisible();
    await expect(page.getByText('This order is no longer in the current list.')).toBeHidden();
  });

  test('ignores an older order search response after a newer filter request completes', async ({
    page,
  }) => {
    const slowOrder = await createTakeaway(page, 'Older filter response fixture');
    const fastOrder = await createTakeaway(page, 'Newer filter response fixture');
    await login(page);
    await page.goto(`${BASE}/orders`);

    let releaseSlowResponse!: () => void;
    let markSlowRequestStarted!: () => void;
    const slowResponseGate = new Promise<void>((resolve) => {
      releaseSlowResponse = resolve;
    });
    const slowRequestStarted = new Promise<void>((resolve) => {
      markSlowRequestStarted = resolve;
    });
    await page.route(`${BASE}/api/orders?*`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('search') === slowOrder.order_number) {
        const response = await route.fetch();
        markSlowRequestStarted();
        await slowResponseGate;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    try {
      const search = page.getByPlaceholder('Search by order number, name, or phone…');
      await search.fill(slowOrder.order_number);
      await slowRequestStarted;
      await search.fill(fastOrder.order_number);

      const fastRow = page.getByRole('button').filter({ hasText: `#${fastOrder.order_number}` });
      const slowRow = page.getByRole('button').filter({ hasText: `#${slowOrder.order_number}` });
      await expect(fastRow).toBeVisible();
      releaseSlowResponse();
      await expect(slowRow).toBeHidden();
      await expect(fastRow).toBeVisible();
    } finally {
      releaseSlowResponse();
      await page.unroute(`${BASE}/api/orders?*`);
    }
  });

  test('loads older matches inside the master pane without closing the selected detail', async ({
    page,
  }) => {
    const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const orders: Array<{ id: number; order_number: string }> = [];
    for (let index = 0; index < 16; index += 1) {
      const response = await page.request.post(`${BASE}/api/orders`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          type: 'takeaway',
          special_instructions: `Orders page fixture ${index}`,
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(response.status()).toBe(201);
      const { order } = (await response.json()) as { order: { id: number; order_number: string } };
      orders.push(order);
    }

    await login(page);
    await page.goto(`${BASE}/orders`);
    const selectedRow = page.getByRole('button').filter({ hasText: `#${orders[15].order_number}` });
    await expect(selectedRow).toBeVisible();
    await selectedRow.click();

    const masterPane = page.getByTestId('orders-master-pane');
    await masterPane.getByRole('button', { name: 'Load more' }).click();
    await expect(
      page.getByRole('button').filter({ hasText: `#${orders[0].order_number}` }),
    ).toBeVisible();
    await expect(page.getByText('E2E Coffee')).toBeVisible();
  });

  test('Load more restores a displaced selection and ignores its late detail response', async ({
    page,
  }) => {
    const headers = {
      Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
    };
    const orders: Array<{ id: number; order_number: string }> = [];
    for (let index = 0; index < 15; index += 1) {
      const response = await page.request.post(`${BASE}/api/orders`, {
        headers,
        data: {
          type: 'takeaway',
          special_instructions: `Live pagination race ${index}`,
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(response.status()).toBe(201);
      const { order } = (await response.json()) as { order: { id: number; order_number: string } };
      orders.push(order);
    }

    const selected = orders[0];
    await login(page);
    await page.goto(`${BASE}/orders`);
    const selectedRow = page.getByRole('button').filter({ hasText: `#${selected.order_number}` });
    await expect(selectedRow).toBeVisible();
    await selectedRow.click();

    const detail = page.getByTestId('orders-detail-panel');
    await expect(detail).toContainText(`#${selected.order_number}`);
    await expect(detail.getByText('Pending', { exact: true })).toBeVisible();

    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    let finishLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupFinished = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    let heldLookups = 0;

    await page.route('**/api/orders/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.pathname !== `/api/orders/${selected.id}`) {
        await route.continue();
        return;
      }

      try {
        const response = await route.fetch();
        const body = (await response.json()) as { order: { status: string } };
        expect(body.order.status).toBe('pending');
        heldLookups += 1;
        markLookupStarted();
        await lookupGate;
        await route.fulfill({ response, body: JSON.stringify(body) });
      } finally {
        finishLookup();
      }
    });

    try {
      const newOrder = await page.request.post(`${BASE}/api/orders`, {
        headers,
        data: {
          type: 'takeaway',
          special_instructions: 'New order displaces the selected row',
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(newOrder.status()).toBe(201);

      const outsideListNotice = page.getByText('This order is no longer in the current list.');
      await expect(outsideListNotice).toBeVisible({ timeout: 20000 });
      await lookupStarted;

      const refreshedPage = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          url.pathname === '/api/orders' &&
          !url.searchParams.has('before_id')
        );
      });
      const statusResponse = await page.request.patch(`${BASE}/api/orders/${selected.id}/status`, {
        headers,
        data: { status: 'preparing' },
      });
      expect(statusResponse.ok()).toBeTruthy();
      await refreshedPage;

      await page
        .getByTestId('orders-master-pane')
        .getByRole('button', { name: 'Load more' })
        .click();
      await expect(selectedRow).toBeVisible();
      await expect(detail.getByText('Preparing', { exact: true })).toBeVisible();
      await expect(outsideListNotice).toBeHidden();

      const lateLookupResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' && url.pathname === `/api/orders/${selected.id}`
        );
      });
      releaseLookup();
      await lookupFinished;
      const staleResponse = await lateLookupResponse;
      await staleResponse.finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(detail.getByText('Preparing', { exact: true })).toBeVisible();
      await expect(outsideListNotice).toBeHidden();
      expect(heldLookups).toBe(1);
    } finally {
      releaseLookup();
      if (heldLookups > 0) await lookupFinished;
      await page.unroute('**/api/orders/*');
    }
  });

  test('the detail pane carries applied charges and the pre-bill print action', async ({
    page,
  }) => {
    const headers = {
      Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
    };
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
          charges: [
            {
              id: 'e2e_detail_charge',
              name: chargeName,
              type: 'fixed',
              value: 3,
              calculation_basis: 'gross',
              order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
              is_optional: false,
              is_default_active: true,
              is_active: true,
            },
          ],
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

      const printAction = page.getByRole('button', { name: 'Print', exact: true });
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

  test('below the md breakpoint the detail pane takes over and back returns to the list', async ({
    page,
  }) => {
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
    expect(
      scrolled,
      `${label}: order cards scroll inside a bounded content region`,
    ).toBeGreaterThan(0);

    expectPinned(
      await elementTop(title, `${label} Orders title`),
      pinned.title,
      `${label} Orders title`,
    );
    expectPinned(
      await elementTop(search, `${label} search field`),
      pinned.search,
      `${label} search field`,
    );
    expectPinned(
      await elementTop(statusTab, `${label} status tab`),
      pinned.tab,
      `${label} status tab`,
    );

    const viewport = page.viewportSize();
    expect(viewport, `${label}: viewport is set`).not.toBeNull();
    const lastBox = await lastCard.boundingBox();
    expect(lastBox, `${label}: last order card has bounds`).not.toBeNull();
    expect(lastBox!.y, `${label}: last order card is inside the viewport`).toBeGreaterThanOrEqual(
      -1,
    );
    expect(
      lastBox!.y + lastBox!.height,
      `${label}: the last order card is reachable`,
    ).toBeLessThanOrEqual(viewport!.height + 1);

    // The filters remain usable after the scroll, and the pinned row stays put
    // while the filter refetches the list.
    await search.fill('scroll fixture');
    await expect(search, `${label}: search accepts input after scrolling`).toHaveValue(
      'scroll fixture',
    );
    await search.fill('');
    expectPinned(
      await elementTop(title, `${label} Orders title`),
      pinned.title,
      `${label} Orders title`,
    );
  }

  test('desktop: the title, tabs, search and filters stay pinned while cards scroll', async ({
    page,
  }) => {
    await login(page);
    originalLayout = await readOrdersLayout(page);
    await setOrdersLayout(page, 'cards');
    await page.setViewportSize({ width: 1440, height: 900 });
    await createScrollFixtureOrders(page, 12);
    await page.goto(`${BASE}/orders`);
    await expectControlsPinnedWhileCardsScroll(page, 'desktop');
  });

  test('phone: the title, tabs, search and filters stay pinned while cards scroll', async ({
    page,
  }) => {
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

  const headers = () => ({
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  });

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
              id: AUTO_CHARGE.id,
              name: AUTO_CHARGE.name,
              type: 'fixed',
              value: 3,
              calculation_basis: 'gross',
              order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
              is_optional: true,
              is_default_active: true,
              is_active: true,
            },
            {
              id: OPT_CHARGE.id,
              name: OPT_CHARGE.name,
              type: 'fixed',
              value: 5,
              calculation_basis: 'gross',
              order_types: ['dine_in', 'takeaway', 'delivery', 'online'],
              is_optional: true,
              is_default_active: false,
              is_active: true,
            },
          ],
        },
      });
      expect(saved.ok(), 'the two fixture charges are saved').toBeTruthy();

      const businessResponse = await api.get(`${BASE}/api/settings/business`, {
        headers: headers(),
      });
      expect(businessResponse.ok(), 'the business settings are readable').toBeTruthy();
      const business = await businessResponse.json();
      businessBefore = {
        billing_type: business.billing_type,
        tables_required: business.tables_required,
      };
      const switched = await api.put(`${BASE}/api/settings/business`, {
        headers: headers(),
        data: { billing_type: 'postpaid', tables_required: true },
      });
      expect(
        switched.ok(),
        `holding needs postpaid table service (got ${switched.status()})`,
      ).toBeTruthy();

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
      await api.put(`${BASE}/api/settings/charges`, {
        headers: headers(),
        data: { charges: chargesBefore },
      });
      await api.put(`${BASE}/api/settings/business`, { headers: headers(), data: businessBefore });
      if (table)
        await api
          .post(`${BASE}/api/tables/${table.id}/deactivate`, { headers: headers() })
          .catch(() => undefined);
    } finally {
      await api.dispose();
    }
  });

  test('the waived automatic fee and the opted-in optional fee come back with the resumed cart', async ({
    page,
  }) => {
    await login(page);
    await page.goto(`${BASE}/pos`);

    // Dine-in on the fixture table, with the fixture fees offered on the cart.
    await page
      .getByRole('button', { name: /Dine in/i })
      .first()
      .click();
    await page
      .getByRole('button', { name: /Select Table/i })
      .first()
      .click();
    const picker = page.locator('.fixed.inset-0').last();
    await expect(picker).toBeVisible();
    await picker
      .getByRole('button')
      .filter({ hasText: new RegExp(table.number) })
      .first()
      .click();

    // E2E Coffee is a simple product, so the card tap lands it on the cart.
    await page.getByTestId('pos-product-card').filter({ hasText: 'E2E Coffee' }).first().click();

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
      resumedCharges
        .locator(':scope > div')
        .filter({ hasText: AUTO_CHARGE.name })
        .getByRole('button', { name: 'Apply', exact: true }),
      'the waived automatic fee comes back waived',
    ).toBeVisible();
    await expect(
      resumedCharges
        .locator(':scope > div')
        .filter({ hasText: OPT_CHARGE.name })
        .getByRole('button', { name: 'Remove', exact: true }),
      'the opted-in optional fee comes back applied',
    ).toBeVisible();

    // Placing the order proves the same choices reached the backend total.
    await page.getByRole('button', { name: 'Place Order', exact: true }).click();
    await expect(page.getByText(/Order #.* placed!/).first()).toBeVisible({ timeout: 15_000 });

    const listResponse = await page.request.get(`${BASE}/api/orders?table_id=${table.id}`, {
      headers: headers(),
    });
    expect(listResponse.ok(), 'the placed order is readable').toBeTruthy();
    const orders = (await listResponse.json()).orders as { charges_breakdown: string | null }[];
    expect(orders, 'exactly one order was placed on the fixture table').toHaveLength(1);
    const applied = JSON.parse(orders[0].charges_breakdown || '[]') as {
      id: string;
      amount: number;
      waived: boolean;
    }[];
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

test.describe('owner live order item edit and superseded cancellation handling', () => {
  test('persists attempt with Idempotency-Key and expected_edit_version, reuses key on 503 retry, and hides restore on superseded line', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E item edit test',
        items: [{ product_id: 'e2e-product', quantity: 3 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('2');

    const capturedRequests: { key: string | undefined; body: Record<string, unknown> }[] = [];
    let shouldFailFirst = true;
    await page.route(`**/api/orders/${order.id}/items/*/edit`, async (route) => {
      const req = route.request();
      capturedRequests.push({
        key: req.headers()['idempotency-key'],
        body: req.postDataJSON() as Record<string, unknown>,
      });
      if (shouldFailFirst) {
        shouldFailFirst = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary server failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => capturedRequests.length).toBe(1);
    expect(capturedRequests[0].key).toBeTruthy();
    expect(capturedRequests[0].body).toEqual({
      expected_edit_version: 0,
      quantity: 2,
    });

    // After uncertain 503 failure, the quantity input is locked to the persisted attempt
    await expect(qtyInput).toBeDisabled();

    // Retry reuses the exact same Idempotency-Key and payload
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => capturedRequests.length).toBe(2);
    expect(capturedRequests[1].key).toBe(capturedRequests[0].key);
    expect(capturedRequests[1].body).toEqual(capturedRequests[0].body);

    // Modal closes after commit; anchor on the refetched order (the new 2x
    // line) so the superseded line's absence from the voided-items toggle is
    // asserted against post-refresh state, not the stale pre-edit order
    await expect(qtyInput).toBeHidden();
    await expect(page.getByText('2x', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /voided item/i })).toHaveCount(0);
  });

  test('a rate-limited attempt keeps the saved record and its payload intact', async ({ page }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E edit 429 test',
        items: [{ product_id: 'e2e-product', quantity: 3 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('1');

    const rejected = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/orders/${order.id}/items/`) &&
        response.request().method() === 'PATCH',
    );
    await page.route(`**/api/orders/${order.id}/items/*/edit`, (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      });
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await rejected;

    const savedBodies = await page.evaluate(() => {
      const storage = window.localStorage;
      const entries: Array<{ key: string; value: string }> = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) entries.push({ key, value: storage.getItem(key) ?? '' });
      }
      return entries
        .filter((entry) => entry.key.startsWith('flo.orders.item-edit.attempt.v1:'))
        .map((entry) => JSON.parse(entry.value));
    });
    expect(savedBodies, 'the 429 response preserves exactly one saved attempt').toHaveLength(1);
    expect(savedBodies[0].body).toEqual({ expected_edit_version: 0, quantity: 1 });
    expect(savedBodies[0].path).toEqual(`/orders/${order.id}/items/${savedBodies[0].itemId}/edit`);
  });

  test('a definitive 409 rejection clears the saved attempt and refetches the order', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E edit conflict test',
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('2');

    await page.route(`**/api/orders/${order.id}/items/*/edit`, (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'edit version conflict' }),
      });
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(qtyInput).toBeHidden({ timeout: 15000 });

    const remainingAttempts = await page.evaluate(() => {
      const storage = window.localStorage;
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) keys.push(key);
      }
      return keys.filter((key) => key.startsWith('flo.orders.item-edit.attempt.v1:'));
    });
    expect(remainingAttempts, 'a definitive conflict clears the matching record').toHaveLength(0);
  });

  test('a committed edit whose response was dropped stays resolvable after reload without auto-patching', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E edit recovery test',
        items: [{ product_id: 'e2e-product', quantity: 3 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('2');

    // Forward a real commit through route.fetch() so the backend registers the
    // edit, then abort the browser response so the page sees an uncertain one.
    let forwardCalls = 0;
    await page.route(`**/api/orders/${order.id}/items/*/edit`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      forwardCalls += 1;
      const response = await route.fetch();
      await route.abort();
      void response;
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => forwardCalls).toBe(1);

    // The edit really reached the server before the response was dropped.
    const apiOrder = await page.request.get(`${BASE}/api/orders/${order.id}`, {
      headers: ownerHeaders,
    });
    expect(apiOrder.ok()).toBeTruthy();
    const committedItems = (await apiOrder.json()).order.items as {
      quantity: number;
      superseded?: boolean;
    }[];
    const activeCommitted = committedItems.filter((i) => !i.superseded);
    expect(activeCommitted.some((i) => i.quantity === 2)).toBe(true);

    await page.unroute(`**/api/orders/${order.id}/items/*/edit`);

    // Reload never replays a saved edit silently: opening the order with the
    // now-hidden original line still exposes the pending edit notice.
    let recoveryPatches = 0;
    await page.route(`**/api/orders/${order.id}/items/*/edit`, (route) => {
      if (route.request().method() === 'PATCH') recoveryPatches += 1;
      return route.continue();
    });

    // Return to a clean page state, then reload the orders screen.
    await page.goto(`${BASE}/pos`);
    await page.reload();
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/orders`);
    await masterRow.click();

    await expect(page.getByRole('button', { name: 'Resolve pending edit' }).first()).toBeVisible({
      timeout: 15000,
    });
    expect(recoveryPatches, 'discovery alone never sends a PATCH').toBe(0);

    // Manual resolve replays the exact stored request (same key and body) and
    // then refreshes the loaded order to its latest state.
    const resolvedPatches: { key?: string; body: Record<string, unknown> }[] = [];
    await page.unroute(`**/api/orders/${order.id}/items/*/edit`);
    await page.route(`**/api/orders/${order.id}/items/*/edit`, async (route) => {
      if (route.request().method() === 'PATCH') {
        resolvedPatches.push({
          key: route.request().headers()['idempotency-key'],
          body: route.request().postDataJSON() as Record<string, unknown>,
        });
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Resolve pending edit' }).first().click();
    await expect
      .poll(() => resolvedPatches.length, 'the resolve action sends one replayed PATCH')
      .toBeGreaterThanOrEqual(1);
    expect(resolvedPatches[0].key).toBeTruthy();
    expect(resolvedPatches[0].body).toEqual({ expected_edit_version: 0, quantity: 2 });

    // The notice clears and the reloaded order reflects the committed edit.
    await expect(page.getByText('2x', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Resolve pending edit' })).toHaveCount(0);
  });

  test('manual recovery with a definitive 409 rejection clears the stored attempt and displays the rejection notice', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E recovery 409 rejection test',
        items: [{ product_id: 'e2e-product', quantity: 3 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('2');

    // Abort the response on edit to leave a saved attempt
    let aborted = false;
    await page.route(`**/api/orders/${order.id}/items/*/edit`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.abort();
      aborted = true;
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => aborted).toBe(true);
    await page.unroute(`**/api/orders/${order.id}/items/*/edit`);

    // Reload the orders screen to discover the saved attempt
    await page.goto(`${BASE}/pos`);
    await page.reload();
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/orders`);
    await masterRow.click();

    const resolveBtn = page.getByRole('button', { name: 'Resolve pending edit' }).first();
    await expect(resolveBtn).toBeVisible({ timeout: 15000 });

    // Mock 409 conflict when clicking Resolve
    await page.route(`**/api/orders/${order.id}/items/*/edit`, (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'edit version conflict' }),
      });
    });

    let failRefresh = true;
    await page.route(`**/api/orders/${order.id}`, (route) => {
      if (failRefresh && route.request().method() === 'GET') {
        return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
      }
      return route.continue();
    });
    await resolveBtn.click();

    // Rejection notice is displayed and the attempt is cleared from localStorage
    const rejectionNotice = page.getByTestId('pending-item-edit-rejection');
    await expect(rejectionNotice).toBeVisible({ timeout: 15000 });
    await expect(rejectionNotice).toContainText('edit version conflict');
    const refreshWarning = page.getByTestId('pending-item-edit-refresh-failed');
    await expect(refreshWarning).toBeVisible();

    const remainingAttempts = await page.evaluate(() => {
      const storage = window.localStorage;
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith('flo.orders.item-edit.attempt.v1:')) keys.push(key);
      }
      return keys;
    });
    expect(remainingAttempts, 'the definitive 409 rejection clears the saved attempt').toHaveLength(
      0,
    );

    // Close button dismisses the rejection notice
    await rejectionNotice.getByRole('button', { name: 'Close' }).click();
    await expect(rejectionNotice).toBeHidden();
    await expect(refreshWarning).toBeVisible();
    failRefresh = false;
    await refreshWarning.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(refreshWarning).toBeHidden();
  });

  test('queued recovery does not send after item-edit permission is revoked', async ({ page }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const response = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 3 }] },
    });
    expect(response.status()).toBe(201);
    const order = (await response.json()).order;
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');
    const itemId = order.items[0].id as number;
    const key = await page.evaluate(
      ({ orderId, itemId }) => {
        const tenantId = JSON.parse(localStorage.getItem('tenant')!).id;
        const key = `flo.orders.item-edit.attempt.v1:${tenantId}:e2e-owner:${orderId}:${itemId}`;
        localStorage.setItem(
          key,
          JSON.stringify({
            mode: 'quantity',
            path: `/orders/${orderId}/items/${itemId}/edit`,
            orderId,
            itemId,
            actorId: 'e2e-owner',
            tenantId,
            idempotencyKey: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            body: { expected_edit_version: 0, quantity: 2 },
          }),
        );
        return key;
      },
      { orderId: order.id, itemId },
    );
    await page.goto(`${BASE}/orders`);
    await page
      .getByRole('button')
      .filter({ hasText: `#${order.order_number}` })
      .click();
    const resolve = page.getByRole('button', { name: 'Resolve pending edit', exact: true });
    await expect(resolve).toBeVisible();
    let patchCount = 0;
    await page.route(`**/api/orders/${order.id}/items/${itemId}/edit`, (route) => {
      patchCount += 1;
      return route.fulfill({ status: 503, json: { error: 'Must not dispatch' } });
    });
    await page.evaluate(async (key) => {
      await new Promise<void>((ready) => {
        void navigator.locks.request(
          key,
          () =>
            new Promise<void>((release) => {
              (window as Window & { releaseRecoveryLock?: () => void }).releaseRecoveryLock =
                release;
              ready();
            }),
        );
      });
    }, key);
    try {
      await resolve.click();
      await expect
        .poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.length ?? 0))
        .toBeGreaterThan(0);
      await page.route('**/api/auth/me', async (route) => {
        const original = await route.fetch();
        const data = await original.json();
        for (const tenant of data.tenants) {
          expect(Array.isArray(tenant.permission_ids)).toBe(true);
          tenant.permission_ids = tenant.permission_ids.filter(
            (id: string) => id !== 'orders.item.edit',
          );
        }
        return route.fulfill({ response: original, json: data });
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(
        page.getByRole('button', { name: 'Resolving edit...', exact: true }),
      ).toBeHidden();
      await page.evaluate(() =>
        (window as Window & { releaseRecoveryLock?: () => void }).releaseRecoveryLock?.(),
      );
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const locks = await navigator.locks.query();
            return (locks.pending?.length ?? 0) + (locks.held?.length ?? 0);
          }),
        )
        .toBe(0);
      expect(patchCount, 'revoked permission aborts the queued replay before HTTP dispatch').toBe(
        0,
      );
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).not.toBeNull();
    } finally {
      await page.evaluate(() =>
        (window as Window & { releaseRecoveryLock?: () => void }).releaseRecoveryLock?.(),
      );
    }
  });

  test('a committed recovery whose current-order refresh fails keeps the refresh retry visible', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E recovery refresh fail test',
        items: [{ product_id: 'e2e-product', quantity: 3 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('2');

    // Forward the real commit then abort so the attempt stays in storage
    let committed = false;
    await page.route(`**/api/orders/${order.id}/items/*/edit`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const res = await route.fetch();
      await route.abort();
      void res;
      committed = true;
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await page.unroute(`**/api/orders/${order.id}/items/*/edit`);

    // Reload the orders screen
    await page.goto(`${BASE}/pos`);
    await page.reload();
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/orders`);
    await masterRow.click();

    const resolveBtn = page.getByRole('button', { name: 'Resolve pending edit' }).first();
    await expect(resolveBtn).toBeVisible({ timeout: 15000 });

    // Mock GET order refresh to fail
    let failGet = true;
    await page.route(`**/api/orders/${order.id}`, (route) => {
      if (failGet && route.request().method() === 'GET') {
        return route.fulfill({ status: 500, body: 'Refresh Failed' });
      }
      return route.continue();
    });

    await resolveBtn.click();

    // The refresh warning and retry button appear
    const refreshWarning = page.getByTestId('pending-item-edit-refresh-failed');
    await expect(refreshWarning).toBeVisible({ timeout: 15000 });
    const retryBtn = page.getByTestId('retry-refresh-button');
    await expect(retryBtn).toBeVisible();

    // The attempt is cleared from localStorage despite the refresh failure
    const remainingAttempts = await page.evaluate(() => {
      const storage = window.localStorage;
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith('flo.orders.item-edit.attempt.v1:')) keys.push(key);
      }
      return keys;
    });
    expect(remainingAttempts, 'the committed edit is cleared from local storage').toHaveLength(0);

    // Unblock GET and click Retry
    failGet = false;
    await retryBtn.click();
    await expect(refreshWarning).toBeHidden({ timeout: 15000 });
  });

  test('an uncertainless 403 keeps the saved attempt so a permitted reveal can resolve it', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E edit 403 test',
        items: [{ product_id: 'e2e-product', quantity: 3 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as { id: number; order_number: string };

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    const editButton = page.getByTitle('Edit item').first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    const qtyInput = page.locator('input[type="number"]');
    await expect(qtyInput).toBeVisible();
    await qtyInput.fill('1');

    const rejected = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/orders/${order.id}/items/`) &&
        response.request().method() === 'PATCH',
    );
    await page.route(`**/api/orders/${order.id}/items/*/edit`, (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Forbidden' }),
      });
    });

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await rejected;

    // A 403 cannot establish whether an earlier attempt committed, so the
    // saved record must survive for the same actor's next attempt.
    const survivingAttempt = await page.evaluate(() => {
      const storage = window.localStorage;
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) keys.push(key);
      }
      return keys.filter((key) => key.startsWith('flo.orders.item-edit.attempt.v1:'));
    });
    expect(survivingAttempt, 'the 403 response preserves the saved attempt').toHaveLength(1);
  });
  test('a started item says increases and decreases are allowed while replacement stays blocked', async ({
    page,
  }) => {
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const orderResponse = await page.request.post(`${BASE}/api/orders`, {
      headers: ownerHeaders,
      data: {
        type: 'takeaway',
        special_instructions: 'E2E kitchen hint test',
        items: [{ product_id: 'e2e-product', quantity: 2 }],
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = (await orderResponse.json()).order as {
      id: number;
      order_number: string;
      items: { id: number }[];
    };
    const started = await page.request.patch(`${BASE}/api/kds/items/${order.items[0].id}/status`, {
      headers: ownerHeaders,
      data: { status: 'preparing' },
    });
    expect(started.ok(), 'the fixture item is sent to the kitchen').toBeTruthy();

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
    await expect(masterRow).toBeVisible();
    await masterRow.click();

    await page.getByTitle('Edit item').first().click();

    // The hint matches what the backend actually permits.
    await expect(
      page.getByText(
        'Preparation has started. You can increase or reduce the quantity. Replacing the product is unavailable.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace item' })).toBeDisabled();

    // A quantity reduction on a started item needs the waste reason.
    const qtyInput = page.locator('input[type="number"]');
    await qtyInput.fill('1');
    await expect(page.getByText('Waste reason (required)')).toBeVisible();
    await expect(page.getByPlaceholder('Reason for kitchen waste')).toBeVisible();

    // Increasing keeps the reason optional.
    await qtyInput.fill('3');
    await expect(page.getByText('Waste reason (required)')).toBeHidden();
  });
});

test.describe('owner order item editing on an online platform quotes platform prices', () => {
  const headers = () => ({
    Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  });

  test('the replacement customizer and selected preview quote the variant online price', async ({
    page,
  }) => {
    const variantName = 'LatteLarge';
    const productResponse = await page.request.post(`${BASE}/api/products`, {
      headers: headers(),
      data: {
        name: 'E2E Online Latte',
        price: 100,
        tax_type: 'none',
        variants: [{ name: variantName, price: 100, online_price: 140 }],
      },
    });
    expect(productResponse.status(), 'fixture product created').toBe(201);
    const fixture = (await productResponse.json()).product as {
      id: string;
      variants: { id: string }[];
    };
    const variantId = fixture.variants[0].id;

    // The suite shares one disposable database: remove the test-owned product afterwards.
    // Later spec files see only the seeded menu cards on the POS grid.
    try {
      const orderResponse = await page.request.post(`${BASE}/api/orders`, {
        headers: headers(),
        data: {
          type: 'takeaway',
          online_platform: 'grab',
          special_instructions: 'E2E online pricing test',
          items: [
            { product_id: 'e2e-product', quantity: 1 },
            { product_id: fixture.id, variant_id: variantId, quantity: 1 },
          ],
        },
      });
      expect(orderResponse.status(), 'online order created').toBe(201);
      const order = (await orderResponse.json()).order as { id: number; order_number: string };

      await page.goto(`${BASE}/auth/login`);
      await page.locator('#email').fill('owner@flo.local');
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL('**/pos/**', { timeout: 20000 });
      await setLanguage(page, 'en');

      await page.goto(`${BASE}/orders`);
      const masterRow = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
      await expect(masterRow).toBeVisible();
      await masterRow.click();

      // Identify the latte line by its product name inside the detail pane.
      const latteRow = page
        .getByTestId('orders-detail-panel')
        .locator('div')
        .filter({ hasText: 'E2E Online Latte' })
        .getByTitle('Edit item')
        .first();
      await expect(latteRow).toBeVisible();
      await latteRow.click();

      await page.getByRole('button', { name: 'Replace item' }).click();
      const search = page.getByPlaceholder('Search products');
      await expect(search).toBeVisible();
      await search.fill('E2E Online Latte');
      const match = page.locator('button').filter({ hasText: 'E2E Online Latte' }).last();
      await expect(match).toBeVisible();
      await match.click();

      // The customizer quotes the platform price for the order's platform.
      const customizerHeading = page.getByRole('heading', { name: 'E2E Online Latte' });
      await expect(customizerHeading).toBeVisible();
      const quotedPrice = customizerHeading.locator('xpath=following-sibling::p');
      await expect(quotedPrice).toBeVisible();
      await expect(quotedPrice, 'customizer (AddonModal) shows the online price').toContainText(
        '140',
      );

      // Confirm the customizer; the selected replacement preview also quotes the
      // platform price basis, not the counter price.
      await page.getByRole('button', { name: /Save changes/ }).click();
      const preview = page
        .locator('div.rounded-lg.border.p-3')
        .filter({ hasText: 'E2E Online Latte' });
      await expect(preview).toBeVisible();
      await expect(preview, 'selected replacement preview shows the online price').toContainText(
        '140',
      );
    } finally {
      await page.request.delete(`${BASE}/api/products/${fixture.id}`, {
        headers: headers(),
      });
    }
  });
});
