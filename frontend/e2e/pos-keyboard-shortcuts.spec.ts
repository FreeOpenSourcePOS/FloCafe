import { test, expect, request as playwrightRequest } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const SCREENSHOTS_DIR =
  process.env.E2E_EVIDENCE_DIR ||
  path.resolve(__dirname, '../../data/flocafe-pos-keyboard-shortcuts-r1/screenshots');
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
    await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 20_000 });
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

    // When an input is focused and F1 opens help, a single Escape closes help before blurring the input
    const searchInput = page.getByTestId('pos-product-search');
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
    await page.keyboard.press('F1');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
    await expect(searchInput).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeFocused();
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

    // Browser/OS modifier combinations must not alter cart quantity
    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Meta+Minus');
    await page.keyboard.press('Alt+Minus');
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '-', code: 'Digit6', altKey: true, bubbles: true }),
      );
    });
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

    // macOS Option+2 (key: '™', code: 'Digit2') toggles table picker open and closed
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '™', code: 'Digit2', altKey: true, bubbles: true }),
      );
    });
    await expect(tableModal).toBeVisible({ timeout: 5_000 });
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '™', code: 'Digit2', altKey: true, bubbles: true }),
      );
    });
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

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 600 },
    { width: 390, height: 844 },
  ]) {
    test(`checkout keeps the payment station visible at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Takeaway' }).click();
      await page.getByTestId('pos-product-card').first().click();
      await page.locator('body').click({ position: { x: 10, y: 10 } });
      await page.keyboard.press('F4');
      const modal = page.getByTestId('prepaid-checkout-modal');
      await expect(modal.getByTestId('prepaid-checkout-summary')).toBeVisible();
      await page.setViewportSize(viewport);
      const keypad = modal.getByLabel('Numeric keypad');
      const clear = keypad.getByRole('button', { name: 'Clear amount' });
      const before = await clear.boundingBox();
      expect(before).not.toBeNull();
      expect(before!.y).toBeGreaterThanOrEqual(0);
      expect(before!.y + before!.height).toBeLessThanOrEqual(viewport.height);
      const cash = modal.getByRole('button', { name: 'Cash', exact: true });
      const card = modal.getByRole('button', { name: 'Card', exact: true });
      await cash.click();
      const cashInput = cash.locator('..').locator('input');
      await cashInput.fill('5');
      await card.click();
      await cash.click();
      await expect(cashInput).toHaveValue('5');
      const inputBounds = await cashInput.boundingBox();
      expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
      expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(viewport.width);
      const after = await clear.boundingBox();
      expect(after!.y).toBe(before!.y);
      if (viewport.width < 1024) {
        await modal.getByRole('button', { name: 'Items', exact: true }).click();
        await expect(modal.getByTestId('prepaid-checkout-summary')).toBeVisible();
        expect((await clear.boundingBox())!.y).toBe(before!.y);
      }
      await modal.getByRole('button', { name: 'Discounts', exact: true }).click();
      expect((await clear.boundingBox())!.y).toBe(before!.y);
    });
  }

  test('prepaid checkout stays visible and locked while submission is pending', async ({
    page,
  }) => {
    let releaseRequest!: () => void;
    let markStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() === 'POST') {
        markStarted();
        await requestGate;
      }
      await route.continue();
    });
    try {
      await page.getByRole('button', { name: 'Takeaway' }).click();
      await page.getByTestId('pos-product-card').first().click();
      await page.locator('body').click({ position: { x: 10, y: 10 } });
      await page.keyboard.press('F4');
      const modal = page.getByTestId('prepaid-checkout-modal');
      await expect(modal.getByTestId('prepaid-checkout-summary')).toBeVisible();
      await modal.getByRole('button', { name: 'Cash', exact: true }).click();
      await modal.getByRole('button', { name: /Confirm Payment/ }).click();
      await requestStarted;
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
      await expect(modal.getByLabel('Numeric keypad').locator('button:not(:disabled)')).toHaveCount(
        0,
      );
      await page.keyboard.press('Escape');
      await expect(modal).toBeVisible();
      releaseRequest();
      await modal.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15000 });
      await expect(modal).not.toBeVisible({ timeout: 15000 });
    } finally {
      releaseRequest();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('F4 opens checkout and payment requires the confirmation button', async ({ page }) => {
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

    // Space on the workspace does not submit a payment.
    await page.keyboard.press('Space');
    await expect(checkoutModal).toBeVisible();
    await expect(checkoutModal.getByText(/Balance Due:/)).toBeVisible();
    await checkoutModal.getByRole('button', { name: 'Cash', exact: true }).click();
    await expect(checkoutModal.getByText(/Balance Due:/)).toHaveCount(0);
    await checkoutModal.getByRole('button', { name: /Confirm Payment/ }).click();

    // Order settles and the cashier dismisses the confirmation.
    await checkoutModal.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(checkoutModal).not.toBeVisible({ timeout: 10_000 });

    // Take screenshot of completed state
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'keyboard-flow-order-completed.png'),
    });
  });

  test('F4 is suspended while the cart price override dialog is open', async ({ page }) => {
    // Price override is owner-only, so switch the session from manager to owner.
    await page.goto(`${BASE}/auth/login`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByRole('button', { name: 'Takeaway' }).click();
    await page.getByTestId('pos-product-card').first().click();
    const cartItem = page.getByTestId('cart-item').first();
    await expect(cartItem).toBeVisible({ timeout: 5_000 });

    await cartItem.getByRole('button', { name: 'Override price' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await cancel.focus();
    await expect(cancel).toBeFocused();

    await page.keyboard.press('F4');
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    const checkoutModal = page.getByTestId('prepaid-checkout-modal');
    await expect(checkoutModal).toHaveCount(0);

    await page.keyboard.press('F4');
    await expect(checkoutModal).toBeVisible({ timeout: 5_000 });
  });

  test('holding Space to open checkout or repeating Space/Enter inside modal does not auto-confirm', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Takeaway' }).click();

    const productCard = page.getByTestId('pos-product-card').first();
    await productCard.click();
    await expect(page.getByTestId('cart-item').first()).toBeVisible({ timeout: 5_000 });

    await page.locator('body').click({ position: { x: 10, y: 10 } });

    const billsBeforeRes = await page.request.get(`${BASE}/api/bills?status=paid`, {
      headers: managerHeaders,
    });
    expect(billsBeforeRes.ok()).toBe(true);
    const billsBeforeData = await billsBeforeRes.json();
    const paidBillsBeforeCount = billsBeforeData.pagination.total;

    let orderCreateRequests = 0;
    let paymentCreateRequests = 0;
    const onRequest = (request: { method: () => string; url: () => string }) => {
      if (request.method() !== 'POST') return;
      if (request.url().endsWith('/api/orders')) orderCreateRequests += 1;
      if (request.url().includes('/payments')) paymentCreateRequests += 1;
    };
    page.on('request', onRequest);

    try {
      // Repeat Space on canvas does not open checkout
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            repeat: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const checkoutModal = page.getByTestId('prepaid-checkout-modal');
      await expect(checkoutModal).not.toBeVisible();

      // Initial non-repeat Space opens prepaid checkout modal
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            repeat: false,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await expect(checkoutModal).toBeVisible({ timeout: 5_000 });

      // Emit immediate repeat Space events while modal mounts/calculates
      await page.evaluate(() => {
        for (let i = 0; i < 5; i += 1) {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ' ',
              code: 'Space',
              repeat: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      });

      // Wait for tax preview calculation to settle
      await expect(checkoutModal.getByText(/Total Due/i)).toBeVisible({ timeout: 5_000 });

      // Emit sustained repeat Space events after listener is active and preview is ready
      const repeatSpaceDefaultPrevented = await page.evaluate(() => {
        const results: boolean[] = [];
        for (let i = 0; i < 15; i += 1) {
          const ev = new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            repeat: true,
            bubbles: true,
            cancelable: true,
          });
          window.dispatchEvent(ev);
          results.push(ev.defaultPrevented);
        }
        return results.every(Boolean);
      });
      expect(repeatSpaceDefaultPrevented).toBe(true);

      // Modal remains open and no order/payment request was sent
      await expect(checkoutModal).toBeVisible();
      expect(orderCreateRequests).toBe(0);
      expect(paymentCreateRequests).toBe(0);

      // Repeat Enter inside modal (including when confirm button is focused) does not confirm and prevents default
      const confirmBtn = checkoutModal.locator('button', { hasText: /Confirm|Pay/i }).last();
      const cashMethodBtn = checkoutModal.getByRole('button', { name: /Cash/i }).first();
      await cashMethodBtn.click();
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.focus();

      const repeatEnterDefaultPrevented = await confirmBtn.evaluate((btn) => {
        const results: boolean[] = [];
        for (let i = 0; i < 5; i += 1) {
          const ev = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            repeat: true,
            bubbles: true,
            cancelable: true,
          });
          btn.dispatchEvent(ev);
          results.push(ev.defaultPrevented);
        }
        return results.every(Boolean);
      });
      expect(repeatEnterDefaultPrevented).toBe(true);
      await expect(checkoutModal).toBeVisible();
      expect(orderCreateRequests).toBe(0);
      expect(paymentCreateRequests).toBe(0);

      const billsMidRes = await page.request.get(`${BASE}/api/bills?status=paid`, {
        headers: managerHeaders,
      });
      const billsMidData = await billsMidRes.json();
      expect(billsMidData.pagination.total).toBe(paidBillsBeforeCount);

      // Release the key and verify a fresh Space cannot submit payment.
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      await confirmBtn.blur();
      await page.keyboard.press('Space');
      await expect(checkoutModal).toBeVisible();
      expect(orderCreateRequests).toBe(0);
      expect(paymentCreateRequests).toBe(0);
      const paymentDonePromise = page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/payments'),
      );
      await checkoutModal.getByRole('button', { name: /Confirm Payment/ }).click();
      await paymentDonePromise;
      await checkoutModal.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(checkoutModal).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('cart-item')).toHaveCount(0, { timeout: 10_000 });
      expect(orderCreateRequests).toBe(1);
      expect(paymentCreateRequests).toBe(1);

      const billsAfterRes = await page.request.get(`${BASE}/api/bills?status=paid`, {
        headers: managerHeaders,
      });
      const billsAfterData = await billsAfterRes.json();
      expect(billsAfterData.pagination.total).toBe(paidBillsBeforeCount + 1);

      // Verify Enter also requires an explicit payment action on a second order.
      await page.getByRole('button', { name: 'Takeaway' }).click();
      await productCard.click();
      await expect(page.getByTestId('cart-item').first()).toBeVisible({ timeout: 5_000 });
      await page.locator('body').click({ position: { x: 10, y: 10 } });
      await page.keyboard.press('Space');
      await expect(checkoutModal).toBeVisible({ timeout: 5_000 });
      await expect(checkoutModal.getByText(/Total Due/i)).toBeVisible({ timeout: 5_000 });

      await page.evaluate(() => {
        for (let i = 0; i < 5; i += 1) {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              repeat: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        window.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await expect(checkoutModal).toBeVisible();
      expect(orderCreateRequests).toBe(1);
      expect(paymentCreateRequests).toBe(1);

      await page.keyboard.press('Enter');
      await expect(checkoutModal).toBeVisible();
      expect(orderCreateRequests).toBe(1);
      expect(paymentCreateRequests).toBe(1);
      await checkoutModal.getByRole('button', { name: 'Cash', exact: true }).click();
      const enterPaymentDonePromise = page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/payments'),
      );
      await checkoutModal.getByRole('button', { name: /Confirm Payment/ }).click();
      await enterPaymentDonePromise;
      await checkoutModal.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(checkoutModal).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('cart-item')).toHaveCount(0, { timeout: 10_000 });
      expect(orderCreateRequests).toBe(2);
      expect(paymentCreateRequests).toBe(2);

      const billsAfterEnterRes = await page.request.get(`${BASE}/api/bills?status=paid`, {
        headers: managerHeaders,
      });
      const billsAfterEnterData = await billsAfterEnterRes.json();
      expect(billsAfterEnterData.pagination.total).toBe(paidBillsBeforeCount + 2);
    } finally {
      page.off('request', onRequest);
    }
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

  test('IME composition confirmation Enter in product search does not add product to cart', async ({
    page,
  }) => {
    const searchInput = page.getByTestId('pos-product-search');
    await searchInput.fill('Coffee');
    const matchingCard = page
      .getByTestId('pos-product-card')
      .filter({ hasText: 'E2E Coffee' })
      .first();
    await expect(matchingCard).toBeVisible({ timeout: 5_000 });

    await searchInput.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          isComposing: true,
          bubbles: true,
        }),
      );
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: false,
          bubbles: true,
        }),
      );
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });

    await expect(page.getByTestId('cart-item')).toHaveCount(0);
    await expect(searchInput).toHaveValue('Coffee');

    await searchInput.press('Enter');
    const cartItems = page.getByTestId('cart-item');
    await expect(cartItems).toHaveCount(1, { timeout: 5_000 });
    const cartItem = cartItems.first();
    await expect(cartItem).toContainText('E2E Coffee');
    await expect(cartItem.getByTestId('cart-item-qty')).toHaveText('1');
    await expect(searchInput).toHaveValue('');
  });

  test('trailing asterisk "3*", F6 customer search open/collapsed, customer modal shortcut isolation, Escape close, and country name', async ({
    page,
  }) => {
    // 1. Trailing asterisk "3*" keeps product grid visible mid-keystroke and adds qty 3 on click
    const searchInput = page.getByTestId('pos-product-search');
    await searchInput.fill('3*');
    const productCard = page.getByTestId('pos-product-card').first();
    await expect(productCard).toBeVisible();
    await searchInput.press('Enter');
    await expect(page.getByTestId('cart-item')).toHaveCount(0);
    await productCard.click();
    const cartItem = page.getByTestId('cart-item').first();
    await expect(cartItem).toBeVisible({ timeout: 5_000 });
    await expect(cartItem.getByTestId('cart-item-qty')).toHaveText('3');
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'pos-trailing-asterisk-quantity-search.png'),
    });

    // 2. F6 focuses customer search input when no customer is selected
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('F6');
    const customerSearchInput = page.getByTestId('pos-customer-search-input').first();
    await expect(customerSearchInput).toBeFocused();

    // 3. CreateCustomerModal suppresses background POS shortcuts and closes on Escape
    await customerSearchInput.fill('NewModalGuest');
    await expect(page.getByText('No matching results')).toBeVisible({ timeout: 5_000 });
    const createBtn = page.getByRole('button').filter({ hasText: 'NewModalGuest' }).first();
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    const createModal = page.locator('div.fixed.inset-0').filter({
      has: page.getByRole('heading', { name: 'Add Customer' }),
    });
    await expect(createModal).toBeVisible({ timeout: 5_000 });
    const createModalInput = createModal.locator('input').first();
    await createModalInput.focus();
    await expect(createModalInput).toBeFocused();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Meta+k');
    await expect(searchInput).not.toBeFocused();
    await createModal.getByRole('heading', { name: 'Add Customer' }).click();
    await page.keyboard.press('F2');
    await page.keyboard.press('F4');
    await page.keyboard.press('?');
    await expect(page.getByTestId('keyboard-shortcuts-modal')).not.toBeVisible();
    await expect(page.getByTestId('prepaid-checkout-modal')).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(createModal).not.toBeVisible();

    // 4. Select existing customer -> F6 clicks pos-customer-select-btn and opens EditCustomerModal
    await customerSearchInput.fill('E2E Guest');
    const guestResult = page.getByRole('button').filter({ hasText: 'E2E Guest' }).first();
    await expect(guestResult).toBeVisible({ timeout: 5_000 });
    await guestResult.click();
    await expect(page.getByTestId('pos-customer-select-btn').first()).toBeVisible();

    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('F6');
    const editModal = page.locator('div.fixed.inset-0').filter({
      has: page.getByRole('heading', { name: 'Edit Customer' }),
    });
    await expect(editModal).toBeVisible({ timeout: 5_000 });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'f6-customer-shortcut-edit-modal.png'),
    });

    // Suppresses background POS shortcuts (including Ctrl/Cmd+K in modal inputs) while EditCustomerModal is open
    const editModalInput = editModal.locator('input').first();
    await editModalInput.focus();
    await expect(editModalInput).toBeFocused();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Meta+k');
    await expect(searchInput).not.toBeFocused();
    await editModal.getByRole('heading', { name: 'Edit Customer' }).click();
    await page.keyboard.press('F2');
    await page.keyboard.press('F4');
    await page.keyboard.press('?');
    await expect(page.getByTestId('keyboard-shortcuts-modal')).not.toBeVisible();
    await expect(page.getByTestId('prepaid-checkout-modal')).not.toBeVisible();

    // Invalid phone shows resolved country name ("Thailand") instead of raw ISO ("TH")
    const phoneInput = editModal.locator('input[type="tel"]');
    await phoneInput.fill('123');
    await editModal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Thailand/)).toBeVisible({ timeout: 5_000 });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'edit-customer-invalid-phone-country-name.png'),
    });

    // Escape closes EditCustomerModal
    await page.keyboard.press('Escape');
    await expect(editModal).not.toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  });

  test('Escape closes the payment queue drawer in one press and FLOCAFE-TICKET Enter looks up ticket without focus leak', async ({
    page,
  }) => {
    const fetchedBillIds: string[] = [];
    await page.route('**/api/settings/multi_counter_enabled', async (route) => {
      await route.fulfill({ json: { setting: { key: 'multi_counter_enabled', value: 'true' } } });
    });
    await page.route('**/api/counters*', async (route) => {
      await route.fulfill({ json: { counters: [] } });
    });
    await page.route('**/api/orders/awaiting-payment*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          orders: [
            {
              id: 7777,
              order_number: 'ORD-7777',
              type: 'takeaway',
              total: 42,
              total_amount: 42,
              paid_amount: 0,
              ticket_balance: 42,
              ticket_paid_amount: 0,
              balance: 42,
              checkout_stage: 'awaiting_payment',
              release_status: 'scheduled',
              created_at: '2026-11-18 12:00:00',
              bill_id: 7778,
              bill_number: 'BILL-7778',
              bill_payment_status: 'unpaid',
            },
          ],
          awaiting_count: 1,
          blocked_count: 0,
          has_more: false,
          next_cursor: null,
        },
      });
    });
    await page.route('**/api/bills/*', async (route) => {
      const url = route.request().url();
      const id = url.split('/').pop() || '';
      fetchedBillIds.push(id);
      await route.fulfill({
        status: 200,
        json: {
          bill: {
            id: Number(id),
            bill_number: `BILL-${id}`,
            order_id: id === '7778' ? 7777 : 9991,
            subtotal: id === '7778' ? 42 : 10,
            tax_amount: 0,
            discount_amount: 0,
            service_charge: 0,
            delivery_charge: 0,
            total: id === '7778' ? 42 : 10,
            paid_amount: 0,
            balance: id === '7778' ? 42 : 10,
            payment_status: 'unpaid',
            payment_details: [],
          },
        },
      });
    });
    await page.route('**/api/orders/by-ticket/*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          order: { id: 9991, order_number: 'ORD-9991', type: 'takeaway' },
          bill: {
            id: 9992,
            bill_number: 'BILL-9992',
            order_id: 9991,
            subtotal: 10,
            tax_amount: 0,
            discount_amount: 0,
            service_charge: 0,
            delivery_charge: 0,
            total: 10,
            paid_amount: 0,
            balance: 10,
            payment_status: 'unpaid',
            payment_details: [],
          },
        },
      });
    });
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByTestId('pos-payment-queue-btn').click();
    const drawer = page.getByTestId('payment-queue-drawer');
    await expect(drawer).toBeVisible();

    const queueSearch = page.getByTestId('payment-queue-search');
    await expect(queueSearch).toBeFocused();

    // Typing FLOCAFE-TICKET: payload + Enter looks up the ticket immediately, blurs queue search, and opens PaymentModal
    await queueSearch.fill('FLOCAFE-TICKET:ORD-9991');
    await queueSearch.press('Enter');
    await expect(queueSearch).toHaveValue('');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await expect(queueSearch).not.toBeFocused();

    // Pressing Enter or typing digits inside PaymentModal must NOT leak into payment-queue-search or open ORD-7777
    await page.keyboard.press('Enter');
    await page.keyboard.type('25');
    await expect(queueSearch).toHaveValue('');
    expect(fetchedBillIds).not.toContain('7778');

    // Single Escape closes PaymentModal on top
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);

    // Single Escape closes the drawer even while payment-queue-search has focus
    await queueSearch.focus();
    await expect(queueSearch).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('pos-payment-queue-btn')).toBeFocused();
  });

  test('Enter in payment queue drawer does not auto-open blocked unpaid orders', async ({
    page,
  }) => {
    await page.route('**/api/settings/multi_counter_enabled', async (route) => {
      await route.fulfill({ json: { setting: { key: 'multi_counter_enabled', value: 'true' } } });
    });
    await page.route('**/api/counters*', async (route) => {
      await route.fulfill({ json: { counters: [] } });
    });
    await page.route('**/api/orders/awaiting-payment*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          orders: [
            {
              id: 503,
              order_number: 'BLK-UNPAID-503',
              type: 'takeaway',
              total: 20,
              total_amount: 20,
              paid_amount: 0,
              ticket_balance: 20,
              ticket_paid_amount: 0,
              balance: 20,
              checkout_stage: 'awaiting_payment',
              release_status: 'blocked',
              release_blocked_reason: 'Insufficient stock',
              created_at: '2026-11-18 12:00:00',
              bill_id: 603,
              bill_number: 'BILL-603',
              bill_payment_status: 'unpaid',
            },
          ],
          awaiting_count: 0,
          blocked_count: 1,
          has_more: false,
          next_cursor: null,
        },
      });
    });
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByTestId('pos-payment-queue-btn').click();
    const drawer = page.getByTestId('payment-queue-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('queue-ticket-BLK-UNPAID-503')).toBeVisible();

    const queueSearch = page.getByTestId('payment-queue-search');
    await expect(queueSearch).toBeFocused();
    await queueSearch.press('Enter');

    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('PaymentQueueDrawer Enter guards stale orders after failed search and during reopen fetch', async ({
    page,
  }) => {
    const fetchedBillIds: string[] = [];
    let queueMode: 'initial' | 'fail' | 'recover' | 'hold' = 'initial';
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    await page.route('**/api/settings/multi_counter_enabled', async (route) => {
      await route.fulfill({ json: { setting: { key: 'multi_counter_enabled', value: 'true' } } });
    });
    await page.route('**/api/counters*', async (route) => {
      await route.fulfill({ json: { counters: [] } });
    });
    await page.route('**/api/orders/awaiting-payment*', async (route) => {
      if (queueMode === 'fail') {
        await route.fulfill({ status: 500, json: { error: 'Temporary queue error' } });
        return;
      }
      if (queueMode === 'hold') {
        await holdGate;
        await route.fulfill({
          status: 200,
          json: {
            orders: [
              {
                id: 1002,
                order_number: 'ORD-1002',
                type: 'takeaway',
                total: 25,
                total_amount: 25,
                paid_amount: 0,
                ticket_balance: 25,
                ticket_paid_amount: 0,
                balance: 25,
                checkout_stage: 'awaiting_payment',
                release_status: 'scheduled',
                created_at: '2026-11-18 12:05:00',
                bill_id: 602,
                bill_number: 'BILL-602',
                bill_payment_status: 'unpaid',
              },
            ],
            awaiting_count: 1,
            blocked_count: 0,
            has_more: false,
            next_cursor: null,
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          orders: [
            {
              id: 1001,
              order_number: 'ORD-1001',
              type: 'takeaway',
              total: 19,
              total_amount: 19,
              paid_amount: 0,
              ticket_balance: 19,
              ticket_paid_amount: 0,
              balance: 19,
              checkout_stage: 'awaiting_payment',
              release_status: 'scheduled',
              created_at: '2026-11-18 12:00:00',
              bill_id: 601,
              bill_number: 'BILL-601',
              bill_payment_status: 'unpaid',
            },
          ],
          awaiting_count: 1,
          blocked_count: 0,
          has_more: false,
          next_cursor: null,
        },
      });
    });
    await page.route('**/api/bills/*', async (route) => {
      const id = route.request().url().split('/').pop() || '';
      fetchedBillIds.push(id);
      const isSecond = id === '602';
      await route.fulfill({
        status: 200,
        json: {
          bill: {
            id: Number(id),
            bill_number: `BILL-${id}`,
            order_id: isSecond ? 1002 : 1001,
            subtotal: isSecond ? 25 : 19,
            tax_amount: 0,
            discount_amount: 0,
            service_charge: 0,
            delivery_charge: 0,
            total: isSecond ? 25 : 19,
            paid_amount: 0,
            balance: isSecond ? 25 : 19,
            payment_status: 'unpaid',
            payment_details: [],
          },
        },
      });
    });
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByTestId('pos-payment-queue-btn').click();
    const drawer = page.getByTestId('payment-queue-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('queue-ticket-ORD-1001')).toBeVisible();

    const queueSearch = page.getByTestId('payment-queue-search');
    queueMode = 'fail';
    const failResp = page.waitForResponse(
      (res) => res.url().includes('/api/orders/awaiting-payment') && res.status() === 500,
    );
    await queueSearch.fill('777');
    await queueSearch.press('Enter');
    await failResp;

    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
    expect(fetchedBillIds).toEqual([]);

    queueMode = 'recover';
    const recoverResp = page.waitForResponse(
      (res) =>
        res.url().includes('/api/orders/awaiting-payment') &&
        res.url().includes('ORD-1001') &&
        res.status() === 200,
    );
    await queueSearch.fill('ORD-1001');
    await queueSearch.press('Enter');
    await recoverResp;

    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    expect(Array.from(new Set(fetchedBillIds))).toEqual(['601']);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
    await queueSearch.fill('');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    queueMode = 'hold';
    await page.getByTestId('pos-payment-queue-btn').click();
    await expect(drawer).toBeVisible();
    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
    expect(Array.from(new Set(fetchedBillIds))).toEqual(['601']);

    const reopenResp = page.waitForResponse(
      (res) => res.url().includes('/api/orders/awaiting-payment') && res.status() === 200,
    );
    releaseHold();
    await reopenResp;
    await expect(page.getByTestId('queue-ticket-ORD-1002')).toBeVisible();

    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    expect(Array.from(new Set(fetchedBillIds))).toEqual(['601', '602']);
  });

  test('PaymentQueueDrawer Enter prefers exact order_number match over substring noise rows', async ({
    page,
  }) => {
    const fetchedBillIds: string[] = [];
    const buildOrder = (overrides: Record<string, unknown>) => ({
      type: 'takeaway',
      total: 15,
      total_amount: 15,
      paid_amount: 0,
      ticket_balance: 15,
      ticket_paid_amount: 0,
      balance: 15,
      checkout_stage: 'awaiting_payment',
      release_status: 'scheduled',
      created_at: '2026-11-18 12:00:00',
      bill_payment_status: 'unpaid',
      ...overrides,
    });

    await page.route('**/api/settings/multi_counter_enabled', async (route) => {
      await route.fulfill({ json: { setting: { key: 'multi_counter_enabled', value: 'true' } } });
    });
    await page.route('**/api/counters*', async (route) => {
      await route.fulfill({ json: { counters: [] } });
    });
    await page.route('**/api/orders/awaiting-payment*', async (route) => {
      const search = new URL(route.request().url()).searchParams.get('search') || '';
      if (search === '0012' || search === '001') {
        await route.fulfill({
          status: 200,
          json: {
            orders: [
              buildOrder({ id: 1012, order_number: '0012', bill_id: 612, bill_number: 'BILL-612' }),
              buildOrder({
                id: 1045,
                order_number: '0045',
                customer_phone: '+15550012',
                bill_id: 645,
                bill_number: 'BILL-645',
              }),
            ],
            awaiting_count: 2,
            blocked_count: 0,
            has_more: search === '0012',
            next_cursor: null,
          },
        });
        return;
      }
      if (search === 'BLK-UNPAID-503') {
        await route.fulfill({
          status: 200,
          json: {
            orders: [
              buildOrder({
                id: 1053,
                order_number: 'BLK-UNPAID-503',
                release_status: 'blocked',
                release_blocked_reason: 'Insufficient stock',
                bill_id: 653,
                bill_number: 'BILL-653',
              }),
              buildOrder({
                id: 1099,
                order_number: '0099',
                customer_phone: 'BLK-UNPAID-503',
                bill_id: 699,
                bill_number: 'BILL-699',
              }),
            ],
            awaiting_count: 1,
            blocked_count: 1,
            has_more: false,
            next_cursor: null,
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          orders: [],
          awaiting_count: 0,
          blocked_count: 0,
          has_more: false,
          next_cursor: null,
        },
      });
    });
    await page.route('**/api/bills/*', async (route) => {
      const id = route.request().url().split('/').pop() || '';
      fetchedBillIds.push(id);
      await route.fulfill({
        status: 200,
        json: {
          bill: {
            id: Number(id),
            bill_number: `BILL-${id}`,
            order_id: 1012,
            subtotal: 15,
            tax_amount: 0,
            discount_amount: 0,
            service_charge: 0,
            delivery_charge: 0,
            total: 15,
            paid_amount: 0,
            balance: 15,
            payment_status: 'unpaid',
            payment_details: [],
          },
        },
      });
    });
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByTestId('pos-payment-queue-btn').click();
    const drawer = page.getByTestId('payment-queue-drawer');
    await expect(drawer).toBeVisible();
    const queueSearch = page.getByTestId('payment-queue-search');

    const nonExactResp = page.waitForResponse(
      (res) => res.url().includes('search=001') && !res.url().includes('search=0012'),
    );
    await queueSearch.fill('001');
    await queueSearch.press('Enter');
    await nonExactResp;
    await expect(page.getByTestId('queue-ticket-0012')).toBeVisible();
    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
    expect(fetchedBillIds).toEqual([]);

    const blockedExactResp = page.waitForResponse((res) =>
      res.url().includes('search=BLK-UNPAID-503'),
    );
    await queueSearch.fill('BLK-UNPAID-503');
    await queueSearch.press('Enter');
    await blockedExactResp;
    await expect(page.getByTestId('queue-ticket-BLK-UNPAID-503')).toBeVisible();
    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toHaveCount(0);
    expect(fetchedBillIds).toEqual([]);

    const exactResp = page.waitForResponse((res) => res.url().includes('search=0012'));
    await queueSearch.fill('0012');
    await queueSearch.press('Enter');
    await exactResp;
    await expect(page.getByTestId('queue-ticket-0012')).toBeVisible();
    await queueSearch.press('Enter');
    await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    expect(Array.from(new Set(fetchedBillIds))).toEqual(['612']);
  });

  test('Escape inside ScheduledOrdersDrawer EditOrderItemModal closes child modal before drawer', async ({
    page,
  }) => {
    await page.goto(`${BASE}/auth/login`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 20_000 });
    await setLanguage(page, 'en');

    await page.route('**/api/settings/scheduled_orders_enabled', async (route) => {
      await route.fulfill({
        json: { setting: { key: 'scheduled_orders_enabled', value: 'true' } },
      });
    });
    await page.route('**/api/orders/scheduled*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          orders: [
            {
              id: 8801,
              order_number: 'ORD-8801',
              type: 'takeaway',
              status: 'pending',
              release_status: 'scheduled',
              scheduled_for: '2035-01-15T10:30:00.000Z',
              total: 10,
              created_at: '2026-11-18 12:00:00',
              items: [
                {
                  id: 8802,
                  order_id: 8801,
                  product_id: 'prod-1',
                  product_name: 'E2E Coffee',
                  quantity: 1,
                  unit_price: 10,
                  total: 10,
                  status: 'pending',
                },
              ],
            },
          ],
          total_active: 1,
          has_more: false,
          next_cursor: null,
        },
      });
    });

    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByTestId('pos-scheduled-orders-btn').click();
    const drawer = page.getByTestId('scheduled-orders-drawer');
    await expect(drawer).toBeVisible();

    await page.getByTestId('scheduled-edit-item-btn-8802').click();
    const editQtyInput = page.locator('div.fixed.inset-0 input[type="number"]').last();
    await expect(editQtyInput).toBeVisible();
    await editQtyInput.focus();
    await expect(editQtyInput).toBeFocused();

    // 1st Escape closes EditOrderItemModal only; ScheduledOrdersDrawer stays open
    await page.keyboard.press('Escape');
    await expect(editQtyInput).toHaveCount(0);
    await expect(drawer).toBeVisible();

    // 2nd Escape closes ScheduledOrdersDrawer
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('ProductGrid search clear button and Escape clear non-empty filter before blurring', async ({
    page,
  }) => {
    const searchInput = page.getByTestId('pos-product-search');
    const clearBtn = page.getByTestId('pos-product-search-clear');

    await expect(clearBtn).toHaveCount(0);
    await searchInput.focus();
    await searchInput.fill('Coffee');
    await expect(clearBtn).toBeVisible();

    // Clicking [X] clears search and keeps focus in the search input
    await clearBtn.click();
    await expect(searchInput).toHaveValue('');
    await expect(clearBtn).toHaveCount(0);
    await expect(searchInput).toBeFocused();

    // First Escape clears non-empty search without blurring; second Escape blurs
    await searchInput.fill('Coffee');
    await expect(clearBtn).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchInput).toHaveValue('');
    await expect(clearBtn).toHaveCount(0);
    await expect(searchInput).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeFocused();
  });

  test('PrepaidCheckoutModal focused buttons are not hijacked by global Space/Enter quick-pay', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Takeaway' }).click();
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item').first()).toBeVisible({ timeout: 5_000 });

    let orderCreateRequests = 0;
    const onRequest = (req: { method: () => string; url: () => string }) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/orders')) orderCreateRequests += 1;
    };
    page.on('request', onRequest);

    try {
      await page.locator('body').click({ position: { x: 10, y: 10 } });
      await page.keyboard.press('F4');
      const checkoutModal = page.getByTestId('prepaid-checkout-modal');
      await expect(checkoutModal).toBeVisible({ timeout: 5_000 });
      await expect(checkoutModal.getByText(/Total Due/i)).toBeVisible({ timeout: 5_000 });

      const cardBtn = checkoutModal.getByRole('button', { name: /Card/i }).first();
      await cardBtn.focus();
      await expect(cardBtn).toBeFocused();
      await page.keyboard.press('Space');

      // Modal stays open and no order was prematurely submitted
      await expect(checkoutModal).toBeVisible();
      expect(orderCreateRequests).toBe(0);
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'prepaid-checkout-focused-button-guard.png'),
      });

      // Focusing Close button and pressing Enter closes modal without submitting
      const closeBtn = checkoutModal.getByRole('button', { name: /Close|Cancel/i }).first();
      await closeBtn.focus();
      await expect(closeBtn).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(checkoutModal).not.toBeVisible();
      expect(orderCreateRequests).toBe(0);
    } finally {
      page.off('request', onRequest);
    }
  });

  test('AddonModal disables + buttons at max_selection cap and AuthGuard enforces /print-test and /order-history-demo permissions', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const groupRes = await page.request.post(`${BASE}/api/addon-groups`, {
      headers: managerHeaders,
      data: {
        name: `Syrups ${suffix}`,
        is_required: false,
        min_selection: 0,
        max_selection: 2,
        allow_multiple_quantities: true,
        addons: [
          { name: 'Vanilla Syrup', price: 10 },
          { name: 'Hazelnut Syrup', price: 15 },
        ],
      },
    });
    expect(groupRes.status()).toBe(201);
    const groupId = (await groupRes.json()).addon_group.id as string;

    let productId: string | undefined;
    try {
      const prodRes = await page.request.post(`${BASE}/api/products`, {
        headers: managerHeaders,
        data: {
          name: `Addon Latte ${suffix}`,
          category_id: 'e2e-category',
          price: 80,
          addon_group_ids: [groupId],
        },
      });
      expect(prodRes.status()).toBe(201);
      productId = (await prodRes.json()).product.id as string;

      await page.reload();
      const addonCard = page
        .getByTestId('pos-product-card')
        .filter({ hasText: `Addon Latte ${suffix}` })
        .first();
      await expect(addonCard).toBeVisible({ timeout: 10_000 });
      await addonCard.click();

      const addonModal = page.locator('div.fixed.inset-0').filter({
        has: page.getByRole('heading', { name: `Addon Latte ${suffix}` }),
      });
      await expect(addonModal).toBeVisible({ timeout: 5_000 });

      const vanillaRow = addonModal
        .locator('div.min-h-14')
        .filter({ hasText: 'Vanilla Syrup' })
        .first();
      // Click + on Vanilla Syrup twice to reach max_selection = 2
      const vanillaPlus = vanillaRow.locator('button').last();
      await expect(vanillaPlus).toBeEnabled();
      await vanillaPlus.click();
      await expect(vanillaPlus).toBeEnabled();
      await vanillaPlus.click();

      await expect(addonModal.getByText(/Selection complete/i)).toBeVisible();
      await expect(vanillaPlus).toBeDisabled();

      const hazelnutRow = addonModal
        .locator('div.min-h-14')
        .filter({ hasText: 'Hazelnut Syrup' })
        .first();
      const hazelnutPlus = hazelnutRow.locator('button').last();
      await expect(hazelnutPlus).toBeDisabled();

      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'addon-modal-max-selection-plus-disabled.png'),
      });
      await addonModal.getByRole('button', { name: 'Close' }).click();
    } finally {
      if (productId) {
        await page.request.delete(`${BASE}/api/products/${productId}`, { headers: managerHeaders });
      }
      await page.request.delete(`${BASE}/api/addon-groups/${groupId}`, {
        headers: managerHeaders,
      });
    }

    // Manager has printers.manage (can open /print-test) but lacks dashboard.view (redirected from /order-history-demo to /pos)
    await page.goto(`${BASE}/print-test`);
    await expect(
      page.getByRole('heading', { name: 'Printing Test Page', exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    await page.goto(`${BASE}/order-history-demo`);
    await page.waitForURL('**/pos**', { timeout: 10_000 });
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toMatch(/^\/pos\/?$/);

    // Server role lacks both printers.manage and dashboard.view -> redirected from both /print-test and /order-history-demo to /orders
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('server@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 20_000 });

    await page.goto(`${BASE}/print-test`);
    await page.waitForURL('**/orders**', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toMatch(/^\/orders\/?$/);

    await page.goto(`${BASE}/order-history-demo`);
    await page.waitForURL('**/orders**', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toMatch(/^\/orders\/?$/);

    // Owner has dashboard.view -> can open /order-history-demo
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 20_000 });

    await page.goto(`${BASE}/order-history-demo`);
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toMatch(/^\/order-history-demo\/?$/);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'authguard-role-redirect-and-access.png'),
    });
  });
});
