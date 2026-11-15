import { test, expect, Page, Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { loginWithPassword, setLanguage } from './helpers/test-auth';

type OrderTypeKey = 'dine_in' | 'takeaway' | 'delivery' | 'online';

interface LocaleOrderTypes {
  code: 'en' | 'ar' | 'de' | 'ta' | 'tr';
  dir: 'ltr' | 'rtl';
  expectCompactDesktop: boolean;
  labels: Record<OrderTypeKey, string>;
}

const MESSAGES_DIR = path.resolve(__dirname, '../src/lib/i18n/messages');

function loadOrderTypeLabels(code: LocaleOrderTypes['code']): Record<OrderTypeKey, string> {
  const raw = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${code}.json`), 'utf8')) as {
    pos: {
      orderTypeDineIn: string;
      orderTypeTakeaway: string;
      orderTypeDelivery: string;
      orderTypeOnline: string;
    };
  };
  return {
    dine_in: raw.pos.orderTypeDineIn,
    takeaway: raw.pos.orderTypeTakeaway,
    delivery: raw.pos.orderTypeDelivery,
    online: raw.pos.orderTypeOnline,
  };
}

const LOCALE_CASES: LocaleOrderTypes[] = [
  {
    code: 'ar',
    dir: 'rtl',
    expectCompactDesktop: true,
    labels: loadOrderTypeLabels('ar'),
  },
  {
    code: 'de',
    dir: 'ltr',
    expectCompactDesktop: true,
    labels: loadOrderTypeLabels('de'),
  },
  {
    code: 'ta',
    dir: 'ltr',
    expectCompactDesktop: true,
    labels: loadOrderTypeLabels('ta'),
  },
  {
    code: 'tr',
    dir: 'ltr',
    expectCompactDesktop: true,
    labels: loadOrderTypeLabels('tr'),
  },
  {
    code: 'en',
    dir: 'ltr',
    expectCompactDesktop: false,
    labels: loadOrderTypeLabels('en'),
  },
];

const ORDER_TYPE_SEQUENCE: OrderTypeKey[] = ['dine_in', 'takeaway', 'delivery', 'online'];

async function assertOrderTypeStripGeometry(
  cartShell: Locator,
  localeCase: LocaleOrderTypes,
  activeType: OrderTypeKey,
  expectCompact: boolean,
): Promise<void> {
  const buttons = ORDER_TYPE_SEQUENCE.map((type) => ({
    type,
    label: localeCase.labels[type],
    locator: cartShell.getByRole('button', { name: localeCase.labels[type], exact: true }),
  }));

  const track = buttons[0].locator.locator('..');
  await expect(track).toBeVisible();
  await expect(track).toHaveAttribute('role', 'group');
  await expect(track).toHaveAttribute('data-testid', 'pos-order-type-tabs');
  await expect(track).toHaveAttribute('data-compact', expectCompact ? 'true' : 'false');

  for (const { type, label, locator } of buttons) {
    await expect(locator, `${localeCase.code}: "${label}" button must stay visible`).toBeVisible();
    await expect(locator).toHaveAttribute('aria-pressed', type === activeType ? 'true' : 'false');
  }

  const shellBox = await cartShell.boundingBox();
  expect(shellBox, `${localeCase.code}/${activeType}: cart-shell bounding box`).not.toBeNull();

  const trackBox = await track.boundingBox();
  expect(trackBox, `${localeCase.code}/${activeType}: track bounding box`).not.toBeNull();
  expect(trackBox!.x).toBeGreaterThanOrEqual(shellBox!.x - 0.5);
  expect(trackBox!.x + trackBox!.width).toBeLessThanOrEqual(shellBox!.x + shellBox!.width + 0.5);

  const boxes: { type: OrderTypeKey; x: number; y: number; width: number; height: number }[] = [];

  for (const { type, label, locator } of buttons) {
    const box = await locator.boundingBox();
    expect(box, `${localeCase.code}/${activeType}: "${label}" bounding box`).not.toBeNull();

    // Containment inside track and cart shell
    expect(
      box!.x,
      `${localeCase.code}/${activeType}: "${label}" left edge inside track`,
    ).toBeGreaterThanOrEqual(trackBox!.x - 0.5);
    expect(
      box!.x + box!.width,
      `${localeCase.code}/${activeType}: "${label}" right edge inside track`,
    ).toBeLessThanOrEqual(trackBox!.x + trackBox!.width + 0.5);
    expect(
      box!.y,
      `${localeCase.code}/${activeType}: "${label}" top edge inside track`,
    ).toBeGreaterThanOrEqual(trackBox!.y - 0.5);
    expect(
      box!.y + box!.height,
      `${localeCase.code}/${activeType}: "${label}" bottom edge inside track`,
    ).toBeLessThanOrEqual(trackBox!.y + trackBox!.height + 0.5);

    // WCAG 2.5.8 minimum 24x24 CSS px target
    expect(
      box!.width,
      `${localeCase.code}/${activeType}: "${label}" width >= 24px`,
    ).toBeGreaterThanOrEqual(23.5);
    expect(
      box!.height,
      `${localeCase.code}/${activeType}: "${label}" height >= 24px`,
    ).toBeGreaterThanOrEqual(23.5);

    // Single-line and zero unclipped button overflow
    const metrics = await locator.evaluate((btn) => {
      const icon = btn.querySelector('svg');
      const labelSpan = btn.querySelector('span');
      const spanRect = labelSpan ? labelSpan.getBoundingClientRect() : null;
      return {
        scrollWidth: btn.scrollWidth,
        clientWidth: btn.clientWidth,
        scrollHeight: btn.scrollHeight,
        clientHeight: btn.clientHeight,
        hasIcon: Boolean(icon),
        iconAriaHidden: icon?.getAttribute('aria-hidden') ?? null,
        iconWidth: icon ? icon.getBoundingClientRect().width : 0,
        spanText: labelSpan?.textContent ?? '',
        spanSrOnly: labelSpan?.classList.contains('sr-only') ?? false,
        spanWidth: spanRect ? spanRect.width : 0,
        spanScrollHeight: labelSpan?.scrollHeight ?? 0,
        spanClientHeight: labelSpan?.clientHeight ?? 0,
      };
    });

    expect(
      metrics.scrollHeight,
      `${localeCase.code}/${activeType}: "${label}" must not wrap onto multiple lines`,
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);
    expect(
      metrics.scrollWidth,
      `${localeCase.code}/${activeType}: "${label}" must not overflow button horizontally`,
    ).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.hasIcon, `${localeCase.code}/${activeType}: "${label}" renders icon`).toBe(true);
    expect(metrics.iconAriaHidden).toBe('true');
    expect(metrics.iconWidth).toBeGreaterThanOrEqual(11);
    expect(metrics.spanText).toBe(label);

    const shouldShowVisibleLabel = !expectCompact || type === activeType;
    expect(metrics.spanSrOnly, `${localeCase.code}/${activeType}: "${label}" sr-only state`).toBe(
      !shouldShowVisibleLabel,
    );
    if (shouldShowVisibleLabel) {
      expect(
        metrics.spanWidth,
        `${localeCase.code}/${activeType}: active/full "${label}" text must be visibly rendered`,
      ).toBeGreaterThan(16);
      expect(metrics.spanScrollHeight).toBeLessThanOrEqual(metrics.spanClientHeight + 1);
    }

    boxes.push({ type, ...box! });
  }

  // Inline direction order check: LTR runs dine_in -> online left-to-right; RTL runs right-to-left
  if (localeCase.dir === 'ltr') {
    for (let i = 0; i < boxes.length - 1; i++) {
      expect(
        boxes[i].x + boxes[i].width,
        `${localeCase.code}/${activeType}: ${boxes[i].type} must not overlap ${boxes[i + 1].type} in LTR`,
      ).toBeLessThanOrEqual(boxes[i + 1].x + 0.5);
    }
  } else {
    for (let i = 0; i < boxes.length - 1; i++) {
      expect(
        boxes[i + 1].x + boxes[i + 1].width,
        `${localeCase.code}/${activeType}: ${boxes[i + 1].type} must sit to the left of ${boxes[i].type} without overlap in RTL`,
      ).toBeLessThanOrEqual(boxes[i].x + 0.5);
    }
  }
}

async function assertTooltipOnCompactInactiveSegments(
  page: Page,
  cartShell: Locator,
  hoverLabel: string,
  focusLabel: string,
): Promise<void> {
  const hoverButton = cartShell.getByRole('button', { name: hoverLabel, exact: true });
  const hoverTooltip = page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: hoverLabel });
  await hoverButton.hover();
  await expect(hoverTooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hoverTooltip).toHaveCount(0);

  // Keyboard focus also reveals tooltip (never relying on mouse-only title)
  const focusButton = cartShell.getByRole('button', { name: focusLabel, exact: true });
  const focusTooltip = page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: focusLabel });
  await focusButton.focus();
  await expect(focusTooltip).toBeVisible();
  await page.keyboard.press('Escape');
}

test('POS cart order-type tabs never overflow, wrap, or overlap across LTR and RTL locales (#1587)', async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.setViewportSize({ width: 1280, height: 800 });
  await loginWithPassword(page, 'owner@flo.local');

  try {
    for (const localeCase of LOCALE_CASES) {
      await setLanguage(page, localeCase.code);
      await page.goto(`${BASE}/pos`);
      await expect(page.locator('html')).toHaveAttribute('dir', localeCase.dir);
      await expect(page.getByTestId('pos-product-grid')).toBeVisible();

      const desktopCart = page.getByTestId('cart-shell').first();
      await expect(desktopCart).toBeVisible();

      // Walk all 4 order types via 1-tap accessible-name clicks and verify geometry in each state
      for (const targetType of ORDER_TYPE_SEQUENCE) {
        const targetLabel = localeCase.labels[targetType];
        await desktopCart.getByRole('button', { name: targetLabel, exact: true }).click();
        await assertOrderTypeStripGeometry(
          desktopCart,
          localeCase,
          targetType,
          localeCase.expectCompactDesktop,
        );
      }

      if (localeCase.expectCompactDesktop) {
        // Active is currently 'online'; hover & focus inactive icon buttons to verify accessible tooltips
        await assertTooltipOnCompactInactiveSegments(
          page,
          desktopCart,
          localeCase.labels.dine_in,
          localeCase.labels.takeaway,
        );
      } else {
        // Live ResizeObserver check: narrowing an English cart container below full-mode fit switches to compact mode and back without reload
        await desktopCart.evaluate((el) => {
          (el as HTMLElement).style.width = '220px';
        });
        await assertOrderTypeStripGeometry(desktopCart, localeCase, 'online', true);
        await desktopCart.evaluate((el) => {
          (el as HTMLElement).style.width = '';
        });
        await assertOrderTypeStripGeometry(desktopCart, localeCase, 'online', false);
      }
    }

    // Also verify narrow 320px mobile cart drawer in Arabic (RTL)
    await setLanguage(page, 'ar');
    await page.setViewportSize({ width: 320, height: 667 });
    await page.goto(`${BASE}/pos`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const arLabels = loadOrderTypeLabels('ar');
    const arCase = LOCALE_CASES.find((c) => c.code === 'ar')!;

    // Open mobile floating cart drawer button
    const mobileCartTrigger = page.locator('button.fixed.md\\:hidden').first();
    await expect(mobileCartTrigger).toBeVisible();
    await mobileCartTrigger.click();

    const drawerCart = page.locator('[data-slot="drawer-content"] [data-testid="cart-shell"]');
    await expect(drawerCart).toBeVisible();

    for (const targetType of ORDER_TYPE_SEQUENCE) {
      await drawerCart.getByRole('button', { name: arLabels[targetType], exact: true }).click();
      await assertOrderTypeStripGeometry(drawerCart, arCase, targetType, true);
    }
  } finally {
    await setLanguage(page, 'en');
  }
});
