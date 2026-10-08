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

// The management screens list every row of the tab that is open, so their
// fixtures need enough rows to overflow a desktop list window: categories,
// add-on groups, supplies, recipes, movements and customers each get a count.
const MANAGEMENT_CATEGORY_COUNT = 18;
const SYNTHETIC_ADDON_GROUP_PREFIX = 'Scroll Layout Add-on Group';
const SYNTHETIC_ADDON_GROUP_COUNT = 18;
const SYNTHETIC_SUPPLY_PREFIX = 'Scroll Layout Supply';
const SYNTHETIC_SUPPLY_COUNT = 24;
const SYNTHETIC_RECIPE_COUNT = 16;
const SYNTHETIC_CUSTOMER_PREFIX = 'Scroll Layout Customer';
const SYNTHETIC_CUSTOMER_COUNT = 30;

interface SyntheticMenu {
  categoryIds: string[];
  productIds: string[];
}

/**
 * Seeds a catalog big enough to overflow the product grid and a category row
 * wide enough to wrap. Names are stable and reused when a previous run left
 * rows behind, because the shared server rate-limits category writes to 60 per
 * minute and a failed test restarts the worker (and this hook with it).
 */
async function seedSyntheticMenu(
  api: APIRequestContext,
  categoryCount = SYNTHETIC_CATEGORY_COUNT,
): Promise<SyntheticMenu> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const categoriesResponse = await api.get(`${BASE}/api/categories`, { headers });
  expect(categoriesResponse.status(), 'categories are readable for seeding').toBe(200);
  const categories = (await categoriesResponse.json()).categories as { id: string; name: string }[];
  const categoryIds = categories
    .filter((category) => category.name.startsWith(SYNTHETIC_CATEGORY_PREFIX))
    .map((category) => category.id);
  for (let index = categoryIds.length; index < categoryCount; index += 1) {
    const response = await api.post(`${BASE}/api/categories`, {
      headers,
      data: { name: `${SYNTHETIC_CATEGORY_PREFIX} ${String(index + 1).padStart(2, '0')}` },
    });
    expect(response.status(), `synthetic category ${index + 1} is created`).toBe(201);
    categoryIds.push((await response.json()).category.id as string);
  }

  const productsResponse = await api.get(`${BASE}/api/products?active=1`, { headers });
  expect(productsResponse.status(), 'products are readable for seeding').toBe(200);
  const products = (await productsResponse.json()).products as { id: string; name: string }[];
  const productIds = products
    .filter((product) => product.name.startsWith(SYNTHETIC_PRODUCT_PREFIX))
    .map((product) => product.id);
  const existingNames = new Set(products.map((product) => product.name));
  for (let index = 0; index < SYNTHETIC_PRODUCT_COUNT; index += 1) {
    const name = `${SYNTHETIC_PRODUCT_PREFIX} ${String(index + 1).padStart(3, '0')}`;
    if (existingNames.has(name)) continue;
    const response = await api.post(`${BASE}/api/products`, {
      headers,
      data: { name, category_id: categoryIds[index % categoryIds.length], price: 25 },
    });
    expect(response.status(), `synthetic product ${name} is created`).toBe(201);
    productIds.push((await response.json()).product.id as string);
  }
  return { categoryIds, productIds };
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

/**
 * Management screens (Products, Inventory, Customers) and the customer-facing
 * order display.
 *
 * Same contract as the POS and Orders suites: a pinned control keeps its
 * viewport position while the records below it scroll, the list region is the
 * scroll owner, and the last record stays reachable. The management fixtures
 * are seeded per resource and removed again, because these pages list every
 * row of the open tab rather than a page of rows.
 */

/**
 * Fixtures only ever add rows with a stable name, so a re-run reuses whatever
 * a previous attempt created (the shared server caps category, add-on group
 * and customer writes at 60 per minute) and teardown removes only what is
 * still there for this run.
 */
async function seedSyntheticAddonGroups(api: APIRequestContext): Promise<string[]> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const response = await api.get(`${BASE}/api/addon-groups`, { headers });
  expect(response.status(), 'add-on groups are readable for seeding').toBe(200);
  const existing = (await response.json()).addon_groups as { id: string; name: string }[];
  const ids = existing
    .filter((group) => group.name.startsWith(SYNTHETIC_ADDON_GROUP_PREFIX))
    .map((group) => group.id);
  for (let index = ids.length; index < SYNTHETIC_ADDON_GROUP_COUNT; index += 1) {
    const created = await api.post(`${BASE}/api/addon-groups`, {
      headers,
      data: {
        name: `${SYNTHETIC_ADDON_GROUP_PREFIX} ${String(index + 1).padStart(2, '0')}`,
        min_selection: 0,
        max_selection: 1,
        addons: [{ name: 'Scroll Layout Add-on', price: 5 }],
      },
    });
    expect(created.status(), `synthetic add-on group ${index + 1} is created`).toBe(201);
    ids.push((await created.json()).addon_group.id as string);
  }
  return ids;
}

async function removeSyntheticAddonGroups(api: APIRequestContext, ids: string[]): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (const id of ids) {
    const response = await api.delete(`${BASE}/api/addon-groups/${id}`, { headers });
    expect(response.status(), 'synthetic add-on group is removed').toBe(200);
  }
}

interface SyntheticInventory {
  supplyIds: string[];
  recipeProductIds: string[];
}

/** Supplies fill the Supplies tab, one movement per supply fills Movements,
 * and a recipe per synthetic product gives the Recipes tab tall rows. */
async function seedSyntheticInventory(
  api: APIRequestContext,
  productIds: string[],
): Promise<SyntheticInventory> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const suppliesResponse = await api.get(`${BASE}/api/supplies?include_inactive=true`, { headers });
  expect(suppliesResponse.status(), 'supplies are readable for seeding').toBe(200);
  const supplies = (await suppliesResponse.json()).supplies as { id: string; name: string }[];
  const supplyIds = supplies
    .filter((supply) => supply.name.startsWith(SYNTHETIC_SUPPLY_PREFIX))
    .map((supply) => supply.id);
  for (let index = supplyIds.length; index < SYNTHETIC_SUPPLY_COUNT; index += 1) {
    const created = await api.post(`${BASE}/api/supplies`, {
      headers,
      data: {
        name: `${SYNTHETIC_SUPPLY_PREFIX} ${String(index + 1).padStart(2, '0')}`,
        base_unit: 'each',
        stock_quantity: 20,
        low_stock_threshold: null,
      },
    });
    expect(created.status(), `synthetic supply ${index + 1} is created`).toBe(201);
    supplyIds.push((await created.json()).supply.id as string);
  }

  const movementsResponse = await api.get(`${BASE}/api/supplies/movements?per_page=50`, { headers });
  expect(movementsResponse.status(), 'movements are readable for seeding').toBe(200);
  const recorded = new Set(
    ((await movementsResponse.json()).movements as { supply_id: string }[]).map((movement) => movement.supply_id),
  );
  for (const supplyId of supplyIds) {
    if (recorded.has(supplyId)) continue;
    const created = await api.post(`${BASE}/api/supplies/${supplyId}/movements`, {
      headers,
      data: { movement_type: 'receive', quantity: 5, unit: 'each' },
    });
    expect(created.status(), 'synthetic movement is recorded').toBe(201);
  }

  const recipeProductIds = productIds.slice(0, SYNTHETIC_RECIPE_COUNT);
  for (const productId of recipeProductIds) {
    const saved = await api.put(`${BASE}/api/recipes/product/${productId}`, {
      headers,
      data: {
        yield_quantity: 1,
        items: [{ supply_id: supplyIds[0], quantity: 1, unit: 'each' }],
      },
    });
    expect(saved.status(), 'synthetic recipe is saved').toBe(200);
  }

  return { supplyIds, recipeProductIds };
}

async function removeSyntheticRecipes(api: APIRequestContext, productIds: string[]): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (const productId of productIds) {
    const response = await api.delete(`${BASE}/api/recipes/product/${productId}`, { headers });
    expect(response.status(), 'synthetic recipe is removed').toBe(200);
  }
}

async function removeSyntheticSupplies(api: APIRequestContext, ids: string[]): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (const id of ids) {
    const response = await api.delete(`${BASE}/api/supplies/${id}`, { headers });
    expect(response.status(), 'synthetic supply is removed').toBe(200);
  }
}

/** The customers API has no delete, so these rows stay in the shared test
 * database; the seeded names are reused by later runs instead of duplicated. */
async function seedSyntheticCustomers(api: APIRequestContext): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const response = await api.get(`${BASE}/api/customers`, { headers });
  expect(response.status(), 'customers are readable for seeding').toBe(200);
  const existingNames = new Set(
    ((await response.json()).data as { name: string }[]).map((customer) => customer.name),
  );
  for (let index = 1; index <= SYNTHETIC_CUSTOMER_COUNT; index += 1) {
    const name = `${SYNTHETIC_CUSTOMER_PREFIX} ${String(index).padStart(3, '0')}`;
    if (existingNames.has(name)) continue;
    const data = { name, email: `scroll-layout-${index}@e2e.invalid` };
    let created = await api.post(`${BASE}/api/customers`, { headers, data });
    if (created.status() === 429) {
      // Customer writes are capped at 60 per minute and the rest of the shared
      // suite writes to the same server; one bounded retry keeps the file from
      // failing on a window someone else filled.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      created = await api.post(`${BASE}/api/customers`, { headers, data });
    }
    expect(created.status(), `synthetic customer ${index} is created`).toBe(201);
  }
}

test.describe('management lists keep their controls visible while records scroll', () => {
  let menu: SyntheticMenu | undefined;
  let addonGroupIds: string[] = [];
  let inventory: SyntheticInventory | undefined;

  test.beforeAll(async () => {
    const api = await request.newContext();
    try {
      await seedSyntheticCustomers(api);
      addonGroupIds = await seedSyntheticAddonGroups(api);
      menu = await seedSyntheticMenu(api, MANAGEMENT_CATEGORY_COUNT);
      inventory = await seedSyntheticInventory(api, menu.productIds);
    } finally {
      await api.dispose();
    }
  });

  test.afterAll(async () => {
    const api = await request.newContext();
    try {
      if (inventory) {
        await removeSyntheticRecipes(api, inventory.recipeProductIds);
        await removeSyntheticSupplies(api, inventory.supplyIds);
      }
      await removeSyntheticAddonGroups(api, addonGroupIds);
      if (menu) await removeSyntheticMenu(api, menu);
    } finally {
      await api.dispose();
    }
  });

  test('products keeps the title, tabs and product actions visible while the rows scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/products`);

    const region = page.getByTestId('products-list-scroll');
    await expect(region, 'the product list region renders').toBeVisible();
    await expect(
      page.getByText(`${SYNTHETIC_PRODUCT_PREFIX} 024`, { exact: true }),
      'the seeded product catalog is loaded',
    ).toBeVisible();

    const title = page.getByRole('heading', { name: 'Products', level: 1 });
    const tabs = page.getByRole('tablist');
    const addProduct = page.getByRole('button', { name: 'Add Product' });
    const csv = page.getByRole('button', { name: 'CSV' });
    const pinned = {
      title: await elementTop(title, 'products title'),
      tabs: await elementTop(tabs, 'products tabs'),
      addProduct: await elementTop(addProduct, 'add product'),
      csv: await elementTop(csv, 'product CSV action'),
    };

    const scrolled = await scrollToEnd(region);
    expect(scrolled.scrollTop, 'the product list region owns the scroll').toBeGreaterThan(0);

    expectPinned(await elementTop(title, 'products title'), pinned.title, 'products title');
    expectPinned(await elementTop(tabs, 'products tabs'), pinned.tabs, 'products tabs');
    expectPinned(await elementTop(addProduct, 'add product'), pinned.addProduct, 'add product');
    expectPinned(await elementTop(csv, 'product CSV action'), pinned.csv, 'product CSV action');

    const regionBox = await region.boundingBox();
    const lastRowBox = await region.locator('tbody tr').last().boundingBox();
    expect(regionBox, 'the product list region has bounds').not.toBeNull();
    expect(lastRowBox, 'the last product row has bounds').not.toBeNull();
    expect(lastRowBox!.y + lastRowBox!.height, 'the last product row is reachable')
      .toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);

    // Tab and Shift+Tab must not land on a control that scrolled out of view.
    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();
    const search = page.getByLabel('Search');
    const assertFocusVisible = async (label: string) => {
      const focused = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      expect(focused, `${label}: a control receives focus`).not.toBeNull();
      expect(focused!.height, `${label}: the focused control is rendered`).toBeGreaterThan(0);
      expect(focused!.top, `${label}: the focused control is not above the viewport`).toBeGreaterThanOrEqual(-1);
      expect(focused!.bottom, `${label}: the focused control is inside the viewport`)
        .toBeLessThanOrEqual(viewport!.height + 1);
    };
    await search.focus();
    await page.keyboard.press('Tab');
    await assertFocusVisible('Tab from the pinned search');
    await page.keyboard.press('Shift+Tab');
    await assertFocusVisible('Shift+Tab back to the pinned search');
  });

  test('products keeps each tab’s own actions visible while that tab’s rows scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/products`);

    const cases = [
      { tab: 'Categories', region: 'categories-list-scroll', action: 'Add Category' },
      { tab: 'Addon Groups', region: 'addons-list-scroll', action: 'Add Addon Group' },
    ];
    for (const entry of cases) {
      await page.getByRole('tab', { name: entry.tab }).click();
      const region = page.getByTestId(entry.region);
      await expect(region, `${entry.tab}: the list region renders`).toBeVisible();
      const tabs = page.getByRole('tablist');
      const action = page.getByRole('button', { name: entry.action });
      const pinned = {
        tabs: await elementTop(tabs, 'products tabs'),
        action: await elementTop(action, `${entry.action} action`),
      };

      const scrolled = await scrollToEnd(region);
      expect(scrolled.scrollTop, `${entry.tab}: the list region owns the scroll`).toBeGreaterThan(0);

      expectPinned(await elementTop(tabs, 'products tabs'), pinned.tabs, 'products tabs');
      expectPinned(await elementTop(action, `${entry.action} action`), pinned.action, `${entry.action} action`);

      const regionBox = await region.boundingBox();
      const lastRowBox = await region.locator('tbody tr').last().boundingBox();
      expect(regionBox, `${entry.tab}: the list region has bounds`).not.toBeNull();
      expect(lastRowBox, `${entry.tab}: the last row has bounds`).not.toBeNull();
      expect(lastRowBox!.y + lastRowBox!.height, `${entry.tab}: the last row is reachable`)
        .toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);

      // Radix unmounts the inactive tab, so a previous tab cannot leave a
      // stale scroller or toolbar behind.
      await expect(
        page.getByTestId('products-list-scroll'),
        `${entry.tab}: the product scroller from the other tab is gone`,
      ).toHaveCount(0);
    }
  });

  test('inventory keeps the title, tabs and active filters visible across its tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/inventory`);

    const cases = [
      { tab: 'Supplies', region: 'inventory-supplies-scroll' },
      { tab: 'Recipes', region: 'inventory-recipes-scroll' },
      { tab: 'Movements', region: 'inventory-movements-scroll' },
    ];
    for (const entry of cases) {
      await page.getByRole('tab', { name: entry.tab }).click();
      const region = page.getByTestId(entry.region);
      await expect(region, `${entry.tab}: the list region renders`).toBeVisible();

      const title = page.getByRole('heading', { name: 'Inventory', level: 1 });
      const tabs = page.getByRole('tablist');
      const search = page.getByPlaceholder('Search').first();
      const pinned = {
        title: await elementTop(title, 'inventory title'),
        tabs: await elementTop(tabs, 'inventory tabs'),
        search: await elementTop(search, `${entry.tab} search`),
      };

      const scrolled = await scrollToEnd(region);
      expect(scrolled.scrollTop, `${entry.tab}: the list region owns the scroll`).toBeGreaterThan(0);

      expectPinned(await elementTop(title, 'inventory title'), pinned.title, 'inventory title');
      expectPinned(await elementTop(tabs, 'inventory tabs'), pinned.tabs, 'inventory tabs');
      expectPinned(await elementTop(search, `${entry.tab} search`), pinned.search, `${entry.tab} search`);

      const regionBox = await region.boundingBox();
      const lastRowBox = await region.locator('tbody tr').last().boundingBox();
      expect(regionBox, `${entry.tab}: the list region has bounds`).not.toBeNull();
      expect(lastRowBox, `${entry.tab}: the last row has bounds`).not.toBeNull();
      expect(lastRowBox!.y + lastRowBox!.height, `${entry.tab}: the last row is reachable`)
        .toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);

      for (const other of cases.filter((candidate) => candidate.region !== entry.region)) {
        await expect(
          page.getByTestId(other.region),
          `${entry.tab}: the ${other.tab} scroller is unmounted`,
        ).toHaveCount(0);
      }
    }
  });

  test('inventory actions stay functional after the rows scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/inventory`);

    const region = page.getByTestId('inventory-supplies-scroll');
    await expect(region).toBeVisible();
    const scrolled = await scrollToEnd(region);
    expect(scrolled.scrollTop, 'the supply list region owns the scroll').toBeGreaterThan(0);

    // The pinned search keeps filtering the scrolled list.
    const search = page.getByPlaceholder('Search').first();
    await search.fill('Scroll Layout Supply 01');
    await expect(region.locator('tbody tr'), 'the pinned search filters the list').toHaveCount(1);
    await search.fill('');
    await expect.poll(() => region.locator('tbody tr').count(), 'the cleared search restores the list')
      .toBeGreaterThan(1);

    // Row edit still opens from the bottom of the scrolled list.
    await scrollToEnd(region);
    await region.locator('tbody tr').last().getByTitle('Edit').click();
    await expect(page.getByRole('heading', { name: 'Edit supply' }), 'the edit dialog opens').toBeVisible();
    await page.locator('.fixed.inset-0 > div').first().locator('button').first().click();
    await expect(page.getByRole('heading', { name: 'Edit supply' }), 'the edit dialog closes').toBeHidden();

    // And so does the toolbar action above the list.
    await page.getByRole('button', { name: 'Add supply' }).click();
    await expect(page.getByRole('heading', { name: 'Add supply' }), 'the create dialog opens').toBeVisible();
  });

  test('customers keeps the title, add action and search visible while the rows scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/customers`);

    const region = page.getByTestId('customers-list-scroll');
    await expect(region, 'the customer list region renders').toBeVisible();
    await expect(
      page.getByText(`${SYNTHETIC_CUSTOMER_PREFIX} 030`, { exact: true }),
      'the seeded customer directory is loaded',
    ).toBeVisible();

    const title = page.getByRole('heading', { name: 'Customers', level: 1 });
    const addCustomer = page.getByRole('button', { name: 'Add Customer' });
    const search = page.getByPlaceholder('Search by name, phone, or email…');
    const pinned = {
      title: await elementTop(title, 'customers title'),
      add: await elementTop(addCustomer, 'add customer'),
      search: await elementTop(search, 'customer search'),
    };

    const scrolled = await scrollToEnd(region);
    expect(scrolled.scrollTop, 'the customer list region owns the scroll').toBeGreaterThan(0);

    expectPinned(await elementTop(title, 'customers title'), pinned.title, 'customers title');
    expectPinned(await elementTop(addCustomer, 'add customer'), pinned.add, 'add customer');
    expectPinned(await elementTop(search, 'customer search'), pinned.search, 'customer search');

    const regionBox = await region.boundingBox();
    const lastRowBox = await region.locator('tbody tr').last().boundingBox();
    expect(regionBox, 'the customer list region has bounds').not.toBeNull();
    expect(lastRowBox, 'the last customer row has bounds').not.toBeNull();
    expect(lastRowBox!.y + lastRowBox!.height, 'the last customer row is reachable')
      .toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);

    // The pinned search still filters the scrolled list.
    await search.fill(SYNTHETIC_CUSTOMER_PREFIX);
    await expect(region.locator('tbody tr'), 'the pinned search filters the customer list')
      .toHaveCount(SYNTHETIC_CUSTOMER_COUNT);
    await search.fill('');
  });

  test('management lists fall back to page flow on a short landscape viewport', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await loginAsManager(page);

    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();
    const cases = [
      { name: 'products', url: `${BASE}/products`, region: 'products-list-scroll', action: 'Add Product' },
      { name: 'inventory', url: `${BASE}/inventory`, region: 'inventory-supplies-scroll', action: 'Add supply' },
      { name: 'customers', url: `${BASE}/customers`, region: 'customers-list-scroll', action: 'Add Customer' },
    ];
    for (const entry of cases) {
      await page.goto(entry.url);
      const region = page.getByTestId(entry.region);
      await expect(region, `${entry.name}: the list region renders`).toBeVisible();

      // Below the short-viewport threshold the list window is dropped, so the
      // records cannot be trapped in a strip too small to read.
      const metrics = await region.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      expect(metrics.scrollHeight, `${entry.name}: the list is not its own tiny window`)
        .toBeLessThanOrEqual(metrics.clientHeight + 1);

      const lastRow = region.locator('tbody tr').last();
      await expect(lastRow, `${entry.name}: the last record renders`).toBeAttached();
      await lastRow.scrollIntoViewIfNeeded();
      const lastRowBox = await lastRow.boundingBox();
      expect(lastRowBox, `${entry.name}: the last record has bounds`).not.toBeNull();
      expect(lastRowBox!.y + lastRowBox!.height, `${entry.name}: the last record is reachable`)
        .toBeLessThanOrEqual(viewport!.height + 1);

      const action = page.getByRole('button', { name: entry.action });
      await action.scrollIntoViewIfNeeded();
      const actionBox = await action.boundingBox();
      expect(actionBox, `${entry.name}: the pinned action has bounds`).not.toBeNull();
      expect(actionBox!.y, `${entry.name}: the pinned action is not above the viewport`).toBeGreaterThanOrEqual(-1);
      expect(actionBox!.y + actionBox!.height, `${entry.name}: the pinned action is reachable`)
        .toBeLessThanOrEqual(viewport!.height + 1);
    }
  });

  test('management lists stay reachable at an effective 200% zoom viewport', async ({ page }) => {
    // 200% browser zoom on a 1024x768 window renders as a 512x384 CSS-pixel
    // viewport at 2x device pixels.
    await page.setViewportSize({ width: 512, height: 384 });
    await loginAsManager(page);
    await page.goto(`${BASE}/products`);

    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();
    const action = page.getByRole('button', { name: 'Add Product' });
    await expect(action, 'the create action renders when zoomed').toBeVisible();

    const lastRow = page.locator('tbody tr').last();
    await lastRow.scrollIntoViewIfNeeded();
    const lastRowBox = await lastRow.boundingBox();
    expect(lastRowBox, 'the last product row has bounds').not.toBeNull();
    expect(lastRowBox!.y, 'the last product row is not above the viewport').toBeGreaterThanOrEqual(-1);
    expect(lastRowBox!.y + lastRowBox!.height, 'the last product row is reachable when zoomed')
      .toBeLessThanOrEqual(viewport!.height + 1);

    await action.scrollIntoViewIfNeeded();
    const actionBox = await action.boundingBox();
    expect(actionBox!.y + actionBox!.height, 'the create action is reachable when zoomed')
      .toBeLessThanOrEqual(viewport!.height + 1);
  });
});

/**
 * The customer-facing order display polls /api/orders every three seconds. The
 * specs below serve that one endpoint from an in-memory list so the number of
 * tiles per section is exact and can change between polls; the rest of the
 * page keeps its real auth, tenant and theme wiring.
 */
interface DisplayOrder {
  id: string;
  order_number: string;
  bill: { bill_number: string };
  status: 'pending' | 'preparing' | 'ready';
  created_at: string;
}

function displayOrders(preparingCount: number, readyCount: number): DisplayOrder[] {
  const orders: DisplayOrder[] = [];
  for (let index = 1; index <= preparingCount; index += 1) {
    orders.push({
      id: `display-preparing-${index}`,
      order_number: `P${index}`,
      bill: { bill_number: `100${String(index).padStart(2, '0')}` },
      status: index % 3 === 0 ? 'pending' : 'preparing',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    });
  }
  for (let index = 1; index <= readyCount; index += 1) {
    orders.push({
      id: `display-ready-${index}`,
      order_number: `R${index}`,
      bill: { bill_number: `200${String(index).padStart(2, '0')}` },
      status: 'ready',
      created_at: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
    });
  }
  return orders;
}

async function mockDisplayOrders(
  page: Page,
  orders: DisplayOrder[],
): Promise<{ replace: (next: DisplayOrder[]) => void }> {
  let current = orders;
  await page.route(
    (url) => url.pathname === '/api/orders',
    (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ orders: current }),
    }),
  );
  return { replace: (next) => { current = next; } };
}

test.describe('customer display keeps its headers visible over independently scrolling tile lists', () => {
  test('the header and both section headings stay visible while the tile lists scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await mockDisplayOrders(page, displayOrders(24, 30));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const ready = page.getByTestId('customer-display-ready-scroll');
    await expect(preparing.getByText('10024', { exact: true }), 'the preparing tiles render').toBeVisible();
    await expect(ready.getByText('20030', { exact: true }), 'the ready tiles render').toBeVisible();

    const header = page.locator('header');
    const preparingHeading = page.getByRole('heading', { name: 'PREPARING' });
    const readyHeading = page.getByRole('heading', { name: 'READY FOR PICKUP' });
    const pinned = {
      header: await elementTop(header, 'display header'),
      preparingHeading: await elementTop(preparingHeading, 'preparing heading'),
      readyHeading: await elementTop(readyHeading, 'ready heading'),
    };

    const preparingScrolled = await scrollToEnd(preparing);
    expect(preparingScrolled.scrollTop, 'the preparing tile list owns its own scroll').toBeGreaterThan(0);
    expectPinned(await elementTop(header, 'display header'), pinned.header, 'display header');
    expectPinned(await elementTop(preparingHeading, 'preparing heading'), pinned.preparingHeading, 'preparing heading');
    expectPinned(await elementTop(readyHeading, 'ready heading'), pinned.readyHeading, 'ready heading');
    expect(
      await ready.evaluate((element) => element.scrollTop),
      'scrolling the preparing tiles leaves the ready tiles in place',
    ).toBe(0);

    const preparingBox = await preparing.boundingBox();
    const lastPreparing = await preparing.getByText('10024', { exact: true }).boundingBox();
    expect(preparingBox).not.toBeNull();
    expect(lastPreparing, 'the last preparing tile has bounds').not.toBeNull();
    expect(lastPreparing!.y + lastPreparing!.height, 'the last preparing tile is reachable')
      .toBeLessThanOrEqual(preparingBox!.y + preparingBox!.height + 1);

    const readyScrolled = await scrollToEnd(ready);
    expect(readyScrolled.scrollTop, 'the ready tile list owns its own scroll').toBeGreaterThan(0);
    expect(
      await preparing.evaluate((element) => element.scrollTop),
      'scrolling the ready tiles leaves the preparing tiles in place',
    ).toBe(preparingScrolled.scrollTop);
    expectPinned(await elementTop(header, 'display header'), pinned.header, 'display header');
    expectPinned(await elementTop(readyHeading, 'ready heading'), pinned.readyHeading, 'ready heading');

    const readyBox = await ready.boundingBox();
    const lastReady = await ready.getByText('20030', { exact: true }).boundingBox();
    expect(readyBox).not.toBeNull();
    expect(lastReady, 'the last ready tile has bounds').not.toBeNull();
    expect(lastReady!.y + lastReady!.height, 'the last ready tile is reachable')
      .toBeLessThanOrEqual(readyBox!.y + readyBox!.height + 1);
  });

  test('the polling refresh keeps the scrolled tile list where the guest left it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    const feed = await mockDisplayOrders(page, displayOrders(20, 4));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    await expect(preparing.getByText('10020', { exact: true }), 'the preparing tiles render').toBeVisible();
    const scrolled = await scrollToEnd(preparing);
    expect(scrolled.scrollTop, 'the preparing tile list is scrolled').toBeGreaterThan(0);
    const headerBefore = await elementTop(page.locator('header'), 'display header');

    // The next poll adds one preparing tile and one ready tile.
    feed.replace(displayOrders(21, 5));
    await expect(
      preparing.getByText('10021', { exact: true }),
      'the poll renders the new order',
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByTestId('customer-display-ready-scroll').getByText('20005', { exact: true }),
      'the poll renders the new ready order',
    ).toBeVisible();

    const after = await preparing.evaluate((element) => element.scrollTop);
    expect(Math.abs(after - scrolled.scrollTop), 'the refresh does not jump the scrolled list')
      .toBeLessThanOrEqual(1);
    expectPinned(await elementTop(page.locator('header'), 'display header'), headerBefore, 'display header');
  });

  test('a narrow viewport uses one reachable content flow instead of two tile windows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsManager(page);
    await mockDisplayOrders(page, displayOrders(12, 12));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const ready = page.getByTestId('customer-display-ready-scroll');
    await expect(preparing.getByText('10012', { exact: true }), 'the preparing tiles render').toBeVisible();
    await expect(ready.getByText('20012', { exact: true }), 'the ready tiles render').toBeVisible();

    const preparingMetrics = await preparing.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    const readyMetrics = await ready.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(preparingMetrics.scrollHeight, 'the preparing tiles are not squeezed into one column window')
      .toBeLessThanOrEqual(preparingMetrics.clientHeight + 1);
    expect(readyMetrics.scrollHeight, 'the ready tiles are not squeezed into one column window')
      .toBeLessThanOrEqual(readyMetrics.clientHeight + 1);

    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();
    const lastReady = ready.getByText('20012', { exact: true });
    await lastReady.scrollIntoViewIfNeeded();
    const lastReadyBox = await lastReady.boundingBox();
    expect(lastReadyBox, 'the last ready tile has bounds').not.toBeNull();
    expect(lastReadyBox!.y, 'the last ready tile is not above the viewport').toBeGreaterThanOrEqual(-1);
    expect(lastReadyBox!.y + lastReadyBox!.height, 'the last ready tile is reachable in the single flow')
      .toBeLessThanOrEqual(viewport!.height + 1);
    await expect(page.locator('header'), 'the business header stays reachable').toBeVisible();
  });

  test('the display keeps its chrome through loading, empty and connection-error states', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/customer-display`);
    await expect(page.getByTestId('customer-display-preparing-scroll')).toBeVisible();

    // Loading: the first answer is held back, so the loading branch is visible.
    await page.route(
      (url) => url.pathname === '/api/orders',
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: [] }) });
      },
    );
    await page.reload();
    await expect(page.getByText('Loading orders…'), 'the loading state renders').toBeVisible();
    await expect(page.locator('header'), 'the business header stays visible while loading').toBeVisible();

    // Empty: both sections explain themselves without collapsing the page.
    await expect(page.getByText('No orders currently being prepared'), 'the empty preparing state renders')
      .toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No orders are ready yet'), 'the empty ready state renders').toBeVisible();
    const emptyTileHeight = await page.getByTestId('customer-display-preparing-scroll')
      .evaluate((element) => element.clientHeight);
    expect(emptyTileHeight, 'the empty tile area still occupies usable space').toBeGreaterThan(0);

    // Connection error: the header reports the retry while the sections stay put.
    await page.route(
      (url) => url.pathname === '/api/orders',
      (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await expect(page.getByText('Connection problem — retrying…'), 'the connection error is reported')
      .toBeVisible({ timeout: 15000 });
    await expect(page.getByText('No orders currently being prepared'), 'the sections survive the error state').toBeVisible();
  });
});
