'use client';

import { Delete, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { allowCurrencyDecimalKey, type CurrencyAmountTarget, type CurrencyDiscountType } from '@/lib/currency-input';

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
}: Props) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDecimal ? '.' : '', '0'];

  return (
    <div className={cn('rounded-xl border border-border bg-muted/40 p-2', className)} aria-label={ariaLabel}>
      {quickValues.length > 0 && (
        <div className="mb-2 grid grid-cols-2 gap-2">
          {quickValues.map((quick) => (
            <button
              key={`${quick.label}-${quick.value}`}
              type="button"
              onClick={() => onChange(clampValue(quick.value, max))}
              className="touch-target rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground transition-colors active:bg-muted"
            >
              {quick.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {keys.map((key, index) => key ? (
          <button
            key={key}
            type="button"
            onClick={() => onChange(appendDigit(value, key, allowDecimal, max))}
            className="touch-target rounded-lg border border-border bg-card text-lg font-bold tabular-nums text-foreground transition-colors active:bg-muted"
          >
            {key}
          </button>
        ) : (
          <span key={`blank-${index}`} aria-hidden="true" />
        ))}
        <button
          type="button"
          onClick={() => onChange(value.slice(0, -1))}
          className="touch-target rounded-lg border border-border bg-card text-muted-foreground transition-colors active:bg-muted"
          aria-label={backspaceLabel}
          title={backspaceLabel}
        >
          <Delete size={18} />
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="touch-target col-span-2 gap-2 rounded-lg border border-border bg-card text-sm font-semibold text-muted-foreground transition-colors active:bg-muted"
        >
          <RotateCcw size={16} />
          {clearLabel}
        </button>
      </div>
    </div>
  );
}

interface CurrencyTouchNumberPadProps extends Omit<Props, 'allowDecimal'> {
  currencyMaxDecimals: number;
  amountTarget: CurrencyAmountTarget;
  discountType: CurrencyDiscountType;
}

export function CurrencyTouchNumberPad({ currencyMaxDecimals, amountTarget, discountType, ...props }: CurrencyTouchNumberPadProps) {
  return (
    <TouchNumberPad
      {...props}
      allowDecimal={allowCurrencyDecimalKey(currencyMaxDecimals, amountTarget, discountType)}
    />
  );
}
