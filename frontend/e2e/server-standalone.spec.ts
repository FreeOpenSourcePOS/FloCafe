import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test.describe('Server Standalone App Live Validation', () => {
  test.setTimeout(60_000);

  test('server logs in, browses catalog with ProductGrid, 1-tap adds item, adds order notes, and sends order', async ({
    page,
    request,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const authHeaders = { Authorization: `Bearer ${managerToken}` };

    // 1. Ensure Table T1 and Table T2 exist so dine-in order and table move workflows are active
    const tablesRes = await request.get(`${E2E_BASE_URL}/api/tables`, { headers: authHeaders });
    expect(tablesRes.ok()).toBeTruthy();
    const tablesData = await tablesRes.json();
    const existingTables: Array<{ id: string; name: string }> = tablesData.tables || [];
    if (!existingTables.some((t) => t.name === 'Table T1')) {
      const res = await request.post(`${E2E_BASE_URL}/api/tables`, {
        headers: authHeaders,
        data: { name: 'Table T1', capacity: 4, floor: 'Main' },
      });
      expect(res.ok()).toBeTruthy();
    }
    if (!existingTables.some((t) => t.name === 'Table T2')) {
      const res = await request.post(`${E2E_BASE_URL}/api/tables`, {
        headers: authHeaders,
        data: { name: 'Table T2', capacity: 4, floor: 'Main' },
      });
      expect(res.ok()).toBeTruthy();
    }

    // 2. Open Server Standalone App
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);

    // 3. Login as server staff
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await page.locator('input[type="email"]').fill('server@flo.local');
    await page.locator('input[type="password"]').fill('E2ePass123!');
    await page.getByRole('button', { name: /sign in/i }).click();

    // 4. Verify ProductGrid is rendered and hydrated
    const productGrid = page.getByTestId('pos-product-grid');
    await expect(productGrid).toBeVisible({ timeout: 15_000 });

    // 5. Verify product catalog item exists (E2E Coffee)
    const productItem = productGrid.getByText('E2E Coffee');
    await expect(productItem).toBeVisible();

    // 6. 1-Tap Add: clicking simple product adds it directly to the draft ticket
    await productItem.click();

    // Verify item appears in draft ticket
    const draftHeading = page.locator('text=E2E Coffee');
    await expect(draftHeading.first()).toBeVisible();

    // 7. Add order notes / special instructions
    const notesInput = page.locator('textarea');
    await expect(notesInput.first()).toBeVisible();
    await notesInput.first().fill('Table note: extra hot');

    // 8. Send order to kitchen
    const sendButton = page.getByRole('button', { name: /send to kitchen|add to order/i });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // 9. Toast notification and item appears in kitchen section
    await expect(page.getByText('Order sent').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('1 x E2E Coffee').first()).toBeVisible();

    // 10. Verify Move Table button is available for the active order and open modal
    const moveTableButton = page.getByRole('button', { name: /move table/i });
    await expect(moveTableButton).toBeVisible();
    await moveTableButton.click();

    // 11. MoveTableModal should be open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Table T2')).toBeVisible();
    await modal.getByText('Table T2').click();

    // 12. Confirm Move
    const confirmButton = modal.getByRole('button', { name: /move to table t2/i });
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // 13. Toast confirms move and active table header changes to Table T2
    await expect(page.getByText(/order moved from table t1 to table t2/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
