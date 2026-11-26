/**
 * Saved quick buttons, at the API: a button holds what one cart line holds, is
 * checked the way an order line is checked when it is saved, and says whether
 * it can still be added once the menu has changed under it.
 *
 * The catalogue is the sample menu, loaded by the real importer.
 *
 * Run: npm run test:pizza-quick-buttons
 */
process.env.JWT_SECRET = 'test-secret-pizza-quick-buttons';

const {
  assertEqualOrThrow,
  assertOrThrow,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCustomer,
  api,
} = require('./helpers/pizza-print-harness');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { writePizzaMenu } = require('./helpers/pizza-fixture');
const { getDatabase, resetDatabaseForCurrencyChange } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { pizzaRoutes } = require('../main/routes/pizza');
const { importMenu } = require('../main/pizza/menu-import');
const { parseMenuFile } = require('../shared/pizza/menu');
const { validateRecipe } = require('../shared/pizza/recipe');

type Headers = Record<string, string>;
type Menu = any;

const SAMPLE = path.join(__dirname, 'fixtures', 'pizza-sample-menu.json');
const sampleMenu = (): Menu => JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const category = (menu: Menu, id: string) => menu.categories.find((entry: any) => entry.id === id);
/** Loads the sample menu, changed first by `change`, the way a shop loads a new menu file. */
const loadMenu = (change: (menu: Menu) => void = () => {}) => {
  const menu = sampleMenu();
  change(menu);
  return importMenu(getDatabase(), parseMenuFile(menu));
};

const whole = (pizzaId: string, removed: string[] = [], sizeId = 'large', extra: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId,
  whole: { pizzaId, removed },
  ...extra,
});
const halves = (first: object, second: object, sizeId = 'large') => ({
  kind: 'pizza',
  v: 1,
  sizeId,
  halves: [first, second],
});
const islandClassic = halves(
  { pizzaId: 'island', removed: ['Pineapple'] },
  { pizzaId: 'classic', removed: [] },
);

const pizzaButton = (pizzaId: string, sizeId: string, extra: object = {}) => ({
  label: `${sizeId} ${pizzaId}`,
  color: 'green',
  product_id: `pz-${pizzaId}`,
  variant_id: `pz-${pizzaId}-${sizeId}`,
  ...extra,
});
const halfButton = (extra: object = {}) => ({
  label: 'Half Island / Classic',
  color: 'red',
  product_id: 'pz-half-and-half',
  variant_id: 'pz-half-and-half-large',
  recipe: islandClassic,
  ...extra,
});

/** Every key anywhere inside a value, for the check that no response carries money. */
function keysIn(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysIn(inner)]);
}

async function main() {
  const db = initTestDb();
  const owner: Headers = seedOwnerUser(db).authHeader;
  const manager: Headers = seedManagerUser(db).authHeader;
  const staff = (id: string, role: string): Headers => {
    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active) VALUES (?, ?, ?, 'x', ?, 1)`,
    ).run(id, `Test ${role}`, `${id}@test.local`, role);
    return { Authorization: `Bearer ${jwt.sign({ userId: id, role }, getJWTSecret())}` };
  };
  const cashier = staff('cashier-1', 'cashier');
  const chef = staff('chef-1', 'chef');
  seedCustomer(db, 'cust-1', 'Sample Customer', '+16045550101');
  seedCustomer(db, 'cust-2', 'Another Customer', '+16045550102');
  loadMenu();
  const catalog = parseMenuFile(sampleMenu());
  const { baseUrl } = await startServer(createApp({ '/api/pizza': pizzaRoutes }));

  const seen: unknown[] = [];
  const call = async (who: Headers | null, method: string, rest = '', body?: object) => {
    const response = await api(baseUrl, `/api/pizza/quick-buttons${rest}`, {
      method,
      body,
      headers: who ?? {},
    });
    seen.push(response.data);
    return response;
  };
  /** Saves a button that must be accepted and returns it as the API answered. */
  const save = async (body: object, who: Headers = owner) => {
    const response = await call(who, 'POST', '', body);
    assertEqualOrThrow(
      response.status,
      201,
      `saved: ${JSON.stringify(body)} (${response.data?.error})`,
    );
    return response.data.button;
  };
  const list = async (customerId?: string, who: Headers = owner) => {
    const response = await call(who, 'GET', customerId ? `?customer_id=${customerId}` : '');
    assertEqualOrThrow(response.status, 200, 'the list answers');
    return response.data.buttons as any[];
  };
  const stored = () => db.prepare('SELECT * FROM pizza_quick_buttons ORDER BY id').all() as any[];
  const same = (actual: unknown, expected: unknown, message: string) =>
    assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);
  const clear = () => db.prepare('DELETE FROM pizza_quick_buttons').run();

  /** Sends a request that must be refused, and checks that it wrote nothing. */
  async function refused(
    label: string,
    body: object,
    message: string,
    request: { method: string; rest: string } = { method: 'POST', rest: '' },
  ) {
    const before = JSON.stringify(stored());
    const response = await call(owner, request.method, request.rest, body);
    assertEqualOrThrow(response.status, 400, `${label}: refused with 400`);
    assertEqualOrThrow(response.data.error, message, `${label}: the message says what to do`);
    assertEqualOrThrow(JSON.stringify(stored()), before, `${label}: nothing is written`);
  }

  await runCases('pizza-quick-buttons', {
    "Case 1: a shop-wide button and a customer's button are saved, listed, changed and deleted":
      async () => {
        clear();
        const garden = await save(
          pizzaButton('garden', 'large', {
            label: '  Large Garden  ',
            addons: [{ id: 'ad-dips-ranch', quantity: 2 }],
            note: '  Extra napkins  ',
          }),
        );
        same(
          { ...garden, id: 'x', created_at: 'x', updated_at: 'x' },
          {
            id: 'x',
            label: 'Large Garden',
            color: 'green',
            customer_id: null,
            product_id: 'pz-garden',
            variant_id: 'pz-garden-large',
            recipe: null,
            addons: [{ id: 'ad-dips-ranch', quantity: 2 }],
            note: 'Extra napkins',
            sort_order: 0,
            created_at: 'x',
            updated_at: 'x',
            usable: true,
            reason: null,
          },
          'a saved button comes back whole, label and note trimmed',
        );
        const salad = await save({
          label: 'Salad',
          color: 'lime',
          product_id: 'sd-green-salad',
        });
        assertEqualOrThrow(salad.sort_order, 1, 'a new shop-wide button goes after the last one');
        same(
          [salad.variant_id, salad.recipe, salad.addons, salad.note],
          [null, null, [], null],
          'a button for a plain item holds only the item',
        );
        const usual = await save(halfButton({ customer_id: 'cust-1' }));
        assertEqualOrThrow(usual.customer_id, 'cust-1', "a customer's button is marked as theirs");
        assertEqualOrThrow(usual.sort_order, 0, "a customer's buttons have their own order");

        same(
          (await list()).map((button) => button.id),
          [garden.id, salad.id],
          "the list without a customer has only the shop's buttons, in order",
        );
        same(
          (await list('cust-1')).map((button) => [button.id, button.customer_id]),
          [
            [garden.id, null],
            [salad.id, null],
            [usual.id, 'cust-1'],
          ],
          "the list for a customer has the shop's buttons and then theirs",
        );
        same(
          (await list('cust-2')).map((button) => button.id),
          [garden.id, salad.id],
          "another customer does not get this customer's button",
        );

        const renamed = await call(owner, 'PUT', `/${garden.id}`, {
          label: 'Garden L',
          color: 'blue',
          sort_order: 5,
        });
        assertEqualOrThrow(renamed.status, 200, 'label, colour and order can be changed alone');
        same(
          { ...renamed.data.button, updated_at: garden.updated_at },
          { ...garden, label: 'Garden L', color: 'blue', sort_order: 5 },
          'and what the button holds stays as it was',
        );
        same(
          (await list()).map((button) => button.id),
          [salad.id, garden.id],
          'the list follows the new order',
        );

        const medium = halves(
          { pizzaId: 'classic', removed: [] },
          { pizzaId: 'garden', removed: ['Onions'] },
          'medium',
        );
        const changed = await call(owner, 'PUT', `/${usual.id}`, {
          variant_id: 'pz-half-and-half-medium',
          recipe: medium,
          addons: [{ id: 'ad-dips-garlic', quantity: 1 }],
          note: '',
        });
        assertEqualOrThrow(changed.status, 200, 'what a button holds can be changed');
        same(
          [
            changed.data.button.label,
            changed.data.button.customer_id,
            changed.data.button.variant_id,
            changed.data.button.recipe,
            changed.data.button.addons,
            changed.data.button.note,
          ],
          [
            usual.label,
            'cust-1',
            'pz-half-and-half-medium',
            medium,
            [{ id: 'ad-dips-garlic', quantity: 1 }],
            null,
          ],
          'the new contents are stored and the rest stays',
        );
        same(
          (await list('cust-1')).find((button) => button.id === usual.id),
          changed.data.button,
          'the list returns the changed button',
        );

        const missing = await call(owner, 'PUT', '/no-such-button', { label: 'Nothing' });
        assertEqualOrThrow(missing.status, 404, 'changing a button that is not there answers 404');

        const removed = await call(owner, 'DELETE', `/${usual.id}`);
        assertEqualOrThrow(removed.status, 200, "a customer's button is deleted");
        same(
          (await list('cust-1')).map((button) => button.id),
          [salad.id, garden.id],
          'and is gone from their list',
        );
        assertEqualOrThrow(
          (await call(owner, 'DELETE', `/${garden.id}`)).status,
          200,
          'a shop-wide button is deleted',
        );
        same(
          (await list()).map((button) => button.id),
          [salad.id],
          'and is gone from the list',
        );
        assertEqualOrThrow(
          (await call(owner, 'DELETE', `/${garden.id}`)).status,
          404,
          'deleting it again answers 404',
        );
      },

    'Case 2: a saved recipe comes back normalised': async () => {
      clear();
      const sent = whole('garden', ['Onions', 'Olives', 'Onions'], 'large', { cook: 'well-done' });
      const expected = whole('garden', ['Olives', 'Onions'], 'large', { cook: 'well-done' });
      const button = await save(pizzaButton('garden', 'large', { recipe: sent }));
      same(button.recipe, expected, 'removals come back sorted, once each');
      assertEqualOrThrow(
        stored()[0].recipe,
        JSON.stringify(validateRecipe(catalog, sent)),
        "the stored text is the core's normalised recipe",
      );
      same((await list())[0].recipe, expected, 'the list returns it normalised');

      const deal = await save({
        label: 'Combo',
        color: 'amber',
        product_id: 'dl-large-combo',
        recipe: {
          kind: 'deal',
          v: 1,
          dealId: 'large-combo',
          pizzas: [sent],
          pops: { 'lemon-lime': 1, cola: 1, 'ginger-ale': 0 },
        },
      });
      same(
        deal.recipe,
        {
          kind: 'deal',
          v: 1,
          dealId: 'large-combo',
          pizzas: [expected],
          pops: { cola: 1, 'lemon-lime': 1 },
        },
        "a deal's pizzas are normalised and its pops sorted, zero counts gone",
      );

      const swapped = await call(owner, 'PUT', `/${button.id}`, {
        recipe: whole('garden', ['Tomato sauce', 'Cheese']),
      });
      same(
        swapped.data.button?.recipe,
        whole('garden', ['Cheese', 'Tomato sauce']),
        'a changed recipe is normalised too',
      );
    },

    'Case 3: a button an order line would not accept is refused, nothing written': async () => {
      clear();
      const kept = await save(halfButton());
      await refused(
        'unknown product',
        pizzaButton('nowhere', 'large'),
        'That item is not on the menu. Pick another item',
      );
      await refused(
        'no product',
        { label: 'Nothing', color: 'red' },
        'That item is not on the menu. Pick another item',
      );
      await refused(
        'variant of another product',
        pizzaButton('garden', 'large', { variant_id: 'pz-island-large' }),
        'Variant "Large" is not an option for Garden',
      );
      await refused(
        'a pizza with no size',
        { label: 'Garden', color: 'green', product_id: 'pz-garden' },
        'A variant must be selected for Garden',
      );
      await refused(
        'identical halves',
        halfButton({
          recipe: halves({ pizzaId: 'island', removed: [] }, { pizzaId: 'island', removed: [] }),
        }),
        'Both halves are the same. Choose a whole pizza instead',
      );
      await refused(
        'half and half with no recipe',
        halfButton({ recipe: undefined }),
        'Pick the two halves',
      );
      await refused(
        'a recipe for another pizza',
        pizzaButton('garden', 'large', { recipe: whole('island') }),
        'The recipe is for a different item. Remove it and add it again',
      );
      await refused(
        'a recipe in another size',
        pizzaButton('garden', 'large', { recipe: whole('garden', [], 'small') }),
        'The size does not match this item. Pick the size again',
      );
      await refused(
        'a recipe on an item that takes none',
        { label: 'Salad', color: 'lime', product_id: 'sd-green-salad', recipe: whole('garden') },
        'This item does not take a pizza or deal recipe. Remove it and add it again',
      );
      await refused(
        'something that is not a recipe',
        { label: 'Salad', color: 'lime', product_id: 'sd-green-salad', recipe: { any: 'thing' } },
        'This item could not be read. Remove it and add it again',
      );
      await refused(
        "an add-on that is not the product's",
        pizzaButton('garden', 'large', { addons: [{ id: 'ad-wings-flavour-hot', quantity: 1 }] }),
        'Add-on "Hot" is not available for this product',
      );
      await refused(
        'an unknown add-on',
        pizzaButton('garden', 'large', { addons: [{ id: 'ad-nowhere', quantity: 1 }] }),
        'A dip or extra on this button is no longer on the menu. Edit the button',
      );
      await refused(
        'a required choice left out',
        { label: 'Wings', color: 'orange', product_id: 'sd-wings' },
        'Selection for group "Flavour" requires at least 1 item(s)',
      );
      for (const color of ['chartreuse', '#ff0000', '', undefined, 7]) {
        await refused(
          `colour ${JSON.stringify(color)}`,
          pizzaButton('garden', 'large', { color }),
          'Pick a colour for this button',
        );
      }
      for (const label of ['', '   ', undefined, 24]) {
        await refused(
          `label ${JSON.stringify(label)}`,
          pizzaButton('garden', 'large', { label }),
          'Give this button a name',
        );
      }
      await refused(
        'a label of 25 characters',
        pizzaButton('garden', 'large', { label: 'x'.repeat(25) }),
        'A button name can have at most 24 characters',
      );
      await refused(
        'a note of 141 characters',
        pizzaButton('garden', 'large', { note: 'x'.repeat(141) }),
        'A note can have at most 140 characters',
      );
      await refused(
        'an unknown customer',
        pizzaButton('garden', 'large', { customer_id: 'cust-nowhere' }),
        'That customer was not found. Search for the customer again',
      );

      const change = { method: 'PUT', rest: `/${kept.id}` };
      await refused(
        'a change to identical halves',
        {
          recipe: halves({ pizzaId: 'plain', removed: [] }, { pizzaId: 'plain', removed: [] }),
        },
        'Both halves are the same. Choose a whole pizza instead',
        change,
      );
      await refused(
        'a change of size without the recipe in that size',
        { variant_id: 'pz-half-and-half-medium' },
        'The size does not match this item. Pick the size again',
        change,
      );
      await refused(
        'a change to an empty label',
        { label: ' ' },
        'Give this button a name',
        change,
      );
      await refused(
        'a change to an unknown colour',
        { color: 'beige' },
        'Pick a colour for this button',
        change,
      );
      await refused(
        'a change to another product without its size',
        { product_id: 'pz-garden' },
        'Variant "Large" is not an option for Garden',
        change,
      );

      const longest = await save(
        pizzaButton('garden', 'large', { label: ` ${'x'.repeat(24)} `, note: 'n'.repeat(140) }),
      );
      assertEqualOrThrow(longest.label.length, 24, 'a label of 24 characters is accepted');
      assertEqualOrThrow(longest.note.length, 140, 'a note of 140 characters is accepted');
    },

    'Case 4: a button whose items left the menu is listed as not usable, with the reason':
      async () => {
        clear();
        loadMenu();
        const island = await save(pizzaButton('island', 'large'));
        const half = await save(halfButton());
        const dipped = await save(
          pizzaButton('classic', 'large', { addons: [{ id: 'ad-dips-ranch', quantity: 2 }] }),
        );
        const noOlives = await save(
          pizzaButton('garden', 'medium', { recipe: whole('garden', ['Olives'], 'medium') }),
        );
        const small = await save(pizzaButton('classic', 'small'));
        const deal = await save({
          label: 'Three large',
          color: 'amber',
          product_id: 'dl-three-large-wings',
          recipe: {
            kind: 'deal',
            v: 1,
            dealId: 'three-large-wings',
            pizzas: [whole('garden'), whole('island'), whole('classic')],
            wingFlavour: 'sweet-chili',
          },
        });
        const names: Record<string, string> = {
          [island.id]: 'island',
          [half.id]: 'half',
          [dipped.id]: 'dipped',
          [noOlives.id]: 'noOlives',
          [small.id]: 'small',
          [deal.id]: 'deal',
        };
        const rows = JSON.stringify(stored());
        /** The reason of every listed button that is not usable, by the names above. */
        const stale = async () => {
          const buttons = await list();
          assertEqualOrThrow(buttons.length, 6, 'a stale button is still listed');
          for (const button of buttons) {
            assertEqualOrThrow(
              button.usable,
              button.reason === null,
              `${names[button.id]}: a reason is given exactly when the button is not usable`,
            );
          }
          return Object.fromEntries(
            buttons
              .filter((button) => !button.usable)
              .map((button) => [names[button.id], button.reason]),
          );
        };
        const NOT_AVAILABLE_LARGE = 'Variant "Large" is not available';

        const prepare = db.prepare;
        let menuReads = 0;
        db.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
          if (sql.includes('FROM pizza_menu')) menuReads += 1;
          return prepare.call(this, sql, ...rest);
        };
        const allThere = await stale().finally(() => {
          db.prepare = prepare;
        });
        same(allThere, {}, 'with everything on the menu, every button is usable');
        assertEqualOrThrow(menuReads, 1, 'the stored menu is read once for the whole list');

        loadMenu((menu) => {
          const pizzas = category(menu, 'pizzas');
          pizzas.items = pizzas.items.filter((pizza: any) => pizza.id !== 'island');
        });
        same(
          await stale(),
          {
            island: 'Island is not on the menu. Pick another item',
            half: 'Island is not on the menu. Pick another pizza',
            deal: 'Island is not on the menu. Pick another pizza',
          },
          'the pizza left the menu: its own button, the half and half and the deal that use it say so',
        );

        loadMenu((menu) => {
          menu.sizes.pizza = menu.sizes.pizza.filter((size: any) => size.id !== 'large');
          const deals = category(menu, 'deals');
          deals.items = deals.items.filter((deal: any) => deal.id === 'pasta-night');
        });
        same(
          await stale(),
          {
            island: NOT_AVAILABLE_LARGE,
            half: NOT_AVAILABLE_LARGE,
            dipped: NOT_AVAILABLE_LARGE,
            deal: 'Large Pizzas & Wings is not on the menu. Pick another item',
          },
          'the size left the menu, and the deals in it: every large button says so, the others stay usable',
        );

        loadMenu((menu) => {
          const dip = category(menu, 'sides').items.find((side: any) => side.id === 'dip');
          dip.modifiers[0].options = dip.modifiers[0].options.filter(
            (option: any) => option.id !== 'ranch',
          );
        });
        same(
          await stale(),
          { dipped: 'Add-on "Ranch" is not available' },
          'the dip left the menu: the button that has it says so',
        );

        loadMenu();
        db.prepare("DELETE FROM addons WHERE id = 'ad-dips-ranch'").run();
        same(
          await stale(),
          { dipped: 'A dip or extra on this button is no longer on the menu. Edit the button' },
          'the dip is gone altogether: the reason does not show its id',
        );

        loadMenu((menu) => {
          const garden = category(menu, 'pizzas').items.find((pizza: any) => pizza.id === 'garden');
          garden.description = garden.description.replace('olives', 'black olives');
        });
        same(
          await stale(),
          { noOlives: 'Garden no longer has Olives. Choose what to remove again' },
          'a removed ingredient was renamed: the button that removes it says so',
        );

        loadMenu();
        db.prepare("UPDATE products SET is_active = 0 WHERE id = 'pz-classic'").run();
        same(
          await stale(),
          {
            dipped: 'Classic Pepperoni is not on the menu. Pick another item',
            small: 'Classic Pepperoni is not on the menu. Pick another item',
          },
          'a product switched off by hand: the same',
        );

        loadMenu();
        writePizzaMenu(db, 'not a menu');
        same(
          await stale(),
          {
            half: 'The pizza menu is not loaded. Load the menu file again.',
            noOlives: 'The pizza menu is not loaded. Load the menu file again.',
            deal: 'The pizza menu is not loaded. Load the menu file again.',
          },
          'the stored menu cannot be read: a button with a recipe says so',
        );

        loadMenu();
        same(await stale(), {}, 'with the menu back, every button is usable again');
        assertEqualOrThrow(
          JSON.stringify(stored()),
          rows,
          'no menu change rewrote a stored button',
        );

        loadMenu((menu) => {
          const pizzas = category(menu, 'pizzas');
          pizzas.items = pizzas.items.filter((pizza: any) => pizza.id !== 'island');
        });
        const relabelled = await call(owner, 'PUT', `/${island.id}`, { label: 'Was Island' });
        same(
          [relabelled.status, relabelled.data.button?.label, relabelled.data.button?.usable],
          [200, 'Was Island', false],
          'a stale button can be renamed, and stays stale',
        );
        const repaired = await call(owner, 'PUT', `/${island.id}`, {
          product_id: 'pz-classic',
          variant_id: 'pz-classic-large',
        });
        same(
          [repaired.status, repaired.data.button?.usable, repaired.data.button?.reason],
          [200, true, null],
          'a stale button can be pointed at an item that is on the menu',
        );
        assertEqualOrThrow(
          (await call(owner, 'DELETE', `/${half.id}`)).status,
          200,
          'a stale button can be deleted',
        );
        loadMenu();
      },

    "Case 5: a cashier keeps customers' buttons, a manager the shop's too": async () => {
      clear();
      const shop = pizzaButton('garden', 'large');
      const theirs = pizzaButton('garden', 'large', { customer_id: 'cust-1' });

      for (const [method, rest] of [
        ['GET', ''],
        ['POST', ''],
        ['PUT', '/any'],
        ['DELETE', '/any'],
      ]) {
        assertEqualOrThrow(
          (await call(null, method, rest, method === 'GET' ? undefined : shop)).status,
          401,
          `signed out: ${method} is refused`,
        );
      }

      const managerShop = await save(shop, manager);
      const managerTheirs = await save(theirs, manager);
      const cashierTheirs = await save(theirs, cashier);
      assertEqualOrThrow(stored().length, 3, 'a manager saves both kinds, a cashier a customer’s');

      for (const [label, response] of [
        ['save a shop-wide button', await call(cashier, 'POST', '', shop)],
        ['change one', await call(cashier, 'PUT', `/${managerShop.id}`, { label: 'Mine' })],
        ['delete one', await call(cashier, 'DELETE', `/${managerShop.id}`)],
      ] as const) {
        assertEqualOrThrow(response.status, 403, `a cashier may not ${label}`);
      }
      assertEqualOrThrow(
        (await call(chef, 'POST', '', theirs)).status,
        403,
        "someone who may not take orders may not save a customer's button",
      );
      same(
        stored()
          .map((row) => [row.id, row.label])
          .sort(),
        [managerShop, managerTheirs, cashierTheirs]
          .map((button) => [button.id, button.label])
          .sort(),
        'the refused requests changed nothing',
      );

      assertEqualOrThrow((await list('cust-1', cashier)).length, 3, 'a cashier reads both kinds');
      assertEqualOrThrow((await list(undefined, cashier)).length, 1, "or the shop's alone");
      assertEqualOrThrow((await list(undefined, chef)).length, 1, "the kitchen reads the shop's");
      const kitchenAsks = await call(chef, 'GET', '?customer_id=cust-1');
      assertEqualOrThrow(kitchenAsks.status, 403, "but not a customer's");
      assertEqualOrThrow(kitchenAsks.data.buttons, undefined, 'and is sent no button');

      const answers = [];
      for (const id of [managerShop.id, managerTheirs.id, 'no-such-button']) {
        for (const method of ['PUT', 'DELETE']) {
          const response = await call(chef, method, `/${id}`, { label: 'Mine' });
          answers.push(`${response.status} ${JSON.stringify(response.data)}`);
        }
      }
      assertEqualOrThrow(answers[0].slice(0, 3), '403', 'someone with neither right is refused');
      assertEqualOrThrow(
        new Set(answers).size,
        1,
        `and is answered the same whether or not the button exists: ${answers.join(' | ')}`,
      );
      assertEqualOrThrow(
        (await call(cashier, 'PUT', '/no-such-button', { label: 'Mine' })).status,
        404,
        'someone who keeps buttons is still told a button is gone',
      );
      const cashierChange = await call(cashier, 'PUT', `/${managerTheirs.id}`, { label: 'Usual' });
      assertEqualOrThrow(cashierChange.status, 200, "a cashier changes a customer's button");
      assertEqualOrThrow(
        (await call(cashier, 'DELETE', `/${cashierTheirs.id}`)).status,
        200,
        "a cashier deletes a customer's button",
      );
      assertEqualOrThrow(
        (await call(manager, 'DELETE', `/${managerTheirs.id}`)).status,
        200,
        "a manager deletes a customer's button",
      );
      assertEqualOrThrow(
        (await call(manager, 'DELETE', `/${managerShop.id}`)).status,
        200,
        'a manager deletes a shop-wide button',
      );
      assertEqualOrThrow(stored().length, 0, 'and all three are gone');
    },

    'Case 6: no price is stored or returned': async () => {
      clear();
      const button = await save(
        pizzaButton('garden', 'large', {
          customer_id: 'cust-1',
          price: 23,
          unit_price: 23,
          addons: [{ id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 2 }],
        }),
      );
      same(
        button.addons,
        [{ id: 'ad-dips-ranch', quantity: 2 }],
        'an add-on is kept as its id and quantity only',
      );
      assertEqualOrThrow(
        stored()[0].addons,
        '[{"id":"ad-dips-ranch","quantity":2}]',
        'and stored that way',
      );
      await call(owner, 'PUT', `/${button.id}`, { label: 'Usual', price: 5 });
      await list('cust-1');
      for (const kind of ['button', 'buttons', 'error']) {
        assertOrThrow(
          seen.some((data: any) => data?.[kind]?.length ?? data?.[kind]),
          `the suite has seen a response with "${kind}"`,
        );
      }
      same(
        [...new Set(seen.flatMap(keysIn))].filter((key) =>
          /price|cents|cost|amount|total/i.test(key),
        ),
        [],
        'no response of this suite has a field for money',
      );
    },

    'Case 7: a customer who no longer exists has no buttons listed': async () => {
      clear();
      const shop = await save(pizzaButton('garden', 'large'));
      const theirs = await save(pizzaButton('garden', 'large', { customer_id: 'cust-2' }));
      assertEqualOrThrow(
        (await list('cust-2')).length,
        2,
        'while the customer exists, it is listed',
      );
      db.prepare("UPDATE customers SET is_active = 0 WHERE id = 'cust-2'").run();
      same(
        (await list('cust-2')).map((button) => button.id),
        [shop.id],
        'a deactivated customer: only the shop buttons',
      );
      db.prepare("DELETE FROM customers WHERE id = 'cust-2'").run();
      same(
        (await list('cust-2')).map((button) => button.id),
        [shop.id],
        'a deleted customer: only the shop buttons',
      );
      assertOrThrow(
        stored().some((row) => row.id === theirs.id),
        'the stored button is left alone',
      );
    },

    'Case 8: the colours are the ones the POS uses for categories': async () => {
      const { QUICK_BUTTON_COLORS } = require('../main/pizza/quick-buttons');
      const grid = fs.readFileSync(
        path.join(__dirname, '..', 'frontend/src/components/pos/ProductGrid.tsx'),
        'utf8',
      );
      const block = grid.slice(grid.indexOf('const CATEGORY_COLORS'));
      const names = [...block.slice(0, block.indexOf('\n};')).matchAll(/^ {2}(\w+): \{$/gm)].map(
        (match) => match[1],
      );
      assertOrThrow(names.length > 10, 'the category colours were read from the POS grid');
      same(QUICK_BUTTON_COLORS, names, 'a button takes exactly those colour names');
    },

    'Case 9: a database fault is a server error, not a refusal or a reason': async () => {
      clear();
      loadMenu();
      const dipped = pizzaButton('classic', 'large', {
        addons: [{ id: 'ad-dips-ranch', quantity: 1 }],
      });
      await save(dipped);
      const rows = JSON.stringify(stored());
      const prepare = db.prepare;
      // The add-on lookup fails inside SQLite, as it would on a damaged or locked file.
      db.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
        const broken = sql.includes('FROM addons LEFT JOIN');
        return prepare.call(this, broken ? 'SELECT * FROM no_such_table' : sql, ...rest);
      };
      try {
        const saved = await call(owner, 'POST', '', dipped);
        same(
          [saved.status, saved.data.error],
          [500, 'Internal server error'],
          'saving answers 500, not a refusal',
        );
        const listed = await call(owner, 'GET');
        same(
          [listed.status, listed.data.error, listed.data.buttons],
          [500, 'Internal server error', undefined],
          'the list answers 500, not a button marked as not usable',
        );
      } finally {
        db.prepare = prepare;
      }
      assertEqualOrThrow(JSON.stringify(stored()), rows, 'nothing is written');
      same(
        (await list()).map((button) => [button.usable, button.reason]),
        [[true, null]],
        'with the database answering again, the button is usable',
      );
    },

    'Case 11: a customer keeps at most 24 buttons and the shop 48': async () => {
      clear();
      const theirs = pizzaButton('garden', 'large', { customer_id: 'cust-1' });
      for (let saved = 0; saved < 24; saved++) await save(theirs, cashier);
      await refused(
        'a 25th button for one customer',
        theirs,
        'This customer already has 24 buttons. Delete one, then save this one',
      );
      seedCustomer(db, 'cust-3', 'Third Customer', '+16045550103');
      await save({ ...theirs, customer_id: 'cust-3' }, cashier);
      const [first] = stored();
      assertEqualOrThrow(
        (await call(cashier, 'PUT', `/${first.id}`, { label: 'Usual' })).status,
        200,
        'a button can still be changed when the customer has 24',
      );

      const shop = pizzaButton('garden', 'large');
      for (let saved = 0; saved < 48; saved++) await save(shop);
      await refused(
        'a 49th shop-wide button',
        shop,
        'The shop already has 48 buttons. Delete one, then save this one',
      );
      assertEqualOrThrow(stored().length, 24 + 1 + 48, 'only the buttons within the limits exist');
    },

    'Case 10: a currency reset leaves no buttons': async () => {
      clear();
      await save(pizzaButton('garden', 'large'));
      await save(halfButton({ customer_id: 'cust-1' }));
      assertEqualOrThrow((await list('cust-1')).length, 2, 'two buttons before the reset');

      await resetDatabaseForCurrencyChange('USD', 'INR');
      const fresh = getDatabase();
      const freshOwner: Headers = seedOwnerUser(fresh).authHeader;
      seedCustomer(fresh, 'cust-1', 'Sample Customer', '+16045550101');
      assertOrThrow(
        fresh.prepare("SELECT 1 FROM products WHERE id = 'pz-garden'").get(),
        'the menu is carried across the reset',
      );
      same(await list(undefined, freshOwner), [], 'no shop-wide button is left');
      same(await list('cust-1', freshOwner), [], "and no customer's button");
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
