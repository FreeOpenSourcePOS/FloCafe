import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test('Settings search bar finds settings by keyword, switches tabs, and highlights target card', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('manager@flo.local');
  await page.getByLabel('Password').fill('E2ePass123!');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);

  const searchInput = page.getByTestId('settings-search-input');
  await expect(searchInput).toBeVisible();

  // Press '/' shortcut to focus the search bar when not typing in an input
  await page.locator('h1').click();
  await page.keyboard.press('/');
  await expect(searchInput).toBeFocused();

  // While editing a settings form field, '/' types into the field while Ctrl+K focuses search
  const storeNameInput = page
    .locator('[data-setting-section="store-details"] input[type="text"]')
    .first();
  await storeNameInput.click();
  await page.keyboard.press('/');
  await expect(storeNameInput).toBeFocused();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+k');
  await expect(searchInput).toBeFocused();

  // Broad query exposes aria-activedescendant and scrolls the active option into view on ArrowDown
  await searchInput.fill('a');
  const resultsList = page.getByTestId('settings-search-results');
  await expect(resultsList).toBeVisible();
  const firstActiveId = await searchInput.getAttribute('aria-activedescendant');
  expect(firstActiveId).toMatch(/^settings-search-option-/);
  for (let i = 0; i < 8; i += 1) {
    await searchInput.press('ArrowDown');
  }
  const nextActiveId = await searchInput.getAttribute('aria-activedescendant');
  expect(nextActiveId).toMatch(/^settings-search-option-/);
  expect(nextActiveId).not.toBe(firstActiveId);
  const scrollTopAfterArrows = await resultsList.evaluate((el) => el.scrollTop);
  expect(scrollTopAfterArrows).toBeGreaterThan(0);

  // Search by synonym keyword ("parcel" -> Charges & Surcharges on POS Workflow tab)
  await searchInput.fill('parcel');
  await expect(resultsList).toBeVisible();

  const chargesResult = page.getByTestId('settings-search-result-charges-surcharges');
  await expect(chargesResult).toBeVisible();
  await expect(chargesResult).toContainText('Charges & Surcharges');
  await expect(chargesResult).toContainText('Operations · POS Workflow');

  // Click result -> switches to POS Workflow tab, closes dropdown, highlights target card
  await chargesResult.click();
  await expect(page).toHaveURL(/\/settings\/?\?tab=pos$/);
  await expect(resultsList).toHaveCount(0);

  const chargesCard = page.locator('[data-setting-section="charges-surcharges"]');
  await expect(chargesCard).toBeVisible();
  await expect(chargesCard).toHaveClass(/ring-2/);
  await expect(chargesCard).toHaveClass(/ring-brand/);
  await expect(chargesCard).toHaveAttribute('data-setting-highlighted', 'true');

  // Search by hardware synonym ("58mm" -> Printers on Printers & Receipts tab) using Enter key
  await searchInput.fill('58mm');
  await expect(page.getByTestId('settings-search-result-printers-hardware')).toBeVisible();
  await searchInput.press('Enter');

  await expect(page).toHaveURL(/\/settings\/?\?tab=receipts-printers$/);
  const printersCard = page.locator('[data-setting-section="printers-hardware"]');
  await expect(printersCard).toBeVisible();
  await expect(printersCard).toHaveClass(/ring-2/);
  await expect(printersCard).toHaveAttribute('data-setting-highlighted', 'true');
});
