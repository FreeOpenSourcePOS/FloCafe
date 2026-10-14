import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

const RUN = Date.now().toString(36);

type StaffRole = 'server' | 'cashier';
type Account = { id: string; email: string; role: StaffRole };
type UserAuthorizationPayload = {
  revision: string;
  overrides: Array<{ permission_id: string; effect: 'allow' | 'deny' }>;
  permissions: Array<{ permission_id: string; allowed: boolean; source: string }>;
};

function ownerHeaders() {
  return {
    Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  };
}

async function createAccount(
  request: APIRequestContext,
  role: StaffRole,
  tag: string,
): Promise<Account> {
  const email = `auth-guard-${tag}-${RUN}@flo.local`;
  const res = await request.post(`${E2E_BASE_URL}/api/staff`, {
    headers: ownerHeaders(),
    data: { name: `AuthGuard ${tag}`, email, password: E2E_PASSWORD, role },
  });
  expect(
    res.status(),
    `creating ${role} account must succeed (got ${res.status()} ${await res.text()})`,
  ).toBe(201);
  const { staff } = (await res.json()) as { staff: Account };
  return staff;
}

async function setUserPermissionOverrides(
  request: APIRequestContext,
  userId: string,
  overrides: Array<{ permission_id: string; effect: 'allow' | 'deny' }>,
): Promise<void> {
  const currentRes = await request.get(`${E2E_BASE_URL}/api/authorization/users/${userId}`, {
    headers: ownerHeaders(),
  });
  expect(currentRes.ok()).toBeTruthy();
  const current = (await currentRes.json()) as UserAuthorizationPayload;

  const updateRes = await request.put(`${E2E_BASE_URL}/api/authorization/users/${userId}`, {
    headers: ownerHeaders(),
    data: {
      revision: current.revision,
      overrides,
    },
  });
  expect(
    updateRes.ok(),
    `updating overrides for ${userId} must succeed (got ${updateRes.status()} ${await updateRes.text()})`,
  ).toBeTruthy();
}

async function loginForToken(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
    data: { email, password: E2E_PASSWORD },
  });
  expect(res.ok(), `login for ${email} must succeed (got ${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function signInThroughUi(page: Page, email: string): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
  });
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 20_000 });
}

test.describe('AuthGuard route normalization and permission gates (#1078)', () => {
  const createdAccounts: Account[] = [];
  let restrictedServer: Account;
  let restrictedCashier: Account;

  test.beforeAll(async ({ request }) => {
    restrictedServer = await createAccount(request, 'server', 'server');
    createdAccounts.push(restrictedServer);
    // Deny settings.view so this server account holds neither staff nor settings permissions,
    // and its permitted landing page is /orders (via orders.read).
    await setUserPermissionOverrides(request, restrictedServer.id, [
      { permission_id: 'settings.view', effect: 'deny' },
    ]);

    restrictedCashier = await createAccount(request, 'cashier', 'cashier');
    createdAccounts.push(restrictedCashier);
    // Deny settings.view so this cashier account also holds neither staff nor settings permissions,
    // while its permitted landing page is /pos (via pos.use).
    await setUserPermissionOverrides(request, restrictedCashier.id, [
      { permission_id: 'settings.view', effect: 'deny' },
    ]);
  });

  test.afterAll(async ({ request }) => {
    for (const account of createdAccounts) {
      await setUserPermissionOverrides(request, account.id, []).catch(() => {});
      await request
        .post(`${E2E_BASE_URL}/api/staff/${account.id}/deactivate`, {
          headers: ownerHeaders(),
        })
        .catch(() => {});
    }
  });

  test('redirects a user without staff or settings permissions from /staff// and /settings/// to their permitted landing page', async ({
    page,
  }) => {
    await setLanguage(page, 'en');

    // 1. Server without staff or settings permissions -> permitted landing page is /orders.
    await signInThroughUi(page, restrictedServer.email);
    await expect(page).toHaveURL(/\/orders\/?$/);

    for (const staffPath of ['/staff', '/staff/', '/staff//', '/staff///']) {
      await page.goto(`${E2E_BASE_URL}${staffPath}`);
      await expect(page).toHaveURL(/\/orders\/?$/, { timeout: 15_000 });
      await expect(
        page.getByRole('heading', { name: 'Role permissions', exact: true }),
      ).toHaveCount(0);
    }

    for (const settingsPath of ['/settings', '/settings/', '/settings//', '/settings///']) {
      await page.goto(`${E2E_BASE_URL}${settingsPath}`);
      await expect(page).toHaveURL(/\/orders\/?$/, { timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'POS Workflow', exact: true })).toHaveCount(0);
    }

    // 2. Cashier without staff or settings permissions -> permitted landing page is /pos.
    await signInThroughUi(page, restrictedCashier.email);
    await expect(page).toHaveURL(/\/pos\/?$/);

    await page.goto(`${E2E_BASE_URL}/staff//`);
    await expect(page).toHaveURL(/\/pos\/?$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Role permissions', exact: true })).toHaveCount(
      0,
    );

    await page.goto(`${E2E_BASE_URL}/settings///`);
    await expect(page).toHaveURL(/\/pos\/?$/, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'POS Workflow', exact: true })).toHaveCount(0);
  });

  test('allows authorized users to access /staff and /settings across standard, single-slash, and multi-slash paths, and preserves root / routing', async ({
    page,
  }) => {
    await setLanguage(page, 'en');
    await signInThroughUi(page, 'owner@flo.local');
    await expect(page).toHaveURL(/\/pos\/?$/);

    for (const staffPath of ['/staff', '/staff/', '/staff//']) {
      await page.goto(`${E2E_BASE_URL}${staffPath}`);
      await expect(
        page.getByRole('heading', { name: 'Role permissions', exact: true }),
      ).toBeVisible({ timeout: 20_000 });
    }

    for (const settingsPath of ['/settings', '/settings/', '/settings///']) {
      await page.goto(`${E2E_BASE_URL}${settingsPath}`);
      await expect(page.getByRole('button', { name: 'POS Workflow', exact: true })).toBeVisible({
        timeout: 20_000,
      });
    }

    // Root "/" redirects to /dashboard; owner has dashboard.view so remains on /dashboard.
    await page.goto(`${E2E_BASE_URL}/`);
    await expect(page).toHaveURL(/\/dashboard\/?$/, { timeout: 15_000 });

    // For a user without dashboard.view (restrictedServer), root "/" redirects through /dashboard to /orders.
    await signInThroughUi(page, restrictedServer.email);
    await page.goto(`${E2E_BASE_URL}/`);
    await expect(page).toHaveURL(/\/orders\/?$/, { timeout: 15_000 });
  });

  test('enforces backend API permissions authoritatively for unauthorized staff and settings requests', async ({
    request,
  }) => {
    const serverToken = await loginForToken(request, restrictedServer.email);
    const serverHeaders = { Authorization: `Bearer ${serverToken}` };

    const staffRead = await request.get(`${E2E_BASE_URL}/api/staff`, { headers: serverHeaders });
    expect(staffRead.status()).toBe(403);
    expect((await staffRead.json()).permission).toBe('staff.view');

    const staffCreate = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: serverHeaders,
      data: {
        name: 'Unauthorized Create',
        email: `unauth-${RUN}@flo.local`,
        password: E2E_PASSWORD,
        role: 'cashier',
      },
    });
    expect(staffCreate.status()).toBe(403);

    const settingsRead = await request.get(`${E2E_BASE_URL}/api/settings/business`, {
      headers: serverHeaders,
    });
    expect(settingsRead.status()).toBe(403);
    expect((await settingsRead.json()).permission).toBe('settings.view');

    const settingsWrite = await request.put(`${E2E_BASE_URL}/api/settings/business`, {
      headers: serverHeaders,
      data: { business_name: 'Unauthorized Rename' },
    });
    expect(settingsWrite.status()).toBe(403);
    expect((await settingsWrite.json()).permission).toBe('settings.manage');
  });
});
