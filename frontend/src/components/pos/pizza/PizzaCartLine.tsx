'use client';

import { useTranslations } from 'use-intl';
import { cartLineDetailLines } from '@/lib/pizza/detail-lines';
import type { CartItem } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { PizzaStepper } from './PizzaSheet';

const ACTION =
  'min-h-12 min-w-12 rounded-lg border border-border bg-card px-2 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

/** The kitchen lines under a pizza or deal in the cart; nothing for any other line. */
export function PizzaLineDetails({ item }: { item: CartItem }) {
  return cartLineDetailLines(item).map((text, index) => (
    <p
      key={index}
      data-testid="pizza-line-detail"
      className={`whitespace-pre font-mono text-xs font-semibold leading-snug ${
        text.trimStart().startsWith('NO ') ? 'text-red-700 dark:text-red-300' : 'text-foreground'
      }`}
    >
      {text}
    </p>
  ));
}

/** The Edit button of a pizza line on screen, where the focus goes after the sheet changed that line. */
export function pizzaLineEditButton(lineId: string | null): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLElement>('[data-pizza-line-edit]');
  return (
    [...buttons].find(
      (button) => button.dataset.pizzaLineEdit === lineId && button.offsetParent !== null,
    ) ?? null
  );
}

/** The 48 px action row of a pizza line: quantity, "Customize 1" on a line of several, Edit. */
export function PizzaLineActions({
  item,
  onEdit,
  onCustomizeOne,
}: {
  item: CartItem;
  onEdit: (item: CartItem) => void;
  onCustomizeOne: (item: CartItem) => void;
}) {
  const t = useTranslations('pizza');
  const tCommon = useTranslations('common');
  const updateQuantity = useCartStore((cart) => cart.updateQuantity);
  return (
    <div
      data-testid="pizza-line-actions"
      className="mt-1.5 flex items-center justify-between gap-1.5"
    >
      <PizzaStepper
        name={item.product.name}
        value={item.quantity}
        least={0}
        onChange={(quantity) => updateQuantity(item.id, quantity)}
        valueTestId="pizza-line-quantity"
      />
      <div className="flex gap-1.5">
        {item.quantity > 1 && (
          <button type="button" className={ACTION} onClick={() => onCustomizeOne(item)}>
            {t('customizeOne')}
          </button>
        )}
        <button
          type="button"
          className={ACTION}
          data-pizza-line-edit={item.id}
          onClick={() => onEdit(item)}
        >
          {tCommon('edit')}
        </button>
      </div>
    </div>
  );
}
