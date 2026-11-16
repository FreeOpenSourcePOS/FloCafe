import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setLanguage,
  setOrdersLayout,
  type E2EOrdersLayout,
} from './helpers/test-auth';

const MANAGER_TOKEN = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');

const DESKTOP_VIEWPORTS = [
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
] as const;

type RectSnapshot = {
  readoutTop: number;
  quickTenderTop: number;
  quickTenderHeight: number;
  keypadTop: number;
  keypadHeight: number;
  footerTop: number;
  footerHeight: number;
  ctaTop: number;
  ctaHeight: number;
  col1FooterTop?: number;
};

async function loginAndOpenPos(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

async function setBusinessSettings(
  page: Page,
  patch: {
    billing_type?: 'prepaid' | 'postpaid';
    tables_required?: boolean;
    card_transaction_id_required?: boolean;
  },
): Promise<{
  originalBusiness: Record<string, unknown>;
  originalCardRequired: string | null;
}> {
  const bizRes = await page.request.get(`${BASE}/api/settings/business`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
  });
  expect(bizRes.ok()).toBeTruthy();
  const originalBusiness = await bizRes.json();

  let originalCardRequired: string | null = null;
  if (patch.card_transaction_id_required !== undefined) {
    const cardRes = await page.request.get(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    });
    if (cardRes.ok()) {
      const cardData = await cardRes.json();
      originalCardRequired = String(cardData?.setting?.value ?? 'false');
    }
  }

  try {
    if (
      (patch.billing_type !== undefined && originalBusiness.billing_type !== patch.billing_type) ||
      (patch.tables_required !== undefined &&
        originalBusiness.tables_required !== patch.tables_required)
    ) {
      const putBiz = await page.request.put(`${BASE}/api/settings/business`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
        data: {
          ...originalBusiness,
          ...(patch.billing_type !== undefined ? { billing_type: patch.billing_type } : {}),
          ...(patch.tables_required !== undefined
            ? { tables_required: patch.tables_required }
            : {}),
        },
      });
      expect(putBiz.ok()).toBeTruthy();
    }

    if (patch.card_transaction_id_required !== undefined) {
      const putCard = await page.request.put(`${BASE}/api/settings/card_transaction_id_required`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
        data: { value: patch.card_transaction_id_required ? 'true' : 'false' },
      });
      expect(putCard.ok()).toBeTruthy();
    }
  } catch (error) {
    await restoreBusinessSettings(page, { originalBusiness, originalCardRequired }).catch(() => {});
    throw error;
  }

  return { originalBusiness, originalCardRequired };
}

async function restoreBusinessSettings(
  page: Page,
  saved: {
    originalBusiness: Record<string, unknown>;
    originalCardRequired: string | null;
  },
): Promise<void> {
  await page.request.put(`${BASE}/api/settings/business`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    data: saved.originalBusiness,
  });
  if (saved.originalCardRequired !== null) {
    await page.request.put(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      data: { value: saved.originalCardRequired },
    });
  }
}

async function createMultiLineOrderAndOpenPaymentModal(page: Page, lineCount = 20): Promise<void> {
  const prodRes = await page.request.get(`${BASE}/api/products`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
  });
  expect(prodRes.ok()).toBeTruthy();
  const prodData = await prodRes.json();
  const products = (prodData.products || prodData) as Array<{ id: number; name: string }>;
  expect(products.length).toBeGreaterThan(0);
  const prodId = products[0].id;

  const orderRes = await page.request.post(`${BASE}/api/orders`, {
    headers: {
      Authorization: `Bearer ${MANAGER_TOKEN}`,
      'Idempotency-Key': `geom-${Date.now()}-${Math.random()}`,
    },
    data: {
      type: 'takeaway',
      items: Array.from({ length: lineCount }, (_, idx) => ({
        product_id: prodId,
        quantity: 1,
        notes: `Line ${idx + 1}`,
      })),
    },
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();

  await page.goto(`${BASE}/orders`);
  const masterRow = page.getByRole('button').filter({ hasText: order.order_number }).first();
  await expect(masterRow).toBeVisible({ timeout: 10000 });
  await masterRow.click();
  await page
    .getByRole('button', { name: /Checkout|Take Payment/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible({ timeout: 10000 });
}

async function assertColumnAndStationGeometry(modalShell: Locator): Promise<RectSnapshot> {
  const shellMetrics = await modalShell.evaluate((el) => {
    const htmlEl = el as HTMLElement;
    const grid = htmlEl.querySelector('.lg\\:grid') as HTMLElement | null;
    const columns = grid ? (Array.from(grid.children) as HTMLElement[]) : [];
    const columnOverflows = columns.map((col) => ({
      scrollHeight: col.scrollHeight,
      clientHeight: col.clientHeight,
    }));
    const col3 = columns[2] || null;
    const col3Style = col3 ? getComputedStyle(col3) : null;
    const col3ContentTop =
      col3 && col3Style
        ? col3.getBoundingClientRect().top + parseFloat(col3Style.paddingTop || '0')
        : 0;
    const readout = htmlEl.querySelector('[data-checkout-zone="readout"]') as HTMLElement | null;
    const quickTender = htmlEl.querySelector(
      '[data-checkout-zone="quick-tender"]',
    ) as HTMLElement | null;
    const keypad = htmlEl.querySelector('[data-checkout-zone="keypad"]') as HTMLElement | null;
    const footer = htmlEl.querySelector('[data-checkout-zone="footer"]') as HTMLElement | null;
    const keypadButtons = keypad
      ? (Array.from(keypad.querySelectorAll('button')) as HTMLElement[])
      : [];
    const ctaButton = footer?.lastElementChild as HTMLElement | null;

    return {
      shellScrollHeight: htmlEl.scrollHeight,
      shellClientHeight: htmlEl.clientHeight,
      columnCount: columns.length,
      columnOverflows,
      col3ContentTop,
      readoutRect: readout ? readout.getBoundingClientRect().toJSON() : null,
      quickTenderRect: quickTender ? quickTender.getBoundingClientRect().toJSON() : null,
      keypadRect: keypad ? keypad.getBoundingClientRect().toJSON() : null,
      footerRect: footer ? footer.getBoundingClientRect().toJSON() : null,
      ctaRect: ctaButton ? ctaButton.getBoundingClientRect().toJSON() : null,
      minKeypadButtonHeight:
        keypadButtons.length > 0
          ? Math.min(...keypadButtons.map((btn) => btn.getBoundingClientRect().height))
          : 0,
      col1FooterTop: columns[0]?.lastElementChild
        ? columns[0].lastElementChild.getBoundingClientRect().top
        : undefined,
    };
  });

  // Zero outer modal scroll & zero column-level scroll
  expect(
    shellMetrics.shellScrollHeight,
    'Modal shell must fit within viewport without vertical scroll',
  ).toBeLessThanOrEqual(shellMetrics.shellClientHeight + 1);
  expect(shellMetrics.columnCount).toBe(3);
  for (const [idx, col] of shellMetrics.columnOverflows.entries()) {
    expect(
      col.scrollHeight,
      `Column ${idx + 1} must not scroll vertically at column level`,
    ).toBeLessThanOrEqual(col.clientHeight + 1);
  }

  // Zero dead top space above Zone 3A readout
  expect(shellMetrics.readoutRect).not.toBeNull();
  expect(shellMetrics.quickTenderRect).not.toBeNull();
  expect(shellMetrics.keypadRect).not.toBeNull();
  expect(shellMetrics.footerRect).not.toBeNull();
  expect(shellMetrics.ctaRect).not.toBeNull();

  const topGap = Math.abs((shellMetrics.readoutRect!.top as number) - shellMetrics.col3ContentTop);
  expect(
    topGap,
    'Column 3 Zone 3A must align directly at padded top without dead space',
  ).toBeLessThanOrEqual(2);

  // Touch floor >= 44px on every keypad button
  expect(shellMetrics.minKeypadButtonHeight).toBeGreaterThanOrEqual(44);

  return {
    readoutTop: shellMetrics.readoutRect!.top as number,
    quickTenderTop: shellMetrics.quickTenderRect!.top as number,
    quickTenderHeight: shellMetrics.quickTenderRect!.height as number,
    keypadTop: shellMetrics.keypadRect!.top as number,
    keypadHeight: shellMetrics.keypadRect!.height as number,
    footerTop: shellMetrics.footerRect!.top as number,
    footerHeight: shellMetrics.footerRect!.height as number,
    ctaTop: shellMetrics.ctaRect!.top as number,
    ctaHeight: shellMetrics.ctaRect!.height as number,
    col1FooterTop: shellMetrics.col1FooterTop,
  };
}

function expectZeroShift(baseline: RectSnapshot, next: RectSnapshot, transition: string): void {
  expect(
    Math.abs(next.readoutTop - baseline.readoutTop),
    `${transition}: Zone 3A readout shifted vertically`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(next.quickTenderTop - baseline.quickTenderTop),
    `${transition}: Zone 3B quick-tender strip shifted vertically`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(next.keypadTop - baseline.keypadTop),
    `${transition}: Zone 3C keypad shifted vertically`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(next.keypadHeight - baseline.keypadHeight),
    `${transition}: Zone 3C keypad height changed`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(next.footerTop - baseline.footerTop),
    `${transition}: Zone 3D footer shifted vertically`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(next.ctaTop - baseline.ctaTop),
    `${transition}: Primary CTA button shifted vertically`,
  ).toBeLessThanOrEqual(1);
  if (baseline.col1FooterTop !== undefined && next.col1FooterTop !== undefined) {
    expect(
      Math.abs(next.col1FooterTop - baseline.col1FooterTop),
      `${transition}: Column 1 pinned totals footer shifted vertically`,
    ).toBeLessThanOrEqual(1);
  }
}

test('PrepaidCheckoutModal maintains 3-column geometry across viewports and states', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const saved = await setBusinessSettings(page, {
    billing_type: 'prepaid',
    card_transaction_id_required: true,
  });
  try {
    await loginAndOpenPos(page);
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item').first()).toBeVisible();
    await page.getByRole('button', { name: /Place Order/i }).click();
    const modal = page.getByTestId('prepaid-checkout-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('prepaid-checkout-summary')).toBeVisible({ timeout: 10000 });
    await expect(modal.getByTestId('checkout-header-chips')).toBeVisible();
    await expect(modal.getByTestId('checkout-header-chips')).not.toContainText(' · ');
    const shell = modal.locator('> div').first();

    for (const vp of DESKTOP_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const baseline = await assertColumnAndStationGeometry(shell);

      // Switch to Card to reveal required Card Terminal Reference input (constant h-11 slot)
      await modal.getByRole('button', { name: 'Card', exact: true }).first().click();
      await expect(modal.locator('#prepaid-card-transaction-id')).toBeVisible();
      await expect(modal.locator('#prepaid-card-transaction-id')).toBeEnabled();
      await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
        'data-status-tone',
        'idle-ready',
      );
      await expect(modal.getByTestId('checkout-status-strip')).not.toHaveText(/\bPaid\b/);
      await expect(modal.locator('[data-checkout-zone="readout"]')).not.toHaveText(/\bPaid\b/);
      expectZeroShift(
        baseline,
        await assertColumnAndStationGeometry(shell),
        `${vp.name} prepaid Card ref`,
      );

      // Switch back to Cash and click highest quick-cash pill to display Change Returned
      await modal.getByRole('button', { name: 'Cash', exact: true }).first().click();
      const pills = modal.locator('[data-checkout-zone="quick-tender"] button');
      const pillCount = await pills.count();
      if (pillCount > 1) {
        await pills.last().click();
      }
      await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
        'data-status-tone',
        'idle-ready',
      );
      await expect(modal.getByTestId('checkout-status-strip')).not.toHaveText(/\bPaid\b/);
      expectZeroShift(
        baseline,
        await assertColumnAndStationGeometry(shell),
        `${vp.name} prepaid Change slot`,
      );

      // Toggle Discount panel & back in Column 1 without moving pinned totals footer
      await modal
        .getByRole('button', { name: /Discount/i })
        .first()
        .click();
      expectZeroShift(
        baseline,
        await assertColumnAndStationGeometry(shell),
        `${vp.name} prepaid Discount panel`,
      );
      await modal.getByRole('button', { name: /Back/i }).first().click();
    }

    await page.setViewportSize({ width: 1024, height: 600 });
    const prepaidCompactFit = await shell.evaluate((el) => {
      const shellRect = el.getBoundingClientRect();
      const cta = el.querySelector('[data-checkout-zone="footer"] > button:last-child');
      const ctaRect = cta ? cta.getBoundingClientRect() : null;
      const btns = Array.from(
        el.querySelectorAll('[data-checkout-zone="keypad"] button'),
      ) as HTMLElement[];
      return {
        ctaBottom: ctaRect ? ctaRect.bottom : Infinity,
        shellBottom: shellRect.bottom,
        minKeyHeight:
          btns.length > 0 ? Math.min(...btns.map((b) => b.getBoundingClientRect().height)) : 0,
      };
    });
    expect(
      prepaidCompactFit.ctaBottom,
      '1024x600 PrepaidCheckoutModal primary CTA must not clip below modal shell',
    ).toBeLessThanOrEqual(prepaidCompactFit.shellBottom + 1);
    expect(prepaidCompactFit.minKeyHeight, '1024x600 keypad height >= 44').toBeGreaterThanOrEqual(
      44,
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    const prepaidShotDir = process.env.CHECKOUT_SCREENSHOT_DIR?.trim() || '';
    if (prepaidShotDir) {
      fs.mkdirSync(prepaidShotDir, { recursive: true });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      await page.screenshot({
        path: path.join(prepaidShotDir, '19-prepaid-light-1280x800.png'),
        animations: 'disabled',
      });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.screenshot({
        path: path.join(prepaidShotDir, '20-prepaid-dark-1280x800.png'),
        animations: 'disabled',
      });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    }

    await modal.getByRole('button', { name: 'Close' }).first().click();
    await expect(modal).toBeHidden();
  } finally {
    await restoreBusinessSettings(page, saved);
  }
});

test('PaymentModal holds zero-scroll and <=1px shift with 20 items, 20-payer Equal Share, and recovery popover', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const originalOrdersLayout: E2EOrdersLayout = await readOrdersLayout(page, BASE, MANAGER_TOKEN);
  const saved = await setBusinessSettings(page, {
    billing_type: 'postpaid',
    card_transaction_id_required: true,
  });
  try {
    await setOrdersLayout(page, 'split', BASE, MANAGER_TOKEN);
    await loginAndOpenPos(page);
    await createMultiLineOrderAndOpenPaymentModal(page, 20);

    const modal = page
      .locator('[data-testid="checkout-payment-station"]')
      .locator('..')
      .locator('..')
      .locator('..');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('checkout-header-chips')).toBeVisible();
    await expect(modal.getByTestId('checkout-header-chips')).not.toContainText(' · ');
    await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
      'data-status-tone',
      'idle-due',
    );

    for (const vp of DESKTOP_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const baseline = await assertColumnAndStationGeometry(modal);

      // Card terminal reference slot + no premature Paid badge when auto-filled
      await modal.getByRole('button', { name: 'Card', exact: true }).first().click();
      await expect(modal.locator('#payment-card-transaction-id')).toBeEnabled();
      await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
        'data-status-tone',
        'idle-ready',
      );
      await expect(modal.getByTestId('checkout-status-strip')).not.toHaveText(/\bPaid\b/);
      await expect(modal.locator('[data-checkout-zone="readout"]')).not.toHaveText(/\bPaid\b/);
      expectZeroShift(
        baseline,
        await assertColumnAndStationGeometry(modal),
        `${vp.name} PaymentModal Card ref`,
      );

      // 20-payer Equal Share in contained Column 2 scroll list
      if (await modal.getByTestId('split-mode-equal-tab').count()) {
        await modal.getByTestId('split-mode-equal-tab').click();
      } else {
        await modal.getByTestId('unified-split-card').locator('button').first().click();
      }
      await modal.locator('#equal-share-payers').fill('20');
      await expect(modal.getByTestId('equal-share-shares')).toBeVisible();
      expectZeroShift(
        baseline,
        await assertColumnAndStationGeometry(modal),
        `${vp.name} PaymentModal 20-payer Equal Share`,
      );
      if (await modal.getByTestId('split-mode-items-tab').count()) {
        await modal.getByTestId('split-mode-items-tab').click();
      } else {
        await modal.getByTestId('unified-split-card').locator('button').first().click();
      }

      // Discount panel swap
      if (await modal.getByTestId('col1-tab-discount').count()) {
        await modal.getByTestId('col1-tab-discount').click();
        expectZeroShift(
          baseline,
          await assertColumnAndStationGeometry(modal),
          `${vp.name} PaymentModal Discount`,
        );
        await modal.getByRole('button', { name: /Back/i }).first().click();
      }
    }

    // Verify 400 validation error & Technical details floating popover cause <=1px shift at 1280x800
    await page.setViewportSize({ width: 1280, height: 800 });
    const baselineAt1280 = await assertColumnAndStationGeometry(modal);

    await page.route('**/api/bills/*/payments', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Card transaction_id is required',
          reason_code: 'payment.invalid',
          operation: 'payment.create',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          correlation_id: route.request().headers()['x-operation-id'],
          display_code: 'card_transaction_id_required',
        }),
      });
    });

    await modal.getByLabel('Card amount').fill('');
    await modal.getByLabel('Cash amount').fill('1284');
    const submitCta = modal.locator('[data-checkout-zone="footer"]').locator('button').last();
    await submitCta.click();
    const techBtn = modal.getByRole('button', { name: /Technical details/i });
    await expect(techBtn).toBeVisible({ timeout: 5000 });
    expectZeroShift(baselineAt1280, await assertColumnAndStationGeometry(modal), '400 error strip');

    // Open floating Technical details popover and prove zero shift
    await techBtn.click();
    await expect(modal.getByRole('region', { name: /Technical details/i })).toBeVisible();
    expectZeroShift(
      baselineAt1280,
      await assertColumnAndStationGeometry(modal),
      'Technical details popover open',
    );
    await modal
      .getByRole('region', { name: /Technical details/i })
      .getByRole('button', { name: /Close/i })
      .click();
    await page.unroute('**/api/bills/*/payments');

    // Also verify unknown network recovery strip causes <=1px shift
    let abortedPaymentPosts = 0;
    await page.route('**/api/bills/*/payments', async (route) => {
      abortedPaymentPosts += 1;
      await route.abort('failed');
    });
    await submitCta.click();
    await expect.poll(() => abortedPaymentPosts).toBe(1);
    await expect(
      modal.getByRole('button', { name: /Send same payment|Check payment status/i }).first(),
    ).toBeVisible({ timeout: 5000 });
    expectZeroShift(
      baselineAt1280,
      await assertColumnAndStationGeometry(modal),
      'Network recovery strip',
    );
    await page.unroute('**/api/bills/*/payments');

    // Verify compact 1024x600 & mobile 390x844 keep keypad buttons interactive and >= 44px
    for (const compactVp of [
      { width: 1024, height: 600 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(compactVp);
      const compactMetrics = await modal.evaluate((el) => {
        const shellRect = el.getBoundingClientRect();
        const cta = el.querySelector('[data-checkout-zone="footer"] > button:last-child');
        const ctaRect = cta ? cta.getBoundingClientRect() : null;
        const btns = Array.from(
          el.querySelectorAll('[data-checkout-zone="keypad"] button'),
        ) as HTMLElement[];
        return {
          minKeyHeight:
            btns.length > 0 ? Math.min(...btns.map((b) => b.getBoundingClientRect().height)) : 0,
          ctaBottom: ctaRect ? ctaRect.bottom : Infinity,
          shellBottom: shellRect.bottom,
        };
      });
      expect(
        compactMetrics.minKeyHeight,
        `${compactVp.width}x${compactVp.height} keypad height >= 44`,
      ).toBeGreaterThanOrEqual(44);
      if (compactVp.width >= 1024) {
        expect(
          compactMetrics.ctaBottom,
          `${compactVp.width}x${compactVp.height} PaymentModal primary CTA must not clip below modal shell`,
        ).toBeLessThanOrEqual(compactMetrics.shellBottom + 1);
      }
    }
  } finally {
    try {
      await setOrdersLayout(page, originalOrdersLayout, BASE, MANAGER_TOKEN);
    } finally {
      await restoreBusinessSettings(page, saved);
    }
  }
});

test('Checkout modals hold Light/Dark parity, RTL geometry, 3-state tender focus, and post-pay completion', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const screenshotDir = process.env.CHECKOUT_SCREENSHOT_DIR?.trim() || '';
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }
  const snap = async (filename: string) => {
    if (!screenshotDir) return;
    await page.screenshot({ path: path.join(screenshotDir, filename), animations: 'disabled' });
  };
  const applyColorScheme = async (scheme: 'light' | 'dark') => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((s) => {
      document.documentElement.classList.toggle('dark', s === 'dark');
    }, scheme);
  };

  const originalOrdersLayout: E2EOrdersLayout = await readOrdersLayout(page, BASE, MANAGER_TOKEN);
  const splitSettingRes = await page.request.get(`${BASE}/api/settings/split_checks_enabled`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
  });
  const originalSplitSetting = splitSettingRes.ok()
    ? String((await splitSettingRes.json())?.setting?.value ?? 'false')
    : 'false';
  const saved = await setBusinessSettings(page, {
    billing_type: 'postpaid',
    card_transaction_id_required: true,
  });

  try {
    await page.request.put(`${BASE}/api/settings/split_checks_enabled`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      data: { value: 'true' },
    });
    await setOrdersLayout(page, 'split', BASE, MANAGER_TOKEN);
    await applyColorScheme('light');
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAndOpenPos(page);

    // Create a dine-in multi-unit order so inline Split Check + Equal Share are both active
    const prodRes = await page.request.get(`${BASE}/api/products`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    });
    const prodData = await prodRes.json();
    const products = (prodData.products || prodData) as Array<{ id: number; name: string }>;
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers: {
        Authorization: `Bearer ${MANAGER_TOKEN}`,
        'Idempotency-Key': `life-visual-${Date.now()}-${Math.random()}`,
      },
      data: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: products[0].id, quantity: 2, notes: 'Extra hot' },
          ...(products[1] ? [{ product_id: products[1].id, quantity: 1 }] : []),
        ],
      },
    });
    expect(orderRes.ok()).toBeTruthy();
    const { order } = await orderRes.json();

    await page.goto(`${BASE}/orders`);
    const masterRow = page.getByRole('button').filter({ hasText: order.order_number }).first();
    await expect(masterRow).toBeVisible({ timeout: 10000 });
    await masterRow.click();
    await page
      .getByRole('button', { name: /Checkout|Take Payment/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible({ timeout: 10000 });

    const modal = page
      .locator('[data-testid="checkout-payment-station"]')
      .locator('..')
      .locator('..')
      .locator('..');

    // 1. Light 1440x900 idle ($0.00): Cash focused, Card idle, CTA disabled, idle-due
    await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
      'data-status-tone',
      'idle-due',
    );
    const footerCta = modal.locator('[data-checkout-zone="footer"]').locator('button').last();
    await expect(footerCta).toBeDisabled();
    await snap('01-payment-light-1440x900-idle.png');

    // 2. Focus Card input at $0.00 -> Card button highlights with bg-brand & zero shift
    const baseline1440 = await assertColumnAndStationGeometry(modal);
    await modal.getByLabel('Card amount').focus();
    await expect(modal.getByRole('button', { name: 'Card', exact: true }).first()).toHaveClass(
      /\bbg-brand\b/,
    );
    expectZeroShift(
      baseline1440,
      await assertColumnAndStationGeometry(modal),
      'Card $0.00 focus border/ring',
    );
    await snap('02-payment-light-1440x900-card-zero-focus.png');

    // 3. Partial tender ($5.00 Cash, $0.00 Card) -> idle-due (never Paid)
    await modal.getByLabel('Cash amount').fill('5');
    await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
      'data-status-tone',
      'idle-due',
    );
    await expect(modal.getByTestId('checkout-status-strip')).not.toHaveText(/\bPaid\b/);
    await snap('03-payment-light-1440x900-partial-due.png');

    // 4. Click Card button to auto-fill remaining -> exact due -> idle-ready + bg-brand CTA (never Paid)
    await modal.getByRole('button', { name: 'Card', exact: true }).first().click();
    await modal.locator('#payment-card-transaction-id').fill('TXN-482910');
    await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
      'data-status-tone',
      'idle-ready',
    );
    await expect(modal.getByTestId('checkout-status-strip')).not.toHaveText(/\bPaid\b/);
    await expect(modal.locator('[data-checkout-zone="readout"]')).toContainText('Exact due');
    await expect(footerCta).toBeEnabled();
    await expect(footerCta).toHaveClass(/\bbg-brand\b/);
    await snap('04-payment-light-1440x900-exact-ready.png');

    // 5. Dark mode 1440x900 exact ready + Equal Share preview
    await applyColorScheme('dark');
    await assertColumnAndStationGeometry(modal);
    await snap('05-payment-dark-1440x900-exact-ready.png');

    if (await modal.getByTestId('split-mode-equal-tab').count()) {
      await modal.getByTestId('split-mode-equal-tab').click();
      await snap('06-payment-dark-1440x900-equal-share.png');
      await modal.getByTestId('split-mode-items-tab').click();
    }

    // 6. Cash overpayment in Light & Dark -> emerald Change Returned, idle-ready, never Paid
    await applyColorScheme('light');
    await modal.getByLabel('Card amount').fill('');
    await modal.getByRole('button', { name: 'Cash', exact: true }).first().click();
    const quickPills = modal.locator('[data-checkout-zone="quick-tender"] button');
    if ((await quickPills.count()) > 1) {
      await quickPills.last().click();
    }
    await expect(modal.getByTestId('checkout-status-strip')).toHaveAttribute(
      'data-status-tone',
      'idle-ready',
    );
    await expect(modal.getByTestId('checkout-status-strip')).not.toHaveText(/\bPaid\b/);
    await snap('07-payment-light-1440x900-cash-overpay.png');

    // 7. Discount sub-panel in Column 1
    if (await modal.getByTestId('col1-tab-discount').count()) {
      await modal.getByTestId('col1-tab-discount').click();
      await snap('08-payment-light-1440x900-discount-panel.png');
      await modal.getByRole('button', { name: /Back/i }).first().click();
    }

    // 8. SplitCheckModal in Light & Dark modes (structured chips, zero middle dots)
    await modal
      .getByTestId('split-check-section')
      .getByRole('button', { name: /Split Check/i })
      .click();
    const splitHeading = page.getByRole('heading', { name: /Split Check/i });
    await expect(splitHeading).toBeVisible();
    await snap('09-splitcheck-table-light-1440x900.png');
    await page.getByRole('button', { name: /Selected items/i }).click();
    await page.locator('[data-testid^="guest-item-inc-"]').first().click();
    await applyColorScheme('dark');
    await snap('10-splitcheck-guest-dark-1440x900.png');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(splitHeading).toBeHidden();

    // 9. Compact 1024x600 & Mobile 390x844 in Light & Dark
    await page.setViewportSize({ width: 1024, height: 600 });
    await applyColorScheme('light');
    await assertColumnAndStationGeometry(modal);
    await snap('11-payment-light-1024x600-compact.png');
    await applyColorScheme('dark');
    await assertColumnAndStationGeometry(modal);
    await snap('12-payment-dark-1024x600-compact.png');

    const assertMobileStationVisibleWithinViewport = async (schemeLabel: string) => {
      const keypad = modal.locator('[data-checkout-zone="keypad"]');
      const payButton = modal.locator('[data-checkout-zone="footer"] > button').last();
      await expect(keypad, `390x844 ${schemeLabel} keypad visible`).toBeVisible();
      await expect(payButton, `390x844 ${schemeLabel} Pay CTA visible`).toBeVisible();
      const mobileBounds = await page.evaluate(() => ({
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      }));
      expect(
        mobileBounds.docScrollWidth,
        `390x844 ${schemeLabel} must not overflow horizontally`,
      ).toBeLessThanOrEqual(mobileBounds.innerWidth);
      const keypadBox = await keypad.boundingBox();
      const payBox = await payButton.boundingBox();
      const chipsBox = await modal.getByTestId('checkout-header-chips').boundingBox();
      expect(keypadBox).not.toBeNull();
      expect(payBox).not.toBeNull();
      expect(chipsBox).not.toBeNull();
      expect(
        chipsBox!.height,
        `390x844 ${schemeLabel} header chips must stay single-row on mobile`,
      ).toBeLessThanOrEqual(24);
      expect(keypadBox!.x).toBeGreaterThanOrEqual(0);
      expect(keypadBox!.x + keypadBox!.width).toBeLessThanOrEqual(mobileBounds.innerWidth + 1);
      expect(keypadBox!.y).toBeGreaterThanOrEqual(0);
      expect(keypadBox!.y + keypadBox!.height).toBeLessThanOrEqual(mobileBounds.innerHeight + 1);
      expect(payBox!.x).toBeGreaterThanOrEqual(0);
      expect(payBox!.x + payBox!.width).toBeLessThanOrEqual(mobileBounds.innerWidth + 1);
      expect(payBox!.y).toBeGreaterThanOrEqual(0);
      expect(payBox!.y + payBox!.height).toBeLessThanOrEqual(mobileBounds.innerHeight + 1);
    };

    await page.setViewportSize({ width: 390, height: 844 });
    await applyColorScheme('light');
    await assertMobileStationVisibleWithinViewport('light');
    await snap('13-payment-light-390x844-mobile.png');
    await applyColorScheme('dark');
    await assertMobileStationVisibleWithinViewport('dark');
    await snap('14-payment-dark-390x844-mobile.png');

    // 10. RTL (Persian `fa`) at 1280x800 in Light & Dark
    await page.setViewportSize({ width: 1280, height: 800 });
    await setLanguage(page, 'fa');
    await page.goto(`${BASE}/orders`);
    const faRow = page.getByRole('button').filter({ hasText: order.order_number }).first();
    await expect(faRow).toBeVisible({ timeout: 10000 });
    await faRow.click();
    await page
      .getByRole('button', { name: /^(پرداخت|دریافت پرداخت)$/ })
      .first()
      .click();
    await expect(page.getByTestId('checkout-payment-station')).toBeVisible({ timeout: 10000 });
    const rtlModal = page
      .locator('[data-testid="checkout-payment-station"]')
      .locator('..')
      .locator('..')
      .locator('..');
    await applyColorScheme('light');
    await assertColumnAndStationGeometry(rtlModal);
    await snap('15-payment-rtl-fa-1280x800-light.png');
    await applyColorScheme('dark');
    await assertColumnAndStationGeometry(rtlModal);
    await snap('16-payment-rtl-fa-1280x800-dark.png');

    // Restore English, submit real payment, and verify server-confirmed post-payment emerald completion screen
    await setLanguage(page, 'en');
    await applyColorScheme('light');
    await page.goto(`${BASE}/orders`);
    await page.getByRole('button').filter({ hasText: order.order_number }).first().click();
    await page
      .getByRole('button', { name: /Checkout|Take Payment/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible({ timeout: 10000 });
    const settleModal = page
      .locator('[data-testid="checkout-payment-station"]')
      .locator('..')
      .locator('..')
      .locator('..');
    await settleModal.getByRole('button', { name: 'Cash', exact: true }).first().click();
    await settleModal.locator('[data-checkout-zone="footer"]').locator('button').last().click();
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await snap('17-payment-postpay-settled-light.png');
    await applyColorScheme('dark');
    await snap('18-payment-postpay-settled-dark.png');
    await applyColorScheme('light');
  } finally {
    await setLanguage(page, 'en').catch(() => {});
    await page.request
      .put(`${BASE}/api/settings/split_checks_enabled`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
        data: { value: originalSplitSetting },
      })
      .catch(() => {});
    try {
      await setOrdersLayout(page, originalOrdersLayout, BASE, MANAGER_TOKEN);
    } finally {
      await restoreBusinessSettings(page, saved);
    }
  }
});

test('Principal UX E2E: 1280x800 Equal Share unclipped, 1-tap tender switch, stacked Escape, and zero-click keyboard rush', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const originalOrdersLayout: E2EOrdersLayout = await readOrdersLayout(page, BASE, MANAGER_TOKEN);
  const splitSettingRes = await page.request.get(`${BASE}/api/settings/split_checks_enabled`, {
    headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
  });
  const originalSplitSetting = splitSettingRes.ok()
    ? String((await splitSettingRes.json())?.setting?.value ?? 'false')
    : 'false';
  const saved = await setBusinessSettings(page, {
    billing_type: 'postpaid',
    tables_required: true,
    card_transaction_id_required: false,
  });
  let createdTableId: string | null = null;
  let createdOrderId: number | null = null;

  try {
    await page.request.put(`${BASE}/api/settings/split_checks_enabled`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      data: { value: 'true' },
    });
    await setOrdersLayout(page, 'split', BASE, MANAGER_TOKEN);
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAndOpenPos(page);

    // Ensure at least one table and product exist for dine-in TableCheckoutModal + Equal Share
    const [prodRes, custRes] = await Promise.all([
      page.request.get(`${BASE}/api/products`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      }),
      page.request.get(`${BASE}/api/customers`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      }),
    ]);
    const products = ((await prodRes.json()).products || []) as Array<{
      id: number;
      name: string;
      price: number;
    }>;
    const customers = ((await custRes.json()).customers || []) as Array<{
      id: string;
      name: string;
    }>;
    expect(products.length).toBeGreaterThan(0);

    const uniqueTableLabel = `UX${Date.now().toString().slice(-4)}`;
    const createdTblRes = await page.request.post(`${BASE}/api/tables`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      data: { number: uniqueTableLabel, name: uniqueTableLabel, capacity: 4, floor: 'Ground' },
    });
    expect(createdTblRes.ok()).toBeTruthy();
    const createdTable = (await createdTblRes.json()).table as {
      id: string;
      number?: string;
      name?: string;
    };
    createdTableId = createdTable.id;

    let customerId = customers[0]?.id;
    if (!customerId) {
      const createdCustRes = await page.request.post(`${BASE}/api/customers`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
        data: { name: 'UX Audit Guest', phone: `+1555${String(Date.now()).slice(-7)}` },
      });
      if (createdCustRes.ok()) {
        customerId = (await createdCustRes.json()).customer?.id;
      }
    }

    const dineInRes = await page.request.post(`${BASE}/api/orders`, {
      headers: {
        Authorization: `Bearer ${MANAGER_TOKEN}`,
        'Idempotency-Key': `ux-e2e-${Date.now()}-${Math.random()}`,
      },
      data: {
        type: 'dine_in',
        table_id: createdTable.id,
        guest_count: 3,
        ...(customerId ? { customer_id: customerId } : {}),
        items: [{ product_id: products[0].id, quantity: 3 }],
      },
    });
    expect(dineInRes.ok()).toBeTruthy();
    const { order: dineInOrder } = await dineInRes.json();
    createdOrderId = dineInOrder.id;

    // 1. Stacked-modal Escape on /pos: TableCheckoutModal -> SplitCheckModal -> 1st Escape -> 2nd Escape
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.getByRole('button', { name: /Dine in/i }).click();
    const tableTile = page.getByRole('button', { name: new RegExp(uniqueTableLabel) }).first();
    if (!(await tableTile.isVisible().catch(() => false))) {
      await page.locator('body').click({ position: { x: 10, y: 10 } });
      await page.keyboard.press('F2');
    }
    await expect(tableTile).toBeVisible({ timeout: 10000 });
    await tableTile.click();
    const tableModalHeading = page.getByRole('heading', { name: new RegExp(uniqueTableLabel) });
    await expect(tableModalHeading).toBeVisible({ timeout: 10000 });

    const splitBtn = page.getByRole('button', { name: /^Split Check$/i });
    await expect(splitBtn).toBeVisible({ timeout: 10000 });
    await splitBtn.click();
    const splitModalHeading = page.getByRole('heading', { name: /Split Check/i });
    await expect(splitModalHeading).toBeVisible({ timeout: 10000 });

    // 1st Escape closes ONLY SplitCheckModal; TableCheckoutModal remains open!
    await page.keyboard.press('Escape');
    await expect(splitModalHeading).toBeHidden();
    await expect(tableModalHeading).toBeVisible();

    // 2nd Escape closes TableCheckoutModal!
    await page.keyboard.press('Escape');
    await expect(tableModalHeading).toBeHidden();

    // 2. PaymentModal at 1280x800: Equal Shares Apply buttons unclipped + 1-tap tender switch + Discount sync & Escape backout
    await page.goto(`${BASE}/orders`);
    await page.getByRole('button').filter({ hasText: dineInOrder.order_number }).first().click();
    await page
      .getByRole('button', { name: /Checkout|Take Payment/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible({ timeout: 10000 });
    const payModal = page
      .locator('[data-testid="checkout-payment-station"]')
      .locator('..')
      .locator('..')
      .locator('..');

    // 1-tap tender switch: Card auto-fills -> Cash moves full balance in 1 click (Card cleared)
    await payModal.getByRole('button', { name: 'Card', exact: true }).first().click();
    await expect(payModal.getByLabel('Card amount')).not.toHaveValue('');
    await payModal.getByRole('button', { name: 'Cash', exact: true }).first().click();
    await expect(payModal.getByLabel('Card amount')).toHaveValue('');
    await expect(payModal.getByLabel('Cash amount')).not.toHaveValue('');

    // Discount panel immediately syncs keypad target (5%..20% pills) and 1st Escape backs out to Items
    if (await payModal.getByTestId('col1-tab-discount').count()) {
      await payModal.getByTestId('col1-tab-discount').click();
      await expect(
        payModal
          .locator('[data-checkout-zone="quick-tender"]')
          .getByRole('button', { name: '10%' }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(payModal.getByRole('heading', { name: 'Payment' })).toBeVisible();
    }

    // Equal Shares at 1280x800: Apply to Cash & Apply to Card stay unclipped inside Column 2 without scrolling
    await payModal.getByTestId('split-mode-equal-tab').click();
    const applyCashBtn = payModal.getByTestId('equal-share-apply-0');
    const applyCardBtn = payModal.getByTestId('equal-share-apply-1');
    await expect(applyCashBtn).toBeVisible();
    await expect(applyCardBtn).toBeVisible();
    const equalBounds = await payModal.evaluate((el) => {
      const grid = el.querySelector('.lg\\:grid') as HTMLElement | null;
      const col2 = grid?.children[1] as HTMLElement | null;
      const cashBtn = el.querySelector('[data-testid="equal-share-apply-0"]') as HTMLElement | null;
      const cardBtn = el.querySelector('[data-testid="equal-share-apply-1"]') as HTMLElement | null;
      const col2Rect = col2?.getBoundingClientRect();
      const cashRect = cashBtn?.getBoundingClientRect();
      const cardRect = cardBtn?.getBoundingClientRect();
      return {
        col2Bottom: col2Rect?.bottom ?? 0,
        cashBottom: cashRect?.bottom ?? Infinity,
        cardBottom: cardRect?.bottom ?? Infinity,
        col2ScrollTop: col2?.scrollTop ?? 0,
      };
    });
    expect(equalBounds.col2ScrollTop).toBe(0);
    expect(
      equalBounds.cashBottom,
      '1280x800 Apply to Cash must stay unclipped inside Column 2 without scrolling',
    ).toBeLessThanOrEqual(equalBounds.col2Bottom + 1);
    expect(
      equalBounds.cardBottom,
      '1280x800 Apply to Card must stay unclipped inside Column 2 without scrolling',
    ).toBeLessThanOrEqual(equalBounds.col2Bottom + 1);
    await payModal.getByRole('button', { name: 'Close' }).first().click();

    // 3. Zero-click keyboard rush checkout in PrepaidCheckoutModal + settled Change Returned + Print Receipt + 1-key Enter dismiss
    await setBusinessSettings(page, {
      billing_type: 'prepaid',
      tables_required: false,
      card_transaction_id_required: false,
    });
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.getByTestId('pos-product-card').first().click();
    await expect(page.getByTestId('cart-item').first()).toBeVisible();
    await page.keyboard.press('F4');
    const prepaidModal = page.getByTestId('prepaid-checkout-modal');
    await expect(prepaidModal).toBeVisible();
    await expect(prepaidModal.getByTestId('prepaid-checkout-summary')).toBeVisible({
      timeout: 10000,
    });

    // Type cash overpayment directly on physical keyboard without clicking any input!
    await page.keyboard.press('9');
    await page.keyboard.press('9');
    await page.keyboard.press('9');
    await page.keyboard.press('9');
    await expect(prepaidModal.getByLabel('Cash amount')).toHaveValue('9999');

    // Deliberate Enter submits payment -> completion screen shows Change Returned + Print Receipt!
    await page.keyboard.press('Enter');
    await expect(prepaidModal.getByTestId('settled-change-banner')).toBeVisible({ timeout: 10000 });
    await expect(prepaidModal.getByTestId('completion-print-receipt-btn')).toBeVisible();

    // 1-keystroke Enter dismisses completion screen back to POS!
    await page.keyboard.press('Enter');
    await expect(prepaidModal).toBeHidden({ timeout: 5000 });
  } finally {
    if (createdOrderId !== null) {
      await page.request
        .patch(`${BASE}/api/orders/${createdOrderId}/status`, {
          headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
          data: { status: 'cancelled', reason: 'E2E cleanup' },
        })
        .catch(() => {});
    }
    if (createdTableId !== null) {
      await page.request
        .post(`${BASE}/api/tables/${createdTableId}/deactivate`, {
          headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
        })
        .catch(() => {});
    }
    await page.request
      .put(`${BASE}/api/settings/split_checks_enabled`, {
        headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
        data: { value: originalSplitSetting },
      })
      .catch(() => {});
    try {
      await setOrdersLayout(page, originalOrdersLayout, BASE, MANAGER_TOKEN);
    } finally {
      await restoreBusinessSettings(page, saved);
    }
  }
});
