'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Building2, Hash, CreditCard, Lock } from 'lucide-react';
import { useTranslations, useLocale } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { Toggle } from '@/components/settings/Toggle';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { LocalePreferencesPanel } from '@/components/settings/LocalePreferencesPanel';
import { TimeZoneSelect } from '@/components/TimeZoneSelect';
import {
  COUNTRIES,
  getCountryByCode,
  getLocalizedCountryName,
  sortCountriesByLocalizedName,
  type CurrencyDisplay,
  type DigitMode,
  type CalendarMode,
} from '@/lib/countries';
import { dialCodeFor } from '@/lib/phone';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useAuthStore } from '@/store/auth';
import { LANGUAGES, TENANT_STATUS_LABEL_KEYS, type Language } from '@/lib/i18n';
import api from '@/lib/api';
import toast from 'react-hot-toast';

const SELECTABLE_LANGUAGES: Language[] = (Object.keys(LANGUAGES) as Language[]).filter(
  (lang) => LANGUAGES[lang].selectable,
);

const BUSINESS_DAY_START_OPTIONS = [
  { value: '00:00', label: '00:00 (12:00 AM)' },
  { value: '00:30', label: '00:30 (12:30 AM)' },
  { value: '01:00', label: '01:00 (1:00 AM)' },
  { value: '01:30', label: '01:30 (1:30 AM)' },
  { value: '02:00', label: '02:00 (2:00 AM)' },
  { value: '02:30', label: '02:30 (2:30 AM)' },
  { value: '03:00', label: '03:00 (3:00 AM)' },
  { value: '03:30', label: '03:30 (3:30 AM)' },
  { value: '04:00', label: '04:00 (4:00 AM)' },
  { value: '04:30', label: '04:30 (4:30 AM)' },
  { value: '05:00', label: '05:00 (5:00 AM)' },
  { value: '05:30', label: '05:30 (5:30 AM)' },
  { value: '06:00', label: '06:00 (6:00 AM)' },
  { value: '06:30', label: '06:30 (6:30 AM)' },
  { value: '07:00', label: '07:00 (7:00 AM)' },
  { value: '07:30', label: '07:30 (7:30 AM)' },
  { value: '08:00', label: '08:00 (8:00 AM)' },
  { value: '08:30', label: '08:30 (8:30 AM)' },
  { value: '09:00', label: '09:00 (9:00 AM)' },
  { value: '09:30', label: '09:30 (9:30 AM)' },
  { value: '10:00', label: '10:00 (10:00 AM)' },
  { value: '10:30', label: '10:30 (10:30 AM)' },
  { value: '11:00', label: '11:00 (11:00 AM)' },
  { value: '11:30', label: '11:30 (11:30 AM)' },
];

export type InvoiceResetPeriod = 'daily' | 'monthly' | 'financial_year' | 'never';

export interface BusinessForm {
  businessName: string;
  countryCode: string;
  timezone: string;
  businessDayStartTime: string;
  currency: string;
  currencyDisplay: CurrencyDisplay;
  numberDigits: DigitMode;
  calendar: CalendarMode;
  billingType: 'postpaid' | 'prepaid';
  tablesRequired: boolean;
  taxRegistered: boolean;
  taxRegistrationNumber: string;
  businessPhone: string;
  businessAddress: string;
  instagramHandle: string;
}

export interface OrderNumberForm {
  prefix: string;
  includeDate: boolean;
  resetDaily: boolean;
  invoicePrefix: string;
  invoiceIncludePeriod: boolean;
  invoiceResetPeriod: InvoiceResetPeriod;
  invoiceFinancialYearStartMonth: number;
  invoiceFinancialYearStartDay: number;
}

function invoicePreviewSegment(period: InvoiceResetPeriod, month: number, day: number): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  if (period === 'monthly') return `${yyyy}${mm}`;
  if (period === 'financial_year') {
    const startsThisYear = now.getMonth() + 1 > month || (now.getMonth() + 1 === month && now.getDate() >= day);
    const startYear = startsThisYear ? yyyy : yyyy - 1;
    return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  return `${yyyy}${mm}${dd}`;
}

function tenantStatusLabel(status: string | undefined, tCommon: (key: 'active' | 'inactive') => string): string {
  const key = (TENANT_STATUS_LABEL_KEYS as Record<string, 'active' | 'inactive' | undefined>)[status ?? ''];
  return key ? tCommon(key) : (status || '-');
}

export interface GeneralSettingsTabProps {
  isAdmin: boolean;
  form: BusinessForm;
  setForm: React.Dispatch<React.SetStateAction<BusinessForm>>;
  taxIdFormat: { pattern: string; description: string } | null;
  taxIdFormatCountryCode: string;
  orderNumberForm: OrderNumberForm;
  setOrderNumberForm: React.Dispatch<React.SetStateAction<OrderNumberForm>>;
  markHydrationTouched: (field: string) => void;
}

export function GeneralSettingsTab({
  isAdmin,
  form,
  setForm,
  taxIdFormat,
  taxIdFormatCountryCode,
  orderNumberForm,
  setOrderNumberForm,
  markHydrationTouched,
}: GeneralSettingsTabProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const { currentTenant } = useAuthStore();
  const language = usePosSettingsStore((state) => state.language);
  const setLanguage = usePosSettingsStore((state) => state.setLanguage);
  const languageRequestId = useRef(0);

  useEffect(() => () => {
    languageRequestId.current += 1;
  }, []);

  const sortedCountries = useMemo(() => sortCountriesByLocalizedName(COUNTRIES, locale), [locale]);

  const TAX_ID_WARNING_MAX_LENGTH = 24;
  const taxIdWarning = (() => {
    const value = form.taxRegistrationNumber.trim();
    if (!taxIdFormat || !value || form.countryCode !== taxIdFormatCountryCode) return null;
    if (value.length > TAX_ID_WARNING_MAX_LENGTH) return null;
    try {
      return new RegExp(taxIdFormat.pattern, 'i').test(value) ? null : taxIdFormat.description;
    } catch {
      return null;
    }
  })();

  return (
    <SettingsTabShell>
      {/* Store Details - editable for admin, readonly otherwise */}
      <div className="lg:col-span-2 bg-card rounded-xl border border-border p-6">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('storeDetails')}</h2>
          {!isAdmin && (
            <span className="ms-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Lock size={12} /> {t('adminOnly')}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('businessName')}</label>
            {isAdmin ? (
              <input
                type="text"
                value={form.businessName}
                onChange={(e) => {
                  markHydrationTouched('businessName');
                  setForm((p) => ({ ...p, businessName: e.target.value }));
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
            ) : (
              <p className="font-medium text-foreground">{form.businessName || currentTenant?.business_name}</p>
            )}
          </div>
          {/* Country, Timezone, Currency in single line with individual headings */}
          <div className="md:col-span-2 space-y-2">
            {/* Headings */}
            <div className="grid grid-cols-3 gap-2">
              <label className="text-sm text-muted-foreground">{t('country')}</label>
              <label className="text-sm text-muted-foreground">{t('timezone')}</label>
              <label className="text-sm text-muted-foreground">{t('currency')}</label>
            </div>

            {/* Input fields */}
            {isAdmin ? (
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={form.countryCode}
                  onChange={(e) => {
                    markHydrationTouched('countryCode');
                    markHydrationTouched('currency');
                    markHydrationTouched('timezone');
                    markHydrationTouched('currencyDisplay');
                    markHydrationTouched('numberDigits');
                    markHydrationTouched('calendar');
                    const country = COUNTRIES.find((c) => c.code === e.target.value);
                    setForm((p) => {
                      const previousCountry = getCountryByCode(p.countryCode);
                      const timezoneWasDefault = !previousCountry || p.timezone === previousCountry.timezone;
                      const options = country?.localeOptions;
                      const currencyDisplay =
                        options?.currencyDisplay?.includes(p.currencyDisplay) || p.currencyDisplay === 'rial'
                          ? p.currencyDisplay
                          : 'rial';
                      const numberDigits =
                        options?.digits?.includes(p.numberDigits) || p.numberDigits === 'locale'
                          ? p.numberDigits
                          : 'locale';
                      const calendar =
                        options?.calendar?.includes(p.calendar) || p.calendar === 'locale'
                          ? p.calendar
                          : 'locale';
                      return {
                        ...p,
                        countryCode: e.target.value,
                        currency: country?.currency || p.currency,
                        timezone: timezoneWasDefault ? country?.timezone || p.timezone : p.timezone,
                        currencyDisplay,
                        numberDigits,
                        calendar,
                      };
                    });
                  }}
                  aria-label={t('country')}
                  className="px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                >
                  <option value="">{t('selectCountry')}</option>
                  {sortedCountries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {getLocalizedCountryName(c.code, locale)}
                    </option>
                  ))}
                </select>
                <TimeZoneSelect
                  value={form.timezone}
                  onChange={(timezone) => {
                    markHydrationTouched('timezone');
                    setForm((p) => ({ ...p, timezone }));
                  }}
                  placeholder={t('selectTimezone')}
                  className="px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                  ariaLabel={t('timezone')}
                />
                <input
                  type="text"
                  value={form.currency}
                  onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
                  placeholder={t('currencyAutoFilled')}
                  className="px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-muted"
                  readOnly
                  dir="ltr"
                />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <p className="font-medium text-foreground">
                  {form.countryCode ? getLocalizedCountryName(form.countryCode, locale) : '-'}
                </p>
                <p className="font-medium text-foreground">
                  <Ltr>{form.timezone || '-'}</Ltr>
                </p>
                <p className="font-medium text-foreground">
                  <Ltr>{form.currency || '-'}</Ltr>
                </p>
              </div>
            )}
          </div>

          {/* Business Day Start Time */}
          <div className="md:col-span-2 space-y-1.5">
            <label htmlFor="business-day-start-time" className="text-sm text-muted-foreground">
              {t('businessDayStartTime')}
            </label>
            {isAdmin ? (
              <div className="max-w-xs">
                <select
                  id="business-day-start-time"
                  value={form.businessDayStartTime}
                  onChange={(e) => {
                    markHydrationTouched('businessDayStartTime');
                    setForm((p) => ({ ...p, businessDayStartTime: e.target.value }));
                  }}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                >
                  {BUSINESS_DAY_START_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.value === '00:00' ? `${opt.label} (${t('defaultMidnight')})` : opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="font-medium text-foreground">
                <Ltr>{form.businessDayStartTime || '00:00'}</Ltr>
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('businessDayStartTimeDesc')}</p>
          </div>

          <LocalePreferencesPanel
            options={getCountryByCode(form.countryCode)?.localeOptions}
            currencyDisplay={form.currencyDisplay}
            digits={form.numberDigits}
            calendar={form.calendar}
            isAdmin={isAdmin}
            onChange={(patch) => {
              if (patch.currencyDisplay !== undefined) markHydrationTouched('currencyDisplay');
              if (patch.digits !== undefined) markHydrationTouched('numberDigits');
              if (patch.calendar !== undefined) markHydrationTouched('calendar');
              setForm((p) => ({
                ...p,
                ...(patch.currencyDisplay !== undefined ? { currencyDisplay: patch.currencyDisplay } : {}),
                ...(patch.digits !== undefined ? { numberDigits: patch.digits } : {}),
                ...(patch.calendar !== undefined ? { calendar: patch.calendar } : {}),
              }));
            }}
          />
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('billingType')}</label>
            {isAdmin ? (
              <select
                value={form.billingType}
                onChange={(e) => {
                  markHydrationTouched('billingType');
                  setForm((p) => ({ ...p, billingType: e.target.value as 'postpaid' | 'prepaid' }));
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                <option value="postpaid">{t('billingTypePostpaid')}</option>
                <option value="prepaid">{t('billingTypePrepaid')}</option>
              </select>
            ) : (
              <p className="font-medium text-foreground capitalize">{form.billingType}</p>
            )}
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('tablesRequired')}</label>
            {isAdmin ? (
              <select
                value={form.tablesRequired ? 'yes' : 'no'}
                onChange={(e) => {
                  markHydrationTouched('tablesRequired');
                  setForm((p) => ({ ...p, tablesRequired: e.target.value === 'yes' }));
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                <option value="yes">{t('tablesRequiredYes')}</option>
                <option value="no">{t('tablesRequiredNo')}</option>
              </select>
            ) : (
              <p className="font-medium text-foreground">{form.tablesRequired ? t('yes') : t('no')}</p>
            )}
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('taxRegistered')}</label>
            {isAdmin ? (
              <select
                value={form.taxRegistered ? 'yes' : 'no'}
                onChange={(e) => {
                  markHydrationTouched('taxRegistered');
                  setForm((p) => ({ ...p, taxRegistered: e.target.value === 'yes' }));
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                <option value="yes">{t('yes')}</option>
                <option value="no">{t('no')}</option>
              </select>
            ) : (
              <p className="font-medium text-foreground">{form.taxRegistered ? t('yes') : t('no')}</p>
            )}
          </div>
          {form.taxRegistered ? (
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('taxIdLabel')}</label>
              {isAdmin ? (
                <>
                  <input
                    type="text"
                    value={form.taxRegistrationNumber}
                    onChange={(e) => {
                      markHydrationTouched('taxRegistrationNumber');
                      setForm((p) => ({ ...p, taxRegistrationNumber: e.target.value }));
                    }}
                    placeholder={t('taxIdPlaceholder')}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    dir="ltr"
                  />
                  {taxIdWarning ? (
                    <p className="mt-1 text-xs text-amber-600">
                      {t('taxIdFormatWarning', { country: form.countryCode, format: taxIdWarning })}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="font-medium text-foreground">
                  <Ltr>{form.taxRegistrationNumber || '-'}</Ltr>
                </p>
              )}
            </div>
          ) : (
            <div className="hidden md:block" />
          )}
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('phone')}</label>
            {isAdmin ? (
              <input
                type="text"
                value={form.businessPhone}
                onChange={(e) => {
                  markHydrationTouched('businessPhone');
                  setForm((p) => ({ ...p, businessPhone: e.target.value }));
                }}
                placeholder={t('phonePlaceholder', { dialCode: dialCodeFor(form.countryCode) || '+1' })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                dir="ltr"
              />
            ) : (
              <p className="font-medium text-foreground">
                <Ltr>{form.businessPhone || '-'}</Ltr>
              </p>
            )}
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm text-muted-foreground mb-1">{t('address')}</label>
            {isAdmin ? (
              <textarea
                value={form.businessAddress}
                onChange={(e) => {
                  markHydrationTouched('businessAddress');
                  setForm((p) => ({ ...p, businessAddress: e.target.value }));
                }}
                rows={2}
                placeholder={t('addressPlaceholder')}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none"
              />
            ) : (
              <p className="font-medium text-foreground">{form.businessAddress || '-'}</p>
            )}
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('instagramHandle')}</label>
            {isAdmin ? (
              <input
                type="text"
                value={form.instagramHandle}
                onChange={(e) => {
                  markHydrationTouched('instagramHandle');
                  setForm((p) => ({ ...p, instagramHandle: e.target.value }));
                }}
                placeholder={t('instagramPlaceholder')}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
            ) : (
              <p className="font-medium text-foreground">{form.instagramHandle || '-'}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">{t('instagramHint')}</p>
          </div>
        </div>
      </div>

      {/* Number Formats */}
      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center gap-2 mb-4">
          <Hash size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('orderNumberFormat')}</h2>
          {!isAdmin && (
            <span className="ms-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Lock size={12} /> {t('adminOnly')}
            </span>
          )}
        </div>

        <h3 className="text-sm font-semibold text-foreground mb-3">{t('orderNumbers')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('orderNumberPrefix')}</label>
            {isAdmin ? (
              <input
                type="text"
                value={orderNumberForm.prefix}
                onChange={(e) => {
                  markHydrationTouched('prefix');
                  setOrderNumberForm((p) => ({
                    ...p,
                    prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
                  }));
                }}
                placeholder="ORD"
                maxLength={12}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
            ) : (
              <p className="font-medium text-foreground">{orderNumberForm.prefix || '-'}</p>
            )}
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">{t('orderNumberPreview')}</label>
            <p className="font-mono font-medium text-foreground px-3 py-2 bg-muted rounded-lg border border-border">
              <Ltr>
                {[
                  orderNumberForm.prefix,
                  orderNumberForm.includeDate ? new Date().toISOString().slice(0, 10).replace(/-/g, '') : '',
                  '0001',
                ]
                  .filter(Boolean)
                  .join('-')}
              </Ltr>
            </p>
          </div>
        </div>

        <div className="mt-5 pt-5 border-t border-border space-y-3">
          <div className="flex items-center justify-between py-2">
            <div>
              <span className="text-sm text-foreground">{t('orderNumberIncludeDate')}</span>
              <p className="text-xs text-muted-foreground">{t('orderNumberIncludeDateHint')}</p>
            </div>
            <Toggle
              value={orderNumberForm.includeDate}
              label={t('orderNumberIncludeDate')}
              onChange={
                isAdmin
                  ? (v) => {
                      markHydrationTouched('includeDate');
                      setOrderNumberForm((p) => ({ ...p, includeDate: v }));
                    }
                  : () => {}
              }
            />
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <span className="text-sm text-foreground">{t('orderNumberResetDaily')}</span>
              <p className="text-xs text-muted-foreground">{t('orderNumberResetDailyHint')}</p>
            </div>
            <Toggle
              value={orderNumberForm.resetDaily}
              label={t('orderNumberResetDaily')}
              onChange={
                isAdmin
                  ? (v) => {
                      markHydrationTouched('resetDaily');
                      setOrderNumberForm((p) => ({ ...p, resetDaily: v }));
                    }
                  : () => {}
              }
            />
          </div>
        </div>

        <div className="mt-6 pt-5 border-t border-border">
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('invoiceNumbers')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('invoiceNumberPrefix')}</label>
              {isAdmin ? (
                <input
                  type="text"
                  value={orderNumberForm.invoicePrefix}
                  onChange={(e) => {
                    markHydrationTouched('invoicePrefix');
                    setOrderNumberForm((p) => ({
                      ...p,
                      invoicePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
                    }));
                  }}
                  placeholder="INV"
                  maxLength={12}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                />
              ) : (
                <p className="font-medium text-foreground">{orderNumberForm.invoicePrefix || '-'}</p>
              )}
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('invoiceNumberPreview')}</label>
              <p className="font-mono font-medium text-foreground px-3 py-2 bg-muted rounded-lg border border-border">
                <Ltr>
                  {[
                    orderNumberForm.invoicePrefix,
                    orderNumberForm.invoiceIncludePeriod
                      ? invoicePreviewSegment(
                          orderNumberForm.invoiceResetPeriod,
                          orderNumberForm.invoiceFinancialYearStartMonth,
                          orderNumberForm.invoiceFinancialYearStartDay
                        )
                      : '',
                    '0001',
                  ]
                    .filter(Boolean)
                    .join('-')}
                </Ltr>
              </p>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">{t('invoiceResetPeriod')}</label>
              {isAdmin ? (
                <select
                  value={orderNumberForm.invoiceResetPeriod}
                  onChange={(e) => {
                    markHydrationTouched('invoiceResetPeriod');
                    setOrderNumberForm((p) => ({
                      ...p,
                      invoiceResetPeriod: e.target.value as InvoiceResetPeriod,
                    }));
                  }}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                >
                  <option value="daily">{t('invoiceResetDaily')}</option>
                  <option value="monthly">{t('invoiceResetMonthly')}</option>
                  <option value="financial_year">{t('invoiceResetFinancialYear')}</option>
                  <option value="never">{t('invoiceResetNever')}</option>
                </select>
              ) : (
                <p className="font-medium text-foreground">{orderNumberForm.invoiceResetPeriod.replace('_', ' ')}</p>
              )}
            </div>
            {orderNumberForm.invoiceResetPeriod === 'financial_year' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    {t('financialYearStartMonth')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={orderNumberForm.invoiceFinancialYearStartMonth}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      markHydrationTouched('invoiceFinancialYearStartMonth');
                      setOrderNumberForm((p) => ({
                        ...p,
                        invoiceFinancialYearStartMonth: Number(e.target.value),
                      }));
                    }}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand disabled:bg-muted"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    {t('financialYearStartDay')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={orderNumberForm.invoiceFinancialYearStartDay}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      markHydrationTouched('invoiceFinancialYearStartDay');
                      setOrderNumberForm((p) => ({
                        ...p,
                        invoiceFinancialYearStartDay: Number(e.target.value),
                      }));
                    }}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand disabled:bg-muted"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-border">
            <div className="flex items-center justify-between py-2">
              <div>
                <span className="text-sm text-foreground">{t('invoiceNumberIncludePeriod')}</span>
                <p className="text-xs text-muted-foreground">{t('invoiceNumberIncludePeriodHint')}</p>
              </div>
              <Toggle
                value={orderNumberForm.invoiceIncludePeriod}
                label={t('invoiceNumberIncludePeriod')}
                onChange={
                  isAdmin
                    ? (v) => {
                        markHydrationTouched('invoiceIncludePeriod');
                        setOrderNumberForm((p) => ({ ...p, invoiceIncludePeriod: v }));
                      }
                    : () => {}
                }
              />
            </div>
          </div>
        </div>
      </div>

      {/* Subscription */}
      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center gap-2 mb-4">
          <CreditCard size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('subscription')}</h2>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-sm text-muted-foreground">{t('plan')}</p>
            <p className="font-medium text-foreground capitalize">{currentTenant?.plan}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('status')}</p>
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                currentTenant?.status === 'active'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {tenantStatusLabel(currentTenant?.status, tCommon)}
            </span>
          </div>
          <div>
            <p className="text-sm text-muted-foreground mb-1">{t('languages')}</p>
            <select
              value={language}
              onChange={(e) => {
                const lang = e.target.value as Language;
                const prev = usePosSettingsStore.getState().language;
                const requestId = ++languageRequestId.current;
                setLanguage(lang);
                api.put('/settings/business', { language: lang }).catch(() => {
                  if (requestId === languageRequestId.current && usePosSettingsStore.getState().language === lang) {
                    setLanguage(prev);
                    toast.error(t('saveFailed'));
                  }
                });
              }}
              className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
            >
              {SELECTABLE_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGES[lang].nativeName}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </SettingsTabShell>
  );
}
