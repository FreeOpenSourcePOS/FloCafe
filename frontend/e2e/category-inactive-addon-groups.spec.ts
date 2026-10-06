import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('category editor can remove an assigned inactive add-on group', async ({ page }) => {
  const token = getE2eToken();
  const headers = { Authorization: `Bearer ${token}` };
  const suffix = Math.random().toString(36).slice(2, 8);
  const groupName = `Retired Group ${suffix}`;
  const categoryName = `Retained Group Category ${suffix}`;
  const groupResponse = await page.request.post(`${BASE}/api/addon-groups`, {
    headers,
    data: {
      name: groupName,
      is_required: false,
      min_selection: 0,
      max_selection: 1,
      allow_multiple_quantities: false,
      addons: [{ name: `Choice ${suffix}`, price: 25 }],
    },
  });
  expect(groupResponse.status(), 'test add-on group is created').toBe(201);
  const groupId = (await groupResponse.json()).addon_group.id as string;
  const categoryResponse = await page.request.post(`${BASE}/api/categories`, {
    headers,
    data: { name: categoryName, addon_group_ids: [groupId] },
  });
  expect(categoryResponse.status(), 'test category is created with the active group').toBe(201);
  const categoryId = (await categoryResponse.json()).category.id as string;
  const deactivation = await page.request.delete(`${BASE}/api/addon-groups/${groupId}`, { headers });
  expect(deactivation.status(), 'assigned group is soft-deleted').toBe(200);

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/products`);
  await page.getByRole('tab', { name: 'Categories', exact: true }).click();

  const row = page.getByRole('row').filter({ hasText: categoryName });
  await row.getByRole('button').first().click();
  const inactiveGroupCheckbox = page.getByLabel(`${groupName} (Inactive)`, { exact: true });
  await expect(inactiveGroupCheckbox, 'the retained inactive group is visible by name and status').toBeChecked();
  await inactiveGroupCheckbox.click();
  await expect(inactiveGroupCheckbox).not.toBeChecked();
  await inactiveGroupCheckbox.check();
  await expect(inactiveGroupCheckbox, 'an original inactive assignment can be restored before saving').toBeChecked();
  await inactiveGroupCheckbox.click();
  await expect(inactiveGroupCheckbox).not.toBeChecked();
  await page.getByRole('button', { name: 'Update', exact: true }).click();

  const updatedCategoryResponse = await page.request.get(`${BASE}/api/categories/${categoryId}`, { headers });
  expect(updatedCategoryResponse.status()).toBe(200);
  expect((await updatedCategoryResponse.json()).category.addon_group_ids).not.toContain(groupId);

  await page.getByRole('button', { name: 'Add Category', exact: true }).click();
  await expect(page.getByLabel(`${groupName} (Inactive)`, { exact: true }), 'unassigned inactive groups are not offered for attachment').toHaveCount(0);
});

test.describe('product editor', () => {
  let groupId: string | undefined;
  let productId: string | undefined;

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: `Bearer ${getE2eToken()}` };
    const productCleanup = productId
      ? await request.delete(`${BASE}/api/products/${productId}`, { headers })
      : undefined;
    const groupCleanup = groupId
      ? await request.delete(`${BASE}/api/addon-groups/${groupId}`, { headers })
      : undefined;
    productId = undefined;
    groupId = undefined;
    if (productCleanup) {
      expect(productCleanup.status(), 'test product is deleted after verification').toBe(200);
    }
    if (groupCleanup) {
      expect(groupCleanup.status(), 'test add-on group is left inactive').toBe(200);
    }
  });

  test('can retain or remove its assigned inactive add-on group', async ({ page }) => {
    const token = getE2eToken();
    const headers = { Authorization: `Bearer ${token}` };
    const suffix = Math.random().toString(36).slice(2, 8);
    const groupName = `Retired Product Group ${suffix}`;
    const productName = `Retained Group Product ${suffix}`;
    const groupResponse = await page.request.post(`${BASE}/api/addon-groups`, {
      headers,
      data: {
        name: groupName,
        is_required: false,
        min_selection: 0,
        max_selection: 1,
        allow_multiple_quantities: false,
        addons: [{ name: `Choice ${suffix}`, price: 25 }],
      },
    });
    expect(groupResponse.status(), 'test add-on group is created').toBe(201);
    groupId = (await groupResponse.json()).addon_group.id as string;
    const productResponse = await page.request.post(`${BASE}/api/products`, {
      headers,
      data: { name: productName, category_id: 'e2e-category', price: 100, addon_group_ids: [groupId] },
    });
    expect(productResponse.status(), 'test product is created with the active group').toBe(201);
    productId = (await productResponse.json()).product.id as string;
    const deactivation = await page.request.delete(`${BASE}/api/addon-groups/${groupId}`, { headers });
    expect(deactivation.status(), 'assigned group is soft-deleted').toBe(200);

    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${BASE}/products`);

    const row = page.getByRole('row').filter({ hasText: productName });
    await row.getByRole('button').first().click();
    const inactiveGroupCheckbox = page.locator(`#addon-group-${groupId}`);
    await expect(inactiveGroupCheckbox, 'the retained inactive product group is visible').toBeChecked();
    await expect(page.getByText(`${groupName} (Inactive)`, { exact: false })).toBeVisible();
    await inactiveGroupCheckbox.click();
    await expect(inactiveGroupCheckbox).not.toBeChecked();
    await inactiveGroupCheckbox.check();
    await expect(inactiveGroupCheckbox, 'an original inactive assignment can be restored before saving').toBeChecked();
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();

    const retainedProductResponse = await page.request.get(`${BASE}/api/products/${productId}`, { headers });
    expect(retainedProductResponse.status()).toBe(200);
    expect((await retainedProductResponse.json()).product.addon_group_ids).toContain(groupId);

    await page.getByRole('row').filter({ hasText: productName }).getByRole('button').first().click();
    const removableGroupCheckbox = page.locator(`#addon-group-${groupId}`);
    await expect(removableGroupCheckbox).toBeChecked();
    await removableGroupCheckbox.uncheck();
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();

    const removedProductResponse = await page.request.get(`${BASE}/api/products/${productId}`, { headers });
    expect(removedProductResponse.status()).toBe(200);
    expect((await removedProductResponse.json()).product.addon_group_ids).not.toContain(groupId);
    const reattachResponse = await page.request.put(`${BASE}/api/products/${productId}`, {
      headers,
      data: { addon_group_ids: [groupId] },
    });
    expect(reattachResponse.status(), 'a removed inactive group cannot be attached again').toBe(400);
  });
});
