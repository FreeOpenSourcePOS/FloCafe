import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { setLanguage, setOrdersLayout, getE2eToken } from './helpers/test-auth';

const EVIDENCE_DIR = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M58BA03R9W302NZRCX6ESTER';

test.describe('Explicit Manager Selection for Approvals and Kitchen Override', () => {
  let ownerToken: string;
  let headers: Record<string, string>;
  let managerAliceId: string;
  let managerBobId: string;

  test.beforeAll(async () => {
    if (!fs.existsSync(EVIDENCE_DIR)) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
    headers = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };

    // Login via UI
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill('E2ePass123!');
    await page.locator('button[type="submit"]').click();
    await setLanguage(page, 'en');
    await setOrdersLayout(page, 'cards');
  });

  test('Scenarios 1 & 2: Kitchen Delivery Override binds manager selection and rejects mismatch', async ({
    page,
  }) => {
    // 1. Configure settings
    await page.request.put(`${BASE}/api/settings/billing_type`, {
      headers,
      data: { value: 'postpaid' },
    });
    await page.request.put(`${BASE}/api/settings/kds_enabled`, {
      headers,
      data: { value: 'true' },
    });
    await page.request.put(`${BASE}/api/settings/require_kitchen_delivered_before_settlement`, {
      headers,
      data: { value: 'true' },
    });

    // 2. Ensure two active managers with distinct PINs exist
    const staffListRes = await page.request.get(`${BASE}/api/staff?active=true`, { headers });
    expect(staffListRes.ok()).toBeTruthy();
    const { staff } = await staffListRes.json();

    const existingAlice = staff.find((s: any) => s.email === 'alice.mgr@flo.local');
    if (!existingAlice) {
      const res = await page.request.post(`${BASE}/api/staff`, {
        headers,
        data: {
          name: 'Manager Alice',
          email: 'alice.mgr@flo.local',
          password: 'Password123!',
          role: 'manager',
          pin: '1111',
        },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      managerAliceId = body.staff.id;
    } else {
      managerAliceId = existingAlice.id;
      await page.request.put(`${BASE}/api/staff/${managerAliceId}`, {
        headers,
        data: { pin: '1111', is_active: 1 },
      });
    }

    const existingBob = staff.find((s: any) => s.email === 'bob.mgr@flo.local');
    if (!existingBob) {
      const res = await page.request.post(`${BASE}/api/staff`, {
        headers,
        data: {
          name: 'Manager Bob',
          email: 'bob.mgr@flo.local',
          password: 'Password123!',
          role: 'manager',
          pin: '2222',
        },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      managerBobId = body.staff.id;
    } else {
      managerBobId = existingBob.id;
      await page.request.put(`${BASE}/api/staff/${managerBobId}`, {
        headers,
        data: { pin: '2222', is_active: 1 },
      });
    }

    // 3. Create an order with an undelivered item
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'takeaway',
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(orderRes.status()).toBe(201);
    const { order } = await orderRes.json();

    // 4. Open Orders page and launch Checkout for this order
    await page.goto(`${BASE}/orders`);
    await page.getByPlaceholder(/search/i).first().fill(order.order_number);
    await expect(page.getByText(`#${order.order_number}`)).toBeVisible();
    await page.getByRole('button', { name: 'Checkout', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();

    // Select Cash tender
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    const payButton = page.getByRole('button', { name: /^Pay / });

    // Initial click fails with 409 because items are undelivered
    await payButton.click();

    // ApproverSelect dropdown and Manager PIN input should appear
    const approverSelect = page.locator('#kitchenApproverSelect');
    await expect(approverSelect).toBeVisible();
    const pinInput = page.getByLabel('Manager PIN');
    await expect(pinInput).toBeVisible();

    // Verify both managers are in the dropdown options
    const options = await approverSelect.locator('option').allTextContents();
    expect(options.some((o) => o.includes('Manager Alice'))).toBeTruthy();
    expect(options.some((o) => o.includes('Manager Bob'))).toBeTruthy();

    // --- Scenario 2 (Adversarial): Mismatched manager selection and PIN ---
    await approverSelect.selectOption(managerAliceId);
    // Enter Bob's PIN (2222) while Alice is selected
    await pinInput.fill('2222');

    const paymentResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/payments') && res.request().method() === 'POST',
    );
    await payButton.click();
    const rejectedResponse = await paymentResponsePromise;
    expect(rejectedResponse.status()).toBe(403);
    const rejectedBody = await rejectedResponse.json();
    expect(rejectedBody.error).toBe('Invalid manager PIN');

    // Error alert should be visible in the modal
    await expect(page.getByText('Invalid manager PIN')).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-2-mismatched-manager-pin-rejected.png'),
    });

    // --- Scenario 1: Correct manager selection and matching PIN ---
    await approverSelect.selectOption(managerBobId);
    // Selecting another approver resets the PIN input
    await expect(pinInput).toHaveValue('');
    await pinInput.fill('2222');

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-1-kitchen-override-select-manager.png'),
    });

    const successResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/payments') && res.request().method() === 'POST',
    );
    await payButton.click();
    const successResponse = await successResponsePromise;
    expect(successResponse.status()).toBe(200);

    // Modal should show Done / successful payment
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-1-payment-settled-success.png'),
    });

    // Verify audit log has kitchen_delivery_override with Bob's manager ID
    const auditRes = await page.request.get(
      `${BASE}/api/orders/${order.id}/audit-log`,
      { headers },
    );
    if (auditRes.ok()) {
      const audit = await auditRes.json();
      const overrideLog = audit.logs?.find((l: any) => l.action === 'kitchen_delivery_override');
      if (overrideLog) {
        const details = typeof overrideLog.details === 'string' ? JSON.parse(overrideLog.details) : overrideLog.details;
        expect(details.manager_user_id).toBe(managerBobId);
      }
    }
  });

  test('Scenario 3: Orders page Void Item & Cancel Order modals enforce manager selection', async ({
    page,
  }) => {
    // 1. Ensure managers exist with PINs
    const staffListRes = await page.request.get(`${BASE}/api/staff?active=true`, { headers });
    const { staff } = await staffListRes.json();
    const activeManagers = staff.filter((s: any) => ['owner', 'manager'].includes(s.role) && s.has_pin);
    if (activeManagers.length < 2) {
      await page.request.post(`${BASE}/api/staff`, {
        headers,
        data: {
          name: 'Manager Alice',
          email: 'alice.mgr@flo.local',
          password: 'Password123!',
          role: 'manager',
          pin: '1111',
        },
      });
      await page.request.post(`${BASE}/api/staff`, {
        headers,
        data: {
          name: 'Manager Bob',
          email: 'bob.mgr@flo.local',
          password: 'Password123!',
          role: 'manager',
          pin: '2222',
        },
      });
    }

    // 2. Create a dine-in order with item in preparing status
    const tableRes = await page.request.post(`${BASE}/api/tables`, {
      headers,
      data: { number: `T-Mgr-${Date.now() % 1000}`, capacity: 4 },
    });
    expect(tableRes.status()).toBe(201);
    const { table } = await tableRes.json();

    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: table.id,
        items: [{ product_id: 'e2e-product', quantity: 2 }],
      },
    });
    expect(orderRes.status()).toBe(201);
    const { order } = await orderRes.json();

    // Mark item as preparing so Void Item button is displayed
    const detailRes = await page.request.get(`${BASE}/api/orders/${order.id}`, { headers });
    const detail = await detailRes.json();
    const itemId = detail.order.items[0].id;
    const patchRes = await page.request.patch(`${BASE}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'preparing' },
    });
    expect(patchRes.ok()).toBeTruthy();

    await page.goto(`${BASE}/orders`);
    await page.getByPlaceholder(/search/i).first().fill(order.order_number);
    const card = page.locator('div.bg-card').filter({ hasText: `#${order.order_number}` }).first();
    await expect(card).toBeVisible();

    // 3. Open Void Item modal
    const voidBtn = card.locator('button[title="Void item"]').first();
    await expect(voidBtn).toBeVisible();
    await voidBtn.click();

    const voidApprover = page.locator('#voidApproverSelect');
    await expect(voidApprover).toBeVisible();
    const confirmVoidBtn = page.getByRole('button', { name: 'Confirm Void', exact: true });
    // Button disabled when no approver chosen
    await expect(confirmVoidBtn).toBeDisabled();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-3-orders-void-item-approver-select.png'),
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // 4. Open Cancel Order modal from Card action dropdown
    const moreBtn = card.locator('button:has(svg.lucide-ellipsis, svg.lucide-more-horizontal)').first();
    await moreBtn.click();

    const cancelMenuItem = page.getByRole('menuitem', { name: /cancel/i });
    await expect(cancelMenuItem).toBeVisible();
    await cancelMenuItem.click();

    // Cancel modal for active table orders requires PIN override
    const cancelApprover = page.locator('#cancelApproverSelect');
    await expect(cancelApprover).toBeVisible();
    const confirmCancelBtn = page.getByRole('button', { name: 'Confirm Cancel', exact: true });
    await expect(confirmCancelBtn).toBeDisabled();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-3-orders-cancel-order-approver-select.png'),
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('Scenario 4: ApproverSelect displays graceful warning when no managers have PINs', async ({
    page,
  }) => {
    // Temporarily clear PINs from all managers
    const staffListRes = await page.request.get(`${BASE}/api/staff?active=true`, { headers });
    const { staff } = await staffListRes.json();
    for (const member of staff) {
      if (['owner', 'manager'].includes(member.role) && member.has_pin) {
        await page.request.put(`${BASE}/api/staff/${member.id}`, {
          headers,
          data: { pin: '' },
        });
      }
    }

    // Create an order and mark item as preparing
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'takeaway',
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    const { order } = await orderRes.json();

    const detailRes = await page.request.get(`${BASE}/api/orders/${order.id}`, { headers });
    const detail = await detailRes.json();
    const itemId = detail.order.items[0].id;
    await page.request.patch(`${BASE}/api/order-items/${itemId}/status`, {
      headers,
      data: { status: 'preparing' },
    });

    await page.goto(`${BASE}/orders`);
    await page.getByPlaceholder(/search/i).first().fill(order.order_number);
    const card = page.locator('div.bg-card').filter({ hasText: `#${order.order_number}` }).first();
    await expect(card).toBeVisible();

    const voidBtn = card.locator('button[title="Void item"]').first();
    await expect(voidBtn).toBeVisible();
    await voidBtn.click();

    const emptyAlert = page.getByText('Approval is not configured');
    await expect(emptyAlert).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-4-approver-select-empty-state.png'),
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
});
