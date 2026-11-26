'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/utils';
import type { CatalogPizza } from '@shared/pizza/types';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

function PizzaNumber({ pizza, chosen }: { pizza: CatalogPizza; chosen: boolean }) {
  if (pizza.number == null) return null;
  return (
    <span
      className={cn(
        'flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-0.5 text-xs font-bold tabular-nums',
        chosen
          ? 'bg-white text-brand'
          : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
      )}
    >
      {pizza.number}
    </span>
  );
}

/**
 * Which pizza a half, or the whole pizza, is. Until one is chosen every pizza
 * of the menu is listed; after that only the chosen one shows, with Change to
 * list them again, so a long menu leaves the ingredients on screen.
 */
export function PizzaChoice({
  pizzas,
  chosen,
  wide,
  onChoose,
}: {
  pizzas: CatalogPizza[];
  chosen: CatalogPizza | undefined;
  /** True when the list has the width of both halves. */
  wide: boolean;
  onChoose: (pizzaId: string) => void;
}) {
  const t = useTranslations('pizza');
  // Null until the list is opened or closed by hand; from then on the focus follows to the control that took the tapped one's place.
  const [listing, setListing] = useState<boolean | null>(null);

  if (chosen && !listing)
    return (
      <div
        data-testid="pizza-choice"
        className="flex min-h-12 items-center gap-2 rounded-lg border border-brand bg-brand ps-2 text-white"
      >
        <PizzaNumber pizza={chosen} chosen />
        <span className="min-w-0 flex-1 py-1 text-sm font-semibold leading-tight break-words">
          {chosen.name}
        </span>
        <button
          type="button"
          // The list button that had the focus is gone.
          autoFocus={listing === false}
          onClick={() => setListing(true)}
          className={cn(
            'min-h-12 min-w-12 shrink-0 rounded-e-lg border-s border-white/40 px-3 text-sm font-semibold hover:bg-white/10',
            FOCUS,
          )}
        >
          {t('change')}
        </button>
      </div>
    );

  return (
    <div className={cn('grid gap-1.5', wide ? 'grid-cols-4' : 'grid-cols-2')}>
      {pizzas.map((pizza) => {
        const isChosen = pizza.id === chosen?.id;
        return (
          <button
            key={pizza.id}
            type="button"
            aria-pressed={isChosen}
            // Change, which had the focus, is gone.
            autoFocus={isChosen && listing === true}
            onClick={() => {
              setListing(false);
              onChoose(pizza.id);
            }}
            className={cn(
              'flex min-h-12 items-center gap-2 rounded-lg border px-2 py-1 text-start text-sm font-semibold leading-tight break-words transition-colors',
              FOCUS,
              isChosen
                ? 'border-brand bg-brand text-white'
                : 'border-border bg-card text-foreground hover:border-brand/40',
            )}
          >
            <PizzaNumber pizza={pizza} chosen={isChosen} />
            {pizza.name}
          </button>
        );
      })}
    </div>
  );
}
