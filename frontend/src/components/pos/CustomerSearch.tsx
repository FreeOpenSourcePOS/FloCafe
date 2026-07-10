'use client';

import { useState, useRef, useEffect } from 'react';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useAuthStore } from '@/store/auth';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Customer } from '@/lib/types';

const CURRENCY_DIAL_CODE: Record<string, string> = {
  INR: '+91', USD: '+1', GBP: '+44', AUD: '+61', CAD: '+1',
  SGD: '+65', THB: '+66', AED: '+971', MYR: '+60', NZD: '+64',
  EUR: '+33', IDR: '+62', PHP: '+63', VND: '+84', SAR: '+966',
  ZAR: '+27', KES: '+254', NGN: '+234', BRL: '+55', MXN: '+52',
  JPY: '+81', CNY: '+86', KRW: '+82', PKR: '+92', BDT: '+880',
  LKR: '+94', NPR: '+977',
};

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

function phoneMatchesInput(customerPhone: string | null | undefined, inputDigits: string): boolean {
  const customerDigits = digitsOnly(customerPhone);
  if (!customerDigits || !inputDigits) return false;
  return customerDigits === inputDigits || customerDigits.endsWith(inputDigits) || inputDigits.endsWith(customerDigits);
}

function TagBadges({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([tag, count]) => (
        <span key={tag} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${tagColor(tag)}`}>
          {tag} ×{count}
        </span>
      ))}
    </div>
  );
}

export default function CustomerSearch({ onSelected, variant = 'default' }: Props = {}) {
  const cart = useCartStore();
  const { phoneDigits } = usePosSettingsStore();
  const { currentTenant } = useAuthStore();
  const dialCode = CURRENCY_DIAL_CODE[currentTenant?.currency || ''] || '';
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [matched, setMatched] = useState<Customer | null>(null);
  const [searched, setSearched] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);

  const customer = cart.customer;
  const maxLen = phoneDigits || 10;
  const isNew = searched && !matched;

  useEffect(() => {
    if (cart.customerId && !cart.customer) {
      api.get(`/customers/${cart.customerId}`)
        .then(res => cart.setCustomer(res.data.customer))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.customerId]);

  const searchByPhone = (p: string) => {
    clearTimeout(debounceRef.current);
    if (p.length < 3) { setMatched(null); setName(''); setSearched(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(p)}`);
        const results = Array.isArray(data) ? data : (data.customers || []);
        const exactMatch = results.find((result: Customer) => phoneMatchesInput(result.phone, p)) || null;
        const found: Customer | null = exactMatch || results[0] || null;
        setMatched(found);
        setName(found ? found.name : '');
        setSearched(true);
        if (exactMatch) {
          cart.setCustomer(exactMatch);
          setPhone('');
          setName('');
          setMatched(null);
          setSearched(false);
          onSelected?.();
        }
      } catch {
        setMatched(null);
        setName('');
        setSearched(true);
      }
    }, 300);
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    let cleaned: string;
    if (val.startsWith('+')) {
      const spaceIdx = val.indexOf(' ');
      if (spaceIdx !== -1) {
        const code = '+' + val.slice(1, spaceIdx).replace(/\D/g, '');
        const number = val.slice(spaceIdx + 1).replace(/\D/g, '').slice(0, maxLen);
        cleaned = `${code} ${number}`;
      } else {
        cleaned = '+' + val.slice(1).replace(/\D/g, '').slice(0, maxLen + 4);
      }
    } else {
      cleaned = val.replace(/\D/g, '').slice(0, maxLen);
    }
    setPhone(cleaned);
    if (matched !== null) setMatched(null);
    if (name !== '') setName('');
    if (searched) setSearched(false);
    const localPart = cleaned.includes(' ')
      ? cleaned.split(' ').slice(1).join('')
      : cleaned.startsWith('+')
        ? cleaned.replace(/^\+\d{1,4}/, '')
        : cleaned;
    searchByPhone(digitsOnly(localPart));
  };

  const handlePhoneFocus = () => {
    if (!phone && dialCode) {
      setPhone(dialCode + ' ');
    }
  };

  const handleSelectMatched = () => {
    if (!matched) return;
    cart.setCustomer(matched);
    setPhone(''); setName(''); setMatched(null); setSearched(false);
    onSelected?.();
  };

  const handleCreate = async () => {
    if (!name.trim() || !phone.trim()) return;
    setCreating(true);
    try {
      const { data } = await api.post('/customers', { name: name.trim(), phone });
      cart.setCustomer(data.customer);
      setPhone(''); setName(''); setMatched(null); setSearched(false);
      toast.success('Customer created');
      onSelected?.();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || 'Failed to create customer');
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
        {hasTags && <TagBadges counts={customer.tag_counts!} />}
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
            onFocus={handlePhoneFocus}
            placeholder="Phone"
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
            placeholder={searched ? (matched ? '' : 'Enter name') : 'Name auto-fills'}
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
              Select
            </button>
          )}
          {isNew && name.trim() && (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="h-10 shrink-0 px-3 bg-brand text-white text-xs rounded-lg hover:bg-brand-hover disabled:opacity-50 whitespace-nowrap"
            >
              {creating ? '…' : 'Add'}
            </button>
          )}
        </div>

        {searched && (
          <div className="absolute left-0 top-full mt-1 z-20 rounded-md border border-gray-100 bg-white px-2 py-1 shadow-sm">
            {matched ? (
              <span className="text-xs text-green-600 font-medium">Customer found</span>
            ) : (
              <span className="text-xs text-red-500 font-medium">New customer — enter name</span>
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
        <input
          type="tel"
          inputMode="numeric"
          value={phone}
          onChange={handlePhoneChange}
          placeholder="Phone"
          className={`${baseInput} w-full py-2`}
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
          placeholder={searched ? (matched ? '' : 'Enter name') : 'Name auto-fills'}
          className={`${baseInput} w-full py-2 ${matched ? 'bg-gray-50 cursor-pointer' : ''}`}
          onClick={matched ? handleSelectMatched : undefined}
        />
      </div>

      {searched && (
        <div className="space-y-1.5">
          {matched ? (
            <>
              <p className="text-xs text-green-600 font-medium">Customer found — click name to select</p>
              {matched.tag_counts && <TagBadges counts={matched.tag_counts} />}
              <button
                onClick={handleSelectMatched}
                className="w-full py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover"
              >
                Select {matched.name}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-red-500 font-medium">New customer — enter name to add</p>
              {name.trim() && (
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="w-full py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-50"
                >
                  {creating ? 'Creating…' : `Add "${name.trim()}"`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
