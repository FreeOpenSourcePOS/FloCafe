'use client';

import { useState, useEffect, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLandingPage } from '@/components/layout/AuthGuard';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
import { Eye, EyeOff } from 'lucide-react';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, selectTenant, user, tenants, currentTenant, loadFromStorage } = useAuthStore();
  const { t } = useI18n();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showTenantSelect, setShowTenantSelect] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    fetch('/api/auth/setup/status')
      .then(r => r.json())
      .then(data => {
        if (data.needsSetup) router.replace('/setup');
      })
      .catch(() => {});

    fetch('/api/health')
      .then(r => r.json())
      .then(data => {
        if (data.status !== 'ok') {
          setDbError(data.db || t('auth.dbErrorPrefix'));
        }
      })
      .catch(() => {});
  }, [router, t]);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  const handleTenantSelect = useCallback(async (tenantId: number) => {
    setLoading(true);
    try {
      await selectTenant(tenantId);
      // useEffect on currentTenant will handle the redirect
    } catch {
      toast.error(t('auth.selectBusinessFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectTenant, t]);

  useEffect(() => {
    if (user && currentTenant) {
      router.push(getLandingPage());
    } else if (user && tenants.length === 1) {
      // Only one business — auto-select it
      handleTenantSelect(tenants[0].id);
    } else if (user && tenants.length > 1) {
      setShowTenantSelect(true);
    }
    if (searchParams.get('select_tenant') === 'true' && user) {
      setShowTenantSelect(true);
    }
   
   
  }, [user, tenants, currentTenant, router, searchParams, handleTenantSelect]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setLoginError(null);
    try {
      await login(email, password, rememberMe);
      toast.success(t('auth.signInSuccess'));
    } catch (err: unknown) {
      const error = err as { response?: { status?: number; data?: { error?: string; attempts_remaining?: number; lockout_minutes?: number } } };
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 401) {
        const remaining = data?.attempts_remaining;
        if (remaining === 0) {
          // Just got locked out
          const mins = data?.lockout_minutes ?? 15;
          setLoginError(t('auth.lockedOut').replace('{minutes}', String(mins)));
        } else if (typeof remaining === 'number' && remaining < 4) {
          // Warn only when getting close (≤ 4 remaining to avoid noise on first attempt)
          setLoginError(
            t('auth.invalidCredentials') + ' ' +
            t('auth.attemptsRemaining').replace('{count}', String(remaining))
          );
        } else {
          setLoginError(t('auth.invalidCredentials'));
        }
      } else if (status === 429) {
        // Middleware-level lockout (authRateLimit window exhausted)
        const msg = data?.error || t('auth.lockedOut').replace('{minutes}', '15');
        setLoginError(msg);
      } else {
        const msg = data?.error || t('auth.loginFailed');
        setDbError(msg);
      }
    } finally {
      setLoading(false);
    }
  };



  if (showTenantSelect) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <Card>
            <CardContent className="pt-6">
              <h2 className="text-2xl font-bold mb-2">{t('auth.selectBusiness')}</h2>
              <p className="text-muted-foreground text-sm mb-6">{t('auth.selectBusinessHint')}</p>
              <div className="space-y-3">
                {tenants.map((tenant) => (
                  <button
                    key={tenant.id}
                    onClick={() => handleTenantSelect(tenant.id)}
                    disabled={loading}
                    className="w-full text-left p-4 border rounded-lg hover:border-primary hover:bg-accent transition-colors group"
                  >
                    <div className="font-semibold group-hover:text-primary">{tenant.business_name}</div>
                    <div className="text-sm text-muted-foreground mt-0.5">{tenant.business_type} &middot; {tenant.role}</div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Flo" width={120} height={77} className="mx-auto mb-3" />
          <p className="text-muted-foreground mt-2">{t('auth.signInTitle')}</p>
        </div>
        {dbError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <strong>{t('auth.dbErrorPrefix')}</strong> {dbError}
          </div>
        )}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('auth.emailPlaceholder')} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <div className="relative">
                  <Input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('auth.passwordPlaceholder')} className="pr-10" required />
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
              <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded border-input text-primary focus:ring-primary"
                />
                {t('auth.rememberMe')}
              </label>
              {loginError && (
                <p className="text-sm text-destructive text-center">{loginError}</p>
              )}
              <Button type="submit" disabled={loading} className="w-full" size="lg">
                {loading ? t('auth.signingIn') : t('auth.signIn')}
              </Button>
              <button
                type="button"
                onClick={() => router.push('/auth/recover')}
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('auth.forgotPasswordLink')}
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
