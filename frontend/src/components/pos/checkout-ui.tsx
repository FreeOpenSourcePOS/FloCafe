import React from 'react';
import { cn } from '@/lib/utils';

export const CHECKOUT_PRIMARY_CTA_CLASS =
  'bg-brand text-white shadow-xs hover:bg-brand-hover active:bg-brand-hover disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100';

export function CheckoutTagIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3.5 shrink-0', className)}
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

export function CheckoutUserIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3 shrink-0', className)}
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function CheckoutReadyIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3.5 shrink-0', className)}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function CheckoutShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3.5 shrink-0', className)}
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

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
      className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}
    >
      {chips.map((chip) => {
        const variant = chip.variant ?? 'neutral';
        return (
          <span
            key={chip.key}
            className={cn(
              'inline-flex h-5 max-w-48 items-center gap-1 rounded-md border px-2 text-[11px] font-medium leading-none',
              variant === 'brand' &&
                'border-brand/25 bg-brand-light text-brand dark:border-indigo-400/35 dark:bg-[var(--color-brand-light)] dark:text-indigo-300',
              variant === 'customer' &&
                'border-border/80 bg-card text-foreground shadow-2xs dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
              variant === 'neutral' &&
                'border-border/75 bg-muted/50 text-muted-foreground dark:border-white/10 dark:bg-muted/30',
            )}
          >
            {variant === 'customer' ? <CheckoutUserIcon className="text-muted-foreground" /> : null}
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
  isInvalid = false,
  disabled = false,
}: {
  isFocused: boolean;
  isAllocated: boolean;
  isInvalid?: boolean;
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
      inputBoxClass: isInvalid
        ? 'border-destructive bg-destructive/5 ring-2 ring-destructive/20'
        : 'border-brand bg-brand-light/35 ring-2 ring-brand/20 dark:border-indigo-400/70 dark:bg-[var(--color-brand-light)] dark:ring-indigo-400/25',
      currencyClass: 'text-brand font-semibold dark:text-indigo-300',
      inputClass: 'text-foreground font-bold',
    };
  }

  if (isAllocated) {
    return {
      buttonClass:
        'border-brand/40 bg-brand-light/75 text-brand hover:bg-brand-light dark:border-indigo-400/40 dark:bg-[var(--color-brand-light)] dark:text-indigo-300 dark:hover:bg-indigo-500/25',
      inputBoxClass: isInvalid
        ? 'border-destructive bg-destructive/5'
        : 'border-brand/40 bg-card shadow-2xs dark:border-indigo-400/40 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
      currencyClass: 'text-brand/80 font-medium dark:text-indigo-300/80',
      inputClass: 'text-foreground font-semibold',
    };
  }

  return {
    buttonClass:
      'border-border bg-card text-foreground shadow-2xs hover:border-brand/30 hover:bg-muted/55 dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
    inputBoxClass: isInvalid
      ? 'border-destructive bg-destructive/5'
      : 'border-border bg-card shadow-2xs hover:border-brand/25 dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
    currencyClass: 'text-muted-foreground font-medium',
    inputClass: 'text-foreground font-medium placeholder:text-muted-foreground/55',
  };
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
