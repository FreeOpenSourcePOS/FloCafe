/**
 * Loads the sample menu into a test database the way the contract maps it onto
 * the catalogue (derived ids, `pizza_menu`, `pizza_products`), without the
 * menu importer. Require it after the Electron mock is installed.
 */
const { parseMenuFile } = require('../../shared/pizza/menu');
const { now } = require('../../main/db');
const { seedCategory, seedProduct } = require('./test-setup');

type PizzaCatalog = import('../../shared/pizza/types').PizzaCatalog;

/**
 * Writes the catalogue of the one `pizza_menu` row, leaving the rows a load owns as they are.
 * Every pizza test that needs the row goes through here.
 */
function writePizzaMenu(db: any, catalogText: string): void {
  db.prepare(
    `INSERT INTO pizza_menu (id, catalog, imported_at) VALUES (1, @catalog, @at)
     ON CONFLICT(id) DO UPDATE SET catalog = @catalog, imported_at = @at`,
  ).run({ catalog: catalogText, at: now() });
}

/** Seeds pizzas, the half-and-half product, deals and one plain side. Returns the catalogue. */
function seedPizzaMenu(db: any): PizzaCatalog {
  const catalog: PizzaCatalog = parseMenuFile(require('../fixtures/pizza-sample-menu.json'));
  const dollars = (cents: number) => cents / 100;
  const mark = (productId: string, menuId: string, kind: string, extra: object = {}) => {
    const row = { ingredients: null, picks: null, ...extra };
    db.prepare(
      `INSERT INTO pizza_products (product_id, menu_id, kind, ingredients, picks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(productId, menuId, kind, row.ingredients, row.picks, now(), now());
  };
  const pizzaProduct = (productId: string, name: string) => {
    seedProduct(db, productId, 'cat-pizzas', name, dollars(catalog.sizes[0].priceCents));
    catalog.sizes.forEach((size, index) =>
      db
        .prepare(
          `INSERT INTO product_variants (id, product_id, name, price, is_active, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          `${productId}-${size.id}`,
          productId,
          size.label,
          dollars(size.priceCents),
          index,
          now(),
          now(),
        ),
    );
  };

  writePizzaMenu(db, JSON.stringify(catalog));
  seedCategory(db, 'cat-pizzas', 'Pizzas');
  for (const pizza of catalog.pizzas) {
    pizzaProduct(`pz-${pizza.id}`, pizza.name);
    mark(`pz-${pizza.id}`, pizza.id, 'pizza', { ingredients: JSON.stringify(pizza.ingredients) });
  }
  pizzaProduct('pz-half-and-half', 'Half & Half');
  mark('pz-half-and-half', 'half-and-half', 'half-and-half');

  seedCategory(db, 'cat-deals', 'Deals');
  for (const deal of catalog.deals) {
    seedProduct(db, `dl-${deal.id}`, 'cat-deals', deal.name, dollars(deal.priceCents));
    mark(`dl-${deal.id}`, deal.id, 'deal', { picks: JSON.stringify(deal.picks) });
  }

  seedCategory(db, 'cat-sides', 'Sides');
  const salad = catalog.sides.find((side) => side.id === 'green-salad')!;
  seedProduct(db, 'sd-green-salad', 'cat-sides', salad.name, dollars(salad.priceCents));
  return catalog;
}

module.exports = { seedPizzaMenu, writePizzaMenu };
