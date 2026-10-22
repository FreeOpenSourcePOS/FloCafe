import { request, test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { elementTop, expectPinned, scrollToEnd } from './helpers/layout';

test('POS product grid has no horizontal clipping and touchable product cards', async ({
  page,
}) => {
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
  expect(grid.scrollWidth, 'POS grid does not overflow horizontally').toBeLessThanOrEqual(
    grid.clientWidth,
  );

  const card = await page.getByTestId('pos-product-card').boundingBox();
  expect(card, 'product card has bounds').not.toBeNull();
  expect(card!.width, 'product card width').toBeGreaterThanOrEqual(44);
  expect(card!.height, 'product card height').toBeGreaterThanOrEqual(44);
});

test('POS hides the floating mobile cart button on tablet and desktop viewports and keeps it touch-sized on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAsManager(page);
  await page.goto(`${BASE}/pos`);

  await expect(page.getByTestId('pos-product-grid')).toBeVisible();

  const mobileCartButton = page.getByRole('button', { name: 'Cart' });
  await expect(mobileCartButton, 'floating cart button hidden at 1024x768').toBeHidden();

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(mobileCartButton, 'floating cart button hidden at 768x1024').toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mobileCartButton, 'floating cart button visible at 390x844').toBeVisible();

  const box = await mobileCartButton.boundingBox();
  expect(box, 'mobile cart button has bounds').not.toBeNull();
  expect(box!.width, 'mobile cart button width >= 44px').toBeGreaterThanOrEqual(44);
  expect(box!.height, 'mobile cart button height >= 44px').toBeGreaterThanOrEqual(44);
});

test('LAN/browser sidebar pins to the viewport top with zero title-bar markup on the POS, KDS, and settings routes', async ({
  page,
}) => {
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

    expect(
      await page.evaluate(() => Boolean(window.electronAPI)),
      `${route.name}: capability absent`,
    ).toBe(false);
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
  expect(forced.height, 'desktop flag shrinks sidebar by title-bar height').toBeCloseTo(
    viewportHeight - 40,
    0,
  );
});

test('sidebar theme toggle button does not clip horizontally or vertically across locales, sidebar states, and theme modes (#1069)', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });

  const locales = [
    {
      code: 'vi',
      title: 'Giao diện',
      modes: [
        { mode: 'system', label: 'Theo hệ thống' },
        { mode: 'light', label: 'Sáng' },
        { mode: 'dark', label: 'Tối' },
      ],
    },
    {
      code: 'tr',
      title: 'Tema ve Renk Modu',
      modes: [
        { mode: 'system', label: 'Sistem Varsayılanı' },
        { mode: 'light', label: 'Açık Tema' },
        { mode: 'dark', label: 'Koyu Tema' },
      ],
    },
  ] as const;

  const resetThemeToSystem = async () => {
    const res = await page.request.put(`${BASE}/api/settings/theme_mode`, {
      headers: { Authorization: `Bearer ${getE2eToken()}` },
      data: { value: 'system' },
    });
    expect(res.ok(), 'resetting theme_mode=system must succeed').toBeTruthy();
  };

  try {
    const sidebar = page.locator('[data-slot="sidebar"]');
    const themeButton = page.getByTestId('sidebar-theme-toggle');

    for (const locale of locales) {
      await resetThemeToSystem();
      await setLanguage(page, locale.code);
      await page.goto(`${BASE}/pos`);
      await expect(sidebar).toHaveAttribute('data-state', 'expanded');
      await expect(themeButton).toBeVisible();

      for (const { mode, label } of locale.modes) {
        const context = `${locale.code} expanded (${mode})`;
        await expect(themeButton, `${context}: title visible`).toContainText(locale.title);
        await expect(themeButton, `${context}: mode label visible`).toContainText(label);

        const metrics = await themeButton.evaluate((el) => {
          const spans = Array.from(el.querySelectorAll('span')).map((span) => ({
            text: span.textContent,
            clientWidth: span.clientWidth,
            scrollWidth: span.scrollWidth,
            clientHeight: span.clientHeight,
            scrollHeight: span.scrollHeight,
          }));
          return {
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
            spans,
          };
        });

        expect(
          metrics.scrollWidth,
          `${context}: button must not overflow horizontally (${JSON.stringify(metrics)})`,
        ).toBeLessThanOrEqual(metrics.clientWidth + 1);
        expect(
          metrics.scrollHeight,
          `${context}: button must not overflow vertically (${JSON.stringify(metrics)})`,
        ).toBeLessThanOrEqual(metrics.clientHeight + 2);
        expect(metrics.spans.length, `${context}: renders title and mode spans`).toBe(2);
        for (const span of metrics.spans) {
          expect(
            span.clientWidth,
            `${context}: span "${span.text}" has visible width`,
          ).toBeGreaterThan(0);
          expect(
            span.clientHeight,
            `${context}: span "${span.text}" has visible height`,
          ).toBeGreaterThan(0);
          expect(
            span.scrollWidth,
            `${context}: span "${span.text}" must not clip horizontally`,
          ).toBeLessThanOrEqual(span.clientWidth + 1);
          expect(
            span.scrollHeight,
            `${context}: span "${span.text}" must not clip vertically`,
          ).toBeLessThanOrEqual(span.clientHeight + 2);
        }

        await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/settings/theme_mode') && r.request().method() === 'PUT',
          ),
          themeButton.click(),
        ]);
      }

      await page.keyboard.press('Control+b');
      await expect(sidebar).toHaveAttribute('data-collapsible', 'icon');
      await expect(themeButton).toHaveCSS('width', '32px');

      for (const { mode } of locale.modes) {
        const context = `${locale.code} collapsed (${mode})`;
        await expect(themeButton.locator('svg'), `${context}: icon visible`).toBeVisible();

        const collapsedMetrics = await themeButton.evaluate((el) => {
          const spans = Array.from(el.querySelectorAll('span')).map((span) => ({
            text: span.textContent,
            clientWidth: span.clientWidth,
            scrollWidth: span.scrollWidth,
            clientHeight: span.clientHeight,
            scrollHeight: span.scrollHeight,
          }));
          return {
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
            spans,
          };
        });

        expect(collapsedMetrics.clientWidth, `${context}: compact width`).toBe(32);
        expect(collapsedMetrics.clientHeight, `${context}: compact height`).toBe(32);
        expect(
          collapsedMetrics.scrollWidth,
          `${context}: collapsed button must not overflow horizontally`,
        ).toBeLessThanOrEqual(collapsedMetrics.clientWidth + 1);
        expect(
          collapsedMetrics.scrollHeight,
          `${context}: collapsed button must not overflow vertically`,
        ).toBeLessThanOrEqual(collapsedMetrics.clientHeight + 2);
        for (const span of collapsedMetrics.spans) {
          expect(span.clientWidth, `${context}: span "${span.text}" hidden when collapsed`).toBe(0);
          expect(span.clientHeight, `${context}: span "${span.text}" hidden when collapsed`).toBe(
            0,
          );
        }

        await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/settings/theme_mode') && r.request().method() === 'PUT',
          ),
          themeButton.click(),
        ]);
      }

      await page.keyboard.press('Control+b');
      await expect(sidebar).toHaveAttribute('data-state', 'expanded');
      await expect
        .poll(async () => themeButton.evaluate((el) => el.clientWidth))
        .toBeGreaterThan(100);
    }
  } finally {
    await resetThemeToSystem().catch(() => {});
    await setLanguage(page, 'en');
  }
});

test('sidebar renders one localized primary navigation landmark wrapping nav links and excluding non-navigation controls across desktop, collapsed, keyboard, RTL, and mobile states (#1097)', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });

  try {
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/orders`);

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');

    // Desktop expanded (LTR): exactly one navigation landmark with localized label
    await expect(page.getByRole('navigation')).toHaveCount(1);
    const primaryNav = page.getByRole('navigation', { name: 'Menu', exact: true });
    await expect(primaryNav).toBeVisible();
    expect(await primaryNav.evaluate((el) => el.tagName)).toBe('NAV');

    const expectedLinks = [
      'POS',
      'Dashboard',
      'Orders',
      'Products',
      'Inventory',
      'Expenses',
      'Customers',
      'Staff',
      'Settings',
    ];
    for (const label of expectedLinks) {
      await expect(
        primaryNav.getByRole('link', { name: label, exact: true }),
        `desktop expanded nav contains link "${label}"`,
      ).toBeVisible();
    }

    // Header brand link, theme toggle, user profile menu, and resize rail stay outside <nav>
    await expect(primaryNav.locator('[data-sidebar="header"]')).toHaveCount(0);
    await expect(primaryNav.locator('[data-sidebar="footer"]')).toHaveCount(0);
    await expect(primaryNav.getByTestId('sidebar-theme-toggle')).toHaveCount(0);
    await expect(primaryNav.locator('[data-slot="dropdown-menu-trigger"]')).toHaveCount(0);
    await expect(primaryNav.locator('[data-sidebar="rail"]')).toHaveCount(0);

    const profileTrigger = page.locator(
      '[data-sidebar="footer"] button[data-sidebar="menu-button"][data-slot="dropdown-menu-trigger"]',
    );
    await expect(profileTrigger).toBeVisible();
    await profileTrigger.click();
    await expect(page.getByRole('menuitem', { name: 'Support' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
    await expect(primaryNav.getByRole('menuitem')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Keyboard traversal and activation inside primary <nav>
    const posLink = primaryNav.getByRole('link', { name: 'POS', exact: true });
    const dashboardLink = primaryNav.getByRole('link', { name: 'Dashboard', exact: true });
    await posLink.focus();
    await expect(posLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dashboardLink).toBeFocused();

    // Collapsed icon rail preserves the single landmark and keyboard focusability
    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    await expect(sidebar).toHaveAttribute('data-collapsible', 'icon');
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(primaryNav).toBeVisible();
    const ordersLink = primaryNav.getByRole('link', { name: 'Orders', exact: true });
    await ordersLink.focus();
    await expect(ordersLink).toBeFocused();

    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');

    // RTL (Persian): landmark label localizes and stays on the inline-start (right) edge
    await setLanguage(page, 'fa');
    await page.goto(`${BASE}/orders`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('navigation')).toHaveCount(1);
    const rtlNav = page.getByRole('navigation', { name: 'منو', exact: true });
    await expect(rtlNav).toBeVisible();
    await expect(rtlNav.getByRole('link', { name: 'صندوق فروش', exact: true })).toBeVisible();
    await expect(rtlNav.getByRole('link', { name: 'سفارش‌ها', exact: true })).toBeVisible();
    await expect(rtlNav.getByTestId('sidebar-theme-toggle')).toHaveCount(0);
    const rtlBox = await rtlNav.boundingBox();
    const viewportWidth = page.viewportSize()?.width ?? 1280;
    expect(rtlBox, 'RTL nav has bounding box').not.toBeNull();
    expect(
      rtlBox!.x + rtlBox!.width,
      'RTL nav sits on the right side of the viewport',
    ).toBeGreaterThan(viewportWidth - 25);

    await setLanguage(page, 'en');
    await page.goto(`${BASE}/orders`);

    // Mobile drawer: landmark mounts inside the mobile sheet when opened and closes on link navigation
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('navigation')).toHaveCount(0);

    const openMobileButton = page.getByRole('button', { name: 'Open navigation' });
    await expect(openMobileButton).toBeVisible();
    await openMobileButton.click();

    await expect(page.getByRole('navigation')).toHaveCount(1);
    const mobileNav = page
      .locator('[data-slot="sidebar"][data-mobile="true"]')
      .getByRole('navigation', { name: 'Menu', exact: true });
    await expect(mobileNav).toBeVisible();
    await expect(mobileNav.getByRole('link', { name: 'POS', exact: true })).toBeVisible();
    await expect(mobileNav.getByTestId('sidebar-theme-toggle')).toHaveCount(0);
    await expect(mobileNav.locator('[data-slot="dropdown-menu-trigger"]')).toHaveCount(0);

    await mobileNav.getByRole('link', { name: 'POS', exact: true }).click();
    await page.waitForURL(/\/pos/, { timeout: 20000 });
    await expect(page.locator('[data-slot="sidebar"][data-mobile="true"]')).toHaveCount(0);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
    await setLanguage(page, 'en').catch(() => {});
  }
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
  /** Products seeded in order. */
  productIds: string[];
  /** Categories and products created by this invocation: its cleanup owns these. */
  ownedCategoryIds: string[];
  /** Pre-existing fixture-prefix rows that were reused: cleanup must keep them. */
  reusedCategoryIds: string[];
  ownedProductIds: string[];
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
  minimumOwnedProductCount = 0,
): Promise<SyntheticMenu> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const categoriesResponse = await api.get(`${BASE}/api/categories`, { headers });
  expect(categoriesResponse.status(), 'categories are readable for seeding').toBe(200);
  const categories = (await categoriesResponse.json()).categories as { id: string; name: string }[];
  const reusedCategoryIds = categories
    .filter((category) => category.name.startsWith(SYNTHETIC_CATEGORY_PREFIX))
    .map((category) => category.id);
  const ownedCategoryIds: string[] = [];
  const seededCategoryIds = [...reusedCategoryIds];
  for (let index = seededCategoryIds.length; index < categoryCount; index += 1) {
    const response = await api.post(`${BASE}/api/categories`, {
      headers,
      data: { name: `${SYNTHETIC_CATEGORY_PREFIX} ${String(index + 1).padStart(2, '0')}` },
    });
    expect(response.status(), `synthetic category ${index + 1} is created`).toBe(201);
    const createdId = (await response.json()).category.id as string;
    ownedCategoryIds.push(createdId);
    seededCategoryIds.push(createdId);
  }

  const productsResponse = await api.get(`${BASE}/api/products?active=1`, { headers });
  expect(productsResponse.status(), 'products are readable for seeding').toBe(200);
  const products = (await productsResponse.json()).products as { id: string; name: string }[];
  const productIds = products
    .filter((product) => product.name.startsWith(SYNTHETIC_PRODUCT_PREFIX))
    .map((product) => product.id);
  const ownedProductIds: string[] = [];
  const existingNames = new Set(products.map((product) => product.name));
  for (
    let index = 0;
    index < SYNTHETIC_PRODUCT_COUNT || ownedProductIds.length < minimumOwnedProductCount;
    index += 1
  ) {
    const name = `${SYNTHETIC_PRODUCT_PREFIX} ${String(index + 1).padStart(3, '0')}`;
    if (existingNames.has(name)) continue;
    const response = await api.post(`${BASE}/api/products`, {
      headers,
      data: { name, category_id: seededCategoryIds[index % seededCategoryIds.length], price: 25 },
    });
    expect(response.status(), `synthetic product ${name} is created`).toBe(201);
    const createdId = (await response.json()).product.id as string;
    ownedProductIds.push(createdId);
    productIds.push(createdId);
  }
  return { productIds, ownedCategoryIds, reusedCategoryIds, ownedProductIds };
}

/**
 * Cleanup removes exactly the rows this invocation created: its products first
 * (whatever category they landed in), then the now-empty categories it made. A
 * reused category and any product already under it belong to another run and
 * survive this cleanup.
 */
async function removeSyntheticMenu(api: APIRequestContext, menu: SyntheticMenu): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (const id of menu.ownedProductIds) {
    const response = await api.delete(`${BASE}/api/products/${id}`, { headers });
    expect(response.status(), 'synthetic product is removed').toBe(200);
  }
  for (const id of menu.ownedCategoryIds) {
    const response = await api.delete(`${BASE}/api/categories/${id}`, { headers });
    expect(response.status(), 'synthetic category is removed').toBe(200);
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
    // The synthetic products carry no options, so the tap is the whole add.
    await card.click();
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

  test('POS keeps the topbar, search and category chips in place while the catalog scrolls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/pos`);

    const catalog = page.getByTestId('pos-catalog-scroll');
    await expect(catalog).toBeVisible();
    await expect(
      page.getByTestId('pos-product-card').filter({ hasText: SYNTHETIC_PRODUCT_PREFIX }).first(),
    ).toBeVisible();

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
    expect(
      scrolled.scrollTop,
      'the catalog is the scroll owner for the product list',
    ).toBeGreaterThan(0);

    expectPinned(
      await elementTop(cashControl, 'cash movement control'),
      pinned.cash,
      'cash movement control',
    );
    expectPinned(await elementTop(searchInput, 'product search'), pinned.search, 'product search');
    expectPinned(
      await elementTop(categoryRow, 'category chips'),
      pinned.categories,
      'category chips',
    );

    const catalogBox = await catalog.boundingBox();
    const lastCardBox = await page.getByTestId('pos-product-card').last().boundingBox();
    expect(catalogBox, 'catalog has bounds').not.toBeNull();
    expect(lastCardBox, 'last catalog card has bounds').not.toBeNull();
    expect(
      lastCardBox!.y,
      'the last catalog card is inside the catalog viewport',
    ).toBeGreaterThanOrEqual(catalogBox!.y - 1);
    expect(
      lastCardBox!.y + lastCardBox!.height,
      'the last catalog card is fully reachable',
    ).toBeLessThanOrEqual(catalogBox!.y + catalogBox!.height + 1);
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
    expect(
      scrolled.scrollTop,
      'the cart item list is the scroll owner for cart rows',
    ).toBeGreaterThan(0);

    expectPinned(await elementTop(footer, 'cart footer'), footerBefore, 'cart footer');
    expectPinned(
      await elementTop(placeOrder, 'checkout button'),
      checkoutBefore,
      'checkout button',
    );

    const itemsBox = await items.boundingBox();
    const lastItem = items.getByText(names[names.length - 1], { exact: false }).last();
    const lastItemBox = await lastItem.boundingBox();
    expect(itemsBox, 'cart item list has bounds').not.toBeNull();
    expect(lastItemBox, 'the last cart row has bounds').not.toBeNull();
    expect(
      lastItemBox!.y + lastItemBox!.height,
      'the last cart row is reachable inside the item list',
    ).toBeLessThanOrEqual(itemsBox!.y + itemsBox!.height + 1);
  });

  test('POS keeps the catalog usable and checkout reachable on a short landscape viewport', async ({
    page,
  }) => {
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

  test('POS preserves usable cart items height and reachable checkout on a 1024x600 viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 600 });
    await loginAsManager(page);
    await page.goto(`${BASE}/pos`);

    const names = await addSyntheticItemsToCart(page, 4);
    const cartScroll = page.getByTestId('cart-items-scroll');
    const cartScrollBox = await cartScroll.boundingBox();
    expect(cartScrollBox, 'cart items container has bounds').not.toBeNull();
    expect(
      cartScrollBox!.height,
      'cart items container maintains usable height on 1024x600 display',
    ).toBeGreaterThanOrEqual(120);

    const placeOrder = page.getByRole('button', { name: 'Place Order' });
    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();

    await page.getByTestId('cart-shell').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await cartScroll.evaluate((element) => {
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
    await expect(
      lastItem,
      'the last cart row is reachable on a 1024x600 viewport',
    ).toBeInViewport();

    await cartShell.getByRole('button', { name: 'Delivery' }).click();
    const deliveryCartScrollBox = await cartScroll.boundingBox();
    expect(deliveryCartScrollBox, 'delivery cart items container has bounds').not.toBeNull();
    expect(
      deliveryCartScrollBox!.height,
      'cart items container maintains usable height with taller Delivery header on 1024x600 display',
    ).toBeGreaterThanOrEqual(120);

    await cartShell.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await cartScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    const deliveryCheckoutBox = await placeOrder.boundingBox();
    expect(deliveryCheckoutBox, 'delivery checkout button has bounds').not.toBeNull();
    expect(
      deliveryCheckoutBox!.y,
      'delivery checkout button is not above the viewport',
    ).toBeGreaterThanOrEqual(-1);
    expect(
      deliveryCheckoutBox!.y + deliveryCheckoutBox!.height,
      'delivery checkout button is reachable inside the viewport',
    ).toBeLessThanOrEqual(viewport!.height + 1);
    await expect(
      lastItem,
      'the last cart row remains in viewport with taller Delivery header on 1024x600',
    ).toBeInViewport();
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
    await expect(
      openCart,
      'the mobile cart trigger is offered when zoom hides the cart column',
    ).toBeVisible();
    await openCart.click();

    const placeOrder = page.getByRole('button', { name: 'Place Order' });
    await expect(placeOrder).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();

    // The desktop cart column stays mounted but hidden below md, so only the
    // drawer's cart panel may be scrolled here.
    const panel = page.locator('[data-testid="cart-items-scroll"]:visible');
    await expect(panel, 'the drawer renders its cart panel').toHaveCount(1);
    const drawerScroller = panel.locator(
      'xpath=ancestor::*[contains(@class, "overflow-y-auto")][1]',
    );

    // The drawer settles after its open animation, and the sheet re-measures
    // while it settles, so poll the scroll-and-measure pair instead of assuming
    // a single scroll sticks.
    await expect
      .poll(
        async () => {
          await drawerScroller.first().evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await panel.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const box = await placeOrder.boundingBox();
          return box ? Math.round(box.y + box.height) : Number.POSITIVE_INFINITY;
        },
        { message: 'checkout button is reachable inside the zoomed viewport' },
      )
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
 * and customer writes at 60 per minute). Teardown removes only the rows this
 * invocation created: a reused row belongs to whoever made it.
 */
async function seedSyntheticAddonGroups(api: APIRequestContext): Promise<string[]> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const response = await api.get(`${BASE}/api/addon-groups`, { headers });
  expect(response.status(), 'add-on groups are readable for seeding').toBe(200);
  const existing = (await response.json()).addon_groups as { id: string; name: string }[];
  const reusedCount = existing.filter((group) =>
    group.name.startsWith(SYNTHETIC_ADDON_GROUP_PREFIX),
  ).length;
  const ownedIds: string[] = [];
  for (let index = reusedCount; index < SYNTHETIC_ADDON_GROUP_COUNT; index += 1) {
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
    ownedIds.push((await created.json()).addon_group.id as string);
  }
  return ownedIds;
}

async function removeSyntheticAddonGroups(api: APIRequestContext, ids: string[]): Promise<void> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (const id of ids) {
    const response = await api.delete(`${BASE}/api/addon-groups/${id}`, { headers });
    expect(response.status(), 'synthetic add-on group is removed').toBe(200);
  }
}

interface SyntheticInventory {
  /** Supplies created by this invocation; the cleanup owns exactly these. */
  supplyIds: string[];
  recipeProductIds: string[];
}

/** Supplies fill the Supplies tab, one movement per supply fills Movements,
 * and recipes on owned products give the Recipes tab tall rows. */
async function seedSyntheticInventory(
  api: APIRequestContext,
  ownedProductIds: string[],
): Promise<SyntheticInventory> {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const suppliesResponse = await api.get(`${BASE}/api/supplies?include_inactive=true`, { headers });
  expect(suppliesResponse.status(), 'supplies are readable for seeding').toBe(200);
  const supplies = (await suppliesResponse.json()).supplies as { id: string; name: string }[];
  const seededSupplies = supplies.filter((supply) =>
    supply.name.startsWith(SYNTHETIC_SUPPLY_PREFIX),
  );
  const seededSupplyIds = seededSupplies.map((supply) => supply.id);
  const existingSupplyNames = new Set(supplies.map((supply) => supply.name));
  const supplyIds: string[] = [];
  let nextSupplyIndex = 1;
  let movementsResponse = await api.get(`${BASE}/api/supplies/movements?per_page=50`, { headers });
  expect(movementsResponse.status(), 'movements are readable for seeding').toBe(200);
  let recorded = new Set(
    ((await movementsResponse.json()).movements as { supply_id: string }[]).map(
      (movement) => movement.supply_id,
    ),
  );
  let recordedSyntheticSupplyCount = seededSupplyIds.filter((supplyId) =>
    recorded.has(supplyId),
  ).length;
  while (
    recordedSyntheticSupplyCount < SYNTHETIC_SUPPLY_COUNT &&
    supplyIds.length < SYNTHETIC_SUPPLY_COUNT
  ) {
    const needed = Math.min(
      SYNTHETIC_SUPPLY_COUNT - recordedSyntheticSupplyCount,
      SYNTHETIC_SUPPLY_COUNT - supplyIds.length,
    );
    for (let index = 0; index < needed; index += 1) {
      let name = `${SYNTHETIC_SUPPLY_PREFIX} ${String(nextSupplyIndex).padStart(2, '0')}`;
      while (existingSupplyNames.has(name)) {
        nextSupplyIndex += 1;
        name = `${SYNTHETIC_SUPPLY_PREFIX} ${String(nextSupplyIndex).padStart(2, '0')}`;
      }
      existingSupplyNames.add(name);
      nextSupplyIndex += 1;
      const created = await api.post(`${BASE}/api/supplies`, {
        headers,
        data: {
          name,
          base_unit: 'each',
          stock_quantity: 20,
          low_stock_threshold: null,
        },
      });
      expect(created.status(), `synthetic supply ${name} is created`).toBe(201);
      const createdId = (await created.json()).supply.id as string;
      supplyIds.push(createdId);
      seededSupplyIds.push(createdId);
    }

    movementsResponse = await api.get(`${BASE}/api/supplies/movements?per_page=50`, { headers });
    expect(movementsResponse.status(), 'movements are readable for seeding').toBe(200);
    recorded = new Set(
      ((await movementsResponse.json()).movements as { supply_id: string }[]).map(
        (movement) => movement.supply_id,
      ),
    );
    recordedSyntheticSupplyCount = seededSupplyIds.filter((supplyId) =>
      recorded.has(supplyId),
    ).length;
  }

  const recipeProductIds = ownedProductIds.slice(0, SYNTHETIC_RECIPE_COUNT);
  for (const productId of recipeProductIds) {
    const saved = await api.put(`${BASE}/api/recipes/product/${productId}`, {
      headers,
      data: {
        yield_quantity: 1,
        items: [{ supply_id: seededSupplyIds[0], quantity: 1, unit: 'each' }],
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
      menu = await seedSyntheticMenu(api, MANAGEMENT_CATEGORY_COUNT, SYNTHETIC_RECIPE_COUNT);
      inventory = await seedSyntheticInventory(api, menu.ownedProductIds);
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

  const MANAGEMENT_VIEWPORTS = [
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
  ] as const;

  async function expectNoHorizontalOverflow(page: Page, label: string) {
    const docOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      docOverflow.scrollWidth,
      `${label}: document has no horizontal overflow`,
    ).toBeLessThanOrEqual(docOverflow.clientWidth);

    const shellOverflow = await page.locator('.dashboard-scroll-shell').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(
      shellOverflow.scrollWidth,
      `${label}: dashboard scroll shell has no horizontal overflow`,
    ).toBeLessThanOrEqual(shellOverflow.clientWidth);
  }

  test('products keeps the title, tabs and product actions visible while the rows scroll', async ({
    page,
  }) => {
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
    const search = page.getByLabel('Search');
    const assignTax = page.getByRole('button', { name: 'Assign tax category' });
    const csv = page.getByRole('button', { name: 'CSV' });
    const printMenu = page.getByRole('button', { name: 'Print Menu' });

    for (const vp of MANAGEMENT_VIEWPORTS) {
      await page.setViewportSize(vp);
      await region.evaluate((el) => {
        el.scrollTop = 0;
      });
      const vpLabel = `products (${vp.width}x${vp.height})`;
      const titleBox = await title.boundingBox();
      const addBox = await addProduct.boundingBox();
      const tabsBox = await tabs.boundingBox();
      const searchBox = await search.boundingBox();
      const assignTaxBox = await assignTax.boundingBox();
      const csvBox = await csv.boundingBox();
      const printMenuBox = await printMenu.boundingBox();
      const currentRegionBox = await region.boundingBox();

      expect(titleBox, `${vpLabel}: title has bounds`).not.toBeNull();
      expect(addBox, `${vpLabel}: Add Product has bounds`).not.toBeNull();
      expect(tabsBox, `${vpLabel}: tablist has bounds`).not.toBeNull();
      expect(searchBox, `${vpLabel}: #products-search has bounds`).not.toBeNull();
      expect(assignTaxBox, `${vpLabel}: Assign tax category has bounds`).not.toBeNull();
      expect(csvBox, `${vpLabel}: CSV has bounds`).not.toBeNull();
      expect(printMenuBox, `${vpLabel}: Print Menu has bounds`).not.toBeNull();
      expect(currentRegionBox, `${vpLabel}: scroll region has bounds`).not.toBeNull();

      // Row 1: heading on the left, primary Add CTA on the right.
      expect(
        Math.abs(titleBox!.y + titleBox!.height / 2 - (addBox!.y + addBox!.height / 2)),
        `${vpLabel}: title and Add Product share Row 1`,
      ).toBeLessThanOrEqual(12);
      expect(addBox!.x, `${vpLabel}: Add Product sits to the right of the title`).toBeGreaterThan(
        titleBox!.x + titleBox!.width,
      );

      // Row 2: tablist below Row 1.
      expect(tabsBox!.y, `${vpLabel}: tablist is below the page title`).toBeGreaterThan(
        titleBox!.y + titleBox!.height - 4,
      );
      expect(tabsBox!.y, `${vpLabel}: tablist is below Add Product`).toBeGreaterThan(
        addBox!.y + addBox!.height - 4,
      );

      // Row 3: search and contextual secondary actions below tablist and above scroll region.
      for (const [controlName, box] of [
        ['search', searchBox!],
        ['Assign tax category', assignTaxBox!],
        ['CSV', csvBox!],
        ['Print Menu', printMenuBox!],
      ] as const) {
        expect(box.y, `${vpLabel}: ${controlName} is below tablist`).toBeGreaterThanOrEqual(
          tabsBox!.y + tabsBox!.height - 4,
        );
        expect(
          currentRegionBox!.y,
          `${vpLabel}: scroll region is below ${controlName}`,
        ).toBeGreaterThanOrEqual(box.y + box.height - 4);
      }
      await expect(search).toHaveAttribute('id', 'products-search');

      await expectNoHorizontalOverflow(page, vpLabel);

      const pinned = {
        title: await elementTop(title, `${vpLabel}: products title`),
        tabs: await elementTop(tabs, `${vpLabel}: products tabs`),
        addProduct: await elementTop(addProduct, `${vpLabel}: add product`),
        search: await elementTop(search, `${vpLabel}: products search`),
        assignTax: await elementTop(assignTax, `${vpLabel}: assign tax category action`),
        csv: await elementTop(csv, `${vpLabel}: product CSV action`),
        printMenu: await elementTop(printMenu, `${vpLabel}: print menu action`),
      };

      const scrolled = await scrollToEnd(region);
      expect(
        scrolled.scrollTop,
        `${vpLabel}: the product list region owns the scroll`,
      ).toBeGreaterThan(0);

      expectPinned(
        await elementTop(title, `${vpLabel}: products title`),
        pinned.title,
        `${vpLabel}: products title`,
      );
      expectPinned(
        await elementTop(tabs, `${vpLabel}: products tabs`),
        pinned.tabs,
        `${vpLabel}: products tabs`,
      );
      expectPinned(
        await elementTop(addProduct, `${vpLabel}: add product`),
        pinned.addProduct,
        `${vpLabel}: add product`,
      );
      expectPinned(
        await elementTop(search, `${vpLabel}: products search`),
        pinned.search,
        `${vpLabel}: products search`,
      );
      expectPinned(
        await elementTop(assignTax, `${vpLabel}: assign tax category action`),
        pinned.assignTax,
        `${vpLabel}: assign tax category action`,
      );
      expectPinned(
        await elementTop(csv, `${vpLabel}: product CSV action`),
        pinned.csv,
        `${vpLabel}: product CSV action`,
      );
      expectPinned(
        await elementTop(printMenu, `${vpLabel}: print menu action`),
        pinned.printMenu,
        `${vpLabel}: print menu action`,
      );

      const regionBox = await region.boundingBox();
      const lastRowBox = await region.locator('tbody tr').last().boundingBox();
      expect(regionBox, `${vpLabel}: the product list region has bounds`).not.toBeNull();
      expect(lastRowBox, `${vpLabel}: the last product row has bounds`).not.toBeNull();
      expect(
        lastRowBox!.y + lastRowBox!.height,
        `${vpLabel}: the last product row is reachable`,
      ).toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);
    }

    // Tab and Shift+Tab must not land on a control that scrolled out of view.
    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();
    const assertFocusVisible = async (label: string) => {
      const focused = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      expect(focused, `${label}: a control receives focus`).not.toBeNull();
      expect(focused!.height, `${label}: the focused control is rendered`).toBeGreaterThan(0);
      expect(
        focused!.top,
        `${label}: the focused control is not above the viewport`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        focused!.bottom,
        `${label}: the focused control is inside the viewport`,
      ).toBeLessThanOrEqual(viewport!.height + 1);
    };
    await search.focus();
    await page.keyboard.press('Tab');
    await assertFocusVisible('Tab from the pinned search');
    await page.keyboard.press('Shift+Tab');
    await assertFocusVisible('Shift+Tab back to the pinned search');
  });

  test('products keeps each tab’s own actions visible while that tab’s rows scroll', async ({
    page,
  }) => {
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
      const title = page.getByRole('heading', { name: 'Products', level: 1 });
      const tabs = page.getByRole('tablist');
      const action = page.getByRole('button', { name: entry.action });
      const search = page.getByLabel('Search');
      const csv = page.getByRole('button', { name: 'CSV' });

      for (const vp of MANAGEMENT_VIEWPORTS) {
        await page.setViewportSize(vp);
        await region.evaluate((el) => {
          el.scrollTop = 0;
        });
        const vpLabel = `products/${entry.tab} (${vp.width}x${vp.height})`;
        const titleBox = await title.boundingBox();
        const actionBox = await action.boundingBox();
        const tabsBox = await tabs.boundingBox();
        const searchBox = await search.boundingBox();
        const csvBox = await csv.boundingBox();
        const currentRegionBox = await region.boundingBox();

        expect(titleBox, `${vpLabel}: title has bounds`).not.toBeNull();
        expect(actionBox, `${vpLabel}: ${entry.action} has bounds`).not.toBeNull();
        expect(tabsBox, `${vpLabel}: tablist has bounds`).not.toBeNull();
        expect(searchBox, `${vpLabel}: #products-search has bounds`).not.toBeNull();
        expect(csvBox, `${vpLabel}: CSV has bounds`).not.toBeNull();
        expect(currentRegionBox, `${vpLabel}: scroll region has bounds`).not.toBeNull();

        expect(
          Math.abs(titleBox!.y + titleBox!.height / 2 - (actionBox!.y + actionBox!.height / 2)),
          `${vpLabel}: title and ${entry.action} share Row 1`,
        ).toBeLessThanOrEqual(12);
        expect(
          actionBox!.x,
          `${vpLabel}: ${entry.action} sits to the right of the title`,
        ).toBeGreaterThan(titleBox!.x + titleBox!.width);
        expect(tabsBox!.y, `${vpLabel}: tablist is below the header row`).toBeGreaterThan(
          actionBox!.y + actionBox!.height - 4,
        );
        expect(searchBox!.y, `${vpLabel}: search is below tablist`).toBeGreaterThanOrEqual(
          tabsBox!.y + tabsBox!.height - 4,
        );
        expect(csvBox!.y, `${vpLabel}: CSV is below tablist`).toBeGreaterThanOrEqual(
          tabsBox!.y + tabsBox!.height - 4,
        );
        expect(
          currentRegionBox!.y,
          `${vpLabel}: scroll region is below search`,
        ).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height - 4);
        expect(
          currentRegionBox!.y,
          `${vpLabel}: scroll region is below CSV`,
        ).toBeGreaterThanOrEqual(csvBox!.y + csvBox!.height - 4);
        await expect(search).toHaveAttribute('id', 'products-search');

        await expectNoHorizontalOverflow(page, vpLabel);

        const pinned = {
          title: await elementTop(title, `${vpLabel}: products title`),
          tabs: await elementTop(tabs, `${vpLabel}: products tabs`),
          action: await elementTop(action, `${vpLabel}: ${entry.action} action`),
          search: await elementTop(search, `${vpLabel}: products search`),
          csv: await elementTop(csv, `${vpLabel}: ${entry.tab} CSV action`),
        };

        const scrolled = await scrollToEnd(region);
        expect(scrolled.scrollTop, `${vpLabel}: the list region owns the scroll`).toBeGreaterThan(
          0,
        );

        expectPinned(
          await elementTop(title, `${vpLabel}: products title`),
          pinned.title,
          `${vpLabel}: products title`,
        );
        expectPinned(
          await elementTop(tabs, `${vpLabel}: products tabs`),
          pinned.tabs,
          `${vpLabel}: products tabs`,
        );
        expectPinned(
          await elementTop(action, `${vpLabel}: ${entry.action} action`),
          pinned.action,
          `${vpLabel}: ${entry.action} action`,
        );
        expectPinned(
          await elementTop(search, `${vpLabel}: products search`),
          pinned.search,
          `${vpLabel}: products search`,
        );
        expectPinned(
          await elementTop(csv, `${vpLabel}: ${entry.tab} CSV action`),
          pinned.csv,
          `${vpLabel}: ${entry.tab} CSV action`,
        );

        const regionBox = await region.boundingBox();
        const lastRowBox = await region.locator('tbody tr').last().boundingBox();
        expect(regionBox, `${vpLabel}: the list region has bounds`).not.toBeNull();
        expect(lastRowBox, `${vpLabel}: the last row has bounds`).not.toBeNull();
        expect(
          lastRowBox!.y + lastRowBox!.height,
          `${vpLabel}: the last row is reachable`,
        ).toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);
      }

      // Radix unmounts the inactive tab, so a previous tab cannot leave a
      // stale scroller or toolbar behind.
      await expect(
        page.getByTestId('products-list-scroll'),
        `${entry.tab}: the product scroller from the other tab is gone`,
      ).toHaveCount(0);
    }
  });

  test('inventory keeps the title, tabs and active filters visible across its tabs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/inventory`);

    const cases = [
      { tab: 'Supplies', region: 'inventory-supplies-scroll', action: 'Add supply' },
      { tab: 'Recipes', region: 'inventory-recipes-scroll', action: 'Create recipe' },
      { tab: 'Movements', region: 'inventory-movements-scroll', action: null },
    ];
    for (const entry of cases) {
      await page.getByRole('tab', { name: entry.tab }).click();
      const region = page.getByTestId(entry.region);
      await expect(region, `${entry.tab}: the list region renders`).toBeVisible();

      const title = page.getByRole('heading', { name: 'Inventory', level: 1 });
      const tabs = page.getByRole('tablist');
      const search = page.getByPlaceholder('Search').first();
      const action = entry.action ? page.getByRole('button', { name: entry.action }) : null;

      for (const vp of MANAGEMENT_VIEWPORTS) {
        await page.setViewportSize(vp);
        await region.evaluate((el) => {
          el.scrollTop = 0;
        });
        const vpLabel = `inventory/${entry.tab} (${vp.width}x${vp.height})`;
        const titleBox = await title.boundingBox();
        const tabsBox = await tabs.boundingBox();
        const searchBox = await search.boundingBox();
        const currentRegionBox = await region.boundingBox();

        expect(titleBox, `${vpLabel}: title has bounds`).not.toBeNull();
        expect(tabsBox, `${vpLabel}: tablist has bounds`).not.toBeNull();
        expect(searchBox, `${vpLabel}: search has bounds`).not.toBeNull();
        expect(currentRegionBox, `${vpLabel}: scroll region has bounds`).not.toBeNull();

        if (action) {
          const actionBox = await action.boundingBox();
          expect(actionBox, `${vpLabel}: ${entry.action} has bounds`).not.toBeNull();
          expect(
            Math.abs(titleBox!.y + titleBox!.height / 2 - (actionBox!.y + actionBox!.height / 2)),
            `${vpLabel}: title and ${entry.action} share Row 1`,
          ).toBeLessThanOrEqual(12);
          expect(
            actionBox!.x,
            `${vpLabel}: ${entry.action} sits to the right of the title`,
          ).toBeGreaterThan(titleBox!.x + titleBox!.width);
          expect(tabsBox!.y, `${vpLabel}: tablist is below ${entry.action}`).toBeGreaterThan(
            actionBox!.y + actionBox!.height - 4,
          );
        }

        expect(tabsBox!.y, `${vpLabel}: tablist is below the page title`).toBeGreaterThan(
          titleBox!.y + titleBox!.height - 4,
        );
        expect(searchBox!.y, `${vpLabel}: search is below tablist`).toBeGreaterThanOrEqual(
          tabsBox!.y + tabsBox!.height - 4,
        );
        expect(
          currentRegionBox!.y,
          `${vpLabel}: scroll region is below search`,
        ).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height - 4);

        await expectNoHorizontalOverflow(page, vpLabel);

        const pinned = {
          title: await elementTop(title, `${vpLabel}: inventory title`),
          tabs: await elementTop(tabs, `${vpLabel}: inventory tabs`),
          search: await elementTop(search, `${vpLabel}: ${entry.tab} search`),
        };

        const scrolled = await scrollToEnd(region);
        expect(scrolled.scrollTop, `${vpLabel}: the list region owns the scroll`).toBeGreaterThan(
          0,
        );

        expectPinned(
          await elementTop(title, `${vpLabel}: inventory title`),
          pinned.title,
          `${vpLabel}: inventory title`,
        );
        expectPinned(
          await elementTop(tabs, `${vpLabel}: inventory tabs`),
          pinned.tabs,
          `${vpLabel}: inventory tabs`,
        );
        expectPinned(
          await elementTop(search, `${vpLabel}: ${entry.tab} search`),
          pinned.search,
          `${vpLabel}: ${entry.tab} search`,
        );

        const regionBox = await region.boundingBox();
        const lastRowBox = await region.locator('tbody tr').last().boundingBox();
        expect(regionBox, `${vpLabel}: the list region has bounds`).not.toBeNull();
        expect(lastRowBox, `${vpLabel}: the last row has bounds`).not.toBeNull();
        expect(
          lastRowBox!.y + lastRowBox!.height,
          `${vpLabel}: the last row is reachable`,
        ).toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);
      }

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
    await expect
      .poll(() => region.locator('tbody tr').count(), 'the cleared search restores the list')
      .toBeGreaterThan(1);

    // Row edit still opens from the bottom of the scrolled list.
    await scrollToEnd(region);
    await region.locator('tbody tr').last().getByTitle('Edit').click();
    await expect(
      page.getByRole('heading', { name: 'Edit supply' }),
      'the edit dialog opens',
    ).toBeVisible();
    await page.locator('.fixed.inset-0 > div').first().locator('button').first().click();
    await expect(
      page.getByRole('heading', { name: 'Edit supply' }),
      'the edit dialog closes',
    ).toBeHidden();

    // And so does the toolbar action above the list.
    await page.getByRole('button', { name: 'Add supply' }).click();
    await expect(
      page.getByRole('heading', { name: 'Add supply' }),
      'the create dialog opens',
    ).toBeVisible();
  });

  test('customers keeps the title, add action and search visible while the rows scroll', async ({
    page,
  }) => {
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

    for (const vp of MANAGEMENT_VIEWPORTS) {
      await page.setViewportSize(vp);
      await region.evaluate((el) => {
        el.scrollTop = 0;
      });
      const vpLabel = `customers (${vp.width}x${vp.height})`;
      const titleBox = await title.boundingBox();
      const addBox = await addCustomer.boundingBox();
      const searchBox = await search.boundingBox();
      const currentRegionBox = await region.boundingBox();

      expect(titleBox, `${vpLabel}: title has bounds`).not.toBeNull();
      expect(addBox, `${vpLabel}: Add Customer has bounds`).not.toBeNull();
      expect(searchBox, `${vpLabel}: search has bounds`).not.toBeNull();
      expect(currentRegionBox, `${vpLabel}: scroll region has bounds`).not.toBeNull();

      expect(
        Math.abs(titleBox!.y + titleBox!.height / 2 - (addBox!.y + addBox!.height / 2)),
        `${vpLabel}: title and Add Customer share Row 1`,
      ).toBeLessThanOrEqual(12);
      expect(addBox!.x, `${vpLabel}: Add Customer sits to the right of the title`).toBeGreaterThan(
        titleBox!.x + titleBox!.width,
      );
      expect(searchBox!.y, `${vpLabel}: search is below the header row`).toBeGreaterThan(
        titleBox!.y + titleBox!.height - 4,
      );
      expect(searchBox!.y, `${vpLabel}: search is below Add Customer`).toBeGreaterThan(
        addBox!.y + addBox!.height - 4,
      );
      expect(
        currentRegionBox!.y,
        `${vpLabel}: scroll region is below search`,
      ).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height - 4);

      await expectNoHorizontalOverflow(page, vpLabel);

      const pinned = {
        title: await elementTop(title, `${vpLabel}: customers title`),
        add: await elementTop(addCustomer, `${vpLabel}: add customer`),
        search: await elementTop(search, `${vpLabel}: customer search`),
      };

      const scrolled = await scrollToEnd(region);
      expect(
        scrolled.scrollTop,
        `${vpLabel}: the customer list region owns the scroll`,
      ).toBeGreaterThan(0);

      expectPinned(
        await elementTop(title, `${vpLabel}: customers title`),
        pinned.title,
        `${vpLabel}: customers title`,
      );
      expectPinned(
        await elementTop(addCustomer, `${vpLabel}: add customer`),
        pinned.add,
        `${vpLabel}: add customer`,
      );
      expectPinned(
        await elementTop(search, `${vpLabel}: customer search`),
        pinned.search,
        `${vpLabel}: customer search`,
      );

      const regionBox = await region.boundingBox();
      const lastRowBox = await region.locator('tbody tr').last().boundingBox();
      expect(regionBox, `${vpLabel}: the customer list region has bounds`).not.toBeNull();
      expect(lastRowBox, `${vpLabel}: the last customer row has bounds`).not.toBeNull();
      expect(
        lastRowBox!.y + lastRowBox!.height,
        `${vpLabel}: the last customer row is reachable`,
      ).toBeLessThanOrEqual(regionBox!.y + regionBox!.height + 1);
    }

    // The pinned search still filters the scrolled list.
    await search.fill(SYNTHETIC_CUSTOMER_PREFIX);
    await expect(
      region.locator('tbody tr'),
      'the pinned search filters the customer list',
    ).toHaveCount(SYNTHETIC_CUSTOMER_COUNT);
    await search.fill('');
  });

  test('management lists fall back to page flow on a short landscape viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await loginAsManager(page);

    const viewport = page.viewportSize();
    expect(viewport, 'viewport is set').not.toBeNull();
    const cases = [
      {
        name: 'products',
        url: `${BASE}/products`,
        region: 'products-list-scroll',
        action: 'Add Product',
      },
      {
        name: 'inventory',
        url: `${BASE}/inventory`,
        region: 'inventory-supplies-scroll',
        action: 'Add supply',
      },
      {
        name: 'customers',
        url: `${BASE}/customers`,
        region: 'customers-list-scroll',
        action: 'Add Customer',
      },
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
      expect(
        metrics.scrollHeight,
        `${entry.name}: the list is not its own tiny window`,
      ).toBeLessThanOrEqual(metrics.clientHeight + 1);

      const lastRow = region.locator('tbody tr').last();
      await expect(lastRow, `${entry.name}: the last record renders`).toBeAttached();
      await lastRow.scrollIntoViewIfNeeded();
      const lastRowBox = await lastRow.boundingBox();
      expect(lastRowBox, `${entry.name}: the last record has bounds`).not.toBeNull();
      expect(
        lastRowBox!.y + lastRowBox!.height,
        `${entry.name}: the last record is reachable`,
      ).toBeLessThanOrEqual(viewport!.height + 1);

      const action = page.getByRole('button', { name: entry.action });
      await action.scrollIntoViewIfNeeded();
      const actionBox = await action.boundingBox();
      expect(actionBox, `${entry.name}: the pinned action has bounds`).not.toBeNull();
      expect(
        actionBox!.y,
        `${entry.name}: the pinned action is not above the viewport`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        actionBox!.y + actionBox!.height,
        `${entry.name}: the pinned action is reachable`,
      ).toBeLessThanOrEqual(viewport!.height + 1);
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
    expect(lastRowBox!.y, 'the last product row is not above the viewport').toBeGreaterThanOrEqual(
      -1,
    );
    expect(
      lastRowBox!.y + lastRowBox!.height,
      'the last product row is reachable when zoomed',
    ).toBeLessThanOrEqual(viewport!.height + 1);

    await action.scrollIntoViewIfNeeded();
    const actionBox = await action.boundingBox();
    expect(
      actionBox!.y + actionBox!.height,
      'the create action is reachable when zoomed',
    ).toBeLessThanOrEqual(viewport!.height + 1);
  });
});

/**
 * A run may reuse a fixture-prefix category another attempt left behind, but
 * its teardown must remove only what it created. This case seats a pre-existing
 * fixture-prefix category with its own product, runs the menu seed/cleanup pair
 * over it, and requires both to survive while the seed's own rows are gone.
 */
test.describe('layout fixtures only delete what they created', () => {
  const SENTINEL_CATEGORY = `${SYNTHETIC_CATEGORY_PREFIX} 99 Sentinel`;
  const SENTINEL_PRODUCT = `${SYNTHETIC_PRODUCT_PREFIX} 999`;
  let sentinelCategoryId = '';
  let ownedSentinelCategoryId: string | undefined;
  let ownedSentinelProductId: string | undefined;

  const headers = () => ({ Authorization: `Bearer ${getE2eToken()}` });

  async function findCategory(api: APIRequestContext, name: string) {
    const response = await api.get(`${BASE}/api/categories`, { headers: headers() });
    expect(response.status(), 'categories are readable').toBe(200);
    return ((await response.json()).categories as { id: string; name: string }[]).find(
      (category) => category.name === name,
    );
  }

  async function findProduct(api: APIRequestContext, name: string) {
    const response = await api.get(`${BASE}/api/products?active=1`, { headers: headers() });
    expect(response.status(), 'products are readable').toBe(200);
    return (
      (await response.json()).products as { id: string; name: string; category_id: string }[]
    ).find((product) => product.name === name);
  }

  test.beforeAll(async () => {
    const api = await request.newContext();
    try {
      const existingCategory = await findCategory(api, SENTINEL_CATEGORY);
      if (existingCategory) {
        sentinelCategoryId = existingCategory.id;
      } else {
        const created = await api.post(`${BASE}/api/categories`, {
          headers: headers(),
          data: { name: SENTINEL_CATEGORY },
        });
        expect(created.status(), 'the sentinel category is created').toBe(201);
        ownedSentinelCategoryId = (await created.json()).category.id as string;
        sentinelCategoryId = ownedSentinelCategoryId;
      }
      if (!(await findProduct(api, SENTINEL_PRODUCT))) {
        const created = await api.post(`${BASE}/api/products`, {
          headers: headers(),
          data: { name: SENTINEL_PRODUCT, category_id: sentinelCategoryId, price: 25 },
        });
        expect(created.status(), 'the sentinel product is created').toBe(201);
        ownedSentinelProductId = (await created.json()).product.id as string;
      }
    } finally {
      await api.dispose();
    }
  });

  test.afterAll(async () => {
    const api = await request.newContext();
    try {
      if (ownedSentinelProductId) {
        await api.delete(`${BASE}/api/products/${ownedSentinelProductId}`, { headers: headers() });
      }
      if (ownedSentinelCategoryId) {
        await api.delete(`${BASE}/api/categories/${ownedSentinelCategoryId}`, {
          headers: headers(),
        });
      }
    } finally {
      await api.dispose();
    }
  });

  test('a reused category and its pre-existing product survive a seed and cleanup cycle', async () => {
    const api = await request.newContext();
    try {
      const menu = await seedSyntheticMenu(api, 2);
      expect(menu.reusedCategoryIds, 'the sentinel is reused, not re-created').toContain(
        sentinelCategoryId,
      );
      expect(menu.ownedCategoryIds, 'the seed owns what it created').not.toContain(
        sentinelCategoryId,
      );

      await removeSyntheticMenu(api, menu);

      const survivor = await findCategory(api, SENTINEL_CATEGORY);
      expect(survivor, 'the reused category survives the cleanup').toBeTruthy();
      expect(survivor!.id).toBe(sentinelCategoryId);
      const product = await findProduct(api, SENTINEL_PRODUCT);
      expect(product, 'the pre-existing product under the reused category survives').toBeTruthy();
      expect(product!.category_id, 'the surviving product keeps its category').toBe(
        sentinelCategoryId,
      );

      // The seed's own rows are gone, so repeat runs stay isolated.
      const remainingCategories = (
        await (await api.get(`${BASE}/api/categories`, { headers: headers() })).json()
      ).categories as { id: string }[];
      for (const id of menu.ownedCategoryIds) {
        expect(
          remainingCategories.map((category) => category.id),
          'an owned category is removed',
        ).not.toContain(id);
      }
      const remainingProducts = (
        await (await api.get(`${BASE}/api/products?active=1`, { headers: headers() })).json()
      ).products as { id: string }[];
      for (const id of menu.ownedProductIds) {
        expect(
          remainingProducts.map((candidate) => candidate.id),
          'an owned product is removed',
        ).not.toContain(id);
      }
    } finally {
      await api.dispose();
    }
  });
});

/**
 * The customer-facing order display polls /api/orders every three seconds. The
 * specs below serve a controlled in-memory list while retaining the real auth,
 * tenant and theme wiring.
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
): Promise<{ replace: (next: DisplayOrder[]) => void; setUnavailable: (value: boolean) => void }> {
  let current = orders;
  let unavailable = false;
  await page.route(
    (url) => url.pathname === '/api/settings/customer-display',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          statuses: ['pending', 'preparing', 'ready'],
          refresh_seconds: 3,
          show_updated: true,
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/orders',
    (route) => {
      if (unavailable) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ orders: current }),
      });
    },
  );
  return {
    replace: (next) => {
      current = next;
    },
    setUnavailable: (value) => {
      unavailable = value;
    },
  };
}

test.describe('customer display wraps full receipt numbers and pages on TV', () => {
  test('the board fits readable rows at 720p, 1080p and 4K without clipping identifiers', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await loginAsManager(page);
    await page.clock.install();
    const orders = displayOrders(100, 100);
    const longReceiptNumber =
      'INV-2026-NORTH-REGION-COUNTER-04-VERY-LONG-RECEIPT-00000123456789012345678901234567890';
    orders[0].bill.bill_number = longReceiptNumber;
    orders[1].bill.bill_number = '';
    await mockDisplayOrders(page, orders);
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const ready = page.getByTestId('customer-display-ready-scroll');
    const receiptRow = preparing.locator('[data-order-id="display-preparing-1"]:visible');
    await receiptRow.waitFor();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await expect(receiptRow.locator('span')).toHaveText(longReceiptNumber);
    await expect(
      preparing.locator('[data-order-id="display-preparing-2"]:visible'),
      'an order without a bill number uses its full order-number fallback',
    ).toHaveText('P2');

    for (const viewport of [
      { width: 1280, height: 720, screenshot: '/tmp/flo-customer-display-720p.png' },
      { width: 1920, height: 1080, screenshot: '/tmp/flo-customer-display-1080p.png' },
      { width: 3840, height: 2160, screenshot: '/tmp/flo-customer-display-4k.png' },
    ]) {
      await page.setViewportSize(viewport);
      await expect(receiptRow.locator('span')).toHaveText(longReceiptNumber);
      await page.waitForFunction(() => {
        return ['customer-display-preparing-scroll', 'customer-display-ready-scroll'].every(
          (testId) => {
            const board = document.querySelector(`[data-testid="${testId}"]`);
            if (!board) return false;
            const visibleRows = [
              ...board.querySelectorAll('[data-testid="customer-display-order-row"]'),
            ].filter((row) => getComputedStyle(row).visibility === 'visible');
            return visibleRows.length > 0 && visibleRows.length < 100;
          },
        );
      });

      for (const [name, board] of [
        ['preparing', preparing],
        ['ready', ready],
      ] as const) {
        const layout = await board.evaluate((element) => {
          const boardBounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const usableTop = boardBounds.top + Number.parseFloat(style.paddingTop);
          const usableBottom = boardBounds.bottom - Number.parseFloat(style.paddingBottom);
          const visibleRows = [
            ...element.querySelectorAll('[data-testid="customer-display-order-row"]'),
          ]
            .filter((row) => getComputedStyle(row).visibility === 'visible')
            .map((row) => {
              const bounds = row.getBoundingClientRect();
              return { top: bounds.top, bottom: bounds.bottom };
            });
          return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            usableTop,
            usableBottom,
            visibleRows,
          };
        });
        expect(
          layout.scrollWidth,
          `${name} TV board has no horizontal overflow`,
        ).toBeLessThanOrEqual(layout.clientWidth);
        expect(layout.visibleRows.length, `${name} board shows a measured page`).toBeGreaterThan(0);
        expect(layout.visibleRows.length).toBeLessThan(100);
        expect(
          layout.visibleRows.every(
            (row) => row.top >= layout.usableTop - 1 && row.bottom <= layout.usableBottom + 1,
          ),
          `${name} TV rows fit vertically inside the usable column area`,
        ).toBe(true);
      }
      const documentWidths = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(
        documentWidths.scrollWidth,
        'the document has no horizontal overflow',
      ).toBeLessThanOrEqual(documentWidths.clientWidth);
      await page.screenshot({ path: viewport.screenshot });
    }

    const wrappedRow = await receiptRow.boundingBox();
    expect(wrappedRow, 'the long receipt row has bounds').not.toBeNull();
    expect(wrappedRow!.height, 'the full receipt number wraps onto multiple lines').toBeGreaterThan(
      72,
    );
    await expect(page.locator('header'), 'the business header stays visible').toBeVisible();
  });

  test('polling keeps the ten-second page interval and alternates new ready orders with older pages', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const initialOrders = displayOrders(20, 50);
    const feed = await mockDisplayOrders(page, initialOrders);
    const originalReadyOrderIds = new Set(
      initialOrders.filter((order) => order.status === 'ready').map((order) => order.id),
    );
    await page.goto(`${BASE}/customer-display`);
    await expect
      .poll(async () => {
        await page.clock.runFor(1);
        return page.locator('header').count();
      })
      .toBe(1);
    await page.clock.runFor(1);

    const ready = page.getByTestId('customer-display-ready-scroll');
    const readReadyIds = () =>
      ready
        .locator('[data-order-id^="display-ready-"]:visible')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-order-id')));
    await expect(
      ready.locator('[data-order-id="display-ready-1"]:visible'),
      'the first ordinary ready page is initially shown',
    ).toBeVisible();
    const firstOrdinaryPage = await readReadyIds();
    expect(
      firstOrdinaryPage.length,
      'the ready column starts with one of several pages',
    ).toBeLessThan(50);
    const pinned = {
      header: await elementTop(page.locator('header'), 'display header'),
      heading: await elementTop(
        page.getByRole('heading', { name: 'READY FOR PICKUP' }),
        'ready heading',
      ),
    };
    const updatedAt = page.getByText(/^Updated /);
    await expect(updatedAt).toBeVisible();
    const initialUpdatedText = (await updatedAt.textContent()) ?? '';
    await page.clock.runFor(1);
    const updatedFeed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/orders' && response.status() === 200,
    );

    const newReadyOrders = [
      {
        id: 'display-ready-new-1',
        order_number: 'NEW-1',
        bill: { bill_number: 'PRIORITY-NEW-1' },
        status: 'ready' as const,
        created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, 1)).toISOString(),
      },
      {
        id: 'display-ready-new-2',
        order_number: 'NEW-2',
        bill: { bill_number: 'PRIORITY-NEW-2' },
        status: 'ready' as const,
        created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, 2)).toISOString(),
      },
    ];
    feed.replace([...displayOrders(20, 50), newReadyOrders[0]]);
    await page.clock.runFor(3000);
    await updatedFeed;
    await page.clock.runFor(0);
    expect(
      await updatedAt.textContent(),
      'the changed feed is accepted before the current page expires',
    ).not.toBe(initialUpdatedText);
    expect(
      await ready.locator('[data-order-id="display-ready-new-1"]:visible').count(),
      'a newly ready order waits for the current page interval',
    ).toBe(0);
    await page.clock.runFor(6900);
    expect(
      await ready.locator('[data-order-id="display-ready-new-1"]:visible').count(),
      'the current page remains visible until its interval expires',
    ).toBe(0);

    await page.clock.runFor(300);
    await expect(
      ready.locator('[data-order-id="display-ready-new-1"]:visible'),
      'the first rotation prioritizes newly ready orders',
    ).toBeVisible();
    expectPinned(
      await elementTop(page.locator('header'), 'display header'),
      pinned.header,
      'display header',
    );
    expectPinned(
      await elementTop(page.getByRole('heading', { name: 'READY FOR PICKUP' }), 'ready heading'),
      pinned.heading,
      'ready heading',
    );

    const nextFeedUpdate = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/orders' && response.status() === 200,
    );
    feed.replace([...displayOrders(20, 50), ...newReadyOrders]);
    await page.clock.runFor(3000);
    await nextFeedUpdate;
    await page.clock.runFor(0);
    await page.clock.runFor(7000);
    await expect.poll(readReadyIds).not.toEqual(firstOrdinaryPage);
    const secondOrdinaryPage = await readReadyIds();
    expect(
      secondOrdinaryPage.length,
      'the next ordinary page is nonempty during arrivals',
    ).toBeGreaterThan(0);
    expect(
      secondOrdinaryPage.every((id) => !!id && originalReadyOrderIds.has(id)),
      'the next rotation returns to older eligible orders during arrivals',
    ).toBe(true);
    expectPinned(
      await elementTop(page.locator('header'), 'display header'),
      pinned.header,
      'display header',
    );
    expectPinned(
      await elementTop(page.getByRole('heading', { name: 'READY FOR PICKUP' }), 'ready heading'),
      pinned.heading,
      'ready heading',
    );

    await page.clock.runFor(20_000);
    const laterOrdinaryPage = await readReadyIds();
    expect(
      laterOrdinaryPage.length,
      'continued arrivals keep a nonempty ordinary page in rotation',
    ).toBeGreaterThan(0);
    expect(
      laterOrdinaryPage.every((id) => !!id && originalReadyOrderIds.has(id)),
      'continued arrivals keep older eligible orders in the rotation',
    ).toBe(true);
  });

  for (const feedKind of ['paired', 'signed-in'] as const) {
    test(`a stalled ${feedKind} feed reports stale data and resumes polling`, async ({
      page,
      browser,
      request,
    }) => {
      const isPaired = feedKind === 'paired';
      const feedPath = isPaired ? '/api/customer-display/feed' : '/api/orders';
      let routePage = page;
      let displayContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
      let displayTokenId: string | undefined;
      let displayToken: string | undefined;
      let requestCount = 0;
      let releaseHeldResponse!: () => void;
      let markHeldRequestStarted!: () => void;
      let markHeldRequestFinished!: () => void;
      const heldResponse = new Promise<void>((resolve) => {
        releaseHeldResponse = resolve;
      });
      const heldRequestStarted = new Promise<void>((resolve) => {
        markHeldRequestStarted = resolve;
      });
      const heldRequestFinished = new Promise<void>((resolve) => {
        markHeldRequestFinished = resolve;
      });
      const initialOrders = displayOrders(1, 1);
      const recoveredOrders = displayOrders(2, 1);
      const responseBody = (orders: DisplayOrder[]) =>
        isPaired
          ? {
              business_name: 'Flo Cafe',
              config: {
                statuses: ['pending', 'preparing', 'ready'],
                refresh_seconds: 3,
                show_updated: true,
              },
              orders: orders.map((order) => ({
                id: order.id,
                number: order.bill.bill_number || order.order_number,
                status: order.status,
              })),
            }
          : { orders };

      try {
        if (isPaired) {
          const created = await request.post(`${BASE}/api/settings/customer-display/tokens`, {
            headers: { Authorization: `Bearer ${getE2eToken()}` },
            data: { label: 'Stalled feed test' },
          });
          expect(created.status(), 'the test display token is created').toBe(201);
          const createdToken = (await created.json()) as { id: string; token: string };
          displayTokenId = createdToken.id;
          displayToken = createdToken.token;
          displayContext = await browser.newContext();
          routePage = await displayContext.newPage();
        } else {
          await loginAsManager(routePage);
          await routePage.route(
            (url) => url.pathname === '/api/settings/customer-display',
            (route) =>
              route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                  statuses: ['pending', 'preparing', 'ready'],
                  refresh_seconds: 3,
                  show_updated: true,
                }),
              }),
          );
        }
        await routePage.setViewportSize({ width: 1440, height: 900 });
        await routePage.route(
          (url) => url.pathname === feedPath,
          async (route) => {
            requestCount += 1;
            if (requestCount === 2) {
              markHeldRequestStarted();
              await heldResponse;
              try {
                await route.fulfill({
                  status: 200,
                  contentType: 'application/json',
                  body: JSON.stringify(responseBody(initialOrders)),
                });
              } catch {
                // The browser aborts this deliberately held request when its deadline expires.
              }
              markHeldRequestFinished();
              return;
            }

            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(
                responseBody(requestCount === 1 ? initialOrders : recoveredOrders),
              ),
            });
          },
        );

        await routePage.goto(
          isPaired ? `${BASE}/customer-display/#token=${displayToken}` : `${BASE}/customer-display`,
        );
        const preparing = routePage.getByTestId('customer-display-preparing-scroll');
        const firstOrder = preparing.locator('[data-order-id="display-preparing-1"]:visible');
        await expect(firstOrder, 'the first successful feed populates the board').toBeVisible();

        await routePage.waitForTimeout(3000);
        await heldRequestStarted;
        await routePage.waitForTimeout(10_000);
        const staleMessage = routePage.getByText(
          'Connection lost. Showing the last available orders.',
        );
        await expect(staleMessage, 'the stalled feed is reported as stale data').toBeVisible();
        await expect(firstOrder, 'the last successful order stays visible').toBeVisible();

        const recoveredResponse = routePage.waitForResponse(
          (response) => new URL(response.url()).pathname === feedPath && response.status() === 200,
        );
        await routePage.waitForTimeout(2500);
        await recoveredResponse;
        await expect(
          preparing.locator('[data-order-id="display-preparing-2"]:visible'),
          'a later poll recovers after the stalled request is aborted',
        ).toBeVisible();
        await expect(staleMessage, 'the successful recovery clears the stale warning').toHaveCount(
          0,
        );
      } finally {
        releaseHeldResponse();
        if (requestCount === 2) await heldRequestFinished;
        await displayContext?.close();
        if (displayTokenId) {
          await request.delete(`${BASE}/api/settings/customer-display/tokens/${displayTokenId}`, {
            headers: { Authorization: `Bearer ${getE2eToken()}` },
          });
        }
      }
    });
  }

  test('each column pages independently when only one has multiple pages', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.clock.install();
    const feed = await mockDisplayOrders(page, displayOrders(30, 2));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const ready = page.getByTestId('customer-display-ready-scroll');
    const readIds = (board: typeof preparing) =>
      board
        .locator('[data-order-id]:visible')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-order-id')));
    await expect(
      preparing.locator('[data-order-id^="display-preparing-"]:visible').first(),
    ).toBeVisible();
    await expect(ready.locator('[data-order-id^="display-ready-"]:visible').first()).toBeVisible();
    const firstPreparingPage = await readIds(preparing);
    const readyPage = await readIds(ready);
    expect(firstPreparingPage.length, 'preparing has multiple pages').toBeLessThan(30);
    expect(readyPage).toEqual(['display-ready-1', 'display-ready-2']);

    await page.clock.runFor(10_000);
    await expect.poll(() => readIds(preparing)).not.toEqual(firstPreparingPage);
    expect(await readIds(ready), 'the single ready page does not rotate').toEqual(readyPage);

    feed.replace(displayOrders(30, 3));
    await page.clock.runFor(3000);
    await expect
      .poll(() => readIds(ready), {
        message: 'a newly ready order that fits on the single ready page is shown on poll',
      })
      .toEqual(['display-ready-1', 'display-ready-2', 'display-ready-3']);
  });

  test('rotation pauses while the page is hidden and resumes on a fresh ten-second interval', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.clock.install();
    await mockDisplayOrders(page, displayOrders(30, 0));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const readIds = () =>
      preparing
        .locator('[data-order-id]:visible')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-order-id')));
    await expect(preparing.locator('[data-order-id="display-preparing-1"]:visible')).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const currentPage = await readIds();
    expect(currentPage.length).toBeGreaterThan(0);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(0);
    await page.clock.runFor(20_000);
    expect(await readIds(), 'hidden time does not advance the board').toEqual(currentPage);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(0);
    await page.clock.runFor(9500);
    expect(await readIds(), 'resuming starts a fresh page interval').toEqual(currentPage);
    await page.clock.runFor(700);
    await expect.poll(readIds).not.toEqual(currentPage);
  });

  test('orders removed from the eligible feed leave the board on the next poll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.clock.install();
    const feed = await mockDisplayOrders(page, displayOrders(4, 8));
    await page.goto(`${BASE}/customer-display`);

    const ready = page.getByTestId('customer-display-ready-scroll');
    await expect(ready.locator('[data-order-id="display-ready-1"]:visible')).toBeVisible();
    feed.replace(displayOrders(4, 0));
    await page.clock.runFor(3000);
    await expect(page.getByText('No orders are ready yet')).toBeVisible();
    await expect(ready.locator('[data-order-id^="display-ready-"]:visible')).toHaveCount(0);
  });

  test('a delayed response longer than the poll interval still updates the board', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    let delayOrders = false;
    let delayedRequestCount = 0;
    let inFlightDelayedRequests = 0;
    await page.route(
      (url) => url.pathname === '/api/settings/customer-display',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            statuses: ['pending', 'preparing', 'ready'],
            refresh_seconds: 3,
            show_updated: true,
          }),
        }),
    );
    await page.route(
      (url) => url.pathname === '/api/orders',
      async (route) => {
        let orders = displayOrders(1, 0);
        if (delayOrders) {
          delayedRequestCount += 1;
          inFlightDelayedRequests += 1;
          orders = displayOrders(2, 0);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          inFlightDelayedRequests -= 1;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ orders }),
        });
      },
    );
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    await expect(
      preparing.locator('[data-order-id="display-preparing-1"]:visible'),
      'the initial response populates the board before the delayed poll',
    ).toBeVisible();
    await page.waitForTimeout(500);
    delayOrders = true;
    await expect.poll(() => delayedRequestCount, { timeout: 5000 }).toBe(1);
    await page.waitForTimeout(3200);
    expect(delayedRequestCount, 'the next poll tick skips while a request is pending').toBe(1);
    expect(inFlightDelayedRequests, 'only one delayed request is in flight').toBe(1);
    await expect(
      preparing.locator('[data-order-id="display-preparing-2"]:visible'),
      'the slow response is accepted after a later poll tick was skipped',
    ).toBeVisible({ timeout: 2000 });
    expect(inFlightDelayedRequests).toBe(0);
  });

  test('a network failure retains the last successful rows and reports stale data', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    const feed = await mockDisplayOrders(page, displayOrders(3, 2));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const firstOrder = preparing.locator('[data-order-id="display-preparing-1"]:visible');
    await expect(firstOrder, 'the successful response displays the current order').toBeVisible();
    feed.setUnavailable(true);
    await expect(
      page.getByText('Connection lost. Showing the last available orders.'),
      'the network failure is reported as stale data',
    ).toBeVisible({ timeout: 10000 });
    await expect(firstOrder, 'the last successful rows remain visible').toBeVisible();
  });

  test('a narrow viewport keeps all rows in one reachable content flow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsManager(page);
    await mockDisplayOrders(page, displayOrders(12, 12));
    await page.goto(`${BASE}/customer-display`);

    const preparing = page.getByTestId('customer-display-preparing-scroll');
    const ready = page.getByTestId('customer-display-ready-scroll');
    await expect(preparing.locator('[data-order-id="display-preparing-12"]:visible')).toBeVisible();
    await expect(ready.locator('[data-order-id="display-ready-12"]:visible')).toBeVisible();
    await expect(preparing.locator('[data-order-id^="display-preparing-"]:visible')).toHaveCount(
      12,
    );
    await expect(ready.locator('[data-order-id^="display-ready-"]:visible')).toHaveCount(12);

    const widths = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(widths.scrollWidth, 'the mobile flow has no horizontal overflow').toBeLessThanOrEqual(
      widths.clientWidth,
    );
    const lastReady = ready.locator('[data-order-id="display-ready-12"]:visible');
    await lastReady.scrollIntoViewIfNeeded();
    const lastReadyBox = await lastReady.boundingBox();
    expect(lastReadyBox, 'the last mobile row has bounds').not.toBeNull();
    expect(lastReadyBox!.y + lastReadyBox!.height).toBeLessThanOrEqual(844 + 1);
    await expect(page.locator('header'), 'the business header stays visible').toBeVisible();
  });

  test('the display keeps its chrome through loading, empty and stale-feed states', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);
    await page.goto(`${BASE}/customer-display`);
    await expect(page.getByTestId('customer-display-preparing-scroll')).toBeVisible();

    await page.route(
      (url) => url.pathname === '/api/orders',
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ orders: [] }),
        });
      },
    );
    await page.reload();
    await expect(page.getByText('Loading orders…'), 'the loading state renders').toBeVisible();
    await expect(
      page.locator('header'),
      'the business header stays visible while loading',
    ).toBeVisible();
    await expect(
      page.getByText('No orders currently being prepared'),
      'the empty preparing state renders',
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText('No orders are ready yet'),
      'the empty ready state renders',
    ).toBeVisible();
    const emptyBoardHeight = await page
      .getByTestId('customer-display-preparing-scroll')
      .evaluate((element) => element.clientHeight);
    expect(emptyBoardHeight, 'the empty board still occupies usable space').toBeGreaterThan(0);

    await page.route(
      (url) => url.pathname === '/api/orders',
      (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await expect(
      page.getByText('Connection lost. Showing the last available orders.'),
      'the stale-data state is reported after a successful empty response',
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText('No orders currently being prepared'),
      'the sections survive the error state',
    ).toBeVisible();
  });

  test('drains multiple cursor pages, deduplicates overlapping orders, removes completed orders, and clears on follow-up page 401', async ({
    page,
    browser,
    request,
  }) => {
    const created = await request.post(`${BASE}/api/settings/customer-display/tokens`, {
      headers: { Authorization: `Bearer ${getE2eToken()}` },
      data: { label: 'Paginated Queue TV' },
    });
    expect(created.status(), 'the test display token is created').toBe(201);
    const { id: displayTokenId, token: displayToken } = (await created.json()) as {
      id: string;
      token: string;
    };

    const displayContext = await browser.newContext();
    try {
      const displayPage = await displayContext.newPage();
      await displayPage.setViewportSize({ width: 1920, height: 1080 });
      await displayPage.clock.install();

      const allOrders = displayOrders(114, 6);
      const preparingOrders = allOrders.filter((o) => o.status !== 'ready');
      const readyOrders = allOrders.filter((o) => o.status === 'ready');

      const toFeedItem = (order: DisplayOrder) => ({
        id: order.id,
        number: order.bill.bill_number || order.order_number,
        status: order.status,
      });

      // Page 1 (newest 100): preparing 18..114 (97) + ready 4..6 (3) = 100
      const page1Items = [
        ...preparingOrders.slice(17, 114).map(toFeedItem),
        ...readyOrders.slice(3, 6).map(toFeedItem),
      ];
      // Page 2 (older 20 + 2 overlapping boundary orders): preparing 1..18 (18) + ready 1..4 (4)
      let page2Items = [
        ...preparingOrders.slice(0, 18).map(toFeedItem),
        ...readyOrders.slice(0, 4).map(toFeedItem),
      ];
      let revokeOnSecondPage = false;
      const requestedCursors: Array<string | null> = [];

      await displayPage.route(
        (url) => url.pathname === '/api/customer-display/feed',
        async (route) => {
          const cursor = new URL(route.request().url()).searchParams.get('cursor');
          requestedCursors.push(cursor);
          if (!cursor) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                business_name: 'Flo Cafe',
                config: {
                  statuses: ['pending', 'preparing', 'ready'],
                  refresh_seconds: 3,
                  show_updated: true,
                },
                orders: page1Items,
                next_cursor: 'cursor-older-page-2',
                has_more: true,
              }),
            });
            return;
          }
          if (revokeOnSecondPage) {
            await route.fulfill({
              status: 401,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Display not paired' }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              business_name: 'Flo Cafe',
              config: {
                statuses: ['pending', 'preparing', 'ready'],
                refresh_seconds: 3,
                show_updated: true,
              },
              orders: page2Items,
              next_cursor: null,
              has_more: false,
            }),
          });
        },
      );

      await displayPage.goto(`${BASE}/customer-display/#token=${displayToken}`);
      await displayPage.clock.runFor(1);

      const preparing = displayPage.getByTestId('customer-display-preparing-scroll');
      const ready = displayPage.getByTestId('customer-display-ready-scroll');

      await expect.poll(() => requestedCursors.slice(0, 2)).toEqual([null, 'cursor-older-page-2']);

      // Ready column shows orders from both Page 2 (1..4) and Page 1 (4..6) with overlapping #4 deduplicated
      const readVisibleIds = (board: typeof preparing) =>
        board
          .locator('[data-order-id]:visible')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-order-id')));

      await expect
        .poll(() => readVisibleIds(ready))
        .toEqual([
          'display-ready-1',
          'display-ready-2',
          'display-ready-3',
          'display-ready-4',
          'display-ready-5',
          'display-ready-6',
        ]);

      // Preparing column starts with the oldest orders from Page 2 and deduplicates overlapping display-preparing-18
      await expect(
        preparing.locator('[data-order-id="display-preparing-1"]:visible'),
      ).toBeVisible();
      const preparingProbeStats = await preparing.evaluate((el) => {
        const probe = el.querySelector('[aria-hidden="true"]');
        const rows = probe
          ? [...probe.querySelectorAll('[data-testid="customer-display-order-row"]')]
          : [];
        const ids = rows.map((r) => r.getAttribute('data-order-id'));
        return {
          total: ids.length,
          duplicate18Count: ids.filter((id) => id === 'display-preparing-18').length,
        };
      });
      expect(preparingProbeStats.total, 'all 114 unique preparing orders are merged').toBe(114);
      expect(
        preparingProbeStats.duplicate18Count,
        'overlapping order across pages is deduplicated',
      ).toBe(1);

      const checkNoOverflow = async () => {
        for (const [name, board] of [
          ['preparing', preparing],
          ['ready', ready],
        ] as const) {
          const layout = await board.evaluate((element) => {
            const boardBounds = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const usableTop = boardBounds.top + Number.parseFloat(style.paddingTop);
            const usableBottom = boardBounds.bottom - Number.parseFloat(style.paddingBottom);
            const visibleRows = [
              ...element.querySelectorAll('[data-testid="customer-display-order-row"]'),
            ]
              .filter((row) => getComputedStyle(row).visibility === 'visible')
              .map((row) => {
                const bounds = row.getBoundingClientRect();
                return { top: bounds.top, bottom: bounds.bottom };
              });
            return {
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              usableTop,
              usableBottom,
              visibleRows,
            };
          });
          expect(
            layout.scrollWidth,
            `${name} board has no horizontal overflow`,
          ).toBeLessThanOrEqual(layout.clientWidth);
          expect(
            layout.visibleRows.every(
              (row) => row.top >= layout.usableTop - 1 && row.bottom <= layout.usableBottom + 1,
            ),
            `${name} rows fit vertically inside the column`,
          ).toBe(true);
        }
      };

      await checkNoOverflow();

      // Rotate through 10-second TV visual pages until orders from Page 1 (display-preparing-19+) are shown
      const firstPreparingVisualPage = await readVisibleIds(preparing);
      await displayPage.clock.runFor(10_000);
      await expect.poll(() => readVisibleIds(preparing)).not.toEqual(firstPreparingVisualPage);
      await displayPage.clock.runFor(10_000);
      const laterPreparingVisualPage = await readVisibleIds(preparing);
      expect(
        laterPreparingVisualPage.some((id) => {
          const n = Number(id?.replace('display-preparing-', ''));
          return Number.isFinite(n) && n >= 19;
        }),
        'TV rotation reaches newer orders from Page 1 after displaying older orders from Page 2',
      ).toBe(true);
      await checkNoOverflow();

      // Completing orders removes them from the board on the next poll
      page2Items = page2Items.filter(
        (item) => item.id !== 'display-ready-1' && item.id !== 'display-preparing-1',
      );
      await displayPage.clock.runFor(3000);
      await expect
        .poll(() => readVisibleIds(ready))
        .toEqual([
          'display-ready-2',
          'display-ready-3',
          'display-ready-4',
          'display-ready-5',
          'display-ready-6',
        ]);
      await expect(preparing.locator('[data-order-id="display-preparing-1"]')).toHaveCount(0);

      // A 401 on a follow-up cursor page immediately aborts pagination, clears stored token and orders, and shows unpaired state
      revokeOnSecondPage = true;
      await displayPage.clock.runFor(3000);
      await expect(
        displayPage.getByRole('heading', { name: 'This display is not paired', exact: true }),
      ).toBeVisible();
      await expect(displayPage.getByTestId('customer-display-order-row')).toHaveCount(0);
      const storedTokenAfter401 = await displayPage.evaluate(() =>
        window.localStorage.getItem('flo.customerDisplayToken'),
      );
      expect(storedTokenAfter401).toBeNull();
      await displayPage.close();

      // Signed-in staff fallback mode also drains multiple /api/orders cursor pages via before_id and deduplicates
      await page.setViewportSize({ width: 1920, height: 1080 });
      await loginAsManager(page);
      await page.clock.install();
      const staffBeforeIds: Array<string | null> = [];
      const staffStatuses: Array<string | null> = [];
      const staffPerPages: Array<string | null> = [];
      let staffSettingsMode: 'all' | 'ready-only' | 'preparing-only' | 'fail' = 'all';
      let staffOrdersFail = false;
      await page.route(
        (url) => url.pathname === '/api/settings/customer-display',
        (route) => {
          if (staffSettingsMode === 'fail') {
            return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          }
          const statuses =
            staffSettingsMode === 'ready-only'
              ? ['ready']
              : staffSettingsMode === 'preparing-only'
                ? ['preparing']
                : ['pending', 'preparing', 'ready'];
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              statuses,
              refresh_seconds: 3,
              show_updated: true,
            }),
          });
        },
      );
      await page.route(
        (url) => url.pathname === '/api/orders',
        (route) => {
          if (staffOrdersFail) {
            return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          }
          const params = new URL(route.request().url()).searchParams;
          const beforeId = params.get('before_id');
          staffBeforeIds.push(beforeId);
          staffStatuses.push(params.get('status'));
          staffPerPages.push(params.get('per_page'));
          if (!beforeId) {
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                orders: [...preparingOrders.slice(17, 114), ...readyOrders.slice(3, 6)],
                nextCursor: 'staff-cursor-2',
              }),
            });
          }
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              orders: [...preparingOrders.slice(0, 18), ...readyOrders.slice(0, 4)],
              nextCursor: null,
            }),
          });
        },
      );
      await page.goto(`${BASE}/customer-display`);
      await page.clock.runFor(1);
      const staffReady = page.getByTestId('customer-display-ready-scroll');
      await expect.poll(() => staffBeforeIds.slice(0, 2)).toEqual([null, 'staff-cursor-2']);
      expect(staffStatuses[0]).toBe('pending,preparing,ready');
      expect(staffPerPages[0]).toBe('100');
      await expect
        .poll(() => readVisibleIds(staffReady))
        .toEqual([
          'display-ready-1',
          'display-ready-2',
          'display-ready-3',
          'display-ready-4',
          'display-ready-5',
          'display-ready-6',
        ]);

      // Switch staff display to ready-only on a successful poll
      staffSettingsMode = 'ready-only';
      await page.clock.runFor(3000);
      await expect(page.getByTestId('customer-display-preparing-scroll')).toHaveCount(0);
      await expect(staffReady.locator('[data-order-id="display-ready-1"]:visible')).toBeVisible();

      // Next poll reads preparing-only settings, but /api/orders fails; then settings fails while /api/orders succeeds.
      // configRef and config state must stay aligned so fetched orders never disappear behind mismatched column visibility.
      staffSettingsMode = 'preparing-only';
      staffOrdersFail = true;
      await page.clock.runFor(3000);
      await expect(
        page.getByText('Connection lost. Showing the last available orders.'),
      ).toBeVisible();

      staffSettingsMode = 'fail';
      staffOrdersFail = false;
      await page.clock.runFor(3000);
      await expect(
        page.getByText('Connection lost. Showing the last available orders.'),
      ).toHaveCount(0);
      await expect(staffReady.locator('[data-order-id="display-ready-1"]:visible')).toBeVisible();

      // Multi-page drain whose total time (3 x 4000ms = 12000ms) exceeds the 10000ms per-request timeout succeeds
      // when each individual page responds within 10000ms, and 5-page polling at refresh_seconds: 2 stays within 120 req/min
      const budgetPage = await displayContext.newPage();
      await budgetPage.setViewportSize({ width: 1920, height: 1080 });
      const initialClockMs = Date.now();
      await budgetPage.clock.install({ time: initialClockMs - 60_000 });
      await budgetPage.clock.pauseAt(initialClockMs);
      let slowMode = true;
      let rateWindowRequests = 0;
      let hit429 = false;
      let notifySlowPageRequest: (() => void) | null = null;
      let releaseSlowPageResponse: (() => void) | null = null;

      await budgetPage.route(
        (url) => url.pathname === '/api/customer-display/feed',
        async (route) => {
          const cursor = new URL(route.request().url()).searchParams.get('cursor');
          if (slowMode) {
            await new Promise<void>((resolve) => {
              releaseSlowPageResponse = resolve;
              notifySlowPageRequest?.();
            });
            const pageMap: Record<
              string,
              { items: ReturnType<typeof toFeedItem>[]; next: string | null; more: boolean }
            > = {
              first: { items: [toFeedItem(readyOrders[2])], next: 'slow-2', more: true },
              'slow-2': { items: [toFeedItem(readyOrders[1])], next: 'slow-3', more: true },
              'slow-3': { items: [toFeedItem(readyOrders[0])], next: null, more: false },
            };
            const entry = pageMap[cursor ?? 'first'];
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                business_name: 'Flo Cafe',
                config: {
                  statuses: ['pending', 'preparing', 'ready'],
                  refresh_seconds: 2,
                  show_updated: true,
                },
                orders: entry.items,
                next_cursor: entry.next,
                has_more: entry.more,
              }),
            });
            return;
          }

          rateWindowRequests += 1;
          if (rateWindowRequests > 120) {
            hit429 = true;
            await route.fulfill({
              status: 429,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Too many requests' }),
            });
            return;
          }
          const pageIndex = cursor ? Number(cursor.replace('rate-page-', '')) : 1;
          const hasMore = pageIndex < 5;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              business_name: 'Flo Cafe',
              config: {
                statuses: ['pending', 'preparing', 'ready'],
                refresh_seconds: 2,
                show_updated: true,
              },
              orders: [toFeedItem(readyOrders[5 - pageIndex])],
              next_cursor: hasMore ? `rate-page-${pageIndex + 1}` : null,
              has_more: hasMore,
            }),
          });
        },
      );

      const waitForNextSlowPage = () =>
        new Promise<void>((resolve) => {
          notifySlowPageRequest = resolve;
        });

      const slowPage1Arrived = waitForNextSlowPage();
      await budgetPage.goto(`${BASE}/customer-display/#token=${displayToken}`);
      await expect
        .poll(async () => {
          await budgetPage.clock.runFor(1);
          return budgetPage.locator('header').count();
        })
        .toBe(1);
      await budgetPage.clock.runFor(1);
      await slowPage1Arrived;

      const slowPage2Arrived = waitForNextSlowPage();
      await budgetPage.clock.runFor(4000);
      releaseSlowPageResponse!();
      await slowPage2Arrived;

      const slowPage3Arrived = waitForNextSlowPage();
      await budgetPage.clock.runFor(4000);
      releaseSlowPageResponse!();
      await slowPage3Arrived;

      // Total elapsed time in this single poll is now 12000ms (> 10000ms single-request timeout),
      // but each individual page only took 4000ms so page 3 must NOT abort.
      await budgetPage.clock.runFor(4000);
      releaseSlowPageResponse!();

      const budgetReady = budgetPage.getByTestId('customer-display-ready-scroll');
      await expect
        .poll(() => readVisibleIds(budgetReady))
        .toEqual(['display-ready-1', 'display-ready-2', 'display-ready-3']);

      // Switch to 5-page fast responses at refresh_seconds: 2 and verify the 5-page poll budget
      slowMode = false;
      rateWindowRequests = 0;
      hit429 = false;
      // Trigger one poll so the client observes a 5-page queue at refresh_seconds: 2
      await budgetPage.clock.runFor(2000);
      await expect.poll(() => rateWindowRequests).toBe(5);

      // Starting a 60-second rate-limit window with the initial 5-page poll (5 requests used):
      // advancing 2000ms (configured refresh_seconds: 2) must NOT fire a new poll yet because 5 pages require 2609ms spacing
      await budgetPage.clock.runFor(2000);
      expect(
        rateWindowRequests,
        '2-second configured refresh is throttled to stay within 120 reads/min for a 5-page queue',
      ).toBe(5);

      // Advancing to the 5-page budget floor (2609ms) triggers the next 5-page poll, and repeating across 60s stays <= 120 requests
      await budgetPage.clock.runFor(609);
      await expect.poll(() => rateWindowRequests).toBe(10);
      for (let elapsed = 2609; elapsed + 2609 < 60_000; elapsed += 2609) {
        const expectedNext = rateWindowRequests + 5;
        await budgetPage.clock.runFor(2609);
        await expect.poll(() => rateWindowRequests).toBe(expectedNext);
      }
      expect(hit429, '5-page polling at 2s refresh never exceeds 120 req/min').toBe(false);
      expect(rateWindowRequests).toBe(115);
      await expect
        .poll(() => readVisibleIds(budgetReady))
        .toEqual([
          'display-ready-1',
          'display-ready-2',
          'display-ready-3',
          'display-ready-4',
          'display-ready-5',
        ]);
    } finally {
      await displayContext.close();
      await request
        .delete(`${BASE}/api/settings/customer-display/tokens/${displayTokenId}`, {
          headers: { Authorization: `Bearer ${getE2eToken()}` },
        })
        .catch(() => {});
    }
  });
});

/**
 * Entering the Movements tab starts a fresh first-page request, but the cursor
 * from the previous visit stayed live until that request resolved. Clicking
 * Load more inside that window started a second request that superseded the
 * refresh, so the older page was appended and the fresh receipts were dropped.
 * These tests hold the responses open to exercise that exact window, and pin
 * the recovery contract: the refresh owns the cursor until it resolves.
 */
test.describe('inventory movements refresh owns the pagination cursor', () => {
  const movement = (id: number, supplyName: string) => ({
    id,
    supply_id: `movement-supply-${id}`,
    supply_name: supplyName,
    movement_type: 'receive',
    quantity_delta: 1,
    unit: 'each',
    stock_after: 1,
    reason: null,
    actor_name: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });

  test('a held first-page refresh cannot append an older page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);

    const requestedCursors: (string | null)[] = [];
    let firstPageCount = 0;
    let releaseRefresh = () => {};
    let signalRefresh = () => {};
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    await page.route('**/api/supplies/movements*', async (route) => {
      const beforeId = new URL(route.request().url()).searchParams.get('before_id');
      requestedCursors.push(beforeId);
      if (beforeId) {
        await route.fulfill({
          json: { movements: [movement(2, 'SECOND PAGE MOVEMENT')], nextCursor: null },
        });
        return;
      }
      firstPageCount += 1;
      if (firstPageCount === 1) {
        await route.fulfill({
          json: { movements: [movement(100, 'OLD PAGE MOVEMENT')], nextCursor: 999 },
        });
        return;
      }
      // The re-entry refresh stays unresolved until the test releases it.
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
        signalRefresh();
      });
      await route.fulfill({
        json: { movements: [movement(300, 'NEW PAGE MOVEMENT')], nextCursor: 888 },
      });
    });

    await page.goto(`${BASE}/inventory`);
    await page.getByRole('tab', { name: 'Movements' }).click();
    await expect(page.getByText('OLD PAGE MOVEMENT')).toBeVisible();

    // Leave and re-enter: the fresh first page is now blocked mid-flight.
    await page.getByRole('tab', { name: 'Recipes' }).click();
    await page.getByRole('tab', { name: 'Movements' }).click();
    await refreshStarted;
    expect(firstPageCount, 'the re-entry refresh has started').toBe(2);

    // The stale cursor must not offer a page while that refresh is unresolved.
    await expect(
      page.getByRole('button', { name: 'Load more' }),
      'the old cursor is hidden until the refresh resolves',
    ).toHaveCount(0);

    releaseRefresh();
    await expect(page.getByText('NEW PAGE MOVEMENT'), 'the fresh page wins').toBeVisible();
    await expect(page.getByText('OLD PAGE MOVEMENT'), 'the outdated page is replaced').toHaveCount(
      0,
    );

    // Normal pagination resumes on the fresh cursor.
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByText('SECOND PAGE MOVEMENT')).toBeVisible();
    await expect(page.getByText('NEW PAGE MOVEMENT')).toBeVisible();
    expect(requestedCursors, 'the stale 999 cursor was never requested').toEqual([
      null,
      null,
      '888',
    ]);
  });

  test('a failed first-page refresh does not leave the old cursor live', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);

    let firstPageCount = 0;
    await page.route('**/api/supplies/movements*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('before_id')) {
        await route.fulfill({
          json: { movements: [movement(2, 'SECOND PAGE MOVEMENT')], nextCursor: null },
        });
        return;
      }
      firstPageCount += 1;
      if (firstPageCount === 1) {
        await route.fulfill({
          json: { movements: [movement(100, 'OLD PAGE MOVEMENT')], nextCursor: 999 },
        });
        return;
      }
      await route.fulfill({ status: 500, json: { error: 'Internal server error' } });
    });

    await page.goto(`${BASE}/inventory`);
    await page.getByRole('tab', { name: 'Movements' }).click();
    await expect(page.getByText('OLD PAGE MOVEMENT')).toBeVisible();

    await page.getByRole('tab', { name: 'Recipes' }).click();
    await page.getByRole('tab', { name: 'Movements' }).click();
    await expect(page.getByText('Failed to load inventory')).toBeVisible({ timeout: 15_000 });

    // The refresh failed, so its cursor cannot silently authorize an old page.
    await expect(
      page.getByRole('button', { name: 'Load more' }),
      'a failed refresh invalidates the stale cursor',
    ).toHaveCount(0);
  });

  test('a failed older movement page can be retried with the same cursor', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);

    const requestedCursors: (string | null)[] = [];
    let olderPageAttempts = 0;
    await page.route('**/api/supplies/movements*', async (route) => {
      const beforeId = new URL(route.request().url()).searchParams.get('before_id');
      requestedCursors.push(beforeId);
      if (!beforeId) {
        await route.fulfill({
          json: { movements: [movement(100, 'FIRST PAGE MOVEMENT')], nextCursor: 999 },
        });
        return;
      }
      olderPageAttempts += 1;
      if (olderPageAttempts === 1) {
        await route.fulfill({ status: 500, json: { error: 'Internal server error' } });
        return;
      }
      await route.fulfill({
        json: { movements: [movement(2, 'SECOND PAGE MOVEMENT')], nextCursor: null },
      });
    });

    await page.goto(`${BASE}/inventory`);
    await page.getByRole('tab', { name: 'Movements' }).click();
    await expect(page.getByText('FIRST PAGE MOVEMENT')).toBeVisible();

    const loadMore = page.getByRole('button', { name: 'Load more' });
    await loadMore.click();
    await expect(page.getByText('Failed to load inventory')).toBeVisible();
    await expect(loadMore).toBeVisible();
    await loadMore.click();

    await expect(page.getByText('SECOND PAGE MOVEMENT')).toBeVisible();
    expect(requestedCursors).toEqual([null, '999', '999']);
  });

  test('a movement search change clears the list and its cursor', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsManager(page);

    let firstPageCount = 0;
    await page.route('**/api/supplies/movements*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('before_id')) {
        await route.fulfill({
          json: { movements: [movement(2, 'SECOND PAGE MOVEMENT')], nextCursor: null },
        });
        return;
      }
      firstPageCount += 1;
      await route.fulfill(
        firstPageCount === 1
          ? { json: { movements: [movement(100, 'OLD PAGE MOVEMENT')], nextCursor: 999 } }
          : { json: { movements: [movement(300, 'FILTERED PAGE MOVEMENT')], nextCursor: null } },
      );
    });

    await page.goto(`${BASE}/inventory`);
    await page.getByRole('tab', { name: 'Movements' }).click();
    await expect(page.getByText('OLD PAGE MOVEMENT')).toBeVisible();

    await page.getByPlaceholder('Search').first().fill('filtered');
    await expect(page.getByText('FILTERED PAGE MOVEMENT')).toBeVisible();
    await expect(page.getByText('OLD PAGE MOVEMENT'), 'the unfiltered page is dropped').toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });
});

test('staff modals close on Escape, ignore non-Escape keys, restore trigger focus, and clean up keydown listeners', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const activeKeydownListeners = new Set<EventListenerOrEventListenerObject>();
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'keydown' && listener) activeKeydownListeners.add(listener);
      return origAdd(type, listener as EventListener, options);
    };
    window.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (type === 'keydown' && listener) activeKeydownListeners.delete(listener);
      return origRemove(type, listener as EventListener, options);
    };
    (
      window as unknown as { __getActiveKeydownListenerCount: () => number }
    ).__getActiveKeydownListenerCount = () => activeKeydownListeners.size;
  });

  await loginAsManager(page);
  await page.goto(`${BASE}/staff`);

  const getListenerCount = () =>
    page.evaluate(() =>
      (
        window as unknown as { __getActiveKeydownListenerCount: () => number }
      ).__getActiveKeydownListenerCount(),
    );

  const addTrigger = page.getByRole('button', { name: 'Add Staff', exact: true }).first();
  const serverCard = page.locator('div.bg-card').filter({ hasText: 'server@flo.local' });
  const editTrigger = serverCard.getByRole('button', { name: 'Edit', exact: true });
  const resetPwTrigger = serverCard.getByRole('button', { name: 'Reset PW', exact: true });

  await expect(addTrigger).toBeVisible();
  await expect(editTrigger).toBeVisible();
  await expect(resetPwTrigger).toBeVisible();

  const baselineListeners = await getListenerCount();

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await addTrigger.click();
    const addDialog = page.getByRole('dialog', { name: 'Add Staff' });
    await expect(addDialog).toBeVisible();
    expect(await getListenerCount()).toBe(baselineListeners + 1);

    const addNameInput = addDialog.getByPlaceholder('Name');
    await addNameInput.click();
    await page.keyboard.type('Alex');
    await page.keyboard.press('Tab');
    await expect(addDialog).toBeVisible();
    await expect(addTrigger).not.toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(addTrigger).toBeFocused();
    expect(await getListenerCount()).toBe(baselineListeners);

    await editTrigger.click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Staff' });
    await expect(editDialog).toBeVisible();
    expect(await getListenerCount()).toBe(baselineListeners + 1);

    const editNameInput = editDialog.getByPlaceholder('Name');
    await editNameInput.click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    await expect(editDialog).toBeVisible();
    await expect(editTrigger).not.toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(editTrigger).toBeFocused();
    expect(await getListenerCount()).toBe(baselineListeners);

    await resetPwTrigger.click();
    const resetDialog = page.getByRole('dialog', { name: 'Reset Password' });
    await expect(resetDialog).toBeVisible();
    expect(await getListenerCount()).toBe(baselineListeners + 1);

    const resetInput = resetDialog.getByPlaceholder('New Password (leave empty to keep)');
    await resetInput.click();
    await page.keyboard.type('Secret123');
    await page.keyboard.press('Enter');
    await expect(resetDialog).toBeVisible();
    await expect(resetPwTrigger).not.toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(resetPwTrigger).toBeFocused();
    expect(await getListenerCount()).toBe(baselineListeners);
  }
});

/**
 * Measured collapse rows and cart table placement (#1152).
 *
 * Categories and favorites collapse to one measured row with a toggle instead
 * of horizontal scrolling, and the dine-in table control lives in the cart next
 * to the Pax stepper rather than in the topbar.
 */
async function openPosAsManager(page: Page): Promise<void> {
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

test.describe('POS collapse rows and cart table control', () => {
  test('an overflowing category row collapses to one measured row with a working toggle', async ({
    page,
    request,
  }) => {
    // Ten extra categories guarantee the row overflows at 1366px; they are the
    // only entities this test creates and they are gone again afterwards.
    const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const authHeaders = { Authorization: `Bearer ${token}` };
    const createdIds: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const response = await request.post(`${BASE}/api/categories`, {
          headers: authHeaders,
          data: { name: `E2E Split Row ${index} with a deliberately long category label` },
        });
        expect(response.ok(), `fixture category ${index} created`).toBeTruthy();
        createdIds.push((await response.json()).category.id as string);
      }

      await page.setViewportSize({ width: 1366, height: 768 });
      await loginAsManager(page);
      await openPosAsManager(page);

      const row = page.getByTestId('pos-category-row');
      await expect(row).toBeVisible();

      const box = await row.boundingBox();
      expect(box, 'category row bounds').not.toBeNull();

      const toggle = page.getByRole('button', { name: 'View more' });
      await expect(toggle, 'overflowing categories offer the toggle').toBeVisible();
      expect(await toggle.getAttribute('aria-controls')).toBe(await row.getAttribute('id'));
      await toggle.click();
      await expect(page.getByRole('button', { name: 'View less' })).toBeVisible();
      expect(
        await page.getByRole('button', { name: 'View less' }).getAttribute('aria-controls'),
      ).toBe(await row.getAttribute('id'));

      // Expanded rows wrap and every category is reachable without the page or
      // the grid scrolling sideways.
      const expanded = await row.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      expect(
        expanded.scrollWidth,
        'expanded categories fit without horizontal scroll',
      ).toBeLessThanOrEqual(expanded.clientWidth + 1);
      expect(expanded.scrollHeight, 'expanded rows wrap onto several lines').toBeGreaterThan(
        box!.height + 4,
      );

      await page.getByRole('button', { name: 'View less' }).click();
      await expect(page.getByRole('button', { name: 'View more' })).toBeVisible();
      const collapsedBox = await row.boundingBox();
      expect(collapsedBox!.height, 'collapsed row returns to a single line').toBeLessThanOrEqual(
        box!.height + 4,
      );
    } finally {
      for (const categoryId of createdIds) {
        await request.delete(`${BASE}/api/categories/${categoryId}`, { headers: authHeaders });
      }
    }
  });

  test('a long selected category and toggle fit narrow English, German, Turkish and RTL rows', async ({
    page,
    request,
  }) => {
    const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const authHeaders = { Authorization: `Bearer ${token}` };
    const createdIds: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const response = await request.post(`${BASE}/api/categories`, {
          headers: authHeaders,
          data: { name: `E2E Tail Row ${index} with a deliberately long category label` },
        });
        expect(response.ok(), `tail fixture category ${index} created`).toBeTruthy();
        createdIds.push((await response.json()).category.id as string);
      }

      await loginAsManager(page);
      await openPosAsManager(page);
      for (const [width, language] of [
        [390, 'en'],
        [320, 'de'],
        [320, 'tr'],
        [320, 'ar'],
      ] as const) {
        await page.setViewportSize({ width, height: 844 });
        await setLanguage(page, language);
        await page.reload();

        // Expand and pick the last category so it sits beyond any collapsed prefix.
        const row = page.getByTestId('pos-category-row');
        await row.locator('button[aria-expanded="false"]').click();
        const selected = row.getByRole('button', {
          name: 'E2E Tail Row 9 with a deliberately long category label',
        });
        await selected.click();
        await row.locator('button[aria-expanded="true"]').click();

        await expect(selected).toBeVisible();
        const toggle = row.locator('button[aria-expanded="false"]');
        await expect
          .poll(async () => {
            const bounds = await row.boundingBox();
            const toggleBounds = await toggle.boundingBox();
            const selectedBounds = await selected.boundingBox();
            const allBounds = await row.getByRole('button').first().boundingBox();
            return Boolean(
              bounds &&
              toggleBounds &&
              selectedBounds &&
              allBounds &&
              allBounds.x >= bounds.x &&
              allBounds.x + allBounds.width <= bounds.x + bounds.width + 1 &&
              toggleBounds.x >= bounds.x &&
              toggleBounds.x + toggleBounds.width <= bounds.x + bounds.width + 1 &&
              selectedBounds.x >= bounds.x &&
              selectedBounds.x + selectedBounds.width <= bounds.x + bounds.width + 1,
            );
          }, 'the selected category and toggle are completely inside the row')
          .toBe(true);
        await toggle.click();
        await expect(
          row.getByRole('button', {
            name: 'E2E Tail Row 0 with a deliberately long category label',
          }),
        ).toBeVisible();
      }
    } finally {
      await setLanguage(page, 'en');
      for (const categoryId of createdIds) {
        await request.delete(`${BASE}/api/categories/${categoryId}`, { headers: authHeaders });
      }
    }
  });

  test('the dine-in table control moves into the cart beside Pax', async ({ page }) => {
    const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const businessResponse = await page.request.get(`${BASE}/api/settings/business`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(businessResponse.ok()).toBeTruthy();
    const originalBusiness = await businessResponse.json();
    try {
      const switchUpdate = await page.request.put(`${BASE}/api/settings/business`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { ...originalBusiness, tables_required: true },
      });
      expect(switchUpdate.ok()).toBeTruthy();

      await page.setViewportSize({ width: 1366, height: 768 });
      await loginAsManager(page);
      const cart = page.getByTestId('cart-shell');
      await expect(cart).toBeVisible();

      await page.getByRole('button', { name: 'Dine in' }).first().click();
      await expect(cart.getByRole('button', { name: /Select Table|Table / })).toBeVisible();
    } finally {
      await page.request.put(`${BASE}/api/settings/business`, {
        headers: { Authorization: `Bearer ${token}` },
        data: originalBusiness,
      });
    }
  });

  test('the cart table control opens the picker from the mobile drawer too', async ({ page }) => {
    const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const businessResponse = await page.request.get(`${BASE}/api/settings/business`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(businessResponse.ok()).toBeTruthy();
    const originalBusiness = await businessResponse.json();
    try {
      const switchUpdate = await page.request.put(`${BASE}/api/settings/business`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { ...originalBusiness, tables_required: true },
      });
      expect(switchUpdate.ok()).toBeTruthy();

      await page.setViewportSize({ width: 390, height: 844 });
      await loginAsManager(page);
      // The order-type controls live in the cart itself, so the drawer opens first.
      await page.getByRole('button', { name: 'Cart' }).click();
      const drawerCart = page.getByTestId('cart-shell').last();
      await expect(drawerCart).toBeVisible();
      await drawerCart.getByRole('button', { name: 'Dine in' }).first().click();
      await expect(drawerCart.getByRole('button', { name: /Select Table|Table / })).toBeVisible();
    } finally {
      await page.request.put(`${BASE}/api/settings/business`, {
        headers: { Authorization: `Bearer ${token}` },
        data: originalBusiness,
      });
    }
  });
});
