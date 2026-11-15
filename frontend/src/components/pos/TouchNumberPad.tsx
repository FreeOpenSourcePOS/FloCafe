'use client';

import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  allowCurrencyDecimalKey,
  type CurrencyAmountTarget,
  type CurrencyDiscountType,
} from '@/lib/currency-input';
import { appendCheckoutPadDigit, clampCheckoutPadValue } from './checkout-ui';

interface QuickValue {
  label: string;
  value: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  clearLabel: string;
  backspaceLabel: string;
  allowDecimal?: boolean;
  max?: number;
  quickValues?: QuickValue[];
  className?: string;
  fillHeight?: boolean;
}

export default function TouchNumberPad({
  value,
  onChange,
  ariaLabel,
  clearLabel,
  backspaceLabel,
  allowDecimal = true,
  max,
  quickValues = [],
  className,
  fillHeight = false,
}: Props) {
  const keys = [
    '7',
    '8',
    '9',
    'backspace',
    '4',
    '5',
    '6',
    'clear',
    '1',
    '2',
    '3',
    'exact',
    '00',
    '0',
    allowDecimal ? '.' : '',
  ];

  const digitKeyClass = cn(
    'touch-target rounded-xl border border-border bg-card text-lg font-bold tabular-nums text-foreground shadow-2xs transition-[color,background-color,border-color,box-shadow,transform] select-none',
    'hover:border-brand/40 hover:bg-brand-light/15 active:scale-[0.985] active:border-brand/60 active:bg-brand-light/40',
    'dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:hover:border-indigo-400/45 dark:hover:bg-[var(--color-brand-light)] dark:active:bg-indigo-500/25',
    fillHeight && 'h-full min-h-11',
  );

  const utilityKeyClass = cn(
    'touch-target rounded-xl border border-border/80 bg-muted/70 text-muted-foreground font-semibold transition-[color,background-color,border-color,box-shadow,transform] select-none',
    'hover:border-border hover:bg-muted hover:text-foreground active:scale-[0.985]',
    'dark:border-white/10 dark:bg-muted/45 dark:hover:bg-muted/70',
    fillHeight && 'h-full min-h-11',
  );

  return (
    <div
      className={cn(
        fillHeight
          ? 'grid h-full grid-cols-4 grid-rows-4 gap-2 [@media(max-height:660px)]:gap-1'
          : 'grid grid-cols-4 gap-2',
        className,
      )}
      aria-label={ariaLabel}
    >
      {keys.map((key, index) => {
        if (key === 'backspace')
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(value.slice(0, -1))}
              className={utilityKeyClass}
              aria-label={backspaceLabel}
              title={backspaceLabel}
            >
              <Delete size={18} />
            </button>
          );
        if (key === 'clear')
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange('')}
              className={cn(utilityKeyClass, 'gap-1 text-xs sm:text-sm')}
            >
              {clearLabel}
            </button>
          );
        if (key === 'exact')
          return quickValues[0] ? (
            <button
              key={key}
              type="button"
              onClick={() => onChange(clampCheckoutPadValue(quickValues[0].value, max))}
              className={cn(
                'touch-target row-span-2 rounded-xl border border-brand/30 bg-brand-light/45 px-2 text-sm font-semibold text-brand transition-[color,background-color,border-color,box-shadow,transform] select-none',
                'hover:border-brand/50 hover:bg-brand-light/75 active:scale-[0.985]',
                'dark:border-indigo-400/35 dark:bg-[var(--color-brand-light)] dark:text-indigo-300 dark:hover:bg-indigo-500/25',
                fillHeight && 'h-full min-h-11',
              )}
            >
              {quickValues[0].label}
            </button>
          ) : (
            <span
              key={key}
              className="row-span-2 rounded-xl border border-border/40 bg-muted/20 dark:border-white/5 dark:bg-muted/10"
              aria-hidden="true"
            />
          );
        return key ? (
          <button
            key={key}
            type="button"
            onClick={() => onChange(appendCheckoutPadDigit(value, key, allowDecimal, max))}
            className={digitKeyClass}
          >
            {key}
          </button>
        ) : (
          <span
            key={`blank-${index}`}
            className="rounded-xl border border-border/40 bg-muted/20 dark:border-white/5 dark:bg-muted/10"
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}

interface CurrencyTouchNumberPadProps extends Omit<Props, 'allowDecimal'> {
  currencyMaxDecimals: number;
  amountTarget: CurrencyAmountTarget;
  discountType: CurrencyDiscountType;
}

export function CurrencyTouchNumberPad({
  currencyMaxDecimals,
  amountTarget,
  discountType,
  ...props
}: CurrencyTouchNumberPadProps) {
  return (
    <TouchNumberPad
      {...props}
      allowDecimal={allowCurrencyDecimalKey(currencyMaxDecimals, amountTarget, discountType)}
    />
  );
}
