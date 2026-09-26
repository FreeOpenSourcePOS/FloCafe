import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

/**
 * The in-app diagnostics screen, as an operator actually meets it.
 *
 * A customer who cannot describe a failure reads the screen down the phone, so
 * this asserts what is *on the page*: the captured failure and its plain-language
 * summary, the copy-for-support action, the exact text the copy action puts on
 * the clipboard, and the deliberately separate log-tail control.
 *
 * The failure is produced through a real product path - POST /api/diagnostics/event -
 * so the assertion is not that a function was called but that the operator can
 * see a failure that actually happened on this till.
 */
test('operator sees a captured failure and the copy-for-support action', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const token = getE2eToken();

  // A real failure on this till, through the real intake endpoint.
  const eventResponse = await page.request.post(`${BASE}/api/diagnostics/event`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      event_code: 'server.internal_error',
      severity: 'error',
      message: 'The order could not be completed on this device',
      metadata: { route: '/api/orders', method: 'POST', status: 500 },
    },
  });
  expect(eventResponse.status(), 'the diagnostic event is accepted').toBe(202);

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);

  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?\?tab=diagnostics$/);
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();

  // The failure the operator could not otherwise describe is on the page.
  const failure = page.getByText('The order could not be completed on this device', { exact: false });
  await expect(failure.first(), 'the captured failure is visible to the operator').toBeVisible();
  await expect(page.getByText('server.internal_error').first()).toBeVisible();
  await expect(page.getByText('/api/orders').first()).toBeVisible();

  // The copy-for-support action exists and shows exactly what it will copy.
  const copyButton = page.getByRole('button', { name: 'Copy for support', exact: true });
  await expect(copyButton, 'the copy-for-support action is offered').toBeVisible();
  const preview = page.getByTestId('diagnostics-bundle-preview');
  await expect(preview, 'the operator sees the bundle before copying it').toBeVisible();
  await expect(preview).toContainText('"app_version"');
  await expect(preview).toContainText('"recent_failures"');
  await expect(preview).toContainText('The order could not be completed on this device');
  await expect(preview, 'the raw log tail is not in the bundle by default').not.toContainText('log file (may contain');

  await copyButton.click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard, 'the clipboard holds exactly the text shown on screen').toBe(await preview.innerText());

  // The log tail is a separate, deliberately-labelled control.
  const logTailToggle = page.getByRole('switch', { name: 'Also include the log file' });
  await expect(logTailToggle, 'the log tail is a separate control').toBeVisible();
  await expect(logTailToggle).toHaveAttribute('aria-checked', 'false');
  await expect(
    page.getByText('The log file can contain order and customer details', { exact: false }),
    'the operator is told what the log tail contains before asking for it',
  ).toBeVisible();
});

test('nothing is transmitted automatically', async ({ page }) => {
  const token = getE2eToken();
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  const before = await page.request.get(`${BASE}/api/diagnostics/recent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(before.status()).toBe(200);
  const beforeBody = await before.text();

  await page.goto(`${BASE}/settings?tab=diagnostics`);
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();

  // Reading the screen must not queue anything for transmission.
  const after = await page.request.get(`${BASE}/api/diagnostics/recent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await after.text()).toBe(beforeBody);

  // The transmission switch is off by default, so nothing captured here is sent.
  const settings = await page.request.get(`${BASE}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const settingsJson = await settings.json();
  expect(settingsJson.settings?.diagnostics_transmission_enabled, 'automatic transmission defaults to off').toBe('false');
  await expect(page.getByRole('switch', { name: 'Send diagnostics automatically' })).toHaveAttribute('aria-checked', 'false');
});
