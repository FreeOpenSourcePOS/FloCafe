'use client';

import { useTranslations, type AppConfig } from 'use-intl';
import type { CountryLocaleOptions, CurrencyDisplay, DigitMode, CalendarMode } from '@/lib/countries';

interface Props {
  options?: CountryLocaleOptions;
  currencyDisplay: CurrencyDisplay;
  digits: DigitMode;
  calendar: CalendarMode;
  isAdmin: boolean;
  onChange: (patch: { currencyDisplay?: CurrencyDisplay; digits?: DigitMode; calendar?: CalendarMode }) => void;
}

type SettingsKey = keyof AppConfig['Messages']['settings'];

// Option labels keyed by value. The panel itself is region-agnostic: which
// controls (and which options within them) are rendered is driven entirely by
// the country profile's `localeOptions`, so a region without locale options
// never sees this panel.
const CURRENCY_DISPLAY_LABELS = {
  rial: 'iranCurrencyDisplayRial',
  toman: 'iranCurrencyDisplayToman',
  toman_short: 'iranCurrencyDisplayTomanShort',
} as const satisfies Record<CurrencyDisplay, SettingsKey>;

const DIGIT_LABELS = {
  locale: 'iranNumberDigitsLocale',
  latin: 'iranNumberDigitsLatin',
} as const satisfies Record<DigitMode, SettingsKey>;

const CALENDAR_LABELS = {
  locale: 'iranCalendarLocale',
  persian: 'iranCalendarPersian',
  gregorian: 'iranCalendarGregorian',
} as const satisfies Record<CalendarMode, SettingsKey>;

export function LocalePreferencesPanel({ options, currencyDisplay, digits, calendar, isAdmin, onChange }: Props) {
  const t = useTranslations('settings');

  const hasAny = Boolean(
    options?.currencyDisplay?.length || options?.digits?.length || options?.calendar?.length,
  );
  if (!hasAny) return null;

  return (
    <div className="md:col-span-2 space-y-4 rounded-lg border border-border bg-muted/60 p-4">
      <p className="text-sm font-medium text-foreground">{t('iranLocaleTitle')}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {options?.currencyDisplay?.length ? (
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('iranCurrencyDisplay')}</label>
            {isAdmin ? (
              <select
                value={currencyDisplay}
                onChange={(e) => onChange({ currencyDisplay: e.target.value as CurrencyDisplay })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                {options!.currencyDisplay!.map((mode) => (
                  <option key={mode} value={mode}>{t(CURRENCY_DISPLAY_LABELS[mode])}</option>
                ))}
              </select>
            ) : (
              <p className="font-medium text-foreground">{t(CURRENCY_DISPLAY_LABELS[currencyDisplay])}</p>
            )}
          </div>
        ) : null}

        {options?.digits?.length ? (
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('iranNumberDigits')}</label>
            {isAdmin ? (
              <select
                value={digits}
                onChange={(e) => onChange({ digits: e.target.value as DigitMode })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                {options!.digits!.map((mode) => (
                  <option key={mode} value={mode}>{t(DIGIT_LABELS[mode])}</option>
                ))}
              </select>
            ) : (
              <p className="font-medium text-foreground">{t(DIGIT_LABELS[digits])}</p>
            )}
          </div>
        ) : null}

        {options?.calendar?.length ? (
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('iranCalendar')}</label>
            {isAdmin ? (
              <select
                value={calendar}
                onChange={(e) => onChange({ calendar: e.target.value as CalendarMode })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                {options!.calendar!.map((mode) => (
                  <option key={mode} value={mode}>{t(CALENDAR_LABELS[mode])}</option>
                ))}
              </select>
            ) : (
              <p className="font-medium text-foreground">{t(CALENDAR_LABELS[calendar])}</p>
            )}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-gray-400">{t('iranLocaleHint')}</p>
    </div>
  );
}
