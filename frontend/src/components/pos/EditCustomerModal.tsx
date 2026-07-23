'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { useI18n } from '@/hooks/useI18n';
import { dialCodeFor } from '@/lib/phone';
import type { Customer } from '@/lib/types';

interface Props {
  customer: Customer;
  onClose: () => void;
  onSaved: (customer: Customer) => void;
}

export default function EditCustomerModal({ customer, onClose, onSaved }: Props) {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const dialCode = dialCodeFor(currentTenant?.country ?? 'IN');
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('pos.nameRequired', { defaultValue: 'Name is required' }));
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put(`/customers/${customer.id}`, {
        name: name.trim(),
        phone: phone.trim(),
      });
      onSaved(data.customer);
      toast.success(t('pos.customerUpdated', { defaultValue: 'Customer updated' }));
      onClose();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string; message?: string } } };
      toast.error(
        error.response?.data?.error ||
        error.response?.data?.message ||
        t('pos.customerUpdateFailed', { defaultValue: 'Failed to update customer' })
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-gray-900">{t('pos.editCustomer', { defaultValue: 'Edit Customer' })}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('pos.customerName', { defaultValue: 'Name' })}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('pos.phone')}</label>
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={dialCode}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
            />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={onClose} className="flex-1">{t('common.cancel')}</Button>
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? t('pos.loadingEllipsis') : t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
