/**
 * The one-screen setup for a pizza shop. The shared e2e server is already set up, so this spec
 * starts its own server on a fresh install (`E2E_FRESH_INSTALL`) and sets it up once, in order.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const PORTS = { main: 3441, kds: 3442, serverApp: 3443 };
const BASE = `http://127.0.0.1:${PORTS.main}`;
const SHOTS = process.env.EVIDENCE_DIR;
const OWNER = {
  shop: 'Sample Pizza Shop',
  name: 'Pizza Owner',
  email: 'owner@example.com',
  password: 'TestPass123',
  pin: '5678',
};

let server: ChildProcess;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = spawn('node', ['tests/e2e-server.cjs'], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_FRESH_INSTALL: '1',
      E2E_TASK_LOCAL_PORTS: '1',
      E2E_BASE_URL: BASE,
      E2E_KDS_BASE_URL: `http://127.0.0.1:${PORTS.kds}`,
      E2E_SERVER_APP_BASE_URL: `http://127.0.0.1:${PORTS.serverApp}`,
    },
  });
  for (let i = 0; i < 200; i++) {
    const up = await fetch(`http://127.0.0.1:${PORTS.serverApp}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) return;
    if (server.exitCode !== null) throw new Error('the fresh e2e server exited');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('the fresh e2e server did not start');
});

test.afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
});

const field = (page: Page, label: string | RegExp) => page.getByLabel(label, { exact: true });

async function openSetup(page: Page) {
  await page.goto(`${BASE}/`);
  await expect(page).toHaveURL(/\/setup\/pizza\/?$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set up your pizza POS');
}

async function fill(page: Page, values: Partial<typeof OWNER> & { pinConfirm?: string } = {}) {
  const v = { ...OWNER, pinConfirm: values.pin ?? OWNER.pin, ...values };
  await field(page, 'Shop name').fill(v.shop);
  await field(page, 'Your name').fill(v.name);
  await field(page, 'Your email').fill(v.email);
  await field(page, 'Password').fill(v.password);
  await field(page, '4-digit PIN').fill(v.pin);
  await field(page, 'Type the PIN again').fill(v.pinConfirm);
  await page.getByRole('checkbox').check();
}

async function controlsAreTallEnough(page: Page) {
  const controls = page.locator('main input, main button, main nav a');
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    const type = await control.getAttribute('type');
    // The checkbox is 24 px; its whole label row is the target.
    const min = type === 'checkbox' ? 24 : 48;
    expect(
      box!.height,
      `${await control.evaluate((e) => e.outerHTML.slice(0, 80))}`,
    ).toBeGreaterThanOrEqual(min);
  }
}

test('a fresh install opens on the one screen', async ({ page }) => {
  await openSetup(page);
  await expect(page.getByText('Set up for a pizza shop in British Columbia')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('FloCafe');
  await expect(page.getByRole('button', { name: 'Set up my shop' })).toBeVisible();
  // Nothing else is asked: five text fields, one PIN pair, one checkbox.
  await expect(page.locator('main input:not([type="checkbox"])')).toHaveCount(6);
  await expect(page.getByRole('checkbox')).toHaveCount(1);
});

test('a short password and mismatched PINs are refused beside the field', async ({ page }) => {
  await openSetup(page);
  await fill(page, { password: 'abc', pinConfirm: '5679' });
  await page.getByRole('button', { name: 'Set up my shop' }).click();
  await expect(page.locator('#quick-setup-password-error')).toHaveText(
    'Password must be at least 4 characters long.',
  );
  await expect(field(page, 'Password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#quick-setup-pinConfirm-error')).toHaveText(
    'The two PINs do not match.',
  );
  await expect(field(page, 'Password')).toBeFocused();
  const status = await (await fetch(`${BASE}/api/auth/setup/status`)).json();
  expect(status.needsSetup, 'nothing was sent').toBe(true);
});

test('a server that cannot be reached says so and keeps what was typed', async ({ page }) => {
  await openSetup(page);
  await page.route('**/api/auth/setup/initialize', (route) => route.abort('connectionrefused'));
  await fill(page);
  await page.getByRole('button', { name: 'Set up my shop' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'The POS server could not be reached',
  );
  await expect(field(page, 'Shop name')).toHaveValue(OWNER.shop);
  await expect(field(page, 'Your email')).toHaveValue(OWNER.email);
});

test('the full wizard and restore are one link away', async ({ page }) => {
  await openSetup(page);
  await page.getByRole('link', { name: 'Not a pizza shop in BC? Use the full setup' }).click();
  await expect(page).toHaveURL(/\/setup\/?$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to FloCafe');

  // The wizard's own restore runs; a browser has no file picker, so it says so.
  await openSetup(page);
  await page.getByRole('link', { name: 'Restore a backup' }).click();
  await expect(page).toHaveURL(/\/setup\/?$/);
  await expect(page.getByText('Not available')).toBeVisible();
});

test('it fits at 1180 x 820 with 48 px controls', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await openSetup(page);
  await controlsAreTallEnough(page);
  if (SHOTS)
    await page.screenshot({
      path: path.join(SHOTS, 'quick-setup-1180x820.png'),
      fullPage: true,
    });
});

test('it fits a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSetup(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways scrolling').toBeLessThanOrEqual(0);
  await controlsAreTallEnough(page);
  if (SHOTS)
    await page.screenshot({
      path: path.join(SHOTS, 'quick-setup-390x844.png'),
      fullPage: true,
    });
});

test('keyboard only: the form sets the shop up, signs in and opens the Pizza menu', async ({
  page,
}) => {
  await openSetup(page);
  const tabTo = async (name: string) => {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.getAttribute('name') ?? '',
      );
      if (label === name) return;
    }
    throw new Error(`Tab never reached ${name}`);
  };
  await tabTo('shopName');
  await page.keyboard.type(OWNER.shop);
  await page.keyboard.press('Tab');
  await page.keyboard.type(OWNER.name);
  await page.keyboard.press('Tab');
  await page.keyboard.type(OWNER.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(OWNER.password);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(field(page, 'Password')).toHaveAttribute('type', 'text');
  await page.keyboard.press('Tab');
  await page.keyboard.type(OWNER.pin);
  await page.keyboard.press('Tab');
  await page.keyboard.type(OWNER.pin);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('checkbox')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/pizza-menu\/?$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Pizza menu' })).toBeVisible();
  await expect(page.getByText('No pizza menu is loaded.')).toBeVisible();
  await expect(page.getByLabel('Menu file (.json)')).toBeVisible();
  if (SHOTS)
    await page.screenshot({
      path: path.join(SHOTS, 'quick-setup-after.png'),
      fullPage: true,
    });
});

test("the store's settings read back as the BC pizza profile", async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  expect(login.status).toBe(200);
  const headers = {
    Authorization: `Bearer ${(await login.json()).access_token}`,
  };
  const { settings } = await (await fetch(`${BASE}/api/settings`, { headers })).json();
  expect({
    business_name: settings.business_name,
    country: settings.country,
    state_code: settings.state_code,
    currency: settings.currency,
    timezone: settings.timezone,
    language: settings.language,
    setup_profile: settings.setup_profile,
    service_model: settings.service_model,
    taxes_enabled: settings.taxes_enabled,
    offline_mode: settings.offline_mode,
  }).toEqual({
    business_name: OWNER.shop,
    country: 'CA',
    state_code: 'BC',
    currency: 'CAD',
    timezone: 'America/Vancouver',
    language: 'en',
    setup_profile: 'pizza',
    service_model: 'qsr',
    taxes_enabled: 'true',
    offline_mode: 'true',
  });
  const pack = await (await fetch(`${BASE}/api/tax-packs/manual-ca`, { headers })).json();
  expect(
    pack.categories.map((c: { category_id: string; label: string }) => [c.category_id, c.label]),
  ).toEqual(
    // The manual pack always carries its own "unclassified" category beside the profile's two.
    expect.arrayContaining([
      ['food', 'Food'],
      ['soda', 'Soda'],
    ]),
  );
});
