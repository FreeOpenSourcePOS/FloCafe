import { type APIRequestContext, type Page, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { getE2eToken } from '../helpers/test-auth';

/**
 * Backend-authoritative owner header, for fixture work that runs outside a
 * logged-in page.
 *
 * Minted per call rather than once at import: changing an account's credentials
 * revokes tokens issued before it, so a header captured at module load goes
 * stale as soon as a scenario sets or clears an approval PIN.
 */
export function ownerAuth() {
  return {
    Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  };
}

/**
 * Shared plumbing for the operational back-office scenarios.
 *
 * The e2e server seeds exactly three users and one product, so each scenario
 * builds whatever else it needs through the API and removes it afterwards.
 * Assertions always pair a rendered figure with the underlying record rather
 * than trusting the screen on its own.
 */

export const PASSWORD = 'E2ePass123!';

export type Role = 'owner' | 'manager' | 'server';

const SEEDED_USER: Record<Role, { id: string; email: string }> = {
  owner: { id: 'e2e-owner', email: 'owner@flo.local' },
  manager: { id: 'e2e-manager', email: 'manager@flo.local' },
  server: { id: 'e2e-server', email: 'server@flo.local' },
};

/** The tenant applies a flat 7% exclusive pack; every expectation derives from it. */
export const TAX_RATE = 0.07;

/** Backend-authoritative total for a net amount, at the tenant's 7% rate. */
export function gross(net: number): number {
  return Math.round(net * (1 + TAX_RATE) * 100) / 100;
}

export async function login(page: Page, role: Role = 'owner'): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.locator('#email').fill(SEEDED_USER[role].email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 20_000 });
}

/** Bearer header for API calls, preferring the token the page already holds. */
export async function authHeader(page: Page, role: Role = 'owner') {
  const held = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
  if (held) return { Authorization: `Bearer ${held}` };
  const seeded = SEEDED_USER[role];
  return { Authorization: `Bearer ${getE2eToken(seeded.id, seeded.email, role)}` };
}

/** Pulls the numeric value out of a rendered money string (e.g. "฿149.80" -> 149.8). */
export function money(text: string): number {
  const digits = text.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  return Number.parseFloat(digits);
}

export function fmt(amount: number): string {
  return amount.toFixed(2);
}

/** Opens a product's detail modal, picks a preset quantity, and adds it to the cart. */
export async function addToCart(page: Page, productName: string, quantity = 1): Promise<void> {
  await page.getByTestId('pos-product-card').filter({ hasText: productName }).first().click();
  const modal = page.locator('.fixed.inset-0').last();
  await expect(modal).toBeVisible();
  if (quantity > 1) {
    await modal.getByRole('button', { name: String(quantity), exact: true }).click();
  }
  await modal.getByRole('button', { name: /Add to Cart/ }).click();
  await expect(modal).toBeHidden();
}

/**
 * Places the current POS cart and settles it in cash.
 *
 * The payment method has to be selected before Confirm arms, so the method
 * button is always clicked even though the tender box is pre-filled.
 */
export async function placeOrderAndPayCash(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Place Order' }).click();
  const modal = page.locator('.fixed.inset-0').last();
  await expect(modal).toBeVisible();

  const shown = () => modal.innerText();
  // Tax is computed server-side, so the modal opens on a placeholder first.
  // innerText lowercases the visually-uppercased label and joins block
  // elements without separators, so match case-insensitively.
  await expect(modal).toContainText(/Total Due/i, { timeout: 30_000 });
  const owed = money((await shown()).match(/Total Due[^\d]*([\d,]+\.\d{2})/i)?.[1] ?? '');
  expect(Number.isFinite(owed) && owed > 0, `the checkout modal must state an amount due (got "${owed}")`).toBeTruthy();

  await modal.getByRole('button', { name: /^Cash/ }).click();
  const confirm = modal.getByRole('button', { name: /Confirm Payment/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  const settled = page.getByText(/paid!/);
  await expect(settled).toBeVisible({ timeout: 30_000 });
  const orderNumber = (await settled.innerText()).match(/#(\S+)\s+paid!/)?.[1];
  expect(orderNumber, 'the confirmation toast must name the paid order').toBeTruthy();
  return orderNumber as string;
}

/**
 * Opens the detail pane's overflow menu.
 *
 * Cancel, convert-to-takeaway and link-customer are DropdownMenuItems behind a
 * single ellipsis trigger rather than top-level buttons, so a scenario that
 * wants one has to open this menu first.
 */
export async function openOrderOverflowMenu(page: Page): Promise<void> {
  await page.locator('button[aria-haspopup="menu"]').filter({ has: page.locator('svg.lucide-ellipsis') }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/**
 * The topmost modal overlay.
 *
 * Cancel, refund and the POS product sheet are all bare `.fixed` containers
 * with no dialog role, so they are addressed by their own layout classes.
 */
export function overlay(page: Page) {
  return page.locator('.fixed.inset-0.z-50').last();
}

/** Sets or clears an account's Staff Approval PIN (owner/manager roles only). */
export async function setApprovalPin(
  api: { request: APIRequestContext },
  userId: string,
  pin: string | null,
): Promise<void> {
  const res = await api.request.put(`${E2E_BASE_URL}/api/staff/${userId}`, {
    headers: ownerAuth(),
    data: { pin },
  });
  expect(res.ok(), `setting an approval PIN on ${userId} must succeed (got ${res.status()} ${await res.text()})`).toBeTruthy();
}

export type OrderRecord = {
  id: number;
  order_number: string;
  status: string;
  type: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  items: Array<{ product_name: string; quantity: number; unit_price: number; status?: string }>;
};

export async function fetchOrder(page: Page, orderNumber: string): Promise<OrderRecord> {
  const headers = await authHeader(page);
  const res = await page.request.get(`${E2E_BASE_URL}/api/orders`, { headers });
  expect(res.ok(), `listing orders must succeed (got ${res.status()})`).toBeTruthy();
  const { orders } = (await res.json()) as { orders: OrderRecord[] };
  const found = orders.find((o) => o.order_number === orderNumber);
  expect(found, `order ${orderNumber} must be readable back from the API`).toBeTruthy();
  return found as OrderRecord;
}

export async function fetchProductStock(page: Page, productId: string): Promise<number> {
  const headers = await authHeader(page);
  const res = await page.request.get(`${E2E_BASE_URL}/api/products`, { headers });
  expect(res.ok()).toBeTruthy();
  const { products } = (await res.json()) as { products: Array<{ id: string; stock_quantity: number }> };
  const found = products.find((p) => p.id === productId);
  expect(found, `product ${productId} must exist`).toBeTruthy();
  return (found as { stock_quantity: number }).stock_quantity;
}

/**
 * Creates an inventory-tracked product in the seeded 'standard' tax category.
 *
 * The seeded product does not track stock and carries no tax category, so a
 * scenario that has to prove stock movement or taxed lines needs one of these.
 */
export async function createTrackedProduct(
  api: { request: APIRequestContext },
  name: string,
  price: number,
  stock: number,
): Promise<{ id: string; name: string; price: number }> {
  const res = await api.request.post(`${E2E_BASE_URL}/api/products`, {
    headers: ownerAuth(),
    data: {
      name,
      price,
      category_id: 'e2e-category',
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
      track_inventory: true,
      stock_quantity: stock,
      low_stock_threshold: 5,
    },
  });
  expect(res.status(), `creating product ${name} must succeed (got ${res.status()})`).toBe(201);
  const { product } = (await res.json()) as { product: { id: string; name: string; price: number } };
  return product;
}

export async function deleteProduct(api: { request: APIRequestContext }, productId: string): Promise<void> {
  await api.request.delete(`${E2E_BASE_URL}/api/products/${productId}`, { headers: ownerAuth() });
}

export type CustomerRecord = {
  id: string;
  name: string;
  phone: string | null;
  email?: string | null;
  is_active?: number;
};

/** The customer list. The endpoint returns the array under `data`. */
export async function fetchCustomers(page: Page): Promise<CustomerRecord[]> {
  const headers = await authHeader(page);
  const res = await page.request.get(`${E2E_BASE_URL}/api/customers`, { headers });
  expect(res.ok(), `listing customers must succeed (got ${res.status()})`).toBeTruthy();
  const { data } = (await res.json()) as { data: CustomerRecord[] };
  return data;
}

/** Opens the order detail pane for a row in the master list. */
export async function openOrder(page: Page, orderNumber: string): Promise<void> {
  await page.getByRole('button').filter({ hasText: `#${orderNumber}` }).first().click();
  await expect(page.getByText(`#${orderNumber}`).nth(1)).toBeVisible();
}