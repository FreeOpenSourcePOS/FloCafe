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
async function recordFailure(
  page: Page,
  message: string,
  metadata: Record<string, unknown> = { route: '/api/orders', method: 'POST', status: 500 },
  eventCode = 'server.internal_error',
) {
  const eventResponse = await page.request.post(`${BASE}/api/diagnostics/event`, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
    data: {
      event_code: eventCode,
      severity: 'error',
      message,
      metadata,
    },
  });
  expect(eventResponse.status(), 'the diagnostic event is accepted').toBe(202);
}

// Assert what the operator sees, not that a function ran.
test('operator sees a captured failure and the copy-for-support action', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await recordFailure(page, 'The order could not be completed on this device');

  await loginAs(page, 'owner@flo.local');
  await page.goto(`${BASE}/support`);
  await page.getByLabel('Subject').fill('A report I started by hand');

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
    page.locator('#support-subject'),
    'a report in progress survives an ordinary tab switch',
  ).toHaveValue('A report I started by hand');
});

test('an old settings diagnostics link lands on the support hub', async ({ page }) => {
  await loginAs(page, 'owner@flo.local');

  await page.goto(`${BASE}/settings?tab=diagnostics`);
  await expect(
    page,
    'a link from before the move is sent to the panel that replaced it',
  ).toHaveURL(/\/support\/?\?tab=diagnostics$/);
  await expect(page.getByRole('tab', { name: DIAGNOSTICS_TAB })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
});

test('the diagnostics half of the hub opens from a deep link', async ({ page }) => {
  await loginAs(page, 'owner@flo.local');

  const profileRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/support-ticket/profile')) profileRequests.push(request.url());
  });

  await page.goto(`${BASE}/support?tab=diagnostics`);
  await expect(page.getByRole('tab', { name: DIAGNOSTICS_TAB })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
  await expect(
    page.getByTestId('diagnostics-bundle-preview'),
    'the deep link is not a ticket form with the panel hidden behind it',
  ).toBeVisible();
  expect(
    profileRequests,
    'the ticket form does not load, and cannot report a failure, for a tab nobody opened',
  ).toHaveLength(0);

  await page.getByRole('tab', { name: TICKET_TAB }).click();
  await expect(page.locator('#support-subject'), 'opening the tab shows the form').toBeVisible();
  await expect
    .poll(() => profileRequests.length, { message: 'the form loads its contact details once shown' })
    .toBe(1);
});

test('a captured failure can be reported as a ticket', async ({ page }) => {
  // The card shows the derived summary, not the submitted message, so the text
  // the operator would report is read back from the screen. A fixed phrase.
  await recordFailure(page, 'The printer is offline');
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

test('automatic reporting is enabled by default and the owner can opt out', async ({ page }) => {
  const token = getE2eToken();
  await loginAs(page, 'owner@flo.local');

  const settings = await page.request.get(`${BASE}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(settings.status()).toBe(200);
  const settingsJson = await settings.json();
  expect(settingsJson.settings?.diagnostics_consent).toBe('true');
  expect(settingsJson.settings?.diagnostics_transmission_enabled).toBe('true');
  const initialHealthResponse = await page.request.get(`${BASE}/api/diagnostics/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const initialHealth = await initialHealthResponse.json();
  expect(initialHealth.effective_consent).toBe(true);
  expect(initialHealth.transmission_enabled).toBe(true);

  await page.goto(`${BASE}/support?tab=diagnostics`);
  await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
  const ownerSwitch = page.getByRole('switch', { name: 'Send diagnostics automatically' });
  await expect(ownerSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(ownerSwitch, 'an owner who holds the settings permission can use it').toBeEnabled();
  await expect(page.getByTestId('diagnostics-health')).toBeVisible();
  if (initialHealth.consent_sync_pending) {
    await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();
    await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toHaveCount(0);
  } else {
    await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toBeVisible();
  }

  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  try {
    expect((await setTransmission('false')).status(), 'the owner can opt out').toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Send diagnostics automatically' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('diagnostics-health')).toBeVisible();
    const health = await page.request.get(`${BASE}/api/diagnostics/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const healthState = await health.json();
    expect(healthState.effective_consent, 'the health endpoint reports the separate store-consent preference').toBe(true);
    expect(healthState.transmission_enabled, 'opting out disables the independent transmission gate').toBe(false);
    expect(['local', 'disabled']).toContain(healthState.transport);
    if (healthState.consent_sync_pending) {
      await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText('Automatic reporting is off', { exact: false })).toBeVisible();
    }
  } finally {
    await setTransmission('true');
  }
});

test('the delivery hint needs both privacy gates and a confirmed transport state', async ({ page }) => {
  const token = getE2eToken();
  await loginAs(page, 'owner@flo.local');
  for (const key of ['diagnostics_consent', 'diagnostics_transmission_enabled']) {
    const response = await page.request.put(`${BASE}/api/settings/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { value: 'true' },
    });
    expect(response.status()).toBe(200);
  }

  let health: Record<string, unknown> = {
    effective_consent: true,
    transmission_enabled: true,
    consent_sync_pending: false,
    delayed: false,
    transport: 'anonymous',
    pending_reports: 0,
    pending_occurrences: 0,
    pending_aggregates: 0,
    pending_aggregate_occurrences: 0,
    permanently_rejected_reports: 0,
    gaps: [],
  };
  await page.route('**/api/diagnostics/health', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(health),
  }));
  await page.goto(`${BASE}/support?tab=diagnostics`);
  await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toBeVisible();
  await expect(page.getByTestId('diagnostics-health')).toContainText('Reporting route: anonymous counts');

  health = { ...health, transmission_enabled: false, transport: 'disabled' };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Automatic reporting is off', { exact: false })).toBeVisible();
  await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toHaveCount(0);

  health = { ...health, transmission_enabled: true, consent_sync_pending: true, transport: 'anonymous' };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toHaveCount(0);

  health = { ...health, effective_consent: false, consent_sync_pending: false };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Automatic reporting is off', { exact: false })).toBeVisible();
  await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toHaveCount(0);

  health = { ...health, effective_consent: true, transmission_enabled: true, transport: { toString: null } };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('diagnostics-health')).toHaveCount(0);
});

test('a settings read that started before an opt-out cannot put the switch back on', async ({ page }) => {
  const token = getE2eToken();
  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  let markReadFetched = () => {};
  let markReadDelivered = () => {};
  let releaseRead = () => {};
  const readFetched = new Promise<void>((resolve) => { markReadFetched = resolve; });
  const readDelivered = new Promise<void>((resolve) => { markReadDelivered = resolve; });
  const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });

  try {
    await loginAs(page, 'owner@flo.local');
    await page.goto(`${BASE}/support?tab=diagnostics`);

    const transmission = page.getByRole('switch', { name: 'Send diagnostics automatically' });
    await expect(transmission, 'the initial setting read enables the switch').toBeEnabled();
    await expect(transmission).toHaveAttribute('aria-checked', 'true');

    // Hold a refresh response after reading the old value, then save before it arrives.
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const response = await route.fetch();
      markReadFetched();
      await readRelease;
      await route.fulfill({ response });
      markReadDelivered();
    });

    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.click();
    await readFetched;
    await transmission.click();
    await expect(transmission, 'the save is reflected in the switch').toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();

    releaseRead();
    await readDelivered;
    await expect(refresh, 'the delayed refresh has been applied').toBeEnabled();
    await expect(transmission, 'a stale read must not put the switch back on').toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();
  } finally {
    releaseRead();
    await page.unroute('**/api/settings');
    await setTransmission('true');
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
    await expect(transmission).toHaveAttribute('aria-checked', 'false');

    // The save already set the switch, so asserting it after the refresh would
    // prove nothing: the server is changed out of band instead.
    expect((await setTransmission('true')).status(), 'the server value is changed directly').toBe(200);
    await expect(transmission, 'precondition: the screen still shows the saved value').toHaveAttribute('aria-checked', 'false');

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      transmission,
      'the refresh applied its own response rather than leaving the earlier state',
    ).toHaveAttribute('aria-checked', 'true');
    const health = await page.request.get(`${BASE}/api/diagnostics/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const healthState = await health.json();
    if (healthState.consent_sync_pending) {
      await expect(page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false })).toBeVisible();
    }
  } finally {
    await setTransmission('true');
  }
});

test('an operator without the settings permission can read diagnostics but not change them', async ({ page }) => {
  // A server holds support.use but not settings.manage, which both destructive
  // endpoints enforce.
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

test('a manager with no confirmed consent state sees a neutral hint and disabled control', async ({ page }) => {
  // A configurable settings.view can be denied independently of settings.manage,
  // so the value can be refused while transmission is on underneath.
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const setTransmission = (value: string) => page.request.put(`${BASE}/api/settings/diagnostics_transmission_enabled`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  try {
    expect((await setTransmission('true')).status(), 'precondition: the manager can change the setting').toBe(200);
    await loginAs(page, 'manager@flo.local');
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'permission_denied' }),
      });
    });
    await page.route('**/api/diagnostics/health', (route) => route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'permission_denied' }),
    }));
    const settingsRead = page.waitForResponse((response) => (
      response.url().endsWith('/api/settings') && response.request().method() === 'GET'
    ));
    await page.goto(`${BASE}/support?tab=diagnostics`);
    await expect(page.getByRole('heading', { name: DIAGNOSTICS_TAB })).toBeVisible();
    await settingsRead;

    // A refused read must not take the failures and the bundle down with it.
    await expect(page.getByTestId('diagnostics-bundle-preview'), 'the bundle is still readable').toBeVisible();
    await expect(
      page.getByText('Automatic reporting is enabled by both privacy controls', { exact: false }),
      'an unreadable setting must not become a claim that reporting is enabled',
    ).toHaveCount(0);
    await expect(
      page.getByText('Reporting permission or delivery state has not been confirmed yet.', { exact: true }),
      'the wording that asserts neither state is used instead',
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Send diagnostics automatically' }),
      'a manager cannot toggle a value that the server did not confirm',
    ).toBeDisabled();
  } finally {
    await page.unroute('**/api/settings');
    await page.unroute('**/api/diagnostics/health');
    await setTransmission('true');
  }
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

test('a ticket retry reuses its exact payload and IDs until the operator edits it', async ({ page }) => {
  await loginAs(page, 'owner@flo.local');
  const submissions: Array<Record<string, unknown>> = [];
  await page.route('**/api/support-ticket', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    submissions.push(payload);
    if (submissions.length < 3) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary failure' }) });
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ client_ticket_id: payload.client_ticket_id }),
    });
  });

  await page.goto(`${BASE}/support`);
  await page.locator('#support-subject').fill('Printer trouble');
  await page.locator('#support-message').fill('The receipt printer stopped.');
  await page.evaluate(() => localStorage.setItem('e2e-log-tail', 'first safe test log snapshot'));
  await page.evaluate(() => {
    window.electronAPI = {
      getLogTail: async () => ({ text: localStorage.getItem('e2e-log-tail') || '' }),
    } as typeof window.electronAPI;
  });
  const submit = page.getByRole('button', { name: 'Send support request' });
  await submit.click();
  await expect(page.getByRole('status')).toContainText('Could not queue the support request');

  await page.evaluate(() => localStorage.setItem('e2e-log-tail', 'a newer log snapshot'));
  await submit.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1].log_tail).toBe('first safe test log snapshot');

  await page.locator('#support-message').fill('I have added the time it happened.');
  await submit.click();
  await expect.poll(() => submissions.length).toBe(3);
  expect(submissions[2].client_ticket_id).not.toBe(submissions[1].client_ticket_id);
  expect(submissions[2].correlation_id).not.toBe(submissions[1].correlation_id);
  expect(submissions[2].message).toBe('I have added the time it happened.');
});
