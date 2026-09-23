'use client';

import { useMemo } from 'react';
import { getCurrencyDisplayName, listSupportedCurrencyCodes, POPULAR_CURRENCY_CODES } from '@shared/currencies';

interface CurrencySelectProps {
  value: string;
  recommendedCurrency?: string;
  locale: string;
  onChange: (currency: string) => void;
  recommendedLabel: string;
  popularLabel: string;
  allLabel: string;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
}

export function CurrencySelect({
  value,
  recommendedCurrency,
  locale,
  onChange,
  recommendedLabel,
  popularLabel,
  allLabel,
  placeholder,
  className,
  id,
  ariaLabel,
}: CurrencySelectProps) {
  const groups = useMemo(() => {
    const recommended = String(recommendedCurrency || '').toUpperCase();
    const supported = new Set(listSupportedCurrencyCodes());
    if (recommended) supported.add(recommended);
    if (/^[A-Z]{3}$/.test(value)) supported.add(value);

    const popular = POPULAR_CURRENCY_CODES.filter((code) => code !== recommended && supported.has(code));
    const excluded = new Set([recommended, ...popular]);
    const all = [...supported]
      .filter((code) => !excluded.has(code))
      .sort((left, right) => {
        const leftName = getCurrencyDisplayName(left, locale);
        const rightName = getCurrencyDisplayName(right, locale);
        return leftName.localeCompare(rightName, locale, { sensitivity: 'base' });
      });
    return { recommended, popular, all };
  }, [locale, recommendedCurrency, value]);

  const optionLabel = (code: string, suffix?: string) => {
    const label = `${code} — ${getCurrencyDisplayName(code, locale)}`;
    return suffix ? `${label} (${suffix})` : label;
  };

  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={className}
      aria-label={ariaLabel}
      dir="ltr"
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {groups.recommended ? (
        <optgroup label={recommendedLabel}>
          <option value={groups.recommended}>{optionLabel(groups.recommended, recommendedLabel)}</option>
        </optgroup>
      ) : null}
      <optgroup label={popularLabel}>
        {groups.popular.map((code) => <option key={code} value={code}>{optionLabel(code)}</option>)}
      </optgroup>
      <optgroup label={allLabel}>
        {groups.all.map((code) => <option key={code} value={code}>{optionLabel(code)}</option>)}
      </optgroup>
    </select>
  );
}
