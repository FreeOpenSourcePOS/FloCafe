import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import {
  clearPizzaMenu,
  loadSampleMenu,
  sampleMenu,
  type SampleMenu as Menu,
} from './helpers/pizza-menu';

const SAMPLE = sampleMenu();
const IMPORT_URL = `${BASE}/api/pizza/menu/import`;
// Catalogue rows the sample maps to, the stored menu record included.
const SAMPLE_ROWS = 78;
const SAMPLE_COUNTS = ['5 pizzas', '3 sizes', '2 dips', '5 sides', '3 drinks', '4 deals'];
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });

function copyOf(edit: (menu: Menu) => void): Menu {
  const menu = sampleMenu();
  edit(menu);
  return menu;
}

const itemsOf = (menu: Menu, id: string) =>
  menu.categories.find((category) => category.id === id)!.items;

async function openScreen(page: Page): Promise<void> {
  await loginWithPassword(page, 'owner@flo.local');
  await page.getByRole('link', { name: 'Pizza menu' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pizza menu' })).toBeVisible();
}

const fileInput = (page: Page) => page.getByLabel('Menu file (.json)');

async function chooseFile(page: Page, name: string, content: Menu | string): Promise<void> {
  await fileInput(page).setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
  });
}

async function loadThroughScreen(page: Page, name: string, menu: Menu): Promise<void> {
  await chooseFile(page, name, menu);
  await page.getByRole('button', { name: 'Load this menu' }).click();
}

async function expectLoaded(page: Page, counts: string[]): Promise<void> {
  for (const count of counts) {
    await expect(page.getByTestId('pizza-menu-loaded')).toContainText(count);
  }
}

async function evidence(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

test.describe('Pizza menu screen', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  let cashier: { id: string; email: string };

  test.beforeAll(async ({ request }) => {
    const email = `pizza-menu-cashier-${Date.now().toString(36)}@flo.local`;
    const res = await request.post(`${BASE}/api/staff`, {
      headers: ownerHeaders(),
      data: { name: 'Pizza Menu Cashier', email, password: E2E_PASSWORD, role: 'cashier' },
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
    await clearPizzaMenu(request);
  });

  test('says so when no menu is loaded', async ({ page }) => {
    // A menu cannot be unloaded and the suite shares one server, so the server's "none" is replayed.
    await page.route('**/api/pizza/catalog', (route) =>
      route.fulfill({ status: 404, json: { error: 'No menu has been loaded' } }),
    );

    await openScreen(page);

    await expect(page.getByTestId('pizza-menu-loaded')).toContainText('No pizza menu is loaded');
  });

  test('loads the sample after a confirm step and shows what is loaded', async ({ page }) => {
    await openScreen(page);
    await chooseFile(page, 'sample-menu.json', SAMPLE);

    const confirm = page.getByTestId('pizza-menu-confirm');
    await expect(confirm).toContainText('sample-menu.json');
    for (const line of [
      'The file is the master copy',
      'Names, prices and which items are on sale follow the file',
      'switched off, not deleted',
      'in the product screen are overwritten',
    ]) {
      await expect(confirm).toContainText(line);
    }
    const confirmButton = confirm.getByRole('button', { name: 'Load this menu' });
    for (const control of [
      fileInput(page),
      confirmButton,
      confirm.getByRole('button', { name: 'Cancel' }),
    ]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    await evidence(page, 'confirm-step.png');

    // The confirm button is the next stop after the file control, and Enter presses it.
    const answered = page.waitForResponse((res) => res.url() === IMPORT_URL);
    await fileInput(page).focus();
    await page.keyboard.press('Tab');
    await expect(confirmButton).toBeFocused();
    await page.keyboard.press('Enter');
    const summary = await (await answered).json();

    expect(summary.created + summary.updated + summary.unchanged).toBe(SAMPLE_ROWS);
    await expect(page.getByTestId('pizza-menu-result')).toContainText(
      `${summary.created} added, ${summary.updated} changed, ${summary.unchanged} unchanged, ${summary.deactivated} switched off`,
    );
    const untaxed = page.getByTestId('pizza-menu-untaxed');
    if (summary.untaxed) await expect(untaxed).toContainText('"food" and "soda"');
    else await expect(untaxed).toHaveCount(0);
    await expect(confirm).toBeHidden();
    await expectLoaded(page, SAMPLE_COUNTS);
    await evidence(page, 'menu-loaded.png');
  });

  test('loading the same file again changes nothing', async ({ page }) => {
    await loadSampleMenu(page.request);
    await openScreen(page);

    await loadThroughScreen(page, 'sample-menu.json', SAMPLE);

    await expect(page.getByTestId('pizza-menu-result')).toContainText(
      `0 added, 0 changed, ${SAMPLE_ROWS} unchanged, 0 switched off`,
    );
  });

  test('a removed pizza is switched off and a changed price is counted', async ({ page }) => {
    await loadSampleMenu(page.request);
    await openScreen(page);

    await loadThroughScreen(
      page,
      'smaller-menu.json',
      copyOf((menu) => {
        itemsOf(menu, 'pizzas').pop();
        itemsOf(menu, 'sides').find((side) => side.id === 'garlic-toast')!.price = 2.75;
      }),
    );

    // Switched off: the pizza's product and its three sizes. Changed: the side's price, the
    // place of Half & Half after the pizzas, and the stored menu record.
    await expect(page.getByTestId('pizza-menu-result')).toContainText(
      '0 added, 3 changed, 70 unchanged, 4 switched off',
    );
    await expectLoaded(page, ['4 pizzas']);
  });

  test('a file the server refuses shows its message and the entry it names', async ({ page }) => {
    await loadSampleMenu(page.request);
    await openScreen(page);

    await loadThroughScreen(
      page,
      'broken-menu.json',
      copyOf((menu) => {
        itemsOf(menu, 'deals')[0].picks![0].size = 'huge';
      }),
    );

    const error = page.getByTestId('pizza-menu-error');
    await expect(error).toContainText('"huge" is not a pizza size');
    const entry = 'categories.deals.items[0].picks[0].size';
    await expect(error).toContainText(`Entry in the file: ${entry}`);
    expect((await error.innerText()).split(entry)).toHaveLength(2);
    await expect(page.getByTestId('pizza-menu-result')).toHaveCount(0);
    await expectLoaded(page, SAMPLE_COUNTS);
  });

  test('a file that is not a JSON object is refused in the browser and nothing is sent', async ({
    page,
  }) => {
    await openScreen(page);
    let sent = 0;
    page.on('request', (request) => {
      if (request.url() === IMPORT_URL) sent += 1;
    });

    for (const [name, content] of [
      ['cut-short.json', '{ "sizes": '],
      ['a-list.json', '[]'],
    ]) {
      await chooseFile(page, name, content);

      await expect(page.getByTestId('pizza-menu-error')).toContainText(
        `${name} is not a menu file, so nothing was sent`,
      );
      await expect(page.getByTestId('pizza-menu-confirm')).toHaveCount(0);
    }
    expect(sent).toBe(0);
  });

  test('a cashier has no sidebar entry and is turned away from the address', async ({ page }) => {
    await loginWithPassword(page, cashier.email);
    await expect(page.getByRole('link', { name: 'POS', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pizza menu' })).toHaveCount(0);

    await page.goto(`${BASE}/pizza-menu`);

    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/pos');
    await expect(page.getByRole('heading', { level: 1, name: 'Pizza menu' })).toHaveCount(0);
  });

  test('the POS shows a newly loaded pizza without signing out', async ({ page }) => {
    await loadSampleMenu(page.request);
    await openScreen(page);

    await loadThroughScreen(
      page,
      'bigger-menu.json',
      copyOf((menu) => {
        itemsOf(menu, 'pizzas').push({
          id: 'orchard',
          name: 'Orchard Special',
          description: 'Apple, cheese & tomato sauce',
          sizes: 'pizza',
        });
      }),
    );
    await expectLoaded(page, ['6 pizzas']);
    await page.getByRole('link', { name: 'POS', exact: true }).click();

    await expect(page.getByText('Orchard Special').first()).toBeVisible();
  });
});
