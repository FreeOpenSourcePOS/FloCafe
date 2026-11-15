import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, loginWithPassword } from './helpers/test-auth';

test.describe.configure({ mode: 'serial' });

let priorThemeMode = 'light';
let priorScheduledEnabled = 'false';

async function getAuthHeaders(page: Page): Promise<Record<string, string>> {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  if (res.ok()) {
    const { access_token } = await res.json();
    return { Authorization: `Bearer ${access_token}` };
  }
  return { Authorization: `Bearer ${getE2eToken()}` };
}

async function setThemeMode(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const headers = await getAuthHeaders(page);
  const res = await page.request.put(`${BASE}/api/settings/theme_mode`, {
    headers,
    data: { value: mode },
  });
  expect(res.ok(), `setting theme_mode=${mode} must succeed`).toBeTruthy();
  await page
    .evaluate((next) => {
      try {
        localStorage.setItem('flo-theme-resolved', next);
        if (next === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      } catch {}
    }, mode)
    .catch(() => {});
}

async function assertThemedDarkInput(page: Page, input: Locator): Promise<void> {
  await expect(input).toBeVisible({ timeout: 15_000 });

  const styles = await input.evaluate((el) => {
    const inputEl = el as HTMLInputElement;
    const isDark = document.documentElement.classList.contains('dark');
    const cs = getComputedStyle(inputEl);
    const classList = Array.from(inputEl.classList);
    const matchingPseudoRules: string[] = [];
    const visitRules = (rules: CSSRuleList | undefined) => {
      if (!rules) return;
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule;
        if (
          styleRule.selectorText &&
          styleRule.selectorText.includes('::-webkit-calendar-picker-indicator')
        ) {
          matchingPseudoRules.push(styleRule.cssText);
        }
        const groupingRule = rule as CSSGroupingRule;
        if (groupingRule.cssRules && groupingRule.cssRules.length > 0) {
          visitRules(groupingRule.cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visitRules(sheet.cssRules);
      } catch {}
    }

    const button = inputEl.parentElement?.querySelector(
      'button[type="button"]',
    ) as HTMLButtonElement | null;
    const buttonCs = button ? getComputedStyle(button) : null;
    const svg = button?.querySelector('svg') ?? null;

    const inputRect = inputEl.getBoundingClientRect();
    const buttonRect = button ? button.getBoundingClientRect() : null;
    const centerCovered = buttonRect
      ? buttonRect.left <= inputRect.left + inputRect.width / 2 &&
        buttonRect.right >= inputRect.left + inputRect.width / 2
      : true;

    return {
      isDark,
      colorScheme: cs.colorScheme,
      hasHideOpacityClass: classList.includes('[&::-webkit-calendar-picker-indicator]:opacity-0'),
      hasHidePointerClass: classList.includes(
        '[&::-webkit-calendar-picker-indicator]:pointer-events-none',
      ),
      hasIndicatorOpacityRule: matchingPseudoRules.some((r) => /opacity:\s*0\b/.test(r)),
      hasIndicatorPointerRule: matchingPseudoRules.some((r) => /pointer-events:\s*none\b/.test(r)),
      hasButton: Boolean(button),
      buttonColor: buttonCs?.color ?? '',
      hasSvg: Boolean(svg),
      svgClass: svg?.getAttribute('class') ?? '',
      centerCovered,
    };
  });

  expect(styles.isDark).toBe(true);
  expect(styles.colorScheme).toBe('dark');
  expect(styles.hasHideOpacityClass).toBe(true);
  expect(styles.hasHidePointerClass).toBe(true);
  expect(styles.hasIndicatorOpacityRule).toBe(true);
  expect(styles.hasIndicatorPointerRule).toBe(true);
  expect(styles.hasButton).toBe(true);
  expect(styles.hasSvg).toBe(true);
  expect(styles.svgClass).toContain('lucide-calendar-days');
  expect(styles.buttonColor).not.toBe('');
  expect(styles.buttonColor).not.toBe('rgb(0, 0, 0)');
  expect(styles.centerCovered).toBe(false);

  // Clicking the custom button invokes native showPicker() on the underlying input
  await input.evaluate((el) => {
    const inputEl = el as HTMLInputElement;
    (window as unknown as { __floPickerSpyCalled?: boolean }).__floPickerSpyCalled = false;
    inputEl.showPicker = () => {
      (window as unknown as { __floPickerSpyCalled?: boolean }).__floPickerSpyCalled = true;
    };
  });
  await input.locator('xpath=following-sibling::button[1]').click();
  const pickerInvoked = await page.evaluate(
    () => (window as unknown as { __floPickerSpyCalled?: boolean }).__floPickerSpyCalled === true,
  );
  expect(pickerInvoked).toBe(true);
}

test.beforeAll(async ({ request }) => {
  const token = getE2eToken();
  const headers = { Authorization: `Bearer ${token}` };
  const themeRes = await request.get(`${BASE}/api/settings/theme_mode`, { headers });
  if (themeRes.ok()) {
    const val = (await themeRes.json())?.setting?.value;
    if (val === 'dark' || val === 'light' || val === 'system') priorThemeMode = val;
  }
  const schedRes = await request.get(`${BASE}/api/settings/scheduled_orders_enabled`, { headers });
  if (schedRes.ok()) {
    const val = (await schedRes.json())?.setting?.value;
    if (val === 'true' || val === 'false') priorScheduledEnabled = val;
  }
});

test.afterAll(async ({ request }) => {
  const token = getE2eToken();
  const headers = { Authorization: `Bearer ${token}` };
  await request.put(`${BASE}/api/settings/theme_mode`, {
    headers,
    data: { value: priorThemeMode },
  });
  await request.put(`${BASE}/api/settings/scheduled_orders_enabled`, {
    headers,
    data: { value: priorScheduledEnabled },
  });
});

test('dark mode themes Expenses filter and form calendar inputs without breaking fill()', async ({
  page,
}) => {
  await loginWithPassword(page, 'owner@flo.local');
  await setThemeMode(page, 'dark');

  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20_000 });

  const fromInput = page.getByTestId('expense-filter-from');
  const toInput = page.getByTestId('expense-filter-to');

  await assertThemedDarkInput(page, fromInput);
  await assertThemedDarkInput(page, toInput);

  await fromInput.fill('2026-11-01');
  await expect(fromInput).toHaveValue('2026-11-01');

  await page.getByTestId('expense-add').click();
  const incurredInput = page.getByTestId('expense-form-incurred-on');
  await assertThemedDarkInput(page, incurredInput);
  await incurredInput.fill('2026-11-10');
  await expect(incurredInput).toHaveValue('2026-11-10');

  // Switch back to light mode and confirm colorScheme reverts to light
  await setThemeMode(page, 'light');
  await page.reload();
  await expect(page.getByTestId('expense-filter-from')).toBeVisible({ timeout: 20_000 });
  const lightScheme = await page
    .getByTestId('expense-filter-from')
    .evaluate((el) => getComputedStyle(el).colorScheme);
  expect(lightScheme).toBe('light');
});

test('dark mode themes POS OrderDetailsDrawer datetime-local input without breaking fill()', async ({
  page,
}) => {
  await loginWithPassword(page, 'owner@flo.local');
  const headers = await getAuthHeaders(page);
  const enableRes = await page.request.put(`${BASE}/api/settings/scheduled_orders_enabled`, {
    headers,
    data: { value: 'true' },
  });
  expect(enableRes.ok()).toBeTruthy();

  await setThemeMode(page, 'dark');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible({ timeout: 20_000 });

  const cartShell = page.getByTestId('cart-shell');
  await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
  await expect(cartShell.getByTestId('pos-order-details-summary')).toBeVisible();
  await cartShell.getByTestId('pos-order-details-summary').click();

  const detailsDrawer = page.getByTestId('pos-order-details-drawer');
  await expect(detailsDrawer).toBeVisible();

  const scheduleInput = detailsDrawer.getByTestId('pos-send-to-kitchen-input');
  await assertThemedDarkInput(page, scheduleInput);
  await scheduleInput.fill('2030-01-15T10:30');
  await expect(scheduleInput).toHaveValue('2030-01-15T10:30');
});
