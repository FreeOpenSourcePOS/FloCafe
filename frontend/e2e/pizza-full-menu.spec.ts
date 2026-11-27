import {
  test,
  expect,
  request as playwrightRequest,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { clearPizzaMenu, loadSampleMenu, sampleMenu } from './helpers/pizza-menu';
import { getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * The pizza screens with a full-size menu: 26 pizzas and 8 deals, grown from
 * the made-up sample here. Every spec shares one database, so this one loads
 * the menu itself, cancels the order it places and clears the menu when it ends.
 *
 * How many tiles fit depends on the rows of category blocks above them, which
 * wrap as their names need. So the page is given the shop's categories as a
 * shop with only its menu has them, whatever other specs left in the database.
 */

const VIEW = { width: 1180, height: 820 };
const PIZZAS = 26;
const LONG = [7, 13, 22];
const nameOf = (number: number) =>
  `Sample Pizza ${number}${LONG.includes(number) ? ' Extra Long Made-Up Name' : ''}`;
const LONG_NAME = nameOf(7);

const menu = sampleMenu();
const itemsOf = (id: string) => menu.categories.find((category) => category.id === id)!.items;
const pizzas = itemsOf('pizzas');
const deals = itemsOf('deals');
for (let number = pizzas.length + 1; number <= PIZZAS; number += 1) {
  pizzas.push({
    ...pizzas[number % 4],
    id: `sample-pizza-${number}`,
    number,
    name: nameOf(number),
  });
}
for (let number = deals.length + 1; number <= 8; number += 1) {
  deals.push({
    ...deals[number % 4],
    id: `sample-deal-${number}`,
    name: `Sample Deal ${number}`,
    description: `Made-up deal ${number}: sample pizzas, a sample salad, sample garlic toast & pops for the table`,
  });
}
const THREE = deals.find((deal) => deal.id === 'three-large-wings')!;
const SIZES = (menu.sizes as { pizza: { label: string; price: number }[] }).pizza;
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '\\.'));

/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
const headers = () => ({ Authorization: `Bearer ${getE2eToken()}` });

test.use({ viewport: VIEW });

test.beforeAll(async () => {
  expect(LONG_NAME.length).toBeGreaterThanOrEqual(35);
  expect(LONG_NAME.length).toBeLessThanOrEqual(40);
  const api = await playwrightRequest.newContext();
  await loadSampleMenu(api, menu);
  await api.dispose();
});

test.afterAll(async () => {
  const api = await playwrightRequest.newContext();
  try {
    await clearPizzaMenu(api);
  } finally {
    await api.dispose();
  }
});

const MENU_CATEGORIES = ['cat-pizzas', 'cat-sides', 'cat-drinks', 'cat-deals'];
/** Categories a shop made besides its menu, added to the answer after the menu's four. */
let otherCategories: { id: string; name: string }[] = [];

test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname === '/api/categories',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const menu = body.categories.filter((entry: { id: string }) =>
        MENU_CATEGORIES.includes(entry.id),
      );
      const others = otherCategories.map((entry) => ({
        ...menu[0],
        ...entry,
        children: [],
      }));
      await route.fulfill({
        response,
        json: { ...body, categories: [...menu, ...others] },
      });
    },
  );
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
  await expect(page.getByTestId('pizza-tile')).toHaveCount(PIZZAS);
});

async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR)
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, name),
      animations: 'disabled',
    });
}

/** A number the report quotes, kept with the test's result. */
const measured = (name: string, value: number) => {
  test.info().annotations.push({ type: name, description: String(value) });
  console.log(`[measured] ${name}: ${value}`);
};

const halfTile = (page: Page): Locator => page.getByTestId('pizza-half-tile');
const dealTiles = (page: Page): Locator => page.getByTestId('pos-product-card');

/** How many of these lie wholly inside the viewport and inside every scrolling box around them. */
const whollyVisible = (tiles: Locator): Promise<number> =>
  tiles.evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const box = element.getBoundingClientRect();
        const inside = (frame: { top: number; left: number; bottom: number; right: number }) =>
          box.top >= frame.top &&
          box.left >= frame.left &&
          box.bottom <= frame.bottom &&
          box.right <= frame.right;
        const frames = [
          {
            top: 0,
            left: 0,
            bottom: window.innerHeight,
            right: window.innerWidth,
          },
        ];
        for (let up = element.parentElement; up; up = up.parentElement)
          if (getComputedStyle(up).overflowY !== 'visible') frames.push(up.getBoundingClientRect());
        return frames.every(inside);
      }).length,
  );

const tooSmall = (scope: Locator): Promise<(string | null)[]> =>
  scope.locator('button').evaluateAll((controls) =>
    controls
      .map((control) => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 48 || box.height < 48)
      .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
  );

/**
 * Both halves chosen in the editor inside `scope`: each half's list gives way
 * to the pizza with its ingredient chips on screen, and Change brings the list back.
 */
async function bothHalvesFit(page: Page, scope: Locator, scroller: Locator): Promise<void> {
  const first = scope.getByRole('group', { name: '1st half' });
  const second = scope.getByRole('group', { name: '2nd half' });
  // A pizza in the list is named by its number and its name.
  const inList = (half: Locator, name: string) =>
    half.getByRole('button', { name: new RegExp(`(^|\\d )${name}$`) });

  // Nothing is chosen yet, so each half lists every pizza.
  await expect(inList(first, nameOf(26))).toBeVisible();
  await inList(first, LONG_NAME).click();
  await inList(second, 'Garden').click();
  const { content, room } = await scroller.evaluate((element) => ({
    content: element.scrollHeight,
    room: element.clientHeight,
  }));
  measured('editor content height', content);
  measured('editor room', room);
  expect(content, 'the editor does not scroll with both halves chosen').toBeLessThanOrEqual(room);

  // Sample Pizza 7 is made of the sample's Smokehouse Chicken.
  const chips: [Locator, string[]][] = [
    [first, ['Roasted chicken', 'BBQ sauce']],
    [second, ['Mushrooms', 'Tomato sauce']],
  ];
  for (const [half, ingredients] of chips) {
    await expect(inList(half, nameOf(26))).toHaveCount(0);
    await expect(half.getByRole('button', { name: 'Change' })).toBeVisible();
    for (const name of ingredients)
      await expect(half.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await expect(first).toContainText(LONG_NAME);
  await expect(second).toContainText('Garden');
  expect(await tooSmall(scope)).toEqual([]);

  await second.getByRole('button', { name: 'Change' }).click();
  await expect(inList(second, 'Garden')).toHaveAttribute('aria-pressed', 'true');
  expect(await tooSmall(second), 'every pizza in the list is at least 48 px').toEqual([]);
  await inList(second, nameOf(26)).click();
  await expect(inList(second, 'Garden')).toHaveCount(0);
  await expect(second).toContainText(nameOf(26));
  await second.getByRole('button', { name: 'Change' }).click();
  await inList(second, 'Garden').click();
  await expect(second.getByRole('button', { name: 'Olives', exact: true })).toBeInViewport({
    ratio: 1,
  });
}

test('twelve pizzas fit a screen, Half & Half first, every control 48 px', async ({ page }) => {
  const tiles = page.getByTestId('pizza-tile');
  const visible = await whollyVisible(tiles);
  measured('pizza tiles wholly visible', visible);
  expect(visible).toBeGreaterThanOrEqual(12);

  const order = await page
    .locator('[data-testid="pizza-half-tile"], [data-testid="pizza-tile"]')
    .evaluateAll((all) => all.map((tile) => tile.getAttribute('data-testid')));
  expect(order[0], 'Half & Half comes before pizza number 1').toBe('pizza-half-tile');
  expect(await whollyVisible(halfTile(page))).toBe(1);
  const half = (await halfTile(page).boundingBox())!;
  const one = (await tiles.first().boundingBox())!;
  expect(half.y < one.y || (half.y === one.y && half.x < one.x)).toBeTruthy();

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    'the page does not scroll sideways',
  ).toBeLessThanOrEqual(0);
  expect(
    await page
      .locator('[data-testid="pos-catalog-scroll"], [data-testid="pizza-tile"]')
      .evaluateAll((all) => all.filter((one) => one.scrollWidth > one.clientWidth).length),
    'neither the list nor a tile overflows sideways',
  ).toBe(0);

  expect(await tooSmall(tiles)).toEqual([]);
  expect(await tooSmall(halfTile(page))).toEqual([]);
  const first = tiles.first();
  await expect(first.getByRole('button')).toHaveCount(4);
  await expect(first.getByRole('button', { name: 'Customize Garden' })).toBeVisible();
  for (const size of ['Small', 'Medium', 'Large'])
    await expect(first.getByRole('button', { name: new RegExp(`^Garden, ${size}`) })).toBeVisible();
  await shot(page, 'full-menu-home.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await shot(page, 'full-menu-home-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);

  // The count on a tile is a bare number to the eye and a phrase to a screen reader.
  await first.getByRole('button', { name: /^Garden, Large/ }).click();
  await expect(first.getByText('1 in order', { exact: true })).toHaveCount(1);
});

test('a menu with four sizes keeps every size button inside its tile', async ({ page }) => {
  const fourSizes = structuredClone(menu);
  (fourSizes.sizes as { pizza: object[] }).pizza.push({
    id: 'extra-large',
    label: 'Extra Large',
    price: 27,
  });
  const api = await playwrightRequest.newContext();
  try {
    await loadSampleMenu(api, fourSizes);
    const tiles = page.getByTestId('pizza-tile');
    // From the widest tiles of this screen down to the narrowest the grid makes.
    for (const width of [VIEW.width, 1100, 1024, 980]) {
      await page.setViewportSize({ ...VIEW, width });
      await page.reload();
      await expect(tiles).toHaveCount(PIZZAS);
      await expect(tiles.first().getByRole('button', { name: /^Garden, / })).toHaveCount(4);
      const outside = await tiles.evaluateAll((all) =>
        all.flatMap((tile) => {
          const box = tile.getBoundingClientRect();
          return [...tile.querySelectorAll('button')]
            .map((button) => button.getBoundingClientRect())
            .filter((button) => button.left < box.left - 0.5 || button.right > box.right + 0.5)
            .map(
              (button) => `${Math.round(button.right - box.right)} px past a ${box.width} px tile`,
            );
        }),
      );
      expect(outside, `at ${width} px wide no button leaves its tile`).toEqual([]);
      expect(await tooSmall(tiles), `at ${width} px wide every control is 48 px`).toEqual([]);
      expect(
        await tiles.evaluateAll(
          (all) => all.filter((one) => one.scrollWidth > one.clientWidth).length,
        ),
        `at ${width} px wide no tile hides part of a row`,
      ).toBe(0);
    }
    await shot(page, 'full-menu-four-sizes.png');
  } finally {
    await loadSampleMenu(api, menu);
    await api.dispose();
  }
});

test('the pizza list is at most about two screens', async ({ page }) => {
  const { content, room } = await page.getByTestId('pos-catalog-scroll').evaluate((element) => ({
    content: element.scrollHeight,
    room: element.clientHeight,
  }));
  measured('pizza list height', content);
  measured('pizza list room', room);
  // Nine rows of three tiles under the Half & Half row, each row about 100 px.
  expect(content, 'the list is as long as nine rows of tiles').toBeLessThanOrEqual(1000);
  expect(content / room, 'screens of list, for a shop with only its menu').toBeLessThanOrEqual(2.1);
});

test.describe('a shop with two more categories than its menu', () => {
  test.beforeAll(() => {
    otherCategories = [
      { id: 'sample-extra-1', name: 'Sample Extras' },
      { id: 'sample-extra-2', name: 'Sample Desserts' },
    ];
  });
  test.afterAll(() => {
    otherCategories = [];
  });

  test('nine category blocks still leave twelve pizzas on a screen', async ({ page }) => {
    await expect(page.getByTestId('pizza-category-blocks').getByRole('button')).toHaveCount(9);
    const visible = await whollyVisible(page.getByTestId('pizza-tile'));
    measured('pizza tiles wholly visible with nine category blocks', visible);
    expect(visible).toBeGreaterThanOrEqual(12);
    expect(await whollyVisible(halfTile(page))).toBe(1);
    const room = await page
      .getByTestId('pos-catalog-scroll')
      .evaluate((element) => element.clientHeight);
    measured('pizza list room with nine category blocks', room);
  });
});

test('a tap anywhere on the top 48 px of a tile opens the sheet, never a size', async ({
  page,
}) => {
  for (const name of ['Garden', LONG_NAME]) {
    const tile = page
      .getByTestId('pizza-tile')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    const customize = tile.getByRole('button', { name: `Customize ${name}` });
    await expect(customize).toBeInViewport({ ratio: 1 });
    // Points along the top, the middle and the lower edge of Customize, and the top edge of each size
    // clear of its rounded corners.
    const misses = await tile.evaluate((element) => {
      const hits = (button: Element, rows: number[], inset: number) => {
        const box = button.getBoundingClientRect();
        return rows.flatMap((y) =>
          [box.left + inset, box.left + box.width / 2, box.right - inset].flatMap((x) => {
            const hit = document.elementFromPoint(x, y);
            return hit && button.contains(hit)
              ? []
              : [`${button.getAttribute('aria-label')} at ${y}: ${hit?.textContent}`];
          }),
        );
      };
      const [band, ...sizes] = element.querySelectorAll('button');
      const box = band.getBoundingClientRect();
      return [
        `${box.width}x${box.height}`,
        ...hits(band, [box.top + 1, box.top + box.height / 2, box.bottom - 1], 1),
        ...sizes.flatMap((size) => hits(size, [size.getBoundingClientRect().top + 1], 9)),
      ];
    });
    const [size, ...rest] = misses;
    const [width, height] = size.split('x').map(Number);
    measured(`customize height, ${name}`, height);
    expect(width).toBeGreaterThanOrEqual(48);
    expect(height).toBeGreaterThanOrEqual(48);
    expect(rest, `${name}: every point hits its own button`).toEqual([]);

    const box = (await customize.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 2);
    const sheet = page.getByRole('dialog', { name: 'Pizza' });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(tile.getByText(/in order$/)).toHaveCount(0);
  }
  await expect(page.getByText('Cart is empty')).toBeVisible();
});

test('a search keeps every price on screen', async ({ page }) => {
  const search = page.getByTestId('pos-product-search');
  const legend = page.getByTestId('pizza-price-legend');
  for (const typed of ['Garden', '3*gar']) {
    await search.fill(typed);
    await expect(halfTile(page)).toHaveCount(0);
    const garden = page.getByTestId('pizza-tile').filter({ hasText: 'Garden' });
    for (const { label, price } of SIZES)
      await expect(
        garden.getByRole('button', { name: new RegExp(`^Garden, ${label}`) }),
        `${typed}: Garden's ${label} shows its price, with no legend to quote it`,
      ).toContainText(money(price));
  }
  await search.fill('Half');
  await expect(page.getByTestId('pizza-tile')).toHaveCount(0);
  await expect(halfTile(page)).toBeVisible();
  await expect(legend, 'no pizza on screen, so no pizza prices').toHaveCount(0);
  for (const { label, price } of SIZES)
    await expect(halfTile(page).getByRole('button', { name: new RegExp(label) })).toContainText(
      money(price),
    );
  await shot(page, 'full-menu-search-half.png');
});

test('the price legend stays on screen at the end of the list', async ({ page }) => {
  const legend = page.getByTestId('pizza-price-legend');
  await expect(legend).toContainText('Most pizzas:');
  await page.getByTestId('pos-catalog-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole('heading', { name: nameOf(PIZZAS), exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(legend).toBeInViewport({ ratio: 1 });
  expect(await whollyVisible(halfTile(page))).toBe(1);
  const covered = await legend.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !hit || !element.contains(hit);
  });
  expect(covered, 'no tile scrolls over the legend').toBe(false);
  await shot(page, 'full-menu-scrolled.png');
});

/**
 * Shift+Tab from the last control of the list up to the first one below the Half & Half row,
 * then Tab back down: every control the focus reaches scrolls below that sticky row, uncovered.
 */
async function keyboardClearsHalfRow(page: Page): Promise<void> {
  const list = page.getByTestId('pos-catalog-scroll');
  const controls = list.locator('button:enabled:not([data-testid="pizza-half-tile"] button)');
  const names = await controls.evaluateAll((all) =>
    all.map((control) => control.getAttribute('aria-label') || control.textContent),
  );
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await controls.last().focus();
  /** Where the focused control sits, or null once focus has left the list below the row. */
  const focused = () =>
    page.evaluate(() => {
      const control = document.activeElement as HTMLElement | null;
      const half = document.querySelector('[data-testid="pizza-half-tile"]')!;
      if (!control?.closest('[data-testid="pos-catalog-scroll"]') || half.contains(control))
        return null;
      const box = control.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        name: control.getAttribute('aria-label') || control.textContent,
        top: box.top,
        below: half.getBoundingClientRect().bottom,
        hit: !!hit && control.contains(hit),
      };
    });
  const check = async (key: string) => {
    const seen: (string | null)[] = [];
    for (let step = 1; step < names.length; step += 1) {
      await page.keyboard.press(key);
      const at = await focused();
      expect(at, `${key} ${step} stays in the list below the Half & Half row`).not.toBeNull();
      expect(at!.top, `${at!.name} is below the Half & Half row`).toBeGreaterThanOrEqual(
        at!.below - 1,
      );
      expect(at!.hit, `${at!.name} is not covered`).toBe(true);
      seen.push(at!.name);
    }
    return seen;
  };
  const up = await check('Shift+Tab');
  expect(up.at(-1)).toBe(names[0]);
  const down = await check('Tab');
  expect(down.at(-1)).toBe(names.at(-1));
}

test('a tile control reached by the keyboard is never under the Half & Half row', async ({
  page,
}) => {
  await keyboardClearsHalfRow(page);
  await shot(page, 'full-menu-keyboard-focus.png');
});

test('under All, a deal or product reached by the keyboard is never under the Half & Half row', async ({
  page,
}) => {
  await page
    .getByTestId('pizza-category-blocks')
    .getByRole('button', { name: 'All', exact: true })
    .click();
  await expect(page.getByTestId('pos-product-card').filter({ hasText: 'Green Salad' })).toHaveCount(
    1,
  );
  await keyboardClearsHalfRow(page);
  await shot(page, 'full-menu-keyboard-focus-all.png');
});

test("a tap on the Half & Half row lands on it, over a product's badge scrolled beneath", async ({
  page,
}) => {
  await page
    .getByTestId('pizza-category-blocks')
    .getByRole('button', { name: 'All', exact: true })
    .click();
  const salad = page.getByTestId('pos-product-card').filter({ hasText: 'Green Salad' });
  await salad.click();
  const badge = salad.getByText('1', { exact: true });
  await expect(badge).toBeVisible();
  const small = halfTile(page).getByRole('button', {
    name: /^Half & Half, Small/,
  });
  const top = (await small.boundingBox())!.y;
  await page.getByTestId('pos-catalog-scroll').evaluate(
    (element, { card, to }) => {
      element.scrollTop += card - to;
    },
    { card: (await salad.boundingBox())!.y, to: top + 4 },
  );
  const { overlap, misses } = await small.evaluate(
    (button, badgeBox) => {
      const box = button.getBoundingClientRect();
      const left = Math.max(box.left, badgeBox.x);
      const right = Math.min(box.right, badgeBox.x + badgeBox.width);
      const y = badgeBox.y + badgeBox.height / 2;
      const misses: string[] = [];
      for (let x = box.left + 2; x <= box.right - 2; x += 2) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !button.contains(hit)) misses.push(`${x}: ${hit?.textContent}`);
      }
      return {
        overlap: { x: (left + right) / 2, y, width: right - left },
        misses,
      };
    },
    (await badge.boundingBox())!,
  );
  expect(overlap.width, "the salad's badge lies under the Small button").toBeGreaterThan(0);
  expect(misses, 'every point across Small hits Small').toEqual([]);

  await page.mouse.click(overlap.x, overlap.y);
  const sheet = page.getByRole('dialog', { name: 'Pizza' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(badge).toHaveText('1');
});

test('the keyboard also clears a Half & Half row that wraps', async ({ page }) => {
  const manySizes = structuredClone(menu);
  (manySizes.sizes as { pizza: object[] }).pizza.push(
    { id: 'extra-large', label: 'Extra Large', price: 27 },
    { id: 'family', label: 'Family Feast', price: 31 },
    { id: 'party', label: 'Party Platter', price: 35 },
  );
  const sizes = SIZES.length + 3;
  const api = await playwrightRequest.newContext();
  try {
    await loadSampleMenu(api, manySizes);
    await page.setViewportSize({ ...VIEW, width: 980 });
    await page.reload();
    await expect(page.getByTestId('pizza-tile')).toHaveCount(PIZZAS);
    await expect(halfTile(page).getByRole('button')).toHaveCount(sizes);
    const { height, clearance } = await halfTile(page).evaluate((row) => ({
      height: Math.ceil(row.getBoundingClientRect().height),
      clearance: parseFloat(
        getComputedStyle(row.closest('[data-testid="pos-catalog-scroll"]')!).scrollPaddingTop,
      ),
    }));
    measured('wrapped Half & Half height', height);
    expect(height, 'the row is taller than a fixed 7rem clearance').toBeGreaterThan(112);
    expect(clearance, 'the list keeps the height of the row clear').toBeGreaterThanOrEqual(height);
    await keyboardClearsHalfRow(page);
    await shot(page, 'full-menu-keyboard-focus-wrapped.png');
  } finally {
    await loadSampleMenu(api, menu);
    await api.dispose();
  }
});

test("a Half & Half priced apart shows its own prices beside the pizzas' legend", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/products',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const product of body.products)
        if (product.id === 'pz-half-and-half')
          for (const variant of product.variants) variant.price += 4;
      await route.fulfill({ response, json: body });
    },
  );
  await page.reload();
  const legend = page.getByTestId('pizza-price-legend');
  await expect(legend).toContainText('Most pizzas:');
  for (const { label, price } of SIZES) {
    await expect(legend).toContainText(money(price));
    const half = halfTile(page).getByRole('button', {
      name: new RegExp(label),
    });
    await expect(half).toContainText(money(price + 4));
    await expect(half).not.toContainText(money(price));
  }
  await shot(page, 'full-menu-half-priced-apart.png');
});

test('a long custom size label wraps in the legend without overflowing sideways', async ({
  page,
}) => {
  const LONG_SIZE =
    'Super Ultra Mega Party Family Banquet Feast Celebration Special Edition Extra Giant Pizza Size';
  await page.route(
    (url) => url.pathname === '/api/products',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const product of body.products)
        if (product.id.startsWith('pz-'))
          for (const variant of product.variants)
            if (variant.name === 'Large') variant.name = LONG_SIZE;
      await route.fulfill({ response, json: body });
    },
  );
  await page.reload();
  const legend = halfTile(page).getByTestId('pizza-price-legend');
  await expect(legend).toContainText(LONG_SIZE);
  const scroller = page.getByTestId('pos-catalog-scroll');
  const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, 'the catalog does not scroll sideways').toBeLessThanOrEqual(0);
  const priceBox = await legend
    .locator('span')
    .filter({ hasText: money(SIZES[2].price) })
    .last()
    .boundingBox();
  const scrollerBox = (await scroller.boundingBox())!;
  expect(priceBox, 'the price amount is rendered').not.toBeNull();
  expect(priceBox!.x + priceBox!.width, 'the price fits inside the scrollport').toBeLessThanOrEqual(
    scrollerBox.x + scrollerBox.width + 0.5,
  );
  expect(priceBox!.height, 'the price stays on one line').toBeLessThanOrEqual(24);
});

test('a wide screen stops at five columns', async ({ page }) => {
  const tiles = page.getByTestId('pizza-tile');
  for (const width of [1600, 1920, 2560]) {
    await page.setViewportSize({ width, height: VIEW.height });
    const columns = await tiles.evaluateAll(
      (all) => new Set(all.map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
    );
    measured(`columns at ${width} px`, columns);
    expect(columns, `${width} px wide`).toBe(5);
  }
});

test('a long name is shown whole, on two lines at most', async ({ page }) => {
  for (const name of LONG.map(nameOf)) {
    const heading = page.getByRole('heading', { name, exact: true });
    await heading.scrollIntoViewIfNeeded();
    const { clipped, lines, text } = await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clipped:
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1 ||
          style.textOverflow === 'ellipsis' ||
          style.webkitLineClamp !== 'none',
        lines: Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight)),
        text: (element as HTMLElement).innerText,
      };
    });
    expect(text).toBe(name);
    expect(clipped, `${name} is not clipped or clamped`).toBe(false);
    expect(lines, `${name} takes two lines at most`).toBeLessThanOrEqual(2);
  }
});

test('in the sheet both halves show their ingredients without scrolling', async ({ page }) => {
  await halfTile(page).getByRole('button', { name: /Large/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Pizza' });
  await bothHalvesFit(page, sheet, sheet.getByTestId('pizza-sheet-body'));
  await shot(page, 'full-menu-sheet.png');
});

test("a deal's pizza tab does the same", async ({ page }) => {
  await page
    .getByTestId('pizza-category-blocks')
    .getByRole('button', { name: 'Deals', exact: true })
    .click();
  await dealTiles(page)
    .filter({ hasText: THREE.name as string })
    .click();
  const dialog = page.getByRole('dialog', { name: THREE.name as string });
  const panel = dialog.getByRole('tabpanel');
  await panel.getByRole('button', { name: 'Half & half' }).click();
  await bothHalvesFit(page, panel, panel);
  await shot(page, 'full-menu-deal-halves.png');
});

test('the Deals category shows all eight deals with what each contains', async ({ page }) => {
  await page
    .getByTestId('pizza-category-blocks')
    .getByRole('button', { name: 'Deals', exact: true })
    .click();
  const tiles = dealTiles(page);
  await expect(tiles).toHaveCount(deals.length);
  expect(await whollyVisible(tiles)).toBe(deals.length);
  for (const deal of deals) {
    const tile = tiles.filter({ hasText: deal.name as string });
    await expect(tile).toContainText(deal.price!.toFixed(2));
    const description = tile.getByTestId('pizza-deal-description');
    await expect(description).toHaveText(deal.description as string);
    const lines = await description.evaluate((element) =>
      Math.round(
        element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
      ),
    );
    expect(lines, `${deal.name}: two lines at most`).toBeLessThanOrEqual(2);
  }
  expect(await tooSmall(page.getByTestId('pos-catalog-scroll'))).toEqual([]);
  await shot(page, 'full-menu-deals.png');

  // The full text of a description cut to two lines is in the configurator's header.
  const last = deals[deals.length - 1];
  await tiles.filter({ hasText: last.name as string }).click();
  await expect(page.getByRole('dialog', { name: last.name as string })).toContainText(
    last.description as string,
  );
});

test('the kitchen is told what comes with a deal that has no pizzas', async ({ request }) => {
  const placed = await request.post(`${BASE}/api/orders`, {
    headers: headers(),
    data: {
      type: 'takeaway',
      items: [
        {
          product_id: 'dl-pasta-night',
          quantity: 1,
          modifier_selection: {
            kind: 'deal',
            v: 1,
            dealId: 'pasta-night',
            pizzas: [],
            pops: { cola: 3 },
          },
        },
      ],
    },
  });
  expect(placed.ok(), `the order is accepted (got ${placed.status()})`).toBeTruthy();
  const { order } = await placed.json();
  try {
    const kitchen = await request.get(`${BASE}/api/kitchen/orders`, {
      headers: headers(),
    });
    expect(kitchen.ok()).toBeTruthy();
    const body = await kitchen.json();
    const ours = (body.orders ?? body).find((entry: { id: number }) => entry.id === order.id);
    expect(ours.items[0].recipe_lines).toEqual([
      'POP: 3 COLA',
      'INCLUDES: 3 PASTA, 3 GARLIC TOASTS & 3 POPS',
    ]);
  } finally {
    await request.patch(`${BASE}/api/orders/${order.id}/status`, {
      headers: headers(),
      data: { status: 'cancelled', reason: 'E2E cleanup' },
    });
  }
});
