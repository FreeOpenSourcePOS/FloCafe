import { test, expect } from '@playwright/test';
import path from 'path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const EVIDENCE_DIR = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M4KH9AEE64Z0DN12TWX2717P';

test.describe('Table Move UI Live Validation', () => {
  test.setTimeout(90_000);

  test('executes end-to-end table move flows across floorplan, tables list, and POS checkout modal', async ({
    page,
    request,
  }) => {
    const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const authHeaders = { Authorization: `Bearer ${token}` };

    // 0. Ensure tables_required and postpaid billing in business settings so POS shows table picker
    const businessRes = await request.get(`${BASE}/api/settings/business`, {
      headers: authHeaders,
    });
    expect(businessRes.ok()).toBeTruthy();
    const originalBusiness = await businessRes.json();

    const businessUpdate = await request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid', tables_required: true },
    });
    expect(businessUpdate.ok()).toBeTruthy();

    try {
      // 1. Prepare deterministic tables and products
      const runId = Date.now();
      const t1Num = `M1_${runId}`;
      const t2Num = `M2_${runId}`;
      const t3Num = `M3_${runId}`;
      const t4Num = `M4_${runId}`;

      const resT1 = await request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number: t1Num, capacity: 4, floor: 'Ground', section: 'Indoor' },
      });
      expect(resT1.ok()).toBeTruthy();
      const table1 = (await resT1.json()).table;

      const resT2 = await request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number: t2Num, capacity: 2, floor: 'Ground', section: 'Window' },
      });
      expect(resT2.ok()).toBeTruthy();
      const table2 = (await resT2.json()).table;

      const resT3 = await request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number: t3Num, capacity: 6, floor: 'Patio', section: 'Terrace' },
      });
      expect(resT3.ok()).toBeTruthy();
      const table3 = (await resT3.json()).table;

      const resT4 = await request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number: t4Num, capacity: 4, floor: 'Patio', section: 'Terrace' },
      });
      expect(resT4.ok()).toBeTruthy();
      const table4 = (await resT4.json()).table;

      // Deactivate T4 to test inactive filtering
      const resDeact = await request.post(`${BASE}/api/tables/${table4.id}/deactivate`, {
        headers: authHeaders,
      });
      expect(resDeact.ok()).toBeTruthy();

      // Create active dine-in order on Table 1
      const orderRes1 = await request.post(`${BASE}/api/orders`, {
        headers: authHeaders,
        data: {
          type: 'dine_in',
          table_id: table1.id,
          guest_count: 3,
          items: [{ product_id: 'e2e-product', quantity: 2 }],
        },
      });
      expect(orderRes1.status()).toBe(201);
      const order1 = (await orderRes1.json()).order;

      // Login via UI
      await page.goto(`${BASE}/auth/login`);
      await page.getByLabel('Email').fill('manager@flo.local');
      await page.getByLabel('Password').fill('E2ePass123!');
      await page.getByRole('button', { name: 'Sign In' }).click();
      await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15_000 });

      // ─────────────────────────────────────────────────────────────────────────
      // SCENARIO 1: Floorplan Table Move
      // ─────────────────────────────────────────────────────────────────────────
      await page.goto(`${BASE}/tables`);
      await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();

      // Switch to Floor plan view
      const floorPlanToggle = page.getByRole('button', { name: 'Floor plan' });
      await floorPlanToggle.click();

      // In floorplan view, click table T1 to open action sheet
      const t1Trigger = page.locator(`text=${t1Num}`).first();
      await expect(t1Trigger).toBeVisible();
      await t1Trigger.click();

      // Action sheet should show "Move Table" action
      const moveTableAction = page.getByRole('button', { name: 'Move Table' });
      await expect(moveTableAction).toBeVisible();

      // Click Move Table to open MoveTableModal
      await moveTableAction.click();

      const moveModal = page.locator('div[role="dialog"]');
      await expect(moveModal).toBeVisible();
      await expect(moveModal.locator('#move-table-modal-title')).toContainText('Move Order');

      // Verify source table banner
      await expect(moveModal.locator(`text=${t1Num}`).first()).toBeVisible();
      await expect(moveModal.locator(`text=#${order1.order_number}`)).toBeVisible();

      // Verify floor filter pills are visible inside modal (Ground, Patio)
      const modalFloorFilter = moveModal.locator('div[aria-label="Filter tables by floor"]');
      await expect(modalFloorFilter.getByRole('button', { name: 'All floors' })).toBeVisible();
      await expect(modalFloorFilter.getByRole('button', { name: 'Ground' })).toBeVisible();
      await expect(modalFloorFilter.getByRole('button', { name: 'Patio' })).toBeVisible();

      // Candidate T2 should be available and visible
      const candidateT2 = moveModal.getByRole('button', { name: new RegExp(t2Num) });
      await expect(candidateT2).toBeVisible();
      await expect(candidateT2).toBeEnabled();

      // Inactive T4 must NOT be rendered
      await expect(moveModal.getByRole('button', { name: new RegExp(t4Num) })).not.toBeVisible();

      // Take screenshot 1: MoveTableModal in Floorplan
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '01-floorplan-move-modal.png'),
        fullPage: true,
      });

      // Select candidate T2
      await candidateT2.click();

      // Confirm button should reflect "Move to {table}"
      const confirmButton = moveModal.getByRole('button', { name: new RegExp(`Move to ${t2Num}`) });
      await expect(confirmButton).toBeEnabled();

      // Execute Move
      await confirmButton.click();

      // Verify success toast
      await expect(page.locator(`text=Order moved from ${t1Num} to ${t2Num}`)).toBeVisible({
        timeout: 10_000,
      });

      // Wait for modal to close
      await expect(moveModal).not.toBeVisible();

      // Take screenshot 2: After Floorplan Move
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '02-floorplan-move-completed.png'),
        fullPage: true,
      });

      // Verify database state: T1 is available, T2 is occupied
      const checkTables1 = await (
        await request.get(`${BASE}/api/tables`, { headers: authHeaders })
      ).json();
      const checkedT1 = checkTables1.tables.find(
        (t: { id: string; status: string }) => t.id === table1.id,
      );
      const checkedT2 = checkTables1.tables.find(
        (t: { id: string; status: string; activeOrder?: { id: string } }) => t.id === table2.id,
      );
      expect(checkedT1.status).toBe('available');
      expect(checkedT2.status).toBe('occupied');
      expect(checkedT2.activeOrder.id).toBe(order1.id);

      // ─────────────────────────────────────────────────────────────────────────
      // SCENARIO 2: Tables List Table Move
      // ─────────────────────────────────────────────────────────────────────────
      // Switch back to List view
      const listToggle = page.getByRole('button', { name: 'List' });
      await listToggle.click();

      // Find table card for T2 (now occupied)
      const t2Card = page
        .locator(`div:has-text("${t2Num}")`)
        .filter({ hasText: 'Occupied' })
        .first();
      await expect(t2Card).toBeVisible();

      // T2 should have inline "Move Table" button
      const moveBtnOnT2 = t2Card.getByRole('button', { name: 'Move Table' }).first();
      await expect(moveBtnOnT2).toBeVisible();

      // Open MoveTableModal from tables list
      await moveBtnOnT2.click();

      const listMoveModal = page.locator('div[role="dialog"]');
      await expect(listMoveModal).toBeVisible();
      await expect(
        listMoveModal.locator(`text=Transfer active order from ${t2Num} to another table.`),
      ).toBeVisible();

      // Take screenshot 3: MoveTableModal from Tables List
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '03-table-list-move-modal.png'),
        fullPage: true,
      });

      // Select T1 (which is now available)
      const candidateT1 = listMoveModal.getByRole('button', { name: new RegExp(t1Num) });
      await expect(candidateT1).toBeVisible();
      await expect(candidateT1).toBeEnabled();
      await candidateT1.click();

      const confirmMoveToListT1 = listMoveModal.getByRole('button', {
        name: new RegExp(`Move to ${t1Num}`),
      });
      await confirmMoveToListT1.click();

      await expect(page.locator(`text=Order moved from ${t2Num} to ${t1Num}`)).toBeVisible({
        timeout: 10_000,
      });

      await expect(listMoveModal).not.toBeVisible();

      // Take screenshot 4: After Tables List Move
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '04-table-list-move-completed.png'),
        fullPage: true,
      });

      // Verify T1 is occupied again, T2 is available
      const checkTables2 = await (
        await request.get(`${BASE}/api/tables`, { headers: authHeaders })
      ).json();
      expect(
        checkTables2.tables.find((t: { id: string; status: string }) => t.id === table1.id).status,
      ).toBe('occupied');
      expect(
        checkTables2.tables.find((t: { id: string; status: string }) => t.id === table2.id).status,
      ).toBe('available');

      // ─────────────────────────────────────────────────────────────────────────
      // SCENARIO 3: POS Checkout Modal Table Move
      // ─────────────────────────────────────────────────────────────────────────
      await page.goto(`${BASE}/pos`);
      await page.waitForLoadState('networkidle');

      // In POS top bar, click the Select Table button
      const posTableBtn = page.getByRole('button', { name: /Select Table|Table/i }).first();
      await expect(posTableBtn).toBeVisible({ timeout: 10_000 });
      await posTableBtn.click();

      // The TablePickerModal should display tables
      const tablePickerModal = page.locator('div:has-text("Select Table")').last();
      await expect(tablePickerModal).toBeVisible();

      // Click occupied table T1 in table picker
      const occupiedT1InPos = page.locator(`button:has-text("${t1Num}")`).first();
      await expect(occupiedT1InPos).toBeVisible();
      await occupiedT1InPos.click();

      // TableCheckoutModal should open showing active order details
      const checkoutModal = page.locator('div:has-text("Table")').filter({ hasText: t1Num }).last();
      await expect(checkoutModal).toBeVisible();
      await expect(page.locator(`text=#${order1.order_number}`)).toBeVisible();

      // Verify "Move Table" button in checkout modal header
      const posCheckoutMoveBtn = page.getByRole('button', { name: 'Move Table' });
      await expect(posCheckoutMoveBtn).toBeVisible();

      // Take screenshot 5: TableCheckoutModal with Move Table button
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '05-pos-checkout-modal.png'),
        fullPage: true,
      });

      // Click "Move Table" button in POS checkout modal
      await posCheckoutMoveBtn.click();

      // MoveTableModal opens on top of POS
      const posMoveModal = page.locator('div[role="dialog"]');
      await expect(posMoveModal).toBeVisible();

      // Take screenshot 6: MoveTableModal over POS
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '06-pos-move-modal.png'),
        fullPage: true,
      });

      // Select candidate T2 and confirm move
      const candidateT2InPos = posMoveModal.getByRole('button', { name: new RegExp(t2Num) });
      await candidateT2InPos.click();

      const confirmMovePos = posMoveModal.getByRole('button', {
        name: new RegExp(`Move to ${t2Num}`),
      });
      await confirmMovePos.click();

      // Verify success toast
      await expect(page.locator(`text=Order moved from ${t1Num} to ${t2Num}`)).toBeVisible({
        timeout: 10_000,
      });

      // Both modals close and POS view updates
      await expect(posMoveModal).not.toBeVisible();

      // Take screenshot 7: POS state after table move
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '07-pos-table-moved.png'),
        fullPage: true,
      });

      // Verify database state: T2 is occupied with order1, T1 is available
      const checkTables3 = await (
        await request.get(`${BASE}/api/tables`, { headers: authHeaders })
      ).json();
      expect(
        checkTables3.tables.find((t: { id: string; status: string }) => t.id === table2.id).status,
      ).toBe('occupied');
      expect(
        checkTables3.tables.find((t: { id: string; status: string }) => t.id === table1.id).status,
      ).toBe('available');

      // ─────────────────────────────────────────────────────────────────────────
      // SCENARIO 4: Adversarial / Guard - Occupied & Inactive Destination Prevention
      // ─────────────────────────────────────────────────────────────────────────
      // Open a second order on T3 so T3 is also occupied
      const orderRes2 = await request.post(`${BASE}/api/orders`, {
        headers: authHeaders,
        data: {
          type: 'dine_in',
          table_id: table3.id,
          guest_count: 2,
          items: [{ product_id: 'e2e-product', quantity: 1 }],
        },
      });
      expect(orderRes2.status()).toBe(201);

      // Open MoveTableModal for T2 (which is occupied)
      await page.goto(`${BASE}/tables`);
      await page.waitForLoadState('networkidle');

      const t2CardForGuard = page
        .locator(`div:has-text("${t2Num}")`)
        .filter({ hasText: 'Occupied' })
        .first();
      const moveBtnGuard = t2CardForGuard.getByRole('button', { name: 'Move Table' }).first();
      await moveBtnGuard.click();

      const guardModal = page.locator('div[role="dialog"]');
      await expect(guardModal).toBeVisible();

      // T3 is occupied: must be rendered as disabled
      const occupiedCandidateT3 = guardModal.getByRole('button', { name: new RegExp(t3Num) });
      await expect(occupiedCandidateT3).toBeVisible();
      await expect(occupiedCandidateT3).toBeDisabled();

      // Inactive table T4 must not be in candidate list
      await expect(guardModal.getByRole('button', { name: new RegExp(t4Num) })).not.toBeVisible();

      // Take screenshot 8: Guard against occupied / inactive tables
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '08-occupied-table-disabled.png'),
        fullPage: true,
      });

      // Close modal
      await guardModal.getByRole('button', { name: 'Cancel' }).first().click();
      await expect(guardModal).not.toBeVisible();
    } finally {
      // Restore business settings
      await request
        .put(`${BASE}/api/settings/business`, {
          headers: authHeaders,
          data: originalBusiness,
        })
        .catch(() => {});
    }
  });
});
