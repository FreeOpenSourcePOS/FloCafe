import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from '../helpers/urls';
import { login, ownerAuth, type Role } from './helpers';

/**
 * Staff and roles, driven as an administrator.
 *
 * The point of this suite is not that the permission matrix *renders* - a
 * read-only matrix proves nothing - but that each role is actually stopped when
 * it attempts an action its role excludes. Every negative case asserts the
 * backend refused the write, not merely that a control was hidden.
 */

const PASSWORD = 'OpsPass123';
const RUN = Date.now().toString(36);

type StaffRole = Role | 'cashier';
type Account = { id: string; email: string; role: StaffRole };
const created: Account[] = [];

/** A surface each role must be refused, with the permission that gates it. */
const DENIED: Array<{ label: string; method: 'get' | 'post' | 'put'; path: string; data?: unknown }> = [
  { label: 'staff.view (read the staff list)', method: 'get', path: '/api/staff' },
  { label: 'settings.manage (write a setting)', method: 'put', path: '/api/settings/business', data: { business_name: 'nope' } },
  { label: 'refunds.initiate', method: 'post', path: '/api/refunds', data: { bill_id: 1, amount_cents: 1, method: 'cash' } },
  { label: 'catalog.manage (write the catalogue)', method: 'post', path: '/api/products', data: { name: 'x', price: 1 } },
  { label: 'tables.manage (write tables)', method: 'post', path: '/api/tables', data: { number: 'Z9', capacity: 2 } },
  { label: 'payments.take (settle a bill)', method: 'post', path: '/api/bills/1/payment', data: { method: 'cash', amount: 1 } },
];

async function makeAccount(request: import('@playwright/test').APIRequestContext, role: StaffRole, tag: string): Promise<Account> {
  const email = `ops-${tag}-${RUN}@flo.local`;
  const res = await request.post(`${E2E_BASE_URL}/api/staff`, {
    headers: ownerAuth(),
    data: { name: `Ops ${tag}`, email, password: PASSWORD, role },
  });
  expect(res.status(), `creating a ${role} account must succeed (got ${res.status()} ${await res.text()})`).toBe(201);
  const { staff: user } = (await res.json()) as { staff: Account };
  created.push(user);
  return user;
}

async function tokenFor(request: import('@playwright/test').APIRequestContext, account: Account): Promise<string> {
  const res = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
    data: { email: account.email, password: PASSWORD },
  });
  expect(res.ok(), `${account.role} must be able to sign in (got ${res.status()} ${await res.text()})`).toBeTruthy();
  return (await res.json()).access_token;
}

test.describe('@ci-tier2 operations admin - staff and roles', () => {
  let server: Account;
  let cashier: Account;
  let retired: Account;

  test.beforeAll(async ({ request }) => {
    server = await makeAccount(request, 'server', 'server');
    cashier = await makeAccount(request, 'cashier', 'cashier');
    // A dedicated account so the deactivation check does not disturb the others.
    retired = await makeAccount(request, 'cashier', 'retired');
  });

  test.afterAll(async ({ request }) => {
    // Staff accounts are deactivated rather than deleted, so leave none active.
    for (const account of created) {
      await request.post(`${E2E_BASE_URL}/api/staff/${account.id}/deactivate`, { headers: ownerAuth() });
    }
  });

  test('an owner can create an account per role, and each one signs in', async ({ page, request }) => {
    // Each role account authenticates against the real login route.
    for (const account of [server, cashier, retired]) {
      const res = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
        data: { email: account.email, password: PASSWORD },
      });
      expect(res.ok(), `${account.role} must sign in`).toBeTruthy();
      const { user } = (await res.json()) as { user: { role: string; id: string } };
      expect(user.role).toBe(account.role);
      expect(user.id).toBe(account.id);
    }

    // And the sign-in form works for one of them, end to end through the UI.
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.locator('#email').fill(server.email);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 20_000 });
  });

  test('a deactivated account cannot sign in, and says why', async ({ page, request }) => {
    try {
      const deactivation = await request.post(`${E2E_BASE_URL}/api/staff/${retired.id}/deactivate`, { headers: ownerAuth() });
      expect(deactivation.ok(), `deactivating an account must succeed (got ${deactivation.status()})`).toBeTruthy();

      const api = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
        data: { email: retired.email, password: PASSWORD },
      });
      expect(api.status(), 'a deactivated account must not authenticate').toBe(401);

      await page.goto(`${E2E_BASE_URL}/auth/login`);
      await page.locator('#email').fill(retired.email);
      await page.locator('#password').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
      await expect(page).toHaveURL(/\/auth\/login/);
      await expect(page.getByText(/deactivat|inactive|not active|invalid|incorrect/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      const reactivated = await request.post(`${E2E_BASE_URL}/api/staff/${retired.id}/reactivate`, { headers: ownerAuth() });
      if (reactivated.status() === 400) {
        expect((await reactivated.json()).error).toBe('Already active');
      } else {
        expect(reactivated.ok(), `reactivating an account must succeed (got ${reactivated.status()})`).toBeTruthy();
      }
    }
  });

  test('a deactivated account keeps an already-issued session out', async ({ request }) => {
    // Signing in first, then deactivating, must not leave a live session behind.
    const token = await tokenFor(request, server);
    const before = await request.get(`${E2E_BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(before.ok()).toBeTruthy();

    try {
      const deactivation = await request.post(`${E2E_BASE_URL}/api/staff/${server.id}/deactivate`, { headers: ownerAuth() });
      expect(deactivation.ok(), `deactivating an account must succeed (got ${deactivation.status()})`).toBeTruthy();
      const after = await request.get(`${E2E_BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      expect(after.status(), 'a session issued before deactivation must stop working').toBe(401);
    } finally {
      const reactivated = await request.post(`${E2E_BASE_URL}/api/staff/${server.id}/reactivate`, { headers: ownerAuth() });
      if (reactivated.status() === 400) {
        expect((await reactivated.json()).error).toBe('Already active');
      } else {
        expect(reactivated.ok(), `reactivating an account must succeed (got ${reactivated.status()})`).toBeTruthy();
      }
    }
  });

  test('a server is refused every surface its role excludes', async ({ request }) => {
    const token = await tokenFor(request, server);
    const headers = { Authorization: `Bearer ${token}` };

    for (const surface of DENIED) {
      const res = await request[surface.method](`${E2E_BASE_URL}${surface.path}`, {
        headers,
        ...(surface.data ? { data: surface.data } : {}),
      });
      expect(
        res.status(),
        `a server must be refused ${surface.label} (got ${res.status()} ${await res.text()})`,
      ).toBe(403);
    }
  });

  test('a server may create a customer but may not edit one', async ({ request }) => {
    const token = await tokenFor(request, server);
    const headers = { Authorization: `Bearer ${token}` };

    // customers.create is granted to a server. The tenant is Thai, so the API
    // takes E.164 directly (the UI is what normalises a local number).
    const createdCustomer = await request.post(`${E2E_BASE_URL}/api/customers`, {
      headers,
      data: { name: `Ops Server Customer ${RUN}`, phone: `+668${String(Date.now()).slice(-8)}` },
    });
    expect(createdCustomer.status(), `a server must be able to create a customer (got ${createdCustomer.status()} ${await createdCustomer.text()})`).toBe(201);
    const { customer } = (await createdCustomer.json()) as { customer: { id: string } };

    // customers.edit is not: the same account must be stopped on the write.
    const edited = await request.put(`${E2E_BASE_URL}/api/customers/${customer.id}`, {
      headers,
      data: { name: 'Renamed By Server' },
    });
    expect(edited.status(), `a server must not be able to edit a customer (got ${edited.status()})`).toBe(403);

    await request.delete(`${E2E_BASE_URL}/api/customers/${customer.id}`, { headers: ownerAuth() }).catch(() => {});
  });

  test('a server sees every order, not only the ones it created', async ({ page, request }) => {
    // Orders are never ownership-gated: a server must see another user's order.
    const ownerOrder = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: ownerAuth(),
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    expect(ownerOrder.status()).toBe(201);
    const { order } = (await ownerOrder.json()) as { order: { order_number: string } };

    const token = await tokenFor(request, server);

    // Backend view.
    const listed = await request.get(`${E2E_BASE_URL}/api/orders`, { headers: { Authorization: `Bearer ${token}` } });
    expect(listed.ok()).toBeTruthy();
    const { orders } = (await listed.json()) as { orders: Array<{ order_number: string }> };
    expect(
      orders.some((o) => o.order_number === order.order_number),
      "a server must be able to read another user's order",
    ).toBeTruthy();

    // And the Orders screen a server actually lands on shows it too.
    await login(page, 'owner');
    await page.evaluate((t) => localStorage.setItem('token', t), token);
    await page.goto(`${E2E_BASE_URL}/orders`);
    await expect(
      page.getByRole('button').filter({ hasText: `#${order.order_number}` }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('a server is not offered the owner-only surfaces in the navigation', async ({ page, request }) => {
    const token = await tokenFor(request, server);

    await login(page, 'owner');
    await page.evaluate((t) => localStorage.setItem('token', t), token);
    await page.goto(`${E2E_BASE_URL}/pos`);
    await page.waitForTimeout(1500);

    // The navigation a server gets carries only its own surfaces.
    const links = await page.locator('a[href]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    expect(links.some((h) => /dashboard/i.test(h)), 'a server must not be offered the dashboard').toBeFalsy();
    expect(links.some((h) => /\/staff/i.test(h)), 'a server must not be offered the staff screen').toBeFalsy();

    // Direct navigation to the dashboard is turned away and lands somewhere usable.
    await page.goto(`${E2E_BASE_URL}/dashboard`);
    await page.waitForTimeout(1200);
    await expect(page).not.toHaveURL(/\/dashboard\/?$/);
  });

  test('FINDING: the staff route renders for a server instead of turning them away', async ({ page, request }) => {
    // The backend correctly refuses the read - this asserts that, because it is
    // the part that matters for security.
    const token = await tokenFor(request, server);
    const denied = await request.get(`${E2E_BASE_URL}/api/staff`, { headers: { Authorization: `Bearer ${token}` } });
    expect(denied.status(), 'the backend must refuse staff.view').toBe(403);
    expect((await denied.json()).permission).toBe('staff.view');

    // But the client-side gate is missing: typing the URL renders the staff
    // screen anyway, with an empty table and a raw error, where /dashboard and
    // /reports would have redirected. Recorded here as executable evidence; no
    // data is exposed, because the read itself is refused.
    await login(page, 'owner');
    await page.evaluate((t) => localStorage.setItem('token', t), token);
    await page.goto(`${E2E_BASE_URL}/staff`);
    await page.waitForTimeout(2000);

    await expect(page.getByRole('heading', { name: /Staff/i })).toBeVisible();
    await expect(page.getByText(/Failed to load staff/i).first()).toBeVisible({ timeout: 15_000 });
    // And it really is empty rather than populated.
    await expect(page.getByText(/No staff members yet/i).first()).toBeVisible();
  });

  test('only an owner can create another owner or manager', async ({ request }) => {
    // A manager holds staff.operational.manage but not staff.privileged.manage.
    const managerToken = (await (await request.post(`${E2E_BASE_URL}/api/auth/login`, {
      data: { email: 'manager@flo.local', password: 'E2ePass123!' },
    })).json()).access_token;

    const privileged = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: { Authorization: `Bearer ${managerToken}` },
      data: { name: 'Ops Escalated', email: `ops-escalated-${RUN}@flo.local`, password: PASSWORD, role: 'manager' },
    });
    expect(privileged.status(), `a manager must not be able to create another manager (got ${privileged.status()})`).toBe(403);

    // The operational role it does hold still works.
    const operational = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: { Authorization: `Bearer ${managerToken}` },
      data: { name: 'Ops Cashier', email: `ops-mgr-cashier-${RUN}@flo.local`, password: PASSWORD, role: 'cashier' },
    });
    expect(operational.status(), `a manager must be able to create a cashier (got ${operational.status()} ${await operational.text()})`).toBe(201);
    const { staff: user } = (await operational.json()) as { staff: Account };
    created.push(user);
  });
});
