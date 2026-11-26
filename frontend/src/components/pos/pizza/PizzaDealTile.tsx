'use client';

import { useTranslations } from 'use-intl';
import type { Product } from '@/lib/types';

/**
 * A deal on the home screen: its name, its price and what it contains, cut to
 * two lines. The configurator it opens shows that text whole.
 */
export function PizzaDealTile({
  product,
  description,
  inCart,
  disabled,
  fmt,
  onOpen,
}: {
  product: Product;
  /** The deal's description from the menu file; may be empty. */
  description: string;
  inCart: number;
  disabled: boolean;
  fmt: (amount: number) => string;
  onOpen: () => void;
}) {
  const t = useTranslations('pizza');
  return (
    <button
      type="button"
      data-testid="pos-product-card"
      disabled={disabled}
      onClick={onOpen}
      title={description || undefined}
      className="flex min-h-24 flex-col gap-1 rounded-xl border border-border bg-card p-2.5 text-start transition-colors hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground active:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex w-full items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-bold leading-tight break-words text-foreground">
          {product.name}
        </span>
        {inCart > 0 && (
          <span className="shrink-0 rounded-full bg-brand px-2 py-0.5 text-xs font-bold tabular-nums text-white">
            <span aria-hidden>{inCart}</span>
            <span className="sr-only">{t('inOrder', { count: inCart })}</span>
          </span>
        )}
      </span>
      {description && (
        <span
          data-testid="pizza-deal-description"
          className="line-clamp-2 text-xs leading-snug text-muted-foreground"
        >
          {description}
        </span>
      )}
      <span className="mt-auto text-base font-bold tabular-nums text-brand dark:text-indigo-300">
        {fmt(Number(product.price))}
      </span>
    </button>
  );
}
