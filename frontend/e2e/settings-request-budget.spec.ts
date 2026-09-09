import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const MOCK_API_RATE_LIMIT = 100;

async function startMockedSettingsSession(page: Page, cloudRegistered = false, cloudStatus: Record<string, unknown> = {}): Promise<void> {
  let apiRequestCount = 0;
  await page.addInitScript(() => {
    localStorage.setItem('token', 'settings-request-budget-token');
  });
  await page.route('**/api/**', async (route) => {
    apiRequestCount += 1;
    if (apiRequestCount > MOCK_API_RATE_LIMIT) {
      await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many requests' }) });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'e2e-owner', name: 'E2E Owner', email: 'owner@flo.local', role: 'owner', category_ids: [] },
          tenants: [{ id: 1, business_name: 'E2E Cafe', role: 'owner', plan: 'free', status: 'active', business_type: 'restaurant', language: 'en' }],
        }),
      });
      return;
    }
    if (path === '/api/settings/cloud' && (cloudRegistered || Object.keys(cloudStatus).length > 0)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ cloud_registration_status: cloudRegistered ? 'registered' : 'unregistered', ...cloudStatus }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20000 });
  await page.waitForTimeout(300);
}

function collectApiPaths(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) paths.push(path);
  });
  return paths;
}

test('Store Settings does not hydrate inactive tabs', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.waitForTimeout(500);

  const inactiveTabRequests = apiPaths.filter((path) => [
    '/api/settings/telemetry_enabled',
    '/api/settings/diagnostics_consent',
    '/api/settings/kds_enabled',
    '/api/settings/server_app_enabled',
    '/api/settings/kot_printing_enabled',
    '/api/settings/printer_trim_decimals',
    '/api/settings/cash_drawer_pulse_enabled',
    '/api/settings/cash_drawer_pulse_methods',
    '/api/settings/bill_language_policy',
    '/api/settings/kot_language_policy',
    '/api/settings/z_report_language_policy',
    '/api/settings/bill-templates',
    '/api/settings/bill_template',
    '/api/settings/bill_footer_message',
    '/api/settings/loyalty',
    '/api/settings/discount',
    '/api/settings/cloud',
    '/api/settings/google-drive',
    '/api/printers',
    '/api/printers/detect',
    '/api/kds-info',
    '/api/kitchen-stations',
    '/api/categories',
    '/api/staff',
    '/api/mobile/pairing-code',
    '/api/mobile/devices',
    '/api/more-apps',
    '/api/more-apps/revflo',
    '/api/db-tools/master-pin/status',
    '/api/db-tools/backups',
  ].includes(path));

  expect(inactiveTabRequests).toEqual([]);
  expect(apiPaths.filter((path) => path === '/api/settings/business')).toHaveLength(1);

  await page.getByRole('button', { name: 'Mobile Access', exact: true }).click();
  await expect(page).toHaveURL(/tab=mobile-access/);
  await page.waitForTimeout(300);
  expect(apiPaths).not.toContain('/api/mobile/pairing-code');
  expect(apiPaths).not.toContain('/api/mobile/devices');
});

test('Privacy hydrates terminal cloud status before exposing deletion', async ({ page }) => {
  await startMockedSettingsSession(page, false, {
    cloud_registration_status: 'deleted',
    cloud_deletion_status: 'deleted',
  });

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/tab=privacy/);
  await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request cloud data deletion', exact: true })).toHaveCount(0);
});

test('Privacy hydrates pending cloud account deletion before enabling deletion', async ({ page }) => {
  await startMockedSettingsSession(page, true);
  await page.route('**/api/settings/cloud/account', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cloud_account_available: true,
        email: 'owner@flo.local',
        deletion_request: { id: 'deletion-1', status: 'pending' },
      }),
    });
  });

  await page.goto(`${BASE}/settings?tab=privacy`);
  const deleteButton = page.getByRole('button', { name: 'Request cloud data deletion', exact: true });
  await expect(deleteButton).toBeVisible();
  await expect(deleteButton).toBeDisabled();
});

test('About hydrates More Apps only when activated', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);

  await page.goto(`${BASE}/settings?tab=about`);
  await expect(page.getByRole('heading', { name: 'About FloCafe', exact: true })).toBeVisible();
  await expect(page.getByText('No apps to show yet.', { exact: true })).toBeVisible();
  expect(apiPaths.filter((path) => path === '/api/more-apps')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/more-apps/revflo')).toHaveLength(0);
});

test('Mobile Access loads cloud and pairing data only when activated, once per tenant', async ({ page }) => {
  await startMockedSettingsSession(page, true);
  const apiPaths = collectApiPaths(page);

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  apiPaths.length = 0;
  expect(apiPaths).not.toContain('/api/mobile/pairing-code');
  expect(apiPaths).not.toContain('/api/mobile/devices');

  await page.getByRole('button', { name: 'Mobile Access', exact: true }).click();
  await expect(page).toHaveURL(/tab=mobile-access/);
  await expect(page.getByRole('heading', { name: 'Mobile Access', exact: true })).toBeVisible();
  await page.waitForTimeout(300);

  expect(apiPaths.filter((path) => path === '/api/settings/cloud')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/pairing-code')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/devices')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/more-apps/revflo')).toHaveLength(1);

  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await page.getByRole('button', { name: 'Mobile Access', exact: true }).click();
  await expect(page).toHaveURL(/tab=mobile-access/);
  await page.waitForTimeout(300);

  expect(apiPaths.filter((path) => path === '/api/settings/cloud')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/pairing-code')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/devices')).toHaveLength(1);
});

test('Save All does not cache partial Mobile Access hydration', async ({ page }) => {
  await startMockedSettingsSession(page, true);
  const apiPaths = collectApiPaths(page);

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  apiPaths.length = 0;
  await page.locator('input[type="text"]').first().fill('Changed Store');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect.poll(() => apiPaths.includes('/api/settings/printing')).toBeTruthy();

  expect(apiPaths).not.toContain('/api/mobile/pairing-code');
  expect(apiPaths).not.toContain('/api/mobile/devices');
  await page.getByRole('button', { name: 'Mobile Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mobile Access', exact: true })).toBeVisible();
  await expect.poll(() => apiPaths.filter((path) => path === '/api/mobile/pairing-code').length).toBe(1);
  await expect.poll(() => apiPaths.filter((path) => path === '/api/mobile/devices').length).toBe(1);
});

test('Rotating pairing code does not refresh devices after leaving Mobile Access', async ({ page }) => {
  await startMockedSettingsSession(page, true);
  const apiPaths = collectApiPaths(page);
  await page.goto(`${BASE}/settings?tab=mobile-access`);
  await expect(page.getByRole('heading', { name: 'Mobile Access', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate Pairing Code', exact: true })).toBeVisible();

  await page.route('**/api/mobile/rotate-code', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pairing_code: 'NEWCODE', expires_at: null, qr_data_url: null }),
    });
  });
  await page.getByRole('button', { name: 'Generate Pairing Code', exact: true }).click();
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await page.waitForTimeout(1200);

  expect(apiPaths.filter((path) => path === '/api/mobile/devices')).toHaveLength(1);
});

test('Leaving KDS cancels station-user hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);
  await page.route('**/api/kitchen-stations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kitchenStations: [{ id: 'station-1', name: 'Main', is_active: 1, sort_order: 0 }] }),
    });
  });
  await page.route('**/api/kitchen-stations/station-1', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kitchenStation: { users: [{ id: 'staff-1', name: 'Chef', role: 'staff' }] } }),
      });
    } catch {}
  });

  await page.goto(`${BASE}/settings?tab=kds`);
  await expect(page.getByRole('heading', { name: 'KDS', exact: true })).toBeVisible();
  await expect.poll(() => apiPaths.filter((path) => path === '/api/kitchen-stations/station-1').length).toBe(1);
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await expect.poll(() => apiPaths.filter((path) => path === '/api/kitchen-stations/station-1').length).toBe(2);
});

test('Changing tabs aborts an in-flight page loader', async ({ page }) => {
  await startMockedSettingsSession(page);
  await page.waitForTimeout(1000);
  let navigationStarted = false;
  await page.unroute('**/api/settings/business');
  await page.route('**/api/settings/business', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, navigationStarted ? 50 : 1000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ business_name: navigationStarted ? 'active' : 'stale' }),
      });
    } catch {
      // The page-owned AbortController should cancel this response.
    }
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  navigationStarted = true;
  await page.getByRole('button', { name: 'Printers', exact: true }).click();
  await expect(page).toHaveURL(/tab=receipts-printers/);
  await page.waitForTimeout(1200);

  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(page.locator('input[type="text"]').first()).toHaveValue('active');
});

test('Save All preserves edits made during business hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  let savedBusinessName: string | undefined;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings/business') {
      savedBusinessName = request.postDataJSON()?.business_name;
    }
  });
  await page.unroute('**/api/settings/business');
  await page.route('**/api/settings/business', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ business_name: 'Server Value' }),
    });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Edited While Loading');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();

  await expect.poll(() => savedBusinessName, { timeout: 10000 }).toBe('Edited While Loading');
});

test('Save All preserves order numbering edits during hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  let savedOrder: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings/order-numbering') {
      savedOrder = request.postDataJSON();
    }
  });
  await page.route('**/api/settings/order-numbering', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        order_number_prefix: 'SERVER',
        order_number_include_date: true,
        order_number_reset_daily: true,
        invoice_number_prefix: 'INV',
        invoice_number_include_period: true,
        invoice_number_reset_period: 'daily',
        invoice_financial_year_start_month: 4,
        invoice_financial_year_start_day: 1,
      }),
    });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  const orderPrefix = page.locator('input[placeholder="ORD"]');
  await orderPrefix.fill('EDIT');
  await orderPrefix.fill('ORD');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();

  await expect.poll(() => savedOrder?.order_number_prefix, { timeout: 10000 }).toBe('ORD');
  expect(savedOrder?.invoice_number_reset_period).toBe('financial_year');
});

test('Save All preserves printing edits during business hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  let savedPrinting: Record<string, unknown> | undefined;
  await page.route('**/api/settings/business', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings/printing') {
      savedPrinting = request.postDataJSON();
    }
  });

  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible();
  await page.getByText('Trim decimals', { exact: true }).locator('..').getByRole('button').click();
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();

  await expect.poll(() => savedPrinting?.printer_trim_decimals, { timeout: 10000 }).toBe(true);
});

test('Rapid Settings navigation stays below the read rate limit', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);
  const responseStatuses: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/')) responseStatuses.push(response.status());
  });

  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  for (const tab of [
    'Printers', 'Mobile Access', 'Store Details', 'Printers', 'Mobile Access',
    'Store Details', 'Printers', 'Mobile Access', 'Store Details', 'Printers',
  ]) {
    await page.getByRole('button', { name: tab, exact: true }).click();
  }
  await page.waitForTimeout(500);

  expect(apiPaths.length).toBeLessThan(MOCK_API_RATE_LIMIT);
  expect(responseStatuses).not.toContain(429);
});

test('Save All hydrates settings before writing and skips mobile status requests', async ({ page }) => {
  await startMockedSettingsSession(page);
  const events: string[] = [];
  let savedBusinessName: string | undefined;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) events.push(`${request.method()} ${path}`);
    if (request.method() === 'PUT' && path === '/api/settings/business') {
      savedBusinessName = request.postDataJSON()?.business_name;
    }
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Changed Store');
  const saveButton = page.getByRole('button', { name: 'Save Changes', exact: true });
  await expect(saveButton).toBeVisible();
  await saveButton.click();

  await expect.poll(() => events.includes('PUT /api/settings/printing'), { timeout: 10000 }).toBeTruthy();
  const firstWrite = events.findIndex((event) => event.startsWith('PUT /api/'));
  expect(firstWrite).toBeGreaterThan(-1);
  for (const path of [
    '/api/settings/business',
    '/api/settings/printer_trim_decimals',
    '/api/settings/z_report_language_policy',
    '/api/settings/loyalty',
    '/api/settings/discount',
    '/api/settings/cloud',
  ]) {
    expect(events.slice(0, firstWrite)).toContain(`GET ${path}`);
  }
  expect(savedBusinessName).toBe('Changed Store');
  expect(events).not.toContain('GET /api/mobile/pairing-code');
  expect(events).not.toContain('GET /api/mobile/devices');
  expect(events).not.toContain('GET /api/more-apps');
  expect(events).not.toContain('GET /api/more-apps/revflo');
});

test('Save All stops when required hydration fails', async ({ page }) => {
  await startMockedSettingsSession(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.startsWith('/api/settings/')) writes.push(path);
  });
  await page.unroute('**/api/settings/business');
  await page.route('**/api/settings/business', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Should Not Save');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await page.waitForTimeout(500);

  expect(writes).toEqual([]);
});

test('Save All stops when printing hydration fails', async ({ page }) => {
  await startMockedSettingsSession(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.startsWith('/api/settings/')) writes.push(path);
  });
  await page.route('**/api/settings/z_report_language_policy', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await page.waitForTimeout(500);

  expect(writes).toEqual([]);
});

test('Health-check deep link loads from the existing store URL', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);

  await page.goto(`${BASE}/settings?tab=store&action=health-check`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await expect.poll(() => apiPaths.filter((path) => path === '/api/db-tools/health-check').length).toBe(1);
});
