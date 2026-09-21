import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

/**
 * Regression coverage for issue #788: a renderer whose localStorage rejects
 * the new-order attempt write used to abort the order before `POST /api/orders`
 * and report the generic "Failed to place order" toast. The attempt must be
 * persisted through the safe storage fallback (sessionStorage), and when no
 * backend accepts it the order must not be sent at all and the reason must be
 * an actionable storage message that reaches the support flow.
 */

const POSTPAID_ATTEMPT_PREFIX = 'flo.postpaid.order.attempt';
const PREPAID_ATTEMPT_KEY = 'flo.prepaid.checkout.attempt';

const STORAGE_UNAVAILABLE_MESSAGE =
  'Order not saved because this device is blocking local storage. Free up disk space or restart FloCafe, then try again.';

interface StorageBlockOptions {
  prefixes: string[];
  blockLocalStorage: boolean;
  blockSessionStorage: boolean;
}

/**
 * `window.localStorage` is unforgeable, but `Storage.prototype.setItem` is
 * shared by both backends, so `this` identifies which one is being written.
 */
async function blockStorageWrites(page: Page, options: StorageBlockOptions): Promise<void> {
  await page.addInitScript((config: StorageBlockOptions) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
      const targetBlocked = (config.blockLocalStorage && this === window.localStorage)
        || (config.blockSessionStorage && this === window.sessionStorage);
      if (targetBlocked && typeof key === 'string' && config.prefixes.some((prefix) => key.startsWith(prefix))) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  }, options);
}

/**
 * Fails writes for the given prefix only when the stored attempt already
 * carries the created order, so the checkout reaches `POST /api/orders` and
 * then loses its retry state. The block is lifted by storing a marker in
 * localStorage, which survives the reload used to retry the checkout.
 */
const ATTEMPT_WRITE_LOCK = 'flo.e2e.attempt-write-lock';

async function blockAttemptWritesCarryingOrder(page: Page, prefix: string): Promise<void> {
  await page.addInitScript((config: { prefix: string; lockKey: string }) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
      const blocked = (() => {
        try {
          return window.localStorage.getItem(config.lockKey) !== 'unlocked';
        } catch {
          return true;
        }
      })();
      if (blocked && typeof key === 'string' && key.startsWith(config.prefix) && String(value).includes('"order":')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  }, { prefix, lockKey: ATTEMPT_WRITE_LOCK });
}

/** Ignores deletes for the given prefix, like a browser that lets the renderer
 * clear the retry key only on the next load. */
async function blockStorageRemovals(page: Page, prefix: string): Promise<void> {
  await page.addInitScript((config: { prefix: string }) => {
    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function patchedRemoveItem(key: string) {
      if (typeof key === 'string' && key.startsWith(config.prefix)) return;
      originalRemoveItem.call(this, key);
    };
  }, { prefix });
}

function trackOrderRequests(page: Page): Array<{ idempotencyKey: string | undefined }> {
  const requests: Array<{ idempotencyKey: string | undefined }> = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (new URL(request.url()).pathname !== '/api/orders') return;
    requests.push({ idempotencyKey: request.headers()['idempotency-key'] });
  });
  return requests;
}

async function loginAndOpenPos(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

async function addProductToCart(page: Page): Promise<void> {
  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: /Add to Cart/ }).click();
}

async function setBillingType(page: Page, billingType: 'prepaid' | 'postpaid'): Promise<Record<string, unknown>> {
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${token}` };
  const businessRes = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessRes.ok()).toBeTruthy();
  const originalBusiness = await businessRes.json();
  const putRes = await page.request.put(`${BASE}/api/settings/business`, {
    headers: authHeaders,
    data: { ...originalBusiness, billing_type: billingType },
  });
  expect(putRes.ok()).toBeTruthy();
  return originalBusiness;
}

async function restoreBusiness(page: Page, originalBusiness: Record<string, unknown>): Promise<void> {
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  await page.request.put(`${BASE}/api/settings/business`, {
    headers: { Authorization: `Bearer ${token}` },
    data: originalBusiness,
  });
}

test('postpaid: no order is sent and the storage problem is reported when every attempt backend is blocked', async ({ page }) => {
  test.setTimeout(60_000);
  const originalBusiness = await setBillingType(page, 'postpaid');
  try {
    await blockStorageWrites(page, {
      prefixes: [POSTPAID_ATTEMPT_PREFIX],
      blockLocalStorage: true,
      blockSessionStorage: true,
    });
    const orderRequests = trackOrderRequests(page);

    await loginAndOpenPos(page);
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();

    // The toast and the support panel both carry the actionable reason, and the
    // support-ticket flow stays reachable for the local storage problem.
    await expect(page.getByRole('status')).toContainText(STORAGE_UNAVAILABLE_MESSAGE);
    await expect(page.getByRole('button', { name: 'Get Help' })).toBeVisible();
    expect(orderRequests, 'a request that cannot be retried safely must not be sent').toHaveLength(0);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('postpaid: a sessionStorage fallback keeps the retry key across a reload without duplicating the order', async ({ page }) => {
  test.setTimeout(90_000);
  const originalBusiness = await setBillingType(page, 'postpaid');
  try {
    await blockStorageWrites(page, {
      prefixes: [POSTPAID_ATTEMPT_PREFIX],
      blockLocalStorage: true,
      blockSessionStorage: false,
    });
    const orderRequests = trackOrderRequests(page);

    // First attempt loses the server response; the fallback-persisted attempt
    // must survive the reload and be replayed under the same idempotency key.
    await page.route('**/api/orders', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E2E forced failure' }) });
    });

    await loginAndOpenPos(page);
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    // The rejection is classified as a server failure, not as a local storage
    // failure, and it is attributed to the order (not printer) support flow.
    await expect(page.getByRole('status')).toContainText('Failed to place order');
    await expect(page.getByText('Order rejected by the local server (HTTP 500)', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get Help' })).toBeVisible();
    expect(orderRequests, 'the first attempt is sent under a durable key').toHaveLength(1);

    await page.unroute('**/api/orders');
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByText(/Order #.+ placed!/)).toBeVisible();

    expect(orderRequests).toHaveLength(2);
    expect(orderRequests[0].idempotencyKey).toBeTruthy();
    expect(
      orderRequests[1].idempotencyKey,
      'the reloaded renderer replays the recovered attempt instead of creating a second order',
    ).toBe(orderRequests[0].idempotencyKey);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('postpaid: a confirmed sale whose cleanup is blocked never reuses the completed key', async ({ page }) => {
  test.setTimeout(90_000);
  const originalBusiness = await setBillingType(page, 'postpaid');
  try {
    await blockStorageRemovals(page, POSTPAID_ATTEMPT_PREFIX);
    const orderRequests = trackOrderRequests(page);

    await loginAndOpenPos(page);
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByText(/Order #.+ placed!/)).toBeVisible();
    expect(orderRequests).toHaveLength(1);

    // The completed attempt could not be deleted, so it survives the reload. It
    // must be recognised as closed instead of being replayed into the sale that
    // happens next.
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByText(/Order #.+ placed!/)).toBeVisible();

    expect(orderRequests).toHaveLength(2);
    expect(orderRequests[0].idempotencyKey).toBeTruthy();
    expect(
      orderRequests[1].idempotencyKey,
      'an identical sale after a completed one starts a new attempt instead of reusing the confirmed key',
    ).not.toBe(orderRequests[0].idempotencyKey);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('prepaid: losing the retry state after the order was created replays that order instead of duplicating it', async ({ page }) => {
  test.setTimeout(90_000);
  const originalBusiness = await setBillingType(page, 'prepaid');
  try {
    await blockAttemptWritesCarryingOrder(page, PREPAID_ATTEMPT_KEY);
    const orderRequests = trackOrderRequests(page);

    await loginAndOpenPos(page);
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: /^Tax / })).toBeVisible();
    await page.getByRole('button', { name: 'Cash' }).click();
    const confirmPayment = page.getByRole('button', { name: /Confirm Payment/ });
    await expect(confirmPayment).toBeEnabled();
    await confirmPayment.click();

    // The order exists on the server but its retry state could not be stored,
    // so the checkout stops with the actionable storage message.
    await expect(page.getByRole('status')).toContainText(STORAGE_UNAVAILABLE_MESSAGE);
    expect(orderRequests, 'the order request itself was sent').toHaveLength(1);

    await page.evaluate((lockKey: string) => window.localStorage.setItem(lockKey, 'unlocked'), ATTEMPT_WRITE_LOCK);
    await page.reload();
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    // The retry replays the same order under the original key and completes the
    // payment, so the customer is charged once for one order.
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: /^Tax / })).toBeVisible();
    await page.getByRole('button', { name: 'Cash' }).click();
    const retryConfirm = page.getByRole('button', { name: /Confirm Payment/ });
    await expect(retryConfirm).toBeEnabled();
    await retryConfirm.click();

    await expect(page.getByText(/Order #.+ paid!/)).toBeVisible({ timeout: 30000 });
    expect(orderRequests).toHaveLength(2);
    expect(
      orderRequests[1].idempotencyKey,
      'a checkout that lost its retry state replays the original order instead of creating a second one',
    ).toBe(orderRequests[0].idempotencyKey);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});

test('prepaid: no order is sent and the storage problem is reported when every attempt backend is blocked', async ({ page }) => {
  test.setTimeout(60_000);
  const originalBusiness = await setBillingType(page, 'prepaid');
  try {
    await blockStorageWrites(page, {
      prefixes: [PREPAID_ATTEMPT_KEY],
      blockLocalStorage: true,
      blockSessionStorage: true,
    });
    const orderRequests = trackOrderRequests(page);

    await loginAndOpenPos(page);
    await addProductToCart(page);
    await page.getByRole('button', { name: 'Place Order' }).click();
    // The confirm button stays disabled until the server preview resolves.
    await expect(page.getByRole('button', { name: /^Tax / })).toBeVisible();
    await page.getByRole('button', { name: 'Cash' }).click();
    const confirmPayment = page.getByRole('button', { name: /Confirm Payment/ });
    await expect(confirmPayment).toBeEnabled();
    await confirmPayment.click();

    await expect(page.getByRole('status')).toContainText(STORAGE_UNAVAILABLE_MESSAGE);
    expect(orderRequests, 'a checkout that cannot persist its retry keys must not send the order').toHaveLength(0);
  } finally {
    await restoreBusiness(page, originalBusiness);
  }
});
