/** Tests role and user permission overrides, persistence, audit, and revision checks. */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

type Override = { permission_id: string; effect: string };
type RolePayload = { role: string; revision: string; overrides: Override[]; permissions: Array<{ permission_id: string; allowed: boolean; source: string }> };
type UserPayload = RolePayload & { user: { id: string; role: string } };

async function api<T>(page: Page, path: string, init?: { method?: string; data?: unknown }): Promise<T> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const method = init?.method ?? 'GET';
  const res = await page.request.fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data: init?.data as never,
  });
  expect(res.ok(), `${method} ${path} must succeed (got ${res.status()})`).toBeTruthy();
  return await res.json() as T;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function openStaff(page: Page): Promise<void> {
  await page.goto(`${BASE}/staff`);
  await expect(page.getByRole('heading', { name: 'Role permissions', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

/** Scope everything to the matrix; the staff page has its own Save buttons. */
const matrix = (page: Page) => page.locator('section[aria-labelledby="permission-matrix-title"]');

/** The matrix renders one row per permission, keyed by the permission id code. */
function permissionRow(page: Page, permissionId: string): Locator {
  return matrix(page).locator('tr').filter({ has: page.locator(`code:text-is("${permissionId}")`) });
}

const overrideSelect = (page: Page, permissionId: string) =>
  permissionRow(page, permissionId).locator('select');

/**
 * The role picker and the staff picker swap in the same slot. Identify them by
 * an option only one of them can contain rather than by DOM position.
 */
const roleSelect = (page: Page) =>
  matrix(page).locator('select').filter({ has: page.locator('option[value="chef"]') }).first();
const staffSelect = (page: Page) =>
  matrix(page).locator('select').filter({ has: page.locator('option[value="e2e-server"]') }).first();
const saveMatrix = (page: Page) => matrix(page).getByRole('button', { name: 'Save', exact: true });
test.describe('@ci-tier2 Staff > Role permissions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setLanguage(page, 'en');
  });

  test('a role-default override persists across a reload and reverts to inherit', async ({ page }) => {
    await openStaff(page);

    const ROLE = 'cashier';
    const PERMISSION = 'orders.read';
    const before = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
      .find((entry) => entry.role === ROLE) as RolePayload;
    const hadOverride = before.overrides.some((entry) => entry.permission_id === PERMISSION);
    expect(hadOverride, 'fixture must start with no override on the permission under test').toBe(false);

    await roleSelect(page).selectOption(ROLE);
    await expect(overrideSelect(page, PERMISSION)).toHaveValue('inherit');

    try {
      await overrideSelect(page, PERMISSION).selectOption('deny');
      await saveMatrix(page).click();
      await expect.poll(async () => {
        const roles = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles;
        return roles.find((entry) => entry.role === ROLE)?.overrides
          .find((entry) => entry.permission_id === PERMISSION)?.effect ?? 'inherit';
      }, { timeout: 20_000 }).toBe('deny');

      // Reload the whole page: the matrix must rehydrate the override, not
      // fall back to the shipped default.
      await openStaff(page);
      await roleSelect(page).selectOption(ROLE);
      await expect(overrideSelect(page, PERMISSION)).toHaveValue('deny');
      await expect(permissionRow(page, PERMISSION)).toContainText('Not allowed');

      // The effective column follows the override, and the source says so.
      const after = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
        .find((entry) => entry.role === ROLE) as RolePayload;
      const effective = after.permissions.find((entry) => entry.permission_id === PERMISSION);
      expect(effective?.allowed).toBe(false);
      expect(effective?.source).toBe('role_override');
    } finally {
      const current = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
        .find((entry) => entry.role === ROLE) as RolePayload;
      await api(page, `/authorization/roles/${ROLE}`, {
        method: 'PUT',
        data: {
          revision: current.revision,
          overrides: current.overrides.filter((entry) => entry.permission_id !== PERMISSION),
        },
      });
      await openStaff(page);
      await roleSelect(page).selectOption(ROLE);
      await expect(overrideSelect(page, PERMISSION)).toHaveValue('inherit');
    }
  });

  test('a per-staff exception overrides the role default and is independently removable', async ({ page }) => {
    await openStaff(page);

    const ROLE = 'server';
    const USER = 'e2e-server';
    const PERMISSION = 'reports.view';

    const roleBefore = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
      .find((entry) => entry.role === ROLE) as RolePayload;
    const userBefore = await api<UserPayload>(page, `/authorization/users/${USER}`);
    expect(userBefore.user.role).toBe(ROLE);

    try {
      await api(page, `/authorization/users/${USER}`, {
        method: 'PUT',
        data: {
          revision: userBefore.revision,
          overrides: userBefore.overrides.filter((entry) => entry.permission_id !== PERMISSION),
        },
      });
      await api<{ role: RolePayload }>(page, `/authorization/roles/${ROLE}`, {
        method: 'PUT',
        data: {
          revision: roleBefore.revision,
          overrides: [
            ...roleBefore.overrides.filter((entry) => entry.permission_id !== PERMISSION),
            { permission_id: PERMISSION, effect: 'deny' },
          ],
        },
      });

      await openStaff(page);
      await matrix(page).getByRole('button', { name: 'Staff exception', exact: true }).click();
      await staffSelect(page).selectOption(USER);
      await expect(overrideSelect(page, PERMISSION)).toHaveValue('inherit');

      await overrideSelect(page, PERMISSION).selectOption('allow');
      await saveMatrix(page).click();

      await expect.poll(async () => {
        const after = await api<UserPayload>(page, `/authorization/users/${USER}`);
        return after.overrides.find((entry) => entry.permission_id === PERMISSION)?.effect ?? 'inherit';
      }, { timeout: 20_000 }).toBe('allow');
      const allowed = (await api<UserPayload>(page, `/authorization/users/${USER}`))
        .permissions.find((entry) => entry.permission_id === PERMISSION);
      expect(allowed?.allowed).toBe(true);
      expect(allowed?.source).toBe('user_override');

      await openStaff(page);
      await matrix(page).getByRole('button', { name: 'Staff exception', exact: true }).click();
      await staffSelect(page).selectOption(USER);
      await expect(overrideSelect(page, PERMISSION)).toHaveValue('allow');

      await overrideSelect(page, PERMISSION).selectOption('inherit');
      await expect(overrideSelect(page, PERMISSION)).toHaveValue('inherit');
      await saveMatrix(page).click();

      await expect.poll(async () => {
        const after = await api<UserPayload>(page, `/authorization/users/${USER}`);
        return after.overrides.find((entry) => entry.permission_id === PERMISSION)?.effect ?? 'inherit';
      }, { timeout: 20_000 }).toBe('inherit');
      const inherited = (await api<UserPayload>(page, `/authorization/users/${USER}`))
        .permissions.find((entry) => entry.permission_id === PERMISSION);
      expect(inherited?.allowed).toBe(false);
      expect(inherited?.source).toBe('role_override');
    } finally {
      try {
        const currentUser = await api<UserPayload>(page, `/authorization/users/${USER}`);
        await api(page, `/authorization/users/${USER}`, {
          method: 'PUT',
          data: { revision: currentUser.revision, overrides: userBefore.overrides },
        });
      } finally {
        const currentRole = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
          .find((entry) => entry.role === ROLE) as RolePayload;
        await api(page, `/authorization/roles/${ROLE}`, {
          method: 'PUT',
          data: { revision: currentRole.revision, overrides: roleBefore.overrides },
        });
      }
    }
  });

  test('a stale revision is refused instead of overwriting the newer permission set', async ({ page }) => {
    const ROLE = 'chef';
    const stale = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
      .find((entry) => entry.role === ROLE) as RolePayload;

    const refused = await page.request.put(`${BASE}/api/authorization/roles/${ROLE}`, {
      headers: {
        Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('token'))}`,
        'Content-Type': 'application/json',
      },
      data: { revision: 'rev-does-not-exist', overrides: [] },
    });

    expect(refused.status()).toBe(409);
    const body = await refused.json() as { code?: string; error?: string };
    expect(body.code).toBe('revision_conflict');
    expect(body.error).toMatch(/another session/i);

    // A refused write must leave the stored revision untouched.
    const after = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
      .find((entry) => entry.role === ROLE) as RolePayload;
    expect(after.revision).toBe(stale.revision);
    expect(after.overrides).toEqual(stale.overrides);
  });

  test('protected permissions render as protected and offer no override control', async ({ page }) => {
    await openStaff(page);
    await roleSelect(page).selectOption('owner');

    // authorization.manage is configurable:false in shared/permissions.ts, so it
    // must not offer an inherit/allow/deny select.
    const row = permissionRow(page, 'authorization.manage');
    await expect(row).toBeVisible();
    await expect(row.locator('select')).toHaveCount(0);
    await expect(row).toContainText('Protected');

    // A configurable permission on the same tab does offer one, so the assertion
    // above is about configurability and not about the row failing to render.
    await expect(permissionRow(page, 'settings.manage').locator('select')).toHaveCount(1);
  });

  test('accepted permission changes are recorded in the audit log', async ({ page }) => {
    const ROLE = 'manager';
    const PERMISSION = 'orders.read';
    const original = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
      .find((entry) => entry.role === ROLE) as RolePayload;
    const alreadyOverridden = original.overrides.some((entry) => entry.permission_id === PERMISSION);

    const auditHasNewEntry = async (maxIdBefore: number) => {
      const after = await api<{ audit: Array<{ id: number; target_type: string; target_id: string; permission_id: string }> }>(
        page, '/authorization/audit?limit=200',
      );
      return after.audit.some((entry) =>
        entry.id > maxIdBefore
        && entry.target_type === 'role'
        && entry.target_id === ROLE
        && entry.permission_id === PERMISSION);
    };
    const auditBefore = (await api<{ audit: Array<{ id: number }> }>(
      page, '/authorization/audit?limit=200',
    )).audit;
    const maxIdBefore = Math.max(0, ...auditBefore.map((entry) => entry.id));

    try {
      // Toggle the override in whichever direction makes a real change, so the
      // writer has something to record.
      await api<{ role: RolePayload }>(page, `/authorization/roles/${ROLE}`, {
        method: 'PUT',
        data: {
          revision: original.revision,
          overrides: alreadyOverridden
            ? original.overrides.filter((entry) => entry.permission_id !== PERMISSION)
            : [...original.overrides, { permission_id: PERMISSION, effect: 'deny' }],
        },
      });

      // The write returned a fresh payload, proving the API accepted it.
      const after = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
        .find((entry) => entry.role === ROLE) as RolePayload;
      expect(after.overrides.some((entry) => entry.permission_id === PERMISSION)).toBe(!alreadyOverridden);

      await expect.poll(() => auditHasNewEntry(maxIdBefore), { timeout: 20_000 }).toBe(true);
    } finally {
      const current = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
        .find((entry) => entry.role === ROLE) as RolePayload;
      await api(page, `/authorization/roles/${ROLE}`, {
        method: 'PUT',
        data: { revision: current.revision, overrides: original.overrides },
      });
      const restored = (await api<{ roles: RolePayload[] }>(page, '/authorization/roles')).roles
        .find((entry) => entry.role === ROLE) as RolePayload;
      expect(restored.overrides).toEqual(original.overrides);
    }
  });
});
