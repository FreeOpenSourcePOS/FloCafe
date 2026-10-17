import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const MOCK_API_RATE_LIMIT = 100;

async function startMockedSettingsSession(
  page: Page,
  cloudRegistered = false,
  cloudStatus: Record<string, unknown> = {},
): Promise<void> {
  let apiRequestCount = 0;
  await page.addInitScript(() => {
    localStorage.setItem('token', 'settings-request-budget-token');
  });
  await page.route('**/api/**', async (route) => {
    apiRequestCount += 1;
    if (apiRequestCount > MOCK_API_RATE_LIMIT) {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
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
    if (
      path === '/api/settings/cloud' &&
      (cloudRegistered || Object.keys(cloudStatus).length > 0)
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cloud_registration_status: cloudRegistered ? 'registered' : 'unregistered',
          ...cloudStatus,
        }),
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

  const inactiveTabRequests = apiPaths.filter((path) =>
    [
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
    ].includes(path),
  );

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
  await expect(
    page.getByRole('button', { name: 'Request cloud data deletion', exact: true }),
  ).toHaveCount(0);
});

test('Privacy hydrates pending cloud account deletion before enabling deletion', async ({
  page,
}) => {
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
  const deleteButton = page.getByRole('button', {
    name: 'Request cloud data deletion',
    exact: true,
  });
  await expect(deleteButton).toBeVisible();
  await expect(deleteButton).toBeDisabled();
});

test('Privacy retries required cloud hydration after an account failure', async ({ page }) => {
  await startMockedSettingsSession(page);
  let shouldFail = true;
  let accountAttempts = 0;
  await page.route('**/api/settings/cloud/account', async (route) => {
    accountAttempts += 1;
    if (shouldFail) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloud_account_available: true, email: 'owner@flo.local' }),
    });
  });

  await page.goto(`${BASE}/settings?tab=privacy`);
  await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Request cloud data deletion', exact: true }),
  ).toHaveCount(0);

  shouldFail = false;
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Request cloud data deletion', exact: true }),
  ).toBeVisible();
  expect(accountAttempts).toBeGreaterThanOrEqual(2);
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

test('Appearance hydrates the persisted theme when activated', async ({ page }) => {
  await startMockedSettingsSession(page);
  await page.route('**/api/settings/theme_mode', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'dark' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=appearance`);
  await expect(page.getByRole('radiogroup', { name: 'Theme', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
});

test('Mobile Access loads cloud and pairing data only when activated, once per tenant', async ({
  page,
}) => {
  await startMockedSettingsSession(page, true);
  const apiPaths = collectApiPaths(page);

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(apiPaths).not.toContain('/api/mobile/pairing-code');
  expect(apiPaths).not.toContain('/api/mobile/devices');
  apiPaths.length = 0;

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

test('Cloud registration refreshes Mobile Access pairing data', async ({ page }) => {
  await startMockedSettingsSession(page);
  let registered = false;
  let firstCloudRequest = true;
  let releaseFirstCloudRequest: (() => void) | null = null;
  const firstCloudRequestReleased = new Promise<void>((resolve) => {
    releaseFirstCloudRequest = resolve;
  });
  const apiPaths = collectApiPaths(page);
  await page.route('**/api/settings/cloud', async (route) => {
    const statusAtRequest = registered ? 'registered' : 'unregistered';
    if (firstCloudRequest) {
      firstCloudRequest = false;
      await firstCloudRequestReleased;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cloud_registration_status: statusAtRequest,
          cloud_sync_enabled: statusAtRequest === 'registered',
          cloud_orders_enabled: statusAtRequest === 'registered',
        }),
      });
    } catch {}
  });
  await page.route('**/api/settings/cloud/register', async (route) => {
    registered = true;
    releaseFirstCloudRequest?.();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloud_registration_status: 'registered' }),
    });
  });
  await page.route('**/api/mobile/pairing-code', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pairing_code: 'PAIR123', expires_at: null, qr_data_url: null }),
    });
  });
  await page.route('**/api/mobile/devices', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ devices: [] }),
    });
  });

  await page.goto(`${BASE}/settings?tab=mobile-access`);
  await expect.poll(() => firstCloudRequest).toBe(false);
  await expect(
    page.getByRole('button', { name: 'Initialize Cloud Services', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Initialize Cloud Services', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Accept & Initialize', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Accept & Initialize', exact: true }).click();

  await expect(page.getByText('PAIR123', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Enable Cloud Sync for RevFlo/i })).toBeChecked();
  expect(apiPaths.filter((path) => path === '/api/mobile/pairing-code')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/devices')).toHaveLength(1);
});

test('Mobile Access caches an unavailable cloud status without navigation retries', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let cloudAttempts = 0;
  await page.route('**/api/settings/cloud', async (route) => {
    cloudAttempts += 1;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    });
  });

  await page.goto(`${BASE}/settings?tab=mobile-access`);
  await expect(page.getByRole('heading', { name: 'Mobile Access', exact: true })).toBeVisible();
  await expect.poll(() => cloudAttempts).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const initialCloudAttempts = cloudAttempts;
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.getByRole('button', { name: 'Mobile Access', exact: true }).click();
  await page.waitForTimeout(200);

  expect(cloudAttempts).toBe(initialCloudAttempts);
});

test('Save All does not write cloud defaults after unavailable cloud hydration', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let cloudWrites = 0;
  let releaseCloudHydration!: () => void;
  const cloudHydrationHeld = new Promise<void>((resolve) => {
    releaseCloudHydration = resolve;
  });
  await page.route('**/api/settings/cloud', async (route) => {
    if (route.request().method() === 'GET') {
      await cloudHydrationHeld;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    cloudWrites += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Changed Store');
  const saveButton = page.getByRole('button', { name: /^(Save Changes|Saving\.\.\.)$/ });
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  releaseCloudHydration();
  await expect(saveButton).toBeEnabled();
  expect(cloudWrites).toBe(0);
});

test('Cloud registration refresh does not continue after leaving Mobile Access', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let registered = false;
  let pairingStarted = false;
  await page.route('**/api/settings/cloud', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cloud_registration_status: registered ? 'registered' : 'unregistered',
      }),
    });
  });
  await page.route('**/api/settings/cloud/register', async (route) => {
    registered = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloud_registration_status: 'registered' }),
    });
  });
  await page.route('**/api/mobile/pairing-code', async (route) => {
    pairingStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pairing_code: 'STALECODE', expires_at: null, qr_data_url: null }),
      });
    } catch {}
  });
  const apiPaths = collectApiPaths(page);
  await page.goto(`${BASE}/settings?tab=mobile-access`);
  await page.getByRole('button', { name: 'Initialize Cloud Services', exact: true }).click();
  await page.getByRole('button', { name: 'Accept & Initialize', exact: true }).click();
  await expect.poll(() => pairingStarted).toBe(true);
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.waitForTimeout(1200);

  expect(apiPaths.filter((path) => path === '/api/mobile/pairing-code')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/devices')).toHaveLength(0);
});

test('Failed KDS and Data hydration retries when revisiting the tab', async ({ page }) => {
  await startMockedSettingsSession(page);
  let kdsInfoAttempts = 0;
  let backupAttempts = 0;
  await page.route('**/api/kds-info', async (route) => {
    kdsInfoAttempts += 1;
    if (kdsInfoAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });
  await page.route('**/api/db-tools/backups', async (route) => {
    backupAttempts += 1;
    if (backupAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ backups: [] }),
    });
  });

  await page.goto(`${BASE}/settings?tab=kds`);
  await expect(page.getByRole('heading', { name: 'KDS', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await expect.poll(() => kdsInfoAttempts).toBe(2);

  await page.getByRole('button', { name: 'Backup & Data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Backup & Data', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.getByRole('button', { name: 'Backup & Data', exact: true }).click();
  await expect.poll(() => backupAttempts).toBe(2);
});

test('Data hydration caches before optional Google Drive status resolves', async ({ page }) => {
  await startMockedSettingsSession(page);
  let googleDriveAttempts = 0;
  const hydrationOrder: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      [
        '/api/settings/google-drive',
        '/api/db-tools/master-pin/status',
        '/api/db-tools/backups',
      ].includes(path)
    )
      hydrationOrder.push(path);
  });
  await page.route('**/api/settings/google-drive', async (route) => {
    googleDriveAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    } catch {}
  });

  const googleDriveRequest = page.waitForRequest('**/api/settings/google-drive');
  await page.goto(`${BASE}/settings?tab=data`);
  await expect(page.getByRole('heading', { name: 'Backup & Data', exact: true })).toBeVisible();
  await expect
    .poll(() => hydrationOrder.filter((path) => path !== '/api/settings/google-drive').length)
    .toBe(2);
  await googleDriveRequest;
  expect(hydrationOrder.indexOf('/api/db-tools/master-pin/status')).toBeLessThan(
    hydrationOrder.indexOf('/api/settings/google-drive'),
  );
  expect(hydrationOrder.indexOf('/api/db-tools/backups')).toBeLessThan(
    hydrationOrder.indexOf('/api/settings/google-drive'),
  );
  await expect.poll(() => googleDriveAttempts).toBe(1);
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.getByRole('button', { name: 'Backup & Data', exact: true }).click();
  await page.waitForTimeout(200);

  expect(googleDriveAttempts).toBe(1);
});

test('Google Drive revoke retry survives status hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  let disconnectAttempts = 0;
  await page.route('**/api/settings/google-drive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        auth_state: 'disconnected',
        secure_storage_available: true,
        connected: false,
        revoke_status: 'unconfirmed',
      }),
    });
  });
  await page.route('**/api/settings/google-drive/disconnect', async (route) => {
    disconnectAttempts += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        connected: false,
        auth_state: 'disconnected',
        revoke_status: 'unconfirmed',
      }),
    });
  });

  await page.goto(`${BASE}/settings?tab=data`);
  await expect(page.getByRole('heading', { name: 'Backup & Data', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry disconnect', exact: true })).toBeVisible();
  await expect(
    page.getByText('Google Drive access is still active. Retry disconnect to revoke it.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry disconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(() => disconnectAttempts).toBe(1);
  await expect(page.getByText('Google Drive disconnected', { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByText('Google Drive access is still active. Retry disconnect to revoke it.', {
        exact: true,
      })
      .first(),
  ).toBeVisible();
});

test('Google Drive retention-pending backup shows a pending warning', async ({ page }) => {
  await startMockedSettingsSession(page);
  let jobPolls = 0;
  await page.route('**/api/settings/google-drive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        auth_state: 'connected',
        secure_storage_available: true,
        connected: true,
        warning_acknowledged: true,
        warning_required: false,
      }),
    });
  });
  await page.route('**/api/settings/google-drive/destinations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ destinations: [] }),
    });
  });
  await page.route('**/api/settings/google-drive/backups', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ backups: [] }),
    });
  });
  await page.route('**/api/settings/google-drive/backup-now', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'retention-job', state: 'queued' } }),
    });
  });
  await page.route('**/api/settings/google-drive/jobs/retention-job', async (route) => {
    jobPolls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'retention-job', state: 'retention_pending' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=data`);
  await page.getByRole('button', { name: 'Back up to Drive now', exact: true }).click();
  await page.getByRole('button', { name: 'I understand', exact: true }).click();
  await expect.poll(() => jobPolls).toBe(1);
  await expect(
    page
      .getByText(
        'Backup uploaded, but automatic retention cleanup is pending and will retry automatically.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText('Backup uploaded to Google Drive', { exact: true })).toHaveCount(0);
});

test('Google Drive cancelled transfer shows automatic retry state', async ({ page }) => {
  await startMockedSettingsSession(page);
  let jobPolls = 0;
  await page.route('**/api/settings/google-drive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        auth_state: 'connected',
        secure_storage_available: true,
        connected: true,
        warning_acknowledged: true,
        warning_required: false,
      }),
    });
  });
  await page.route('**/api/settings/google-drive/destinations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ destinations: [] }),
    });
  });
  await page.route('**/api/settings/google-drive/backups', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ backups: [] }),
    });
  });
  await page.route('**/api/settings/google-drive/backup-now', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'cancelled-job', state: 'queued' } }),
    });
  });
  await page.route('**/api/settings/google-drive/jobs/cancelled-job', async (route) => {
    jobPolls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job: { id: 'cancelled-job', state: 'offline_pending', error_code: 'cancelled' },
      }),
    });
  });

  await page.goto(`${BASE}/settings?tab=data`);
  await page.getByRole('button', { name: 'Back up to Drive now', exact: true }).click();
  await page.getByRole('button', { name: 'I understand', exact: true }).click();
  await expect.poll(() => jobPolls).toBe(1);
  await expect(
    page
      .getByText('Google Drive backup is pending and will retry automatically.', { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByText('Backup to Google Drive failed', { exact: true })).toHaveCount(0);
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
  await expect
    .poll(() => apiPaths.filter((path) => path === '/api/mobile/pairing-code').length)
    .toBe(1);
  await expect.poll(() => apiPaths.filter((path) => path === '/api/mobile/devices').length).toBe(1);
});

test('Rotating pairing code does not refresh devices after leaving Mobile Access', async ({
  page,
}) => {
  await startMockedSettingsSession(page, true);
  const apiPaths = collectApiPaths(page);
  await page.goto(`${BASE}/settings?tab=mobile-access`);
  await expect(page.getByRole('heading', { name: 'Mobile Access', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Generate Pairing Code', exact: true }),
  ).toBeVisible();

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

test('Rotating pairing code does not update the code after leaving and re-entering Mobile Access', async ({
  page,
}) => {
  await startMockedSettingsSession(page, true);
  const apiPaths = collectApiPaths(page);
  await page.route('**/api/mobile/pairing-code', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pairing_code: 'INITIALCODE', expires_at: null, qr_data_url: null }),
    });
  });
  await page.goto(`${BASE}/settings?tab=mobile-access`);
  await expect(page.getByRole('heading', { name: 'Mobile Access', exact: true })).toBeVisible();
  await expect(page.getByText('INITIALCODE', { exact: true })).toBeVisible();

  await page.route('**/api/mobile/rotate-code', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pairing_code: 'STALECODE', expires_at: null, qr_data_url: null }),
      });
    } catch {}
  });
  await page.getByRole('button', { name: /Generate new code/i }).click();
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await page.getByRole('button', { name: 'Mobile Access', exact: true }).click();
  await expect(page.getByText('INITIALCODE', { exact: true })).toBeVisible();
  await page.waitForTimeout(1200);

  expect(apiPaths.filter((path) => path === '/api/mobile/rotate-code')).toHaveLength(1);
  expect(apiPaths.filter((path) => path === '/api/mobile/devices')).toHaveLength(1);
  await expect(page.getByText('STALECODE', { exact: true })).toHaveCount(0);
});

test('Leaving Kitchen Stations cancels station-user hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);
  await page.route('**/api/kitchen-stations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kitchenStations: [{ id: 'station-1', name: 'Main', is_active: 1, sort_order: 0 }],
      }),
    });
  });
  await page.route('**/api/kitchen-stations/station-1', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kitchenStation: { users: [{ id: 'staff-1', name: 'Chef', role: 'staff' }] },
        }),
      });
    } catch {}
  });

  await page.goto(`${BASE}/settings?tab=kitchen-stations`);
  await expect(page.getByRole('heading', { name: 'Kitchen Stations', exact: true })).toBeVisible();
  await expect
    .poll(() => apiPaths.filter((path) => path === '/api/kitchen-stations/station-1').length)
    .toBe(1);
  await page.getByRole('button', { name: 'Store Details', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Kitchen Stations', exact: true }).click();
  await expect
    .poll(() => apiPaths.filter((path) => path === '/api/kitchen-stations/station-1').length)
    .toBe(2);
});

test('Changing tabs aborts an in-flight page loader', async ({ page }) => {
  await startMockedSettingsSession(page);
  await page.waitForTimeout(1000);
  let navigationStarted = false;
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
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/settings/business'
    ) {
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
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/settings/order-numbering'
    ) {
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
        invoice_number_reset_period: 'financial_year',
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
  await page.locator('input[type="text"]').first().fill('Changed Store');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();

  await expect.poll(() => savedOrder?.order_number_prefix, { timeout: 10000 }).toBe('ORD');
  expect(savedOrder?.invoice_number_reset_period).toBe('financial_year');
});

test('Save All preserves printing edits during business hydration', async ({ page }) => {
  await startMockedSettingsSession(page);
  const savedPrintingRequests: Record<string, unknown>[] = [];
  await page.route('**/api/settings/business', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/settings/printing'
    ) {
      savedPrintingRequests.push(request.postDataJSON());
    }
  });

  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Trim decimals', exact: true }).click();
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();

  await expect.poll(() => savedPrintingRequests.length, { timeout: 10000 }).toBe(1);
  expect(savedPrintingRequests[0]).toEqual({
    printer_trim_decimals: true,
    bill_language_policy: { primary: { mode: 'inherit' }, additional: [] },
    kot_language_policy: { primary: { mode: 'inherit' }, additional: [] },
    bill_show_logo: false,
    bill_show_name: true,
    bill_show_address: true,
    bill_show_phone: true,
    bill_show_tax_id: false,
    bill_show_tax_breakdown: true,
    bill_show_customer_name: true,
    bill_show_customer_phone: true,
    bill_show_table_number: true,
    bill_delivery_show_customer_phone_always: true,
  });
});

test('Printers tab hydrates KDS enabled state on direct load for the double-off warning', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  await page.route('**/api/settings/kds_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Both the Kitchen Display and KOT printing are off. Kitchen items won't display or print anywhere — orders will need to be marked served directly at the counter.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: false,
    });
});

test('Rapid Settings navigation stays below the read rate limit', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);
  const responseStatuses: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/'))
      responseStatuses.push(response.status());
  });

  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  for (const tab of [
    'Printers',
    'Mobile Access',
    'Store Details',
    'Printers',
    'Mobile Access',
    'Store Details',
    'Printers',
    'Mobile Access',
    'Store Details',
    'Printers',
  ]) {
    await page.getByRole('button', { name: tab, exact: true }).click();
  }
  await page.waitForTimeout(500);

  expect(apiPaths.length).toBeLessThan(MOCK_API_RATE_LIMIT);
  expect(responseStatuses).not.toContain(429);
});

test('Save All hydrates settings before writing and skips mobile status requests', async ({
  page,
}) => {
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

  await expect
    .poll(() => events.includes('PUT /api/settings/printing'), { timeout: 10000 })
    .toBeTruthy();
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
  let releaseBusinessHydration!: () => void;
  const businessHydrationHeld = new Promise<void>((resolve) => {
    releaseBusinessHydration = resolve;
  });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.startsWith('/api/settings/')) writes.push(path);
  });
  await page.route('**/api/settings/business', async (route) => {
    await businessHydrationHeld;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Should Not Save');
  const saveButton = page.getByRole('button', { name: /^(Save Changes|Saving\.\.\.)$/ });
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  releaseBusinessHydration();
  await expect(saveButton).toBeEnabled();

  expect(writes).toEqual([]);
});

test('Save All stops when printing hydration fails', async ({ page }) => {
  await startMockedSettingsSession(page);
  const writes: string[] = [];
  let releasePrintingHydration!: () => void;
  const printingHydrationHeld = new Promise<void>((resolve) => {
    releasePrintingHydration = resolve;
  });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.startsWith('/api/settings/')) writes.push(path);
  });
  await page.route('**/api/settings/z_report_language_policy', async (route) => {
    await printingHydrationHeld;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    });
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Should Not Save');
  const saveButton = page.getByRole('button', { name: /^(Save Changes|Saving\.\.\.)$/ });
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  releasePrintingHydration();
  await expect(saveButton).toBeEnabled();

  expect(writes).toEqual([]);
});

test('Save All persists when a settings read is rate limited', async ({ page }) => {
  await startMockedSettingsSession(page);
  let throttledAttempts = 0;
  // A 429 is throttling, not unavailability, so the read must be retried. Treating it
  // as a failed hydration used to make Save Changes discard the whole edit set.
  await page.route('**/api/settings/z_report_language_policy', async (route) => {
    throttledAttempts += 1;
    if (throttledAttempts === 1) {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto(`${BASE}/settings?tab=store`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await page.locator('input[type="text"]').first().fill('Should Save');
  // Wait on the response, not on the request being dispatched, so a rejected save
  // cannot pass unnoticed.
  const businessSave = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/settings/business' && response.request().method() === 'PUT';
  });
  await page.getByRole('button', { name: /^(Save Changes|Saving\.\.\.)$/ }).click();
  expect((await businessSave).ok()).toBe(true);

  expect(throttledAttempts).toBeGreaterThan(1);
});

test('Health-check deep link loads from the existing store URL', async ({ page }) => {
  await startMockedSettingsSession(page);
  const apiPaths = collectApiPaths(page);
  await page.route('**/api/db-tools/health-check', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-01-01T00:00:00.000Z',
        liveSchemaVersion: 1,
        idealSchemaVersion: 1,
        findings: [],
        summary: { safeCount: 0, manualReviewCount: 0 },
      }),
    }),
  );

  await page.goto(`${BASE}/settings?tab=store&action=health-check`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('dialog').getByText('No issues found', { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => apiPaths.filter((path) => path === '/api/db-tools/health-check').length)
    .toBe(1);
});

test('Network pairing cards explain local and VPN/mesh QR choices across settings tabs and languages', async ({
  page,
}) => {
  await startMockedSettingsSession(page);

  const pairingInfo = {
    mdns_url: 'http://flo.local:3001',
    ip_url: 'http://192.168.1.25:3001',
    qr_url: 'http://192.168.1.25:3001/qr',
    qr_data_url: null,
    ips_data: [
      { ip: '192.168.1.25', url: 'http://192.168.1.25:3001', qr_data: null },
      { ip: '10.42.0.25', url: 'http://10.42.0.25:3001', qr_data: null },
      { ip: '100.64.0.25', url: 'http://100.64.0.25:3001', qr_data: null },
    ],
  };
  for (const path of ['/api/pos-info', '/api/kds-info', '/api/server-app-info']) {
    await page.route('**' + path, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(pairingInfo),
      });
    });
  }

  const expectPairingHints = async (localHint: string, vpnHint: string, vpnLabel: string) => {
    await expect(page.getByText(localHint, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(vpnHint, { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: vpnLabel, exact: true }).focus();
    await expect(page.getByRole('tooltip')).toHaveText(vpnHint);
  };
  const selectLanguage = async (storeLabel: string, language: string) => {
    await page.getByRole('button', { name: storeLabel, exact: true }).click();
    const languageSelect = page
      .locator('select')
      .filter({ has: page.locator('option[value="en"]') })
      .first();
    await languageSelect.selectOption(language);
  };

  await page.goto(BASE + '/settings?tab=pos');
  await page.getByRole('button', { name: 'Load POS Info', exact: true }).click();
  const englishLocalHint =
    'Use when all devices can reach this address over Wi-Fi, Ethernet, or a VPN/mesh network';
  const englishVpnHint =
    'Use when devices connect via a VPN or mesh network across different subnets or locations';
  const expectLocalAddressCard = async () => {
    const localAddress = 'http://10.42.0.25:3001';
    const localCard = page
      .getByRole('link', { name: localAddress, exact: true })
      .locator('xpath=..');
    await expect(localCard.getByRole('link')).toHaveAttribute('href', localAddress);
    await expect(localCard.getByText('Local Network', { exact: true })).toBeVisible();
    await expect(localCard).toContainText(englishLocalHint);
  };
  await expectPairingHints(englishLocalHint, englishVpnHint, 'VPN / Mesh Network');
  await expectLocalAddressCard();

  const networkGrid = page
    .getByText(englishLocalHint, { exact: true })
    .first()
    .locator('xpath=../../..');
  const desktopColumns = await networkGrid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
  );
  expect(desktopColumns).toBe(2);
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileColumns = await networkGrid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
  );
  expect(mobileColumns).toBe(1);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await expectPairingHints(englishLocalHint, englishVpnHint, 'VPN / Mesh Network');
  await expectLocalAddressCard();

  await page.getByRole('button', { name: 'Tableside Ordering', exact: true }).click();
  await page.getByRole('button', { name: 'Load Server App Info', exact: true }).click();
  await expectPairingHints(englishLocalHint, englishVpnHint, 'VPN / Mesh Network');
  await expectLocalAddressCard();

  await selectLanguage('Store Details', 'es');
  await page.getByRole('button', { name: 'Flujo del POS', exact: true }).click();
  await expectPairingHints(
    'Úsalo cuando todos los dispositivos puedan acceder a esta dirección por Wi-Fi, Ethernet o una red VPN/mesh',
    'Úsalo cuando los dispositivos se conecten mediante una VPN o una red mesh entre distintas subredes o ubicaciones',
    'VPN / Red mesh',
  );

  await selectLanguage('Datos del Negocio', 'de');
  await page.getByRole('button', { name: 'KDS & Küche', exact: true }).click();
  await expectPairingHints(
    'Verwenden Sie diese Option, wenn alle Geräte diese Adresse über WLAN, Ethernet oder ein VPN-/Mesh-Netzwerk erreichen können',
    'Verwenden Sie diese Option, wenn Geräte über ein VPN oder Mesh-Netzwerk über verschiedene Subnetze oder Standorte hinweg verbunden sind',
    'VPN / Mesh-Netzwerk',
  );

  await selectLanguage('Geschäftsdaten', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: 'الطلب من جانب الطاولة', exact: true }).click();
  await expectPairingHints(
    'استخدم هذا الخيار عندما تتمكن جميع الأجهزة من الوصول إلى هذا العنوان عبر Wi-Fi أو Ethernet أو شبكة VPN/mesh',
    'استخدم هذا الخيار عندما تتصل الأجهزة عبر VPN أو شبكة متداخلة بين شبكات فرعية أو مواقع مختلفة',
    'شبكة VPN / شبكة متشابكة',
  );
});

test('Charges stay read-only after a failed refresh until retry succeeds', async ({ page }) => {
  await startMockedSettingsSession(page);
  const charge = {
    id: 'existing_fee',
    name: 'Existing fee',
    type: 'fixed',
    value: 3,
    calculation_basis: 'gross',
    order_types: ['dine_in'],
    is_optional: false,
    is_default_active: true,
    is_active: true,
    tax_category_id: null,
  };
  let reads = 0;
  let writes = 0;
  await page.route('**/api/settings/charges', async (route) => {
    if (route.request().method() === 'GET') {
      reads += 1;
      if (reads === 2) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ charges: [charge] }),
      });
      return;
    }
    writes += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ charges: [charge] }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);
  await expect(page.getByText('Existing fee', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await page.getByRole('button', { name: 'POS Workflow', exact: true }).click();

  const chargesError = page.getByRole('alert').filter({ hasText: 'Failed to reload settings' });
  await expect(chargesError).toBeVisible();
  await expect(page.getByText('Existing fee', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Charge', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  expect(writes).toBe(0);

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(chargesError).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Charge', exact: true })).toBeEnabled();
  expect(reads).toBe(3);
});

test('Charges use presets, edit existing standard definitions, and confirm deletion before saving', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  const charge = {
    id: 'service_charge',
    name: 'Table service',
    type: 'percentage',
    value: 10,
    calculation_basis: 'net',
    order_types: ['dine_in', 'takeaway'],
    is_optional: true,
    is_default_active: false,
    is_active: false,
    tax_category_id: 'standard',
  };
  let writes = 0;
  let savedCharges: unknown[] = [];
  await page.route('**/api/settings/charges', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ charges: [charge] }),
      });
      return;
    }
    writes += 1;
    savedCharges = route.request().postDataJSON().charges;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ charges: savedCharges }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);
  await expect(page.getByText('Table service', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add Charge', exact: true }).click();
  const form = page.getByRole('dialog');

  await expect(form.getByLabel('Charge ID')).toHaveCount(0);

  await expect(form.getByLabel('Fee Type')).toHaveValue('custom');
  await expect(form.getByLabel('Name')).toHaveValue('');
  await expect(form.getByLabel('Value')).toHaveValue('');
  await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await form.getByLabel('Fee Type').selectOption('packaging');
  expect(writes).toBe(0);
  await expect(form.getByLabel('Name')).toHaveValue('Packaging charge');
  await expect(form.getByLabel(/^type/i)).toHaveValue('fixed');
  await expect(form.getByLabel('Value')).toHaveValue('');
  await expect(form.getByLabel('Dine In')).not.toBeChecked();
  await expect(form.getByLabel('Takeaway')).toBeChecked();
  await expect(form.getByLabel('Delivery')).toBeChecked();
  await expect(form.getByLabel('Online')).toBeChecked();
  await expect(form.getByLabel('Apply automatically')).toBeChecked();
  await expect(form.getByLabel('Cashier can waive')).not.toBeChecked();
  await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  // An existing reserved ID opens the saved definition instead of creation defaults.
  await form.getByLabel('Fee Type').selectOption('service');
  expect(writes).toBe(0);
  await expect(form.getByRole('heading', { name: 'Edit Charge' })).toBeVisible();
  await expect(form.getByLabel('Fee Type')).toBeDisabled();
  await expect(form.getByLabel('Name')).toHaveValue('Table service');
  await expect(form.getByLabel('Value')).toHaveValue('10');
  await expect(form.getByLabel('Takeaway')).toBeChecked();
  await expect(form.getByLabel('Cashier can waive')).toBeChecked();
  await expect(form.getByLabel('Apply automatically')).not.toBeChecked();

  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toBe(0);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('Name').fill('Service');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  expect(savedCharges).toEqual([{ ...charge, name: 'Service' }]);

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText('Delete Service?');
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => writes).toBe(2);
  expect(savedCharges).toEqual([]);
});

test('Charges generate stable custom IDs, allow duplicate names, and preserve IDs on rename/retry', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let writes = 0;
  let savedCharges: Array<{ id: string; name: string; value: number }> = [];
  let shouldFailNextSave = false;
  let failedCharges: Array<{ id: string }> = [];

  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined });
  });
  await page.route('**/api/settings/charges', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ charges: savedCharges }),
      });
      return;
    }
    writes += 1;
    if (shouldFailNextSave) {
      failedCharges = route.request().postDataJSON().charges;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Save failed' }),
      });
      return;
    }
    savedCharges = route.request().postDataJSON().charges;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ charges: savedCharges }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);

  await page.getByRole('button', { name: 'Add Charge', exact: true }).click();
  let form = page.getByRole('dialog');
  await form.getByLabel('Fee Type').selectOption('service');
  await expect(form.getByRole('heading', { name: 'Add Charge' })).toBeVisible();
  await expect(form.getByLabel('Name')).toHaveValue('Service charge');
  await expect(form.getByLabel(/^type/i)).toHaveValue('percentage');
  await expect(form.getByLabel('Value')).toHaveValue('');
  await expect(form.getByLabel('Dine In')).toBeChecked();
  await expect(form.getByLabel('Takeaway')).not.toBeChecked();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toBe(0);

  // Create first custom charge with a non-ASCII name
  await page.getByRole('button', { name: 'Add Charge', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('Name').fill('رسوم التوصيل');
  await form.getByLabel('Value').fill('5');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  expect(savedCharges.length).toBe(1);
  const firstId = savedCharges[0].id;
  expect(firstId).toMatch(/^charge-[a-f0-9]{32}$/);

  // Create a second custom charge with the same name; a failed save and retry keep its new ID
  await page.getByRole('button', { name: 'Add Charge', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('Name').fill('رسوم التوصيل');
  await form.getByLabel('Value').fill('8');
  shouldFailNextSave = true;
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(2);
  await expect(form).toBeVisible();
  const failedDraftId = failedCharges[1]?.id;
  shouldFailNextSave = false;
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(3);
  expect(savedCharges.length).toBe(2);
  const secondId = savedCharges[1].id;
  expect(secondId).toMatch(/^charge-[a-f0-9]{32}$/);
  expect(secondId).toBe(failedDraftId);
  expect(firstId).not.toBe(secondId);

  // Edit the first charge: change its name, ID must remain firstId
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  form = page.getByRole('dialog');
  await expect(form.getByRole('heading', { name: 'Edit Charge' })).toBeVisible();
  await expect(form.getByLabel('Fee Type')).toBeDisabled();
  await form.getByLabel('Name').fill('Envío exprés 配送');

  // Failed save keeps dialog open and retry preserves the exact same ID
  shouldFailNextSave = true;
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(4);
  await expect(form).toBeVisible();

  shouldFailNextSave = false;
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(5);
  expect(savedCharges.length).toBe(2);
  expect(savedCharges[0].id).toBe(firstId);
  expect(savedCharges[0].name).toBe('Envío exprés 配送');
});

for (const outcome of ['deleted', 'updated', 'unavailable'] as const) {
  test(`Charges reconcile an open editor with ${outcome} server definitions before saving`, async ({
    page,
  }) => {
    await startMockedSettingsSession(page);
    const original = {
      id: 'service_charge',
      name: 'Original service',
      type: 'percentage',
      value: 10,
      calculation_basis: 'gross',
      order_types: ['dine_in'],
      is_optional: false,
      is_default_active: true,
      is_active: true,
      tax_category_id: null as string | null,
    };
    const other = { ...original, id: 'other_fee', name: 'Other fee', value: 3 };
    let serverCharges = [original, other];
    let failReads = false;
    let writes = 0;
    let reads = 0;
    await page.route('**/api/settings/charges', async (route) => {
      if (route.request().method() === 'GET') {
        reads += 1;
        await route.fulfill({
          status: failReads ? 503 : 200,
          json: failReads ? { error: 'Read unavailable' } : { charges: serverCharges },
        });
        return;
      }
      writes += 1;
      serverCharges = route.request().postDataJSON().charges;
      await route.fulfill({ status: 200, json: { charges: serverCharges } });
    });
    await page.goto(`${BASE}/settings?tab=pos`);
    await expect(page.getByText(original.name, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Name').fill('Renamed service');

    const latestOther = { ...other, value: 7 };
    const latestOriginal = { ...original, is_active: false, tax_category_id: 'standard' };
    serverCharges = outcome === 'deleted' ? [latestOther] : [latestOriginal, latestOther];
    failReads = outcome === 'unavailable';
    const readsBeforeSave = reads;
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(readsBeforeSave);

    if (outcome === 'deleted') {
      await expect(form).toBeHidden();
      await expect(
        page.getByText('This charge is no longer available. Please reopen and try again.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(writes).toBe(0);
      expect(serverCharges).toEqual([latestOther]);
    } else if (outcome === 'updated') {
      await expect(form).toBeHidden();
      expect(writes).toBe(1);
      expect(serverCharges).toEqual([{ ...latestOriginal, name: 'Renamed service' }, latestOther]);
    } else {
      await expect(page.getByRole('alert')).toContainText('Failed to reload settings');
      await expect(form.getByLabel('Name')).toHaveValue('Renamed service');
      await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      expect(writes).toBe(0);
      failReads = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(form).toBeHidden();
      expect(writes).toBe(1);
      expect(serverCharges).toEqual([{ ...latestOriginal, name: 'Renamed service' }, latestOther]);
    }
  });
}

test('Charges ignore an older failed load after a newer load succeeds', async ({ page }) => {
  await startMockedSettingsSession(page);
  const latestCharge = {
    id: 'latest_fee',
    name: 'Latest fee',
    type: 'fixed',
    value: 4,
    calculation_basis: 'gross',
    order_types: ['dine_in'],
    is_optional: false,
    is_default_active: true,
    is_active: true,
    tax_category_id: null,
  };
  let releaseFirstRead!: () => void;
  let signalFirstReadStarted!: () => void;
  let signalFirstReadFinished!: () => void;
  const firstReadHeld = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const firstReadStarted = new Promise<void>((resolve) => {
    signalFirstReadStarted = resolve;
  });
  const firstReadFinished = new Promise<void>((resolve) => {
    signalFirstReadFinished = resolve;
  });
  let reads = 0;
  await page.route('**/api/settings/charges', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ charges: [] }),
      });
      return;
    }
    reads += 1;
    if (reads === 1) {
      signalFirstReadStarted();
      await firstReadHeld;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      signalFirstReadFinished();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ charges: [latestCharge] }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);
  await firstReadStarted;
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await page.getByRole('button', { name: 'POS Workflow', exact: true }).click();
  await expect(page.getByText('Latest fee', { exact: true })).toBeVisible();

  const staleFailure = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/settings/charges' &&
      response.request().method() === 'GET' &&
      response.status() === 503
    );
  });
  releaseFirstRead();
  await staleFailure;
  await firstReadFinished;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await expect(
    page.getByRole('alert').filter({ hasText: 'Failed to reload settings' }),
  ).toHaveCount(0);
  await expect(page.getByText('Latest fee', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Charge', exact: true })).toBeEnabled();
  expect(reads).toBe(2);
});

test('Charges keep saved definitions when a pending load completes later', async ({ page }) => {
  await startMockedSettingsSession(page);
  const originalCharge = {
    id: 'existing_fee',
    name: 'Existing fee',
    type: 'fixed',
    value: 3,
    calculation_basis: 'gross',
    order_types: ['dine_in'],
    is_optional: false,
    is_default_active: true,
    is_active: true,
    tax_category_id: null,
  };
  let savedCharges: Array<Record<string, unknown>> = [originalCharge];
  let releaseSave!: () => void;
  let signalSaveStarted!: () => void;
  let releaseStaleRead!: () => void;
  let signalStaleReadStarted!: () => void;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveStarted = new Promise<void>((resolve) => {
    signalSaveStarted = resolve;
  });
  const staleReadHeld = new Promise<void>((resolve) => {
    releaseStaleRead = resolve;
  });
  const staleReadStarted = new Promise<void>((resolve) => {
    signalStaleReadStarted = resolve;
  });
  let reads = 0;
  await page.route('**/api/settings/charges', async (route) => {
    if (route.request().method() === 'GET') {
      reads += 1;
      if (reads === 3) {
        signalStaleReadStarted();
        await staleReadHeld;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ charges: [originalCharge] }),
      });
      return;
    }
    savedCharges = route.request().postDataJSON().charges;
    signalSaveStarted();
    await saveHeld;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ charges: savedCharges }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);
  await expect(page.getByText('Existing fee', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name').fill('Updated fee');
  const saveResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/settings/charges' && response.request().method() === 'PUT';
  });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await saveStarted;
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await page.getByRole('button', { name: 'POS Workflow', exact: true }).click();
  await staleReadStarted;

  releaseSave();
  await saveResponse;
  await expect(page.getByText('Updated fee', { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/settings/charges' &&
      response.request().method() === 'GET' &&
      response.status() === 200
    );
  });
  releaseStaleRead();
  await staleResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await expect(page.getByText('Updated fee', { exact: true })).toBeVisible();
  await expect(page.getByText('Existing fee', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Charge', exact: true })).toBeEnabled();
  expect(reads).toBe(3);
});

test('Charges generate distinct native IDs for non-ASCII names', async ({ page }) => {
  await startMockedSettingsSession(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
  });
  let savedCharges: Array<{ id: string; name: string }> = [];
  await page.route('**/api/settings/charges', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ charges: savedCharges }),
      });
      return;
    }
    savedCharges = route.request().postDataJSON().charges;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ charges: savedCharges }),
    });
  });

  await page.goto(`${BASE}/settings?tab=pos`);
  expect(await page.evaluate(() => typeof globalThis.crypto.randomUUID)).toBe('undefined');
  expect(await page.evaluate(() => typeof globalThis.crypto.getRandomValues)).toBe('function');
  for (const name of ['رسوم', '料金']) {
    await page.getByRole('button', { name: 'Add Charge', exact: true }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Value').fill('5');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
  }

  expect(savedCharges).toHaveLength(2);
  expect(savedCharges[0].id).toMatch(/^charge-[0-9a-f]{32}$/);
  expect(savedCharges[1].id).toMatch(/^charge-[0-9a-f]{32}$/);
  expect(savedCharges[0].id).not.toBe(savedCharges[1].id);
});

async function readPersistedPosKitchenSettings(
  page: Page,
): Promise<{ kdsEnabled?: boolean; kotPrintingEnabled?: boolean }> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as {
      state?: { kdsEnabled?: boolean; kotPrintingEnabled?: boolean };
    };
    return {
      kdsEnabled: parsed.state?.kdsEnabled,
      kotPrintingEnabled: parsed.state?.kotPrintingEnabled,
    };
  });
}

async function switchMockedTenant(page: Page, tenantId: number, tenantName: string): Promise<void> {
  await page.evaluate(
    ({ id, name }) => {
      type FiberHook = {
        memoizedState?: unknown;
        next?: FiberHook | null;
      };
      type FiberNode = {
        memoizedState?: FiberHook | null;
        return?: FiberNode | null;
      };
      const root = document.querySelector('main') || document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node: Node | null = root;
      while (node) {
        const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
        let fiber = fiberKey
          ? ((node as unknown as Record<string, FiberNode | undefined>)[fiberKey] ?? null)
          : null;
        while (fiber) {
          let hook = fiber.memoizedState ?? null;
          while (hook) {
            const candidate = hook.memoizedState;
            const storeState =
              candidate &&
              typeof candidate === 'object' &&
              'value' in candidate &&
              (candidate as { value?: unknown }).value !== undefined
                ? (candidate as { value?: unknown }).value
                : candidate;
            if (
              storeState &&
              typeof storeState === 'object' &&
              'updateCurrentTenant' in storeState &&
              typeof (
                storeState as {
                  updateCurrentTenant?: (tenant: {
                    id: number;
                    name: string;
                    slug: string;
                  }) => void;
                }
              ).updateCurrentTenant === 'function'
            ) {
              (
                storeState as {
                  updateCurrentTenant: (tenant: { id: number; name: string; slug: string }) => void;
                }
              ).updateCurrentTenant({
                id,
                name,
                slug: name.toLowerCase().replace(/\s+/g, '-'),
              });
              return;
            }
            hook = hook.next ?? null;
          }
          fiber = fiber.return ?? null;
        }
        node = walker.nextNode();
      }
      throw new Error('Could not locate auth store in React fiber tree');
    },
    { id: tenantId, name: tenantName },
  );
}

test('Direct KDS tab load hydrates KOT state and shows double-off warning when both are disabled', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  await page.route('**/api/settings/kds_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=kds`);
  const kdsPanel = page.getByRole('tabpanel');
  await expect(
    kdsPanel.getByRole('switch', { name: 'Kitchen Display System', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(
    kdsPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: false,
    });
});

test('Failed kitchen setting saves before initial hydration completes reconcile to persisted values', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let releaseInitialKotHydration!: () => void;
  let signalInitialKotGetStarted!: () => void;
  let releaseInitialHydration!: () => void;
  let signalInitialKdsGetStarted!: () => void;
  let signalInitialDeliveryGetStarted!: () => void;
  let releaseHeldReconcileGet!: () => void;
  let signalHeldReconcileGetStarted!: () => void;
  const initialKotHydrationHeld = new Promise<void>((resolve) => {
    releaseInitialKotHydration = resolve;
  });
  const initialKotGetStarted = new Promise<void>((resolve) => {
    signalInitialKotGetStarted = resolve;
  });
  const initialHydrationHeld = new Promise<void>((resolve) => {
    releaseInitialHydration = resolve;
  });
  const initialKdsGetStarted = new Promise<void>((resolve) => {
    signalInitialKdsGetStarted = resolve;
  });
  const initialDeliveryGetStarted = new Promise<void>((resolve) => {
    signalInitialDeliveryGetStarted = resolve;
  });
  const heldReconcileGet = new Promise<void>((resolve) => {
    releaseHeldReconcileGet = resolve;
  });
  const heldReconcileGetStarted = new Promise<void>((resolve) => {
    signalHeldReconcileGetStarted = resolve;
  });

  let kotGets = 0;
  let kdsGets = 0;
  let deliveryGets = 0;
  let deliveryPuts = 0;
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    kotGets += 1;
    if (kotGets === 1) {
      signalInitialKotGetStarted();
      await initialKotHydrationHeld;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });
  await page.route('**/api/settings/kds_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    kdsGets += 1;
    if (kdsGets <= 2) {
      if (kdsGets === 2) signalInitialKdsGetStarted();
      await initialHydrationHeld;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setting: { value: 'false' } }),
      });
    } catch {
      // Aborted when leaving Printers tab before initial KDS hydration finishes.
    }
  });
  await page.route('**/api/settings/require_kitchen_delivered_before_settlement', async (route) => {
    if (route.request().method() === 'PUT') {
      deliveryPuts += 1;
      if (deliveryPuts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unavailable' }),
        });
        return;
      }
      const value = String(route.request().postDataJSON()?.value);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setting: { value } }),
      });
      return;
    }
    deliveryGets += 1;
    if (deliveryGets === 1) {
      signalInitialDeliveryGetStarted();
      await initialHydrationHeld;
    } else if (deliveryGets === 2) {
      signalHeldReconcileGetStarted();
      await heldReconcileGet;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'true' } }),
    });
  });

  // 1. KOT failed save before initial hydration on Printers tab reconciles to persisted 'false'.
  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  await initialKotGetStarted;
  const printersPanel = page.getByRole('tabpanel');
  const kotSwitch = printersPanel.getByRole('switch', {
    name: 'KOT Ticket Printing',
    exact: true,
  });
  const failedKotPut = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kot_printing_enabled' &&
      res.request().method() === 'PUT' &&
      res.status() === 503,
  );
  await kotSwitch.click();
  await failedKotPut;
  releaseInitialKotHydration();
  await expect(kotSwitch).toHaveAttribute('aria-checked', 'false');

  // 2. KDS and kitchen-delivery failed saves before KDS tab hydration reconcile to persisted values.
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await initialKdsGetStarted;
  await initialDeliveryGetStarted;

  const kdsPanel = page.getByRole('tabpanel');
  const kdsSwitch = kdsPanel.getByRole('switch', { name: 'Kitchen Display System', exact: true });
  const deliverySwitch = kdsPanel.getByRole('switch', {
    name: 'Require kitchen delivery before billing',
    exact: true,
  });

  const failedKdsPut = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT' &&
      res.status() === 503,
  );
  const failedDeliveryPut = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/require_kitchen_delivered_before_settlement' &&
      res.request().method() === 'PUT' &&
      res.status() === 503,
  );

  await kdsSwitch.click();
  await deliverySwitch.click();
  await failedKdsPut;
  await failedDeliveryPut;
  await heldReconcileGetStarted;
  releaseInitialHydration();

  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(deliverySwitch).toHaveAttribute('aria-checked', 'true');
  await expect(
    kdsPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: false,
    });

  // 3. A slow reconciliation GET from the pre-hydration failed PUT does not overwrite a newer user edit.
  const secondDeliveryPut = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/require_kitchen_delivered_before_settlement' &&
      res.request().method() === 'PUT' &&
      res.status() === 200,
  );
  const reconcileGetDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/require_kitchen_delivered_before_settlement' &&
      res.request().method() === 'GET',
  );
  await deliverySwitch.click();
  await secondDeliveryPut;
  releaseHeldReconcileGet();
  await reconcileGetDone;

  await expect(deliverySwitch).toHaveAttribute('aria-checked', 'false');
});

test('Switching from Printers to KDS while KOT save is pending preserves successful save and reconciles failed save', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let persistedKot = 'false';
  let releasePendingPut!: () => void;
  let signalPutStarted!: () => void;
  let releaseKdsTabKotGet!: () => void;
  let signalKdsTabKotGetStarted!: () => void;
  let holdNextPut = false;
  let failNextPut = false;
  let holdNextGet = false;

  let pendingPutHeld = new Promise<void>((resolve) => {
    releasePendingPut = resolve;
  });
  let putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve;
  });
  const kdsTabKotGetHeld = new Promise<void>((resolve) => {
    releaseKdsTabKotGet = resolve;
  });
  const kdsTabKotGetStarted = new Promise<void>((resolve) => {
    signalKdsTabKotGetStarted = resolve;
  });

  await page.route('**/api/settings/kds_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      const requestedValue = route.request().postDataJSON()?.value;
      signalPutStarted();
      if (holdNextPut) {
        await pendingPutHeld;
      }
      if (failNextPut) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unavailable' }),
        });
        return;
      }
      persistedKot = String(requestedValue);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setting: { value: persistedKot } }),
      });
      return;
    }
    const snapshotValue = persistedKot;
    if (holdNextGet) {
      holdNextGet = false;
      signalKdsTabKotGetStarted();
      await kdsTabKotGetHeld;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: snapshotValue } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  const printersPanel = page.getByRole('tabpanel');
  const kotSwitch = printersPanel.getByRole('switch', {
    name: 'KOT Ticket Printing',
    exact: true,
  });
  await expect(kotSwitch).toHaveAttribute('aria-checked', 'false');

  // Part 1: Enable KOT on Printers tab, switch to KDS tab before PUT finishes, and let stale GET return 'false' first.
  holdNextPut = true;
  holdNextGet = true;
  await kotSwitch.click();
  await putStarted;

  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await kdsTabKotGetStarted;
  const staleKotGetDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kot_printing_enabled' &&
      res.request().method() === 'GET',
  );
  releaseKdsTabKotGet();
  await staleKotGetDone;

  const kotPutDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kot_printing_enabled' &&
      res.request().method() === 'PUT',
  );
  releasePendingPut();
  await kotPutDone;

  const kdsPanel = page.getByRole('tabpanel');
  await expect(
    kdsPanel.getByRole('switch', { name: 'Kitchen Display System', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(
    kdsPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toHaveCount(0);
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: true,
    });

  // Part 2: Toggle KOT off on Printers tab while switching back to KDS tab, and fail the PUT.
  await page.getByRole('button', { name: 'Printers', exact: true }).click();
  await expect(kotSwitch).toHaveAttribute('aria-checked', 'true');

  pendingPutHeld = new Promise<void>((resolve) => {
    releasePendingPut = resolve;
  });
  putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve;
  });
  holdNextPut = true;
  failNextPut = true;

  await kotSwitch.click();
  await putStarted;
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  // Optimistically both KDS and KOT are off while PUT is in flight.
  await expect(
    page.getByRole('tabpanel').getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();

  const failedKotPutDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kot_printing_enabled' &&
      res.request().method() === 'PUT' &&
      res.status() === 503,
  );
  releasePendingPut();
  await failedKotPutDone;

  // Failed PUT reconciles KOT back to confirmed 'true', hiding the double-off warning.
  await expect(
    page.getByRole('tabpanel').getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toHaveCount(0);
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: true,
    });
});

test('Rapid repeated kitchen setting changes ignore out-of-order responses and keep POS store in sync', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let persistedKds = 'false';
  const pendingPuts: Array<{ value: string; release: () => void }> = [];

  await page.route('**/api/settings/kds_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      const value = String(route.request().postDataJSON()?.value);
      await new Promise<void>((resolve) => {
        pendingPuts.push({ value, release: resolve });
      });
      persistedKds = value;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setting: { value } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: persistedKds } }),
    });
  });
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=kds`);
  const kdsPanel = page.getByRole('tabpanel');
  const kdsSwitch = kdsPanel.getByRole('switch', { name: 'Kitchen Display System', exact: true });
  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(
    kdsPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();

  // Rapidly toggle ON ('true') then OFF ('false') while both PUTs are in flight.
  await kdsSwitch.click();
  await kdsSwitch.click();
  await expect.poll(() => pendingPuts.length).toBe(2);
  expect(pendingPuts.map((p) => p.value)).toEqual(['true', 'false']);

  // Resolve the second PUT ('false') FIRST, then resolve the first PUT ('true') out of order.
  const secondPutResponse = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT',
  );
  pendingPuts[1].release();
  await secondPutResponse;

  const firstPutResponse = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT',
  );
  pendingPuts[0].release();
  await firstPutResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(
    kdsPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: false,
    });
});

test('Tenant switch while KDS/KOT requests are pending ignores stale tenant responses', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let activeMockTenantId = 1;
  let releaseTenant1KotGet!: () => void;
  let signalTenant1KotGetStarted!: () => void;
  let releaseTenant1KdsPut!: () => void;
  let signalTenant1KdsPutStarted!: () => void;
  const tenant1KotGetHeld = new Promise<void>((resolve) => {
    releaseTenant1KotGet = resolve;
  });
  const tenant1KotGetStarted = new Promise<void>((resolve) => {
    signalTenant1KotGetStarted = resolve;
  });
  const tenant1KdsPutHeld = new Promise<void>((resolve) => {
    releaseTenant1KdsPut = resolve;
  });
  const tenant1KdsPutStarted = new Promise<void>((resolve) => {
    signalTenant1KdsPutStarted = resolve;
  });

  await page.route('**/api/settings/kds_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      signalTenant1KdsPutStarted();
      await tenant1KdsPutHeld;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setting: { value: 'false' } }),
      });
      return;
    }
    const value = activeMockTenantId === 1 ? 'true' : 'true';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value } }),
    });
  });
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    if (activeMockTenantId === 1) {
      signalTenant1KotGetStarted();
      await tenant1KotGetHeld;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ setting: { value: 'false' } }),
        });
      } catch {
        // Aborted when tenant 1 effect cleans up.
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'true' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=kds`);
  await tenant1KotGetStarted;

  const kdsPanel = page.getByRole('tabpanel');
  const kdsSwitch = kdsPanel.getByRole('switch', { name: 'Kitchen Display System', exact: true });
  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'true');

  // Start a PUT turning KDS off under tenant 1 while tenant 1's KOT GET is also still pending.
  await kdsSwitch.click();
  await tenant1KdsPutStarted;
  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'false');

  // Switch to tenant 2 while tenant 1's GET and PUT are both pending.
  activeMockTenantId = 2;
  const tenant2KotGetDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kot_printing_enabled' &&
      res.request().method() === 'GET' &&
      res.status() === 200,
  );
  await switchMockedTenant(page, 2, 'Second Cafe');
  await tenant2KotGetDone;

  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: true,
      kotPrintingEnabled: true,
    });

  // Now release tenant 1's stale GET and PUT and verify neither overwrites tenant 2.
  const stalePutDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT',
  );
  releaseTenant1KotGet();
  releaseTenant1KdsPut();
  await stalePutDone;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(
    kdsPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toHaveCount(0);
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: true,
      kotPrintingEnabled: true,
    });
});

test('Direct Printers tab load hides double-off warning when KDS is enabled and KOT is disabled', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  await page.route('**/api/settings/kds_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'true' } }),
    });
  });
  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  const printersPanel = page.getByRole('tabpanel');
  await expect(
    printersPanel.getByRole('switch', { name: 'KOT Ticket Printing', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(
    printersPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toHaveCount(0);
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: true,
      kotPrintingEnabled: false,
    });
});

test('Switching from KDS to Printers while KDS save is pending preserves successful saves in both directions and reconciles failed save', async ({
  page,
}) => {
  await startMockedSettingsSession(page);
  let persistedKds = 'false';
  let releasePendingPut!: () => void;
  let signalPutStarted!: () => void;
  let releasePrintersTabKdsGet!: () => void;
  let signalPrintersTabKdsGetStarted!: () => void;
  let holdNextPut = false;
  let failNextPut = false;
  let holdNextPrintersGet = false;

  let pendingPutHeld = new Promise<void>((resolve) => {
    releasePendingPut = resolve;
  });
  let putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve;
  });
  let printersTabKdsGetHeld = new Promise<void>((resolve) => {
    releasePrintersTabKdsGet = resolve;
  });
  let printersTabKdsGetStarted = new Promise<void>((resolve) => {
    signalPrintersTabKdsGetStarted = resolve;
  });

  await page.route('**/api/settings/kot_printing_enabled', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: 'false' } }),
    });
  });
  await page.route('**/api/settings/kds_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      const requestedValue = route.request().postDataJSON()?.value;
      signalPutStarted();
      if (holdNextPut) {
        await pendingPutHeld;
      }
      if (failNextPut) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unavailable' }),
        });
        return;
      }
      persistedKds = String(requestedValue);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ setting: { value: persistedKds } }),
      });
      return;
    }
    const snapshotValue = persistedKds;
    if (holdNextPrintersGet) {
      holdNextPrintersGet = false;
      signalPrintersTabKdsGetStarted();
      await printersTabKdsGetHeld;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setting: { value: snapshotValue } }),
    });
  });

  await page.goto(`${BASE}/settings?tab=kds`);
  const kdsSwitch = page
    .getByRole('tabpanel')
    .getByRole('switch', { name: 'Kitchen Display System', exact: true });
  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'false');

  // Part 1: Enable KDS on KDS tab, navigate to unvisited Printers tab before PUT finishes, and let stale GET return 'false' first.
  holdNextPut = true;
  holdNextPrintersGet = true;
  await kdsSwitch.click();
  await putStarted;

  await page.getByRole('button', { name: 'Printers', exact: true }).click();
  await printersTabKdsGetStarted;
  const stalePrintersGetDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'GET',
  );
  releasePrintersTabKdsGet();
  await stalePrintersGetDone;

  const kdsPutDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT',
  );
  releasePendingPut();
  await kdsPutDone;

  const printersPanel = page.getByRole('tabpanel');
  await expect(
    printersPanel.getByRole('switch', { name: 'KOT Ticket Printing', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(
    printersPanel.getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toHaveCount(0);
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: true,
      kotPrintingEnabled: false,
    });

  // Part 2 (reverse transition): Reload on KDS tab with KDS enabled, disable KDS while PUT is pending, navigate to unvisited Printers tab whose GET returns stale 'true' first.
  await page.goto(`${BASE}/settings?tab=kds`);
  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'true');

  pendingPutHeld = new Promise<void>((resolve) => {
    releasePendingPut = resolve;
  });
  putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve;
  });
  printersTabKdsGetHeld = new Promise<void>((resolve) => {
    releasePrintersTabKdsGet = resolve;
  });
  printersTabKdsGetStarted = new Promise<void>((resolve) => {
    signalPrintersTabKdsGetStarted = resolve;
  });
  holdNextPut = true;
  holdNextPrintersGet = true;

  await kdsSwitch.click();
  await putStarted;

  await page.getByRole('button', { name: 'Printers', exact: true }).click();
  await printersTabKdsGetStarted;
  const stalePrintersTrueGetDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'GET',
  );
  releasePrintersTabKdsGet();
  await stalePrintersTrueGetDone;

  const kdsDisablePutDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT',
  );
  releasePendingPut();
  await kdsDisablePutDone;

  await expect(
    page.getByRole('tabpanel').getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: false,
    });

  // Part 3 (failed PUT): Switch back to KDS tab, enable KDS while PUT is held and will fail (503), navigate to Printers tab, and verify failure reconciles back to 'false' and restores the warning.
  await page.getByRole('button', { name: 'Kitchen Display', exact: true }).click();
  await expect(kdsSwitch).toHaveAttribute('aria-checked', 'false');

  pendingPutHeld = new Promise<void>((resolve) => {
    releasePendingPut = resolve;
  });
  putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve;
  });
  holdNextPut = true;
  failNextPut = true;

  await kdsSwitch.click();
  await putStarted;
  await page.getByRole('button', { name: 'Printers', exact: true }).click();
  await expect(
    page.getByRole('tabpanel').getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toHaveCount(0);

  const failedKdsPutDone = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/settings/kds_enabled' &&
      res.request().method() === 'PUT' &&
      res.status() === 503,
  );
  releasePendingPut();
  await failedKdsPutDone;

  await expect(
    page.getByRole('tabpanel').getByText(/Both the Kitchen Display and KOT printing are off/i),
  ).toBeVisible();
  await expect
    .poll(() => readPersistedPosKitchenSettings(page))
    .toEqual({
      kdsEnabled: false,
      kotPrintingEnabled: false,
    });
});
