import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

// Tall viewport so the canvas AND the staging tray below it are inside the
// viewport — mouse drags hit nothing outside it.
test.use({ viewport: { width: 1280, height: 1000 } });

const EMAIL = 'manager@flo.local';
const PASSWORD = 'E2ePass123!';

// Deterministic floors/tables for the UI tests. Idempotent: skips tables that
// already exist (the e2e server DB persists between local runs).
test.beforeEach(async ({ request }) => {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await login.json();
  const auth = { Authorization: `Bearer ${access_token}` };
  const list = await (await request.get(`${BASE}/api/tables`, { headers: auth })).json();
  const have = new Set((list.tables ?? []).map((t: { number: string }) => t.number));
  const seed: Array<[string, number, string]> = [
    ['T1', 4, 'Ground'],
    ['T2', 4, 'Ground'],
    ['T3', 4, 'First'],
  ];
  for (const [number, capacity, floor] of seed) {
    if (!have.has(number)) {
      await request.post(`${BASE}/api/tables`, {
        headers: auth,
        data: { number, capacity, floor },
      });
    }
  }
  // Reset seed coordinates so every test starts with T1-T3 unplaced,
  // even when the e2e DB persists between runs.
  const fresh = await (await request.get(`${BASE}/api/tables`, { headers: auth })).json();
  const ids = (fresh.tables ?? [])
    .filter((t: { number: string }) => ['T1', 'T2', 'T3'].includes(t.number))
    .map((t: { id: string }) => ({ id: t.id, position_x: null, position_y: null }));
  if (ids.length > 0) {
    await request.patch(`${BASE}/api/tables/positions`, { headers: auth, data: { positions: ids } });
  }
});

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.goto(`${BASE}/tables`);
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('floorplan editor: drag table onto map, save, persist after reload', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Edit layout' }).click();
  const canvas = page.getByTestId('floorplan-canvas');
  await expect(canvas).toBeVisible();

  // Floor tabs derived from table floors (scoped: the hidden list view holds
  // same-named filter pills that would make unscoped locators ambiguous)
  const tabs = page.getByTestId('floorplan-floor-tabs');
  await expect(tabs.getByRole('button', { name: 'Ground' })).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'First' })).toBeVisible();

  // Drag T1 from the staging tray onto the canvas center
  const trayChip = page.getByTestId('floorplan-tray-T1');
  await expect(trayChip).toBeVisible();
  await trayChip.scrollIntoViewIfNeeded();
  const canvasBox = await canvas.boundingBox();
  const chipBox = await trayChip.boundingBox();
  if (!canvasBox || !chipBox) throw new Error('missing drag geometry');
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    canvasBox.x + canvasBox.width * 0.5,
    canvasBox.y + canvasBox.height * 0.5,
    { steps: 8 }
  );
  await page.mouse.up();

  await expect(page.getByTestId('floorplan-chip-T1')).toBeVisible();
  await expect(trayChip).toBeHidden();

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Floorplan saved')).toBeVisible();

  // Reload: T1 is now on the map (not in the tray) — position persisted
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(canvas).toBeVisible();
  const chipT1 = page.getByTestId('floorplan-chip-T1');
  await expect(chipT1).toBeVisible();
  await expect(page.getByTestId('floorplan-tray-T1')).toBeHidden();

  // Keyboard nudge: arrows move a placed chip; Cancel reverts
  const styleBefore = await chipT1.getAttribute('style');
  await chipT1.focus();
  await page.keyboard.press('ArrowRight');
  expect(await chipT1.getAttribute('style')).not.toBe(styleBefore);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(chipT1).toHaveAttribute('style', styleBefore!);

  // T2 (Ground) and T3 (First) remain unplaced on their own floors
  await expect(page.getByTestId('floorplan-tray-T2')).toBeVisible();
  await expect(page.getByTestId('floorplan-tray-T3')).toBeHidden();

  // Switching floors shows the other floor's tables
  await tabs.getByRole('button', { name: 'First' }).click();
  await expect(page.getByTestId('floorplan-tray-T3')).toBeVisible();
  await expect(page.getByTestId('floorplan-chip-T1')).toBeHidden();
});

test('floorplan editor: drag table back to tray unplaces it', async ({ page, request }) => {
  // Self-sufficient: place T1 via API (beforeEach resets all seeds to unplaced).
  const apiLogin = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await apiLogin.json();
  const apiAuth = { Authorization: `Bearer ${access_token}` };
  const tableList = await (await request.get(`${BASE}/api/tables`, { headers: apiAuth })).json();
  const t1 = (tableList.tables ?? []).find((t: { number: string }) => t.number === 'T1');
  await request.patch(`${BASE}/api/tables/positions`, {
    headers: apiAuth,
    data: { positions: [{ id: t1.id, position_x: 30, position_y: 30 }] },
  });

  await login(page);

  await page.getByRole('button', { name: 'Edit layout' }).click();
  const chip = page.getByTestId('floorplan-chip-T1');
  await expect(chip).toBeVisible();
  const tray = page.getByTestId('floorplan-tray');
  await expect(tray).toBeVisible();
  await chip.scrollIntoViewIfNeeded();
  const chipBox = await chip.boundingBox();
  const trayBox = await tray.boundingBox();
  if (!chipBox || !trayBox) throw new Error('missing drag geometry');
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trayBox.x + trayBox.width / 2, trayBox.y + trayBox.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId('floorplan-tray-T1')).toBeVisible();
  await expect(chip).toBeHidden();

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Floorplan saved')).toBeVisible();

  // Reload: T1 stays unplaced — the null positions persisted
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(page.getByTestId('floorplan-tray-T1')).toBeVisible();
  await expect(page.getByTestId('floorplan-chip-T1')).toBeHidden();
});

test('floorplan editor: discard reverts unsaved drags', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Edit layout' }).click();
  const canvas = page.getByTestId('floorplan-canvas');
  await expect(canvas).toBeVisible();

  const trayChip = page.getByTestId('floorplan-tray-T2');
  await expect(trayChip).toBeVisible();
  await trayChip.scrollIntoViewIfNeeded();
  const canvasBox = await canvas.boundingBox();
  const chipBox = await trayChip.boundingBox();
  if (!canvasBox || !chipBox) throw new Error('missing drag geometry');
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.2, canvasBox.y + canvasBox.height * 0.2, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId('floorplan-chip-T2')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('floorplan-tray-T2')).toBeVisible();
  await expect(page.getByTestId('floorplan-chip-T2')).toBeHidden();
});

test('floorplan editor: click a table to edit its seats', async ({ page, request }) => {
  // This test needs T1 placed; establish it here via API instead of relying
  // on the persistence test (beforeEach resets all seeds to unplaced).
  const apiLogin = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await apiLogin.json();
  const apiAuth = { Authorization: `Bearer ${access_token}` };
  const tableList = await (await request.get(`${BASE}/api/tables`, { headers: apiAuth })).json();
  const t1 = (tableList.tables ?? []).find((t: { number: string }) => t.number === 'T1');
  await request.patch(`${BASE}/api/tables/positions`, {
    headers: apiAuth,
    data: { positions: [{ id: t1.id, position_x: 30, position_y: 30 }] },
  });

  await login(page);

  await page.getByRole('button', { name: 'Edit layout' }).click();
  const chipT1 = page.getByTestId('floorplan-chip-T1');
  await expect(chipT1).toBeVisible();

  // Click (no drag) opens the table editor
  await chipT1.click();
  const form = page.getByTestId('floorplan-table-form');
  await expect(form).toBeVisible();

  await page.getByLabel('Capacity').fill('6');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Table updated')).toBeVisible();

  // Seats are drawn as chair dots — the object geometry reflects capacity
  await expect(chipT1.locator('[data-seats="6"]')).toBeVisible();
});

test('floorplan editor: quick-add suggests the next number and active floor', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Edit layout' }).click();
  await page.getByTestId('floorplan-add').click();
  const form = page.getByTestId('floorplan-table-form');
  await expect(form).toBeVisible();

  const name = await page.getByLabel('Name').inputValue();
  expect(name).toMatch(/^\d+$/);
  await expect(form.getByLabel('Floor')).toHaveValue('Ground');

  await page.getByLabel('Capacity').fill('2');
  await form.getByRole('button', { name: 'Create Table' }).click();
  await expect(page.getByText('Table created')).toBeVisible();

  // Quick-add auto-places the new table on the canvas at a free corner
  await expect(page.getByTestId(`floorplan-chip-${name}`)).toBeVisible();
});

test('floorplan editor: add a named floor and see it in the all-floors overview', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Edit layout' }).click();

  await page.getByTestId('floorplan-add-floor').click();
  const floorForm = page.getByTestId('floorplan-floor-form');
  await expect(floorForm).toBeVisible();
  await page.getByLabel('Floor name').fill('Patio');
  const floorTable = await page.locator('#floorplan-floor-table').inputValue();
  expect(floorTable).toMatch(/^\d+$/);
  await floorForm.getByRole('button', { name: 'Create Table' }).click();
  await expect(page.getByText('Table created')).toBeVisible();

  // Editor switches to the new floor; its first table starts placed on the canvas
  await expect(page.getByTestId(`floorplan-chip-${floorTable}`)).toBeVisible();

  // The all-floors overview shows every floor side by side
  await page.getByTestId('floorplan-floor-tabs').getByRole('button', { name: 'All floors' }).click();
  await expect(page.getByTestId('floorplan-mini-Ground')).toBeVisible();
  await expect(page.getByTestId('floorplan-mini-First')).toBeVisible();
  await expect(page.getByTestId('floorplan-mini-Patio')).toBeVisible();

  // Overview is read-only; Edit returns to that floor's canvas
  await expect(page.getByTestId('floorplan-canvas')).toBeHidden();
  await page.getByTestId('floorplan-mini-Patio').getByRole('button').click();
  await expect(page.getByTestId('floorplan-canvas')).toBeVisible();
  await expect(page.getByTestId(`floorplan-chip-${floorTable}`)).toBeVisible();
});

test('floorplan editor: live table status refreshes while editing', async ({ page, request }) => {
  const apiLogin = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await apiLogin.json();
  const apiAuth = { Authorization: `Bearer ${access_token}` };
  const tableList = await (await request.get(`${BASE}/api/tables`, { headers: apiAuth })).json();
  const t1 = (tableList.tables ?? []).find((t: { number: string }) => t.number === 'T1');
  await request.patch(`${BASE}/api/tables/${t1.id}/status`, {
    headers: apiAuth,
    data: { status: 'available' },
  });
  await request.patch(`${BASE}/api/tables/positions`, {
    headers: apiAuth,
    data: { positions: [{ id: t1.id, position_x: 30, position_y: 30 }] },
  });

  await login(page);
  await page.getByRole('button', { name: 'Edit layout' }).click();
  const chip = page.getByTestId('floorplan-chip-T1');
  await expect(chip).toHaveAttribute('aria-label', /Available/);

  await request.patch(`${BASE}/api/tables/${t1.id}/status`, {
    headers: apiAuth,
    data: { status: 'occupied' },
  });
  await expect(chip).toHaveAttribute('aria-label', /Occupied/, { timeout: 15_000 });
});

test('floorplan editor: live order status refreshes while editing', async ({ page, request }) => {
  const apiLogin = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const { access_token } = await apiLogin.json();
  const apiAuth = { Authorization: `Bearer ${access_token}` };
  const tableList = await (await request.get(`${BASE}/api/tables`, { headers: apiAuth })).json();
  const t1 = (tableList.tables ?? []).find((t: { number: string }) => t.number === 'T1');
  if (!t1) throw new Error('missing seeded table T1');
  await request.patch(`${BASE}/api/tables/${t1.id}/status`, {
    headers: apiAuth,
    data: { status: 'available' },
  });
  await request.patch(`${BASE}/api/tables/positions`, {
    headers: apiAuth,
    data: { positions: [{ id: t1.id, position_x: 30, position_y: 30 }] },
  });
  const orderRes = await request.post(`${BASE}/api/orders`, {
    headers: apiAuth,
    data: {
      table_id: t1.id,
      type: 'dine_in',
      guest_count: 2,
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();

  await login(page);
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await expect(page.getByTestId('floorplan-chip-T1')).toContainText(`#${order.order_number}`);

  const waitForOrderStatus = (status: string) => page.waitForResponse(async (response) => {
    if (response.request().method() !== 'GET' || !response.url().includes('/api/orders')) return false;
    try {
      const body = await response.json();
      return body.orders?.some((candidate: { order_number: string; status: string }) =>
        candidate.order_number === order.order_number && candidate.status === status);
    } catch {
      return false;
    }
  }, { timeout: 15_000 });

  await waitForOrderStatus('pending');
  await request.patch(`${BASE}/api/orders/${order.id}/status`, {
    headers: apiAuth,
    data: { status: 'preparing' },
  });
  await waitForOrderStatus('preparing');
});

test('list view: Add Table keeps the selected floor', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'First', exact: true }).click();
  await page.getByRole('button', { name: 'Add Table', exact: true }).click();

  const form = page.locator('form').filter({ hasText: 'Floor' });
  await expect(form.locator('input').nth(2)).toHaveValue('First');
});
