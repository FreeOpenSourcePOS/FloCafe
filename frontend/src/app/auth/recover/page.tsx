'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import toast from 'react-hot-toast';
import { ArrowLeft, Eye, EyeOff, KeyRound, Mail } from 'lucide-react';

const RESET_POLL_INTERVAL_MS = 3000;

type RecoveryMethod = 'email' | 'pin';
type EmailStep = 'idle' | 'waiting' | 'approved';

export default function RecoverAccessPage() {
  const router = useRouter();
  const t = useTranslations('auth');
  const tSetup = useTranslations('setup');

  const [email, setEmail] = useState('');
  const [masterPin, setMasterPin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Master PIN availability status (null = checking, true/false = resolved).
  const [pinAvailable, setPinAvailable] = useState<boolean | null>(null);
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [method, setMethod] = useState<RecoveryMethod>('pin');
  const [emailStep, setEmailStep] = useState<EmailStep>('idle');
  const [resetId, setResetId] = useState('');
  const [emailHint, setEmailHint] = useState('');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  };

  useEffect(() => {
    api
      .get('/auth/setup/status')
      .then(({ data }) => {
        setPinAvailable(!!data.masterPinAvailable);
        setCloudAvailable(!!data.cloudRecoveryAvailable);
        if (data.cloudRecoveryAvailable) setMethod('email');
      })
      .catch(() => {
        console.warn('[RecoverAccess] Could not verify recovery availability');
        setPinAvailable(false);
      });
    return stopPolling;
  }, []);

  const requestEmailReset = async () => {
    setFormError(null);
    setLoading(true);
    try {
      const { data } = await api.post('/auth/recover-password/cloud/request');
      setResetId(data.reset_id);
      setEmailHint(data.email_hint || '');
      setEmailStep('waiting');
      stopPolling();
      pollTimer.current = setInterval(async () => {
        try {
          const { data: status } = await api.get('/auth/recover-password/cloud/status', {
            params: { reset_id: data.reset_id },
          });
          if (status.status === 'approved') {
            stopPolling();
            setEmailStep('approved');
          } else if (status.status === 'expired' || status.status === 'consumed') {
            stopPolling();
            setEmailStep('idle');
            setFormError(t('recoverEmailExpired'));
          }
        } catch {
          // Transient failures keep polling; the owner can resend.
        }
      }, RESET_POLL_INTERVAL_MS);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      setFormError(status === 429 ? t('recoverEmailRateLimited') : t('recoverEmailUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const passwordsEntered = newPassword.length > 0 && confirmPassword.length > 0;
  const passwordsMatch = !passwordsEntered || newPassword === confirmPassword;

  const isPasswordValid = (password: string) => {
    if (!password || password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (method === 'pin' && !/^\d{4}$/.test(masterPin)) {
      setFormError(t('recoverPinFormat'));
      return;
    }
    if (!isPasswordValid(newPassword)) {
      setFormError(t('recoverPasswordRequirements'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError(t('recoverPasswordMismatch'));
      return;
    }

    setLoading(true);
    try {
      if (method === 'email') {
        await api.post('/auth/recover-password/cloud/complete', {
          reset_id: resetId,
          new_password: newPassword,
        });
      } else {
        await api.post('/auth/recover-password', {
          email,
          master_pin: masterPin,
          new_password: newPassword,
        });
      }
      toast.success(t('recoverSuccess'));
      router.push('/auth/login');
    } catch (err: unknown) {
      const error = err as { response?: { status?: number; data?: { error?: string } } };
      const status = error.response?.status;

      if (method === 'email' && status === 409) {
        setEmailStep('idle');
        setFormError(t('recoverEmailExpired'));
      } else if (method === 'email' && status === 502) {
        setFormError(t('recoverEmailUnavailable'));
      } else if (status === 503) {
        setFormError(t('recoverPinUnavailable'));
      } else if (status === 409) {
        setFormError(t('recoverErrorGeneric'));
      } else if (status === 429) {
        setFormError(t('recoverRateLimited'));
      } else if (status === 403) {
        setFormError(t('recoverWrongPin'));
      } else if (status === 404) {
        setFormError(t('recoverNoOwner'));
      } else if (status === 400) {
        setFormError(t('recoverErrorGeneric'));
      } else {
        setFormError(t('recoverErrorGeneric'));
      }
    } finally {
      setLoading(false);
    }
  };

  const passwordFields = (
    <>
      <div className="grid grid-cols-1 gap-4">
        <div className="space-y-2">
          <Label htmlFor="new-password">{t('recoverNewPasswordLabel')}</Label>
          <div className="relative">
            <Input
              id="new-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('recoverNewPasswordPlaceholder')}
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
          <Label htmlFor="confirm-new-password">{t('recoverConfirmPasswordLabel')}</Label>
          <Input
            id="confirm-new-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('recoverConfirmPasswordPlaceholder')}
            required
          />
        </div>
      </div>

      {!isPasswordValid(newPassword) && newPassword.length > 0 && (
        <p className="text-xs font-medium text-red-600">{t('recoverPasswordRequirements')}</p>
      )}
      {passwordsEntered && (
        <p className={`text-xs font-medium ${passwordsMatch ? 'text-green-600' : 'text-red-600'}`}>
          {passwordsMatch ? tSetup('passwordsMatch') : tSetup('passwordsMismatch')}
        </p>
      )}
    </>
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <button
          onClick={() => router.push('/auth/login')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4 rtl-flip" /> {t('recoverBackToLogin')}
        </button>

        <div className="text-center mb-6">
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <KeyRound className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">{t('recoverTitle')}</h1>
          <p className="text-muted-foreground mt-2 text-sm">{t('recoverSubtitle')}</p>
        </div>

        <Card>
          <CardContent className="pt-6">
            {pinAvailable === null ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                {t('recoverChecking')}
              </p>
            ) : pinAvailable === false && !cloudAvailable ? (
              <div className="text-center py-4">
                <p className="text-sm text-destructive font-medium">{t('recoverPinUnavailable')}</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {cloudAvailable && pinAvailable && (
                  <div className="grid grid-cols-2 gap-2">
                    {(['email', 'pin'] as const).map((m) => (
                      <Button
                        key={m}
                        type="button"
                        variant={method === m ? 'default' : 'outline'}
                        onClick={() => {
                          stopPolling();
                          setEmailStep('idle');
                          setFormError(null);
                          setMethod(m);
                        }}
                      >
                        {m === 'email' ? t('recoverMethodEmail') : t('recoverMethodPin')}
                      </Button>
                    ))}
                  </div>
                )}

                {method === 'email' ? (
                  emailStep === 'approved' ? null : (
                    <div className="space-y-3 text-center">
                      <Mail className="w-6 h-6 mx-auto text-primary" />
                      <p className="text-sm text-muted-foreground">
                        {emailStep === 'waiting'
                          ? t('recoverEmailSent', { email: emailHint })
                          : t('recoverEmailIntro')}
                      </p>
                      <Button
                        type="button"
                        variant={emailStep === 'waiting' ? 'outline' : 'default'}
                        className="w-full"
                        disabled={loading}
                        onClick={requestEmailReset}
                      >
                        {loading
                          ? t('recoverEmailSending')
                          : emailStep === 'waiting'
                            ? t('recoverEmailResend')
                            : t('recoverEmailSend')}
                      </Button>
                    </div>
                  )
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="recover-email">{t('email')}</Label>
                      <Input
                        id="recover-email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder={t('emailPlaceholder')}
                        dir="ltr"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="recover-pin">{t('recoverPinLabel')}</Label>
                      <p className="text-xs text-muted-foreground">{t('recoverPinHint')}</p>
                      <div className="relative">
                        <Input
                          id="recover-pin"
                          type={showPin ? 'text' : 'password'}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={masterPin}
                          onChange={(e) =>
                            setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                          }
                          placeholder="••••"
                          className="text-center text-lg tracking-[0.5em] pe-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowPin(!showPin)}
                          className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {(method === 'pin' || emailStep === 'approved') && passwordFields}

                {formError && <p className="text-sm text-destructive text-center">{formError}</p>}

                {(method === 'pin' || emailStep === 'approved') && (
                  <Button type="submit" disabled={loading} className="w-full" size="lg">
                    {loading ? t('recoverSubmitting') : t('recoverSubmit')}
                  </Button>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
