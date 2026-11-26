'use client';

import { Check, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getCategoryColorClasses } from '@/components/pos/ProductGrid';
import { activeVariants, isVariantSoldOut } from '@/lib/product-variants';
import type { Category, Product, ProductVariant } from '@/lib/types';
import { cn } from '@/lib/utils';
import { QuickButtonsBlock } from './useQuickButtons';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
/** The outline drawn inside, for a control whose tile clips what leaves it. */
const FOCUS_INSET =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground';

/**
 * The grid the pizza home lays its tiles on: as many columns as fit three size buttons each,
 * close together, so twelve pizzas fit a tablet screen.
 */
export const PIZZA_GRID_CLASS = 'grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-1!';

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
      <QuickButtonsBlock selected={selectedCategory} onSelect={setSelectedCategory} />
    </div>
  );
}

/** How many of that product the order holds. */
function InOrder({ count }: { count: number }) {
  const t = useTranslations('pizza');
  if (count <= 0) return null;
  return (
    <span className="flex h-4 shrink-0 items-center rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{t('inOrder', { count })}</span>
    </span>
  );
}

function SizeButtons({
  product,
  disabled,
  fmt,
  onSize,
  className,
}: {
  product: Product;
  disabled: boolean;
  fmt: (amount: number) => string;
  onSize: (variant: ProductVariant) => void;
  className?: string;
}) {
  const t = useTranslations('pizza');
  return (
    // More sizes than a tile is wide wrap to a second row; each button keeps its 48 px.
    <div className={cn('flex flex-wrap', className)}>
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
            'flex min-h-12 min-w-12 flex-1 flex-col items-center justify-center border-s border-border px-1 text-[13px] font-bold leading-tight text-foreground transition-colors first:border-s-0 hover:bg-muted active:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
            FOCUS_INSET,
          )}
        >
          {variant.name}
          <span className="text-[11px] tabular-nums text-brand dark:text-indigo-300">
            {fmt(Number(variant.price))}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * A pizza on the home screen, two rows of 48 px: the name, which opens the sheet,
 * and a size button for each size, which adds the pizza plain.
 */
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
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="relative flex min-h-12 flex-1 items-center px-1.5 py-1">
        {/* The number and the icon float, no taller than a line, so the name's second line has the whole width. */}
        <div className={cn('min-w-0 flex-1', disabled && 'opacity-50')}>
          {number != null && (
            <span className="float-start me-1.5 flex h-4 min-w-5 items-center justify-center rounded bg-red-50 px-0.5 text-[11px] font-bold tabular-nums text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {number}
            </span>
          )}
          <span className="float-end ms-1 flex items-center gap-1">
            <InOrder count={inCart} />
            <SlidersHorizontal size={14} aria-hidden className="text-brand dark:text-indigo-300" />
          </span>
          <h3 className="text-[13px] font-semibold leading-tight break-words text-foreground">
            {product.name}
          </h3>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onCustomize}
          aria-label={t('customizeNamed', { name: product.name })}
          className={cn(
            'absolute inset-0 rounded-t-xl hover:bg-foreground/5 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            FOCUS_INSET,
          )}
        />
      </div>
      <SizeButtons
        product={product}
        disabled={disabled}
        fmt={fmt}
        onSize={onSize}
        className="border-t border-border"
      />
    </div>
  );
}

/** The half-and-half row, first on the home screen: a size button opens the sheet as a half and half at that size. */
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
      className="col-span-full flex items-center gap-2 overflow-hidden rounded-xl border-2 border-dashed border-orange-400 bg-orange-50 ps-2 dark:border-orange-700 dark:bg-orange-950/30"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-orange-100 text-xs font-bold text-orange-800 dark:bg-orange-900/60 dark:text-orange-200">
        ½
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-bold leading-tight text-foreground">{product.name}</h3>
        <p className="truncate text-xs text-muted-foreground">{t('halfTileHint')}</p>
      </div>
      <InOrder count={inCart} />
      <SizeButtons
        product={product}
        disabled={disabled}
        fmt={fmt}
        onSize={onSize}
        className="w-56 shrink-0 border-s border-orange-400 dark:border-orange-700"
      />
    </div>
  );
}
