import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

test.describe('Cash close phase-1 UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 20000 });
    await page.waitForFunction(() => !!localStorage.getItem('token'));
    await setLanguage(page, 'en');
  });

  test.afterEach(async ({ page }) => {
    await setLanguage(page, 'en');
  });

  test('day close modal shows open-shift block from x-report', async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);
    await page.route('**/api/reports/x-report*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xReport: {
            businessDate: today,
            periodStart: `${today} 00:00:00`,
            periodEnd: `${today} 23:59:59`,
            grossCollected: 0,
            refunded: 0,
            netCollected: 0,
            billCount: 0,
            refundCount: 0,
            paymentMethods: [],
            staffSales: [],
            taxComponents: [],
            openingFloatCents: 0,
            payInCents: 0,
            payOutCents: 0,
            safeDropCents: 0,
            cashMovements: [],
            expectedCashCents: 0,
            priorClosedCashCents: null,
            priorBusinessDate: null,
            alreadyClosed: false,
            blockingOpenShift: {
              id: 42,
              opened_by_name: 'E2E Cashier',
              opened_at: `${today} 10:00:00`,
            },
          },
        }),
      });
    });

    await page.goto(`${BASE}/dashboard?action=cash-close&view=x-report`);
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 15000 });
    const blocker = dialog.getByTestId('day-close-open-shift-blocker');
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText('42');
    await expect(blocker).toContainText('E2E Cashier');
    await expect(dialog.getByRole('button', { name: /Continuar|Continue/i })).toBeDisabled();
  });

  test('shift close modal shows unpaid carry-over warning while keeping close button enabled', async ({
    page,
  }) => {
    const nowSql = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await page.route('**/api/cash-sessions/current', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 7,
          opened_by: 'owner',
          opened_by_name: 'Owner',
          opened_at: nowSql,
          opening_float_cents: 0,
          status: 'open',
          expected_cash_cents: 5000,
        }),
      });
    });
    await page.route('**/api/cash-sessions/current/close-preview', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session_id: 7,
          opened_by_name: 'Owner',
          opened_at: nowSql,
          unpaid_in_shift: {
            count: 2,
            bill_count: 2,
            pending_cents: 12500,
            sample: [
              {
                order_id: 101,
                order_number: 'ORD-101',
                bill_id: 201,
                bill_number: 'BILL-201',
                status: 'pending',
                payment_status: 'unpaid',
                total: 75,
                balance: 75,
                balance_cents: 7500,
                created_at: nowSql,
              },
              {
                order_id: 102,
                order_number: 'ORD-102',
                bill_id: 202,
                bill_number: 'BILL-202',
                status: 'pending',
                payment_status: 'partial',
                total: 50,
                balance: 50,
                balance_cents: 5000,
                created_at: nowSql,
              },
            ],
          },
          would_block_close: false,
        }),
      });
    });

    await page.goto(`${BASE}/pos`);
    await page.getByRole('button', { name: /Cerrar turno|Close shift/i }).click({ timeout: 15000 });
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    const warning = dialog.getByTestId('shift-close-unpaid-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute('role', 'status');
    await expect(warning).toContainText('#ORD-101');
    await expect(dialog.getByRole('button', { name: /Cerrar turno|Close shift/i })).toBeEnabled();
  });
});
