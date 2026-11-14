import { test, expect, type Page, type Locator } from '@playwright/test';
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

  if (patch.billing_type && originalBusiness.billing_type !== patch.billing_type) {
    const putBiz = await page.request.put(`${BASE}/api/settings/business`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      data: { ...originalBusiness, billing_type: patch.billing_type },
    });
    expect(putBiz.ok()).toBeTruthy();
  }

  let originalCardRequired: string | null = null;
  if (patch.card_transaction_id_required !== undefined) {
    const cardRes = await page.request.get(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
    });
    if (cardRes.ok()) {
      const cardData = await cardRes.json();
      originalCardRequired = String(cardData?.setting?.value ?? 'false');
    }
    const putCard = await page.request.put(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: { Authorization: `Bearer ${MANAGER_TOKEN}` },
      data: { value: patch.card_transaction_id_required ? 'true' : 'false' },
    });
    expect(putCard.ok()).toBeTruthy();
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
    const shell = modal.locator('> div').first();

    for (const vp of DESKTOP_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const baseline = await assertColumnAndStationGeometry(shell);

      // Switch to Card to reveal required Card Terminal Reference input (constant h-11 slot)
      await modal.getByRole('button', { name: 'Card', exact: true }).first().click();
      await expect(modal.locator('#prepaid-card-transaction-id')).toBeVisible();
      await expect(modal.locator('#prepaid-card-transaction-id')).toBeEnabled();
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

    for (const vp of DESKTOP_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const baseline = await assertColumnAndStationGeometry(modal);

      // Card terminal reference slot
      await modal.getByRole('button', { name: 'Card', exact: true }).first().click();
      await expect(modal.locator('#payment-card-transaction-id')).toBeEnabled();
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
          code: 'card_transaction_id_required',
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
    await page.route('**/api/bills/*/payments', async (route) => {
      await route.abort('failed');
    });
    await submitCta.click();
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
      const minKeyHeight = await modal.evaluate((el) => {
        const btns = Array.from(
          el.querySelectorAll('[data-checkout-zone="keypad"] button'),
        ) as HTMLElement[];
        return btns.length > 0 ? Math.min(...btns.map((b) => b.getBoundingClientRect().height)) : 0;
      });
      expect(
        minKeyHeight,
        `${compactVp.width}x${compactVp.height} keypad height >= 44`,
      ).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await setOrdersLayout(page, originalOrdersLayout, BASE, MANAGER_TOKEN);
    await restoreBusinessSettings(page, saved);
  }
});
