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

export type E2EOrdersLayout = 'split' | 'cards';

/**
 * Token used by the layout helpers: an explicit override wins, then the token
 * the page already holds, then the E2E owner token. Restricted roles that
 * cannot read or write settings need an explicit owner token.
 */
async function ordersLayoutToken(page: Page, token?: string): Promise<string> {
  if (token) return token;
  return (await page.evaluate(() => localStorage.getItem('token')).catch(() => null)) || getE2eToken();
}

/**
 * Reads the tenant's Orders screen layout (`orders_layout`).
 *
 * Returns the backend default ('split') when the tenant never chose one, so a
 * caller can capture "what this tenant had before I pinned it" and put it back.
 */
export async function readOrdersLayout(
  page: Page,
  base = E2E_BASE_URL,
  token?: string,
): Promise<E2EOrdersLayout> {
  const authToken = await ordersLayoutToken(page, token);
  const res = await page.request.get(`${base}/api/settings/orders_layout`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(
    res.ok(),
    `reading orders_layout on ${base} must succeed (got status ${res.status()})`,
  ).toBeTruthy();
  const { value } = (await res.json()).setting as { value: string };
  return value === 'cards' ? 'cards' : 'split';
}

/**
 * Pins the Orders screen layout for the spec that calls it.
 *
 * `orders_layout` defaults to 'split' — the master/detail screen introduced in
 * #639 — and the card-grid specs predate that default, so they declare the mode
 * they drive rather than inheriting whatever the default happens to be. The
 * Orders page reads the setting on mount, so pin it BEFORE the first
 * `goto('/orders')`.
 *
 * The e2e server shares one database across the whole suite, so every pin must
 * be undone with `test.afterEach`. See frontend/e2e/orders-master-detail.spec.ts
 * for the split-default coverage that runs when no pin is applied.
 */
export async function setOrdersLayout(
  page: Page,
  value: E2EOrdersLayout,
  base = E2E_BASE_URL,
  token?: string,
): Promise<void> {
  const authToken = await ordersLayoutToken(page, token);
  const res = await page.request.put(`${base}/api/settings/orders_layout`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { value },
  });
  expect(
    res.ok(),
    `setting orders_layout=${value} on ${base} must succeed (got status ${res.status()})`,
  ).toBeTruthy();
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
