import { test, expect, type Page } from '@playwright/test';
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