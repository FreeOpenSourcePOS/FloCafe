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
 * The deal configurator, against the made-up sample menu. Every spec shares
 * one database, so this one loads the menu itself, pays the order it places,
 * and clears the menu when it ends.
 */

const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };

const menu = sampleMenu();
const deals = menu.categories.find((category) => category.id === 'deals')!.items;
const dealOf = (id: string) => {
  const deal = deals.find((entry) => entry.id === id)!;
  return { name: deal.name as string, description: deal.description as string, price: deal.price! };
};
const COMBO = dealOf('large-combo');
const THREE = dealOf('three-large-wings');
const PARTY = dealOf('party');
const PASTA = dealOf('pasta-night');
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '\\.'));

/** Garden without olives, Island and Plain Cheese half and half, Classic Pepperoni, sweet chili wings. */
const THREE_RECIPE = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    { kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 'garden', removed: ['Olives'] } },
    {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'island', removed: [] },
        { pizzaId: 'plain', removed: [] },
      ],
    },
    { kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 'classic', removed: [] } },
  ],
  wingFlavour: 'sweet-chili',
};
const THREE_LINES = [
  '1) LARGE GARDEN',
  'NO OLIVES',
  '2) LARGE HALF & HALF',
  '1ST: ISLAND',
  '2ND: PLAIN CHEESE',
  '3) LARGE CLASSIC PEPPERONI',
  'WINGS: SWEET CHILI',
];
/** What comes with the three-pizza deal: the ticket's last line, as the summary and the narrower cart wrap it. */
const THREE_INCLUDES = ['INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS'];
const THREE_INCLUDES_CART = ['INCLUDES: ANY 3 LARGE PIZZAS', '& 12 WINGS'];
const COMBO_INCLUDES_CART = ['INCLUDES: 1 LARGE PIZZA,', '1 PASTA, 2 POPS,', '1 GARLIC TOAST'];

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

const dealTile = (page: Page, name: string): Locator =>
  page.getByTestId('pos-product-card').filter({ hasText: name });
const cartLines = (page: Page): Locator => page.getByTestId('cart-item');
const details = (line: Locator): Locator => line.getByTestId('pizza-line-detail');
const tabs = (dialog: Locator): Locator => dialog.getByRole('tab');
const tab = (dialog: Locator, name: string): Locator => dialog.getByRole('tab', { name });
const panel = (dialog: Locator): Locator => dialog.getByRole('tabpanel');
const summary = (dialog: Locator): Locator => dialog.getByTestId('deal-summary-line');
const missingBox = (dialog: Locator): Locator => dialog.getByTestId('deal-missing');
const addButton = (dialog: Locator): Locator => dialog.getByTestId('deal-add');
const wholePizza = (dialog: Locator, name: string): Locator =>
  panel(dialog).getByRole('group', { name: 'Whole pizza' }).getByRole('button', { name });

async function openDeal(page: Page, name: string): Promise<Locator> {
  await dealTile(page, name).click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The first two pizzas of the three-pizza deal: the state the wireframe draws. */
async function buildTwoOfThree(dialog: Locator): Promise<void> {
  await wholePizza(dialog, 'Garden').click();
  await panel(dialog).getByRole('button', { name: 'Olives', exact: true }).click();
  await dialog.getByRole('button', { name: 'Next: Pizza 2' }).click();
  await panel(dialog).getByRole('button', { name: 'Half & half' }).click();
  await panel(dialog)
    .getByRole('group', { name: '1st half' })
    .getByRole('button', { name: 'Island' })
    .click();
  await panel(dialog)
    .getByRole('group', { name: '2nd half' })
    .getByRole('button', { name: 'Plain Cheese' })
    .click();
}

/** The whole three-pizza deal, left open with Add on. */
async function buildThree(page: Page): Promise<Locator> {
  const dialog = await openDeal(page, THREE.name);
  await buildTwoOfThree(dialog);
  await dialog.getByRole('button', { name: 'Next: Pizza 3' }).click();
  await wholePizza(dialog, 'Classic Pepperoni').click();
  await dialog.getByRole('button', { name: 'Next: Wing flavour' }).click();
  await panel(dialog).getByRole('button', { name: 'Sweet Chili' }).click();
  await expect(addButton(dialog)).toBeEnabled();
  return dialog;
}

test.describe('the deal configurator', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await loginWithPassword(page, 'owner@flo.local');
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
    await page.getByRole('button', { name: 'Takeaway' }).click();
    await page.getByTestId('pizza-category-blocks').getByRole('button', { name: 'Deals' }).click();
  });

  test('a deal tile after a quantity search adds that many of the deal', async ({ page }) => {
    await page.getByTestId('pos-product-grid').getByRole('textbox').first().fill(`3*${COMBO.name}`);
    await expect(dealTile(page, COMBO.name)).toHaveCount(1);
    const dialog = await openDeal(page, COMBO.name);
    await wholePizza(dialog, 'Island').click();
    await dialog.getByRole('button', { name: 'Next: Pops' }).click();
    const cola = panel(dialog).getByRole('button', { name: 'One more Cola' });
    await cola.click();
    await cola.click();
    await addButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(cartLines(page).first().getByTestId('pizza-line-quantity')).toHaveText('3');
  });

  test('a deal tile opens the configurator with a tab for each choice', async ({ page }) => {
    const three = await openDeal(page, THREE.name);
    await expect(three).toContainText(THREE.description);
    await expect(three.getByTestId('deal-price')).toHaveText(money(THREE.price));
    await expect(three.getByTestId('deal-chosen')).toHaveText('0 of 4 chosen');
    await expect(tabs(three)).toHaveText([/Pizza 1/, /Pizza 2/, /Pizza 3/, /Wing flavour/]);
    await expect(tab(three, 'Pizza 1')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(three, 'Pizza 1')).toContainText('Choose a pizza');
    await expect(tab(three, 'Wing flavour')).toContainText('Choose a flavour');
    await expect(panel(three)).toContainText('Large · set by the deal');
    // A deal's pizza has no size, dips, note or quantity of its own.
    await expect(three.getByRole('group', { name: 'Size' })).toHaveCount(0);
    await expect(three.getByRole('group', { name: 'Dips' })).toHaveCount(0);
    await expect(three.getByLabel('Note for the kitchen')).toHaveCount(0);
    await expect(three.getByRole('button', { name: 'One more pizza' })).toHaveCount(0);
    await three.getByRole('button', { name: 'Close' }).click();
    await expect(three).toBeHidden();

    const party = await openDeal(page, PARTY.name);
    await expect(tabs(party)).toHaveText([
      /Pizza 1/,
      /Pizza 2/,
      /Pizza 3/,
      /Pizza 4/,
      /Pizza 5/,
      /Pizza 6/,
      /Drinks/,
    ]);
    await expect(tab(party, 'Drinks')).toContainText('Choose 4 cans or a 2L bottle');
    await party.getByRole('button', { name: 'Close' }).click();

    const combo = await openDeal(page, COMBO.name);
    await expect(tabs(combo)).toHaveText([/Pizza 1/, /Pops/]);
    await expect(tab(combo, 'Pops')).toContainText('Choose 2 pops');
    await combo.getByRole('button', { name: 'Close' }).click();

    const pasta = await openDeal(page, PASTA.name);
    await expect(tabs(pasta)).toHaveText([/Pops/]);
    await expect(pasta.getByTestId('deal-chosen')).toHaveText('0 of 1 chosen');
    await pasta.getByRole('button', { name: 'Close' }).click();
    await expect(cartLines(page)).toHaveCount(0);
  });

  test('Add is off, with the count, until every choice is made', async ({ page }) => {
    const dialog = await openDeal(page, COMBO.name);
    const add = addButton(dialog);
    const message = dialog.getByTestId('deal-message');
    await expect(add).toBeDisabled();
    await expect(add).toHaveText('2 choices left to add');
    await expect(message).toHaveText('Pizza 1: Pick a pizza');
    await expect(message).toHaveRole('status');
    await expect(add).toHaveAccessibleDescription('Pizza 1: Pick a pizza');

    await wholePizza(dialog, 'Garden').click();
    await expect(add).toBeDisabled();
    await expect(add).toHaveText('1 choice left to add');
    await expect(message).toHaveText('Pick 2 pops');
    await expect(dialog.getByTestId('deal-chosen')).toHaveText('1 of 2 chosen');
    await expect(tab(dialog, 'Pizza 1')).toContainText('Garden');

    await tab(dialog, 'Pops').click();
    const cans = dialog.getByTestId('deal-cans-count');
    await expect(cans).toHaveText('0 of 2 · 2 more');
    await panel(dialog).getByRole('button', { name: 'One more Cola' }).click();
    await expect(cans).toHaveText('1 of 2 · 1 more');
    await expect(add).toBeDisabled();
    await panel(dialog).getByRole('button', { name: 'One more Ginger Ale' }).click();
    await expect(cans).toHaveText('2 of 2 · done');
    // The deal has its two cans, so no drink takes another.
    await expect(panel(dialog).getByRole('button', { name: 'One more Cola' })).toBeDisabled();
    await expect(panel(dialog).getByRole('button', { name: 'One more Lemon Lime' })).toBeDisabled();
    await expect(tab(dialog, 'Pops')).toContainText('1 Cola, 1 Ginger Ale');
    await expect(missingBox(dialog)).toHaveCount(0);

    await expect(add).toBeEnabled();
    await expect(add).toHaveText(/^Add to order/);
    await expect(add).toContainText(money(COMBO.price));
    await expect(message).toHaveText('');
    await add.click();
    await expect(dialog).toBeHidden();

    await expect(cartLines(page)).toHaveCount(1);
    const line = cartLines(page).first();
    await expect(line).toContainText(COMBO.name);
    await expect(line).toContainText(money(COMBO.price));
    await expect(details(line)).toHaveText([
      '1) LARGE GARDEN',
      'POP: 1 COLA, 1 GINGER ALE',
      ...COMBO_INCLUDES_CART,
    ]);
  });

  test('three pizzas and wings: the summary, then the cart line', async ({ page }) => {
    const dialog = await openDeal(page, THREE.name);
    await buildTwoOfThree(dialog);
    await expect(dialog.getByTestId('deal-chosen')).toHaveText('2 of 4 chosen');
    await expect(tab(dialog, 'Pizza 1')).toContainText('Garden · NO OLIVES');
    await expect(tab(dialog, 'Pizza 2')).toContainText('Island / Plain Cheese');
    await expect(tab(dialog, 'Pizza 2')).toHaveAttribute('aria-selected', 'true');
    await expect(summary(dialog)).toHaveText([
      THREE.name.toUpperCase(),
      ...THREE_LINES.slice(0, 5),
      '3) Choose a pizza',
      'WINGS: Choose a flavour',
      ...THREE_INCLUDES,
    ]);
    await expect(addButton(dialog)).toHaveText('2 choices left to add');
    await shot(page, 'deal-configurator.png');

    await dialog.getByRole('button', { name: 'Next: Pizza 3' }).click();
    await wholePizza(dialog, 'Classic Pepperoni').click();
    await dialog.getByRole('button', { name: 'Next: Wing flavour' }).click();
    await shot(page, 'deal-wings.png');
    await panel(dialog).getByRole('button', { name: 'Sweet Chili' }).click();
    await expect(panel(dialog).getByRole('button', { name: 'Sweet Chili' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(tab(dialog, 'Wing flavour')).toContainText('Sweet Chili');
    await expect(summary(dialog)).toHaveText([
      THREE.name.toUpperCase(),
      ...THREE_LINES,
      ...THREE_INCLUDES,
    ]);
    await expect(dialog.getByTestId('deal-chosen')).toHaveText('4 of 4 chosen');
    await expect(addButton(dialog)).toContainText(money(THREE.price));

    await addButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(cartLines(page)).toHaveCount(1);
    const line = cartLines(page).first();
    await expect(line).toContainText(THREE.name);
    await expect(line).toContainText(money(THREE.price));
    await expect(details(line)).toHaveText([...THREE_LINES, ...THREE_INCLUDES_CART]);
    await shot(page, 'deal-cart-line.png');
  });

  test('"Still missing" jumps to the tab of a missing choice', async ({ page }) => {
    const dialog = await openDeal(page, THREE.name);
    await buildTwoOfThree(dialog);
    const box = missingBox(dialog);
    await expect(box).toContainText('Still missing: 2');
    await expect(box.getByRole('button')).toHaveText(['Pizza 3', 'Wing flavour']);

    await box.getByRole('button', { name: 'Wing flavour' }).click();
    await expect(tab(dialog, 'Wing flavour')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(dialog, 'Wing flavour')).toBeFocused();
    await expect(panel(dialog).getByRole('button', { name: 'Hot', exact: true })).toBeVisible();

    await box.getByRole('button', { name: 'Pizza 3' }).click();
    await expect(tab(dialog, 'Pizza 3')).toHaveAttribute('aria-selected', 'true');
    await wholePizza(dialog, 'Smokehouse Chicken').click();
    await expect(box).toContainText('Still missing: 1');
    await expect(box.getByRole('button')).toHaveText(['Wing flavour']);
  });

  test('Edit on a deal line changes one pizza and saves over the line, and "Customize 1" splits it', async ({
    page,
  }) => {
    await addButton(await buildThree(page)).click();
    await expect(cartLines(page)).toHaveCount(1);

    await cartLines(page).first().getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: THREE.name });
    await expect(dialog.getByTestId('deal-chosen')).toHaveText('4 of 4 chosen');
    await expect(summary(dialog)).toHaveText([
      THREE.name.toUpperCase(),
      ...THREE_LINES,
      ...THREE_INCLUDES,
    ]);
    await expect(addButton(dialog)).toHaveText(/^Save/);
    await expect(addButton(dialog)).toContainText(money(THREE.price));
    await expect(panel(dialog).getByRole('button', { name: 'NO Olives' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await tab(dialog, 'Pizza 3').click();
    // The tab shows the pizza it holds; Change lists them all again.
    await panel(dialog).getByRole('button', { name: 'Change' }).click();
    await wholePizza(dialog, 'Smokehouse Chicken').click();
    await panel(dialog)
      .getByRole('group', { name: 'Cook' })
      .getByRole('button', { name: 'Well done' })
      .click();
    await addButton(dialog).click();
    await expect(dialog).toBeHidden();

    await expect(cartLines(page)).toHaveCount(1);
    const line = cartLines(page).first();
    await expect(line).toContainText(money(THREE.price));
    await expect(line.getByTestId('pizza-line-quantity')).toHaveText('1');
    await expect(details(line)).toHaveText([
      ...THREE_LINES.slice(0, 5),
      '3) LARGE SMOKEHOUSE CHICKEN',
      'WELL DONE',
      'WINGS: SWEET CHILI',
      ...THREE_INCLUDES_CART,
    ]);
    // The line was saved under a new identity, so its own Edit button takes the focus.
    await expect(line.getByRole('button', { name: 'Edit' })).toBeFocused();

    // Closing an edit without saving leaves the line as it is.
    await line.getByRole('button', { name: 'Edit' }).click();
    await tab(dialog, 'Wing flavour').click();
    await panel(dialog).getByRole('button', { name: 'Hot', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(details(cartLines(page).first()).filter({ hasText: 'WINGS:' })).toHaveText(
      'WINGS: SWEET CHILI',
    );

    // A deal line of two: "Customize 1" takes one off, and closing puts it back.
    const quantity = (at: number) => cartLines(page).nth(at).getByTestId('pizza-line-quantity');
    await cartLines(page)
      .first()
      .getByRole('button', { name: /^One more/ })
      .click();
    await expect(quantity(0)).toHaveText('2');
    await cartLines(page).first().getByRole('button', { name: 'Customize 1' }).click();
    await expect(dialog).toBeVisible();
    await expect(cartLines(page)).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(quantity(0)).toHaveText('2');

    // Saved with another flavour, the one taken off is a line of its own.
    await cartLines(page).first().getByRole('button', { name: 'Customize 1' }).click();
    await tab(dialog, 'Wing flavour').click();
    await panel(dialog).getByRole('button', { name: 'Hot', exact: true }).click();
    await addButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(cartLines(page)).toHaveCount(2);
    await expect(quantity(0)).toHaveText('1');
    await expect(quantity(1)).toHaveText('1');
    await expect(details(cartLines(page).nth(0)).filter({ hasText: 'WINGS:' })).toHaveText(
      'WINGS: SWEET CHILI',
    );
    await expect(details(cartLines(page).nth(1)).filter({ hasText: 'WINGS:' })).toHaveText(
      'WINGS: HOT',
    );
    await expect(cartLines(page).nth(1).getByRole('button', { name: 'Edit' })).toBeFocused();
  });

  test('an order paid in cash stores the recipe the configurator built', async ({ page }) => {
    await addButton(await buildThree(page)).click();
    await expect(cartLines(page)).toHaveCount(1);

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
    expect((await (await paid).json()).bill.payment_status).toBe('paid');
    await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
    await expect(checkout).toBeHidden({ timeout: 15_000 });

    const read = await page.request.get(`${BASE}/api/orders/${orderId}`, { headers: ownerHeaders });
    expect(read.ok()).toBeTruthy();
    const { order } = await read.json();
    expect(order.items).toHaveLength(1);
    const [item] = order.items;
    expect(item.product_id).toBe('dl-three-large-wings');
    expect(item.quantity).toBe(1);
    expect(Number(item.unit_price)).toBe(THREE.price);
    expect(
      typeof item.modifier_selection === 'string'
        ? JSON.parse(item.modifier_selection)
        : item.modifier_selection,
    ).toEqual({ ...THREE_RECIPE, includes: THREE.description });
  });

  test('the six-pizza deal fits iPad landscape and every control is 48 px', async ({ page }) => {
    const tooSmall = (scope: Locator) =>
      scope.locator('button, input').evaluateAll((controls) =>
        controls
          .map((control) => ({ control, box: control.getBoundingClientRect() }))
          .filter(({ box }) => box.width < 48 || box.height < 48)
          .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
      );
    const fits = async (dialog: Locator) => {
      // The dialog opens at 95% and grows; measure it at rest.
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1180);
      expect(box.y + box.height).toBeLessThanOrEqual(820);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        'the page does not scroll sideways',
      ).toBe(0);
      // Each of the dialog's own scrolling parts may scroll down, never sideways.
      expect(
        await dialog.evaluate((element) =>
          [element, ...element.querySelectorAll('*')]
            .filter(
              (part) =>
                getComputedStyle(part).overflowX !== 'hidden' &&
                part.scrollWidth > part.clientWidth + 1,
            )
            .map((part) => part.textContent),
        ),
        'nothing in the dialog scrolls sideways',
      ).toEqual([]);
      for (const part of [...(await tabs(dialog).all()), addButton(dialog)]) {
        const inside = (await part.boundingBox())!;
        expect(inside.x).toBeGreaterThanOrEqual(box.x);
        expect(inside.x + inside.width).toBeLessThanOrEqual(box.x + box.width);
        expect(inside.y + inside.height).toBeLessThanOrEqual(box.y + box.height);
      }
      expect(await tooSmall(dialog)).toEqual([]);
    };

    const dialog = await openDeal(page, PARTY.name);
    await expect(tabs(dialog)).toHaveCount(7);
    await fits(dialog);
    await shot(page, 'deal-party-empty.png');

    // The widest pizzas the sample has: a half and half with removals on both sides, six times.
    for (let pizza = 1; pizza <= 6; pizza += 1) {
      await tab(dialog, `Pizza ${pizza}`).click();
      await panel(dialog).getByRole('button', { name: 'Half & half' }).click();
      const first = panel(dialog).getByRole('group', { name: '1st half' });
      await first.getByRole('button', { name: 'Smokehouse Chicken' }).click();
      await first.getByRole('button', { name: 'Jalapeño pepper', exact: true }).click();
      await first.getByRole('button', { name: 'Red onions', exact: true }).click();
      const second = panel(dialog).getByRole('group', { name: '2nd half' });
      await second.getByRole('button', { name: 'Garden' }).click();
      await second.getByRole('button', { name: 'Mushrooms', exact: true }).click();
      await panel(dialog)
        .getByRole('group', { name: 'Cook' })
        .getByRole('button', { name: 'Well done' })
        .click();
      await panel(dialog)
        .getByRole('group', { name: 'Cut' })
        .getByRole('button', { name: 'Square cut' })
        .click();
    }
    await expect(dialog.getByTestId('deal-chosen')).toHaveText('6 of 7 chosen');
    await fits(dialog);
    await shot(page, 'deal-party-pizza.png');

    await missingBox(dialog).getByRole('button', { name: 'Drinks' }).click();
    await panel(dialog).getByRole('button', { name: 'One more Cola' }).click();
    await panel(dialog).getByRole('button', { name: 'One more Cola' }).click();
    await panel(dialog).getByRole('button', { name: 'One more Ginger Ale' }).click();
    await expect(dialog.getByTestId('deal-cans-count')).toHaveText('3 of 4 · 1 more');
    await fits(dialog);
    await shot(page, 'deal-party-cans.png');

    await panel(dialog).getByRole('button', { name: 'One 2L bottle' }).click();
    await panel(dialog).getByRole('button', { name: 'Ginger Ale 2L' }).click();
    await expect(tab(dialog, 'Drinks')).toContainText('2L Ginger Ale');
    await expect(summary(dialog).filter({ hasText: '2L:' })).toHaveText('2L: GINGER ALE');
    await fits(dialog);
    await shot(page, 'deal-party-bottle.png');
    // The other side was cleared: going back to cans starts from none.
    await panel(dialog).getByRole('button', { name: '4 cans' }).click();
    await expect(dialog.getByTestId('deal-cans-count')).toHaveText('0 of 4 · 4 more');
    await panel(dialog).getByRole('button', { name: 'One 2L bottle' }).click();
    await panel(dialog).getByRole('button', { name: 'Cola 2L' }).click();

    await addButton(dialog).click();
    await expect(dialog).toBeHidden();
    const line = cartLines(page).first();
    await expect(line).toContainText(money(PARTY.price));
    await expect(details(line).filter({ hasText: '2L:' })).toHaveText('2L: COLA');
    expect(await tooSmall(line.getByTestId('pizza-line-actions'))).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      'the page does not scroll sideways with the deal in the cart',
    ).toBe(0);
    await shot(page, 'deal-party-cart-line.png');
  });

  test('the configurator works with the keyboard only', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: COMBO.name });
    /** Tabs forward until `target` has the focus; the focus never leaves the dialog. */
    const tabTo = async (target: Locator) => {
      for (let presses = 0; presses < 80; presses += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
        expect(
          await dialog.evaluate((element) => element.contains(document.activeElement)),
          'the focus stays inside the dialog',
        ).toBe(true);
      }
      throw new Error('Tab never reached the control');
    };

    const tile = dealTile(page, COMBO.name);
    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(tab(dialog, 'Pizza 1')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(cartLines(page)).toHaveCount(0);
    await expect(tile).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    // The arrow keys move along the tabs.
    await page.keyboard.press('ArrowRight');
    await expect(tab(dialog, 'Pops')).toBeFocused();
    await expect(tab(dialog, 'Pops')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(tab(dialog, 'Pizza 1')).toHaveAttribute('aria-selected', 'true');

    await tabTo(wholePizza(dialog, 'Island'));
    await page.keyboard.press('Enter');
    await tabTo(panel(dialog).getByRole('button', { name: 'Pineapple', exact: true }));
    await page.keyboard.press('Space');
    await expect(panel(dialog).getByRole('button', { name: 'NO Pineapple' })).toBeFocused();
    await tabTo(
      panel(dialog).getByRole('group', { name: 'Cut' }).getByRole('button', { name: 'Uncut' }),
    );
    await page.keyboard.press('Enter');
    await tabTo(dialog.getByRole('button', { name: 'Next: Pops' }));
    await page.keyboard.press('Enter');
    await expect(tab(dialog, 'Pops')).toBeFocused();

    await tabTo(panel(dialog).getByRole('button', { name: 'One more Lemon Lime' }));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('deal-cans-count')).toHaveText('2 of 2 · done');
    const add = addButton(dialog);
    await tabTo(add);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(tile).toBeFocused();

    const line = cartLines(page).first();
    await expect(line).toContainText(COMBO.name);
    await expect(details(line)).toHaveText([
      '1) LARGE ISLAND',
      'NO PINEAPPLE',
      'UNCUT',
      'POP: 2 LEMON LIME',
      ...COMBO_INCLUDES_CART,
    ]);
  });
});
