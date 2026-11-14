import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

interface PromptRouteOptions {
  cloudDeletionBlocked?: boolean;
  consentStatus?: number;
  consentBody?: Record<string, unknown>;
  transmissionStatus?: number;
  transmissionBody?: Record<string, unknown>;
}

async function loginAsOwner(page: Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
}

async function setupDiagnosticsPromptRoutes(page: Page, options: PromptRouteOptions = {}) {
  const {
    cloudDeletionBlocked = false,
    consentStatus = 200,
    consentBody = { setting: { key: 'diagnostics_consent', value: 'true' } },
    transmissionStatus = 200,
    transmissionBody = { setting: { key: 'diagnostics_transmission_enabled', value: 'true' } },
  } = options;

  const callOrder: string[] = [];
  let recordCalls = false;

  await page.route('**/api/settings/diagnostics-prompt', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: false,
          dismissed: false,
          cloud_deletion_blocked: cloudDeletionBlocked,
          prompt_count: 0,
          last_asked_at: null,
          problems_since: 2,
        }),
      });
      return;
    }
    const payload = route.request().postDataJSON() as { event?: string };
    if (recordCalls) {
      callOrder.push(`POST /api/settings/diagnostics-prompt:${payload?.event ?? ''}`);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: false,
        dismissed: false,
        cloud_deletion_blocked: cloudDeletionBlocked,
        prompt_count: 1,
        last_asked_at: new Date().toISOString(),
        problems_since: 0,
      }),
    });
  });

  await page.route('**/api/settings/diagnostics_consent', async (route) => {
    if (route.request().method() === 'PUT') {
      if (recordCalls) callOrder.push('PUT /api/settings/diagnostics_consent');
      await route.fulfill({
        status: consentStatus,
        contentType: 'application/json',
        body: JSON.stringify(consentBody),
      });
      return;
    }
    await route.continue();
  });

  await page.route('**/api/settings/diagnostics_transmission_enabled', async (route) => {
    if (route.request().method() === 'PUT') {
      if (recordCalls) callOrder.push('PUT /api/settings/diagnostics_transmission_enabled');
      await route.fulfill({
        status: transmissionStatus,
        contentType: 'application/json',
        body: JSON.stringify(transmissionBody),
      });
      return;
    }
    await route.continue();
  });

  return {
    callOrder,
    startRecording: () => {
      recordCalls = true;
    },
  };
}

async function openPromptOnSupport(page: Page) {
  await loginAsOwner(page);
  const shownResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/settings/diagnostics-prompt') &&
      response.request().method() === 'POST',
  );
  await page.goto(`${BASE}/support`);
  await expect(page.getByTestId('diagnostics-prompt')).toBeVisible();
  await shownResponse;
}

test('suppresses diagnostics prompt and shown event when cloud deletion blocks consent', async ({
  page,
}) => {
  const tracker = await setupDiagnosticsPromptRoutes(page, { cloudDeletionBlocked: true });
  tracker.startRecording();

  await loginAsOwner(page);
  const promptStateRead = page.waitForResponse(
    (response) =>
      response.url().includes('/api/settings/diagnostics-prompt') &&
      response.request().method() === 'GET',
  );
  await page.goto(`${BASE}/support`);
  await promptStateRead;
  await expect(page.getByRole('tab', { name: 'Submit Ticket' })).toBeVisible();
  await expect(page.getByTestId('diagnostics-prompt')).toHaveCount(0);
  expect(tracker.callOrder).toEqual([]);
});

test('persists consent and transmission before posting accepted', async ({ page }) => {
  const tracker = await setupDiagnosticsPromptRoutes(page);
  await openPromptOnSupport(page);

  tracker.startRecording();
  await page.getByTestId('diagnostics-prompt-send').click();
  await expect(page.getByTestId('diagnostics-prompt')).toHaveCount(0);
  await expect
    .poll(() => tracker.callOrder)
    .toEqual([
      'PUT /api/settings/diagnostics_consent',
      'PUT /api/settings/diagnostics_transmission_enabled',
      'POST /api/settings/diagnostics-prompt:accepted',
    ]);
});

test('closes without posting accepted or showing error toast on 409 cloud_deletion_pending', async ({
  page,
}) => {
  const tracker = await setupDiagnosticsPromptRoutes(page, {
    consentStatus: 409,
    consentBody: { error: 'cloud_deletion_pending' },
  });
  await openPromptOnSupport(page);

  tracker.startRecording();
  await page.getByTestId('diagnostics-prompt-send').click();
  await expect(page.getByTestId('diagnostics-prompt')).toHaveCount(0);
  await expect(page.getByText("Couldn't save. Try again.")).toHaveCount(0);
  expect(tracker.callOrder).toEqual(['PUT /api/settings/diagnostics_consent']);
});

test('keeps prompt open and skips accepted when saving transmission fails', async ({ page }) => {
  const tracker = await setupDiagnosticsPromptRoutes(page, {
    transmissionStatus: 500,
    transmissionBody: { error: 'internal error' },
  });
  await openPromptOnSupport(page);

  tracker.startRecording();
  await page.getByTestId('diagnostics-prompt-send').click();
  await expect(page.getByText("Couldn't save. Try again.")).toBeVisible();
  await expect(page.getByTestId('diagnostics-prompt')).toBeVisible();
  expect(tracker.callOrder).toEqual([
    'PUT /api/settings/diagnostics_consent',
    'PUT /api/settings/diagnostics_transmission_enabled',
  ]);
});
