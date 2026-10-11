'use client';

import { useState, useRef, useEffect } from 'react';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { X, Pencil, Gift, Search, Phone, User, Loader2 } from 'lucide-react';
import type { Customer } from '@/lib/types';
import EditCustomerModal from './EditCustomerModal';
import CreateCustomerModal from './CreateCustomerModal';
import { Ltr } from '@/components/layout/Ltr';
import { disambiguateCustomerInput } from '@/lib/customer-disambiguation';
import { useTranslations } from 'use-intl';

interface Props {
  onSelected?: () => void;
  variant?: 'default' | 'topbar';
}

const TAG_COLORS: Record<string, string> = {
  veg: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
  nonveg: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  vegan: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  spicy: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
};

function tagColor(tag: string) {
  return TAG_COLORS[tag.toLowerCase()] ?? 'bg-muted text-muted-foreground';
}

function TagBadges({ counts }: { counts: Record<string, number> }) {
  const t = useTranslations('pos');
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([tag, count]) => (
        <span
          key={tag}
          className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${tagColor(tag)}`}
        >
          {t('tagCount', { tag, count })}
        </span>
      ))}
    </div>
  );
}

export default function CustomerSearch({ onSelected, variant = 'default' }: Props = {}) {
  const cart = useCartStore();
  const t = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchSucceeded, setSearchSucceeded] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const [editingCustomer, setEditingCustomer] = useState(false);
  const [creatingModal, setCreatingModal] = useState<{
    initialSearch: string;
    initialField?: 'phone' | 'name';
  } | null>(null);

  const [loyaltyPoints, setLoyaltyPoints] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestAbortRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const customer = cart.customer;

  // Reset stale points synchronously during render when customer changes
  const [syncedCustomerId, setSyncedCustomerId] = useState(customer?.id ?? null);
  if ((customer?.id ?? null) !== syncedCustomerId) {
    setSyncedCustomerId(customer?.id ?? null);
    setLoyaltyPoints(null);
  }

  useEffect(() => {
    if (!customer) return;
    const controller = new AbortController();
    api
      .get(`/customers/${customer.id}/wallet`, { signal: controller.signal })
      .then((res) => setLoyaltyPoints(res.data.balance))
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))
          return;
        setLoyaltyPoints(null);
      });
    return () => controller.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);

  useEffect(() => {
    if (cart.customerId && !cart.customer) {
      const controller = new AbortController();
      api
        .get(`/customers/${cart.customerId}`, { signal: controller.signal })
        .then((res) => cart.setCustomer(res.data.customer))
        .catch(() => {});
      return () => controller.abort();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.customerId]);

  useEffect(() => {
    return () => {
      searchRequestIdRef.current += 1;
      clearTimeout(debounceRef.current);
      requestAbortRef.current?.abort();
    };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const searchCustomers = (q: string) => {
    const requestId = ++searchRequestIdRef.current;
    clearTimeout(debounceRef.current);
    requestAbortRef.current?.abort();
    setResults([]);
    setSearchSucceeded(false);
    setSearchFailed(false);

    const trimmed = q.trim();
    setActiveIndex(disambiguateCustomerInput(trimmed).category === 'ambiguous' ? -1 : 0);
    if (trimmed.length < 2) {
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestAbortRef.current = controller;
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (requestId !== searchRequestIdRef.current) return;
        const list = Array.isArray(data) ? data : data.customers || [];
        setResults(list);
        setSearchSucceeded(true);
      } catch {
        if (controller.signal.aborted || requestId !== searchRequestIdRef.current) return;
        setResults([]);
        setSearchFailed(true);
      } finally {
        if (requestId === searchRequestIdRef.current) setLoading(false);
      }
    }, 250);
  };

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    setIsOpen(true);
    searchCustomers(val);
  };

  const handleSelectCustomer = (selected: Customer) => {
    cart.setCustomer(selected);
    searchCustomers('');
    setQuery('');
    setIsOpen(false);
    onSelected?.();
  };

  const handleClear = () => cart.setCustomer(null);

  // Compute intent actions when query is at least 1 character
  const trimmedQuery = query.trim();
  const disambiguation = disambiguateCustomerInput(trimmedQuery);

  // Intent action items
  interface IntentAction {
    id: string;
    label: string;
    field: 'phone' | 'name';
    isDefault: boolean;
    icon: typeof Phone;
  }

  const actions: IntentAction[] = [];
  if (trimmedQuery.length >= 2 && searchSucceeded && !loading && !trimmedQuery.includes('@')) {
    if (disambiguation.category === 'phone') {
      actions.push({
        id: 'create-phone',
        label: t('createWithPhone', { phone: trimmedQuery }),
        field: 'phone',
        isDefault: true,
        icon: Phone,
      });
      actions.push({
        id: 'create-name',
        label: t('createWithName', { name: trimmedQuery }),
        field: 'name',
        isDefault: false,
        icon: User,
      });
    } else if (disambiguation.category === 'name') {
      actions.push({
        id: 'create-name',
        label: t('createWithName', { name: trimmedQuery }),
        field: 'name',
        isDefault: true,
        icon: User,
      });
    } else {
      // Ambiguous short digits (e.g. "123")
      actions.push({
        id: 'create-name',
        label: t('createWithName', { name: trimmedQuery }),
        field: 'name',
        isDefault: false,
        icon: User,
      });
      actions.push({
        id: 'create-phone',
        label: t('createWithPhone', { phone: trimmedQuery }),
        field: 'phone',
        isDefault: false,
        icon: Phone,
      });
    }
  }

  const totalInteractiveItems = results.length + actions.length;

  const handleTriggerAction = (field: 'phone' | 'name') => {
    setIsOpen(false);
    setCreatingModal({
      initialSearch: trimmedQuery,
      initialField: field,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setIsOpen(true);
      return;
    }

    if (e.key === 'Escape') {
      setIsOpen(false);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (totalInteractiveItems > 0) {
        setActiveIndex((prev) => (prev + 1) % totalInteractiveItems);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (totalInteractiveItems > 0) {
        setActiveIndex((prev) =>
          prev < 0
            ? totalInteractiveItems - 1
            : (prev - 1 + totalInteractiveItems) % totalInteractiveItems,
        );
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && results.length > 0 && activeIndex < results.length) {
        handleSelectCustomer(results[activeIndex]);
        return;
      }

      const actionIndex = activeIndex - results.length;
      if (actionIndex >= 0 && actionIndex < actions.length) {
        handleTriggerAction(actions[actionIndex].field);
      }
    }
  };

  // ── Customer already selected ──────────────────────────────────────────────
  if (customer) {
    const hasTags = customer.tag_counts && Object.keys(customer.tag_counts).length > 0;

    if (variant === 'topbar') {
      return (
        <>
          <div className="min-h-10 flex items-center gap-2 px-3 bg-brand-light dark:bg-[var(--color-brand-light)] rounded-lg min-w-0 w-full sm:w-auto">
            <button
              onClick={() => setEditingCustomer(true)}
              title={t('editCustomer')}
              className="touch-target flex-1 min-w-0 justify-start gap-x-2 flex-wrap text-start cursor-pointer"
            >
              <span className="font-semibold text-brand dark:text-indigo-300 text-sm truncate">
                {customer.name}
              </span>
              <span className="text-brand/70 dark:text-indigo-300 text-xs shrink-0">
                <Ltr>{customer.phone}</Ltr>
              </span>
              <Pencil size={14} className="text-brand/60 dark:text-indigo-300 shrink-0" />
              {!!loyaltyPoints && loyaltyPoints > 0 && (
                <span className="flex items-center gap-0.5 text-xs font-medium text-brand dark:text-indigo-300 bg-card/70 rounded-full px-1.5 py-0.5 shrink-0">
                  <Gift size={11} />
                  {t('loyaltyPointsShort', { count: loyaltyPoints })}
                </span>
              )}
              {hasTags && <TagBadges counts={customer.tag_counts!} />}
            </button>
            <button
              onClick={handleClear}
              className="touch-target rounded-full text-brand dark:text-indigo-300 hover:text-brand-hover active:bg-card/60 shrink-0 ms-auto cursor-pointer"
              aria-label={t('remove')}
            >
              <X size={16} />
            </button>
          </div>
          {editingCustomer && (
            <EditCustomerModal
              customer={customer}
              onClose={() => setEditingCustomer(false)}
              onSaved={(updated) => cart.setCustomer(updated)}
            />
          )}
        </>
      );
    }

    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between px-3 py-2 bg-brand-light dark:bg-[var(--color-brand-light)] rounded-lg text-sm">
          <button
            onClick={() => setEditingCustomer(true)}
            className="touch-target flex-1 min-w-0 justify-start gap-2 text-start cursor-pointer"
          >
            <span className="font-medium text-brand dark:text-indigo-300 truncate">
              {customer.name}
            </span>
            {customer.phone && (
              <span className="text-xs text-muted-foreground">
                <Ltr>{customer.phone}</Ltr>
              </span>
            )}
            <Pencil size={14} className="text-brand/60 dark:text-indigo-300 shrink-0" />
          </button>
          <button
            onClick={handleClear}
            className="touch-target rounded-full text-brand dark:text-indigo-300 hover:text-brand-hover active:bg-card/60 ms-2 shrink-0 cursor-pointer"
            aria-label={t('remove')}
          >
            <X size={16} />
          </button>
        </div>
        {!!loyaltyPoints && loyaltyPoints > 0 && (
          <span className="inline-flex items-center gap-0.5 text-xs font-medium text-brand dark:text-indigo-300 bg-brand-light dark:bg-[var(--color-brand-light)] rounded-full px-1.5 py-0.5">
            <Gift size={11} />
            {t('loyaltyPointsShort', { count: loyaltyPoints })}
          </span>
        )}
        {hasTags && <TagBadges counts={customer.tag_counts!} />}
        {editingCustomer && (
          <EditCustomerModal
            customer={customer}
            onClose={() => setEditingCustomer(false)}
            onSaved={(updated) => cart.setCustomer(updated)}
          />
        )}
      </div>
    );
  }

  // ── Unified Search Input & Predictive Dropdown ──────────────────────────────
  const isTopbar = variant === 'topbar';
  const showDropdown = isOpen && trimmedQuery.length >= 2;

  return (
    <div
      ref={containerRef}
      className={`relative ${isTopbar ? 'w-full min-w-0 sm:max-w-52' : 'w-full'}`}
    >
      <div className="relative flex items-center">
        <Search
          size={16}
          className="absolute start-3 text-muted-foreground pointer-events-none shrink-0"
        />
        <input
          id="customer-phone-search"
          ref={inputRef}
          type="text"
          dir="ltr"
          value={query}
          onChange={handleQueryChange}
          onFocus={() => {
            if (trimmedQuery.length >= 2) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={tOrders('searchCustomer')}
          className={`w-full ps-9 pe-8 text-sm border border-border bg-card rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none transition-colors ${
            isTopbar ? 'h-10' : 'min-h-11 py-2'
          }`}
          aria-label={tOrders('searchCustomer')}
          data-testid="pos-customer-search-input"
          autoComplete="off"
        />
        {loading ? (
          <Loader2
            size={14}
            className="absolute end-3 animate-spin text-muted-foreground pointer-events-none"
          />
        ) : query ? (
          <button
            type="button"
            onClick={() => {
              searchCustomers('');
              setQuery('');
              setIsOpen(false);
              inputRef.current?.focus();
            }}
            className="absolute end-2.5 p-1 rounded-full text-muted-foreground hover:text-foreground active:bg-muted"
            aria-label={t('close')}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {/* Autocomplete & Predictive Actions Dropdown */}
      {showDropdown && (
        <div className="absolute start-0 top-full mt-1.5 w-full sm:w-80 min-w-full z-30 rounded-xl border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden animate-in fade-in-50 duration-100">
          <div className="max-h-72 overflow-y-auto p-1.5 space-y-1">
            {/* Matching existing customers */}
            {results.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2.5 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('customerFound')}
                </div>
                {results.map((cust, idx) => {
                  const isSelected = activeIndex === idx;
                  return (
                    <button
                      key={cust.id}
                      type="button"
                      onClick={() => handleSelectCustomer(cust)}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-sm transition-colors text-start cursor-pointer ${
                        isSelected
                          ? 'bg-brand text-white dark:bg-brand dark:text-white'
                          : 'hover:bg-muted text-foreground'
                      }`}
                    >
                      <div className="min-w-0 flex-1 me-2">
                        <div className="font-medium truncate">{cust.name}</div>
                        {cust.phone && (
                          <div
                            className={`text-xs ${
                              isSelected ? 'text-white/80' : 'text-muted-foreground'
                            }`}
                          >
                            <Ltr>{cust.phone}</Ltr>
                          </div>
                        )}
                      </div>
                      {cust.wallet_balance !== undefined && cust.wallet_balance > 0 && (
                        <span
                          className={`text-xs font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                            isSelected
                              ? 'bg-white/20 text-white'
                              : 'bg-brand-light dark:bg-[var(--color-brand-light)] text-brand dark:text-indigo-300'
                          }`}
                        >
                          <Gift size={11} className="inline me-0.5" />
                          {cust.wallet_balance}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Zero matching customers header */}
            {results.length === 0 && !loading && (searchSucceeded || searchFailed) && (
              <div className="px-2.5 py-2 text-xs text-muted-foreground text-center">
                {searchFailed ? tCommon('somethingWrong') : tCommon('noResults')}
              </div>
            )}

            {/* Predictive Creation Actions */}
            {actions.length > 0 && (
              <div className="border-t border-border pt-1 mt-1 space-y-0.5">
                {actions.map((act, actIdx) => {
                  const itemIndex = results.length + actIdx;
                  const isSelected = activeIndex === itemIndex;
                  const Icon = act.icon;
                  return (
                    <button
                      key={act.id}
                      type="button"
                      onClick={() => handleTriggerAction(act.field)}
                      onMouseEnter={() => setActiveIndex(itemIndex)}
                      className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors text-start cursor-pointer ${
                        isSelected
                          ? 'bg-brand text-white dark:bg-brand dark:text-white'
                          : act.isDefault
                            ? 'bg-brand/10 text-brand dark:bg-brand/20 dark:text-indigo-300 hover:bg-brand/20'
                            : 'hover:bg-muted text-foreground'
                      }`}
                    >
                      <Icon size={14} className="shrink-0" />
                      <span className="flex-1 truncate">{act.label}</span>
                      {act.isDefault && (
                        <kbd
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            isSelected
                              ? 'bg-white/20 border-white/40 text-white'
                              : 'bg-muted border-border text-muted-foreground'
                          }`}
                        >
                          ↵
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Creation Modal */}
      {creatingModal && (
        <CreateCustomerModal
          initialSearch={creatingModal.initialSearch}
          initialField={creatingModal.initialField}
          onClose={() => setCreatingModal(null)}
          onCreated={(created) => {
            cart.setCustomer(created);
            setCreatingModal(null);
            searchCustomers('');
            setQuery('');
            onSelected?.();
          }}
        />
      )}
    </div>
  );
}
