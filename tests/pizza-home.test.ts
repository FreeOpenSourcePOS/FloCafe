/**
 * The pizza home's size buttons: the price most pizzas share at a size is shown
 * once, in the Half & Half legend, and a button shows a price only where its
 * pizza differs from that.
 *
 * Run: npm run test:pizza-home
 */
const { assertEqualOrThrow, loadFrontend, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');

loadFrontend();
const {
  catalogSizeLabels,
  sizeLabels,
  standardPrices,
  tilePrice,
} = require('../frontend/src/lib/pizza/pizza-home');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(
    isDeepStrictEqual(actual, expected),
    true,
    `${message} (got ${JSON.stringify(actual)})`,
  );

let next = 0;
const variant = (name: string, price: number, extra: Record<string, unknown> = {}) => ({
  id: `v-${(next += 1)}`,
  name,
  price,
  online_price: null,
  is_active: true,
  ...extra,
});
const pizza = (prices: [number, number, number], extra: Record<string, unknown>[] = []) => ({
  id: `p-${(next += 1)}`,
  price: prices[0],
  variants: ['Small', 'Medium', 'Large'].map((name, at) => variant(name, prices[at], extra[at])),
});
const entries = (prices: Map<string, number>) => [...prices.entries()];

runCases('pizza-home', {
  'Case 1: the price most pizzas share at each size is the standard, in menu size order': () => {
    const menu = [pizza([15, 19, 23]), pizza([15, 19, 23]), pizza([16, 21, 25])];
    same(
      entries(standardPrices(menu, false)),
      [
        ['Small', 15],
        ['Medium', 19],
        ['Large', 23],
      ],
      'two of three pizzas share each price',
    );
  },

  'Case 2: a price only one pizza has, or a tie, is no standard': () => {
    same(entries(standardPrices([pizza([15, 19, 23])], false)), [], 'one pizza sets no standard');
    same(
      entries(standardPrices([pizza([15, 19, 23]), pizza([16, 19, 24])], false)),
      [['Medium', 19]],
      'sizes where the two disagree have no standard',
    );
    same(entries(standardPrices([], false)), [], 'no pizzas, no standard');
  },

  'Case 3: an online order counts the online price, as the cart charges it': () => {
    const online = [{ online_price: 18 }, { online_price: 22 }, { online_price: 26 }];
    const menu = [pizza([15, 19, 23], online), pizza([15, 19, 23], online), pizza([15, 19, 23])];
    same(
      entries(standardPrices(menu, true)),
      [
        ['Small', 18],
        ['Medium', 22],
        ['Large', 26],
      ],
      'online prices make the standard on an online order',
    );
    same(entries(standardPrices(menu, false))[2], ['Large', 23], 'a counter order ignores them');
  },

  'Case 4: a size switched off is not counted': () => {
    const off = [{}, {}, { is_active: false }];
    const menu = [pizza([15, 19, 30], off), pizza([15, 19, 30], off), pizza([15, 19, 23])];
    same(entries(standardPrices(menu, false))[2], undefined, 'no Large is on sale twice');
  },

  'Case 5: a button shows its price only where it differs from the standard': () => {
    const usual = pizza([15, 19, 23]);
    const dear = pizza([15, 19, 25]);
    const standard = standardPrices([usual, pizza([15, 19, 23]), dear], false);
    const large = (product: ReturnType<typeof pizza>) => product.variants[2];
    assertEqualOrThrow(tilePrice(usual, large(usual), standard, false), null, 'the usual Large');
    assertEqualOrThrow(tilePrice(dear, large(dear), standard, false), 25, 'the dearer Large');
    assertEqualOrThrow(
      tilePrice(dear, dear.variants[0], new Map(), false),
      15,
      'with no standard every button shows its price',
    );
    const online = pizza([15, 19, 23], [{}, {}, { online_price: 27 }]);
    assertEqualOrThrow(
      tilePrice(online, large(online), standard, true),
      27,
      'an online price that differs is shown',
    );
  },

  'Case 6: common size names get a one- or two-letter label, any other keeps its name': () => {
    const names = ['Small', 'Medium', 'Large', 'Extra Large', 'Family', 'Party Size'];
    same(
      entries(sizeLabels(names)),
      [
        ['Small', 'S'],
        ['Medium', 'M'],
        ['Large', 'L'],
        ['Extra Large', 'XL'],
        ['Family', 'Family'],
        ['Party Size', 'Party Size'],
      ],
      'the labels of the sizes',
    );
    same(entries(sizeLabels([' large '])), [[' large ', 'L']], 'case and spaces are ignored');
  },

  'Case 7: a size named like a property of every object keeps its own name': () => {
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    same(
      entries(sizeLabels(names)),
      names.map((name) => [name, name]),
      'no label is read off the prototype',
    );
  },

  'Case 8: two sizes that would share a label keep their own names': () => {
    same(
      entries(sizeLabels(['Small', 'Large', 'L'])),
      [
        ['Small', 'S'],
        ['Large', 'Large'],
        ['L', 'L'],
      ],
      'Large and L are told apart',
    );
    same(
      entries(sizeLabels(['Small', 'S', 'Medium'])),
      [
        ['Small', 'Small'],
        ['S', 'S'],
        ['Medium', 'M'],
      ],
      'Small and S are told apart, Medium still shortens',
    );
    same(entries(sizeLabels(['Large', 'Large'])), [['Large', 'L']], 'a name twice is one size');
  },

  'Case 9: a price is the standard only when more than half the pizzas have it': () => {
    const large = (prices: number[]) =>
      entries(
        standardPrices(
          prices.map((price) => pizza([15, 19, price])),
          false,
        ),
      )[2];
    same(large([23, 23, 25, 26, 27]), undefined, 'two of five is not most pizzas');
    same(large([23, 23, 23, 25, 26]), ['Large', 23], 'three of five is');
    same(large([23, 23, 25, 25]), undefined, 'half is not most');
  },

  'Case 10: every tile and the legend label a size the same way, from the whole menu': () => {
    const withL = (prices: [number, number, number], price: number, extra = {}) => {
      const product = pizza(prices);
      product.variants.push(variant('L', price, extra));
      return product;
    };
    const plain = pizza([15, 19, 23]);
    const labelsOf = (menu: ReturnType<typeof pizza>[]) =>
      entries(catalogSizeLabels(menu)).filter(([name]) => name === 'Large' || name === 'L');
    const both = [
      ['Large', 'Large'],
      ['L', 'L'],
    ];
    same(labelsOf([plain, withL([15, 19, 23], 21)]), both, 'a pizza with no L still reads Large');
    same(
      labelsOf([plain, withL([15, 19, 23], 21, { is_active: false }), withL([15, 19, 23], 22)]),
      both,
      'an L switched off on one pizza is still on the menu',
    );
    const menu = [withL([15, 19, 23], 20), withL([15, 19, 23], 21), withL([15, 19, 23], 22)];
    same(
      [...standardPrices(menu, false).keys()],
      ['Small', 'Medium', 'Large'],
      'L has no standard',
    );
    same(labelsOf(menu), both, 'the legend still tells Large from L');
    same(
      entries(catalogSizeLabels([withL([15, 19, 23], 21, { is_active: false })])),
      [
        ['Small', 'S'],
        ['Medium', 'M'],
        ['Large', 'L'],
      ],
      'a size on sale nowhere takes no label',
    );
  },

  'Case 11: a pizza counts once at a size, however many variants share its name': () => {
    const twoLarge = (price: number, second: number) => {
      const product = pizza([15, 19, price]);
      product.variants.push(variant('Large', second));
      return product;
    };
    const large = (menu: ReturnType<typeof pizza>[]) =>
      entries(standardPrices(menu, false)).find(([name]) => name === 'Large');
    same(large([twoLarge(23, 23)]), undefined, 'one pizza is not two, even with two Larges');
    same(
      large([pizza([15, 19, 23]), pizza([15, 19, 23]), twoLarge(23, 25)]),
      ['Large', 23],
      'a pizza with two Large prices is one pizza with no vote',
    );
    same(
      large([pizza([15, 19, 23]), twoLarge(23, 25)]),
      undefined,
      'one vote of two pizzas is no standard',
    );
  },
});
