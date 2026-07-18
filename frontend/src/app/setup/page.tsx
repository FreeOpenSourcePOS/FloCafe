'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, ArrowRight, Check, Database, KeyRound, Search, Sparkles, UtensilsCrossed, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { COUNTRIES, getCountryByCode, countryName, type Country } from '@/lib/countries';
import { getBrowserLanguage, t as translate, type Language } from '@/lib/i18n';

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
  const [language, setLanguage] = useState<Language>('en');
  const [browserLanguage, setBrowserLanguage] = useState<Language>('en');
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
  const passwordsEntered = form.password.length > 0 && form.confirmPassword.length > 0;
  const passwordsMatch = !passwordsEntered || form.password === form.confirmPassword;

  const [masterPinAvailable, setMasterPinAvailable] = useState<boolean | null>(null);
  const [masterPin, setMasterPin] = useState('');
  const [masterPinConfirm, setMasterPinConfirm] = useState('');
  const masterPinValid = /^\d{4}$/.test(masterPin) && masterPin === masterPinConfirm;

  const isPasswordValid = (password: string) => {
    if (!password || password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
  };
  const passwordMeetsRequirements = form.password.length === 0 || isPasswordValid(form.password);

  useEffect(() => {
    api.get('/auth/setup/status')
      .then(({ data }) => setMasterPinAvailable(!!data.masterPinAvailable))
      .catch(() => setMasterPinAvailable(false));
  }, []);

  useEffect(() => {
    const detectedLanguage = getBrowserLanguage();
    setBrowserLanguage(detectedLanguage);
    setLanguage(detectedLanguage);
  }, []);

  const selectedCountry: Country | undefined = getCountryByCode(country);
  const q = countryQuery.trim().toLowerCase();
  const languageOptions: Language[] = browserLanguage === 'es' ? ['es', 'en'] : ['en', 'es'];
  const filteredCountries = COUNTRIES.filter((c) => {
    if (!q) return true;
    return (
      countryName(c.code).toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.currency.toLowerCase().includes(q) ||
      (c.locale ?? '').toLowerCase().includes(q)
    );
  });

  const t = (key: string) => translate(key, language);

  const completeSetup = () => {
    usePosSettingsStore.getState().setLanguage(language);
    logout();
    toast.success(t('setup.completeSetupSuccess'));
    window.location.replace('/auth/login');
  };

  const validateOwner = () => {
    if (!form.name.trim() || !form.email.trim() || !form.password) {
      toast.error(t('setup.errorNameRequired'));
      return false;
    }
    if (!isPasswordValid(form.password)) {
      toast.error('Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.');
      return false;
    }
    if (form.password !== form.confirmPassword) {
      toast.error(t('setup.errorPasswordMismatch'));
      return false;
    }
    if (!termsAccepted) {
      toast.error(t('setup.errorTermsRequired'));
      return false;
    }
    return true;
  };

  const handleOwnerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateOwner()) setStep(4);
  };

  const handleCompleteSetup = async () => {
    if (!validateOwner()) {
      setStep(3);
      return;
    }
    if (masterPinAvailable && !masterPinValid) {
      toast.error(t('setup.masterPinRequired'));
      setStep(2);
      return;
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
        ...countryPayload,
      });
      completeSetup();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      toast.error(error.response?.data?.error || t('setup.errorGeneric'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Flo" width={80} height={52} className="mx-auto mb-4" />
          <h1 className="text-3xl font-bold">{t('setup.welcome')}</h1>
          <p className="text-muted-foreground mt-2">{t('setup.tagline')}</p>
        </div>

        <div className="flex justify-center gap-2 mb-8">
          {[1, 2, 3, 4, 5].map((s) => (
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
                  <h2 className="text-xl font-semibold mb-2">{t('setup.chooseLanguage')}</h2>
                  <p className="text-muted-foreground text-sm">
                    {t('setup.chooseLanguageHint')}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {languageOptions.map((option) => {
                    const selected = language === option;
                    const label = option === 'es' ? t('setup.languageSpanish') : t('setup.languageEnglish');
                    return (
                      <button
                        key={option}
                        onClick={() => setLanguage(option)}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${
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
                    <h3 className="text-sm font-medium">{t('setup.chooseCountry')}</h3>
                    <p className="text-muted-foreground text-sm mt-1">{t('setup.chooseCountryHint')}</p>
                  </div>

                  <div className="relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <Input
                      value={countryQuery}
                      onChange={(e) => setCountryQuery(e.target.value)}
                      placeholder={t('setup.searchPlaceholder')}
                      className="pl-9"
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
                        className={`p-3 rounded-xl border-2 text-left transition-all flex items-center justify-between ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div>
                          <div className="font-semibold">{countryName(c.code)}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.currency} · {c.taxIdLabel || t('setup.noTaxId')} · {c.locale}
                          </div>
                        </div>
                        {selected && <Check className="w-5 h-5 text-primary" />}
                      </button>
                    );
                  })}
                  {q && filteredCountries.length === 0 && (
                    <p className="text-center text-gray-500 py-6 text-sm">{t('setup.noMatches').replace('{query}', countryQuery)}</p>
                  )}
                </div>

                <Button onClick={() => setStep(2)} className="w-full" size="lg">
                  {t('setup.continue')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <KeyRound className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">{t('setup.setMasterPinTitle')}</h2>
                  <p className="text-muted-foreground text-sm">
                    {t('setup.setMasterPinDescription')}
                  </p>
                </div>

                {masterPinAvailable === false ? (
                  <p className="text-sm text-center text-muted-foreground bg-muted rounded-lg p-4">
                    {t('setup.masterPinNotAvailable')}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="master-pin">{t('setup.pinLabel')}</Label>
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
                          className="text-center text-lg tracking-[0.5em] pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowMasterPin(!showMasterPin)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showMasterPin ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="master-pin-confirm">{t('setup.confirmPinLabel')}</Label>
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
                          className="text-center text-lg tracking-[0.5em] pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmMasterPin(!showConfirmMasterPin)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
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
                  {t('setup.continue')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(2)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setup.createOwner')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setup.ownerSubtitle')}</p>
                </div>

                <form onSubmit={handleOwnerSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">{t('setup.ownerName')}</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder={t('setup.ownerNamePlaceholder')}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('setup.ownerEmail')}</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder={t('setup.ownerEmailPlaceholder')}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="password">{t('setup.password')}</Label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          autoComplete="new-password"
                          value={form.password}
                          onChange={(e) => setForm({ ...form, password: e.target.value })}
                          placeholder={t('setup.passwordPlaceholder')}
                          className="pr-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirmPassword">{t('setup.confirmPassword')}</Label>
                      <div className="relative">
                        <Input
                          id="confirmPassword"
                          type={showConfirmPassword ? "text" : "password"}
                          autoComplete="new-password"
                          value={form.confirmPassword}
                          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                          placeholder={t('setup.confirmPasswordPlaceholder')}
                          className="pr-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
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
                      {passwordsMatch ? t('setup.passwordsMatch') : t('setup.passwordsMismatch')}
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="business_name">{t('setup.businessName')}</Label>
                    <Input
                      id="business_name"
                      value={form.business_name}
                      onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                      placeholder={t('setup.businessNamePlaceholder')}
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
                      {t('setup.termsIntro')}{' '}
                      <a href="https://flopos.com/terms" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        {t('setup.terms')}
                      </a>
                      ,{' '}
                      <a href="https://flopos.com/privacy" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        {t('setup.privacy')}
                      </a>
                      , and{' '}
                      <a href="https://flopos.com/disclaimer" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                        {t('setup.disclaimer')}
                      </a>
                      .
                    </span>
                  </label>


                  <Button type="submit" disabled={!passwordsMatch || !termsAccepted || !isPasswordValid(form.password)} className="w-full" size="lg">
                    {t('setup.continue')} <ArrowRight className="w-4 h-4 ml-2" />
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
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setup.setupDataTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setup.setupDataSubtitle')}</p>
                </div>

                <div className="grid gap-4">
                  {SETUP_PROFILES.map((item) => {
                    const selected = profile === item.value;
                    const Icon = item.value === 'demo' ? Database : item.value === 'express' ? Sparkles : UtensilsCrossed;
                    return (
                      <button
                        key={item.value}
                        onClick={() => setProfile(item.value)}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start gap-4">
                          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
                            <Icon className="w-5 h-5 text-primary" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">{t(`setup.${item.value}Label`)}</span>
                              {item.badge && (
                                <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                                  {t('setup.expressBadge')}
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground mt-1">{t(`setup.${item.value}Desc`)}</div>
                            <div className="text-xs text-muted-foreground mt-2">{t(`setup.${item.value}Details`)}</div>
                          </div>
                          {selected && <Check className="w-5 h-5 text-primary" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <Button onClick={() => setStep(5)} className="w-full" size="lg">
                  {t('setup.continue')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(4)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setup.flowTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setup.flowSubtitle')}</p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  {SERVICE_MODELS.map((item) => {
                    const selected = serviceModel === item.value;
                    return (
                      <button
                        key={item.value}
                        onClick={() => setServiceModel(item.value)}
                        className={`p-5 rounded-xl border-2 text-left transition-all ${
                          selected ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-semibold text-lg">{t(`setup.${item.value}Label`)}</div>
                            <div className="text-sm text-muted-foreground mt-1">{t(`setup.${item.value}Desc`)}</div>
                            <div className="text-xs text-muted-foreground mt-3">{t(`setup.${item.value}Details`)}</div>
                          </div>
                          {selected && <Check className="w-5 h-5 text-primary shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <Button onClick={handleCompleteSetup} disabled={loading} className="w-full" size="lg">
                  {loading ? t('setup.completingSetup') : (
                    <>
                      {t('setup.completeSetup')} <ArrowRight className="w-4 h-4 ml-2" />
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
