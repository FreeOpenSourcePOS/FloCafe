'use client';

import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  allowCurrencyDecimalKey,
  type CurrencyAmountTarget,
  type CurrencyDiscountType,
} from '@/lib/currency-input';

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

function clampValue(value: string, max?: number) {
  if (max == null || value === '' || value === '.') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric > max ? String(max) : value;
}

function appendDigit(value: string, digit: string, allowDecimal: boolean, max?: number) {
  if (digit === '.') {
    if (!allowDecimal || value.includes('.')) return value;
    return value === '' ? '0.' : `${value}.`;
  }
  const next = value === '0' ? digit : `${value}${digit}`;
  return clampValue(next, max);
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

  return (
    <div
      className={cn(
        fillHeight ? 'grid h-full grid-cols-4 grid-rows-4 gap-2' : 'grid grid-cols-4 gap-2',
        className,
      )}
      aria-label={ariaLabel}
    >
      {keys.map((key, index) => {
        const keyClass = cn(
          'touch-target rounded-lg border border-border bg-card text-lg font-bold tabular-nums text-foreground transition-colors active:bg-muted',
          fillHeight && 'h-full min-h-11',
        );
        if (key === 'backspace')
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(value.slice(0, -1))}
              className={keyClass}
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
              className={cn(keyClass, 'gap-1 text-sm')}
            >
              {clearLabel}
            </button>
          );
        if (key === 'exact')
          return quickValues[0] ? (
            <button
              key={key}
              type="button"
              onClick={() => onChange(clampValue(quickValues[0].value, max))}
              className={cn(keyClass, 'row-span-2 px-2 text-sm')}
            >
              {quickValues[0].label}
            </button>
          ) : (
            <span key={key} className="row-span-2" aria-hidden="true" />
          );
        return key ? (
          <button
            key={key}
            type="button"
            onClick={() => onChange(appendDigit(value, key, allowDecimal, max))}
            className={keyClass}
          >
            {key}
          </button>
        ) : (
          <span key={`blank-${index}`} aria-hidden="true" />
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
