import { test, expect, type Page, type Route } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';

// The copy the matrix renders is asserted from the real en.json catalog, so a
// renamed or dropped message key fails here instead of passing against a
// hand-copied string.
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'i18n', 'messages', 'en.json'), 'utf8')) as {
  common: Record<string, string>;
  permissionMatrix: Record<string, string>;
};

// Minimal permission catalog covering two areas — enough to exercise grouping,
// the configurable vs. protected row rendering, and the role/user override flow
// without depending on the full shared/permissions.ts registry staying in sync.
const CATALOG = [
  { id: 'orders.read', area: 'orders', defaultRoles: ['owner', 'manager', 'cashier', 'server'], configurable: true, risk: 'standard' },
  { id: 'orders.item.void', area: 'orders', defaultRoles: ['owner', 'manager', 'server'], configurable: true, risk: 'sensitive' },
  { id: 'staff.operational.manage', area: 'staff', defaultRoles: ['owner', 'manager'], configurable: true, risk: 'sensitive' },
  { id: 'staff.privileged.manage', area: 'staff', defaultRoles: ['owner'], configurable: false, risk: 'sensitive' },
  { id: 'authorization.manage', area: 'authorization', defaultRoles: ['owner'], configurable: false, risk: 'sensitive' },
  { id: 'settings.manage', area: 'settings', defaultRoles: ['owner', 'manager'], configurable: true, risk: 'sensitive' },
];

const ROLES = ['owner', 'manager', 'cashier', 'server', 'chef'];

const STAFF_MEMBER = { id: 'e2e-server-1', name: 'Sam Server', email: 'sam@flo.local', role: 'server', has_pin: false, is_active: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const OWNER = { id: 'e2e-owner', name: 'E2E Owner', email: 'owner@flo.local', role: 'owner', has_pin: true, is_active: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

type PutResponse = { status: number; body: unknown };

type PutBody = { revision?: string; overrides: { permission_id: string; effect: string }[]; override_pin?: string };
type PutRequest = { url: string; body: PutBody };

/** How the save endpoint answers. Returning `null` accepts the write. */
type PutResponder = (body: PutBody, attempt: number) => PutResponse | null;

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

async function startOwnerSession(page: Page, options: { putResponder?: PutResponder; ownerHasPin?: boolean } = {}): Promise<{ putRequests: PutRequest[] }> {
  const putRequests: PutRequest[] = [];
  const ownerHasPin = options.ownerHasPin ?? true;

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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [{ ...OWNER, has_pin: ownerHasPin }, STAFF_MEMBER] }) });
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
      const refusal = options.putResponder?.(body, putRequests.length) ?? null;
      if (refusal) {
        await route.fulfill({ status: refusal.status, contentType: 'application/json', body: JSON.stringify(refusal.body) });
        return;
      }
      const overrides: Record<string, 'allow' | 'deny'> = {};
      for (const entry of body.overrides || []) overrides[entry.permission_id] = entry.effect;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ role: managerRolePayload(overrides) }) });
      return;
    }

    if (path === '/api/authorization/roles/owner' && method === 'PUT') {
      const body = request.postDataJSON();
      putRequests.push({ url: path, body });
      const refusal = options.putResponder?.(body, putRequests.length) ?? null;
      if (refusal) {
        await route.fulfill({ status: refusal.status, contentType: 'application/json', body: JSON.stringify(refusal.body) });
        return;
      }
      const overrides: Record<string, 'allow' | 'deny'> = {};
      for (const entry of body.overrides || []) overrides[entry.permission_id] = entry.effect;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ role: { ...managerRolePayload(overrides), role: 'owner' } }) });
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
  // A save the server simply accepts must not pick up any refusal surface.
  await expect(page.getByTestId('permission-save-refusal')).toHaveCount(0);
  await expect(page.getByTestId('permission-self-access-warning')).toHaveCount(0);

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

/** The matrix's role tab is the only select that offers the owner's own role. */
const roleSelect = (page: Page) => page.locator('select').filter({ has: page.locator('option[value="owner"]') });
const rowFor = (page: Page, permissionId: string) => page.locator('tr', { hasText: permissionId });
const selfAccessWarnings = (page: Page) => page.getByTestId('permission-self-access-warning');

test('a save that would strip the actor of an administrative capability names the loss on the row before the save', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page);

  await roleSelect(page).selectOption('owner');

  const settingsRow = rowFor(page, 'settings.manage');
  await expect(settingsRow.getByText('Allowed', { exact: true })).toBeVisible();
  await settingsRow.locator('select').selectOption('deny');

  // The warning appears while the change is still unsaved, and names the surface
  // actually being lost rather than asking for blanket confirmation.
  await expect(selfAccessWarnings(page)).toHaveCount(1);
  await expect(selfAccessWarnings(page)).toHaveText(EN.permissionMatrix.selfAccessWarningSettings);
  await expect(settingsRow.getByTestId('permission-self-access-warning')).toBeVisible();
  expect(putRequests).toHaveLength(0);

  // It is a warning, not a client-side gate: the server stays the authority.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => putRequests.length).toBe(1);
});

test('an ordinary permission change renders no self-access warning', async ({ page }) => {
  await startOwnerSession(page);

  await roleSelect(page).selectOption('owner');

  await rowFor(page, 'orders.read').locator('select').selectOption('deny');
  await expect(selfAccessWarnings(page)).toHaveCount(0);

  // The other configurable administrative capability gets its own copy, not the
  // settings one, so the warning stays specific to what is being lost.
  await rowFor(page, 'staff.operational.manage').locator('select').selectOption('deny');
  await expect(selfAccessWarnings(page)).toHaveCount(1);
  await expect(selfAccessWarnings(page)).toHaveText(EN.permissionMatrix.selfAccessWarningStaffOperational);

  // Protected administrative permissions expose no control and no warning.
  const protectedRow = rowFor(page, 'authorization.manage');
  await expect(protectedRow.locator('select')).toHaveCount(0);
  await expect(protectedRow.getByTestId('permission-self-access-warning')).toHaveCount(0);
});

test('a rejected save states the invariant and the remedy instead of a bare error', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page, {
    putResponder: () => ({
      status: 400,
      body: { error: 'This change would leave no account able to manage staff, permissions, or store settings.', code: 'administration_unreachable' },
    }),
  });

  await roleSelect(page).selectOption('owner');
  await rowFor(page, 'settings.manage').locator('select').selectOption('deny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => putRequests.length).toBe(1);
  await expect(page.getByTestId('permission-save-refusal')).toHaveText(EN.permissionMatrix.administrationUnreachable);
  // The refused diff stays on screen so one row can be fixed and the save retried.
  await expect(rowFor(page, 'settings.manage').getByText('Not allowed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a 428 prompts for the PIN and re-submits with it exactly once', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page, {
    putResponder: (body) => (body.override_pin
      ? null
      : { status: 428, body: { error: 'PIN required', code: 'self_privilege_change_requires_factor', requires: 'pin' } }),
  });

  await roleSelect(page).selectOption('owner');
  await rowFor(page, 'settings.manage').locator('select').selectOption('deny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(EN.permissionMatrix.selfPrivilegeChangeTitle, { exact: true })).toBeVisible();
  await expect(dialog.getByText(EN.permissionMatrix.selfPrivilegeChangePrompt, { exact: true })).toBeVisible();

  await dialog.locator('#master-pin').fill('1234');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();

  await expect.poll(() => putRequests.length).toBe(2);
  expect(putRequests[0].body.override_pin).toBeUndefined();
  expect(putRequests[1].body.override_pin).toBe('1234');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('permission-save-refusal')).toHaveCount(0);

  // A settled save must not re-arm the prompt.
  await page.waitForTimeout(500);
  expect(putRequests).toHaveLength(2);
});

test('a 428 the PIN does not clear refuses with an explanation instead of prompting again', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page, {
    putResponder: () => ({ status: 428, body: { error: 'PIN rejected', code: 'self_privilege_change_requires_factor', requires: 'pin' } }),
  });

  await roleSelect(page).selectOption('owner');
  await rowFor(page, 'settings.manage').locator('select').selectOption('deny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#master-pin').fill('1234');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();

  await expect.poll(() => putRequests.length).toBe(2);
  await expect(page.getByTestId('permission-save-refusal')).toHaveText(EN.permissionMatrix.selfPrivilegeNotConfirmed);
  await page.waitForTimeout(500);
  expect(putRequests).toHaveLength(2);
  await expect(dialog).toHaveCount(0);
});

test('an unexpected error shape still surfaces a message instead of doing nothing', async ({ page }) => {
  // Neither refusal code, and no usable error text: the shape the backend has
  // not promised to send, and the one an outage or proxy would produce.
  const { putRequests } = await startOwnerSession(page, {
    putResponder: () => ({ status: 500, body: { detail: 'upstream unavailable' } }),
  });

  await roleSelect(page).selectOption('owner');
  await rowFor(page, 'settings.manage').locator('select').selectOption('deny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => putRequests.length).toBe(1);
  // A real message, localised, rather than silence.
  await expect(page.getByText(EN.common.failedToSave, { exact: true })).toBeVisible();
  // Neither refusal surface is implied, and the pending diff stays editable so
  // the owner can retry without re-entering it.
  await expect(page.getByTestId('permission-save-refusal')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowFor(page, 'settings.manage').getByText('Not allowed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('a mistyped PIN leaves the prompt available again on the next save', async ({ page }) => {
  // Refuse every attempt that is not carrying the right PIN, so the owner
  // mistypes, and then has to be able to try again without reloading.
  const { putRequests } = await startOwnerSession(page, {
    putResponder: (body) => (body.override_pin === '1234'
      ? null
      : { status: 428, body: { error: 'PIN required', code: 'self_privilege_change_requires_factor', requires: 'pin' } }),
  });

  const submitPin = async (pin: string) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('#master-pin').fill(pin);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  };

  await roleSelect(page).selectOption('owner');
  await rowFor(page, 'settings.manage').locator('select').selectOption('deny');
  // 1: the unconfirmed save, 2: the mistyped PIN, 3: the retry, 4: the correct PIN.
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await submitPin('9999');
  await expect.poll(() => putRequests.length).toBe(2);
  await expect(page.getByTestId('permission-save-refusal')).toHaveText(EN.permissionMatrix.selfPrivilegeNotConfirmed);

  // A second attempt after the mistype must offer the prompt again, not leave
  // the owner with an error banner and no way to correct it.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await submitPin('1234');

  await expect.poll(() => putRequests.length).toBe(4);
  expect(putRequests[3].body.override_pin).toBe('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('permission-save-refusal')).toHaveCount(0);
  // The retry settles on the first correct PIN rather than re-prompting.
  await page.waitForTimeout(500);
  expect(putRequests).toHaveLength(4);
});

test('an owner with no PIN is refused with an explanation instead of a dead prompt', async ({ page }) => {
  const { putRequests } = await startOwnerSession(page, {
    ownerHasPin: false,
    putResponder: () => ({ status: 428, body: { error: 'PIN required', code: 'self_privilege_change_requires_factor', requires: 'pin' } }),
  });

  await roleSelect(page).selectOption('owner');
  await rowFor(page, 'settings.manage').locator('select').selectOption('deny');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => putRequests.length).toBe(1);
  await expect(page.getByTestId('permission-save-refusal')).toHaveText(EN.permissionMatrix.selfPrivilegeNotConfirmed);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(putRequests).toHaveLength(1);
});
