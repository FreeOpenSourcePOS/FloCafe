'use client';

import { useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { SheetHalf } from '@/lib/pizza/sheet-state';
import type { ToppingPrices } from '@/lib/pizza/toppings';
import { cn } from '@/lib/utils';
import { MAX_ADDED_TOPPINGS } from '@shared/pizza/toppings';
import type { CatalogPizza, PizzaCatalog } from '@shared/pizza/types';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
const CHIP =
  'inline-flex min-h-12 min-w-12 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors';
const NORMAL = 'border-border bg-card text-foreground hover:border-brand/40';
/** Off the pizza: red, the name struck through. */
const OFF =
  'border-2 border-red-700 bg-red-50 text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300';
/** More of it, or put on: green. An added topping has a dashed edge and a cross to take it off. */
const MORE =
  'border-2 border-emerald-700 bg-emerald-50 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-200';

/** What one extra or added topping costs here, as "+2.25"; nothing while the POS has no price for it. */
function Price({ price }: { price: number | null }) {
  const fmt = useFormatCurrency();
  if (price === null) return null;
  return <span className="font-normal tabular-nums">+{fmt(price)}</span>;
}

/** The cross on a chip whose tap takes what it names off the pizza. */
function TakeOff() {
  const t = useTranslations('pizza');
  return (
    <span role="img" aria-label={t('toppingTakeOff')} className="shrink-0">
      <X size={16} aria-hidden />
    </span>
  );
}

/**
 * The ingredients of one pizza or half as chips, each reading its state in words: the name, `NO`
 * and the name struck through, or `EXTRA`, the name and its price. After them come the toppings
 * added, as `ADD` chips that take the topping off again, and Add, which opens the menu's toppings
 * as a grid. A topping the pizza already has is not listed. A menu without toppings has no Add,
 * and its ingredients go from normal to `NO` and back.
 *
 * The chips show everything the pizza holds, whatever the menu says now: a line made before a
 * menu load can hold a topping the menu dropped, shown by its id, or a removal or an extra of an
 * ingredient the pizza lost. Each has a cross and comes off in one tap, so such a line can always
 * be seen and put right.
 */
export function PizzaChanges({
  catalog,
  pizza,
  half,
  wide,
  price,
  onIngredient,
  onTopping,
}: {
  catalog: PizzaCatalog;
  pizza: CatalogPizza;
  half: SheetHalf;
  /** True when the chips have the width of both halves. */
  wide: boolean;
  /** What one extra or added topping costs on this pizza or half. */
  price: number | null;
  /** `gone` is true for a name the pizza no longer has, which one tap takes off. */
  onIngredient: (name: string, gone?: boolean) => void;
  onTopping: (toppingId: string) => void;
}) {
  const t = useTranslations('pizza');
  const fmt = useFormatCurrency();
  const [listing, setListing] = useState(false);
  const listId = useId();
  const add = useRef<HTMLButtonElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  /** Where the focus goes when the chip that had it is gone: Add, or the chips when there is none. */
  const refocus = () => (add.current ?? chips.current)?.focus();
  const toppings = catalog.toppings?.items ?? [];
  const gone = [...half.removed, ...half.extra].filter((name) => !pizza.ingredients.includes(name));
  const has = new Set(pizza.ingredients.map((name) => name.toLowerCase()));
  const offered = toppings.filter((topping) => !has.has(topping.label.trim().toLowerCase()));
  const full = half.added.length >= MAX_ADDED_TOPPINGS;

  return (
    <>
      <div ref={chips} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        {pizza.ingredients.map((name) => {
          const off = half.removed.includes(name);
          const extra = half.extra.includes(name);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={off || extra}
              data-state={off ? 'no' : extra ? 'extra' : 'normal'}
              onClick={() => onIngredient(name)}
              className={cn(CHIP, FOCUS, off ? OFF : extra ? MORE : NORMAL)}
            >
              {off && <span className="font-bold">{t('no')}</span>}
              {extra && <span className="font-bold">{t('extra')}</span>}
              {off ? <s>{name}</s> : name}
              {extra && <Price price={price} />}
            </button>
          );
        })}
        {gone.map((name) => {
          const off = half.removed.includes(name);
          return (
            <button
              key={name}
              type="button"
              data-testid="pizza-gone-ingredient"
              onClick={() => {
                onIngredient(name, true);
                refocus();
              }}
              className={cn(CHIP, FOCUS, off ? OFF : MORE, 'pe-3')}
            >
              <span className="font-bold">{off ? t('no') : t('extra')}</span>
              {off ? <s>{name}</s> : name}
              <TakeOff />
            </button>
          );
        })}
        {half.added.map((id) => (
          <button
            key={id}
            type="button"
            data-testid="pizza-added-topping"
            onClick={() => {
              onTopping(id);
              // This chip is gone once the topping is off.
              refocus();
            }}
            className={cn(CHIP, FOCUS, MORE, 'border-dashed pe-3')}
          >
            <span className="font-bold">{t('toppingAdded')}</span>
            {toppings.find((topping) => topping.id === id)?.label ?? id}
            <Price price={price} />
            <TakeOff />
          </button>
        ))}
        {offered.length > 0 && (
          <button
            ref={add}
            type="button"
            aria-label={t('toppingAddLabel')}
            aria-expanded={listing}
            aria-controls={listId}
            onClick={() => setListing(!listing)}
            className={cn(
              CHIP,
              FOCUS,
              'border-dashed border-brand text-brand hover:bg-muted dark:text-indigo-300',
              listing && 'bg-muted',
            )}
          >
            <Plus size={16} aria-hidden className="shrink-0" />
            {t('toppingAdd')}
          </button>
        )}
      </div>
      {listing && offered.length > 0 && (
        <div
          id={listId}
          role="group"
          aria-label={t('toppings')}
          data-testid="pizza-toppings-list"
          className="mt-2 rounded-lg bg-muted p-2"
        >
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
            {price === null ? t('toppings') : t('toppingsEach', { price: fmt(price) })}
          </p>
          <div className={cn('grid gap-1.5', wide ? 'grid-cols-6' : 'grid-cols-3')}>
            {offered.map((topping) => {
              const on = half.added.includes(topping.id);
              return (
                <button
                  key={topping.id}
                  type="button"
                  aria-pressed={on}
                  disabled={full && !on}
                  onClick={() => onTopping(topping.id)}
                  className={cn(
                    'min-h-12 min-w-12 rounded-lg border px-2 py-1 text-sm font-semibold leading-tight break-words transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    FOCUS,
                    on ? MORE : 'border-border bg-card text-foreground hover:border-brand/40',
                  )}
                >
                  {topping.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The price lines of a pizza's or a deal's toppings: "2 toppings" and "1 half topping", each
 * with what the cart charges for them, or a dash while the POS has no price for one.
 */
export function ToppingPriceLines({
  counts,
  prices,
}: {
  counts: { whole: number; half: number };
  prices: ToppingPrices;
}) {
  const t = useTranslations('pizza');
  const fmt = useFormatCurrency();
  const lines = [
    { key: 'toppingLine' as const, count: counts.whole, each: prices.whole },
    { key: 'halfToppingLine' as const, count: counts.half, each: prices.half },
  ];
  return lines.map(
    ({ key, count, each }) =>
      count > 0 && (
        <div key={key} data-testid="pizza-topping-price" className="contents">
          <dt>{t(key, { count })}</dt>
          <dd className="text-end tabular-nums">{each === null ? '—' : fmt(each * count)}</dd>
        </div>
      ),
  );
}
