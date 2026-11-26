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
 * The dips and drinks popup and the folded cart rows, against the made-up
 * sample menu at iPad landscape. Every spec shares one database, so this one
 * loads the menu itself, pays the orders it places, and clears the menu when
 * it ends.
 */

test.use({ viewport: { width: 1180, height: 820 } });

const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };

const menu = sampleMenu();
const category = (id: string) => menu.categories.find((entry) => entry.id === id)!;
const DIP = category('sides').items.find((side) => side.id === 'dip')!.price!;
const sizes = (category('drinks') as unknown as { variants: { id: string; price: number }[] })
  .variants;
const CAN = sizes.find((size) => size.id === 'can')!.price;
const BOTTLE = sizes.find((size) => size.id === '2l')!.price;
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
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, name),
      animations: 'disabled',
    });
}

const blocks = (page: Page): Locator => page.getByTestId('pizza-category-blocks');
const block = (page: Page, name: string): Locator =>
  blocks(page).getByRole('button', { name, exact: true });
const popupOf = (page: Page): Locator => page.getByRole('dialog', { name: 'Dips & drinks' });
const dim = (page: Page): Locator => page.getByTestId('small-items-dim');
const cartLines = (page: Page): Locator => page.getByTestId('cart-item');
const lineOf = (page: Page, text: string | RegExp): Locator =>
  cartLines(page).filter({ hasText: text });
const pizzaTile = (page: Page, name: string): Locator =>
  page.getByTestId('pizza-tile').filter({ has: page.getByRole('heading', { name, exact: true }) });

/** A row of the popup by its kind: "Dips", "Can", "2L Bottle". */
const row = (page: Page, kind: string): Locator =>
  popupOf(page).getByRole('group', { name: new RegExp(`^${kind}`) });
const tile = (page: Page, kind: string, name: string): Locator =>
  row(page, kind)
    .getByTestId('small-item-tile')
    .filter({
      has: page.getByRole('button', { name: new RegExp(`^${name}`) }),
    });
const add = (page: Page, kind: string, name: string): Locator =>
  tile(page, kind, name).getByRole('button', { name: new RegExp(`^${name}`) });
const minus = (page: Page, kind: string, name: string): Locator =>
  tile(page, kind, name).getByRole('button', { name: /^One fewer/ });
const countOn = (page: Page, kind: string, name: string): Locator =>
  tile(page, kind, name).getByTestId('small-item-count');

async function addLargePizza(page: Page, name: string): Promise<void> {
  await pizzaTile(page, name).getByRole('button', { name: /Large/ }).click();
}

/** One of a product through the product grid's own tile and dialog. */
async function addFromGrid(
  page: Page,
  product: string,
  choice: { addon?: string; size?: string },
): Promise<void> {
  await page
    .getByTestId('pos-product-card')
    .filter({ has: page.getByRole('heading', { name: product, exact: true }) })
    .click();
  if (choice.size) await page.getByRole('radio', { name: new RegExp(`^${choice.size}`) }).click();
  if (choice.addon)
    await page
      .locator('div.min-h-14')
      .filter({ hasText: choice.addon })
      .getByRole('button')
      .click();
  await page.getByRole('button', { name: /^Add to Cart/ }).click();
}

type PlacedOrder = {
  subtotal: number;
  tax_amount: number;
  total: number;
  items: {
    product_id: string;
    variant_id: string | null;
    quantity: number;
    unit_price: number;
    subtotal: number;
    tax_amount: number;
    total: number;
    addons: { id?: string | number | null; quantity?: number }[] | null;
  }[];
};

/** Pays the cart in cash and answers the order as the server stored it. */
async function payCash(page: Page): Promise<PlacedOrder> {
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
  await expect(cartLines(page)).toHaveCount(0);

  const read = await page.request.get(`${BASE}/api/orders/${orderId}`, {
    headers: ownerHeaders,
  });
  expect(read.ok()).toBeTruthy();
  return (await read.json()).order;
}

/** What the two ways of adding the same items must agree on. */
const sold = (order: PlacedOrder) => ({
  subtotal: order.subtotal,
  tax_amount: order.tax_amount,
  total: order.total,
  items: order.items
    .map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id ?? null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      subtotal: item.subtotal,
      tax_amount: item.tax_amount,
      total: item.total,
      addons: (item.addons ?? []).map((addon) => [addon.id, addon.quantity ?? 1]),
    }))
    .sort((a, b) =>
      `${a.product_id}${a.variant_id}`.localeCompare(`${b.product_id}${b.variant_id}`),
    ),
});

const tooSmall = (scope: Locator) =>
  scope.locator('button').evaluateAll((controls) =>
    controls
      .map((control) => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 48 || box.height < 48)
      .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
  );

test.beforeEach(async ({ page }) => {
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(blocks(page)).toBeVisible();
  await page.getByRole('button', { name: 'Takeaway' }).click();
  await expect(block(page, 'Pizzas')).toHaveAttribute('aria-pressed', 'true');
});

test('the Dips block opens the popup and the order stays visible and usable', async ({ page }) => {
  await addLargePizza(page, 'Garden');
  await block(page, 'Dips').click();
  const popup = popupOf(page);
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('Tap a tile to add one. It goes straight into the order.');

  // One row per kind, dips first, labelled with the kind and its price.
  await expect(popup.getByRole('group')).toHaveCount(3);
  await expect(row(page, 'Dips')).toHaveAccessibleName(money(DIP));
  await expect(row(page, 'Can')).toHaveAccessibleName(money(CAN));
  await expect(row(page, '2L Bottle')).toHaveAccessibleName(money(BOTTLE));
  await expect(row(page, 'Dips').getByTestId('small-item-tile')).toHaveCount(2);
  await expect(row(page, 'Can').getByTestId('small-item-tile')).toHaveCount(3);
  await expect(row(page, '2L Bottle').getByTestId('small-item-tile')).toHaveCount(3);
  await expect(add(page, 'Dips', 'Ranch')).toContainText(money(DIP));
  await expect(add(page, '2L Bottle', 'Lemon Lime')).toContainText(money(BOTTLE));

  // The sheet covers the lower part of the product area and none of the order.
  const grid = (await page.getByTestId('pos-product-grid').boundingBox())!;
  const sheet = (await popup.boundingBox())!;
  const line = lineOf(page, 'Garden');
  const order = (await line.boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(grid.x - 1);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(grid.x + grid.width + 1);
  expect(sheet.y).toBeGreaterThan(grid.y);
  expect(Math.abs(sheet.y + sheet.height - (grid.y + grid.height))).toBeLessThanOrEqual(1);
  expect(order.x).toBeGreaterThanOrEqual(sheet.x + sheet.width);
  await expect(line).toBeVisible();

  // The order is still worked on beside the open popup.
  await line.getByRole('button', { name: 'One more Garden' }).click();
  await expect(line.getByTestId('pizza-line-quantity')).toHaveText('2');
  await expect(popup).toBeVisible();

  // The Drinks block opens the same popup, and leaves the category that was chosen alone.
  await popup.getByRole('button', { name: 'Done' }).click();
  await expect(popup).toBeHidden();
  await block(page, 'Drinks').click();
  await expect(popup).toBeVisible();
  await popup.getByRole('button', { name: 'Done' }).click();
  await expect(block(page, 'Pizzas')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pizza-tile').first()).toBeVisible();
});

test('two taps on a dip make one line of two, counted on the tile and marked added', async ({
  page,
}) => {
  await addLargePizza(page, 'Garden');
  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await add(page, 'Dips', 'Ranch').click();

  await expect(cartLines(page)).toHaveCount(2);
  const line = lineOf(page, 'Ranch');
  await expect(line).toContainText('Dip');
  await expect(line.getByTestId('cart-item-qty')).toHaveText('2');
  await expect(line).toContainText(money(DIP * 2));
  await expect(countOn(page, 'Dips', 'Ranch')).toHaveText('2');
  await expect(countOn(page, 'Dips', 'Garlic')).toHaveCount(0);

  // The mark is a word, and it sits on that line only until the order changes again.
  await expect(line.getByTestId('pizza-line-added')).toHaveText('added');
  await expect(page.getByTestId('pizza-line-added')).toHaveCount(1);
  await shot(page, 'small-items-popup.png');
  await add(page, 'Can', 'Cola').click();
  await expect(line.getByTestId('pizza-line-added')).toHaveCount(0);
  await expect(lineOf(page, 'Cola').getByTestId('pizza-line-added')).toHaveText('added');
  await lineOf(page, 'Garden').getByRole('button', { name: 'One more Garden' }).click();
  await expect(page.getByTestId('pizza-line-added')).toHaveCount(0);
});

test('minus takes one off, and at zero the line is gone', async ({ page }) => {
  await block(page, 'Dips').click();
  await expect(minus(page, 'Dips', 'Garlic')).toHaveCount(0);
  await add(page, 'Dips', 'Garlic').click();
  await add(page, 'Dips', 'Garlic').click();
  await expect(countOn(page, 'Dips', 'Garlic')).toHaveText('2');

  await minus(page, 'Dips', 'Garlic').click();
  await expect(countOn(page, 'Dips', 'Garlic')).toHaveText('1');
  await expect(lineOf(page, 'Garlic').getByTestId('cart-item-qty')).toHaveText('1');

  await minus(page, 'Dips', 'Garlic').click();
  await expect(cartLines(page)).toHaveCount(0);
  await expect(countOn(page, 'Dips', 'Garlic')).toHaveCount(0);
  await expect(minus(page, 'Dips', 'Garlic')).toHaveCount(0);
  await expect(add(page, 'Dips', 'Garlic')).toContainText(money(DIP));
});

test('a can and a two-litre of one drink are separate lines at their own prices', async ({
  page,
}) => {
  await block(page, 'Drinks').click();
  await add(page, 'Can', 'Cola').click();
  await add(page, '2L Bottle', 'Cola').click();

  await expect(cartLines(page)).toHaveCount(2);
  await expect(lineOf(page, 'Cola (Can)')).toContainText(money(CAN));
  await expect(lineOf(page, 'Cola (2L Bottle)')).toContainText(money(BOTTLE));
  await expect(countOn(page, 'Can', 'Cola')).toHaveText('1');
  await expect(countOn(page, '2L Bottle', 'Cola')).toHaveText('1');
  await expect(countOn(page, 'Can', 'Ginger Ale')).toHaveCount(0);
});

test('Done, Escape and the dimmed area close it and leave the order as it is', async ({ page }) => {
  const popup = popupOf(page);
  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await add(page, 'Can', 'Ginger Ale').click();
  const order = await cartLines(page).allInnerTexts();
  expect(order).toHaveLength(2);

  await popup.getByRole('button', { name: 'Done' }).click();
  await expect(popup).toBeHidden();
  expect(await cartLines(page).allInnerTexts()).toEqual(order);
  await expect(block(page, 'Dips')).toBeFocused();

  await block(page, 'Drinks').click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  expect(await cartLines(page).allInnerTexts()).toEqual(order);
  await expect(block(page, 'Drinks')).toBeFocused();

  await block(page, 'Dips').click();
  await expect(popup).toBeVisible();
  // The dimmed area is the product area above the sheet.
  await dim(page).click({ position: { x: 40, y: 40 } });
  await expect(popup).toBeHidden();
  expect(await cartLines(page).allInnerTexts()).toEqual(order);
  await expect(dim(page)).toHaveCount(0);

  // With the popup closed the tiles under it work again.
  await addLargePizza(page, 'Island');
  await expect(cartLines(page)).toHaveCount(3);
});

test('Escape closes a window opened from the order first, and the popup only after it', async ({
  page,
}) => {
  const popup = popupOf(page);
  await block(page, 'Drinks').click();
  await add(page, 'Can', 'Cola').click();
  await lineOf(page, 'Cola (Can)').getByRole('button', { name: 'Edit' }).click();
  const save = page.getByRole('button', { name: /^Save(?! as)/ });
  await expect(save).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(save).toBeHidden();
  await expect(popup).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(cartLines(page)).toHaveCount(1);
});

test('a scan that ends in Enter adds nothing when the popup has just opened', async ({ page }) => {
  const popup = popupOf(page);
  await block(page, 'Dips').click();
  // The sheet itself has the focus, not a tile a stray Enter would press.
  await expect(popup).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(cartLines(page)).toHaveCount(0);
  await expect(popup).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(popup.getByRole('button', { name: 'Done' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(add(page, 'Dips', 'Ranch')).toBeFocused();
});

test('a tap with a pointer leaves the focus on the sheet, so a scan presses no tile', async ({
  page,
}) => {
  const popup = popupOf(page);
  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await expect(popup).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(countOn(page, 'Dips', 'Ranch')).toHaveText('1');
  await add(page, 'Dips', 'Ranch').click();
  await minus(page, 'Dips', 'Ranch').click();
  await expect(popup).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(countOn(page, 'Dips', 'Ranch')).toHaveText('1');

  // A code the scanner types, ending in Enter, adds nothing through the popup.
  await page.keyboard.type('4006381333931', { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(cartLines(page)).toHaveCount(1);
  await expect(countOn(page, 'Dips', 'Ranch')).toHaveText('1');
  await expect(popup).toBeVisible();
});

test('a dialog opened from the order over the popup takes Escape first', async ({ page }) => {
  const popup = popupOf(page);
  await addLargePizza(page, 'Garden');
  await block(page, 'Drinks').click();
  await add(page, 'Can', 'Cola').click();

  // The quick-button dialog, from the row under an ordinary line.
  await lineOf(page, 'Cola (Can)').getByRole('button', { name: 'Save as quick button' }).click();
  const saveButton = page.getByRole('dialog', { name: 'Save as quick button' });
  await expect(saveButton).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(saveButton).toBeHidden();
  await expect(popup).toBeVisible();

  // The pizza sheet, from a pizza line.
  await lineOf(page, 'Garden').getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pizza', exact: true });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(popup).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(cartLines(page)).toHaveCount(2);
});

test('the save row shows on the unfolded line and is hidden on folded ones, and stays on ordinary lines', async ({
  page,
}) => {
  const saveRow = (name: string) =>
    lineOf(page, name).getByRole('button', { name: 'Save as quick button' });
  await block(page, 'Deals').click();
  await page.getByTestId('pos-product-card').filter({ hasText: 'Pasta Night' }).click();
  const deal = page.getByRole('dialog', { name: 'Pasta Night' });
  for (let can = 0; can < 3; can += 1)
    await deal.getByRole('button', { name: 'One more Cola' }).click();
  await deal.getByTestId('deal-add').click();
  await expect(deal).toBeHidden();
  await block(page, 'Pizzas').click();
  for (const name of ['Garden', 'Island']) await addLargePizza(page, name);
  // With three lines nothing folds, and every line has its row.
  for (const name of ['Pasta Night', 'Garden', 'Island']) await expect(saveRow(name)).toBeVisible();

  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await popupOf(page).getByRole('button', { name: 'Done' }).click();
  await expect(cartLines(page)).toHaveCount(4);

  // The dip was touched last: the deal and both pizzas are folded, and their rows are away.
  await expect(page.getByTestId('pizza-line-actions')).toHaveCount(0);
  await expect(lineOf(page, 'Pasta Night').getByTestId('pizza-line-unfold')).toHaveText('1x');
  await expect(lineOf(page, 'Pasta Night').getByTestId('pizza-line-detail').first()).toBeVisible();
  for (const name of ['Pasta Night', 'Garden', 'Island']) await expect(saveRow(name)).toBeHidden();
  // An ordinary line keeps its row, and it opens the dialog.
  const saveButton = page.getByRole('dialog', { name: 'Save as quick button' });
  expect((await saveRow('Ranch').boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await saveRow('Ranch').click();
  await expect(saveButton).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(saveButton).toBeHidden();

  // Unfolding the deal brings its action row and its save row back, and folds nothing else open.
  await lineOf(page, 'Pasta Night').click({ position: { x: 90, y: 12 } });
  await expect(lineOf(page, 'Pasta Night').getByTestId('pizza-line-actions')).toBeVisible();
  await saveRow('Pasta Night').click();
  await expect(saveButton).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(saveButton).toBeHidden();
  await expect(saveRow('Garden')).toBeHidden();
  await expect(saveRow('Ranch')).toBeVisible();
});

test('five pizza lines fit the cart at iPad landscape without scrolling', async ({ page }) => {
  for (const name of [
    'Garden',
    'Island',
    'Classic Pepperoni',
    'Smokehouse Chicken',
    'Plain Cheese',
  ])
    await addLargePizza(page, name);
  await expect(cartLines(page)).toHaveCount(5);
  const last = lineOf(page, 'Plain Cheese');
  await expect(last.getByTestId('pizza-line-actions')).toBeVisible();
  const heights = await cartLines(page).evaluateAll((lines) =>
    lines.map((line) => Math.round(line.getBoundingClientRect().height)),
  );
  const line = (await last.boundingBox())!;
  const footer = (await page.getByTestId('cart-footer').boundingBox())!;
  expect(
    line.y + line.height,
    `the last line ends above the cart footer (line heights ${heights.join(', ')})`,
  ).toBeLessThanOrEqual(footer.y);
  await expect(last.getByRole('button', { name: 'Save as quick button' })).toBeInViewport({
    ratio: 1,
  });
});

test('the Quick Buttons block keeps its place, and the popup opens over its page and gives it back', async ({
  page,
}) => {
  await expect(blocks(page).getByRole('button')).toHaveText([
    'All',
    'Pizzas',
    /./,
    'Sides',
    'Dips',
    'Drinks',
    'Deals',
    /^Quick Buttons/,
  ]);
  const quick = blocks(page).getByRole('button', { name: /^Quick Buttons/ });
  await quick.click();
  await expect(quick).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pizza-tile')).toHaveCount(0);

  await block(page, 'Dips').click();
  await expect(popupOf(page)).toBeVisible();
  await add(page, 'Dips', 'Garlic').click();
  await popupOf(page).getByRole('button', { name: 'Done' }).click();
  await expect(popupOf(page)).toBeHidden();
  await expect(quick).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pizza-tile')).toHaveCount(0);
  await expect(cartLines(page)).toHaveCount(1);
});

test('past three lines the pizza action rows fold, except on the line last touched', async ({
  page,
}) => {
  const actions = page.getByTestId('pizza-line-actions');
  const unfold = (name: string) => lineOf(page, name).getByTestId('pizza-line-unfold');
  for (const name of ['Garden', 'Island', 'Classic Pepperoni']) await addLargePizza(page, name);
  await expect(cartLines(page)).toHaveCount(3);
  await expect(actions).toHaveCount(3);
  await expect(page.getByTestId('pizza-line-unfold')).toHaveCount(0);

  await addLargePizza(page, 'Smokehouse Chicken');
  await addLargePizza(page, 'Plain Cheese');
  await addLargePizza(page, 'Plain Cheese');
  await expect(cartLines(page)).toHaveCount(5);
  await expect(actions).toHaveCount(1);
  await expect(lineOf(page, 'Plain Cheese').getByTestId('pizza-line-actions')).toBeVisible();
  await expect(lineOf(page, 'Plain Cheese').getByTestId('pizza-line-quantity')).toHaveText('2');
  // A folded line still says how many, in words a screen reader gets too.
  await expect(unfold('Garden')).toHaveText('1x');
  await expect(unfold('Garden')).toHaveAttribute('aria-expanded', 'false');
  await expect(unfold('Garden')).toHaveAccessibleName('1x Garden. Show actions');

  // A tap anywhere on a folded line unfolds it and folds the others.
  const garden = lineOf(page, 'Garden');
  expect((await garden.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await garden.click({ position: { x: 90, y: 12 } });
  await expect(actions).toHaveCount(1);
  await expect(garden.getByTestId('pizza-line-actions')).toBeVisible();
  await expect(unfold('Plain Cheese')).toHaveText('2x');
  expect(await tooSmall(page.getByTestId('pizza-line-actions'))).toEqual([]);
  await shot(page, 'small-items-folded.png');

  // The keyboard unfolds a line too, and lands on its actions.
  await unfold('Island').focus();
  await page.keyboard.press('Enter');
  await expect(lineOf(page, 'Island').getByTestId('pizza-line-actions')).toBeVisible();
  await expect(lineOf(page, 'Island').getByRole('button', { name: 'Edit' })).toBeFocused();
  await expect(actions).toHaveCount(1);

  // A folded line can still be removed, and a line added from the popup folds every pizza line.
  await garden.getByTestId('cart-item-remove-btn').click();
  await expect(cartLines(page)).toHaveCount(4);
  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await expect(cartLines(page)).toHaveCount(5);
  await expect(actions).toHaveCount(0);
  await popupOf(page).getByRole('button', { name: 'Done' }).click();

  // Back at three lines, every row shows.
  await lineOf(page, 'Ranch').getByTestId('cart-item-remove-btn').click();
  await lineOf(page, 'Smokehouse Chicken').getByTestId('cart-item-remove-btn').click();
  await expect(cartLines(page)).toHaveCount(3);
  await expect(actions).toHaveCount(3);
  await expect(page.getByTestId('pizza-line-unfold')).toHaveCount(0);
});

test('an order from the popup is priced and taxed as the same items from the product grid', async ({
  page,
}) => {
  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await add(page, 'Can', 'Cola').click();
  await add(page, 'Can', 'Cola').click();
  await add(page, '2L Bottle', 'Ginger Ale').click();
  await expect(cartLines(page)).toHaveCount(3);
  await popupOf(page).getByRole('button', { name: 'Done' }).click();

  // A tap on a tile and the product grid's dialog add to one and the same line.
  await block(page, 'All').click();
  await addFromGrid(page, 'Dip', { addon: 'Ranch' });
  await expect(cartLines(page)).toHaveCount(3);
  await expect(lineOf(page, 'Ranch').getByTestId('cart-item-qty')).toHaveText('2');
  await block(page, 'Dips').click();
  await expect(countOn(page, 'Dips', 'Ranch')).toHaveText('2');
  await minus(page, 'Dips', 'Ranch').click();
  await popupOf(page).getByRole('button', { name: 'Done' }).click();
  const fromPopup = await payCash(page);

  await block(page, 'All').click();
  await addFromGrid(page, 'Dip', { addon: 'Ranch' });
  await addFromGrid(page, 'Cola', { size: 'Can' });
  await addFromGrid(page, 'Cola', { size: 'Can' });
  await addFromGrid(page, 'Ginger Ale', { size: '2L Bottle' });
  await expect(cartLines(page)).toHaveCount(3);
  const fromGrid = await payCash(page);

  expect(sold(fromPopup)).toEqual(sold(fromGrid));
  expect(
    sold(fromPopup).items.map((item) => [item.product_id, item.variant_id, item.quantity]),
  ).toEqual([
    ['dr-cola', 'dr-cola-can', 2],
    ['dr-ginger-ale', 'dr-ginger-ale-2l', 1],
    ['sd-dip', null, 1],
  ]);
  expect(fromPopup.subtotal).toBeCloseTo(DIP + CAN * 2 + BOTTLE, 2);
  expect(fromPopup.total).toBeGreaterThanOrEqual(fromPopup.subtotal);
});

test('the popup works with the keyboard only', async ({ page }) => {
  const popup = popupOf(page);
  /** Tabs until `target` has the focus, never onto the dimmed product area. */
  const tabTo = async (target: Locator, key = 'Tab') => {
    for (let presses = 0; presses < 40; presses += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) return;
      await page.keyboard.press(key);
      expect(
        await page
          .getByTestId('pos-product-grid')
          .evaluate((area) => area.contains(document.activeElement)),
        'the focus stays off the dimmed product area',
      ).toBe(false);
    }
    throw new Error('Tab never reached the control');
  };

  await block(page, 'Drinks').focus();
  await page.keyboard.press('Enter');
  await expect(popup).toBeVisible();
  await expect(popup).toBeFocused();
  await tabTo(add(page, 'Can', 'Cola'));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(countOn(page, 'Can', 'Cola')).toHaveText('2');
  await expect(add(page, 'Can', 'Cola')).toBeFocused();

  await tabTo(add(page, '2L Bottle', 'Ginger Ale'));
  await page.keyboard.press('Enter');
  await tabTo(add(page, 'Dips', 'Garlic'), 'Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(cartLines(page)).toHaveCount(3);

  // Minus down to nothing keeps the focus on that tile.
  await tabTo(minus(page, 'Dips', 'Garlic'), 'Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(cartLines(page)).toHaveCount(2);
  await expect(add(page, 'Dips', 'Garlic')).toBeFocused();

  await tabTo(popup.getByRole('button', { name: 'Done' }), 'Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(popup).toBeHidden();
  await expect(block(page, 'Drinks')).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(block(page, 'Drinks')).toBeFocused();
  await expect(lineOf(page, 'Cola (Can)').getByTestId('cart-item-qty')).toHaveText('2');
  await expect(lineOf(page, 'Ginger Ale (2L Bottle)')).toBeVisible();
});

test('at iPad landscape the popup fits, nothing is clipped and every control is 48 px', async ({
  page,
}) => {
  await addLargePizza(page, 'Garden');
  await block(page, 'Dips').click();
  await add(page, 'Dips', 'Ranch').click();
  await add(page, 'Can', 'Lemon Lime').click();
  const popup = popupOf(page);
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1180);
  expect(box.y + box.height).toBeLessThanOrEqual(820);
  expect(await tooSmall(popup)).toEqual([]);
  expect(await tooSmall(blocks(page))).toEqual([]);
  expect(
    await popup.evaluate((dialog) =>
      [dialog, ...dialog.querySelectorAll('*')]
        .filter(
          (element) =>
            // Only an element that clips can hide what overflows it.
            getComputedStyle(element).overflow !== 'visible' &&
            (element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1),
        )
        .map((element) => element.textContent),
    ),
    'nothing in the popup is clipped or needs scrolling',
  ).toEqual([]);
});

test('a menu with no dips and no drinks leaves the blocks as plain categories', async ({
  page,
}) => {
  await page.route('**/api/pizza/catalog', async (route) => {
    const stored = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...stored, dips: [], drinks: [], drinkVariants: [] },
    });
  });
  await page.reload();
  await expect(blocks(page)).toBeVisible();
  await expect(block(page, 'Pizzas')).toHaveAttribute('aria-pressed', 'true');
  await expect(block(page, 'Dips')).toHaveCount(0);
  await block(page, 'Drinks').click();
  await expect(block(page, 'Drinks')).toHaveAttribute('aria-pressed', 'true');
  await expect(popupOf(page)).toHaveCount(0);
  await expect(
    page.getByTestId('pos-product-card').filter({ hasText: 'Cola' }).first(),
  ).toBeVisible();
});
