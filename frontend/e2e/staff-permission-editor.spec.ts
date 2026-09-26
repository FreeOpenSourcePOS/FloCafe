import { test, expect, type Page, type Route } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

// Minimal permission catalog covering two areas — enough to exercise grouping,
// the configurable vs. protected row rendering, and the role/user override flow
// without depending on the full shared/permissions.ts registry staying in sync.
const CATALOG = [
  { id: 'orders.read', area: 'orders', defaultRoles: ['owner', 'manager', 'cashier', 'server'], configurable: true, risk: 'standard' },
  { id: 'orders.item.void', area: 'orders', defaultRoles: ['owner', 'manager', 'server'], configurable: true, risk: 'sensitive' },
  { id: 'staff.privileged.manage', area: 'staff', defaultRoles: ['owner'], configurable: false, risk: 'sensitive' },
];

const ROLES = ['owner', 'manager', 'cashier', 'server', 'chef'];

const STAFF_MEMBER = { id: 'e2e-server-1', name: 'Sam Server', email: 'sam@flo.local', role: 'server', has_pin: false, is_active: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

function permissionsFor(overrides: Record<string, 'allow' | 'deny'>, defaultAllowRoles: (id: string) => boolean) {
  return CATALOG.map(({ id }) => {
    if (id in overrides) return { permission_id: id, allowed: overrides[id] === 'allow', source: 'role_override' as const };
    return { permission_id: id, allowed: defaultAllowRoles(id), source: 'shipped_default' as const };
  });
}

function managerRolePayload(overrides: Record<string, 'allow' | 'deny'> = {}) {
  return {
    role: 'manager',
    revision: 'rev-manager-1',
    overrides: Object.entries(overrides).map(([permission_id, effect]) => ({ permission_id, effect })),
    permissions: permissionsFor(overrides, (id) => id !== 'staff.privileged.manage'),
  };
}

function serverUserPayload(overrides: Record<string, 'allow' | 'deny'> = {}) {
  return {
    user: STAFF_MEMBER,
    revision: 'rev-user-sam-1',
    overrides: Object.entries(overrides).map(([permission_id, effect]) => ({ permission_id, effect })),
    permissions: permissionsFor(overrides, (id) => id === 'orders.read'),
  };
}

async function startOwnerSession(page: Page): Promise<{ putRequests: Array<{ url: string; body: unknown }> }> {
  const putRequests: Array<{ url: string; body: unknown }> = [];

  await page.addInitScript(() => {
    localStorage.setItem('token', 'staff-permission-editor-token');
  });

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

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

    if (path === '/api/authorization/users' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [STAFF_MEMBER] }) });
      return;
    }

    if (path === '/api/authorization/catalog') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ permissions: CATALOG, roles: ROLES }) });
      return;
    }

    if (path === '/api/authorization/roles' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ roles: ROLES.map((role) => (role === 'manager' ? managerRolePayload() : { ...managerRolePayload(), role })) }),
      });
      return;
    }

    if (path === '/api/authorization/roles/manager' && method === 'PUT') {
      const body = request.postDataJSON();
      putRequests.push({ url: path, body });
      const overrides: Record<string, 'allow' | 'deny'> = {};
      for (const entry of body.overrides || []) overrides[entry.permission_id] = entry.effect;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ role: managerRolePayload(overrides) }) });
      return;
    }

    if (path === `/api/authorization/users/${STAFF_MEMBER.id}` && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(serverUserPayload()) });
      return;
    }

    if (path === `/api/authorization/users/${STAFF_MEMBER.id}` && method === 'PUT') {
      const body = request.postDataJSON();
      putRequests.push({ url: path, body });
      const overrides: Record<string, 'allow' | 'deny'> = {};
      for (const entry of body.overrides || []) overrides[entry.permission_id] = entry.effect;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(serverUserPayload(overrides)) });
      return;
    }

    if (path === '/api/authorization/audit' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          audit: [
            {
              id: 1,
              batch_id: 'batch-1',
              actor_user_id: 'e2e-owner',
              actor_name: 'E2E Owner',
              target_type: 'user',
              target_id: STAFF_MEMBER.id,
              permission_id: 'orders.read',
              previous_effect: null,
              next_effect: 'allow',
              created_at: '2026-01-02T10:00:00Z',
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
  await page.getByRole('link', { name: 'Staff', exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/?$/);

  return { putRequests };
}

test('owner can override a role permission and see it saved', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page);

  await expect(page.getByRole('heading', { name: 'Role permissions', exact: true })).toBeVisible();

  const voidRow = page.locator('tr', { hasText: 'orders · item · void' });
  await expect(voidRow).toBeVisible();
  await expect(voidRow.getByText('Allowed', { exact: true })).toBeVisible();

  await voidRow.locator('select').selectOption('deny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => putRequests.length).toBeGreaterThan(0);
  const [{ url, body }] = putRequests;
  expect(url).toBe('/api/authorization/roles/manager');
  expect(body).toMatchObject({ revision: 'rev-manager-1', overrides: [{ permission_id: 'orders.item.void', effect: 'deny' }] });

  await expect(page.getByText('Done', { exact: true })).toBeVisible();
  await expect(voidRow.getByText('Not allowed', { exact: true })).toBeVisible();

  // Protected permissions never expose an override control.
  const protectedRow = page.locator('tr', { hasText: 'staff · privileged · manage' });
  await expect(protectedRow.getByText('Protected', { exact: true })).toBeVisible();
  await expect(protectedRow.locator('select')).toHaveCount(0);
});

test('owner can grant a staff-specific permission exception', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page);

  await page.getByRole('button', { name: 'Staff exception', exact: true }).click();
  await page.locator('select').filter({ hasText: 'Select a staff member' }).selectOption(STAFF_MEMBER.id);

  const voidRow = page.locator('tr', { hasText: 'orders · item · void' });
  await expect(voidRow).toBeVisible();
  await expect(voidRow.getByText('Not allowed', { exact: true })).toBeVisible();

  await voidRow.locator('select').selectOption('allow');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => putRequests.length).toBeGreaterThan(0);
  const [{ url, body }] = putRequests;
  expect(url).toBe(`/api/authorization/users/${STAFF_MEMBER.id}`);
  expect(body).toMatchObject({ revision: 'rev-user-sam-1', overrides: [{ permission_id: 'orders.item.void', effect: 'allow' }] });

  await expect(voidRow.getByText('Allowed', { exact: true })).toBeVisible();
});

test('permission change history lists prior overrides', async ({ page }) => {
  await startOwnerSession(page);

  await expect(page.getByRole('heading', { name: 'Permission change history', exact: true })).toBeVisible();
  const historyRow = page.locator('tr', { hasText: 'E2E Owner' });
  await expect(historyRow).toBeVisible();
  await expect(historyRow.getByText('Staff · Sam Server', { exact: true })).toBeVisible();
  await expect(historyRow.getByText('Inherit', { exact: true })).toBeVisible();
  await expect(historyRow.getByText('Allow', { exact: true })).toBeVisible();
});
