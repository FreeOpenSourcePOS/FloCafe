import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

async function startSettingsSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'customer-display-address-test-token');
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'e2e-owner',
            name: 'E2E Owner',
            email: 'owner@flo.local',
            role: 'owner',
            category_ids: [],
          },
          tenants: [
            {
              id: 1,
              business_name: 'E2E Cafe',
              role: 'owner',
              plan: 'free',
              status: 'active',
              business_type: 'restaurant',
              language: 'en',
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20000 });
}

const posInfo = {
  mdns_url: 'http://flo.local:4321',
  ip_url: 'http://10.42.0.25:4321',
  ips_data: [
    { ip: '10.42.0.25', url: 'http://10.42.0.25:4321', qr_data: null },
    { ip: '192.168.1.25', url: 'http://192.168.1.25:4321', qr_data: null },
  ],
};

test('customer display pairing uses the selected POS address and reuses its token when switched', async ({
  page,
  browser,
}) => {
  await startSettingsSession(page);
  let networkInfoReads = 0;
  let tokenCreates = 0;
  const token = `cdt_${'a'.repeat(64)}`;
  await page.route('**/api/pos-info', async (route) => {
    networkInfoReads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(posInfo),
    });
  });
  await page.route('**/api/settings/customer-display/tokens', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"tokens":[]}' });
      return;
    }
    tokenCreates += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'paired-display-1',
        label: 'Counter TV',
        token,
        created_at: '2026-10-14T12:00:00.000Z',
      }),
    });
  });
  await page.goto(`${BASE}/settings?tab=pos`);
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await expect(page.getByText('Primary LAN address', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Primary LAN address/ })).toBeChecked();
  await expect(
    page.getByText('http://10.42.0.25:4321/customer-display/', { exact: true }),
  ).toBeVisible();
  expect(networkInfoReads).toBe(1);

  await page.getByLabel('Display name', { exact: true }).fill('Counter TV');
  await page.getByRole('button', { name: 'Pair display', exact: true }).click();
  let pairingUrl = 'http://10.42.0.25:4321/customer-display/#token=' + token;
  await expect(page.getByText(pairingUrl, { exact: true })).toBeVisible();

  await page.getByText('Show other addresses', { exact: true }).click();
  await page.getByRole('radio', { name: /192\.168\.1\.25:4321/ }).check();
  await expect(
    page.getByText('http://192.168.1.25:4321/customer-display/', { exact: true }),
  ).toBeVisible();
  pairingUrl = 'http://192.168.1.25:4321/customer-display/#token=' + token;
  await expect(page.getByText(pairingUrl, { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /flo\.local:4321/ }).check();
  pairingUrl = 'http://flo.local:4321/customer-display/#token=' + token;
  await expect(page.getByText(pairingUrl, { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /This computer only \(local preview\)/ }).check();
  const localOrigin = new URL(BASE).origin;
  await expect(page.getByText(`${localOrigin}/customer-display/`, { exact: true })).toBeVisible();
  pairingUrl = `${localOrigin}/customer-display/#token=${token}`;
  await expect(page.getByText(pairingUrl, { exact: true })).toBeVisible();
  expect(tokenCreates).toBe(1);

  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  let feedRequests = 0;
  let revoked = false;
  await devicePage.route('**/api/customer-display/feed', async (route) => {
    feedRequests += 1;
    if (revoked) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"error":"revoked"}',
      });
      return;
    }
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        business_name: 'E2E Cafe',
        config: {
          statuses: ['pending', 'preparing', 'ready'],
          refresh_seconds: 3,
          show_updated: false,
        },
        orders: [{ id: 1, number: 'A-42', status: 'ready' }],
      }),
    });
  });
  await devicePage.goto(pairingUrl);
  await expect(devicePage.getByText('E2E Cafe', { exact: true })).toBeVisible();
  await expect(devicePage.getByTestId('customer-display-ready-scroll')).toContainText('A-42');
  await expect(devicePage).toHaveURL(`${localOrigin}/customer-display/`);
  await devicePage.reload();
  await expect(devicePage.getByTestId('customer-display-ready-scroll')).toContainText('A-42');
  expect(feedRequests).toBeGreaterThanOrEqual(2);
  revoked = true;
  await expect(
    devicePage.getByRole('heading', { name: 'This display is not paired', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await deviceContext.close();
});

test('customer display pairing shows no-LAN and network lookup failures explicitly', async ({
  page,
}) => {
  await startSettingsSession(page);
  let networkInfoReads = 0;
  const localToken = `cdt_${'b'.repeat(64)}`;
  await page.route('**/api/pos-info', async (route) => {
    networkInfoReads += 1;
    if (networkInfoReads === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"offline"}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mdns_url: 'http://flo.local:3001',
        ip_url: 'http://127.0.0.1:3001',
        ips_data: [{ ip: '127.0.0.1', url: 'http://127.0.0.1:3001', qr_data: null }],
      }),
    });
  });
  await page.route('**/api/settings/customer-display/tokens', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"tokens":[]}' });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'paired-display-local',
        label: 'Local preview',
        token: localToken,
        created_at: '2026-10-14T12:00:00.000Z',
      }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await expect(page.getByText('Could not load network addresses.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'LAN pairing is unavailable. Select the local preview to use this computer only.',
  );
  await expect(page.locator('input[name="customer-display-pairing-address"]')).toHaveCount(1);
  await expect(
    page.getByRole('radio', { name: /This computer only \(local preview\)/ }),
  ).not.toBeChecked();
  await expect(page.getByText('http://flo.local:3001', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: /This computer only \(local preview\)/ }).check();
  await page.getByLabel('Display name', { exact: true }).fill('Local preview');
  await page.getByRole('button', { name: 'Pair display', exact: true }).click();
  const localOrigin = new URL(BASE).origin;
  await expect(
    page.getByText(`${localOrigin}/customer-display/#token=${localToken}`, { exact: true }),
  ).toBeVisible();
  expect(networkInfoReads).toBe(2);
});
