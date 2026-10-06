import { expect, APIRequestContext } from '@playwright/test';
import { E2E_BASE_URL } from './urls';
import { getE2eToken, E2E_PASSWORD } from './test-auth';

/** Creates and reuses the variant and add-on catalog needed by kitchen UAT specs. */

export const FIXTURE_PRODUCT_NAME = 'UAT Cappuccino';
export const FIXTURE_ADDON_GROUP_NAME = 'UAT Milk Options';
export const FIXTURE_CATEGORY_NAME = 'UAT Kitchen';
export const FIXTURE_TABLE_NAME = 'UAT-T1';
export const FIXTURE_CHEF_EMAIL = 'uat-chef@flo.local';

export interface UatVariant {
  id: string;
  name: string;
  price: number;
}

export interface UatAddon {
  id: string;
  name: string;
  price: number;
}

interface CategoryRow { id: string; name: string }
interface AddonGroupRow { id: string; name: string; addons?: UatAddon[] }
interface ProductRow { id: string; name: string; variants?: UatVariant[] }
interface TableRow { id: string; number?: string }
interface StaffRow { email: string }

export interface UatFixture {
  categoryId: string;
  productId: string;
  addonGroupId: string;
  tableId: string;
  variants: Record<'Large' | 'Small', UatVariant>;
  addons: Record<'Oat Milk' | 'Extra Shot', UatAddon>;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function loginToken(
  request: APIRequestContext,
  email: string,
  password = E2E_PASSWORD,
  base = E2E_BASE_URL,
): Promise<string> {
  const response = await request.post(`${base}/api/auth/login`, {
    data: { email, password, remember_me: false },
  });
  expect(response.ok(), `login for ${email} must succeed (got ${response.status()})`).toBeTruthy();
  const body = await response.json();
  return body.access_token as string;
}

/** Reads a settings value as the owner. Returns undefined when never set. */
export async function readSetting(request: APIRequestContext, key: string, base = E2E_BASE_URL): Promise<string | undefined> {
  const token = getE2eToken();
  const response = await request.get(`${base}/api/settings/${key}`, {
    headers: authHeaders(token),
  });
  if (!response.ok()) return undefined;
  const { setting } = await response.json();
  return setting?.value as string | undefined;
}

export async function writeSetting(request: APIRequestContext, key: string, value: string, base = E2E_BASE_URL): Promise<void> {
  const token = getE2eToken();
  const response = await request.put(`${base}/api/settings/${key}`, {
    headers: authHeaders(token),
    data: { value },
  });
  expect(response.ok(), `setting ${key}=${value} must save (got ${response.status()})`).toBeTruthy();
}

/** Restores a settings snapshot captured by {@link captureSettings}. */
export async function restoreSettings(
  request: APIRequestContext,
  snapshot: Map<string, string | undefined>,
  base = E2E_BASE_URL,
): Promise<void> {
  const defaults: Record<string, string> = {
    billing_type: 'postpaid',
    kds_enabled: 'true',
    require_kitchen_delivered_before_settlement: 'false',
  };
  for (const [key, value] of snapshot) {
    const restoredValue = value ?? defaults[key];
    if (restoredValue === undefined) {
      throw new Error(`No default is defined to restore setting ${key}`);
    }
    const token = getE2eToken();
    const response = await request.put(`${base}/api/settings/${key}`, {
      headers: authHeaders(token),
      data: { value: restoredValue },
    });
    expect(response.ok(), `restoring setting ${key} must succeed (got ${response.status()})`).toBeTruthy();
  }
}

export async function captureSettings(request: APIRequestContext, keys: string[], base = E2E_BASE_URL): Promise<Map<string, string | undefined>> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) snapshot.set(key, await readSetting(request, key, base));
  return snapshot;
}

/**
 * Creates (once) the UAT catalog, table and chef user, and returns their ids.
 * Safe to call from every test in every spec; later calls are reads.
 *
 * Takes an APIRequestContext rather than a Page so it can run in `beforeAll`,
 * where no browser page exists yet.
 */
export async function ensureUatFixture(request: APIRequestContext, base = E2E_BASE_URL): Promise<UatFixture> {
  const token = getE2eToken();
  const headers = authHeaders(token);

  // Category
  const categoriesResponse = await request.get(`${base}/api/categories`, { headers });
  expect(categoriesResponse.ok()).toBeTruthy();
  const categoriesBody = (await categoriesResponse.json()) as { categories?: CategoryRow[] };
  let category = (categoriesBody.categories || []).find((c) => c.name === FIXTURE_CATEGORY_NAME);
  if (!category) {
    const created = await request.post(`${base}/api/categories`, {
      headers,
      data: { name: FIXTURE_CATEGORY_NAME, sort_order: 900, is_active: true },
    });
    expect(created.ok(), `creating the UAT category must succeed (got ${created.status()})`).toBeTruthy();
    category = ((await created.json()) as { category: CategoryRow }).category;
  }

  // Add-on group (the add-ons hang off the group, not off a standalone route)
  const groupsResponse = await request.get(`${base}/api/addon-groups`, { headers });
  expect(groupsResponse.ok()).toBeTruthy();
  const groupsBody = (await groupsResponse.json()) as { addon_groups?: AddonGroupRow[]; groups?: AddonGroupRow[] };
  const groupList: AddonGroupRow[] = groupsBody.addon_groups || groupsBody.groups || [];
  let group = groupList.find((g: AddonGroupRow) => g.name === FIXTURE_ADDON_GROUP_NAME);
  if (!group) {
    const created = await request.post(`${base}/api/addon-groups`, {
      headers,
      data: { name: FIXTURE_ADDON_GROUP_NAME, is_active: true, min_selections: 0, max_selections: 3 },
    });
    expect(created.ok(), `creating the UAT add-on group must succeed (got ${created.status()})`).toBeTruthy();
    group = ((await created.json()) as { addon_group: AddonGroupRow }).addon_group;
  }

  const addonsByName: Record<string, UatAddon> = {};
  for (const [name, price] of [['Oat Milk', 15], ['Extra Shot', 10]] as const) {
    let addon = (group.addons || []).find((a: UatAddon) => a.name === name);
    if (!addon) {
      const detail = await request.get(`${base}/api/addon-groups/${group.id}`, { headers });
      const detailBody = await detail.json();
      addon = ((detailBody.addon_group || detailBody.group || {}).addons || []).find((a: UatAddon) => a.name === name);
    }
    if (!addon) {
      const created = await request.post(`${base}/api/addon-groups/${group.id}/addons`, {
        headers,
        data: { name, price, is_active: true },
      });
      expect(created.ok(), `creating add-on ${name} must succeed (got ${created.status()})`).toBeTruthy();
      addon = ((await created.json()) as { addon: UatAddon }).addon;
    }
    addonsByName[name] = { id: addon.id, name: addon.name, price };
  }

  // Product with two variants, linked to the add-on group.
  const productsResponse = await request.get(`${base}/api/products`, { headers });
  expect(productsResponse.ok()).toBeTruthy();
  const productsBody = (await productsResponse.json()) as { products?: ProductRow[] };
  let product = (productsBody.products || []).find((p: ProductRow) => p.name === FIXTURE_PRODUCT_NAME);
  if (!product) {
    const created = await request.post(`${base}/api/products`, {
      headers,
      data: {
        name: FIXTURE_PRODUCT_NAME,
        category_id: category.id,
        price: 80,
        tax_type: 'none',
        tax_category_id: 'standard',
        tax_behavior: 'exclusive',
        is_active: true,
        variants: [
          { name: 'Large', price: 95 },
          { name: 'Small', price: 70 },
        ],
      },
    });
    expect(created.ok(), `creating the UAT product must succeed (got ${created.status()})`).toBeTruthy();
    product = ((await created.json()) as { product: ProductRow }).product;
  }

  const linkResponse = await request.put(`${base}/api/products/${product.id}`, {
    headers,
    data: { addon_group_ids: [group.id] },
  });
  expect(linkResponse.ok(), `linking the add-on group must succeed (got ${linkResponse.status()})`).toBeTruthy();

  const detailResponse = await request.get(`${base}/api/products/${product.id}`, { headers });
  expect(detailResponse.ok()).toBeTruthy();
  const detailProduct = ((await detailResponse.json()) as { product: ProductRow }).product;
  const allVariants = detailProduct.variants || [];
  const large = allVariants.find((v) => v.name === 'Large');
  const small = allVariants.find((v) => v.name === 'Small');
  expect(large, 'the UAT product must keep a Large variant').toBeTruthy();
  expect(small, 'the UAT product must keep a Small variant').toBeTruthy();
  const variants = { Large: large as UatVariant, Small: small as UatVariant };

  // Table
  const tablesResponse = await request.get(`${base}/api/tables`, { headers });
  expect(tablesResponse.ok()).toBeTruthy();
  const tablesBody = (await tablesResponse.json()) as { tables?: TableRow[] };
  let table = (tablesBody.tables || []).find((t: TableRow) => t.number === FIXTURE_TABLE_NAME);
  if (!table) {
    const created = await request.post(`${base}/api/tables`, {
      headers,
      data: { number: FIXTURE_TABLE_NAME, name: FIXTURE_TABLE_NAME, capacity: 4, is_active: true },
    });
    expect(created.ok(), `creating the UAT table must succeed (got ${created.status()})`).toBeTruthy();
    table = ((await created.json()) as { table: TableRow }).table;
  }

  // Chef user. The KDS treats `chef` as a restricted-payload role, which is
  // the whole point of the variant-line scenario, so the fixture needs one.
  const staffResponse = await request.get(`${base}/api/staff`, { headers });
  if (staffResponse.ok()) {
    const staffBody = (await staffResponse.json()) as { staff?: StaffRow[]; users?: StaffRow[] };
    const staffList = staffBody.staff || staffBody.users || [];
    if (!staffList.some((s: StaffRow) => s.email === FIXTURE_CHEF_EMAIL)) {
      const created = await request.post(`${base}/api/users`, {
        headers,
        data: {
          name: 'UAT Chef',
          email: FIXTURE_CHEF_EMAIL,
          password: E2E_PASSWORD,
          role: 'chef',
          is_active: true,
        },
      });
      expect(created.ok(), `creating the UAT chef must succeed (got ${created.status()})`).toBeTruthy();
    }
  }

  return {
    categoryId: category.id,
    productId: product.id,
    addonGroupId: group.id,
    tableId: table.id,
    variants,
    addons: {
      'Oat Milk': addonsByName['Oat Milk'],
      'Extra Shot': addonsByName['Extra Shot'],
    },
  };
}

/** An order item payload in exactly the shape the POS/server-app builders send. */
export function orderItem(
  productId: string,
  options: { quantity?: number; variantId?: string | null; addons?: UatAddon[]; instructions?: string } = {},
) {
  return {
    product_id: productId,
    variant_id: options.variantId ?? null,
    quantity: options.quantity ?? 1,
    addons:
      options.addons && options.addons.length > 0
        ? options.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: 1 }))
        : null,
    special_instructions: options.instructions ?? null,
  };
}
