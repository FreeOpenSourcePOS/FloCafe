import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

// Production allows 120 GET /api/settings/:key per minute per IP
// (settingsReadRateLimit in main/routes/settings.ts). A single settings page load
// issues roughly twenty of them, so the whole suite - one server, one client IP -
// exhausts the production budget and starts 429ing its own page loads. A throttled
// read fails a settings tab hydration, and Save Changes then writes nothing at all.
// tests/e2e-server.cjs raises the read limit so no test can starve another.
const PRODUCTION_READ_LIMIT = 120;
const BURST_TOTAL = PRODUCTION_READ_LIMIT + 20;
const BATCH = 20;

const authHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });

let originalBusinessPhone = '';

// The whole suite shares one seeded database, so hand the store phone back or the next
// spec inherits this one's value. Registered here so it still runs when the test below
// fails partway.
test.afterAll(async ({ request }) => {
  await request.put(`${BASE}/api/settings/business`, {
    headers: authHeaders(),
    data: { business_phone: originalBusinessPhone },
  });
});

// Sent in small batches rather than all at once: opening a couple of hundred sockets
// at the same moment is needless load on the very server under test.
async function exceedProductionReadBudget(page: import('@playwright/test').Page): Promise<number[]> {
  const statuses: number[] = [];
  for (let sent = 0; sent < BURST_TOTAL; sent += BATCH) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(BATCH, BURST_TOTAL - sent) }, () =>
        page.request.get(`${BASE}/api/settings/theme_mode`, { headers: authHeaders() }).then((response) => response.status()),
      ),
    );
    statuses.push(...batch);
  }
  return statuses;
}

test('E2E settings reads are never throttled by the production per-IP read limit', async ({ page }) => {
  const statuses = await exceedProductionReadBudget(page);
  expect(statuses.filter((status) => status === 429)).toEqual([]);
});

test('Settings save still persists once the production read budget is spent', async ({ page }) => {
  await exceedProductionReadBudget(page);

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15000 });

  await page.goto(`${BASE}/settings`);
  const phoneInput = page.locator('div:has(> label:has-text("Phone")) input').first();
  await expect(phoneInput).toBeVisible();

  const business = await (await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders() })).json();
  originalBusinessPhone = business.business_phone || '';

  await phoneInput.fill('0898765432');
  const businessSave = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/settings/business' && response.request().method() === 'PUT';
  });
  await page.getByRole('button', { name: /Save Changes/i }).click();

  const saved = await (await businessSave).json();
  expect(saved.business_phone).toBe('+66898765432');
});
