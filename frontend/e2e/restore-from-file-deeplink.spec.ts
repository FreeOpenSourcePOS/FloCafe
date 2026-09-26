import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { injectElectronFixture } from './helpers/electron-fixture';

/**
 * The application menu opens the restore control through a ?action= deep link.
 * That parameter has to be consumed exactly once, or two things go wrong for the
 * operator: a finished restore reloads the page still carrying the parameter and
 * immediately asks for another file, and a cancelled picker leaves the parameter
 * armed so the next menu click changes nothing and appears to do nothing.
 */

async function signInAsOwner(page: Page) {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders|dashboard)/, { timeout: 20000 });
}

function pickerCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__floPickerCalls ?? -1);
}

test.describe('restore-from-file deep link is consumed once', () => {
  test('a finished restore does not reopen the picker after the page reloads', async ({ page }) => {
    await injectElectronFixture(page, { platform: 'win32' });
    await signInAsOwner(page);

    await page.goto(`${BASE}/settings?tab=data&action=restore-from-file`);
    await expect.poll(() => pickerCalls(page)).toBe(1);

    // The parameter is consumed before the work runs, so the address no longer
    // arms the action and a reload cannot re-open the picker.
    await expect(page).not.toHaveURL(/action=restore-from-file/);
    expect(await pickerCalls(page)).toBe(1);

    // After a reload the counter starts at zero again, so zero means the
    // restored page did not re-arm the action and asked for no further file.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).not.toHaveURL(/action=restore-from-file/);
    expect(await pickerCalls(page)).toBe(0);
  });

  test('cancelling the picker leaves the menu item able to fire again', async ({ page }) => {
    await injectElectronFixture(page, { platform: 'win32' });
    await signInAsOwner(page);

    await page.goto(`${BASE}/settings?tab=data&action=restore-from-file`);
    await expect.poll(() => pickerCalls(page)).toBe(1);
    await expect(page).not.toHaveURL(/action=restore-from-file/);

    // Second menu click. The first visit released the address, so this one
    // actually reaches the action and asks for a file again instead of being
    // swallowed as a no-op push of a URL that never changed.
    await page.goto(`${BASE}/settings?tab=data&action=restore-from-file`);
    await expect.poll(() => pickerCalls(page)).toBe(1);
  });
});
