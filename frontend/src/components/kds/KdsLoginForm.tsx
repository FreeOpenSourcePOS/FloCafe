'use client';

import { useState, type FormEvent } from 'react';
import { ChefHat, Delete, KeyRound, Mail, UserRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';
import type { KdsPinUser, UseKdsConnectionResult } from '@/hooks/useKdsConnection';

const EMPTY_PIN_USERS: KdsPinUser[] = [];

export function KdsLoginForm({ conn }: { conn: UseKdsConnectionResult }) {
  const t = useTranslations('kds');
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const tStaff = useTranslations('staff');
  const pinUsers = conn.pinUsers ?? EMPTY_PIN_USERS;

  const [signInMode, setSignInMode] = useState<'pin' | 'password' | null>(null);
  const [selectedPinUser, setSelectedPinUser] = useState<KdsPinUser | null>(null);
  const [pin, setPin] = useState('');

  const activeSignInMode = pinUsers.length > 0 ? (signInMode ?? 'pin') : 'password';

  const appendPinDigit = (digit: string) => {
    conn.setLoginError?.('');
    setPin((prev) => (prev.length < 6 ? prev + digit : prev));
  };

  const backspacePin = () => {
    conn.setLoginError?.('');
    setPin((prev) => prev.slice(0, -1));
  };

  const clearPin = () => {
    conn.setLoginError?.('');
    setPin('');
  };

  const handlePinSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!selectedPinUser || pin.length < 4 || conn.loginLoading) return;
    conn.setLoginError?.('');
    try {
      await conn.handlePinLogin(selectedPinUser.id, pin);
    } catch {
      setPin('');
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <ChefHat size={48} className="mx-auto text-brand mb-4" />
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-muted-foreground mt-2">{t('loginSubtitle')}</p>
        </div>

        {pinUsers.length > 0 && (
          <div
            data-testid="signin-mode-toggle"
            role="tablist"
            aria-label={tAuth('signIn')}
            className="grid grid-cols-2 gap-1 p-1 mb-6 rounded-xl bg-muted border border-border"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeSignInMode === 'pin'}
              data-testid="signin-mode-pin"
              onClick={() => {
                setSignInMode('pin');
                conn.setLoginError?.('');
              }}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                activeSignInMode === 'pin'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <KeyRound className="size-4 shrink-0" />
              <span className="truncate">{tAuth('quickSwitchTitle')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeSignInMode === 'password'}
              data-testid="signin-mode-password"
              onClick={() => {
                setSignInMode('password');
                setSelectedPinUser(null);
                setPin('');
                conn.setLoginError?.('');
              }}
              className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                activeSignInMode === 'password'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Mail className="size-4 shrink-0" />
              <span className="truncate">{tAuth('password')}</span>
            </button>
          </div>
        )}

        {activeSignInMode === 'pin' ? (
          <div data-testid="pin-user-picker" className="space-y-4">
            <div className="flex items-center gap-2">
              <KeyRound size={18} className="text-brand" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {tAuth('quickSwitchTitle')}
                </h2>
                <p className="text-xs text-muted-foreground">{tAuth('quickSwitchSubtitle')}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {pinUsers.map((u) => {
                const isSelected = selectedPinUser?.id === u.id;
                const roleKey = ROLE_LABEL_KEYS[u.role];
                const roleLabel = roleKey ? tStaff(roleKey) : u.role;
                return (
                  <button
                    key={u.id}
                    type="button"
                    data-testid={`pin-user-tile-${u.id}`}
                    onClick={() => {
                      setSelectedPinUser(u);
                      setPin('');
                      conn.setLoginError?.('');
                    }}
                    className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-start transition-all ${
                      isSelected
                        ? 'border-brand bg-brand-muted ring-2 ring-brand/30'
                        : 'border-border hover:border-brand/50 hover:bg-muted/60'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-brand/15 text-brand flex items-center justify-center shrink-0">
                      <UserRound size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{u.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{roleLabel}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            {selectedPinUser && (
              <form
                onSubmit={handlePinSubmit}
                data-testid="pin-login-form"
                className="pt-3 border-t border-border space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {tAuth('enterPinFor', { name: selectedPinUser.name })}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground">{pin.length}/6</span>
                </div>

                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={6}
                  dir="ltr"
                  autoFocus
                  data-testid="pin-login-input"
                  value={pin}
                  onChange={(e) => {
                    conn.setLoginError?.('');
                    setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                  }}
                  placeholder="••••"
                  className="w-full h-11 px-3 text-center tracking-[0.5em] text-lg font-mono rounded-lg border border-input bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />

                <div className="grid grid-cols-3 gap-2" dir="ltr">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <button
                      key={digit}
                      type="button"
                      data-testid={`pin-pad-digit-${digit}`}
                      onClick={() => appendPinDigit(digit)}
                      className="h-11 rounded-lg border border-border bg-muted/50 hover:bg-muted text-base font-semibold text-foreground transition-colors"
                    >
                      {digit}
                    </button>
                  ))}
                  <button
                    type="button"
                    data-testid="pin-pad-clear"
                    onClick={clearPin}
                    className="h-11 rounded-lg border border-border bg-muted/50 hover:bg-muted text-xs font-medium text-muted-foreground transition-colors"
                  >
                    {tCommon('clear')}
                  </button>
                  <button
                    type="button"
                    data-testid="pin-pad-digit-0"
                    onClick={() => appendPinDigit('0')}
                    className="h-11 rounded-lg border border-border bg-muted/50 hover:bg-muted text-base font-semibold text-foreground transition-colors"
                  >
                    0
                  </button>
                  <button
                    type="button"
                    data-testid="pin-pad-backspace"
                    onClick={backspacePin}
                    aria-label={tCommon('delete')}
                    className="h-11 rounded-lg border border-border bg-muted/50 hover:bg-muted flex items-center justify-center text-muted-foreground transition-colors"
                  >
                    <Delete size={16} />
                  </button>
                </div>

                {conn.loginError && (
                  <p
                    role="alert"
                    data-testid="pin-login-error"
                    className="text-xs text-destructive text-center font-medium"
                  >
                    {conn.loginError}
                  </p>
                )}

                <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
                  <input
                    type="checkbox"
                    checked={conn.rememberMe}
                    onChange={(e) => conn.setRememberMe(e.target.checked)}
                    className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                  />
                  {tAuth('rememberMe')}
                </label>

                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="pin-login-cancel"
                    onClick={() => {
                      setSelectedPinUser(null);
                      setPin('');
                      conn.setLoginError?.('');
                    }}
                    className="flex-1 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  >
                    {tCommon('cancel')}
                  </button>
                  <button
                    type="submit"
                    data-testid="pin-login-submit"
                    disabled={conn.loginLoading || pin.length < 4}
                    className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-semibold hover:bg-brand/90 disabled:opacity-50 transition-colors"
                  >
                    {conn.loginLoading ? tAuth('signingIn') : tAuth('signIn')}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <form data-testid="kds-login-form" onSubmit={conn.handleLogin} className="space-y-4">
            {conn.loginError && (
              <div
                role="alert"
                aria-live="polite"
                className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm"
              >
                {conn.loginError}
              </div>
            )}

            <div>
              <label
                htmlFor="kds-login-email"
                className="block text-sm font-medium text-foreground mb-1"
              >
                {tAuth('email')}
              </label>
              <input
                id="kds-login-email"
                data-testid="kds-login-email"
                type="email"
                value={conn.loginEmail}
                onChange={(e) => conn.setLoginEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
                placeholder="chef@flo.local"
                required
              />
            </div>

            <div>
              <label
                htmlFor="kds-login-password"
                className="block text-sm font-medium text-foreground mb-1"
              >
                {tAuth('password')}
              </label>
              <input
                id="kds-login-password"
                data-testid="kds-login-password"
                type="password"
                value={conn.loginPassword}
                onChange={(e) => conn.setLoginPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
                placeholder="••••••••"
                required
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
              <input
                type="checkbox"
                checked={conn.rememberMe}
                onChange={(e) => conn.setRememberMe(e.target.checked)}
                className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
              />
              {tAuth('rememberMe')}
            </label>

            <button
              data-testid="kds-login-submit"
              type="submit"
              disabled={conn.loginLoading}
              className="w-full py-3 bg-brand text-white font-semibold rounded-lg hover:bg-brand/90 disabled:opacity-50"
            >
              {conn.loginLoading ? tAuth('signingIn') : tAuth('signIn')}
            </button>
          </form>
        )}

        <p className="text-xs text-gray-400 text-center mt-6">{t('loginHint')}</p>
      </div>
    </div>
  );
}
