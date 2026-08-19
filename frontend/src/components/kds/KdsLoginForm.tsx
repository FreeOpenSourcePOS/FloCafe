'use client';

import { ChefHat } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

export function KdsLoginForm({ conn }: { conn: UseKdsConnectionResult }) {
  const t = useTranslations('kds');
  const tAuth = useTranslations('auth');
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <ChefHat size={48} className="mx-auto text-brand mb-4" />
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500 mt-2">{t('loginSubtitle')}</p>
        </div>

        <form data-testid="kds-login-form" onSubmit={conn.handleLogin} className="space-y-4">
          {conn.loginError && (
            <div role="alert" aria-live="polite" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {conn.loginError}
            </div>
          )}

          <div>
            <label htmlFor="kds-login-email" className="block text-sm font-medium text-gray-700 mb-1">{tAuth('email')}</label>
            <input
              id="kds-login-email"
              data-testid="kds-login-email"
              type="email"
              value={conn.loginEmail}
              onChange={(e) => conn.setLoginEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
              placeholder="chef@flo.local"
              required
            />
          </div>

          <div>
            <label htmlFor="kds-login-password" className="block text-sm font-medium text-gray-700 mb-1">{tAuth('password')}</label>
            <input
              id="kds-login-password"
              data-testid="kds-login-password"
              type="password"
              value={conn.loginPassword}
              onChange={(e) => conn.setLoginPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
              placeholder="••••••••"
              required
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={conn.rememberMe}
              onChange={(e) => conn.setRememberMe(e.target.checked)}
              className="rounded border-gray-300 text-brand focus:ring-brand"
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

        <p className="text-xs text-gray-400 text-center mt-6">{t('loginHint')}</p>
      </div>
    </div>
  );
}
