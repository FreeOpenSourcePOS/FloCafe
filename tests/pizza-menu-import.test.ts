/**
 * Pizza fork: loading a menu file writes FloCafe's own catalogue rows with ids derived from the
 * menu's ids, so loading it again changes nothing and a changed entry updates its own rows.
 *
 * The expected rows are written out by hand from the mapping table in pizza/contract.md and
 * the sample menu. The order total in case 7 is worked out by hand too:
 *   large pizza $23.00 + 2 dips x $1.25 = $25.50 food: GST 25.50 x 0.05 = 1.275 -> 1.28
 *   can of cola $1.75 soda: GST 0.0875 -> 0.09, PST 0.1225 -> 0.12
 *   together: subtotal 27.25, GST 1.37, PST 0.12, total 28.74
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pizza-menu-import.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-menu-import-'));
let userData = root;
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => userData, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-pizza-menu-import';

const jwt = require('jsonwebtoken');
const {
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const { getJWTSecret } = require('../main/routes/auth');
const { parseMenuFile } = require('../shared/pizza/menu');
const { importMenu } = require('../main/pizza/menu-import');

const SAMPLE = path.join(__dirname, 'fixtures', 'pizza-sample-menu.json');
const sampleMenu = () => JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const sizes = (menu: any) => menu.sizes.pizza;
const pizzas = (menu: any) => menu.categories[0].items;

const PIZZAS = ['garden', 'island', 'classic', 'smokehouse', 'plain', 'half-and-half'];
const DRINKS = ['cola', 'ginger-ale', 'lemon-lime'];
const DEALS = ['large-combo', 'three-large-wings', 'party', 'pasta-night'];

/** Every table the import writes, with the column that says when a row was last written. */
const TABLES: Array<[table: string, key: string, stamp: string | null]> = [
  ['categories', 'id', 'updated_at'],
  ['products', 'id', 'updated_at'],
  ['product_variants', 'id', 'updated_at'],
  ['addon_groups', 'id', 'updated_at'],
  ['addons', 'id', 'updated_at'],
  ['category_addon_groups', "category_id || '|' || addon_group_id", null],
  ['addon_group_product', "product_id || '|' || addon_group_id", null],
  ['pizza_products', 'product_id', 'updated_at'],
  ['pizza_menu', 'id', 'imported_at'],
];
const LONG_AGO = '2000-01-01 00:00:00';

const rows = (sql: string): any[] => getDatabase().prepare(sql).all();
/** One line per row: the named columns joined with `|`, in id order unless `order` says otherwise. */
const lines = (table: string, columns: string, where = '1 = 1', order = '1'): string[] =>
  rows(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${order}`).map((row) =>
    Object.values(row).join('|'),
  );
/** Every column of every row the import could write. */
const dump = (): string =>
  JSON.stringify(TABLES.map(([table]) => rows(`SELECT * FROM ${table} ORDER BY rowid`)));
/** Timestamps have one-second resolution, so a rewrite is only visible against an old stamp. */
function ageEveryRow(): void {
  for (const [table, , stamp] of TABLES) {
    if (!stamp) continue;
    const created = stamp === 'updated_at' ? ', created_at = @old' : '';
    getDatabase().prepare(`UPDATE ${table} SET ${stamp} = @old${created}`).run({ old: LONG_AGO });
  }
}
/** `table:key` of every row written since `ageEveryRow`. */
const written = (): string[] =>
  TABLES.flatMap(([table, key, stamp]) =>
    stamp
      ? rows(`SELECT ${key} AS k FROM ${table} WHERE ${stamp} <> '${LONG_AGO}' ORDER BY 1`).map(
          (row) => `${table}:${row.k}`,
        )
      : [],
  );
const load = (menu: unknown) => importMenu(getDatabase(), parseMenuFile(menu));
const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);

const failedCases: string[] = [];
async function testCase(name: string, run: () => unknown) {
  console.log(`\n--- ${name} ---`);
  try {
    await run();
  } catch (error: any) {
    failedCases.push(name);
    console.error(`  case failed: ${error?.message ?? error}`);
  }
}

/** Tax lines of an order, added up by label and rate as the reports do. */
function taxLines(breakdown: unknown): string {
  const merged = new Map<string, number>();
  for (const line of [breakdown].flat(3) as Array<{
    title: string;
    rate: number;
    amount: number;
  }>) {
    const key = `${line.title} ${line.rate}%`;
    merged.set(key, Math.round(((merged.get(key) ?? 0) + line.amount) * 100) / 100);
  }
  return [...merged].map(([key, amount]) => `${key} ${amount.toFixed(2)}`).join(', ');
}

async function main() {
  console.log('Pizza fork: loading a menu file');
  console.log('='.repeat(60));
  resetCounters();
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const post = (headers: Record<string, string>, body: unknown) =>
    api(baseUrl, '/api/pizza/menu/import', { method: 'POST', headers, body });
  const catalogOf = (headers: Record<string, string>) =>
    api(baseUrl, '/api/pizza/catalog', { headers });
  /** Opens a new store, runs first-time setup with the given profile and signs the owner in. */
  const setUpStore = async (profile: string): Promise<Record<string, string>> => {
    userData = path.join(root, profile);
    fs.mkdirSync(userData, { recursive: true });
    initDatabase();
    const setup = await api(baseUrl, '/api/auth/setup/initialize', {
      method: 'POST',
      body: {
        name: 'Pizza Owner',
        email: 'owner@example.com',
        password: 'TestPass123',
        business_type: 'restaurant',
        business_name: 'Sample Pizza Shop',
        setup_profile: profile,
        terms_accepted: true,
        owner_approval_pin: '5678',
        owner_approval_pin_confirmation: '5678',
        country: 'CA',
        currency: 'CAD',
        timezone: 'America/Vancouver',
      },
    });
    assertEqualOrThrow(setup.status, 200, `setup accepts the ${profile} profile`);
    return { Authorization: `Bearer ${setup.data.access_token}` };
  };

  try {
    const owner = await setUpStore('empty');
    getDatabase()
      .prepare(
        `INSERT INTO users (id, name, email, password, role, is_active)
         VALUES ('cashier-1', 'Test Cashier', 'cashier@test.local', 'x', 'cashier', 1)`,
      )
      .run();
    const cashier = {
      Authorization: `Bearer ${jwt.sign({ userId: 'cashier-1', role: 'cashier' }, getJWTSecret())}`,
    };
    const empty = dump();

    await testCase(
      '8. The route refuses a broken file and a user who cannot edit products',
      async () => {
        assertEqualOrThrow(
          (await catalogOf(owner)).status,
          404,
          'no catalogue before a menu is loaded',
        );

        const broken = sampleMenu();
        broken.categories[1].items[2].price = -1;
        const refused = await post(owner, broken);
        assertEqualOrThrow(refused.status, 400, 'a broken file answers 400');
        assertEqualOrThrow(
          refused.data.path,
          'categories.sides.items[2].price',
          'the answer names the bad entry',
        );
        assertEqualOrThrow(
          refused.data.error,
          'categories.sides.items[2].price: must be a price in dollars, 0 or more',
          'and says what is wrong with it',
        );
        assertEqualOrThrow(dump(), empty, 'a broken file writes nothing');

        const denied = await post(cashier, sampleMenu());
        assertEqualOrThrow(denied.status, 403, 'a cashier cannot load a menu');
        assertEqualOrThrow(
          denied.data.permission,
          'catalog.import-export',
          'the permission is the bulk import one',
        );
        assertEqualOrThrow(dump(), empty, 'a refused load writes nothing');

        const loaded = await post(owner, sampleMenu());
        assertEqualOrThrow(loaded.status, 200, 'the owner loads the sample menu');
        same(
          loaded.data,
          { created: 73, updated: 0, unchanged: 0, deactivated: 0, untaxed: true },
          'the answer is the summary',
        );
        const stored = await catalogOf(cashier);
        assertEqualOrThrow(stored.status, 200, 'a cashier reads the catalogue once it is loaded');
        same(stored.data, parseMenuFile(sampleMenu()), 'it is the catalogue parsed from the file');
      },
    );

    await testCase('1. Every row of the mapping table exists', () => {
      same(
        lines('categories', 'id, name, slug, sort_order, is_active'),
        [
          'cat-deals|Deals|deals|3|1',
          'cat-drinks|Drinks|drinks|2|1',
          'cat-pizzas|Pizzas|pizzas|0|1',
          'cat-sides|Sides|sides|1|1',
        ],
        'four categories, in menu order',
      );
      const named = fs
        .readFileSync(
          path.join(__dirname, '../frontend/src/components/pos/ProductGrid.tsx'),
          'utf8',
        )
        .split('const CATEGORY_COLORS')[1]
        .split('function getCategoryColorClasses')[0]
        .match(/^ {2}[a-z]+(?=: \{)/gm)
        .map((name: string) => name.trim());
      const colours = rows('SELECT color FROM categories').map((row) => row.color);
      assertOrThrow(
        colours.every((colour: string) => named.includes(colour)),
        `every category colour is a named colour (${colours.join(', ')})`,
      );
      assertEqualOrThrow(new Set(colours).size, 4, 'one colour per category');

      // A product with variants shows its lowest price on its tile.
      same(
        lines('products', "id, category_id, name, price, COALESCE(description, '-'), is_active"),
        [
          'dl-large-combo|cat-deals|Large Pizza Combo|35.5|1 large pizza, 1 pasta, 2 pops, 1 garlic toast|1',
          'dl-party|cat-deals|Party Pack|118.4|Any 6 large pizzas & 4 can pops or a 2L bottle|1',
          'dl-pasta-night|cat-deals|Pasta Night|29.99|3 pasta, 3 garlic toasts & 3 pops|1',
          'dl-three-large-wings|cat-deals|Large Pizzas & Wings|71.25|Any 3 large pizzas & 12 wings|1',
          'dr-cola|cat-drinks|Cola|1.75|-|1',
          'dr-ginger-ale|cat-drinks|Ginger Ale|1.75|-|1',
          'dr-lemon-lime|cat-drinks|Lemon Lime|1.75|-|1',
          'pz-classic|cat-pizzas|Classic Pepperoni|15|Pepperoni, cheese & tomato sauce|1',
          'pz-garden|cat-pizzas|Garden|15|Mushrooms, olives, onions, green peppers, cheese & tomato sauce|1',
          'pz-half-and-half|cat-pizzas|Half & Half|15|-|1',
          'pz-island|cat-pizzas|Island|15|Ham, pineapple, cheese & tomato sauce|1',
          'pz-plain|cat-pizzas|Plain Cheese|15|-|1',
          'pz-smokehouse|cat-pizzas|Smokehouse Chicken|15|Roasted chicken, red onions, jalapeño pepper, cheddar & BBQ sauce|1',
          'sd-dip|cat-sides|Dip|1.25|-|1',
          'sd-garlic-toast|cat-sides|Garlic Toast|2.5|-|1',
          'sd-green-salad|cat-sides|Green Salad|5.49|-|1',
          'sd-pasta|cat-sides|Baked Pasta|11|-|1',
          'sd-wings|cat-sides|Wings (8 pcs.)|12.25|-|1',
        ],
        'one product per pizza, side, drink and deal, plus the half-and-half product',
      );
      same(
        lines('products', 'id', "category_id = 'cat-pizzas'", 'sort_order'),
        PIZZAS.map((pizza) => `pz-${pizza}`),
        'pizzas keep the order of the file, the half-and-half product last',
      );

      same(
        lines('product_variants', 'id, product_id, name, price, sort_order, is_active'),
        [
          ...DRINKS.flatMap((drink) => [
            `dr-${drink}-2l|dr-${drink}|2L Bottle|4.5|1|1`,
            `dr-${drink}-can|dr-${drink}|Can|1.75|0|1`,
          ]),
          ...PIZZAS.flatMap((pizza) => [
            `pz-${pizza}-large|pz-${pizza}|Large|23|2|1`,
            `pz-${pizza}-medium|pz-${pizza}|Medium|19|1|1`,
            `pz-${pizza}-small|pz-${pizza}|Small|15|0|1`,
          ]),
        ].sort(),
        'one variant per size at the size price, one per drink variant at its price',
      );

      same(
        lines(
          'addon_groups',
          "id, name, is_required, min_selection, COALESCE(max_selection, 'NULL'), allow_multiple_quantities, is_active",
        ),
        [
          'ag-dip-dip-type|Dip|1|1|1|0|1',
          'ag-dips|Dips|0|0|NULL|1|1',
          'ag-pasta-pasta-type|Pasta|1|1|1|0|1',
          'ag-wings-flavour|Flavour|1|1|1|0|1',
        ],
        'dips are optional and unlimited; a side modifier is one required choice',
      );
      same(
        lines('addons', 'id, addon_group_id, name, price, sort_order, is_active'),
        [
          'ad-dip-dip-type-garlic|ag-dip-dip-type|Garlic|0|1|1',
          'ad-dip-dip-type-ranch|ag-dip-dip-type|Ranch|0|0|1',
          'ad-dips-garlic|ag-dips|Garlic|1.25|1|1',
          'ad-dips-ranch|ag-dips|Ranch|1.25|0|1',
          'ad-pasta-pasta-type-lasagna|ag-pasta-pasta-type|Lasagna|0|0|1',
          'ad-pasta-pasta-type-spaghetti|ag-pasta-pasta-type|Spaghetti|0|1|1',
          'ad-wings-flavour-hot|ag-wings-flavour|Hot|0|0|1',
          'ad-wings-flavour-sweet-chili|ag-wings-flavour|Sweet Chili|0|1|1',
        ],
        'a dip costs the dip price on a pizza; a side choice costs nothing',
      );
      same(
        lines('category_addon_groups', 'category_id, addon_group_id'),
        ['cat-pizzas|ag-dips'],
        'the Dips group is linked to the Pizzas category',
      );
      same(
        lines('addon_group_product', 'product_id, addon_group_id'),
        ['sd-dip|ag-dip-dip-type', 'sd-pasta|ag-pasta-pasta-type', 'sd-wings|ag-wings-flavour'],
        'each side modifier group is linked to its side',
      );

      const catalog = parseMenuFile(sampleMenu());
      same(
        rows('SELECT product_id, menu_id, kind, ingredients, picks FROM pizza_products ORDER BY 1'),
        [
          ...catalog.deals.map((deal: any) => ({
            product_id: `dl-${deal.id}`,
            menu_id: deal.id,
            kind: 'deal',
            ingredients: null,
            picks: JSON.stringify(deal.picks),
          })),
          ...catalog.pizzas.map((pizza: any) => ({
            product_id: `pz-${pizza.id}`,
            menu_id: pizza.id,
            kind: 'pizza',
            ingredients: JSON.stringify(pizza.ingredients),
            picks: null,
          })),
          {
            product_id: 'pz-half-and-half',
            menu_id: 'half-and-half',
            kind: 'half-and-half',
            ingredients: null,
            picks: null,
          },
        ].sort((a, b) => (a.product_id < b.product_id ? -1 : 1)),
        'pizza_products marks the pizzas, the half-and-half product and the deals',
      );
      same(
        lines('pizza_products', 'ingredients', "product_id = 'pz-island'"),
        ['["Ham","Pineapple","Cheese","Tomato sauce"]'],
        'a pizza row carries its ingredients',
      );
      same(
        lines('pizza_products', 'product_id, menu_id, kind', "kind = 'half-and-half'"),
        ['pz-half-and-half|half-and-half|half-and-half'],
        'the half-and-half row has menu id and kind half-and-half, as the order API expects',
      );
      const menuRows = rows('SELECT id, catalog, owned_rows FROM pizza_menu');
      assertEqualOrThrow(menuRows.length, 1, 'pizza_menu has one row');
      same(JSON.parse(menuRows[0].catalog), catalog, 'holding the catalogue');
      const owned = [
        'addon_groups',
        'addons',
        'categories',
        'product_variants',
        'products',
      ].flatMap((table) => lines(table, 'id').map((id) => `${table}:${id}`));
      assertEqualOrThrow(owned.length, 58, 'the menu owns 58 catalogue rows');
      same(JSON.parse(menuRows[0].owned_rows), owned, 'and the row lists them, sorted');
    });

    await testCase('2. No id repeats within any table', () => {
      const expected: Record<string, number> = {
        categories: 4,
        products: PIZZAS.length + 5 + DRINKS.length + DEALS.length,
        product_variants: PIZZAS.length * 3 + DRINKS.length * 2,
        addon_groups: 4,
        addons: 8,
        category_addon_groups: 1,
        addon_group_product: 3,
        pizza_products: PIZZAS.length + DEALS.length,
        pizza_menu: 1,
      };
      for (const [table, key] of TABLES) {
        const ids = rows(`SELECT ${key} AS k FROM ${table}`).map((row) => row.k);
        // Two menu entries with one derived id would share a row, so a short table is a repeat.
        assertEqualOrThrow(ids.length, expected[table], `${table} has a row for every entry`);
        assertEqualOrThrow(new Set(ids).size, ids.length, `no id repeats in ${table}`);
      }
      assertEqualOrThrow(
        Object.values(expected).reduce((sum, count) => sum + count, 0),
        73,
        'which is the 73 rows the summary counted',
      );
    });

    await testCase('3. A second import changes nothing', () => {
      ageEveryRow();
      const before = dump();
      same(
        load(sampleMenu()),
        { created: 0, updated: 0, unchanged: 73, deactivated: 0, untaxed: true },
        'every row is reported unchanged',
      );
      assertEqualOrThrow(dump(), before, 'every row is byte for byte the same');
    });

    await testCase('4. A changed price or name updates only its own rows', () => {
      const menu = sampleMenu();
      sizes(menu)[2].price = 24;
      ageEveryRow();
      same(
        load(menu),
        { created: 0, updated: 7, unchanged: 66, deactivated: 0, untaxed: true },
        'a new large price updates seven rows',
      );
      same(
        written(),
        [...PIZZAS.map((pizza) => `product_variants:pz-${pizza}-large`).sort(), 'pizza_menu:1'],
        'the six large variants and the stored catalogue',
      );
      same(
        lines('product_variants', 'DISTINCT price', "id LIKE 'pz-%-large'"),
        ['24'],
        'each large variant has the new price',
      );

      pizzas(menu)[0].name = 'Garden Supreme';
      ageEveryRow();
      assertEqualOrThrow(load(menu).updated, 2, 'a renamed pizza updates two rows');
      same(written(), ['products:pz-garden', 'pizza_menu:1'], 'its product and the catalogue');
      same(lines('products', 'name', "id = 'pz-garden'"), ['Garden Supreme'], 'with the new name');

      // The tile price of a pizza is its lowest size price, so that one size moves it too.
      sizes(menu)[0].price = 14;
      ageEveryRow();
      assertEqualOrThrow(load(menu).updated, 13, 'a new small price updates thirteen rows');
      same(
        written(),
        [
          ...PIZZAS.map((pizza) => `products:pz-${pizza}`).sort(),
          ...PIZZAS.map((pizza) => `product_variants:pz-${pizza}-small`).sort(),
          'pizza_menu:1',
        ],
        'the six small variants, the six tile prices and the catalogue',
      );
      // Six large variants, six small variants, six products (one of them renamed), the catalogue.
      assertEqualOrThrow(load(sampleMenu()).updated, 19, 'the sample file puts all of it back');
    });

    await testCase('5. A removed pizza is switched off, and on again when it returns', () => {
      const menu = sampleMenu();
      pizzas(menu).splice(1, 1);
      const removed = load(menu);
      assertEqualOrThrow(
        removed.deactivated,
        4,
        'the product and its three variants are switched off',
      );
      assertEqualOrThrow(removed.created, 0, 'nothing is created');
      same(lines('products', 'id', 'is_active = 0'), ['pz-island'], 'the pizza is inactive');
      same(
        lines('product_variants', 'id', 'is_active = 0'),
        ['pz-island-large', 'pz-island-medium', 'pz-island-small'],
        'and so are its sizes',
      );
      same(
        lines('pizza_products', 'product_id, menu_id, kind', "product_id = 'pz-island'"),
        ['pz-island|island|pizza'],
        'its pizza_products row is kept',
      );
      assertEqualOrThrow(
        load(menu).deactivated,
        0,
        'loading the same file again switches nothing off',
      );

      const back = load(sampleMenu());
      assertEqualOrThrow(back.deactivated, 0, 'the full file switches nothing off');
      assertEqualOrThrow(back.created, 0, 'and creates nothing: the rows were kept');
      same(lines('products', 'id', 'is_active = 0'), [], 'the pizza is active again');
      same(lines('product_variants', 'id', 'is_active = 0'), [], 'with its sizes');

      // The back office deletes a product by stamping deleted_at; the file is the master.
      getDatabase()
        .prepare("UPDATE products SET deleted_at = ? WHERE id = 'pz-garden'")
        .run(LONG_AGO);
      assertEqualOrThrow(load(sampleMenu()).updated, 1, 'a product deleted by hand is one update');
      same(lines('products', 'id', 'deleted_at IS NOT NULL'), [], 'and it is back on the menu');
    });

    await testCase('6. A product made by hand in the same category is untouched', () => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO products (id, category_id, name, price, created_at, updated_at)
         VALUES ('byhand', 'cat-pizzas', 'Sample special', 9.5, @old, @old)`,
      ).run({ old: LONG_AGO });
      db.prepare(
        `INSERT INTO product_variants (id, product_id, name, price, created_at, updated_at)
         VALUES ('byhand-one', 'byhand', 'One size', 9.5, @old, @old),
                ('byhand-xl', 'pz-garden', 'Extra large', 27, @old, @old)`,
      ).run({ old: LONG_AGO });
      const byHand = () =>
        JSON.stringify([
          rows("SELECT * FROM products WHERE id = 'byhand'"),
          rows("SELECT * FROM product_variants WHERE id LIKE 'byhand-%' ORDER BY id"),
        ]);
      assertEqualOrThrow(
        JSON.parse(byHand())[1].length,
        2,
        'one variant on the hand-made product, one added to an imported pizza',
      );
      const before = byHand();

      const menu = sampleMenu();
      pizzas(menu).splice(1, 1);
      sizes(menu)[2].price = 24;
      load(menu);
      assertEqualOrThrow(byHand(), before, 'a load that removes a pizza leaves it alone');
      const summary = load(sampleMenu());
      assertEqualOrThrow(
        summary.created + summary.updated + summary.unchanged,
        73,
        'the summary counts only the rows the menu owns',
      );
      assertEqualOrThrow(byHand(), before, 'and so does the next load');
      db.prepare("DELETE FROM product_variants WHERE id LIKE 'byhand-%'").run();
      db.prepare("DELETE FROM products WHERE id = 'byhand'").run();
    });

    await testCase('7a. Without the pizza profile, products carry no tax category', () => {
      same(
        lines('products', "DISTINCT COALESCE(tax_category_id, 'NULL')"),
        ['NULL'],
        'no imported product has a tax category',
      );
      assertEqualOrThrow(load(sampleMenu()).untaxed, true, 'and the summary says untaxed');
    });

    await testCase('9. Two entries that derive the same id are refused', async () => {
      const menu = sampleMenu();
      menu.sizes.pizza = [
        { id: 'b-c', label: 'First', price: 10 },
        { id: 'c', label: 'Second', price: 12 },
      ];
      menu.categories = [
        {
          id: 'pizzas',
          name: 'Pizzas',
          items: [
            { id: 'a', name: 'First', description: '', sizes: 'pizza' },
            { id: 'a-b', name: 'Second', description: '', sizes: 'pizza' },
          ],
        },
      ];
      const before = dump();
      const refusal = (run: () => unknown): string => {
        try {
          run();
        } catch (error: any) {
          return error.message;
        }
        return '';
      };
      assertEqualOrThrow(
        refusal(() => load(menu)),
        'menu: pizza "a" in size "b-c" and pizza "a-b" in size "c" would both get the id "pz-a-b-c"; change one of those ids',
        'the parser refuses pizza a at size b-c beside pizza a-b at size c',
      );
      // A catalogue that reaches the import some other way is refused there too.
      const catalog = parseMenuFile({
        ...menu,
        categories: [{ ...menu.categories[0], items: [menu.categories[0].items[0]] }],
      });
      catalog.pizzas.push({ ...catalog.pizzas[0], id: 'a-b' });
      assertEqualOrThrow(
        refusal(() => importMenu(getDatabase(), catalog)),
        'menu: two entries map to product_variants id "pz-a-b-c"',
        'pizza a at size b-c and pizza a-b at size c cannot both be pz-a-b-c',
      );
      assertEqualOrThrow((await post(owner, menu)).status, 400, 'the route answers 400');
      assertEqualOrThrow(dump(), before, 'and nothing is written');
    });

    await testCase('10. A tax category the owner set survives a load', () => {
      const db = getDatabase();
      db.prepare("UPDATE products SET tax_category_id = 'owner-rate' WHERE id = 'pz-garden'").run();
      const menu = sampleMenu();
      sizes(menu)[0].price = 14;
      assertEqualOrThrow(load(menu).untaxed, true, 'the store still has no food or soda category');
      same(
        lines('products', 'price, tax_category_id', "id = 'pz-garden'"),
        ['14|owner-rate'],
        'the price follows the file and the tax category stays',
      );
      load(sampleMenu());
      db.prepare("UPDATE products SET tax_category_id = NULL WHERE id = 'pz-garden'").run();
    });

    await testCase('11. A category that still holds a hand-made product stays on', () => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO products (id, category_id, name, price) VALUES ('byhand', 'cat-deals', 'Sample special', 9.5)`,
      ).run();
      const menu = sampleMenu();
      menu.categories.pop();
      assertEqualOrThrow(load(menu).deactivated, 4, 'the four deals are switched off');
      same(
        lines('products', 'id', "is_active = 1 AND category_id = 'cat-deals'"),
        ['byhand'],
        'the hand-made product is all that is left in Deals',
      );
      same(lines('categories', 'id', 'is_active = 0'), [], 'so Deals stays on');

      // The file is loaded again while the product is still there, so the load before the
      // product goes is one that no longer wrote Deals.
      assertEqualOrThrow(load(menu).deactivated, 0, 'a second load of that file changes nothing');
      db.prepare("UPDATE products SET is_active = 0 WHERE id = 'byhand'").run();
      assertEqualOrThrow(
        load(menu).deactivated,
        1,
        'once the hand-made product is off, the next load switches Deals off',
      );
      same(lines('categories', 'id', 'is_active = 0'), ['cat-deals'], 'and only Deals');
      db.prepare("UPDATE products SET is_active = 1 WHERE id = 'byhand'").run();
      db.prepare("UPDATE categories SET is_active = 1 WHERE id = 'cat-deals'").run();
      assertEqualOrThrow(
        load(menu).deactivated,
        0,
        'switched on again by hand with its product, Deals stays on',
      );

      // A product in an active sub-category needs Deals on: the catalogue shows a product only
      // while every category above it is on.
      db.prepare("UPDATE products SET is_active = 0 WHERE id = 'byhand'").run();
      db.prepare(
        "INSERT INTO categories (id, name, slug, parent_id) VALUES ('sub-byhand', 'Specials', 'specials', 'cat-deals')",
      ).run();
      db.prepare(
        "INSERT INTO products (id, category_id, name, price) VALUES ('in-sub', 'sub-byhand', 'Sample special', 9.5)",
      ).run();
      assertEqualOrThrow(load(menu).deactivated, 0, 'Deals stays on for its sub-category');
      same(lines('categories', 'id', 'is_active = 0'), [], 'and nothing else is switched off');
      db.prepare("UPDATE categories SET is_active = 0 WHERE id = 'sub-byhand'").run();
      assertEqualOrThrow(load(menu).deactivated, 1, 'with the sub-category off, Deals goes');
      db.prepare("DELETE FROM products WHERE id = 'in-sub'").run();
      db.prepare("DELETE FROM categories WHERE id = 'sub-byhand'").run();

      // Drinks nested under Deals by hand, and both leave the menu in one load: Deals is judged
      // after Drinks has been switched off, so it does not stay on for a child that is going.
      load(sampleMenu());
      db.prepare("UPDATE categories SET parent_id = 'cat-deals' WHERE id = 'cat-drinks'").run();
      const neither = sampleMenu();
      neither.categories.splice(2, 2);
      load(neither);
      same(
        lines('categories', 'id', 'is_active = 0'),
        ['cat-deals', 'cat-drinks'],
        'a parent and its child that both left the menu are switched off by the same load',
      );
      db.prepare("UPDATE categories SET parent_id = NULL WHERE id = 'cat-drinks'").run();

      db.prepare("DELETE FROM products WHERE id = 'byhand'").run();
      load(sampleMenu());
      assertEqualOrThrow(
        load(menu).deactivated,
        5,
        'with nothing else in it, Deals goes with its deals',
      );
      same(lines('categories', 'id', 'is_active = 0'), ['cat-deals'], 'and is switched off');
      load(sampleMenu());
      same(lines('categories', 'id', 'is_active = 0'), [], 'the full file switches it on again');
    });

    await testCase('12. What an earlier load owns is read from owned_rows', async () => {
      const db = getDatabase();
      db.prepare(`UPDATE pizza_menu SET catalog = '{"sizes":['`).run();
      const menu = sampleMenu();
      pizzas(menu).splice(1, 1);
      assertEqualOrThrow(
        load(menu).deactivated,
        4,
        'a load works when the stored catalogue is unreadable',
      );
      same(
        lines('products', 'id', 'is_active = 0'),
        ['pz-island'],
        'and still switches off what left',
      );
      same(
        JSON.parse(rows('SELECT catalog FROM pizza_menu')[0].catalog),
        parseMenuFile(menu),
        'and stores a readable catalogue again',
      );

      const good = rows('SELECT owned_rows FROM pizza_menu')[0].owned_rows;
      const unreadable =
        'The stored menu record is unreadable (pizza_menu.owned_rows), so the menu was not loaded.';
      for (const bad of ['["products:pz-island"', '{"products":"pz-island"}', '["users:owner"]']) {
        db.prepare('UPDATE pizza_menu SET owned_rows = ?').run(bad);
        const before = dump();
        let message = '';
        try {
          load(sampleMenu());
        } catch (error: any) {
          message = error.message;
        }
        assertEqualOrThrow(message, unreadable, `owned_rows ${bad} stops the load`);
        const refused = await post(owner, sampleMenu());
        assertEqualOrThrow(refused.status, 400, 'the route answers 400');
        assertEqualOrThrow(refused.data.error, unreadable, 'with the same message');
        assertEqualOrThrow(dump(), before, 'and nothing is written');
      }
      db.prepare('UPDATE pizza_menu SET owned_rows = ?').run(good);
      load(sampleMenu());
      same(lines('products', 'id', 'is_active = 0'), [], 'with the list back, the full file loads');
    });

    await testCase('13. A store whose currency is not in cents is refused', async () => {
      const db = getDatabase();
      const setCurrency = (code: string) =>
        db.prepare("UPDATE settings SET value = ? WHERE key = 'currency'").run(code);
      setCurrency('JPY');
      try {
        const before = dump();
        const refused = await post(owner, sampleMenu());
        assertEqualOrThrow(refused.status, 400, 'a yen store answers 400');
        assertEqualOrThrow(
          refused.data.error,
          'A menu file is priced in dollars and cents, and the store currency JPY is not counted in hundredths, so the menu was not loaded.',
          'and says why',
        );
        assertEqualOrThrow(dump(), before, 'and nothing is written');
      } finally {
        setCurrency('CAD');
      }
      assertEqualOrThrow(
        (await post(owner, sampleMenu())).status,
        200,
        'the dollar store loads it',
      );
    });

    await testCase('14. A derived id is never moved to another product or group', () => {
      const only = (pizzaId: string, sizeId: string, side: unknown) => ({
        ...sampleMenu(),
        sizes: { pizza: [{ id: sizeId, label: 'Only', price: 10 }] },
        categories: [
          {
            id: 'pizzas',
            name: 'Pizzas',
            items: [{ id: pizzaId, name: 'Only', description: '', sizes: 'pizza' }],
          },
          { id: 'sides', name: 'Sides', items: [side] },
        ],
      });
      const sideWith = (id: string, modifierId: string, optionId: string) => ({
        id,
        name: 'Side',
        price: 1,
        modifiers: [
          {
            id: modifierId,
            label: 'Kind',
            required: true,
            options: [{ id: optionId, label: 'One' }],
          },
        ],
      });
      const refusal = (menu: unknown): string => {
        const before = dump();
        let message = '';
        try {
          load(menu);
        } catch (error: any) {
          message = error.message;
        }
        assertEqualOrThrow(dump(), before, 'a refused menu writes nothing');
        return message;
      };

      // Pizza a at size b-c is pz-a-b-c; the dip m-o is ad-dips-m-o in the Dips group.
      load(only('a', 'b-c', sideWith('dip', 'kind', 'm-o')));
      assertEqualOrThrow(
        refusal(only('a-b', 'c', sideWith('dip', 'kind', 'm-o'))),
        'menu: product_variants id "pz-a-b-c" is already used under "pz-a", so it cannot go under "pz-a-b"',
        'pizza a-b at size c may not take over the variant of pizza a',
      );
      assertEqualOrThrow(
        refusal(only('a', 'b-c', sideWith('dips', 'm', 'o'))),
        'menu: addons id "ad-dips-m-o" is already used under "ag-dips", so it cannot go under "ag-dips-m"',
        'option o of side dips, modifier m, may not take over the dip m-o',
      );
    });

    await testCase('14b. Every kind of derived id stays with the entry it was made for', () => {
      const sideWith = (id: string, modifierId: string, optionId: string) => ({
        id,
        name: 'Side',
        price: 1,
        modifiers: [
          {
            id: modifierId,
            label: 'Kind',
            required: true,
            options: [{ id: optionId, label: 'One' }],
          },
        ],
      });
      const menuOf = (sides: unknown[], drinkId: string, variantId: string) => ({
        ...sampleMenu(),
        categories: [
          sampleMenu().categories[0],
          { id: 'sides', name: 'Sides', items: sides },
          {
            id: 'drinks',
            name: 'Drinks',
            variants: [{ id: variantId, label: 'Only', price: 1 }],
            items: [{ id: drinkId, name: 'Only' }],
          },
        ],
      });
      const refusal = (menu: unknown): string => {
        const before = dump();
        let message = '';
        try {
          load(menu);
        } catch (error: any) {
          message = error.message;
        }
        assertEqualOrThrow(dump(), before, 'a refused menu writes nothing');
        return message;
      };
      const plain = { id: 'q', name: 'Plain side', price: 1 };

      // Side q with modifier b-c is the group ag-q-b-c with the choice ad-q-b-c-x; drink q in
      // variant b-c is dr-q-b-c.
      load(menuOf([sideWith('q', 'b-c', 'x')], 'q', 'b-c'));
      assertEqualOrThrow(
        refusal(menuOf([plain, sideWith('q-b', 'c', 'x')], 'q', 'b-c')),
        'menu: addon_groups id "ag-q-b-c" is already used under "sd-q", so it cannot go under "sd-q-b"',
        'side q-b with modifier c may not take over the group of side q',
      );
      assertEqualOrThrow(
        refusal(menuOf([sideWith('q-b', 'c', 'x')], 'q', 'b-c')),
        'menu: addon_groups id "ag-q-b-c" is already used under "sd-q", so it cannot go under "sd-q-b"',
        'nor when side q has left the menu',
      );
      assertEqualOrThrow(
        refusal(menuOf([sideWith('q', 'b', 'c-x')], 'q', 'b-c')),
        'menu: addons id "ad-q-b-c-x" is already used under "ag-q-b-c", so it cannot go under "ag-q-b"',
        'option c-x of modifier b may not take over option x of modifier b-c',
      );
      assertEqualOrThrow(
        refusal(menuOf([sideWith('q', 'b-c', 'x')], 'q-b', 'c')),
        'menu: product_variants id "dr-q-b-c" is already used under "dr-q", so it cannot go under "dr-q-b"',
        'drink q-b in variant c may not take over the variant of drink q',
      );
      same(
        lines('addon_group_product', 'product_id, addon_group_id', "addon_group_id = 'ag-q-b-c'"),
        ['sd-q|ag-q-b-c'],
        'the group is still required by its own side alone',
      );
      // A store that already holds both sides' links, from before this check, is refused too.
      const bothLinked = getDatabase().prepare(
        "INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('sd-q-b', 'ag-q-b-c')",
      );
      bothLinked.run();
      assertEqualOrThrow(
        refusal(menuOf([sideWith('q', 'b-c', 'x')], 'q', 'b-c')),
        'menu: addon_groups id "ag-q-b-c" is already used under "sd-q-b", so it cannot go under "sd-q"',
        'a reload with the other side still linked is refused, naming both sides',
      );
      getDatabase()
        .prepare(
          "DELETE FROM addon_group_product WHERE product_id = 'sd-q-b' AND addon_group_id = 'ag-q-b-c'",
        )
        .run();
      // A link the owner made by hand to another product is not a reason to refuse.
      getDatabase()
        .prepare(
          "INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('sd-wings', 'ag-q-b-c')",
        )
        .run();
      assertEqualOrThrow(
        refusal(menuOf([sideWith('q', 'b-c', 'x')], 'q', 'b-c')),
        '',
        'the same menu loads again with a hand-made link in place',
      );
      getDatabase()
        .prepare(
          "DELETE FROM addon_group_product WHERE product_id = 'sd-wings' AND addon_group_id = 'ag-q-b-c'",
        )
        .run();
    });

    await testCase('16. A row no load made is never taken over', async () => {
      const db = getDatabase();
      load(sampleMenu());
      const menu = sampleMenu();
      pizzas(menu).push({ ...pizzas(menu)[0], id: 'byhand', number: 9, name: 'Sample special' });
      const notOurs = (noun: string, id: string) =>
        `${noun} with the id ${id} already exists and was not made by a menu load. Give that item a different id in the menu file, then load it again.`;
      const refused = async (file: unknown, message: string, why: string) => {
        const before = dump();
        let thrown = '';
        try {
          load(file);
        } catch (error: any) {
          thrown = error.message;
        }
        assertEqualOrThrow(thrown, message, why);
        const answer = await post(owner, file);
        assertEqualOrThrow(answer.status, 400, 'the route answers 400');
        assertEqualOrThrow(answer.data.error, message, 'with the same message');
        assertEqualOrThrow(dump(), before, 'and nothing is written');
      };

      db.prepare(
        `INSERT INTO products (id, category_id, name, price, created_at, updated_at)
         VALUES ('pz-byhand', 'cat-pizzas', 'Made by hand', 9.5, @old, @old)`,
      ).run({ old: LONG_AGO });
      await refused(menu, notOurs('A product', 'pz-byhand'), 'a hand-made product stops the load');
      // Deleting it in the back office only stamps deleted_at: the row is still someone else's.
      db.prepare("UPDATE products SET deleted_at = ?, is_active = 0 WHERE id = 'pz-byhand'").run(
        LONG_AGO,
      );
      await refused(
        menu,
        notOurs('A product', 'pz-byhand'),
        'deleted in the back office, it still does',
      );
      db.prepare("DELETE FROM products WHERE id = 'pz-byhand'").run();

      db.prepare(
        `INSERT INTO product_variants (id, product_id, name, price, created_at, updated_at)
         VALUES ('pz-byhand-small', 'pz-garden', 'Made by hand', 9.5, @old, @old)`,
      ).run({ old: LONG_AGO });
      await refused(
        menu,
        notOurs('A product variant', 'pz-byhand-small'),
        'a hand-made size stops the load',
      );
      db.prepare("DELETE FROM product_variants WHERE id = 'pz-byhand-small'").run();

      // A category that is in the catalogue but in no load's list was not made by a load.
      const owned = rows('SELECT owned_rows FROM pizza_menu')[0].owned_rows;
      db.prepare('UPDATE pizza_menu SET owned_rows = ?').run(
        JSON.stringify(
          JSON.parse(owned).filter((entry: string) => entry !== 'categories:cat-deals'),
        ),
      );
      // Every menu uses this id, so no change to the file can get around the row.
      await refused(
        sampleMenu(),
        'A category with the id cat-deals already exists and was not made by a menu load. That id is reserved for the Deals section of the menu, so the menu cannot be loaded until support renames or removes that category.',
        'a category stops it too, and the owner is not told to change the file',
      );
      db.prepare('UPDATE pizza_menu SET owned_rows = ?').run(owned);

      // What a load made stays the file's: switched off or removed by hand, the next load restores it.
      db.prepare("UPDATE products SET is_active = 0 WHERE id = 'pz-garden'").run();
      db.prepare("UPDATE categories SET is_active = 0 WHERE id = 'cat-sides'").run();
      db.prepare("DELETE FROM product_variants WHERE id = 'pz-island-small'").run();
      const restored = load(sampleMenu());
      assertEqualOrThrow(restored.updated, 2, 'the product and category switched off are updated');
      assertEqualOrThrow(restored.created, 1, 'the size removed by hand is made again');
      same(lines('products', 'is_active', "id = 'pz-garden'"), ['1'], 'the product is on again');
      same(lines('categories', 'is_active', "id = 'cat-sides'"), ['1'], 'the category is on again');
      same(lines('product_variants', 'is_active', "id = 'pz-island-small'"), ['1'], 'the size too');

      // A pizza that left the menu is still a load's own, so it can come back.
      const without = sampleMenu();
      pizzas(without).splice(1, 1);
      load(without);
      same(lines('products', 'is_active', "id = 'pz-island'"), ['0'], 'gone from the file: off');
      load(without);
      assertEqualOrThrow(load(sampleMenu()).created, 0, 'and back with the file, not refused');
      same(lines('products', 'is_active', "id = 'pz-island'"), ['1'], 'on again');

      // Switched on by hand after it left the file, a row stays on: only what the last load wrote is switched off.
      load(without);
      db.prepare("UPDATE products SET is_active = 1 WHERE id = 'pz-island'").run();
      assertEqualOrThrow(load(without).deactivated, 0, 'a later load leaves it on');
      same(lines('products', 'is_active', "id = 'pz-island'"), ['1'], 'still on');
      assertEqualOrThrow(load(sampleMenu()).created, 0, 'and the file still takes it back');

      // A pizza or deal that left the menu before loads kept the list is known by its pizza_products row.
      load(without);
      const keeping = rows('SELECT owned_rows FROM pizza_menu')[0].owned_rows;
      db.prepare('UPDATE pizza_menu SET owned_rows = ?').run(
        JSON.stringify(
          JSON.parse(keeping).filter((entry: string) => !entry.includes(':pz-island')),
        ),
      );
      assertEqualOrThrow(load(sampleMenu()).created, 0, 'so it comes back with its sizes');
      same(lines('products', 'is_active', "id = 'pz-island'"), ['1'], 'and is on');
      same(
        lines('product_variants', 'is_active', "product_id = 'pz-island'"),
        ['1', '1', '1'],
        'with every size',
      );

      assertEqualOrThrow(load(menu).created, 5, 'with the id free, the new pizza loads');
      load(sampleMenu());
    });

    closeDatabase();
    let headers: Record<string, string> = {};
    const order = (items: unknown[]) =>
      api(baseUrl, '/api/orders', { method: 'POST', headers, body: { type: 'takeaway', items } });

    await testCase('7b. With the pizza profile, drinks carry soda and the rest food', async () => {
      headers = await setUpStore('pizza');

      const loaded = await post(headers, sampleMenu());
      same(
        loaded.data,
        { created: 73, updated: 0, unchanged: 0, deactivated: 0, untaxed: false },
        'the sample menu loads and is taxed',
      );
      same(
        lines('products', 'DISTINCT tax_category_id', "id LIKE 'dr-%'"),
        ['soda'],
        'every drink carries soda',
      );
      same(
        lines('products', 'DISTINCT tax_category_id', "id NOT LIKE 'dr-%'"),
        ['food'],
        'every other product carries food',
      );
    });

    await testCase('7c. An order is accepted and priced from the catalogue', async () => {
      const placed = await order([
        {
          product_id: 'pz-garden',
          variant_id: 'pz-garden-large',
          quantity: 1,
          addons: [{ id: 'ad-dips-ranch', quantity: 2 }],
        },
        { product_id: 'dr-cola', variant_id: 'dr-cola-can', quantity: 1 },
      ]);
      assertEqualOrThrow(
        placed.status,
        201,
        'a large pizza with two ranch dips and a can is accepted',
      );
      const { items, subtotal, tax_breakdown, total } = placed.data.order;
      const line = (productId: string) => items.find((item: any) => item.product_id === productId);
      assertEqualOrThrow(line('pz-garden').unit_price, 23, 'the pizza costs the large price');
      same(
        line('pz-garden').addons.map(
          (addon: any) => `${addon.quantity} x ${addon.name} ${addon.price}`,
        ),
        ['2 x Ranch 1.25'],
        'with two dips at the dip price',
      );
      assertEqualOrThrow(line('dr-cola').unit_price, 1.75, 'the can costs the can price');
      assertEqualOrThrow(subtotal, 27.25, 'subtotal is 23.00 + 2.50 + 1.75');
      assertEqualOrThrow(
        taxLines(tax_breakdown),
        'GST 5% 1.37, PST 7% 0.12',
        'GST on everything, PST on the can only',
      );
      assertEqualOrThrow(total, 28.74, 'total is $28.74');

      const wings = { product_id: 'sd-wings', quantity: 1 };
      assertEqualOrThrow((await order([wings])).status, 400, 'wings with no flavour are refused');
      const flavoured = await order([{ ...wings, addons: [{ id: 'ad-wings-flavour-hot' }] }]);
      assertEqualOrThrow(flavoured.status, 201, 'wings with one flavour are accepted');
      assertEqualOrThrow(flavoured.data.order.subtotal, 12.25, 'and the flavour costs nothing');
    });

    await testCase('7e. A side that loses its modifier is still sold', async () => {
      const pasta = { product_id: 'sd-pasta', quantity: 1 };
      assertEqualOrThrow((await order([pasta])).status, 400, 'pasta needs its choice at first');
      const menu = sampleMenu();
      delete menu.categories[1].items[4].modifiers;
      assertEqualOrThrow(
        load(menu).deactivated,
        3,
        'the group and its two choices are switched off',
      );
      same(
        lines('addon_groups', 'id', 'is_active = 0'),
        ['ag-pasta-pasta-type'],
        'the group is off',
      );
      same(
        lines('addons', 'id', 'is_active = 0'),
        ['ad-pasta-pasta-type-lasagna', 'ad-pasta-pasta-type-spaghetti'],
        'with its choices',
      );
      same(
        lines('addon_group_product', 'addon_group_id', "product_id = 'sd-pasta'"),
        ['ag-pasta-pasta-type'],
        'the link is kept',
      );
      const plain = await order([pasta]);
      assertEqualOrThrow(plain.status, 201, 'and pasta is ordered with no choice');
      assertEqualOrThrow(plain.data.order.subtotal, 11, 'at its price');
    });

    await testCase('7d. Without provincial tax on drinks, drinks carry food', () => {
      const menu = sampleMenu();
      menu.categories[2].pst = false;
      assertEqualOrThrow(load(menu).untaxed, false, 'the menu is still taxed');
      same(lines('products', 'DISTINCT tax_category_id'), ['food'], 'every product carries food');
    });

    await testCase('15. The largest menu the parser accepts, 200 pizzas in 12 sizes, loads', () => {
      const menu = sampleMenu();
      menu.categories[0].items = Array.from({ length: 200 }, (_, index) => ({
        ...pizzas(menu)[1],
        id: `pizza-${index}`,
        number: index + 1,
        name: `Pizza ${index + 1}`,
      }));
      sizes(menu).push(
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `size-${index}`,
          label: `Size ${index}`,
          price: 30 + index,
        })),
      );
      load(menu);
      same(
        lines('products', 'COUNT(*)', "id LIKE 'pz-pizza-%' AND is_active = 1"),
        ['200'],
        'every pizza is a product on sale',
      );
      same(
        lines('product_variants', 'COUNT(*)', "product_id LIKE 'pz-pizza-%' AND is_active = 1"),
        ['2400'],
        'each in every size',
      );
      assertEqualOrThrow(load(menu).unchanged > 2600, true, 'and loading it again changes nothing');
    });
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (failedCases.length > 0) console.error(`Failed cases:\n  ${failedCases.join('\n  ')}`);
  process.exit(failedCases.length > 0 || results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
