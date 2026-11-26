/**
 * The recipe on an order line, at the API: a pizza, a half and half and a deal
 * are checked against the stored menu and against the line's own product and
 * variant, stored normalised, and carried through every later change to the line.
 *
 * Run: npm run test:pizza-order-recipe
 */
const {
  assertEqualOrThrow,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  api,
} = require('./helpers/pizza-print-harness');
const { seedPizzaMenu, writePizzaMenu } = require('./helpers/pizza-fixture');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { validateRecipe } = require('../shared/pizza/recipe');

const UNREADABLE = 'This item could not be read. Remove it and add it again';
const WRONG_ITEM = 'The recipe is for a different item. Remove it and add it again';

const whole = (pizzaId: string, removed: string[] = [], extra: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
  ...extra,
});
const halves = (first: object, second: object) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [first, second],
});

// Removals out of order and repeated; the stored recipe has them sorted, once each.
const gardenSent = whole('garden', ['Onions', 'Olives', 'Onions'], { cook: 'well-done' });
const gardenStored = whole('garden', ['Olives', 'Onions'], { cook: 'well-done' });
const halfSent = halves(
  { pizzaId: 'island', removed: ['Pineapple', 'Ham'] },
  { pizzaId: 'classic', removed: [] },
);
const halfStored = halves(
  { pizzaId: 'island', removed: ['Ham', 'Pineapple'] },
  { pizzaId: 'classic', removed: [] },
);
const deal = (dealId: string, pizzas: object[], extra: object = {}) => ({
  kind: 'deal',
  v: 1,
  dealId,
  pizzas,
  ...extra,
});
const sixLarge = ['garden', 'island', 'classic', 'smokehouse', 'plain', 'garden'].map((id) =>
  whole(id),
);

const gardenLine = (extra: object = {}) => ({
  product_id: 'pz-garden',
  variant_id: 'pz-garden-large',
  quantity: 1,
  ...extra,
});
const halfLine = (extra: object = {}) => ({
  product_id: 'pz-half-and-half',
  variant_id: 'pz-half-and-half-large',
  quantity: 1,
  ...extra,
});
const dealLine = (dealId: string, extra: object = {}) => ({
  product_id: `dl-${dealId}`,
  quantity: 1,
  ...extra,
});

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const catalog = seedPizzaMenu(db);
  const { baseUrl } = await startServer(
    createApp({
      '/api/orders': orderRoutes,
      '/api/bills': billRoutes,
      '/api/refunds': refundRoutes,
    }),
  );

  let key = 0;
  const post = (path: string, body: object) =>
    api(baseUrl, path, { method: 'POST', body, headers: owner.authHeader });
  const patch = (path: string, body: object) =>
    api(baseUrl, path, {
      method: 'PATCH',
      body,
      headers: { ...owner.authHeader, 'Idempotency-Key': `pizza-recipe-${++key}` },
    });
  const createOrder = (items: object[]) => post('/api/orders', { type: 'takeaway', items });
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
  const row = (itemId: number) =>
    db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as any;
  /** The order's lines that are still part of the sale, oldest first. */
  const liveRows = (orderId: number) =>
    db
      .prepare(
        "SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded') ORDER BY id",
      )
      .all(orderId) as any[];
  const editVersion = (orderId: number, itemId: number) =>
    (
      db
        .prepare(
          'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
        )
        .get(orderId, itemId) as any
    ).v;
  const edit = (orderId: number, itemId: number, body: object) =>
    patch(`/api/orders/${orderId}/items/${itemId}/edit`, {
      expected_edit_version: editVersion(orderId, itemId),
      ...body,
    });
  const stored = (recipe: object) => JSON.stringify(recipe);

  /** Posts an order that must be refused, and checks that it left nothing behind. */
  async function refused(label: string, item: object, message: string, status = 400) {
    const before = [count('orders'), count('order_items')];
    const response = await createOrder([gardenLine(), item]);
    assertEqualOrThrow(response.status, status, `${label}: refused with ${status}`);
    assertEqualOrThrow(response.data.error, message, `${label}: the message says what to do`);
    assertEqualOrThrow(
      JSON.stringify([count('orders'), count('order_items')]),
      JSON.stringify(before),
      `${label}: nothing is written`,
    );
  }

  await runCases('pizza-order-recipe', {
    'Case 1: a pizza, a half and half and every sample deal are stored normalised': async () => {
      const sent = [
        gardenLine({ modifier_selection: gardenSent }),
        halfLine({ modifier_selection: halfSent }),
        dealLine('large-combo', {
          modifier_selection: deal('large-combo', [gardenSent], {
            pops: { 'lemon-lime': 1, cola: 1, 'ginger-ale': 0 },
          }),
        }),
        dealLine('three-large-wings', {
          modifier_selection: deal('three-large-wings', [gardenSent, halfSent, whole('classic')], {
            wingFlavour: 'sweet-chili',
          }),
        }),
        dealLine('party', { modifier_selection: deal('party', sixLarge, { twoLitre: 'cola' }) }),
        dealLine('party', {
          modifier_selection: deal('party', sixLarge, { pops: { 'ginger-ale': 3, cola: 1 } }),
        }),
        dealLine('pasta-night', {
          modifier_selection: deal('pasta-night', [], { pops: { cola: 3 } }),
        }),
      ];
      const prepare = db.prepare;
      let menuReads = 0;
      db.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
        if (sql.includes('FROM pizza_menu')) menuReads += 1;
        return prepare.call(this, sql, ...rest);
      };
      const response = await createOrder(sent).finally(() => {
        db.prepare = prepare;
      });
      assertEqualOrThrow(response.status, 201, 'the order is accepted');
      const items = response.data.order.items;
      assertEqualOrThrow(items.length, sent.length, 'every line is on the order');
      assertEqualOrThrow(menuReads, 1, 'the stored menu is read once for the whole request');

      assertEqualOrThrow(
        row(items[0].id).modifier_selection,
        stored(gardenStored),
        'whole pizza: removals are stored sorted, once each',
      );
      assertEqualOrThrow(
        row(items[1].id).modifier_selection,
        stored(halfStored),
        'half and half: each half keeps its place, removals sorted',
      );
      assertEqualOrThrow(
        row(items[2].id).modifier_selection,
        stored(deal('large-combo', [gardenStored], { pops: { cola: 1, 'lemon-lime': 1 } })),
        'combo deal: pops are sorted and the zero count is gone',
      );
      assertEqualOrThrow(
        row(items[3].id).modifier_selection,
        stored(
          deal('three-large-wings', [gardenStored, halfStored, whole('classic')], {
            wingFlavour: 'sweet-chili',
          }),
        ),
        'three-pizza deal: every pizza is normalised, the wing flavour is kept',
      );
      assertEqualOrThrow(
        row(items[5].id).modifier_selection,
        stored(deal('party', sixLarge, { pops: { cola: 1, 'ginger-ale': 3 } })),
        'party deal with cans: pops are sorted',
      );
      sent.forEach((line: any, index) => {
        const normalised = validateRecipe(catalog, line.modifier_selection);
        assertEqualOrThrow(
          row(items[index].id).modifier_selection,
          stored(normalised),
          `line ${index + 1}: the stored text is the core's normalised recipe`,
        );
        assertEqualOrThrow(
          JSON.stringify(items[index].modifier_selection),
          stored(normalised),
          `line ${index + 1}: the response returns it parsed`,
        );
      });
    },

    'Case 2: a recipe the menu or the line does not allow is refused, nothing written':
      async () => {
        await refused(
          'unknown ingredient',
          gardenLine({ modifier_selection: whole('garden', ['Anchovies']) }),
          'Garden does not have that ingredient. Choose what to remove again',
        );
        const sameHalf = { pizzaId: 'island', removed: ['Ham'] };
        await refused(
          'identical halves',
          halfLine({ modifier_selection: halves(sameHalf, sameHalf) }),
          'Both halves are the same. Choose a whole pizza instead',
        );
        await refused(
          'size disagrees with the variant',
          gardenLine({ variant_id: 'pz-garden-medium', modifier_selection: whole('garden') }),
          'The size does not match this item. Pick the size again',
        );
        await refused(
          'whole names another pizza',
          gardenLine({ modifier_selection: whole('island') }),
          WRONG_ITEM,
        );
        await refused(
          'halves on a plain pizza',
          gardenLine({ modifier_selection: halfSent }),
          'A half and half is its own item. Choose Half & Half instead',
        );
        await refused('half and half with no recipe', halfLine(), 'Pick the two halves');
        await refused(
          'whole on the half-and-half product',
          halfLine({ modifier_selection: whole('garden') }),
          'Pick the two halves',
        );
        await refused(
          'deal with no recipe',
          dealLine('three-large-wings'),
          'Pick what goes in this deal',
        );
        await refused(
          'deal with the wrong number of pizzas',
          dealLine('three-large-wings', {
            modifier_selection: deal('three-large-wings', [whole('garden'), whole('island')], {
              wingFlavour: 'hot',
            }),
          }),
          'Pick 3 pizzas for Large Pizzas & Wings',
        );
        await refused(
          'a deal recipe for another deal',
          dealLine('pasta-night', {
            modifier_selection: deal('large-combo', [whole('garden')], { pops: { cola: 2 } }),
          }),
          WRONG_ITEM,
        );
        await refused(
          'a pizza recipe on a product that is not a pizza',
          { product_id: 'sd-green-salad', quantity: 1, modifier_selection: whole('garden') },
          'This item does not take a pizza or deal recipe. Remove it and add it again',
        );
        await refused(
          'a deal recipe on a product that is not a pizza',
          {
            product_id: 'sd-green-salad',
            quantity: 1,
            modifier_selection: deal('pasta-night', [], { pops: { cola: 3 } }),
          },
          'This item does not take a pizza or deal recipe. Remove it and add it again',
        );
        await refused(
          'a deal line that sends a variant',
          dealLine('pasta-night', {
            variant_id: 'pz-garden-large',
            modifier_selection: deal('pasta-night', [], { pops: { cola: 3 } }),
          }),
          'Variant "Large" is not an option for Pasta Night',
        );
        await refused(
          'a recipe larger than the core allows',
          gardenLine({ modifier_selection: whole('garden', [], { padding: 'x'.repeat(20_001) }) }),
          UNREADABLE,
        );
      },

    'Case 3: a plain pizza with no recipe is accepted': async () => {
      const response = await createOrder([gardenLine(), gardenLine({ modifier_selection: null })]);
      assertEqualOrThrow(response.status, 201, 'the order is accepted');
      for (const item of response.data.order.items) {
        assertEqualOrThrow(row(item.id).modifier_selection, 'null', 'no recipe is stored');
      }
    },

    'Case 4: the price is the catalogue price, whatever the client sends': async () => {
      const response = await createOrder([
        gardenLine({ unit_price: 0.01 }),
        gardenLine({ unit_price: 0.01, modifier_selection: gardenSent }),
        halfLine({ unit_price: 0.01, modifier_selection: halfSent }),
        dealLine('pasta-night', {
          unit_price: 0.01,
          modifier_selection: deal('pasta-night', [], { pops: { cola: 3 } }),
        }),
      ]);
      assertEqualOrThrow(response.status, 201, 'the order is accepted');
      assertEqualOrThrow(
        JSON.stringify(response.data.order.items.map((item: any) => row(item.id).unit_price)),
        JSON.stringify([23, 23, 23, 29.99]),
        'each line is charged its size or deal price, with and without a recipe',
      );
    },

    'Case 5: add items stores the normalised recipe and refuses a bad one': async () => {
      const order = (await createOrder([gardenLine()])).data.order;
      const added = await post(`/api/orders/${order.id}/items`, {
        items: [halfLine({ modifier_selection: halfSent })],
      });
      assertEqualOrThrow(added.status, 200, 'the line is added');
      assertEqualOrThrow(
        row(added.data.added_item_ids[0]).modifier_selection,
        stored(halfStored),
        'the added line is stored normalised',
      );

      const before = count('order_items');
      const bad = await post(`/api/orders/${order.id}/items`, {
        items: [gardenLine(), halfLine()],
      });
      assertEqualOrThrow(bad.status, 400, 'a half and half with no recipe is refused');
      assertEqualOrThrow(bad.data.error, 'Pick the two halves', 'with the recipe message');
      assertEqualOrThrow(count('order_items'), before, 'and no line of that request is added');
    },

    'Case 6: quantity and replacement edits keep or update the recipe': async () => {
      const order = (await createOrder([gardenLine({ modifier_selection: gardenSent })])).data
        .order;
      const live = () => liveRows(order.id);

      const more = await edit(order.id, live()[0].id, { quantity: 3 });
      assertEqualOrThrow(more.status, 200, 'the quantity edit is accepted');
      assertEqualOrThrow(live().length, 1, 'one line stands after the quantity edit');
      assertEqualOrThrow(live()[0].quantity, 3, 'with the new quantity');
      assertEqualOrThrow(
        live()[0].modifier_selection,
        stored(gardenStored),
        'a quantity edit keeps the recipe',
      );
      const fewer = await edit(order.id, live()[0].id, { quantity: 2 });
      assertEqualOrThrow(fewer.status, 200, 'the quantity reduction is accepted');
      assertEqualOrThrow(
        live()[0].modifier_selection,
        stored(gardenStored),
        'a quantity reduction keeps the recipe',
      );

      const replaced = await edit(order.id, live()[0].id, {
        replacement: gardenLine({
          modifier_selection: whole('garden', ['Onions', 'Mushrooms'], { cut: 'square-cut' }),
        }),
      });
      assertEqualOrThrow(replaced.status, 200, 'a replacement with a new recipe is accepted');
      const newRecipe = stored(whole('garden', ['Mushrooms', 'Onions'], { cut: 'square-cut' }));
      assertEqualOrThrow(
        live()[0].modifier_selection,
        newRecipe,
        'the new recipe is stored normalised',
      );

      const bare = await edit(order.id, live()[0].id, { replacement: gardenLine({ quantity: 2 }) });
      assertEqualOrThrow(bare.status, 200, 'a replacement with no recipe is accepted');
      assertEqualOrThrow(live()[0].quantity, 2, 'the replacement itself is applied');
      assertEqualOrThrow(
        live()[0].modifier_selection,
        newRecipe,
        'a replacement with no recipe keeps the stored one',
      );

      const standing = live()[0].id;
      const untouched = [count('order_items'), editVersion(order.id, standing)];
      const bad = await edit(order.id, standing, {
        replacement: gardenLine({ modifier_selection: whole('garden', ['Anchovies']) }),
      });
      assertEqualOrThrow(bad.status, 400, 'a replacement with a bad recipe is refused');
      assertEqualOrThrow(
        bad.data.error,
        'Garden does not have that ingredient. Choose what to remove again',
        'with the recipe message',
      );
      assertEqualOrThrow(live()[0].id, standing, 'and the line it would replace still stands');
      assertEqualOrThrow(
        JSON.stringify([count('order_items'), editVersion(order.id, standing)]),
        JSON.stringify(untouched),
        'the refusal adds no line and leaves the edit version alone',
      );

      const other = await edit(order.id, standing, {
        replacement: { product_id: 'sd-green-salad', quantity: 1 },
      });
      assertEqualOrThrow(other.status, 200, 'a replacement by another product is accepted');
      assertEqualOrThrow(
        live()[0].modifier_selection,
        'null',
        'and does not carry the pizza recipe over',
      );
    },

    'Case 6b: a replacement that changes the size keeps the recipe at the new size': async () => {
      const order = (
        await createOrder([
          gardenLine({ modifier_selection: gardenSent }),
          halfLine({ modifier_selection: halfSent }),
        ])
      ).data.order;
      const [garden, half] = liveRows(order.id);

      const medium = await edit(order.id, garden.id, {
        replacement: gardenLine({ variant_id: 'pz-garden-medium' }),
      });
      assertEqualOrThrow(medium.status, 200, 'whole pizza: the size change is accepted');
      const mediumRow = liveRows(order.id).find((line) => line.product_id === 'pz-garden');
      assertEqualOrThrow(mediumRow.variant_id, 'pz-garden-medium', 'whole pizza: new variant');
      assertEqualOrThrow(mediumRow.unit_price, 19, 'whole pizza: charged the new size price');
      assertEqualOrThrow(
        mediumRow.modifier_selection,
        stored({ ...gardenStored, sizeId: 'medium' }),
        'whole pizza: the removals are kept and the recipe says medium',
      );

      const small = await edit(order.id, half.id, {
        replacement: halfLine({ variant_id: 'pz-half-and-half-small' }),
      });
      assertEqualOrThrow(small.status, 200, 'half and half: the size change is accepted');
      const smallRow = liveRows(order.id).find((line) => line.product_id === 'pz-half-and-half');
      assertEqualOrThrow(
        smallRow.modifier_selection,
        stored({ ...halfStored, sizeId: 'small' }),
        'half and half: both halves are kept and the recipe says small',
      );
    },

    'Case 6c: only an absent field keeps the recipe; an explicit null clears it': async () => {
      const order = (
        await createOrder([
          gardenLine({ modifier_selection: gardenSent }),
          halfLine({ modifier_selection: halfSent }),
          dealLine('pasta-night', {
            modifier_selection: deal('pasta-night', [], { pops: { cola: 3 } }),
          }),
          { product_id: 'sd-green-salad', quantity: 1, modifier_selection: { kind: 'note' } },
        ])
      ).data.order;
      const [garden, half, pasta, salad] = liveRows(order.id);
      const lineOf = (productId: string) =>
        liveRows(order.id).find((line) => line.product_id === productId);

      const cleared = await edit(order.id, garden.id, {
        replacement: gardenLine({ modifier_selection: null }),
      });
      assertEqualOrThrow(cleared.status, 200, 'plain pizza: an explicit null is accepted');
      assertEqualOrThrow(
        lineOf('pz-garden').modifier_selection,
        'null',
        'plain pizza: an explicit null clears the recipe',
      );

      const halfNull = await edit(order.id, half.id, {
        replacement: halfLine({ modifier_selection: null }),
      });
      assertEqualOrThrow(halfNull.status, 400, 'half and half: an explicit null is refused');
      assertEqualOrThrow(halfNull.data.error, 'Pick the two halves', 'as any missing recipe is');
      const dealNull = await edit(order.id, pasta.id, {
        replacement: dealLine('pasta-night', { modifier_selection: null }),
      });
      assertEqualOrThrow(dealNull.status, 400, 'deal: an explicit null is refused');
      assertEqualOrThrow(dealNull.data.error, 'Pick what goes in this deal', 'with its message');
      const dealKept = await edit(order.id, pasta.id, {
        replacement: dealLine('pasta-night', { quantity: 2 }),
      });
      assertEqualOrThrow(dealKept.status, 200, 'deal: an absent field is accepted');
      assertEqualOrThrow(
        lineOf('dl-pasta-night').modifier_selection,
        stored(deal('pasta-night', [], { pops: { cola: 3 } })),
        'deal: an absent field keeps the recipe',
      );

      // A line that is not a pizza behaves as upstream: a replacement stores what it sends.
      const saladEdit = await edit(order.id, salad.id, {
        replacement: { product_id: 'sd-green-salad', quantity: 2 },
      });
      assertEqualOrThrow(saladEdit.status, 200, 'other product: the replacement is accepted');
      assertEqualOrThrow(
        lineOf('sd-green-salad').modifier_selection,
        'null',
        'other product: what it carried is not kept',
      );
    },

    'Case 6d: a quantity increase is refused once the pizza has left the menu': async () => {
      const order = (await createOrder([gardenLine({ modifier_selection: gardenSent })])).data
        .order;
      const [line] = liveRows(order.id);
      const without = { ...catalog, pizzas: catalog.pizzas.filter((p: any) => p.id !== 'garden') };
      db.prepare('UPDATE pizza_menu SET catalog = ?').run(JSON.stringify(without));
      try {
        const more = await edit(order.id, line.id, { quantity: 2 });
        assertEqualOrThrow(more.status, 400, 'the increase is refused');
        assertEqualOrThrow(
          more.data.error,
          'That pizza is not on the menu. Pick another pizza',
          'with the recipe message',
        );
        assertEqualOrThrow(liveRows(order.id)[0].id, line.id, 'and the line still stands');
      } finally {
        db.prepare('UPDATE pizza_menu SET catalog = ?').run(JSON.stringify(catalog));
      }
    },

    'Case 7: a void and a refund keep the recipe on both lines': async () => {
      const voided = (await createOrder([halfLine({ modifier_selection: halfSent })])).data.order;
      const voidedItem = voided.items[0].id;
      db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(voidedItem);
      const voidResponse = await patch(`/api/orders/${voided.id}/items/${voidedItem}/cancel`, {
        override_pin: '1234',
      });
      assertEqualOrThrow(voidResponse.status, 200, 'the line is voided');
      const voidRows = db
        .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
        .all(voided.id) as any[];
      assertEqualOrThrow(
        JSON.stringify(voidRows.map((line) => line.status)),
        JSON.stringify(['voided', 'void_adjustment']),
        'the void leaves the line and its adjustment',
      );
      for (const line of voidRows) {
        assertEqualOrThrow(line.modifier_selection, stored(halfStored), `${line.status}: recipe`);
      }

      const sold = (await createOrder([gardenLine({ modifier_selection: gardenSent })])).data.order;
      const bill = (await post('/api/bills/generate', { order_id: sold.id })).data.bill;
      const paid = await post(`/api/bills/${bill.id}/payment`, { method: 'cash', amount: null });
      assertEqualOrThrow(paid.status, 200, 'the bill is paid');
      // An item-level refund needs a line the kitchen has finished.
      db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(sold.items[0].id);
      const refund = await post('/api/refunds', {
        bill_id: bill.id,
        order_item_id: sold.items[0].id,
        method: 'cash',
        override_pin: '1234',
        manager_id: manager.userId,
      });
      assertEqualOrThrow(refund.status, 201, 'the line is refunded');
      const refundRows = db
        .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
        .all(sold.id) as any[];
      assertEqualOrThrow(
        JSON.stringify(refundRows.map((line) => line.status)),
        JSON.stringify(['refunded', 'void_adjustment']),
        'the refund leaves the line and its adjustment',
      );
      for (const line of refundRows) {
        assertEqualOrThrow(line.modifier_selection, stored(gardenStored), `${line.status}: recipe`);
      }
    },

    'Case 8: a product that is not a pizza keeps whatever it carries': async () => {
      const other = { kind: 'note', choices: ['b', 'a'], nested: { z: 1, a: 0 } };
      const response = await createOrder([
        { product_id: 'sd-green-salad', quantity: 1, modifier_selection: other },
        { product_id: 'sd-green-salad', quantity: 1 },
      ]);
      assertEqualOrThrow(response.status, 201, 'the order is accepted');
      const [withObject, without] = response.data.order.items;
      assertEqualOrThrow(
        row(withObject.id).modifier_selection,
        JSON.stringify(other),
        'the object is stored unchanged',
      );
      assertEqualOrThrow(row(without.id).modifier_selection, 'null', 'nothing is stored for none');
    },

    'Case 9: with no readable menu, pizza recipes answer 503 and other lines still sell':
      async () => {
        const menuText = JSON.stringify(catalog);
        const notLoaded = 'The pizza menu is not loaded. Load the menu file again.';
        const states: Record<string, () => void> = {
          'row missing': () => db.prepare('DELETE FROM pizza_menu').run(),
          'unreadable JSON': () => db.prepare("UPDATE pizza_menu SET catalog = '{not json'").run(),
          'JSON that is not a menu': () =>
            db.prepare("UPDATE pizza_menu SET catalog = 'null'").run(),
        };
        for (const [state, apply] of Object.entries(states)) {
          apply();
          try {
            await refused(
              `${state}, pizza with a recipe`,
              gardenLine({ modifier_selection: gardenSent }),
              notLoaded,
              503,
            );
            await refused(
              `${state}, deal`,
              dealLine('pasta-night', {
                modifier_selection: deal('pasta-night', [], { pops: { cola: 3 } }),
              }),
              notLoaded,
              503,
            );
            const plain = await createOrder([
              { product_id: 'sd-green-salad', quantity: 1 },
              gardenLine(),
            ]);
            assertEqualOrThrow(plain.status, 201, `${state}: lines with no recipe still sell`);
          } finally {
            writePizzaMenu(db, menuText);
          }
        }
        const back = await createOrder([gardenLine({ modifier_selection: gardenSent })]);
        assertEqualOrThrow(back.status, 201, 'with the menu back, the recipe is accepted again');
      },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
