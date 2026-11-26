import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { clearPizzaMenu, loadSampleMenu, sampleMenu } from './helpers/pizza-menu';
import { E2E_PASSWORD, getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * Quick buttons on the POS, against the made-up sample menu. Every spec shares
 * one database, so this one loads the menu itself, deletes every button it
 * saves, switches off the cashier it creates, and clears the menu when it ends.
 */

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });
const BUTTONS = `${BASE}/api/pizza/quick-buttons`;

const menu = sampleMenu();
const itemsOf = (categoryId: string) =>
  menu.categories.find((category) => category.id === categoryId)!.items;
const LARGE = (menu.sizes as { pizza: { id: string; price: number }[] }).pizza.find(
  (size) => size.id === 'large',
)!.price;
const DIP = itemsOf('sides').find((side) => side.id === 'dip')!.price!;
const TOAST = itemsOf('sides').find((side) => side.id === 'garlic-toast')!.price!;
const money = (amount: number) => new RegExp(amount.toFixed(2).replace('.', '\\.'));

/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
const RUN = Date.now();
/** Made-up people on numbers from the range kept for fiction. */
const CASEY = { id: '', name: 'Casey Example', phone: `+1604555${String(RUN).slice(-4)}` };
const ROBIN = {
  id: '',
  name: 'Robin Placeholder',
  phone: `+1604555${String((RUN + 1) % 10_000).padStart(4, '0')}`,
};
const cashier = { id: '', email: `quick-buttons-cashier-${RUN.toString(36)}@flo.local` };

const GARDEN = { product_id: 'pz-garden', variant_id: 'pz-garden-large' };
const ISLAND = { product_id: 'pz-island', variant_id: 'pz-island-large' };
const GARLIC_TOAST = { product_id: 'sd-garlic-toast' };

type Saved = { id: string; label: string; recipe: unknown; customer_id: string | null };

async function withApi<T>(run: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await playwrightRequest.newContext();
  try {
    return await run(api);
  } finally {
    await api.dispose();
  }
}

/** Saves a button through the API, as the owner. */
const seedButton = (label: string, color: string, contents: object, customerId?: string) =>
  withApi(async (api) => {
    const response = await api.post(BUTTONS, {
      headers: ownerHeaders(),
      data: { label, color, ...contents, ...(customerId ? { customer_id: customerId } : {}) },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).button as Saved;
  });

/** The shop-wide buttons, then those of each customer this spec made. */
const listButtons = (api: APIRequestContext) =>
  Promise.all(
    ['', CASEY.id, ROBIN.id].map(async (customerId) => {
      const response = await api.get(BUTTONS, {
        headers: ownerHeaders(),
        params: customerId ? { customer_id: customerId } : {},
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const { buttons } = (await response.json()) as { buttons: Saved[] };
      return buttons.filter((button) => (button.customer_id ?? '') === customerId);
    }),
  ).then((lists) => lists.flat());

const deleteEveryButton = () =>
  withApi(async (api) => {
    for (const button of await listButtons(api)) {
      const response = await api.delete(`${BUTTONS}/${button.id}`, { headers: ownerHeaders() });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
  });

test.beforeAll(async () => {
  await withApi(async (api) => {
    await loadSampleMenu(api);
    // Shop-wide buttons a crashed earlier run left behind would throw the counts off.
    const left = await api.get(BUTTONS, { headers: ownerHeaders() });
    for (const button of ((await left.json()) as { buttons: Saved[] }).buttons)
      await api.delete(`${BUTTONS}/${button.id}`, { headers: ownerHeaders() });
    for (const customer of [CASEY, ROBIN]) {
      const response = await api.post(`${BASE}/api/customers`, {
        headers: ownerHeaders(),
        data: { name: customer.name, phone: customer.phone },
      });
      expect(response.status(), await response.text()).toBe(201);
      customer.id = (await response.json()).customer.id;
    }
    const staff = await api.post(`${BASE}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Quick Buttons Cashier',
        email: cashier.email,
        password: E2E_PASSWORD,
        role: 'cashier',
      },
    });
    expect(staff.status(), await staff.text()).toBe(201);
    cashier.id = (await staff.json()).staff.id;
  });
});

test.afterEach(deleteEveryButton);

test.afterAll(async () => {
  await withApi(async (api) => {
    try {
      await deleteEveryButton();
      if (cashier.id)
        await api.post(`${BASE}/api/staff/${cashier.id}/deactivate`, { headers: ownerHeaders() });
    } finally {
      // The API has no route that deletes a customer, so the two made-up customers stay.
      await clearPizzaMenu(api);
    }
  });
});

async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, name), animations: 'disabled' });
}

async function openPos(page: Page, email = 'owner@flo.local'): Promise<void> {
  // A cashier may not change the language, so it is set as the owner before anyone signs in.
  await setLanguage(page, 'en');
  await loginWithPassword(page, email);
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
  await page.getByRole('button', { name: 'Takeaway' }).click();
}

const block = (page: Page): Locator =>
  page.getByTestId('pizza-category-blocks').getByRole('button', { name: /^Quick Buttons/ });
const quickPage = (page: Page): Locator => page.getByTestId('quick-buttons-page');
const shopSection = (page: Page): Locator =>
  quickPage(page).getByRole('group', { name: 'Shop-wide' });
const favouritesRow = (page: Page): Locator => page.getByTestId('quick-favourites');
/** A button's tile, found by its label. */
const tileOf = (scope: Locator, label: string): Locator =>
  scope
    .getByTestId('quick-button')
    .filter({ has: scope.page().getByText(label, { exact: true }) })
    .first();
const addOf = (tile: Locator): Locator => tile.getByTestId('quick-button-add');
const menuOf = (tile: Locator): Locator => tile.getByRole('button', { name: /^Edit or delete/ });
const saveDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Save as quick button' });
const pizzaSheet = (page: Page): Locator => page.getByRole('dialog', { name: 'Pizza' });
const cartLines = (page: Page): Locator => page.getByTestId('cart-item');
const details = (line: Locator): Locator => line.getByTestId('pizza-line-detail');
const quantity = (line: Locator): Locator => line.getByTestId('pizza-line-quantity');
const pizzaTile = (page: Page, name: string): Locator =>
  page.getByTestId('pizza-tile').filter({ has: page.getByRole('heading', { name, exact: true }) });
const saveAction = (scope: Locator): Locator =>
  scope.getByRole('button', { name: 'Save as quick button' });

async function openQuickPage(page: Page): Promise<void> {
  await block(page).click();
  await expect(quickPage(page)).toBeVisible();
}

/** Picks an entry of a button's `⋯` menu. */
async function pick(page: Page, tile: Locator, entry: string): Promise<void> {
  await menuOf(tile).click();
  await page.getByRole('menuitem', { name: entry }).click();
}

/** A large half and half, Garden without olives and Classic Pepperoni, with a garlic dip. */
async function addHalfAndHalf(page: Page): Promise<Locator> {
  await page.getByTestId('pizza-half-tile').getByRole('button', { name: /Large/ }).click();
  const sheet = pizzaSheet(page);
  const first = sheet.getByRole('group', { name: '1st half' });
  await first.getByRole('button', { name: 'Garden' }).click();
  await first.getByRole('button', { name: 'Olives', exact: true }).click();
  await sheet
    .getByRole('group', { name: '2nd half' })
    .getByRole('button', { name: 'Classic Pepperoni' })
    .click();
  await sheet.getByRole('button', { name: 'One more Garlic' }).click();
  await sheet.getByRole('button', { name: /^Add to order/ }).click();
  await expect(sheet).toBeHidden();
  await expect(cartLines(page)).toHaveCount(1);
  return cartLines(page).first();
}

/** Fills the save dialog and saves. */
async function saveAs(page: Page, label: string, colour: string, showFor?: string): Promise<void> {
  const dialog = saveDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Label on the button').fill(label);
  await dialog
    .getByRole('group', { name: 'Colour' })
    .getByRole('button', { name: colour, exact: true })
    .click();
  if (showFor)
    await dialog
      .getByRole('group', { name: 'Show for' })
      .getByRole('button', { name: showFor })
      .click();
  await dialog.getByRole('button', { name: 'Save button' }).click();
  await expect(dialog).toBeHidden();
}

/** The phone lookup: the number is this run's own, so it finds this run's customer. */
async function attachCustomer(page: Page, customer: { name: string; phone: string }) {
  await page.getByTestId('pos-customer-search-input').first().fill(customer.phone);
  await page.getByRole('button').filter({ hasText: customer.name }).first().click();
  await expect(page.getByTestId('pos-customer-select-btn').first()).toContainText(customer.name);
}

/** The controls of `scope` under 48 px either way, measured once it has stopped animating. */
async function tooSmall(scope: Locator): Promise<(string | null)[]> {
  await scope.evaluate((root) =>
    Promise.all(root.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  return scope.locator('button, input, select').evaluateAll((controls) =>
    controls
      .map((control) => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 48 || box.height < 48)
      .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
  );
}
const clipped = (scope: Locator) =>
  scope.evaluate((root) =>
    [...root.querySelectorAll('*')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent),
  );

test('the block shows how many are saved and opens the page in place of the grid', async ({
  page,
}) => {
  await seedButton('LG GARDEN', 'green', GARDEN);
  await seedButton('GARLIC TOAST', 'teal', GARLIC_TOAST);
  await openPos(page);

  await expect(block(page)).toContainText('2 saved');
  await expect(block(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('pizza-tile')).toHaveCount(itemsOf('pizzas').length);
  await expect(quickPage(page)).toHaveCount(0);

  await openQuickPage(page);
  await expect(block(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pizza-tile')).toHaveCount(0);
  await expect(page.getByTestId('pos-product-card')).toHaveCount(0);
  const tiles = shopSection(page).getByTestId('quick-button');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toContainText('LG GARDEN');
  await expect(tiles.nth(0)).toContainText('Garden (Large)');
  await expect(tiles.nth(0)).toContainText(money(LARGE));
  await expect(tiles.nth(0)).toHaveAttribute('data-color', 'green');
  await expect(tiles.nth(1)).toContainText('GARLIC TOAST');
  await expect(tiles.nth(1)).toContainText(money(TOAST));
  await expect(tiles.nth(1)).toHaveAttribute('data-color', 'teal');

  await page.getByTestId('pizza-category-blocks').getByRole('button', { name: 'Pizzas' }).click();
  await expect(quickPage(page)).toHaveCount(0);
  await expect(page.getByTestId('pizza-tile')).toHaveCount(itemsOf('pizzas').length);
});

test('a half and half is saved from its cart line for the shop, with a label and a colour', async ({
  page,
}) => {
  await openPos(page);
  await expect(block(page)).toContainText('0 saved');
  const line = await addHalfAndHalf(page);

  await saveAction(line).click();
  const dialog = saveDialog(page);
  await expect(dialog.getByTestId('quick-button-adds')).toContainText('Half & Half (Large)');
  await expect(dialog.getByTestId('quick-button-adds').getByTestId('pizza-line-detail')).toHaveText(
    ['1ST: GARDEN', 'NO OLIVES', '2ND: CLASSIC PEPPERONI'],
  );
  await expect(dialog.getByTestId('quick-button-adds')).toContainText(money(LARGE + DIP));
  // With no customer on the order the button can only be for the shop.
  await expect(dialog.getByRole('group', { name: 'Show for' }).getByRole('button')).toHaveText([
    'Everyone (shop-wide)',
  ]);
  await expect(dialog.getByRole('button', { name: 'Save button' })).toBeEnabled();
  await dialog.getByLabel('Label on the button').fill('');
  await expect(dialog.getByRole('button', { name: 'Save button' })).toBeDisabled();
  await saveAs(page, 'LG GARDEN / PEP', 'Green');

  // Saving a button leaves the order as it was.
  await expect(cartLines(page)).toHaveCount(1);
  await expect(block(page)).toContainText('1 saved');
  await openQuickPage(page);
  const tile = tileOf(shopSection(page), 'LG GARDEN / PEP');
  await expect(tile).toHaveAttribute('data-color', 'green');
  await expect(tile).toContainText('1ST: GARDEN · NO OLIVES · 2ND: CLASSIC PEPPERONI');
  await expect(tile).toContainText('+ Garlic');
  await expect(tile).toContainText(money(LARGE + DIP));
});

test('a tap adds the line the button was saved from, and a second tap makes it 2x', async ({
  page,
}) => {
  await openPos(page);
  const line = await addHalfAndHalf(page);
  await saveAction(line).click();
  await saveAs(page, 'LG GARDEN / PEP', 'Orange');
  const savedFrom = await line.innerText();
  await line.getByTestId('cart-item-remove-btn').click();
  await expect(cartLines(page)).toHaveCount(0);

  await openQuickPage(page);
  const add = addOf(tileOf(shopSection(page), 'LG GARDEN / PEP'));
  await add.click();
  await expect(cartLines(page)).toHaveCount(1);
  expect(await cartLines(page).first().innerText()).toBe(savedFrom);
  await expect(details(cartLines(page).first())).toHaveText([
    '1ST: GARDEN',
    'NO OLIVES',
    '2ND: CLASSIC PEPPERONI',
  ]);

  await add.click();
  await expect(cartLines(page)).toHaveCount(1);
  await expect(quantity(cartLines(page).first())).toHaveText('2');
  await expect(cartLines(page).first()).toContainText(money((LARGE + DIP) * 2));
});

test('the sheet saves what it holds as a button without adding it to the order', async ({
  page,
}) => {
  await openPos(page);
  await pizzaTile(page, 'Island').getByRole('button', { name: 'Customize Island' }).click();
  const sheet = pizzaSheet(page);
  // Until the sheet holds a whole pizza there is nothing to save.
  await expect(saveAction(sheet)).toHaveCount(0);
  await sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Large/ }).click();
  await sheet.getByRole('button', { name: 'Pineapple', exact: true }).click();
  await sheet
    .getByRole('group', { name: 'Cook' })
    .getByRole('button', { name: 'Well done' })
    .click();

  await saveAction(sheet).click();
  await expect(saveDialog(page).getByTestId('quick-button-adds')).toContainText('Island (Large)');
  await expect(
    saveDialog(page).getByTestId('quick-button-adds').getByTestId('pizza-line-detail'),
  ).toHaveText(['NO PINEAPPLE', 'WELL DONE']);
  await saveAs(page, 'ISLAND NO PINE WD', 'Amber');

  // The sheet is still open on the pizza, and the order is still empty.
  await expect(sheet).toBeVisible();
  await expect(saveAction(sheet)).toBeFocused();
  await expect(cartLines(page)).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  await expect(cartLines(page)).toHaveCount(0);

  await openQuickPage(page);
  const tile = tileOf(shopSection(page), 'ISLAND NO PINE WD');
  await expect(tile).toContainText('Island (Large) · NO PINEAPPLE · WELL DONE');
  await expect(tile).toContainText(money(LARGE));
  await addOf(tile).click();
  await expect(details(cartLines(page).first())).toHaveText(['NO PINEAPPLE', 'WELL DONE']);
});

test('a button is relabelled and recoloured from its menu', async ({ page }) => {
  await seedButton('LG GARDEN', 'green', GARDEN);
  await openPos(page);
  await openQuickPage(page);

  await pick(page, tileOf(shopSection(page), 'LG GARDEN'), 'Edit label & colour');
  const dialog = page.getByRole('dialog', { name: 'Edit label & colour' });
  await expect(dialog.getByLabel('Label on the button')).toHaveValue('LG GARDEN');
  const colours = dialog.getByRole('group', { name: 'Colour' });
  await expect(colours.getByRole('button', { name: 'Green', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByLabel('Label on the button').fill('GARDEN LARGE');
  await colours.getByRole('button', { name: 'Sky', exact: true }).click();
  await expect(colours.getByRole('button', { name: 'Sky', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const tile = tileOf(shopSection(page), 'GARDEN LARGE');
  await expect(tile).toHaveAttribute('data-color', 'sky');
  await expect(tile).toContainText('Garden (Large)');
  await expect(shopSection(page).getByTestId('quick-button')).toHaveCount(1);
  await expect(menuOf(tile)).toBeFocused();
});

test('"Edit the item" opens a pizza button in the sheet and saves the button, not the order', async ({
  page,
}) => {
  const garden = await seedButton('LG GARDEN', 'green', GARDEN);
  await seedButton('GARLIC TOAST', 'teal', GARLIC_TOAST);
  await openPos(page);
  await openQuickPage(page);

  // Only a pizza opens in the pizza sheet.
  await menuOf(tileOf(shopSection(page), 'GARLIC TOAST')).click();
  await expect(page.getByRole('menuitem', { name: 'Edit label & colour' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit the item' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The order holds the same pizza, which the button's edit must leave alone.
  await addOf(tileOf(shopSection(page), 'LG GARDEN')).click();
  await expect(cartLines(page)).toHaveCount(1);

  await pick(page, tileOf(shopSection(page), 'LG GARDEN'), 'Edit the item');
  const sheet = pizzaSheet(page);
  await expect(
    sheet.getByRole('group', { name: 'Size' }).getByRole('button', { name: /Large/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(saveAction(sheet)).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Olives', exact: true }).click();
  await sheet.getByRole('button', { name: /^Save/ }).click();
  await expect(sheet).toBeHidden();

  await expect(tileOf(shopSection(page), 'LG GARDEN')).toContainText('Garden (Large) · NO OLIVES');
  await expect(cartLines(page)).toHaveCount(1);
  await expect(details(cartLines(page).first())).toHaveCount(0);
  await expect(quantity(cartLines(page).first())).toHaveText('1');
  const stored = await withApi(listButtons);
  expect(stored.find((button) => button.id === garden.id)!.recipe).toEqual({
    kind: 'pizza',
    v: 1,
    sizeId: 'large',
    whole: { pizzaId: 'garden', removed: ['Olives'] },
  });
});

test('a button is deleted only after the confirm', async ({ page }) => {
  await seedButton('LG GARDEN', 'green', GARDEN);
  await seedButton('GARLIC TOAST', 'teal', GARLIC_TOAST);
  await openPos(page);
  await openQuickPage(page);

  await pick(page, tileOf(shopSection(page), 'LG GARDEN'), 'Delete button');
  const confirm = page.getByRole('dialog', { name: 'Delete LG GARDEN?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(shopSection(page).getByTestId('quick-button')).toHaveCount(2);

  await pick(page, tileOf(shopSection(page), 'LG GARDEN'), 'Delete button');
  await confirm.getByRole('button', { name: 'Delete button' }).click();
  await expect(confirm).toBeHidden();
  await expect(shopSection(page).getByTestId('quick-button')).toHaveCount(1);
  await expect(shopSection(page)).not.toContainText('LG GARDEN');
  await expect(block(page)).toContainText('1 saved');
});

test("a customer's favourite shows in a row on the POS home, and not for another customer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await seedButton('LG GARDEN', 'green', GARDEN);
  await seedButton('LG ISLAND', 'red', ISLAND);
  await seedButton('GARLIC TOAST', 'teal', GARLIC_TOAST);
  await openPos(page);
  await expect(favouritesRow(page)).toHaveCount(0);
  await attachCustomer(page, CASEY);
  await expect(favouritesRow(page)).toHaveCount(0);

  const line = await addHalfAndHalf(page);
  await saveAction(line).click();
  const showFor = saveDialog(page).getByRole('group', { name: 'Show for' });
  await expect(showFor.getByRole('button')).toHaveText([
    'Everyone (shop-wide)',
    `${CASEY.name} only`,
  ]);
  expect(await tooSmall(saveDialog(page))).toEqual([]);
  expect(await clipped(saveDialog(page))).toEqual([]);
  await saveDialog(page).getByLabel('Label on the button').fill("CASEY'S USUAL");
  await showFor.getByRole('button', { name: `${CASEY.name} only` }).click();
  await shot(page, 'quick-buttons-save-dialog.png');
  await saveAs(page, "CASEY'S USUAL", 'Violet', `${CASEY.name} only`);

  // The home: one row above the pizzas, and a tap adds the favourite.
  const row = favouritesRow(page);
  await expect(row).toContainText(`${CASEY.name}'s favourites`);
  await expect(row.getByTestId('quick-button')).toHaveCount(1);
  await expect(page.getByTestId('pizza-tile')).toHaveCount(itemsOf('pizzas').length);
  await addOf(tileOf(row, "CASEY'S USUAL")).click();
  await expect(quantity(cartLines(page).first())).toHaveText('2');
  expect(await tooSmall(row)).toEqual([]);
  await shot(page, 'quick-buttons-pos-home-favourites.png');
  // A favourite is not one of the shop's buttons.
  await expect(block(page)).toContainText('3 saved');

  // The page: the customer's section on top, with a tile that saves from the order.
  await openQuickPage(page);
  await expect(favouritesRow(page)).toHaveCount(0);
  const theirs = quickPage(page).getByRole('group', { name: `${CASEY.name}'s favourites` });
  await expect(theirs.getByTestId('quick-button')).toHaveCount(1);
  await expect(shopSection(page).getByTestId('quick-button')).toHaveCount(3);
  await pizzaTileFreeAdd(page);
  await theirs
    .getByRole('button', { name: `Save an item from the order for ${CASEY.name}` })
    .click();
  await expect(
    saveDialog(page)
      .getByRole('group', { name: 'Show for' })
      .getByRole('button', { pressed: true }),
  ).toHaveText(`${CASEY.name} only`);
  await saveDialog(page).getByLabel('Item from the order').selectOption({ label: 'Garlic Toast' });
  await expect(saveDialog(page).getByTestId('quick-button-adds')).toContainText('Garlic Toast');
  await saveAs(page, 'CASEY TOAST', 'Teal');
  await expect(theirs.getByTestId('quick-button')).toHaveCount(2);
  await expect(tileOf(theirs, 'CASEY TOAST')).toContainText(money(TOAST));
  expect(await tooSmall(quickPage(page))).toEqual([]);
  expect(await clipped(quickPage(page))).toEqual([]);
  await shot(page, 'quick-buttons-page.png');

  // Another customer has none of them.
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(quickPage(page).getByRole('group', { name: /favourites$/ })).toHaveCount(0);
  await attachCustomer(page, ROBIN);
  const others = quickPage(page).getByRole('group', { name: `${ROBIN.name}'s favourites` });
  await expect(others).toBeVisible();
  await expect(others.getByTestId('quick-button')).toHaveCount(0);
  await page.getByTestId('pizza-category-blocks').getByRole('button', { name: 'Pizzas' }).click();
  await expect(page.getByTestId('pizza-tile')).toHaveCount(itemsOf('pizzas').length);
  await expect(favouritesRow(page)).toHaveCount(0);
});

/** Adds a Garlic Toast through the Sides category and comes back to the quick buttons page. */
async function pizzaTileFreeAdd(page: Page): Promise<void> {
  const blocks = page.getByTestId('pizza-category-blocks');
  await blocks.getByRole('button', { name: 'Sides' }).click();
  await page.getByTestId('pos-product-card').filter({ hasText: 'Garlic Toast' }).click();
  await expect(cartLines(page)).toHaveCount(2);
  await openQuickPage(page);
}

test('a button whose pizza left the menu is greyed with the reason and cannot be added', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await seedButton('LG GARDEN', 'green', GARDEN);
  await seedButton('LG ISLAND', 'red', ISLAND);
  const edited = sampleMenu();
  const pizzas = edited.categories.find((category) => category.id === 'pizzas')!;
  pizzas.items = pizzas.items.filter((pizza) => pizza.id !== 'garden');
  try {
    await withApi((api) => loadSampleMenu(api, edited));
    await openPos(page);
    await openQuickPage(page);

    const stale = tileOf(shopSection(page), 'LG GARDEN');
    await expect(stale).toHaveAttribute('data-usable', 'false');
    await expect(stale).toContainText('Garden is not on the menu. Pick another item');
    // It cannot be added, and the keyboard still reaches it and its reason.
    await expect(addOf(stale)).toHaveAttribute('aria-disabled', 'true');
    await addOf(stale).focus();
    await expect(addOf(stale)).toBeFocused();
    await page.keyboard.press('Enter');
    await addOf(stale).click({ force: true });
    await expect(cartLines(page)).toHaveCount(0);
    await shot(page, 'quick-buttons-stale.png');

    // It can still be edited or deleted.
    await menuOf(stale).click();
    await expect(page.getByRole('menuitem')).toHaveText([
      'Edit label & colour',
      'Edit the item',
      'Delete button',
    ]);
    await page.keyboard.press('Escape');

    const island = tileOf(shopSection(page), 'LG ISLAND');
    await expect(island).toHaveAttribute('data-usable', 'true');
    await addOf(island).click();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(cartLines(page).first()).toContainText('Island (Large)');
  } finally {
    await withApi((api) => loadSampleMenu(api));
  }
});

test('a deal is saved from its cart line and a tap adds it with the same choices', async ({
  page,
}) => {
  const deal = itemsOf('deals').find((entry) => entry.id === 'three-large-wings')!;
  const name = deal.name as string;
  await openPos(page);
  await page.getByTestId('pizza-category-blocks').getByRole('button', { name: 'Deals' }).click();
  await page.getByTestId('pos-product-card').filter({ hasText: name }).click();
  const dialog = page.getByRole('dialog', { name });
  const panel = dialog.getByRole('tabpanel');
  const whole = (pizza: string) =>
    panel.getByRole('group', { name: 'Whole pizza' }).getByRole('button', { name: pizza });
  await whole('Garden').click();
  await panel.getByRole('button', { name: 'Olives', exact: true }).click();
  await dialog.getByRole('button', { name: 'Next: Pizza 2' }).click();
  await whole('Island').click();
  await dialog.getByRole('button', { name: 'Next: Pizza 3' }).click();
  await whole('Classic Pepperoni').click();
  await dialog.getByRole('button', { name: 'Next: Wing flavour' }).click();
  await panel.getByRole('button', { name: 'Sweet Chili' }).click();
  await dialog.getByTestId('deal-add').click();
  await expect(dialog).toBeHidden();
  await expect(cartLines(page)).toHaveCount(1);

  const line = cartLines(page).first();
  const lines = await details(line).allTextContents();
  expect(lines.length).toBeGreaterThan(3);
  await saveAction(line).click();
  await expect(
    saveDialog(page).getByTestId('quick-button-adds').getByTestId('pizza-line-detail'),
  ).toHaveText(lines);
  await saveAs(page, '3 LG + WINGS', 'Violet');
  const savedFrom = await line.innerText();
  await line.getByTestId('cart-item-remove-btn').click();
  await expect(cartLines(page)).toHaveCount(0);

  await openQuickPage(page);
  const tile = tileOf(shopSection(page), '3 LG + WINGS');
  await expect(tile).toContainText(money(deal.price!));
  await addOf(tile).click();
  await expect(cartLines(page)).toHaveCount(1);
  expect(await cartLines(page).first().innerText()).toBe(savedFrom);
  await expect(details(cartLines(page).first())).toHaveText(lines);
  await addOf(tile).click();
  await expect(quantity(cartLines(page).first())).toHaveText('2');

  // A deal button is relabelled and deleted like any other; the pizza sheet cannot open it.
  await menuOf(tile).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Edit label & colour', 'Delete button']);
  await page.keyboard.press('Escape');
});

test("a cashier adds buttons and manages a customer's, and cannot change the shop's", async ({
  page,
}) => {
  await seedButton('LG GARDEN', 'green', GARDEN);
  await seedButton("CASEY'S USUAL", 'violet', ISLAND, CASEY.id);
  await openPos(page, cashier.email);
  await openQuickPage(page);

  // A shop-wide button: a tap adds it, and it has no menu.
  const shop = tileOf(shopSection(page), 'LG GARDEN');
  await addOf(shop).click();
  await expect(cartLines(page)).toHaveCount(1);
  await expect(menuOf(shop)).toHaveCount(0);
  // With no customer on the order there is nobody the cashier may save a button for.
  await expect(saveAction(cartLines(page).first())).toHaveCount(0);
  await page.getByTestId('pizza-category-blocks').getByRole('button', { name: 'Pizzas' }).click();
  await pizzaTile(page, 'Island').getByRole('button', { name: 'Customize Island' }).click();
  await pizzaSheet(page)
    .getByRole('group', { name: 'Size' })
    .getByRole('button', { name: /Large/ })
    .click();
  await expect(pizzaSheet(page).getByRole('button', { name: /^Add to order/ })).toBeEnabled();
  await expect(saveAction(pizzaSheet(page))).toHaveCount(0);
  await pizzaSheet(page).getByRole('button', { name: 'Close' }).click();

  // With a customer: their buttons can be added, saved, changed and deleted.
  await attachCustomer(page, CASEY);
  await addOf(tileOf(favouritesRow(page), "CASEY'S USUAL")).click();
  await expect(cartLines(page)).toHaveCount(2);
  await saveAction(cartLines(page).first()).click();
  await expect(
    saveDialog(page).getByRole('group', { name: 'Show for' }).getByRole('button'),
  ).toHaveText([`${CASEY.name} only`]);
  await saveAs(page, 'CASEY GARDEN', 'Lime');
  await expect(favouritesRow(page).getByTestId('quick-button')).toHaveCount(2);

  await openQuickPage(page);
  const theirs = quickPage(page).getByRole('group', { name: `${CASEY.name}'s favourites` });
  await pick(page, tileOf(theirs, 'CASEY GARDEN'), 'Edit label & colour');
  const edit = page.getByRole('dialog', { name: 'Edit label & colour' });
  await edit.getByLabel('Label on the button').fill('CASEY LG GARDEN');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tileOf(theirs, 'CASEY LG GARDEN')).toBeVisible();
  await pick(page, tileOf(theirs, "CASEY'S USUAL"), 'Delete button');
  await page
    .getByRole('dialog', { name: "Delete CASEY'S USUAL?" })
    .getByRole('button', { name: 'Delete button' })
    .click();
  await expect(theirs.getByTestId('quick-button')).toHaveCount(1);
  await expect(menuOf(tileOf(shopSection(page), 'LG GARDEN'))).toHaveCount(0);

  // The server refuses what the screen does not offer, in its own words.
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const refused = await page.request.post(BUTTONS, {
    headers: { Authorization: `Bearer ${token}` },
    data: { label: 'NOT ALLOWED', color: 'red', ...GARDEN },
  });
  expect(refused.status()).toBe(403);
});

test('a refusal from the server shows its message', async ({ page }) => {
  await seedButton('LG GARDEN', 'green', GARDEN);
  await openPos(page);
  await openQuickPage(page);
  await page.route('**/api/pizza/quick-buttons/*', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, json: { error: 'Pick a colour for this button' } })
      : route.continue(),
  );
  await pick(page, tileOf(shopSection(page), 'LG GARDEN'), 'Edit label & colour');
  const dialog = page.getByRole('dialog', { name: 'Edit label & colour' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Pick a colour for this button')).toBeVisible();
  // The dialog stays open on what was typed.
  await expect(dialog).toBeVisible();
});

test('quick buttons work with the keyboard only', async ({ page }) => {
  await seedButton('LG GARDEN', 'green', GARDEN);
  await openPos(page);
  /** Tabs forward until `target` has the focus, staying inside `within` when one is given. */
  const tabTo = async (target: Locator, within?: Locator) => {
    for (let presses = 0; presses < 80; presses += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) return;
      await page.keyboard.press('Tab');
      if (within)
        expect(
          await within.evaluate((dialog) => dialog.contains(document.activeElement)),
          'the focus stays inside the dialog',
        ).toBe(true);
    }
    throw new Error('Tab never reached the control');
  };

  // Open the page and add the button.
  await block(page).focus();
  await page.keyboard.press('Enter');
  await expect(quickPage(page)).toBeVisible();
  const tile = tileOf(shopSection(page), 'LG GARDEN');
  await tabTo(addOf(tile));
  await page.keyboard.press('Enter');
  await expect(cartLines(page)).toHaveCount(1);
  await expect(cartLines(page).first()).toContainText('Garden (Large)');

  // The menu, and the label dialog: Escape closes it and gives the focus back.
  await page.keyboard.press('Tab');
  await expect(menuOf(tile)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Edit label & colour' })).toBeFocused();
  await page.keyboard.press('Enter');
  const edit = page.getByRole('dialog', { name: 'Edit label & colour' });
  await expect(edit.getByLabel('Label on the button')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(edit).toBeHidden();
  await expect(menuOf(tile)).toBeFocused();

  // Rename and recolour without the mouse.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(edit.getByLabel('Label on the button')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('GARDEN LG');
  const sky = edit.getByRole('group', { name: 'Colour' }).getByRole('button', {
    name: 'Sky',
    exact: true,
  });
  await tabTo(sky, edit);
  await page.keyboard.press('Space');
  await expect(sky).toHaveAttribute('aria-pressed', 'true');
  await tabTo(edit.getByRole('button', { name: 'Save', exact: true }), edit);
  await page.keyboard.press('Enter');
  await expect(edit).toBeHidden();
  const renamed = tileOf(shopSection(page), 'GARDEN LG');
  await expect(renamed).toHaveAttribute('data-color', 'sky');
  await expect(menuOf(renamed)).toBeFocused();

  // Save a button from the cart line: Enter in the label field saves.
  const action = saveAction(cartLines(page).first());
  await action.focus();
  await page.keyboard.press('Enter');
  const save = saveDialog(page);
  await expect(save.getByLabel('Label on the button')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(save).toBeHidden();
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SECOND GARDEN');
  await page.keyboard.press('Enter');
  await expect(save).toBeHidden();
  await expect(action).toBeFocused();
  await expect(shopSection(page).getByTestId('quick-button')).toHaveCount(2);

  // Delete with the confirm.
  await menuOf(renamed).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Delete button' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: 'Delete GARDEN LG?' });
  await tabTo(confirm.getByRole('button', { name: 'Delete button' }), confirm);
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(shopSection(page).getByTestId('quick-button')).toHaveCount(1);
  // The button that opened the confirm is gone, so the page's block takes the focus.
  await expect(block(page)).toBeFocused();
});
