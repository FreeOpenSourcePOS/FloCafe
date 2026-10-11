import { test, expect, request as playwrightRequest } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const SCREENSHOTS_DIR = path.resolve(
  __dirname,
  '../../data/flocafe-pos-keyboard-shortcuts-r1/screenshots',
);
const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};

let originalBusiness: Record<string, unknown> = {};
let createdTableId: string | null = null;

test.describe('POS Keyboard Shortcuts & Rapid Cashier Ergonomics', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    const req = await playwrightRequest.newContext();
    const res = await req.get(`${BASE}/api/settings/business`, { headers: managerHeaders });
    if (res.ok()) {
      originalBusiness = await res.json();
      await req.put(`${BASE}/api/settings/business`, {
        headers: managerHeaders,
        data: { ...originalBusiness, tables_required: true, billing_type: 'prepaid' },
      });
    }

    // Ensure at least one table exists for F2 picker
    const tableResponse = await req
      .post(`${BASE}/api/tables`, {
        headers: managerHeaders,
        data: { number: 'E2E-KB-T1', capacity: 4 },
      })
      .catch(() => null);
    if (tableResponse?.ok()) {
      const { table } = await tableResponse.json();
      createdTableId = table.id;
    }
    await req.dispose();
  });

  test.afterAll(async () => {
    if (Object.keys(originalBusiness).length > 0 || createdTableId) {
      const req = await playwrightRequest.newContext();
      if (Object.keys(originalBusiness).length > 0) {
        await req.put(`${BASE}/api/settings/business`, {
          headers: managerHeaders,
          data: originalBusiness,
        });
      }
      if (createdTableId) {
        await req.post(`${BASE}/api/tables/${createdTableId}/deactivate`, {
          headers: managerHeaders,
        });
      }
      await req.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  });

  test('? opens keyboard shortcuts modal cheat sheet, Escape closes it', async ({ page }) => {
    // Press '?' to open modal
    await page.keyboard.press('?');
    const modal = page.getByTestId('keyboard-shortcuts-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await expect(modal.getByText('Speed Cashier & Tendering')).toBeVisible();
    const clippedDescriptions = await modal
      .getByTestId('keyboard-shortcut-description')
      .evaluateAll((descriptions) =>
        descriptions
          .filter((description) => description.scrollWidth > description.clientWidth)
          .map((description) => description.textContent?.trim()),
      );
    expect(clippedDescriptions).toEqual([]);

    // Take screenshot of modal
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'keyboard-shortcuts-modal.png') });

    // Press Escape to dismiss
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
  });

  test('/ focuses product search input, and multiplier search adds item with quantity', async ({
    page,
  }) => {
    // Blur any active element
    await page.locator('body').click({ position: { x: 10, y: 10 } });

    // Press '/' to focus search
    await page.keyboard.press('/');
    const searchInput = page.getByTestId('pos-product-search');
    await expect(searchInput).toBeFocused();

    // Integer-only products must reject fractional multiplier quantities
    await searchInput.fill('1.5*Coffee');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cart-item')).toHaveCount(0);

    // Type 3*Coffee to test multiplier search
    await searchInput.fill('3*Coffee');
    await page.keyboard.press('Enter');

    // Cart should now have item with quantity 3
    const cartItem = page.getByTestId('cart-item').first();
    await expect(cartItem).toBeVisible({ timeout: 5_000 });
    const qtySpan = cartItem.getByTestId('cart-item-qty');
    await expect(qtySpan).toHaveText('3');

    await searchInput.fill('2*Coffee');
    await page.getByTestId('pos-product-card').first().click();
    await expect(qtySpan).toHaveText('5');

    // Take screenshot of multiplier cart
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'keyboard-multiplier-cart.png') });

    // Blur search input by clicking body
    await page.locator('body').click({ position: { x: 10, y: 10 } });

    // Test '+' key increments cart quantity to 6
    await page.keyboard.press('+');
    await expect(qtySpan).toHaveText('6');

    // Test '-' key decrements cart quantity back to 5
    await page.keyboard.press('-');
    await expect(qtySpan).toHaveText('5');
  });

  test('F2 toggles table picker, and Escape dismisses it', async ({ page }) => {
    // Press F2 to open table picker
    await page.keyboard.press('F2');
    const tableModal = page
      .locator('div.fixed.inset-0')
      .filter({ hasText: /select table|tables/i });
    await expect(tableModal).toBeVisible({ timeout: 5_000 });

    // F2 toggles the active table picker closed
    await page.keyboard.press('F2');
    await expect(tableModal).not.toBeVisible();

    // F2 does not open the table picker for takeaway orders
    await page.getByRole('button', { name: 'Takeaway' }).click();
    await page.keyboard.press('F2');
    await expect(tableModal).not.toBeVisible();

    await page.getByRole('button', { name: /Dine in/i }).click();
    await page.keyboard.press('F2');
    await expect(tableModal).toBeVisible({ timeout: 5_000 });

    // Press Escape to close table picker
    await page.keyboard.press('Escape');
    await expect(tableModal).not.toBeVisible();
  });

  test('F4 opens checkout modal, and Space tenders cash to complete order', async ({
    page,
  }) => {
    // Select Takeaway mode so checkout does not require table selection
    await page.getByRole('button', { name: 'Takeaway' }).click();

    // Add simple product (E2E Coffee) to cart
    const productCard = page.getByTestId('pos-product-card').first();
    await productCard.click();
    const cartItem = page.getByTestId('cart-item').first();
    await expect(cartItem).toBeVisible({ timeout: 5_000 });

    // Blur any input
    await page.locator('body').click({ position: { x: 10, y: 10 } });

    // Press F4 to trigger checkout
    await page.keyboard.press('F4');

    // Checkout modal appears
    const checkoutModal = page.getByTestId('prepaid-checkout-modal');
    await expect(checkoutModal).toBeVisible({ timeout: 5_000 });

    // Wait for tax preview calculation to settle
    await expect(checkoutModal.getByText(/Total Due/i)).toBeVisible({ timeout: 5_000 });

    // Press Space inside checkout modal to tender cash and complete
    await page.keyboard.press('Space');

    // Order settles and checkout modal closes
    await expect(checkoutModal).not.toBeVisible({ timeout: 10_000 });

    // Take screenshot of completed state
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'keyboard-flow-order-completed.png'),
    });
  });

  test('typing immunity: shortcuts are suppressed when typing in inputs', async ({ page }) => {
    // Focus search input
    const searchInput = page.getByTestId('pos-product-search');
    await searchInput.focus();

    // Type spaces, +, -, / in input
    await page.keyboard.type('test + - / space');

    // Ensure no modals opened
    const shortcutsModal = page.getByTestId('keyboard-shortcuts-modal');
    await expect(shortcutsModal).not.toBeVisible();
  });
});
