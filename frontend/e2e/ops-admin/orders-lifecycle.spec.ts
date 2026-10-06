import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import {
  login, addToCart, placeOrderAndPayCash, fetchOrder, fetchProductStock,
  createTrackedProduct, deleteProduct, openOrderOverflowMenu, setApprovalPin,
  gross, money, fmt, overlay,
} from './helpers';

/**
 * Orders: the operational path an owner actually walks.
 *
 * Every assertion pairs the figure on screen with the record the backend holds,
 * because a screen that is internally consistent but disagrees with the stored
 * order is exactly the defect this programme is looking for.
 *
 * The seeded catalogue holds one untaxed-by-product, non-stock-tracked coffee,
 * so this suite provisions its own stock-tracked product in the seeded tax
 * category and removes it again: stock movement and taxed lines are otherwise
 * unobservable.
 */

const OWNER_APPROVAL_PIN = '1234';

let tracked: { id: string; name: string; price: number };
let cancelProbe: { id: string; name: string; price: number };

test.beforeAll(async ({ request }) => {
  const api = { request };
  tracked = await createTrackedProduct(api, 'Ops Menu Probe', 40, 50);
  cancelProbe = await createTrackedProduct(api, 'Ops Cancel Probe', 30, 12);
  // Refunds are gated on a Staff Approval PIN and no seeded account has one,
  // so the owner gets one for the duration of this suite and loses it again.
  await setApprovalPin(api, 'e2e-owner', OWNER_APPROVAL_PIN);
});

test.afterAll(async ({ request }) => {
  const api = { request };
  for (const id of [tracked?.id, cancelProbe?.id]) {
    if (id) await deleteProduct(api, id);
  }
  await setApprovalPin(api, 'e2e-owner', null);
});

test.describe('@ci-tier2 operations admin - order lifecycle', () => {
  test('a POS order, settled in cash, matches the record it created line for line', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await addToCart(page, 'E2E Coffee', 1);
    await addToCart(page, tracked.name, 2);

    const cart = await page.locator('body').innerText();
    expect(money(cart.match(/Subtotal\s*฿([\d,]+\.\d{2})/)?.[1] ?? '')).toBe(140);

    const orderNumber = await placeOrderAndPayCash(page);
    const order = await fetchOrder(page, orderNumber);

    // The record, not the cart, is the authority on what was sold.
    expect(order.status).toBe('completed');
    expect(order.subtotal).toBe(140);
    expect(order.tax_amount).toBeCloseTo(9.8, 2);
    expect(order.total).toBeCloseTo(gross(140), 2);
    expect(order.items).toHaveLength(2);
    expect(order.items.reduce((sum, i) => sum + i.quantity, 0)).toBe(3);
  });

  test('a paid order offers a refund, and issuing it settles against the recorded sale', async ({ page }) => {
    await login(page, 'owner');
    await page.goto(`${E2E_BASE_URL}/pos`);
    await addToCart(page, 'E2E Coffee', 1);
    const orderNumber = await placeOrderAndPayCash(page);

    await page.goto(`${E2E_BASE_URL}/orders`);
    const row = page.getByRole('button').filter({ hasText: `#${orderNumber}` }).first();
    await expect(row).toBeVisible();
    await row.click();

    const paid = await fetchOrder(page, orderNumber);
    expect(paid.status).toBe('completed');

    const refund = page.getByRole('button', { name: /^Refund$/ }).first();
    await expect(refund).toBeVisible({ timeout: 20_000 });
    await refund.click();

    const sheet = overlay(page);
    await expect(sheet).toBeVisible();
    // The refundable balance is the sale it is refunding, not a rounded figure.
    await expect(sheet).toContainText(`Refundable balance: ฿${fmt(paid.total)}`);
    // An approval PIN was provisioned for this suite, so the gate is open.
    await expect(sheet).not.toContainText(/Refund approval is not configured/);

    await sheet.locator('#refundPin').fill(OWNER_APPROVAL_PIN);
    await sheet.locator('#refundMethod').selectOption('cash');
    await sheet.getByRole('button', { name: /Issue refund/i }).click();

    await expect(page.getByText(/Refund issued/i).first()).toBeVisible({ timeout: 30_000 });

    // The refund is on the record, and the original sale is still a completed order.
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();
    const listed = await page.request.get(`${E2E_BASE_URL}/api/refunds`, { headers });
    expect(listed.ok()).toBeTruthy();
    const { refunds } = (await listed.json()) as { refunds: Array<{ amount_cents: number; method: string; approved_by: string }> };
    const issued = refunds.find((r) => r.approved_by === 'e2e-owner' && r.amount_cents === Math.round(paid.total * 100));
    expect(issued, 'the issued refund must be recorded for the amount that was collected').toBeTruthy();
    expect(issued?.method).toBe('cash');
    expect((await fetchOrder(page, orderNumber)).status).toBe('completed');
  });

  test('adding a line to an open order recomputes tax and deducts the extra stock', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const before = await fetchProductStock(page, tracked.id);

    const created = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: tracked.id, quantity: 2 }] },
    });
    expect(created.status()).toBe(201);
    const { order } = (await created.json()) as { order: { id: number; order_number: string; subtotal: number } };

    expect(order.subtotal).toBe(80);
    expect(await fetchProductStock(page, tracked.id)).toBe(before - 2);

    const added = await page.request.post(`${E2E_BASE_URL}/api/orders/${order.id}/items`, {
      headers,
      data: { items: [{ product_id: tracked.id, quantity: 1 }] },
    });
    expect(added.ok(), `adding a line to an open order must succeed (got ${added.status()})`).toBeTruthy();

    const reloaded = await fetchOrder(page, order.order_number);
    expect(reloaded.subtotal).toBe(120);
    expect(reloaded.tax_amount).toBeCloseTo(8.4, 2);
    expect(reloaded.total).toBeCloseTo(gross(120), 2);
    expect(await fetchProductStock(page, tracked.id)).toBe(before - 3);
  });

  test('cancelling an unpaid order returns every deducted unit to stock', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const before = await fetchProductStock(page, cancelProbe.id);

    const created = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: cancelProbe.id, quantity: 3 }] },
    });
    expect(created.status()).toBe(201);
    const { order } = (await created.json()) as { order: { id: number; order_number: string; subtotal: number } };

    expect(order.subtotal).toBe(90);
    expect(await fetchProductStock(page, cancelProbe.id)).toBe(before - 3);

    // Cancel from the Orders screen, the way staff would.
    await page.goto(`${E2E_BASE_URL}/orders`);
    const row = page.getByRole('button').filter({ hasText: `#${order.order_number}` }).first();
    await expect(row).toBeVisible();
    await row.click();

    // Cancel from the Orders screen, the way staff would. The action lives in
    // the detail pane's overflow menu, not as a top-level button.
    await openOrderOverflowMenu(page);
    await page.getByRole('menuitem', { name: /^Cancel$/ }).click();

    const sheet = overlay(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(`Cancel Order #${order.order_number}`);
    // A pending order needs no PIN; the dialog says so rather than demanding one.
    await expect(sheet).toContainText(/Pending orders can be cancelled without a PIN/i);
    await sheet.getByRole('button', { name: /Confirm Cancel/i }).click();

    // The operator gets a confirmation, and the cancelled order leaves the
    // Active list it was on.
    await expect(page.getByText(/Order cancelled successfully/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button').filter({ hasText: `#${order.order_number}` })).toHaveCount(0);

    const after = await fetchOrder(page, order.order_number);
    expect(after.status).toBe('cancelled');
    // Cancelling a whole order gives the stock back.
    expect(await fetchProductStock(page, cancelProbe.id)).toBe(before);
  });

  test('the Orders screen shows this order\'s own totals, and each line its own gross', async ({ page }) => {
    await login(page, 'owner');
    const headers = await (async () => ({ Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}` }))();

    const created = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        guest_count: 2,
        items: [{ product_id: 'e2e-product', quantity: 1 }, { product_id: tracked.id, quantity: 2 }],
      },
    });
    expect(created.status()).toBe(201);
    const { order } = (await created.json()) as { order: { order_number: string } };

    await page.goto(`${E2E_BASE_URL}/orders`);
    await page.getByRole('button').filter({ hasText: `#${order.order_number}` }).first().click();

    const detail = await page.locator('body').innerText();
    const shown = {
      subtotal: money(detail.match(/Subtotal\s*฿([\d,]+\.\d{2})/)?.[1] ?? ''),
      tax: money(detail.match(/Tax\s*฿([\d,]+\.\d{2})/)?.[1] ?? ''),
      total: money(detail.match(/Total\s*฿([\d,]+\.\d{2})/)?.[1] ?? ''),
    };

    const record = await fetchOrder(page, order.order_number);
    expect(shown.subtotal).toBe(record.subtotal);
    expect(shown.tax).toBeCloseTo(record.tax_amount, 2);
    expect(shown.total).toBeCloseTo(record.total, 2);
    expect(shown.total).toBeCloseTo(shown.subtotal + shown.tax, 2);

    // Each rendered line carries its own gross, not the order's total. Scoped to
    // the detail pane so a matching figure in the master list cannot satisfy it.
    await expect(page.getByText(`฿${fmt(gross(60))}`).last()).toBeVisible();
    await expect(page.getByText(`฿${fmt(gross(80))}`).last()).toBeVisible();
  });
});