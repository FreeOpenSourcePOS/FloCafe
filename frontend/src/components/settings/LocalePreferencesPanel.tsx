'use client';

import { useI18n } from '@/hooks/useI18n';
import type { CountryLocaleOptions, CurrencyDisplay, DigitMode, CalendarMode } from '@/lib/countries';

interface Props {
  options?: CountryLocaleOptions;
  currencyDisplay: CurrencyDisplay;
  digits: DigitMode;
  calendar: CalendarMode;
  isAdmin: boolean;
  onChange: (patch: { currencyDisplay?: CurrencyDisplay; digits?: DigitMode; calendar?: CalendarMode }) => void;
}

// Option labels keyed by value. The panel itself is region-agnostic: which
// controls (and which options within them) are rendered is driven entirely by
// the country profile's `localeOptions`, so a region without locale options
// never sees this panel.
const CURRENCY_DISPLAY_LABELS: Record<CurrencyDisplay, string> = {
  rial: 'settings.iranCurrencyDisplayRial',
  toman: 'settings.iranCurrencyDisplayToman',
  toman_short: 'settings.iranCurrencyDisplayTomanShort',
};

const DIGIT_LABELS: Record<DigitMode, string> = {
  locale: 'settings.iranNumberDigitsLocale',
  latin: 'settings.iranNumberDigitsLatin',
};

const CALENDAR_LABELS: Record<CalendarMode, string> = {
  locale: 'settings.iranCalendarLocale',
  persian: 'settings.iranCalendarPersian',
  gregorian: 'settings.iranCalendarGregorian',
};

export function LocalePreferencesPanel({ options, currencyDisplay, digits, calendar, isAdmin, onChange }: Props) {
  const { t } = useI18n();

  const hasAny = Boolean(
    options?.currencyDisplay?.length || options?.digits?.length || options?.calendar?.length,
  );
  if (!hasAny) return null;

  return (
    <div className="md:col-span-2 space-y-4 rounded-lg border border-gray-100 bg-gray-50/60 p-4">
      <p className="text-sm font-medium text-gray-700">{t('settings.iranLocaleTitle')}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {options?.currencyDisplay?.length ? (
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('settings.iranCurrencyDisplay')}</label>
            {isAdmin ? (
              <select
                value={currencyDisplay}
                onChange={(e) => onChange({ currencyDisplay: e.target.value as CurrencyDisplay })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
              >
                {options!.currencyDisplay!.map((mode) => (
                  <option key={mode} value={mode}>{t(CURRENCY_DISPLAY_LABELS[mode])}</option>
                ))}
              </select>
            ) : (
              <p className="font-medium text-gray-900">{t(CURRENCY_DISPLAY_LABELS[currencyDisplay])}</p>
            )}
          </div>
        ) : null}

        {options?.digits?.length ? (
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('settings.iranNumberDigits')}</label>
            {isAdmin ? (
              <select
                value={digits}
                onChange={(e) => onChange({ digits: e.target.value as DigitMode })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
              >
                {options!.digits!.map((mode) => (
                  <option key={mode} value={mode}>{t(DIGIT_LABELS[mode])}</option>
                ))}
              </select>
            ) : (
              <p className="font-medium text-gray-900">{t(DIGIT_LABELS[digits])}</p>
            )}
          </div>
        ) : null}

        {options?.calendar?.length ? (
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('settings.iranCalendar')}</label>
            {isAdmin ? (
              <select
                value={calendar}
                onChange={(e) => onChange({ calendar: e.target.value as CalendarMode })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
              >
                {options!.calendar!.map((mode) => (
                  <option key={mode} value={mode}>{t(CALENDAR_LABELS[mode])}</option>
                ))}
              </select>
            ) : (
              <p className="font-medium text-gray-900">{t(CALENDAR_LABELS[calendar])}</p>
            )}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-gray-400">{t('settings.iranLocaleHint')}</p>
    </div>
  );
}
