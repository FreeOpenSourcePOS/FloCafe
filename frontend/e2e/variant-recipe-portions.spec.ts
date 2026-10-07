import { test, expect, type APIRequestContext } from '@playwright/test';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * Variant recipe portions end to end.
 *
 * A menu product's own ingredient recipe is scaled by the ordered variant's
 * portion: 0.5 consumes half of every ingredient, 2 consumes double. The
 * portion is configured in the back-office variants table, and the depletion a
 * sale and an append produce is read back from the supplies API, which is the
 * authoritative stock record.
 *
 * The suite shares one database and one server, so every fixture it creates is
 * unique per run and removed afterwards.
 */

const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};

type Fixture = {
  productId: string;
  productName: string;
  supplyId: string;
  halfVariantId: string;
  doubleVariantId: string;
};

async function activeCategoryId(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${BASE}/api/categories`, { headers: managerHeaders });
  expect(response.status(), 'active categories are readable').toBe(200);
  const categories = (await response.json()).categories as { id: string; is_active: boolean }[];
  const category = categories.find((candidate) => candidate.is_active);
  expect(category, 'an active category exists for the product').toBeTruthy();
  return category!.id;
}

async function supplyStock(request: APIRequestContext, supplyId: string): Promise<number> {
  const response = await request.get(`${BASE}/api/supplies/${supplyId}`, { headers: managerHeaders });
  expect(response.status(), 'the supply is readable').toBe(200);
  return Number((await response.json()).supply.stock_quantity);
}

function snapshotQuantity(order: { items: { recipe_snapshot: unknown }[] }, supplyId: string): number {
  const snapshot = order.items[0].recipe_snapshot as { components: { supply_id: string; quantity: number }[] };
  return snapshot.components.find((component) => component.supply_id === supplyId)!.quantity;
}

async function openProductEditor(page: import('@playwright/test').Page, productName: string): Promise<void> {
  await page.goto(`${BASE}/products`);
  await page.getByRole('row').filter({ hasText: productName }).getByRole('button').first().click();
}

test.describe('variant recipe portions', () => {
  let fixture: Fixture | undefined;

  test.beforeAll(async ({ request }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const categoryId = await activeCategoryId(request);

    // A supply to deplete, and a recipe whose ingredients the portion scales.
    const supplyResponse = await request.post(`${BASE}/api/supplies`, {
      headers: managerHeaders,
      data: { name: `Portion beans ${suffix}`, base_unit: 'g', stock_quantity: 1000 },
    });
    expect(supplyResponse.status(), 'the fixture supply is created').toBe(201);
    const supplyId = (await supplyResponse.json()).supply.id as string;

    // Both variants are created without a portion, so the editor starts from
    // the one-portion default the migration gives every existing variant.
    const productResponse = await request.post(`${BASE}/api/products`, {
      headers: managerHeaders,
      data: {
        name: `Portion latte ${suffix}`,
        category_id: categoryId,
        price: 300,
        variants: [
          { name: 'Half', price: 200 },
          { name: 'Double', price: 400 },
        ],
      },
    });
    expect(productResponse.status(), 'the fixture product is created').toBe(201);
    const product = (await productResponse.json()).product;
    const variants = product.variants as { id: string; name: string; recipe_multiplier: number }[];
    expect(
      variants.map((variant) => variant.recipe_multiplier),
      'a variant created without a portion reads one portion',
    ).toEqual([1, 1]);

    const recipeResponse = await request.put(`${BASE}/api/recipes/product/${product.id}`, {
      headers: managerHeaders,
      data: { yield_quantity: 1, items: [{ supply_id: supplyId, quantity: 18, unit: 'g' }] },
    });
    expect(recipeResponse.status(), 'the fixture recipe is saved').toBe(200);

    fixture = {
      productId: product.id,
      productName: product.name as string,
      supplyId,
      halfVariantId: variants.find((variant) => variant.name === 'Half')!.id,
      doubleVariantId: variants.find((variant) => variant.name === 'Double')!.id,
    };
  });

  test.afterAll(async ({ request }) => {
    if (!fixture) return;
    // The recipe holds the supply, so it goes first; otherwise the supply is in use.
    expect((await request.delete(`${BASE}/api/recipes/product/${fixture.productId}`, { headers: managerHeaders })).status()).toBe(200);
    expect((await request.delete(`${BASE}/api/supplies/${fixture.supplyId}`, { headers: managerHeaders })).status()).toBe(200);
    expect((await request.delete(`${BASE}/api/products/${fixture.productId}`, { headers: managerHeaders })).status()).toBe(200);
  });

  test('a configured portion drives supply depletion for a sale and an append', async ({ page, request }) => {
    expect(fixture, 'the fixture was built').toBeTruthy();
    const { productId, productName, supplyId, halfVariantId, doubleVariantId } = fixture!;

    // The tenant language is pinned before login so the editor labels are stable.
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('manager@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });

    await openProductEditor(page, productName);
    const portions = page.getByLabel('Recipe multiplier');
    await expect(portions, 'every variant row exposes its recipe portion').toHaveCount(2);
    await expect(portions.first(), 'a variant starts at one base portion').toHaveValue('1');
    await portions.first().fill('0.5');
    await portions.nth(1).fill('2');
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit Product' })).toHaveCount(0);

    const stored = await request.get(`${BASE}/api/products/${productId}`, { headers: managerHeaders });
    expect(stored.status()).toBe(200);
    const storedVariants = (await stored.json()).product.variants as { id: string; recipe_multiplier: number }[];
    expect(storedVariants.find((variant) => variant.id === halfVariantId)!.recipe_multiplier).toBe(0.5);
    expect(storedVariants.find((variant) => variant.id === doubleVariantId)!.recipe_multiplier).toBe(2);

    // Re-opening the editor shows what was configured, not the default.
    await openProductEditor(page, productName);
    await expect(page.getByLabel('Recipe multiplier').first(), 'the half portion round-trips').toHaveValue('0.5');
    await expect(page.getByLabel('Recipe multiplier').nth(1), 'the double portion round-trips').toHaveValue('2');

    // One double portion: twice the base recipe, recorded in the snapshot.
    const beforeDouble = await supplyStock(request, supplyId);
    const doubleOrder = await request.post(`${BASE}/api/orders`, {
      headers: managerHeaders,
      data: { type: 'takeaway', items: [{ product_id: productId, variant_id: doubleVariantId, quantity: 1 }] },
    });
    expect(doubleOrder.status(), 'a double-portion order is created').toBe(201);
    const orderId = (await doubleOrder.json()).order.id as string;
    expect(await supplyStock(request, supplyId), 'one double portion depletes two base portions').toBe(beforeDouble - 36);

    const orderDetail = await request.get(`${BASE}/api/orders/${orderId}`, { headers: managerHeaders });
    expect(orderDetail.status()).toBe(200);
    expect(
      snapshotQuantity((await orderDetail.json()).order, supplyId),
      'the order records the doubled amount as its restorable quantity',
    ).toBe(36);

    // Appending another double portion depletes again, through the same rules.
    const beforeAppend = await supplyStock(request, supplyId);
    const appended = await request.post(`${BASE}/api/orders/${orderId}/items`, {
      headers: managerHeaders,
      data: { items: [{ product_id: productId, variant_id: doubleVariantId, quantity: 1 }] },
    });
    expect(appended.status(), 'a second double portion is appended').toBe(200);
    expect(await supplyStock(request, supplyId), 'the appended portion depletes its own amount').toBe(beforeAppend - 36);

    // Two half portions cost exactly one base portion.
    const beforeHalf = await supplyStock(request, supplyId);
    const halfOrder = await request.post(`${BASE}/api/orders`, {
      headers: managerHeaders,
      data: { type: 'takeaway', items: [{ product_id: productId, variant_id: halfVariantId, quantity: 2 }] },
    });
    expect(halfOrder.status(), 'a half-portion order is created').toBe(201);
    expect(await supplyStock(request, supplyId), 'half of the base recipe, twice over').toBe(beforeHalf - 18);

    // The ledger carries the scaled amounts, one depletion row per write.
    const movements = await request.get(`${BASE}/api/supplies/movements?supply_id=${supplyId}&movement_type=recipe_depletion`, {
      headers: managerHeaders,
    });
    expect(movements.status(), 'the supply ledger is readable').toBe(200);
    expect(
      ((await movements.json()).movements as { quantity_delta: number }[])
        .map((movement) => Math.abs(movement.quantity_delta))
        .sort((left, right) => left - right),
      'each recorded depletion matches the portion that produced it',
    ).toEqual([18, 36, 36]);

    // Cancelling the appended portion returns the doubled amount it recorded,
    // not a portion recomputed from the catalog as it stands now.
    const afterAppend = await request.get(`${BASE}/api/orders/${orderId}`, { headers: managerHeaders });
    const appendedItem = ((await afterAppend.json()).order.items as { id: number }[]).slice(-1)[0];
    expect(appendedItem, 'the appended item can be addressed for a cancel').toBeTruthy();
    const beforeCancel = await supplyStock(request, supplyId);
    const cancelled = await request.patch(`${BASE}/api/orders/${orderId}/items/${appendedItem.id}/cancel`, {
      headers: managerHeaders,
      data: {},
    });
    expect(cancelled.status(), 'the doubled item can be cancelled').toBe(200);
    expect(await supplyStock(request, supplyId), 'cancelling returns the snapshotted double portion').toBe(beforeCancel + 36);
  });

  test('a zero portion is refused before the catalog is written', async ({ page, request }) => {
    expect(fixture, 'the fixture was built').toBeTruthy();
    const { productId, productName, halfVariantId } = fixture!;
    const storedBefore = await request.get(`${BASE}/api/products/${productId}`, { headers: managerHeaders });
    const storedBeforeValue = ((await storedBefore.json()).product.variants as { id: string; recipe_multiplier: number }[])
      .find((variant) => variant.id === halfVariantId)!.recipe_multiplier;

    await setLanguage(page, 'en');
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('manager@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });

    await openProductEditor(page, productName);
    await page.getByLabel('Recipe multiplier').first().fill('0');
    await page.getByRole('button', { name: 'Update Product', exact: true }).click();

    await expect(
      page.getByText('Every variant needs a name, a price, and a recipe multiplier greater than zero.'),
      'the draft is refused with the reason',
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edit Product' }), 'the editor stays open on the refused draft').toBeVisible();

    const stored = await request.get(`${BASE}/api/products/${productId}`, { headers: managerHeaders });
    const storedVariants = (await stored.json()).product.variants as { id: string; recipe_multiplier: number }[];
    expect(
      storedVariants.find((variant) => variant.id === halfVariantId)!.recipe_multiplier,
      'a refused draft never reaches the catalog',
    ).toBe(storedBeforeValue);
  });
});
