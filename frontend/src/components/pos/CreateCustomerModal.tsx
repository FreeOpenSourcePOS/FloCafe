'use client';

import { useState } from 'react';
import axios from 'axios';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { useTranslations } from 'use-intl';
import { dialCodeFor, normalizeOptionalPhone } from '@/lib/phone';
import { countryName } from '@/lib/countries';
import type { Customer } from '@/lib/types';

interface Props {
  initialSearch?: string;
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}

export default function CreateCustomerModal({ initialSearch = '', onClose, onCreated }: Props) {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const country = currentTenant?.country ?? 'IN';
  const dialCode = dialCodeFor(country);

  // If initialSearch contains digits and no letters, treat as phone; otherwise treat as name
  const isPhoneLike = Boolean(initialSearch && /\d/.test(initialSearch) && !/\p{L}/u.test(initialSearch));
  const [name, setName] = useState(isPhoneLike ? '' : initialSearch.trim());
  const [phone, setPhone] = useState(isPhoneLike ? initialSearch.trim() : '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    const norm = normalizeOptionalPhone(phone.trim(), country);
    if (!norm.valid) {
      toast.error(t('invalidPhone', { country: countryName(country) }));
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.post('/customers', {
        name: name.trim(),
        phone: norm.e164 ?? '',
        country_code: norm.countryCode ?? '',
      });
      onCreated(data.customer);
      toast.success(t('customerCreated'));
      onClose();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const errorMsg = (err.response?.data as { message?: string; error?: string } | undefined)?.message
          || (err.response?.data as { message?: string; error?: string } | undefined)?.error
          || t('createCustomerFailed');
        toast.error(errorMsg);
      } else {
        toast.error(t('createCustomerFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-gray-900">{t('addCustomer')}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('customerName')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
              autoFocus={!isPhoneLike}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('phone')}</label>
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={dialCode}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
              dir="ltr"
              autoFocus={isPhoneLike}
            />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={onClose} className="flex-1">{tCommon('cancel')}</Button>
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? t('loadingEllipsis') : tCommon('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
