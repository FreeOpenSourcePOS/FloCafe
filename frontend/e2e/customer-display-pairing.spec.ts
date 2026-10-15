import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

const CUSTOMER_DISPLAY_DEFAULTS = {
  statuses: ['pending', 'preparing', 'ready'],
  refresh_seconds: 3,
  show_updated: true,
};

function ownerHeaders() {
  return { Authorization: `Bearer ${getE2eToken()}` };
}

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function openKdsSettingsTab(page: Page): Promise<void> {
  await page.goto(`${BASE}/settings?tab=kds`);
  await expect(page.getByRole('heading', { name: 'Customer display', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'Paired displays', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function revokeAllDisplayTokens(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${BASE}/api/settings/customer-display/tokens`, {
    headers: ownerHeaders(),
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { tokens?: Array<{ id: string }> };
  for (const token of body.tokens ?? []) {
    await request.delete(`${BASE}/api/settings/customer-display/tokens/${token.id}`, {
      headers: ownerHeaders(),
    });
  }
}

async function resetCustomerDisplayConfig(request: APIRequestContext): Promise<void> {
  await request.put(`${BASE}/api/settings/customer-display`, {
    headers: ownerHeaders(),
    data: CUSTOMER_DISPLAY_DEFAULTS,
  });
}

async function createOrderWithStatus(
  request: APIRequestContext,
  status: 'pending' | 'preparing' | 'ready',
): Promise<{ id: number; order_number: string }> {
  const created = await request.post(`${BASE}/api/orders`, {
    headers: ownerHeaders(),
    data: {
      type: 'takeaway',
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(created.status(), 'creating test order must succeed').toBe(201);
  const { order } = (await created.json()) as { order: { id: number; order_number: string } };
  if (status !== 'pending') {
    const updated = await request.patch(`${BASE}/api/orders/${order.id}/status`, {
      headers: ownerHeaders(),
      data: { status },
    });
    expect(updated.ok(), `moving order ${order.id} to ${status} must succeed`).toBeTruthy();
  }
  return order;
}

test.describe('Customer display pairing and clipboard safety', () => {
  const createdOrderIds: number[] = [];

  test.beforeEach(async ({ page, request }) => {
    await revokeAllDisplayTokens(request);
    await resetCustomerDisplayConfig(request);
    await loginAsOwner(page);
    await setLanguage(page, 'en');
  });

  test.afterEach(async ({ request }) => {
    while (createdOrderIds.length > 0) {
      const id = createdOrderIds.pop()!;
      await request
        .patch(`${BASE}/api/orders/${id}/status`, {
          headers: ownerHeaders(),
          data: { status: 'completed' },
        })
        .catch(() => {});
    }
    await revokeAllDisplayTokens(request);
    await resetCustomerDisplayConfig(request);
  });

  test('pairs an unauthenticated display, strips the URL token fragment, persists across reload, survives revoking another device, and clears link and access on revoke', async ({
    page,
    browser,
    request,
  }) => {
    const preparingOrder = await createOrderWithStatus(request, 'preparing');
    createdOrderIds.push(preparingOrder.id);
    const readyOrder = await createOrderWithStatus(request, 'ready');
    createdOrderIds.push(readyOrder.id);

    const displayContext = await browser.newContext();
    try {
      const displayPage = await displayContext.newPage();

      // Without a staff session or paired token, the board redirects to login.
      await displayPage.goto(`${BASE}/customer-display/`);
      await expect(displayPage).toHaveURL(/\/auth\/login/);

      await openKdsSettingsTab(page);
      await expect(page.getByText('No displays paired yet', { exact: true })).toBeVisible();

      const labelInput = page.locator('#customer-display-pair-label');
      const pairButton = page.getByRole('button', { name: 'Pair display', exact: true });

      const pairingCodeEl = page.locator('code').filter({ hasText: '#token=' });

      // Pair a secondary device first so we can later revoke it without disconnecting the active board.
      await labelInput.fill('Secondary Display');
      await pairButton.click();
      await expect(pairingCodeEl).toBeVisible();
      const secondaryPairingUrl = (await pairingCodeEl.innerText()).trim();
      expect(secondaryPairingUrl).toMatch(/\/customer-display\/#token=cdt_[0-9a-f]{64}$/);

      // Pair the primary display; its one-time link replaces the previous banner.
      await labelInput.fill('Lobby TV');
      await pairButton.click();
      await expect(pairingCodeEl).not.toHaveText(secondaryPairingUrl);
      const pairingUrl = (await pairingCodeEl.innerText()).trim();
      expect(pairingUrl).toMatch(/\/customer-display\/#token=cdt_[0-9a-f]{64}$/);

      // Open the pairing URL in the unauthenticated display context.
      await displayPage.goto(pairingUrl);

      // The token fragment is consumed into localStorage and stripped from the address bar.
      await expect(displayPage).toHaveURL(/\/customer-display\/?$/);
      expect(displayPage.url()).not.toContain('#token=');
      const storedToken = await displayPage.evaluate(() => {
        return {
          displayToken: window.localStorage.getItem('flo.customerDisplayToken'),
          staffToken: window.localStorage.getItem('token'),
        };
      });
      expect(storedToken.displayToken).toMatch(/^cdt_[0-9a-f]{64}$/);
      expect(storedToken.staffToken).toBeNull();

      // The paired display renders the active orders without a staff session.
      await expect(displayPage.getByTestId('customer-display-preparing-scroll')).toContainText(
        preparingOrder.order_number,
      );
      await expect(displayPage.getByTestId('customer-display-ready-scroll')).toContainText(
        readyOrder.order_number,
      );

      // Reloading the display without the URL fragment keeps the board paired via stored token.
      await displayPage.reload();
      await expect(displayPage).toHaveURL(/\/customer-display\/?$/);
      await expect(displayPage.getByTestId('customer-display-preparing-scroll')).toContainText(
        preparingOrder.order_number,
      );
      await expect(displayPage.getByTestId('customer-display-ready-scroll')).toContainText(
        readyOrder.order_number,
      );

      // Revoking a different device ('Secondary Display') leaves Lobby TV's visible pairing link intact
      // and does not disconnect the active Lobby TV display.
      const secondaryRow = page.locator('li').filter({ hasText: 'Secondary Display' }).first();
      await expect(secondaryRow).toBeVisible();
      await secondaryRow.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(page.getByText('Display revoked', { exact: true })).toBeVisible();
      await expect(secondaryRow).toHaveCount(0);
      await expect(pairingCodeEl).toBeVisible();
      await expect(pairingCodeEl).toHaveText(pairingUrl);

      await displayPage.reload();
      await expect(displayPage.getByTestId('customer-display-preparing-scroll')).toContainText(
        preparingOrder.order_number,
      );
      await expect(displayPage.getByTestId('customer-display-ready-scroll')).toContainText(
        readyOrder.order_number,
      );

      // Revoking the active display ('Lobby TV') clears its visible one-time pairing link
      // and transitions the display to the unpaired state.
      const lobbyRow = page.locator('li').filter({ hasText: 'Lobby TV' }).first();
      await expect(lobbyRow).toBeVisible();
      await lobbyRow.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(page.getByText('Open this link on the display', { exact: true })).toHaveCount(0);
      await expect(page.getByText('No displays paired yet', { exact: true })).toBeVisible();

      await displayPage.reload();
      await expect(
        displayPage.getByRole('heading', { name: 'This display is not paired', exact: true }),
      ).toBeVisible();
      await expect(
        displayPage.getByText('Ask a manager for a new pairing link.', { exact: true }),
      ).toBeVisible();
      const tokenAfterRevoke = await displayPage.evaluate(() =>
        window.localStorage.getItem('flo.customerDisplayToken'),
      );
      expect(tokenAfterRevoke).toBeNull();
    } finally {
      await displayContext.close();
    }
  });

  test('guards both customer-display copy actions when navigator.clipboard is missing, throws synchronously, or rejects', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    // Simulate plain LAN HTTP where navigator.clipboard is undefined before the settings page loads.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      });
    });

    await openKdsSettingsTab(page);

    const card = page
      .locator('div.bg-card')
      .filter({ has: page.getByRole('heading', { name: 'Customer display', exact: true }) })
      .first();

    // Pair a display so both the static Display address copy action and the one-time pairing link copy action are present.
    await card.locator('#customer-display-pair-label').fill('LAN HTTP TV');
    await card.getByRole('button', { name: 'Pair display', exact: true }).click();
    await expect(card.getByText('Open this link on the display', { exact: true })).toBeVisible();

    const codeElements = card.locator('code');
    await expect(codeElements).toHaveCount(2);
    const displayUrlCode = codeElements.nth(0);
    const pairingUrlCode = codeElements.nth(1);
    const expectedDisplayUrl = (await displayUrlCode.innerText()).trim();
    const expectedPairingUrl = (await pairingUrlCode.innerText()).trim();
    expect(expectedDisplayUrl).toContain('/customer-display/');
    expect(expectedPairingUrl).toMatch(/\/customer-display\/#token=cdt_[0-9a-f]{64}$/);

    const copyButtons = card.getByRole('button', { name: 'Copy address', exact: true });
    await expect(copyButtons).toHaveCount(2);
    const copyDisplayUrlButton = copyButtons.nth(0);
    const copyPairingUrlButton = copyButtons.nth(1);

    async function assertBothLinksRemainSelectable() {
      await expect(displayUrlCode).toBeVisible();
      await expect(pairingUrlCode).toBeVisible();
      const selected = await page.evaluate(() => {
        const codes = Array.from(document.querySelectorAll('code')).filter((el) =>
          el.textContent?.includes('/customer-display/'),
        );
        const selection = window.getSelection();
        if (!selection || codes.length < 2) return [];
        return codes.map((code) => {
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(code);
          selection.addRange(range);
          return selection.toString().trim();
        });
      });
      expect(selected).toEqual([expectedDisplayUrl, expectedPairingUrl]);
    }

    // 1. Missing navigator.clipboard (plain LAN HTTP)
    await copyDisplayUrlButton.click();
    await expect(page.getByText('Failed to save', { exact: true }).first()).toBeVisible();
    await page.evaluate(() =>
      document.querySelectorAll('[role="status"]').forEach((n) => n.remove()),
    );

    await copyPairingUrlButton.click();
    await expect(
      page.getByText('Could not pair the display', { exact: true }).first(),
    ).toBeVisible();
    await assertBothLinksRemainSelectable();
    expect(pageErrors).toHaveLength(0);

    // 2. Synchronous exception from navigator.clipboard.writeText
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText() {
            throw new DOMException('Synchronous clipboard failure', 'NotAllowedError');
          },
        },
        configurable: true,
      });
    });

    await copyDisplayUrlButton.click();
    await expect(page.getByText('Failed to save', { exact: true }).first()).toBeVisible();

    await copyPairingUrlButton.click();
    await expect(
      page.getByText('Could not pair the display', { exact: true }).first(),
    ).toBeVisible();
    await assertBothLinksRemainSelectable();
    expect(pageErrors).toHaveLength(0);

    // 3. Rejected promise from navigator.clipboard.writeText
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText() {
            return Promise.reject(new DOMException('Async clipboard rejection', 'NotAllowedError'));
          },
        },
        configurable: true,
      });
    });

    await copyDisplayUrlButton.click();
    await expect(page.getByText('Failed to save', { exact: true }).first()).toBeVisible();

    await copyPairingUrlButton.click();
    await expect(
      page.getByText('Could not pair the display', { exact: true }).first(),
    ).toBeVisible();
    await assertBothLinksRemainSelectable();
    expect(pageErrors).toHaveLength(0);
  });
});
