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
 * The pizza POS home and the pizza sheet, against the made-up sample menu.
 * Every spec shares one database, so this one loads the menu itself, never
 * asserts "no menu" against the server, and clears the menu when it ends.
 */

const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };

const menu = sampleMenu();
const itemsOf = (categoryId: string) =>
  menu.categories.find((category) => category.id === categoryId)!.items;
const sizePrice = (id: string): number =>
  (menu.sizes as { pizza: { id: string; price: number }[] }).pizza.find((size) => size.id === id)!
    .price;
const LARGE = sizePrice('large');
const DIP = itemsOf('sides').find((side) => side.id === 'dip')!.price!;
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '\\.'));

/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext();
  await loadSampleMenu(api);
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

async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, name), animations: 'disabled' });
}

async function openPos(page: Page): Promise<void> {
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

const tile = (page: Page, name: string): Locator =>
  page.getByTestId('pizza-tile').filter({ has: page.getByRole('heading', { name, exact: true }) });
const halfTile = (page: Page): Locator => page.getByTestId('pizza-half-tile');
const sheetOf = (page: Page): Locator => page.getByRole('dialog', { name: 'Pizza' });
const cartLines = (page: Page): Locator => page.getByTestId('cart-item');
const details = (line: Locator): Locator => line.getByTestId('pizza-line-detail');
const quantity = (line: Locator): Locator => line.getByTestId('pizza-line-quantity');

/** A large half and half: Garden without olives, and Classic Pepperoni. */
async function buildHalfAndHalf(page: Page): Promise<Locator> {
  await halfTile(page).getByRole('button', { name: /Large/ }).click();
  const sheet = sheetOf(page);
  const first = sheet.getByRole('group', { name: '1st half' });
  await first.getByRole('button', { name: 'Garden' }).click();
  await first.getByRole('button', { name: 'Olives', exact: true }).click();
  await sheet
    .getByRole('group', { name: '2nd half' })
    .getByRole('button', { name: 'Classic Pepperoni' })
    .click();
  return sheet;
}

/** A large Garden without olives, through the sheet. */
async function addGardenNoOlives(
  page: Page,
  beforeAdd?: (sheet: Locator) => Promise<void>,
): Promise<void> {
  await tile(page, 'Garden').getByRole('button', { name: 'Customize Garden' }).click();
  const sheet = sheetOf(page);
  await sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Large/ }).click();
  await sheet.getByRole('button', { name: 'Olives', exact: true }).click();
  await beforeAdd?.(sheet);
  await sheet.getByRole('button', { name: /^Add to order/ }).click();
  await expect(sheet).toBeHidden();
}

/** What the server answers when it holds no menu, and when it holds one with every item taken out. */
const NOT_A_PIZZA_MENU = {
  'no pizza menu': (page: Page) =>
    page.route('**/api/pizza/catalog', (route) =>
      route.fulfill({ status: 404, json: { error: 'No menu has been loaded' } }),
    ),
  'a menu that has no pizzas': (page: Page) =>
    page.route('**/api/pizza/catalog', async (route) => {
      const stored = await (await route.fetch()).json();
      await route.fulfill({
        json: { ...stored, pizzas: [], dips: [], sides: [], drinks: [], deals: [] },
      });
    }),
};

for (const [name, answer] of Object.entries(NOT_A_PIZZA_MENU)) {
  test(`with ${name} the POS home is upstream`, async ({ page }) => {
    await answer(page);
    const catalog = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/pizza/catalog',
    );
    await openPos(page);
    await catalog;
    await expect(page.getByTestId('pos-category-row')).toBeVisible();
    await expect(page.getByTestId('pizza-category-blocks')).toHaveCount(0);
    await expect(page.getByTestId('pizza-tile')).toHaveCount(0);
    await expect(page.getByTestId('pizza-half-tile')).toHaveCount(0);

    // A pizza is an ordinary product here: upstream's tile, dialog and cart line.
    await page.getByTestId('pos-product-card').filter({ hasText: 'Garden' }).click();
    await expect(sheetOf(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Add to Cart/ }).click();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(cartLines(page).first()).toContainText('Garden');
    await expect(cartLines(page).first().getByTestId('cart-item-qty')).toHaveText('1');
    await expect(page.getByTestId('pizza-line-actions')).toHaveCount(0);
    await expect(page.getByTestId('pizza-line-detail')).toHaveCount(0);
  });
}

test.describe('with the sample menu loaded', () => {
  test.beforeEach(async ({ page }) => {
    await openPos(page);
    await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
    await page.getByRole('button', { name: 'Takeaway' }).click();
  });

  test('a dashboard screen other than the POS loads the menu too', async ({ page }) => {
    const catalog = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/pizza/catalog',
    );
    await page.goto(`${BASE}/orders`);
    const response = await catalog;
    expect(response.status()).toBe(200);
    expect((await response.json()).pizzas).toHaveLength(itemsOf('pizzas').length);
  });

  test('a menu loaded on another device reaches the open POS when its window comes to the front', async ({
    page,
    request,
  }) => {
    // "All" shows a pizza, whose price is the product's, beside a deal, whose words are the menu's.
    await page
      .getByTestId('pizza-category-blocks')
      .getByRole('button', { name: 'All', exact: true })
      .click();
    const large = tile(page, 'Garden').getByRole('button', { name: /Large/ });
    await expect(large).toContainText(money(LARGE));
    const combo = itemsOf('deals').find((deal) => deal.id === 'large-combo')!;
    const WORDS = 'One large pizza with everything on the side';
    const descriptions = page.getByTestId('pizza-deal-description');
    await expect(descriptions.filter({ hasText: combo.description as string })).toHaveCount(1);

    const edited = sampleMenu();
    (edited.sizes as { pizza: { id: string; price: number }[] }).pizza.find(
      (size) => size.id === 'large',
    )!.price = LARGE + 2;
    edited.categories
      .find((category) => category.id === 'deals')!
      .items.find((deal) => deal.id === 'large-combo')!.description = WORDS;
    // The product list that goes with the new menu is slow to answer.
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === '/api/products',
      async (route) => {
        await slow;
        await route.continue();
      },
    );
    try {
      await loadSampleMenu(request, edited);
      // A refresh asks at most every 30 seconds, so the till's clock moves on a minute.
      await page.clock.setFixedTime(Date.now() + 60_000);
      const asked = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/pizza/catalog',
      );
      const listsAsked = page.waitForRequest(
        (sent) => new URL(sent.url()).pathname === '/api/products',
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await asked;
      await listsAsked;

      // The new menu has answered and its products have not: the till stays on the old pair.
      await page.waitForTimeout(500);
      await expect(descriptions.filter({ hasText: WORDS })).toHaveCount(0);
      await expect(large).toContainText(money(LARGE));
      release();
      await expect(descriptions.filter({ hasText: WORDS })).toHaveCount(1);
      await expect(large).toContainText(money(LARGE + 2));
      await tile(page, 'Garden').getByRole('button', { name: 'Customize Garden' }).click();
      const sheet = sheetOf(page);
      const size = sheet
        .getByRole('group', { name: 'Size' })
        .getByRole('button', { name: /Large/ });
      await expect(size).toContainText(money(LARGE + 2));
      await size.click();
      await sheet.getByRole('button', { name: /^Add to order/ }).click();
      await expect(cartLines(page).first()).toContainText(money(LARGE + 2));
    } finally {
      await loadSampleMenu(request);
    }
  });

  test('an online order with a platform quotes the online price in the sheet, and the cart agrees', async ({
    page,
    request,
  }) => {
    const ONLINE = LARGE + 4;
    const product = `${BASE}/api/products/pz-garden`;
    const stored = (await (await request.get(product, { headers: ownerHeaders })).json())
      .product as { variants: { id: string; name: string; price: number; sort_order: number }[] };
    /** The product's sizes as they are, with this online price on Large. */
    const priced = (online: number | null) =>
      request.put(product, {
        headers: ownerHeaders,
        data: {
          variants: stored.variants.map(({ id, name, price, sort_order }) => ({
            id,
            name,
            price,
            sort_order,
            online_price: id === 'pz-garden-large' ? online : null,
          })),
        },
      });
    try {
      expect((await priced(ONLINE)).status(), 'Large gets an online price').toBe(200);
      await page.reload();
      await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
      await page.getByRole('button', { name: 'Online' }).click();
      await page.getByTestId('pos-order-details-edit-btn').click();
      await page.getByTestId('pos-online-platform-input').fill('Example Eats');
      await page.getByTestId('pos-order-details-done-btn').click();

      // The size button of the tile quotes the same price, to the eye and to a screen reader.
      const tileLarge = tile(page, 'Garden').getByRole('button', { name: /Large/ });
      await expect(tileLarge).toContainText(money(ONLINE));
      await expect(tileLarge).toHaveAccessibleName(money(ONLINE));

      await tile(page, 'Garden').getByRole('button', { name: 'Customize Garden' }).click();
      const sheet = sheetOf(page);
      const size = sheet
        .getByRole('group', { name: 'Size' })
        .getByRole('button', { name: /Large/ });
      await expect(size).toContainText(money(ONLINE));
      await size.click();
      await sheet.getByRole('button', { name: 'One more Garlic' }).click();
      const add = sheet.getByRole('button', { name: /^Add to order/ });
      await expect(add).toContainText(money(ONLINE + DIP));
      await add.click();
      await expect(sheet).toBeHidden();

      const line = cartLines(page).first();
      await expect(line).toContainText(money(ONLINE + DIP));
      await line.getByRole('button', { name: 'Edit' }).click();
      await expect(sheetOf(page).getByRole('button', { name: /^Save/ })).toContainText(
        money(ONLINE + DIP),
      );
    } finally {
      await priced(null);
    }
  });

  test('categories are blocks and one tap on Large adds a plain large pizza', async ({ page }) => {
    await expect(page.getByTestId('pos-category-row')).toHaveCount(0);
    const blocks = page.getByTestId('pizza-category-blocks');
    await expect(blocks.getByRole('button', { name: 'Pizzas' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('pizza-tile')).toHaveCount(itemsOf('pizzas').length);

    await tile(page, 'Garden').getByRole('button', { name: /Large/ }).click();
    await expect(cartLines(page)).toHaveCount(1);
    const line = cartLines(page).first();
    await expect(line).toContainText('Garden (Large)');
    await expect(line).toContainText(money(LARGE));
    await expect(quantity(line)).toHaveText('1');
    await expect(details(line)).toHaveCount(0);
    await expect(sheetOf(page)).toHaveCount(0);

    await blocks.getByRole('button', { name: 'Sides' }).click();
    await expect(page.getByTestId('pizza-tile')).toHaveCount(0);
    await expect(page.getByTestId('pos-product-card').first()).toBeVisible();
  });

  test('half and half with one removal and a dip', async ({ page }) => {
    const sheet = await buildHalfAndHalf(page);
    await expect(
      sheet.getByRole('group', { name: '1st half' }).getByRole('button', { name: 'NO Olives' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'One more Garlic' }).click();

    await expect(sheet.getByTestId('pizza-prints-line')).toHaveText([
      'LARGE HALF & HALF',
      '1ST: GARDEN',
      'NO OLIVES',
      '2ND: CLASSIC PEPPERONI',
    ]);
    const add = sheet.getByRole('button', { name: /^Add to order/ });
    await expect(add).toContainText(money(LARGE + DIP));
    await add.click();
    await expect(sheet).toBeHidden();

    const line = cartLines(page).first();
    await expect(line).toContainText('Half & Half (Large)');
    await expect(line).toContainText(money(LARGE + DIP));
    await expect(line).toContainText('Garlic');
    await expect(details(line)).toHaveText(['1ST: GARDEN', 'NO OLIVES', '2ND: CLASSIC PEPPERONI']);
  });

  test('identical halves switch Add off with the message', async ({ page }) => {
    await halfTile(page).getByRole('button', { name: /Large/ }).click();
    const sheet = sheetOf(page);
    const add = sheet.getByRole('button', { name: /^Add to order/ });
    await expect(add).toBeDisabled();
    await expect(sheet.getByTestId('pizza-sheet-message')).toHaveText('Pick the first half');
    await expect(add).toHaveAccessibleDescription('Pick the first half');

    await sheet
      .getByRole('group', { name: '1st half' })
      .getByRole('button', { name: 'Garden' })
      .click();
    const second = sheet.getByRole('group', { name: '2nd half' });
    await second.getByRole('button', { name: 'Garden' }).click();
    await expect(add).toBeDisabled();
    await expect(sheet.getByTestId('pizza-sheet-message')).toHaveText(
      'Both halves are the same. Choose a whole pizza instead',
    );

    await second.getByRole('button', { name: 'Olives', exact: true }).click();
    await expect(add).toBeEnabled();
    await expect(sheet.getByTestId('pizza-sheet-message')).toHaveText('');
    await expect(sheet.getByTestId('pizza-sheet-message')).toHaveRole('status');
    await expect(add).toHaveAccessibleDescription('');
  });

  test('"Customize 1" splits a 2x line, and closing the sheet puts it back', async ({ page }) => {
    const large = tile(page, 'Garden').getByRole('button', { name: /Large/ });
    await large.click();
    await large.click();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(quantity(cartLines(page).first())).toHaveText('2');

    await cartLines(page).first().getByRole('button', { name: 'Customize 1' }).click();
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(quantity(cartLines(page).first())).toHaveText('2');
    // The button that opened the sheet went with the split, so the line's Edit takes the focus.
    await expect(cartLines(page).first().getByRole('button', { name: 'Edit' })).toBeFocused();

    await cartLines(page).first().getByRole('button', { name: 'Customize 1' }).click();
    await expect(
      sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Large/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'Olives', exact: true }).click();
    await sheet.getByRole('button', { name: /^Save/ }).click();
    await expect(sheet).toBeHidden();

    await expect(cartLines(page)).toHaveCount(2);
    await expect(quantity(cartLines(page).nth(0))).toHaveText('1');
    await expect(details(cartLines(page).nth(0))).toHaveCount(0);
    await expect(quantity(cartLines(page).nth(1))).toHaveText('1');
    await expect(details(cartLines(page).nth(1))).toHaveText(['NO OLIVES']);
    await expect(cartLines(page).nth(1).getByRole('button', { name: 'Edit' })).toBeFocused();
    await expect(cartLines(page).nth(1).getByRole('button', { name: 'Customize 1' })).toHaveCount(
      0,
    );
  });

  test('editing a line until it equals another merges the two', async ({ page }) => {
    await tile(page, 'Garden').getByRole('button', { name: /Large/ }).click();
    await addGardenNoOlives(page);
    await expect(cartLines(page)).toHaveCount(2);

    await cartLines(page).nth(1).getByRole('button', { name: 'Edit' }).click();
    const sheet = sheetOf(page);
    // Off, then extra, then back on the pizza as it comes.
    await sheet.getByRole('button', { name: 'NO Olives' }).click();
    await sheet.getByRole('button', { name: /^EXTRA Olives/ }).click();
    await sheet.getByRole('button', { name: /^Save/ }).click();
    await expect(sheet).toBeHidden();

    await expect(cartLines(page)).toHaveCount(1);
    await expect(quantity(cartLines(page).first())).toHaveText('2');
    await expect(details(cartLines(page).first())).toHaveCount(0);
    await expect(cartLines(page).first().getByRole('button', { name: 'Edit' })).toBeFocused();
  });

  test('leaving the POS with a "Customize 1" sheet open puts the line back', async ({ page }) => {
    // The cart outlives the POS page only across navigation inside the app.
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL(/\/orders/);
    await page.getByRole('link', { name: 'POS', exact: true }).click();
    await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();

    const large = tile(page, 'Garden').getByRole('button', { name: /Large/ });
    await large.click();
    await large.click();
    await cartLines(page).first().getByRole('button', { name: 'Customize 1' }).click();
    await expect(sheetOf(page)).toBeVisible();
    await expect(cartLines(page)).toHaveCount(2);

    await page.goBack();
    await page.waitForURL(/\/orders/);
    await expect(page.getByTestId('pos-product-grid')).toHaveCount(0);
    await page.getByRole('link', { name: 'POS', exact: true }).click();
    await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(cartLines(page)).toHaveCount(1);
    await expect(quantity(cartLines(page).first())).toHaveText('2');
  });

  test('an order paid in cash stores each recipe the sheet built', async ({ page }) => {
    await tile(page, 'Garden').getByRole('button', { name: /Large/ }).click();

    await tile(page, 'Island').getByRole('button', { name: 'Customize Island' }).click();
    const sheet = sheetOf(page);
    await sheet
      .getByRole('group', { name: 'Size' })
      .getByRole('button', { name: /Medium/ })
      .click();
    await sheet.getByRole('button', { name: 'Pineapple', exact: true }).click();
    await sheet
      .getByRole('group', { name: 'Cook' })
      .getByRole('button', { name: 'Well done' })
      .click();
    await sheet
      .getByRole('group', { name: 'Cut' })
      .getByRole('button', { name: 'Square cut' })
      .click();
    await sheet.getByRole('button', { name: /^Add to order/ }).click();
    await expect(sheet).toBeHidden();

    await buildHalfAndHalf(page);
    await sheet.getByRole('button', { name: 'One more Garlic' }).click();
    await sheet.getByRole('button', { name: /^Add to order/ }).click();
    await expect(sheet).toBeHidden();
    await expect(cartLines(page)).toHaveCount(3);

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/orders',
    );
    const paid = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /^\/api\/bills\/[^/]+\/payments$/.test(new URL(response.url()).pathname),
    );
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('F4');
    const checkout = page.getByTestId('prepaid-checkout-modal');
    await expect(checkout.getByText(/Total Due/i)).toBeVisible();
    await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
    await checkout.getByRole('button', { name: /Confirm Payment/ }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const orderId = (await response.json()).order.id;
    const payment = await paid;
    expect(
      payment
        .request()
        .postDataJSON()
        .payments.map((line: { method: string }) => line.method),
    ).toEqual(['cash']);
    expect((await payment.json()).bill.payment_status).toBe('paid');
    await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
    await expect(checkout).toBeHidden({ timeout: 15_000 });

    const read = await page.request.get(`${BASE}/api/orders/${orderId}`, { headers: ownerHeaders });
    expect(read.ok()).toBeTruthy();
    const { order } = await read.json();
    const stored = Object.fromEntries(
      order.items.map((item: { product_id: string; modifier_selection: unknown }) => [
        item.product_id,
        typeof item.modifier_selection === 'string'
          ? JSON.parse(item.modifier_selection)
          : item.modifier_selection,
      ]),
    );
    expect(stored).toEqual({
      'pz-garden': null,
      'pz-island': {
        kind: 'pizza',
        v: 1,
        sizeId: 'medium',
        whole: { pizzaId: 'island', removed: ['Pineapple'] },
        cook: 'well-done',
        cut: 'square-cut',
      },
      'pz-half-and-half': {
        kind: 'pizza',
        v: 1,
        sizeId: 'large',
        halves: [
          { pizzaId: 'garden', removed: ['Olives'] },
          { pizzaId: 'classic', removed: [] },
        ],
      },
    });
    const half = order.items.find(
      (item: { product_id: string }) => item.product_id === 'pz-half-and-half',
    );
    expect(half.variant_id).toBe('pz-half-and-half-large');
    expect(JSON.stringify(half)).toContain('ad-dips-garlic');
  });

  test('the sheet works with the keyboard only', async ({ page }) => {
    const sheet = sheetOf(page);
    /** Tabs forward until `target` has the focus; the focus never leaves the dialog. */
    const tabTo = async (target: Locator) => {
      for (let presses = 0; presses < 80; presses += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
        expect(
          await sheet.evaluate((dialog) => dialog.contains(document.activeElement)),
          'the focus stays inside the dialog',
        ).toBe(true);
      }
      throw new Error('Tab never reached the control');
    };

    const customize = tile(page, 'Island').getByRole('button', { name: 'Customize Island' });
    await customize.focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(cartLines(page)).toHaveCount(0);
    await expect(customize).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    const add = sheet.getByRole('button', { name: /^Add to order/ });
    await expect(add).toBeDisabled();

    await tabTo(sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Medium/ }));
    await page.keyboard.press('Space');
    await tabTo(sheet.getByRole('button', { name: 'Pineapple', exact: true }));
    await page.keyboard.press('Enter');
    await expect(sheet.getByRole('button', { name: 'NO Pineapple' })).toBeFocused();
    await tabTo(
      sheet.getByRole('group', { name: 'Cook' }).getByRole('button', { name: 'Well done' }),
    );
    await page.keyboard.press('Space');
    await tabTo(sheet.getByRole('button', { name: 'One more Ranch' }));
    await page.keyboard.press('Enter');
    await tabTo(sheet.getByLabel('Note for the kitchen'));
    await page.keyboard.type('Extra napkins');
    await tabTo(sheet.getByRole('button', { name: 'One more pizza' }));
    await page.keyboard.press('Enter');
    await tabTo(add);
    await expect(add).toContainText(money((sizePrice('medium') + DIP) * 2));
    await page.keyboard.press('Enter');
    await expect(sheet).toBeHidden();

    const line = cartLines(page).first();
    await expect(line).toContainText('Island (Medium)');
    await expect(line).toContainText('Extra napkins');
    await expect(quantity(line)).toHaveText('2');
    await expect(details(line)).toHaveText(['NO PINEAPPLE', 'WELL DONE']);
  });

  test('at iPad landscape nothing overflows and every pizza control is 48 px', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const tooSmall = (scope: Locator) =>
      scope.locator('button, input').evaluateAll((controls) =>
        controls
          .map((control) => ({ control, box: control.getBoundingClientRect() }))
          .filter(({ box }) => box.width < 48 || box.height < 48)
          .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
      );

    await addGardenNoOlives(page, async (whole) => {
      expect(await tooSmall(whole)).toEqual([]);
      await shot(page, 'pizza-sheet-whole.png');
    });
    await cartLines(page).first().getByRole('button', { name: 'One more' }).click();
    await buildHalfAndHalf(page);
    const sheet = sheetOf(page);
    await sheet.getByRole('button', { name: 'One more Garlic' }).click();

    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1180);
    expect(box.y + box.height).toBeLessThanOrEqual(820);
    expect(await tooSmall(sheet)).toEqual([]);
    expect(
      await sheet.evaluate((dialog) =>
        [...dialog.querySelectorAll('*')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent),
      ),
      'no text in the sheet is clipped sideways',
    ).toEqual([]);
    await shot(page, 'pizza-sheet.png');

    await sheet.getByRole('button', { name: /^Add to order/ }).click();
    await expect(sheet).toBeHidden();
    await expect(cartLines(page)).toHaveCount(2);
    await expect(quantity(cartLines(page).first())).toHaveText('2');
    expect(await tooSmall(page.getByTestId('pizza-category-blocks'))).toEqual([]);
    expect(await tooSmall(page.getByTestId('pizza-tile'))).toEqual([]);
    expect(await tooSmall(halfTile(page))).toEqual([]);
    expect(await tooSmall(page.getByTestId('pizza-line-actions'))).toEqual([]);
    expect(
      await page
        .getByTestId('pizza-tile')
        .evaluateAll((tiles) => tiles.filter((tile) => tile.scrollWidth > tile.clientWidth).length),
      'no pizza tile overflows sideways',
    ).toBe(0);
    await shot(page, 'pos-home.png');
  });
});
