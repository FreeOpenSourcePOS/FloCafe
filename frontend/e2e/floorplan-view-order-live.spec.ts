import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test.use({ viewport: { width: 1280, height: 900 } });

const EMAIL = 'manager@flo.local';
const PASSWORD = 'E2ePass123!';

test('live validation: floorplan View Order navigation and OrdersPage ?table= query sync', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  const loginRes = await request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { access_token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${access_token}` };

  const businessRes = await request.get(`${BASE}/api/settings/business`, { headers: auth });
  expect(businessRes.ok()).toBeTruthy();
  const originalBusiness = await businessRes.json();

  const businessUpdateFalse = await request.put(`${BASE}/api/settings/business`, {
    headers: auth,
    data: { ...originalBusiness, tables_required: false },
  });
  expect(businessUpdateFalse.ok()).toBeTruthy();

  let t101 = { id: '', number: '', name: '' };
  let t102 = { id: '', number: '', name: '' };
  let t103 = { id: '', number: '', name: '' };
  let order101: { id: string | number; order_number: string } = { id: '', order_number: '' };
  let order102: { id: string | number; order_number: string } = { id: '', order_number: '' };

  try {
    // Seed placed occupied (T101), unplaced occupied (T102), and placed available (T103) tables.
    const suffix = String(Date.now()).slice(-4);
    const t101Name = `T101_${suffix}`;
    const t102Name = `T102_${suffix}`;
    const t103Name = `T103_${suffix}`;

    const createTable = async (
      number: string,
      capacity: number,
      position_x: number | null,
      position_y: number | null,
    ) => {
      const res = await request.post(`${BASE}/api/tables`, {
        headers: auth,
        data: {
          number,
          capacity,
          floor: 'Ground',
          section: 'Main',
          position_x,
          position_y,
        },
      });
      expect(res.ok()).toBeTruthy();
      return (await res.json()).table as { id: string; number: string; name: string };
    };

    t101 = await createTable(t101Name, 4, 25, 30);
    t102 = await createTable(t102Name, 2, null, null);
    t103 = await createTable(t103Name, 4, 65, 30);

    const posRes = await request.patch(`${BASE}/api/tables/positions`, {
      headers: auth,
      data: {
        positions: [
          { id: t101.id, position_x: 25, position_y: 30 },
          { id: t102.id, position_x: null, position_y: null },
          { id: t103.id, position_x: 65, position_y: 30 },
        ],
      },
    });
    expect(posRes.ok()).toBeTruthy();

    const createOrderForTable = async (tableId: string) => {
      const res = await request.post(`${BASE}/api/orders`, {
        headers: auth,
        data: {
          table_id: tableId,
          type: 'dine_in',
          guest_count: 2,
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(res.status()).toBe(201);
      return (await res.json()).order as { id: string | number; order_number: string };
    };

    order101 = await createOrderForTable(t101.id);
    order102 = await createOrderForTable(t102.id);

    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15_000 });

    const getTableFilterSelect = () =>
      page.locator('select').filter({ has: page.locator('option', { hasText: 'All Tables' }) });

    // Scenario 1: Placed occupied table on floorplan canvas navigates to filtered /orders.
    await page.goto(`${BASE}/tables`);
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
    await page.getByRole('button', { name: 'Floor plan' }).click();

    const groundTab = page
      .getByTestId('floorplan-floor-tabs')
      .getByRole('button', { name: 'Ground' });
    if (await groundTab.isVisible()) {
      await groundTab.click();
    }

    const chip101 = page.getByTestId(`floorplan-chip-${t101Name}`);
    await expect(chip101).toBeVisible();
    await expect(chip101).toContainText(`#${order101.order_number}`);
    await chip101.click();

    const dialog101 = page.getByRole('dialog', { name: t101Name });
    await expect(dialog101).toBeVisible();
    const viewOrderBtn101 = dialog101.getByRole('button', { name: 'View Order' });
    await expect(viewOrderBtn101).toBeVisible();

    const ordersFetch101 = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${encodeURIComponent(String(t101.id))}`),
    );
    await viewOrderBtn101.click();
    await ordersFetch101;

    await expect(page).toHaveURL(
      new RegExp(`/orders/?\\?table=${encodeURIComponent(String(t101.id))}$`),
    );
    const tableSelect = getTableFilterSelect();
    await expect(tableSelect).toBeVisible();
    await expect(tableSelect).toHaveValue(String(t101.id));

    await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
    await expect(page.getByText(`#${order102.order_number}`)).toHaveCount(0);

    const businessUpdateTrue = await request.put(`${BASE}/api/settings/business`, {
      headers: auth,
      data: { ...originalBusiness, tables_required: true },
    });
    expect(businessUpdateTrue.ok()).toBeTruthy();

    // Scenario 2: Unplaced occupied table in floorplan tray navigates to filtered /orders.
    await page.goto(`${BASE}/tables`);
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
    await page.getByRole('button', { name: 'Floor plan' }).click();
    if (await groundTab.isVisible()) {
      await groundTab.click();
    }

    const tray102 = page.getByTestId(`floorplan-tray-${t102Name}`);
    await expect(tray102).toBeVisible();
    await tray102.click();

    const dialog102 = page.getByRole('dialog', { name: t102Name });
    await expect(dialog102).toBeVisible();
    const viewOrderBtn102 = dialog102.getByRole('button', { name: 'View Order' });
    await expect(viewOrderBtn102).toBeVisible();

    const ordersFetch102 = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${encodeURIComponent(String(t102.id))}`),
    );
    await viewOrderBtn102.click();
    await ordersFetch102;

    await expect(page).toHaveURL(
      new RegExp(`/orders/?\\?table=${encodeURIComponent(String(t102.id))}$`),
    );
    await expect(tableSelect).toHaveValue(String(t102.id));
    await expect(page.getByText(`#${order102.order_number}`).first()).toBeVisible();
    await expect(page.getByText(`#${order101.order_number}`)).toHaveCount(0);

    // Scenario 3: Manual table dropdown changes persist across re-renders while ?table= is unchanged.
    await tableSelect.selectOption(String(t101.id));
    await expect(tableSelect).toHaveValue(String(t101.id));
    await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
    await expect(page.getByText(`#${order102.order_number}`)).toHaveCount(0);

    await page.getByRole('button', { name: 'Active', exact: true }).click();
    await expect(tableSelect).toHaveValue(String(t101.id));
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(tableSelect).toHaveValue(String(t101.id));
    await expect(page).toHaveURL(
      new RegExp(`/orders/?\\?table=${encodeURIComponent(String(t102.id))}$`),
    );

    await tableSelect.selectOption('');
    await expect(tableSelect).toHaveValue('');
    await page.getByRole('button', { name: 'Active', exact: true }).click();
    await expect(tableSelect).toHaveValue('');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(tableSelect).toHaveValue('');
    await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
    await expect(page.getByText(`#${order102.order_number}`).first()).toBeVisible();

    // Scenario 4: Navigating to /orders without ?table= resets filters.table to All Tables.
    await tableSelect.selectOption(String(t101.id));
    await expect(tableSelect).toHaveValue(String(t101.id));
    await expect(page.getByText(`#${order102.order_number}`)).toHaveCount(0);

    await page.locator('a[href^="/orders"]').first().click();
    await expect(page).toHaveURL(new RegExp(`/orders/?$`));
    await expect(tableSelect).toHaveValue('');
    await expect(page.getByText(`#${order101.order_number}`).first()).toBeVisible();
    await expect(page.getByText(`#${order102.order_number}`).first()).toBeVisible();

    // Scenario 5: Available (unoccupied) floorplan table does not expose View Order.
    await page.goto(`${BASE}/tables`);
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
    await page.getByRole('button', { name: 'Floor plan' }).click();
    if (await groundTab.isVisible()) {
      await groundTab.click();
    }

    const chip103 = page.getByTestId(`floorplan-chip-${t103Name}`);
    await expect(chip103).toBeVisible();
    await chip103.click();

    const dialog103 = page.getByRole('dialog', { name: t103Name });
    await expect(dialog103).toBeVisible();
    await expect(dialog103.getByRole('button', { name: 'Reserve Table' })).toBeVisible();
    await expect(dialog103.getByRole('button', { name: 'View Order' })).toHaveCount(0);
  } finally {
    for (const ord of [order101, order102]) {
      if (ord.id) {
        await request
          .patch(`${BASE}/api/orders/${ord.id}/status`, {
            headers: auth,
            data: { status: 'cancelled', reason: 'E2E cleanup' },
          })
          .catch(() => {});
      }
    }
    const createdTableIds = [t101.id, t102.id, t103.id].filter(Boolean);
    if (createdTableIds.length > 0) {
      await request
        .patch(`${BASE}/api/tables/positions`, {
          headers: auth,
          data: {
            positions: createdTableIds.map((id) => ({
              id,
              position_x: null,
              position_y: null,
            })),
          },
        })
        .catch(() => {});
    }
    for (const tbl of [t101, t102, t103]) {
      if (tbl.id) {
        await request
          .patch(`${BASE}/api/tables/${tbl.id}/status`, {
            headers: auth,
            data: { status: 'available' },
          })
          .catch(() => {});
        await request
          .post(`${BASE}/api/tables/${tbl.id}/deactivate`, { headers: auth })
          .catch(() => {});
      }
    }
    await request
      .put(`${BASE}/api/settings/business`, {
        headers: auth,
        data: originalBusiness,
      })
      .catch(() => {});
  }
});
