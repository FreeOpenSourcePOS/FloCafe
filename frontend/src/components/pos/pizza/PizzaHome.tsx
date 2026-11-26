'use client';

import { Check, ChevronRight } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getCategoryColorClasses } from '@/components/pos/ProductGrid';
import { activeVariants, isVariantSoldOut } from '@/lib/product-variants';
import type { Category, Product, ProductVariant } from '@/lib/types';
import { cn } from '@/lib/utils';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

/** The grid the pizza home lays its tiles on: as many columns as fit three size buttons each. */
export const PIZZA_GRID_CLASS = 'grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))]';

/**
 * The top-level categories as large colour-coded blocks. It takes the props
 * of the product grid's category row, so the grid swaps one for the other.
 */
export function PizzaCategoryBlocks({
  className,
  categories,
  selectedCategory,
  setSelectedCategory,
  allLabel,
}: {
  className: string;
  collapse: boolean;
  categories: Category[];
  selectedCategory: Category['id'] | null;
  setSelectedCategory: (id: Category['id'] | null) => void;
  allLabel: string;
  resetKey: string | null;
}) {
  const blocks = [
    { id: null as Category['id'] | null, name: allLabel, color: null as string | null },
    ...categories,
  ];
  return (
    <div
      data-testid="pizza-category-blocks"
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2', className)}
    >
      {blocks.map((block) => {
        const selected =
          block.id === null
            ? selectedCategory == null
            : selectedCategory != null && String(selectedCategory) === String(block.id);
        const color = getCategoryColorClasses(block.color);
        return (
          <button
            key={block.id ?? 'all'}
            type="button"
            aria-pressed={selected}
            onClick={() => setSelectedCategory(block.id)}
            className={cn(
              'flex min-h-14 items-center justify-between gap-2 rounded-xl border border-s-4 px-3 text-start text-base font-bold leading-tight transition-colors',
              FOCUS,
              color
                ? `${color.bg} ${color.text} ${color.border}`
                : 'border-border bg-card text-foreground',
              // The ring and the tick mark the chosen block; its colour says which category it is.
              selected && 'border-current ring-2 ring-inset ring-current',
            )}
          >
            <span className="line-clamp-2 break-words">{block.name}</span>
            {selected && <Check size={18} className="shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}

/** The line under a tile's name, with how many of that product the order holds. */
function TileHint({ text, inCart }: { text: string; inCart: number }) {
  const t = useTranslations('pizza');
  return (
    <div className="flex items-center gap-2">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{text}</p>
      {inCart > 0 && (
        <span className="shrink-0 rounded-full bg-brand px-2 py-0.5 text-xs font-bold text-white">
          {t('inOrder', { count: inCart })}
        </span>
      )}
    </div>
  );
}

function SizeButtons({
  product,
  disabled,
  fmt,
  onSize,
}: {
  product: Product;
  disabled: boolean;
  fmt: (amount: number) => string;
  onSize: (variant: ProductVariant) => void;
}) {
  const t = useTranslations('pizza');
  return (
    <div className="mt-auto flex gap-1.5">
      {activeVariants(product.variants).map((variant) => (
        <button
          key={variant.id}
          type="button"
          disabled={disabled || isVariantSoldOut(variant)}
          onClick={() => onSize(variant)}
          aria-label={t('sizeOf', {
            pizza: product.name,
            size: variant.name,
            price: fmt(Number(variant.price)),
          })}
          className={cn(
            'flex min-h-12 min-w-12 flex-1 flex-col items-center justify-center rounded-lg border border-border bg-card px-1 text-sm font-bold leading-tight text-foreground transition-colors hover:border-brand/40 active:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
            FOCUS,
          )}
        >
          {variant.name}
          <span className="text-xs tabular-nums text-brand dark:text-indigo-300">
            {fmt(Number(variant.price))}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A pizza on the home screen: a size button adds it plain, Customize opens the sheet. */
export function PizzaTile({
  product,
  number,
  inCart,
  disabled,
  fmt,
  onSize,
  onCustomize,
}: {
  product: Product;
  number?: number;
  inCart: number;
  disabled: boolean;
  fmt: (amount: number) => string;
  onSize: (variant: ProductVariant) => void;
  onCustomize: () => void;
}) {
  const t = useTranslations('pizza');
  return (
    <div
      data-testid="pizza-tile"
      className="flex min-h-36 flex-col gap-1 rounded-xl border border-border bg-card p-2.5"
    >
      <div className="flex items-center gap-2">
        {number != null && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-50 text-xs font-bold tabular-nums text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {number}
          </span>
        )}
        <h3 className="min-w-0 flex-1 text-base font-bold leading-tight text-foreground line-clamp-2">
          {product.name}
        </h3>
        <button
          type="button"
          disabled={disabled}
          onClick={onCustomize}
          aria-label={t('customizeNamed', { name: product.name })}
          className={cn(
            '-me-1.5 flex min-h-12 min-w-12 shrink-0 items-center rounded-lg px-1.5 text-sm font-semibold text-brand hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-300',
            FOCUS,
          )}
        >
          {t('customize')}
          <ChevronRight size={14} className="rtl-flip" />
        </button>
      </div>
      <TileHint text={product.description || t('noIngredients')} inCart={inCart} />
      <SizeButtons product={product} disabled={disabled} fmt={fmt} onSize={onSize} />
    </div>
  );
}

/** The half-and-half tile: a size button opens the sheet as a half and half at that size. */
export function HalfAndHalfTile({
  product,
  inCart,
  disabled,
  fmt,
  onSize,
}: {
  product: Product;
  inCart: number;
  disabled: boolean;
  fmt: (amount: number) => string;
  onSize: (variant: ProductVariant) => void;
}) {
  const t = useTranslations('pizza');
  return (
    <div
      data-testid="pizza-half-tile"
      className="flex min-h-36 flex-col gap-1 rounded-xl border-2 border-dashed border-orange-400 bg-orange-50 p-2.5 dark:border-orange-700 dark:bg-orange-950/30"
    >
      <div className="flex min-h-12 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-orange-100 text-xs font-bold text-orange-800 dark:bg-orange-900/60 dark:text-orange-200">
          ½
        </span>
        <h3 className="text-base font-bold leading-tight text-foreground">{product.name}</h3>
      </div>
      <TileHint text={t('halfTileHint')} inCart={inCart} />
      <SizeButtons product={product} disabled={disabled} fmt={fmt} onSize={onSize} />
    </div>
  );
}
