import React from 'react';
import { User } from 'lucide-react';
import { cn } from '@/lib/utils';

export const CHECKOUT_PRIMARY_CTA_CLASS =
  'bg-brand text-white shadow-xs hover:bg-brand-hover active:bg-brand-hover disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100';

export interface CheckoutHeaderChipItem {
  key: string;
  label: React.ReactNode;
  variant?: 'neutral' | 'brand' | 'customer';
}

export function CheckoutHeaderChips({
  chips,
  className,
}: {
  chips: CheckoutHeaderChipItem[];
  className?: string;
}) {
  if (chips.length === 0) return null;

  return (
    <div
      data-testid="checkout-header-chips"
      className={cn(
        'flex min-w-0 max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible',
        className,
      )}
    >
      {chips.map((chip) => {
        const variant = chip.variant ?? 'neutral';
        return (
          <span
            key={chip.key}
            className={cn(
              'inline-flex h-5 max-w-48 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium leading-none',
              variant === 'brand' &&
                'border-brand/25 bg-brand-light text-brand dark:border-indigo-400/35 dark:bg-[var(--color-brand-light)] dark:text-indigo-300',
              variant === 'customer' &&
                'border-border/80 bg-card text-foreground shadow-2xs dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
              variant === 'neutral' &&
                'border-border/75 bg-muted/50 text-muted-foreground dark:border-white/10 dark:bg-muted/30',
            )}
          >
            {variant === 'customer' ? (
              <User className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="truncate">{chip.label}</span>
          </span>
        );
      })}
    </div>
  );
}

export function CheckoutQtyBadge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-border/80 bg-muted/65 px-1.5 text-[11px] font-semibold tabular-nums text-foreground dark:border-white/10 dark:bg-muted/35',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function getTenderRowClasses({
  isFocused,
  isAllocated,
  disabled = false,
}: {
  isFocused: boolean;
  isAllocated: boolean;
  disabled?: boolean;
}) {
  if (disabled) {
    return {
      buttonClass:
        'border-border/60 bg-muted/40 text-muted-foreground opacity-60 cursor-not-allowed dark:border-white/8',
      inputBoxClass: 'border-border/60 bg-muted/25 opacity-60 dark:border-white/8',
      currencyClass: 'text-muted-foreground/70 font-medium',
      inputClass: 'text-muted-foreground font-medium cursor-not-allowed',
    };
  }

  if (isFocused) {
    return {
      buttonClass: 'border-brand bg-brand text-white shadow-xs',
      inputBoxClass:
        'border-brand bg-brand-light/35 ring-2 ring-brand/20 dark:border-indigo-400/70 dark:bg-[var(--color-brand-light)] dark:ring-indigo-400/25',
      currencyClass: 'text-brand font-semibold dark:text-indigo-300',
      inputClass: 'text-foreground font-bold',
    };
  }

  if (isAllocated) {
    return {
      buttonClass:
        'border-brand/40 bg-brand-light/75 text-brand hover:bg-brand-light dark:border-indigo-400/40 dark:bg-[var(--color-brand-light)] dark:text-indigo-300 dark:hover:bg-indigo-500/25',
      inputBoxClass:
        'border-brand/40 bg-card shadow-2xs dark:border-indigo-400/40 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
      currencyClass: 'text-brand/80 font-medium dark:text-indigo-300/80',
      inputClass: 'text-foreground font-semibold',
    };
  }

  return {
    buttonClass:
      'border-border bg-card text-foreground shadow-2xs hover:border-brand/30 hover:bg-muted/55 dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
    inputBoxClass:
      'border-border bg-card shadow-2xs hover:border-brand/25 dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
    currencyClass: 'text-muted-foreground font-medium',
    inputClass: 'text-foreground font-medium placeholder:text-muted-foreground/55',
  };
}

export function clampCheckoutPadValue(value: string, max?: number): string {
  if (max == null || value === '' || value === '.') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric > max ? String(max) : value;
}

export function appendCheckoutPadDigit(
  value: string,
  digit: string,
  allowDecimal: boolean,
  max?: number,
): string {
  if (digit === '.') {
    if (!allowDecimal || value.includes('.')) return value;
    return value === '' ? '0.' : `${value}.`;
  }
  if (digit === '00' && (value === '' || value === '0')) {
    return clampCheckoutPadValue('0', max);
  }
  const next = value === '0' ? digit : `${value}${digit}`;
  return clampCheckoutPadValue(next, max);
}

export function applyPhysicalCheckoutKey(
  currentValue: string,
  key: string,
  allowDecimal: boolean,
  max?: number,
): string | null {
  if (/^[0-9]$/.test(key)) {
    return appendCheckoutPadDigit(currentValue, key, allowDecimal, max);
  }
  if (key === '.') {
    return appendCheckoutPadDigit(currentValue, '.', allowDecimal, max);
  }
  if (key === 'Backspace') {
    return currentValue.slice(0, -1);
  }
  if (key === 'Delete') {
    return '';
  }
  return null;
}

export function getCardReferenceSlotClasses({
  isActive,
  isMissingRequired,
}: {
  isActive: boolean;
  isMissingRequired: boolean;
}) {
  if (!isActive) {
    return 'border-border/50 bg-muted/25 text-muted-foreground/70 dark:border-white/8 dark:bg-muted/15';
  }
  if (isMissingRequired) {
    return 'border-amber-500/60 bg-amber-500/8 text-foreground shadow-2xs ring-2 ring-amber-500/15 dark:border-amber-400/50 dark:bg-amber-500/10';
  }
  return 'border-brand/50 bg-card text-foreground shadow-2xs focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20 dark:border-brand/55 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]';
}
