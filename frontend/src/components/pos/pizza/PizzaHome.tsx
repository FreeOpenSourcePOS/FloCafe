'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { cartVariantUnitPrice } from '@/lib/cart-price';
import { tilePrice } from '@/lib/pizza/pizza-home';
import { activeVariants, isVariantSoldOut } from '@/lib/product-variants';
import type { Category, Product, ProductVariant } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CategoryPill } from './CategoryPill';
import { QuickButtonsBlock, useOnlineOrder } from './useQuickButtons';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
/** The tile draws the focus of its Customize band, so the ring frames the whole pizza. */
const CUSTOMIZE_FOCUS =
  'has-[[data-customize]:focus-visible]:outline-2 has-[[data-customize]:focus-visible]:outline-offset-2 has-[[data-customize]:focus-visible]:outline-foreground';

/**
 * The grid the pizza home lays its tiles on: as many columns as fit three size buttons each,
 * so twelve pizzas fit a tablet screen, and no more than five on a wide one.
 */
// 2.5rem is the four xl gaps between five columns; the 1px keeps rounding from dropping the fifth.
export const PIZZA_GRID_CLASS =
  'grid-cols-[repeat(auto-fill,minmax(max(11.5rem,calc((100%_-_2.5rem_-_1px)/5)),1fr))] gap-1.5! xl:gap-2.5!';

/** The price most pizzas share at each size, by size name: see `standardPrices`. */
type StandardPrices = ReadonlyMap<string, number>;
/** The label of each size on the menu, by size name: see `catalogSizeLabels`. */
type SizeLabels = ReadonlyMap<string, string>;

/**
 * The top-level categories as one row of blocks that wraps. It takes the props
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
    <div data-testid="pizza-category-blocks" className={cn('flex flex-wrap gap-2', className)}>
      {blocks.map((block) => (
        <CategoryPill
          key={block.id ?? 'all'}
          selected={
            block.id === null
              ? selectedCategory == null
              : selectedCategory != null && String(selectedCategory) === String(block.id)
          }
          color={block.color}
          onClick={() => setSelectedCategory(block.id)}
        >
          <span className="line-clamp-2 break-words">{block.name}</span>
        </CategoryPill>
      ))}
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
  standard,
  labels,
  disabled,
  fmt,
  onSize,
  className,
}: {
  product: Product;
  standard: StandardPrices;
  labels: SizeLabels;
  disabled: boolean;
  fmt: (amount: number) => string;
  onSize: (variant: ProductVariant) => void;
  className?: string;
}) {
  const t = useTranslations('pizza');
  // What the cart charges for the size: its online price on an order for an online platform.
  const online = useOnlineOrder();
  const variants = activeVariants(product.variants);
  return (
    // More sizes than a tile is wide wrap to a second row; each button keeps its 48 px.
    <div className={cn('flex min-w-0 max-w-full flex-wrap gap-1', className)}>
      {variants.map((variant) => {
        const price = tilePrice(product, variant, standard, online);
        const soldOut = isVariantSoldOut(variant);
        return (
          <button
            key={variant.id}
            type="button"
            disabled={disabled || soldOut}
            onClick={() => onSize(variant)}
            aria-label={t('sizeOf', {
              pizza: product.name,
              size: variant.name,
              price: fmt(cartVariantUnitPrice({ product, variant }, online)),
            })}
            className={cn(
              'group/size flex min-h-12 min-w-12 max-w-full flex-1 flex-col items-center justify-center rounded-lg border border-border bg-muted/60 px-1 text-center text-sm font-bold leading-tight break-words text-foreground transition-colors hover:border-brand hover:bg-brand hover:text-white active:border-brand active:bg-brand active:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-muted/60 disabled:hover:text-foreground',
              soldOut && 'line-through',
              FOCUS,
            )}
          >
            <span className="max-w-full break-words">
              {labels.get(variant.name) ?? variant.name}
            </span>
            {/* Only a price that differs from the one in the Half & Half legend is shown. */}
            {price !== null && (
              <span className="text-[11px] tabular-nums text-brand group-enabled/size:group-hover/size:text-white group-enabled/size:group-active/size:text-white dark:text-indigo-300">
                {fmt(price)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A pizza on the home screen: the name, where a tap opens the sheet,
 * and a size button for each size, which adds the pizza plain.
 */
export function PizzaTile({
  product,
  number,
  standard,
  labels,
  inCart,
  disabled,
  fmt,
  onSize,
  onCustomize,
}: {
  product: Product;
  number?: number;
  standard: StandardPrices;
  labels: SizeLabels;
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
      className={cn(
        'group flex min-w-0 flex-col rounded-xl border bg-card transition-colors',
        CUSTOMIZE_FOCUS,
        inCart > 0 ? 'border-brand' : 'border-border',
      )}
    >
      {/* The top 48 px opens the sheet; the size buttons sit below it, never over it. */}
      <div className="relative min-h-12 rounded-t-xl px-2 pt-1.5 transition-colors has-[[data-customize]:enabled:hover]:bg-muted/40">
        <button
          type="button"
          data-customize
          disabled={disabled}
          onClick={onCustomize}
          aria-label={t('customizeNamed', { name: product.name })}
          className="absolute inset-0 outline-hidden disabled:cursor-not-allowed"
        />
        {/* The number and the icon float, no taller than a line, so the name's second line has the whole width. */}
        <div className={cn('pointer-events-none relative min-w-0', disabled && 'opacity-50')}>
          {number != null && (
            <span className="float-start me-1.5 font-mono text-[11px] font-semibold leading-4 tabular-nums text-muted-foreground">
              {number}
            </span>
          )}
          <span className="float-end ms-1 flex items-center gap-1">
            <InOrder count={inCart} />
            <SlidersHorizontal
              size={14}
              aria-hidden
              className="text-muted-foreground transition-colors group-has-[[data-customize]:enabled:hover]:text-foreground"
            />
          </span>
          <h3 className="text-[13px] font-semibold leading-tight break-words text-foreground">
            {product.name}
          </h3>
        </div>
      </div>
      <SizeButtons
        product={product}
        standard={standard}
        labels={labels}
        disabled={disabled}
        fmt={fmt}
        onSize={onSize}
        className="mt-auto px-1"
      />
    </div>
  );
}

/**
 * The half-and-half row, first on the home screen: a size button opens the sheet as a half and half
 * at that size. It carries the price most pizzas have at each size, which their buttons leave out.
 */
export function HalfAndHalfTile({
  product,
  standard,
  labels,
  inCart,
  disabled,
  fmt,
  onSize,
}: {
  product: Product;
  standard: StandardPrices;
  labels: SizeLabels;
  inCart: number;
  disabled: boolean;
  fmt: (amount: number) => string;
  onSize: (variant: ProductVariant) => void;
}) {
  const t = useTranslations('pizza');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current;
    const scroller =
      row?.closest<HTMLElement>('[data-testid="pos-catalog-scroll"]') ?? row?.parentElement;
    if (!row || !scroller) return;
    // Anything the keyboard reaches in the list scrolls clear of this sticky row, however tall it wraps.
    const observer = new ResizeObserver(() => {
      scroller.style.scrollPaddingTop = `${Math.ceil(row.getBoundingClientRect().height) + 8}px`;
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
      scroller.style.scrollPaddingTop = '';
    };
  }, []);
  return (
    <div
      ref={ref}
      data-testid="pizza-half-tile"
      className="sticky top-0 z-20 col-span-full flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-muted p-1 ps-2 shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-100 text-sm font-bold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
        >
          ½
        </span>
        <h3 className="text-sm font-semibold leading-tight text-foreground">{product.name}</h3>
        <p className="sr-only">{t('halfTileHint')}</p>
        <InOrder count={inCart} />
      </div>
      <SizeButtons
        product={product}
        standard={standard}
        labels={labels}
        disabled={disabled}
        fmt={fmt}
        onSize={onSize}
      />
      {standard.size > 0 && (
        <p
          data-testid="pizza-price-legend"
          className="ms-auto flex min-w-0 max-w-full flex-wrap items-center gap-x-2.5 pe-2 text-xs text-muted-foreground"
        >
          <span className="font-medium">{t('standardPrices')}</span>
          {[...standard].map(([size, price]) => (
            <span key={size} className="inline-flex max-w-full flex-wrap items-center gap-x-1">
              <span aria-hidden className="min-w-0 break-words">
                {labels.get(size) ?? size}
              </span>
              <span className="sr-only">{size}</span>
              <span className="whitespace-nowrap font-semibold tabular-nums text-foreground">
                {fmt(price)}
              </span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
