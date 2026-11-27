'use client';

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { getCategoryColorClasses } from '@/components/pos/ProductGrid';
import { cn } from '@/lib/utils';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

/** A block of the pizza home's category row: a dot in the category's colour, and a fill and a tick when chosen. */
export function CategoryPill({
  selected,
  color,
  onClick,
  children,
}: {
  selected: boolean;
  color: string | null | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  const dot = getCategoryColorClasses(color)?.activeBg;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'group flex min-h-12 min-w-12 items-center gap-2 rounded-xl border px-3 text-start text-sm font-semibold leading-tight transition-colors',
        FOCUS,
        selected
          ? 'border-brand bg-brand text-white'
          : 'border-border bg-card text-foreground hover:bg-muted',
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cn('h-2 w-2 shrink-0 rounded-full', dot, selected && 'ring-2 ring-white')}
        />
      )}
      {children}
      {selected && <Check size={16} className="shrink-0" />}
    </button>
  );
}
