'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, ArrowRight, Check, Cloud, Database, KeyRound, Search, Sparkles, UtensilsCrossed, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { COUNTRIES, getCountryByCode, countryName, type Country } from '@/lib/countries';
import { useTranslations, type AppConfig } from 'use-intl';
import { LANGUAGES, getBrowserLanguage, type Language } from '@/lib/i18n';

type SetupProfile = 'empty' | 'express' | 'demo';
type ServiceModel = 'qsr' | 'finedine';

const SETUP_PROFILES: Array<{ value: SetupProfile; badge?: 'express' | null }> = [
  { value: 'empty' },
  { value: 'express', badge: 'express' },
  { value: 'demo' },
];

const SERVICE_MODELS: Array<{ value: ServiceModel }> = [
  { value: 'qsr' },
  { value: 'finedine' },
];

// Exhaustively typed leaf-key maps for the setup profile / service model
// cards (use-intl resolves leaf keys within the namespace scope — no
// template-literal dynamic key construction).
type SetupKey = keyof AppConfig['Messages']['setup'];

const SETUP_PROFILE_KEYS = {
  empty: { label: 'emptyLabel', desc: 'emptyDesc', details: 'emptyDetails' },
  express: { label: 'expressLabel', desc: 'expressDesc', details: 'expressDetails' },
  demo: { label: 'demoLabel', desc: 'demoDesc', details: 'demoDetails' },
} as const satisfies Record<SetupProfile, { label: SetupKey; desc: SetupKey; details: SetupKey }>;

const SERVICE_MODEL_KEYS = {
  qsr: { label: 'qsrLabel', desc: 'qsrDesc', details: 'qsrDetails' },
  finedine: { label: 'finedineLabel', desc: 'finedineDesc', details: 'finedineDetails' },
} as const satisfies Record<ServiceModel, { label: SetupKey; desc: SetupKey; details: SetupKey }>;

// Registry-derived selectable languages (derived from LANGUAGES registry where selectable: true).
const SELECTABLE_LANGUAGES: Language[] = (Object.keys(LANGUAGES) as Language[]).filter(
  (lang) => LANGUAGES[lang].selectable,
);

// Mirrors main/services/cloud-sync.ts DEFAULT_CLOUD_SERVER_URL — kept in sync
// manually since the frontend can't import backend TS modules directly.
const DEFAULT_CLOUD_SERVER_URL = 'https://blue.flopos.com/';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUSPECT_EMAIL_TLDS = new Set(['example', 'invalid', 'lcaol', 'local', 'localhost', 'test']);

function isValidOwnerEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

function hasSuspectEmailDomain(email: string): boolean {
  if (!isValidOwnerEmail(email)) return false;
  const domain = email.split('@').pop()?.toLowerCase() || '';
  const labels = domain.split('.');
  const tld = labels[labels.length - 1] || '';
  return SUSPECT_EMAIL_TLDS.has(tld);
}

export default function SetupPage() {
  const { logout } = useAuthStore();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showMasterPin, setShowMasterPin] = useState(false);
  const [showConfirmMasterPin, setShowConfirmMasterPin] = useState(false);
  const [profile, setProfile] = useState<SetupProfile>('express');
  const [serviceModel, setServiceModel] = useState<ServiceModel>('qsr');
  // The wizard's language follows the shared store so the atomic provider
  // (and therefore useTranslations below) renders the chosen language
  // immediately — the #375 manual loadedLanguage gate is no longer needed.
  const language = usePosSettingsStore((s) => s.language);
  const setStoreLanguage = usePosSettingsStore((s) => s.setLanguage);
  const [browserLanguage] = useState<Language>(() => getBrowserLanguage());
  const [country, setCountry] = useState<string>('IN');
  const [countryQuery, setCountryQuery] = useState<string>('');
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    business_name: '',
  });
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productUpdates, setProductUpdates] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const passwordsEntered = form.password.length > 0 && form.confirmPassword.length > 0;
  const passwordsMatch = !passwordsEntered || form.password === form.confirmPassword;
  const ownerEmail = form.email.trim().toLowerCase();
  const ownerEmailEntered = ownerEmail.length > 0;
  const ownerEmailInvalid = ownerEmailEntered && !isValidOwnerEmail(ownerEmail);
  const ownerEmailWarning = ownerEmailEntered && !ownerEmailInvalid && hasSuspectEmailDomain(ownerEmail);

  const [masterPinAvailable, setMasterPinAvailable] = useState<boolean | null>(null);
  const [masterPin, setMasterPin] = useState('');
  const [masterPinConfirm, setMasterPinConfirm] = useState('');
  const masterPinValid = /^\d{4}$/.test(masterPin) && masterPin === masterPinConfirm;

  const cloudEnabled = true;
  const [cloudServerUrl, setCloudServerUrl] = useState(DEFAULT_CLOUD_SERVER_URL);

  const isPasswordValid = (password: string) => {
    if (!password || password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
  };
  const passwordMeetsRequirements = form.password.length === 0 || isPasswordValid(form.password);
  const t = useTranslations('setup');

  useEffect(() => {
    let mounted = true;
    api.get('/auth/setup/status')
      .then(({ data }) => {
        if (!mounted) return;
        setMasterPinAvailable(!!data.masterPinAvailable);
        // An owner already exists — /auth/setup/initialize is disabled server-side,
        // so bail out immediately instead of letting the user fill the whole wizard
        // and only find out at the final submit.
        if (!data.needsSetup) {
          toast.error(t('alreadyCompleted'));
          window.location.replace('/auth/login');
        }
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        console.warn('[Setup] Failed to check setup status:', err);
        setMasterPinAvailable(false);
      });
    return () => { mounted = false; };
    // One-time mount check — the toast uses the initial language selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCountry: Country | undefined = getCountryByCode(country);
  const q = countryQuery.trim().toLowerCase();
  const languageOptions: Language[] =
    browserLanguage === 'fa'
      ? ['fa', ...SELECTABLE_LANGUAGES]
      : SELECTABLE_LANGUAGES.includes(browserLanguage)
        ? [browserLanguage, ...SELECTABLE_LANGUAGES.filter((l) => l !== browserLanguage)]
        : SELECTABLE_LANGUAGES;
  const filteredCountries = COUNTRIES.filter((c) => {
    if (!q) return true;
    return (
      countryName(c.code).toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.currency.toLowerCase().includes(q) ||
      (c.locale ?? '').toLowerCase().includes(q)
    );
  });

  const completeSetup = () => {
    usePosSettingsStore.getState().setLanguage(language);
    // Persist language server-side so the standalone KDS inherits it.
    api.put(`/settings/language`, { value: language }).catch((err: unknown) => {
      console.warn('[Setup] Failed to persist language setting:', err);
    });
    logout();
    toast.success(t('completeSetupSuccess'));
    window.location.replace('/auth/login');
  };

  const validateOwner = () => {
    if (!form.name.trim() || !form.email.trim() || !form.password) {
      toast.error(t('errorNameRequired'));
      return false;
    }
    if (!isValidOwnerEmail(form.email.trim())) {
      toast.error(t('errorInvalidEmail'));
      return false;
    }
    if (!isPasswordValid(form.password)) {
      toast.error(t('errorPasswordRequirementsNotMet'));
      return false;
    }
    if (form.password !== form.confirmPassword) {
      toast.error(t('errorPasswordMismatch'));
      return false;
    }
    if (!termsAccepted) {
      toast.error(t('errorTermsRequired'));
      return false;
    }
    return true;
  };

  const handleOwnerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateOwner()) setStep(4);
  };

  const handleCompleteSetup = async () => {
    if (loading) return;
    if (!validateOwner()) {
      setStep(3);
      return;
    }
    if (masterPinAvailable && !masterPinValid) {
      toast.error(t('masterPinRequired'));
      setStep(2);
      return;
    }

    if (cloudEnabled && cloudServerUrl.trim()) {
      try {
        const parsed = new URL(cloudServerUrl.trim());
        const localHttp = parsed.protocol === 'http:'
          && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !localHttp) {
          toast.error(t('cloudUrlHttpsRequired'));
          setStep(5);
          return;
        }
      } catch {
        toast.error(t('cloudUrlInvalid'));
        setStep(5);
        return;
      }
    }

    setLoading(true);
    try {
      const countryProfile = selectedCountry;
      const countryCode = countryProfile?.code || country;
      const countryPayload = {
        country: countryCode,
        currency: countryProfile?.currency,
        timezone: countryProfile?.timezone,
        language,
      };

      await api.post('/auth/setup/initialize', {
        name: form.name,
        email: form.email,
        password: form.password,
        business_type: 'restaurant',
        business_name: form.business_name || undefined,
        setup_profile: profile,
        service_model: serviceModel,
        terms_accepted: termsAccepted,
        master_pin: masterPinAvailable ? masterPin : undefined,
        cloud_sync_enabled: true,
        cloud_server_url: cloudServerUrl.trim() || DEFAULT_CLOUD_SERVER_URL,
        email_product_updates: productUpdates,
        email_marketing: marketing,
        ...countryPayload,
      });
      completeSetup();
    } catch {
      toast.error(t('errorGeneric'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Flo" width={80} height={52} className="mx-auto mb-4" />
          <h1 className="text-3xl font-bold">{t('welcome')}</h1>
          <p className="text-muted-foreground mt-2">{t('tagline')}</p>
        </div>

        <div className="flex justify-center gap-2 mb-8">
          {[1, 2, 3, 4, 5, 6].map((s) => (
            <div
              key={s}
              className={`w-3 h-3 rounded-full transition-colors ${
                s === step ? 'bg-primary' : s < step ? 'bg-primary/50' : 'bg-muted'
              }`}
            />
          ))}
        </div>

        <Card>
          <CardContent className="pt-6">
            {step === 1 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('chooseLanguage')}</h2>
                  <p className="text-muted-foreground text-sm">
                    {t('chooseLanguageHint')}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {languageOptions.map((option) => {
                    const selected = language === option;
                    const label = option === 'es' ? t('languageSpanish') : option === 'pt' ? t('languagePortuguese') : option === 'fa' ? t('languagePersian') : t('languageEnglish');
                    return (
                      <button
                        key={option}
                        onClick={() => setStoreLanguage(option)}
                        className={`p-4 rounded-xl border-2 text-start transition-all ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-semibold">{label}</div>
                            <div className="text-xs text-muted-foreground mt-1">{option.toUpperCase()}</div>
                          </div>
                          {selected && <Check className="w-5 h-5 text-primary shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-3">
                  <div>
                    <h3 className="text-sm font-medium">{t('chooseCountry')}</h3>
                    <p className="text-muted-foreground text-sm mt-1">{t('chooseCountryHint')}</p>
                  </div>

                  <div className="relative">
                    <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <Input
                      value={countryQuery}
                      onChange={(e) => setCountryQuery(e.target.value)}
                      placeholder={t('searchPlaceholder')}
                      className="ps-9"
                    />
                  </div>
                </div>

                <div className="grid gap-2 max-h-72 overflow-y-auto">
                  {filteredCountries.map((c) => {
                    const selected = country === c.code;
                    return (
                      <button
                        key={c.code}
                        onClick={() => setCountry(c.code)}
                        className={`p-3 rounded-xl border-2 text-start transition-all flex items-center justify-between ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div>
                          <div className="font-semibold">{countryName(c.code)}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.currency} · {c.taxIdLabel || t('noTaxId')} · {c.locale}
                          </div>
                        </div>
                        {selected && <Check className="w-5 h-5 text-primary" />}
                      </button>
                    );
                  })}
                  {q && filteredCountries.length === 0 && (
                    <p className="text-center text-gray-500 py-6 text-sm">{t('noMatches', { query: countryQuery })}</p>
                  )}
                </div>

                <Button onClick={() => setStep(2)} className="w-full" size="lg">
                  {t('continue')} <ArrowRight className="w-4 h-4 ms-2 rtl-flip" />
                </Button>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 rtl-flip" /> {t('back')}
                </button>

                <div className="text-center">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <KeyRound className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">{t('setMasterPinTitle')}</h2>
                  <p className="text-muted-foreground text-sm">
                    {t('setMasterPinDescription')}
                  </p>
                  <p className="text-muted-foreground text-xs mt-2 bg-muted rounded-lg p-3">
                    {t('masterPinRecoveryNote')}
                  </p>
                </div>

                {masterPinAvailable === false ? (
                  <p className="text-sm text-center text-muted-foreground bg-muted rounded-lg p-4">
                    {t('masterPinNotAvailable')}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="master-pin">{t('pinLabel')}</Label>
                      <div className="relative">
                        <Input
                          id="master-pin"
                          type={showMasterPin ? "text" : "password"}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={masterPin}
                          onChange={(e) => setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="text-center text-lg tracking-[0.5em] pe-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowMasterPin(!showMasterPin)}
                          className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showMasterPin ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="master-pin-confirm">{t('confirmPinLabel')}</Label>
                      <div className="relative">
                        <Input
                          id="master-pin-confirm"
                          type={showConfirmMasterPin ? "text" : "password"}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={masterPinConfirm}
                          onChange={(e) => setMasterPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="text-center text-lg tracking-[0.5em] pe-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmMasterPin(!showConfirmMasterPin)}
                          className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showConfirmMasterPin ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <Button
                  onClick={() => setStep(3)}
                  disabled={masterPinAvailable === true && !masterPinValid}
                  className="w-full"
                  size="lg"
                >
                  {t('continue')} <ArrowRight className="w-4 h-4 ms-2 rtl-flip" />
                </Button>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(2)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 rtl-flip" /> {t('back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('createOwner')}</h2>
                  <p className="text-muted-foreground text-sm">{t('ownerSubtitle')}</p>
                </div>

                <form onSubmit={handleOwnerSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">{t('ownerName')}</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder={t('ownerNamePlaceholder')}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('ownerEmail')}</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder={t('ownerEmailPlaceholder')}
                      aria-invalid={ownerEmailInvalid}
                      dir="ltr"
                      required
                    />
                    {ownerEmailInvalid && (
                      <p className="text-xs font-medium text-red-600">
                        {t('errorInvalidEmail')}
                      </p>
                    )}
                    {ownerEmailWarning && (
                      <p className="text-xs font-medium text-orange-600">
                        {t('ownerEmailDomainWarning')}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="password">{t('password')}</Label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          autoComplete="new-password"
                          value={form.password}
                          onChange={(e) => setForm({ ...form, password: e.target.value })}
                          placeholder={t('passwordPlaceholder')}
                          className="pe-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirmPassword">{t('confirmPassword')}</Label>
                      <div className="relative">
                        <Input
                          id="confirmPassword"
                          type={showConfirmPassword ? "text" : "password"}
                          autoComplete="new-password"
                          value={form.confirmPassword}
                          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                          placeholder={t('confirmPasswordPlaceholder')}
                          className="pe-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  </div>
                  {!passwordMeetsRequirements && (
                    <p className="text-xs font-medium text-red-600">
                      Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.
                    </p>
                  )}
                  {passwordsEntered && (
                    <p className={`text-xs font-medium ${passwordsMatch ? 'text-green-600' : 'text-red-600'}`}>
                      {passwordsMatch ? t('passwordsMatch') : t('passwordsMismatch')}
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="business_name">{t('businessName')}</Label>
                    <Input
                      id="business_name"
                      value={form.business_name}
                      onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                      placeholder={t('businessNamePlaceholder')}
                    />
                  </div>

                  <label className="flex items-start gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      onChange={(e) => setTermsAccepted(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300"
                      required
                    />
                    <span>
                      {t('termsIntro')}{' '}
                      <a href="https://flopos.com/terms" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        {t('terms')}
                      </a>
                      ,{' '}
                      <a href="https://flopos.com/privacy" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        {t('privacy')}
                      </a>
                      , and{' '}
                      <a href="https://flopos.com/disclaimer" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        {t('disclaimer')}
                      </a>
                      .
                    </span>
                  </label>

                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">{t('anonymousDataTitle')}</p>
                    <p className="mt-1">{t('anonymousDataDescription')}</p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-primary">{t('anonymousDataDetails')}</summary>
                      <p className="mt-1">{t('anonymousDataFields')}</p>
                    </details>
                  </div>

                  <div className="space-y-3 rounded-lg border border-border px-3 py-3 text-sm">
                    <p className="font-medium text-foreground">Email communication</p>
                    <p className="text-muted-foreground">We will send a welcome email immediately so you can verify this address. Essential account, service, and security notices are not promotional and cannot be disabled here.</p>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={productUpdates} onChange={(e) => setProductUpdates(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                      <span>Receive product updates and release notes (optional)</span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
                      <span>Receive marketing messages, offers, and surveys (optional)</span>
                    </label>
                  </div>


                  <Button type="submit" disabled={ownerEmailInvalid || !passwordsMatch || !termsAccepted || !isPasswordValid(form.password)} className="w-full" size="lg">
                    {t('continue')} <ArrowRight className="w-4 h-4 ms-2 rtl-flip" />
                  </Button>
                </form>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(3)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 rtl-flip" /> {t('back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setupDataTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setupDataSubtitle')}</p>
                </div>

                <div className="grid gap-4">
                  {SETUP_PROFILES.map((item) => {
                    const selected = profile === item.value;
                    const Icon = item.value === 'demo' ? Database : item.value === 'express' ? Sparkles : UtensilsCrossed;
                    return (
                      <button
                        key={item.value}
                        onClick={() => setProfile(item.value)}
                        className={`p-4 rounded-xl border-2 text-start transition-all ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start gap-4">
                          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
                            <Icon className="w-5 h-5 text-primary" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">{t(SETUP_PROFILE_KEYS[item.value].label)}</span>
                              {item.badge && (
                                <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                                  {t('expressBadge')}
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground mt-1">{t(SETUP_PROFILE_KEYS[item.value].desc)}</div>
                            <div className="text-xs text-muted-foreground mt-2">{t(SETUP_PROFILE_KEYS[item.value].details)}</div>
                          </div>
                          {selected && <Check className="w-5 h-5 text-primary" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <Button onClick={() => setStep(5)} className="w-full" size="lg">
                  {t('continue')} <ArrowRight className="w-4 h-4 ms-2 rtl-flip" />
                </Button>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(4)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 rtl-flip" /> {t('back')}
                </button>

                <div className="text-center">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <Cloud className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">{t('cloudTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('cloudSubtitle')}</p>
                </div>

                <label className="flex items-start gap-3 cursor-pointer p-4 rounded-xl border-2 border-gray-200">
                  <input
                    type="checkbox"
                    checked={cloudEnabled}
                    disabled
                    className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  />
                  <span>
                    <span className="font-medium text-foreground">Cloud Services are enabled automatically</span>
                    <span className="block text-sm text-muted-foreground mt-1">FloCafe connects automatically so RevFlo pairing and support work without a manual approval step.</span>
                  </span>
                </label>

                {cloudEnabled && (
                  <div className="space-y-2">
                    <Label htmlFor="cloud-server-url">{t('cloudUrlLabel')}</Label>
                    <Input
                      id="cloud-server-url"
                      type="url"
                      value={cloudServerUrl}
                      onChange={(e) => setCloudServerUrl(e.target.value)}
                      placeholder={DEFAULT_CLOUD_SERVER_URL}
                      dir="ltr"
                    />
                    <p className="text-xs text-muted-foreground">{t('cloudUrlHint')}</p>
                  </div>
                )}

                <p className="text-xs text-muted-foreground bg-muted rounded-lg p-3">
                  {cloudEnabled ? t('cloudRecoveryNoteEnabled') : t('cloudRecoveryNoteDisabled')}
                </p>

                <Button onClick={() => setStep(6)} className="w-full" size="lg">
                  {t('continue')} <ArrowRight className="w-4 h-4 ms-2 rtl-flip" />
                </Button>
              </div>
            )}

            {step === 6 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(5)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 rtl-flip" /> {t('back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('flowTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('flowSubtitle')}</p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  {SERVICE_MODELS.map((item) => {
                    const selected = serviceModel === item.value;
                    return (
                      <button
                        key={item.value}
                        onClick={() => setServiceModel(item.value)}
                        className={`p-5 rounded-xl border-2 text-start transition-all ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-semibold text-lg">{t(SERVICE_MODEL_KEYS[item.value].label)}</div>
                            <div className="text-sm text-muted-foreground mt-1">{t(SERVICE_MODEL_KEYS[item.value].desc)}</div>
                            <div className="text-xs text-muted-foreground mt-3">{t(SERVICE_MODEL_KEYS[item.value].details)}</div>
                          </div>
                          {selected && <Check className="w-5 h-5 text-primary shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <Button onClick={handleCompleteSetup} disabled={loading} className="w-full" size="lg">
                  {loading ? t('completingSetup') : (
                    <>
                      {t('completeSetup')} <ArrowRight className="w-4 h-4 ms-2 rtl-flip" />
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
