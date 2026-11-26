'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { customizeOne, replaceCartLine, sheetAddons } from '@/lib/pizza/cart-lines';
import { PIZZA_PRODUCT_PREFIX } from '@/lib/pizza/line-recipe';
import { newSheet, sheetReducer, type SheetLine, type SheetState } from '@/lib/pizza/sheet-state';
import type { CartItem, Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { pizzaLineEditButton } from './PizzaCartLine';
import { HalfAndHalfTile, PIZZA_GRID_CLASS, PizzaCategoryBlocks, PizzaTile } from './PizzaHome';
import PizzaSheet from './PizzaSheet';
import { usePizzaCatalog } from './usePizzaCatalog';
import { PizzaDealDialog, usePizzaDeal } from './usePizzaDeal';
import { QuickButtonsArea } from './QuickButtons';
import { useQuickButtonSheet } from './useQuickButtons';

const HALF_AND_HALF = `${PIZZA_PRODUCT_PREFIX}half-and-half`;
const PIZZAS_CATEGORY = 'cat-pizzas';

/** The cart with a line "Customize 1" split off merged back into the line it came from. */
function mergedBack(split: CartItem): CartItem[] {
  const { id, ...line } = split;
  return replaceCartLine(useCartStore.getState().items, id, line);
}

/** What the POS page, the product grid and the cart panel hook the pizza screens in with. */
export interface PizzaPos {
  /** Takes the place of the product grid's category row. */
  Categories: typeof PizzaCategoryBlocks;
  gridClassName: string;
  /** The tile of a pizza product; null for any other product, which keeps upstream's tile. */
  tile: (
    product: Product,
    inCart: number,
    disabled: boolean,
    fmt: (amount: number) => string,
  ) => ReactNode;
  /** Opens the sheet for a pizza product, or the deal configurator for a deal; false for any other product. */
  open: (product: Product, quantity?: number) => boolean;
  /** True for a cart line the sheet or the deal configurator edits. */
  isPizzaLine: (item: CartItem) => boolean;
  /** Opens the sheet or the deal configurator on a cart line; false for a line that is neither. */
  edit: (item: CartItem) => boolean;
  /** "Customize 1": takes one off the line and opens the sheet on it. */
  customizeOne: (item: CartItem) => void;
  /** The open sheet or deal configurator, or null. */
  sheet: ReactNode;
  /** Sits above the grid's tiles: the quick buttons page, or a customer's favourites. */
  above: (category: string | null) => ReactNode;
}

interface Session {
  initial: SheetState;
  /** The cart line the sheet saves over; null when it adds a new one. */
  lineId: string | null;
}

/** The pizza screens of the POS page; null when no pizza menu is loaded. */
export function usePizzaPos(
  products: Product[],
  categories: Category[],
  selectCategory: (id: string | null) => void,
): PizzaPos | null {
  const t = useTranslations('pizza');
  const catalog = usePizzaCatalog();
  const deal = usePizzaDeal(catalog);
  const quick = useQuickButtonSheet();
  const [session, setSession] = useState<Session | null>(null);
  /** The line "Customize 1" split off, merged back unless the sheet saves it. */
  const split = useRef<CartItem | null>(null);
  /** The cart line the sheet last wrote, which takes the focus when the sheet's opener is gone. */
  const written = useRef<string | null>(null);

  // Leaving the POS with a "Customize 1" sheet open would strand the split line in the cart.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Development runs this cleanup and the effect again at once; only a real unmount stays unmounted.
      queueMicrotask(() => {
        if (mounted.current || !split.current) return;
        useCartStore.setState({ items: mergedBack(split.current) });
        split.current = null;
      });
    };
  }, []);

  // A pizza shop opens on its pizzas.
  const hasPizzas = Boolean(catalog) && categories.some((entry) => entry.id === PIZZAS_CATEGORY);
  useEffect(() => {
    if (hasPizzas) selectCategory(PIZZAS_CATEGORY);
  }, [hasPizzas, selectCategory]);

  if (!catalog) return null;

  const isPizzaLine = (item: CartItem) =>
    deal.isDealLine(item) ||
    (item.product.id.startsWith(PIZZA_PRODUCT_PREFIX) && item.recipe?.kind !== 'deal');
  const openSheet = (initial: SheetState, lineId: string | null = null) => {
    written.current = null;
    setSession({ initial, lineId });
  };
  const openLine = (line: CartItem) =>
    deal.edit(line) || openSheet(sheetReducer(newSheet(), { type: 'load', line }), line.id);
  /** Writes the cart and notes which line is new in it. */
  const writeCart = (items: CartItem[]) => {
    const before = useCartStore.getState().items;
    written.current = items.find((item) => !before.includes(item))?.id ?? null;
    useCartStore.setState({ items });
  };
  const menuPizza = (product: Product) =>
    catalog.pizzas.find((pizza) => PIZZA_PRODUCT_PREFIX + pizza.id === product.id);
  const sizeOf = (product: Product, variantId: string) => variantId.slice(product.id.length + 1);

  const save = (line: SheetLine, state: SheetState, asButton = false) => {
    const product = products.find((entry) => entry.id === line.productId);
    const variant = product?.variants?.find((entry) => entry.id === line.variantId);
    const onSale = (product?.addon_groups ?? []).flatMap((group) => group.addons ?? []);
    const dips = line.dips.flatMap((dip) => {
      const addon = onSale.find((entry) => entry.id === dip.addonId);
      return addon ? [{ ...addon, quantity: dip.quantity }] : [];
    });
    // The menu was changed in the catalogue since it was loaded: refuse, never add half a pizza.
    if (!product || !variant || dips.length !== line.dips.length) {
      toast.error(t('notOnPos'));
      return;
    }
    const cart = useCartStore.getState();
    const note = state.note.trim();
    const held = {
      product,
      variant,
      addons: dips,
      special_instructions: note,
      recipe: line.recipe,
    };
    if (quick.takes(held, asButton || session?.lineId, () => setSession(null))) return;
    const source = cart.items.find((item) => item.id === session?.lineId);
    if (source) {
      writeCart(
        replaceCartLine(cart.items, source.id, {
          product,
          variant,
          quantity: state.quantity,
          addons: sheetAddons(source.addons, dips),
          special_instructions: note,
          ...(source.price_override ? { price_override: source.price_override } : {}),
          ...(line.recipe ? { recipe: line.recipe } : {}),
        }),
      );
    } else {
      cart.addItem(product, state.quantity, dips, note, variant, line.recipe);
    }
    split.current = null;
    setSession(null);
  };

  const close = () => {
    if (split.current) writeCart(mergedBack(split.current));
    split.current = null;
    setSession(null);
  };

  const pos: PizzaPos = {
    Categories: PizzaCategoryBlocks,
    gridClassName: PIZZA_GRID_CLASS,
    tile: (product, inCart, disabled, fmt) => {
      if (product.id === HALF_AND_HALF)
        return (
          <HalfAndHalfTile
            key={product.id}
            product={product}
            inCart={inCart}
            disabled={disabled}
            fmt={fmt}
            onSize={(variant) =>
              openSheet(newSheet({ split: true, sizeId: sizeOf(product, variant.id) }))
            }
          />
        );
      const pizza = menuPizza(product);
      if (!pizza) return null;
      return (
        <PizzaTile
          key={product.id}
          product={product}
          number={pizza.number}
          inCart={inCart}
          disabled={disabled}
          fmt={fmt}
          onSize={(variant) => useCartStore.getState().addItem(product, 1, [], '', variant)}
          onCustomize={() => openSheet(newSheet({ pizzaId: pizza.id }))}
        />
      );
    },
    open: (product, quantity = 1) => {
      if (deal.open(product, quantity)) return true;
      const pizza = menuPizza(product);
      if (!pizza && product.id !== HALF_AND_HALF) return false;
      openSheet({ ...newSheet({ pizzaId: pizza?.id, split: !pizza }), quantity });
      return true;
    },
    isPizzaLine,
    edit: (item) => {
      if (!isPizzaLine(item)) return false;
      openLine(item);
      return true;
    },
    customizeOne: (item) => {
      const result = customizeOne(useCartStore.getState().items, item.id);
      if (!result) return;
      useCartStore.setState({ items: result.items });
      openLine(result.line);
      split.current = result.line.id === item.id ? null : result.line;
    },
    above: (category) => (
      <QuickButtonsArea category={category} products={products} onEditItem={openLine} />
    ),
    sheet: session ? (
      <PizzaSheet
        catalog={catalog}
        initial={session.initial}
        editing={session.lineId !== null}
        onSave={save}
        onSaveButton={(line, state) => save(line, state, true)}
        onClose={close}
        returnFocus={() => pizzaLineEditButton(written.current)}
      />
    ) : (
      // True while a quick button dialog is open, so the POS page counts it as a modal.
      quick.dialogOpen
    ),
  };
  const dealDialog = deal.session && (
    <PizzaDealDialog
      deal={deal}
      catalog={catalog}
      onSaved={(items) => {
        writeCart(items);
        split.current = null;
      }}
      onClosed={close}
      returnFocus={() => pizzaLineEditButton(written.current)}
    />
  );
  return dealDialog ? { ...pos, sheet: dealDialog } : pos;
}
