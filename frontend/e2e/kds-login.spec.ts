import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';

test('KDS standalone logs in, defaults to Kanban, persists view selection, and restores its session', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form')).toBeVisible();
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  // Body pointer-events must never be stuck at 'none' on first login, and default view is Kanban.
  const bodyPointerEvents = await page.evaluate(() => document.body.style.pointerEvents);
  expect(bodyPointerEvents).not.toBe('none');
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Switching to Tabs and back to Kanban works on the first authenticated render and persists across reloads.
  await page.getByRole('button', { name: 'Tabs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tabs', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tabs', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByTestId('kds-login-form')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByTestId('kds-login-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    pageErrors.filter((error) => /Minified React error #418|Hydration failed/i.test(error.message)),
  ).toHaveLength(0);
});

test('Logging out from sidebar dropdown and logging into KDS keeps body interactive without refresh', async ({
  page,
}) => {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.locator('input[type="email"]').fill('manager@flo.local');
  await page.locator('input[type="password"]').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/auth\/login/);

  // Open sidebar user dropdown and trigger Logout -> ConfirmDialog
  const sidebarFooterButton = page
    .locator('[data-sidebar="footer"] [data-sidebar="menu-button"]')
    .last();
  await sidebarFooterButton.click();
  await page.getByRole('menuitem', { name: /log\s*out/i }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /confirm|log\s*out/i })
    .click();
  await expect(page).toHaveURL(/\/auth\/login/);

  const pointerEventsAfterLogout = await page.evaluate(() => document.body.style.pointerEvents);
  expect(pointerEventsAfterLogout).not.toBe('none');

  // Without refreshing, log back in on the same page to prove inputs/buttons are immediately clickable
  await page.locator('input[type="email"]').fill('manager@flo.local');
  await page.locator('input[type="password"]').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/auth\/login/);

  // Now test KDS logout ConfirmDialog -> re-login without refreshing
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form')).toBeVisible();
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  await page.locator('button[title="Logout"]').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /confirm|log\s*out/i })
    .click();
  await expect(page.getByTestId('kds-login-form')).toBeVisible();

  const pointerEventsAfterKdsLogout = await page.evaluate(() => document.body.style.pointerEvents);
  expect(pointerEventsAfterKdsLogout).not.toBe('none');

  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  const pointerEventsOnKds = await page.evaluate(() => document.body.style.pointerEvents);
  expect(pointerEventsOnKds).not.toBe('none');
  await page.getByRole('button', { name: 'Tabs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tabs', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
