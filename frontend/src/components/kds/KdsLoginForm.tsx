'use client';

import { ChefHat } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

export function KdsLoginForm({ conn }: { conn: UseKdsConnectionResult }) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <ChefHat size={48} className="mx-auto text-brand mb-4" />
          <h1 className="text-2xl font-bold text-gray-900">{t('kds.title')}</h1>
          <p className="text-gray-500 mt-2">{t('kds.loginSubtitle')}</p>
        </div>

        <form onSubmit={conn.handleLogin} className="space-y-4">
          {conn.loginError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {conn.loginError}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.email')}</label>
            <input
              type="email"
              value={conn.loginEmail}
              onChange={(e) => conn.setLoginEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
              placeholder="chef@flo.local"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.password')}</label>
            <input
              type="password"
              value={conn.loginPassword}
              onChange={(e) => conn.setLoginPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={conn.loginLoading}
            className="w-full py-3 bg-brand text-white font-semibold rounded-lg hover:bg-brand/90 disabled:opacity-50"
          >
            {conn.loginLoading ? t('auth.signingIn') : t('auth.signIn')}
          </button>
        </form>

        <p className="text-xs text-gray-400 text-center mt-6">{t('kds.loginHint')}</p>
      </div>
    </div>
  );
}
