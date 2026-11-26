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
 * Extra and added toppings on the pizza sheet and in the deal configurator,
 * against the made-up sample menu at iPad landscape. Every spec shares one
 * database, so this one loads the menu itself and clears it when it ends.
 */

const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };

const menu = sampleMenu();
const LARGE = (menu.sizes as { pizza: { id: string; price: number }[] }).pizza.find(
  (size) => size.id === 'large',
)!.price;
const TOPPING = (menu.toppings as { price: number }).price;
const THREE = menu.categories
  .find((category) => category.id === 'deals')!
  .items.find((deal) => deal.id === 'three-large-wings')! as unknown as {
  name: string;
  price: number;
};
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '\\.'));
/** What the menu load made half a topping cost; read from the POS, never worked out here. */
let HALF = 0;

/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext();
  await loadSampleMenu(api);
  const { products } = await (
    await api.get(`${BASE}/api/products`, { headers: ownerHeaders })
  ).json();
  const addons = products
    .find((product: { id: string }) => product.id === 'pz-half-and-half')
    .addon_groups.flatMap((group: { addons: { id: string; price: number }[] }) => group.addons);
  expect(
    Number(addons.find((addon: { id: string }) => addon.id === 'ad-topping').price),
    'a topping is sold at the price in the menu file',
  ).toBe(TOPPING);
  HALF = Number(addons.find((addon: { id: string }) => addon.id === 'ad-topping-half').price);
  expect(HALF, 'half a topping costs less than one, and more than nothing').toBeGreaterThan(0);
  expect(HALF).toBeLessThan(TOPPING);
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
  await page.setViewportSize({ width: 1180, height: 820 });
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
  await page.getByRole('button', { name: 'Takeaway' }).click();
}

const tile = (page: Page, name: string): Locator =>
  page.getByTestId('pizza-tile').filter({ has: page.getByRole('heading', { name, exact: true }) });
const sheetOf = (page: Page): Locator => page.getByRole('dialog', { name: 'Pizza' });
const cartLines = (page: Page): Locator => page.getByTestId('cart-item');
const details = (line: Locator): Locator => line.getByTestId('pizza-line-detail');
const printsAs = (sheet: Locator): Locator => sheet.getByTestId('pizza-prints-line');
const priceLines = (scope: Locator): Locator => scope.getByTestId('pizza-topping-price');
const half = (sheet: Locator, which: '1st' | '2nd'): Locator =>
  sheet.getByRole('group', { name: `${which} half` });
const addTopping = (scope: Locator): Locator =>
  scope.getByRole('button', { name: 'Add a topping' });
const toppingList = (scope: Locator): Locator => scope.getByRole('group', { name: 'Toppings' });
/** An ingredient chip in one of its three states, by the words it reads. */
const chip = (scope: Locator, name: string, state: 'normal' | 'NO' | 'EXTRA'): Locator =>
  state === 'normal'
    ? scope.getByRole('button', { name, exact: true })
    : scope.getByRole('button', { name: new RegExp(`^${state} ${name}`) });
const addedChip = (scope: Locator, name: string): Locator =>
  scope.getByTestId('pizza-added-topping').filter({ hasText: name });
const addToOrder = (sheet: Locator): Locator =>
  sheet.getByRole('button', { name: /^Add to order/ });

/** The sheet on a large Garden, opened from its tile. */
async function openLargeGarden(page: Page): Promise<Locator> {
  await tile(page, 'Garden').getByRole('button', { name: 'Customize Garden' }).click();
  const sheet = sheetOf(page);
  await sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Large/ }).click();
  return sheet;
}

/** A large half and half of Garden and Classic Pepperoni, left open with nothing changed. */
async function openHalfAndHalf(page: Page, second = 'Classic Pepperoni'): Promise<Locator> {
  await page.getByTestId('pizza-half-tile').getByRole('button', { name: /Large/ }).click();
  const sheet = sheetOf(page);
  await half(sheet, '1st').getByRole('button', { name: 'Garden' }).click();
  await half(sheet, '2nd').getByRole('button', { name: second }).click();
  return sheet;
}

/** Extra olives and bacon on the first half, extra pepperoni and feta on the second. */
async function oneOfEachOnBothHalves(sheet: Locator): Promise<void> {
  const first = half(sheet, '1st');
  const second = half(sheet, '2nd');
  await chip(first, 'Olives', 'normal').click();
  await chip(first, 'Olives', 'NO').click();
  await addTopping(first).click();
  await toppingList(first).getByRole('button', { name: 'Bacon' }).click();
  await addTopping(first).click();
  await chip(second, 'Pepperoni', 'normal').click();
  await chip(second, 'Pepperoni', 'NO').click();
  await addTopping(second).click();
  await toppingList(second).getByRole('button', { name: 'Feta' }).click();
  await addTopping(second).click();
}

const BOTH_HALVES_LINES = [
  '1ST: GARDEN',
  'EXTRA OLIVES',
  'ADD BACON',
  '2ND: CLASSIC PEPPERONI',
  'EXTRA PEPPERONI',
  'ADD FETA',
];
const BOTH_HALVES_RECIPE = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'garden', removed: [], extra: ['Olives'], added: ['bacon'] },
    { pizzaId: 'classic', removed: [], extra: ['Pepperoni'], added: ['feta'] },
  ],
};

/** Pays the order in the cart in cash and answers it as the server stores it. */
async function payInCash(page: Page) {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/orders',
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
  expect((await (await paid).json()).bill.payment_status).toBe('paid');
  await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
  await expect(checkout).toBeHidden({ timeout: 15_000 });
  const read = await page.request.get(`${BASE}/api/orders/${orderId}`, { headers: ownerHeaders });
  expect(read.ok()).toBeTruthy();
  return (await read.json()).order;
}

test.describe('toppings on a pizza', () => {
  test.beforeEach(async ({ page }) => {
    await openPos(page);
  });

  test('a second tap on an ingredient reads EXTRA and a third puts it back', async ({ page }) => {
    const sheet = await openLargeGarden(page);
    await expect(sheet.getByText('Ingredients: tap for NO, tap again for EXTRA')).toBeVisible();
    await expect(chip(sheet, 'Olives', 'normal')).toHaveAttribute('aria-pressed', 'false');

    await chip(sheet, 'Olives', 'normal').click();
    await expect(chip(sheet, 'Olives', 'NO')).toHaveAttribute('aria-pressed', 'true');
    await expect(printsAs(sheet)).toHaveText(['LARGE GARDEN', 'NO OLIVES']);
    await expect(priceLines(sheet)).toHaveCount(0);
    await expect(addToOrder(sheet)).toContainText(money(LARGE));

    await chip(sheet, 'Olives', 'NO').click();
    const extra = chip(sheet, 'Olives', 'EXTRA');
    await expect(extra).toHaveAttribute('aria-pressed', 'true');
    await expect(extra, 'the chip reads its price').toContainText(money(TOPPING));
    await expect(extra.locator('s'), 'an extra is not struck through').toHaveCount(0);
    await expect(printsAs(sheet)).toHaveText(['LARGE GARDEN', 'EXTRA OLIVES']);
    await expect(priceLines(sheet)).toHaveText([new RegExp(`^1 topping.*${TOPPING.toFixed(2)}`)]);
    await expect(addToOrder(sheet)).toContainText(money(LARGE + TOPPING));

    await extra.click();
    await expect(chip(sheet, 'Olives', 'normal')).toHaveAttribute('aria-pressed', 'false');
    await expect(printsAs(sheet)).toHaveText(['LARGE GARDEN']);
    await expect(priceLines(sheet)).toHaveCount(0);
    await expect(addToOrder(sheet)).toContainText(money(LARGE));
  });

  test('Add lists the toppings; one goes on one half only, comes off, and goes on again', async ({
    page,
  }) => {
    const sheet = await openHalfAndHalf(page);
    const first = half(sheet, '1st');
    const second = half(sheet, '2nd');
    await expect(toppingList(sheet)).toHaveCount(0);

    await addTopping(first).click();
    await expect(addTopping(first)).toHaveAttribute('aria-expanded', 'true');
    await expect(toppingList(first).getByRole('button')).toHaveText([
      'Bacon',
      'Feta',
      'Spinach',
      'Tomatoes',
      'Banana Peppers',
      'Anchovies',
      'Artichokes',
    ]);
    await expect(
      toppingList(first).getByRole('button', { name: 'Mushrooms' }),
      'Garden already has mushrooms, so they are not offered',
    ).toHaveCount(0);
    await addTopping(second).click();
    await expect(
      toppingList(second).getByRole('button', { name: 'Mushrooms' }),
      'Classic Pepperoni has none, so they are',
    ).toBeVisible();
    await addTopping(second).click();
    await expect(toppingList(second)).toHaveCount(0);

    const bacon = toppingList(first).getByRole('button', { name: 'Bacon' });
    await bacon.click();
    await expect(bacon).toHaveAttribute('aria-pressed', 'true');
    await expect(addedChip(first, 'Bacon')).toContainText(/^ADD\s*Bacon/);
    await expect(addedChip(first, 'Bacon'), 'the chip reads its price').toContainText(money(HALF));
    await expect(second.getByTestId('pizza-added-topping')).toHaveCount(0);
    const withBacon = ['LARGE HALF & HALF', '1ST: GARDEN', 'ADD BACON', '2ND: CLASSIC PEPPERONI'];
    await expect(printsAs(sheet)).toHaveText(withBacon);
    await expect(priceLines(sheet)).toHaveText([new RegExp(`^1 half topping.*${HALF.toFixed(2)}`)]);
    await expect(addToOrder(sheet)).toContainText(money(LARGE + HALF));

    await addedChip(first, 'Bacon').click();
    await expect(first.getByTestId('pizza-added-topping')).toHaveCount(0);
    await expect(addTopping(first), 'the focus goes to Add').toBeFocused();
    await expect(bacon).toHaveAttribute('aria-pressed', 'false');
    await expect(printsAs(sheet)).toHaveText([
      'LARGE HALF & HALF',
      '1ST: GARDEN',
      '2ND: CLASSIC PEPPERONI',
    ]);
    await expect(priceLines(sheet)).toHaveCount(0);
    await expect(addToOrder(sheet)).toContainText(money(LARGE));

    await bacon.click();
    await expect(addedChip(first, 'Bacon')).toBeVisible();
    await expect(printsAs(sheet)).toHaveText(withBacon);

    await addToOrder(sheet).click();
    await expect(sheet).toBeHidden();
    const line = cartLines(page).first();
    await expect(details(line)).toHaveText(withBacon.slice(1));
    await expect(line).toContainText(money(LARGE + HALF));
    await shot(page, 'toppings-cart-line.png');
  });

  test('an order paid in cash stores the recipe and the menu price', async ({ page }) => {
    const sheet = await openHalfAndHalf(page);
    await oneOfEachOnBothHalves(sheet);
    await expect(printsAs(sheet)).toHaveText(['LARGE HALF & HALF', ...BOTH_HALVES_LINES]);
    await expect(priceLines(sheet)).toHaveText([/^4 half toppings/]);
    await addToOrder(sheet).click();
    await expect(sheet).toBeHidden();
    await expect(details(cartLines(page).first())).toHaveText(BOTH_HALVES_LINES);

    const order = await payInCash(page);
    expect(order.items).toHaveLength(1);
    const [item] = order.items;
    expect(item.product_id).toBe('pz-half-and-half');
    expect(Number(item.unit_price), 'the pizza is at its size price').toBe(LARGE);
    expect(
      typeof item.modifier_selection === 'string'
        ? JSON.parse(item.modifier_selection)
        : item.modifier_selection,
    ).toEqual(BOTH_HALVES_RECIPE);
    expect(
      item.addons.map((addon: { id: string; price: number; quantity: number }) => [
        addon.id,
        Number(addon.price),
        addon.quantity,
      ]),
      'four half toppings at the price the menu load gave them',
    ).toEqual([['ad-topping-half', HALF, 4]]);
    expect(Number(item.subtotal).toFixed(2)).toBe((LARGE + 4 * HALF).toFixed(2));
  });

  test('a line reopened from the cart shows the same chips', async ({ page }) => {
    const sheet = await openHalfAndHalf(page);
    await oneOfEachOnBothHalves(sheet);
    await addToOrder(sheet).click();
    await expect(sheet).toBeHidden();

    await cartLines(page).first().getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(sheet).toBeVisible();
    const first = half(sheet, '1st');
    const second = half(sheet, '2nd');
    await expect(chip(first, 'Olives', 'EXTRA')).toBeVisible();
    await expect(chip(first, 'Onions', 'normal')).toHaveAttribute('aria-pressed', 'false');
    await expect(first.getByTestId('pizza-added-topping')).toHaveText([/^ADD\s*Bacon/]);
    await expect(chip(second, 'Pepperoni', 'EXTRA')).toBeVisible();
    await expect(second.getByTestId('pizza-added-topping')).toHaveText([/^ADD\s*Feta/]);
    await expect(printsAs(sheet)).toHaveText(['LARGE HALF & HALF', ...BOTH_HALVES_LINES]);

    await sheet.getByRole('button', { name: /^Save/ }).click();
    await expect(sheet).toBeHidden();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(details(cartLines(page).first())).toHaveText(BOTH_HALVES_LINES);
    await expect(cartLines(page).first()).toContainText(money(LARGE + 4 * HALF));
  });

  test('a pizza inside a deal gets an extra and a topping, charged on the deal', async ({
    page,
  }) => {
    await page.getByTestId('pizza-category-blocks').getByRole('button', { name: 'Deals' }).click();
    await page.getByTestId('pos-product-card').filter({ hasText: THREE.name }).click();
    const dialog = page.getByRole('dialog', { name: THREE.name });
    const panel = dialog.getByRole('tabpanel');
    const whole = panel.getByRole('group', { name: 'Whole pizza' });

    await whole.getByRole('button', { name: 'Garden' }).click();
    await chip(panel, 'Olives', 'normal').click();
    await chip(panel, 'Olives', 'NO').click();
    await expect(chip(panel, 'Olives', 'EXTRA')).toContainText(money(TOPPING));
    await addTopping(panel).click();
    await toppingList(panel).getByRole('button', { name: 'Bacon' }).click();
    await expect(dialog.getByRole('tab', { name: 'Pizza 1' })).toContainText(
      'Garden · EXTRA OLIVES · ADD BACON',
    );
    await expect(dialog.getByTestId('deal-summary-line')).toContainText([
      '1) LARGE GARDEN',
      'EXTRA OLIVES',
      'ADD BACON',
    ]);
    await expect(priceLines(dialog)).toHaveText([
      new RegExp(`^2 toppings.*${(2 * TOPPING).toFixed(2)}`),
    ]);
    await shot(page, 'toppings-deal.png');

    await dialog.getByRole('button', { name: 'Next: Pizza 2' }).click();
    await whole.getByRole('button', { name: 'Island' }).click();
    await dialog.getByRole('button', { name: 'Next: Pizza 3' }).click();
    await whole.getByRole('button', { name: 'Classic Pepperoni' }).click();
    await dialog.getByRole('button', { name: 'Next: Wing flavour' }).click();
    await panel.getByRole('button', { name: 'Hot' }).click();
    const add = dialog.getByTestId('deal-add');
    await expect(add).toContainText(money(THREE.price + 2 * TOPPING));
    await add.click();
    await expect(dialog).toBeHidden();

    const line = cartLines(page).first();
    await expect(details(line)).toContainText(['1) LARGE GARDEN', 'EXTRA OLIVES', 'ADD BACON']);
    await expect(line).toContainText(money(THREE.price + 2 * TOPPING));
    const order = await payInCash(page);
    const [item] = order.items;
    expect(Number(item.unit_price), 'the deal is at its price').toBe(THREE.price);
    expect(
      item.addons.map((addon: { id: string; quantity: number }) => [addon.id, addon.quantity]),
    ).toEqual([['ad-topping', 2]]);
  });

  test('an extra and a topping the menu has dropped still show on a reopened line and come off', async ({
    page,
    request,
  }) => {
    const sheet = await openLargeGarden(page);
    await chip(sheet, 'Olives', 'normal').click();
    await chip(sheet, 'Olives', 'NO').click();
    await addTopping(sheet).click();
    await toppingList(sheet).getByRole('button', { name: 'Bacon' }).click();
    await addToOrder(sheet).click();
    await expect(sheet).toBeHidden();
    await expect(details(cartLines(page).first())).toHaveText(['EXTRA OLIVES', 'ADD BACON']);

    const without = sampleMenu();
    delete without.toppings;
    try {
      await loadSampleMenu(request, without);
      // A refresh asks at most every 30 seconds, so the till's clock moves on a minute.
      await page.clock.setFixedTime(Date.now() + 60_000);
      // The sheet opens on the menu held; it is reopened until that is the menu without toppings.
      await expect(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await cartLines(page).first().getByRole('button', { name: 'Edit', exact: true }).click();
        try {
          await expect(addTopping(sheet)).toHaveCount(0, { timeout: 1000 });
        } catch (error) {
          await page.keyboard.press('Escape');
          await expect(sheet).toBeHidden();
          throw error;
        }
      }).toPass({ timeout: 20_000 });

      // The line still has both, and the menu has a price for neither.
      const save = sheet.getByRole('button', { name: /^Save/ });
      const message = sheet.getByTestId('pizza-sheet-message');
      const bacon = addedChip(sheet, 'bacon');
      await expect(chip(sheet, 'Olives', 'EXTRA')).toBeVisible();
      await expect(bacon, 'a topping the menu no longer names shows by its id').toContainText(
        /^ADD\s*bacon/,
      );
      await expect(save).toBeDisabled();
      await expect(message).toContainText('This menu has no price for extra Olives');
      await shot(page, 'toppings-dropped-from-menu.png');

      await chip(sheet, 'Olives', 'EXTRA').click();
      await expect(chip(sheet, 'Olives', 'normal')).toHaveAttribute('aria-pressed', 'false');
      await expect(save).toBeDisabled();
      await expect(message).toContainText('That topping is not on the menu');
      await bacon.click();
      await expect(sheet.getByTestId('pizza-added-topping')).toHaveCount(0);
      await expect(message).toBeEmpty();
      await expect(printsAs(sheet)).toHaveText(['LARGE GARDEN']);
      await expect(save).toBeEnabled();
      await save.click();
      await expect(sheet).toBeHidden();
      await expect(details(cartLines(page).first())).toHaveCount(0);
      await expect(cartLines(page).first()).toContainText(money(LARGE));
    } finally {
      await loadSampleMenu(request);
    }
  });

  test('the chips and the list work with the keyboard only', async ({ page }) => {
    const sheet = sheetOf(page);
    /** Tabs until `target` has the focus, backwards when asked; the focus never leaves the dialog. */
    const tabTo = async (target: Locator, key = 'Tab') => {
      for (let presses = 0; presses < 80; presses += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press(key);
        expect(
          await sheet.evaluate((dialog) => dialog.contains(document.activeElement)),
          'the focus stays inside the dialog',
        ).toBe(true);
      }
      throw new Error('Tab never reached the control');
    };

    await tile(page, 'Island').getByRole('button', { name: 'Customize Island' }).focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await tabTo(sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Large/ }));
    await page.keyboard.press('Space');

    await tabTo(chip(sheet, 'Pineapple', 'normal'));
    await page.keyboard.press('Enter');
    await expect(chip(sheet, 'Pineapple', 'NO')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chip(sheet, 'Pineapple', 'EXTRA')).toBeFocused();

    await tabTo(addTopping(sheet));
    await page.keyboard.press('Enter');
    const bacon = toppingList(sheet).getByRole('button', { name: 'Bacon' });
    await tabTo(bacon);
    await page.keyboard.press('Space');
    await expect(bacon).toBeFocused();
    await expect(bacon).toHaveAttribute('aria-pressed', 'true');
    await expect(printsAs(sheet)).toHaveText(['LARGE ISLAND', 'EXTRA PINEAPPLE', 'ADD BACON']);

    // The chip takes the topping off and hands the focus to Add; the list puts it on again.
    await tabTo(addedChip(sheet, 'Bacon'), 'Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(sheet.getByTestId('pizza-added-topping')).toHaveCount(0);
    await expect(addTopping(sheet)).toBeFocused();
    await tabTo(bacon);
    await page.keyboard.press('Enter');
    await expect(addedChip(sheet, 'Bacon')).toBeVisible();

    await tabTo(addToOrder(sheet));
    await expect(addToOrder(sheet)).toContainText(money(LARGE + 2 * TOPPING));
    await page.keyboard.press('Enter');
    await expect(sheet).toBeHidden();
    await expect(details(cartLines(page).first())).toHaveText(['EXTRA PINEAPPLE', 'ADD BACON']);
  });

  test('every new control is 48 px and the chips stay in view with two toppings on each half', async ({
    page,
  }) => {
    const tooSmall = (scope: Locator) =>
      scope.locator('button, input').evaluateAll((controls) =>
        controls
          .map((control) => ({ control, box: control.getBoundingClientRect() }))
          .filter(({ box }) => box.width < 48 || box.height < 48)
          .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
      );
    /** The controls of `scope` that are not wholly on screen. */
    const offScreen = (scope: Locator) =>
      scope.evaluateAll((controls) =>
        controls
          .filter((control) => {
            const box = control.getBoundingClientRect();
            const body = control
              .closest('[data-testid="pizza-sheet-body"]')!
              .getBoundingClientRect();
            return (
              box.top < body.top || box.bottom > body.bottom || box.left < 0 || box.right > 1180
            );
          })
          .map((control) => control.textContent),
      );

    // Whole pizza: an extra, a removal and two toppings, with the list open.
    const whole = await openLargeGarden(page);
    await chip(whole, 'Olives', 'normal').click();
    await chip(whole, 'Olives', 'NO').click();
    await chip(whole, 'Onions', 'normal').click();
    await addTopping(whole).click();
    await toppingList(whole).getByRole('button', { name: 'Bacon' }).click();
    await toppingList(whole).getByRole('button', { name: 'Feta' }).click();
    expect(await tooSmall(whole)).toEqual([]);
    await expect(priceLines(whole)).toHaveText([/^3 toppings/]);
    await shot(page, 'toppings-sheet-whole.png');
    await page.keyboard.press('Escape');
    await expect(whole).toBeHidden();

    // Half and half, both pizzas chosen: an extra and two toppings on each half.
    const sheet = await openHalfAndHalf(page, 'Smokehouse Chicken');
    const first = half(sheet, '1st');
    const second = half(sheet, '2nd');
    for (const [side, ingredient] of [
      [first, 'Olives'],
      [second, 'Cheddar'],
    ] as const) {
      await chip(side, ingredient, 'normal').click();
      await chip(side, ingredient, 'NO').click();
      await addTopping(side).click();
      await toppingList(side).getByRole('button', { name: 'Bacon' }).click();
      await toppingList(side).getByRole('button', { name: 'Feta' }).click();
    }
    await expect(sheet.getByTestId('pizza-added-topping')).toHaveCount(4);
    await expect(priceLines(sheet)).toHaveText([/^6 half toppings/]);

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
    await shot(page, 'toppings-sheet-halves-list-open.png');

    // With the lists closed, as the cashier leaves them, every chip and both Add controls are on screen.
    await addTopping(first).click();
    await addTopping(second).click();
    await expect(toppingList(sheet)).toHaveCount(0);
    await sheet.getByTestId('pizza-sheet-body').evaluate((body) => body.scrollTo(0, 0));
    expect(
      await offScreen(sheet.getByTestId('pizza-sheet-body').locator('section button')),
      'every chip of both halves is on screen without scrolling',
    ).toEqual([]);
    expect(await tooSmall(sheet)).toEqual([]);
    await shot(page, 'toppings-sheet-halves.png');
  });
});

test('a menu with no toppings has no Add control, and a second tap puts the ingredient back', async ({
  page,
}) => {
  const api = await playwrightRequest.newContext();
  const without = sampleMenu();
  delete without.toppings;
  try {
    await loadSampleMenu(api, without);
    await openPos(page);
    const sheet = await openLargeGarden(page);
    await expect(sheet.getByText('Ingredients: tap to remove, no charge')).toBeVisible();
    await expect(addTopping(sheet)).toHaveCount(0);
    await chip(sheet, 'Olives', 'normal').click();
    await expect(chip(sheet, 'Olives', 'NO')).toBeVisible();
    await chip(sheet, 'Olives', 'NO').click();
    await expect(chip(sheet, 'Olives', 'normal')).toHaveAttribute('aria-pressed', 'false');
    await expect(sheet.getByRole('button', { name: /^EXTRA/ })).toHaveCount(0);
    await expect(printsAs(sheet)).toHaveText(['LARGE GARDEN']);
    await shot(page, 'toppings-none-on-menu.png');
  } finally {
    await loadSampleMenu(api);
    await api.dispose();
  }
});
