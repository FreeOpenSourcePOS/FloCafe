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
  const deactivation = await page.request.delete(`${BASE}/api/addon-groups/${groupId}`, {
    headers,
  });
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
  await expect(
    inactiveGroupCheckbox,
    'the retained inactive group is visible by name and status',
  ).toBeChecked();
  await inactiveGroupCheckbox.click();
  await expect(inactiveGroupCheckbox).not.toBeChecked();
  await inactiveGroupCheckbox.check();
  await expect(
    inactiveGroupCheckbox,
    'an original inactive assignment can be restored before saving',
  ).toBeChecked();
  await inactiveGroupCheckbox.click();
  await expect(inactiveGroupCheckbox).not.toBeChecked();
  await page.getByRole('button', { name: 'Update', exact: true }).click();

  const updatedCategoryResponse = await page.request.get(`${BASE}/api/categories/${categoryId}`, {
    headers,
  });
  expect(updatedCategoryResponse.status()).toBe(200);
  expect((await updatedCategoryResponse.json()).category.addon_group_ids).not.toContain(groupId);

  await page.getByRole('button', { name: 'Add Category', exact: true }).click();
  await expect(
    page.getByLabel(`${groupName} (Inactive)`, { exact: true }),
    'unassigned inactive groups are not offered for attachment',
  ).toHaveCount(0);
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
      data: {
        name: productName,
        category_id: 'e2e-category',
        price: 100,
        addon_group_ids: [groupId],
      },
    });
    expect(productResponse.status(), 'test product is created with the active group').toBe(201);
    productId = (await productResponse.json()).product.id as string;
    const deactivation = await page.request.delete(`${BASE}/api/addon-groups/${groupId}`, {
      headers,
    });
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
    await expect(
      inactiveGroupCheckbox,
      'the retained inactive product group is visible',
    ).toBeChecked();
    await expect(page.getByText(`${groupName} (Inactive)`, { exact: false })).toBeVisible();
    await inactiveGroupCheckbox.click();
    await expect(inactiveGroupCheckbox).not.toBeChecked();
    await inactiveGroupCheckbox.check();
    await expect(
      inactiveGroupCheckbox,
      'an original inactive assignment can be restored before saving',
    ).toBeChecked();
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();

    const retainedProductResponse = await page.request.get(`${BASE}/api/products/${productId}`, {
      headers,
    });
    expect(retainedProductResponse.status()).toBe(200);
    expect((await retainedProductResponse.json()).product.addon_group_ids).toContain(groupId);

    await page
      .getByRole('row')
      .filter({ hasText: productName })
      .getByRole('button')
      .first()
      .click();
    const removableGroupCheckbox = page.locator(`#addon-group-${groupId}`);
    await expect(removableGroupCheckbox).toBeChecked();
    await removableGroupCheckbox.uncheck();
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();

    const removedProductResponse = await page.request.get(`${BASE}/api/products/${productId}`, {
      headers,
    });
    expect(removedProductResponse.status()).toBe(200);
    expect((await removedProductResponse.json()).product.addon_group_ids).not.toContain(groupId);
    const reattachResponse = await page.request.put(`${BASE}/api/products/${productId}`, {
      headers,
      data: { addon_group_ids: [groupId] },
    });
    expect(reattachResponse.status(), 'a removed inactive group cannot be attached again').toBe(
      400,
    );
  });
});

test.describe('two-level category hierarchy UI', () => {
  const createdProductIds: string[] = [];
  const createdChildCategoryIds: string[] = [];
  const createdRootCategoryIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: `Bearer ${getE2eToken()}` };
    while (createdProductIds.length > 0) {
      const id = createdProductIds.pop()!;
      await request.delete(`${BASE}/api/products/${id}`, { headers });
    }
    while (createdChildCategoryIds.length > 0) {
      const id = createdChildCategoryIds.pop()!;
      await request.delete(`${BASE}/api/categories/${id}`, { headers });
    }
    while (createdRootCategoryIds.length > 0) {
      const id = createdRootCategoryIds.pop()!;
      await request.delete(`${BASE}/api/categories/${id}`, { headers });
    }
  });

  test('supports parent selector and indented tree in management and subcategory chip filtering in POS', async ({
    page,
  }) => {
    const token = getE2eToken();
    const headers = { Authorization: `Bearer ${token}` };
    const suffix = Math.random().toString(36).slice(2, 8);
    const parentName = `DrinksRoot ${suffix}`;
    const childName = `HotSub ${suffix}`;
    const flatRootName = `BakeryFlat ${suffix}`;
    const parentProdName = `House Water ${suffix}`;
    const childProdName = `Cortado ${suffix}`;
    const flatProdName = `Croissant ${suffix}`;

    const parentRes = await page.request.post(`${BASE}/api/categories`, {
      headers,
      data: { name: parentName, sort_order: -2 },
    });
    expect(parentRes.status()).toBe(201);
    const parentId = (await parentRes.json()).category.id as string;
    createdRootCategoryIds.push(parentId);

    const flatRes = await page.request.post(`${BASE}/api/categories`, {
      headers,
      data: { name: flatRootName, sort_order: -1 },
    });
    expect(flatRes.status()).toBe(201);
    const flatId = (await flatRes.json()).category.id as string;
    createdRootCategoryIds.push(flatId);

    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });

    // Create subcategory via Management UI parent selector
    await page.goto(`${BASE}/products`);
    await page.getByRole('tab', { name: 'Categories', exact: true }).click();
    await page.getByRole('button', { name: 'Add Category', exact: true }).click();
    await page.locator('form input[type="text"]').first().fill(childName);
    await page.locator('#category-parent-select').selectOption(parentId);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const childRow = page.getByRole('row').filter({ hasText: childName });
    await expect(childRow).toBeVisible();
    await expect(childRow).toHaveAttribute('data-category-depth', '1');

    const parentRow = page.getByRole('row').filter({ hasText: parentName }).first();
    await expect(parentRow).toHaveAttribute('data-category-depth', '0');

    // Look up created child category id for cleanup and seeding products
    const listRes = await page.request.get(`${BASE}/api/categories?parent_id=${parentId}`, {
      headers,
    });
    expect(listRes.status()).toBe(200);
    const childId = (await listRes.json()).categories[0].id as string;
    createdChildCategoryIds.push(childId);

    // Seed products under parent, child, and flat category
    for (const [name, catId, price] of [
      [parentProdName, parentId, 3],
      [childProdName, childId, 4.5],
      [flatProdName, flatId, 5],
    ] as const) {
      const pRes = await page.request.post(`${BASE}/api/products`, {
        headers,
        data: { name, category_id: catId, price },
      });
      expect(pRes.status()).toBe(201);
      createdProductIds.push((await pRes.json()).product.id as string);
    }

    // Navigate to POS and verify parent/subcategory chip behavior
    await page.goto(`${BASE}/pos`);
    await expect(page.getByText(parentProdName)).toBeVisible();
    await expect(page.getByText(childProdName)).toBeVisible();
    await expect(page.getByText(flatProdName)).toBeVisible();
    await expect(page.getByTestId('pos-subcategory-row')).toHaveCount(0);

    // Selecting flat category shows its product and NO subcategory bar
    await page.getByRole('button', { name: flatRootName, exact: true }).click();
    await expect(page.getByText(flatProdName)).toBeVisible();
    await expect(page.getByText(parentProdName)).toHaveCount(0);
    await expect(page.getByTestId('pos-subcategory-row')).toHaveCount(0);

    // Selecting parent category shows both direct parent product AND subcategory product, plus subcategory chips
    await page.getByRole('button', { name: parentName, exact: true }).click();
    await expect(page.getByTestId('pos-subcategory-row')).toBeVisible();
    await expect(page.getByText(parentProdName)).toBeVisible();
    await expect(page.getByText(childProdName)).toBeVisible();
    await expect(page.getByText(flatProdName)).toHaveCount(0);

    // Selecting subcategory chip filters to only that subcategory's products
    await page
      .getByTestId('pos-subcategory-row')
      .getByRole('button', { name: childName, exact: true })
      .click();
    await expect(page.getByText(childProdName)).toBeVisible();
    await expect(page.getByText(parentProdName)).toHaveCount(0);

    // Selecting "All" shows everything again and hides subcategory chips
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText(parentProdName)).toBeVisible();
    await expect(page.getByText(childProdName)).toBeVisible();
    await expect(page.getByText(flatProdName)).toBeVisible();
    await expect(page.getByTestId('pos-subcategory-row')).toHaveCount(0);
  });
});
