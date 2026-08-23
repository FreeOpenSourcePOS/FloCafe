import { Page, expect } from '@playwright/test';
import * as crypto from 'crypto';
import { E2E_BASE_URL } from './urls';

export const E2E_JWT_SECRET = process.env.JWT_SECRET || 'e2e-test-secret';
export const E2E_PASSWORD = process.env.E2E_PASSWORD || 'E2ePass123!';

function base64Url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/**
 * Generates an authoritative test JWT for E2E setup and teardown tasks
 * without requiring UI interaction or hardcoded network login requests.
 */
export function getE2eToken(
  userId = 'e2e-owner',
  email = 'owner@flo.local',
  role = 'owner',
): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      userId,
      email,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const signature = base64Url(
    crypto.createHmac('sha256', E2E_JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

/**
 * Sets the active tenant language on both backend API and frontend local storage,
 * asserting that the API update succeeds. Guarantees that teardown never silently
 * leaves the shared database with contaminated state.
 */
export async function setLanguage(
  page: Page,
  value: string,
  base = E2E_BASE_URL,
): Promise<void> {
  const token =
    (await page.evaluate(() => localStorage.getItem('token')).catch(() => null)) ||
    getE2eToken();

  const res = await page.request.put(`${base}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  expect(
    res.ok(),
    `setting language=${value} on ${base} must succeed (got status ${res.status()})`,
  ).toBeTruthy();

  await page.evaluate((lang) => {
    try {
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: lang };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    } catch {}
  }, value).catch(() => {});
}
