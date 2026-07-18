'use client';

import { useState, useRef, useEffect } from 'react';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { countryName } from '@/lib/countries';
import { parsePhone, dialCodeFor } from '@/lib/phone';
import type { Customer } from '@/lib/types';

import { useI18n } from '@/hooks/useI18n';

interface Props {
  onSelected?: () => void;
  variant?: 'default' | 'topbar';
}

const TAG_COLORS: Record<string, string> = {
  veg:    'bg-green-100 text-green-700',
  nonveg: 'bg-red-100 text-red-700',
  vegan:  'bg-emerald-100 text-emerald-700',
  spicy:  'bg-orange-100 text-orange-700',
};

function tagColor(tag: string) {
  return TAG_COLORS[tag.toLowerCase()] ?? 'bg-gray-100 text-gray-600';
}

function digitsOnly(value: string | null | undefined): string {
  return String(value || '').replace(/\D/g, '');
}

function phoneMatchesInput(customerPhoneDigits: string | null | undefined, inputDigits: string): boolean {
  if (!customerPhoneDigits || !inputDigits) return false;
  return customerPhoneDigits.includes(inputDigits);
}

function TagBadges({ counts, t }: { counts: Record<string, number>; t: (k: string, p?: Record<string, string | number>) => string }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([tag, count]) => (
        <span key={tag} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${tagColor(tag)}`}>
          {t('pos.tagCount', { tag, count })}
        </span>
      ))}
    </div>
  );
}

export default function CustomerSearch({ onSelected, variant = 'default' }: Props = {}) {
  const cart = useCartStore();
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const dialCode = dialCodeFor(currentTenant?.country ?? 'IN');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [matched, setMatched] = useState<Customer | null>(null);
  const [searched, setSearched] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);

  const customer = cart.customer;
  const isNew = searched && !matched;

  useEffect(() => {
    if (cart.customerId && !cart.customer) {
      api.get(`/customers/${cart.customerId}`)
        .then(res => cart.setCustomer(res.data.customer))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.customerId]);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
    };
  }, []);

  const searchByPhone = (p: string) => {
    clearTimeout(debounceRef.current);
    if (p.length < 3) { setMatched(null); setName(''); setSearched(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(p)}`);
        const results = Array.isArray(data) ? data : (data.customers || []);
        const exactMatch = results.find((result: Customer) => phoneMatchesInput(result.phone_digits, p)) || null;
        const found: Customer | null = exactMatch || results[0] || null;
        setMatched(found);
        setName(found ? found.name : '');
        setSearched(true);
      } catch {
        setMatched(null);
        setName('');
        setSearched(true);
      }
    }, 300);
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPhone(val);
    if (matched !== null) setMatched(null);
    if (name !== '') setName('');
    if (searched) setSearched(false);
    searchByPhone(digitsOnly(val));
  };

  const handleSelectMatched = () => {
    if (!matched) return;
    cart.setCustomer(matched);
    setPhone(''); setName(''); setMatched(null); setSearched(false);
    onSelected?.();
  };

  const handlePhoneKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && matched) {
      handleSelectMatched();
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !phone.trim()) return;
    const country = currentTenant?.country ?? 'IN';
    const parsed = parsePhone(phone, country);
    if (!parsed) {
      toast.error(t('pos.invalidPhone', { country: countryName(country) }));
      return;
    }
    setCreating(true);
    try {
      const { data } = await api.post('/customers', { name: name.trim(), phone: parsed.e164, country_code: parsed.countryCode });
      cart.setCustomer(data.customer);
      setPhone(''); setName(''); setMatched(null); setSearched(false);
      toast.success(t('pos.customerCreated'));
      onSelected?.();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || t('pos.createCustomerFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleClear = () => cart.setCustomer(null);

  // ── Shared input classes ───────────────────────────────────────────────────
  const baseInput = 'px-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none text-sm';

  // ── Customer already selected ──────────────────────────────────────────────
  if (customer) {
    const hasTags = customer.tag_counts && Object.keys(customer.tag_counts).length > 0;

    if (variant === 'topbar') {
      return (
        <div className="h-10 flex items-center gap-2 px-3 bg-brand-light rounded-lg min-w-0 w-full">
          <div className="flex-1 min-w-0 flex items-center gap-x-2 flex-wrap">
            <span className="font-semibold text-brand text-sm truncate">{customer.name}</span>
            <span className="text-brand/70 text-xs shrink-0">{customer.phone}</span>
          </div>
          <button onClick={handleClear} className="text-brand hover:text-brand-hover shrink-0 ml-auto">
            <X size={14} />
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between px-3 py-2 bg-brand-light rounded-lg text-sm">
          <div className="flex-1 min-w-0">
            <span className="font-medium text-brand truncate">{customer.name}</span>
            {customer.phone && <span className="text-xs text-gray-500 ml-2">{customer.phone}</span>}
          </div>
          <button onClick={handleClear} className="text-brand hover:text-brand-hover ml-2 shrink-0">
            <X size={14} />
          </button>
        </div>
        {hasTags && <TagBadges counts={customer.tag_counts!} t={t} />}
      </div>
    );
  }

  // ── Topbar variant ─────────────────────────────────────────────────────────
  if (variant === 'topbar') {
    return (
      <div className="relative w-full min-w-0">
        <div className="h-10 flex items-center gap-2 min-w-0">

          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={handlePhoneChange}
            onKeyDown={handlePhoneKeyDown}
            placeholder={dialCode ? `${dialCode} ${t('pos.phone')}` : t('pos.phone')}
            className="h-10 w-44 shrink-0 px-3 text-sm border border-amber-400 bg-amber-50 placeholder:text-amber-600/70 rounded-lg focus:ring-2 focus:ring-amber-200 focus:border-amber-500 outline-none"
          />
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={matched ? undefined : (e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (matched) handleSelectMatched();
              else handleCreate();
            }}
            readOnly={!!matched}
            placeholder={searched ? (matched ? '' : t('pos.enterName')) : t('pos.nameAutoFills')}
            className={`h-10 w-48 shrink-0 px-3 text-sm border rounded-lg focus:ring-2 outline-none transition-colors duration-150 ${
              matched
                ? 'border-gray-200 bg-gray-50 cursor-pointer focus:ring-brand/20 focus:border-brand'
                : 'border-indigo-200 bg-indigo-50 placeholder:text-indigo-400/80 focus:ring-indigo-200 focus:border-indigo-400'
            }`}
            onClick={matched ? handleSelectMatched : undefined}
          />
          {matched && (
            <button
              onClick={handleSelectMatched}
              className="h-10 shrink-0 px-3 bg-brand text-white text-xs rounded-lg hover:bg-brand-hover whitespace-nowrap"
            >
              {t('pos.select')}
            </button>
          )}
          {isNew && name.trim() && (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="h-10 shrink-0 px-3 bg-brand text-white text-xs rounded-lg hover:bg-brand-hover disabled:opacity-50 whitespace-nowrap"
            >
              {creating ? t('pos.loadingEllipsis') : t('common.add')}
            </button>
          )}
        </div>

        {searched && (
          <div className="absolute left-0 top-full mt-1 z-20 rounded-md border border-gray-100 bg-white px-2 py-1 shadow-sm">
            {matched ? (
              <span className="text-xs text-green-600 font-medium">{t('pos.customerFound')}</span>
            ) : (
              <span className="text-xs text-red-500 font-medium">{t('pos.newCustomerEnterName')}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Default variant (stacked, used in modal) ───────────────────────────────
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2">
        <div className="flex items-stretch gap-2">

          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={handlePhoneChange}
            onKeyDown={handlePhoneKeyDown}
            placeholder={dialCode ? `${dialCode} ${t('pos.phone')}` : t('pos.phone')}
            className={`${baseInput} flex-1 py-2`}
          />
        </div>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={matched ? undefined : (e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (matched) handleSelectMatched();
            else handleCreate();
          }}
          readOnly={!!matched}
          placeholder={searched ? (matched ? '' : t('pos.enterName')) : t('pos.nameAutoFills')}
          className={`${baseInput} w-full py-2 ${matched ? 'bg-gray-50 cursor-pointer' : ''}`}
          onClick={matched ? handleSelectMatched : undefined}
        />
      </div>

      {searched && (
        <div className="space-y-1.5">
          {matched ? (
            <>
              <p className="text-xs text-green-600 font-medium">{t('pos.customerFoundClick')}</p>
              {matched.tag_counts && <TagBadges counts={matched.tag_counts} t={t} />}
              <button
                onClick={handleSelectMatched}
                className="w-full py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover"
              >
                {t('pos.selectName', { name: matched.name })}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-red-500 font-medium">{t('pos.newCustomerEnterName')}</p>
              {name.trim() && (
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="w-full py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-50"
                >
                  {creating ? t('pos.creating') : t('pos.addName', { name: name.trim() })}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
