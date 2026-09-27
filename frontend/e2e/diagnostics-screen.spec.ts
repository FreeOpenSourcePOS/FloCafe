import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

// The in-app diagnostics screen as an operator meets it: the captured failure,
// the copy action, the exact clipboard text, and the separate log-tail control.
// The failure is produced through a real intake call, so these assert what is on
// the page rather than that a function ran.
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
  const ownerSwitch = page.getByRole('switch', { name: 'Send diagnostics automatically' });
  await expect(ownerSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(ownerSwitch, 'an owner who holds the settings permission can use it').toBeEnabled();
});

test('the privacy hint stops claiming nothing is sent once transmission is on', async ({ page }) => {
  const token = getE2eToken();
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });

  await page.goto(`${BASE}/settings?tab=diagnostics`);
  const hint = page.getByText('Nothing here leaves the till automatically', { exact: false });
  // The off-state claim is only shown once the server has confirmed the setting.
  await expect(hint, 'with transmission confirmed off the absolute claim is shown').toBeVisible();

  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  try {
    expect((await setTransmission('true')).status(), 'the owner can turn transmission on').toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
    // The claim is false once transmission is on, so the screen must stop making
    // it rather than tell the owner their data stays on the till.
    await expect(
      page.getByText('Nothing here leaves the till automatically', { exact: false }),
      'the absolute claim is withdrawn when transmission is on',
    ).toHaveCount(0);
    await expect(
      page.getByText('Automatic transmission is on', { exact: false }),
      'the screen says recorded problems may be sent instead',
    ).toBeVisible();
  } finally {
    // Shared test database: a failed assertion must not leave it transmitting.
    await setTransmission('false');
  }
});

test('a settings read that started before a save cannot put the switch back to off', async ({ page }) => {
  const token = getE2eToken();
  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  // The server must ANSWER the settings read before the save and DELIVER it
  // after, so the response is fetched at request time and held before being
  // fulfilled. Holding the request instead would just make the server answer
  // after the save, which is not the race.
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ response });
  });

  try {
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await page.goto(`${BASE}/settings?tab=diagnostics`);

    const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
    await transmission.click();
    await expect(transmission, 'the save is reflected in the switch').toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Automatic transmission is on', { exact: false })).toBeVisible();

    // The delayed, now stale, settings response lands after the save.
    await page.waitForTimeout(5000);
    await expect(transmission, 'a stale read must not put the switch back to off').toHaveAttribute('aria-checked', 'true');
    await expect(
      page.getByText('Nothing here leaves the till automatically', { exact: false }),
      'the screen must not claim nothing is sent while the backend can transmit',
    ).toHaveCount(0);
  } finally {
    await page.unroute('**/api/settings');
    await setTransmission('false');
  }
});

test('a refresh started after a save returns the new value', async ({ page }) => {
  const token = getE2eToken();
  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  try {
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await page.goto(`${BASE}/settings?tab=diagnostics`);

    const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
    await transmission.click();
    await expect(transmission).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(transmission, 'the refresh read returns the value just saved').toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Automatic transmission is on', { exact: false })).toBeVisible();
    await expect(
      page.getByText('Nothing here leaves the till automatically', { exact: false }),
      'a post-save refresh must not fall back to the off-state claim',
    ).toHaveCount(0);
  } finally {
    await setTransmission('false');
  }
});

test('an operator without the settings permission cannot use the transmission switch', async ({ page }) => {
  // A server holds the support permission that opens this screen but not
  // settings.manage, which is what PUT /settings/:key enforces.
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('server@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });

  await page.goto(`${BASE}/settings?tab=diagnostics`);
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();

  // A manager has the support permission that opens this screen but not the
  // settings permission the write endpoint enforces, so the switch is offered
  // visibly unavailable rather than apparently broken.
  const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
  await expect(transmission, 'the control is still shown, so its state is legible').toBeVisible();
  await expect(transmission, 'the control is visibly unavailable').toBeDisabled();
  // Erasing the failure history is the destructive one, so it is gated too.
  await expect(
    page.getByRole('button', { name: 'Clear', exact: true }),
    'clearing the failure history is visibly unavailable without the settings permission',
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Copy for support', exact: true }),
    'the parts of the screen a server may use still work',
  ).toBeEnabled();
});
