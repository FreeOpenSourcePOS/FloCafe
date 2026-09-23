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
  const currencyNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const code of listSupportedCurrencyCodes()) {
      names.set(code, getCurrencyDisplayName(code, locale));
    }
    return names;
  }, [locale]);

  const groups = useMemo(() => {
    const recommended = String(recommendedCurrency || '').toUpperCase();
    const supported = new Set(currencyNames.keys());
    if (recommended) supported.add(recommended);
    if (/^[A-Z]{3}$/.test(value)) supported.add(value);
    const nameOf = (code: string) => currencyNames.get(code) || getCurrencyDisplayName(code, locale);

    const popular = POPULAR_CURRENCY_CODES.filter((code) => code !== recommended && supported.has(code));
    const excluded = new Set([recommended, ...popular]);
    const all = [...supported]
      .filter((code) => !excluded.has(code))
      .sort((left, right) => nameOf(left).localeCompare(nameOf(right), locale, { sensitivity: 'base' }));
    return { recommended, popular, all };
  }, [currencyNames, locale, recommendedCurrency, value]);

  const optionLabel = (code: string, suffix?: string) => {
    const displayName = currencyNames.get(code) || getCurrencyDisplayName(code, locale);
    const label = `${code} — ${displayName}`;
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
