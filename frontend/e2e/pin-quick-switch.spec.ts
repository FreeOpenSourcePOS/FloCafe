import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { captureSettings, restoreSettings } from './helpers/kitchen-fixture';

const SETTINGS_TO_RESTORE = ['billing_type', 'auto_lock_minutes'];

test.describe('PIN Quick User Switch and Lock Flow (#1338)', () => {
  let ownerToken: string;
  let ownerHeaders: Record<string, string>;
  let cashierId: string;
  let settingsBefore: Map<string, string | undefined>;
  let createdOrderIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
    ownerHeaders = {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    };
    settingsBefore = await captureSettings(request, SETTINGS_TO_RESTORE);

    // Ensure owner has a PIN and create/update a cashier with a PIN (4321)
    const ownerPinRes = await request.put(`${BASE}/api/staff/e2e-owner`, {
      headers: ownerHeaders,
      data: { pin: '1111' },
    });
    expect(ownerPinRes.ok()).toBeTruthy();

    const staffRes = await request.get(`${BASE}/api/staff`, { headers: ownerHeaders });
    expect(staffRes.ok()).toBeTruthy();
    const { staff } = await staffRes.json();
    const existingCashier = staff.find(
      (member: { email?: string; id?: string; is_active?: number | boolean }) =>
        member.email === 'pin-cashier@flo.local',
    );
    if (existingCashier) {
      cashierId = existingCashier.id;
      if (!existingCashier.is_active) {
        const reactivateRes = await request.post(`${BASE}/api/staff/${cashierId}/reactivate`, {
          headers: ownerHeaders,
        });
        expect(reactivateRes.ok()).toBeTruthy();
      }
      const updateRes = await request.put(`${BASE}/api/staff/${cashierId}`, {
        headers: ownerHeaders,
        data: { role: 'cashier', pin: '4321' },
      });
      expect(updateRes.ok()).toBeTruthy();
    } else {
      const createRes = await request.post(`${BASE}/api/staff`, {
        headers: ownerHeaders,
        data: {
          name: 'QuickSwitch Cashier',
          email: 'pin-cashier@flo.local',
          password: E2E_PASSWORD,
          role: 'cashier',
          pin: '4321',
        },
      });
      expect(createRes.ok()).toBeTruthy();
      const body = await createRes.json();
      cashierId = body.staff.id;
    }
  });

  test.beforeEach(async ({ request }) => {
    createdOrderIds = [];
    await request.put(`${BASE}/api/settings/billing_type`, {
      headers: ownerHeaders,
      data: { value: 'prepaid' },
    });
    await request.put(`${BASE}/api/settings/auto_lock_minutes`, {
      headers: ownerHeaders,
      data: { value: '0' },
    });
  });

  test.afterEach(async ({ request }) => {
    if (settingsBefore) {
      await restoreSettings(request, settingsBefore);
    }
    for (const orderId of createdOrderIds) {
      try {
        await request.patch(`${BASE}/api/orders/${orderId}/status`, {
          headers: ownerHeaders,
          data: {
            status: 'cancelled',
            override_pin: '1111',
            approver_id: 'e2e-owner',
          },
        });
      } catch {
        // Ignore if already completed/cancelled
      }
    }
  });

  test('locks POS from topbar, quick-switches to cashier via PIN tile picker, preserves cart, and completes payment', async ({
    page,
  }) => {
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);

    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    // Click Lock in the POS topbar and verify POST /api/auth/logout succeeds with 200
    const logoutResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.pathname === '/api/auth/logout';
    });
    await page.getByTestId('pos-lock-button').click();
    expect((await logoutResponse).status()).toBe(200);
    await page.waitForURL('**/auth/login**', { timeout: 15000 });

    // Verify user tile picker is visible and shows our PIN-enabled cashier
    const picker = page.getByTestId('pin-user-picker');
    await expect(picker).toBeVisible();
    const cashierTile = page.getByTestId(`pin-user-tile-${cashierId}`);
    await expect(cashierTile).toBeVisible();
    await expect(cashierTile).toContainText('QuickSwitch Cashier');

    // Tap the cashier tile and enter PIN 4321 using the keypad
    await cashierTile.click();
    await expect(page.getByTestId('pin-login-form')).toBeVisible();
    await page.getByTestId('pin-pad-digit-4').click();
    await page.getByTestId('pin-pad-digit-3').click();
    await page.getByTestId('pin-pad-digit-2').click();
    await page.getByTestId('pin-pad-digit-1').click();
    await page.getByTestId('pin-login-submit').click();

    // Verify redirect to POS, active user switched to cashier, and unfinished cart preserved
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    // Complete payment as the cashier
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm Payment · ฿64.20' })).toBeEnabled();

    const orderResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && url.pathname === '/api/orders';
    });
    const paymentResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'POST' &&
        /^\/api\/bills\/[^/]+\/payments$/.test(url.pathname)
      );
    });

    await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();

    const orderPayload = await (await orderResponse).json();
    if (orderPayload?.order?.id) {
      createdOrderIds.push(String(orderPayload.order.id));
    }
    const paymentPayload = await (await paymentResponse).json();
    expect(paymentPayload.bill.payment_status).toBe('paid');
    await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toBeVisible();
  });
});
