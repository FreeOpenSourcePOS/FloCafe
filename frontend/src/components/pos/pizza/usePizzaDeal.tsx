'use client';

import { useState } from 'react';
import { replaceCartLine } from '@/lib/pizza/cart-lines';
import { newDeal, type DealState } from '@/lib/pizza/deal-state';
import type { CartItem, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import type { CatalogDeal, PizzaCatalog } from '@shared/pizza/types';
import PizzaDeal from './PizzaDeal';

/** Product ids of deals start with this. */
const DEAL_PRODUCT_PREFIX = 'dl-';

interface Session {
  deal: CatalogDeal;
  product: Product;
  initial: DealState;
  quantity: number;
  /** The cart line the configurator saves over; null when it adds a new one. */
  lineId: string | null;
}

/** The deal configurator of the POS page: which products and cart lines are deals, and the one that is open. */
export function usePizzaDeal(catalog: PizzaCatalog | null) {
  const [session, setSession] = useState<Session | null>(null);
  const dealOf = (product: Product) =>
    catalog?.deals.find((deal) => DEAL_PRODUCT_PREFIX + deal.id === product.id);

  return {
    /** True for a cart line the configurator edits. */
    isDealLine: (item: CartItem) => Boolean(dealOf(item.product)),
    /** Opens the configurator on a deal product with nothing chosen; false for any other product. */
    open: (product: Product, quantity: number) => {
      const deal = dealOf(product);
      if (deal) setSession({ deal, product, initial: newDeal(deal), quantity, lineId: null });
      return Boolean(deal);
    },
    /** Opens the configurator on a deal line of the cart; false for any other line. */
    edit: (item: CartItem) => {
      const deal = dealOf(item.product);
      if (deal)
        setSession({
          deal,
          product: item.product,
          initial: newDeal(deal, item.recipe?.kind === 'deal' ? item.recipe : null),
          quantity: item.quantity,
          lineId: item.id,
        });
      return Boolean(deal);
    },
    /** What is open, or null. */
    session,
    end: () => setSession(null),
  };
}

/**
 * The open configurator. A new deal goes into the cart here. An edited line
 * goes to `onSaved` as the cart with that line saved, because `usePizzaPos`
 * owns the cart's split line and the focus.
 */
export function PizzaDealDialog({
  deal: { session, end },
  catalog,
  onSaved,
  onClosed,
  returnFocus,
}: {
  deal: ReturnType<typeof usePizzaDeal>;
  catalog: PizzaCatalog;
  onSaved: (items: CartItem[]) => void;
  /** The configurator closed without saving. */
  onClosed: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  if (!session) return null;
  return (
    <PizzaDeal
      catalog={catalog}
      deal={session.deal}
      initial={session.initial}
      editing={session.lineId !== null}
      quantity={session.quantity}
      onSave={(recipe) => {
        const cart = useCartStore.getState();
        const source = cart.items.find((item) => item.id === session.lineId);
        if (source) {
          // The deal's choices are all the configurator changes on a line.
          const { id, ...line } = source;
          onSaved(replaceCartLine(cart.items, id, { ...line, recipe }));
        } else {
          cart.addItem(session.product, session.quantity, [], '', null, recipe);
        }
        end();
      }}
      onClose={() => {
        end();
        onClosed();
      }}
      returnFocus={returnFocus}
    />
  );
}
