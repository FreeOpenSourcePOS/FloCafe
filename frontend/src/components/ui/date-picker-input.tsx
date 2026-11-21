'use client';

import * as React from 'react';
import { CalendarDays, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export type TemporalInputType = 'date' | 'datetime-local' | 'month' | 'week' | 'time';

export interface DatePickerInputProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  type?: TemporalInputType;
  buttonClassName?: string;
  pickerAriaLabel?: string;
}

/** Opens Chromium's native date/time picker while preserving focus fallback. */
export function openTemporalPicker(input: HTMLInputElement | null): void {
  if (!input || input.disabled || input.readOnly) return;
  try {
    if (typeof input.showPicker === 'function') {
      input.showPicker();
      return;
    }
  } catch {
    // Older embedded Chromium builds or restricted contexts may reject showPicker.
  }
  input.focus();
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): (() => void) | void {
  if (typeof ref === 'function') {
    return ref(value) as (() => void) | void;
  } else if (ref && typeof ref === 'object') {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

export function DatePickerInput({
  type = 'date',
  className,
  buttonClassName,
  pickerAriaLabel,
  disabled,
  ref,
  ...props
}: DatePickerInputProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const refCleanupRef = React.useRef<(() => void) | null>(null);

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      const detach = () => {
        inputRef.current = null;
        const refCleanup = refCleanupRef.current;
        refCleanupRef.current = null;
        if (refCleanup) {
          refCleanup();
        } else {
          assignRef(ref, null);
        }
      };

      if (node === null) {
        detach();
        return;
      }

      inputRef.current = node;
      const cleanup = assignRef(ref, node);
      refCleanupRef.current = typeof cleanup === 'function' ? cleanup : null;
      return detach;
    },
    [ref],
  );

  const defaultAriaLabel =
    type === 'time'
      ? 'Open time picker'
      : type === 'month'
        ? 'Open month picker'
        : 'Open date picker';

  return (
    <div className="relative">
      <input
        ref={setRefs}
        type={type}
        disabled={disabled}
        className={cn(
          'appearance-none rounded-lg border border-border bg-card ps-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand',
          className,
          'pe-10 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:pointer-events-none [&::-webkit-calendar-picker-indicator]:opacity-0',
        )}
        {...props}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => openTemporalPicker(inputRef.current)}
        className={cn(
          'absolute inset-y-0 end-0 z-10 flex w-9 items-center justify-center rounded-e-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          buttonClassName,
        )}
        aria-label={pickerAriaLabel ?? defaultAriaLabel}
      >
        {type === 'time' ? <Clock size={16} /> : <CalendarDays size={16} />}
      </button>
    </div>
  );
}
