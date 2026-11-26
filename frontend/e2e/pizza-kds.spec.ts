import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';
import { clearPizzaMenu, loadSampleMenu } from './helpers/pizza-menu';

/**
 * The kitchen display shows a pizza's or a deal's recipe as the kitchen ticket's lines, under the
 * item name, in the tabs view, the kanban view and the item window.
 *
 * Set PIZZA_KDS_SCREENSHOT_DIR to keep a 1280 x 800 picture of each view.
 */
const SHOTS = process.env.PIZZA_KDS_SCREENSHOT_DIR;
const WARNING = 'RECIPE NOT PRINTED - CHECK ORDER';

const whole = (pizzaId: string, removed: string[] = []) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
});
const half = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'island', removed: ['Pineapple'] },
    { pizzaId: 'classic', removed: [] },
  ],
};
const threeLarge = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    whole('garden', ['Olives']),
    {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'island', removed: [] },
        { pizzaId: 'plain', removed: [] },
      ],
    },
    whole('classic'),
  ],
  wingFlavour: 'sweet-chili',
};

const HALF_NAME = /Half & Half \(Large\)/;
const DEAL_NAME = /Large Pizzas & Wings/;
const HALF_LINES = ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC PEPPERONI'];
const DEAL_LINES = [
  '1) LARGE GARDEN',
  '   NO OLIVES',
  '2) LARGE HALF & HALF',
  '   1ST: ISLAND',
  '   2ND: PLAIN CHEESE',
  '3) LARGE CLASSIC PEPPERONI',
  'WINGS: SWEET CHILI',
];

const headers = () => ({ Authorization: `Bearer ${getE2eToken()}` });

/** Ids of the orders this spec placed; `afterAll` cancels them. */
const placedOrderIds: number[] = [];

async function placeOrder(request: APIRequestContext, items: object[]): Promise<string> {
  const placed = await request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: headers(),
    data: { type: 'takeaway', items },
  });
  expect(placed.ok(), `the order is accepted (got ${placed.status()})`).toBeTruthy();
  const { order } = await placed.json();
  placedOrderIds.push(order.id);
  return order.order_number;
}

async function openKds(page: Page, view: 'Tabs' | 'Kanban') {
  // A page already on the display only switches view. Loading it a second time shows the sign-in
  // form for a moment while the session is restored, and filling that form races the workspace.
  if (!(await page.getByTestId('kds-workspace').isVisible())) {
    await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
    await expect(
      page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
    ).toBeVisible();
    if (await page.getByTestId('kds-login-form').isVisible()) {
      await page.getByTestId('kds-login-email').fill('owner@flo.local');
      await page.getByTestId('kds-login-password').fill(E2E_PASSWORD);
      await page.getByTestId('kds-login-submit').click();
    }
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByRole('button', { name: view, exact: true }).click();
  await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

const orderCard = (page: Page, orderNumber: string) =>
  page.locator('div.rounded-xl.bg-card').filter({ hasText: `#${orderNumber}` });
const itemRow = (card: Locator, name: RegExp) => card.getByRole('button').filter({ hasText: name });

/** The lines are the ticket's, in order, each drawn at its own indent, in a monospace face. */
async function expectRecipeLines(scope: Locator, expected: string[]) {
  const block = scope.getByTestId('kds-recipe-lines');
  await expect(block).toBeVisible();
  await expect(block).toHaveCSS('font-family', /mono/i);
  const drawn = await block.evaluate((element) => {
    const cell = (line: Element, offset: number) => {
      const range = document.createRange();
      range.setStart(line.firstChild as Text, offset);
      range.setEnd(line.firstChild as Text, offset + 1);
      return range.getBoundingClientRect();
    };
    const left = element.getBoundingClientRect().left;
    return {
      fontSize: parseFloat(getComputedStyle(element).fontSize),
      fits: element.scrollWidth <= element.clientWidth,
      lines: Array.from(element.children, (line) => {
        const text = line.textContent ?? '';
        const indent = text.length - text.trimStart().length;
        const first = cell(line, indent);
        return { text, indent, cells: (first.left - left) / first.width };
      }),
    };
  });
  expect(drawn.lines.map((line) => line.text)).toEqual(expected);
  for (const line of drawn.lines) expect(line.cells).toBeCloseTo(line.indent, 1);
  expect(drawn.fontSize, 'large enough to read from across a kitchen').toBeGreaterThanOrEqual(16);
  expect(drawn.fits, 'no line is clipped').toBe(true);
}

const top = async (locator: Locator) => (await locator.boundingBox())!.y;

/** Name, then the recipe lines, then the add-on, then the note. */
async function expectOrderOnScreen(scope: Locator, name: Locator) {
  const positions = [
    await top(name),
    await top(scope.getByTestId('kds-recipe-lines')),
    await top(scope.getByText(/\+ Ranch/)),
    await top(scope.getByText(/Ring the bell/)),
  ];
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

const shoot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

test.describe('pizza recipe lines on the kitchen display', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1280, height: 800 } });

  let pizzaOrder = '';
  let plainOrder = '';

  test.beforeAll(async ({ request }) => {
    await loadSampleMenu(request);
    const dips = await request.get(`${E2E_BASE_URL}/api/addon-groups/ag-dips`, {
      headers: headers(),
    });
    expect(dips.ok(), 'the dips add-on group is there').toBeTruthy();
    const body = await dips.json();
    const ranch = (body.addon_group ?? body.group).addons.find(
      (addon: { name: string }) => addon.name === 'Ranch',
    );
    pizzaOrder = await placeOrder(request, [
      {
        product_id: 'pz-half-and-half',
        variant_id: 'pz-half-and-half-large',
        quantity: 1,
        modifier_selection: half,
        addons: [{ id: ranch.id, name: ranch.name, price: ranch.price, quantity: 1 }],
        special_instructions: 'Ring the bell',
      },
      { product_id: 'dl-three-large-wings', quantity: 1, modifier_selection: threeLarge },
    ]);
    plainOrder = await placeOrder(request, [
      { product_id: 'pz-garden', variant_id: 'pz-garden-large', quantity: 1 },
      { product_id: 'e2e-product', quantity: 1 },
    ]);
  });

  // Every spec shares one database: the orders leave the kitchen display, then the menu goes.
  test.afterAll(async ({ request }) => {
    const failures: string[] = [];
    for (const id of placedOrderIds) {
      const cancelled = await request
        .patch(`${E2E_BASE_URL}/api/orders/${id}/status`, {
          headers: headers(),
          data: { status: 'cancelled', reason: 'E2E cleanup' },
        })
        .then(async (res) => (res.ok() ? '' : `HTTP ${res.status()} ${await res.text()}`))
        .catch(String);
      if (cancelled) failures.push(`cancel order ${id}: ${cancelled}`);
    }
    await clearPizzaMenu(request).catch((error) => failures.push(String(error)));
    expect(failures, 'cleaning up after the kitchen display spec').toEqual([]);
  });

  for (const view of ['Tabs', 'Kanban'] as const) {
    test(`the ${view.toLowerCase()} view shows the lines under each pizza item`, async ({
      page,
    }) => {
      await openKds(page, view);
      const card = orderCard(page, pizzaOrder);
      await expect(card).toHaveCount(1);
      const halfRow = itemRow(card, HALF_NAME);
      await expectRecipeLines(halfRow, HALF_LINES);
      await expectRecipeLines(itemRow(card, DEAL_NAME), DEAL_LINES);
      await expectOrderOnScreen(halfRow, halfRow.getByText(HALF_NAME));
      await card.scrollIntoViewIfNeeded();
      await shoot(page, view.toLowerCase());
    });
  }

  test('the item window shows the lines under the item name', async ({ page }) => {
    await openKds(page, 'Tabs');
    const card = orderCard(page, pizzaOrder);
    const dialog = page.getByRole('dialog');

    await itemRow(card, DEAL_NAME).click();
    await expectRecipeLines(dialog, DEAL_LINES);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    await itemRow(card, HALF_NAME).click();
    await expectRecipeLines(dialog, HALF_LINES);
    await expectOrderOnScreen(dialog, dialog.getByRole('heading', { name: HALF_NAME }));
    await shoot(page, 'item-window');
  });

  test('an order with no recipes shows as it does upstream', async ({ page }) => {
    for (const view of ['Tabs', 'Kanban'] as const) {
      await openKds(page, view);
      const card = orderCard(page, plainOrder);
      await expect(card).toHaveCount(1);
      await expect(card.getByRole('button')).toHaveCount(2);
      await expect(card.getByTestId('kds-recipe-lines')).toHaveCount(0);

      await itemRow(card, /Garden \(Large\)/).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Garden (Large)' })).toBeVisible();
      await expect(dialog.getByTestId('kds-recipe-lines')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close' }).click();
    }
  });

  test('with the stored menu removed, the warning line shows and stands out', async ({
    page,
    request,
  }) => {
    // No route removes the stored menu, so the row is deleted in the server's database file.
    // tests/e2e-server.cjs answers every Electron path with one temporary folder: getDbPath() in
    // main/db.ts puts flo.db in it, and getLocalBackupDir() reports <folder>/FloCafe/Backups.
    const backups = await request.get(`${E2E_BASE_URL}/api/db-tools/local-backup`, {
      headers: headers(),
    });
    expect(backups.ok(), `the local backup folder is reported (got ${backups.status()})`).toBe(
      true,
    );
    const { directory } = await backups.json();
    const database = path.resolve(directory, '../../flo.db');
    expect(
      fs.existsSync(database),
      `looked for the test server's database at ${database}, two folders above the local backup folder it reports (${directory}); no file is there`,
    ).toBe(true);
    const db = new DatabaseSync(database);
    try {
      db.exec('PRAGMA busy_timeout = 5000; DELETE FROM pizza_menu');
    } finally {
      db.close();
    }

    try {
      for (const view of ['Tabs', 'Kanban'] as const) {
        await openKds(page, view);
        const card = orderCard(page, pizzaOrder);
        const warnings = card.getByTestId('kds-recipe-warning');
        await expect(warnings).toHaveText([WARNING, WARNING]);
        await expect(card.getByTestId('kds-recipe-lines')).toHaveCount(2);
        // Colour and a symbol, never colour alone.
        const warning = warnings.first();
        await expect(warning.locator('svg')).toBeVisible();
        await expect(warning).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        expect(
          await warning.evaluate((element) => element.scrollWidth <= element.clientWidth),
          'the warning is not clipped',
        ).toBe(true);
        await card.scrollIntoViewIfNeeded();
        await shoot(page, `warning-${view.toLowerCase()}`);
      }

      await itemRow(orderCard(page, pizzaOrder), HALF_NAME).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('kds-recipe-warning')).toHaveText(WARNING);
      await expect(dialog.getByTestId('kds-recipe-warning').locator('svg')).toBeVisible();
      await shoot(page, 'warning-item-window');
    } finally {
      await loadSampleMenu(request);
    }
  });
});
