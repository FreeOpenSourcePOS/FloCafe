import { test, expect, type Locator } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';

test('KDS kanban requires confirmation when skipping preparation stages', async ({ page }) => {
  // Set generous desktop viewport
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. Create a fresh order via POS API with pending kitchen status
  const loginRes = await page.request.post(`${E2E_BASE_URL}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: 'E2ePass123!' },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { access_token } = await loginRes.json();

  const authHeaders = {
    Authorization: `Bearer ${access_token}`,
    'Content-Type': 'application/json',
  };
  const suffix = Math.random().toString(36).slice(2, 8);
  const groupRes = await page.request.post(`${E2E_BASE_URL}/api/addon-groups`, {
    headers: authHeaders,
    data: {
      name: `E2E Smash Extras ${suffix}`,
      is_required: false,
      min_selection: 0,
      max_selection: 5,
      allow_multiple_quantities: true,
      addons: [
        { name: 'Extra Cheese', price: 10 },
        { name: 'Bacon', price: 15 },
      ],
    },
  });
  expect(groupRes.ok()).toBeTruthy();
  const { addon_group: addonGroup } = await groupRes.json();
  const extraCheese = addonGroup.addons.find((a: { name: string }) => a.name === 'Extra Cheese');
  const bacon = addonGroup.addons.find((a: { name: string }) => a.name === 'Bacon');

  const productRes = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers: authHeaders,
    data: {
      name: `E2E Smash Burger ${suffix}`,
      category_id: 'e2e-category',
      price: 60,
      tax_type: 'none',
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
      is_active: true,
      addon_group_ids: [addonGroup.id],
    },
  });
  expect(productRes.ok()).toBeTruthy();
  const { product: kanbanProduct } = await productRes.json();

  const orderRes = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: authHeaders,
    data: {
      type: 'dine_in',
      items: [
        {
          product_id: kanbanProduct.id,
          quantity: 2,
          addons: [
            { id: extraCheese.id, name: 'Extra Cheese', price: 10, quantity: 2 },
            { id: bacon.id, name: 'Bacon', price: 15, quantity: 1 },
          ],
          special_instructions: 'No onions',
        },
      ],
    },
  });
  await page.request.delete(`${E2E_BASE_URL}/api/products/${kanbanProduct.id}`, {
    headers: authHeaders,
  });
  await page.request.delete(`${E2E_BASE_URL}/api/addon-groups/${addonGroup.id}`, {
    headers: authHeaders,
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();
  const orderNumStr = `#${order.order_number}`;

  // 2. Open standalone KDS
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  // 3. Switch to Kanban view
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByRole('button', { name: 'Kanban' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Column drop targets
  const getColumn = (name: string) =>
    page
      .locator('div.flex-1.min-w-\\[260px\\]')
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator('div[style*="min-height"]');

  const waitingCol = getColumn('Waiting');
  const preparingCol = getColumn('Preparing');
  const readyCol = getColumn('Ready');
  const deliveredCol = getColumn('Delivered');

  await expect(waitingCol).toBeVisible();
  await expect(preparingCol).toBeVisible();
  await expect(readyCol).toBeVisible();
  await expect(deliveredCol).toBeVisible();

  const cardIn = (col: Locator) =>
    col
      .locator('div.select-none.cursor-grab:not([data-dnd-placeholder])')
      .filter({ hasText: orderNumStr })
      .first();

  // Find the card for our order in Waiting column and verify inline add-ons + notes
  const waitingCard = cardIn(waitingCol);
  await expect(waitingCard).toBeVisible();
  await expect(waitingCard).not.toHaveClass(/pointer-events-none/);
  await expect(waitingCard.getByText('+ Extra Cheese ×2', { exact: true })).toBeVisible();
  await expect(waitingCard.getByText('+ Bacon', { exact: true })).toBeVisible();
  await expect(waitingCard.getByText('"No onions"', { exact: true })).toBeVisible();
  await expect(waitingCard.getByText('+2', { exact: true })).toHaveCount(0);

  // Helper for dnd-kit pointer drag and drop from card header
  const dragCard = async (sourceCard: Locator, targetColumn: Locator, desc = '') => {
    console.log(`\n[Drag] ${desc}`);
    await expect(sourceCard).toBeVisible({ timeout: 10000 });
    await expect(sourceCard).not.toHaveClass(/pointer-events-none/);

    await sourceCard.scrollIntoViewIfNeeded();
    await targetColumn.scrollIntoViewIfNeeded();

    const headerLoc = sourceCard.locator('span.font-bold').first();
    const sourceBox = await headerLoc.boundingBox();
    const targetBox = await targetColumn.boundingBox();
    if (!sourceBox || !targetBox) throw new Error('Could not compute bounding boxes for drag');

    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    const endX = targetBox.x + targetBox.width / 2;
    const endY = targetBox.y + Math.min(100, Math.max(50, targetBox.height / 2));

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 15, startY + 15, { steps: 10 });
    await page.waitForTimeout(100);
    await page.mouse.move(endX, endY, { steps: 35 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(250);
  };

  // -------------------------------------------------------------
  // Step A: Single-step forward move (Waiting -> Preparing)
  // Single-step moves stay one-touch: NO confirmation dialog shown
  // -------------------------------------------------------------
  await dragCard(cardIn(waitingCol), preparingCol, 'Waiting -> Preparing (single-step)');
  await expect(page.getByRole('heading', { name: 'Skip a stage?' })).toHaveCount(0);

  await expect(cardIn(preparingCol)).toBeVisible({ timeout: 10000 });
  await expect(cardIn(preparingCol)).not.toHaveClass(/pointer-events-none/);
  await expect(cardIn(waitingCol)).toHaveCount(0);
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------------
  // Step B: Multi-step forward move (Preparing -> Delivered, skipping Ready)
  // Accidental completion protection: MUST require explicit confirmation
  // ---------------------------------------------------------------------
  await dragCard(cardIn(preparingCol), deliveredCol, 'Preparing -> Delivered (skips Ready)');

  const dialogTitle = page.getByRole('heading', { name: 'Skip a stage?' });
  await expect(dialogTitle).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByText('This will mark the item as Delivered and skip the stages in between.'),
  ).toBeVisible({ timeout: 10000 });
  const cancelBtn = page.getByRole('button', { name: 'Cancel' });
  const confirmDeliveredBtn = page.getByRole('button', { name: 'Mark as Delivered' });
  await expect(cancelBtn).toBeVisible({ timeout: 10000 });
  await expect(confirmDeliveredBtn).toBeVisible({ timeout: 10000 });

  // ---------------------------------------------------------------------
  // Step C: Cancel confirmation -> card remains in Preparing
  // ---------------------------------------------------------------------
  await cancelBtn.click();
  await expect(dialogTitle).toHaveCount(0);
  await expect(cardIn(preparingCol)).toBeVisible({ timeout: 10000 });
  await expect(cardIn(preparingCol)).not.toHaveClass(/pointer-events-none/);
  await expect(cardIn(deliveredCol)).toHaveCount(0);
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------------
  // Step D: Drag again and Confirm -> card commits transition to Delivered
  // ---------------------------------------------------------------------
  await dragCard(cardIn(preparingCol), deliveredCol, 'Preparing -> Delivered (confirm)');
  await expect(dialogTitle).toBeVisible({ timeout: 10000 });
  await confirmDeliveredBtn.click();
  await expect(dialogTitle).toHaveCount(0);

  await expect(cardIn(deliveredCol)).toBeVisible({ timeout: 10000 });
  await expect(cardIn(deliveredCol)).not.toHaveClass(/pointer-events-none/);
  await expect(cardIn(preparingCol)).toHaveCount(0);

  // ---------------------------------------------------------------------
  // Step E: Backward drag (Delivered -> Preparing)
  // Backward moves stay one-touch: NO confirmation dialog
  // ---------------------------------------------------------------------
  await dragCard(cardIn(deliveredCol), preparingCol, 'Delivered -> Preparing (backward)');
  await expect(page.getByRole('heading', { name: 'Skip a stage?' })).toHaveCount(0);
  await expect(cardIn(preparingCol)).toBeVisible({ timeout: 10000 });
  await expect(cardIn(preparingCol)).not.toHaveClass(/pointer-events-none/);
  await expect(cardIn(deliveredCol)).toHaveCount(0);
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------------
  // Step F: Backward drag to Waiting, then skip drag Waiting -> Ready (skipping Preparing)
  // ---------------------------------------------------------------------
  await dragCard(cardIn(preparingCol), waitingCol, 'Preparing -> Waiting (backward)');
  await expect(cardIn(waitingCol)).toBeVisible({ timeout: 10000 });
  await expect(cardIn(waitingCol)).not.toHaveClass(/pointer-events-none/);

  await dragCard(cardIn(waitingCol), readyCol, 'Waiting -> Ready (skips Preparing)');
  await expect(dialogTitle).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByText('This will mark the item as Ready and skip the stages in between.'),
  ).toBeVisible({ timeout: 10000 });
  const confirmReadyBtn = page.getByRole('button', { name: 'Mark as Ready' });
  await expect(confirmReadyBtn).toBeVisible({ timeout: 10000 });

  await confirmReadyBtn.click();
  await expect(dialogTitle).toHaveCount(0);
  await expect(cardIn(readyCol)).toBeVisible({ timeout: 10000 });
  await expect(cardIn(readyCol)).not.toHaveClass(/pointer-events-none/);
  await expect(cardIn(waitingCol)).toHaveCount(0);
});
