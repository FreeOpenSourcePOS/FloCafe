'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  formatAmountForDisplay,
  groupAmountForDisplay,
  parseAmountInput,
  sanitizeAmountKeystrokes,
  type AmountFormat,
} from '@/lib/currency-input';

type CurrencyAmountInputProps = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & {
  /** Plain numeric value in the store's currency (not display-formatted). '' clears the field. */
  value: number | '';
  onValueChange: (value: number | '') => void;
  /** The store's regional snapshot separators — never a hardcoded '.'/','. */
  format: AmountFormat;
};

/**
 * A price input that groups digits with the store's own separators as
 * typed, and blocks decimal entry entirely when the currency has no
 * fraction digits (e.g. COP, JPY). docs/regional-snapshot.md, "Currency
 * input and display path".
 */
export default function CurrencyAmountInput({ value, onValueChange, format, ...rest }: CurrencyAmountInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastEmitted = useRef<number | ''>(value);
  const formatKey = `${format.decimalSeparator}|${format.groupSeparator}|${format.currencyFractionDigits}`;
  const lastFormatKey = useRef(formatKey);
  const [display, setDisplay] = useState(() => (value === '' ? '' : formatAmountForDisplay(value, format)));

  useEffect(() => {
    // Re-derive the display from the plain numeric value whenever it changes
    // externally, or when the store's regional format itself changes (e.g.
    // the tenant snapshot finishes loading after this input mounts) — but
    // not on every keystroke, or we'd fight the user's own typing.
    if (value === lastEmitted.current && formatKey === lastFormatKey.current) return;
    lastEmitted.current = value;
    lastFormatKey.current = formatKey;
    setDisplay(value === '' ? '' : formatAmountForDisplay(value, format));
    // formatKey is a value-equal proxy for format's three fields, so it alone is the correct dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, formatKey]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    const cursorFromEnd = el.value.length - (el.selectionStart ?? el.value.length);
    const sanitized = sanitizeAmountKeystrokes(el.value, format);
    const grouped = groupAmountForDisplay(sanitized, format);
    setDisplay(grouped);

    const parsed = parseAmountInput(sanitized, format);
    lastEmitted.current = parsed ?? '';
    onValueChange(parsed ?? '');

    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      const pos = Math.max(0, grouped.length - cursorFromEnd);
      inputRef.current.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (format.currencyFractionDigits === 0 && e.key === format.decimalSeparator) {
      e.preventDefault();
    }
    rest.onKeyDown?.(e);
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={display}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}
