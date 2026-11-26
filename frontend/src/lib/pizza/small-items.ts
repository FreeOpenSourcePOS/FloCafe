/**
 * The dips and drinks popup, and the folded cart rows, as plain data: the rows
 * and tiles a menu gives, the cart line one tap on a tile adds, how many of a
 * tile the order holds, and which pizza lines keep their action row.
 */
import { addonStockCeiling } from '@/lib/addon-inventory';
import { generateCartItemId } from '@/lib/cart-identity';
import { cartVariantUnitPrice } from '@/lib/cart-price';
import { activeVariants, isVariantSoldOut } from '@/lib/product-variants';
import type { Addon, CartItem, Product, ProductVariant } from '@/lib/types';
import type { PizzaCatalog } from '../../../../shared/pizza/types';

/** The ids the menu load gives the side that defines the dips, and each drink. */
const DIP_SIDE = 'dip';
const SIDE_PRODUCT_PREFIX = 'sd-';
const DRINK_PRODUCT_PREFIX = 'dr-';

/** One thing a tap adds: a dip, or a drink in one size. */
export interface SmallItemTile {
  /** The id of the cart line a tap adds to. */
  lineId: string;
  name: string;
  price: number;
  product: Product;
  variant: ProductVariant | null;
  addons: Addon[];
}

export interface SmallItemRow {
  kind: 'dips' | 'drinks';
  /** `dips`, or the menu id of the drink size. */
  id: string;
  /** The drink size. The dips row has none: the screen names it. */
  label?: string;
  /** The price of every tile in the row, or null when they differ. */
  price: number | null;
  /** The category the row's products are sold under. */
  categoryId: string | null;
  tiles: SmallItemTile[];
}

function tile(
  name: string,
  price: number,
  product: Product,
  variant: ProductVariant | null,
  addons: Addon[],
): SmallItemTile {
  const lineId = generateCartItemId(product.id, variant?.id ?? null, addons, '');
  return { lineId, name, price, product, variant, addons };
}

function row(
  kind: SmallItemRow['kind'],
  id: string,
  label: string | undefined,
  tiles: SmallItemTile[],
): SmallItemRow[] {
  if (tiles.length === 0) return [];
  const price = tiles.every((entry) => entry.price === tiles[0].price) ? tiles[0].price : null;
  return [
    {
      kind,
      id,
      label,
      price,
      categoryId: tiles[0].product.category_id ?? null,
      tiles,
    },
  ];
}

/**
 * The popup's rows: the dips, then one row per drink size. An item is on a
 * tile only when the menu has it and the POS sells it, found by the ids the
 * menu load derives. A row with no tile is left out. A drink costs what the
 * cart charges for its size: the online price while `online`, which is an
 * order for an online platform.
 */
export function smallItemRows(
  catalog: PizzaCatalog | null,
  products: Product[],
  online = false,
): SmallItemRow[] {
  if (!catalog) return [];
  const sold = (id: string) => products.find((product) => product.id === id);

  const dipSide = catalog.sides.find((side) => side.id === DIP_SIDE);
  const dipProduct = sold(SIDE_PRODUCT_PREFIX + DIP_SIDE);
  const dipChoices = (dipProduct?.addon_groups ?? []).flatMap((group) => group.addons ?? []);
  const dips = catalog.dips.flatMap((dip) => {
    const addon = dipChoices.find(
      (choice) => choice.id === `ad-${DIP_SIDE}-${dipSide?.modifier?.id}-${dip.id}`,
    );
    if (!dipProduct || !addon) return [];
    // The choice as the product grid's dialog hands it over: one of it.
    const chosen = { ...addon, quantity: 1 };
    return [
      tile(addon.name, Number(dipProduct.price) + Number(addon.price), dipProduct, null, [chosen]),
    ];
  });

  return [
    ...row('dips', 'dips', undefined, dips),
    ...catalog.drinkVariants.flatMap((size) =>
      row(
        'drinks',
        size.id,
        size.label,
        catalog.drinks.flatMap((drink) => {
          const product = sold(DRINK_PRODUCT_PREFIX + drink.id);
          const variant = activeVariants(product?.variants).find(
            (entry) => entry.id === `${DRINK_PRODUCT_PREFIX}${drink.id}-${size.id}`,
          );
          return product && variant
            ? [
                tile(
                  product.name,
                  cartVariantUnitPrice({ product, variant }, online),
                  product,
                  variant,
                  [],
                ),
              ]
            : [];
        }),
      ),
    ),
  ];
}

/** What one tap adds, as the arguments of the cart's `addItem`: the product grid's own add of one. */
export function tileAdd(
  item: SmallItemTile,
): [Product, number, Addon[], string, ProductVariant | null] {
  return [item.product, 1, item.addons, '', item.variant];
}

/**
 * The cart lines that hold a tile's item, the line a tap adds to last, so a
 * minus takes from the last one. A dip that is an add-on on a pizza is that
 * pizza's line, never the dip's.
 */
export function tileLines(items: CartItem[], item: SmallItemTile): CartItem[] {
  const held = items.filter(
    (line) =>
      line.product.id === item.product.id &&
      (line.variant?.id ?? null) === (item.variant?.id ?? null) &&
      line.addons.length === item.addons.length &&
      item.addons.every((addon) => line.addons.some((entry) => entry.id === addon.id)),
  );
  return [
    ...held.filter((line) => line.id !== item.lineId),
    ...held.filter((line) => line.id === item.lineId),
  ];
}

export function tileCount(items: CartItem[], item: SmallItemTile): number {
  return tileLines(items, item).reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * True when a tap must not add one more: a size with none left, or a tracked
 * dip the whole order already holds all of. The product grid's dialog counts a
 * dip against one line only, so this is the stricter of the two.
 */
export function tileSoldOut(item: SmallItemTile, inOrder: number): boolean {
  if (item.variant && isVariantSoldOut(item.variant)) return true;
  return item.addons.some((addon) => {
    const ceiling = addonStockCeiling(addon);
    return ceiling !== null && inOrder >= ceiling;
  });
}

/** Above this many lines, a pizza line folds its action row away. */
const UNFOLDED_LINES = 3;

/** The line a cart change added or changed, the later one of several; null when it only removed. */
export function touchedLine(before: CartItem[], after: CartItem[]): string | null {
  return after.filter((line) => !before.includes(line)).pop()?.id ?? null;
}

/** True when the pizza line `lineId` hides its action row: the order is long and it was not the last touched. */
export function foldsActions(items: CartItem[], touched: string | null, lineId: string): boolean {
  return items.length > UNFOLDED_LINES && lineId !== touched;
}

/**
 * The category whose block opens the popup in place of its own products: the
 * drinks' category, and only while every product sold in it is on a tile in
 * every size it has. Otherwise something would be out of reach behind the
 * popup, so the block stays a plain category. The dip's category keeps its
 * block either way; the Dips block is an extra one.
 */
export function popupCategory(rows: SmallItemRow[], products: Product[]): string | null {
  const tiles = rows.filter((entry) => entry.kind === 'drinks').flatMap((entry) => entry.tiles);
  const categoryId = tiles[0]?.product.category_id ?? null;
  if (categoryId === null) return null;
  const onTile = (product: Product, variant: ProductVariant) =>
    tiles.some((entry) => entry.product.id === product.id && entry.variant?.id === variant.id);
  const covered = products
    .filter((product) => product.category_id === categoryId && product.is_active !== false)
    .every((product) => {
      const sizes = activeVariants(product.variants);
      return sizes.length > 0 && sizes.every((size) => onTile(product, size));
    });
  return covered ? categoryId : null;
}
