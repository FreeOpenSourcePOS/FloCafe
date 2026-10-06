import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test.describe('product cost price round trip', () => {
  let productId: string | undefined;

  test.afterEach(async ({ request }) => {
    if (!productId) return;
    const response = await request.delete(`${BASE}/api/products/${productId}`, {
      headers: { Authorization: `Bearer ${getE2eToken()}` },
    });
    expect(response.status(), 'test product is deleted after verification').toBe(200);
    productId = undefined;
  });

  test('shows the stored cost when editing and preserves or intentionally updates it', async ({ page }) => {
    const token = getE2eToken();
    const headers = { Authorization: `Bearer ${token}` };
    const suffix = Math.random().toString(36).slice(2, 8);
    const productName = `Cost Round Trip ${suffix}`;
    const categoriesResponse = await page.request.get(`${BASE}/api/categories`, { headers });
    expect(categoriesResponse.status(), 'active categories are available for the product').toBe(200);
    const categories = (await categoriesResponse.json()).categories as { id: string; is_active: boolean }[];
    const category = categories.find((candidate) => candidate.is_active);
    expect(category, 'an active category exists for the product').toBeTruthy();

    const createResponse = await page.request.post(`${BASE}/api/products`, {
      headers,
      data: { name: productName, category_id: category!.id, price: 100, cost_price: 60.25 },
    });
    expect(createResponse.status(), 'product with a stored cost price is created').toBe(201);
    productId = (await createResponse.json()).product.id as string;

    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${BASE}/products`);

    const productRow = () => page.getByRole('row').filter({ hasText: productName });
    await productRow().getByRole('button').first().click();
    const costInput = page.locator('form input[inputmode="decimal"]').nth(1);
    await expect(costInput, 'the editor shows the stored product cost price').toHaveValue('60.25');

    await page.locator('form input[type="text"]').first().fill(`${productName} Updated`);
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Product' })).toHaveCount(0);
    let productResponse = await page.request.get(`${BASE}/api/products/${productId}`, { headers });
    expect(productResponse.status()).toBe(200);
    expect((await productResponse.json()).product.cost).toBe(60.25);

    await page.getByRole('row').filter({ hasText: `${productName} Updated` }).getByRole('button').first().click();
    await expect(costInput, 'the stored cost is still present after an unrelated edit').toHaveValue('60.25');
    await costInput.fill('70.5');
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Product' })).toHaveCount(0);
    productResponse = await page.request.get(`${BASE}/api/products/${productId}`, { headers });
    expect(productResponse.status()).toBe(200);
    expect((await productResponse.json()).product.cost).toBe(70.5);

    await page.getByRole('row').filter({ hasText: `${productName} Updated` }).getByRole('button').first().click();
    await expect(costInput, 'an intentional cost change appears when editing again').toHaveValue('70.50');
    await costInput.fill('0');
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Product' })).toHaveCount(0);
    productResponse = await page.request.get(`${BASE}/api/products/${productId}`, { headers });
    expect(productResponse.status()).toBe(200);
    expect((await productResponse.json()).product.cost).toBe(0);
    await page.getByRole('row').filter({ hasText: `${productName} Updated` }).getByRole('button').first().click();
    await expect(costInput, 'zero remains an explicitly stored cost price').toHaveValue('0.00');
  });
});
