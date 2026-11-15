import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

interface MockCloudSessionOptions {
  role?: 'owner' | 'manager';
  cloudAccount?: Record<string, unknown>;
  cloudStatus?: Record<string, unknown>;
}

async function startMockedSession(
  page: Page,
  options: MockCloudSessionOptions = {},
): Promise<void> {
  const role = options.role ?? 'owner';
  let currentAccount = options.cloudAccount ?? {
    cloud_account_available: false,
    email: null,
    verified: false,
  };
  let currentCloud = options.cloudStatus ?? {
    cloud_registration_status: 'unregistered',
    cloud_deletion_status: '',
  };

  await page.addInitScript(() => {
    localStorage.setItem('token', 'settings-subnav-attention-token');
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: `e2e-${role}`,
            name: `E2E ${role}`,
            email: `${role}@flo.local`,
            role,
            category_ids: [],
          },
          tenants: [
            {
              id: 1,
              business_name: 'E2E Cafe',
              role,
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
    if (path === '/api/settings/cloud/account') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentAccount),
      });
      return;
    }
    if (path === '/api/settings/cloud') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentCloud),
      });
      return;
    }
    if (path === '/api/settings/cloud/account/verification') {
      currentAccount = {
        ...currentAccount,
        verified: true,
        verified_at: '2026-11-15T12:00:00Z',
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentAccount),
      });
      return;
    }
    if (path === '/api/settings/cloud/delete-data/status') {
      currentCloud = {
        cloud_registration_status: 'deleted',
        cloud_deletion_status: 'deleted',
      };
      currentAccount = {
        cloud_account_available: false,
        email: null,
        verified: false,
        deletion_request: { id: 'deletion-1', status: 'deleted' },
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cloud_account_available: false,
          deletion_request: { id: 'deletion-1', status: 'deleted' },
        }),
      });
      return;
    }
    if (path === '/api/settings/diagnostics-prompt') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: false,
          dismissed: true,
          prompt_count: 0,
          last_asked_at: null,
          problems_since: 0,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20_000 });
}

test('unverified cloud email shows attention in sidebar and Account subnav immediately without hydrating inactive tabs', async ({
  page,
}) => {
  await startMockedSession(page, {
    cloudAccount: {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: false,
    },
    cloudStatus: {
      cloud_registration_status: 'registered',
      cloud_deletion_status: '',
    },
  });

  const sidebarDot = page.getByTestId('sidebar-settings-attention');
  const settingsLink = page.getByRole('link', { name: 'Settings', exact: true });
  await expect(sidebarDot).toBeVisible();
  await expect(settingsLink).toHaveAccessibleDescription('Action required');

  const settingsRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) settingsRequests.push(path);
  });

  await settingsLink.click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();

  // Immediately visible on Account sub-nav while Store Details is active
  await expect(page.getByTestId('settings-nav-attention-account')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Account', exact: true }),
  ).toHaveAccessibleDescription('Action required');
  await expect(page.getByTestId('settings-nav-attention-privacy')).toHaveCount(0);

  // Lazy tabs remain unhydrated when opening Settings on Store Details
  await page.waitForTimeout(300);
  expect(settingsRequests).not.toContain('/api/settings/printing');
  expect(settingsRequests).not.toContain('/api/printers');
  expect(settingsRequests).not.toContain('/api/db-tools/backups');
  expect(settingsRequests).not.toContain('/api/settings/google-drive');
  expect(settingsRequests).not.toContain('/api/settings/cloud');
  expect(settingsRequests).not.toContain('/api/settings/cloud/account');

  // Resolving verification clears both the subnav badge and sidebar dot
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page).toHaveURL(/tab=account/);
  await page.getByRole('button', { name: /Send verification email/i }).click();
  await expect(page.getByTestId('settings-nav-attention-account')).toHaveCount(0);
  await expect(sidebarDot).toHaveCount(0);
});

test('actionable cloud deletion status shows attention in sidebar and Privacy subnav immediately before visiting Privacy', async ({
  page,
}) => {
  await startMockedSession(page, {
    cloudAccount: {
      cloud_account_available: false,
      email: null,
      verified: false,
      deletion_request: { id: 'deletion-1', status: 'pending' },
    },
    cloudStatus: {
      cloud_registration_status: 'deletion_pending',
      cloud_deletion_status: 'pending',
    },
  });

  const sidebarDot = page.getByTestId('sidebar-settings-attention');
  await expect(sidebarDot).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();

  await expect(page.getByTestId('settings-nav-attention-privacy')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Privacy', exact: true }),
  ).toHaveAccessibleDescription('Action required');
  await expect(page.getByTestId('settings-nav-attention-account')).toHaveCount(0);

  // Refreshing deletion status to terminal 'deleted' clears both indicators
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/tab=privacy/);
  await page.getByRole('button', { name: /Refresh deletion status/i }).click();
  await expect(page.getByTestId('settings-nav-attention-privacy')).toHaveCount(0);
  await expect(sidebarDot).toHaveCount(0);
});

test('verified email and clean deletion state show no attention indicators', async ({ page }) => {
  await startMockedSession(page, {
    cloudAccount: {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: true,
    },
    cloudStatus: {
      cloud_registration_status: 'registered',
      cloud_deletion_status: '',
    },
  });

  await expect(page.getByTestId('sidebar-settings-attention')).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await expect(page.getByTestId('settings-nav-attention-account')).toHaveCount(0);
  await expect(page.getByTestId('settings-nav-attention-privacy')).toHaveCount(0);
});

test('mobile horizontal Settings subnav displays attention badge cleanly without squishing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startMockedSession(page, {
    cloudAccount: {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: false,
    },
    cloudStatus: {
      cloud_registration_status: 'registered',
      cloud_deletion_status: '',
    },
  });

  await page.goto(`${BASE}/settings`);
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();

  const accountBadge = page.getByTestId('settings-nav-attention-account');
  await accountBadge.scrollIntoViewIfNeeded();
  await expect(accountBadge).toBeVisible();

  const accountButton = page.getByRole('button', { name: 'Account', exact: true });
  const btnBox = await accountButton.boundingBox();
  const badgeBox = await accountBadge.boundingBox();
  expect(btnBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(btnBox!.width).toBeGreaterThanOrEqual(70);
  expect(badgeBox!.width).toBeGreaterThanOrEqual(14);
  expect(badgeBox!.height).toBeGreaterThanOrEqual(14);
});

test('failed deletion status without deletion_request still flags Privacy subnav immediately', async ({
  page,
}) => {
  await startMockedSession(page, {
    cloudAccount: {
      cloud_account_available: false,
      email: null,
      verified: false,
      deletion_request: null,
    },
    cloudStatus: {
      cloud_registration_status: 'deletion_failed',
      cloud_deletion_status: 'failed',
    },
  });

  await expect(page.getByTestId('sidebar-settings-attention')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();

  await expect(page.getByTestId('settings-nav-attention-privacy')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Privacy', exact: true }),
  ).toHaveAccessibleDescription('Action required');
});

test('non-owner manager lacking cloud.account.manage shows no attention indicators', async ({
  page,
}) => {
  await startMockedSession(page, {
    role: 'manager',
    cloudAccount: {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: false,
    },
    cloudStatus: {
      cloud_registration_status: 'deletion_pending',
      cloud_deletion_status: 'pending',
    },
  });

  await expect(page.getByTestId('sidebar-settings-attention')).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();
  await expect(page.getByTestId('settings-nav-attention-account')).toHaveCount(0);
  await expect(page.getByTestId('settings-nav-attention-privacy')).toHaveCount(0);
});

test('stale Account hydration resolving after verification does not restore attention badges', async ({
  page,
}) => {
  await startMockedSession(page, {
    cloudAccount: {
      cloud_account_available: true,
      email: 'owner@flo.local',
      verified: false,
    },
    cloudStatus: {
      cloud_registration_status: 'registered',
      cloud_deletion_status: '',
    },
  });

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();

  let releaseStaleHydration!: () => void;
  const staleHydrationGate = new Promise<void>((resolve) => {
    releaseStaleHydration = resolve;
  });
  let accountGetCount = 0;

  await page.route('**/api/settings/cloud/account', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    accountGetCount += 1;
    if (accountGetCount === 1) {
      await staleHydrationGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cloud_account_available: true,
          email: 'owner@flo.local',
          verified: false,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cloud_account_available: true,
        email: 'owner@flo.local',
        verified: true,
      }),
    });
  });

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page).toHaveURL(/tab=account/);

  await page.getByRole('button', { name: /Send verification email/i }).click();
  await expect(page.getByTestId('settings-nav-attention-account')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-settings-attention')).toHaveCount(0);

  releaseStaleHydration();
  await page.waitForTimeout(250);
  await expect(page.getByTestId('settings-nav-attention-account')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-settings-attention')).toHaveCount(0);
});
