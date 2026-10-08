import { request, test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { elementTop, expectPinned, scrollToEnd } from './helpers/layout';

test('POS product grid has no horizontal clipping and touchable product cards', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();

  // The LAN/browser build must not render Electron-only title-bar markup.
  expect(await page.evaluate(() => Boolean(window.electronAPI))).toBe(false);
  await expect(page.getByTestId('desktop-title-bar')).toHaveCount(0);
  await expect(page.getByTestId('desktop-drag-surface')).toHaveCount(0);

  const productGrid = page.getByTestId('pos-product-grid');
  await expect(productGrid).toBeVisible();
  await expect(page.getByTestId('pos-product-card')).toHaveCount(1);

  const grid = await productGrid.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(grid.scrollWidth, 'POS grid does not overflow horizontally').toBeLessThanOrEqual(grid.clientWidth);

  const card = await page.getByTestId('pos-product-card').boundingBox();
  expect(card, 'product card has bounds').not.toBeNull();
  expect(card!.width, 'product card width').toBeGreaterThanOrEqual(44);
  expect(card!.height, 'product card height').toBeGreaterThanOrEqual(44);
});

test('LAN/browser sidebar pins to the viewport top with zero title-bar markup on the POS, KDS, and settings routes', async ({ page }) => {
  // One login keeps the suite within the shared server's login rate limit.
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });

  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await expect(sidebar).toBeVisible();

  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(viewportHeight).toBeGreaterThan(0);

  const assertViewportTopGeometry = async (label: string) => {
    const box = await sidebar.boundingBox();
    expect(box, `${label}: sidebar has bounds`).not.toBeNull();
    expect(box!.y, `${label}: sidebar starts at viewport top`).toBe(0);
    expect(box!.height, `${label}: sidebar spans the viewport`).toBeCloseTo(viewportHeight, 0);
    const top = await sidebar.evaluate((element) => getComputedStyle(element).top);
    expect(top, `${label}: computed block-start inset`).toBe('0px');
  };

  // Every dashboard layout route shares the same fixed-sidebar chrome, so the
  // capability-absent contract must hold on each of them in expanded and
  // collapsed/rail variants: zero Electron title-bar markup, no CSS desktop
  // flag, viewport-top sidebar geometry. /kds is served by its standalone
  // KDS server (the main LAN app reserves /kds for its WebSocket endpoint),
  // so it is exercised against the same static export on the KDS origin.
  const dashboardRoutes = [
    { name: 'POS', url: `${BASE}/pos` },
    { name: 'KDS', url: `${E2E_KDS_BASE_URL}/kds` },
    { name: 'settings', url: `${BASE}/settings` },
  ];
  for (const route of dashboardRoutes) {
    await page.goto(route.url);
    await expect(sidebar, `${route.name}: sidebar renders`).toBeVisible();

    expect(await page.evaluate(() => Boolean(window.electronAPI)), `${route.name}: capability absent`).toBe(false);
    await expect(page.getByTestId('desktop-title-bar'), route.name).toHaveCount(0);
    await expect(page.getByTestId('desktop-drag-surface'), route.name).toHaveCount(0);
    await expect(page.locator('html'), route.name).not.toHaveAttribute('data-flo-desktop-titlebar');

    await assertViewportTopGeometry(`${route.name} expanded sidebar`);
    await page.keyboard.press('Control+b');
    await expect(sidebar, `${route.name}: rail stays visible when collapsed`).toBeVisible();
    await assertViewportTopGeometry(`${route.name} collapsed sidebar`);
  }

  // CSS wiring sanity for the Electron path: forcing the capability flag on
  // <html> must offset the fixed sidebar below the title bar height.
  const forced = await sidebar.evaluate((element) => {
    const html = document.documentElement;
    try {
      html.dataset.floDesktopTitlebar = 'true';
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    } finally {
      delete html.dataset.floDesktopTitlebar;
    }
  });
  expect(forced.y, 'desktop flag offsets sidebar below title bar').toBeCloseTo(40, 0);
  expect(forced.height, 'desktop flag shrinks sidebar by title-bar height')
    .toBeCloseTo(viewportHeight - 40, 0);
});

/**
 * Scroll assertions for the POS and Orders control surfaces.
 *
 * The merchant report behind these tests is that product/order content scrolls
 * while the controls staff need mid-sale disappear with it: the POS topbar,
 * product search and category chips, the cart totals/checkout, and the Orders
 * title/status/search/filters. Every assertion measures the same contract —
 * pinning controls keep their viewport position, the content region keeps a
 * usable height, its scroll position actually changes, and the last record is
 * reachable at the end of that scroll.
 */

const SYNTHETIC_CATEGORY_PREFIX = 'Scroll Layout Long Name Category';
const SYNTHETIC_PRODUCT_PREFIX = 'Scroll Layout Item';
const SYNTHETIC_NAME = /Scroll Layout Item \d{3}/;
const SYNTHETIC_CATEGORY_COUNT = 6;
const SYNTHETIC_PRODUCT_COUNT = 24;

interface SyntheticMenu {
  categoryIds: string[];
}

/**
 * Seeds a catalog big enough to overflow the product grid and a category row
 * wide enough to wrap. Names are stable and reused when a previous run left
 * rows behind, because the shared server rate-limits category writes to 60 per
 * minute and a failed test restarts the worker (and this hook with it).
 */
async function seedSyntheticMenu(api: APIRequestContext): Promise<SyntheticMenu> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const categoriesResponse = await api.get(`${BASE}/api/categories`, { headers });
  expect(categoriesResponse.status(), 'categories are readable for seeding').toBe(200);
  const categories = (await categoriesResponse.json()).categories as { id: string; name: string }[];
  const categoryIds = categories
    .filter((category) => category.name.startsWith(SYNTHETIC_CATEGORY_PREFIX))
    .map((category) => category.id);
  for (let index = categoryIds.length; index < SYNTHETIC_CATEGORY_COUNT; index += 1) {
    const response = await api.post(`${BASE}/api/categories`, {
      headers,
      data: { name: `${SYNTHETIC_CATEGORY_PREFIX} ${String(index + 1).padStart(2, '0')}` },
    });
    expect(response.status(), `synthetic category ${index + 1} is created`).toBe(201);
    categoryIds.push((await response.json()).category.id as string);
  }

  const productsResponse = await api.get(`${BASE}/api/products?active=1`, { headers });
  expect(productsResponse.status(), 'products are readable for seeding').toBe(200);
  const products = (await productsResponse.json()).products as { name: string }[];
  const existingNames = new Set(products.map((product) => product.name));
  for (let index = 0; index < SYNTHETIC_PRODUCT_COUNT; index += 1) {
    const name = `${SYNTHETIC_PRODUCT_PREFIX} ${String(index + 1).padStart(3, '0')}`;
    if (existingNames.has(name)) continue;
    const response = await api.post(`${BASE}/api/products`, {
      headers,
      data: { name, category_id: categoryIds[index % categoryIds.length], price: 25 },
    });
    expect(response.status(), `synthetic product ${name} is created`).toBe(201);
  }
  return { categoryIds };
}

/** delete_all drops the category together with the products seeded under it. */
async function removeSyntheticMenu(api: APIRequestContext, menu: SyntheticMenu): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (const id of menu.categoryIds) {
    const response = await api.delete(`${BASE}/api/categories/${id}?action=delete_all`, { headers });
    expect(response.status(), 'synthetic category is removed with its products').toBe(200);
  }
}

async function loginAsManager(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await setLanguage(page, 'en');
}

/** Clicks the first `count` synthetic catalog cards and returns their product names. */
async function addSyntheticItemsToCart(page: Page, count: number): Promise<string[]> {
  const cards = page.getByTestId('pos-product-card').filter({ hasText: SYNTHETIC_PRODUCT_PREFIX });
  await expect(cards.first(), 'the synthetic catalog is loaded').toBeVisible();
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const name = SYNTHETIC_NAME.exec((await card.textContent()) ?? '');
    expect(name, 'synthetic product name is readable from its card').not.toBeNull();
    await card.click();
    // A catalog tap always opens the customizer; confirming it is the action
    // that actually adds the line to the cart.
    const confirmAdd = page.getByRole('button', { name: /^Add to Cart/ });
    await confirmAdd.first().click();
    await expect(confirmAdd.first(), 'the customizer closes after adding').toBeHidden();
    names.push(name![0]);
  }
  return names;
}

test.describe('checkout controls stay visible while catalog and cart content scroll', () => {
  let menu: SyntheticMenu | undefined;

  test.beforeAll(async () => {
    const api = await request.newContext();
    try {
      menu = await seedSyntheticMenu(api);
    } finally {
      await api.dispose();
    }
  });

  test.afterAll(async () => {
    if (!menu) return;
    const api = await request.newContext();
    try {
      await removeSyntheticMenu(api, menu);
    } finally {
      await api.dispose();
    }
  });

  test('POS keeps the topbar, search and category chips in place while the catalog scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/pos`);

    const catalog = page.getByTestId('pos-catalog-scroll');
    await expect(catalog).toBeVisible();
    await expect(page.getByTestId('pos-product-card').filter({ hasText: SYNTHETIC_PRODUCT_PREFIX }).first()).toBeVisible();

    const cashControl = page.getByTitle('Cash movement');
    const searchInput = page.getByTestId('pos-product-grid').locator('input[type="text"]').first();
    const categoryRow = page.getByTestId('pos-category-row');
    const pinned = {
      cash: await elementTop(cashControl, 'cash movement control'),
      search: await elementTop(searchInput, 'product search'),
      categories: await elementTop(categoryRow, 'category chips'),
    };

    const categoryRowBox = await categoryRow.boundingBox();
    expect(categoryRowBox, 'category chips have bounds').not.toBeNull();
    expect(
      categoryRowBox!.height,
      'category chips stay a single row high instead of consuming the catalog',
    ).toBeLessThanOrEqual(96);

    const scrolled = await scrollToEnd(catalog);
    expect(scrolled.scrollTop, 'the catalog is the scroll owner for the product list').toBeGreaterThan(0);

    expectPinned(await elementTop(cashControl, 'cash movement control'), pinned.cash, 'cash movement control');
    expectPinned(await elementTop(searchInput, 'product search'), pinned.search, 'product search');
    expectPinned(await elementTop(categoryRow, 'category chips'), pinned.categories, 'category chips');

    const catalogBox = await catalog.boundingBox();
    const lastCardBox = await page.getByTestId('pos-product-card').last().boundingBox();
    expect(catalogBox, 'catalog has bounds').not.toBeNull();
    expect(lastCardBox, 'last catalog card has bounds').not.toBeNull();
    expect(lastCardBox!.y, 'the last catalog card is inside the catalog viewport')
      .toBeGreaterThanOrEqual(catalogBox!.y - 1);
    expect(lastCardBox!.y + lastCardBox!.height, 'the last catalog card is fully reachable')
      .toBeLessThanOrEqual(catalogBox!.y + catalogBox!.height + 1);
  });

  test('POS keeps cart totals and checkout in place while cart items scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/pos`);

    const names = await addSyntheticItemsToCart(page, 10);
    const items = page.getByTestId('cart-items-scroll');
    const footer = page.getByTestId('cart-footer');
    const placeOrder = page.getByRole('button', { name: 'Place Order' });

    const footerBefore = await elementTop(footer, 'cart footer');
    const checkoutBefore = await elementTop(placeOrder, 'checkout button');

    const scrolled = await scrollToEnd(items);
    expect(scrolled.scrollTop, 'the cart item list is the scroll owner for cart rows').toBeGreaterThan(0);

    expectPinned(await elementTop(footer, 'cart footer'), footerBefore, 'cart footer');
    expectPinned(await elementTop(placeOrder, 'checkout button'), checkoutBefore, 'checkout button');

    const itemsBox = await items.boundingBox();
    const lastItem = items.getByText(names[names.length - 1], { exact: false }).last();
    const lastItemBox = await lastItem.boundingBox();
    expect(itemsBox, 'cart item list has bounds').not.toBeNull();
    expect(lastItemBox, 'the last cart row has bounds').not.toBeNull();
    expect(lastItemBox!.y + lastItemBox!.height, 'the last cart row is reachable inside the item list')
      .toBeLessThanOrEqual(itemsBox!.y + itemsBox!.height + 1);
  });

  test('POS keeps the catalog usable and checkout reachable on a short landscape viewport', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await loginAsManager(page);
    await page.goto(`${BASE}/pos`);

    const catalog = page.getByTestId('pos-catalog-scroll');
    await expect(catalog).toBeVisible();
    const catalogClientHeight = await catalog.evaluate((element) => element.clientHeight);
    expect(
      catalogClientHeight,
      'the catalog keeps a usable height when the viewport is short',
    ).toBeGreaterThanOrEqual(60);

    const names = await addSyntheticItemsToCart(page, 8);
    const placeOrder = page.getByRole('button', { name: 'Place Order' });
    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();

    // The cart surface may have to scroll as a whole on a short viewport; every
    // candidate scroll owner is driven to its end before the checkout check.
    await page.getByTestId('cart-shell').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.getByTestId('cart-items-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    const checkoutBox = await placeOrder.boundingBox();
    expect(checkoutBox, 'checkout button has bounds').not.toBeNull();
    expect(checkoutBox!.y, 'checkout button is not above the viewport').toBeGreaterThanOrEqual(-1);
    expect(
      checkoutBox!.y + checkoutBox!.height,
      'checkout button is reachable inside the viewport',
    ).toBeLessThanOrEqual(viewport!.height + 1);

    const cartShell = page.getByTestId('cart-shell');
    const lastItem = cartShell.getByText(names[names.length - 1], { exact: false }).last();
    await expect(lastItem, 'the last cart row is reachable on a short viewport').toBeVisible();
  });

  test('POS keeps checkout reachable at an effective 200% zoom viewport', async ({ page }) => {
    // 200% browser zoom on a 1024x768 window renders as a 512x384 CSS-pixel
    // viewport at 2x device pixels; below md the mobile cart drawer is the
    // supported checkout surface.
    await page.setViewportSize({ width: 512, height: 384 });
    await loginAsManager(page);
    await page.goto(`${BASE}/pos`);

    await addSyntheticItemsToCart(page, 4);

    const openCart = page.getByRole('button', { name: 'Cart' });
    await expect(openCart, 'the mobile cart trigger is offered when zoom hides the cart column').toBeVisible();
    await openCart.click();

    const placeOrder = page.getByRole('button', { name: 'Place Order' });
    await expect(placeOrder).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();

    // The desktop cart column stays mounted but hidden below md, so only the
    // drawer's cart panel may be scrolled here.
    const panel = page.locator('[data-testid="cart-items-scroll"]:visible');
    await expect(panel, 'the drawer renders its cart panel').toHaveCount(1);
    const drawerScroller = panel.locator('xpath=ancestor::*[contains(@class, "overflow-y-auto")][1]');

    // The drawer settles after its open animation, and the sheet re-measures
    // while it settles, so poll the scroll-and-measure pair instead of assuming
    // a single scroll sticks.
    await expect.poll(async () => {
      await drawerScroller.first().evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const box = await placeOrder.boundingBox();
      return box ? Math.round(box.y + box.height) : Number.POSITIVE_INFINITY;
    }, { message: 'checkout button is reachable inside the zoomed viewport' })
      .toBeLessThanOrEqual(viewport!.height + 1);
  });
});
