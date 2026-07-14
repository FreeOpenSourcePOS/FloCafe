'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';

export default function RegisterPage() {
  const router = useRouter();
  const { register, selectTenant } = useAuthStore();
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    password_confirmation: '',
    business_name: '',
    business_type: 'restaurant',
    country: 'IN',
  });
  const passwordsEntered = form.password.length > 0 && form.password_confirmation.length > 0;
  const passwordsMatch = !passwordsEntered || form.password === form.password_confirmation;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.password_confirmation) {
      toast.error(t('auth.passwordsDoNotMatch'));
      return;
    }
    setLoading(true);
    try {
      await register(form);
      // Auto-select the newly created tenant
      const newTenants = useAuthStore.getState().tenants;
      if (newTenants.length > 0) {
        await selectTenant(newTenants[0].id);
      }
      toast.success(t('auth.accountCreated'));
      router.push('/dashboard');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { errors?: Record<string, string[]>; error?: string } } };
      const errors = error.response?.data?.errors;
      if (errors) {
        const firstError = Object.values(errors)[0]?.[0];
        toast.error(firstError || t('auth.registrationFailed'));
      } else {
        toast.error(error.response?.data?.error || t('auth.registrationFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <img src="/logo.svg" alt="Flo" width={120} height={77} className="mx-auto mb-3" />
          <p className="text-gray-500 mt-2">{t('auth.registerSubtitle')}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.yourName')}</label>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                  required
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.email')}</label>
                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.password')}</label>
                <input
                  type="password"
                  name="password"
                  value={form.password}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.confirmPassword')}</label>
                <input
                  type="password"
                  name="password_confirmation"
                  value={form.password_confirmation}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                  required
                />
              </div>

              {passwordsEntered && (
                <div className="col-span-2 -mt-2">
                  <p className={`text-xs font-medium ${passwordsMatch ? 'text-green-600' : 'text-red-600'}`}>
                    {passwordsMatch ? t('auth.passwordsMatch') : t('auth.passwordsDoNotMatch')}
                  </p>
                </div>
              )}

              <div className="col-span-2 border-t border-gray-200 pt-5 mt-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.businessNameLabel')}</label>
                <input
                  type="text"
                  name="business_name"
                  value={form.business_name}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                  placeholder={t('auth.businessNamePlaceholder')}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.countryLabel')}</label>
                <select
                  name="country"
                  value={form.country}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
                >
                  <option value="IN">{t('auth.countryIndia')}</option>
                  <option value="TH">{t('auth.countryThailand')}</option>
                </select>
              </div>
            </div>

            <Button type="submit" disabled={loading || !passwordsMatch} className="w-full" size="lg">
              {loading ? t('auth.signingIn') : t('auth.createAccount')}
            </Button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-6">
            {t('auth.haveAccount')}{' '}
            <Link href="/auth/login" className="text-brand hover:text-brand-hover font-medium">
              {t('auth.signIn')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
