'use client';

import { useState, useEffect, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations, type AppConfig } from 'use-intl';
import { getLandingPage } from '@/components/layout/AuthGuard';
import { useAuthStore, StorageUnavailableError } from '@/store/auth';
import { parseLoginFailure } from '@/lib/login-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import toast from 'react-hot-toast';
import { Eye, EyeOff, LifeBuoy, MessageCircle, Ticket } from 'lucide-react';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';
import { SupportTicketForm, PRE_LOGIN_SUPPORT_ENDPOINTS } from '@/components/support/SupportTicketForm';

const WHATSAPP_COMMUNITY_URL = 'https://chat.whatsapp.com/LxHobzv6d2X81NzrVfMjzo?mode=gi_t';

// Backend enum → leaf key maps for the tenant picker.
type BusinessTypeKey = keyof AppConfig['Messages']['businessType'];

const BUSINESS_TYPE_LEAF_KEYS: Record<string, BusinessTypeKey> = {
  restaurant: 'restaurant',
};

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, selectTenant, user, tenants, currentTenant, loadFromStorage } = useAuthStore();
  const t = useTranslations('auth');
  const tStaff = useTranslations('staff');
  const tBusinessType = useTranslations('businessType');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
  const tSupport = useTranslations('support');

  useEffect(() => {
    fetch('/api/auth/setup/status')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.needsSetup) router.replace('/setup');
      })
      .catch(() => {});

    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.status !== 'ok') {
          setDbError(data.db || t('dbErrorPrefix'));
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
      toast.error(t('selectBusinessFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectTenant, t]);

  useEffect(() => {
    // Navigate to landing page once user and tenant are selected (auto-selection handled in auth store).
    if (user && currentTenant) {
      router.push(getLandingPage());
    }
  }, [user, currentTenant, router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setLoginError(null);
    try {
      await login(email, password, rememberMe);
      toast.success(t('signInSuccess'));
    } catch (err: unknown) {
      if (err instanceof StorageUnavailableError) {
        // Server login succeeded but the session could not be persisted.
        setLoginError(t('storageUnavailable'));
      } else {
        const failure = parseLoginFailure(err);
        if (failure.status === 401) {
          const remaining = failure.attemptsRemaining;
          if (remaining === 0) {
            // Just got locked out
            const mins = failure.lockoutMinutes ?? 15;
            setLoginError(t('lockedOut', { minutes: mins }));
          } else if (typeof remaining === 'number' && remaining < 4) {
            // Warn only when getting close (≤ 4 remaining to avoid noise on first attempt)
            setLoginError(
              t('invalidCredentials') + ' ' +
              t('attemptsRemaining', { count: remaining })
            );
          } else {
            setLoginError(t('invalidCredentials'));
          }
        } else if (failure.status === 429) {
          // Middleware-level lockout (authRateLimit window exhausted)
          setLoginError(t('lockedOut', { minutes: 15 }));
        } else if (failure.status === undefined) {
          // No HTTP response at all: the server was unreachable (network).
          setLoginError(t('connectionFailed'));
        } else {
          // Other server-side failures belong under the database/setup banner.
          setDbError(t('loginFailed'));
        }
      }
    } finally {
      setLoading(false);
    }
  };



  const shouldShowTenantSelect = !!(user && (tenants.length > 1 || searchParams.get('select_tenant') === 'true'));

  if (shouldShowTenantSelect) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <Card>
            <CardContent className="pt-6">
              <h2 className="text-2xl font-bold mb-2">{t('selectBusiness')}</h2>
              <p className="text-muted-foreground text-sm mb-6">{t('selectBusinessHint')}</p>
              <div className="space-y-3">
                {tenants.map((tenant) => {
                  const businessTypeKey = tenant.business_type ? BUSINESS_TYPE_LEAF_KEYS[tenant.business_type] : undefined;
                  const roleKey = tenant.role ? ROLE_LABEL_KEYS[tenant.role] : undefined;
                  return (
                    <button
                      key={tenant.id}
                      onClick={() => handleTenantSelect(tenant.id)}
                      disabled={loading}
                      className="w-full text-start p-4 border rounded-lg hover:border-primary hover:bg-accent transition-colors group"
                    >
                      <div className="font-semibold group-hover:text-primary">{tenant.business_name}</div>
                      <div className="text-sm text-muted-foreground mt-0.5">
                        {businessTypeKey ? tBusinessType(businessTypeKey) : tenant.business_type ?? ''} &middot; {roleKey ? tStaff(roleKey) : tenant.role ?? ''}
                      </div>
                    </button>
                  );
                })}
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
          <img src="/logo.svg" alt="Flo" width={96} height={96} className="mx-auto mb-3" />
          <p className="text-muted-foreground mt-2">{t('signInTitle')}</p>
        </div>
        {dbError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <strong>{t('dbErrorPrefix')}</strong> {dbError}
          </div>
        )}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('email')}</Label>
                <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('emailPlaceholder')} dir="ltr" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t('password')}</Label>
                <div className="relative">
                  <Input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('passwordPlaceholder')} className="pe-10" required />
                  <button
                    type="button"
                    data-testid="password-visibility-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
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
                {t('rememberMe')}
              </label>
              {loginError && (
                <p className="text-sm text-destructive text-center">{loginError}</p>
              )}
              <Button type="submit" disabled={loading} className="w-full" size="lg">
                {loading ? t('signingIn') : t('signIn')}
              </Button>
              <button
                type="button"
                onClick={() => router.push('/auth/recover')}
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('forgotPasswordLink')}
              </button>
            </form>
          </CardContent>
        </Card>

        <div className="mt-4 flex justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <LifeBuoy className="size-4" />
                {tSupport('menuLabel')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem onClick={() => setTicketDialogOpen(true)}>
                <Ticket className="size-4" />
                {tSupport('menuSubmitTicket')}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={WHATSAPP_COMMUNITY_URL} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="size-4" />
                  {tSupport('menuWhatsapp')}
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog open={ticketDialogOpen} onOpenChange={setTicketDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tSupport('dialogTitle')}</DialogTitle>
          </DialogHeader>
          <SupportTicketForm
            endpoints={PRE_LOGIN_SUPPORT_ENDPOINTS}
            showDiagnosticsPreview={false}
          />
        </DialogContent>
      </Dialog>
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
