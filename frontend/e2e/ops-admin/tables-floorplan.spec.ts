import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, ownerAuth, overlay, openOrderOverflowMenu } from './helpers';

/**
 * Tables and floor plans, driven as an administrator.
 *
 * The drag-and-drop geometry of the floor-plan canvas is already covered by the
 * repository's own floorplan-editor.spec.ts, so this suite stays on the
 * operational side: creating, renaming and reassigning tables, and the round
 * trip of a real order opened against one - which is where a table's state has
 * to agree with the order record.
 */

const RUN = Date.now().toString(36).slice(-4);
const created: string[] = [];

type Table = { id: string; number: string; name?: string; capacity: number; floor: string; section: string | null; status: string; is_active?: number };

async function fetchTables(page: import('@playwright/test').Page): Promise<Table[]> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.get(`${E2E_BASE_URL}/api/tables`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).tables as Table[];
}

/**
 * A locator restricted to what is actually on screen.
 *
 * The Tables page keeps the list and the floor-plan canvas mounted at the same
 * time and hides the inactive one, so an unscoped getByText can resolve to the
 * hidden copy and report a table as missing when it is plainly on the page.
 */
function onScreen(page: import('@playwright/test').Page, text: string) {
  return page.getByText(text).filter({ visible: true }).first();
}

test.describe('operations admin - tables and floor plans', () => {
  test.afterAll(async ({ request }) => {
    // Tables are deactivated rather than deleted; leave none active behind.
    for (const id of created) {
      await request.post(`${E2E_BASE_URL}/api/tables/${id}/deactivate`, { headers: ownerAuth() });
    }
  });

  test('a table created from the form is stored with its floor and capacity', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/tables`);
    await page.getByRole('button', { name: 'Add Table', exact: true }).click();

    const form = overlay(page);
    await expect(form).toBeVisible();

    // The form's labels are not wired to their inputs, so the fields are
    // addressed by placeholder and input type rather than by label text.
    const number = `Ops${RUN}A`;
    await form.getByPlaceholder('e.g., T1, Table 1').fill(number);
    await form.locator('input[type="number"]').fill('4');
    await form.locator('input[type="text"]').nth(1).fill(`OpsFloor${RUN}`);
    await form.getByRole('button', { name: 'Create Table' }).click();
    await expect(page.getByText('Table created')).toBeVisible({ timeout: 20_000 });

    const stored = (await fetchTables(page)).find((t) => t.number === number);
    expect(stored, 'the new table must be readable back from the API').toBeTruthy();
    expect(stored?.capacity).toBe(4);
    expect(stored?.floor).toBe(`OpsFloor${RUN}`);
    created.push(stored!.id);

    // And the list an operator reads shows the same thing.
    await expect(onScreen(page, number)).toBeVisible();
  });

  test('renaming a table and moving it to another floor persists', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const number = `Ops${RUN}B`;
    const createdRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number, capacity: 2, floor: `OpsFloor${RUN}` },
    });
    expect(createdRes.status()).toBe(201);
    const table = ((await createdRes.json()) as { table: Table }).table;
    created.push(table.id);

    // Rename and reassign through the API the screen uses.
    const renamed = `${number}R`;
    const updated = await page.request.put(`${E2E_BASE_URL}/api/tables/${table.id}`, {
      headers,
      data: { number: renamed, capacity: 6, floor: `OpsRoof${RUN}` },
    });
    expect(updated.ok(), `renaming a table must succeed (got ${updated.status()} ${await updated.text()})`).toBeTruthy();

    const stored = (await fetchTables(page)).find((t) => t.id === table.id);
    expect(stored).toMatchObject({ number: renamed, capacity: 6, floor: `OpsRoof${RUN}` });

    // The renamed table is what the screen offers, and the old number is gone.
    await page.goto(`${E2E_BASE_URL}/tables`);
    await expect(onScreen(page, renamed)).toBeVisible();
    // Exact match: the renamed value extends the old one, so a substring search
    // would find the new number inside the old label.
    await expect(page.getByText(number, { exact: true }).filter({ visible: true })).toHaveCount(0);
  });

  test('placing a table on the floor plan persists its position', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const number = `Ops${RUN}C`;
    const createdRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number, capacity: 4, floor: `OpsFloor${RUN}` },
    });
    const table = ((await createdRes.json()) as { table: Table }).table;
    created.push(table.id);

    // Unplaced until it is given coordinates.
    expect(table.floor).toBe(`OpsFloor${RUN}`);

    // Coordinates are canvas percentages, so they must fall between 0 and 100.
    const placed = await page.request.patch(`${E2E_BASE_URL}/api/tables/positions`, {
      headers,
      data: { positions: [{ id: table.id, position_x: 30, position_y: 40 }] },
    });
    expect(placed.ok(), `placing a table must succeed (got ${placed.status()})`).toBeTruthy();

    await page.goto(`${E2E_BASE_URL}/tables`);
    await page.getByRole('button', { name: 'Floor plan' }).click();
    await page.getByRole('button', { name: 'Edit layout' }).click();

    // The editor opens on whichever floor tab is active, and this suite leaves
    // several floors behind, so select the one holding this table. The tab
    // label carries a table count, hence the prefix match rather than exact.
    const tabs = page.getByTestId('floorplan-floor-tabs');
    await tabs.getByRole('button', { name: new RegExp(`^OpsFloor${RUN}`) }).click();

    // Placed tables render on the canvas; unplaced ones wait in the staging tray.
    await expect(page.getByTestId(`floorplan-chip-${number}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`floorplan-tray-${number}`)).toBeHidden();
  });

  test('an order opened on a table round-trips: it shows on the table, and freeing it frees the table', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const number = `Ops${RUN}D`;
    const createdRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number, capacity: 2, floor: `OpsFloor${RUN}` },
    });
    const table = ((await createdRes.json()) as { table: Table }).table;
    created.push(table.id);

    // Open a real dine-in order against that table.
    const orderRes = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'dine_in', table_id: table.id, guest_count: 2, items: [{ product_id: 'e2e-product', quantity: 2 }] },
    });
    expect(orderRes.status()).toBe(201);
    const { order } = (await orderRes.json()) as { order: { id: number; order_number: string; subtotal: number; total: number } };

    // The order names its table in the record.
    const listed = await page.request.get(`${E2E_BASE_URL}/api/orders`, { headers });
    const { orders } = (await listed.json()) as { orders: Array<{ order_number: string; table: { number: string } | null; subtotal: number; total: number }> };
    const onTable = orders.find((o) => o.order_number === order.order_number);
    expect(onTable?.table?.number, 'the order must carry the table it was opened on').toBe(number);

    // The Tables screen shows the order sitting on that table.
    await page.goto(`${E2E_BASE_URL}/tables`);
    await expect(onScreen(page, number)).toBeVisible();
    await expect(onScreen(page, `#${order.order_number}`)).toBeVisible({ timeout: 20_000 });

    // The Orders screen agrees, and names the same table.
    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button').filter({ hasText: `#${order.order_number}` }).first().click();
    await expect(page.getByText(`#${order.order_number}`).nth(1)).toBeVisible();
    await expect(page.getByText(number, { exact: true }).first()).toBeVisible();

    // Cancel the order, which is what actually releases the table.
    await openOrderOverflowMenu(page);
    await page.getByRole('menuitem', { name: /^Cancel$/ }).click();
    const sheet = overlay(page);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: /Confirm Cancel/i }).click();
    await expect(page.getByText(/Order cancelled successfully/i).first()).toBeVisible({ timeout: 30_000 });

    const after = (await fetchTables(page)).find((t) => t.id === table.id);
    expect(after?.status, 'a cancelled order must not leave its table occupied').not.toBe('occupied');
  });

  test('a table can be deactivated and brought back', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const number = `Ops${RUN}E`;
    const createdRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number, capacity: 2, floor: `OpsFloor${RUN}` },
    });
    const table = ((await createdRes.json()) as { table: Table }).table;
    created.push(table.id);

    const off = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/deactivate`, { headers });
    expect(off.ok(), `deactivating a table must succeed (got ${off.status()} ${await off.text()})`).toBeTruthy();

    const on = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/reactivate`, { headers });
    expect(on.ok(), `reactivating a table must succeed (got ${on.status()})`).toBeTruthy();

    const stored = (await fetchTables(page)).find((t) => t.id === table.id);
    expect(stored, 'a reactivated table returns to the list').toBeTruthy();
    expect(stored?.is_active ?? 1).toBe(1);
  });
});