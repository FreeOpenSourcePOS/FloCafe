'use client';

import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useTranslations } from 'use-intl';
import { Check, Eye, EyeOff, Pizza } from 'lucide-react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RESTORE_FROM_FILE_EVENT } from '@/components/layout/MenuActionHandler';
import { PASSWORD_MIN_LENGTH, validatePassword } from '@shared/password-policy';
import {
  quickSetupBody,
  quickSetupProblems,
  refusedField,
  type QuickSetupField,
  type QuickSetupForm,
} from '@/lib/pizza/quick-setup';

const RESTORE_URL = '/setup?action=restore-from-file';
const FIELD_ORDER: QuickSetupField[] = [
  'shopName',
  'name',
  'email',
  'password',
  'pin',
  'pinConfirm',
  'termsAccepted',
];
const INPUT = 'h-12 text-base';
const LINK = 'inline-flex min-h-12 items-center text-primary underline underline-offset-4';

/** One screen that sets up a counter-service pizza shop in British Columbia. */
export default function PizzaQuickSetupPage() {
  const t = useTranslations('pizza');
  const tSetup = useTranslations('setup');
  const [form, setForm] = useState<QuickSetupForm>({
    shopName: '',
    name: '',
    email: '',
    password: '',
    pin: '',
    pinConfirm: '',
    termsAccepted: false,
  });
  const [errors, setErrors] = useState<Partial<Record<QuickSetupField, string>>>({});
  const [formError, setFormError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [masterPinAvailable, setMasterPinAvailable] = useState(false);
  // The recovery-PIN note depends on the setup status, so the form is not sent before it is read.
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // The first read starts from the 'loading' state above; a retry sets it from its click.
  const readStatus = () => {
    api
      .get('/auth/setup/status')
      .then(({ data }) => {
        if (!data.needsSetup) window.location.replace('/auth/login');
        // A store finishing a currency reset keeps its region, which only the full wizard handles.
        else if (data.currencyReset) window.location.replace('/setup');
        else {
          setMasterPinAvailable(Boolean(data.masterPinAvailable));
          setStatus('ready');
        }
      })
      .catch(() => setStatus('failed'));
  };

  useEffect(() => {
    readStatus();
    const restore = () => window.location.assign(RESTORE_URL);
    window.addEventListener(RESTORE_FROM_FILE_EVENT, restore);
    return () => window.removeEventListener(RESTORE_FROM_FILE_EVENT, restore);
  }, []);

  const set = <K extends QuickSetupField>(key: K, value: QuickSetupForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const showErrors = (next: Partial<Record<QuickSetupField, string>>) => {
    setErrors(next);
    const first = FIELD_ORDER.find((field) => next[field]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || status !== 'ready') return;
    setFormError('');
    const problems = quickSetupProblems(form);
    if (Object.keys(problems).length > 0) {
      showErrors(
        Object.fromEntries(
          Object.entries(problems).map(([field, key]) => [
            field,
            t(key, { min: PASSWORD_MIN_LENGTH }),
          ]),
        ),
      );
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/setup/initialize', quickSetupBody(form, masterPinAvailable));
    } catch (error) {
      setBusy(false);
      const message =
        axios.isAxiosError(error) && error.response
          ? String((error.response.data as { error?: string })?.error || error.message)
          : null;
      if (message === null) return setFormError(t('quickSetupUnreachable'));
      const field = refusedField(message);
      if (field) showErrors({ [field]: message });
      else setFormError(message);
      return;
    }
    try {
      await useAuthStore.getState().login(form.email.trim(), form.password);
      window.location.replace('/pizza-menu');
    } catch {
      window.location.replace('/auth/login');
    }
  };

  const fieldProps = (field: QuickSetupField) => ({
    id: `quick-setup-${field}`,
    name: field,
    'aria-invalid': Boolean(errors[field]),
    'aria-describedby': errors[field] ? `quick-setup-${field}-error` : undefined,
  });
  const fieldError = (field: QuickSetupField) =>
    errors[field] ? (
      <p id={`quick-setup-${field}-error`} className="text-sm font-medium text-red-600">
        {errors[field]}
      </p>
    ) : null;

  const passwordOk = validatePassword(form.password);
  const passwordRuleTone = errors.password
    ? 'text-red-600'
    : passwordOk
      ? 'text-green-700'
      : 'text-muted-foreground';

  return (
    <main className="min-h-screen bg-gradient-to-br from-background to-muted px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 text-center">
          <Pizza className="mx-auto mb-3 size-12 text-primary" aria-hidden />
          <h1 className="text-3xl font-bold">{t('quickSetupTitle')}</h1>
          <p className="mt-2 text-muted-foreground">{t('quickSetupDecided')}</p>
        </div>

        <form
          ref={formRef}
          onSubmit={submit}
          noValidate
          className="space-y-5 rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <div className="space-y-2">
            <Label htmlFor="quick-setup-shopName">{t('quickSetupShopName')}</Label>
            <Input
              {...fieldProps('shopName')}
              className={INPUT}
              autoComplete="organization"
              value={form.shopName}
              onChange={(e) => set('shopName', e.target.value)}
            />
            {fieldError('shopName')}
          </div>

          <div className="space-y-2">
            <Label htmlFor="quick-setup-name">{t('quickSetupOwnerName')}</Label>
            <Input
              {...fieldProps('name')}
              className={INPUT}
              autoComplete="name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
            {fieldError('name')}
          </div>

          <div className="space-y-2">
            <Label htmlFor="quick-setup-email">{t('quickSetupEmail')}</Label>
            <Input
              {...fieldProps('email')}
              className={INPUT}
              type="email"
              autoComplete="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
            />
            {fieldError('email')}
          </div>

          <div className="space-y-2">
            <Label htmlFor="quick-setup-password">{t('quickSetupPassword')}</Label>
            <div className="flex gap-2">
              <Input
                {...fieldProps('password')}
                aria-describedby="quick-setup-password-error"
                className={INPUT}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                className="size-12 shrink-0"
                aria-label={
                  showPassword ? t('quickSetupHidePassword') : t('quickSetupShowPassword')
                }
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </Button>
            </div>
            <p
              id="quick-setup-password-error"
              className={`flex items-center gap-1 text-sm ${passwordRuleTone}`}
            >
              {passwordOk && !errors.password && <Check className="size-4" aria-hidden />}
              {errors.password || t('quickSetupNeedPassword', { min: PASSWORD_MIN_LENGTH })}
            </p>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t('quickSetupPin')}</legend>
            <p className="text-sm text-muted-foreground">
              {t('quickSetupPinHint')}
              {masterPinAvailable && ` ${t('quickSetupPinRecovery')}`}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(['pin', 'pinConfirm'] as const).map((field) => (
                <div key={field} className="space-y-2">
                  <Label htmlFor={`quick-setup-${field}`}>
                    {t(field === 'pin' ? 'quickSetupPinFirst' : 'quickSetupPinConfirm')}
                  </Label>
                  <Input
                    {...fieldProps(field)}
                    className={`${INPUT} text-center tracking-[0.5em]`}
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    value={form[field]}
                    onChange={(e) => set(field, e.target.value.replace(/\D/g, '').slice(0, 4))}
                  />
                  {fieldError(field)}
                </div>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1">
            <label className="flex items-start gap-3 text-sm">
              <input
                {...fieldProps('termsAccepted')}
                type="checkbox"
                className="mt-0.5 size-6 shrink-0 accent-primary"
                checked={form.termsAccepted}
                onChange={(e) => set('termsAccepted', e.target.checked)}
              />
              <span>
                {tSetup('termsIntro')}{' '}
                <a
                  href="https://flopos.com/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {tSetup('terms')}
                </a>
                ,{' '}
                <a
                  href="https://flopos.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {tSetup('privacy')}
                </a>
                , {tSetup('termsAnd')}{' '}
                <a
                  href="https://flopos.com/disclaimer"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {tSetup('disclaimer')}
                </a>
                .
              </span>
            </label>
            {fieldError('termsAccepted')}
          </div>

          {formError && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {formError}
            </p>
          )}

          {status === 'failed' && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              <span className="flex-1">{t('quickSetupStatusFailed')}</span>
              <Button
                type="button"
                variant="outline"
                className="h-12"
                onClick={() => {
                  setStatus('loading');
                  readStatus();
                }}
              >
                {t('quickSetupRetry')}
              </Button>
            </div>
          )}

          <Button
            type="submit"
            disabled={busy || status !== 'ready'}
            className="h-12 w-full text-base"
          >
            {busy ? t('quickSetupSubmitting') : t('quickSetupSubmit')}
          </Button>
        </form>

        <nav className="mt-4 flex flex-col items-center gap-1 text-sm">
          <Link href="/setup" className={LINK}>
            {t('quickSetupFullSetup')}
          </Link>
          <Link href={RESTORE_URL} className={LINK}>
            {t('quickSetupRestore')}
          </Link>
        </nav>
      </div>
    </main>
  );
}
