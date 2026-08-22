'use client';

import { useMemo } from 'react';
import { listTimeZones, isValidTimeZone } from '@/lib/countries';

interface TimeZoneSelectProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * A searchable (browser type-ahead) IANA timezone `<select>` backed entirely
 * by `Intl.supportedValuesOf('timeZone')`. No bundled timezone data and no
 * network access — the list comes from the platform's native Intl runtime.
 *
 * If the currently persisted value is a legacy alias that Intl accepts but
 * `supportedValuesOf` does not enumerate (e.g. `US/Eastern`), it is appended
 * so it stays visible and selectable rather than silently dropping the value.
 */
export function TimeZoneSelect({
  value,
  onChange,
  id,
  className,
  placeholder,
  disabled,
  ariaLabel,
}: TimeZoneSelectProps) {
  const options = useMemo(() => {
    const zones = listTimeZones();
    if (value && isValidTimeZone(value) && !zones.includes(value)) {
      return [...zones, value].sort();
    }
    return zones;
  }, [value]);

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      disabled={disabled}
      aria-label={ariaLabel}
      dir="ltr"
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </select>
  );
}
