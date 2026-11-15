import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, loginWithPassword } from './helpers/test-auth';

test.describe.configure({ mode: 'serial' });

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || '';

let priorThemeMode = 'light';
let priorScheduledEnabled = 'false';
const createdOrderIds: number[] = [];

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, filename),
    fullPage: true,
    timeout: 15_000,
  });
}

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

async function assertThemedInput(
  page: Page,
  input: Locator,
  expectedTheme: 'dark' | 'light',
  expectedIconClass: 'lucide-calendar-days' | 'lucide-clock' = 'lucide-calendar-days',
): Promise<void> {
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
      inputColor: cs.color,
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

  expect(styles.isDark).toBe(expectedTheme === 'dark');
  expect(styles.colorScheme).toBe(expectedTheme);
  expect(styles.hasHideOpacityClass).toBe(true);
  expect(styles.hasHidePointerClass).toBe(true);
  expect(styles.hasIndicatorOpacityRule).toBe(true);
  expect(styles.hasIndicatorPointerRule).toBe(true);
  expect(styles.hasButton).toBe(true);
  expect(styles.hasSvg).toBe(true);
  expect(styles.svgClass).toContain(expectedIconClass);
  expect(styles.buttonColor).not.toBe('');
  if (expectedTheme === 'dark') {
    expect(styles.buttonColor).not.toBe('rgb(0, 0, 0)');
    expect(styles.buttonColor).not.toBe('oklch(0 0 0)');
  }
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
  await input.evaluate((el) => {
    delete (el as Partial<HTMLInputElement>).showPicker;
  });
}

function futureBangkokWallClock(minutesAhead: number): string {
  const target = new Date(Date.now() + minutesAhead * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(target);
  const byType: Record<string, string> = {};
  for (const part of parts) byType[part.type] = part.value;
  const hour = byType.hour === '24' ? '00' : byType.hour;
  return `${byType.year}-${byType.month}-${byType.day}T${hour}:${byType.minute}`;
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
  const cleanupErrors: string[] = [];

  for (const orderId of createdOrderIds) {
    try {
      const checkRes = await request.get(`${BASE}/api/orders/${orderId}`, { headers });
      if (checkRes.status() === 404) continue;
      if (!checkRes.ok()) {
        cleanupErrors.push(
          `inspect order ${orderId}: HTTP ${checkRes.status()} ${await checkRes.text().catch(() => '')}`,
        );
        continue;
      }
      const order = (await checkRes.json()).order as
        | { status?: string; release_status?: string; bill?: { payment_status?: string } }
        | undefined;
      if (!order || order.status === 'completed' || order.status === 'cancelled') continue;

      if (order.bill?.payment_status === 'paid') {
        if (order.release_status !== 'released') {
          const releaseRes = await request.post(`${BASE}/api/orders/${orderId}/release`, {
            headers,
          });
          if (!releaseRes.ok()) {
            cleanupErrors.push(
              `release paid order ${orderId}: HTTP ${releaseRes.status()} ${await releaseRes.text().catch(() => '')}`,
            );
            continue;
          }
        }
        const completeRes = await request.patch(`${BASE}/api/orders/${orderId}/status`, {
          headers,
          data: { status: 'completed' },
        });
        if (!completeRes.ok()) {
          cleanupErrors.push(
            `complete paid order ${orderId}: HTTP ${completeRes.status()} ${await completeRes.text().catch(() => '')}`,
          );
        }
        continue;
      }

      const res = await request.patch(`${BASE}/api/orders/${orderId}/status`, {
        headers,
        data: { status: 'cancelled', reason: 'E2E cleanup' },
      });
      if (!res.ok()) {
        cleanupErrors.push(
          `cancel order ${orderId}: HTTP ${res.status()} ${await res.text().catch(() => '')}`,
        );
      }
    } catch (err) {
      cleanupErrors.push(`cleanup order ${orderId}: ${String(err)}`);
    }
  }

  for (const [key, value] of [
    ['theme_mode', priorThemeMode],
    ['scheduled_orders_enabled', priorScheduledEnabled],
  ] as const) {
    try {
      const res = await request.put(`${BASE}/api/settings/${key}`, {
        headers,
        data: { value },
      });
      if (!res.ok()) {
        cleanupErrors.push(
          `restore ${key}=${value}: HTTP ${res.status()} ${await res.text().catch(() => '')}`,
        );
      }
    } catch (err) {
      cleanupErrors.push(`restore ${key}=${value}: ${String(err)}`);
    }
  }

  expect(cleanupErrors, `E2E afterAll cleanup errors:\n${cleanupErrors.join('\n')}`).toEqual([]);
});

test('dark mode themes Expenses filter and form calendar inputs without breaking fill() and reverts cleanly in light mode', async ({
  page,
}) => {
  await loginWithPassword(page, 'owner@flo.local');
  await setThemeMode(page, 'dark');

  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20_000 });

  const fromInput = page.getByTestId('expense-filter-from');
  const toInput = page.getByTestId('expense-filter-to');

  await assertThemedInput(page, fromInput, 'dark');
  await assertThemedInput(page, toInput, 'dark');

  await fromInput.fill('2026-11-01');
  await expect(fromInput).toHaveValue('2026-11-01');
  await captureEvidence(page, 'expenses-dark-filters.png');

  await fromInput.locator('xpath=following-sibling::button[1]').click();
  await page.keyboard.press('Escape');

  await page.getByTestId('expense-add').click();
  const incurredInput = page.getByTestId('expense-form-incurred-on');
  await assertThemedInput(page, incurredInput, 'dark');
  await incurredInput.fill('2026-11-10');
  await expect(incurredInput).toHaveValue('2026-11-10');
  await captureEvidence(page, 'expenses-dark-form.png');

  // Adversarial: showPicker throwing falls back to focus() without uncaught errors
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  await incurredInput.evaluate((el) => {
    (el as HTMLInputElement).showPicker = () => {
      throw new Error('showPicker unsupported');
    };
  });
  await incurredInput.locator('xpath=following-sibling::button[1]').click();
  const isFocused = await incurredInput.evaluate((el) => document.activeElement === el);
  expect(isFocused).toBe(true);
  expect(pageErrors).toEqual([]);
  await incurredInput.evaluate((el) => {
    delete (el as Partial<HTMLInputElement>).showPicker;
  });

  // Switch back to light mode and confirm colorScheme reverts to light
  await setThemeMode(page, 'light');
  await page.reload();
  await expect(page.getByTestId('expense-filter-from')).toBeVisible({ timeout: 20_000 });
  const lightFrom = page.getByTestId('expense-filter-from');
  await assertThemedInput(page, lightFrom, 'light');
  await captureEvidence(page, 'expenses-light-filters.png');
});

test('dark mode themes Dashboard day, month, range pickers and CashCloseModal business date', async ({
  page,
}) => {
  await loginWithPassword(page, 'owner@flo.local');
  await setThemeMode(page, 'dark');

  await page.goto(`${BASE}/dashboard`);
  const dayInput = page.locator('input[type="date"][aria-label="Select date"]');
  await assertThemedInput(page, dayInput, 'dark');
  await captureEvidence(page, 'dashboard-dark-day.png');

  await page
    .getByRole('group', { name: 'Dashboard period' })
    .getByRole('button', { name: 'Month' })
    .click();
  const monthInput = page.locator('input[type="month"][aria-label="Select month"]');
  await assertThemedInput(page, monthInput, 'dark');
  await captureEvidence(page, 'dashboard-dark-month.png');

  await page
    .getByRole('group', { name: 'Dashboard period' })
    .getByRole('button', { name: 'Range' })
    .click();
  const rangeStart = page.locator('input[type="date"][aria-label="Period start"]');
  const rangeEnd = page.locator('input[type="date"][aria-label="Period end"]');
  await assertThemedInput(page, rangeStart, 'dark');
  await assertThemedInput(page, rangeEnd, 'dark');
  await captureEvidence(page, 'dashboard-dark-range.png');

  // CashCloseModal business date input
  await page.getByRole('button', { name: 'Close day' }).click();
  const cashCloseDate = page.locator('#business-date');
  await assertThemedInput(page, cashCloseDate, 'dark');
  await captureEvidence(page, 'dashboard-dark-cash-close.png');

  // Light mode verification
  await setThemeMode(page, 'light');
  await page.reload();
  await assertThemedInput(
    page,
    page.locator('input[type="date"][aria-label="Select date"]'),
    'light',
  );
  await captureEvidence(page, 'dashboard-light-day.png');
});

test('dark mode themes POS OrderDetailsDrawer, ScheduledOrdersDrawer reschedule, and CashDrawerMovementModal', async ({
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

  // 1. OrderDetailsDrawer datetime-local input
  const cartShell = page.getByTestId('cart-shell');
  await page.getByTestId('pos-product-card').first().click();
  await cartShell.getByRole('button', { name: 'Takeaway', exact: true }).click();
  await expect(cartShell.getByTestId('pos-order-details-summary')).toBeVisible();
  await cartShell.getByTestId('pos-order-details-summary').click();

  const detailsDrawer = page.getByTestId('pos-order-details-drawer');
  await expect(detailsDrawer).toBeVisible();

  const scheduleInput = detailsDrawer.getByTestId('pos-send-to-kitchen-input');
  await assertThemedInput(page, scheduleInput, 'dark');
  const futureWall = futureBangkokWallClock(90);
  await scheduleInput.fill(futureWall);
  await expect(scheduleInput).toHaveValue(futureWall);
  await captureEvidence(page, 'pos-dark-order-details-drawer.png');
  await scheduleInput.locator('xpath=following-sibling::button[1]').click();
  await page.keyboard.press('Escape');
  await detailsDrawer.getByTestId('pos-order-details-done-btn').click();
  await expect(detailsDrawer).toHaveCount(0);

  // 2. Submit scheduled order (hold/unpaid or confirm payment) so ScheduledOrdersDrawer has a real order
  const createOrderPromise = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return res.request().method() === 'POST' && url.pathname === '/api/orders';
  });
  await cartShell.getByRole('button', { name: 'Place Order' }).click();
  await expect(page.getByRole('button', { name: /Confirm Payment/ })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: /Confirm Payment/ }).click();
  const createOrderRes = await createOrderPromise;
  expect(createOrderRes.status()).toBe(201);
  const createdOrderId = Number((await createOrderRes.json()).order.id);
  createdOrderIds.push(createdOrderId);
  await page
    .getByTestId('prepaid-checkout-modal')
    .getByRole('button', { name: 'Done', exact: true })
    .click();

  // Open ScheduledOrdersDrawer and enter Reschedule mode
  await page.getByTestId('pos-scheduled-orders-btn').click();
  const scheduledDrawer = page.getByTestId('scheduled-orders-drawer');
  await expect(scheduledDrawer).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`scheduled-reschedule-btn-${createdOrderId}`).click();
  const rescheduleInput = page.getByTestId(`scheduled-reschedule-input-${createdOrderId}`);
  await assertThemedInput(page, rescheduleInput, 'dark');
  const rescheduledWall = futureBangkokWallClock(150);
  await rescheduleInput.fill(rescheduledWall);
  await expect(rescheduleInput).toHaveValue(rescheduledWall);
  await captureEvidence(page, 'pos-dark-scheduled-reschedule.png');
  await page.getByTestId(`scheduled-reschedule-save-${createdOrderId}`).click();
  await expect(page.getByTestId(`scheduled-reschedule-panel-${createdOrderId}`)).toHaveCount(0);
  await scheduledDrawer.getByTestId('close-scheduled-drawer-btn').click();

  // 3. CashDrawerMovementModal business date input
  await page.mouse.move(0, 0);
  await expect(page.locator('.flo-toast-card')).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Cash movement' }).click();
  const movementDateInput = page.locator('#movement-business-date');
  await assertThemedInput(page, movementDateInput, 'dark');
  await captureEvidence(page, 'pos-dark-cash-movement.png');
});

test('dark mode themes WhatsApp quiet-hours time inputs with Clock icon and light mode reverts', async ({
  page,
}) => {
  await loginWithPassword(page, 'owner@flo.local');
  await setThemeMode(page, 'dark');

  await page.goto(`${BASE}/whatsapp`);
  const automationTab = page.getByRole('tab', { name: /Templates & Rules/i });
  await expect(automationTab).toBeVisible({ timeout: 20_000 });
  await automationTab.click();

  const quietStart = page.locator('#wa-quiet-hours-start');
  const quietEnd = page.locator('#wa-quiet-hours-end');
  await assertThemedInput(page, quietStart, 'dark', 'lucide-clock');
  await assertThemedInput(page, quietEnd, 'dark', 'lucide-clock');
  await quietStart.fill('22:30');
  await expect(quietStart).toHaveValue('22:30');
  await captureEvidence(page, 'whatsapp-dark-quiet-hours.png');
  await quietStart.locator('xpath=following-sibling::button[1]').click();
  await page.keyboard.press('Escape');

  // Verify globals.css base color-scheme applies to all 5 temporal input types in dark & light
  const baseSchemes = await page.evaluate(() => {
    const types = ['date', 'datetime-local', 'month', 'week', 'time'];
    const readSchemes = () =>
      types.map((t) => {
        const el = document.createElement('input');
        el.type = t;
        document.body.appendChild(el);
        const scheme = getComputedStyle(el).colorScheme;
        el.remove();
        return { type: t, scheme };
      });
    const darkSchemes = readSchemes();
    document.documentElement.classList.remove('dark');
    const lightSchemes = readSchemes();
    document.documentElement.classList.add('dark');
    return { darkSchemes, lightSchemes };
  });
  for (const row of baseSchemes.darkSchemes) {
    expect(row.scheme, `dark base color-scheme for ${row.type}`).toBe('dark');
  }
  for (const row of baseSchemes.lightSchemes) {
    expect(row.scheme, `light base color-scheme for ${row.type}`).toBe('light');
  }

  await setThemeMode(page, 'light');
  await page.reload();
  await page.getByRole('tab', { name: /Templates & Rules/i }).click();
  await assertThemedInput(page, page.locator('#wa-quiet-hours-start'), 'light', 'lucide-clock');
  await captureEvidence(page, 'whatsapp-light-quiet-hours.png');
});
