import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

const DIAGNOSTICS_TAB = 'Diagnostics & Logs';
const TICKET_TAB = 'Submit Ticket';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loginAs(page: Page, email: string) {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  // A server lands on orders, everyone else on the till.
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
}

/** Records a failure through the real intake endpoint, so the screen has one to show. */
async function recordFailure(page: Page, message: string) {
  const eventResponse = await page.request.post(`${BASE}/api/diagnostics/event`, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
    data: {
      event_code: 'server.internal_error',
      severity: 'error',
      message,
      metadata: { route: '/api/orders', method: 'POST', status: 500 },
    },
  });
  expect(eventResponse.status(), 'the diagnostic event is accepted').toBe(202);
}

// These assert what the operator sees, not that a function ran, so the failure
// under test is produced through the real intake endpoint rather than injected.
test('operator sees a captured failure and the copy-for-support action', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await recordFailure(page, 'The order could not be completed on this device');

  await loginAs(page, 'owner@flo.local');

  await page.getByRole('button', { name: 'E2E owner' }).click();
  await page.getByRole('menuitem', { name: 'Support' }).click();
  await expect(page).toHaveURL(/\/support\/?$/);
  await expect(
    page.getByRole('tab', { name: TICKET_TAB }),
    'the hub opens on ticket submission',
  ).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: DIAGNOSTICS_TAB }).click();
  await expect(page).toHaveURL(/\/support\/?\?tab=diagnostics$/);
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();

  const failure = page.getByText('The order could not be completed on this device', { exact: false });
  await expect(failure.first(), 'the captured failure is visible to the operator').toBeVisible();
  await expect(page.getByText('server.internal_error').first()).toBeVisible();
  await expect(page.getByText('/api/orders').first()).toBeVisible();

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

  const logTailToggle = page.getByRole('switch', { name: 'Also include the log file' });
  await expect(logTailToggle, 'the log tail is a separate control').toBeVisible();
  await expect(logTailToggle).toHaveAttribute('aria-checked', 'false');
  await expect(
    page.getByText('The log file can contain order and customer details', { exact: false }),
    'the operator is told what the log tail contains before asking for it',
  ).toBeVisible();

  await page.getByRole('tab', { name: TICKET_TAB }).click();
  await expect(page).toHaveURL(/\/support\/?$/);
  await expect(page.getByRole('tab', { name: TICKET_TAB })).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByLabel('Subject'),
    'switching back reaches the ticket form',
  ).toBeVisible();
});

test('the diagnostics half of the hub opens from a deep link', async ({ page }) => {
  await loginAs(page, 'owner@flo.local');

  await page.goto(`${BASE}/support?tab=diagnostics`);
  await expect(page.getByRole('tab', { name: DIAGNOSTICS_TAB })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
  await expect(
    page.getByTestId('diagnostics-bundle-preview'),
    'the deep link is not a ticket form with the panel hidden behind it',
  ).toBeVisible();
});

test('a captured failure can be reported as a ticket', async ({ page }) => {
  // The card shows the derived summary, not the submitted message, so the text
  // the operator would report is read back from the screen.
  await recordFailure(page, 'The receipt printer jammed while cutting the paper');
  await loginAs(page, 'owner@flo.local');
  await page.goto(`${BASE}/support?tab=diagnostics`);

  const card = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Create Ticket' }) }).first();
  await expect(card, 'the failure is offered for reporting').toBeVisible();
  const summary = (await card.locator('p').first().innerText()).trim();
  const signature = (await card.locator('p').nth(1).innerText()).trim();
  await card.getByRole('button', { name: 'Create Ticket' }).click();

  await expect(page).toHaveURL(/\/support\/?$/);
  await expect(
    page.getByRole('tab', { name: TICKET_TAB }),
    'reporting a failure lands on the ticket form',
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#support-category'), 'a failure is reported as a bug').toHaveValue('bug');
  await expect(page.locator('#support-subject')).toHaveValue(/^\[Failure\] server\.internal_error: /);
  const message = page.locator('#support-message');
  await expect(message, 'the report carries the summary shown on the failure card').toHaveValue(new RegExp(escapeRegExp(summary)));
  await expect(message, 'the report carries the signature it was raised from').toHaveValue(new RegExp(escapeRegExp(signature)));
  await expect(message, 'the report carries when it happened').toHaveValue(/occurred_at: /);
  await expect(message, 'the report carries the metadata the till recorded').toHaveValue(/\/api\/orders/);
});

test('nothing is transmitted automatically', async ({ page }) => {
  const token = getE2eToken();
  await loginAs(page, 'owner@flo.local');

  const before = await page.request.get(`${BASE}/api/diagnostics/recent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(before.status()).toBe(200);
  const beforeBody = await before.text();

  await page.goto(`${BASE}/support?tab=diagnostics`);
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();

  const after = await page.request.get(`${BASE}/api/diagnostics/recent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await after.text()).toBe(beforeBody);

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
  await loginAs(page, 'owner@flo.local');

  await page.goto(`${BASE}/support?tab=diagnostics`);
  const hint = page.getByText('Nothing here leaves the till automatically', { exact: false });
  await expect(hint, 'with transmission confirmed off the absolute claim is shown').toBeVisible();

  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  try {
    expect((await setTransmission('true')).status(), 'the owner can turn transmission on').toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
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
  // Fetch now, fulfil after the save: the server must answer before it and
  // deliver after, or there is no race to reproduce.
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ response });
  });

  try {
    await loginAs(page, 'owner@flo.local');
    await page.goto(`${BASE}/support?tab=diagnostics`);

    const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
    await transmission.click();
    await expect(transmission, 'the save is reflected in the switch').toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Automatic transmission is on', { exact: false })).toBeVisible();

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

test('a refresh started after a save applies the value it read', async ({ page }) => {
  const token = getE2eToken();
  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  try {
    await loginAs(page, 'owner@flo.local');
    await page.goto(`${BASE}/support?tab=diagnostics`);

    const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
    await transmission.click();
    await expect(transmission).toHaveAttribute('aria-checked', 'true');

    // The save already set the switch, so asserting it after the refresh would
    // prove nothing: the server is changed out of band instead.
    expect((await setTransmission('false')).status(), 'the server value is changed directly').toBe(200);
    await expect(transmission, 'precondition: the screen still shows the saved value').toHaveAttribute('aria-checked', 'true');

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      transmission,
      'the refresh applied its own response rather than leaving the earlier state',
    ).toHaveAttribute('aria-checked', 'false');
    await expect(
      page.getByText('Nothing here leaves the till automatically', { exact: false }),
      'and the wording matches the value the refresh read',
    ).toBeVisible();
  } finally {
    await setTransmission('false');
  }
});

test('an operator without the settings permission can read diagnostics but not change them', async ({ page }) => {
  // A server holds the support permission that opens this hub but not
  // settings.manage, which is what PUT /settings/:key and DELETE
  // /diagnostics/recent enforce.
  await loginAs(page, 'server@flo.local');

  await page.goto(`${BASE}/support?tab=diagnostics`);
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();

  // The read paths need support.use only, so a rejected settings read must not
  // take the failures and the bundle down with it.
  await expect(page.getByTestId('diagnostics-bundle-preview'), 'the bundle is still readable').toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Copy for support', exact: true }),
    'the parts of the hub a server may use still work',
  ).toBeEnabled();
  await expect(
    page.getByRole('switch', { name: 'Also include the log file' }),
    'the log tail is a control a server may use',
  ).toBeEnabled();

  const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
  await expect(transmission, 'the control is still shown, so its state is legible').toBeVisible();
  await expect(transmission, 'the control is visibly unavailable').toBeDisabled();
  // Erasing the failure history is the destructive one, so it is gated too.
  await expect(
    page.getByRole('button', { name: 'Clear', exact: true }),
    'clearing the failure history is visibly unavailable without the settings permission',
  ).toBeDisabled();
});

test('a failure can be reported as a ticket by a staff member without the settings permission', async ({ page }) => {
  await recordFailure(page, 'The card reader refused the chip');
  await loginAs(page, 'server@flo.local');
  await page.goto(`${BASE}/support?tab=diagnostics`);

  const card = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Create Ticket' }) }).first();
  await expect(card, 'a server may report what they can see').toBeVisible();
  await card.getByRole('button', { name: 'Create Ticket' }).click();
  await expect(page.getByRole('tab', { name: TICKET_TAB })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#support-subject')).toHaveValue(/^\[Failure\] server\.internal_error: /);
});
