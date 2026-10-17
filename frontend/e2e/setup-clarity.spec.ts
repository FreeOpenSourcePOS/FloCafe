import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test.describe('FloCafe Manager Setup Clarity - Add-ons (#1155)', () => {
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const cashierToken = getE2eToken('e2e-cashier', 'cashier@flo.local', 'cashier');
  const authHeaders = { Authorization: `Bearer ${ownerToken}` };

  test('direct legacy /addon-groups navigates and replaces history to /products?tab=addons', async ({ page }) => {
    await page.addInitScript((token) => {
      localStorage.setItem('token', token);
    }, ownerToken);

    await page.goto(`${BASE}/dashboard`);
    await page.goto(`${BASE}/addon-groups`);

    await page.waitForURL(
      (url) => url.pathname.startsWith('/products') && url.searchParams.get('tab') === 'addons',
      { timeout: 10_000 },
    );
    expect(page.url()).toContain('/products');
    expect(page.url()).toContain('tab=addons');

    // Going back in browser history should return to dashboard, not bounce back into /addon-groups
    await page.goBack();
    await page.waitForURL((url) => url.pathname.startsWith('/dashboard'), { timeout: 10_000 });
    expect(page.url()).toContain('/dashboard');
  });

  test('canonical tab deep link, reload, and query navigation work as expected', async ({ page }) => {
    await page.addInitScript((token) => {
      localStorage.setItem('token', token);
    }, ownerToken);

    // 1. Direct visit to /products?tab=addons selects Add-on Groups
    await page.goto(`${BASE}/products?tab=addons`);
    const addonsTabTrigger = page.getByRole('tab', { name: /add-?on groups/i });
    await expect(addonsTabTrigger).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('button', { name: /add add-?on group/i })).toBeVisible();

    // 2. Reload preserves selection
    await page.reload();
    await expect(addonsTabTrigger).toHaveAttribute('data-state', 'active');

    // 3. Tab clicks update the query with router.replace
    const productsTabTrigger = page.getByRole('tab', { name: /^products/i });
    await productsTabTrigger.click();
    await page.waitForURL(
      (url) => url.searchParams.get('tab') === 'products' || !url.searchParams.has('tab'),
      { timeout: 5_000 },
    );
    await expect(productsTabTrigger).toHaveAttribute('data-state', 'active');

    const categoriesTabTrigger = page.getByRole('tab', { name: /categories/i });
    await categoriesTabTrigger.click();
    await page.waitForURL((url) => url.searchParams.get('tab') === 'categories', { timeout: 5_000 });
    await expect(categoriesTabTrigger).toHaveAttribute('data-state', 'active');

    await addonsTabTrigger.click();
    await page.waitForURL((url) => url.searchParams.get('tab') === 'addons', { timeout: 5_000 });
    await expect(addonsTabTrigger).toHaveAttribute('data-state', 'active');

    // 4. Invalid tab query value safely falls back to products tab
    await page.goto(`${BASE}/products?tab=invalid_value`);
    await expect(productsTabTrigger).toHaveAttribute('data-state', 'active');
  });

  test('authorized non-restaurant business can manage add-on groups in Products', async ({ page, request }) => {
    // Read original business setting
    const bRes = await request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
    expect(bRes.ok()).toBeTruthy();
    const originalBusiness = await bRes.json();

    try {
      // Set business_type to 'retail' (non-restaurant)
      const updateRes = await request.put(`${BASE}/api/settings/business`, {
        headers: authHeaders,
        data: { ...originalBusiness, business_type: 'retail' },
      });
      expect(updateRes.ok()).toBeTruthy();

      await page.addInitScript((token) => {
        localStorage.setItem('token', token);
      }, ownerToken);

      await page.goto(`${BASE}/products?tab=addons`);

      // Add-on Groups tab trigger should be visible for authorized user even in retail
      const addonsTabTrigger = page.getByRole('tab', { name: /add-?on groups/i });
      await expect(addonsTabTrigger).toBeVisible();
      await expect(addonsTabTrigger).toHaveAttribute('data-state', 'active');

      // Add Add-on Group button should be visible
      await expect(page.getByRole('button', { name: /add add-?on group/i })).toBeVisible();
    } finally {
      // Restore business setting
      await request.put(`${BASE}/api/settings/business`, {
        headers: authHeaders,
        data: originalBusiness,
      });
    }
  });

  test('unauthorized user without catalog.manage is blocked from /products and /addon-groups', async ({ page }) => {
    await page.addInitScript((token) => {
      localStorage.setItem('token', token);
    }, cashierToken);

    await page.goto(`${BASE}/products?tab=addons`);
    // Cashier should be bounced away from /products by AuthGuard (to /pos)
    await page.waitForURL((url) => !url.pathname.startsWith('/products'), { timeout: 10_000 });
    expect(page.url()).not.toContain('/products');

    await page.goto(`${BASE}/addon-groups`);
    // Cashier should also be bounced away from /addon-groups
    await page.waitForURL((url) => !url.pathname.startsWith('/addon-groups') && !url.pathname.startsWith('/products'), { timeout: 10_000 });
    expect(page.url()).not.toContain('/addon-groups');
  });

  test('canonical group creation and editing in Products', async ({ page, request }) => {
    const runId = Date.now();
    const groupName = `Group_${runId}`;

    await page.addInitScript((token) => {
      localStorage.setItem('token', token);
    }, ownerToken);

    await page.goto(`${BASE}/products?tab=addons`);
    await page.getByRole('button', { name: /add add-?on group/i }).click();

    // Modal opens
    const modal = page.locator('div.fixed.inset-0');
    await expect(modal).toBeVisible();
    await modal.locator('form input[type="text"]').first().fill(groupName);

    // Add an add-on item
    await modal.getByRole('button', { name: /\+ add addon/i }).click();
    await modal.locator('input[placeholder*="Name" i], input[placeholder*="Addon" i]').last().fill('Vanilla');
    await modal.locator('input[aria-label="Price"]').last().fill('15');

    let posts = 0;
    await page.route('**/api/addon-groups', async (route) => {
      if (route.request().method() === 'POST') {
        posts += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await route.continue();
    });

    // Two submits in the same task: the in-flight guard must allow only one POST.
    await modal.locator('form').evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(modal).not.toBeVisible();
    expect(posts).toBe(1);

    // Verify row in table
    await expect(page.getByText(groupName)).toHaveCount(1);

    // Cleanup via API
    const listRes = await request.get(`${BASE}/api/addon-groups`, { headers: authHeaders });
    const groups = (await listRes.json()).addon_groups;
    const created = groups.find((g: { name: string; id: number }) => g.name === groupName);
    if (created) {
      await request.delete(`${BASE}/api/addon-groups/${created.id}`, { headers: authHeaders });
    }
  });

  test('preserves saved tax metadata on existing add-on edits', async ({ page, request }) => {
    const runId = Date.now();
    const groupName = `TaxGroup_${runId}`;

    // Create group with non-default tax metadata directly via API
    const createRes = await request.post(`${BASE}/api/addon-groups`, {
      headers: authHeaders,
      data: {
        name: groupName,
        is_required: false,
        min_selection: 0,
        max_selection: 2,
        addons: [
          {
            name: 'Taxed Extra',
            price: 25,
            tax_category_id: 'standard',
            tax_behavior: 'exclusive',
            inherit_parent_tax_category: false,
            track_inventory: false,
            low_stock_threshold: 0,
          },
        ],
      },
    });
    expect(createRes.status()).toBe(201);
    const createdGroup = (await createRes.json()).addon_group;
    const createdAddonId = createdGroup.addons[0].id;

    try {
      await page.addInitScript((token) => {
        localStorage.setItem('token', token);
      }, ownerToken);

      await page.goto(`${BASE}/products?tab=addons`);
      await expect(page.getByText(groupName)).toBeVisible();

      // Click Edit for this group
      const row = page.locator('tr').filter({ hasText: groupName });
      await row.getByRole('button', { name: /edit/i }).click();

      const modal = page.locator('div.fixed.inset-0');
      await expect(modal).toBeVisible();

      // Edit only the add-on name, leaving tax metadata untouched
      const nameInput = modal.locator('input[value="Taxed Extra"]');
      await nameInput.fill('Renamed Taxed Extra');

      // Save (Update)
      await modal.getByRole('button', { name: /create|update/i }).click();
      await expect(modal).not.toBeVisible();

      // Verify the persisted tax fields via API
      const getRes = await request.get(`${BASE}/api/addon-groups/${createdGroup.id}`, { headers: authHeaders });
      expect(getRes.ok()).toBeTruthy();
      const updatedGroup = (await getRes.json()).addon_group;
      const updatedAddon = updatedGroup.addons.find((a: { id: number; name: string; tax_category_id?: string | null; tax_behavior?: string; inherit_parent_tax_category?: boolean }) => a.id === createdAddonId);

      expect(updatedAddon.name).toBe('Renamed Taxed Extra');
      expect(updatedAddon.tax_category_id).toBe('standard');
      expect(updatedAddon.tax_behavior).toBe('exclusive');
      expect(updatedAddon.inherit_parent_tax_category).toBe(false);
    } finally {
      await request.delete(`${BASE}/api/addon-groups/${createdGroup.id}`, { headers: authHeaders });
    }
  });

  test('does not overwrite inventory stock during ordinary edits without stock changes', async ({ page, request }) => {
    const runId = Date.now();
    const groupName = `StockGroup_${runId}`;

    // Create group with inventory tracking and initial stock 10
    const createRes = await request.post(`${BASE}/api/addon-groups`, {
      headers: authHeaders,
      data: {
        name: groupName,
        is_required: false,
        min_selection: 0,
        max_selection: 2,
        addons: [
          {
            name: 'Stock Item',
            price: 10,
            track_inventory: true,
            stock_quantity: 10,
            low_stock_threshold: 2,
          },
        ],
      },
    });
    expect(createRes.status()).toBe(201);
    const createdGroup = (await createRes.json()).addon_group;
    const addonId = createdGroup.addons[0].id;

    try {
      await page.addInitScript((token) => {
        localStorage.setItem('token', token);
      }, ownerToken);

      await page.goto(`${BASE}/products?tab=addons`);
      const row = page.locator('tr').filter({ hasText: groupName });
      await row.getByRole('button', { name: /edit/i }).click();

      const modal = page.locator('div.fixed.inset-0');
      await expect(modal).toBeVisible();

      // Stock moves after the editor loaded its snapshot of 10.
      const adjustRes = await request.put(`${BASE}/api/addon-groups/${createdGroup.id}`, {
        headers: authHeaders,
        data: {
          name: groupName,
          addons: [
            {
              id: addonId,
              name: 'Stock Item',
              price: 10,
              track_inventory: true,
              stock_quantity: 7,
              low_stock_threshold: 2,
            },
          ],
        },
      });
      expect(adjustRes.ok()).toBeTruthy();

      await modal.locator('form input[type="text"]').first().fill(`${groupName}_Edited`);
      await modal.getByRole('button', { name: /create|update/i }).click();
      await expect(modal).not.toBeVisible();

      const checkRes = await request.get(`${BASE}/api/addon-groups/${createdGroup.id}`, { headers: authHeaders });
      const checkedGroup = (await checkRes.json()).addon_group;
      expect(checkedGroup.name).toBe(`${groupName}_Edited`);
      const checkedAddon = checkedGroup.addons.find((a: { id: number; stock_quantity?: number }) => a.id === addonId);
      expect(checkedAddon.stock_quantity).toBe(7);
    } finally {
      await request.delete(`${BASE}/api/addon-groups/${createdGroup.id}`, { headers: authHeaders });
    }
  });
});
