import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { clearPizzaMenu, loadSampleMenu, sampleMenu } from './helpers/pizza-menu';
import { E2E_PASSWORD, getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * The Prices section of the Pizza menu screen, against the made-up sample menu. The suite shares
 * one database, so this spec loads the menu itself, takes every price it set off again when it
 * ends, and clears the menu.
 */

const PRICES_URL = `${BASE}/api/pizza/prices`;
const LARGE = (sampleMenu().sizes as { pizza: { id: string; price: number }[] }).pizza.find(
  (size) => size.id === 'large',
)!.price;
const RAISED = LARGE + 1.5;
/** An amount as the store's currency prints it, whatever its symbol. */
const money = (amount: number) => amount.toFixed(2).replace('.', '\\.');
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });

type Prices = {
  prices: { key: string; file: number; price: number; overridden: boolean }[];
  unused: { key: string }[];
};

async function readPrices(request: APIRequestContext): Promise<Prices> {
  const res = await request.get(PRICES_URL, { headers: ownerHeaders() });
  expect(res.ok(), `reading the prices must succeed (${await res.text()})`).toBeTruthy();
  return res.json();
}

/** Takes off every price set in the POS, used or not. */
async function removeOverrides(request: APIRequestContext): Promise<void> {
  const list = await readPrices(request);
  const keys = [
    ...list.prices.filter((row) => row.overridden).map((row) => row.key),
    ...list.unused.map((entry) => entry.key),
  ];
  const res = await request.put(PRICES_URL, {
    headers: ownerHeaders(),
    data: { prices: Object.fromEntries(keys.map((key) => [key, null])) },
  });
  expect(res.ok(), `removing the overrides must succeed (${await res.text()})`).toBeTruthy();
}

async function openScreen(page: Page): Promise<Locator> {
  await loginWithPassword(page, 'owner@flo.local');
  await page.getByRole('link', { name: 'Pizza menu' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pizza menu' })).toBeVisible();
  const section = page.getByTestId('pizza-prices');
  await expect(section.getByRole('heading', { name: 'Prices' })).toBeVisible();
  return section;
}

const largeRow = (section: Locator) => section.getByTestId('pizza-price-size:large');

async function save(page: Page, section: Locator): Promise<void> {
  const saved = page.waitForResponse(
    (res) => res.url() === PRICES_URL && res.request().method() === 'PUT',
  );
  await section.getByRole('button', { name: 'Save prices' }).click();
  expect((await saved).status()).toBe(200);
  await expect(section.getByTestId('pizza-prices-preview')).toHaveCount(0);
}

test.describe('Pizza prices', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1180, height: 820 } });

  let cashier: { id: string; email: string };

  test.beforeAll(async ({ request }) => {
    await loadSampleMenu(request);
    await removeOverrides(request);
    const email = `pizza-prices-cashier-${Date.now().toString(36)}@flo.local`;
    const res = await request.post(`${BASE}/api/staff`, {
      headers: ownerHeaders(),
      data: { name: 'Pizza Prices Cashier', email, password: E2E_PASSWORD, role: 'cashier' },
    });
    expect(res.status(), `creating the cashier must succeed (${await res.text()})`).toBe(201);
    cashier = (await res.json()).staff;
  });

  test.beforeEach(async ({ page }) => {
    await setLanguage(page, 'en');
  });

  test.afterAll(async ({ request }) => {
    await request
      .post(`${BASE}/api/staff/${cashier.id}/deactivate`, { headers: ownerHeaders() })
      .catch(() => {});
    try {
      await removeOverrides(request);
      const left = await readPrices(request);
      expect(left.unused, 'no override is left behind').toEqual([]);
      expect(left.prices.filter((row) => row.overridden)).toEqual([]);
    } finally {
      await clearPizzaMenu(request);
    }
  });

  test('a new Large price is previewed, saved, shown on the POS and charged', async ({ page }) => {
    const section = await openScreen(page);
    const row = largeRow(section);
    await expect(row).toContainText(new RegExp(`${money(LARGE)}.*${money(LARGE)}`, 's'));
    await expect(section.getByTestId('pizza-prices-preview')).toHaveCount(0);

    await section.getByLabel('New price for Large', { exact: true }).fill(String(RAISED));

    const preview = section.getByTestId('pizza-prices-preview');
    await expect(preview).toContainText(
      new RegExp(
        `Large: \\D*${money(LARGE)} to \\D*${money(RAISED)}, on 5 pizzas and the half and half`,
      ),
    );
    for (const control of [
      section.getByLabel('New price for Large', { exact: true }),
      preview.getByRole('button', { name: 'Save prices' }),
    ]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    if (EVIDENCE_DIR) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, 'prices-section.png'),
        animations: 'disabled',
      });
    }

    await save(page, section);
    await expect(row).toContainText(new RegExp(`${money(LARGE)}.*${money(RAISED)}.*set here`, 's'));
    await expect(row.getByRole('button', { name: "Use the menu's price" })).toBeVisible();
    await expect(section.getByLabel('New price for Large', { exact: true })).toBeEnabled();
    if (EVIDENCE_DIR)
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, 'prices-saved.png'),
        animations: 'disabled',
      });

    // The same session, no sign-out: the POS reads the menu this screen just fetched again.
    await page.getByRole('link', { name: 'POS', exact: true }).click();
    const large = page
      .getByTestId('pizza-tile')
      .filter({ has: page.getByRole('heading', { name: 'Garden', exact: true }) })
      .getByRole('button', { name: /Large/ });
    await expect(large).toContainText(new RegExp(money(RAISED)));
    await large.click();
    await expect(page.getByTestId('cart-item').first()).toContainText(new RegExp(money(RAISED)));

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/orders',
    );
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('F4');
    const checkout = page.getByTestId('prepaid-checkout-modal');
    await expect(checkout.getByText(/Total Due/i)).toBeVisible();
    await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
    await checkout.getByRole('button', { name: /Confirm Payment/ }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const { order } = await response.json();
    expect(Number(order.subtotal), 'the order is charged the price set in the POS').toBe(RAISED);
    await checkout.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15_000 });
    await expect(checkout).toBeHidden({ timeout: 15_000 });
  });

  test('loading the menu file again keeps the price set in the POS', async ({ page, request }) => {
    await loadSampleMenu(request);

    const section = await openScreen(page);

    await expect(largeRow(section)).toContainText(
      new RegExp(`${money(LARGE)}.*${money(RAISED)}.*set here`, 's'),
    );
  });

  test('"Use the menu\'s price" puts the file\'s price back', async ({ page, request }) => {
    const section = await openScreen(page);
    const row = largeRow(section);

    await row.getByRole('button', { name: "Use the menu's price" }).click();

    await expect(section.getByTestId('pizza-prices-preview')).toContainText(
      new RegExp(`Large: \\D*${money(RAISED)} to \\D*${money(LARGE)} \\(the menu's price\\)`),
    );
    await save(page, section);
    await expect(row).not.toContainText('set here');
    await expect(row.getByRole('button', { name: "Use the menu's price" })).toHaveCount(0);
    const large = (await readPrices(request)).prices.find((entry) => entry.key === 'size:large');
    expect(large).toMatchObject({ file: LARGE, price: LARGE, overridden: false });
  });

  test('an amount that is not money cannot be saved', async ({ page }) => {
    const section = await openScreen(page);

    await section.getByLabel('New price for Large', { exact: true }).fill('23.505');

    const preview = section.getByTestId('pizza-prices-preview');
    await expect(preview).toContainText('Large: enter an amount such as 23 or 23.50');
    await expect(preview.getByRole('button', { name: 'Save prices' })).toBeDisabled();
  });

  test('a cashier does not see the section', async ({ page }) => {
    await loginWithPassword(page, cashier.email);

    await expect(page.getByRole('link', { name: 'POS', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pizza menu' })).toHaveCount(0);
    await page.goto(`${BASE}/pizza-menu`);
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/pos');
    await expect(page.getByTestId('pizza-prices')).toHaveCount(0);
  });
});
