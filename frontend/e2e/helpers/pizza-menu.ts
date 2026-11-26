import { expect, type APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getE2eToken } from './test-auth';
import { E2E_BASE_URL } from './urls';

export type SampleMenuItem = {
  id: string;
  price?: number;
  picks?: Array<{ size?: string }>;
  [field: string]: unknown;
};
export type SampleMenu = {
  categories: Array<{ id: string; name: string; items: SampleMenuItem[] }>;
  [field: string]: unknown;
};

const SAMPLE_FILE = path.resolve(__dirname, '../../../tests/fixtures/pizza-sample-menu.json');
const MENU_CATEGORY_IDS = ['cat-pizzas', 'cat-sides', 'cat-drinks', 'cat-deals'];

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });

/** A fresh copy of the made-up sample menu, safe to edit. */
export function sampleMenu(): SampleMenu {
  return JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
}

/** Loads the sample menu, or an edited copy of it, as the owner. */
export async function loadSampleMenu(
  request: APIRequestContext,
  menu: SampleMenu = sampleMenu(),
  base = E2E_BASE_URL,
): Promise<void> {
  const res = await request.post(`${base}/api/pizza/menu/import`, {
    headers: ownerHeaders(),
    data: menu,
  });
  expect(
    res.ok(),
    `loading a pizza menu on ${base} must succeed (got ${res.status()} ${await res.text()})`,
  ).toBeTruthy();
}

/**
 * Takes the menu's products and categories back out of the catalogue. The e2e server shares one
 * database across the whole suite, so a spec that loads a menu calls this in `test.afterAll`.
 *
 * A menu cannot be unloaded: afterwards the server stores an empty menu, not none, so a spec
 * must never assert "no menu" against the server.
 *
 * The emptied load switches off the add-on groups, and comes before the deletes because every
 * load brings "Pizzas" and "Half & Half" back. Each step runs whatever the others did.
 */
export async function clearPizzaMenu(
  request: APIRequestContext,
  base = E2E_BASE_URL,
): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, accepted: number[], send: () => Promise<number>) => {
    try {
      const status = await send();
      if (!accepted.includes(status)) failures.push(`${name}: status ${status}`);
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  };

  const emptied = sampleMenu();
  emptied.categories = [{ id: 'pizzas', name: 'Our Pizzas', items: [] }];
  await step('load the emptied menu', [200], async () =>
    (
      await request.post(`${base}/api/pizza/menu/import`, {
        headers: ownerHeaders(),
        data: emptied,
      })
    ).status(),
  );
  for (const id of MENU_CATEGORY_IDS) {
    // 404: the category was never loaded, or is already deleted.
    await step(`delete ${id}`, [200, 404], async () =>
      (
        await request.delete(`${base}/api/categories/${id}?action=delete_all`, {
          headers: ownerHeaders(),
        })
      ).status(),
    );
  }
  expect(failures, `clearing the pizza menu on ${base}`).toEqual([]);
}
